/**
 * M5 — saldo awal piutang saat cut-over (US-M5-07; BRD 10.3, NFR-34, FR-M11-09, PAR-62).
 *
 * - Admin Keuangan menginput faktur saldo awal per pelanggan (tanggal, keterangan, jumlah, jatuh tempo, bukti konfirmasi
 *   pelanggan), bertanda "saldo awal", TANPA jurnal penjualan (masuk neraca awal M11; event `invoice.issued`
 *   `isOpeningBalance: true`).
 * - Total saldo awal ditandatangani pemilik di sistem (`data_signoffs` kelompok `opening_receivables`) sebelum dipakai
 *   (penahanan & pengingat baru memperhitungkan faktur saldo awal setelah ditandatangani); perubahan setelahnya hanya
 *   lewat koreksi berjejak (`opening_balance_adjustment`, persetujuan pemilik, ≤ PAR-62 bulan setelah cut-over).
 * - Faktur saldo awal mengikuti aturan umur, pengingat, penahanan yang sama, termasuk masa transisi (US-M5-03 KP-5).
 */
import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { attachments, customers, dataSignoffs, invoices } from "@/db/schema";
import { formatRupiah, zRupiahPositive } from "@/lib/money";
import { formatTanggal, isBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, ValidationError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { loadCustomer, loadInvoice, openingSignoff, type InvoiceRow, type SignoffRow } from "./common";
import { afterReceivablesChanged } from "./credit-hold";
import { issueCreditNote, issueInvoice } from "./ledger";

const bizDate = (what: string) => z.string().refine((v) => isBusinessDate(v), { error: `${what} tidak valid (YYYY-MM-DD).` });

const openingSchema = z.object({
  customerId: z.string().uuid({ error: "Pelanggan wajib dipilih." }),
  issueDate: bizDate("Tanggal faktur"),
  dueDate: bizDate("Jatuh tempo"),
  description: z.string().trim().min(3, { error: "Keterangan wajib diisi." }).max(300),
  amount: zRupiahPositive,
  confirmationAttachmentId: z.string().uuid({ error: "Bukti konfirmasi pelanggan wajib dilampirkan." }),
});

/** Tanggal cut-over akuntansi (NFR-36) bila sudah ditetapkan. */
async function cutoverDate(tx: Tx, date: BusinessDate): Promise<BusinessDate | null> {
  const v = await params.get(tx, "accounting.cutover_date", date);
  return v.date ?? null;
}

async function assertAttachment(tx: Tx, id: string, tenantId: string) {
  const [att] = await tx.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!att || att.tenantId !== tenantId) throw ValidationError.field("confirmationAttachmentId", "Bukti konfirmasi tidak ditemukan. Unggah ulang berkasnya.");
  return att;
}

/** Input faktur saldo awal (KP-1) — hanya sebelum total saldo awal ditandatangani pemilik. */
export async function createOpeningInvoice(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<InvoiceRow> {
  await authorize(ctx, "m5.opening_balance.create", { tx: opts.tx });
  const data = parseInput(openingSchema, input, { customerId: "Pelanggan", issueDate: "Tanggal", dueDate: "Jatuh tempo", description: "Keterangan", amount: "Jumlah", confirmationAttachmentId: "Bukti konfirmasi" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const customer = await loadCustomer(tx, data.customerId, { ctx });
    const signoff = await openingSignoff(tx, customer.tenantId);
    if (signoff?.status === "signed") {
      throw new ConflictError("OPENING_SIGNED", "Saldo awal piutang sudah ditandatangani pemilik; perubahan hanya lewat koreksi berjejak (ajukan penyesuaian saldo awal).");
    }
    const cutover = await cutoverDate(tx, today);
    if (cutover && data.issueDate >= cutover) throw ValidationError.field("issueDate", `Faktur saldo awal harus bertanggal sebelum cut-over ${formatTanggal(cutover, { weekday: false })}.`);
    if (!cutover && data.issueDate > today) throw ValidationError.field("issueDate", "Tanggal faktur saldo awal tidak boleh setelah hari ini.");
    if (data.dueDate < data.issueDate) throw ValidationError.field("dueDate", "Jatuh tempo tidak boleh sebelum tanggal faktur.");
    await assertAttachment(tx, data.confirmationAttachmentId, customer.tenantId);
    const inv = await issueInvoice(tx, ctx, {
      tenantId: customer.tenantId,
      customerId: customer.id,
      kind: "opening_balance",
      issueDate: data.issueDate,
      dueDate: data.dueDate,
      description: data.description,
      isOpeningBalance: true,
      openingConfirmationAttachmentId: data.confirmationAttachmentId,
      applyAdvances: false,
      lines: [{ component: "opening_balance", description: `Saldo awal: ${data.description}`, serviceDate: data.issueDate, quantity: 1, unitPrice: data.amount, amount: data.amount }],
      rule: "US-M5-07 KP-1",
    });
    await linkAttachment(tx, data.confirmationAttachmentId, { type: "invoice", id: inv.id });
    await refreshOpeningDraft(tx, ctx, customer.tenantId);
    return inv;
  });
}

const cancelSchema = z.object({ invoiceId: z.string().uuid(), reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }) });

