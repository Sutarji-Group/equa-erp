/**
 * M3 — KOREKSI rit & pembayaran rit oleh Admin Keuangan (tambahan S5, backlog B-34; FR-M3-07, US-M3-10 KP-2, BR-38,
 * 6.7). Rit Selesai terkunci di perangkat; perubahan hanya lewat layanan ini, beralasan, berjejak, dan:
 *
 * - `correctTrip` — harga rit (mis. penyesuaian volume parsial US-M3-03 KP-2) dan/atau volume terkirim. Selisih harga
 *   > PAR-21 → persetujuan pemilik jenis `correction` (objek `trip`) sebelum berlaku. Berlaku → `trips` diperbarui
 *   (nilai lama di jejak audit) + event `trip.corrected` { changes, priceDelta, volumeDeltaL, advanceAmount }.
 * - `reverseTripPayment` — pembayaran TUNAI/TRANSFER rit yang salah dibalik dengan baris pembalik bertanda negatif
 *   (`reversal_of_id`), baris asal ditandai `reversed_at` (tidak dihapus). > PAR-21 → persetujuan pemilik (objek
 *   `trip_payment`). Berlaku → event `trip_payment.reversed`. Tempo/digital tidak dibalik di sini (koreksi faktur /
 *   pelunasan di Piutang M5).
 *
 * Penerima event: M5 (faktur koreksi / nota kredit `trip_correction` / uang muka; faktur koreksi pembalik), M4
 * (transfer rit yang belum cocok dibatalkan), M11 (jurnal koreksi pendapatan / pembalik kas), M9 (addendum H+0).
 */
import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import { customers, deposits, tripPayments, trips } from "@/db/schema";
import { newId } from "@/lib/ids";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { tripOpenReceivable } from "@/server/modules/m5-receivables";

import { correctTripSchema, reverseTripPaymentSchema } from "../schemas";
import { loadTrip, type TripRow } from "./common";

type TripPaymentRow = typeof tripPayments.$inferSelect;

export type TripCorrectionTarget = { price: number | null; deliveredVolumeL: number | null };

export type TripCorrectionResult =
  | { status: "pending_approval"; approval: ApprovalRow; trip: TripRow }
  | { status: "corrected"; approval: null; trip: TripRow; priceDelta: number; volumeDeltaL: number; advanceAmount: number };

export type TripPaymentReversalResult =
  | { status: "pending_approval"; approval: ApprovalRow; reversal: null }
  | { status: "reversed"; approval: null; reversal: TripPaymentRow };

async function correctionLimit(tx: Tx, ctx: ActorContext): Promise<number> {
  return (await params.get(tx, "PAR-21", ctxBusinessDate(ctx))).amount_gt;
}

function assertCorrectable(trip: TripRow): void {
  if (trip.status !== "completed") {
    throw new DomainError("TRIP_NOT_COMPLETED", `Rit ${trip.number} berstatus ${label("trip_status", trip.status)} — hanya rit Selesai yang dikoreksi Admin Keuangan.`);
  }
  if (trip.isInternal) {
    throw new DomainError("TRIP_INTERNAL", `Rit ${trip.number} adalah rit internal pasokan depot — koreksi volume lewat penerimaan pasokan di depot (M6).`);
  }
}

/** Perubahan yang diminta dibandingkan nilai rit sekarang (kosong = tidak ada perubahan). */
function diffTrip(trip: TripRow, target: TripCorrectionTarget) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const currentVolume = trip.deliveredVolumeL ?? trip.plannedVolumeL;
  if (target.price !== null && target.price !== trip.price) changes.price = { from: trip.price, to: target.price };
  if (target.deliveredVolumeL !== null && target.deliveredVolumeL !== currentVolume) changes.deliveredVolumeL = { from: currentVolume, to: target.deliveredVolumeL };
  const priceDelta = changes.price ? (target.price as number) - trip.price : 0;
  const volumeDeltaL = changes.deliveredVolumeL ? (target.deliveredVolumeL as number) - currentVolume : 0;
  return { changes, priceDelta, volumeDeltaL };
}

