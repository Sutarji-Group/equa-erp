/**
 * M5 — buku piutang inti (fungsi `tx`-first, TANPA otorisasi — dipanggil layanan/handler modul ini yang sudah
 * terotorisasi): terbitkan faktur, hitung ulang sisa faktur dari alokasi, uang muka, nota kredit, pembalik alokasi,
 * penghapusan piutang.
 *
 * Model sisa faktur (CHECK `invoices_outstanding_chk`): `sisa = amount − paid − credited − written_off`, dengan
 * - `paid_amount`     = Σ `payment_allocations.amount` faktur itu (sumber pelunasan ATAU uang muka; baris pembalik
 *                       bernilai negatif) — alokasi pelunasan lewat sopir ditulis M3, diterapkan di sini (B-16);
 * - `credited_amount` = Σ `credit_notes.amount` berstatus Terbit (nota kredit TIDAK ditulis sebagai alokasi agar sisa
 *                       efektif di aplikasi sopir — `openInvoicesFor` M3 — tetap benar);
 * - `written_off_amount` = penghapusan piutang tak tertagih lewat jurnal manual M11 (PTB-28).
 * Tidak ada DELETE: koreksi = baris pembalik (BR-38). Faktur Lunas terkunci (US-M5-02 KP-4).
 */
import "server-only";

import { and, asc, desc, eq, gt, isNull, sql, sum } from "drizzle-orm";

import { creditNotes, customerAdvances, invoiceLines, invoices, paymentAllocations } from "@/db/schema";
import type { EnumValue, InvoiceKind } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { nextNumber } from "@/server/core/numbering";

import { customerCardLink, invoiceLink, loadAdvance, loadInvoice, profitCenterOfKind, type AdvanceRow, type CreditNoteRow, type InvoiceRow, type ReceivableLine } from "./common";

// =====================================================================================================================
// Terbitkan faktur
// =====================================================================================================================

export type InvoiceLineInput = {
  component: EnumValue<"invoice_line_component">;
  description: string;
  tripId?: string | null;
  posSaleLineId?: string | null;
  productId?: string | null;
  serviceDate?: BusinessDate | null;
  quantity?: number;
  unitPrice: number;
  amount: number;
  volumeL?: number | null;
  unbilledChargeId?: string | null;
};

export type IssueInvoiceInput = {
  tenantId: string;
  customerId: string;
  kind: InvoiceKind;
  issueDate: BusinessDate;
  dueDate: BusinessDate;
  lines: InvoiceLineInput[];
  addressId?: string | null;
  tripId?: string | null;
  posSaleId?: string | null;
  periodMonth?: BusinessDate | null;
  description?: string | null;
  isOpeningBalance?: boolean;
  openingConfirmationAttachmentId?: string | null;
  /** Lini asal faktur saldo awal (B-37). */
  openingLine?: ReceivableLine | null;
  pendingTransferId?: string | null;
  outletId?: string | null;
  reclassifiedFromTripPaymentId?: string | null;
  /** Uang muka pelanggan otomatis dialokasikan ke faktur baru (US-M5-02 KP-3). Bawaan true. */
  applyAdvances?: boolean;
  rule?: string;
  reason?: string | null;
};

