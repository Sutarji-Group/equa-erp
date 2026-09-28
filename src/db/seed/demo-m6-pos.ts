/**
 * Seed demo M6 — Penjualan Depot (POS). Idempoten: ID deterministik + ON CONFLICT DO NOTHING; stok/buku air hanya
 * diisi bila outlet belum punya mutasi; nomor urut dokumen dinaikkan hanya saat baris benar-benar baru dibuat.
 *
 * Isi (outlet D02 & D03 — outlet uji Vitest M6 memakai D04–D10 agar tidak terpengaruh):
 * - Stok awal bahan habis pakai (tutup, tisu, galon kosong) D02 & D03 + stok air awal (buku air).
 * - D02: pasokan air truk kemarin (dikonfirmasi, selisih −20 L beralasan) dan satu shift KEMARIN yang sudah ditutup
 *   operator `depot02`: 8 transaksi (tunai & QRIS, 1 void dalam shift + transaksi pengganti), hitung stok awal/akhir,
 *   pemakaian bahan & penjualan galon terposting, selisih kas −Rp2.000 beralasan, setoran akhir "Diajukan" (menunggu
 *   diterima Kasir Kantor M4).
 * - D03: satu pasokan air truk berstatus "Tiba" menunggu konfirmasi operator (`depot03`).
 * Tidak ada shift terbuka (operator demo membuka shift sendiri di /pos) dan tidak ada permintaan persetujuan.
 * Event domain TIDAK dipancarkan (seed menulis langsung) — modul lain tidak menerima `shift.closed` untuk data demo ini.
 */
import { and, eq, sql } from "drizzle-orm";

import {
  addDays,
  toBusinessDate,
  wibToUtc,
  type BusinessDate,
} from "@/lib/time";

import type { DbOrTx } from "../client";
import {
  deposits,
  documentSequences,
  outletWaterLedger,
  posSaleLines,
  posSales,
  shifts,
  shiftStockCounts,
  stockBalances,
  stockLedger,
  waterSupplyReceipts,
} from "../schema";
import { PRODUCT_SEEDS, productId } from "./catalog";
import { seedId } from "./ids";
import { deviceId, EQUA_TENANT_ID, outletId, userIdByUsername } from "./org";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Stok awal bahan per depot demo: jumlah & harga pokok per satuan (nilai transfer internal toko). */
const OPENING_STOCK: Record<
  string,
  { code: string; quantity: number; unitCost: number }[]
> = {
  D02: [
    { code: "TUTUP", quantity: 400, unitCost: 600 },
    { code: "TISU", quantity: 400, unitCost: 300 },
    { code: "GALON-KOSONG", quantity: 40, unitCost: 35_000 },
  ],
  D03: [
    { code: "TUTUP", quantity: 250, unitCost: 600 },
    { code: "TISU", quantity: 250, unitCost: 300 },
    { code: "GALON-KOSONG", quantity: 20, unitCost: 35_000 },
  ],
};
const OPENING_WATER_L: Record<string, number> = { D02: 1_500, D03: 800 };

const PRICE: Record<string, number> = {
  "ISI-ULANG": 5_000,
  "GALON-BARU": 45_000,
  "CUCI-GALON": 2_000,
};
const RECIPE: Record<string, { material: string; quantity: number }[]> = {
  "ISI-ULANG": [
    { material: "TUTUP", quantity: 1 },
    { material: "TISU", quantity: 1 },
  ],
  "GALON-BARU": [
    { material: "GALON-KOSONG", quantity: 1 },
    { material: "TUTUP", quantity: 1 },
  ],
};
const GALLON_L: Record<string, number> = { "ISI-ULANG": 19, "GALON-BARU": 19 };

type DemoSale = {
  minute: number;
  lines: [string, number][];
  method: "cash" | "qris";
  cashReceived?: number;
  voided?: { reason: "wrong_quantity"; note: string };
  replaces?: number;
};