/**
 * Terapkan koreksi rit (setelah persetujuan bila perlu). `requesterUserId` = Admin Keuangan pengaju (jejak).
 * Harga turun melebihi piutang rit yang masih terbuka → `advanceAmount` (uang muka pelanggan, M5/M11).
 */
export async function applyTripCorrection(
  tx: Tx,
  ctx: ActorContext,
  trip: TripRow,
  target: TripCorrectionTarget,
  reason: string,
  approvalId: string | null,
): Promise<Extract<TripCorrectionResult, { status: "corrected" }>> {
  assertCorrectable(trip);
  const { changes, priceDelta, volumeDeltaL } = diffTrip(trip, target);
  if (!Object.keys(changes).length) throw ValidationError.field("price", "Nilai koreksi sama dengan nilai rit sekarang.");
  const open = priceDelta < 0 ? await tripOpenReceivable(tx, trip.id) : null;
  const advanceAmount = open ? Math.max(0, -priceDelta - open.total) : 0;
  const [updated] = await tx
    .update(trips)
    .set({
      ...(changes.price ? { price: target.price as number } : {}),
      ...(changes.deliveredVolumeL ? { deliveredVolumeL: target.deliveredVolumeL as number } : {}),
      updatedAt: ctx.now,
    })
    .where(eq(trips.id, trip.id))
    .returning();
  const correctionId = newId();
  await auditRecord(tx, {
    ctx,
    objectType: "trip",
    objectId: trip.id,
    action: "correct",
    before: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])),
    after: { ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])), correctionId, approvalId, advanceAmount },
    reason,
    rule: "FR-M3-07, BR-38",
  });
  await emit(
    tx,
    "trip.corrected",
    {
      tripId: trip.id,
      orderId: trip.orderId,
      customerId: trip.customerId,
      truckId: trip.truckId ?? "",
      changes,
      priceDelta,
      volumeDeltaL,
      profitCenter: "L2",
      reason,
      correctionId,
      tripNumber: trip.number,
      businessDate: ctxBusinessDate(ctx),
      approvalId,
      advanceAmount,
    },
    { ctx, businessDate: ctxBusinessDate(ctx), objectType: "trip", objectId: trip.id },
  );
  return { status: "corrected", approval: null, trip: updated!, priceDelta, volumeDeltaL, advanceAmount };
}

/** Koreksi harga/volume rit Selesai oleh Admin Keuangan (izin `m3.trip.correct`; > PAR-21 → persetujuan pemilik). */
export async function correctTrip(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<TripCorrectionResult> {
  await authorize(ctx, "m3.trip.correct", { tx: opts.tx, objectType: "trip" });
  const data = parseInput(correctTripSchema, input, { price: "Harga rit", deliveredVolumeL: "Volume terkirim", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const trip = await loadTrip(tx, data.tripId, { forUpdate: true });
    if (trip.tenantId !== ctx.tenantId) throw new NotFoundError("Rit tidak ditemukan.");
    assertCorrectable(trip);
    const target: TripCorrectionTarget = { price: data.price ?? null, deliveredVolumeL: data.deliveredVolumeL ?? null };
    const { changes, priceDelta } = diffTrip(trip, target);
    if (!Object.keys(changes).length) throw ValidationError.field("price", "Nilai koreksi sama dengan nilai rit sekarang.");
    const limit = await correctionLimit(tx, ctx);
    if (Math.abs(priceDelta) > limit) {
      const approval = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "trip",
          objectId: trip.id,
          amount: Math.abs(priceDelta),
          reason: `Koreksi harga rit ${trip.number} ${formatRupiah(trip.price)} → ${formatRupiah(trip.price + priceDelta)}: ${data.reason}`,
          payload: { kind: "trip_correction", price: target.price, deliveredVolumeL: target.deliveredVolumeL, reason: data.reason, link: "/sopir-kantor/koreksi" },
        },
        { tx },
      );
      await auditRecord(tx, { ctx, objectType: "trip", objectId: trip.id, action: "request_correction", after: { approvalId: approval.id, ...changes }, reason: data.reason, rule: "BR-38" });
      return { status: "pending_approval" as const, approval, trip };
    }
    return applyTripCorrection(tx, ctx, trip, target, data.reason, null);
  });
}

