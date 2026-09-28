/**
 * M5 — kontrol jatuh tempo & status kredit Ditahan (US-M5-03; BR-01, BR-03, KPI-04; PAR-09, PAR-41, PAR-45; 6.2a
 * `credit_hold_release`, 6.2b penundaan masa transisi; PTB-27, PTB-28).
 *
 * - Evaluasi harian setelah tutup kas (event `cash_day.closed`) atau job PAR-55 (22.30): pelanggan Tempo/Tempo migrasi
 *   dengan faktur lewat tempo > PAR-09 hari → Ditahan otomatis + notifikasi `credit.on_hold` (Dispatcher, Admin
 *   Keuangan, pemilik) + event `credit_status.changed` (M2 menandai rit tempo belum Berangkat, PTB-27).
 *   Dikecualikan: faktur bersengketa selama ≤ PAR-45 hari; faktur yang tercakup pembukaan pemilik
 *   (`hold_release_covers_due_until`); faktur saldo awal sebelum total saldo awal ditandatangani; pelanggan dalam masa
 *   transisi (PAR-41, `hold_deferral_until`) — tetap tampil di laporan lewat tempo.
 * - Dilepas otomatis saat seluruh faktur lewat tempo lunas (kecuali ada penghapusan piutang, PTB-28).
 * - Pembukaan sebelum lunas: pemilik langsung (beralasan) atau lewat persetujuan bila diajukan Dispatcher/Admin
 *   Keuangan; berlaku sampai keterlambatan berikutnya.
 * - Riwayat status kredit di `customer_credit_history` (kapan, oleh siapa, alasan, aturan).
 */
import "server-only";

import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { customerCreditHistory, customers, employees, invoices, orders, users } from "@/db/schema";
import { label, type CreditStatus } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { evaluateCreditEligibility, type CreditEligibility } from "@/server/modules/m1-master";

import { customerCardLink, daysPastDue, loadCustomer, openingSignoff, type CustomerRow, type InvoiceRow } from "./common";

const CREDIT_STATUSES: readonly CreditStatus[] = ["credit", "credit_migrated"];

// =====================================================================================================================
// Perubahan status kredit (riwayat + audit + event)
// =====================================================================================================================

export async function changeCreditStatus(
  tx: Tx,
  ctx: ActorContext,
  customer: CustomerRow,
  input: {
    to: CreditStatus;
    reason: string;
    rule: string;
    automatic: boolean;
    approvalId?: string | null;
    set?: Partial<typeof customers.$inferInsert>;
  },
): Promise<CustomerRow> {
  const [after] = await tx
    .update(customers)
    .set({ creditStatus: input.to, updatedAt: ctx.now, ...(input.set ?? {}) })
    .where(eq(customers.id, customer.id))
    .returning();
  await tx.insert(customerCreditHistory).values({
    customerId: customer.id,
    fromStatus: customer.creditStatus,
    toStatus: input.to,
    creditLimitBefore: customer.creditLimit,
    creditLimitAfter: after!.creditLimit,
    termDaysBefore: customer.paymentTermDays,
    termDaysAfter: after!.paymentTermDays,
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
    action: "credit_status",
    before: { creditStatus: customer.creditStatus },
    after: { creditStatus: input.to, ...(input.set ?? {}) },
    reason: input.reason,
    rule: input.rule,
  });
  await emit(
    tx,
    "credit_status.changed",
    { customerId: customer.id, from: customer.creditStatus, to: input.to, reason: input.reason, automatic: input.automatic, rule: input.rule },
    { ctx, tenantId: customer.tenantId, objectType: "customer", objectId: customer.id },
  );
  return after!;
}

/** Status Tempo sebelum Ditahan (dari riwayat) — dipulihkan saat dilepas. */
async function statusBeforeHold(tx: Tx, customerId: string): Promise<CreditStatus> {
  const rows = await tx
    .select({ from: customerCreditHistory.fromStatus })
    .from(customerCreditHistory)
    .where(and(eq(customerCreditHistory.customerId, customerId), eq(customerCreditHistory.toStatus, "on_hold")))
    .orderBy(desc(customerCreditHistory.changedAt))
    .limit(1);
  const from = rows[0]?.from;
  return from === "credit_migrated" ? "credit_migrated" : "credit";
}

