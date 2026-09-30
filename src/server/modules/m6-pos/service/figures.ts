/**
 * M6 — angka "seharusnya" per shift (Bab 6.1: sistem menghitung, manusia memasukkan kenyataan): penjualan per
 * produk & per cara bayar, void, tunai seharusnya, setoran, pemakaian bahan dari resep (US-M6-02 KP-2/KP-3/KP-5).
 */
import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { posSaleLines, posSales, products } from "@/db/schema";

import type { Tx } from "@/server/core/db";

import type { PosSaleRow, ShiftRow } from "./common";
import { recipesFor, usageFromLines } from "./inventory";

/** Transaksi dihitung sebagai penjualan (lihat `COUNTED_SALE`). */
export function isCountedSale(s: Pick<PosSaleRow, "isReversal" | "status" | "reversalReason">): boolean {
  return s.isReversal || s.status === "valid" || s.status === "void_pending" || (s.status === "voided" && !!s.reversalReason);
}

export type ShiftProductFigure = { productId: string; code: string; name: string; unit: string; quantity: number; amount: number; gallonLiters: number };

export type ShiftFigures = {
  saleCount: number;
  countedCount: number;
  salesTotal: number;
  cashSales: number;
  qrisSales: number;
  creditSales: number;
  qrisCount: number;
  voidCount: number;
  voidAmount: number;
  voidCashAmount: number;
  voidPendingCount: number;
  voidPendingAmount: number;
  priceMismatchCount: number;
  gallonsSold: number;
  gallonLitersSold: number;
  byProduct: ShiftProductFigure[];
  /** Pemakaian bahan seharusnya (id bahan → jumlah). */
  usage: Map<string, number>;
  openingCash: number;
  /** Tunai seharusnya = kas awal + tunai − kembalian − void tunai. */
  expectedCash: number;
  partialDepositTotal: number;
  /** Kas di laci seharusnya = tunai seharusnya − Σ setor sebagian. */
  expectedDrawer: number;
  /** Setoran = tunai seharusnya − kas awal tetap − Σ setor sebagian. */
  depositAmount: number;
};

/** Hitung angka shift dari transaksi yang sudah tersinkron. */
export async function computeShiftFigures(tx: Tx, shift: ShiftRow, opts: { soldUpTo?: Date } = {}): Promise<ShiftFigures> {
  const sales = await tx.select().from(posSales).where(eq(posSales.shiftId, shift.id));
  const scoped = opts.soldUpTo ? sales.filter((s) => s.soldAt.getTime() <= opts.soldUpTo!.getTime()) : sales;
  const counted = scoped.filter(isCountedSale);
  const f: ShiftFigures = {
    saleCount: scoped.filter((s) => !s.isReversal).length,
    countedCount: counted.filter((s) => !s.isReversal).length,
    salesTotal: 0,
    cashSales: 0,
    qrisSales: 0,
    creditSales: 0,
    qrisCount: 0,
    voidCount: 0,
    voidAmount: 0,
    voidCashAmount: 0,
    voidPendingCount: 0,
    voidPendingAmount: 0,
    priceMismatchCount: scoped.filter((s) => s.priceMismatch).length,
    gallonsSold: 0,
    gallonLitersSold: 0,
    byProduct: [],
    usage: new Map(),
    openingCash: shift.openingCashFixed,
    expectedCash: 0,
    partialDepositTotal: shift.partialDepositTotal,
    expectedDrawer: 0,
    depositAmount: 0,
  };
  for (const s of scoped) {
    if (!s.isReversal && s.status === "voided" && !s.reversalReason) {
      f.voidCount++;
      f.voidAmount += s.total;
      if (s.paymentMethod === "cash") f.voidCashAmount += s.total;
    }
    if (s.status === "void_pending") {
      f.voidPendingCount++;
      f.voidPendingAmount += s.total;
    }
  }
  for (const s of counted) {
    f.salesTotal += s.total;
    if (s.paymentMethod === "cash") f.cashSales += s.total;
    else if (s.paymentMethod === "qris") {
      f.qrisSales += s.total;
      if (!s.isReversal) f.qrisCount++;
    } else if (s.paymentMethod === "credit") f.creditSales += s.total;
  }
  const countedIds = counted.map((s) => s.id);
  const lines = countedIds.length ? await tx.select().from(posSaleLines).where(inArray(posSaleLines.posSaleId, countedIds)) : [];
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const prods = productIds.length
    ? await tx.select({ id: products.id, code: products.code, name: products.name, unit: products.unit }).from(products).where(inArray(products.id, productIds))
    : [];
  const byId = new Map(prods.map((p) => [p.id, p]));
  const agg = new Map<string, ShiftProductFigure>();
  for (const l of lines) {
    const p = byId.get(l.productId);
    const cur = agg.get(l.productId) ?? { productId: l.productId, code: p?.code ?? "", name: p?.name ?? "", unit: p?.unit ?? "", quantity: 0, amount: 0, gallonLiters: 0 };
    cur.quantity += l.quantity;
    cur.amount += l.lineTotal;
    if (l.gallonSizeL) {
      cur.gallonLiters += l.quantity * l.gallonSizeL;
      f.gallonsSold += l.quantity;
      f.gallonLitersSold += l.quantity * l.gallonSizeL;
    }
    agg.set(l.productId, cur);
  }
  f.byProduct = [...agg.values()].sort((a, b) => a.code.localeCompare(b.code));
  // Pemakaian bahan: resep berlaku pada tanggal bisnis masing-masing transaksi.
  const byDate = new Map<string, { productId: string; quantity: number }[]>();
  const saleDate = new Map(counted.map((s) => [s.id, s.businessDate]));
  for (const l of lines) {
    const d = saleDate.get(l.posSaleId) ?? shift.businessDate;
    const list = byDate.get(d) ?? [];
    list.push({ productId: l.productId, quantity: l.quantity });
    byDate.set(d, list);
  }
  for (const [date, list] of byDate) {
    const recipes = await recipesFor(
      tx,
      shift.tenantId,
      list.map((l) => l.productId),
      date,
    );
    for (const [mat, qty] of usageFromLines(list, recipes)) f.usage.set(mat, (f.usage.get(mat) ?? 0) + qty);
  }
  f.expectedCash = f.openingCash + f.cashSales;
  f.expectedDrawer = f.expectedCash - f.partialDepositTotal;
  f.depositAmount = f.expectedCash - f.openingCash - f.partialDepositTotal;
  return f;
}

