/**
 * M11 — jurnal manual (US-M11-03, BR-35, BR-38, PTB-12, P-07 langkah 2–3):
 * - Draf → Diajukan → Disetujui → Terposting. Lampiran bukti WAJIB saat diajukan/diposting.
 * - Jumlah > PAR-20 → persetujuan pemilik (`manual_journal`) sebelum posting; ≤ PAR-20 → terposting oleh Admin
 *   Keuangan dan masuk daftar tinjauan wajib pemilik (periode tidak dapat ditutup sebelum ditandai "ditinjau").
 * - Terposting tidak dapat diubah; koreksi = jurnal pembalik beralasan; > PAR-21 persetujuan pemilik (`correction`).
 *   Jurnal otomatis TIDAK dapat dibalik manual — koreksi lewat modul sumbernya (P-07 langkah 1).
 * - Jurnal berulang bulanan (sewa, listrik, gaji, …) dibuat sebagai DRAF; jurnal "akrual" dibalik otomatis tanggal 1
 *   periode berikutnya (P-07 langkah 3). Gaji = total rekap penggajian; potongan ganti rugi → pelunasan piutang
 *   karyawan (PTB-22) lewat M4.
 * - Penanda utang (US-M11-07), pembayaran utang manual, penghapusan piutang (PTB-28 → `m5.writeOffInvoice`).
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";

import { accountingPeriods, accounts, journalPayableSettlements, journalPayables, journals, manualJournalDetails, recurringJournals, type TemplateJournalLine } from "@/db/schema";
import { enumValues, label, type JournalKind } from "@/lib/labels";
import { formatRupiah, zRupiahNonNegative, zRupiahPositive } from "@/lib/money";
import { addDays, firstDayOfMonth, isBusinessDate, lastDayOfMonth, monthOf, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, can, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";
import * as m5 from "@/server/modules/m5-receivables";

import { MANUAL_TEMPLATES } from "../constants";
import {
  accountsByCode,
  assertBalancedLines,
  assertPostableAccounts,
  existingReversal,
  insertJournal,
  loadJournal,
  loadLines,
  postingPeriodFor,
  shiftPeriod,
  swappedLines,
  type JournalRow,
} from "./common";

const MANUAL_KINDS: JournalKind[] = ["manual", "accrual", "opening_adjustment"];

const dateSchema = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." });

export const journalLineSchema = z
  .object({
    accountId: z.uuid({ error: "Pilih akun." }),
    profitCenter: z.enum(enumValues("profit_center"), { error: "Pilih pusat laba." }),
    outletId: z.uuid().nullable().optional(),
    debit: zRupiahNonNegative.default(0),
    credit: zRupiahNonNegative.default(0),
    memo: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const manualJournalSchema = z
  .object({
    date: dateSchema,
    description: z.string().trim().min(5, { error: "Keterangan minimal 5 karakter." }).max(300),
    lines: z.array(journalLineSchema).min(2, { error: "Jurnal minimal dua baris (debit & kredit)." }).max(50),
    attachmentId: z.uuid().nullable().optional(),
    template: z.enum(enumValues("recurring_journal_template")).nullable().optional(),
    isAccrual: z.boolean().default(false),
    /** Koreksi transaksi periode Dikunci: rujukan periode asal (US-M11-10 KP-3). */
    originPeriod: z
      .string()
      .regex(/^\d{4}-\d{2}$/, { error: "Periode asal berformat YYYY-MM." })
      .nullable()
      .optional(),
    payable: z
      .object({ supplierId: z.uuid().nullable().optional(), payeeName: z.string().trim().min(2, { error: "Nama pihak yang diutangi wajib diisi." }), dueDate: dateSchema })
      .strict()
      .nullable()
      .optional(),
    settlesPayableId: z.uuid().nullable().optional(),
    writeOff: z.object({ invoiceId: z.uuid(), amount: zRupiahPositive }).strict().nullable().optional(),
  })
  .strict();

export type ManualJournalInput = z.input<typeof manualJournalSchema>;

type Details = typeof manualJournalDetails.$inferSelect;

async function loadDetails(tx: Tx, journalId: string): Promise<Details | null> {
  const [d] = await tx.select().from(manualJournalDetails).where(eq(manualJournalDetails.journalId, journalId)).limit(1);
  return d ?? null;
}

/** Tenggat keputusan jurnal manual = batas tutup buku periode (PAR-23 tanggal bulan berikutnya, 23.59 WIB). */
async function closeDeadline(tx: Tx, date: BusinessDate): Promise<Date> {
  const { day_of_next_month } = await params.get(tx, "PAR-23", date);
  const next = shiftPeriod(monthOf(date), 1);
  return wibToUtc(`${next}-${String(day_of_next_month).padStart(2, "0")}`, "23:59");
}