// =====================================================================================================================
// Evaluasi lewat tempo
// =====================================================================================================================

export type HoldCandidate = Pick<InvoiceRow, "id" | "number" | "dueDate" | "outstandingAmount" | "kind" | "disputeStatus" | "disputeUntil" | "isOpeningBalance"> & { daysPastDue: number };

/** Faktur terbuka lewat jatuh tempo pelanggan (semua), dengan hari lewat tempo per `date`. */
export async function overdueInvoices(tx: Tx, customerId: string, date: BusinessDate): Promise<HoldCandidate[]> {
  const rows = await tx
    .select({
      id: invoices.id,
      number: invoices.number,
      dueDate: invoices.dueDate,
      outstandingAmount: invoices.outstandingAmount,
      kind: invoices.kind,
      disputeStatus: invoices.disputeStatus,
      disputeUntil: invoices.disputeUntil,
      isOpeningBalance: invoices.isOpeningBalance,
    })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), gt(invoices.outstandingAmount, 0), lt(invoices.dueDate, date)))
    .orderBy(asc(invoices.dueDate));
  return rows.map((r) => ({ ...r, daysPastDue: daysPastDue(r.dueDate, date) }));
}

/** Faktur bersengketa yang masih dalam penundaan (≤ PAR-45 hari; 7.5.6). */
export function disputeSuspended(inv: Pick<InvoiceRow, "disputeStatus" | "disputeUntil">, date: BusinessDate): boolean {
  return inv.disputeStatus === "disputed" && !!inv.disputeUntil && inv.disputeUntil >= date;
}

export type HoldTrigger = { invoices: HoldCandidate[]; toleranceDays: number };

/** Faktur pemicu Ditahan (> PAR-09 hari lewat tempo, setelah pengecualian). */
export async function holdTriggers(tx: Tx, customer: CustomerRow, date: BusinessDate): Promise<HoldTrigger> {
  const par09 = await params.get(tx, "PAR-09", date);
  const signoff = await openingSignoff(tx, customer.tenantId);
  const openingSigned = signoff?.status === "signed";
  const overdue = await overdueInvoices(tx, customer.id, date);
  const triggers = overdue.filter(
    (inv) =>
      inv.daysPastDue > par09.days &&
      !disputeSuspended(inv, date) &&
      !(customer.holdReleaseCoversDueUntil && inv.dueDate <= customer.holdReleaseCoversDueUntil) &&
      !(inv.isOpeningBalance && !openingSigned),
  );
  return { invoices: triggers, toleranceDays: par09.days };
}

/** Masa transisi aktif (PAR-41; 6.2b). */
export function inTransition(customer: Pick<CustomerRow, "holdDeferralUntil">, date: BusinessDate): boolean {
  return !!customer.holdDeferralUntil && customer.holdDeferralUntil >= date;
}

export type HoldEvaluation = "held" | "released" | "deferred" | "unchanged";

/**
 * Evaluasi satu pelanggan (idempoten): Tempo + pemicu → Ditahan (kecuali masa transisi); Ditahan tanpa faktur lewat
 * tempo tersisa → dilepas otomatis (kecuali ada penghapusan piutang, PTB-28).
 */
