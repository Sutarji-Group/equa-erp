/**
 * M5 — umur piutang, kartu piutang & daftar tindakan harian (US-M5-04; FR-M5-04, KPI-04, BR-39, PAR-40).
 *
 * - Umur per pelanggan / segmen / lini (air truk, toko): belum jatuh tempo / 1–7 / 8–30 / > 30 hari (batas dari
 *   `m5.receivable_rules`) + belum ditagih; % lewat tempo terhadap total piutang (KPI-04) — tersedia kapan saja.
 * - Kartu piutang per pelanggan: faktur, pelunasan, uang muka, nota kredit, penghapusan, saldo berjalan; ekspor
 *   PDF/Excel (hanya pemilik/Admin Keuangan + tujuan, BR-39) dan dapat dikirim sebagai pernyataan piutang.
 * - Daftar tindakan harian Admin Keuangan: pelanggan yang perlu diingatkan (H-3/H+1) dan yang akan/sudah Ditahan.
 * - Ringkasan mingguan otomatis ke pemilik (Senin pagi, PAR-40).
 */
import "server-only";

import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

import { creditNotes, customerAdvances, customerPayments, customers, invoices, paymentAllocations, unbilledCharges } from "@/db/schema";
import { label, type CreditStatus, type CustomerSegment } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, isBusinessDate, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";
import { buildWaLink, recordWaOpened, renderTemplate } from "@/server/core/wa";

import { AGING_BUCKETS, agingBucket, lineOfKind, loadCustomer, receivableRules, type AgingBucket, type ReceivableLine } from "./common";
import { creditStatusBoard, inTransition } from "./credit-hold";
import { listReminders } from "./reminders";
import { activeTemplate, companyName } from "./templates";
import { z } from "zod";

type Buckets = Record<AgingBucket, number>;
const emptyBuckets = (): Buckets => ({ not_due: 0, d1_7: 0, d8_30: 0, over_30: 0 });

export type AgingCustomerRow = Buckets & {
  customerId: string;
  code: string | null;
  name: string;
  segment: CustomerSegment;
  creditStatus: CreditStatus;
  inTransition: boolean;
  unbilled: number;
  total: number;
  overdue: number;
  oldestDueDate: string | null;
};

export type AgingGroupRow = Buckets & { key: string; label: string; unbilled: number; total: number; overdue: number };

export type AgingReport = {
  asOf: BusinessDate;
  bucketLabels: Record<AgingBucket, string>;
  customers: AgingCustomerRow[];
  bySegment: AgingGroupRow[];
  byLine: AgingGroupRow[];
  totals: Buckets & { unbilled: number; total: number; overdue: number; overduePct: number };
  /** Sasaran KPI-04 (% lewat tempo) dari `m5.receivable_rules`. */
  kpi04TargetPercent: number;
};

function bucketLabels(rules: { aging_first_bucket_days: number; aging_second_bucket_days: number }): Record<AgingBucket, string> {
  return {
    not_due: label("aging_bucket", "not_due"),
    d1_7: `1–${rules.aging_first_bucket_days} hari`,
    d8_30: `${rules.aging_first_bucket_days + 1}–${rules.aging_second_bucket_days} hari`,
    over_30: `> ${rules.aging_second_bucket_days} hari`,
  };
}

