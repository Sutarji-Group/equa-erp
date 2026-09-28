/**
 * M3 — pembayaran per rit (US-M3-04, PTB-18/19, BR-19) & permintaan tunai → tempo di lokasi (6.2a
 * `field_payment_to_credit`, penyetuju Dispatcher). Pembayaran adalah bagian dari Selesai (tidak dapat dilewati);
 * harga = harga pesanan, sopir hanya memasukkan uang fisik / jumlah transfer / memilih cara bayar.
 */
import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";
import type { z } from "zod";

import { approvalRequests, bankAccounts, tripPayments, trips } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { label } from "@/lib/labels";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { systemContext, type ActorContext } from "@/server/core/context";
import { DomainError, ValidationError, parseInput } from "@/server/core/errors";
import { evaluateCreditOrder } from "@/server/modules/m2-orders";

import type { paymentSchema } from "../schemas";
import { fieldCreditSchema } from "../schemas";
import {
  assertActingOnTruck,
  attachmentsOfKind,
  ensureRunningDeposit,
  loadTripContext,
  m3Rules,
  requireTextReason,
  tripConflictNote,
  type M3WriteMeta,
  type TripContext,
} from "./common";

export type TripPaymentRow = typeof tripPayments.$inferSelect;

export type ResolvedPayment = {
  method: "cash" | "transfer" | "credit";
  expected: number;
  received: number;
  underpayment: number;
  underpaymentReason: string | null;
  originalMethod: "cash" | "transfer" | "credit" | null;
  approvalId: string | null;
  transferProofAttachmentId: string | null;
  /** Permintaan tempo tidak disetujui / luring → dicatat kurang bayar (US-M3-04 KP-4). */
  convertedToUnderpayment: boolean;
};

type PaymentInput = z.output<typeof paymentSchema>;

/** Rekening PT yang ditampilkan ke pelanggan (US-M3-04 KP-3). */
export async function customerFacingBankAccounts(tx: M3WriteMeta["tx"], tenantId: string) {
  return tx
    .select({ id: bankAccounts.id, bankName: bankAccounts.bankName, accountNumber: bankAccounts.accountNumber, accountName: bankAccounts.accountName })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.tenantId, tenantId), eq(bankAccounts.isCustomerFacing, true), eq(bankAccounts.isActive, true)))
    .orderBy(asc(bankAccounts.bankName));
}

/**
 * Tentukan pembayaran rit dari input perangkat (US-M3-04 KP-1..KP-4): tunai (≤ harga; kurang → alasan → kurang bayar),
 * transfer (foto bukti wajib; ≤ harga), tempo (pesanan tempo, atau tunai → tempo yang DISETUJUI Dispatcher;
 * selain itu kurang bayar). Tempo → tunai/transfer selalu boleh. Harga tidak pernah diambil dari perangkat.
 */
