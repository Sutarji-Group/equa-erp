/**
 * P2 — pembantu bersama layanan Aplikasi Pelanggan.
 *
 * Pelanggan TIDAK memakai RBAC kantor (autentikasi terpisah `customer_accounts`, 8.6): setiap layanan pelanggan
 * menerima `CustomerContext` hasil sesi (`resolveCustomerSession`) dan hanya boleh menyentuh data pelanggan M1 yang
 * tertaut ke akunnya ("data pribadi hanya milik sendiri", 8.6). Pemanggilan layanan modul lain (M1/M2/M5) dilakukan
 * atas nama "Sistem" (`systemContext`) SETELAH kepemilikan diperiksa di sini; jejak audit P2 mencatat sumber
 * `customer_app` + id akun pelanggan.
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { customerAccounts, customers, invoices, orders, trips } from "@/db/schema";
import type { EnumValue } from "@/lib/labels";
import { addDays, toWibParts, wibToUtc, type BusinessDate } from "@/lib/time";

import { record as auditRecord, type AuditAction } from "@/server/core/audit";
import { EQUA_TENANT_ID, systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import { isEnabled } from "@/server/core/flags";
import * as params from "@/server/core/params";

/** Pelaku aplikasi pelanggan (bukan `ActorContext` kantor). */
export type CustomerContext = {
  kind: "customer";
  accountId: string;
  /** Pelanggan M1 tertaut (null bila masih menunggu verifikasi Dispatcher / belum melengkapi pendaftaran). */
  customerId: string | null;
  tenantId: string;
  sessionId: string;
  status: EnumValue<"customer_account_status">;
  phone: string;
  displayName: string | null;
  /** Verifikasi ulang OTP terakhir di sesi ini (syarat pembayaran, 8.6). */
  reverifiedAt: Date | null;
  consentGiven: boolean;
  /** Waktu server (uji mengendalikan lewat nilai ini). */
  now: Date;
};

export type AccountRow = typeof customerAccounts.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type TripRow = typeof trips.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;

/** Tenant aplikasi pelanggan (EQUA; aplikasi mitra Tahap 3 memakai portal terpisah). */
export const CUSTOMER_APP_TENANT_ID = EQUA_TENANT_ID;

/** Tanggal bisnis WIB pelaku pelanggan. */
export function customerBusinessDate(cctx: Pick<CustomerContext, "now">): BusinessDate {
  return toWibParts(cctx.now).businessDate;
}

/** Konteks "Sistem" untuk memanggil layanan modul lain atas nama pelanggan (setelah kepemilikan diperiksa). */
export function sysCtx(tenantId: string, now: Date): ActorContext {
  return systemContext({ tenantId, now });
}

/** Konteks jejak audit untuk tindakan pelanggan: sumber `customer_app`, tanpa pengguna kantor. */
export function customerAuditCtx(cctx: Pick<CustomerContext, "tenantId" | "now">): ActorContext {
  return { ...systemContext({ tenantId: cctx.tenantId, now: cctx.now }), source: "customer_app" };
}

/** Catat jejak audit tindakan pelanggan (id akun ikut di `after`). */
export async function recordCustomerAudit(
  tx: Tx,
  cctx: Pick<CustomerContext, "tenantId" | "now" | "accountId">,
  input: { objectType: string; objectId: string; action: AuditAction; before?: unknown; after?: unknown; reason?: string | null; rule?: string | null },
): Promise<void> {
  const after = input.after && typeof input.after === "object" ? { ...(input.after as Record<string, unknown>), customerAccountId: cctx.accountId } : { value: input.after ?? null, customerAccountId: cctx.accountId };
  await auditRecord(tx, { ctx: customerAuditCtx(cctx), objectType: input.objectType, objectId: input.objectId, action: input.action, before: input.before, after, reason: input.reason ?? null, rule: input.rule ?? null });
}

/** Aplikasi pelanggan hanya berjalan bila flag `phase2.customer_app` aktif (D-02). */
export async function assertAppEnabled(tx: Tx, tenantId: string): Promise<void> {
  if (!(await isEnabled(tx, "phase2.customer_app", { tenantId }))) {
    throw new DomainError("CUSTOMER_APP_DISABLED", "Aplikasi pelanggan EQUA belum aktif. Silakan pesan lewat telepon/WhatsApp kantor.");
  }
}

export async function isAppEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  return isEnabled(tx, "phase2.customer_app", { tenantId });
}

