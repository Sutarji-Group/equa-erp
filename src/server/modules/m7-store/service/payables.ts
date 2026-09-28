/**
 * M7 — utang pemasok & pembayaran (US-M7-08; FR-M7-06, FR-M11-07).
 *
 * - Nota pembelian yang belum dibayar = utang dengan jatuh tempo (dari nota; kosong → tanggal nota + tempo pemasok,
 *   bila kosong PAR-67). Sisa utang = total − dibayar − retur/pembalik. Daftar per pemasok & umur; pengingat ke Admin
 *   Keuangan (job, `supplier_payable.due`).
 * - Pembayaran (kas kantor / transfer; bukti WAJIB untuk transfer) dialokasikan ke nota — sebagian/penuh. Koreksi =
 *   pembalik beralasan (alokasi append-only; > PAR-21 lewat persetujuan `correction`, BR-38).
 * - `supplier_payment.recorded` → M4 (kas kantor/transfer keluar) & M11 (utang usaha).
 */
import "server-only";

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { attachments, notifications, outlets, purchaseReceipts, supplierPaymentAllocations, supplierPayments, suppliers } from "@/db/schema";
import { formatRupiah, zRupiahPositive } from "@/lib/money";
import { addDays, daysBetween, formatTanggal, isBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { storeRules } from "./common";

type PaymentRow = typeof supplierPayments.$inferSelect;

export type ReceiptBalance = { total: number; paid: number; returned: number; outstanding: number };

/** Sisa utang per nota (total − dibayar − retur/pembalik). */
export async function receiptBalances(tx: Tx, receiptIds: readonly string[]): Promise<Map<string, ReceiptBalance>> {
  const out = new Map<string, ReceiptBalance>();
  if (!receiptIds.length) return out;
  const rows = await tx.select().from(purchaseReceipts).where(inArray(purchaseReceipts.id, [...receiptIds]));
  const reversals = await tx
    .select({ of: purchaseReceipts.reversalOfId, total: sql<string>`coalesce(sum(${purchaseReceipts.totalAmount}), 0)` })
    .from(purchaseReceipts)
    .where(inArray(purchaseReceipts.reversalOfId, [...receiptIds]))
    .groupBy(purchaseReceipts.reversalOfId);
  const returned = new Map(reversals.map((r) => [r.of!, -Number(r.total)]));
  for (const r of rows) {
    const ret = returned.get(r.id) ?? 0;
    out.set(r.id, { total: r.totalAmount, paid: r.paidAmount, returned: ret, outstanding: Math.max(0, r.totalAmount - r.paidAmount - ret) });
  }
  return out;
}

/** Hitung ulang status bayar nota dari sisa utang. */
export async function refreshPaymentStatus(tx: Tx, receiptId: string): Promise<ReceiptBalance> {
  const bal = (await receiptBalances(tx, [receiptId])).get(receiptId)!;
  const status = bal.outstanding <= 0 ? "paid" : bal.paid > 0 ? "partial" : "unpaid";
  await tx.update(purchaseReceipts).set({ paymentStatus: status, updatedAt: new Date() }).where(eq(purchaseReceipts.id, receiptId));
  return bal;
}

/** Jatuh tempo nota: dari nota; kosong → tanggal nota + tempo pemasok, bila kosong PAR-67 (US-M7-08 KP-1). */
export async function payableDueDate(tx: Tx, input: { explicit?: string | null; noteDate?: string | null; businessDate: BusinessDate; supplierTermDays: number | null }): Promise<BusinessDate> {
  if (input.explicit && isBusinessDate(input.explicit)) return input.explicit;
  const base = input.noteDate && isBusinessDate(input.noteDate) ? input.noteDate : input.businessDate;
  const days = input.supplierTermDays ?? (await params.get(tx, "PAR-67", input.businessDate)).days;
  return addDays(base, days);
}

export type AgingBucket = "not_due" | "d1_7" | "d8_30" | "over_30";
export const AGING_LABELS: Record<AgingBucket, string> = { not_due: "Belum jatuh tempo", d1_7: "1–7 hari", d8_30: "8–30 hari", over_30: "> 30 hari" };

export function agingBucket(dueDate: string | null, asOf: BusinessDate): { bucket: AgingBucket; daysOverdue: number } {
  if (!dueDate) return { bucket: "not_due", daysOverdue: 0 };
  const d = daysBetween(dueDate, asOf);
  if (d <= 0) return { bucket: "not_due", daysOverdue: 0 };
  return { bucket: d <= 7 ? "d1_7" : d <= 30 ? "d8_30" : "over_30", daysOverdue: d };
}

export type PayableRow = {
  receiptId: string;
  number: string | null;
  supplierId: string;
  supplierName: string;
  outletName: string;
  supplierNoteNumber: string | null;
  supplierNoteDate: string | null;
  businessDate: string;
  dueDate: string | null;
  isOpeningPayable: boolean;
  total: number;
  paid: number;
  returned: number;
  outstanding: number;
  daysOverdue: number;
  bucket: AgingBucket;
  bucketLabel: string;
};

/** Nota yang masih berutang (tanpa otorisasi — pemanggil sudah berizin). */
export async function payableRows(tx: Tx, tenantId: string, asOf: BusinessDate, filter: { supplierId?: string | null; includePaid?: boolean } = {}): Promise<PayableRow[]> {
  const conds = [eq(purchaseReceipts.tenantId, tenantId), eq(purchaseReceipts.status, "received"), isNull(purchaseReceipts.reversalOfId)];
  if (filter.supplierId) conds.push(eq(purchaseReceipts.supplierId, filter.supplierId));
  if (!filter.includePaid) conds.push(ne(purchaseReceipts.paymentStatus, "paid"));
  const rows = await tx
    .select({ r: purchaseReceipts, supplierName: suppliers.name, outletName: outlets.name })
    .from(purchaseReceipts)
    .innerJoin(suppliers, eq(suppliers.id, purchaseReceipts.supplierId))
    .innerJoin(outlets, eq(outlets.id, purchaseReceipts.outletId))
    .where(and(...conds))
    .orderBy(asc(purchaseReceipts.dueDate), asc(purchaseReceipts.createdAt));
  const bal = await receiptBalances(
    tx,
    rows.map((r) => r.r.id),
  );
  return rows
    .map(({ r, supplierName, outletName }) => {
      const b = bal.get(r.id)!;
      const ag = agingBucket(r.dueDate, asOf);
      return {
        receiptId: r.id,
        number: r.number,
        supplierId: r.supplierId,
        supplierName,
        outletName,
        supplierNoteNumber: r.supplierNoteNumber,
        supplierNoteDate: r.supplierNoteDate,
        businessDate: r.businessDate,
        dueDate: r.dueDate,
        isOpeningPayable: r.isOpeningPayable,
        total: b.total,
        paid: b.paid,
        returned: b.returned,
        outstanding: b.outstanding,
        daysOverdue: ag.daysOverdue,
        bucket: ag.bucket,
        bucketLabel: AGING_LABELS[ag.bucket],
      };
    })
    .filter((r) => filter.includePaid || r.outstanding > 0);
}

/** Ringkasan utang per pemasok. */
export async function payableSummaryBySupplier(tx: Tx, tenantId: string, asOf: BusinessDate): Promise<Map<string, { outstanding: number; openNotes: number; overdue: number }>> {
  const rows = await payableRows(tx, tenantId, asOf);
  const out = new Map<string, { outstanding: number; openNotes: number; overdue: number }>();
  for (const r of rows) {
    const cur = out.get(r.supplierId) ?? { outstanding: 0, openNotes: 0, overdue: 0 };
    cur.outstanding += r.outstanding;
    cur.openNotes += 1;
    if (r.daysOverdue > 0) cur.overdue += r.outstanding;
    out.set(r.supplierId, cur);
  }
  return out;
}

export type SupplierAgingRow = { supplierId: string; supplierName: string; total: number } & Record<AgingBucket, number>;

/** Daftar utang (izin `m7.supplier_payable.read`): per nota + per pemasok & umur (US-M7-08 KP-1). */
export async function listPayables(ctx: ActorContext, filter: { supplierId?: string | null; asOf?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.supplier_payable.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const asOf = filter.asOf && isBusinessDate(filter.asOf) ? filter.asOf : ctxBusinessDate(ctx);
  const rows = await payableRows(tx, ctx.tenantId, asOf, { supplierId: filter.supplierId ?? null });
  const bySupplier = new Map<string, SupplierAgingRow>();
  for (const r of rows) {
    const cur = bySupplier.get(r.supplierId) ?? { supplierId: r.supplierId, supplierName: r.supplierName, total: 0, not_due: 0, d1_7: 0, d8_30: 0, over_30: 0 };
    cur.total += r.outstanding;
    cur[r.bucket] += r.outstanding;
    bySupplier.set(r.supplierId, cur);
  }
  return { asOf, rows, bySupplier: [...bySupplier.values()].sort((a, b) => b.total - a.total), total: rows.reduce((s, r) => s + r.outstanding, 0) };
}

// =====================================================================================================================
// Pembayaran pemasok (Admin Keuangan) — US-M7-08 KP-2
// =====================================================================================================================

export const supplierPaymentSchema = z
  .object({
    supplierId: z.uuid({ error: "Pilih pemasok." }),
    amount: zRupiahPositive,
    method: z.enum(["cash", "transfer"], { error: "Pilih cara bayar: kas kantor atau transfer." }),
    businessDate: z.string().refine(isBusinessDate, { error: "Tanggal bayar harus YYYY-MM-DD." }).nullable().optional(),
    bankAccountId: z.uuid().nullable().optional(),
    proofAttachmentId: z.uuid().nullable().optional(),
    /** Alokasi ke nota; kosong = otomatis ke nota jatuh tempo paling awal. */
    allocations: z.array(z.object({ purchaseReceiptId: z.uuid(), amount: zRupiahPositive }).strict()).max(50).optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export type SupplierPaymentInput = z.input<typeof supplierPaymentSchema>;

export async function recordSupplierPayment(ctx: ActorContext, input: SupplierPaymentInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.supplier_payment.create", { tx: opts.tx, objectType: "supplier_payment" });
  const data = parseInput(supplierPaymentSchema, input, { amount: "Jumlah bayar", method: "Cara bayar", proofAttachmentId: "Bukti transfer" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const date = data.businessDate ?? today;
    if (date > today) throw new DomainError("DATE_IN_FUTURE", "Tanggal bayar tidak boleh setelah hari ini.");
    const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, data.supplierId)).limit(1);
    if (!sup || sup.tenantId !== ctx.tenantId) throw new NotFoundError("Pemasok tidak ditemukan.");
    if (data.method === "transfer") {
      if (!data.proofAttachmentId) throw new DomainError("PROOF_REQUIRED", "Bukti transfer wajib dilampirkan untuk pembayaran transfer.");
    }
    if (data.proofAttachmentId) {
      const [att] = await tx.select().from(attachments).where(eq(attachments.id, data.proofAttachmentId)).limit(1);
      if (!att || att.tenantId !== ctx.tenantId) throw new NotFoundError("Bukti pembayaran tidak ditemukan. Unggah ulang.");
    }
    const open = await payableRows(tx, ctx.tenantId, date, { supplierId: sup.id });
    let allocations: { purchaseReceiptId: string; amount: number }[];
    if (data.allocations?.length) {
      allocations = data.allocations;
      const byId = new Map(open.map((o) => [o.receiptId, o]));
      const seen = new Set<string>();
      for (const a of allocations) {
        const row = byId.get(a.purchaseReceiptId);
        if (!row) throw new DomainError("ALLOCATION_INVALID", "Nota yang dipilih bukan utang terbuka pemasok ini.");
        if (seen.has(a.purchaseReceiptId)) throw new DomainError("ALLOCATION_DUPLICATE", "Satu nota hanya boleh dialokasikan sekali per pembayaran.");
        seen.add(a.purchaseReceiptId);
        if (a.amount > row.outstanding) {
          throw new DomainError("ALLOCATION_TOO_LARGE", `Alokasi ${formatRupiah(a.amount)} melebihi sisa utang nota ${row.supplierNoteNumber ?? row.number} (${formatRupiah(row.outstanding)}).`);
        }
      }
      const sum = allocations.reduce((s, a) => s + a.amount, 0);
      if (sum !== data.amount) throw new DomainError("ALLOCATION_MISMATCH", `Jumlah alokasi ${formatRupiah(sum)} harus sama dengan jumlah bayar ${formatRupiah(data.amount)}.`);
    } else {
      const totalOpen = open.reduce((s, o) => s + o.outstanding, 0);
      if (data.amount > totalOpen) {
        throw new DomainError("PAYMENT_EXCEEDS_PAYABLE", `Pembayaran ${formatRupiah(data.amount)} melebihi total utang ke ${sup.name} (${formatRupiah(totalOpen)}).`);
      }
      let rest = data.amount;
      allocations = [];
      for (const o of open) {
        if (rest <= 0) break;
        const a = Math.min(rest, o.outstanding);
        allocations.push({ purchaseReceiptId: o.receiptId, amount: a });
        rest -= a;
      }
    }
    const [pay] = await tx
      .insert(supplierPayments)
      .values({
        tenantId: ctx.tenantId,
        supplierId: sup.id,
        businessDate: date,
        amount: data.amount,
        method: data.method,
        proofAttachmentId: data.proofAttachmentId ?? null,
        bankAccountId: data.bankAccountId ?? null,
        notes: data.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await tx.insert(supplierPaymentAllocations).values(allocations.map((a) => ({ supplierPaymentId: pay!.id, purchaseReceiptId: a.purchaseReceiptId, amount: a.amount, createdBy: ctx.userId })));
    for (const a of allocations) {
      await tx
        .update(purchaseReceipts)
        .set({ paidAmount: sql`${purchaseReceipts.paidAmount} + ${a.amount}` })
        .where(eq(purchaseReceipts.id, a.purchaseReceiptId));
      await refreshPaymentStatus(tx, a.purchaseReceiptId);
    }
    if (data.proofAttachmentId) await linkAttachment(tx, data.proofAttachmentId, { type: "supplier_payment", id: pay!.id });
    await auditRecord(tx, {
      ctx,
      objectType: "supplier_payment",
      objectId: pay!.id,
      action: "create",
      after: { supplier: sup.name, amount: data.amount, method: data.method, businessDate: date, allocations },
      reason: data.notes ?? null,
    });
    await emit(
      tx,
      "supplier_payment.recorded",
      { supplierPaymentId: pay!.id, supplierId: sup.id, amount: data.amount, method: data.method, businessDate: date, bankAccountId: data.bankAccountId ?? null, allocations },
      { ctx, objectType: "supplier_payment", objectId: pay!.id, businessDate: date },
    );
    return { payment: pay!, allocations };
  });
}

// --- Pembalik pembayaran keliru (BR-38) -------------------------------------------------------------------------------

const reversePaymentSchema = z.object({
  paymentId: z.uuid(),
  reason: z.string().trim().min(5, { error: "Alasan pembalik wajib diisi (minimal 5 karakter)." }).max(300),
});

async function applyPaymentReversal(tx: Tx, ctx: ActorContext, pay: PaymentRow, reason: string, approvalId: string | null, createdBy: string | null) {
  const allocs = await tx.select().from(supplierPaymentAllocations).where(and(eq(supplierPaymentAllocations.supplierPaymentId, pay.id), isNull(supplierPaymentAllocations.reversalOfId)));
  const [rev] = await tx
    .insert(supplierPayments)
    .values({
      tenantId: pay.tenantId,
      supplierId: pay.supplierId,
      businessDate: ctxBusinessDate(ctx),
      amount: -pay.amount,
      method: pay.method,
      bankAccountId: pay.bankAccountId,
      notes: `Pembalik: ${reason}`,
      reversalOfId: pay.id,
      createdBy,
    })
    .returning();
  for (const a of allocs) {
    await tx.insert(supplierPaymentAllocations).values({
      supplierPaymentId: rev!.id,
      purchaseReceiptId: a.purchaseReceiptId,
      amount: -a.amount,
      reversalOfId: a.id,
      reversalReason: reason,
      correctionApprovalId: approvalId,
      createdBy,
    });
    await tx
      .update(purchaseReceipts)
      .set({ paidAmount: sql`${purchaseReceipts.paidAmount} - ${a.amount}` })
      .where(eq(purchaseReceipts.id, a.purchaseReceiptId));
    await refreshPaymentStatus(tx, a.purchaseReceiptId);
  }
  await auditRecord(tx, { ctx, objectType: "supplier_payment", objectId: pay.id, action: "reverse", after: { reversalId: rev!.id, amount: -pay.amount }, reason, rule: approvalId ? "6.2a" : "BR-38" });
  await emit(
    tx,
    "supplier_payment.recorded",
    {
      supplierPaymentId: rev!.id,
      supplierId: pay.supplierId,
      amount: -pay.amount,
      method: pay.method === "transfer" ? "transfer" : "cash",
      businessDate: ctxBusinessDate(ctx),
      bankAccountId: pay.bankAccountId,
      reversalOfId: pay.id,
      reason,
      allocations: allocs.map((a) => ({ purchaseReceiptId: a.purchaseReceiptId, amount: -a.amount })),
    },
    { ctx, tenantId: pay.tenantId, objectType: "supplier_payment", objectId: rev!.id },
  );
  return rev!;
}

/** Balik pembayaran keliru (≤ PAR-21 langsung; di atasnya persetujuan pemilik `correction`). */
export async function reverseSupplierPayment(ctx: ActorContext, input: z.input<typeof reversePaymentSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.supplier_payment.reverse", { tx: opts.tx, objectType: "supplier_payment", objectId: input.paymentId });
  const data = parseInput(reversePaymentSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const [pay] = await tx.select().from(supplierPayments).where(eq(supplierPayments.id, data.paymentId)).for("update").limit(1);
    if (!pay || pay.tenantId !== ctx.tenantId) throw new NotFoundError("Pembayaran tidak ditemukan.");
    if (pay.reversalOfId || pay.amount < 0) throw new DomainError("REVERSAL_OF_REVERSAL", "Pembalik tidak dapat dibalik lagi.");
    const [already] = await tx.select({ id: supplierPayments.id }).from(supplierPayments).where(eq(supplierPayments.reversalOfId, pay.id)).limit(1);
    if (already) throw new DomainError("ALREADY_REVERSED", "Pembayaran ini sudah dibalik.");
    const limit = await params.get(tx, "PAR-21", ctxBusinessDate(ctx));
    if (pay.amount > limit.amount_gt) {
      const req = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "supplier_payment",
          objectId: pay.id,
          amount: pay.amount,
          reason: `Pembalik pembayaran pemasok ${formatRupiah(pay.amount)} (${formatTanggal(pay.businessDate)}): ${data.reason}`,
          payload: { kind: "supplier_payment_reversal", reason: data.reason, link: "/toko/utang" },
        },
        { tx },
      );
      await auditRecord(tx, { ctx, objectType: "supplier_payment", objectId: pay.id, action: "request_reversal", after: { approvalId: req.id }, reason: data.reason, rule: "BR-38" });
      return { status: "pending_approval" as const, approval: req, reversal: null };
    }
    const rev = await applyPaymentReversal(tx, ctx, pay, data.reason, null, ctx.userId);
    return { status: "reversed" as const, approval: null, reversal: rev };
  });
}

export async function onPaymentReversalApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [pay] = await tx.select().from(supplierPayments).where(eq(supplierPayments.id, request.objectId)).for("update").limit(1);
  if (!pay) return { effect: "none" };
  const [already] = await tx.select({ id: supplierPayments.id }).from(supplierPayments).where(eq(supplierPayments.reversalOfId, pay.id)).limit(1);
  if (already) return { effect: "none" };
  const reason = String((request.payload as { reason?: string } | null)?.reason ?? request.reason);
  const rev = await applyPaymentReversal(tx, ctx, pay, reason, request.id, request.requesterUserId);
  return { effect: "reversed", reversalId: rev.id };
}

