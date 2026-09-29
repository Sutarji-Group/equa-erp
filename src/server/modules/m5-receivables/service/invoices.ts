/**
 * M5 — faktur: daftar & rincian, dokumen PDF (identitas usaha, tanpa PPN & tanpa faktur pajak — BR-29), pengiriman
 * WA/e-mail tercatat (US-M5-01 KP-5), sengketa (7.5.6), nota kredit beralasan (BR-38; > PAR-21 persetujuan pemilik),
 * konversi kurang bayar → tempo setelah persetujuan tempo lapangan (PTB-19, US-M3-04 KP-4), penghapusan piutang
 * (PTB-28, dipanggil M11). Faktur tidak dapat dihapus (US-M5-01 KP-6).
 */
import "server-only";

import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  approvalRequests,
  creditNotes,
  customerAddresses,
  customerAdvances,
  customerPayments,
  customers,
  domainEvents,
  invoiceLines,
  invoices,
  paymentAllocations,
  receivableReminders,
  trips,
  waMessageLogs,
} from "@/db/schema";
import { label, type InvoiceKind, type InvoiceStatus } from "@/lib/labels";
import { formatRupiah, zRupiahPositive } from "@/lib/money";
import { addDays, formatTanggal, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, ValidationError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, authorizeAny, runService } from "@/server/core/rbac";
import { buildWaLink, recordWaOpened, renderTemplate } from "@/server/core/wa";

import { agingBucket, customerCardLink, invoiceLink, lineOfInvoice, loadCustomer, loadInvoice, receivableRules, type InvoiceRow } from "./common";
import { changeCreditStatus, afterReceivablesChanged } from "./credit-hold";
import { computeExposure } from "./balance";
import { applyWriteOff, issueCreditNote, issueInvoice, recomputeInvoice } from "./ledger";
import { customerBankAccount } from "./payments";
import { activeTemplate, companyName } from "./templates";

// =====================================================================================================================
// Daftar & rincian
// =====================================================================================================================

export type InvoiceListFilter = {
  q?: string | null;
  status?: InvoiceStatus | "unpaid" | null;
  kind?: InvoiceKind | null;
  customerId?: string | null;
  overdue?: boolean;
  disputed?: boolean;
  pendingTransfer?: boolean;
  from?: BusinessDate | null;
  to?: BusinessDate | null;
  limit?: number;
};

export type InvoiceListRow = InvoiceRow & { customerName: string; customerCode: string | null; daysPastDue: number; bucket: ReturnType<typeof agingBucket> };

export async function listInvoices(ctx: ActorContext, filter: InvoiceListFilter = {}, opts: { tx?: Tx } = {}): Promise<InvoiceListRow[]> {
  await authorize(ctx, "m5.invoice.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const rules = await receivableRules(tx, today, ctx.tenantId);
  const conds: SQL[] = [eq(invoices.tenantId, ctx.tenantId)];
  if (filter.status === "unpaid") conds.push(gt(invoices.outstandingAmount, 0));
  else if (filter.status) conds.push(eq(invoices.status, filter.status));
  if (filter.kind) conds.push(eq(invoices.kind, filter.kind));
  if (filter.customerId) conds.push(eq(invoices.customerId, filter.customerId));
  if (filter.overdue) conds.push(and(gt(invoices.outstandingAmount, 0), lt(invoices.dueDate, today))!);
  if (filter.disputed) conds.push(eq(invoices.disputeStatus, "disputed"));
  if (filter.pendingTransfer) conds.push(sql`${invoices.pendingTransferId} is not null`);
  if (filter.from) conds.push(sql`${invoices.issueDate} >= ${filter.from}`);
  if (filter.to) conds.push(sql`${invoices.issueDate} <= ${filter.to}`);
  if (filter.q && filter.q.trim().length >= 2) {
    const q = `%${filter.q.trim()}%`;
    conds.push(or(ilike(invoices.number, q), ilike(customers.name, q), ilike(customers.code, q))!);
  }
  const rows = await tx
    .select({ inv: invoices, customerName: customers.name, customerCode: customers.code })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(...conds))
    .orderBy(desc(invoices.issueDate), desc(invoices.number))
    .limit(filter.limit ?? 300);
  return rows.map((r) => ({
    ...r.inv,
    customerName: r.customerName,
    customerCode: r.customerCode,
    daysPastDue: Math.max(0, Math.round((Date.parse(today) - Date.parse(r.inv.dueDate)) / 86_400_000)),
    bucket: agingBucket(r.inv.dueDate, today, rules),
  }));
}