async function validateJournalPayload(tx: Tx, ctx: ActorContext, data: z.output<typeof manualJournalSchema>) {
  const lines = data.lines.map((l) => ({ ...l, debit: l.debit ?? 0, credit: l.credit ?? 0 }));
  const totals = assertBalancedLines(lines);
  const accs = await assertPostableAccounts(
    tx,
    ctx.tenantId,
    lines.map((l) => l.accountId),
  );
  let payableAmount = 0;
  if (data.payable) {
    payableAmount = lines.filter((l) => accs.get(l.accountId)?.type === "liability").reduce((s, l) => s + l.credit, 0);
    if (payableAmount <= 0) throw new DomainError("PAYABLE_ACCOUNT", "Jurnal bertanda utang harus mengkredit akun utang (liabilitas).");
  }
  if (data.settlesPayableId) {
    const [p] = await tx.select().from(journalPayables).where(and(eq(journalPayables.id, data.settlesPayableId), eq(journalPayables.tenantId, ctx.tenantId))).limit(1);
    if (!p) throw new NotFoundError("Utang yang dibayar tidak ditemukan.");
    if (p.status === "paid") throw new DomainError("PAYABLE_PAID", "Utang ini sudah lunas.");
    const paid = lines.filter((l) => accs.get(l.accountId)?.type === "liability").reduce((s, l) => s + l.debit, 0);
    if (paid <= 0) throw new DomainError("PAYABLE_ACCOUNT", "Jurnal pembayaran utang harus mendebit akun utang.");
    if (paid > p.amount - p.settledAmount) throw new DomainError("PAYABLE_OVERPAID", `Pembayaran melebihi sisa utang ${formatRupiah(p.amount - p.settledAmount)}.`);
  }
  if (data.writeOff && data.writeOff.amount > totals.debit) throw new DomainError("WRITE_OFF_AMOUNT", "Nilai penghapusan piutang melebihi nilai jurnal.");
  return { lines, totals, payableAmount };
}

/** Buat draf jurnal manual (Admin Keuangan). */
export async function createManualJournal(ctx: ActorContext, input: ManualJournalInput, opts: { tx?: Tx } = {}): Promise<JournalRow> {
  await authorize(ctx, "m11.journal.create", { tx: opts.tx });
  const data = parseInput(manualJournalSchema, input, { date: "Tanggal", description: "Keterangan", lines: "Baris jurnal", attachmentId: "Lampiran" });
  return runService(ctx, opts, async (tx) => {
    const { lines, payableAmount } = await validateJournalPayload(tx, ctx, data);
    const { journal } = await insertJournal(tx, {
      tenantId: ctx.tenantId,
      kind: data.isAccrual ? "accrual" : "manual",
      status: "draft",
      date: data.date,
      description: data.description,
      lines: lines.map((l) => ({ accountId: l.accountId, profitCenter: l.profitCenter, outletId: l.outletId ?? null, debit: l.debit, credit: l.credit, memo: l.memo ?? null })),
      ctx,
      attachmentId: data.attachmentId ?? null,
      templateKey: data.template ?? null,
      originPeriod: data.originPeriod ?? null,
      sourceType: "manual",
    });
    if (data.attachmentId) await linkAttachment(tx, data.attachmentId, { type: "journal", id: journal.id });
    await tx.insert(manualJournalDetails).values({
      tenantId: ctx.tenantId,
      journalId: journal.id,
      payable: data.payable ? { supplierId: data.payable.supplierId ?? null, payeeName: data.payable.payeeName, dueDate: data.payable.dueDate, amount: payableAmount } : null,
      settlesPayableId: data.settlesPayableId ?? null,
      writeOff: data.writeOff ?? null,
    });
    await auditRecord(tx, {
      ctx,
      objectType: "journal",
      objectId: journal.id,
      action: "create",
      after: { number: journal.number, kind: journal.kind, date: data.date, total: journal.totalDebit, lines: lines.length, template: data.template ?? null },
      reason: data.description,
      rule: "US-M11-03 KP-1",
    });
    return journal;
  });
}

const attachSchema = z.object({ journalId: z.uuid(), attachmentId: z.uuid({ error: "Unggah lampiran bukti." }) }).strict();

