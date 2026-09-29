/**
 * B-25 (S5): tinjauan pemilik M6 atas perluasan M7 di kerangka POS (`policy.ts`, `sales.ts`, `index.ts`, klien
 * `contract/optimistic`, `pos-app.tsx`, `(field)/pos/page.tsx` → `PosEntry`). Uji regresi: perilaku POS DEPOT tidak
 * berubah oleh titik perluasan toko (tempo, diskon, pelanggan, status menunggu persetujuan).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { domainEvents, posSales } from "@/db/schema";
import { saleStatusText, type PosReference } from "@/client/m6-pos/contract";
import { applyPosCommand } from "@/client/m6-pos/optimistic";
import { customerId } from "@/db/seed";
import { posKindPolicy } from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { expectApplied, isi, openShiftVia, posFor, PRICE, sellVia } from "./helpers";

describe("B-25 regresi POS depot setelah perluasan M7 (US-M6-01, PTB-48, FR-M6-08)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-25 US-M6-01 KP-2 PTB-48 POS depot: tempo & diskon ditolak dengan pesan tindakan; pelanggan tidak disimpan; permintaan persetujuan diabaikan (transaksi langsung Sah, harga standar)", async () => {
    const policy = posKindPolicy("depot");
    expect(policy).toMatchObject({ acceptsCustomer: false, productLine: "depot" });
    expect(policy.paymentMethods ?? ["cash", "qris"]).not.toContain("credit");
    expect(policy.allowsDiscount ?? false).toBe(false);

    const pos = await posFor("D07");
    const { shiftId } = await openShiftVia(pos);
    const credit = await sellVia(pos, shiftId, [isi(1)], { extra: { paymentMethod: "credit" } });
    expect(credit.res.status).toBe("rejected");
    expect(credit.res.message).toMatch(/tidak tersedia di POS depot/);
    const discount = await sellVia(pos, shiftId, [isi(2)], { extra: { discountAmount: 1_000, discountReason: "Pelanggan tetap" } });
    expect(discount.res.status).toBe("rejected");
    expect(discount.res.message).toMatch(/Diskon tidak tersedia di POS depot/);

    const sale = await sellVia(pos, shiftId, [isi(2)], { extra: { customerId: customerId("PLG-0001"), requestApproval: true } });
    expectApplied(sale.res);
    const [row] = await t.db.select().from(posSales).where(eq(posSales.id, sale.saleId));
    expect(row).toMatchObject({ status: "valid", customerId: null, priceKind: "standard", discountAmount: 0, subtotal: 2 * PRICE.ISI, total: 2 * PRICE.ISI, creditOffline: false });
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "pos_sale.recorded"), eq(domainEvents.objectId, sale.saleId)));
    expect(ev!.payload).toMatchObject({ outletKind: "depot", method: "cash", discount: 0, customerId: null, total: 2 * PRICE.ISI });
  });

  it("B-25 US-M6-06 KP-2 klien POS depot: transaksi optimistis tanpa diskon tetap Sah & total = jumlah baris; teks status mengenal status toko", () => {
    const meta = { userId: "u1", deviceTime: "2026-09-29T02:00:00.000Z", businessDate: "2026-09-29" };
    const empty = { openShift: null, conflictShifts: [], history: [], materials: [], recipes: [], settings: { fixedOpeningCash: 200_000 } } as unknown as PosReference;
    const ref = applyPosCommand(empty, "m6.shift.open", { shiftId: "s1", openingCashCounted: 200_000 }, meta, () => 19);
    const d = applyPosCommand(ref, "m6.pos_sale.create", { saleId: "a", shiftId: "s1", localNumber: "L1", deviceSeq: 1, lines: [{ productId: "p", quantity: 3, unitPrice: 5_000 }], paymentMethod: "cash" }, meta, () => 19);
    expect(d.openShift!.sales[0]).toMatchObject({ id: "a", status: "valid", total: 15_000, cashReceived: 15_000, changeAmount: 0 });
    expect(saleStatusText({ status: "valid", local: false })).toBe("Sah · terkirim");
    expect(saleStatusText({ status: "pending_approval", local: true })).toBe("Menunggu persetujuan pemilik · tersimpan di perangkat");
    expect(saleStatusText({ status: "rejected", local: false })).toBe("Ditolak · terkirim");
  });
});