/** Laporan umur piutang (US-M5-04 KP-1) — tanpa otorisasi (dipakai job ringkasan & laporan ekspor). */
export async function computeAging(tx: Tx, tenantId: string, asOf: BusinessDate, filter: { segment?: CustomerSegment | null; line?: ReceivableLine | null } = {}): Promise<AgingReport> {
  const rules = await receivableRules(tx, asOf, tenantId);
  const rows = await tx
    .select({ inv: invoices, c: customers })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.tenantId, tenantId), gt(invoices.outstandingAmount, 0)));
  const unbilled = await tx
    .select({ customerId: unbilledCharges.customerId, total: sql<string>`sum(${unbilledCharges.amount})`, c: customers })
    .from(unbilledCharges)
    .innerJoin(customers, eq(customers.id, unbilledCharges.customerId))
    .where(and(eq(unbilledCharges.tenantId, tenantId), eq(unbilledCharges.status, "unbilled")))
    .groupBy(unbilledCharges.customerId, customers.id);
  const byCustomer = new Map<string, AgingCustomerRow>();
  const bySegment = new Map<string, AgingGroupRow>();
  const byLine = new Map<string, AgingGroupRow>();
  const touch = (c: typeof customers.$inferSelect) => {
    let row = byCustomer.get(c.id);
    if (!row) {
      row = { ...emptyBuckets(), customerId: c.id, code: c.code, name: c.name, segment: c.segment, creditStatus: c.creditStatus, inTransition: inTransition(c, asOf), unbilled: 0, total: 0, overdue: 0, oldestDueDate: null };
      byCustomer.set(c.id, row);
    }
    return row;
  };
  const group = (map: Map<string, AgingGroupRow>, key: string, text: string) => {
    let g = map.get(key);
    if (!g) {
      g = { ...emptyBuckets(), key, label: text, unbilled: 0, total: 0, overdue: 0 };
      map.set(key, g);
    }
    return g;
  };
  for (const { inv, c } of rows) {
    const line = lineOfKind(inv.kind);
    if (filter.segment && c.segment !== filter.segment) continue;
    if (filter.line && line !== filter.line) continue;
    const b = agingBucket(inv.dueDate, asOf, rules);
    const amt = inv.outstandingAmount;
    for (const target of [touch(c), group(bySegment, c.segment, label("customer_segment", c.segment)), group(byLine, line, label("receivable_line", line))]) {
      target[b] += amt;
      target.total += amt;
      if (b !== "not_due") target.overdue += amt;
    }
    const cr = touch(c);
    if (!cr.oldestDueDate || inv.dueDate < cr.oldestDueDate) cr.oldestDueDate = inv.dueDate;
  }
  if (filter.line !== "store" && filter.line !== "partner") {
    for (const u of unbilled) {
      if (filter.segment && u.c.segment !== filter.segment) continue;
      const amt = Number(u.total ?? 0);
      for (const target of [touch(u.c), group(bySegment, u.c.segment, label("customer_segment", u.c.segment)), group(byLine, "truck", label("receivable_line", "truck"))]) {
        target.unbilled += amt;
        target.total += amt;
      }
    }
  }
  const totals = { ...emptyBuckets(), unbilled: 0, total: 0, overdue: 0, overduePct: 0 };
  for (const r of byCustomer.values()) {
    for (const b of AGING_BUCKETS) totals[b] += r[b];
    totals.unbilled += r.unbilled;
    totals.total += r.total;
    totals.overdue += r.overdue;
  }
  totals.overduePct = totals.total === 0 ? 0 : Math.round((totals.overdue / totals.total) * 10_000) / 100;
  return {
    asOf,
    bucketLabels: bucketLabels(rules),
    customers: [...byCustomer.values()].sort((a, b) => b.overdue - a.overdue || b.total - a.total || a.name.localeCompare(b.name, "id")),
    bySegment: [...bySegment.values()].sort((a, b) => b.total - a.total),
    byLine: [...byLine.values()].sort((a, b) => b.total - a.total),
    totals,
    kpi04TargetPercent: rules.kpi04_target_percent,
  };
}