export async function appRules(tx: Tx, date: BusinessDate, tenantId: string) {
  return params.get(tx, "p2.customer_app_rules", date, { tenantId });
}

export async function paymentRules(tx: Tx, date: BusinessDate, tenantId: string) {
  return params.get(tx, "p2.payment_rules", date, { tenantId });
}

/** Pelanggan M1 tertaut wajib ada (fitur pesan/tagihan). */
export function requireLinked(cctx: CustomerContext): string {
  if (!cctx.consentGiven) {
    throw new DomainError("REGISTRATION_INCOMPLETE", "Lengkapi pendaftaran dulu (persetujuan data pribadi & nama).");
  }
  if (!cctx.customerId || cctx.status !== "linked") {
    throw new DomainError(
      "ACCOUNT_NOT_LINKED",
      cctx.status === "pending_review"
        ? "Akun Anda sedang diverifikasi kantor EQUA. Anda akan mendapat pemberitahuan setelah selesai."
        : "Akun belum terhubung ke data pelanggan. Lengkapi pendaftaran dulu.",
    );
  }
  return cctx.customerId;
}

/** Pesanan milik pelanggan ini — selain itu "tidak ditemukan" (tidak membocorkan keberadaan data orang lain). */
export async function loadOwnOrder(tx: Tx, cctx: CustomerContext, orderId: string, opts: { forUpdate?: boolean } = {}): Promise<OrderRow> {
  const customerId = requireLinked(cctx);
  const q = tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.customerId, customerId))).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  if (!rows[0]) throw new NotFoundError("Pesanan tidak ditemukan.");
  return rows[0];
}

export async function loadOwnTrip(tx: Tx, cctx: CustomerContext, tripId: string): Promise<TripRow> {
  const customerId = requireLinked(cctx);
  const rows = await tx.select().from(trips).where(and(eq(trips.id, tripId), eq(trips.customerId, customerId))).limit(1);
  if (!rows[0]) throw new NotFoundError("Pengiriman tidak ditemukan.");
  return rows[0];
}

export async function loadOwnInvoices(tx: Tx, cctx: CustomerContext, invoiceIds: string[]): Promise<InvoiceRow[]> {
  const customerId = requireLinked(cctx);
  if (!invoiceIds.length) return [];
  const rows = await tx.select().from(invoices).where(and(inArray(invoices.id, invoiceIds), eq(invoices.customerId, customerId)));
  if (rows.length !== new Set(invoiceIds).size) throw new NotFoundError("Tagihan tidak ditemukan.");
  return rows;
}

export async function loadCustomer(tx: Tx, customerId: string): Promise<CustomerRow> {
  const rows = await tx.select().from(customers).where(eq(customers.id, customerId)).limit(1);
  if (!rows[0]) throw new NotFoundError("Pelanggan tidak ditemukan.");
  return rows[0];
}

/**
 * Tambah N jam layanan (PAR-07 `start`–`end`) sejak `from` (PAR-75 `service_hours_only`): di luar jam layanan waktu
 * tidak berjalan; pesanan malam hari → tenggat dihitung dari awal jam layanan esok.
 */
export function addServiceHours(from: Date, hours: number, window: { start: string; end: string }, serviceHoursOnly = true): Date {
  if (!serviceHoursOnly) return new Date(from.getTime() + hours * 3_600_000);
  let remaining = hours * 60 * 60_000;
  let cursor = from;
  for (let i = 0; i < 400 && remaining > 0; i++) {
    const date = toWibParts(cursor).businessDate;
    const start = wibToUtc(date, window.start);
    const end = wibToUtc(date, window.end);
    if (cursor < start) cursor = start;
    if (cursor >= end) {
      cursor = wibToUtc(addDays(date, 1), window.start);
      continue;
    }
    const available = end.getTime() - cursor.getTime();
    if (available >= remaining) return new Date(cursor.getTime() + remaining);
    remaining -= available;
    cursor = wibToUtc(addDays(date, 1), window.start);
  }
  return cursor;
}

/** Nama depan (US-P2-03 KP-3: identitas sopir yang tampil ke pelanggan). */
export function firstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  return fullName.trim().split(/\s+/)[0] ?? null;
}

/** Samarkan nomor WA untuk tampilan kantor/log: 6281234567890 → 0812-****-7890. */
export function maskPhone(phone: string): string {
  const local = phone.startsWith("62") ? `0${phone.slice(2)}` : phone;
  if (local.length < 8) return local;
  return `${local.slice(0, 4)}-****-${local.slice(-4)}`;
}