/** Tambah/ganti lampiran bukti pada draf (mis. draf jurnal berulang). */
export async function attachJournalEvidence(ctx: ActorContext, input: z.input<typeof attachSchema>, opts: { tx?: Tx } = {}): Promise<JournalRow> {
  await authorize(ctx, "m11.journal.create", { tx: opts.tx });
  const data = parseInput(attachSchema, input, { attachmentId: "Lampiran" });
  return runService(ctx, opts, async (tx) => {
    const j = await loadJournal(tx, ctx.tenantId, data.journalId, { forUpdate: true });
    if (j.status !== "draft" && j.status !== "rejected") throw new DomainError("JOURNAL_LOCKED", "Lampiran hanya dapat diganti pada draf.");
    await linkAttachment(tx, data.attachmentId, { type: "journal", id: j.id });
    const [row] = await tx.update(journals).set({ attachmentId: data.attachmentId, updatedAt: new Date() }).where(eq(journals.id, j.id)).returning();
    await auditRecord(tx, { ctx, objectType: "journal", objectId: j.id, action: "update", before: { attachmentId: j.attachmentId }, after: { attachmentId: data.attachmentId } });
    return row!;
  });
}

/** Efek sesudah posting: utang manual, pelunasan utang, penghapusan piutang (PTB-28). */
async function afterManualPosted(tx: Tx, ctx: ActorContext, journal: JournalRow, approvalId: string | null): Promise<void> {
  const d = await loadDetails(tx, journal.id);
  if (!d) return;
  if (d.payable) {
    await tx.insert(journalPayables).values({
      tenantId: journal.tenantId,
      journalId: journal.id,
      supplierId: d.payable.supplierId ?? null,
      payeeName: d.payable.payeeName,
      description: journal.description,
      amount: d.payable.amount,
      dueDate: d.payable.dueDate,
      createdBy: ctx.userId,
    });
  }
  if (d.settlesPayableId) {
    const lines = await loadLines(tx, journal.id);
    const accs = await tx.select().from(accounts).where(inArray(accounts.id, lines.map((l) => l.accountId)));
    const liab = new Set(accs.filter((a) => a.type === "liability").map((a) => a.id));
    const paid = lines.filter((l) => liab.has(l.accountId)).reduce((s, l) => s + l.debit, 0);
    await settlePayable(tx, d.settlesPayableId, journal.id, paid);
  }
  if (d.writeOff) {
    await m5.writeOffInvoice(tx, { ctx, invoiceId: d.writeOff.invoiceId, amount: d.writeOff.amount, journalId: journal.id, approvalId, reason: journal.description });
  }
}

async function settlePayable(tx: Tx, payableId: string, journalId: string, amount: number): Promise<void> {
  const [p] = await tx.select().from(journalPayables).where(eq(journalPayables.id, payableId)).for("update").limit(1);
  if (!p) throw new NotFoundError("Utang tidak ditemukan.");
  const settled = Math.min(p.amount, p.settledAmount + amount);
  await tx.insert(journalPayableSettlements).values({ payableId, journalId, amount });
  await tx
    .update(journalPayables)
    .set({ settledAmount: settled, status: settled >= p.amount ? "paid" : settled > 0 ? "partial" : "open", updatedAt: new Date() })
    .where(eq(journalPayables.id, payableId));
}

/** Posting draf/diajukan (tanpa otorisasi — pemanggil sudah memeriksa). */
export async function postManual(
  tx: Tx,
  ctx: ActorContext,
  journal: JournalRow,
  opts: { requiresOwnerReview: boolean; periodMode: "strict" | "forward"; approvalId?: string | null },
): Promise<JournalRow> {
  const posting = await postingPeriodFor(tx, journal.tenantId, journal.journalDate, opts.periodMode);
  const autoReverseOn = journal.kind === "accrual" ? firstDayOfMonth(addDays(lastDayOfMonth(journal.journalDate), 1)) : null;
  const [row] = await tx
    .update(journals)
    .set({
      status: "posted",
      periodId: posting.periodId,
      originPeriod: journal.originPeriod ?? posting.originPeriod,
      postedAt: ctx.now,
      postedBy: ctx.userId,
      requiresOwnerReview: opts.requiresOwnerReview,
      autoReverseOn,
      approvalRequestId: opts.approvalId ?? journal.approvalRequestId,
      updatedAt: new Date(),
    })
    .where(eq(journals.id, journal.id))
    .returning();
  await afterManualPosted(tx, ctx, row!, opts.approvalId ?? null);
  await auditRecord(tx, {
    ctx,
    objectType: "journal",
    objectId: journal.id,
    action: "post",
    before: { status: journal.status },
    after: { status: "posted", period: posting.period, requiresOwnerReview: opts.requiresOwnerReview, autoReverseOn },
    rule: "US-M11-03 KP-2",
    businessDate: journal.journalDate,
  });
  return row!;
}