/** Umur piutang untuk layar (izin `m5.aging.read`: pemilik, Admin Keuangan, akuntan). */
export async function agingReport(
  ctx: ActorContext,
  input: { asOf?: BusinessDate | null; segment?: CustomerSegment | null; line?: ReceivableLine | null } = {},
  opts: { tx?: Tx } = {},
): Promise<AgingReport> {
  await authorize(ctx, "m5.aging.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const asOf = input.asOf && isBusinessDate(input.asOf) ? input.asOf : ctxBusinessDate(ctx);
  return computeAging(tx, ctx.tenantId, asOf, { segment: input.segment ?? null, line: input.line ?? null });
}

// =====================================================================================================================
// Kartu piutang (KP-2)
// =====================================================================================================================

export type StatementEntry = {
  date: string;
  at: Date;
  kind: "opening" | "invoice" | "payment" | "payment_reversal" | "credit_note" | "write_off" | "advance" | "advance_refund";
  reference: string;
  description: string;
  debit: number;
  credit: number;
  /** Saldo berjalan setelah baris (baris uang muka tidak mengubah saldo piutang). */
  balance: number;
  info?: number;
};

export type CustomerStatement = {
  customer: { id: string; code: string | null; name: string; waPhone: string; segment: CustomerSegment; creditStatus: CreditStatus; creditLimit: number; paymentTermDays: number; monthlyBilling: boolean };
  from: BusinessDate;
  to: BusinessDate;
  openingBalance: number;
  entries: StatementEntry[];
  closingBalance: number;
  openAdvance: number;
  unbilled: number;
  openInvoices: { id: string; number: string; dueDate: string; outstanding: number; bucket: AgingBucket }[];
};

/** Kartu piutang pelanggan (tanpa otorisasi — dipakai layar, ekspor, dan pernyataan). */
export async function computeStatement(tx: Tx, customerId: string, input: { from: BusinessDate; to: BusinessDate; asOf: BusinessDate }): Promise<CustomerStatement> {
  const c = await loadCustomer(tx, customerId);
  const rules = await receivableRules(tx, input.asOf, c.tenantId);
  const raw: Omit<StatementEntry, "balance">[] = [];
  const invs = await tx.select().from(invoices).where(eq(invoices.customerId, customerId));
  for (const i of invs) {
    raw.push({ date: i.issueDate, at: i.createdAt, kind: "invoice", reference: i.number, description: `${label("invoice_kind", i.kind)}${i.description ? ` — ${i.description}` : ""} (jatuh tempo ${formatTanggal(i.dueDate, { weekday: false })})`, debit: i.amount, credit: 0 });
    if (i.writtenOffAmount > 0 && i.writtenOffAt) {
      raw.push({ date: toBusinessDate(i.writtenOffAt), at: i.writtenOffAt, kind: "write_off", reference: i.number, description: "Penghapusan piutang tak tertagih (PTB-28)", debit: 0, credit: i.writtenOffAmount });
    }
  }
  const invIds = invs.map((i) => i.id);
  const numberOf = new Map(invs.map((i) => [i.id, i.number]));
  if (invIds.length) {
    const allocs = await tx
      .select({ a: paymentAllocations, payDate: customerPayments.businessDate, channel: customerPayments.channel, method: customerPayments.method })
      .from(paymentAllocations)
      .leftJoin(customerPayments, eq(customerPayments.id, paymentAllocations.customerPaymentId))
      .where(and(inArray(paymentAllocations.invoiceId, invIds), sql`${paymentAllocations.creditNoteId} is null`));
    for (const r of allocs) {
      const a = r.a;
      const date = a.amount > 0 && r.payDate ? r.payDate : toBusinessDate(a.allocatedAt);
      const ref = numberOf.get(a.invoiceId) ?? "";
      if (a.amount > 0) {
        raw.push({
          date,
          at: a.allocatedAt,
          kind: "payment",
          reference: ref,
          description: a.customerAdvanceId ? "Uang muka dialokasikan" : `Pelunasan ${r.channel ? label("payment_channel", r.channel).toLowerCase() : ""} ${r.method ? `(${label("payment_method", r.method).toLowerCase()})` : ""}`.trim(),
          debit: 0,
          credit: a.amount,
        });
      } else {
        raw.push({ date, at: a.allocatedAt, kind: "payment_reversal", reference: ref, description: "Pembalik / realokasi pelunasan (BR-38)", debit: -a.amount, credit: 0 });
      }
    }
    const cns = await tx.select().from(creditNotes).where(and(inArray(creditNotes.invoiceId, invIds), eq(creditNotes.status, "issued")));
    for (const n of cns) raw.push({ date: n.issueDate, at: n.createdAt, kind: "credit_note", reference: n.number, description: `Nota kredit ${numberOf.get(n.invoiceId) ?? ""}: ${n.reason}`, debit: 0, credit: n.amount });
  }
  const advances = await tx.select().from(customerAdvances).where(eq(customerAdvances.customerId, customerId));
  for (const a of advances) {
    raw.push({ date: toBusinessDate(a.createdAt), at: a.createdAt, kind: "advance", reference: "Uang muka", description: a.notes ?? "Uang muka pelanggan", debit: 0, credit: 0, info: a.amount });
    if (a.refundedAt) raw.push({ date: toBusinessDate(a.refundedAt), at: a.refundedAt, kind: "advance_refund", reference: "Uang muka", description: "Pengembalian uang muka (persetujuan pemilik)", debit: 0, credit: 0, info: a.amount - a.remainingAmount });
  }
  raw.sort((x, y) => x.date.localeCompare(y.date) || x.at.getTime() - y.at.getTime());
  let running = 0;
  let opening = 0;
  const entries: StatementEntry[] = [];
  for (const e of raw) {
    running += e.debit - e.credit;
    if (e.date < input.from) {
      opening = running;
      continue;
    }
    if (e.date > input.to) continue;
    entries.push({ ...e, balance: running });
  }
  const closing = entries.length ? entries[entries.length - 1]!.balance : opening;
  const [unb] = await tx.select({ total: sql<string>`coalesce(sum(${unbilledCharges.amount}), 0)` }).from(unbilledCharges).where(and(eq(unbilledCharges.customerId, customerId), eq(unbilledCharges.status, "unbilled")));
  const openAdvance = advances.filter((a) => a.status === "open").reduce((s, a) => s + a.remainingAmount, 0);
  return {
    customer: { id: c.id, code: c.code, name: c.name, waPhone: c.waPhone, segment: c.segment, creditStatus: c.creditStatus, creditLimit: c.creditLimit, paymentTermDays: c.paymentTermDays, monthlyBilling: c.monthlyBilling },
    from: input.from,
    to: input.to,
    openingBalance: opening,
    entries,
    closingBalance: closing,
    openAdvance,
    unbilled: Number(unb?.total ?? 0),
    openInvoices: invs
      .filter((i) => i.outstandingAmount > 0)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((i) => ({ id: i.id, number: i.number, dueDate: i.dueDate, outstanding: i.outstandingAmount, bucket: agingBucket(i.dueDate, input.asOf, rules) })),
  };
}

/** Kartu piutang untuk layar (izin `m5.aging.read`). Bawaan rentang = `statement_default_days` terakhir. */
export async function customerStatement(ctx: ActorContext, customerId: string, input: { from?: BusinessDate | null; to?: BusinessDate | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.aging.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await loadCustomer(tx, customerId, { ctx });
  const today = ctxBusinessDate(ctx);
  const rules = await receivableRules(tx, today, ctx.tenantId);
  const to = input.to && isBusinessDate(input.to) ? input.to : today;
  const from = input.from && isBusinessDate(input.from) ? input.from : addDays(to, -rules.statement_default_days);
  return computeStatement(tx, customerId, { from, to, asOf: today });
}

/** Kirim kartu piutang sebagai pernyataan piutang lewat WA (tercatat). */
export async function sendStatement(ctx: ActorContext, input: { customerId: string }, opts: { tx?: Tx } = {}): Promise<{ link: string; text: string }> {
  await authorize(ctx, "m5.invoice.send", { tx: opts.tx });
  const data = parseInput(z.object({ customerId: z.string().uuid() }), input);
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const c = await loadCustomer(tx, data.customerId, { ctx });
    const st = await computeStatement(tx, c.id, { from: addDays(today, -365), to: today, asOf: today });
    const tpl = await activeTemplate(tx, c.tenantId, "statement");
    const { text } = renderTemplate(tpl.body, {
      nama_pelanggan: c.name,
      tanggal: formatTanggal(today, { weekday: false }),
      saldo: formatRupiah(st.closingBalance + st.unbilled),
      jumlah_faktur: st.openInvoices.length,
      rincian: st.openInvoices.map((i) => `- ${i.number} jatuh tempo ${formatTanggal(i.dueDate, { weekday: false })}: ${formatRupiah(i.outstanding)}`).join("\n") + (st.unbilled ? `\n- Belum ditagih (faktur bulanan): ${formatRupiah(st.unbilled)}` : ""),
      nama_usaha: await companyName(tx, c.tenantId, today),
    });
    const link = buildWaLink(c.waPhone, text);
    await recordWaOpened(tx, ctx, { kind: "statement", toPhone: c.waPhone, renderedText: text, templateId: tpl.id, customerId: c.id, objectType: "customer", objectId: c.id });
    await auditRecord(tx, { ctx, objectType: "customer", objectId: c.id, action: "statement_sent", after: { balance: st.closingBalance, unbilled: st.unbilled }, rule: "US-M5-04 KP-2" });
    return { link, text };
  });
}

