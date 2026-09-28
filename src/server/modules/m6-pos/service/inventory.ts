/**
 * M6 — primitif persediaan kerangka POS (dipakai M6 & M7): kartu stok + saldo (harga pokok rata-rata bergerak,
 * PTB-38), buku air outlet (liter), resep bahan per tenant (US-M6-04 KP-2) dan pemakaian seharusnya.
 *
 * Kartu stok & buku air APPEND-ONLY (hardening EQ002): koreksi = baris pembalik/penyesuaian, tidak pernah UPDATE.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

import { depotRecipes, outletWaterLedger, products, stockBalances, stockLedger } from "@/db/schema";
import type { EnumValue } from "@/lib/labels";
import type { BusinessDate } from "@/lib/time";

import type { Tx } from "@/server/core/db";

export type StockMovementKind = EnumValue<"stock_movement_kind">;
export type OutletWaterKind = EnumValue<"outlet_water_kind">;

export type StockMovementInput = {
  tenantId: string;
  outletId: string;
  productId: string;
  kind: StockMovementKind;
  /** Bertanda: masuk positif, keluar negatif. */
  quantity: number;
  /** Harga pokok satuan masuk (nota/harga mitra). Kosong = rata-rata berjalan. */
  unitCost?: number | null;
  businessDate: BusinessDate;
  occurredAt: Date;
  source: { type: string; id: string };
  note?: string | null;
  createdBy?: string | null;
  reversalOfId?: string | null;
};

export type StockMovementResult = { ledgerId: string; balanceAfter: number; avgCostAfter: number; unitCost: number; totalCost: number };

/**
 * Catat mutasi stok + perbarui saldo (dikunci per outlet+barang). Masuk dengan harga → rata-rata bergerak diperbarui;
 * keluar memakai rata-rata berjalan. Satu mutasi per (sumber, barang, jenis) — pengulangan ditolak indeks unik.
 */
export async function postStockMovement(tx: Tx, input: StockMovementInput): Promise<StockMovementResult> {
  if (!Number.isInteger(input.quantity)) throw new Error("postStockMovement: jumlah harus bilangan bulat.");
  await tx
    .insert(stockBalances)
    .values({ tenantId: input.tenantId, outletId: input.outletId, productId: input.productId, quantity: 0, avgCost: 0, totalValue: 0 })
    .onConflictDoNothing();
  const [bal] = await tx
    .select()
    .from(stockBalances)
    .where(and(eq(stockBalances.outletId, input.outletId), eq(stockBalances.productId, input.productId)))
    .for("update")
    .limit(1);
  const q0 = bal!.quantity;
  const v0 = bal!.totalValue;
  const avg0 = bal!.avgCost;
  const q1 = q0 + input.quantity;
  let unitCost = avg0;
  let v1: number;
  let avg1 = avg0;
  if (input.quantity > 0 && input.unitCost !== null && input.unitCost !== undefined) {
    unitCost = input.unitCost;
    v1 = v0 + input.quantity * unitCost;
    if (q1 > 0) avg1 = Math.round(v1 / q1);
    else avg1 = unitCost;
  } else {
    v1 = q1 === 0 ? 0 : v0 + input.quantity * avg0;
  }
  const totalCost = input.quantity * unitCost;
  await tx
    .update(stockBalances)
    .set({ quantity: q1, avgCost: avg1, totalValue: v1, lastMovementAt: input.occurredAt, updatedAt: new Date() })
    .where(eq(stockBalances.id, bal!.id));
  const [row] = await tx
    .insert(stockLedger)
    .values({
      tenantId: input.tenantId,
      outletId: input.outletId,
      productId: input.productId,
      kind: input.kind,
      quantity: input.quantity,
      unitCost,
      totalCost,
      balanceAfter: q1,
      avgCostAfter: avg1,
      businessDate: input.businessDate,
      occurredAt: input.occurredAt,
      sourceObjectType: input.source.type,
      sourceObjectId: input.source.id,
      reversalOfId: input.reversalOfId ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: stockLedger.id });
  return { ledgerId: row!.id, balanceAfter: q1, avgCostAfter: avg1, unitCost, totalCost };
}

export type StockBalanceView = { productId: string; quantity: number; avgCost: number; totalValue: number };