const submitSchema = z.object({ journalId: z.uuid() }).strict();

export type SubmitResult = { status: "posted"; journal: JournalRow } | { status: "submitted"; journal: JournalRow; approvalId: string };

/**
 * Ajukan/posting jurnal manual (Admin Keuangan): lampiran wajib; > PAR-20 → persetujuan pemilik; ≤ PAR-20 → terposting
 * + daftar tinjauan pemilik (PTB-12).
 */
export async function submitManualJournal(ctx: ActorContext, input: z.input<typeof submitSchema>, opts: { tx?: Tx } = {}): Promise<SubmitResult> {
  await authorize(ctx, "m11.journal.submit", { tx: opts.tx });
  const data = parseInput(submitSchema, input);
  return runService(ctx, opts, async (tx) => {
    const j = await loadJournal(tx, ctx.tenantId, data.journalId, { forUpdate: true });
    if (!MANUAL_KINDS.includes(j.kind) || j.kind === "opening_adjustment") throw new DomainError("NOT_MANUAL", "Hanya jurnal manual yang diajukan dari sini.");
    if (j.status !== "draft" && j.status !== "rejected") throw new DomainError("JOURNAL_STATUS", `Jurnal ini berstatus ${label("journal_status", j.status)}.`);
    if (!j.attachmentId) throw new DomainError("ATTACHMENT_REQUIRED", "Lampiran bukti (foto/PDF) wajib sebelum jurnal diajukan (BR-35).");
    const lines = await loadLines(tx, j.id);
    await assertPostableAccounts(
      tx,
      ctx.tenantId,
      lines.map((l) => l.accountId),
    );
    await postingPeriodFor(tx, ctx.tenantId, j.journalDate, "strict");
    const { amount_gt } = await params.get(tx, "PAR-20", j.journalDate);
    if (j.totalDebit > amount_gt) {
      const req = await approvals.submit(
        ctx,
        {
          type: "manual_journal",
          objectType: "journal",
          objectId: j.id,
          amount: j.totalDebit,
          reason: `${j.number}: ${j.description}`,
          deadlineAt: await closeDeadline(tx, j.journalDate),
          businessDate: j.journalDate,
          payload: { number: j.number, date: j.journalDate, link: `/akuntansi/jurnal/${j.id}` },
        },
        { tx },
      );
      const [row] = await tx.update(journals).set({ status: "submitted", approvalRequestId: req.id, updatedAt: new Date() }).where(eq(journals.id, j.id)).returning();
      await auditRecord(tx, { ctx, objectType: "journal", objectId: j.id, action: "submit", before: { status: j.status }, after: { status: "submitted", approval: req.number, amount: j.totalDebit, threshold: amount_gt }, rule: "BR-35, PAR-20" });
      return { status: "submitted", journal: row!, approvalId: req.id };
    }
    if (!can(ctx, "m11.journal.post")) throw new DomainError("POST_FORBIDDEN", "Anda tidak berwenang memposting jurnal manual.");
    const posted = await postManual(tx, ctx, j, { requiresOwnerReview: true, periodMode: "strict" });
    await notify(tx, {
      event: "journal.owner_review",
      tenantId: ctx.tenantId,
      title: `Jurnal manual ${j.number} masuk daftar tinjauan`,
      body: `${j.description} — ${formatRupiah(j.totalDebit)}. Tandai daftar tinjauan sebelum periode ${monthOf(j.journalDate)} ditutup (PTB-12).`,
      objectType: "journal",
      objectId: j.id,
      valueAmount: j.totalDebit,
      groupKey: `journal.owner_review:${ctx.tenantId}:${monthOf(j.journalDate)}`,
      link: `/akuntansi/jurnal?tinjauan=${monthOf(j.journalDate)}`,
      now: ctx.now,
    });
    return { status: "posted", journal: posted };
  });
}

const cancelSchema = z.object({ journalId: z.uuid(), reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }) }).strict();