/** Persetujuan `correction` objek `trip` diterima → koreksi berlaku (nilai dihitung ulang terhadap rit terkini). */
export async function onTripCorrectionApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const trip = await loadTrip(tx, request.objectId, { forUpdate: true });
  const p = (request.payload ?? {}) as { price?: number | null; deliveredVolumeL?: number | null; reason?: string };
  const target: TripCorrectionTarget = { price: p.price ?? null, deliveredVolumeL: p.deliveredVolumeL ?? null };
  const { changes } = diffTrip(trip, target);
  if (trip.status !== "completed" || !Object.keys(changes).length) return { effect: "none" };
  const res = await applyTripCorrection(tx, ctx, trip, target, String(p.reason ?? request.reason), request.id);
  return { effect: "corrected", priceDelta: res.priceDelta, volumeDeltaL: res.volumeDeltaL, advanceAmount: res.advanceAmount };
}

// =====================================================================================================================
// Pembalik pembayaran rit
// =====================================================================================================================

async function loadLivePayment(tx: Tx, id: string): Promise<TripPaymentRow> {
  const [pay] = await tx.select().from(tripPayments).where(eq(tripPayments.id, id)).for("update").limit(1);
  if (!pay) throw new NotFoundError("Pembayaran rit tidak ditemukan.");
  if (pay.reversalOfId) throw new DomainError("REVERSAL_OF_REVERSAL", "Baris pembalik tidak dapat dibalik lagi.");
  if (pay.reversedAt) throw new DomainError("ALREADY_REVERSED", "Pembayaran rit ini sudah dibalik.");
  return pay;
}

function assertReversible(pay: TripPaymentRow): void {
  if (pay.method !== "cash" && pay.method !== "transfer") {
    throw new DomainError(
      "PAYMENT_NOT_REVERSIBLE",
      pay.method === "credit"
        ? "Pembayaran tempo tidak dibalik di sini — koreksi faktur rit lewat nota kredit di menu Piutang."
        : "Pembayaran digital dikoreksi lewat pembalik pelunasan di menu Piutang.",
    );
  }
  if (pay.receivedAmount <= 0) throw new DomainError("NOTHING_TO_REVERSE", "Tidak ada uang diterima pada pembayaran ini — tidak ada yang dibalik.");
}

/**
 * Tunai rit yang sudah masuk setoran sopir yang DITERIMA/DITUTUP Admin Keuangan tidak dibalik di sini: setoran & hari
 * kasnya terkunci (US-M4-06 KP-7) — kekurangan uang ditangani lewat selisih setoran (M4) dan tagihan pelanggan lewat
 * Piutang (M5). Selama setoran masih Berjalan/Diajukan, pembalik mengurangi tunai seharusnya disetor.
 */
async function assertDepositOpen(tx: Tx, pay: TripPaymentRow): Promise<void> {
  if (pay.method !== "cash" || !pay.depositId) return;
  const [dep] = await tx.select({ status: deposits.status, number: deposits.number }).from(deposits).where(eq(deposits.id, pay.depositId)).limit(1);
  if (dep && (dep.status === "received" || dep.status === "closed")) {
    throw new DomainError(
      "DEPOSIT_ALREADY_RECEIVED",
      `Tunai rit ini sudah masuk setoran ${dep.number} yang ${label("deposit_status", dep.status).toLowerCase()}. Koreksi kekurangan lewat selisih setoran (menu Kas) dan tagih pelanggan lewat Piutang.`,
    );
  }
}