/** Terbitkan faktur (nomor `F-YY-NNNNNN`, D-04) + baris + jejak audit + `invoice.issued`. Tanpa PPN (BR-29). */
export async function issueInvoice(tx: Tx, ctx: ActorContext, input: IssueInvoiceInput): Promise<InvoiceRow> {
  const amount = input.lines.reduce((s, l) => s + l.amount, 0);
  if (!Number.isInteger(amount) || amount <= 0) throw new DomainError("INVOICE_AMOUNT", "Nilai faktur harus lebih dari nol rupiah.");
  if (input.dueDate < input.issueDate) throw new DomainError("INVOICE_DUE_DATE", "Jatuh tempo tidak boleh sebelum tanggal faktur.");
  const number = await nextNumber(tx, "invoice", input.issueDate, { tenantId: input.tenantId });
  const [inv] = await tx
    .insert(invoices)
    .values({
      tenantId: input.tenantId,
      number,
      kind: input.kind,
      customerId: input.customerId,
      addressId: input.addressId ?? null,
      tripId: input.tripId ?? null,
      posSaleId: input.posSaleId ?? null,
      periodMonth: input.periodMonth ?? null,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      amount,
      outstandingAmount: amount,
      status: "open",
      description: input.description ?? null,
      isOpeningBalance: input.isOpeningBalance ?? false,
      openingConfirmationAttachmentId: input.openingConfirmationAttachmentId ?? null,
      openingLine: input.openingLine ?? null,
      pendingTransferId: input.pendingTransferId ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  let lineNo = 0;
  for (const l of input.lines) {
    lineNo++;
    await tx.insert(invoiceLines).values({
      invoiceId: inv!.id,
      lineNo,
      component: l.component,
      description: l.description,
      tripId: l.tripId ?? null,
      posSaleLineId: l.posSaleLineId ?? null,
      productId: l.productId ?? null,
      serviceDate: l.serviceDate ?? null,
      quantity: l.quantity ?? 1,
      unitPrice: l.unitPrice,
      amount: l.amount,
      volumeL: l.volumeL ?? null,
      unbilledChargeId: l.unbilledChargeId ?? null,
    });
  }
  await auditRecord(tx, {
    ctx,
    objectType: "invoice",
    objectId: inv!.id,
    action: "create",
    after: {
      number,
      kind: input.kind,
      customerId: input.customerId,
      amount,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      tripId: input.tripId ?? null,
      posSaleId: input.posSaleId ?? null,
      periodMonth: input.periodMonth ?? null,
      isOpeningBalance: input.isOpeningBalance ?? false,
      pendingTransferId: input.pendingTransferId ?? null,
      lines: input.lines.length,
    },
    reason: input.reason ?? null,
    rule: input.rule ?? "US-M5-01",
    businessDate: input.issueDate,
  });
  await emit(
    tx,
    "invoice.issued",
    {
      invoiceId: inv!.id,
      customerId: input.customerId,
      kind: input.kind,
      amount,
      dueDate: input.dueDate,
      tripId: input.tripId ?? null,
      posSaleId: input.posSaleId ?? null,
      profitCenter: profitCenterOfKind(input.kind),
      outletId: input.outletId ?? null,
      number,
      issueDate: input.issueDate,
      isOpeningBalance: input.isOpeningBalance ?? false,
      pendingTransferId: input.pendingTransferId ?? null,
      periodMonth: input.periodMonth ?? null,
      reclassifiedFromTripPaymentId: input.reclassifiedFromTripPaymentId ?? null,
    },
    { ctx, tenantId: input.tenantId, businessDate: input.issueDate, objectType: "invoice", objectId: inv!.id },
  );
  if (input.applyAdvances !== false && !input.pendingTransferId) await applyOpenAdvances(tx, ctx, inv!.id);
  return loadInvoice(tx, inv!.id);
}

// =====================================================================================================================
// Hitung ulang sisa faktur
// =====================================================================================================================

export type RecomputeResult = { invoice: InvoiceRow; before: InvoiceRow; becamePaid: boolean; reopened: boolean; changed: boolean };

/**
 * Hitung ulang `paid/credited/outstanding/status/paid_at` dari alokasi & nota kredit (idempoten — aman dipanggil ulang
 * oleh handler event). Kelebihan alokasi (mis. perangkat luring & kantor melunasi faktur yang sama) dibalik dari
 * alokasi terbaru dan dipindah menjadi uang muka pelanggan — uang pelanggan tidak pernah hilang.
 */
export async function recomputeInvoice(tx: Tx, ctx: ActorContext, invoiceId: string): Promise<RecomputeResult> {
  const before = await loadInvoice(tx, invoiceId, { forUpdate: true });
  let paid = await allocatedTotal(tx, invoiceId);
  const credited = await creditedTotal(tx, invoiceId);
  const capacity = before.amount - credited - before.writtenOffAmount;
  if (paid > capacity) {
    await moveOverflowToAdvance(tx, ctx, before, paid - Math.max(0, capacity));
    paid = await allocatedTotal(tx, invoiceId);
  }
  const outstanding = Math.max(0, before.amount - paid - credited - before.writtenOffAmount);
  const status: InvoiceRow["status"] = outstanding === 0 ? "paid" : paid > 0 || credited > 0 || before.writtenOffAmount > 0 ? "partial" : "open";
  const becamePaid = status === "paid" && before.status !== "paid";
  const reopened = before.status === "paid" && status !== "paid";
  const changed = paid !== before.paidAmount || credited !== before.creditedAmount || outstanding !== before.outstandingAmount || status !== before.status;
  if (!changed) return { invoice: before, before, becamePaid: false, reopened: false, changed: false };
  const [after] = await tx
    .update(invoices)
    .set({
      paidAmount: paid,
      creditedAmount: credited,
      outstandingAmount: before.amount - paid - credited - before.writtenOffAmount,
      status,
      paidAt: status === "paid" ? (before.paidAt ?? ctx.now) : null,
      updatedAt: ctx.now,
    })
    .where(eq(invoices.id, invoiceId))
    .returning();
  if (becamePaid) {
    await emit(
      tx,
      "invoice.paid",
      { invoiceId, customerId: before.customerId, amount: before.amount, number: before.number, kind: before.kind, paidAt: ctx.now.toISOString() },
      { ctx, tenantId: before.tenantId, objectType: "invoice", objectId: invoiceId },
    );
  }
  return { invoice: after!, before, becamePaid, reopened, changed: true };
}

/** Σ alokasi (pelunasan + uang muka, termasuk pembalik negatif) ke faktur. */
export async function allocatedTotal(tx: Tx, invoiceId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sum(paymentAllocations.amount) })
    .from(paymentAllocations)
    .where(and(eq(paymentAllocations.invoiceId, invoiceId), isNull(paymentAllocations.creditNoteId)));
  return Number(row?.total ?? 0);
}