/** Batalkan entri saldo awal yang salah SEBELUM ditandatangani (nota kredit penuh, berjejak; tanpa penghapusan). */
export async function cancelOpeningInvoice(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.opening_balance.create", { tx: opts.tx });
  const data = parseInput(cancelSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const inv = await loadInvoice(tx, data.invoiceId, { ctx, forUpdate: true });
    if (!inv.isOpeningBalance) throw new DomainError("NOT_OPENING", "Hanya faktur saldo awal yang dapat dibatalkan di sini.");
    const signoff = await openingSignoff(tx, inv.tenantId);
    if (signoff?.status === "signed") throw new ConflictError("OPENING_SIGNED", "Saldo awal sudah ditandatangani; ajukan penyesuaian saldo awal (koreksi berjejak).");
    if (inv.outstandingAmount <= 0) throw new DomainError("INVOICE_LOCKED", `Faktur ${inv.number} sudah tidak bersisa.`);
    await issueCreditNote(tx, ctx, { invoiceId: inv.id, amount: inv.outstandingAmount, reason: `Pembatalan entri saldo awal: ${data.reason}`, purpose: "opening_adjustment" });
    await refreshOpeningDraft(tx, ctx, inv.tenantId);
    return loadInvoice(tx, inv.id);
  });
}

/** Ringkasan saldo awal piutang (total, jumlah faktur, per pelanggan). */
export async function openingSummary(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({ inv: invoices, customerName: customers.name, customerCode: customers.code })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.isOpeningBalance, true)))
    .orderBy(asc(customers.name), asc(invoices.issueDate));
  const netOf = (i: InvoiceRow) => i.amount - i.creditedAmount;
  const byCustomer = new Map<string, { customerId: string; name: string; code: string | null; total: number; count: number }>();
  for (const r of rows) {
    const net = netOf(r.inv);
    if (net <= 0) continue;
    const c = byCustomer.get(r.inv.customerId) ?? { customerId: r.inv.customerId, name: r.customerName, code: r.customerCode, total: 0, count: 0 };
    c.total += net;
    c.count++;
    byCustomer.set(r.inv.customerId, c);
  }
  const total = [...byCustomer.values()].reduce((s, c) => s + c.total, 0);
  const count = [...byCustomer.values()].reduce((s, c) => s + c.count, 0);
  return { total, count, customers: [...byCustomer.values()], invoices: rows.map((r) => ({ ...r.inv, customerName: r.customerName, customerCode: r.customerCode })) };
}

async function refreshOpeningDraft(tx: Tx, ctx: ActorContext, tenantId: string): Promise<SignoffRow> {
  const sum = await openingSummary(tx, tenantId);
  const summary = { total: sum.total, count: sum.count, customers: sum.customers, updatedAt: ctx.now.toISOString() };
  const current = await openingSignoff(tx, tenantId);
  let row: SignoffRow;
  if (current && current.status === "draft") {
    [row] = (await tx.update(dataSignoffs).set({ summary, updatedAt: ctx.now }).where(eq(dataSignoffs.id, current.id)).returning()) as [SignoffRow];
  } else {
    [row] = (await tx
      .insert(dataSignoffs)
      .values({ tenantId, group: "opening_receivables", title: "Ringkasan data awal — Piutang berjalan", summary, status: "draft", supersedesId: current?.id ?? null, createdBy: ctx.userId })
      .returning()) as [SignoffRow];
    await notify(tx, {
      event: "initial_data.signoff_pending",
      tenantId,
      title: "Saldo awal piutang menunggu tanda tangan pemilik",
      body: "Tinjau total saldo awal piutang per pelanggan lalu tanda tangani sebelum go-live (NFR-34).",
      objectType: "data_signoff",
      objectId: row.id,
      link: "/piutang/saldo-awal",
      groupKey: `signoff:${tenantId}:opening_receivables`,
      now: ctx.now,
    });
  }
  await auditRecord(tx, { ctx, objectType: "data_signoff", objectId: row.id, action: "update", after: { group: "opening_receivables", total: sum.total, count: sum.count }, rule: "US-M5-07 KP-2, NFR-34" });
  return row;
}