export async function resolvePayment(ctx: ActorContext, tc: TripContext, input: PaymentInput, meta: M3WriteMeta): Promise<ResolvedPayment> {
  const { trip } = tc;
  const price = trip.price;
  const orderMethod = trip.paymentMethod as "cash" | "transfer" | "credit";
  if (input.method === "none") throw new DomainError("PAYMENT_REQUIRED", "Pembayaran wajib dicatat sebelum rit Selesai (tunai, transfer, atau tempo).");
  const tooMuch = (what: string) =>
    ValidationError.field("payment", `${what} lebih besar dari harga rit ${formatRupiah(price)} tidak dapat dicatat — berikan kembalian di lapangan.`);

  if (input.method === "cash") {
    if (input.cashReceived > price) throw tooMuch("Tunai");
    const under = price - input.cashReceived;
    const reason = under > 0 ? requireTextReason(input.underpaymentReasonCode, input.underpaymentReasonText, "underpaymentReason", "Tunai kurang dari harga: pilih alasan kurang bayar") : null;
    return {
      method: "cash",
      expected: price,
      received: input.cashReceived,
      underpayment: under,
      underpaymentReason: reason,
      originalMethod: orderMethod !== "cash" ? orderMethod : null,
      approvalId: null,
      transferProofAttachmentId: null,
      convertedToUnderpayment: false,
    };
  }
  if (input.method === "transfer") {
    if (input.transferAmount <= 0) throw ValidationError.field("payment", "Isi jumlah transfer sesuai bukti.");
    if (input.transferAmount > price) throw tooMuch("Jumlah transfer");
    const proof = attachmentsOfKind(meta, "transfer_proof")[0];
    if (!proof && !meta.office) throw new DomainError("TRANSFER_PROOF_REQUIRED", "Foto bukti transfer wajib. Ambil foto bukti transfer dari ponsel pelanggan lalu simpan lagi.");
    const under = price - input.transferAmount;
    const reason = under > 0 ? requireTextReason(input.underpaymentReasonCode, input.underpaymentReasonText, "underpaymentReason", "Transfer kurang dari harga: pilih alasan kurang bayar") : null;
    return {
      method: "transfer",
      expected: price,
      received: input.transferAmount,
      underpayment: under,
      underpaymentReason: reason,
      originalMethod: orderMethod !== "transfer" ? orderMethod : null,
      approvalId: null,
      transferProofAttachmentId: proof?.id ?? null,
      convertedToUnderpayment: false,
    };
  }
  // Tempo.
  if (orderMethod === "credit") {
    return {
      method: "credit",
      expected: price,
      received: 0,
      underpayment: 0,
      underpaymentReason: null,
      originalMethod: null,
      approvalId: null,
      transferProofAttachmentId: null,
      convertedToUnderpayment: false,
    };
  }
  // Tunai → tempo: hanya dengan persetujuan Dispatcher yang sudah diputuskan (PTB-19).
  const approval = await fieldCreditApprovalFor(meta.tx, trip.id, input.creditApprovalId ?? null);
  if (approval?.status === "approved") {
    return {
      method: "credit",
      expected: price,
      received: 0,
      underpayment: 0,
      underpaymentReason: null,
      originalMethod: orderMethod,
      approvalId: approval.id,
      transferProofAttachmentId: null,
      convertedToUnderpayment: false,
    };
  }
  if (approval?.status === "submitted") {
    // Belum diputuskan saat rit dicatat → gugur; kekurangan dicatat kurang bayar (6.2a "Bila lewat tenggat").
    const cancelCtx = meta.office || ctx.userId !== approval.requesterUserId ? systemContext({ tenantId: trip.tenantId, now: ctx.now }) : ctx;
    await approvals.cancel(cancelCtx, approval.id, "Rit dicatat kurang bayar sebelum permintaan tempo diputuskan (PTB-19).", { tx: meta.tx });
  }
  const received = Math.min(price, input.cashReceivedIfRejected ?? 0);
  return {
    method: "cash",
    expected: price,
    received,
    underpayment: price - received,
    underpaymentReason: `credit_not_approved: ${approval ? `permintaan ${approval.number} ${label("approval_status", approval.status === "submitted" ? "cancelled" : approval.status)}` : "tanpa persetujuan Dispatcher (luring)"}`,
    originalMethod: null,
    approvalId: approval?.id ?? null,
    transferProofAttachmentId: null,
    convertedToUnderpayment: true,
  };
}

/** Permintaan `field_payment_to_credit` untuk rit (id tertentu atau yang terbaru). */
export async function fieldCreditApprovalFor(tx: M3WriteMeta["tx"], tripId: string, approvalId: string | null) {
  const rows = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.type, "field_payment_to_credit"),
        eq(approvalRequests.objectType, "trip"),
        eq(approvalRequests.objectId, tripId),
        ...(approvalId ? [eq(approvalRequests.id, approvalId)] : []),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Simpan pembayaran rit (satu pembayaran hidup per rit — indeks unik `trip_payments_live_uq`). */
export async function insertTripPayment(
  ctx: ActorContext,
  tc: TripContext,
  pay: ResolvedPayment,
  meta: M3WriteMeta,
  input: { driverUserId: string; fieldValues: Record<string, unknown>; today: string },
): Promise<{ payment: TripPaymentRow; depositId: string | null }> {
  const tx = meta.tx;
  let depositId: string | null = null;
  if (pay.method === "cash" && pay.received > 0) {
    const { deposit } = await ensureRunningDeposit(tx, ctx, {
      tenantId: tc.trip.tenantId,
      userId: input.driverUserId,
      date: meta.businessDate,
      truckId: tc.trip.truckId,
      today: input.today,
    });
    depositId = deposit.id;
  }
  const [payment] = await tx
    .insert(tripPayments)
    .values({
      tenantId: tc.trip.tenantId,
      tripId: tc.trip.id,
      customerId: tc.trip.customerId,
      driverUserId: input.driverUserId,
      method: pay.method,
      expectedAmount: pay.expected,
      receivedAmount: pay.received,
      underpaymentAmount: pay.underpayment,
      underpaymentReason: pay.underpaymentReason,
      transferProofAttachmentId: pay.transferProofAttachmentId,
      originalMethod: pay.originalMethod,
      methodChangeApprovalId: pay.method === "credit" ? pay.approvalId : null,
      depositId,
      businessDate: meta.businessDate,
      createdBy: ctx.userId,
      ...input.fieldValues,
    })
    .returning();
  await auditRecord(tx, {
    ctx,
    objectType: "trip_payment",
    objectId: payment!.id,
    action: "create",
    after: {
      tripId: tc.trip.id,
      tripNumber: tc.trip.number,
      method: pay.method,
      expectedAmount: pay.expected,
      receivedAmount: pay.received,
      underpaymentAmount: pay.underpayment,
      originalMethod: pay.originalMethod,
      recordedByOffice: !!meta.office,
    },
    reason: pay.underpaymentReason ?? meta.office?.reason ?? null,
    rule: pay.underpayment > 0 ? "PTB-18" : pay.originalMethod ? "PTB-19" : "US-M3-04",
    businessDate: meta.businessDate,
  });
  return { payment: payment!, depositId };
}