/** Σ nota kredit terbit untuk faktur. */
export async function creditedTotal(tx: Tx, invoiceId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sum(creditNotes.amount) })
    .from(creditNotes)
    .where(and(eq(creditNotes.invoiceId, invoiceId), eq(creditNotes.status, "issued")));
  return Number(row?.total ?? 0);
}

/** Alokasi hidup per sumber (Σ positif + pembalik) untuk faktur — dipakai pembalik/realokasi. */
export async function liveAllocations(
  tx: Tx,
  where: { invoiceId?: string; paymentId?: string; advanceId?: string },
): Promise<{ invoiceId: string; paymentId: string | null; advanceId: string | null; amount: number; lastId: string }[]> {
  const conds = [isNull(paymentAllocations.creditNoteId)];
  if (where.invoiceId) conds.push(eq(paymentAllocations.invoiceId, where.invoiceId));
  if (where.paymentId) conds.push(eq(paymentAllocations.customerPaymentId, where.paymentId));
  if (where.advanceId) conds.push(eq(paymentAllocations.customerAdvanceId, where.advanceId));
  const rows = await tx
    .select()
    .from(paymentAllocations)
    .where(and(...conds))
    .orderBy(asc(paymentAllocations.allocatedAt), asc(paymentAllocations.createdAt));
  const map = new Map<string, { invoiceId: string; paymentId: string | null; advanceId: string | null; amount: number; lastId: string }>();
  for (const r of rows) {
    const key = `${r.invoiceId}|${r.customerPaymentId ?? ""}|${r.customerAdvanceId ?? ""}`;
    const cur = map.get(key) ?? { invoiceId: r.invoiceId, paymentId: r.customerPaymentId, advanceId: r.customerAdvanceId, amount: 0, lastId: r.id };
    cur.amount += r.amount;
    if (r.amount > 0) cur.lastId = r.id;
    map.set(key, cur);
  }
  return [...map.values()].filter((a) => a.amount !== 0);
}

/** Tulis baris pembalik (negatif) atas alokasi hidup sebesar `amount` (BR-38). */
export async function reverseAllocation(
  tx: Tx,
  ctx: ActorContext,
  live: { invoiceId: string; paymentId: string | null; advanceId: string | null; lastId: string },
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  await tx.insert(paymentAllocations).values({
    invoiceId: live.invoiceId,
    customerPaymentId: live.paymentId,
    customerAdvanceId: live.advanceId,
    amount: -amount,
    allocatedAt: ctx.now,
    reversalOfId: live.lastId,
    createdBy: ctx.userId,
  });
}

