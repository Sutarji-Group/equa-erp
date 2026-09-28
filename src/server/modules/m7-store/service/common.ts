/**
 * M7 — pembantu internal layanan toko (tidak diekspor lewat index.ts kecuali disebut): pemuatan outlet toko & barang
 * dengan cek tenant/lingkup (NFR-30), label bulan opname, saldo stok PADA WAKTU tertentu (US-M7-05 KP-3), aturan toko
 * (`m7.store_rules`), jenis harga pelanggan (BR-18).
 */
import "server-only";

import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { customers, outlets, products, stockBalances, stockLedger } from "@/db/schema";
import type { PriceKind } from "@/lib/labels";
import { addDays, firstDayOfMonth, isBusinessDate, lastDayOfMonth, type BusinessDate } from "@/lib/time";

import { isSystem, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, ForbiddenError, NotFoundError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { assertOutletScope, assertTenantScope, inOutletScope } from "@/server/core/rbac";

export type OutletRow = typeof outlets.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;

export async function loadOutlet(tx: Tx, id: string): Promise<OutletRow> {
  const [row] = await tx.select().from(outlets).where(eq(outlets.id, id)).limit(1);
  if (!row) throw new NotFoundError("Outlet tidak ditemukan.");
  return row;
}

/** Outlet toko milik tenant pelaku (dan dalam lingkupnya). */
export async function loadStoreOutlet(tx: Tx, ctx: ActorContext, id: string): Promise<OutletRow> {
  const outlet = await loadOutlet(tx, id);
  if (outlet.kind !== "store") throw new NotFoundError("Toko tidak ditemukan.");
  if (!isSystem(ctx)) {
    if (outlet.tenantId !== ctx.tenantId) throw new NotFoundError("Toko tidak ditemukan.");
    assertTenantScope(ctx, outlet.tenantId);
    if (!inOutletScope(ctx, outlet.id, outlet.tenantId)) {
      throw new ForbiddenError("Anda tidak memiliki akses ke toko ini.", { rule: "SCOPE", objectType: "outlet", objectId: outlet.id });
    }
  }
  return outlet;
}

/**
 * Toko tempat perangkat POS bekerja (NFR-30): outlet perangkat (perangkat cadangan: lingkup kasir). Tenant perangkat =
 * tenant toko = tenant pengguna; toko dalam lingkup pelaku.
 */
export async function resolveStorePosOutlet(tx: Tx, ctx: ActorContext, device: { outletId: string | null; tenantId: string }): Promise<OutletRow> {
  const outletId = device.outletId ?? ctx.scope.outletIds[0] ?? null;
  if (!outletId) throw new DomainError("OUTLET_REQUIRED", "Toko POS belum ditentukan. Minta admin sistem menautkan tablet ke toko.");
  const outlet = await loadOutlet(tx, outletId);
  if (outlet.tenantId !== device.tenantId || outlet.tenantId !== ctx.tenantId) throw new NotFoundError("Toko tidak ditemukan.");
  if (outlet.kind !== "store") throw new DomainError("NOT_A_STORE", "Aksi ini hanya untuk POS toko.");
  if (!outlet.isActive) throw new DomainError("OUTLET_INACTIVE", `${outlet.name} nonaktif. Hubungi pemilik.`);
  await assertOutletScope(tx, ctx, outlet.id);
  return outlet;
}

/** Toko aktif tenant (urut kode). */
export async function storeOutletsOf(tx: Tx, tenantId: string, opts: { includeInactive?: boolean } = {}): Promise<OutletRow[]> {
  const rows = await tx
    .select()
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.kind, "store")))
    .orderBy(outlets.code);
  return opts.includeInactive ? rows : rows.filter((o) => o.isActive);
}

/** Toko bawaan pelaku kantor: toko pertama dalam lingkup (atau yang diminta). */
export async function resolveOfficeStore(tx: Tx, ctx: ActorContext, requested?: string | null): Promise<OutletRow | null> {
  if (requested) return loadStoreOutlet(tx, ctx, requested);
  const stores = await storeOutletsOf(tx, ctx.tenantId);
  return stores.find((s) => isSystem(ctx) || inOutletScope(ctx, s.id, s.tenantId)) ?? null;
}

export async function loadStoreProduct(tx: Tx, tenantId: string, id: string): Promise<ProductRow> {
  const [row] = await tx.select().from(products).where(eq(products.id, id)).limit(1);
  if (!row || row.tenantId !== tenantId || row.line !== "store") throw new NotFoundError("Barang toko tidak ditemukan.");
  return row;
}