export async function getInvoiceDetail(ctx: ActorContext, invoiceId: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.invoice.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const inv = await loadInvoice(tx, invoiceId, { ctx });
  const customer = await loadCustomer(tx, inv.customerId);
  const address = inv.addressId ? (await tx.select().from(customerAddresses).where(eq(customerAddresses.id, inv.addressId)).limit(1))[0] ?? null : null;
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(asc(invoiceLines.lineNo));
  const allocs = await tx
    .select({ a: paymentAllocations, channel: customerPayments.channel, method: customerPayments.method, paymentDate: customerPayments.businessDate })
    .from(paymentAllocations)
    .leftJoin(customerPayments, eq(customerPayments.id, paymentAllocations.customerPaymentId))
    .where(eq(paymentAllocations.invoiceId, inv.id))
    .orderBy(asc(paymentAllocations.allocatedAt), asc(paymentAllocations.createdAt));
  const notes = await tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, inv.id)).orderBy(asc(creditNotes.createdAt));
  const reminders = await tx.select().from(receivableReminders).where(eq(receivableReminders.invoiceId, inv.id)).orderBy(asc(receivableReminders.scheduledDate));
  const sends = await tx
    .select()
    .from(waMessageLogs)
    .where(and(eq(waMessageLogs.objectType, "invoice"), eq(waMessageLogs.objectId, inv.id)))
    .orderBy(desc(waMessageLogs.createdAt));
  const pending = await tx
    .select()
    .from(approvalRequests)
    .where(and(inArray(approvalRequests.objectType, ["invoice"]), eq(approvalRequests.objectId, inv.id)))
    .orderBy(desc(approvalRequests.createdAt));
  const trip = inv.tripId ? (await tx.select({ number: trips.number, orderId: trips.orderId }).from(trips).where(eq(trips.id, inv.tripId)).limit(1))[0] ?? null : null;
  const today = ctxBusinessDate(ctx);
  const rules = await receivableRules(tx, today, inv.tenantId);
  const fieldCredit =
    inv.kind === "underpayment" && inv.tripId
      ? (
          await tx
            .select({ id: approvalRequests.id, number: approvalRequests.number, status: approvalRequests.status })
            .from(approvalRequests)
            .where(and(eq(approvalRequests.type, "field_payment_to_credit"), eq(approvalRequests.objectType, "trip"), eq(approvalRequests.objectId, inv.tripId)))
            .orderBy(desc(approvalRequests.createdAt))
            .limit(1)
        )[0] ?? null
      : null;
  return {
    invoice: inv,
    customer,
    address,
    trip,
    lines,
    allocations: allocs.map((r) => ({ ...r.a, channel: r.channel, method: r.method, paymentDate: r.paymentDate })),
    creditNotes: notes,
    reminders,
    sends,
    approvals: pending,
    fieldCredit,
    bucket: agingBucket(inv.dueDate, today, rules),
    line: lineOfInvoice(inv),
  };
}

// =====================================================================================================================
// Dokumen faktur (PDF, BR-29) & pengiriman (KP-5)
// =====================================================================================================================

export type InvoiceDocument = Awaited<ReturnType<typeof invoiceDocument>>;

