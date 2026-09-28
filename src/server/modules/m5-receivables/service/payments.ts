/**
 * M5 — pelunasan & alokasinya (US-M5-02; BR-07, BR-38; 7.5.6):
 *
 * - Pelunasan kantor (Admin Keuangan): pelanggan, tanggal, jumlah, cara (tunai kantor → kas kantor M4; transfer →
 *   daftar pencocokan M4 lewat `collection.recorded`), bukti wajib untuk transfer, alokasi ke satu/beberapa faktur
 *   (bawaan tertua dulu, dapat diubah), sebagian/penuh; kelebihan → uang muka.
 * - Pelunasan lewat sopir (M3) diterapkan otomatis dari `collection.recorded` (alokasi sudah ditulis M3) — Admin
 *   Keuangan tidak mencatat ulang.
 * - Uang muka dialokasikan otomatis ke faktur berikutnya atau dikembalikan dengan persetujuan pemilik (`customer_refund`).
 * - Faktur Lunas terkunci; pembatalan/realokasi pelunasan hanya lewat pembalik beralasan; > PAR-21 → persetujuan
 *   pemilik (`correction`), event `payment.reversed`.
 * - 7.5.6: tunai rit yang sebenarnya pelunasan → reklasifikasi (kas tidak berubah); transfer tanpa keterangan → tertua dulu.
 */
import "server-only";

import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lte, sql, sum } from "drizzle-orm";
import { z } from "zod";

import {
  approvalRequests,
  bankAccounts,
  customerAdvances,
  customerPayments,
  customers,
  invoices,
  paymentAllocations,
  tripPayments,
  trips,
} from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah, zRupiahPositive } from "@/lib/money";
import { addDays, formatTanggal, isBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, ValidationError, parseInput } from "@/server/core/errors";
import { emit, type DomainEvent } from "@/server/core/events";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";
import { buildWaLink, recordWaOpened, renderTemplate } from "@/server/core/wa";

import { customerCardLink, loadAdvance, loadCustomer, loadInvoice, loadPayment, profitCenterOfKind, TRUCK_INVOICE_KINDS, type PaymentRow } from "./common";
import { afterReceivablesChanged } from "./credit-hold";
import {
  allocateOldest,
  applyAdvanceToInvoice,
  createAdvance,
  insertAllocation,
  issueInvoice,
  liveAllocations,
  openInvoicesOldestFirst,
  recomputeInvoice,
  reverseAllocation,
} from "./ledger";
import { activeTemplate, companyName } from "./templates";

const uuid = (what: string) => z.string().uuid({ error: `${what} wajib dipilih.` });
const bizDate = z.string().refine((v) => isBusinessDate(v), { error: "Tanggal tidak valid (YYYY-MM-DD)." });
const allocationSchema = z.object({ invoiceId: uuid("Faktur"), amount: zRupiahPositive });

// =====================================================================================================================
// Pembantu
// =====================================================================================================================

async function customerFacingAccount(tx: Tx, tenantId: string) {
  const rows = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.tenantId, tenantId), eq(bankAccounts.isCustomerFacing, true), eq(bankAccounts.isActive, true)))
    .orderBy(asc(bankAccounts.bankName))
    .limit(1);
  return rows[0] ?? null;
}

/** Rekening PT yang ditampilkan ke pelanggan (pengingat, faktur). */
export async function customerBankAccount(tx: Tx, tenantId: string): Promise<{ text: string; accountName: string } | null> {
  const acc = await customerFacingAccount(tx, tenantId);
  return acc ? { text: `${acc.bankName} ${acc.accountNumber}`, accountName: acc.accountName } : null;
}