/** Terapkan pembalik pembayaran rit (setelah persetujuan bila perlu). */
export async function applyTripPaymentReversal(tx: Tx, ctx: ActorContext, pay: TripPaymentRow, reason: string, approvalId: string | null): Promise<TripPaymentRow> {
  assertReversible(pay);
  await assertDepositOpen(tx, pay);
  const trip = await loadTrip(tx, pay.tripId);
  const date = ctxBusinessDate(ctx);
  const [reversal] = await tx
    .insert(tripPayments)
    .values({
      tenantId: pay.tenantId,
      tripId: pay.tripId,
      customerId: pay.customerId,
      driverUserId: pay.driverUserId,
      method: pay.method,
      expectedAmount: -pay.expectedAmount,
      receivedAmount: -pay.receivedAmount,
      underpaymentAmount: -pay.underpaymentAmount,
      originalMethod: pay.originalMethod,
      depositId: pay.depositId,
      businessDate: date,
      reversalOfId: pay.id,
      reversalReason: reason,
      correctionApprovalId: approvalId,
      recordedByOffice: true,
      officeRecordReason: reason,
      createdBy: ctx.userId,
    })
    .returning();
  await tx.update(tripPayments).set({ reversedAt: ctx.now, reversedById: reversal!.id, updatedAt: ctx.now }).where(eq(tripPayments.id, pay.id));
  // Data pull perangkat (riwayat pembayaran rit) berubah.
  await tx.update(trips).set({ updatedAt: ctx.now }).where(eq(trips.id, pay.tripId));
  await auditRecord(tx, {
    ctx,
    objectType: "trip_payment",
    objectId: pay.id,
    action: "reverse",
    before: { method: pay.method, receivedAmount: pay.receivedAmount, underpaymentAmount: pay.underpaymentAmount },
    after: { reversalId: reversal!.id, approvalId },
    reason,
    rule: "FR-M3-07, BR-38",
  });
  await emit(
    tx,
    "trip_payment.reversed",
    {
      tripPaymentId: pay.id,
      reversalId: reversal!.id,
      tripId: pay.tripId,
      customerId: pay.customerId,
      method: pay.method,
      amount: pay.receivedAmount,
      profitCenter: "L2",
      reason,
      tripNumber: trip.number,
      businessDate: date,
      driverUserId: pay.driverUserId,
      depositId: pay.depositId,
      approvalId,
    },
    { ctx, businessDate: date, objectType: "trip_payment", objectId: pay.id },
  );
  return reversal!;
}

/** Balik pembayaran tunai/transfer rit (izin `m3.trip.correct`; > PAR-21 → persetujuan pemilik). */
export async function reverseTripPayment(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<TripPaymentReversalResult> {
  await authorize(ctx, "m3.trip.correct", { tx: opts.tx, objectType: "trip_payment" });
  const data = parseInput(reverseTripPaymentSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const pay = await loadLivePayment(tx, data.tripPaymentId);
    if (pay.tenantId !== ctx.tenantId) throw new NotFoundError("Pembayaran rit tidak ditemukan.");
    assertReversible(pay);
    await assertDepositOpen(tx, pay);
    const limit = await correctionLimit(tx, ctx);
    if (pay.receivedAmount > limit) {
      const trip = await loadTrip(tx, pay.tripId);
      const approval = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "trip_payment",
          objectId: pay.id,
          amount: pay.receivedAmount,
          reason: `Pembalik pembayaran ${label("payment_method", pay.method).toLowerCase()} rit ${trip.number} ${formatRupiah(pay.receivedAmount)}: ${data.reason}`,
          payload: { kind: "trip_payment_reversal", reason: data.reason, link: "/sopir-kantor/koreksi" },
        },
        { tx },
      );
      await auditRecord(tx, { ctx, objectType: "trip_payment", objectId: pay.id, action: "request_reversal", after: { approvalId: approval.id }, reason: data.reason, rule: "BR-38" });
      return { status: "pending_approval" as const, approval, reversal: null };
    }
    const reversal = await applyTripPaymentReversal(tx, ctx, pay, data.reason, null);
    return { status: "reversed" as const, approval: null, reversal };
  });
}

