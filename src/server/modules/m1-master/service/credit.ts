/**
 * M1 — status kredit pelanggan (US-M1-01 KP-3/KP-4; BR-01, BR-02, BR-04; PAR-08, PAR-10, PAR-11, PAR-82; 6.2a).
 *
 * - Pelanggan baru Tunai (BR-01). "Ajukan Tempo" hanya bila layak: (≥ PAR-11 bulan sejak pesanan Selesai pertama ATAU
 *   ≥ PAR-11 pesanan Selesai) DAN "tanpa masalah" PAR-82 dalam periode itu (tanpa kurang bayar lewat PAR-09 hari,
 *   tanpa transfer "Tidak ditemukan", tanpa sengketa ditolak, ≤ PAR-82 rit gagal karena pelanggan menolak).
 * - Rumah tangga tidak pernah dapat Tempo (BR-04, CR-12). Tidak ada pengesampingan selain "Tempo migrasi" (impor data
 *   awal, US-M1-06 KP-6).
 * - Persetujuan pemilik wajib (credit_grant; ubah batas/tempo = credit_terms_change) — pemohon ≠ penyetuju.
 */
import "server-only";

import { and, count, eq, gte, isNotNull, lte, min, or, sql } from "drizzle-orm";
import { z } from "zod";

import { customerCreditHistory, customers, incomingTransfers, invoices, orders, trips } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah, zRupiahNonNegative } from "@/lib/money";
import { addDays, toBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";

import { addMonths, loadCustomer, type CustomerRow } from "./common";
import { defaultCreditTerms } from "./customers";

export type CreditEligibility = {
  customerId: string;
  eligible: boolean;
  /** Alasan tidak layak (bahasa lapangan) — kosong bila layak. */
  reasons: string[];
  metrics: {
    firstCompletedDate: string | null;
    monthsRequired: number;
    monthsSinceFirstMet: boolean;
    completedOrders: number;
    ordersRequired: number;
    underpaymentsOverdue: number;
    transfersNotFound: number;
    rejectedDisputes: number;
    failedTripsCustomerRefused: number;
  };
  limits: { maxUnderpaymentsOverdue: number; maxTransfersNotFound: number; maxRejectedDisputes: number; maxFailedTripsCustomerRefused: number };
};

/**
 * Evaluasi kelayakan Tempo (PAR-11 + PAR-82) dari data pesanan/rit/faktur/transfer (read-only). Rumah tangga selalu
 * tidak layak (BR-04). Pelanggan yang sudah Tempo/Tempo migrasi/Ditahan tidak perlu mengajukan lagi.
 */
export async function evaluateCreditEligibility(tx: Tx, customerId: string, opts: { date?: BusinessDate } = {}): Promise<CreditEligibility> {
  const customer = await loadCustomer(tx, null, customerId);
  const date = opts.date ?? toBusinessDate(new Date());
  const par11 = await params.get(tx, "PAR-11", date);
  const par82 = await params.get(tx, "PAR-82", date);
  const par09 = await params.get(tx, "PAR-09", date);
  const reasons: string[] = [];

  const [first] = await tx
    .select({ firstAt: min(orders.completedAt), n: count() })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.status, "completed"), isNotNull(orders.completedAt)));
  const firstCompletedDate = first?.firstAt ? toBusinessDate(first.firstAt) : null;
  const completedOrders = Number(first?.n ?? 0);
  const monthsMet = firstCompletedDate !== null && addMonths(firstCompletedDate, par11.min_months_since_first_completed) <= date;
  const ordersMet = completedOrders >= par11.min_completed_orders;
  const volumeMet = par11.combine === "and" ? monthsMet && ordersMet : monthsMet || ordersMet;

  // Periode penilaian PAR-82 = sejak pesanan Selesai pertama s.d. hari ini.
  const periodStart = firstCompletedDate ?? date;
  const periodStartUtc = new Date(`${periodStart}T00:00:00+07:00`);
  const overdueCutoff = addDays(date, -par09.days);
  const [under] = await tx
    .select({ n: count() })
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, customerId),
        eq(invoices.kind, "underpayment"),
        gte(invoices.issueDate, periodStart),
        or(
          // Belum lunas dan sudah lewat jatuh tempo > PAR-09 hari.
          and(sql`${invoices.outstandingAmount} > 0`, lte(invoices.dueDate, overdueCutoff)),
          // Sudah lunas, tetapi dilunasi > PAR-09 hari setelah jatuh tempo.
          sql`${invoices.paidAt} is not null and (${invoices.paidAt} at time zone 'Asia/Jakarta')::date > ${invoices.dueDate} + ${par09.days}::int`,
        ),
      ),
    );
  const [transfers] = await tx
    .select({ n: count() })
    .from(incomingTransfers)
    .where(and(eq(incomingTransfers.customerId, customerId), or(eq(incomingTransfers.status, "not_found"), isNotNull(incomingTransfers.notFoundAt)), gte(incomingTransfers.transferDate, periodStart)));
  const [disputes] = await tx
    .select({ n: count() })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.disputeStatus, "rejected"), gte(invoices.issueDate, periodStart)));
  const [refused] = await tx
    .select({ n: count() })
    .from(trips)
    .where(and(eq(trips.customerId, customerId), eq(trips.status, "failed"), eq(trips.failReason, "customer_refused"), gte(trips.failedAt, periodStartUtc)));

  const metrics = {
    firstCompletedDate,
    monthsRequired: par11.min_months_since_first_completed,
    monthsSinceFirstMet: monthsMet,
    completedOrders,
    ordersRequired: par11.min_completed_orders,
    underpaymentsOverdue: Number(under?.n ?? 0),
    transfersNotFound: Number(transfers?.n ?? 0),
    rejectedDisputes: Number(disputes?.n ?? 0),
    failedTripsCustomerRefused: Number(refused?.n ?? 0),
  };
  const limits = {
    maxUnderpaymentsOverdue: par82.max_underpayments_overdue_7d,
    maxTransfersNotFound: par82.max_transfers_not_found,
    maxRejectedDisputes: par82.max_rejected_disputes,
    maxFailedTripsCustomerRefused: par82.max_failed_trips_customer_refused,
  };

  const terms = await defaultCreditTerms(tx, customer.segment, date);
  if (terms.cashOnly) reasons.push(`Segmen ${label("customer_segment", customer.segment)} hanya tunai tanpa pengecualian (BR-04).`);
  if (customer.creditStatus !== "cash") reasons.push(`Status kredit sudah ${label("credit_status", customer.creditStatus)}.`);
  if (!customer.isActive) reasons.push("Pelanggan nonaktif.");
  if (!volumeMet) {
    reasons.push(
      `Belum memenuhi syarat lama/volume (PAR-11): ${par11.min_months_since_first_completed} bulan sejak pesanan Selesai pertama ${par11.combine === "and" ? "dan" : "atau"} ${par11.min_completed_orders} pesanan Selesai (baru ${completedOrders} pesanan${firstCompletedDate ? `, pertama ${firstCompletedDate}` : ""}).`,
    );
  }
  if (metrics.underpaymentsOverdue > limits.maxUnderpaymentsOverdue) reasons.push(`Ada ${metrics.underpaymentsOverdue} kurang bayar lewat ${par09.days} hari (PAR-82).`);
  if (metrics.transfersNotFound > limits.maxTransfersNotFound) reasons.push(`Ada ${metrics.transfersNotFound} transfer "Tidak ditemukan" (PAR-82).`);
  if (metrics.rejectedDisputes > limits.maxRejectedDisputes) reasons.push(`Ada ${metrics.rejectedDisputes} sengketa yang ditolak (PAR-82).`);
  if (metrics.failedTripsCustomerRefused > limits.maxFailedTripsCustomerRefused) {
    reasons.push(`Ada ${metrics.failedTripsCustomerRefused} rit gagal karena pelanggan menolak (maks. ${limits.maxFailedTripsCustomerRefused}, PAR-82).`);
  }
  return { customerId, eligible: reasons.length === 0, reasons, metrics, limits };
}

