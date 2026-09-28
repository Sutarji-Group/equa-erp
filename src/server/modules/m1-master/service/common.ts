/**
 * M1 — pembantu internal layanan (tidak diekspor lewat index.ts kecuali disebut).
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { customerAddresses, customers, products } from "@/db/schema";
import { addDays, isBusinessDate, type BusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError, ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { assertTenantScope } from "@/server/core/rbac";

export type CustomerRow = typeof customers.$inferSelect;
export type AddressRow = typeof customerAddresses.$inferSelect;
export type ProductRow = typeof products.$inferSelect;

/** Status pesanan yang dianggap "aktif" (belum Selesai/Dibatalkan) — US-M1-01 KP-8, BR-06. */
export const ACTIVE_ORDER_STATUSES = ["new", "awaiting_approval", "scheduled", "in_delivery"] as const;

/** Tambah N bulan kalender ke tanggal bisnis; tanggal dijepit ke akhir bulan (31 Jan + 1 bln = 28/29 Feb). */
export function addMonths(date: BusinessDate, months: number): BusinessDate {
  if (!isBusinessDate(date)) throw new RangeError(`Tanggal tidak valid: ${date}`);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** Tanggal kemarin dari tanggal bisnis. */
export function previousDate(date: BusinessDate): BusinessDate {
  return addDays(date, -1);
}

/** Aturan data master M1 (setelan `m1.master_rules`). */
export async function masterRules(tx: Tx, date: BusinessDate) {
  return params.get(tx, "m1.master_rules", date);
}

/** Normalisasi teks untuk perbandingan (huruf kecil, tanpa tanda baca, spasi tunggal). */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const t = s.replace(/ /g, "");
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Kemiripan teks 0..1 (koefisien Dice bigram atas teks ternormalisasi). */
export function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of bx) {
    overlap += Math.min(n, by.get(g) ?? 0);
    total += n;
  }
  for (const n of by.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

/** Muat pelanggan + cek lingkup tenant pelaku. */
export async function loadCustomer(tx: Tx, ctx: ActorContext | null, id: string, opts: { forUpdate?: boolean } = {}): Promise<CustomerRow> {
  const q = tx.select().from(customers).where(eq(customers.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const row = rows[0];
  if (!row) throw new NotFoundError("Pelanggan tidak ditemukan.");
  if (ctx) assertTenantScope(ctx, row.tenantId);
  return row;
}

/** Muat alamat kirim + pelanggannya (cek lingkup tenant). */
export async function loadAddress(
  tx: Tx,
  ctx: ActorContext | null,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<{ address: AddressRow; customer: CustomerRow }> {
  const q = tx.select().from(customerAddresses).where(eq(customerAddresses.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const address = rows[0];
  if (!address) throw new NotFoundError("Alamat kirim tidak ditemukan.");
  const customer = await loadCustomer(tx, ctx, address.customerId);
  return { address, customer };
}

/** Muat produk (cek lingkup tenant bila `ctx`). */
export async function loadProduct(tx: Tx, ctx: ActorContext | null, id: string): Promise<ProductRow> {
  const rows = await tx.select().from(products).where(eq(products.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("Produk tidak ditemukan.");
  if (ctx) assertTenantScope(ctx, row.tenantId);
  return row;
}

/** Produk air truk reguler (bukan transfer internal) aktif milik tenant. */
export async function truckWaterProduct(tx: Tx, tenantId: string): Promise<ProductRow> {
  const rows = await tx
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.line, "truck_water"), eq(products.isInternalTransfer, false), eq(products.status, "active")))
    .orderBy(products.sortOrder, products.code)
    .limit(1);
  if (!rows[0]) throw new DomainError("NO_TRUCK_WATER_PRODUCT", "Produk air truk belum ada atau nonaktif. Minta Admin Keuangan membuatnya di Data master > Produk.");
  return rows[0];
}

/** Validasi tanggal berlaku harga/tarif: pemilik boleh mulai hari ini; jalur baku (persetujuan) minimal besok. */
export function assertEffectiveFrom(effectiveFrom: string, today: BusinessDate, ownerDirect: boolean): void {
  if (!isBusinessDate(effectiveFrom)) throw ValidationError.field("effectiveFrom", "Tanggal berlaku wajib diisi (YYYY-MM-DD).");
  if (ownerDirect && effectiveFrom < today) {
    throw ValidationError.field("effectiveFrom", "Tanggal berlaku tidak boleh mundur. Pilih hari ini atau tanggal sesudahnya.");
  }
  if (!ownerDirect && effectiveFrom <= today) {
    throw ValidationError.field(
      "effectiveFrom",
      "Perubahan lewat persetujuan pemilik harus berlaku paling cepat besok (tenggat persetujuan = sebelum tanggal berlaku).",
    );
  }
}

/** Nama tampilan karyawan (untuk daftar). */
export function displayName(fullName: string | null | undefined, nickname?: string | null): string {
  if (!fullName) return "—";
  return nickname ? `${fullName} (${nickname})` : fullName;
}
