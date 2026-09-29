/**
 * M5 — pembantu bersama modul Piutang (bukan API publik): tipe baris, aturan (parameter), kelompok umur, lini
 * piutang, pemuat baris dengan kunci, dan pengecekan lingkup tenant.
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import {
  creditNotes,
  customerAdvances,
  customerPayments,
  customers,
  dataSignoffs,
  invoices,
  paymentAllocations,
  unbilledCharges,
} from "@/db/schema";
import type { EnumValue, InvoiceKind } from "@/lib/labels";
import { daysBetween, type BusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { NotFoundError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { assertTenantScope } from "@/server/core/rbac";

export type InvoiceRow = typeof invoices.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type PaymentRow = typeof customerPayments.$inferSelect;
export type AdvanceRow = typeof customerAdvances.$inferSelect;
export type CreditNoteRow = typeof creditNotes.$inferSelect;
export type AllocationRow = typeof paymentAllocations.$inferSelect;
export type UnbilledRow = typeof unbilledCharges.$inferSelect;
export type SignoffRow = typeof dataSignoffs.$inferSelect;

export type AgingBucket = EnumValue<"aging_bucket">;
export type ReceivableLine = EnumValue<"receivable_line">;

export const AGING_BUCKETS: readonly AgingBucket[] = ["not_due", "d1_7", "d8_30", "over_30"];

export type ReceivableRules = {
  underpayment_due_days: number;
  aging_first_bucket_days: number;
  aging_second_bucket_days: number;
  hold_warning_days: number;
  statement_default_days: number;
  /** KPI-04: sasaran % piutang lewat tempo (bawaan 5). */
  kpi04_target_percent: number;
};

/** Aturan piutang non-PAR (params `m5.receivable_rules`). */
export async function receivableRules(tx: Tx, date: BusinessDate, tenantId?: string | null): Promise<ReceivableRules> {
  return (await params.get(tx, "m5.receivable_rules", date, { tenantId: tenantId ?? null })) as ReceivableRules;
}

/** Hari lewat jatuh tempo per `asOf` (negatif/0 = belum jatuh tempo). */
export function daysPastDue(dueDate: BusinessDate, asOf: BusinessDate): number {
  return daysBetween(dueDate, asOf);
}

/** Kelompok umur (FR-M5-04): belum jatuh tempo / 1–7 / 8–30 / > 30 hari (batas dari `m5.receivable_rules`). */
export function agingBucket(dueDate: BusinessDate, asOf: BusinessDate, rules: Pick<ReceivableRules, "aging_first_bucket_days" | "aging_second_bucket_days">): AgingBucket {
  const d = daysPastDue(dueDate, asOf);
  if (d <= 0) return "not_due";
  if (d <= rules.aging_first_bucket_days) return "d1_7";
  if (d <= rules.aging_second_bucket_days) return "d8_30";
  return "over_30";
}

/** Lini piutang dari jenis faktur (US-M5-04 KP-1): toko = penjualan toko; kemitraan = langganan mitra; lainnya air truk. */
export function lineOfKind(kind: InvoiceKind): ReceivableLine {
  if (kind === "store_sale") return "store";
  if (kind === "partner_subscription") return "partner";
  return "truck";
}

/** Lini piutang suatu faktur: saldo awal memakai lini asal yang dipilih saat input (B-37), selain itu dari jenisnya. */
export function lineOfInvoice(inv: { kind: InvoiceKind; openingLine?: ReceivableLine | null }): ReceivableLine {
  if (inv.kind === "opening_balance" && inv.openingLine) return inv.openingLine;
  return lineOfKind(inv.kind);
}

/** Pusat laba faktur (payload event mandiri). */
export function profitCenterOfKind(kind: InvoiceKind): "L2" | "L4" | "L5" | null {
  const line = lineOfKind(kind);
  if (line === "store") return "L4";
  if (line === "partner") return "L5";
  return kind === "opening_balance" ? null : "L2";
}

export async function loadInvoice(tx: Tx, id: string, opts: { forUpdate?: boolean; ctx?: ActorContext } = {}): Promise<InvoiceRow> {
  const q = tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const row = rows[0];
  if (!row) throw new NotFoundError("Faktur tidak ditemukan.");
  if (opts.ctx) assertTenantScope(opts.ctx, row.tenantId);
  return row;
}

export async function loadCustomer(tx: Tx, id: string, opts: { forUpdate?: boolean; ctx?: ActorContext } = {}): Promise<CustomerRow> {
  const q = tx.select().from(customers).where(eq(customers.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const row = rows[0];
  if (!row) throw new NotFoundError("Pelanggan tidak ditemukan.");
  if (opts.ctx) assertTenantScope(opts.ctx, row.tenantId);
  return row;
}

export async function loadPayment(tx: Tx, id: string, opts: { forUpdate?: boolean; ctx?: ActorContext } = {}): Promise<PaymentRow> {
  const q = tx.select().from(customerPayments).where(eq(customerPayments.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const row = rows[0];
  if (!row) throw new NotFoundError("Pelunasan tidak ditemukan.");
  if (opts.ctx) assertTenantScope(opts.ctx, row.tenantId);
  return row;
}

export async function loadAdvance(tx: Tx, id: string, opts: { forUpdate?: boolean; ctx?: ActorContext } = {}): Promise<AdvanceRow> {
  const q = tx.select().from(customerAdvances).where(eq(customerAdvances.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const row = rows[0];
  if (!row) throw new NotFoundError("Uang muka tidak ditemukan.");
  if (opts.ctx) assertTenantScope(opts.ctx, row.tenantId);
  return row;
}

/** Status tanda tangan saldo awal piutang tenant (NFR-34): terbaru yang tidak digantikan. */
export async function openingSignoff(tx: Tx, tenantId: string): Promise<SignoffRow | null> {
  const rows = await tx
    .select()
    .from(dataSignoffs)
    .where(and(eq(dataSignoffs.tenantId, tenantId), eq(dataSignoffs.group, "opening_receivables")))
    .orderBy(dataSignoffs.createdAt);
  const live = rows.filter((r) => r.status !== "superseded");
  return live[live.length - 1] ?? null;
}

/** Jenis faktur lini air truk (pelunasan lewat sopir, pusat laba L2). */
export const TRUCK_INVOICE_KINDS: readonly InvoiceKind[] = ["delivery", "underpayment", "monthly", "opening_balance"];

/** Uraian singkat faktur untuk pesan/daftar. */
export function invoiceTitle(inv: Pick<InvoiceRow, "number" | "kind">): string {
  return inv.number;
}

/** Tautan layar faktur. */
export function invoiceLink(id: string): string {
  return `/piutang/faktur/${id}`;
}

export function customerCardLink(id: string): string {
  return `/piutang/pelanggan/${id}`;
}