// =====================================================================================================================
// Ringkasan & daftar tindakan harian (KP-3)
// =====================================================================================================================

export type ReceivableOverview = {
  date: BusinessDate;
  totals: AgingReport["totals"];
  openInvoiceCount: number;
  onHoldCount: number;
  disputedCount: number;
  pendingTransferCount: number;
  openAdvanceTotal: number;
  monthlyReadyCount: number;
};

export async function receivableOverview(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<ReceivableOverview> {
  await authorize(ctx, "m5.receivable.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const date = ctxBusinessDate(ctx);
  const aging = await computeAging(tx, ctx.tenantId, date);
  const [counts] = await tx
    .select({
      open: sql<number>`count(*) filter (where ${invoices.outstandingAmount} > 0)::int`,
      disputed: sql<number>`count(*) filter (where ${invoices.disputeStatus} = 'disputed')::int`,
      pending: sql<number>`count(*) filter (where ${invoices.pendingTransferId} is not null and ${invoices.outstandingAmount} > 0)::int`,
      monthlyReady: sql<number>`count(*) filter (where ${invoices.kind} = 'monthly' and ${invoices.sentAt} is null)::int`,
    })
    .from(invoices)
    .where(eq(invoices.tenantId, ctx.tenantId));
  const [hold] = await tx.select({ n: sql<number>`count(*)::int` }).from(customers).where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.creditStatus, "on_hold")));
  const [adv] = await tx
    .select({ total: sql<string>`coalesce(sum(${customerAdvances.remainingAmount}), 0)` })
    .from(customerAdvances)
    .where(and(eq(customerAdvances.tenantId, ctx.tenantId), eq(customerAdvances.status, "open")));
  return {
    date,
    totals: aging.totals,
    openInvoiceCount: Number(counts?.open ?? 0),
    onHoldCount: Number(hold?.n ?? 0),
    disputedCount: Number(counts?.disputed ?? 0),
    pendingTransferCount: Number(counts?.pending ?? 0),
    openAdvanceTotal: Number(adv?.total ?? 0),
    monthlyReadyCount: Number(counts?.monthlyReady ?? 0),
  };
}