/** Batalkan draf/pengajuan (status Ditolak; tidak dihapus). */
export async function cancelManualJournal(ctx: ActorContext, input: z.input<typeof cancelSchema>, opts: { tx?: Tx } = {}): Promise<JournalRow> {
  await authorize(ctx, "m11.journal.create", { tx: opts.tx });
  const data = parseInput(cancelSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const j = await loadJournal(tx, ctx.tenantId, data.journalId, { forUpdate: true });
    if (j.status === "posted") throw new DomainError("JOURNAL_POSTED", "Jurnal terposting tidak dapat dibatalkan — buat jurnal pembalik beralasan.");
    if (j.status === "submitted" && j.approvalRequestId) {
      const req = await approvals.getApproval(tx, j.approvalRequestId);
      if (req?.status === "submitted") await approvals.cancel(ctx, req.id, data.reason, { tx });
    }
    const [row] = await tx.update(journals).set({ status: "rejected", updatedAt: new Date() }).where(eq(journals.id, j.id)).returning();
    await auditRecord(tx, { ctx, objectType: "journal", objectId: j.id, action: "cancel", before: { status: j.status }, after: { status: "rejected" }, reason: data.reason });
    return row!;
  });
}

// --- Persetujuan pemilik ---------------------------------------------------------------------------------------------

/** `manual_journal` disetujui → posting (ctx = pemilik; tulis langsung dengan tx). */
export async function onManualJournalApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const j = await loadJournal(tx, request.tenantId, request.objectId, { forUpdate: true });
  if (j.status !== "submitted") return { skipped: true, status: j.status };
  const posted = await postManual(tx, ctx, j, { requiresOwnerReview: false, periodMode: "forward", approvalId: request.id });
  return { journalId: posted.id, number: posted.number, status: "posted" };
}

export async function onManualJournalRejected(tx: Tx, request: ApprovalRow, ctx: ActorContext, reason: string | null): Promise<Record<string, unknown>> {
  const j = await loadJournal(tx, request.tenantId, request.objectId, { forUpdate: true });
  if (j.status !== "submitted") return { skipped: true };
  await tx.update(journals).set({ status: "rejected", updatedAt: new Date() }).where(eq(journals.id, j.id));
  await auditRecord(tx, { ctx, objectType: "journal", objectId: j.id, action: "reject", before: { status: "submitted" }, after: { status: "rejected" }, reason, rule: "BR-35" });
  return { journalId: j.id, status: "rejected" };
}

// --- Pembalik (BR-38) -----------------------------------------------------------------------------------------------

const reverseSchema = z
  .object({ journalId: z.uuid(), reason: z.string().trim().min(5, { error: "Alasan pembalik wajib diisi (minimal 5 karakter)." }), date: dateSchema.nullable().optional() })
  .strict();

async function createReversal(tx: Tx, ctx: ActorContext, j: JournalRow, reason: string, date: BusinessDate, approvalId: string | null): Promise<JournalRow> {
  if (await existingReversal(tx, j.id)) throw new DomainError("ALREADY_REVERSED", `Jurnal ${j.number} sudah dibalik.`);
  const lines = await loadLines(tx, j.id);
  const { journal } = await insertJournal(tx, {
    tenantId: j.tenantId,
    kind: "reversal",
    date: date < j.journalDate ? j.journalDate : date,
    description: `Pembalik ${j.number}: ${reason}`,
    lines: swappedLines(lines),
    ctx,
    sourceType: "manual",
    sourceObject: { type: "journal", id: j.id },
    reversalOfId: j.id,
    reversalReason: reason,
    approvalRequestId: approvalId,
    periodMode: "strict",
  });
  const [payable] = await tx.select().from(journalPayables).where(eq(journalPayables.journalId, j.id)).limit(1);
  if (payable && payable.status !== "paid") await settlePayable(tx, payable.id, journal.id, payable.amount - payable.settledAmount);
  await auditRecord(tx, { ctx, objectType: "journal", objectId: j.id, action: "reverse", after: { reversalId: journal.id, reversalNumber: journal.number, amount: j.totalDebit }, reason, rule: "BR-38" });
  return journal;
}

export type ReverseResult = { status: "reversed"; reversal: JournalRow } | { status: "pending_approval"; approvalId: string };