const signSchema = z.object({ note: z.string().trim().max(500).optional().nullable(), expectedTotal: z.number().int().optional().nullable() });

/** Pemilik menandatangani total saldo awal piutang (KP-2, NFR-34). */
export async function signOpeningBalances(ctx: ActorContext, input: unknown = {}, opts: { tx?: Tx } = {}): Promise<SignoffRow> {
  await authorize(ctx, "m5.opening_balance.sign", { tx: opts.tx });
  const data = parseInput(signSchema, input ?? {});
  return runService(ctx, opts, async (tx) => {
    const current = await openingSignoff(tx, ctx.tenantId);
    if (!current) throw new DomainError("NO_OPENING", "Belum ada saldo awal piutang yang diinput.");
    if (current.status === "signed") throw new ConflictError("OPENING_SIGNED", "Saldo awal piutang sudah ditandatangani.");
    const sum = await openingSummary(tx, ctx.tenantId);
    const recorded = (current.summary as { total?: number }).total ?? 0;
    if (recorded !== sum.total || (data.expectedTotal != null && data.expectedTotal !== sum.total)) {
      throw new ConflictError("OPENING_CHANGED", `Total saldo awal berubah menjadi ${formatRupiah(sum.total)}. Muat ulang halaman lalu tinjau kembali sebelum menandatangani.`);
    }
    if (current.supersedesId) await tx.update(dataSignoffs).set({ status: "superseded" }).where(eq(dataSignoffs.id, current.supersedesId));
    const [after] = await tx
      .update(dataSignoffs)
      .set({ status: "signed", signedBy: ctx.userId, signedAt: ctx.now, notes: data.note ?? null, updatedAt: ctx.now })
      .where(eq(dataSignoffs.id, current.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "data_signoff", objectId: current.id, action: "sign", before: { status: "draft" }, after: { status: "signed", total: sum.total, count: sum.count }, reason: data.note ?? null, rule: "US-M5-07 KP-2, NFR-34" });
    // Setelah ditandatangani, faktur saldo awal ikut evaluasi penahanan (KP-3).
    await afterReceivablesChanged(tx, ctx, sum.customers.map((c) => c.customerId));
    return after!;
  });
}

// =====================================================================================================================
// Koreksi berjejak setelah ditandatangani (KP-2; PAR-62; 6.2a `opening_balance_adjustment`)
// =====================================================================================================================

const adjustSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    customerId: z.string().uuid({ error: "Pelanggan wajib dipilih." }),
    issueDate: bizDate("Tanggal faktur"),
    dueDate: bizDate("Jatuh tempo"),
    description: z.string().trim().min(3).max(300),
    amount: zRupiahPositive,
    confirmationAttachmentId: z.string().uuid({ error: "Bukti konfirmasi pelanggan wajib dilampirkan." }),
    reason: z.string().trim().min(5, { error: "Alasan koreksi wajib diisi (minimal 5 karakter)." }),
  }),
  z.object({
    action: z.literal("reduce"),
    invoiceId: z.string().uuid({ error: "Faktur saldo awal wajib dipilih." }),
    amount: zRupiahPositive,
    reason: z.string().trim().min(5, { error: "Alasan koreksi wajib diisi (minimal 5 karakter)." }),
  }),
]);

