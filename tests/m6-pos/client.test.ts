import { describe, expect, it } from "vitest";

import { deviceShiftFigures, expectedClosingStock, gridProducts, stockReasonRequired, voidNeedsApproval, type CatalogRef, type PosReference } from "@/client/m6-pos/contract";
import { applyPosCommand } from "@/client/m6-pos/optimistic";

const ISI = "p-isi";
const BARU = "p-baru";
const TUTUP = "m-tutup";
const TISU = "m-tisu";
const GALON = "m-galon";

function reference(): PosReference {
  return {
    version: 1,
    generatedAt: "2026-09-28T00:00:00.000Z",
    businessDate: "2026-09-28",
    outlet: { id: "o1", code: "D04", name: "Depot uji", kind: "depot", tenantId: "t1", storageCapacityL: 5_000 },
    companyName: "EQUA",
    settings: {
      fixedOpeningCash: 200_000,
      cashLimit: 2_000_000,
      voidApprovalAbove: 20_000,
      voidDailyCount: 3,
      stockTolerance: 2,
      gridMax: 12,
      maxSaleLines: 20,
      maxQuantityPerLine: 999,
      qrisEnabled: true,
      printerEnabled: false,
    },
    openShift: null,
    conflictShifts: [],
    lastClosedShift: null,
    materials: [
      { id: TUTUP, code: "TUTUP", name: "Tutup galon", unit: "pcs", balance: 100 },
      { id: TISU, code: "TISU", name: "Tisu", unit: "pcs", balance: 100 },
      { id: GALON, code: "GALON-KOSONG", name: "Galon kosong", unit: "pcs", balance: 10 },
    ],
    recipes: [
      { productId: ISI, materialProductId: TUTUP, quantity: 1 },
      { productId: ISI, materialProductId: TISU, quantity: 1 },
      { productId: BARU, materialProductId: GALON, quantity: 1 },
      { productId: BARU, materialProductId: TUTUP, quantity: 1 },
    ],
    water: { stockL: 1_000, capacityL: 5_000, overCapacity: false, pending: [{ id: "w1", tripId: null, tripNumber: null, deliveredVolumeL: 3_000, arrivedAt: "2026-09-28T01:00:00.000Z", businessDate: "2026-09-28", status: "arrived" }] },
    transfers: [],
    stockCountThisWeek: null,
    history: [],
    voidsToday: 0,
  };
}

const meta = { userId: "u1", deviceTime: "2026-09-28T01:00:00.000Z", businessDate: "2026-09-28" };
const size = (id: string) => (id === ISI || id === BARU ? 19 : null);