/** Validasi & normalisasi alokasi terhadap faktur terbuka pelanggan (terkunci). */
async function resolveAllocations(
  tx: Tx,
  ctx: ActorContext,
  customerId: string,
  amount: number,
  requested: { invoiceId: string; amount: number }[] | undefined | null,
): Promise<{ allocations: { invoiceId: string; amount: number }[]; excess: number }> {
  const open = await openInvoicesOldestFirst(tx, customerId, { includeDisputed: true, lock: true });
  for (const inv of open) await recomputeInvoice(tx, ctx, inv.id);
  const fresh = await openInvoicesOldestFirst(tx, customerId, { includeDisputed: true });
  if (!requested || requested.length === 0) return allocateOldest(fresh.filter((i) => i.disputeStatus !== "disputed"), amount);
  const merged = new Map<string, number>();
  for (const a of requested) merged.set(a.invoiceId, (merged.get(a.invoiceId) ?? 0) + a.amount);
  const allocations: { invoiceId: string; amount: number }[] = [];
  let total = 0;
  for (const [invoiceId, amt] of merged) {
    const inv = fresh.find((i) => i.id === invoiceId);
    if (!inv) {
      const any = await tx.select({ number: invoices.number, status: invoices.status, customerId: invoices.customerId }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
      if (!any[0] || any[0].customerId !== customerId) throw ValidationError.field("allocations", "Faktur yang dipilih bukan milik pelanggan ini.");
      throw ValidationError.field("allocations", `Faktur ${any[0].number} sudah Lunas dan terkunci; pilih faktur lain.`);
    }
    if (amt > inv.outstandingAmount) {
      throw ValidationError.field("allocations", `Alokasi ${formatRupiah(amt)} melebihi sisa faktur ${inv.number} (${formatRupiah(inv.outstandingAmount)}).`);
    }
    allocations.push({ invoiceId, amount: amt });
    total += amt;
  }
  if (total > amount) throw ValidationError.field("allocations", `Jumlah alokasi ${formatRupiah(total)} melebihi jumlah pelunasan ${formatRupiah(amount)}.`);
  return { allocations, excess: amount - total };
}

async function invoiceKinds(tx: Tx, ids: string[]) {
  if (!ids.length) return [];
  return tx.select({ id: invoices.id, kind: invoices.kind, number: invoices.number }).from(invoices).where(inArray(invoices.id, ids));
}

function profitCenterOf(kinds: { kind: (typeof invoices.$inferSelect)["kind"] }[]): "L2" | "L4" | null {
  if (!kinds.length) return null;
  if (kinds.every((k) => TRUCK_INVOICE_KINDS.includes(k.kind))) return "L2";
  if (kinds.every((k) => profitCenterOfKind(k.kind) === "L4")) return "L4";
  return null;
}

// =====================================================================================================================
// Pelunasan kantor (KP-1)
// =====================================================================================================================

export const officePaymentSchema = z.object({
  customerId: uuid("Pelanggan"),
  businessDate: bizDate,
  amount: zRupiahPositive,
  method: z.enum(["cash", "transfer"], { error: "Cara bayar harus tunai kantor atau transfer." }),
  proofAttachmentId: z.string().uuid().nullable().optional(),
  bankAccountId: z.string().uuid().nullable().optional(),
  allocations: z.array(allocationSchema).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export type OfficePaymentResult = { payment: PaymentRow; allocations: { invoiceId: string; amount: number }[]; advanceAmount: number };

/** Catat pelunasan kantor (US-M5-02 KP-1) — izin `m5.customer_payment.create` (Admin Keuangan). */
export async function recordOfficePayment(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<OfficePaymentResult> {
  await authorize(ctx, "m5.customer_payment.create", { tx: opts.tx });
  const data = parseInput(officePaymentSchema, input, {
    customerId: "Pelanggan",
    businessDate: "Tanggal",
    amount: "Jumlah",
    method: "Cara bayar",
    proofAttachmentId: "Bukti transfer",
    allocations: "Alokasi",
  });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    if (data.businessDate > today) throw ValidationError.field("businessDate", "Tanggal pelunasan tidak boleh setelah hari ini.");
    if (data.method === "transfer" && !data.proofAttachmentId) {
      throw ValidationError.field("proofAttachmentId", "Bukti transfer wajib dilampirkan untuk pelunasan transfer (US-M5-02 KP-1).");
    }
    const customer = await loadCustomer(tx, data.customerId, { ctx });
    const { allocations, excess } = await resolveAllocations(tx, ctx, customer.id, data.amount, data.allocations);
    const bank = data.method === "transfer" ? (data.bankAccountId ?? (await customerFacingAccount(tx, customer.tenantId))?.id ?? null) : null;
    const [payment] = await tx
      .insert(customerPayments)
      .values({
        tenantId: customer.tenantId,
        customerId: customer.id,
        channel: "office",
        method: data.method,
        amount: data.amount,
        businessDate: data.businessDate,
        proofAttachmentId: data.proofAttachmentId ?? null,
        advanceAmount: excess,
        notes: data.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    for (const a of allocations) await insertAllocation(tx, ctx, { invoiceId: a.invoiceId, paymentId: payment!.id, amount: a.amount });
    if (data.proofAttachmentId) await linkAttachment(tx, data.proofAttachmentId, { type: "customer_payment", id: payment!.id });
    await applyPaymentEffects(tx, ctx, payment!, { notifyAdvance: false });
    const kinds = await invoiceKinds(tx, allocations.map((a) => a.invoiceId));
    await auditRecord(tx, {
      ctx,
      objectType: "customer_payment",
      objectId: payment!.id,
      action: "create",
      after: {
        customerId: customer.id,
        channel: "office",
        method: data.method,
        amount: data.amount,
        businessDate: data.businessDate,
        allocations: allocations.map((a) => ({ ...a, number: kinds.find((k) => k.id === a.invoiceId)?.number })),
        advanceAmount: excess,
        defaultOldestFirst: !data.allocations?.length,
      },
      reason: data.notes ?? null,
      rule: "US-M5-02 KP-1",
      businessDate: data.businessDate,
    });
    await emit(
      tx,
      "collection.recorded",
      {
        customerPaymentId: payment!.id,
        customerId: customer.id,
        amount: data.amount,
        channel: "office",
        method: data.method,
        allocations,
        advanceAmount: excess,
        profitCenter: profitCenterOf(kinds),
        bankAccountId: bank,
        proofAttachmentId: data.proofAttachmentId ?? null,
        businessDate: data.businessDate,
        notes: data.notes ?? null,
      },
      { ctx, tenantId: customer.tenantId, businessDate: data.businessDate, objectType: "customer_payment", objectId: payment!.id },
    );
    return { payment: payment!, allocations, advanceAmount: excess };
  });
}

/**
 * Terapkan pelunasan ke faktur (idempoten): hitung ulang faktur beralokasi, buat uang muka dari kelebihan (bila belum),
 * lalu lepas Ditahan bila seluruh faktur lewat tempo sudah lunas.
 */
export async function applyPaymentEffects(tx: Tx, ctx: ActorContext, payment: PaymentRow, opts: { notifyAdvance?: boolean } = {}): Promise<void> {
  const allocs = await tx
    .select({ invoiceId: paymentAllocations.invoiceId })
    .from(paymentAllocations)
    .where(eq(paymentAllocations.customerPaymentId, payment.id));
  for (const id of new Set(allocs.map((a) => a.invoiceId))) await recomputeInvoice(tx, ctx, id);
  if (payment.advanceAmount > 0 && !payment.reversalOfId) {
    const [existing] = await tx.select({ id: customerAdvances.id }).from(customerAdvances).where(eq(customerAdvances.sourcePaymentId, payment.id)).limit(1);
    if (!existing) {
      await createAdvance(tx, ctx, {
        tenantId: payment.tenantId,
        customerId: payment.customerId,
        amount: payment.advanceAmount,
        sourcePaymentId: payment.id,
        notes: payment.notes ?? `Kelebihan pelunasan ${formatRupiah(payment.amount)} (${label("payment_channel", payment.channel)}).`,
        notify: opts.notifyAdvance,
      });
    }
  }
  await afterReceivablesChanged(tx, ctx, [payment.customerId]);
}

/** Handler `collection.recorded` (M3 sopir, kasir toko, kantor): alokasi diterapkan tanpa input ulang (KP-2, B-16). */
export async function onCollectionRecorded(tx: Tx, ctx: ActorContext, event: DomainEvent<"collection.recorded">): Promise<boolean> {
  const [payment] = await tx.select().from(customerPayments).where(eq(customerPayments.id, event.payload.customerPaymentId)).limit(1);
  if (!payment) return false;
  await applyPaymentEffects(tx, ctx, payment, { notifyAdvance: payment.channel !== "office" });
  return true;
}

// =====================================================================================================================
// Pembalik pelunasan (KP-4; BR-38; > PAR-21 persetujuan pemilik)
// =====================================================================================================================

const reverseSchema = z.object({
  paymentId: uuid("Pelunasan"),
  reason: z.string().trim().min(5, { error: "Alasan pembalik wajib diisi (minimal 5 karakter)." }),
});

async function assertReversible(tx: Tx, payment: PaymentRow): Promise<void> {
  if (payment.reversalOfId) throw new DomainError("PAYMENT_IS_REVERSAL", "Baris ini adalah pembalik; tidak dapat dibalik lagi.");
  const [rev] = await tx.select({ id: customerPayments.id }).from(customerPayments).where(eq(customerPayments.reversalOfId, payment.id)).limit(1);
  if (rev) throw new ConflictError("PAYMENT_REVERSED", "Pelunasan ini sudah dibalik.");
}

async function correctionThreshold(tx: Tx, date: BusinessDate): Promise<number> {
  const par21 = await params.get(tx, "PAR-21", date);
  return par21.amount_gt;
}

async function openCorrection(tx: Tx, objectType: string, objectId: string) {
  const [row] = await tx
    .select({ id: approvalRequests.id, number: approvalRequests.number })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.type, "correction"), eq(approvalRequests.objectType, objectType), eq(approvalRequests.objectId, objectId), eq(approvalRequests.status, "submitted")))
    .limit(1);
  return row ?? null;
}

export type ReversalResult =
  | { status: "reversed"; reversal: PaymentRow }
  | { status: "pending_approval"; approvalId: string; approvalNumber: string };

/** Balik pelunasan beralasan (US-M5-02 KP-4). Jumlah > PAR-21 → persetujuan pemilik (`correction`). */
export async function reverseCustomerPayment(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<ReversalResult> {
  await authorize(ctx, "m5.customer_payment.reverse", { tx: opts.tx });
  const data = parseInput(reverseSchema, input, { paymentId: "Pelunasan", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const payment = await loadPayment(tx, data.paymentId, { ctx, forUpdate: true });
    await assertReversible(tx, payment);
    const threshold = await correctionThreshold(tx, ctxBusinessDate(ctx));
    if (payment.amount > threshold) {
      const open = await openCorrection(tx, "customer_payment", payment.id);
      if (open) throw new ConflictError("APPROVAL_ALREADY_OPEN", `Pembalik pelunasan ini sudah diajukan (${open.number}); tunggu keputusan pemilik.`);
      const customer = await loadCustomer(tx, payment.customerId);
      const req = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "customer_payment",
          objectId: payment.id,
          amount: payment.amount,
          reason: data.reason,
          payload: { action: "reverse", customerName: customer.name, amount: payment.amount, businessDate: payment.businessDate, link: customerCardLink(customer.id) },
        },
        { tx },
      );
      return { status: "pending_approval", approvalId: req.id, approvalNumber: req.number };
    }
    const reversal = await applyPaymentReversal(tx, ctx, payment.id, data.reason, null);
    return { status: "reversed", reversal };
  });
}