/** Balik jurnal manual terposting (Admin Keuangan); > PAR-21 lewat persetujuan pemilik (BR-38). */
export async function reverseManualJournal(ctx: ActorContext, input: z.input<typeof reverseSchema>, opts: { tx?: Tx } = {}): Promise<ReverseResult> {
  await authorize(ctx, "m11.journal.reverse", { tx: opts.tx });
  const data = parseInput(reverseSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const j = await loadJournal(tx, ctx.tenantId, data.journalId, { forUpdate: true });
    if (j.status !== "posted") throw new DomainError("JOURNAL_NOT_POSTED", "Hanya jurnal terposting yang dapat dibalik.");
    if (j.kind === "auto") throw new DomainError("AUTO_JOURNAL", "Jurnal otomatis tidak dapat diubah atau dibalik manual — koreksi lewat modul sumbernya (P-07 langkah 1, BR-38).");
    if (j.kind === "reversal" || j.kind === "accrual_reversal") throw new DomainError("REVERSAL_OF_REVERSAL", "Jurnal pembalik tidak dapat dibalik lagi — catat jurnal baru.");
    if (await existingReversal(tx, j.id)) throw new DomainError("ALREADY_REVERSED", `Jurnal ${j.number} sudah dibalik.`);
    const details = await loadDetails(tx, j.id);
    if (details?.writeOff) throw new DomainError("WRITE_OFF_REVERSAL", "Penghapusan piutang tidak dibalik dari sini — ajukan koreksi lewat Piutang (M5).");
    const [payable] = await tx.select().from(journalPayables).where(eq(journalPayables.journalId, j.id)).limit(1);
    if (payable && payable.settledAmount > 0) throw new DomainError("PAYABLE_SETTLED", "Utang dari jurnal ini sudah dibayar sebagian — balik jurnal pembayarannya dulu.");
    const date = data.date ?? ctxBusinessDate(ctx);
    const { amount_gt } = await params.get(tx, "PAR-21", ctxBusinessDate(ctx));
    if (j.totalDebit > amount_gt) {
      const req = await approvals.submit(
        ctx,
        { type: "correction", objectType: "journal", objectId: j.id, amount: j.totalDebit, reason: `Pembalik ${j.number}: ${data.reason}`, payload: { date, reason: data.reason, link: `/akuntansi/jurnal/${j.id}` } },
        { tx },
      );
      await auditRecord(tx, { ctx, objectType: "journal", objectId: j.id, action: "request_reversal", after: { approval: req.number, amount: j.totalDebit, threshold: amount_gt }, reason: data.reason, rule: "BR-38, PAR-21" });
      return { status: "pending_approval", approvalId: req.id };
    }
    const reversal = await createReversal(tx, ctx, j, data.reason, date, null);
    return { status: "reversed", reversal };
  });
}

/** `correction` objek `journal` disetujui pemilik → pembalik terposting. */
export async function onJournalCorrectionApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const j = await loadJournal(tx, request.tenantId, request.objectId, { forUpdate: true });
  if (await existingReversal(tx, j.id)) return { skipped: true };
  const payload = request.payload as { date?: string; reason?: string };
  const date = payload.date && isBusinessDate(payload.date) ? payload.date : ctxBusinessDate(ctx);
  const reversal = await createReversal(tx, ctx, j, payload.reason ?? request.reason, date, request.id);
  return { reversalId: reversal.id, number: reversal.number };
}

// --- Daftar tinjauan pemilik (PTB-12) --------------------------------------------------------------------------------

