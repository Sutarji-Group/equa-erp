/**
 * Seed demo M7 — Penjualan Toko & Stok (toko TK1). Idempoten: seluruh data demo ditulis SEKALI — hanya bila toko TK1
 * belum punya mutasi stok (penanda: baris pemasok demo belum ada); ID deterministik + ON CONFLICT DO NOTHING; nomor
 * urut dokumen dinaikkan hanya saat baris benar-benar baru dibuat.
 *
 * Isi (relatif terhadap `now`):
 * - 3 pemasok aktif (tempo 14 hari, bawaan PAR-67, 7 hari).
 * - Stok awal 9 barang toko (40 hari lalu, harga beli terakhir = harga pokok awal).
 * - Nota pembelian: CV Sumber Plastik (20 hari lalu, dibayar sebagian Rp400.000 kas kantor → lewat jatuh tempo),
 *   Grosir Makmur (5 hari lalu, belum jatuh tempo), saldo awal utang cut-over Grosir Makmur (jatuh tempo 3 hari lalu),
 *   nota pengganti UD Filter Jaya (kemarin) menunggu diterima Admin Keuangan.
 * - Opname bulanan bulan lalu (Disetujui; selisih tisu −5 rusak) + penyesuaian di kartu stok.
 * - Transfer internal 2 hari lalu ke D03 (tutup & tisu, nilai harga mitra) berstatus Dikirim (menunggu diterima operator).
 * - Shift toko KEMARIN yang sudah ditutup kasir `kasir`: 7 transaksi (umum/mitra, tunai/QRIS/tempo mitra, diskon 3%
 *   beralasan), HPP per baris, setoran "Diajukan" (menunggu Kasir Kantor M4).
 * - Daftar pesan ulang: galon kosong (sudah dipesan), filter & lampu UV (perlu dipesan).
 * Tidak ada shift terbuka (kasir membuka shift sendiri di /pos) dan tidak ada permintaan persetujuan.
 * Event domain TIDAK dipancarkan (seed menulis langsung) — penjualan tempo demo belum difakturkan M5.
 */
import { eq, sql } from "drizzle-orm";