const grantSchema = z.object({
  reason: z.string().trim().min(3, { error: "Alasan pengajuan wajib diisi (minimal 3 karakter)." }),
});

/**
 * Ajukan status Tempo (US-M1-01 KP-3): hanya bila layak PAR-11 + PAR-82; batas dari segmen (PAR-10) & tempo standar
 * (PAR-08). Persetujuan pemilik wajib (6.2a `credit_grant`).
 */
export async function requestCreditGrant(ctx: ActorContext, customerId: string, input: z.input<typeof grantSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.customer.request_credit", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const data = parseInput(grantSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const customer = await loadCustomer(tx, ctx, customerId);
    const eligibility = await evaluateCreditEligibility(tx, customerId, { date: ctxBusinessDate(ctx) });
    if (!eligibility.eligible) {
      throw new DomainError("CREDIT_NOT_ELIGIBLE", `Belum dapat mengajukan Tempo: ${eligibility.reasons.join(" ")}`, { eligibility });
    }
    const terms = await defaultCreditTerms(tx, customer.segment, ctxBusinessDate(ctx));
    return approvals.submit(
      ctx,
      {
        type: "credit_grant",
        objectType: "customer",
        objectId: customerId,
        amount: terms.creditLimit,
        reason: data.reason,
        payload: {
          customerName: customer.name,
          segment: customer.segment,
          creditLimit: terms.creditLimit,
          paymentTermDays: terms.paymentTermDays,
          metrics: eligibility.metrics,
          link: `/master/pelanggan/${customerId}`,
        },
      },
      { tx },
    );
  });
}