/** Alokasikan `amount` dari pelunasan ATAU uang muka ke faktur (baris baru). */
export async function insertAllocation(tx: Tx, ctx: ActorContext, input: { invoiceId: string; paymentId?: string | null; advanceId?: string | null; amount: number; at?: Date }): Promise<void> {
  if (input.amount <= 0) return;
  await tx.insert(paymentAllocations).values({
    invoiceId: input.invoiceId,
    customerPaymentId: input.paymentId ?? null,
    customerAdvanceId: input.advanceId ?? null,
    amount: input.amount,
    allocatedAt: input.at ?? ctx.now,
    createdBy: ctx.userId,
  });
}

/**
 * Reklasifikasi piutang ↔ uang muka di buku besar (B-65): `amount` > 0 uang muka dipakai pada faktur; < 0 alokasi
 * dibatalkan / kelebihan alokasi pelunasan menjadi uang muka. M11 menjurnal Dr 2-1201 / Cr 1-1401 (bertanda).
 */
async function emitAdvanceApplied(
  tx: Tx,
  ctx: ActorContext,
  inv: InvoiceRow,
  input: { amount: number; advanceId: string | null; reason: "applied" | "allocation_reversed" | "overpayment_to_advance" },
): Promise<void> {
  if (!input.amount) return;
  const businessDate = ctxBusinessDate(ctx);
  await emit(
    tx,
    "customer_advance.applied",
    { customerId: inv.customerId, invoiceId: inv.id, invoiceNumber: inv.number, customerAdvanceId: input.advanceId, amount: input.amount, reason: input.reason, tripId: inv.tripId ?? null, businessDate },
    { ctx, tenantId: inv.tenantId, businessDate, objectType: "invoice", objectId: inv.id },
  );
}

async function moveOverflowToAdvance(tx: Tx, ctx: ActorContext, inv: InvoiceRow, over: number): Promise<void> {
  let left = over;
  const live = (await liveAllocations(tx, { invoiceId: inv.id })).reverse();
  for (const a of live) {
    if (left <= 0) break;
    const take = Math.min(left, a.amount);
    await reverseAllocation(tx, ctx, a, take);
    if (a.advanceId) {
      const adv = await loadAdvance(tx, a.advanceId, { forUpdate: true });
      await tx
        .update(customerAdvances)
        .set({ remainingAmount: adv.remainingAmount + take, status: "open", updatedAt: ctx.now })
        .where(eq(customerAdvances.id, adv.id));
      await emitAdvanceApplied(tx, ctx, inv, { amount: -take, advanceId: adv.id, reason: "allocation_reversed" });
    } else {
      const adv = await createAdvance(tx, ctx, {
        tenantId: inv.tenantId,
        customerId: inv.customerId,
        amount: take,
        sourcePaymentId: a.paymentId,
        notes: `Kelebihan alokasi ke faktur ${inv.number} (sisa berubah sementara pelunasan tercatat) dipindah menjadi uang muka.`,
      });
      await emitAdvanceApplied(tx, ctx, inv, { amount: -take, advanceId: adv.id, reason: "overpayment_to_advance" });
    }
    left -= take;
  }
  await auditRecord(tx, {
    ctx,
    objectType: "invoice",
    objectId: inv.id,
    action: "overflow_to_advance",
    after: { amount: over },
    reason: "Alokasi melebihi sisa faktur — kelebihan dipindah menjadi uang muka pelanggan.",
    rule: "US-M5-02 KP-3",
  });
}

// =====================================================================================================================
// Uang muka (US-M5-02 KP-3)
// =====================================================================================================================