/** Transaksi shift demo D02 (menit sejak buka shift 07:00 WIB). */
const D02_SALES: DemoSale[] = [
  {
    minute: 12,
    lines: [["ISI-ULANG", 2]],
    method: "cash",
    cashReceived: 10_000,
  },
  { minute: 35, lines: [["ISI-ULANG", 1]], method: "qris" },
  {
    minute: 58,
    lines: [["GALON-BARU", 1]],
    method: "cash",
    cashReceived: 50_000,
  },
  {
    minute: 95,
    lines: [["ISI-ULANG", 3]],
    method: "cash",
    cashReceived: 20_000,
  },
  {
    minute: 140,
    lines: [["ISI-ULANG", 1]],
    method: "cash",
    cashReceived: 5_000,
    voided: {
      reason: "wrong_quantity",
      note: "Pelanggan membeli 2 galon, tercatat 1",
    },
  },
  {
    minute: 142,
    lines: [["ISI-ULANG", 2]],
    method: "cash",
    cashReceived: 10_000,
    replaces: 5,
  },
  { minute: 260, lines: [["ISI-ULANG", 4]], method: "qris" },
  {
    minute: 410,
    lines: [
      ["CUCI-GALON", 1],
      ["ISI-ULANG", 1],
    ],
    method: "cash",
    cashReceived: 10_000,
  },
];

export const DEMO_M6_SHIFT_ID = seedId("m6:demo:shift:D02:closed");

async function seedOpeningStock(
  tx: DbOrTx,
  code: string,
  at: Date,
  date: BusinessDate,
): Promise<number> {
  const oid = outletId(code);
  const [existing] = await tx
    .select({ id: stockLedger.id })
    .from(stockLedger)
    .where(eq(stockLedger.outletId, oid))
    .limit(1);
  if (existing) return 0;
  let n = 0;
  for (const s of OPENING_STOCK[code] ?? []) {
    const pid = productId(s.code);
    const inserted = await tx
      .insert(stockBalances)
      .values({
        id: seedId(`m6:demo:stock_balance:${code}:${s.code}`),
        tenantId: EQUA_TENANT_ID,
        outletId: oid,
        productId: pid,
        quantity: s.quantity,
        avgCost: s.unitCost,
        totalValue: s.quantity * s.unitCost,
        lastMovementAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: stockBalances.id });
    if (!inserted.length) continue;
    await tx.insert(stockLedger).values({
      id: seedId(`m6:demo:stock_opening:${code}:${s.code}`),
      tenantId: EQUA_TENANT_ID,
      outletId: oid,
      productId: pid,
      kind: "opening",
      quantity: s.quantity,
      unitCost: s.unitCost,
      totalCost: s.quantity * s.unitCost,
      balanceAfter: s.quantity,
      avgCostAfter: s.unitCost,
      businessDate: date,
      occurredAt: at,
      note: "Stok awal (data demo)",
    });
    n++;
  }
  return n;
}

async function seedOpeningWater(
  tx: DbOrTx,
  code: string,
  at: Date,
  date: BusinessDate,
): Promise<boolean> {
  const oid = outletId(code);
  const [existing] = await tx
    .select({ id: outletWaterLedger.id })
    .from(outletWaterLedger)
    .where(eq(outletWaterLedger.outletId, oid))
    .limit(1);
  if (existing) return false;
  const liters = OPENING_WATER_L[code] ?? 0;
  await tx
    .insert(outletWaterLedger)
    .values({
      id: seedId(`m6:demo:water_opening:${code}`),
      tenantId: EQUA_TENANT_ID,
      outletId: oid,
      businessDate: date,
      kind: "opening",
      volumeL: liters,
      balanceAfterL: liters,
      occurredAt: at,
    })
    .onConflictDoNothing();
  return true;
}

/** Naikkan urutan nomor dokumen ke paling sedikit `value` (nomor demo tidak dipakai ulang oleh `nextNumber`). */
async function bumpSequence(
  tx: DbOrTx,
  kind: string,
  scopeKey: string,
  value: number,
): Promise<void> {
  await tx
    .insert(documentSequences)
    .values({
      id: seedId(`m6:demo:seq:${kind}:${scopeKey}`),
      tenantId: EQUA_TENANT_ID,
      kind,
      scopeKey,
      lastValue: value,
    })
    .onConflictDoUpdate({
      target: [
        documentSequences.tenantId,
        documentSequences.kind,
        documentSequences.scopeKey,
      ],
      set: {
        lastValue: sql`greatest(${documentSequences.lastValue}, ${value})`,
        updatedAt: new Date(),
      },
    });
}