const termsSchema = z.object({
  creditLimit: zRupiahNonNegative,
  paymentTermDays: z.number().int({ error: "Tempo harus bilangan bulat hari." }).min(1, { error: "Tempo minimal 1 hari." }).max(90, { error: "Tempo maksimal 90 hari." }),
  reason: z.string().trim().min(3, { error: "Alasan pengajuan wajib diisi (minimal 3 karakter)." }),
});

/** Ajukan perubahan batas/tempo pelanggan bertempo (US-M1-01 KP-4; 6.2a `credit_terms_change`). */
export async function requestCreditTermsChange(ctx: ActorContext, customerId: string, input: z.input<typeof termsSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.customer.request_credit_terms", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const data = parseInput(termsSchema, input, { creditLimit: "Batas kredit", paymentTermDays: "Tempo (hari)", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const customer = await loadCustomer(tx, ctx, customerId);
    const terms = await defaultCreditTerms(tx, customer.segment, ctxBusinessDate(ctx));
    if (terms.cashOnly) throw new DomainError("HOUSEHOLD_CASH_ONLY", `Segmen ${label("customer_segment", customer.segment)} hanya tunai; batas/tempo tidak berlaku (BR-04).`);
    if (customer.creditStatus === "cash") throw new DomainError("NOT_CREDIT_CUSTOMER", "Pelanggan masih Tunai. Ajukan status Tempo lebih dulu.");
    if (data.creditLimit === customer.creditLimit && data.paymentTermDays === customer.paymentTermDays) {
      throw new DomainError("NO_CHANGE", "Batas dan tempo sama dengan yang berlaku sekarang.");
    }
    return approvals.submit(
      ctx,
      {
        type: "credit_terms_change",
        objectType: "customer",
        objectId: customerId,
        amount: data.creditLimit,
        reason: data.reason,
        payload: {
          customerName: customer.name,
          creditLimitBefore: customer.creditLimit,
          creditLimit: data.creditLimit,
          paymentTermDaysBefore: customer.paymentTermDays,
          paymentTermDays: data.paymentTermDays,
          link: `/master/pelanggan/${customerId}`,
        },
      },
      { tx },
    );
  });
}

/** Penerapan `credit_grant` disetujui (ctx = pemilik; tulis langsung + audit, 6.2a). */
export async function applyCreditGrant(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow): Promise<Record<string, unknown>> {
  const customer = await loadCustomer(tx, null, request.objectId, { forUpdate: true });
  const date = ctxBusinessDate(ctx);
  const terms = await defaultCreditTerms(tx, customer.segment, date);
  if (terms.cashOnly) throw new DomainError("HOUSEHOLD_CASH_ONLY", "Rumah tangga tidak dapat Tempo (BR-04).");
  if (customer.creditStatus !== "cash") return { applied: false, note: `Status sudah ${label("credit_status", customer.creditStatus)}.` };
  const payload = (request.payload ?? {}) as { creditLimit?: number; paymentTermDays?: number };
  const creditLimit = typeof payload.creditLimit === "number" ? payload.creditLimit : terms.creditLimit;
  const paymentTermDays = typeof payload.paymentTermDays === "number" ? payload.paymentTermDays : terms.paymentTermDays;
  await setCreditStatus(tx, ctx, customer, { to: "credit", creditLimit, paymentTermDays, reason: `Pemberian status Tempo disetujui (${request.number}). ${request.reason}`, approvalId: request.id, rule: "BR-01" });
  return { applied: true, creditLimit, paymentTermDays };
}