/** Daftar tindakan harian Admin Keuangan (US-M5-04 KP-3): perlu diingatkan (H-3/H+1) + akan/sudah Ditahan. */
export async function dailyActionList(ctx: ActorContext, opts: { tx?: Tx; date?: BusinessDate } = {}) {
  await authorize(ctx, "m5.receivable.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const date = opts.date ?? ctxBusinessDate(ctx);
  const reminders = await listReminders(ctx, { date }, { tx });
  const board = await creditStatusBoard(ctx, { tx, date });
  return {
    date,
    daysBeforeDue: reminders.daysBeforeDue,
    daysAfterDue: reminders.daysAfterDue,
    remind: reminders.groups.filter((g) => g.status !== "skipped"),
    willHold: board.willHold,
    onHold: board.onHold,
    transition: board.transition,
    toleranceDays: board.toleranceDays,
  };
}

/** Ringkasan umur piutang mingguan ke pemilik (PAR-40, Senin pagi). */
export async function sendWeeklyAgingSummary(tx: Tx, ctx: ActorContext, tenantId: string, date: BusinessDate): Promise<{ total: number; overduePct: number }> {
  const aging = await computeAging(tx, tenantId, date);
  const rules = await receivableRules(tx, date, tenantId);
  const top = aging.customers.filter((c) => c.overdue > 0).slice(0, 5);
  const t = aging.totals;
  const onTarget = t.overduePct < rules.kpi04_target_percent;
  await notify(tx, {
    event: "receivable.weekly_aging",
    tenantId,
    title: `Umur piutang ${formatTanggal(date, { weekday: false })}: lewat tempo ${t.overduePct.toLocaleString("id-ID")}%`,
    body: [
      `Total piutang ${formatRupiah(t.total)} (belum jatuh tempo ${formatRupiah(t.not_due)}, ${aging.bucketLabels.d1_7} ${formatRupiah(t.d1_7)}, ${aging.bucketLabels.d8_30} ${formatRupiah(t.d8_30)}, ${aging.bucketLabels.over_30} ${formatRupiah(t.over_30)}, belum ditagih ${formatRupiah(t.unbilled)}).`,
      top.length ? `Lewat tempo terbesar: ${top.map((c) => `${c.name} ${formatRupiah(c.overdue)}`).join("; ")}.` : "Tidak ada piutang lewat tempo.",
      `Sasaran KPI-04: lewat tempo di bawah ${rules.kpi04_target_percent.toLocaleString("id-ID")}% — ${onTarget ? "tercapai" : "belum tercapai, prioritaskan penagihan"}.`,
    ].join(" "),
    valueAmount: t.overdue,
    valueText: `${t.overduePct}%`,
    link: "/piutang/umur",
    groupKey: `receivable.weekly_aging:${tenantId}:${date}`,
    now: ctx.now,
  });
  return { total: t.total, overduePct: t.overduePct };
}

/** Tenant yang memiliki piutang (untuk job). */
export async function tenantsWithReceivables(tx: Tx): Promise<string[]> {
  const rows = await tx.selectDistinct({ id: customers.tenantId }).from(customers).where(isNotNull(customers.tenantId)).orderBy(asc(customers.tenantId));
  return rows.map((r) => r.id);
}
