/**
 * M3 — pelunasan piutang lewat sopir (US-M3-05, BR-07, FR-M5-03, P-05 langkah 3): hanya pelanggan rit hari itu;
 * faktur terbuka dari data sinkron terakhir (kurang bayar paling atas, "tagih kurang bayar"); alokasi ke faktur TERPILIH
 * dari yang tertua; sebagian boleh; tunai menambah kas di tangan & setoran hari itu; transfer = foto bukti.
 * Disimpan sebagai `customer_payments` (channel `driver`) + `payment_allocations`; event `collection.recorded` → M5
 * menerapkan ke faktur tanpa input ulang Admin Keuangan. Kelebihan di atas sisa (data kantor berubah sementara
 * perangkat luring) → uang muka pelanggan (bukan ditolak — lapangan tidak ditimpa kantor).
 */
import "server-only";

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { customerPayments, customers, invoices, paymentAllocations, trips } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { toBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { linkAttachment } from "@/server/core/storage";

import { allocateOldestFirst, sortInvoicesForCollection, type M3InvoiceRef } from "@/client/m3-driver/contract";

import { collectionSchema } from "../schemas";
import { assertActingOnTruck, attachmentsOfKind, ensureRunningDeposit, fieldValues, loadTrip, type M3WriteMeta } from "./common";

/** Jenis faktur lini truk (profit center L2) untuk pelunasan lewat sopir. */
const TRUCK_INVOICE_KINDS = new Set(["underpayment", "delivery", "monthly"]);

/**
 * Faktur terbuka pelanggan dengan SISA EFEKTIF: `outstanding_amount` dikurangi alokasi yang sudah tercatat tetapi
 * belum diterapkan M5 ke faktur (min kedua cara hitung) — pelunasan sopir langsung mengurangi sisa di perangkat.
 */
export async function openInvoicesFor(tx: Tx, customerIds: readonly string[]): Promise<M3InvoiceRef[]> {
  if (customerIds.length === 0) return [];
  const rows = await tx
    .select({
      id: invoices.id,
      number: invoices.number,
      kind: invoices.kind,
      customerId: invoices.customerId,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      amount: invoices.amount,
      credited: invoices.creditedAmount,
      writtenOff: invoices.writtenOffAmount,
      outstanding: invoices.outstandingAmount,
      allocated: sql<number>`coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = "invoices"."id"), 0)::bigint`,
    })
    .from(invoices)
    .where(and(inArray(invoices.customerId, [...customerIds]), gt(invoices.outstandingAmount, 0)));
  const out: M3InvoiceRef[] = [];
  for (const r of rows) {
    const byAlloc = r.amount - r.credited - r.writtenOff - Number(r.allocated);
    const outstanding = Math.max(0, Math.min(r.outstanding, byAlloc));
    if (outstanding <= 0) continue;
    out.push({
      id: r.id,
      number: r.number,
      kind: r.kind,
      customerId: r.customerId,
      issueDate: r.issueDate,
      dueDate: r.dueDate,
      outstanding,
      isUnderpayment: r.kind === "underpayment",
    });
  }
  return sortInvoicesForCollection(out);
}

export type CollectionResult = {
  payment: typeof customerPayments.$inferSelect;
  allocations: { invoiceId: string; amount: number }[];
  advanceAmount: number;
  conflict: string | null;
  duplicate: boolean;
};

export async function recordCollection(ctx: ActorContext, input: unknown, meta: M3WriteMeta, opts: { actingUserId?: string } = {}): Promise<CollectionResult> {
  const data = parseInput(collectionSchema, input, { amount: "Jumlah pelunasan", invoiceIds: "Faktur", method: "Cara bayar" });
  const tx = meta.tx;
  const actingUserId = opts.actingUserId ?? ctx.userId!;
  const existing = await tx.select().from(customerPayments).where(eq(customerPayments.id, data.paymentId)).limit(1);
  if (existing[0]) {
    const allocs = await tx.select({ invoiceId: paymentAllocations.invoiceId, amount: paymentAllocations.amount }).from(paymentAllocations).where(eq(paymentAllocations.customerPaymentId, data.paymentId));
    return { payment: existing[0], allocations: allocs, advanceAmount: existing[0].advanceAmount, conflict: null, duplicate: true };
  }
  const trip = await loadTrip(tx, data.tripId);
  if (trip.customerId !== data.customerId) throw new DomainError("CUSTOMER_MISMATCH", "Pelunasan hanya untuk pelanggan rit ini.");
  // US-M3-05 KP-4: hanya pelanggan pada rit hari itu.
  if (trip.scheduledDate !== meta.businessDate && trip.completionBusinessDate !== meta.businessDate) {
    throw new DomainError("NOT_TODAY_CUSTOMER", "Pelunasan hanya untuk pelanggan pada rit hari ini. Pelanggan lain melunasi lewat Admin Keuangan (kantor/transfer).");
  }
  if (trip.isInternal) throw new DomainError("INTERNAL_TRIP", "Rit internal pasokan depot tidak memiliki piutang pelanggan.");
  await assertActingOnTruck(tx, ctx, "m3.collection.create", trip.truckId, meta.businessDate, meta);

  const proof = attachmentsOfKind(meta, "collection_transfer_proof")[0] ?? attachmentsOfKind(meta, "transfer_proof")[0] ?? null;
  if (data.method === "transfer" && !proof && !meta.office) {
    throw new DomainError("TRANSFER_PROOF_REQUIRED", "Foto bukti transfer wajib untuk pelunasan transfer.");
  }
  // Kunci faktur pelanggan agar alokasi tidak berebut dengan kantor.
  await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.customerId, data.customerId), gt(invoices.outstandingAmount, 0))).for("update");
  const open = await openInvoicesFor(tx, [data.customerId]);
  const selected = open.filter((i) => data.invoiceIds.includes(i.id));
  const missing = data.invoiceIds.filter((id) => !selected.some((s) => s.id === id));
  const { allocations, excess } = allocateOldestFirst(selected, data.amount);
  const conflict =
    excess > 0 || missing.length > 0
      ? `Sisa faktur berubah sejak data terakhir di ponsel${missing.length ? ` (${missing.length} faktur sudah lunas)` : ""}; ${formatRupiah(excess)} dicatat sebagai uang muka pelanggan untuk ditinjau Admin Keuangan.`
      : null;

  let depositId: string | null = null;
  if (data.method === "cash") {
    const { deposit } = await ensureRunningDeposit(tx, ctx, { tenantId: trip.tenantId, userId: actingUserId, date: meta.businessDate, truckId: trip.truckId, today: toBusinessDate(ctx.now) });
    depositId = deposit.id;
  }
  const [payment] = await tx
    .insert(customerPayments)
    .values({
      id: data.paymentId,
      tenantId: trip.tenantId,
      customerId: data.customerId,
      channel: "driver",
      method: data.method,
      amount: data.amount,
      businessDate: meta.businessDate,
      proofAttachmentId: proof?.id ?? null,
      tripId: trip.id,
      driverUserId: actingUserId,
      depositId,
      advanceAmount: excess,
      notes: conflict,
      createdBy: ctx.userId,
      ...fieldValues(meta),
    })
    .returning();
  for (const a of allocations) {
    await tx.insert(paymentAllocations).values({ invoiceId: a.invoiceId, customerPaymentId: payment!.id, amount: a.amount, allocatedAt: meta.deviceTime, createdBy: ctx.userId });
  }
  if (proof) await linkAttachment(tx, proof.id, { type: "customer_payment", id: payment!.id });
  await tx.update(trips).set({ updatedAt: ctx.now }).where(eq(trips.id, trip.id));
  await auditRecord(tx, {
    ctx,
    objectType: "customer_payment",
    objectId: payment!.id,
    action: "create",
    after: { customerId: data.customerId, channel: "driver", method: data.method, amount: data.amount, allocations, advanceAmount: excess, tripId: trip.id, recordedByOffice: !!meta.office },
    reason: conflict ?? meta.office?.reason ?? null,
    rule: "BR-07, US-M3-05",
    businessDate: meta.businessDate,
  });
  const kinds = open.filter((i) => allocations.some((a) => a.invoiceId === i.id)).map((i) => i.kind);
  await emit(
    tx,
    "collection.recorded",
    {
      customerPaymentId: payment!.id,
      customerId: data.customerId,
      amount: data.amount,
      channel: "driver",
      method: data.method,
      allocations,
      advanceAmount: excess,
      driverUserId: actingUserId,
      profitCenter: kinds.length > 0 && kinds.every((k) => TRUCK_INVOICE_KINDS.has(k)) ? "L2" : null,
      tripId: trip.id,
      depositId,
      proofAttachmentId: proof?.id ?? null,
      businessDate: meta.businessDate,
      recordedByOffice: !!meta.office,
      lateSync: meta.lateSync,
    },
    { ctx, businessDate: meta.businessDate, objectType: "customer_payment", objectId: payment!.id },
  );
  return { payment: payment!, allocations, advanceAmount: excess, conflict, duplicate: false };
}