/** Data dokumen faktur untuk PDF: identitas usaha (`company.identity`), rincian, total, rekening, catatan tanpa PPN. */
export async function invoiceDocument(ctx: ActorContext, invoiceId: string, opts: { tx?: Tx } = {}) {
  const d = await getInvoiceDetail(ctx, invoiceId, opts);
  const tx = opts.tx ?? getDb();
  const identity = await params.get(tx, "company.identity", ctxBusinessDate(ctx), { tenantId: d.invoice.tenantId });
  const bank = await customerBankAccount(tx, d.invoice.tenantId);
  const payments = d.allocations.filter((a) => a.customerPaymentId || a.customerAdvanceId).reduce((s, a) => s + a.amount, 0);
  const advances = await tx
    .select({ total: sql<string>`coalesce(sum(${customerAdvances.remainingAmount}), 0)` })
    .from(customerAdvances)
    .where(and(eq(customerAdvances.customerId, d.customer.id), eq(customerAdvances.status, "open")));
  const [other] = await tx
    .select({ total: sql<string>`coalesce(sum(${invoices.outstandingAmount}), 0)` })
    .from(invoices)
    .where(and(eq(invoices.customerId, d.customer.id), gt(invoices.outstandingAmount, 0), sql`${invoices.id} <> ${d.invoice.id}`));
  return {
    ...d,
    identity,
    bank,
    paymentsReceived: payments,
    openAdvance: Number(advances[0]?.total ?? 0),
    otherOutstanding: Number(other?.total ?? 0),
    notes: [
      "Harga tanpa PPN; dokumen ini bukan faktur pajak (BR-29).",
      bank ? `Pembayaran transfer ke ${bank.text} a.n. ${bank.accountName}; cantumkan nomor faktur pada berita transfer.` : "Pembayaran tunai ke kantor atau transfer ke rekening resmi usaha.",
    ],
  };
}

const sendSchema = z.object({
  invoiceId: z.string().uuid(),
  via: z.enum(["wa", "email"], { error: "Pilih kirim lewat WA atau e-mail." }),
  /** B-36: alamat penerima draf e-mail (`mailto:`), opsional. */
  email: z.email({ error: "Alamat e-mail tidak valid." }).nullable().optional(),
});

/** Teks faktur dari template (WA / e-mail) + subjek e-mail. Dipakai `sendInvoice` & `emailInvoice` (B-36). */
export async function invoiceMessage(tx: Tx, ctx: ActorContext, inv: InvoiceRow, opts: { pdfUrl?: string } = {}) {
  const customer = await loadCustomer(tx, inv.customerId);
  const bank = await customerBankAccount(tx, inv.tenantId);
  const kind = inv.kind === "monthly" ? ("monthly_invoice" as const) : ("invoice" as const);
  const tpl = await activeTemplate(tx, inv.tenantId, kind);
  const company = await companyName(tx, inv.tenantId, ctxBusinessDate(ctx));
  const { text } = renderTemplate(tpl.body, {
    nama_pelanggan: customer.name,
    nomor_faktur: inv.number,
    jumlah: formatRupiah(inv.outstandingAmount > 0 ? inv.outstandingAmount : inv.amount),
    total_faktur: formatRupiah(inv.amount),
    tanggal_faktur: formatTanggal(inv.issueDate, { weekday: false }),
    jatuh_tempo: formatTanggal(inv.dueDate, { weekday: false }),
    periode: inv.periodMonth ? formatTanggal(inv.periodMonth, { weekday: false }).replace(/^\d+ /, "") : "",
    rekening: bank?.text ?? "",
    nama_rekening: bank?.accountName ?? "",
    tautan_pdf: opts.pdfUrl ?? "",
    nama_usaha: company,
  });
  const subject = `${inv.kind === "monthly" ? "Faktur bulanan" : "Faktur"} ${inv.number} — ${company}`;
  return { customer, kind, tpl, text, subject };
}