/** Terapkan pembalik pelunasan (setelah otorisasi / persetujuan). Uang muka dari pelunasan itu ikut dibatalkan. */
export async function applyPaymentReversal(tx: Tx, ctx: ActorContext, paymentId: string, reason: string, approvalId: string | null): Promise<PaymentRow> {
  const payment = await loadPayment(tx, paymentId, { forUpdate: true });
  await assertReversible(tx, payment);
  const [reversal] = await tx
    .insert(customerPayments)
    .values({
      tenantId: payment.tenantId,
      customerId: payment.customerId,
      channel: payment.channel,
      method: payment.method,
      amount: -payment.amount,
      businessDate: ctxBusinessDate(ctx),
      incomingTransferId: payment.incomingTransferId,
      advanceAmount: -payment.advanceAmount,
      notes: `Pembalik pelunasan ${formatTanggal(payment.businessDate, { weekday: false })}: ${reason}`,
      reversalOfId: payment.id,
      reversalReason: reason,
      correctionApprovalId: approvalId,
      createdBy: ctx.userId,
    })
    .returning();
  await tx.update(customerPayments).set({ reversalReason: reason, correctionApprovalId: approvalId ?? payment.correctionApprovalId, updatedAt: ctx.now }).where(eq(customerPayments.id, payment.id));
  const touched = new Set<string>();
  for (const a of await liveAllocations(tx, { paymentId: payment.id })) {
    await reverseAllocation(tx, ctx, a, a.amount);
    touched.add(a.invoiceId);
  }
  // Uang muka dari pelunasan ini: batalkan alokasinya dan sisanya.
  const advs = await tx.select().from(customerAdvances).where(eq(customerAdvances.sourcePaymentId, payment.id));
  for (const adv of advs) {
    for (const a of await liveAllocations(tx, { advanceId: adv.id })) {
      await reverseAllocation(tx, ctx, a, a.amount);
      touched.add(a.invoiceId);
    }
    await tx
      .update(customerAdvances)
      .set({ remainingAmount: 0, status: "applied", notes: `${adv.notes ?? ""} — dibatalkan karena pelunasan sumbernya dibalik.`.trim(), updatedAt: ctx.now })
      .where(eq(customerAdvances.id, adv.id));
  }
  for (const id of touched) await recomputeInvoice(tx, ctx, id);
  await auditRecord(tx, {
    ctx,
    objectType: "customer_payment",
    objectId: payment.id,
    action: "reverse",
    before: { amount: payment.amount },
    after: { reversalId: reversal!.id, invoices: [...touched] },
    reason,
    rule: approvalId ? "BR-38, 6.2a" : "BR-38",
  });
  const kinds = await invoiceKinds(tx, [...touched]);
  await emit(
    tx,
    "payment.reversed",
    {
      customerPaymentId: payment.id,
      reversalId: reversal!.id,
      customerId: payment.customerId,
      amount: payment.amount,
      reason,
      channel: payment.channel,
      method: payment.method,
      depositId: payment.depositId,
      incomingTransferId: payment.incomingTransferId,
      profitCenter: profitCenterOf(kinds),
      approvalId,
      businessDate: ctxBusinessDate(ctx),
    },
    { ctx, tenantId: payment.tenantId, objectType: "customer_payment", objectId: payment.id },
  );
  return reversal!;
}

// =====================================================================================================================
// Realokasi (KP-1 "dapat diubah"; 7.5.6 transfer tanpa keterangan)
// =====================================================================================================================

const reallocateSchema = z.object({
  paymentId: uuid("Pelunasan"),
  allocations: z.array(allocationSchema).min(1, { error: "Isi alokasi baru minimal satu faktur." }),
  reason: z.string().trim().min(5, { error: "Alasan realokasi wajib diisi (minimal 5 karakter)." }),
});

export type ReallocationResult = { status: "reallocated" } | { status: "pending_approval"; approvalId: string; approvalNumber: string };