/** Saldo stok per barang di outlet (barang tanpa baris saldo = 0). */
export async function stockBalancesOf(tx: Tx, outletId: string, productIds?: readonly string[]): Promise<Map<string, StockBalanceView>> {
  const rows = await tx
    .select({ productId: stockBalances.productId, quantity: stockBalances.quantity, avgCost: stockBalances.avgCost, totalValue: stockBalances.totalValue })
    .from(stockBalances)
    .where(
      productIds?.length
        ? and(eq(stockBalances.outletId, outletId), inArray(stockBalances.productId, [...productIds]))
        : eq(stockBalances.outletId, outletId),
    );
  const out = new Map<string, StockBalanceView>(rows.map((r) => [r.productId, r]));
  for (const id of productIds ?? []) if (!out.has(id)) out.set(id, { productId: id, quantity: 0, avgCost: 0, totalValue: 0 });
  return out;
}

export type ConsumableProduct = { id: string; code: string; name: string; unit: string; sortOrder: number };

/** Bahan habis pakai aktif tenant untuk lini outlet (depot: tutup, tisu, galon kosong). */
export async function consumablesOf(tx: Tx, tenantId: string, line: "depot" | "store" = "depot"): Promise<ConsumableProduct[]> {
  return tx
    .select({ id: products.id, code: products.code, name: products.name, unit: products.unit, sortOrder: products.sortOrder })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.line, line), eq(products.isConsumable, true), eq(products.status, "active")))
    .orderBy(asc(products.sortOrder), asc(products.code));
}

export type RecipeLine = { materialProductId: string; quantity: number };

/**
 * Resep bahan berlaku per produk pada tanggal (US-M6-04 KP-2): baris aktif dengan tanggal berlaku terbaru ≤ tanggal
 * per (produk, bahan). Jumlah 0 = bahan dikeluarkan dari resep.
 */
export async function recipesFor(tx: Tx, tenantId: string, productIds: readonly string[], date: BusinessDate): Promise<Map<string, RecipeLine[]>> {
  const out = new Map<string, RecipeLine[]>();
  if (!productIds.length) return out;
  const rows = await tx
    .select({
      productId: depotRecipes.productId,
      materialProductId: depotRecipes.materialProductId,
      quantity: depotRecipes.quantity,
      effectiveFrom: depotRecipes.effectiveFrom,
    })
    .from(depotRecipes)
    .where(
      and(
        eq(depotRecipes.tenantId, tenantId),
        inArray(depotRecipes.productId, [...new Set(productIds)]),
        eq(depotRecipes.isActive, true),
        lte(depotRecipes.effectiveFrom, date),
      ),
    )
    .orderBy(desc(depotRecipes.effectiveFrom));
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.productId}:${r.materialProductId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.quantity <= 0) continue;
    const list = out.get(r.productId) ?? [];
    list.push({ materialProductId: r.materialProductId, quantity: r.quantity });
    out.set(r.productId, list);
  }
  return out;
}

/** Semua resep aktif tenant pada tanggal (untuk data offline POS). */
export async function tenantRecipes(tx: Tx, tenantId: string, date: BusinessDate): Promise<{ productId: string; materialProductId: string; quantity: number }[]> {
  const ids = await tx.selectDistinct({ id: depotRecipes.productId }).from(depotRecipes).where(eq(depotRecipes.tenantId, tenantId));
  const map = await recipesFor(
    tx,
    tenantId,
    ids.map((r) => r.id),
    date,
  );
  return [...map.entries()].flatMap(([productId, lines]) => lines.map((l) => ({ productId, ...l })));
}

/** Pemakaian bahan seharusnya dari baris penjualan (murni). */
export function usageFromLines(lines: readonly { productId: string; quantity: number }[], recipes: ReadonlyMap<string, readonly RecipeLine[]>): Map<string, number> {
  const usage = new Map<string, number>();
  for (const line of lines) {
    for (const r of recipes.get(line.productId) ?? []) {
      usage.set(r.materialProductId, (usage.get(r.materialProductId) ?? 0) + line.quantity * r.quantity);
    }
  }
  return usage;
}

// =====================================================================================================================
// Buku air outlet (US-M6-05 KP-3/KP-4)
// =====================================================================================================================