/** Kirim faktur lewat tautan WA (template) atau e-mail — pengiriman tercatat (US-M5-01 KP-5, US-M5-06 KP-4). */
export async function sendInvoice(ctx: ActorContext, input: unknown, opts: { tx?: Tx; pdfUrl?: string } = {}): Promise<{ link: string | null; text: string }> {
  await authorize(ctx, "m5.invoice.send", { tx: opts.tx });
  const data = parseInput(sendSchema, input, { email: "Alamat e-mail" });
  return runService(ctx, opts, async (tx) => {
    const inv = await loadInvoice(tx, data.invoiceId, { ctx, forUpdate: true });
    const { customer, kind, tpl, text, subject } = await invoiceMessage(tx, ctx, inv, { pdfUrl: opts.pdfUrl });
    let link: string | null = null;
    if (data.via === "wa") {
      link = buildWaLink(customer.waPhone, text);
      await recordWaOpened(tx, ctx, { kind, toPhone: customer.waPhone, renderedText: text, templateId: tpl.id, customerId: customer.id, objectType: "invoice", objectId: inv.id });
    } else {
      // E-mail tanpa pengirim server (RESEND_API_KEY kosong, D-10 butir 2): draf e-mail terisi (PDF dilampirkan Admin
      // Keuangan dari tombol unduh) — dicatat "dibuka" (`email_link`), bukan "terkirim".
      link = `mailto:${data.email ? encodeURIComponent(data.email) : ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    }
    const sentVia = data.via === "email" ? "email_link" : data.via;
    await tx.update(invoices).set({ sentAt: ctx.now, sentVia, updatedAt: ctx.now }).where(eq(invoices.id, inv.id));
    await auditRecord(tx, { ctx, objectType: "invoice", objectId: inv.id, action: "send", after: { via: sentVia, sentAt: ctx.now, to: data.email ?? null }, rule: "US-M5-01 KP-5, D-10 butir 2" });
    return { link, text };
  });
}

// =====================================================================================================================
// Sengketa (7.5.6; PAR-45)
// =====================================================================================================================

const disputeSchema = z.object({ invoiceId: z.string().uuid(), note: z.string().trim().min(5, { error: "Catatan sengketa wajib diisi (minimal 5 karakter)." }) });

/** Admin Keuangan menandai faktur bersengketa: pengingat & penahanan ditunda ≤ PAR-45 hari sampai diputuskan pemilik. */
export async function disputeInvoice(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<InvoiceRow> {
  await authorize(ctx, "m5.invoice.dispute", { tx: opts.tx });
  const data = parseInput(disputeSchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const inv = await loadInvoice(tx, data.invoiceId, { ctx, forUpdate: true });
    if (inv.status === "paid") throw new DomainError("INVOICE_LOCKED", `Faktur ${inv.number} sudah Lunas dan terkunci.`);
    if (inv.disputeStatus === "disputed") throw new ConflictError("ALREADY_DISPUTED", `Faktur ${inv.number} sudah bersengketa; tunggu keputusan pemilik.`);
    const today = ctxBusinessDate(ctx);
    const par45 = await params.get(tx, "PAR-45", today);
    const until = addDays(today, par45.max_days);
    const [after] = await tx
      .update(invoices)
      .set({ disputeStatus: "disputed", disputedAt: ctx.now, disputeNote: data.note, disputeUntil: until, disputeDecidedAt: null, disputeDecidedBy: null, updatedAt: ctx.now })
      .where(eq(invoices.id, inv.id))
      .returning();
    await tx
      .update(receivableReminders)
      .set({ status: "skipped", skipReason: "Faktur bersengketa (7.5.6)", updatedAt: ctx.now })
      .where(and(eq(receivableReminders.invoiceId, inv.id), eq(receivableReminders.status, "scheduled")));
    await auditRecord(tx, { ctx, objectType: "invoice", objectId: inv.id, action: "dispute", before: { disputeStatus: inv.disputeStatus }, after: { disputeStatus: "disputed", disputeUntil: until }, reason: data.note, rule: "7.5.6, PAR-45" });
    const customer = await loadCustomer(tx, inv.customerId);
    await notify(tx, {
      event: "receivable.dispute_opened",
      tenantId: inv.tenantId,
      title: `Faktur ${inv.number} disengketakan: ${customer.name}`,
      body: `${data.note} — sisa ${formatRupiah(inv.outstandingAmount)}. Pengingat & penahanan ditunda sampai ${formatTanggal(until, { weekday: false })}. Putuskan: nota kredit atau sengketa ditolak.`,
      objectType: "invoice",
      objectId: inv.id,
      valueAmount: inv.outstandingAmount,
      deadlineAt: new Date(`${until}T23:59:00+07:00`),
      link: invoiceLink(inv.id),
      now: ctx.now,
    });
    return after!;
  });
}

const decideSchema = z.discriminatedUnion("decision", [
  z.object({ invoiceId: z.string().uuid(), decision: z.literal("credit_note"), amount: zRupiahPositive, reason: z.string().trim().min(5, { error: "Alasan keputusan wajib diisi (minimal 5 karakter)." }) }),
  z.object({ invoiceId: z.string().uuid(), decision: z.literal("reject"), reason: z.string().trim().min(5, { error: "Alasan keputusan wajib diisi (minimal 5 karakter)." }) }),
]);

/** Pemilik memutuskan sengketa: koreksi lewat nota kredit, atau sengketa ditolak (7.5.6). */
export async function decideDispute(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.dispute.decide", { tx: opts.tx });
  const data = parseInput(decideSchema, input, { amount: "Nilai nota kredit", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const inv = await loadInvoice(tx, data.invoiceId, { ctx, forUpdate: true });
    if (inv.disputeStatus !== "disputed") throw new DomainError("NOT_DISPUTED", `Faktur ${inv.number} tidak sedang bersengketa.`);
    let creditNoteId: string | null = null;
    if (data.decision === "credit_note") {
      const res = await issueCreditNote(tx, ctx, { invoiceId: inv.id, amount: data.amount, reason: `Keputusan sengketa: ${data.reason}`, purpose: "dispute" });
      creditNoteId = res.creditNote?.id ?? null;
    }
    const status = data.decision === "credit_note" ? "resolved" : "rejected";
    const [after] = await tx
      .update(invoices)
      .set({ disputeStatus: status, disputeDecidedAt: ctx.now, disputeDecidedBy: ctx.userId, updatedAt: ctx.now })
      .where(eq(invoices.id, inv.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "invoice",
      objectId: inv.id,
      action: "dispute_decide",
      before: { disputeStatus: "disputed" },
      after: { disputeStatus: status, creditNoteId },
      reason: data.reason,
      rule: "7.5.6",
    });
    await notify(tx, {
      event: "receivable.dispute_decided",
      tenantId: inv.tenantId,
      title: `Sengketa ${inv.number}: ${label("dispute_decision", data.decision)}`,
      body: data.reason,
      objectType: "invoice",
      objectId: inv.id,
      link: invoiceLink(inv.id),
      now: ctx.now,
    });
    await afterReceivablesChanged(tx, ctx, [inv.customerId]);
    return { invoice: after!, creditNoteId };
  });
}

// =====================================================================================================================
// Nota kredit (KP-6; BR-38; > PAR-21 persetujuan pemilik)
// =====================================================================================================================

const creditNoteSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: zRupiahPositive,
  reason: z.string().trim().min(5, { error: "Alasan koreksi wajib diisi (minimal 5 karakter)." }),
});

export type CreditNoteRequestResult = { status: "issued"; creditNoteId: string } | { status: "pending_approval"; approvalId: string; approvalNumber: string };

/** Admin Keuangan menerbitkan nota kredit beralasan; > PAR-21 → persetujuan pemilik (`correction`, objek `invoice`). */
export async function requestCreditNote(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<CreditNoteRequestResult> {
  await authorize(ctx, "m5.credit_note.create", { tx: opts.tx });
  const data = parseInput(creditNoteSchema, input, { amount: "Nilai nota kredit", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await recomputeInvoice(tx, ctx, data.invoiceId);
    const inv = await loadInvoice(tx, data.invoiceId, { ctx, forUpdate: true });
    if (inv.status === "paid") throw new DomainError("INVOICE_LOCKED", `Faktur ${inv.number} sudah Lunas dan terkunci. Balik pelunasannya dulu (BR-38).`);
    if (inv.isOpeningBalance) {
      throw new DomainError("OPENING_CORRECTION", `Faktur ${inv.number} adalah saldo awal — koreksi lewat menu Saldo awal piutang (pembatalan sebelum ditandatangani, atau penyesuaian berjejak setelahnya).`);
    }
    if (inv.disputeStatus === "disputed") {
      throw new DomainError("INVOICE_DISPUTED", `Faktur ${inv.number} sedang bersengketa — koreksi lewat keputusan sengketa oleh pemilik (7.5.6).`);
    }
    if (data.amount > inv.outstandingAmount) {
      throw ValidationError.field("amount", `Nota kredit ${formatRupiah(data.amount)} melebihi sisa faktur ${formatRupiah(inv.outstandingAmount)}.`);
    }
    const par21 = await params.get(tx, "PAR-21", ctxBusinessDate(ctx));
    // BR-38 / 6.2a: ambang PAR-21 tidak dapat dipecah — nota kredit koreksi TANPA persetujuan yang sudah terbit pada
    // faktur ini (dan pada pelanggan ini hari ini) serta permintaan koreksi yang masih menunggu ikut dijumlahkan.
    const prior = await unapprovedCorrectionTotal(tx, { tenantId: inv.tenantId, invoiceId: inv.id, customerId: inv.customerId, date: ctxBusinessDate(ctx) });
    if (data.amount + prior > par21.amount_gt) {
      const req = await approvals.submit(
        ctx,
        { type: "correction", objectType: "invoice", objectId: inv.id, amount: data.amount, reason: data.reason, payload: { action: "credit_note", amount: data.amount, invoiceNumber: inv.number, link: invoiceLink(inv.id) } },
        { tx },
      );
      return { status: "pending_approval", approvalId: req.id, approvalNumber: req.number };
    }
    const res = await issueCreditNote(tx, ctx, { invoiceId: inv.id, amount: data.amount, reason: data.reason, purpose: "correction" });
    await afterReceivablesChanged(tx, ctx, [inv.customerId]);
    return { status: "issued", creditNoteId: res.creditNote!.id };
  });
}

/**
 * Σ nota kredit koreksi yang terbit TANPA persetujuan pemilik — pada faktur ini (kapan pun) atau pada pelanggan yang sama
 * hari ini — ditambah permintaan nota kredit koreksi atas faktur ini yang masih menunggu keputusan (BR-38, PAR-21).
 */
async function unapprovedCorrectionTotal(tx: Tx, q: { tenantId: string; invoiceId: string; customerId: string; date: BusinessDate }): Promise<number> {
  const [issued] = await tx
    .select({ v: sql<string>`coalesce(sum((${domainEvents.payload}->>'amount')::bigint), 0)` })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.tenantId, q.tenantId),
        eq(domainEvents.type, "credit_note.issued"),
        sql`${domainEvents.payload}->>'purpose' = 'correction'`,
        sql`${domainEvents.payload}->>'approvalId' is null`,
        or(sql`${domainEvents.payload}->>'invoiceId' = ${q.invoiceId}`, and(sql`${domainEvents.payload}->>'customerId' = ${q.customerId}`, eq(domainEvents.businessDate, q.date))),
      ),
    );
  const pending = (await approvals.listForObject(tx, "invoice", q.invoiceId)).filter(
    (a) => a.type === "correction" && a.status === "submitted" && (a.payload as { action?: string } | null)?.action === "credit_note",
  );
  return Number(issued?.v ?? 0) + pending.reduce((s, a) => s + (a.amount ?? 0), 0);
}

/** Penerapan nota kredit yang disetujui pemilik (handler `correction` objek `invoice`). */
export async function applyApprovedCreditNote(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow): Promise<Record<string, unknown>> {
  const payload = (request.payload ?? {}) as { amount?: number };
  const inv = await loadInvoice(tx, request.objectId, { forUpdate: true });
  const amount = Math.min(payload.amount ?? request.amount ?? 0, inv.outstandingAmount);
  if (amount <= 0) return { applied: false, note: "Faktur sudah lunas; nota kredit tidak diterbitkan." };
  const res = await issueCreditNote(tx, ctx, { invoiceId: inv.id, amount, reason: request.reason, purpose: "correction", approvalId: request.id });
  await afterReceivablesChanged(tx, ctx, [inv.customerId]);
  return { applied: true, creditNoteId: res.creditNote?.id ?? null, number: res.creditNote?.number ?? null };
}

// =====================================================================================================================
// Konversi kurang bayar → tempo (PTB-19; B-16 `field_credit.decided`)
// =====================================================================================================================

const convertSchema = z.object({ invoiceId: z.string().uuid(), reason: z.string().trim().min(5, { error: "Alasan konversi wajib diisi (minimal 5 karakter)." }) });

/**
 * Kurang bayar yang tempo-nya DISETUJUI Dispatcher setelah rit dicatat (US-M3-04 KP-4): faktur kurang bayar ditutup
 * nota kredit reklasifikasi dan faktur kirim tempo terbit (jatuh tempo = tanggal kirim + tempo pelanggan), setelah
 * pemeriksaan status & batas kredit.
 */
export async function convertUnderpaymentToCredit(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.credit_note.create", { tx: opts.tx });
  const data = parseInput(convertSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await recomputeInvoice(tx, ctx, data.invoiceId);
    const inv = await loadInvoice(tx, data.invoiceId, { ctx, forUpdate: true });
    if (inv.kind !== "underpayment" || !inv.tripId) throw new DomainError("NOT_UNDERPAYMENT", "Hanya faktur kurang bayar rit yang dapat dikonversi menjadi tempo.");
    if (inv.outstandingAmount <= 0) throw new DomainError("INVOICE_LOCKED", `Faktur ${inv.number} sudah Lunas dan terkunci.`);
    const [approved] = await tx
      .select({ id: approvalRequests.id, number: approvalRequests.number })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.type, "field_payment_to_credit"), eq(approvalRequests.objectType, "trip"), eq(approvalRequests.objectId, inv.tripId), eq(approvalRequests.status, "approved")))
      .limit(1);
    if (!approved) throw new DomainError("NO_FIELD_CREDIT_APPROVAL", "Konversi ke tempo hanya untuk rit yang permintaan tempo lapangannya disetujui Dispatcher (PTB-19).");
    const customer = await loadCustomer(tx, inv.customerId);
    if (!["credit", "credit_migrated"].includes(customer.creditStatus)) {
      throw new DomainError("CREDIT_NOT_AVAILABLE", `Status kredit pelanggan ${label("credit_status", customer.creditStatus)} — kurang bayar tetap ditagih H+0.`);
    }
    const exposure = await computeExposure(tx, customer.id);
    if (exposure.exceedsLimit) {
      throw new DomainError("OVER_LIMIT", `Eksposur ${formatRupiah(exposure.exposure)} melampaui batas ${formatRupiah(exposure.creditLimit)} — kurang bayar tetap ditagih H+0.`);
    }
    const [dup] = await tx.select({ number: invoices.number }).from(invoices).where(and(eq(invoices.tripId, inv.tripId), eq(invoices.kind, "delivery"))).limit(1);
    if (dup) throw new ConflictError("TRIP_ALREADY_INVOICED", `Rit ini sudah memiliki faktur kirim ${dup.number}.`);
    const amount = inv.outstandingAmount;
    await issueCreditNote(tx, ctx, { invoiceId: inv.id, amount, reason: `Konversi kurang bayar → tempo (persetujuan ${approved.number}): ${data.reason}`, purpose: "underpayment_conversion", approvalId: approved.id });
    const [trip] = await tx.select().from(trips).where(eq(trips.id, inv.tripId)).limit(1);
    const newInv = await issueInvoice(tx, ctx, {
      tenantId: inv.tenantId,
      customerId: customer.id,
      kind: "delivery",
      addressId: inv.addressId,
      tripId: inv.tripId,
      issueDate: inv.issueDate,
      dueDate: addDays(inv.issueDate, customer.paymentTermDays),
      description: `Faktur kirim rit ${trip?.number ?? ""} (konversi kurang bayar ${inv.number} → tempo)`,
      lines: [{ component: "trip", description: `Air truk rit ${trip?.number ?? ""} — tempo disetujui Dispatcher (${approved.number})`, tripId: inv.tripId, serviceDate: inv.issueDate, quantity: 1, unitPrice: amount, amount, volumeL: trip?.deliveredVolumeL ?? null }],
      rule: "PTB-19, US-M3-04 KP-4",
      reason: data.reason,
    });
    return { creditedInvoiceId: inv.id, invoice: newInv };
  });
}

// =====================================================================================================================
// Penghapusan piutang tak tertagih (PTB-28) — API untuk M11
// =====================================================================================================================

/**
 * Dipanggil M11 di DALAM transaksi jurnal manual yang disetujui pemilik (PTB-28): mengurangi sisa faktur tanpa nota
 * kredit, mencatat jurnal & persetujuan, dan menjaga pelanggan Tempo tetap/menjadi Ditahan.
 */
export async function writeOffInvoice(
  tx: Tx,
  input: { ctx: ActorContext; invoiceId: string; amount?: number | null; journalId?: string | null; approvalId?: string | null; reason: string },
): Promise<InvoiceRow> {
  // PTB-28: penghapusan piutang hanya lewat jurnal manual M11 DENGAN persetujuan pemilik (atau keputusan pemilik sendiri).
  if (!input.approvalId && !input.ctx.roles.includes("owner")) {
    throw new DomainError("WRITE_OFF_NEEDS_APPROVAL", "Penghapusan piutang wajib disetujui pemilik. Ajukan lewat jurnal manual Akuntansi (penghapusan piutang).");
  }
  const inv = await applyWriteOff(tx, input.ctx, input);
  const customer = await loadCustomer(tx, inv.customerId, { forUpdate: true });
  if (customer.creditStatus === "credit" || customer.creditStatus === "credit_migrated") {
    await changeCreditStatus(tx, input.ctx, customer, { to: "on_hold", reason: `Piutang ${inv.number} dihapusbukukan (PTB-28): ${input.reason}`, rule: "PTB-28", automatic: true, approvalId: input.approvalId ?? null });
  }
  return inv;
}

/** Lookup cepat pelanggan untuk pilihan formulir (layar piutang, pelunasan, status kredit, saldo awal). */
export async function customerOptions(ctx: ActorContext, opts: { tx?: Tx; withOpenOnly?: boolean } = {}) {
  await authorizeAny(ctx, ["m5.invoice.read", "m5.customer_payment.read", "m5.credit_exposure.read", "m5.opening_balance.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({
      id: customers.id,
      code: customers.code,
      name: customers.name,
      creditStatus: customers.creditStatus,
      segment: customers.segment,
      monthlyBilling: customers.monthlyBilling,
      isActive: customers.isActive,
    })
    .from(customers)
    .where(and(eq(customers.tenantId, ctx.tenantId), sql`${customers.internalOutletId} is null`))
    .orderBy(asc(customers.name));
  if (!opts.withOpenOnly) return rows;
  const open = await tx.selectDistinct({ id: invoices.customerId }).from(invoices).where(and(eq(invoices.tenantId, ctx.tenantId), gt(invoices.outstandingAmount, 0)));
  const ids = new Set(open.map((o) => o.id));
  return rows.filter((r) => ids.has(r.id));
}

export { customerCardLink };