/** Nomor berikutnya (logika sama dengan core/numbering `nextNumber`, tanpa impor server-only). */
async function nextSeq(
  tx: DbOrTx,
  kind: string,
  scopeKey: string,
): Promise<number> {
  const rows = await tx
    .insert(documentSequences)
    .values({
      id: seedId(`m6:demo:seq:${kind}:${scopeKey}:first`),
      tenantId: EQUA_TENANT_ID,
      kind,
      scopeKey,
      lastValue: 1,
    })
    .onConflictDoUpdate({
      target: [
        documentSequences.tenantId,
        documentSequences.kind,
        documentSequences.scopeKey,
      ],
      set: {
        lastValue: sql`${documentSequences.lastValue} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ lastValue: documentSequences.lastValue });
  return Number(rows[0]!.lastValue);
}

async function seedClosedShiftD02(
  tx: DbOrTx,
  day: BusinessDate,
): Promise<boolean> {
  const oid = outletId("D02");
  const operator = userIdByUsername("depot02");
  const device = deviceId("POS-D02");
  const openedAt = wibToUtc(day, "07:00");
  const closedAt = wibToUtc(day, "15:05");
  const openingCash = 200_000;
  const yymmdd = `${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}`;

  // Angka shift dihitung dulu (murni) agar baris shift langsung berstatus Ditutup.
  let cashSales = 0;
  let qrisSales = 0;
  let salesTotal = 0;
  let voidAmount = 0;
  let voidCount = 0;
  let gallons = 0;
  let gallonLiters = 0;
  const usage: Record<string, number> = {};
  for (const s of D02_SALES) {
    const total = s.lines.reduce(
      (a, [code, q]) => a + (PRICE[code] ?? 0) * q,
      0,
    );
    if (s.voided) {
      voidCount++;
      voidAmount += total;
      continue;
    }
    salesTotal += total;
    if (s.method === "cash") cashSales += total;
    else qrisSales += total;
    for (const [code, q] of s.lines) {
      if (GALLON_L[code]) {
        gallons += q;
        gallonLiters += q * GALLON_L[code];
      }
      for (const r of RECIPE[code] ?? [])
        usage[r.material] = (usage[r.material] ?? 0) + r.quantity * q;
    }
  }
  const expectedCash = openingCash + cashSales;
  const closingCash = expectedCash - 2_000;
  const depositAmount = expectedCash - openingCash;

  const inserted = await tx
    .insert(shifts)
    .values({
      id: DEMO_M6_SHIFT_ID,
      tenantId: EQUA_TENANT_ID,
      outletId: oid,
      operatorUserId: operator,
      businessDate: day,
      status: "closed",
      openedAt,
      closedAt,
      openingCashFixed: openingCash,
      openingCashCounted: openingCash,
      cashSales,
      qrisSales,
      creditSales: 0,
      voidCount,
      voidAmount,
      expectedCash,
      closingCashCounted: closingCash,
      cashDifference: -2_000,
      cashDifferenceReason:
        "Kembalian lebih Rp2.000 ke pelanggan (tidak teliti)",
      depositAmount,
      depositStatus: "deposited",
      depositedAt: new Date(closedAt.getTime() + 10 * MIN),
      deviceId: device,
      deviceTime: openedAt,
      syncedAt: new Date(openedAt.getTime() + 2 * MIN),
      createdBy: operator,
    })
    .onConflictDoNothing()
    .returning({ id: shifts.id });
  if (!inserted.length) return false;

  // --- Hitung stok awal (sistem = saldo saat buka).
  const materials = ["TUTUP", "TISU", "GALON-KOSONG"] as const;
  const balance: Record<string, { qty: number; cost: number }> =
    Object.fromEntries(
      (OPENING_STOCK.D02 ?? []).map((s) => [
        s.code,
        { qty: s.quantity, cost: s.unitCost },
      ]),
    );
  await tx
    .insert(shiftStockCounts)
    .values(
      materials.map((m) => ({
        id: seedId(`m6:demo:shift_stock:D02:opening:${m}`),
        tenantId: EQUA_TENANT_ID,
        shiftId: DEMO_M6_SHIFT_ID,
        outletId: oid,
        productId: productId(m),
        phase: "opening" as const,
        systemQty: balance[m]?.qty ?? 0,
      })),
    )
    .onConflictDoNothing();

  // --- Transaksi.
  let number = 0;
  const saleIds: string[] = [];
  const voidedIds: string[] = [];
  for (const [i, s] of D02_SALES.entries()) {
    const seq = i + 1;
    const id = seedId(`m6:demo:sale:D02:${seq}`);
    saleIds.push(id);
    const soldAt = new Date(openedAt.getTime() + s.minute * MIN);
    const total = s.lines.reduce(
      (a, [code, q]) => a + (PRICE[code] ?? 0) * q,
      0,
    );
    number++;
    await tx
      .insert(posSales)
      .values({
        id,
        tenantId: EQUA_TENANT_ID,
        outletId: oid,
        shiftId: DEMO_M6_SHIFT_ID,
        number: `D02-${yymmdd}-${String(number).padStart(4, "0")}`,
        localNumber: `D02-${yymmdd}-POSD02-${String(9000 + seq).padStart(4, "0")}`,
        deviceSeq: 9000 + seq,
        operatorUserId: operator,
        priceKind: "standard",
        businessDate: day,
        soldAt,
        subtotal: total,
        total,
        paymentMethod: s.method,
        cashReceived: s.method === "cash" ? (s.cashReceived ?? total) : null,
        changeAmount:
          s.method === "cash" ? (s.cashReceived ?? total) - total : null,
        qrisReference:
          s.method === "qris"
            ? `QR${yymmdd}${String(seq).padStart(3, "0")}`
            : null,
        status: s.voided ? "voided" : "valid",
        voidReason: s.voided?.reason ?? null,
        voidNote: s.voided?.note ?? null,
        voidRequestedAt: s.voided ? new Date(soldAt.getTime() + MIN) : null,
        voidedAt: s.voided ? new Date(soldAt.getTime() + MIN) : null,
        voidedBy: s.voided ? operator : null,
        replacesSaleId: s.replaces
          ? seedId(`m6:demo:sale:D02:${s.replaces}`)
          : null,
        receiptPrinted: false,
        deviceId: device,
        deviceTime: soldAt,
        syncedAt: new Date(soldAt.getTime() + 30_000),
        createdBy: operator,
      })
      .onConflictDoNothing();
    await tx
      .insert(posSaleLines)
      .values(
        s.lines.map(([code, q], li) => ({
          id: seedId(`m6:demo:sale_line:D02:${seq}:${li + 1}`),
          posSaleId: id,
          tenantId: EQUA_TENANT_ID,
          outletId: oid,
          businessDate: day,
          lineNo: li + 1,
          productId: productId(code),
          quantity: q,
          unitPrice: PRICE[code] ?? 0,
          lineTotal: (PRICE[code] ?? 0) * q,
          gallonSizeL: GALLON_L[code] ?? null,
        })),
      )
      .onConflictDoNothing();
    if (s.voided) voidedIds.push(id);
  }
  await bumpSequence(tx, "pos_sale", `D02-${yymmdd}`, number);

  // --- Hitung stok akhir (sistem = saldo − pemakaian seharusnya) + posting pemakaian bahan (sumber: shift).
  const physical: Record<string, { qty: number; reason?: string }> = {
    TUTUP: { qty: 400 - (usage.TUTUP ?? 0) },
    TISU: {
      qty: 400 - (usage.TISU ?? 0) - 2,
      reason: "2 tisu sobek saat dipasang",
    },
    "GALON-KOSONG": { qty: 40 - (usage["GALON-KOSONG"] ?? 0) },
  };
  const stockSummary: Record<string, unknown>[] = [];
  for (const m of materials) {
    const b = balance[m]!;
    const used = usage[m] ?? 0;
    const systemQty = b.qty - used;
    const phys = physical[m]!;
    await tx
      .insert(shiftStockCounts)
      .values({
        id: seedId(`m6:demo:shift_stock:D02:closing:${m}`),
        tenantId: EQUA_TENANT_ID,
        shiftId: DEMO_M6_SHIFT_ID,
        outletId: oid,
        productId: productId(m),
        phase: "closing",
        systemQty,
        physicalQty: phys.qty,
        expectedUsage: used,
        difference: phys.qty - systemQty,
        reason: phys.reason ?? null,
      })
      .onConflictDoNothing();
    stockSummary.push({
      productId: productId(m),
      name: PRODUCT_SEEDS.find((p) => p.code === m)?.name ?? m,
      expectedUsage: used,
      systemQty,
      physicalQty: phys.qty,
      difference: phys.qty - systemQty,
      reason: phys.reason ?? null,
    });
    if (used > 0) {
      await tx.insert(stockLedger).values({
        id: seedId(`m6:demo:stock_consumption:D02:${m}`),
        tenantId: EQUA_TENANT_ID,
        outletId: oid,
        productId: productId(m),
        kind: "consumption",
        quantity: -used,
        unitCost: b.cost,
        totalCost: -used * b.cost,
        balanceAfter: systemQty,
        avgCostAfter: b.cost,
        businessDate: day,
        occurredAt: closedAt,
        sourceObjectType: "shift",
        sourceObjectId: DEMO_M6_SHIFT_ID,
        note: "Pemakaian seharusnya (resep) — tutup shift",
        createdBy: operator,
      });
      await tx
        .update(stockBalances)
        .set({
          quantity: systemQty,
          totalValue: systemQty * b.cost,
          lastMovementAt: closedAt,
        })
        .where(
          and(
            eq(stockBalances.outletId, oid),
            eq(stockBalances.productId, productId(m)),
          ),
        );
    }
  }

  // --- Buku air: penjualan galon shift.
  const waterAfterSupply = (OPENING_WATER_L.D02 ?? 0) + 2_980;
  await tx
    .insert(outletWaterLedger)
    .values({
      id: seedId("m6:demo:water_sales_out:D02"),
      tenantId: EQUA_TENANT_ID,
      outletId: oid,
      businessDate: day,
      kind: "sales_out",
      volumeL: -gallonLiters,
      balanceAfterL: waterAfterSupply - gallonLiters,
      sourceObjectType: "shift",
      sourceObjectId: DEMO_M6_SHIFT_ID,
      occurredAt: closedAt,
    })
    .onConflictDoNothing();

  // --- Tutup kas & setoran akhir (Diajukan → menunggu diterima Kasir Kantor).
  const depositNo = await nextSeq(tx, "deposit", day.slice(2, 4));
  const depositId = seedId("m6:demo:deposit:D02:shift");
  await tx
    .insert(deposits)
    .values({
      id: depositId,
      tenantId: EQUA_TENANT_ID,
      number: `S-${day.slice(2, 4)}-${String(depositNo).padStart(6, "0")}`,
      sourceType: "depot_shift",
      businessDate: day,
      status: "submitted",
      depositorUserId: operator,
      outletId: oid,
      shiftId: DEMO_M6_SHIFT_ID,
      method: "physical",
      expectedCash: depositAmount,
      expectedNet: depositAmount,
      submittedAt: closedAt,
      isPartial: false,
      summarySnapshot: {
        kind: "shift_close",
        salesTotal,
        cashSales,
        qrisSales,
        openingCash,
        partialDepositTotal: 0,
        closingCashCounted: closingCash,
        cashDifference: -2_000,
      },
      deviceId: device,
      deviceTime: closedAt,
      createdBy: operator,
    })
    .onConflictDoNothing();
  await tx
    .update(shifts)
    .set({
      depositId,
      summary: {
        salesTotal,
        saleCount: D02_SALES.length,
        countedCount: D02_SALES.length - voidCount,
        qrisCount: D02_SALES.filter((s) => s.method === "qris" && !s.voided)
          .length,
        voidPendingCount: 0,
        voidPendingAmount: 0,
        voidCashAmount: voidAmount,
        priceMismatchCount: 0,
        gallonsSold: gallons,
        gallonLitersSold: gallonLiters,
        expectedDrawer: expectedCash,
        usage: Object.fromEntries(
          materials.map((m) => [productId(m), usage[m] ?? 0]),
        ),
        stock: stockSummary,
        device: { saleIds, voidedSaleIds: voidedIds },
        closeConflicts: [],
        cashDiscrepancyOverThreshold: false,
        demo: true,
      },
    })
    .where(eq(shifts.id, DEMO_M6_SHIFT_ID));
  return true;
}

async function seedWaterSupplies(
  tx: DbOrTx,
  day: BusinessDate,
  now: Date,
  withD02: boolean,
): Promise<number> {
  let n = 0;
  // D02: pasokan truk kemarin pagi, dikonfirmasi operator dengan selisih beralasan.
  const d02At = wibToUtc(day, "06:30");
  const d02 = !withD02
    ? []
    : await tx
        .insert(waterSupplyReceipts)
        .values({
          id: seedId("m6:demo:water_supply:D02:confirmed"),
          tenantId: EQUA_TENANT_ID,
          outletId: outletId("D02"),
          source: "equa_truck",
          status: "discrepancy",
          deliveredVolumeL: 3_000,
          receivedVolumeL: 2_980,
          differenceL: -20,
          differenceReason: "Sebagian tumpah saat selang dilepas",
          confirmedAt: new Date(d02At.getTime() + 40 * MIN),
          confirmedBy: userIdByUsername("depot02"),
          businessDate: day,
          deviceId: deviceId("POS-D02"),
          deviceTime: new Date(d02At.getTime() + 40 * MIN),
        })
        .onConflictDoNothing()
        .returning({ id: waterSupplyReceipts.id });
  if (d02.length) {
    n++;
    await tx
      .insert(outletWaterLedger)
      .values({
        id: seedId("m6:demo:water_supply_in:D02"),
        tenantId: EQUA_TENANT_ID,
        outletId: outletId("D02"),
        businessDate: day,
        kind: "supply_in",
        volumeL: 2_980,
        balanceAfterL: (OPENING_WATER_L.D02 ?? 0) + 2_980,
        sourceObjectType: "water_supply_receipt",
        sourceObjectId: d02[0]!.id,
        occurredAt: new Date(d02At.getTime() + 40 * MIN),
      })
      .onConflictDoNothing();
  }
  // D03: pasokan truk tiba 2 jam lalu, menunggu konfirmasi operator.
  const d03 = await tx
    .insert(waterSupplyReceipts)
    .values({
      id: seedId("m6:demo:water_supply:D03:arrived"),
      tenantId: EQUA_TENANT_ID,
      outletId: outletId("D03"),
      source: "equa_truck",
      status: "arrived",
      deliveredVolumeL: 4_000,
      businessDate: toBusinessDate(new Date(now.getTime() - 2 * HOUR)),
      createdAt: new Date(now.getTime() - 2 * HOUR),
    })
    .onConflictDoNothing()
    .returning({ id: waterSupplyReceipts.id });
  return n + d03.length;
}

export async function seedDemoM6Pos(
  tx: DbOrTx,
  now: Date = new Date(),
): Promise<{ stockLines: number; shift: boolean; supplies: number }> {
  const today = toBusinessDate(now);
  const yesterday = addDays(today, -1);
  const openingAt = new Date(now.getTime() - 7 * DAY);
  const openingDate = toBusinessDate(openingAt);
  const stockD02 = await seedOpeningStock(tx, "D02", openingAt, openingDate);
  const stockD03 = await seedOpeningStock(tx, "D03", openingAt, openingDate);
  const waterD02 = await seedOpeningWater(tx, "D02", openingAt, openingDate);
  await seedOpeningWater(tx, "D03", openingAt, openingDate);
  // Shift & pasokan D02 hanya bersama stok/buku air awalnya (saldo konsisten); jalankan ulang → tidak ada perubahan.
  const supplies = await seedWaterSupplies(tx, yesterday, now, waterD02);
  const shift =
    stockD02 > 0 && waterD02 ? await seedClosedShiftD02(tx, yesterday) : false;
  return { stockLines: stockD02 + stockD03, shift, supplies };
}