import { addDays, firstDayOfMonth, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import type { DbOrTx } from "../client";
import {
  deposits,
  documentSequences,
  internalTransferLines,
  internalTransfers,
  posSaleLines,
  posSales,
  purchaseReceiptLines,
  purchaseReceipts,
  reorderItems,
  shifts,
  stockBalances,
  stockCountLines,
  stockCounts,
  stockLedger,
  supplierPaymentAllocations,
  supplierPayments,
  suppliers,
} from "../schema";
import { productId } from "./catalog";
import { customerId } from "./customers";
import { seedId } from "./ids";
import { deviceId, EQUA_TENANT_ID, outletId, userIdByUsername } from "./org";

const MIN = 60_000;

export const DEMO_M7_SUPPLIERS = {
  plastik: seedId("m7:demo:supplier:sumber-plastik"),
  grosir: seedId("m7:demo:supplier:grosir-makmur"),
  filter: seedId("m7:demo:supplier:filter-jaya"),
} as const;
export const DEMO_M7_SHIFT_ID = seedId("m7:demo:shift:TK1:closed");
export const DEMO_M7_SUBSTITUTE_RECEIPT_ID = seedId("m7:demo:receipt:substitute");

const OPENING: Record<string, { quantity: number; unitCost: number }> = {
  "TK-GALON-KOSONG": { quantity: 30, unitCost: 33_000 },
  "TK-TUTUP": { quantity: 1_200, unitCost: 550 },
  "TK-TISU": { quantity: 900, unitCost: 280 },
  "TK-SABUN": { quantity: 8, unitCost: 25_000 },
  "TK-FILTER-10": { quantity: 14, unitCost: 29_000 },
  "TK-LAMPU-UV": { quantity: 4, unitCost: 130_000 },
  "TK-POMPA": { quantity: 12, unitCost: 21_000 },
  "TK-SIKAT": { quantity: 6, unitCost: 16_000 },
  "TK-DISPENSER": { quantity: 3, unitCost: 760_000 },
};
const MIN_STOCK: Record<string, number> = {
  "TK-GALON-KOSONG": 20,
  "TK-TUTUP": 500,
  "TK-TISU": 500,
  "TK-SABUN": 6,
  "TK-FILTER-10": 10,
  "TK-LAMPU-UV": 3,
  "TK-POMPA": 5,
  "TK-SIKAT": 5,
  "TK-DISPENSER": 2,
};

type DemoSale = {
  minute: number;
  customer?: string;
  lines: [code: string, qty: number, unitPrice: number][];
  method: "cash" | "qris" | "credit";
  cashReceived?: number;
  discount?: { amount: number; reason: string };
};

/** Transaksi shift toko kemarin (menit sejak buka 08:00 WIB). */
const SALES: DemoSale[] = [
  {
    minute: 15,
    lines: [
      ["TK-TUTUP", 20, 800],
      ["TK-TISU", 20, 400],
    ],
    method: "cash",
    cashReceived: 25_000,
  },
  { minute: 40, customer: "PLG-0002", lines: [["TK-GALON-KOSONG", 10, 35_000]], method: "cash", cashReceived: 350_000 },
  { minute: 75, lines: [["TK-POMPA", 2, 25_000]], method: "qris" },
  {
    minute: 120,
    customer: "PLG-0003",
    lines: [["TK-FILTER-10", 4, 30_000]],
    method: "cash",
    cashReceived: 120_000,
    discount: { amount: 3_600, reason: "Pelanggan tetap, beli 4 filter sekaligus (3%)" },
  },
  { minute: 200, customer: "PLG-0001", lines: [["TK-LAMPU-UV", 2, 135_000]], method: "credit" },
  { minute: 260, lines: [["TK-SABUN", 1, 30_000]], method: "cash", cashReceived: 50_000 },
  {
    minute: 330,
    customer: "PLG-0002",
    lines: [
      ["TK-TUTUP", 300, 600],
      ["TK-TISU", 300, 300],
    ],
    method: "qris",
  },
];

type Bal = { qty: number; avg: number; value: number };
type Movement = {
  key: string;
  code: string;
  kind: "opening" | "receipt" | "sale" | "adjustment" | "transfer_out";
  quantity: number;
  unitCost?: number;
  at: Date;
  date: BusinessDate;
  source?: { type: string; id: string };
  note: string;
  createdBy?: string | null;
  /** Diisi saat simulasi: HPP per satuan yang dipakai (penjualan/transfer). */
  onPosted?: (unitCost: number, balanceAfter: number) => void;
};

/** Nomor berikutnya (logika sama dengan core/numbering `nextNumber`, tanpa impor server-only). */
async function nextSeq(tx: DbOrTx, kind: string, scopeKey: string): Promise<number> {
  const rows = await tx
    .insert(documentSequences)
    .values({ id: seedId(`m7:demo:seq:${kind}:${scopeKey}:first`), tenantId: EQUA_TENANT_ID, kind, scopeKey, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.tenantId, documentSequences.kind, documentSequences.scopeKey],
      set: { lastValue: sql`${documentSequences.lastValue} + 1`, updatedAt: new Date() },
    })
    .returning({ lastValue: documentSequences.lastValue });
  return Number(rows[0]!.lastValue);
}

const yy = (d: BusinessDate) => d.slice(2, 4);
const yymmdd = (d: BusinessDate) => `${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}`;