/** Persetujuan `correction` objek `trip_payment` diterima → pembalik berlaku (bila masih hidup). */
export async function onTripPaymentReversalApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [pay] = await tx.select().from(tripPayments).where(eq(tripPayments.id, request.objectId)).for("update").limit(1);
  if (!pay || pay.reversalOfId || pay.reversedAt) return { effect: "none" };
  const reason = String((request.payload as { reason?: string } | null)?.reason ?? request.reason);
  const rev = await applyTripPaymentReversal(tx, ctx, pay, reason, request.id);
  return { effect: "reversed", reversalId: rev.id };
}

// =====================================================================================================================
// Layar koreksi (Admin Keuangan)
// =====================================================================================================================

export type CorrectionTripView = {
  trip: Pick<TripRow, "id" | "number" | "status" | "price" | "plannedVolumeL" | "deliveredVolumeL" | "scheduledDate" | "isInternal" | "paymentMethod">;
  customerName: string;
  payments: Pick<TripPaymentRow, "id" | "method" | "expectedAmount" | "receivedAmount" | "underpaymentAmount" | "businessDate" | "reversalOfId" | "reversedAt" | "reversalReason">[];
  openReceivable: number;
};

/** Cari rit berdasarkan nomor (`P-YY-NNNNNN/n`) untuk layar koreksi (izin `m3.trip.correct`). */
export async function findTripForCorrection(ctx: ActorContext, number: string, opts: { tx?: Tx } = {}): Promise<CorrectionTripView | null> {
  await authorize(ctx, "m3.trip.correct", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const q = number.trim().toUpperCase();
  if (!q) return null;
  const [row] = await tx
    .select({ trip: trips, customerName: customers.name })
    .from(trips)
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .where(and(eq(trips.tenantId, ctx.tenantId), eq(trips.number, q)))
    .limit(1);
  if (!row) return null;
  const payments = await tx
    .select({
      id: tripPayments.id,
      method: tripPayments.method,
      expectedAmount: tripPayments.expectedAmount,
      receivedAmount: tripPayments.receivedAmount,
      underpaymentAmount: tripPayments.underpaymentAmount,
      businessDate: tripPayments.businessDate,
      reversalOfId: tripPayments.reversalOfId,
      reversedAt: tripPayments.reversedAt,
      reversalReason: tripPayments.reversalReason,
    })
    .from(tripPayments)
    .where(eq(tripPayments.tripId, row.trip.id))
    .orderBy(desc(tripPayments.createdAt));
  const open = row.trip.isInternal ? 0 : (await tripOpenReceivable(tx, row.trip.id)).total;
  const t = row.trip;
  return {
    trip: { id: t.id, number: t.number, status: t.status, price: t.price, plannedVolumeL: t.plannedVolumeL, deliveredVolumeL: t.deliveredVolumeL, scheduledDate: t.scheduledDate, isInternal: t.isInternal, paymentMethod: t.paymentMethod },
    customerName: row.customerName,
    payments,
    openReceivable: open,
  };
}

/** Pembayaran hidup rit (untuk uji/layar). */
export async function livePaymentOf(tx: Tx, tripId: string): Promise<TripPaymentRow | null> {
  const [row] = await tx
    .select()
    .from(tripPayments)
    .where(and(eq(tripPayments.tripId, tripId), isNull(tripPayments.reversalOfId), isNull(tripPayments.reversedAt)))
    .limit(1);
  return row ?? null;
}