/** Pelunasan lewat sopir (tanggal & pengguna) untuk ringkasan setor / pull. */
export async function collectionsOf(tx: Tx, userId: string, date: string) {
  const rows = await tx
    .select({ p: customerPayments, customerName: customers.name })
    .from(customerPayments)
    .innerJoin(customers, eq(customers.id, customerPayments.customerId))
    .where(and(eq(customerPayments.channel, "driver"), eq(customerPayments.driverUserId, userId), eq(customerPayments.businessDate, date), isNull(customerPayments.reversalOfId)));
  const ids = rows.map((r) => r.p.id);
  const allocs = ids.length
    ? await tx
        .select({ paymentId: paymentAllocations.customerPaymentId, invoiceId: paymentAllocations.invoiceId, amount: paymentAllocations.amount, number: invoices.number })
        .from(paymentAllocations)
        .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
        .where(inArray(paymentAllocations.customerPaymentId, ids))
    : [];
  // Pembalik (Admin Keuangan) menetralkan pelunasan asal.
  const reversed = ids.length
    ? await tx.select({ id: customerPayments.reversalOfId }).from(customerPayments).where(and(inArray(customerPayments.reversalOfId, ids), or(eq(customerPayments.channel, "driver"), eq(customerPayments.channel, "office"))))
    : [];
  const reversedIds = new Set(reversed.map((r) => r.id));
  return rows
    .filter((r) => !reversedIds.has(r.p.id))
    .map((r) => ({
      id: r.p.id,
      customerId: r.p.customerId,
      customerName: r.customerName,
      tripId: r.p.tripId,
      method: r.p.method as "cash" | "transfer",
      amount: r.p.amount,
      allocations: allocs.filter((a) => a.paymentId === r.p.id).map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: a.number, amount: a.amount })),
      advanceAmount: r.p.advanceAmount,
      recordedAt: (r.p.deviceTime ?? r.p.createdAt).toISOString(),
    }));
}
