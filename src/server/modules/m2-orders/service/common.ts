/**
 * M2 — pembantu internal layanan (tidak diekspor lewat index.ts kecuali disebut).
 */
import "server-only";

import { asc, eq, inArray } from "drizzle-orm";

import { customerAddresses, customers, employees, orders, trips, trucks, users } from "@/db/schema";
import { addDays, toWibParts, type BusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { assertTenantScope } from "@/server/core/rbac";

export type OrderRow = typeof orders.$inferSelect;
export type TripRow = typeof trips.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type AddressRow = typeof customerAddresses.$inferSelect;
export type TruckRow = typeof trucks.$inferSelect;

/** Status pesanan "berjalan" (Baru/Menunggu persetujuan/Terjadwal/Dalam pengiriman) — BR-06, FR-M2-04. */
export const ACTIVE_ORDER_STATUSES = ["new", "awaiting_approval", "scheduled", "in_delivery"] as const;
/** Status pesanan terkunci (US-M2-02 KP-2). */
export const LOCKED_ORDER_STATUSES = ["completed", "cancelled"] as const;
/** Rit sedang di jalan (tidak dapat dipindah/ditarik, US-M2-03 KP-5). */
export const ON_ROAD_TRIP_STATUSES = ["departed", "arrived"] as const;

/**
 * PTB-18 (6.2a "Pesanan baru saat kurang bayar kedua belum lunas"): kurang bayar KEDUA saat yang pertama belum lunas =
 * dua faktur kurang bayar terbuka sekaligus. Angka ini definisi aturan (bukan ambang Lampiran B).
 */
export const SECOND_UNDERPAYMENT_OPEN_INVOICES = 2;

/** Aturan M2 dari parameter Lampiran B pada tanggal bisnis (tanpa angka di kode). */
export async function orderRules(tx: Tx, date: BusinessDate) {
  const [cutoff, service, volume, failures, capacity, recurring] = await Promise.all([
    params.get(tx, "PAR-05", date),
    params.get(tx, "PAR-07", date),
    params.get(tx, "PAR-15", date),
    params.get(tx, "PAR-17", date),
    params.get(tx, "PAR-33", date),
    params.get(tx, "PAR-34", date),
  ]);
  return {
    /** BR-20: batas pesanan H+0 (HH:mm WIB). */
    sameDayCutoff: cutoff.time,
    serviceStart: service.start,
    serviceEnd: service.end,
    /** BR-22: volume standar rit (L). */
    standardVolumeL: volume.liters,
    /** BR-24: rit gagal berturut → konfirmasi ulang. */
    consecutiveFailLimit: failures.count,
    /** PAR-33: kapasitas rit per truk per hari (bawaan). */
    defaultTripCapacity: capacity.trips,
    /** PAR-34: pesanan langganan dibuat H-n. */
    recurringDaysBefore: recurring.days_before,
  };
}

/**
 * Tanggal diminta bawaan (US-M2-01 KP-1, BR-20): hari ini bila jam WIB sekarang sebelum PAR-05, bila tidak H+1.
 */
export function defaultRequestedDate(now: Date, cutoff: string): { date: BusinessDate; afterCutoff: boolean } {
  const p = toWibParts(now);
  const afterCutoff = p.time >= cutoff;
  return { date: afterCutoff ? addDays(p.businessDate, 1) : p.businessDate, afterCutoff };
}

/** Muat pesanan + cek lingkup tenant. */
export async function loadOrder(tx: Tx, ctx: ActorContext | null, id: string, opts: { forUpdate?: boolean } = {}): Promise<OrderRow> {
  const q = tx.select().from(orders).where(eq(orders.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const row = rows[0];
  if (!row) throw new NotFoundError("Pesanan tidak ditemukan.");
  if (ctx) assertTenantScope(ctx, row.tenantId);
  return row;
}

/** Muat rit + cek lingkup tenant. */
export async function loadTrip(tx: Tx, ctx: ActorContext | null, id: string, opts: { forUpdate?: boolean } = {}): Promise<TripRow> {
  const q = tx.select().from(trips).where(eq(trips.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const row = rows[0];
  if (!row) throw new NotFoundError("Rit tidak ditemukan.");
  if (ctx) assertTenantScope(ctx, row.tenantId);
  return row;
}

/** Rit pesanan (urut nomor tangki). */
export async function orderTrips(tx: Tx, orderId: string): Promise<TripRow[]> {
  return tx.select().from(trips).where(eq(trips.orderId, orderId)).orderBy(asc(trips.sequenceInOrder));
}

/** Muat truk + cek lingkup tenant. */
export async function loadTruck(tx: Tx, ctx: ActorContext | null, id: string): Promise<TruckRow> {
  const rows = await tx.select().from(trucks).where(eq(trucks.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("Truk tidak ditemukan.");
  if (ctx) assertTenantScope(ctx, row.tenantId);
  return row;
}

/** Muat pelanggan + alamat (alamat harus milik pelanggan). */
export async function loadCustomerAddress(
  tx: Tx,
  ctx: ActorContext | null,
  customerId: string,
  addressId: string,
): Promise<{ customer: CustomerRow; address: AddressRow }> {
  const rows = await tx
    .select({ customer: customers, address: customerAddresses })
    .from(customerAddresses)
    .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
    .where(eq(customerAddresses.id, addressId))
    .limit(1);
  const row = rows[0];
  if (!row || row.customer.id !== customerId) throw new NotFoundError("Alamat kirim tidak ditemukan untuk pelanggan ini.");
  if (ctx) assertTenantScope(ctx, row.customer.tenantId);
  return row;
}

/** Rit sudah diterbitkan ke aplikasi sopir (bertruk, terbit, tidak ditarik). */
export function isTripPublished(t: Pick<TripRow, "truckId" | "publishedAt" | "withdrawnAt">): boolean {
  return !!t.truckId && !!t.publishedAt && !t.withdrawnAt;
}

/** Rit masih dapat diubah kantor (belum Berangkat/Tiba/Selesai/Gagal, tidak ditarik permanen). */
export function isTripOpen(t: Pick<TripRow, "status" | "withdrawnAt">): boolean {
  return t.status === "assigned" && !t.withdrawnAt;
}

/** Nama karyawan per ID. */
export async function employeeNames(tx: Tx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (list.length === 0) return new Map();
  const rows = await tx.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Nama pengguna (nama karyawan) per ID pengguna. */
export async function userNames(tx: Tx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (list.length === 0) return new Map();
  const rows = await tx
    .select({ id: users.id, name: employees.fullName })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** ID pengguna milik karyawan (satu orang satu akun, BR-36). */
export async function userIdOfEmployee(tx: Tx, employeeId: string): Promise<string | null> {
  const rows = await tx.select({ id: users.id }).from(users).where(eq(users.employeeId, employeeId)).limit(1);
  return rows[0]?.id ?? null;
}

/** Teks alasan wajib (minimal 3 karakter). */
export function requireReason(reason: string | null | undefined, what: string): string {
  const clean = (reason ?? "").trim();
  if (clean.length < 3) throw new DomainError("REASON_REQUIRED", `Alasan ${what} wajib diisi (minimal 3 karakter).`);
  return clean;
}