export async function createAdvance(
  tx: Tx,
  ctx: ActorContext,
  input: { tenantId: string; customerId: string; amount: number; sourcePaymentId?: string | null; notes: string; notify?: boolean },
): Promise<AdvanceRow> {
  const [adv] = await tx
    .insert(customerAdvances)
    .values({
      tenantId: input.tenantId,
      customerId: input.customerId,
      sourcePaymentId: input.sourcePaymentId ?? null,
      amount: input.amount,
      remainingAmount: input.amount,
      status: "open",
      notes: input.notes,
      createdBy: ctx.userId,
    })
    .returning();
  await auditRecord(tx, {
    ctx,
    objectType: "customer_advance",
    objectId: adv!.id,
    action: "create",
    after: { customerId: input.customerId, amount: input.amount, sourcePaymentId: input.sourcePaymentId ?? null },
    reason: input.notes,
    rule: "US-M5-02 KP-3",
  });
  if (input.notify !== false) {
    await notify(tx, {
      event: "receivable.advance_review",
      tenantId: input.tenantId,
      title: `Uang muka pelanggan ${formatRupiah(input.amount)}`,
      body: `${input.notes} Uang muka otomatis dialokasikan ke faktur berikutnya; pengembalian ke pelanggan perlu persetujuan pemilik.`,
      objectType: "customer_advance",
      objectId: adv!.id,
      valueAmount: input.amount,
      link: customerCardLink(input.customerId),
      now: ctx.now,
    });
  }
  return adv!;
}

/** ID uang muka yang sedang diajukan pengembaliannya (tidak dialokasikan otomatis). */
async function advancesPendingRefund(tx: Tx, customerId: string): Promise<Set<string>> {
  const rows = await tx.execute<{ object_id: string }>(
    sql`select ar.object_id from approval_requests ar join customer_advances ca on ca.id::text = ar.object_id
        where ar.type = 'customer_refund' and ar.status = 'submitted' and ca.customer_id = ${customerId}`,
  );
  return new Set(rows.rows.map((r) => r.object_id));
}

/** Alokasikan uang muka ke faktur (sebesar `amount`, dibatasi sisa keduanya). Mengembalikan jumlah teralokasi. */
export async function applyAdvanceToInvoice(tx: Tx, ctx: ActorContext, advanceId: string, invoiceId: string, amount?: number): Promise<number> {
  const adv = await loadAdvance(tx, advanceId, { forUpdate: true });
  const inv = await loadInvoice(tx, invoiceId, { forUpdate: true });
  if (adv.customerId !== inv.customerId) throw new DomainError("ADVANCE_CUSTOMER", "Uang muka hanya dapat dialokasikan ke faktur pelanggan yang sama.");
  if (inv.status === "paid") throw new DomainError("INVOICE_LOCKED", `Faktur ${inv.number} sudah Lunas dan terkunci.`);
  const take = Math.min(amount ?? Number.MAX_SAFE_INTEGER, adv.remainingAmount, inv.outstandingAmount);
  if (take <= 0) return 0;
  await insertAllocation(tx, ctx, { invoiceId, advanceId, amount: take });
  const remaining = adv.remainingAmount - take;
  await tx
    .update(customerAdvances)
    .set({ remainingAmount: remaining, status: remaining === 0 ? "applied" : "open", updatedAt: ctx.now })
    .where(eq(customerAdvances.id, adv.id));
  await recomputeInvoice(tx, ctx, invoiceId);
  await auditRecord(tx, {
    ctx,
    objectType: "customer_advance",
    objectId: adv.id,
    action: "apply",
    before: { remainingAmount: adv.remainingAmount },
    after: { remainingAmount: remaining, invoiceId, invoiceNumber: inv.number, amount: take },
    rule: "US-M5-02 KP-3",
  });
  await emitAdvanceApplied(tx, ctx, inv, { amount: take, advanceId: adv.id, reason: "applied" });
  return take;
}

/** Uang muka terbuka pelanggan dialokasikan otomatis ke faktur (tertua dulu), kecuali yang sedang diajukan dikembalikan. */
export async function applyOpenAdvances(tx: Tx, ctx: ActorContext, invoiceId: string): Promise<number> {
  const inv = await loadInvoice(tx, invoiceId);
  if (inv.outstandingAmount <= 0 || inv.disputeStatus === "disputed") return 0;
  const pending = await advancesPendingRefund(tx, inv.customerId);
  const open = await tx
    .select()
    .from(customerAdvances)
    .where(and(eq(customerAdvances.customerId, inv.customerId), eq(customerAdvances.status, "open"), gt(customerAdvances.remainingAmount, 0)))
    .orderBy(asc(customerAdvances.createdAt));
  let applied = 0;
  for (const adv of open) {
    if (pending.has(adv.id)) continue;
    const fresh = await loadInvoice(tx, invoiceId);
    if (fresh.outstandingAmount <= 0) break;
    applied += await applyAdvanceToInvoice(tx, ctx, adv.id, invoiceId);
  }
  return applied;
}