export type ShiftCashTotals = Pick<ShiftFigures, "cashSales" | "qrisSales" | "expectedCash" | "expectedDrawer" | "depositAmount">;

/**
 * Angka kas shift (tunai & QRIS terhitung, tunai seharusnya, kas di laci, setoran) untuk BANYAK shift sekaligus lewat
 * satu agregat SQL — nilai yang SAMA dengan field bernama sama dari `computeShiftFigures`, tanpa memuat seluruh
 * transaksi, baris, produk & resep shift. Dipakai jalur panas: `checkCashLimit` (setiap transaksi tunai tersinkron;
 * versi lengkap membuat push batch O(n²) per shift — uji beban NFR-05: 45 ms/transaksi pada shift 500 transaksi) dan
 * posisi kas M4 (semua shift terbuka). Syarat "terhitung" = `isCountedSale` (alasan pembalik kosong = tanpa alasan).
 */
export async function computeShiftCashTotals(tx: Tx, shiftRows: readonly Pick<ShiftRow, "id" | "openingCashFixed" | "partialDepositTotal">[]): Promise<Map<string, ShiftCashTotals>> {
  const out = new Map<string, ShiftCashTotals>();
  if (!shiftRows.length) return out;
  const rows = await tx
    .select({
      shiftId: posSales.shiftId,
      cash: sql<string>`coalesce(sum(case when ${posSales.paymentMethod} = 'cash' then ${posSales.total} else 0 end), 0)`,
      qris: sql<string>`coalesce(sum(case when ${posSales.paymentMethod} = 'qris' then ${posSales.total} else 0 end), 0)`,
    })
    .from(posSales)
    .where(
      and(
        inArray(
          posSales.shiftId,
          shiftRows.map((s) => s.id),
        ),
        sql`(${posSales.isReversal} = true or ${posSales.status} in ('valid', 'void_pending') or (${posSales.status} = 'voided' and coalesce(${posSales.reversalReason}, '') <> ''))`,
      ),
    )
    .groupBy(posSales.shiftId);
  const byShift = new Map(rows.map((r) => [r.shiftId, r]));
  for (const s of shiftRows) {
    const r = byShift.get(s.id);
    const cashSales = Number(r?.cash ?? 0);
    const expectedCash = s.openingCashFixed + cashSales;
    out.set(s.id, {
      cashSales,
      qrisSales: Number(r?.qris ?? 0),
      expectedCash,
      expectedDrawer: expectedCash - s.partialDepositTotal,
      depositAmount: expectedCash - s.openingCashFixed - s.partialDepositTotal,
    });
  }
  return out;
}

/** Kas di laci seharusnya (BR-08) satu shift — `computeShiftCashTotals` (= `computeShiftFigures(...).expectedDrawer`). */
export async function computeShiftDrawer(tx: Tx, shift: Pick<ShiftRow, "id" | "openingCashFixed" | "partialDepositTotal">): Promise<number> {
  return (await computeShiftCashTotals(tx, [shift])).get(shift.id)!.expectedDrawer;
}

/** Kas berjalan di laci (BR-08): kas awal + tunai − kembalian − void tunai − setor sebagian. */
export function runningCash(f: Pick<ShiftFigures, "expectedDrawer">): number {
  return f.expectedDrawer;
}