export async function evaluateCustomerHold(tx: Tx, ctx: ActorContext, customerId: string, date: BusinessDate): Promise<HoldEvaluation> {
  const customer = await loadCustomer(tx, customerId, { forUpdate: true });
  if (CREDIT_STATUSES.includes(customer.creditStatus)) {
    const trig = await holdTriggers(tx, customer, date);
    if (trig.invoices.length === 0) return "unchanged";
    if (inTransition(customer, date)) return "deferred";
    const total = trig.invoices.reduce((s, i) => s + i.outstandingAmount, 0);
    const worst = trig.invoices.reduce((m, i) => Math.max(m, i.daysPastDue), 0);
    const reason = `Otomatis: ${trig.invoices.length} faktur lewat tempo lebih dari ${trig.toleranceDays} hari (${trig.invoices
      .slice(0, 3)
      .map((i) => `${i.number} ${i.daysPastDue} hari`)
      .join(", ")}${trig.invoices.length > 3 ? ", …" : ""}), total ${formatRupiah(total)}.`;
    await changeCreditStatus(tx, ctx, customer, { to: "on_hold", reason, rule: "BR-03", automatic: true });
    await notify(tx, {
      event: "credit.on_hold",
      tenantId: customer.tenantId,
      title: `Ditahan: ${customer.name}`,
      body: `${reason} Pesanan tempo baru diblokir; rit tempo yang belum Berangkat ditandai ke Dispatcher (PTB-27). Terbuka otomatis saat seluruh faktur lewat tempo lunas.`,
      objectType: "customer",
      objectId: customer.id,
      valueAmount: total,
      valueText: `${worst} hari`,
      link: customerCardLink(customer.id),
      groupKey: `credit.on_hold:${customer.id}:${date}`,
      now: ctx.now,
    });
    return "held";
  }
  if (customer.creditStatus === "on_hold") {
    if (await autoReleaseIfSettled(tx, ctx, customer, date)) return "released";
  }
  return "unchanged";
}

/** Lepas Ditahan otomatis bila tidak ada faktur lewat tempo tersisa (BR-03). Tidak untuk pelanggan dengan penghapusan piutang (PTB-28). */
export async function autoReleaseIfSettled(tx: Tx, ctx: ActorContext, customer: CustomerRow, date: BusinessDate): Promise<boolean> {
  if (customer.creditStatus !== "on_hold") return false;
  const [wo] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.customerId, customer.id), gt(invoices.writtenOffAmount, 0)));
  if (Number(wo?.n ?? 0) > 0) return false;
  const overdue = (await overdueInvoices(tx, customer.id, date)).filter((i) => !disputeSuspended(i, date));
  if (overdue.length > 0) return false;
  const to = await statusBeforeHold(tx, customer.id);
  const reason = "Otomatis: seluruh faktur lewat tempo sudah lunas (BR-03).";
  await changeCreditStatus(tx, ctx, customer, { to, reason, rule: "BR-03", automatic: true });
  await notify(tx, {
    event: "credit.hold_released",
    tenantId: customer.tenantId,
    title: `Ditahan dilepas: ${customer.name}`,
    body: `${reason} Status kembali ${label("credit_status", to)}.`,
    objectType: "customer",
    objectId: customer.id,
    link: customerCardLink(customer.id),
    now: ctx.now,
  });
  return true;
}

/** Setelah pelunasan/nota kredit: coba lepas Ditahan pelanggan terkait (tanpa menunggu job harian). */
export async function afterReceivablesChanged(tx: Tx, ctx: ActorContext, customerIds: readonly string[]): Promise<void> {
  const date = ctxBusinessDate(ctx);
  for (const id of new Set(customerIds)) {
    const c = await loadCustomer(tx, id);
    if (c.creditStatus === "on_hold") await autoReleaseIfSettled(tx, ctx, await loadCustomer(tx, id, { forUpdate: true }), date);
  }
}

export type HoldRunSummary = { date: BusinessDate; evaluated: number; held: string[]; released: string[]; deferred: string[] };

/** Evaluasi seluruh pelanggan Tempo/Ditahan tenant (job harian setelah tutup kas; idempoten). */
export async function evaluateCreditHolds(tx: Tx, ctx: ActorContext, tenantId: string, date: BusinessDate): Promise<HoldRunSummary> {
  const rows = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), inArray(customers.creditStatus, ["credit", "credit_migrated", "on_hold"])));
  const out: HoldRunSummary = { date, evaluated: rows.length, held: [], released: [], deferred: [] };
  for (const r of rows) {
    const res = await evaluateCustomerHold(tx, ctx, r.id, date);
    if (res === "held") out.held.push(r.id);
    else if (res === "released") out.released.push(r.id);
    else if (res === "deferred") out.deferred.push(r.id);
  }
  return out;
}