/** Penerapan `credit_terms_change` disetujui. */
export async function applyCreditTermsChange(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow): Promise<Record<string, unknown>> {
  const customer = await loadCustomer(tx, null, request.objectId, { forUpdate: true });
  const payload = (request.payload ?? {}) as { creditLimit?: number; paymentTermDays?: number };
  if (typeof payload.creditLimit !== "number" || typeof payload.paymentTermDays !== "number") return { applied: false };
  const [after] = await tx
    .update(customers)
    .set({ creditLimit: payload.creditLimit, creditLimitOverridden: true, paymentTermDays: payload.paymentTermDays })
    .where(eq(customers.id, customer.id))
    .returning();
  await tx.insert(customerCreditHistory).values({
    customerId: customer.id,
    fromStatus: customer.creditStatus,
    toStatus: customer.creditStatus,
    creditLimitBefore: customer.creditLimit,
    creditLimitAfter: payload.creditLimit,
    termDaysBefore: customer.paymentTermDays,
    termDaysAfter: payload.paymentTermDays,
    reason: `Perubahan batas/tempo disetujui (${request.number}). ${request.reason}`,
    changedBy: ctx.userId,
    rule: "BR-04",
    approvalRequestId: request.id,
    changedAt: ctx.now,
  });
  await auditRecord(tx, {
    ctx,
    objectType: "customer",
    objectId: customer.id,
    action: "update",
    before: { creditLimit: customer.creditLimit, paymentTermDays: customer.paymentTermDays },
    after: { creditLimit: after!.creditLimit, paymentTermDays: after!.paymentTermDays },
    reason: request.reason,
    rule: "6.2a",
  });
  return { applied: true, creditLimit: after!.creditLimit, paymentTermDays: after!.paymentTermDays, text: `Batas ${formatRupiah(after!.creditLimit)}, tempo ${after!.paymentTermDays} hari` };
}

/** Ubah status kredit + riwayat + audit + event `credit_status.changed`. */
export async function setCreditStatus(
  tx: Tx,
  ctx: ActorContext,
  customer: CustomerRow,
  input: { to: CustomerRow["creditStatus"]; creditLimit: number; paymentTermDays: number; reason: string; approvalId?: string | null; rule: string; automatic?: boolean },
): Promise<CustomerRow> {
  const [after] = await tx
    .update(customers)
    .set({ creditStatus: input.to, creditLimit: input.creditLimit, paymentTermDays: input.paymentTermDays })
    .where(eq(customers.id, customer.id))
    .returning();
  await tx.insert(customerCreditHistory).values({
    customerId: customer.id,
    fromStatus: customer.creditStatus,
    toStatus: input.to,
    creditLimitBefore: customer.creditLimit,
    creditLimitAfter: input.creditLimit,
    termDaysBefore: customer.paymentTermDays,
    termDaysAfter: input.paymentTermDays,
    reason: input.reason,
    changedBy: ctx.userId,
    rule: input.rule,
    approvalRequestId: input.approvalId ?? null,
    changedAt: ctx.now,
  });
  await auditRecord(tx, {
    ctx,
    objectType: "customer",
    objectId: customer.id,
    action: "update",
    before: { creditStatus: customer.creditStatus, creditLimit: customer.creditLimit, paymentTermDays: customer.paymentTermDays },
    after: { creditStatus: input.to, creditLimit: input.creditLimit, paymentTermDays: input.paymentTermDays },
    reason: input.reason,
    rule: input.rule,
  });
  await emit(
    tx,
    "credit_status.changed",
    { customerId: customer.id, from: customer.creditStatus, to: input.to, reason: input.reason, automatic: input.automatic ?? false, rule: input.rule },
    { ctx, tenantId: customer.tenantId, objectType: "customer", objectId: customer.id },
  );
  return after!;
}

/** Kelayakan Tempo untuk layar (dengan otorisasi baca). */
export async function getCreditEligibility(ctx: ActorContext, customerId: string, opts: { tx?: Tx } = {}): Promise<CreditEligibility> {
  await authorize(ctx, "m1.customer.read", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const tx = opts.tx ?? getDb();
  await loadCustomer(tx, ctx, customerId);
  return evaluateCreditEligibility(tx, customerId, { date: ctxBusinessDate(ctx) });
}