// =====================================================================================================================
// Nota kredit (BR-38, 7.5.6, PTB-46)
// =====================================================================================================================

export type CreditNotePurpose = "correction" | "dispute" | "store_return" | "pos_void" | "underpayment_conversion" | "pending_transfer_resolved" | "opening_adjustment";

/**
 * Terbitkan nota kredit `NK-YY-NNNNNN` atas faktur: bagian ≤ sisa faktur mengurangi faktur; kelebihan (faktur sudah
 * dibayar) menjadi uang muka pelanggan bila `excessToAdvance`, selain itu ditolak.
 */
export async function issueCreditNote(
  tx: Tx,
  ctx: ActorContext,
  input: {
    invoiceId: string;
    amount: number;
    reason: string;
    purpose: CreditNotePurpose;
    approvalId?: string | null;
    posSaleId?: string | null;
    storeReturnId?: string | null;
    excessToAdvance?: boolean;
    issueDate?: BusinessDate;
  },
): Promise<{ creditNote: CreditNoteRow | null; advance: AdvanceRow | null; applied: number; excess: number }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new DomainError("CREDIT_NOTE_AMOUNT", "Nilai nota kredit harus lebih dari nol rupiah.");
  await recomputeInvoice(tx, ctx, input.invoiceId);
  const inv = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  const applied = Math.min(input.amount, inv.outstandingAmount);
  const excess = input.amount - applied;
  if (excess > 0 && !input.excessToAdvance) {
    throw new DomainError(
      "CREDIT_NOTE_EXCEEDS",
      inv.status === "paid"
        ? `Faktur ${inv.number} sudah Lunas dan terkunci. Balik pelunasannya dulu (BR-38) sebelum menerbitkan nota kredit.`
        : `Nota kredit ${formatRupiah(input.amount)} melebihi sisa faktur ${inv.number} (${formatRupiah(inv.outstandingAmount)}).`,
    );
  }
  let cn: CreditNoteRow | null = null;
  const date = input.issueDate ?? ctxBusinessDate(ctx);
  if (applied > 0) {
    const number = await nextNumber(tx, "credit_note", date, { tenantId: inv.tenantId });
    [cn] = await tx
      .insert(creditNotes)
      .values({
        tenantId: inv.tenantId,
        number,
        customerId: inv.customerId,
        invoiceId: inv.id,
        amount: applied,
        reason: input.reason,
        issueDate: date,
        status: "issued",
        approvalRequestId: input.approvalId ?? null,
        posSaleId: input.posSaleId ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await recomputeInvoice(tx, ctx, inv.id);
    await auditRecord(tx, {
      ctx,
      objectType: "credit_note",
      objectId: cn!.id,
      action: "create",
      after: { number, invoiceId: inv.id, invoiceNumber: inv.number, amount: applied, purpose: input.purpose, excessToAdvance: excess },
      reason: input.reason,
      rule: input.purpose === "store_return" ? "PTB-46" : input.purpose === "dispute" ? "7.5.6" : "BR-38",
      businessDate: date,
    });
  }
  let advance: AdvanceRow | null = null;
  if (excess > 0) {
    advance = await createAdvance(tx, ctx, {
      tenantId: inv.tenantId,
      customerId: inv.customerId,
      amount: excess,
      notes: `Kelebihan ${input.purpose === "store_return" ? "retur toko" : "koreksi"} atas faktur ${inv.number} yang sudah dibayar: ${input.reason}`,
    });
  }
  if (cn) {
    await emit(
      tx,
      "credit_note.issued",
      {
        creditNoteId: cn.id,
        invoiceId: inv.id,
        customerId: inv.customerId,
        amount: applied,
        reason: input.reason,
        profitCenter: profitCenterOfKind(inv.kind),
        number: cn.number,
        purpose: input.purpose,
        posSaleId: input.posSaleId ?? null,
        storeReturnId: input.storeReturnId ?? null,
        advanceAmount: excess,
        approvalId: input.approvalId ?? null,
      },
      { ctx, tenantId: inv.tenantId, businessDate: date, objectType: "credit_note", objectId: cn.id },
    );
  }
  return { creditNote: cn, advance, applied, excess };
}

// =====================================================================================================================
// Penghapusan piutang tak tertagih (PTB-28) — dipanggil M11 dari jurnal manual yang disetujui pemilik
// =====================================================================================================================

/** Hapus buku sisa faktur (seluruhnya atau `amount`); pelanggan Tempo tetap/menjadi Ditahan (PTB-28). */
export async function applyWriteOff(
  tx: Tx,
  ctx: ActorContext,
  input: { invoiceId: string; amount?: number | null; journalId?: string | null; approvalId?: string | null; reason: string },
): Promise<InvoiceRow> {
  await recomputeInvoice(tx, ctx, input.invoiceId);
  const inv = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  const amount = input.amount ?? inv.outstandingAmount;
  if (!Number.isInteger(amount) || amount <= 0) throw new DomainError("WRITE_OFF_AMOUNT", "Nilai penghapusan harus lebih dari nol rupiah.");
  if (amount > inv.outstandingAmount) {
    throw new DomainError("WRITE_OFF_EXCEEDS", `Penghapusan ${formatRupiah(amount)} melebihi sisa faktur ${inv.number} (${formatRupiah(inv.outstandingAmount)}).`);
  }
  const writtenOff = inv.writtenOffAmount + amount;
  await tx
    .update(invoices)
    .set({
      writtenOffAmount: writtenOff,
      outstandingAmount: inv.outstandingAmount - amount,
      writtenOffAt: ctx.now,
      writeOffJournalId: input.journalId ?? inv.writeOffJournalId,
      writeOffApprovalId: input.approvalId ?? inv.writeOffApprovalId,
      updatedAt: ctx.now,
    })
    .where(eq(invoices.id, inv.id));
  const res = await recomputeInvoice(tx, ctx, inv.id);
  await auditRecord(tx, {
    ctx,
    objectType: "invoice",
    objectId: inv.id,
    action: "write_off",
    before: { outstandingAmount: inv.outstandingAmount, writtenOffAmount: inv.writtenOffAmount },
    after: { outstandingAmount: res.invoice.outstandingAmount, writtenOffAmount: writtenOff, journalId: input.journalId ?? null },
    reason: input.reason,
    rule: "PTB-28",
  });
  await emit(
    tx,
    "invoice.written_off",
    {
      invoiceId: inv.id,
      customerId: inv.customerId,
      amount,
      profitCenter: profitCenterOfKind(inv.kind),
      approvalId: input.approvalId ?? null,
      reason: input.reason,
      journalId: input.journalId ?? null,
      number: inv.number,
    },
    { ctx, tenantId: inv.tenantId, objectType: "invoice", objectId: inv.id },
  );
  return res.invoice;
}

/** Faktur terbuka pelanggan urut tertua (jatuh tempo, tanggal, nomor) — bawaan alokasi (US-M5-02 KP-1, 7.5.6). */
export async function openInvoicesOldestFirst(tx: Tx, customerId: string, opts: { includeDisputed?: boolean; lock?: boolean } = {}): Promise<InvoiceRow[]> {
  const q = tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), gt(invoices.outstandingAmount, 0)))
    .orderBy(asc(invoices.dueDate), asc(invoices.issueDate), asc(invoices.number));
  const rows = opts.lock ? await q.for("update") : await q;
  return opts.includeDisputed ? rows : rows.filter((r) => r.disputeStatus !== "disputed");
}

/** Pembagian jumlah ke faktur urut tertua; sisa di atas total sisa → `excess` (uang muka). */
export function allocateOldest(rows: readonly Pick<InvoiceRow, "id" | "outstandingAmount">[], amount: number): { allocations: { invoiceId: string; amount: number }[]; excess: number } {
  let left = amount;
  const allocations: { invoiceId: string; amount: number }[] = [];
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(left, r.outstandingAmount);
    if (take > 0) {
      allocations.push({ invoiceId: r.id, amount: take });
      left -= take;
    }
  }
  return { allocations, excess: left };
}

/** Faktur terbaru untuk rit & jenis (idempotensi handler). */
export async function invoiceForTrip(tx: Tx, tripId: string, kind: InvoiceKind): Promise<InvoiceRow | null> {
  const rows = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.tripId, tripId), eq(invoices.kind, kind)))
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export { invoiceLink };