/** Jurnal manual ≤ PAR-20 yang wajib ditinjau pemilik pada periode. */
export async function ownerReviewList(ctx: ActorContext, filter: { periodId: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.journal.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return tx
    .select()
    .from(journals)
    .where(and(eq(journals.tenantId, ctx.tenantId), eq(journals.periodId, filter.periodId), eq(journals.requiresOwnerReview, true), eq(journals.status, "posted")))
    .orderBy(asc(journals.journalDate), asc(journals.number));
}

const markSchema = z.object({ periodId: z.uuid(), note: z.string().trim().max(300).nullable().optional() }).strict();

/** Pemilik menandai daftar tinjauan jurnal manual periode "ditinjau" (syarat tutup periode). */
export async function markManualJournalsReviewed(ctx: ActorContext, input: z.input<typeof markSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.journal.review", { tx: opts.tx });
  const data = parseInput(markSchema, input);
  return runService(ctx, opts, async (tx) => {
    const [p] = await tx.select().from(accountingPeriods).where(and(eq(accountingPeriods.id, data.periodId), eq(accountingPeriods.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!p) throw new NotFoundError("Periode tidak ditemukan.");
    const pending = await tx
      .update(journals)
      .set({ ownerReviewedAt: ctx.now, ownerReviewedBy: ctx.userId, updatedAt: new Date() })
      .where(and(eq(journals.periodId, p.id), eq(journals.requiresOwnerReview, true), isNull(journals.ownerReviewedAt), eq(journals.status, "posted")))
      .returning({ id: journals.id, number: journals.number });
    await tx.update(accountingPeriods).set({ manualReviewMarkedAt: ctx.now, manualReviewMarkedBy: ctx.userId, updatedAt: new Date() }).where(eq(accountingPeriods.id, p.id));
    await auditRecord(tx, { ctx, objectType: "accounting_period", objectId: p.id, action: "review", after: { period: p.period, journals: pending.map((r) => r.number) }, reason: data.note ?? null, rule: "PTB-12" });
    return { period: p.period, reviewed: pending.length };
  });
}

// --- Jurnal berulang (US-M11-03 KP-4) --------------------------------------------------------------------------------

export const recurringSchema = z
  .object({
    id: z.uuid().nullable().optional(),
    name: z.string().trim().min(3).max(100),
    template: z.enum(enumValues("recurring_journal_template")),
    description: z.string().trim().min(5).max(300),
    lines: z.array(journalLineSchema).min(2).max(20),
    dayOfMonth: z.number().int().min(1).max(28).default(1),
    isAccrual: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .strict();

export async function listRecurringJournals(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.journal.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return tx.select().from(recurringJournals).where(eq(recurringJournals.tenantId, ctx.tenantId)).orderBy(desc(recurringJournals.isActive), asc(recurringJournals.name));
}

/** Simpan jurnal berulang (penyusutan BUKAN jurnal berulang — otomatis). Berjejak. */
export async function saveRecurringJournal(ctx: ActorContext, input: z.input<typeof recurringSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.recurring_journal.update", { tx: opts.tx });
  const data = parseInput(recurringSchema, input, { name: "Nama", description: "Keterangan", lines: "Baris" });
  return runService(ctx, opts, async (tx) => {
    const lines = data.lines.map((l) => ({ ...l, debit: l.debit ?? 0, credit: l.credit ?? 0 }));
    assertBalancedLines(lines);
    await assertPostableAccounts(
      tx,
      ctx.tenantId,
      lines.map((l) => l.accountId),
    );
    const stored: TemplateJournalLine[] = lines.map((l) => ({
      accountId: l.accountId,
      profitCenter: l.profitCenter,
      outletId: l.outletId ?? null,
      side: l.debit > 0 ? "debit" : "credit",
      amount: l.debit > 0 ? l.debit : l.credit,
      memo: l.memo ?? null,
    }));
    const values = { name: data.name, template: data.template, description: data.description, lines: stored, dayOfMonth: data.dayOfMonth, isAccrual: data.isAccrual, isActive: data.isActive };
    if (data.id) {
      const [prev] = await tx.select().from(recurringJournals).where(and(eq(recurringJournals.id, data.id), eq(recurringJournals.tenantId, ctx.tenantId))).limit(1);
      if (!prev) throw new NotFoundError("Jurnal berulang tidak ditemukan.");
      const [row] = await tx.update(recurringJournals).set({ ...values, updatedAt: new Date() }).where(eq(recurringJournals.id, prev.id)).returning();
      await auditRecord(tx, { ctx, objectType: "recurring_journal", objectId: prev.id, action: "update", before: { name: prev.name, lines: prev.lines, isActive: prev.isActive }, after: values, rule: "US-M11-03 KP-4" });
      return row!;
    }
    const [row] = await tx.insert(recurringJournals).values({ tenantId: ctx.tenantId, ...values, createdBy: ctx.userId }).returning();
    await auditRecord(tx, { ctx, objectType: "recurring_journal", objectId: row!.id, action: "create", after: values, rule: "US-M11-03 KP-4" });
    return row!;
  });
}

/** Buat draf jurnal berulang untuk periode (idempoten per jurnal berulang + periode). */
export async function generateRecurringDraftsFor(tx: Tx, tenantId: string, period: string, ctx: ActorContext): Promise<string[]> {
  const rows = await tx.select().from(recurringJournals).where(and(eq(recurringJournals.tenantId, tenantId), eq(recurringJournals.isActive, true)));
  const created: string[] = [];
  for (const r of rows) {
    const [existing] = await tx
      .select({ id: manualJournalDetails.id })
      .from(manualJournalDetails)
      .where(and(eq(manualJournalDetails.recurringJournalId, r.id), eq(manualJournalDetails.recurringPeriod, period)))
      .limit(1);
    if (existing) continue;
    const date = `${period}-${String(r.dayOfMonth).padStart(2, "0")}`;
    const { journal } = await insertJournal(tx, {
      tenantId,
      kind: r.isAccrual ? "accrual" : "manual",
      status: "draft",
      date,
      description: `${r.description} (${period})`,
      lines: r.lines.map((l) => ({ accountId: l.accountId, profitCenter: l.profitCenter as never, outletId: l.outletId ?? null, debit: l.side === "debit" ? l.amount : 0, credit: l.side === "credit" ? l.amount : 0, memo: l.memo ?? null })),
      ctx,
      templateKey: r.template,
      sourceType: "manual",
    });
    await tx.insert(manualJournalDetails).values({ tenantId, journalId: journal.id, recurringJournalId: r.id, recurringPeriod: period });
    await tx.update(recurringJournals).set({ lastGeneratedPeriod: period, updatedAt: new Date() }).where(eq(recurringJournals.id, r.id));
    await auditRecord(tx, { ctx, objectType: "journal", objectId: journal.id, action: "create", after: { number: journal.number, recurring: r.name, period, status: "draft" }, rule: "US-M11-03 KP-4" });
    created.push(journal.id);
  }
  if (created.length) {
    await notify(tx, {
      event: "journal.recurring_ready",
      tenantId,
      title: `${created.length} draf jurnal berulang ${period} siap`,
      body: "Lengkapi lampiran bukti lalu ajukan/posting sesuai ambang persetujuan.",
      objectType: "accounting_period",
      objectId: period,
      groupKey: `journal.recurring_ready:${tenantId}:${period}`,
      link: "/akuntansi/jurnal?status=draft",
      now: ctx.now,
    });
  }
  return created;
}

/** Buat draf jurnal berulang bulan berjalan sekarang (Admin Keuangan). */
export async function generateRecurringDraftsNow(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<string[]> {
  await authorize(ctx, "m11.recurring_journal.update", { tx: opts.tx });
  return runService(ctx, opts, (tx) => generateRecurringDraftsFor(tx, ctx.tenantId, monthOf(ctxBusinessDate(ctx)), ctx));
}

/** Job bulanan: draf jurnal berulang bulan berjalan untuk semua tenant pembukuan. */
export async function runRecurringDrafts(now: Date, opts: { db?: Tx } = {}): Promise<number> {
  const run = async (tx: Tx) => {
    const tenants = await tx.selectDistinct({ tenantId: recurringJournals.tenantId }).from(recurringJournals).where(eq(recurringJournals.isActive, true));
    let n = 0;
    for (const { tenantId } of tenants) n += (await generateRecurringDraftsFor(tx, tenantId, monthOf(toBusinessDate(now)), systemContext({ tenantId, now }))).length;
    return n;
  };
  return opts.db ? run(opts.db) : withTx(run);
}

// --- Akrual (P-07 langkah 3) ----------------------------------------------------------------------------------------

/** Balik otomatis jurnal akrual yang jatuh tanggal pembaliknya (idempoten). */
export async function runAccrualReversals(now: Date, opts: { db?: Tx } = {}): Promise<number> {
  const today = toBusinessDate(now);
  const run = async (tx: Tx) => {
    const due = await tx
      .select()
      .from(journals)
      .where(and(eq(journals.kind, "accrual"), eq(journals.status, "posted"), lte(journals.autoReverseOn, today)));
    let n = 0;
    for (const j of due) {
      if (await existingReversal(tx, j.id)) continue;
      const lines = await loadLines(tx, j.id);
      const ctx = systemContext({ tenantId: j.tenantId, now });
      const { journal } = await insertJournal(tx, {
        tenantId: j.tenantId,
        kind: "accrual_reversal",
        date: j.autoReverseOn!,
        description: `Pembalik otomatis akrual ${j.number}: ${j.description}`,
        lines: swappedLines(lines),
        ctx,
        sourceType: "manual",
        sourceObject: { type: "journal", id: j.id },
        reversalOfId: j.id,
        reversalReason: "Pembalik akrual otomatis tanggal 1 periode berikutnya (P-07 langkah 3)",
        periodMode: "forward",
      });
      await auditRecord(tx, { ctx, objectType: "journal", objectId: j.id, action: "reverse", after: { reversalId: journal.id, number: journal.number, autoReverseOn: j.autoReverseOn }, rule: "US-M11-03 KP-6" });
      n++;
    }
    return n;
  };
  return opts.db ? run(opts.db) : withTx(run);
}

// --- Template & gaji -------------------------------------------------------------------------------------------------

/** Template jurnal manual dengan akun bawaan (kode → id) untuk formulir. */
export async function manualTemplates(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.journal.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const codes = Object.values(MANUAL_TEMPLATES).flatMap((t) => [t.debitAccountCode, t.creditAccountCode]);
  const byCode = await accountsByCode(tx, ctx.tenantId, [...codes, "2-1301"]);
  return Object.entries(MANUAL_TEMPLATES).map(([key, t]) => ({
    key,
    label: t.label,
    hint: t.hint,
    profitCenter: t.profitCenter,
    debitAccountId: byCode.get(t.debitAccountCode)?.id ?? null,
    creditAccountId: byCode.get(t.creditAccountCode)?.id ?? null,
    deductionAccountId: key === "salary" ? (byCode.get("2-1301")?.id ?? null) : null,
  }));
}