/** Jalankan evaluasi sekarang dari layar (pemilik/Admin Keuangan). */
export async function runHoldEvaluationNow(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<HoldRunSummary> {
  await authorize(ctx, "m5.credit_hold.evaluate", { tx: opts.tx });
  const date = ctxBusinessDate(ctx);
  // Penahanan/pelepasan tetap tindakan otomatis Sistem (aturan BR-03), walau evaluasinya dipicu dari layar.
  const sys = systemContext({ tenantId: ctx.tenantId, now: ctx.now, businessDate: date });
  return runService(ctx, opts, (tx) => evaluateCreditHolds(tx, sys, ctx.tenantId, date));
}

// =====================================================================================================================
// Pembukaan Ditahan sebelum lunas (KP-3; 6.2a)
// =====================================================================================================================

const releaseSchema = z.object({
  customerId: z.string().uuid({ error: "Pelanggan wajib dipilih." }),
  reason: z.string().trim().min(5, { error: "Alasan pembukaan wajib diisi (minimal 5 karakter)." }),
});

/** Terapkan pembukaan Ditahan (pemilik langsung / persetujuan disetujui): berlaku sampai keterlambatan berikutnya. */
export async function applyHoldRelease(tx: Tx, ctx: ActorContext, customerId: string, input: { reason: string; approvalId?: string | null }): Promise<CustomerRow | null> {
  const customer = await loadCustomer(tx, customerId, { forUpdate: true });
  if (customer.creditStatus !== "on_hold") return null;
  const date = ctxBusinessDate(ctx);
  const overdue = await overdueInvoices(tx, customer.id, date);
  const covers = overdue.reduce<string | null>((m, i) => (m === null || i.dueDate > m ? i.dueDate : m), customer.holdReleaseCoversDueUntil);
  const to = await statusBeforeHold(tx, customer.id);
  const after = await changeCreditStatus(tx, ctx, customer, {
    to,
    reason: `Dibuka sebelum lunas oleh pemilik: ${input.reason}`,
    rule: input.approvalId ? "BR-03, 6.2a" : "BR-03",
    automatic: false,
    approvalId: input.approvalId ?? null,
    set: {
      holdReleasedAt: ctx.now,
      holdReleasedBy: ctx.userId,
      holdReleaseApprovalId: input.approvalId ?? null,
      holdReleaseCoversDueUntil: covers ?? date,
    },
  });
  await notify(tx, {
    event: "credit.hold_released",
    tenantId: customer.tenantId,
    title: `Ditahan dibuka pemilik: ${customer.name}`,
    body: `Alasan: ${input.reason}. Berlaku sampai keterlambatan berikutnya (faktur jatuh tempo sampai ${covers ? formatTanggal(covers, { weekday: false }) : "hari ini"} tidak menahan lagi).`,
    objectType: "customer",
    objectId: customer.id,
    link: customerCardLink(customer.id),
    now: ctx.now,
  });
  return after;
}

/** Pemilik membuka Ditahan sebelum lunas dengan alasan (keputusan langsung, berjejak). */
export async function releaseCreditHold(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.credit_hold.release", { tx: opts.tx });
  const data = parseInput(releaseSchema, input, { customerId: "Pelanggan", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await loadCustomer(tx, data.customerId, { ctx });
    const after = await applyHoldRelease(tx, ctx, data.customerId, { reason: data.reason });
    if (!after) throw new DomainError("NOT_ON_HOLD", "Pelanggan tidak berstatus Ditahan.");
    return after;
  });
}

/** Dispatcher/Admin Keuangan mengajukan pembukaan Ditahan ke pemilik (6.2a `credit_hold_release`). */
export async function requestCreditHoldRelease(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.credit_hold.release_request", { tx: opts.tx });
  const data = parseInput(releaseSchema, input, { customerId: "Pelanggan", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const customer = await loadCustomer(tx, data.customerId, { ctx });
    if (customer.creditStatus !== "on_hold") throw new DomainError("NOT_ON_HOLD", "Pelanggan tidak berstatus Ditahan.");
    const overdue = await overdueInvoices(tx, customer.id, ctxBusinessDate(ctx));
    const total = overdue.reduce((s, i) => s + i.outstandingAmount, 0);
    return approvals.submit(
      ctx,
      {
        type: "credit_hold_release",
        objectType: "customer",
        objectId: customer.id,
        amount: total,
        reason: data.reason,
        payload: { customerName: customer.name, overdueInvoices: overdue.map((i) => ({ number: i.number, daysPastDue: i.daysPastDue, outstanding: i.outstandingAmount })), link: customerCardLink(customer.id) },
      },
      { tx },
    );
  });
}

// =====================================================================================================================
// Masa transisi (KP-5; PAR-41; 6.2b)
// =====================================================================================================================

const deferSchema = z.object({
  customerId: z.string().uuid({ error: "Pelanggan wajib dipilih." }),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Tanggal berakhir wajib diisi (YYYY-MM-DD)." }),
  reason: z.string().trim().min(5, { error: "Alasan penundaan wajib diisi (minimal 5 karakter)." }),
});

function addMonthsDate(date: BusinessDate, months: number): BusinessDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Batas akhir masa transisi = go-live (PAR-41; bila belum diisi: hari ini) + PAR-41 bulan. */
export async function transitionLimit(tx: Tx, date: BusinessDate): Promise<{ goLive: BusinessDate | null; maxUntil: BusinessDate; months: number }> {
  const par41 = await params.get(tx, "PAR-41", date);
  const goLive = par41.go_live_date ?? null;
  return { goLive, maxUntil: addMonthsDate(goLive ?? date, par41.max_months_since_go_live), months: par41.max_months_since_go_live };
}

/** Batas masa transisi untuk layar (izin `m5.credit_exposure.read`). */
export async function holdDeferralLimit(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<{ goLive: BusinessDate | null; maxUntil: BusinessDate; months: number; today: BusinessDate }> {
  await authorize(ctx, "m5.credit_exposure.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  return { ...(await transitionLimit(tx, today)), today };
}

/** Pemilik menunda penahanan otomatis per pelanggan sampai tanggal tertentu (≤ go-live + PAR-41). */
export async function deferCreditHold(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.credit_hold.defer", { tx: opts.tx });
  const data = parseInput(deferSchema, input, { customerId: "Pelanggan", until: "Berlaku sampai", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const customer = await loadCustomer(tx, data.customerId, { ctx, forUpdate: true });
    if (!["credit", "credit_migrated", "on_hold"].includes(customer.creditStatus)) {
      throw new DomainError("NOT_CREDIT_CUSTOMER", "Masa transisi hanya untuk pelanggan Tempo/Tempo migrasi.");
    }
    if (data.until < today) throw new DomainError("DEFER_PAST", "Tanggal berakhir masa transisi tidak boleh sebelum hari ini.");
    const limit = await transitionLimit(tx, today);
    if (data.until > limit.maxUntil) {
      throw new DomainError(
        "DEFER_TOO_LONG",
        `Masa transisi paling lama ${limit.months} bulan sejak go-live${limit.goLive ? ` (${formatTanggal(limit.goLive, { weekday: false })})` : ""}: pilih tanggal ≤ ${formatTanggal(limit.maxUntil, { weekday: false })} (PAR-41).`,
      );
    }
    const [after] = await tx
      .update(customers)
      .set({ holdDeferralUntil: data.until, holdDeferralReason: data.reason, holdDeferralSetBy: ctx.userId, updatedAt: ctx.now })
      .where(eq(customers.id, customer.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "customer",
      objectId: customer.id,
      action: "hold_deferral",
      before: { holdDeferralUntil: customer.holdDeferralUntil },
      after: { holdDeferralUntil: data.until },
      reason: data.reason,
      rule: "PAR-41, 6.2b",
    });
    let released = false;
    if (customer.creditStatus === "on_hold") {
      const to = await statusBeforeHold(tx, customer.id);
      await changeCreditStatus(tx, ctx, after!, { to, reason: `Masa transisi sampai ${data.until}: ${data.reason}`, rule: "PAR-41, 6.2b", automatic: false });
      released = true;
    }
    await notify(tx, {
      event: "credit.hold_deferred",
      tenantId: customer.tenantId,
      title: `Masa transisi: ${customer.name} sampai ${formatTanggal(data.until, { weekday: false })}`,
      body: `Penahanan otomatis ditunda pemilik (PAR-41). Alasan: ${data.reason}. Pelanggan tetap tampil di laporan lewat tempo.`,
      objectType: "customer",
      objectId: customer.id,
      link: customerCardLink(customer.id),
      now: ctx.now,
    });
    return { customer: after!, released };
  });
}

/** Akhiri masa transisi lebih awal (pemilik). */
export async function endCreditHoldDeferral(ctx: ActorContext, input: { customerId: string; reason: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.credit_hold.defer", { tx: opts.tx });
  const data = parseInput(releaseSchema, input, { customerId: "Pelanggan", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const customer = await loadCustomer(tx, data.customerId, { ctx, forUpdate: true });
    const [after] = await tx.update(customers).set({ holdDeferralUntil: null, updatedAt: ctx.now }).where(eq(customers.id, customer.id)).returning();
    await auditRecord(tx, { ctx, objectType: "customer", objectId: customer.id, action: "hold_deferral_end", before: { holdDeferralUntil: customer.holdDeferralUntil }, after: { holdDeferralUntil: null }, reason: data.reason, rule: "PAR-41, 6.2b" });
    return after!;
  });
}

// =====================================================================================================================
// Tampilan: riwayat status kredit, Ditahan, masa transisi, layak Tempo
// =====================================================================================================================

export type CreditHistoryRow = {
  id: string;
  changedAt: Date;
  fromStatus: CreditStatus | null;
  toStatus: CreditStatus;
  reason: string | null;
  rule: string | null;
  changedByName: string | null;
  approvalRequestId: string | null;
};

/** Riwayat status kredit pelanggan (KP-4). */
export async function creditHistory(ctx: ActorContext, customerId: string, opts: { tx?: Tx } = {}): Promise<CreditHistoryRow[]> {
  await authorize(ctx, "m5.credit_exposure.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await loadCustomer(tx, customerId, { ctx });
  const rows = await tx
    .select({ h: customerCreditHistory, name: employees.fullName })
    .from(customerCreditHistory)
    .leftJoin(users, eq(users.id, customerCreditHistory.changedBy))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(customerCreditHistory.customerId, customerId))
    .orderBy(desc(customerCreditHistory.changedAt));
  return rows.map((r) => ({
    id: r.h.id,
    changedAt: r.h.changedAt,
    fromStatus: r.h.fromStatus,
    toStatus: r.h.toStatus,
    reason: r.h.reason,
    rule: r.h.rule,
    changedByName: r.name ?? (r.h.changedBy ? null : "Sistem"),
    approvalRequestId: r.h.approvalRequestId,
  }));
}

export type CreditStatusBoardRow = {
  customerId: string;
  code: string | null;
  name: string;
  segment: CustomerRow["segment"];
  creditStatus: CreditStatus;
  creditLimit: number;
  overdueTotal: number;
  worstDaysPastDue: number;
  holdDeferralUntil: string | null;
  holdReleaseCoversDueUntil: string | null;
  lastChangedAt: Date | null;
  lastReason: string | null;
};

/** Papan status kredit: Ditahan + masa transisi + akan Ditahan (US-M5-03, US-M5-04 KP-3). */
export async function creditStatusBoard(ctx: ActorContext, opts: { tx?: Tx; date?: BusinessDate } = {}) {
  await authorize(ctx, "m5.credit_exposure.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const date = opts.date ?? ctxBusinessDate(ctx);
  const par09 = await params.get(tx, "PAR-09", date);
  const rules = (await params.get(tx, "m5.receivable_rules", date)) as { hold_warning_days: number };
  // Saldo awal yang belum ditandatangani pemilik tidak memicu penahanan (US-M5-07 KP-3) — begitu pula di papan ini.
  const openingSigned = (await openingSignoff(tx, ctx.tenantId))?.status === "signed";
  const list = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, ctx.tenantId), inArray(customers.creditStatus, ["credit", "credit_migrated", "on_hold"])))
    .orderBy(asc(customers.name));
  const onHold: CreditStatusBoardRow[] = [];
  const willHold: (CreditStatusBoardRow & { holdOn: BusinessDate })[] = [];
  const transition: CreditStatusBoardRow[] = [];
  for (const c of list) {
    const overdue = (await overdueInvoices(tx, c.id, date)).filter((i) => !disputeSuspended(i, date));
    const lastRows = await tx
      .select({ at: customerCreditHistory.changedAt, reason: customerCreditHistory.reason })
      .from(customerCreditHistory)
      .where(eq(customerCreditHistory.customerId, c.id))
      .orderBy(desc(customerCreditHistory.changedAt))
      .limit(1);
    const row: CreditStatusBoardRow = {
      customerId: c.id,
      code: c.code,
      name: c.name,
      segment: c.segment,
      creditStatus: c.creditStatus,
      creditLimit: c.creditLimit,
      overdueTotal: overdue.reduce((s, i) => s + i.outstandingAmount, 0),
      worstDaysPastDue: overdue.reduce((m, i) => Math.max(m, i.daysPastDue), 0),
      holdDeferralUntil: c.holdDeferralUntil,
      holdReleaseCoversDueUntil: c.holdReleaseCoversDueUntil,
      lastChangedAt: lastRows[0]?.at ?? null,
      lastReason: lastRows[0]?.reason ?? null,
    };
    if (c.creditStatus === "on_hold") onHold.push(row);
    else {
      if (inTransition(c, date)) {
        transition.push(row);
        continue;
      }
      // "Akan Ditahan": faktur yang melewati PAR-09 dalam `hold_warning_days` hari (atau sudah, menunggu evaluasi malam).
      const soon = overdue.filter(
        (i) =>
          !(c.holdReleaseCoversDueUntil && i.dueDate <= c.holdReleaseCoversDueUntil) &&
          !(i.isOpeningBalance && !openingSigned) &&
          i.daysPastDue > par09.days - rules.hold_warning_days,
      );
      if (soon.length) {
        const worst = soon.reduce((m, i) => (i.daysPastDue > m.daysPastDue ? i : m), soon[0]!);
        willHold.push({ ...row, holdOn: addDays(worst.dueDate, par09.days + 1) });
      }
    }
  }
  return { date, toleranceDays: par09.days, onHold, willHold, transition };
}

export type EligibleRow = { customerId: string; code: string | null; name: string; segment: CustomerRow["segment"]; eligibility: CreditEligibility };

/** Pelanggan Tunai yang memenuhi PAR-11 + PAR-82 → daftar "layak diajukan Tempo" (US-M5-03 KP-6). */
export async function creditEligibleCustomers(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<EligibleRow[]> {
  await authorize(ctx, "m5.credit_exposure.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const date = ctxBusinessDate(ctx);
  const candidates = await tx
    .selectDistinct({ id: customers.id, code: customers.code, name: customers.name, segment: customers.segment })
    .from(customers)
    .innerJoin(orders, and(eq(orders.customerId, customers.id), eq(orders.status, "completed")))
    .where(
      and(
        eq(customers.tenantId, ctx.tenantId),
        eq(customers.creditStatus, "cash"),
        eq(customers.isActive, true),
        ne(customers.segment, "household"),
        isNull(customers.internalOutletId),
      ),
    );
  const out: EligibleRow[] = [];
  for (const c of candidates) {
    const eligibility = await evaluateCreditEligibility(tx, c.id, { date });
    if (eligibility.eligible) out.push({ customerId: c.id, code: c.code, name: c.name, segment: c.segment, eligibility });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "id"));
}