/** Ubah alokasi pelunasan (jumlah teralokasi tetap). Memindah dari faktur Lunas/total > PAR-21 → persetujuan pemilik. */
export async function reallocateCustomerPayment(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<ReallocationResult> {
  await authorize(ctx, "m5.customer_payment.reallocate", { tx: opts.tx });
  const data = parseInput(reallocateSchema, input, { paymentId: "Pelunasan", allocations: "Alokasi", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const payment = await loadPayment(tx, data.paymentId, { ctx, forUpdate: true });
    await assertReversible(tx, payment);
    const plan = await planReallocation(tx, payment, data.allocations);
    const threshold = await correctionThreshold(tx, ctxBusinessDate(ctx));
    if (plan.moved > threshold) {
      const open = await openCorrection(tx, "customer_payment", payment.id);
      if (open) throw new ConflictError("APPROVAL_ALREADY_OPEN", `Koreksi pelunasan ini sudah diajukan (${open.number}); tunggu keputusan pemilik.`);
      const customer = await loadCustomer(tx, payment.customerId);
      const req = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "customer_payment",
          objectId: payment.id,
          amount: plan.moved,
          reason: data.reason,
          payload: { action: "reallocate", allocations: data.allocations, customerName: customer.name, moved: plan.moved, link: customerCardLink(customer.id) },
        },
        { tx },
      );
      return { status: "pending_approval", approvalId: req.id, approvalNumber: req.number };
    }
    await applyReallocation(tx, ctx, payment.id, data.allocations, data.reason, null);
    return { status: "reallocated" };
  });
}

async function planReallocation(tx: Tx, payment: PaymentRow, requested: { invoiceId: string; amount: number }[]) {
  const live = await liveAllocations(tx, { paymentId: payment.id });
  const current = new Map<string, number>();
  for (const a of live) current.set(a.invoiceId, (current.get(a.invoiceId) ?? 0) + a.amount);
  const target = new Map<string, number>();
  for (const a of requested) target.set(a.invoiceId, (target.get(a.invoiceId) ?? 0) + a.amount);
  const curTotal = [...current.values()].reduce((s, v) => s + v, 0);
  const newTotal = [...target.values()].reduce((s, v) => s + v, 0);
  if (curTotal !== newTotal) {
    throw ValidationError.field("allocations", `Jumlah alokasi baru ${formatRupiah(newTotal)} harus sama dengan yang teralokasi sekarang ${formatRupiah(curTotal)}. Kelebihan bayar tetap menjadi uang muka.`);
  }
  const ids = [...new Set([...current.keys(), ...target.keys()])];
  const rows = ids.length ? await tx.select().from(invoices).where(inArray(invoices.id, ids)) : [];
  for (const r of rows) if (r.customerId !== payment.customerId) throw ValidationError.field("allocations", "Faktur yang dipilih bukan milik pelanggan ini.");
  if (rows.length !== ids.length) throw ValidationError.field("allocations", "Faktur tidak ditemukan.");
  let moved = 0;
  for (const id of ids) moved += Math.max(0, (current.get(id) ?? 0) - (target.get(id) ?? 0));
  return { live, current, target, moved };
}

export async function applyReallocation(tx: Tx, ctx: ActorContext, paymentId: string, requested: { invoiceId: string; amount: number }[], reason: string, approvalId: string | null): Promise<void> {
  const payment = await loadPayment(tx, paymentId, { forUpdate: true });
  await assertReversible(tx, payment);
  const plan = await planReallocation(tx, payment, requested);
  const ids = [...new Set([...plan.current.keys(), ...plan.target.keys()])];
  // Kurangi dulu.
  for (const id of ids) {
    const diff = (plan.current.get(id) ?? 0) - (plan.target.get(id) ?? 0);
    if (diff > 0) {
      const liveRow = plan.live.find((a) => a.invoiceId === id)!;
      await reverseAllocation(tx, ctx, liveRow, diff);
      await recomputeInvoice(tx, ctx, id);
    }
  }
  // Tambah (dibatasi sisa faktur).
  for (const id of ids) {
    const diff = (plan.target.get(id) ?? 0) - (plan.current.get(id) ?? 0);
    if (diff > 0) {
      await recomputeInvoice(tx, ctx, id);
      const inv = await loadInvoice(tx, id, { forUpdate: true });
      if (diff > inv.outstandingAmount) {
        throw ValidationError.field("allocations", `Alokasi ${formatRupiah(diff)} melebihi sisa faktur ${inv.number} (${formatRupiah(inv.outstandingAmount)}).`);
      }
      await insertAllocation(tx, ctx, { invoiceId: id, paymentId: payment.id, amount: diff });
      await recomputeInvoice(tx, ctx, id);
    }
  }
  await auditRecord(tx, {
    ctx,
    objectType: "customer_payment",
    objectId: payment.id,
    action: "reallocate",
    before: Object.fromEntries(plan.current),
    after: Object.fromEntries(plan.target),
    reason,
    rule: approvalId ? "BR-38, 6.2a, 7.5.6" : "BR-38, 7.5.6",
  });
  await afterReceivablesChanged(tx, ctx, [payment.customerId]);
}

// =====================================================================================================================
// 7.5.6 — tunai rit yang sebenarnya pelunasan: reklasifikasi (kas tidak berubah)
// =====================================================================================================================

const reclassSchema = z.object({
  tripId: uuid("Rit"),
  amount: zRupiahPositive.nullable().optional(),
  allocations: z.array(allocationSchema).nullable().optional(),
  reason: z.string().trim().min(5, { error: "Alasan reklasifikasi wajib diisi (minimal 5 karakter)." }),
});

const RECLASS_TAG = (tripPaymentId: string) => `[reklasifikasi tunai rit ${tripPaymentId}]`;