// =====================================================================================================================
// Permintaan tunai → tempo di lokasi (PTB-19)
// =====================================================================================================================

/**
 * Ajukan ubah cara bayar tunai → tempo (US-M3-04 KP-4): hanya saat daring (perintah yang tiba terlambat > aturan
 * ditolak), hanya pesanan tunai/transfer untuk pelanggan berstatus Tempo & dalam batas kredit (BR-06; kontrol M2).
 * Penyetuju Dispatcher; tenggat singkat "saat di lokasi". Pelanggan Tunai tidak pernah menjadi tempo di lapangan.
 */
export async function requestFieldCredit(ctx: ActorContext, input: unknown, meta: M3WriteMeta) {
  const data = parseInput(fieldCreditSchema, input, { tripId: "Rit", reason: "Alasan" });
  const tx = meta.tx;
  const tc = await loadTripContext(tx, data.tripId, { forUpdate: true });
  const { trip } = tc;
  await tripConflictNote(tx, ctx, trip, meta);
  await assertActingOnTruck(tx, ctx, "m3.field_credit.request", trip.truckId, meta.businessDate, meta);
  const rules = await m3Rules(tx, meta.businessDate, trip.tenantId);
  const delayMs = meta.receivedAt.getTime() - meta.deviceTime.getTime();
  if (delayMs > rules.fieldCreditMaxDelayMinutes * 60_000) {
    throw new DomainError(
      "FIELD_CREDIT_OFFLINE",
      "Permintaan tempo hanya dapat diajukan saat ada sinyal. Catat kekurangan sebagai kurang bayar — Admin Keuangan dapat mengubahnya menjadi tempo setelah pemeriksaan batas.",
    );
  }
  if (trip.isInternal) throw new DomainError("INTERNAL_TRIP", "Rit internal pasokan depot tidak memiliki pembayaran.");
  if (trip.paymentMethod === "credit") throw new DomainError("ALREADY_CREDIT", "Pesanan ini sudah bercara-bayar tempo.");
  if (!["departed", "arrived"].includes(trip.status)) throw new DomainError("TRIP_STATUS", "Permintaan tempo diajukan saat rit Berangkat/Tiba di lokasi pelanggan.");
  if (tc.customer.creditStatus !== "credit" && tc.customer.creditStatus !== "credit_migrated") {
    throw new DomainError(
      "CUSTOMER_NOT_CREDIT",
      `${tc.customer.name} berstatus ${label("credit_status", tc.customer.creditStatus)} — tidak dapat tempo di lapangan. Terima tunai/transfer atau catat kurang bayar.`,
    );
  }
  const check = await evaluateCreditOrder(tx, trip.customerId, trip.price);
  if (!check.ok) {
    throw new DomainError("CREDIT_LIMIT", `Tempo tidak dapat diajukan: ${check.message} Terima tunai/transfer atau catat kurang bayar.`);
  }
  const deadlineAt = new Date(ctx.now.getTime() + rules.fieldCreditWaitMinutes * 60_000);
  const approval = await approvals.submit(
    ctx,
    {
      type: "field_payment_to_credit",
      objectType: "trip",
      objectId: trip.id,
      amount: trip.price,
      reason: data.reason,
      deadlineAt,
      businessDate: meta.businessDate,
      payload: {
        tripId: trip.id,
        tripNumber: trip.number,
        orderId: trip.orderId,
        customerId: trip.customerId,
        customerName: tc.customer.name,
        price: trip.price,
        truckCode: tc.truck?.code ?? null,
        link: `/jadwal?tanggal=${trip.scheduledDate}`,
      },
    },
    { tx },
  );
  await tx.update(trips).set({ updatedAt: ctx.now }).where(eq(trips.id, trip.id));
  return { approval };
}