/** Riwayat pembayaran pemasok (izin `m7.supplier_payable.read`). */
export async function listSupplierPayments(ctx: ActorContext, filter: { supplierId?: string | null; limit?: number } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.supplier_payable.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ p: supplierPayments, supplierName: suppliers.name })
    .from(supplierPayments)
    .innerJoin(suppliers, eq(suppliers.id, supplierPayments.supplierId))
    .where(and(eq(supplierPayments.tenantId, ctx.tenantId), ...(filter.supplierId ? [eq(supplierPayments.supplierId, filter.supplierId)] : [])))
    .orderBy(sql`${supplierPayments.businessDate} desc, ${supplierPayments.createdAt} desc`)
    .limit(filter.limit ?? 100);
  const ids = rows.map((r) => r.p.id);
  const allocs = ids.length
    ? await tx
        .select({ a: supplierPaymentAllocations, noteNumber: purchaseReceipts.supplierNoteNumber, number: purchaseReceipts.number })
        .from(supplierPaymentAllocations)
        .innerJoin(purchaseReceipts, eq(purchaseReceipts.id, supplierPaymentAllocations.purchaseReceiptId))
        .where(inArray(supplierPaymentAllocations.supplierPaymentId, ids))
    : [];
  const reversedIds = new Set(rows.filter((r) => r.p.reversalOfId).map((r) => r.p.reversalOfId!));
  return rows.map(({ p, supplierName }) => ({
    ...p,
    supplierName,
    reversed: reversedIds.has(p.id),
    allocations: allocs.filter((a) => a.a.supplierPaymentId === p.id).map((a) => ({ receiptId: a.a.purchaseReceiptId, amount: a.a.amount, note: a.noteNumber ?? a.number })),
  }));
}