async function loadCashTripPayment(tx: Tx, tripId: string) {
  const rows = await tx
    .select({ p: tripPayments, number: trips.number, tenantId: trips.tenantId })
    .from(tripPayments)
    .innerJoin(trips, eq(trips.id, tripPayments.tripId))
    .where(and(eq(tripPayments.tripId, tripId), isNull(tripPayments.reversalOfId), isNull(tripPayments.reversedAt)))
    .orderBy(desc(tripPayments.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("Pembayaran rit tidak ditemukan.");
  if (row.p.method !== "cash" || row.p.receivedAmount <= 0) throw new DomainError("NOT_CASH_TRIP", "Hanya pembayaran rit tunai yang dapat direklasifikasi menjadi pelunasan.");
  return row;
}

export type ReclassResult =
  | { status: "reclassified"; invoiceId: string; paymentId: string }
  | { status: "pending_approval"; approvalId: string; approvalNumber: string };

/**
 * Pelanggan membayar ke sopir untuk faktur lama, tetapi sopir mencatatnya sebagai tunai rit (7.5.6): rit menjadi
 * piutang (faktur kirim) dan uang yang sama menjadi pelunasan faktur lama (metode `internal` — kas di tangan sopir
 * dan setoran TIDAK berubah). > PAR-21 → persetujuan pemilik.
 */
export async function reclassifyTripCash(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<ReclassResult> {
  await authorize(ctx, "m5.customer_payment.reallocate", { tx: opts.tx });
  const data = parseInput(reclassSchema, input, { tripId: "Rit", amount: "Jumlah", allocations: "Alokasi", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const tp = await loadCashTripPayment(tx, data.tripId);
    await loadCustomer(tx, tp.p.customerId, { ctx });
    const amount = data.amount ?? tp.p.receivedAmount;
    if (amount > tp.p.receivedAmount) throw ValidationError.field("amount", `Jumlah melebihi tunai rit ${formatRupiah(tp.p.receivedAmount)}.`);
    await assertNotReclassified(tx, tp.p.id, data.tripId);
    const threshold = await correctionThreshold(tx, ctxBusinessDate(ctx));
    if (amount > threshold) {
      const open = await openCorrection(tx, "trip_cash_reclass", tp.p.id);
      if (open) throw new ConflictError("APPROVAL_ALREADY_OPEN", `Reklasifikasi ini sudah diajukan (${open.number}); tunggu keputusan pemilik.`);
      const req = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "trip_cash_reclass",
          objectId: tp.p.id,
          amount,
          reason: data.reason,
          payload: { action: "reclassify_trip_cash", tripId: data.tripId, tripNumber: tp.number, amount, allocations: data.allocations ?? null, link: customerCardLink(tp.p.customerId) },
        },
        { tx },
      );
      return { status: "pending_approval", approvalId: req.id, approvalNumber: req.number };
    }
    const res = await applyTripCashReclass(tx, ctx, { tripId: data.tripId, amount, allocations: data.allocations ?? null, reason: data.reason, approvalId: null });
    return { status: "reclassified", ...res };
  });
}

async function assertNotReclassified(tx: Tx, tripPaymentId: string, tripId: string) {
  const [dup] = await tx
    .select({ id: customerPayments.id })
    .from(customerPayments)
    .where(and(eq(customerPayments.tripId, tripId), like(customerPayments.notes, `%${RECLASS_TAG(tripPaymentId)}%`), isNull(customerPayments.reversalOfId)))
    .limit(1);
  if (dup) throw new ConflictError("ALREADY_RECLASSIFIED", "Tunai rit ini sudah direklasifikasi menjadi pelunasan.");
  const [inv] = await tx.select({ number: invoices.number }).from(invoices).where(and(eq(invoices.tripId, tripId), eq(invoices.kind, "delivery"))).limit(1);
  if (inv) throw new ConflictError("TRIP_ALREADY_INVOICED", `Rit ini sudah memiliki faktur kirim ${inv.number}.`);
}

export async function applyTripCashReclass(
  tx: Tx,
  ctx: ActorContext,
  input: { tripId: string; amount: number; allocations: { invoiceId: string; amount: number }[] | null; reason: string; approvalId: string | null },
): Promise<{ invoiceId: string; paymentId: string }> {
  const tp = await loadCashTripPayment(tx, input.tripId);
  await assertNotReclassified(tx, tp.p.id, input.tripId);
  const [trip] = await tx.select().from(trips).where(eq(trips.id, input.tripId)).limit(1);
  const customer = await loadCustomer(tx, tp.p.customerId, { forUpdate: true });
  const { allocations, excess } = await resolveAllocations(tx, ctx, customer.id, input.amount, input.allocations);
  if (allocations.length === 0) throw new DomainError("NO_OPEN_INVOICE", "Tidak ada faktur terbuka lain untuk dialokasikan; reklasifikasi tidak diperlukan.");
  const tag = RECLASS_TAG(tp.p.id);
  const inv = await issueInvoice(tx, ctx, {
    tenantId: tp.tenantId,
    customerId: customer.id,
    kind: "delivery",
    addressId: trip!.addressId,
    tripId: trip!.id,
    issueDate: tp.p.businessDate,
    dueDate: tp.p.businessDate,
    description: `Rit ${tp.number} — tunai dialihkan menjadi pelunasan faktur lama (7.5.6)`,
    lines: [
      {
        component: "trip",
        description: `Air truk rit ${tp.number} (tunai ${formatRupiah(input.amount)} dialihkan sebagai pelunasan)`,
        tripId: trip!.id,
        serviceDate: tp.p.businessDate,
        quantity: 1,
        unitPrice: input.amount,
        amount: input.amount,
        volumeL: trip!.deliveredVolumeL ?? trip!.plannedVolumeL,
      },
    ],
    reclassifiedFromTripPaymentId: tp.p.id,
    applyAdvances: false,
    rule: "7.5.6",
    reason: input.reason,
  });
  const [payment] = await tx
    .insert(customerPayments)
    .values({
      tenantId: tp.tenantId,
      customerId: customer.id,
      channel: "office",
      method: "internal",
      amount: input.amount,
      businessDate: tp.p.businessDate,
      tripId: trip!.id,
      advanceAmount: excess,
      notes: `${input.reason} ${tag}`,
      correctionApprovalId: input.approvalId,
      createdBy: ctx.userId,
    })
    .returning();
  for (const a of allocations) await insertAllocation(tx, ctx, { invoiceId: a.invoiceId, paymentId: payment!.id, amount: a.amount });
  await applyPaymentEffects(tx, ctx, payment!, { notifyAdvance: false });
  await auditRecord(tx, {
    ctx,
    objectType: "trip_payment",
    objectId: tp.p.id,
    action: "reclassify",
    after: { invoiceId: inv.id, invoiceNumber: inv.number, customerPaymentId: payment!.id, amount: input.amount, allocations },
    reason: input.reason,
    rule: input.approvalId ? "7.5.6, BR-38, 6.2a" : "7.5.6, BR-38",
  });
  const kinds = await invoiceKinds(tx, allocations.map((a) => a.invoiceId));
  await emit(
    tx,
    "collection.recorded",
    {
      customerPaymentId: payment!.id,
      customerId: customer.id,
      amount: input.amount,
      channel: "office",
      method: "internal",
      allocations,
      advanceAmount: excess,
      profitCenter: profitCenterOf(kinds),
      tripId: trip!.id,
      businessDate: tp.p.businessDate,
      reclassifiedFromTripPaymentId: tp.p.id,
      notes: input.reason,
    },
    { ctx, tenantId: tp.tenantId, businessDate: tp.p.businessDate, objectType: "customer_payment", objectId: payment!.id },
  );
  return { invoiceId: inv.id, paymentId: payment!.id };
}

// =====================================================================================================================
// Uang muka: alokasi manual & pengembalian (KP-3)
// =====================================================================================================================

const applyAdvanceSchema = z.object({ advanceId: uuid("Uang muka"), invoiceId: uuid("Faktur"), amount: zRupiahPositive.nullable().optional() });

export async function applyAdvance(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<number> {
  await authorize(ctx, "m5.customer_payment.reallocate", { tx: opts.tx });
  const data = parseInput(applyAdvanceSchema, input, { advanceId: "Uang muka", invoiceId: "Faktur", amount: "Jumlah" });
  return runService(ctx, opts, async (tx) => {
    const adv = await loadAdvance(tx, data.advanceId, { ctx });
    if (adv.status !== "open" || adv.remainingAmount <= 0) throw new DomainError("ADVANCE_NOT_OPEN", "Uang muka ini sudah terpakai atau dikembalikan.");
    const n = await applyAdvanceToInvoice(tx, ctx, adv.id, data.invoiceId, data.amount ?? undefined);
    if (n <= 0) throw new DomainError("NOTHING_APPLIED", "Tidak ada yang dapat dialokasikan (faktur sudah lunas atau uang muka habis).");
    await afterReceivablesChanged(tx, ctx, [adv.customerId]);
    return n;
  });
}

const refundSchema = z.object({
  advanceId: uuid("Uang muka"),
  amount: zRupiahPositive,
  method: z.enum(["cash", "transfer"], { error: "Cara pengembalian harus tunai kantor atau transfer." }),
  bankAccountId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(5, { error: "Alasan pengembalian wajib diisi (minimal 5 karakter)." }),
});

/** Ajukan pengembalian uang muka ke pelanggan — persetujuan pemilik (6.2a `customer_refund`). */
export async function requestAdvanceRefund(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.customer_advance.refund_request", { tx: opts.tx });
  const data = parseInput(refundSchema, input, { advanceId: "Uang muka", amount: "Jumlah", method: "Cara", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const adv = await loadAdvance(tx, data.advanceId, { ctx, forUpdate: true });
    if (adv.status !== "open" || data.amount > adv.remainingAmount) {
      throw ValidationError.field("amount", `Jumlah pengembalian melebihi sisa uang muka ${formatRupiah(adv.remainingAmount)}.`);
    }
    const customer = await loadCustomer(tx, adv.customerId);
    return approvals.submit(
      ctx,
      {
        type: "customer_refund",
        objectType: "customer_advance",
        objectId: adv.id,
        amount: data.amount,
        reason: data.reason,
        payload: { customerName: customer.name, amount: data.amount, method: data.method, bankAccountId: data.bankAccountId ?? null, link: customerCardLink(customer.id) },
      },
      { tx },
    );
  });
}

/** Penerapan pengembalian uang muka disetujui (ctx = pemilik; ditulis langsung + audit + event untuk M4/M11). */
export async function applyAdvanceRefund(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow): Promise<Record<string, unknown>> {
  const adv = await loadAdvance(tx, request.objectId, { forUpdate: true });
  const payload = (request.payload ?? {}) as { amount?: number; method?: "cash" | "transfer"; bankAccountId?: string | null };
  const amount = Math.min(payload.amount ?? request.amount ?? 0, adv.remainingAmount);
  if (amount <= 0) return { applied: false, note: "Sisa uang muka sudah habis." };
  const remaining = adv.remainingAmount - amount;
  await tx
    .update(customerAdvances)
    .set({ remainingAmount: remaining, status: remaining === 0 ? "refunded" : "open", refundApprovalId: request.id, refundedAt: ctx.now, refundedBy: request.requesterUserId, updatedAt: ctx.now })
    .where(eq(customerAdvances.id, adv.id));
  await auditRecord(tx, {
    ctx,
    objectType: "customer_advance",
    objectId: adv.id,
    action: "refund",
    before: { remainingAmount: adv.remainingAmount },
    after: { remainingAmount: remaining, refunded: amount, method: payload.method ?? "cash" },
    reason: request.reason,
    rule: "US-M5-02 KP-3, 6.2a",
  });
  await emit(
    tx,
    "customer_advance.refunded",
    { customerAdvanceId: adv.id, customerId: adv.customerId, amount, method: payload.method ?? "cash", bankAccountId: payload.bankAccountId ?? null, approvalId: request.id, reason: request.reason },
    { ctx, tenantId: adv.tenantId, objectType: "customer_advance", objectId: adv.id },
  );
  return { applied: true, amount, remaining };
}

// =====================================================================================================================
// Daftar & bukti pelunasan (KP-5)
// =====================================================================================================================

export type PaymentListRow = {
  id: string;
  customerId: string;
  customerName: string;
  channel: PaymentRow["channel"];
  method: PaymentRow["method"];
  amount: number;
  businessDate: string;
  advanceAmount: number;
  notes: string | null;
  tripId: string | null;
  reversalOfId: string | null;
  reversed: boolean;
  proofAttachmentId: string | null;
  allocations: { invoiceId: string; number: string; amount: number }[];
  createdAt: Date;
};

export async function listPayments(
  ctx: ActorContext,
  filter: { customerId?: string | null; from?: BusinessDate | null; to?: BusinessDate | null; channel?: PaymentRow["channel"] | null; limit?: number } = {},
  opts: { tx?: Tx } = {},
): Promise<PaymentListRow[]> {
  await authorize(ctx, "m5.customer_payment.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds = [eq(customerPayments.tenantId, ctx.tenantId)];
  if (filter.customerId) conds.push(eq(customerPayments.customerId, filter.customerId));
  if (filter.from) conds.push(sql`${customerPayments.businessDate} >= ${filter.from}`);
  if (filter.to) conds.push(lte(customerPayments.businessDate, filter.to));
  if (filter.channel) conds.push(eq(customerPayments.channel, filter.channel));
  const rows = await tx
    .select({ p: customerPayments, customerName: customers.name })
    .from(customerPayments)
    .innerJoin(customers, eq(customers.id, customerPayments.customerId))
    .where(and(...conds))
    .orderBy(desc(customerPayments.businessDate), desc(customerPayments.createdAt))
    .limit(filter.limit ?? 200);
  const ids = rows.map((r) => r.p.id);
  const allocs = ids.length
    ? await tx
        .select({ paymentId: paymentAllocations.customerPaymentId, invoiceId: paymentAllocations.invoiceId, number: invoices.number, amount: sum(paymentAllocations.amount) })
        .from(paymentAllocations)
        .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
        .where(inArray(paymentAllocations.customerPaymentId, ids))
        .groupBy(paymentAllocations.customerPaymentId, paymentAllocations.invoiceId, invoices.number)
    : [];
  const reversedIds = ids.length
    ? new Set(
        (await tx.select({ id: customerPayments.reversalOfId }).from(customerPayments).where(and(inArray(customerPayments.reversalOfId, ids), isNotNull(customerPayments.reversalOfId)))).map(
          (r) => r.id!,
        ),
      )
    : new Set<string>();
  return rows.map(({ p, customerName }) => ({
    id: p.id,
    customerId: p.customerId,
    customerName,
    channel: p.channel,
    method: p.method,
    amount: p.amount,
    businessDate: p.businessDate,
    advanceAmount: p.advanceAmount,
    notes: p.notes,
    tripId: p.tripId,
    reversalOfId: p.reversalOfId,
    reversed: reversedIds.has(p.id),
    proofAttachmentId: p.proofAttachmentId,
    allocations: allocs.filter((a) => a.paymentId === p.id && Number(a.amount) !== 0).map((a) => ({ invoiceId: a.invoiceId, number: a.number, amount: Number(a.amount) })),
    createdAt: p.createdAt,
  }));
}

export type AdvanceListRow = typeof customerAdvances.$inferSelect & { customerName: string; refundPending: boolean };

export async function listAdvances(ctx: ActorContext, filter: { customerId?: string | null; openOnly?: boolean } = {}, opts: { tx?: Tx } = {}): Promise<AdvanceListRow[]> {
  await authorize(ctx, "m5.customer_payment.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds = [eq(customerAdvances.tenantId, ctx.tenantId)];
  if (filter.customerId) conds.push(eq(customerAdvances.customerId, filter.customerId));
  if (filter.openOnly) conds.push(and(eq(customerAdvances.status, "open"), gt(customerAdvances.remainingAmount, 0))!);
  const rows = await tx
    .select({ a: customerAdvances, customerName: customers.name })
    .from(customerAdvances)
    .innerJoin(customers, eq(customers.id, customerAdvances.customerId))
    .where(and(...conds))
    .orderBy(desc(customerAdvances.createdAt))
    .limit(200);
  const pending = new Set(
    (
      await tx
        .select({ id: approvalRequests.objectId })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.type, "customer_refund"), eq(approvalRequests.status, "submitted"), eq(approvalRequests.tenantId, ctx.tenantId)))
    ).map((r) => r.id),
  );
  return rows.map((r) => ({ ...r.a, customerName: r.customerName, refundPending: pending.has(r.a.id) }));
}

export type PaymentReceipt = {
  payment: PaymentRow;
  customer: { id: string; name: string; waPhone: string; code: string | null };
  allocations: { invoiceId: string; number: string; amount: number; outstandingAfter: number }[];
  advanceAmount: number;
  balanceAfter: number;
};

/** Data bukti pelunasan (PDF/WA, KP-5). */
export async function paymentReceipt(ctx: ActorContext, paymentId: string, opts: { tx?: Tx } = {}): Promise<PaymentReceipt> {
  await authorize(ctx, "m5.customer_payment.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const payment = await loadPayment(tx, paymentId, { ctx });
  const customer = await loadCustomer(tx, payment.customerId);
  const allocs = await tx
    .select({ invoiceId: paymentAllocations.invoiceId, number: invoices.number, amount: sum(paymentAllocations.amount), outstanding: invoices.outstandingAmount })
    .from(paymentAllocations)
    .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
    .where(eq(paymentAllocations.customerPaymentId, payment.id))
    .groupBy(paymentAllocations.invoiceId, invoices.number, invoices.outstandingAmount);
  const [bal] = await tx.select({ total: sum(invoices.outstandingAmount) }).from(invoices).where(and(eq(invoices.customerId, customer.id), gt(invoices.outstandingAmount, 0)));
  return {
    payment,
    customer: { id: customer.id, name: customer.name, waPhone: customer.waPhone, code: customer.code },
    allocations: allocs.filter((a) => Number(a.amount) !== 0).map((a) => ({ invoiceId: a.invoiceId, number: a.number, amount: Number(a.amount), outstandingAfter: a.outstanding })),
    advanceAmount: payment.advanceAmount,
    balanceAfter: Number(bal?.total ?? 0),
  };
}

/** Kirim bukti pelunasan lewat tautan WA (template `payment_receipt`, tercatat) — US-M5-02 KP-5. */
export async function sendPaymentReceipt(ctx: ActorContext, input: { paymentId: string }, opts: { tx?: Tx } = {}): Promise<{ link: string; text: string }> {
  await authorize(ctx, "m5.invoice.send", { tx: opts.tx });
  const data = parseInput(z.object({ paymentId: uuid("Pelunasan") }), input);
  return runService(ctx, opts, async (tx) => {
    const r = await paymentReceipt(ctx, data.paymentId, { tx });
    const tpl = await activeTemplate(tx, r.payment.tenantId, "payment_receipt");
    const { text } = renderTemplate(tpl.body, {
      nama_usaha: await companyName(tx, r.payment.tenantId, ctxBusinessDate(ctx)),
      nama_pelanggan: r.customer.name,
      tanggal: formatTanggal(r.payment.businessDate, { weekday: false }),
      jumlah: formatRupiah(r.payment.amount),
      daftar_faktur: r.allocations.map((a) => `${a.number} (${formatRupiah(a.amount)})`).join(", ") || (r.advanceAmount ? "uang muka" : "-"),
      sisa_piutang: formatRupiah(r.balanceAfter),
    });
    const link = buildWaLink(r.customer.waPhone, text);
    await recordWaOpened(tx, ctx, { kind: "payment_receipt", toPhone: r.customer.waPhone, renderedText: text, templateId: tpl.id, customerId: r.customer.id, objectType: "customer_payment", objectId: r.payment.id });
    await auditRecord(tx, { ctx, objectType: "customer_payment", objectId: r.payment.id, action: "receipt_sent", after: { via: "wa" }, rule: "US-M5-02 KP-5" });
    return { link, text };
  });
}

// =====================================================================================================================
// Rincian pelunasan (layar /piutang/pelunasan/[id]) & kandidat reklasifikasi tunai rit (7.5.6)
// =====================================================================================================================

export type PaymentDetail = {
  payment: PaymentRow;
  customer: { id: string; name: string; code: string | null; waPhone: string; creditStatus: string };
  /** Alokasi hidup per faktur (Σ baris + pembalik). */
  allocations: { invoiceId: string; number: string; amount: number; status: string; outstanding: number }[];
  /** Riwayat baris alokasi (termasuk pembalik negatif). */
  allocationRows: (typeof paymentAllocations.$inferSelect & { number: string })[];
  reversal: PaymentRow | null;
  reversalOf: PaymentRow | null;
  advances: (typeof customerAdvances.$inferSelect)[];
  /** Faktur terbuka pelanggan (untuk realokasi). */
  openInvoices: { id: string; number: string; kind: string; dueDate: string; outstanding: number; disputed: boolean }[];
  pendingApprovals: { id: string; number: string; status: string; amount: number | null; reason: string; createdAt: Date }[];
  tripNumber: string | null;
};

/** Rincian satu pelunasan (izin `m5.customer_payment.read`). */
export async function getPaymentDetail(ctx: ActorContext, paymentId: string, opts: { tx?: Tx } = {}): Promise<PaymentDetail> {
  await authorize(ctx, "m5.customer_payment.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const payment = await loadPayment(tx, paymentId, { ctx });
  const customer = await loadCustomer(tx, payment.customerId);
  const rows = await tx
    .select({ a: paymentAllocations, number: invoices.number })
    .from(paymentAllocations)
    .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
    .where(eq(paymentAllocations.customerPaymentId, payment.id))
    .orderBy(asc(paymentAllocations.allocatedAt), asc(paymentAllocations.createdAt));
  const live = await liveAllocations(tx, { paymentId: payment.id });
  const invRows = live.length ? await tx.select().from(invoices).where(inArray(invoices.id, live.map((l) => l.invoiceId))) : [];
  const [reversal] = await tx.select().from(customerPayments).where(eq(customerPayments.reversalOfId, payment.id)).limit(1);
  const reversalOf = payment.reversalOfId ? ((await tx.select().from(customerPayments).where(eq(customerPayments.id, payment.reversalOfId)).limit(1))[0] ?? null) : null;
  const advances = await tx.select().from(customerAdvances).where(eq(customerAdvances.sourcePaymentId, payment.id)).orderBy(asc(customerAdvances.createdAt));
  const open = await openInvoicesOldestFirst(tx, customer.id, { includeDisputed: true });
  const approvalRows = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.objectType, "customer_payment"), eq(approvalRequests.objectId, payment.id)))
    .orderBy(desc(approvalRequests.createdAt));
  const trip = payment.tripId ? ((await tx.select({ number: trips.number }).from(trips).where(eq(trips.id, payment.tripId)).limit(1))[0] ?? null) : null;
  return {
    payment,
    customer: { id: customer.id, name: customer.name, code: customer.code, waPhone: customer.waPhone, creditStatus: customer.creditStatus },
    allocations: live.map((l) => {
      const inv = invRows.find((i) => i.id === l.invoiceId);
      return { invoiceId: l.invoiceId, number: inv?.number ?? "", amount: l.amount, status: inv?.status ?? "open", outstanding: inv?.outstandingAmount ?? 0 };
    }),
    allocationRows: rows.map((r) => ({ ...r.a, number: r.number })),
    reversal: reversal ?? null,
    reversalOf,
    advances,
    openInvoices: open.map((i) => ({ id: i.id, number: i.number, kind: i.kind, dueDate: i.dueDate, outstanding: i.outstandingAmount, disputed: i.disputeStatus === "disputed" })),
    pendingApprovals: approvalRows.map((r) => ({ id: r.id, number: r.number, status: r.status, amount: r.amount, reason: r.reason, createdAt: r.createdAt })),
    tripNumber: trip?.number ?? null,
  };
}