export async function seedDemoM7Store(tx: DbOrTx, now: Date = new Date()): Promise<{ created: boolean }> {
  const [exists] = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, DEMO_M7_SUPPLIERS.plastik)).limit(1);
  if (exists) return { created: false };
  const store = outletId("TK1");
  const [ledgerRow] = await tx.select({ id: stockLedger.id }).from(stockLedger).where(eq(stockLedger.outletId, store)).limit(1);
  if (ledgerRow) return { created: false };

  const today = toBusinessDate(now);
  const yesterday = addDays(today, -1);
  const kasir = userIdByUsername("kasir");
  const finance = userIdByUsername("keuangan1");
  const device = deviceId("POS-TK1");
  const at = (daysAgo: number, time: string) => wibToUtc(addDays(today, -daysAgo), time);

  // --- Pemasok -------------------------------------------------------------------------------------------------------
  await tx
    .insert(suppliers)
    .values([
      { id: DEMO_M7_SUPPLIERS.plastik, tenantId: EQUA_TENANT_ID, code: "SUP-001", name: "CV Sumber Plastik Cianjur", contactName: "Pak Asep", phone: "081234500111", address: "Jl. Siliwangi No. 21, Cianjur", paymentTermDays: 14, status: "active", approvedBy: finance, approvedAt: at(60, "09:00"), createdBy: kasir },
      { id: DEMO_M7_SUPPLIERS.grosir, tenantId: EQUA_TENANT_ID, code: "SUP-002", name: "Toko Grosir Makmur", contactName: "Ibu Euis", phone: "081234500222", address: "Pasar Induk Cianjur Blok B-12", paymentTermDays: null, status: "active", approvedBy: finance, approvedAt: at(60, "09:05"), createdBy: kasir },
      { id: DEMO_M7_SUPPLIERS.filter, tenantId: EQUA_TENANT_ID, code: "SUP-003", name: "UD Filter Jaya Bandung", contactName: "Pak Hendra", phone: "081234500333", address: "Jl. Soekarno-Hatta No. 400, Bandung", paymentTermDays: 7, status: "active", approvedBy: finance, approvedAt: at(60, "09:10"), createdBy: kasir },
    ])
    .onConflictDoNothing();

  const movements: Movement[] = [];

  // --- Stok awal (40 hari lalu) --------------------------------------------------------------------------------------
  const openingAt = at(40, "08:00");
  for (const [code, o] of Object.entries(OPENING)) {
    movements.push({ key: `opening:${code}`, code, kind: "opening", quantity: o.quantity, unitCost: o.unitCost, at: openingAt, date: toBusinessDate(openingAt), note: "Stok awal (data demo)" });
  }

  // --- Nota pembelian ------------------------------------------------------------------------------------------------
  type ReceiptDemo = {
    key: string;
    supplierId: string;
    noteNumber: string | null;
    noteDaysAgo: number;
    time: string;
    dueDate: BusinessDate | null;
    lines: [code: string, qty: number, unitCost: number][];
    substitute?: boolean;
    opening?: { amount: number };
    notes?: string;
  };
  const receiptsDemo: ReceiptDemo[] = [
    {
      key: "plastik",
      supplierId: DEMO_M7_SUPPLIERS.plastik,
      noteNumber: "SP-118",
      noteDaysAgo: 20,
      time: "10:00",
      dueDate: addDays(today, -6),
      lines: [
        ["TK-TUTUP", 1_000, 600],
        ["TK-TISU", 1_000, 300],
      ],
    },
    {
      key: "grosir",
      supplierId: DEMO_M7_SUPPLIERS.grosir,
      noteNumber: "GM-7781",
      noteDaysAgo: 5,
      time: "11:00",
      dueDate: addDays(today, 25),
      lines: [
        ["TK-SABUN", 12, 26_000],
        ["TK-SIKAT", 10, 17_000],
      ],
    },
    { key: "opening", supplierId: DEMO_M7_SUPPLIERS.grosir, noteNumber: "GM-6920", noteDaysAgo: 33, time: "09:00", dueDate: addDays(today, -3), lines: [], opening: { amount: 750_000 }, notes: "Saldo awal utang pemasok (cut-over)" },
    {
      key: "substitute",
      supplierId: DEMO_M7_SUPPLIERS.filter,
      noteNumber: null,
      noteDaysAgo: 1,
      time: "13:30",
      dueDate: addDays(yesterday, 7),
      lines: [["TK-FILTER-10", 6, 29_500]],
      substitute: true,
      notes: "Nota asli terbawa sopir pemasok — dikirim menyusul",
    },
  ];
  const receiptIds: Record<string, string> = {};
  for (const r of receiptsDemo) {
    const id = r.substitute ? DEMO_M7_SUBSTITUTE_RECEIPT_ID : seedId(`m7:demo:receipt:${r.key}`);
    receiptIds[r.key] = id;
    const recordedAt = r.opening ? at(40, "09:00") : at(r.noteDaysAgo, r.time);
    const date = toBusinessDate(recordedAt);
    const total = r.opening ? r.opening.amount : r.lines.reduce((s, [, q, c]) => s + q * c, 0);
    const seq = await nextSeq(tx, "purchase_receipt", yy(date));
    const paid = r.key === "plastik" ? 400_000 : 0;
    await tx
      .insert(purchaseReceipts)
      .values({
        id,
        tenantId: EQUA_TENANT_ID,
        outletId: store,
        number: `NB-${yy(date)}-${String(seq).padStart(6, "0")}`,
        supplierId: r.supplierId,
        supplierNoteNumber: r.noteNumber,
        supplierNoteDate: addDays(today, -r.noteDaysAgo),
        isSubstituteNote: r.substitute ?? false,
        status: r.substitute ? "pending_acceptance" : "received",
        totalAmount: total,
        paidAmount: paid,
        paymentStatus: paid ? "partial" : "unpaid",
        dueDate: r.dueDate,
        isOpeningPayable: !!r.opening,
        receivedBy: r.opening ? finance : kasir,
        businessDate: date,
        notes: r.notes ?? null,
        recordedByOffice: !!r.opening,
        deviceTime: r.opening ? null : recordedAt,
        syncedAt: r.opening ? null : new Date(recordedAt.getTime() + MIN),
        createdAt: recordedAt,
        createdBy: r.opening ? finance : kasir,
      })
      .onConflictDoNothing();
    if (r.lines.length) {
      await tx
        .insert(purchaseReceiptLines)
        .values(r.lines.map(([code, q, c], i) => ({ id: seedId(`m7:demo:receipt_line:${r.key}:${i}`), tenantId: EQUA_TENANT_ID, receiptId: id, productId: productId(code), quantity: q, unitCost: c, lineTotal: q * c })))
        .onConflictDoNothing();
    }
    if (!r.substitute && !r.opening) {
      for (const [code, q, c] of r.lines) {
        movements.push({ key: `receipt:${r.key}:${code}`, code, kind: "receipt", quantity: q, unitCost: c, at: recordedAt, date, source: { type: "purchase_receipt", id }, note: `Nota ${r.noteNumber}`, createdBy: kasir });
      }
    }
  }

  // Pembayaran sebagian nota Sumber Plastik (kas kantor, 10 hari lalu).
  const paymentId = seedId("m7:demo:supplier_payment:plastik");
  await tx
    .insert(supplierPayments)
    .values({ id: paymentId, tenantId: EQUA_TENANT_ID, supplierId: DEMO_M7_SUPPLIERS.plastik, businessDate: addDays(today, -10), amount: 400_000, method: "cash", notes: "Cicilan pertama nota SP-118", createdAt: at(10, "14:00"), createdBy: finance })
    .onConflictDoNothing();
  await tx
    .insert(supplierPaymentAllocations)
    .values({ id: seedId("m7:demo:supplier_payment_alloc:plastik"), supplierPaymentId: paymentId, purchaseReceiptId: receiptIds.plastik!, amount: 400_000, createdBy: finance })
    .onConflictDoNothing();

  // --- Opname bulanan bulan lalu (Disetujui; tisu −5 rusak) -----------------------------------------------------------
  const countDate = addDays(firstDayOfMonth(today), -1);
  const countAt = wibToUtc(countDate, "16:00");
  const countId = seedId("m7:demo:stock_count:monthly");
  const countLines: { code: string; physical: number; system: number; unitCost: number }[] = [];
  for (const code of Object.keys(OPENING)) {
    movements.push({
      key: `count:${code}`,
      code,
      kind: "adjustment",
      quantity: 0,
      at: countAt,
      date: countDate,
      note: "Titik opname",
    });
  }

  // --- Transfer internal ke D03 (2 hari lalu) -------------------------------------------------------------------------
  const transferAt = at(2, "09:00");
  const transferDate = toBusinessDate(transferAt);
  const transferId = seedId("m7:demo:internal_transfer:D03");
  const transferLines: { code: string; toCode: string; qty: number; unitValue: number; unitCost: number }[] = [
    { code: "TK-TUTUP", toCode: "TUTUP", qty: 100, unitValue: 600, unitCost: 0 },
    { code: "TK-TISU", toCode: "TISU", qty: 100, unitValue: 300, unitCost: 0 },
  ];
  const transferSeq = await nextSeq(tx, "internal_transfer", yy(transferDate));
  const transferNumber = `TI-${yy(transferDate)}-${String(transferSeq).padStart(5, "0")}`;
  for (const l of transferLines) {
    movements.push({
      key: `transfer:${l.code}`,
      code: l.code,
      kind: "transfer_out",
      quantity: -l.qty,
      at: transferAt,
      date: transferDate,
      source: { type: "internal_transfer", id: transferId },
      note: `Transfer internal ${transferNumber} ke depot D03`,
      createdBy: kasir,
      onPosted: (cost) => {
        l.unitCost = cost;
      },
    });
  }

  // --- Shift kemarin & penjualan -------------------------------------------------------------------------------------
  const openedAt = wibToUtc(yesterday, "08:00");
  const closedAt = wibToUtc(yesterday, "15:30");
  const saleRows: { id: string; soldAt: Date; number: string; localNumber: string; seq: number; sale: DemoSale; subtotal: number; total: number; unitCosts: Map<string, number> }[] = [];
  for (const [i, s] of SALES.entries()) {
    const seq = i + 1;
    const id = seedId(`m7:demo:sale:TK1:${seq}`);
    const soldAt = new Date(openedAt.getTime() + s.minute * MIN);
    const subtotal = s.lines.reduce((a, [, q, p]) => a + q * p, 0);
    const total = subtotal - (s.discount?.amount ?? 0);
    const n = await nextSeq(tx, "pos_sale", `TK1-${yymmdd(yesterday)}`);
    const row = { id, soldAt, number: `TK1-${yymmdd(yesterday)}-${String(n).padStart(4, "0")}`, localNumber: `TK1-${yymmdd(yesterday)}-POSTK1-${9000 + seq}`, seq, sale: s, subtotal, total, unitCosts: new Map<string, number>() };
    saleRows.push(row);
    for (const [code, q] of s.lines) {
      movements.push({
        key: `sale:${seq}:${code}`,
        code,
        kind: "sale",
        quantity: -q,
        at: soldAt,
        date: yesterday,
        source: { type: "pos_sale", id },
        note: `Penjualan ${row.number}`,
        createdBy: kasir,
        onPosted: (cost) => {
          row.unitCosts.set(code, cost);
        },
      });
    }
  }

  // --- Simulasi kartu stok (urut waktu; rata-rata tertimbang seperti postStockMovement) -------------------------------
  movements.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === "adjustment" ? 1 : 0) - (b.kind === "adjustment" ? 1 : 0));
  const bal = new Map<string, Bal>();
  const ledger: (typeof stockLedger.$inferInsert)[] = [];
  const reorderAt = new Map<string, { at: Date; balance: number }>();
  for (const m of movements) {
    const b = bal.get(m.code) ?? { qty: 0, avg: 0, value: 0 };
    if (m.kind === "adjustment") {
      // Titik opname: catat sistem saat hitung; tisu fisik −5 → penyesuaian (disetujui) sejam kemudian.
      const physical = m.code === "TK-TISU" ? b.qty - 5 : b.qty;
      countLines.push({ code: m.code, physical, system: b.qty, unitCost: b.avg });
      if (physical !== b.qty) {
        const q = physical - b.qty;
        const value = b.qty + q === 0 ? 0 : b.value + q * b.avg;
        ledger.push({
          id: seedId(`m7:demo:ledger:${m.key}`),
          tenantId: EQUA_TENANT_ID,
          outletId: store,
          productId: productId(m.code),
          kind: "adjustment",
          quantity: q,
          unitCost: b.avg,
          totalCost: q * b.avg,
          balanceAfter: b.qty + q,
          avgCostAfter: b.avg,
          businessDate: countDate,
          occurredAt: new Date(countAt.getTime() + 60 * MIN),
          sourceObjectType: "stock_count",
          sourceObjectId: countId,
          note: "Penyesuaian opname (rusak) — disetujui pemilik",
          createdBy: finance,
        });
        b.qty += q;
        b.value = value;
      }
      bal.set(m.code, b);
      continue;
    }
    let unitCost = b.avg;
    const q1 = b.qty + m.quantity;
    let v1: number;
    let avg1 = b.avg;
    if (m.quantity > 0 && m.unitCost !== undefined) {
      unitCost = m.unitCost;
      v1 = b.value + m.quantity * unitCost;
      avg1 = q1 > 0 ? Math.round(v1 / q1) : unitCost;
    } else {
      v1 = q1 === 0 ? 0 : b.value + m.quantity * b.avg;
    }
    ledger.push({
      id: seedId(`m7:demo:ledger:${m.key}`),
      tenantId: EQUA_TENANT_ID,
      outletId: store,
      productId: productId(m.code),
      kind: m.kind,
      quantity: m.quantity,
      unitCost,
      totalCost: m.quantity * unitCost,
      balanceAfter: q1,
      avgCostAfter: avg1,
      businessDate: m.date,
      occurredAt: m.at,
      sourceObjectType: m.source?.type ?? null,
      sourceObjectId: m.source?.id ?? null,
      note: m.note,
      createdBy: m.createdBy ?? null,
    });
    m.onPosted?.(unitCost, q1);
    bal.set(m.code, { qty: q1, avg: avg1, value: v1 });
    const min = MIN_STOCK[m.code];
    if (m.quantity < 0 && min !== undefined && q1 <= min && !reorderAt.has(m.code)) reorderAt.set(m.code, { at: m.at, balance: q1 });
  }

  // --- Tulis stok -----------------------------------------------------------------------------------------------------
  await tx.insert(stockLedger).values(ledger).onConflictDoNothing();
  const lastAt = new Map<string, Date>();
  for (const l of ledger) lastAt.set(l.productId, l.occurredAt as Date);
  await tx
    .insert(stockBalances)
    .values(
      [...bal.entries()].map(([code, b]) => ({
        id: seedId(`m7:demo:stock_balance:TK1:${code}`),
        tenantId: EQUA_TENANT_ID,
        outletId: store,
        productId: productId(code),
        quantity: b.qty,
        avgCost: b.avg,
        totalValue: b.value,
        lastMovementAt: lastAt.get(productId(code)) ?? openingAt,
      })),
    )
    .onConflictDoNothing();

  // --- Opname bulan lalu ----------------------------------------------------------------------------------------------
  await tx
    .insert(stockCounts)
    .values({
      id: countId,
      tenantId: EQUA_TENANT_ID,
      outletId: store,
      kind: "monthly_store",
      periodLabel: countDate.slice(0, 7),
      status: "approved",
      startedAt: countAt,
      countedBy: kasir,
      coCounterUserId: finance,
      submittedAt: new Date(countAt.getTime() + 30 * MIN),
      decidedAt: new Date(countAt.getTime() + 60 * MIN),
      adjustmentPostedAt: new Date(countAt.getTime() + 60 * MIN),
      notes: "Opname bulanan (data demo)",
      deviceId: device,
      deviceTime: countAt,
      createdBy: kasir,
    })
    .onConflictDoNothing();
  await tx
    .insert(stockCountLines)
    .values(
      countLines.map((l) => ({
        id: seedId(`m7:demo:stock_count_line:${l.code}`),
        tenantId: EQUA_TENANT_ID,
        stockCountId: countId,
        productId: productId(l.code),
        physicalQty: l.physical,
        systemQtyAtCount: l.system,
        countedAt: countAt,
        differenceQty: l.physical - l.system,
        unitCost: l.unitCost,
        differenceValue: (l.physical - l.system) * l.unitCost,
        reason: l.physical !== l.system ? ("damaged" as const) : null,
        reasonNote: l.physical !== l.system ? "Basah terkena rembesan atap gudang" : null,
      })),
    )
    .onConflictDoNothing();

  // --- Transfer internal ----------------------------------------------------------------------------------------------
  await tx
    .insert(internalTransfers)
    .values({
      id: transferId,
      tenantId: EQUA_TENANT_ID,
      number: transferNumber,
      localNumber: `TK1-TI-9001`,
      deviceSeq: 9001,
      fromOutletId: store,
      toOutletId: outletId("D03"),
      status: "sent",
      businessDate: transferDate,
      sentAt: transferAt,
      sentBy: kasir,
      totalValue: transferLines.reduce((s, l) => s + l.qty * l.unitValue, 0),
      notes: "Kiriman bahan rutin (data demo)",
      deviceId: device,
      deviceTime: transferAt,
      syncedAt: new Date(transferAt.getTime() + MIN),
      createdBy: kasir,
    })
    .onConflictDoNothing();
  await tx
    .insert(internalTransferLines)
    .values(
      transferLines.map((l, i) => ({
        id: seedId(`m7:demo:internal_transfer_line:${i}`),
        tenantId: EQUA_TENANT_ID,
        transferId,
        productId: productId(l.code),
        toProductId: productId(l.toCode),
        quantitySent: l.qty,
        unitValue: l.unitValue,
        unitCost: l.unitCost,
        lineValue: l.qty * l.unitValue,
      })),
    )
    .onConflictDoNothing();

  // --- Shift & transaksi ----------------------------------------------------------------------------------------------
  const openingCash = 200_000;
  const cashSales = saleRows.filter((r) => r.sale.method === "cash").reduce((s, r) => s + r.total, 0);
  const qrisSales = saleRows.filter((r) => r.sale.method === "qris").reduce((s, r) => s + r.total, 0);
  const creditSales = saleRows.filter((r) => r.sale.method === "credit").reduce((s, r) => s + r.total, 0);
  const expectedCash = openingCash + cashSales;
  await tx
    .insert(shifts)
    .values({
      id: DEMO_M7_SHIFT_ID,
      tenantId: EQUA_TENANT_ID,
      outletId: store,
      operatorUserId: kasir,
      businessDate: yesterday,
      status: "closed",
      openedAt,
      closedAt,
      openingCashFixed: openingCash,
      openingCashCounted: openingCash,
      cashSales,
      qrisSales,
      creditSales,
      voidCount: 0,
      voidAmount: 0,
      expectedCash,
      closingCashCounted: expectedCash,
      cashDifference: 0,
      depositAmount: cashSales,
      depositStatus: "deposited",
      depositedAt: new Date(closedAt.getTime() + 10 * MIN),
      deviceId: device,
      deviceTime: openedAt,
      syncedAt: new Date(openedAt.getTime() + 2 * MIN),
      createdBy: kasir,
    })
    .onConflictDoNothing();
  for (const r of saleRows) {
    const s = r.sale;
    await tx
      .insert(posSales)
      .values({
        id: r.id,
        tenantId: EQUA_TENANT_ID,
        outletId: store,
        shiftId: DEMO_M7_SHIFT_ID,
        number: r.number,
        localNumber: r.localNumber,
        deviceSeq: 9000 + r.seq,
        operatorUserId: kasir,
        customerId: s.customer ? customerId(s.customer) : null,
        priceKind: s.customer ? "partner" : "general",
        businessDate: yesterday,
        soldAt: r.soldAt,
        subtotal: r.subtotal,
        discountAmount: s.discount?.amount ?? 0,
        discountReason: s.discount?.reason ?? null,
        total: r.total,
        paymentMethod: s.method,
        cashReceived: s.method === "cash" ? (s.cashReceived ?? r.total) : null,
        changeAmount: s.method === "cash" ? (s.cashReceived ?? r.total) - r.total : null,
        qrisReference: s.method === "qris" ? `QR${yymmdd(yesterday)}${r.seq}` : null,
        status: "valid",
        receiptPrinted: true,
        deviceId: device,
        deviceTime: r.soldAt,
        syncedAt: new Date(r.soldAt.getTime() + MIN),
        createdBy: kasir,
      })
      .onConflictDoNothing();
    await tx
      .insert(posSaleLines)
      .values(
        s.lines.map(([code, q, p], i) => ({
          id: seedId(`m7:demo:sale_line:TK1:${r.seq}:${i}`),
          posSaleId: r.id,
          tenantId: EQUA_TENANT_ID,
          outletId: store,
          businessDate: yesterday,
          lineNo: i + 1,
          productId: productId(code),
          quantity: q,
          unitPrice: p,
          lineTotal: q * p,
          unitCost: r.unitCosts.get(code) ?? null,
        })),
      )
      .onConflictDoNothing();
  }
  const depositNo = await nextSeq(tx, "deposit", yy(yesterday));
  const depositId = seedId("m7:demo:deposit:TK1:shift");
  await tx
    .insert(deposits)
    .values({
      id: depositId,
      tenantId: EQUA_TENANT_ID,
      number: `S-${yy(yesterday)}-${String(depositNo).padStart(6, "0")}`,
      sourceType: "store_shift",
      businessDate: yesterday,
      status: "submitted",
      depositorUserId: kasir,
      outletId: store,
      shiftId: DEMO_M7_SHIFT_ID,
      method: "physical",
      expectedCash: cashSales,
      expectedNet: cashSales,
      submittedAt: closedAt,
      isPartial: false,
      summarySnapshot: { kind: "shift_close", salesTotal: cashSales + qrisSales + creditSales, cashSales, qrisSales, creditSales, openingCash, partialDepositTotal: 0, closingCashCounted: expectedCash, cashDifference: 0 },
      deviceId: device,
      deviceTime: closedAt,
      createdBy: kasir,
    })
    .onConflictDoNothing();
  await tx
    .update(shifts)
    .set({
      depositId,
      summary: {
        salesTotal: cashSales + qrisSales + creditSales,
        saleCount: saleRows.length,
        countedCount: saleRows.length,
        qrisCount: saleRows.filter((r) => r.sale.method === "qris").length,
        creditCount: saleRows.filter((r) => r.sale.method === "credit").length,
        voidPendingCount: 0,
        voidPendingAmount: 0,
        voidCashAmount: 0,
        priceMismatchCount: 0,
        expectedDrawer: expectedCash,
        device: { saleIds: saleRows.map((r) => r.id), voidedSaleIds: [] },
        closeConflicts: [],
        cashDiscrepancyOverThreshold: false,
        demo: true,
      },
    })
    .where(eq(shifts.id, DEMO_M7_SHIFT_ID));

  // --- Daftar pesan ulang ---------------------------------------------------------------------------------------------
  for (const [code, r] of reorderAt) {
    const ordered = code === "TK-GALON-KOSONG";
    await tx
      .insert(reorderItems)
      .values({
        id: seedId(`m7:demo:reorder:${code}`),
        tenantId: EQUA_TENANT_ID,
        outletId: store,
        productId: productId(code),
        status: ordered ? "ordered" : "open",
        triggeredAt: r.at,
        balanceAtTrigger: r.balance,
        lastSupplierId: code === "TK-GALON-KOSONG" ? DEMO_M7_SUPPLIERS.grosir : null,
        orderedAt: ordered ? closedAt : null,
        orderedSupplierId: ordered ? DEMO_M7_SUPPLIERS.grosir : null,
        orderedBy: ordered ? kasir : null,
      })
      .onConflictDoNothing();
  }
  return { created: true };
}