// =====================================================================================================================
// Pengingat jatuh tempo (job harian) — Bab 6.3 / US-M7-08 KP-1
// =====================================================================================================================

export async function runPayableReminders(now: Date, db: Tx): Promise<{ tenants: number; notified: number }> {
  const today = ctxBusinessDate(systemContext({ now }));
  const tenants = await db.selectDistinct({ tenantId: purchaseReceipts.tenantId }).from(purchaseReceipts).where(and(eq(purchaseReceipts.status, "received"), ne(purchaseReceipts.paymentStatus, "paid")));
  let notified = 0;
  for (const { tenantId } of tenants) {
    const rules = await storeRules(db, today, tenantId);
    const horizon = addDays(today, rules.payable_reminder_days_before);
    const rows = (await payableRows(db, tenantId, today)).filter((r) => r.dueDate !== null && r.dueDate <= horizon);
    if (!rows.length) continue;
    const groupKey = `supplier_payable.due:${tenantId}:${today}`;
    const [dup] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.groupKey, groupKey), eq(notifications.tenantId, tenantId))).limit(1);
    if (dup) continue;
    const overdue = rows.filter((r) => r.daysOverdue > 0);
    const total = rows.reduce((s, r) => s + r.outstanding, 0);
    await notify(db, {
      event: "supplier_payable.due",
      tenantId,
      title: `${rows.length} nota pemasok jatuh tempo ≤ ${rules.payable_reminder_days_before} hari${overdue.length ? ` (${overdue.length} lewat)` : ""}`,
      body: `Total ${formatRupiah(total)}: ${rows
        .slice(0, 5)
        .map((r) => `${r.supplierName} ${r.supplierNoteNumber ?? r.number} ${formatRupiah(r.outstanding)} jatuh tempo ${r.dueDate}`)
        .join("; ")}${rows.length > 5 ? "; …" : ""}. Jadwalkan pembayaran di Utang pemasok.`,
      valueAmount: total,
      link: "/toko/utang",
      groupKey,
      now,
    });
    notified++;
  }
  return { tenants: tenants.length, notified };
}

/** Nota berutang lewat jatuh tempo untuk tampilan ringkas. */
export async function overduePayables(tx: Tx, tenantId: string, asOf: BusinessDate) {
  return (await payableRows(tx, tenantId, asOf)).filter((r) => r.daysOverdue > 0);
}