export type ReclassCandidate = {
  tripId: string;
  tripNumber: string;
  tripPaymentId: string;
  customerId: string;
  customerName: string;
  businessDate: string;
  amount: number;
  /** Sisa faktur terbuka pelanggan (di luar rit ini). */
  otherOutstanding: number;
};

/**
 * Tunai rit yang dapat direklasifikasi menjadi pelunasan (7.5.6): pembayaran rit tunai yang belum dibalik, pelanggan
 * masih memiliki faktur terbuka, rit belum berfaktur kirim, dalam rentang `statement_default_days` terakhir.
 */
export async function reclassCandidates(ctx: ActorContext, input: { customerId?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<ReclassCandidate[]> {
  await authorize(ctx, "m5.customer_payment.reallocate", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const rules = (await params.get(tx, "m5.receivable_rules", today, { tenantId: ctx.tenantId })) as { statement_default_days: number };
  const from = addDays(today, -rules.statement_default_days);
  const conds = [
    eq(trips.tenantId, ctx.tenantId),
    eq(tripPayments.method, "cash"),
    gt(tripPayments.receivedAmount, 0),
    isNull(tripPayments.reversalOfId),
    isNull(tripPayments.reversedAt),
    gte(tripPayments.businessDate, from),
    sql`not exists (select 1 from ${invoices} where ${invoices.tripId} = ${trips.id} and ${invoices.kind} = 'delivery')`,
    sql`exists (select 1 from ${invoices} where ${invoices.customerId} = ${tripPayments.customerId} and ${invoices.outstandingAmount} > 0)`,
  ];
  if (input.customerId) conds.push(eq(tripPayments.customerId, input.customerId));
  const rows = await tx
    .select({ p: tripPayments, number: trips.number, customerName: customers.name })
    .from(tripPayments)
    .innerJoin(trips, eq(trips.id, tripPayments.tripId))
    .innerJoin(customers, eq(customers.id, tripPayments.customerId))
    .where(and(...conds))
    .orderBy(desc(tripPayments.businessDate), desc(tripPayments.createdAt))
    .limit(100);
  const out: ReclassCandidate[] = [];
  for (const r of rows) {
    const [dup] = await tx
      .select({ id: customerPayments.id })
      .from(customerPayments)
      .where(and(eq(customerPayments.tripId, r.p.tripId), like(customerPayments.notes, `%${RECLASS_TAG(r.p.id)}%`), isNull(customerPayments.reversalOfId)))
      .limit(1);
    if (dup) continue;
    const [bal] = await tx.select({ total: sum(invoices.outstandingAmount) }).from(invoices).where(and(eq(invoices.customerId, r.p.customerId), gt(invoices.outstandingAmount, 0)));
    out.push({
      tripId: r.p.tripId,
      tripNumber: r.number,
      tripPaymentId: r.p.id,
      customerId: r.p.customerId,
      customerName: r.customerName,
      businessDate: r.p.businessDate,
      amount: r.p.receivedAmount,
      otherOutstanding: Number(bal?.total ?? 0),
    });
  }
  return out;
}