describe("M6 klien POS (reducer optimistis & angka perangkat, tanpa sinyal)", () => {
  it("US-M6-06 KP-1 buka shift → jual tunai/QRIS → void → setor sebagian → angka shift & stok seharusnya dihitung di perangkat tanpa server", () => {
    let d = reference();
    d = applyPosCommand(d, "m6.shift.open", { shiftId: "s1", openingCashCounted: 200_000 }, meta, size);
    expect(d.openShift).toMatchObject({ id: "s1", openingCash: 200_000, local: true, syncConflict: false });
    d = applyPosCommand(d, "m6.pos_sale.create", { saleId: "a", shiftId: "s1", localNumber: "L1", deviceSeq: 1, lines: [{ productId: ISI, quantity: 3, unitPrice: 5_000 }], paymentMethod: "cash", cashReceived: 20_000 }, meta, size);
    d = applyPosCommand(d, "m6.pos_sale.create", { saleId: "b", shiftId: "s1", localNumber: "L2", deviceSeq: 2, lines: [{ productId: BARU, quantity: 1, unitPrice: 45_000 }], paymentMethod: "qris" }, meta, size);
    d = applyPosCommand(d, "m6.pos_sale.create", { saleId: "c", shiftId: "s1", localNumber: "L3", deviceSeq: 3, lines: [{ productId: ISI, quantity: 1, unitPrice: 5_000 }], paymentMethod: "cash" }, meta, size);
    // Pengiriman ulang perintah yang sama tidak menggandakan transaksi.
    d = applyPosCommand(d, "m6.pos_sale.create", { saleId: "c", shiftId: "s1", localNumber: "L3", deviceSeq: 3, lines: [{ productId: ISI, quantity: 1, unitPrice: 5_000 }], paymentMethod: "cash" }, meta, size);
    d = applyPosCommand(d, "m6.pos_sale.void", { saleId: "c", reason: "wrong_quantity" }, meta, size);
    // Void di atas PAR-04 → menunggu persetujuan & tetap dihitung.
    d = applyPosCommand(d, "m6.pos_sale.void", { saleId: "b", reason: "customer_cancelled" }, meta, size);
    d = applyPosCommand(d, "m6.shift_deposit.partial", { depositId: "dp", shiftId: "s1", amount: 10_000 }, meta, size);

    const shift = d.openShift!;
    expect(shift.sales.map((s) => s.status)).toEqual(["valid", "void_pending", "voided"]);
    expect(shift.sales[0]).toMatchObject({ changeAmount: 5_000, local: true });
    expect(d.voidsToday).toBe(2);
    const f = deviceShiftFigures(shift, d.recipes);
    expect(f.cashSales).toBe(15_000);
    expect(f.qrisSales).toBe(45_000);
    expect(f.voidCount).toBe(1);
    expect(f.voidPendingCount).toBe(1);
    expect(f.expectedDrawer).toBe(200_000 + 15_000 - 10_000);
    expect(f.depositAmount).toBe(15_000 - 10_000);
    expect(f.usage).toMatchObject({ [TUTUP]: 4, [TISU]: 3, [GALON]: 1 });
    const expected = expectedClosingStock(d.materials, f.usage);
    expect(expected).toEqual({ [TUTUP]: 96, [TISU]: 97, [GALON]: 9 });
    expect(stockReasonRequired(-2, d.settings.stockTolerance)).toBe(false);
    expect(stockReasonRequired(-3, d.settings.stockTolerance)).toBe(true);
    expect(voidNeedsApproval(20_001, d.settings)).toBe(true);
    expect(voidNeedsApproval(20_000, d.settings)).toBe(false);

    // Tutup shift offline → saldo bahan berkurang pemakaian seharusnya; setoran menunggu diserahkan.
    d = applyPosCommand(d, "m6.shift.close", { shiftId: "s1", closingCashCounted: 205_000, stock: [], saleIds: ["a", "b", "c"], voidedSaleIds: ["b", "c"] }, meta, size);
    expect(d.openShift).toBeNull();
    expect(d.lastClosedShift).toMatchObject({ id: "s1", depositStatus: "not_deposited" });
    expect(d.materials.find((m) => m.id === TUTUP)?.balance).toBe(96);
  });

  it("US-M6-06 KP-1 shift kedua dibuka offline saat shift lain terbuka → dicatat sebagai konflik (bukan ditolak); pasokan air dikonfirmasi offline", () => {
    let d = reference();
    d = applyPosCommand(d, "m6.shift.open", { shiftId: "s1", openingCashCounted: 200_000 }, meta);
    d = applyPosCommand(d, "m6.shift.open", { shiftId: "s2", openingCashCounted: 200_000 }, meta);
    expect(d.openShift?.id).toBe("s1");
    expect(d.conflictShifts.map((s) => [s.id, s.syncConflict])).toEqual([["s2", true]]);
    d = applyPosCommand(d, "m6.water_supply.confirm", { receiptId: "w1", receivedVolumeL: 2_950, reason: "Tumpah" }, meta);
    expect(d.water).toMatchObject({ stockL: 3_950, pending: [] });
  });

  it("US-M6-01 KP-1 kisi produk POS maksimal 12 produk terlihat dengan harga master sesuai jenis harga outlet", () => {
    const catalog: CatalogRef = {
      outletId: "o1",
      products: Array.from({ length: 15 }, (_, i) => ({
        id: `p${i}`,
        code: `P${String(i).padStart(2, "0")}`,
        name: `Produk ${i}`,
        unit: "pcs",
        posVisible: i !== 3,
        sortOrder: i,
        gallonSizeL: null,
        isConsumable: false,
        prices: i === 5 ? { general: 1_000 } : { standard: 1_000 * (i + 1) },
      })),
    };
    const grid = gridProducts(catalog, "standard", 12);
    expect(grid).toHaveLength(12);
    expect(grid.map((p) => p.id)).not.toContain("p3");
    expect(grid.map((p) => p.id)).not.toContain("p5");
    expect(grid[0]).toMatchObject({ id: "p0", price: 1_000 });
  });
});