export async function loadProductsById(tx: Tx, ids: readonly string[]): Promise<Map<string, ProductRow>> {
  if (!ids.length) return new Map();
  const rows = await tx.select().from(products).where(inArray(products.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function loadCustomer(tx: Tx, id: string): Promise<CustomerRow | null> {
  const [row] = await tx.select().from(customers).where(eq(customers.id, id)).limit(1);
  return row ?? null;
}

/** BR-18: pelanggan bertanda mitra toko (aktif, tenant sama) → harga mitra; selain itu harga umum. */
export async function priceKindForCustomer(tx: Tx, tenantId: string, customerId: string | null): Promise<PriceKind> {
  if (!customerId) return "general";
  const c = await loadCustomer(tx, customerId);
  return c && c.tenantId === tenantId && c.isActive && c.isStorePartner ? "partner" : "general";
}

/** Label bulan opname toko `YYYY-MM` (PAR-32: toko bulanan). */
export function monthLabel(date: BusinessDate): string {
  if (!isBusinessDate(date)) throw new RangeError(`Tanggal tidak valid: ${date}`);
  return date.slice(0, 7);
}

/** Rentang tanggal bulan `YYYY-MM`. */
export function monthRange(label: string): { from: BusinessDate; to: BusinessDate } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(label)) throw new DomainError("INVALID_MONTH", `Bulan tidak valid: ${label}. Gunakan format YYYY-MM.`);
  const first = `${label}-01`;
  return { from: firstDayOfMonth(first), to: lastDayOfMonth(first) };
}

/** Bulan sebelumnya dari tanggal bisnis. */
export function previousMonthLabel(date: BusinessDate): string {
  return monthLabel(addDays(firstDayOfMonth(date), -1));
}

export type StoreRules = params.ParamValue<"m7.store_rules">;

export async function storeRules(tx: Tx, date: BusinessDate, tenantId: string): Promise<StoreRules> {
  return params.get(tx, "m7.store_rules", date, { tenantId });
}

/** Saldo stok sekarang per barang (tanpa baris = 0). */
export async function balancesNow(tx: Tx, outletId: string, productIds?: readonly string[]): Promise<Map<string, { quantity: number; avgCost: number; totalValue: number }>> {
  const rows = await tx
    .select({ productId: stockBalances.productId, quantity: stockBalances.quantity, avgCost: stockBalances.avgCost, totalValue: stockBalances.totalValue })
    .from(stockBalances)
    .where(productIds?.length ? and(eq(stockBalances.outletId, outletId), inArray(stockBalances.productId, [...productIds])) : eq(stockBalances.outletId, outletId));
  const out = new Map(rows.map((r) => [r.productId, { quantity: r.quantity, avgCost: r.avgCost, totalValue: r.totalValue }]));
  for (const id of productIds ?? []) if (!out.has(id)) out.set(id, { quantity: 0, avgCost: 0, totalValue: 0 });
  return out;
}

/**
 * Saldo sistem PADA WAKTU hitung per barang (US-M7-05 KP-3): Σ mutasi kartu stok dengan waktu kejadian ≤ `at`.
 * Penjualan yang terjadi SETELAH jam hitung (walau tersinkron lebih dulu) tidak ikut; yang terjadi sebelum ikut.
 */
export async function balanceAt(tx: Tx, outletId: string, productId: string, at: Date): Promise<{ quantity: number; avgCost: number }> {
  const [row] = await tx
    .select({ qty: sql<string>`coalesce(sum(${stockLedger.quantity}), 0)` })
    .from(stockLedger)
    .where(and(eq(stockLedger.outletId, outletId), eq(stockLedger.productId, productId), lte(stockLedger.occurredAt, at)));
  const [last] = await tx
    .select({ avg: stockLedger.avgCostAfter })
    .from(stockLedger)
    .where(and(eq(stockLedger.outletId, outletId), eq(stockLedger.productId, productId), lte(stockLedger.occurredAt, at)))
    .orderBy(sql`${stockLedger.occurredAt} desc, ${stockLedger.createdAt} desc`)
    .limit(1);
  let avgCost = last?.avg ?? 0;
  if (!avgCost) {
    const [bal] = await tx.select({ avg: stockBalances.avgCost }).from(stockBalances).where(and(eq(stockBalances.outletId, outletId), eq(stockBalances.productId, productId))).limit(1);
    avgCost = bal?.avg ?? 0;
  }
  return { quantity: Number(row?.qty ?? 0), avgCost };
}

/** Jumlah per barang (gabungan baris berulang). */
export function sumByProduct<T extends { productId: string; quantity: number }>(lines: readonly T[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.productId, (out.get(l.productId) ?? 0) + l.quantity);
  return out;
}

export function describeLines(lines: readonly { productId: string; quantity: number }[], byId: Map<string, ProductRow>): string {
  return lines.map((l) => `${byId.get(l.productId)?.name ?? "Barang"} × ${l.quantity}`).join(", ");
}