export type WaterMovementInput = {
  tenantId: string;
  outletId: string;
  kind: OutletWaterKind;
  /** Bertanda (liter): masuk positif, keluar negatif. */
  volumeL: number;
  businessDate: BusinessDate;
  occurredAt: Date;
  source: { type: string; id: string } | null;
  reversalOfId?: string | null;
  reversalReason?: string | null;
};

/** Saldo buku air outlet (Σ mutasi), opsional sebelum tanggal bisnis tertentu. */
export async function waterBalance(tx: Tx, outletId: string, opts: { before?: BusinessDate; upTo?: BusinessDate } = {}): Promise<number> {
  const conds = [eq(outletWaterLedger.outletId, outletId)];
  if (opts.before) conds.push(lt(outletWaterLedger.businessDate, opts.before));
  if (opts.upTo) conds.push(lte(outletWaterLedger.businessDate, opts.upTo));
  const [row] = await tx
    .select({ total: sql<string | null>`coalesce(sum(${outletWaterLedger.volumeL}), 0)` })
    .from(outletWaterLedger)
    .where(and(...conds));
  return Number(row?.total ?? 0);
}

/** Catat mutasi air outlet; saldo setelahnya = Σ mutasi (buku append-only). */
export async function postWaterMovement(tx: Tx, input: WaterMovementInput): Promise<{ id: string; balanceAfterL: number }> {
  const balance = (await waterBalance(tx, input.outletId)) + input.volumeL;
  const [row] = await tx
    .insert(outletWaterLedger)
    .values({
      tenantId: input.tenantId,
      outletId: input.outletId,
      businessDate: input.businessDate,
      kind: input.kind,
      volumeL: input.volumeL,
      balanceAfterL: balance,
      sourceObjectType: input.source?.type ?? null,
      sourceObjectId: input.source?.id ?? null,
      occurredAt: input.occurredAt,
      reversalOfId: input.reversalOfId ?? null,
      reversalReason: input.reversalReason ?? null,
    })
    .returning({ id: outletWaterLedger.id });
  return { id: row!.id, balanceAfterL: balance };
}

export type WaterPeriodBalance = {
  outletId: string;
  from: BusinessDate;
  to: BusinessDate;
  openingL: number;
  receivedL: number;
  soldL: number;
  adjustmentL: number;
  closingL: number;
  /** Air tersedia = stok awal (≥ 0) + diterima + penyesuaian masuk. */
  availableL: number;
  /** Galon terjual × ukuran melebihi air tersedia (liter, ≥ 0). */
  excessL: number;
  excessPct: number;
};

/**
 * Neraca air outlet satu periode (US-M6-05 KP-4): galon terjual × ukuran galon vs air diterima ± perubahan stok.
 * `excessPct` > PAR-59 → ditandai ke pemilik.
 */
export async function waterPeriodBalance(tx: Tx, outletId: string, from: BusinessDate, to: BusinessDate): Promise<WaterPeriodBalance> {
  const openingL = await waterBalance(tx, outletId, { before: from });
  const rows = await tx
    .select({ kind: outletWaterLedger.kind, total: sql<string>`coalesce(sum(${outletWaterLedger.volumeL}), 0)` })
    .from(outletWaterLedger)
    .where(and(eq(outletWaterLedger.outletId, outletId), gte(outletWaterLedger.businessDate, from), lte(outletWaterLedger.businessDate, to)))
    .groupBy(outletWaterLedger.kind);
  const by = new Map(rows.map((r) => [r.kind, Number(r.total)]));
  const receivedL = (by.get("supply_in") ?? 0) + (by.get("opening") ?? 0);
  const soldL = -(by.get("sales_out") ?? 0);
  const adjustmentL = by.get("adjustment") ?? 0;
  const closingL = openingL + receivedL - soldL + adjustmentL;
  const availableL = Math.max(0, openingL) + receivedL + Math.max(0, adjustmentL);
  const excessL = Math.max(0, soldL - availableL);
  const excessPct = availableL > 0 ? Math.round((excessL / availableL) * 10_000) / 100 : soldL > 0 ? 100 : 0;
  return { outletId, from, to, openingL, receivedL, soldL, adjustmentL, closingL, availableL, excessL, excessPct };
}