function addMonths(date: BusinessDate, months: number): BusinessDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Ajukan koreksi saldo awal setelah ditandatangani — persetujuan pemilik; paling lama PAR-62 bulan setelah cut-over. */
export async function requestOpeningAdjustment(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.opening_balance.create", { tx: opts.tx });
  const data = parseInput(adjustSchema, input, { amount: "Jumlah", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const signoff = await openingSignoff(tx, ctx.tenantId);
    if (signoff?.status !== "signed") throw new DomainError("OPENING_NOT_SIGNED", "Saldo awal belum ditandatangani — ubah langsung entrinya.");
    const cutover = await cutoverDate(tx, today);
    if (cutover) {
      const par62 = await params.get(tx, "PAR-62", today);
      const limit = addMonths(cutover, par62.max_months_after_cutover);
      if (today > limit) throw new DomainError("ADJUSTMENT_WINDOW_CLOSED", `Penyesuaian saldo awal hanya sampai ${formatTanggal(limit, { weekday: false })} (PAR-62).`);
    }
    let objectId: string;
    let customerId: string;
    if (data.action === "add") {
      const c = await loadCustomer(tx, data.customerId, { ctx });
      await assertAttachment(tx, data.confirmationAttachmentId, c.tenantId);
      objectId = c.id;
      customerId = c.id;
    } else {
      const inv = await loadInvoice(tx, data.invoiceId, { ctx });
      if (!inv.isOpeningBalance) throw new DomainError("NOT_OPENING", "Pilih faktur saldo awal.");
      if (data.amount > inv.outstandingAmount) throw ValidationError.field("amount", `Koreksi melebihi sisa faktur ${formatRupiah(inv.outstandingAmount)}.`);
      objectId = inv.id;
      customerId = inv.customerId;
    }
    const customer = await loadCustomer(tx, customerId);
    return approvals.submit(
      ctx,
      {
        type: "opening_balance_adjustment",
        objectType: "opening_receivable",
        objectId,
        amount: data.amount,
        reason: data.reason,
        payload: { ...data, customerName: customer.name, link: "/piutang/saldo-awal" },
      },
      { tx },
    );
  });
}

/** Penerapan koreksi saldo awal yang disetujui pemilik. */
export async function applyOpeningAdjustment(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow): Promise<Record<string, unknown>> {
  const p = request.payload as z.output<typeof adjustSchema>;
  if (p.action === "add") {
    const customer = await loadCustomer(tx, p.customerId);
    const inv = await issueInvoice(tx, ctx, {
      tenantId: customer.tenantId,
      customerId: customer.id,
      kind: "opening_balance",
      issueDate: p.issueDate,
      dueDate: p.dueDate,
      description: `Koreksi saldo awal: ${p.description}`,
      isOpeningBalance: true,
      openingConfirmationAttachmentId: p.confirmationAttachmentId,
      applyAdvances: false,
      lines: [{ component: "opening_balance", description: `Koreksi saldo awal (${request.number}): ${p.description}`, serviceDate: p.issueDate, quantity: 1, unitPrice: p.amount, amount: p.amount }],
      rule: "US-M5-07 KP-2, PAR-62, 6.2a",
      reason: request.reason,
    });
    await linkAttachment(tx, p.confirmationAttachmentId, { type: "invoice", id: inv.id });
    return { applied: true, invoiceId: inv.id, number: inv.number };
  }
  const inv = await loadInvoice(tx, p.invoiceId, { forUpdate: true });
  const amount = Math.min(p.amount, inv.outstandingAmount);
  if (amount <= 0) return { applied: false, note: "Faktur sudah tidak bersisa." };
  const res = await issueCreditNote(tx, ctx, { invoiceId: inv.id, amount, reason: `Koreksi saldo awal (${request.number}): ${request.reason}`, purpose: "opening_adjustment", approvalId: request.id });
  await afterReceivablesChanged(tx, ctx, [inv.customerId]);
  return { applied: true, creditNoteId: res.creditNote?.id ?? null };
}

/** Layar saldo awal piutang (izin `m5.opening_balance.read`). */
export async function openingBoard(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.opening_balance.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const summary = await openingSummary(tx, ctx.tenantId);
  const signoff = await openingSignoff(tx, ctx.tenantId);
  const history = await tx
    .select()
    .from(dataSignoffs)
    .where(and(eq(dataSignoffs.tenantId, ctx.tenantId), eq(dataSignoffs.group, "opening_receivables")))
    .orderBy(desc(dataSignoffs.createdAt));
  const cutover = await cutoverDate(tx, today);
  const [adj] = await tx.select({ n: sql<number>`count(*)::int` }).from(invoices).where(and(eq(invoices.tenantId, ctx.tenantId), eq(invoices.isOpeningBalance, true), sql`${invoices.description} like 'Koreksi saldo awal:%'`));
  return { summary, signoff, history, cutover, adjustments: Number(adj?.n ?? 0) };
}
