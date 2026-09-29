/**
 * M3 — siklus rit di lapangan (Bab 5.2): Berangkat → Tiba → Selesai (bukti kirim + pembayaran) / Gagal.
 *
 * - US-M3-02: Berangkat/Tiba satu ketukan; waktu perangkat + GPS + akurasi; satu rit aktif per truk; di luar urutan
 *   boleh (urutan aktual tercatat); tanpa lokasi → penanda "tanpa lokasi" (anomali M12 lewat event).
 * - US-M3-03: Selesai = foto (kamera aplikasi) + nama penerima + tanda tangan (lewati beralasan) + volume (PAR-15;
 *   beda → alasan); jarak ke alamat dihitung ULANG di server (PAR-16: > 200 m alasan, > 1 km tinjauan pemilik);
 *   alamat belum dikunci → tanpa pembandingan (M1 mengusulkan koordinat dari event `trip.completed`).
 * - US-M3-04: pembayaran bagian dari Selesai (lihat ./payments.ts). Rit internal (PTB-01): volume + foto, tanpa bayar.
 * - US-M3-06 KP-1/KP-2: Gagal (Berangkat/Tiba) alasan wajib, foto opsional, posisi, tindak lanjut air dimuat.
 * Lapangan tidak ditimpa kantor (Bab 6.4): rit yang ditarik/dipindah setelah diunduh tetap sah → `conflict`.
 */
import "server-only";

import { and, count, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";

import { tripIncidents, tripStatusEvents, trips } from "@/db/schema";
import { haversineMeters, isValidLatLng } from "@/lib/geo";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatUnderpaymentReason } from "@/lib/reasons";
import { toBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { substituteDriverConditions } from "@/server/core/auth";
import type { ActorContext } from "@/server/core/context";
import { DomainError, ValidationError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { authorize } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { arriveSchema, completeSchema, departSchema, failSchema } from "../schemas";
import {
  activeTripOfTruck,
  actingTruckId,
  assertActingOnTruck,
  assertDayNotSubmitted,
  assertNotLocked,
  attachmentsOfKind,
  deviationTarget,
  fieldValues,
  loadTripContext,
  m3Rules,
  tripConflictNote,
  type M3WriteMeta,
  type TripContext,
  type TripRow,
} from "./common";
import { customerFacingBankAccounts, insertTripPayment, resolvePayment, type ResolvedPayment, type TripPaymentRow } from "./payments";

const LABELS = {
  tripId: "Rit",
  location: "Lokasi",
  recipientName: "Nama penerima",
  deliveredVolumeL: "Volume terkirim",
  partialVolumeReason: "Alasan volume parsial",
  locationReason: "Alasan lokasi",
  payment: "Pembayaran",
  reason: "Alasan",
  loadedWaterDisposition: "Tindak lanjut air dimuat",
};

export type TripActionResult = {
  trip: TripRow;
  conflict: string | null;
  duplicate: boolean;
  payment?: TripPaymentRow | null;
  details?: Record<string, unknown>;
};

type Loc = { lat: number; lng: number; accuracyM: number | null } | null;

function locValues(loc: Loc) {
  return loc && isValidLatLng(loc) ? { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM === null ? null : Math.round(loc.accuracyM) } : { lat: null, lng: null, accuracyM: null };
}

async function recordStatusEvent(
  tx: M3WriteMeta["tx"],
  trip: TripRow,
  status: TripRow["status"],
  userId: string | null,
  loc: Loc,
  meta: M3WriteMeta,
): Promise<void> {
  const l = locValues(loc);
  await tx.insert(tripStatusEvents).values({
    tenantId: trip.tenantId,
    tripId: trip.id,
    status,
    deviceTime: meta.deviceTime,
    businessDate: meta.businessDate,
    syncedAt: meta.receivedAt,
    lat: l.lat,
    lng: l.lng,
    accuracyM: l.accuracyM,
    userId,
    deviceId: meta.office ? null : meta.deviceId,
    syncCommandId: meta.office ? null : meta.commandId,
    recordedByOffice: !!meta.office,
    officeRecordReason: meta.office?.reason ?? null,
    lateSync: meta.lateSync,
    clockSkewFlagged: meta.office ? false : meta.clockSkewFlagged,
  });
}

async function flagConflict(tx: M3WriteMeta["tx"], ctx: ActorContext, trip: TripRow, note: string): Promise<void> {
  await tx.update(trips).set({ syncConflict: true, syncConflictNote: note, updatedAt: ctx.now }).where(eq(trips.id, trip.id));
  await auditRecord(tx, { ctx, objectType: "trip", objectId: trip.id, action: "conflict", after: { syncConflict: true }, reason: note, rule: "6.4" });
}

/** Rit sedang dikerjakan pelaku yang sama (idempoten untuk ketukan ganda offline). */
function sameActor(trip: TripRow, ctx: ActorContext): boolean {
  return !!ctx.userId && trip.driverUserId === ctx.userId;
}

// =====================================================================================================================
// Berangkat (US-M3-02)
// =====================================================================================================================

export async function departTrip(ctx: ActorContext, input: unknown, meta: M3WriteMeta): Promise<TripActionResult> {
  const data = parseInput(departSchema, input, LABELS);
  const tx = meta.tx;
  const tc = await loadTripContext(tx, data.tripId, { forUpdate: true });
  const trip = tc.trip;
  const conflict = await tripConflictNote(tx, ctx, trip, meta);
  const truckId = conflict ? ((await actingTruckId(tx, ctx, meta.businessDate)) ?? trip.truckId) : trip.truckId;
  await assertActingOnTruck(tx, ctx, "m3.trip.depart", truckId, meta.businessDate, meta);

  if (trip.status !== "assigned") {
    if ((trip.status === "departed" || trip.status === "arrived") && sameActor(trip, ctx)) return { trip, conflict: null, duplicate: true };
    throw new DomainError("TRIP_STATUS", `Rit ${trip.number} sudah berstatus ${label("trip_status", trip.status)} — tidak dapat Berangkat lagi.`);
  }
  await assertNotLocked(tx, ctx, meta.businessDate, meta, ctx.userId!);
  await assertDayNotSubmitted(tx, ctx.userId!, meta.businessDate, meta);
  if (truckId) {
    const active = await activeTripOfTruck(tx, truckId, trip.id);
    if (active) {
      throw new DomainError("ACTIVE_TRIP_EXISTS", `Rit ${active.number} masih berjalan. Selesaikan atau tandai gagal dulu — hanya satu rit Berangkat/Tiba per truk.`);
    }
  }
  // Urutan aktual (US-M3-02 KP-2) & penanda di luar urutan rencana.
  const [done] = await tx
    .select({ n: count() })
    .from(trips)
    .where(and(eq(trips.truckId, trip.truckId ?? truckId!), eq(trips.scheduledDate, trip.scheduledDate), isNotNull(trips.departedAt), ne(trips.id, trip.id)));
  const actualOrder = Number(done?.n ?? 0) + 1;
  const earlier = trip.routeOrder
    ? await tx
        .select({ id: trips.id })
        .from(trips)
        .where(
          and(
            eq(trips.truckId, trip.truckId ?? truckId!),
            eq(trips.scheduledDate, trip.scheduledDate),
            eq(trips.status, "assigned"),
            isNull(trips.withdrawnAt),
            lt(trips.routeOrder, trip.routeOrder),
            ne(trips.id, trip.id),
          ),
        )
        .limit(1)
    : [];
  const outOfOrder = earlier.length > 0;
  const l = locValues(data.location);
  const [updated] = await tx
    .update(trips)
    .set({
      status: "departed",
      departedAt: meta.deviceTime,
      departedLat: l.lat,
      departedLng: l.lng,
      departedAccuracyM: l.accuracyM,
      noLocation: l.lat === null ? true : trip.noLocation,
      actualOrder,
      driverUserId: ctx.userId,
      driverEmployeeId: ctx.employeeId,
      ...fieldValues(meta),
      updatedAt: ctx.now,
    })
    .where(eq(trips.id, trip.id))
    .returning();
  await recordStatusEvent(tx, trip, "departed", ctx.userId, data.location, meta);
  await auditRecord(tx, {
    ctx,
    objectType: "trip",
    objectId: trip.id,
    action: "depart",
    before: { status: trip.status },
    after: { status: "departed", departedAt: meta.deviceTime, lat: l.lat, lng: l.lng, accuracyM: l.accuracyM, actualOrder, outOfOrder, noLocation: l.lat === null },
    reason: outOfOrder ? "Berangkat di luar urutan rencana (dikonfirmasi sopir)." : null,
    rule: "US-M3-02",
    businessDate: meta.businessDate,
  });
  if (conflict) await flagConflict(tx, ctx, updated!, conflict);
  await emit(
    tx,
    "trip.departed",
    {
      tripId: trip.id,
      orderId: trip.orderId,
      truckId: truckId ?? trip.truckId ?? "",
      driverUserId: ctx.userId,
      departedAt: meta.deviceTime.toISOString(),
      lat: l.lat,
      lng: l.lng,
      tripNumber: trip.number,
      customerId: trip.customerId,
      accuracyM: l.accuracyM,
      noLocation: l.lat === null,
      actualOrder,
      plannedOrder: trip.routeOrder,
      outOfOrder,
      isInternal: trip.isInternal,
      destinationOutletId: trip.destinationOutletId,
      businessDate: meta.businessDate,
      recordedByOffice: !!meta.office,
      lateSync: meta.lateSync,
    },
    { ctx, businessDate: meta.businessDate, objectType: "trip", objectId: trip.id },
  );
  return { trip: updated!, conflict, duplicate: false, details: { actualOrder, outOfOrder, noLocation: l.lat === null } };
}

// =====================================================================================================================
// Tiba (US-M3-02 KP-3)
// =====================================================================================================================

export async function arriveTrip(ctx: ActorContext, input: unknown, meta: M3WriteMeta): Promise<TripActionResult> {
  const data = parseInput(arriveSchema, input, LABELS);
  const tx = meta.tx;
  const tc = await loadTripContext(tx, data.tripId, { forUpdate: true });
  const trip = tc.trip;
  const conflict = await tripConflictNote(tx, ctx, trip, meta);
  const truckId = conflict ? ((await actingTruckId(tx, ctx, meta.businessDate)) ?? trip.truckId) : trip.truckId;
  await assertActingOnTruck(tx, ctx, "m3.trip.arrive", truckId, meta.businessDate, meta);
  if (trip.status !== "departed") {
    if (trip.status === "arrived" && sameActor(trip, ctx)) return { trip, conflict: null, duplicate: true };
    throw new DomainError("TRIP_STATUS", `Rit ${trip.number} berstatus ${label("trip_status", trip.status)} — catat Berangkat dulu sebelum Tiba.`);
  }
  const l = locValues(data.location);
  // B-48: rit internal diukur ke depot tujuan; rit pelanggan ke titik alamat (Tiba: informasi, tanpa syarat Dikunci).
  const arriveTarget = tc.trip.isInternal && tc.trip.destinationOutletId ? (tc.outletPoint ?? null) : tc.address.lat !== null && tc.address.lng !== null ? { lat: tc.address.lat, lng: tc.address.lng } : null;
  const distance = l.lat !== null && arriveTarget ? Math.round(haversineMeters({ lat: l.lat, lng: l.lng! }, arriveTarget)) : null;
  const [updated] = await tx
    .update(trips)
    .set({
      status: "arrived",
      arrivedAt: meta.deviceTime,
      arrivedLat: l.lat,
      arrivedLng: l.lng,
      arrivedAccuracyM: l.accuracyM,
      arrivalDistanceM: distance ?? data.clientDistanceM ?? null,
      noLocation: l.lat === null ? true : trip.noLocation,
      ...fieldValues(meta),
      updatedAt: ctx.now,
    })
    .where(eq(trips.id, trip.id))
    .returning();
  await recordStatusEvent(tx, trip, "arrived", ctx.userId, data.location, meta);
  await auditRecord(tx, {
    ctx,
    objectType: "trip",
    objectId: trip.id,
    action: "arrive",
    before: { status: trip.status },
    after: { status: "arrived", arrivedAt: meta.deviceTime, lat: l.lat, lng: l.lng, distanceToAddressM: distance, noLocation: l.lat === null },
    rule: "US-M3-02",
    businessDate: meta.businessDate,
  });
  if (conflict) await flagConflict(tx, ctx, updated!, conflict);
  await emit(
    tx,
    "trip.arrived",
    {
      tripId: trip.id,
      orderId: trip.orderId,
      truckId: truckId ?? trip.truckId ?? "",
      arrivedAt: meta.deviceTime.toISOString(),
      distanceToAddressM: distance,
      tripNumber: trip.number,
      customerId: trip.customerId,
      driverUserId: ctx.userId,
      lat: l.lat,
      lng: l.lng,
      accuracyM: l.accuracyM,
      noLocation: l.lat === null,
      isInternal: trip.isInternal,
      destinationOutletId: trip.destinationOutletId,
      businessDate: meta.businessDate,
      lateSync: meta.lateSync,
    },
    { ctx, businessDate: meta.businessDate, objectType: "trip", objectId: trip.id },
  );
  return { trip: updated!, conflict, duplicate: false, details: { distanceToAddressM: distance } };
}

// =====================================================================================================================
// Selesai + pembayaran (US-M3-03, US-M3-04)
// =====================================================================================================================

type CompleteOptions = {
  /** Pelaksana atas nama siapa rit dicatat (dicatat kantor = sopir rit). Bawaan: pelaku. */
  actingUserId?: string;
  actingEmployeeId?: string | null;
  /** Lampiran bukti kantor (bukan foto kamera aplikasi). */
  officeEvidenceAttachmentId?: string | null;
};

export async function completeTrip(ctx: ActorContext, input: unknown, meta: M3WriteMeta, opts: CompleteOptions = {}): Promise<TripActionResult> {
  const data = parseInput(completeSchema, input, LABELS);
  const tx = meta.tx;
  const tc = await loadTripContext(tx, data.tripId, { forUpdate: true });
  const trip = tc.trip;
  const actingUserId = opts.actingUserId ?? ctx.userId!;
  const conflict = await tripConflictNote(tx, ctx, trip, meta);
  const truckId = conflict ? ((await actingTruckId(tx, ctx, meta.businessDate)) ?? trip.truckId) : trip.truckId;
  await assertActingOnTruck(tx, ctx, "m3.trip.complete", truckId, meta.businessDate, meta);
  if (!trip.isInternal && !meta.office) {
    const conditions = truckId ? await substituteDriverConditions(tx, ctx, truckId, meta.businessDate) : {};
    await authorize(ctx, "m3.trip_payment.create", { tx, conditions, objectType: "trip", objectId: trip.id });
  }

  const photos = attachmentsOfKind(meta, "delivery_photo");
  const signature = attachmentsOfKind(meta, "signature")[0] ?? null;

  // Rit sudah Selesai/Gagal (perangkat lain / dicatat kantor): data lapangan tetap diterima sebagai KONFLIK — bukti
  // ikut tertaut, pembayaran tidak digandakan (satu pembayaran hidup per rit); Admin Keuangan meninjau.
  if (trip.status === "completed" || trip.status === "failed") {
    if (trip.status === "completed" && sameActor(trip, ctx) && !trip.recordedByOffice && trip.syncCommandId === meta.commandId) {
      return { trip, conflict: null, duplicate: true };
    }
    const note = `Rit ${trip.number} sudah ${label("trip_status", trip.status)}${trip.recordedByOffice ? " (dicatat kantor)" : ""}; data Selesai dari ${meta.office ? "kantor" : "perangkat"} diterima sebagai konflik untuk ditinjau Admin Keuangan.`;
    for (const a of [...photos, ...(signature ? [signature] : [])]) await linkAttachment(tx, a.id, { type: "trip", id: trip.id });
    await flagConflict(tx, ctx, trip, note);
    return { trip, conflict: note, duplicate: false };
  }
  if (trip.status === "assigned" && !meta.office) {
    throw new DomainError("TRIP_STATUS", `Rit ${trip.number} belum Berangkat. Tekan Berangkat lalu Tiba sebelum Selesai.`);
  }

  const rules = await m3Rules(tx, meta.businessDate, trip.tenantId);
  // --- Bukti kirim (BR-22) ---
  if (!meta.office) {
    if (photos.length === 0) throw new DomainError("PHOTO_REQUIRED", "Foto bukti kirim wajib. Ambil minimal satu foto dari kamera aplikasi lalu simpan lagi.");
    if (photos.length > rules.maxDeliveryPhotos) throw ValidationError.field("photos", `Maksimal ${rules.maxDeliveryPhotos} foto bukti kirim per rit.`);
  }
  let recipientName = data.recipientName?.trim() || null;
  let signatureSkippedReason: string | null = null;
  if (!trip.isInternal) {
    if (!recipientName) throw ValidationError.field("recipientName", "Nama penerima wajib diisi.");
    if (!signature && !meta.office) {
      if (!data.signatureSkipReason) throw new DomainError("SIGNATURE_REQUIRED", "Minta tanda tangan penerima, atau pilih alasan: penerima tidak bersedia / tidak ada.");
      signatureSkippedReason = data.signatureSkipReason;
    }
    if (meta.office && !signature) signatureSkippedReason = "dicatat_kantor";
  } else {
    recipientName = recipientName ?? `Operator ${tc.outletName ?? "depot"}`;
  }

  // --- Volume (BR-22, PAR-15) ---
  const maxVolume = Math.max(rules.standardVolumeL, trip.plannedVolumeL);
  if (data.deliveredVolumeL > maxVolume) throw ValidationError.field("deliveredVolumeL", `Volume terkirim tidak boleh melebihi ${maxVolume.toLocaleString("id-ID")} L.`);
  const partialVolume = data.deliveredVolumeL !== rules.standardVolumeL;
  if (partialVolume) {
    if (!data.partialVolumeReason) throw ValidationError.field("partialVolumeReason", `Volume berbeda dari ${rules.standardVolumeL.toLocaleString("id-ID")} L: pilih alasan.`);
    if (data.partialVolumeReason === "other" && (data.partialVolumeNote?.trim().length ?? 0) < 3) {
      throw ValidationError.field("partialVolumeNote", "Tulis keterangan alasan volume (Lainnya).");
    }
  }

  // --- Lokasi (BR-23, PAR-16): server menghitung ulang — hasil server yang berlaku ---
  const l = locValues(data.location);
  let distance: number | null = null;
  // B-48: rit internal → depot tujuan; rit pelanggan → alamat Dikunci (acuan sama dengan M12).
  const target = deviationTarget(tc);
  if (l.lat !== null && target) {
    distance = Math.round(haversineMeters({ lat: l.lat, lng: l.lng! }, target));
  }
  const deviation: "none" | "level1" | "level2" = distance === null ? "none" : distance > rules.ownerReviewGtM ? "level2" : distance > rules.reasonRequiredGtM ? "level1" : "none";
  const clientNeedsReason = (data.clientDistanceM ?? 0) > rules.reasonRequiredGtM;
  if (!meta.office && deviation !== "none" && clientNeedsReason && !data.locationReason) {
    throw ValidationError.field("locationReason", `Lokasi Selesai lebih dari ${rules.reasonRequiredGtM} m dari alamat: pilih alasan.`);
  }
  if (data.locationReason === "other" && (data.locationReasonNote?.trim().length ?? 0) < 3) throw ValidationError.field("locationReasonNote", "Tulis keterangan alasan lokasi (Lainnya).");

  // --- Pembayaran (US-M3-04) ---
  let pay: ResolvedPayment | null = null;
  if (!trip.isInternal) {
    pay = await resolvePayment(ctx, tc, data.payment, meta);
  }

  const fv = fieldValues(meta);
  const now = ctx.now;
  const [updated] = await tx
    .update(trips)
    .set({
      status: "completed",
      departedAt: trip.departedAt ?? meta.deviceTime,
      arrivedAt: trip.arrivedAt ?? meta.deviceTime,
      completedAt: meta.deviceTime,
      completedLat: l.lat,
      completedLng: l.lng,
      completedAccuracyM: l.accuracyM,
      completionDistanceM: distance,
      completionDistanceClientM: data.clientDistanceM ?? null,
      locationDeviation: deviation,
      locationReason: data.locationReason ?? null,
      locationReasonNote: data.locationReasonNote ?? null,
      ownerReviewRequired: deviation === "level2",
      deliveredVolumeL: data.deliveredVolumeL,
      partialVolumeReason: partialVolume ? (data.partialVolumeReason ?? null) : null,
      partialVolumeNote: partialVolume ? (data.partialVolumeNote ?? null) : null,
      recipientName,
      signatureAttachmentId: signature?.id ?? null,
      signatureSkippedReason,
      noLocation: l.lat === null ? true : trip.noLocation,
      completionBusinessDate: meta.businessDate,
      driverUserId: trip.driverUserId ?? actingUserId,
      driverEmployeeId: trip.driverEmployeeId ?? opts.actingEmployeeId ?? ctx.employeeId,
      ...fv,
      updatedAt: now,
    })
    .where(eq(trips.id, trip.id))
    .returning();
  for (const a of photos) await linkAttachment(tx, a.id, { type: "trip", id: trip.id });
  if (signature) await linkAttachment(tx, signature.id, { type: "trip", id: trip.id });
  if (opts.officeEvidenceAttachmentId) await linkAttachment(tx, opts.officeEvidenceAttachmentId, { type: "trip", id: trip.id });
  await recordStatusEvent(tx, trip, "completed", actingUserId, data.location, meta);

  let payment: TripPaymentRow | null = null;
  let depositId: string | null = null;
  if (pay) {
    const res = await insertTripPayment(ctx, tc, pay, meta, { driverUserId: actingUserId, fieldValues: fv, today: toBusinessDate(ctx.now) });
    payment = res.payment;
    depositId = res.depositId;
    if (pay.transferProofAttachmentId) await linkAttachment(tx, pay.transferProofAttachmentId, { type: "trip_payment", id: payment.id });
  }

  await auditRecord(tx, {
    ctx,
    objectType: "trip",
    objectId: trip.id,
    action: "complete",
    before: { status: trip.status },
    after: {
      status: "completed",
      completedAt: meta.deviceTime,
      deliveredVolumeL: data.deliveredVolumeL,
      partialVolumeReason: partialVolume ? data.partialVolumeReason : null,
      recipientName,
      signatureSkippedReason,
      distanceToAddressM: distance,
      locationDeviation: deviation,
      locationReason: data.locationReason ?? null,
      ownerReviewRequired: deviation === "level2",
      photos: photos.length,
      recordedByOffice: !!meta.office,
      onBehalfOfUserId: meta.office ? actingUserId : undefined,
    },
    reason: meta.office?.reason ?? (partialVolume ? `Volume parsial: ${label("partial_volume_reason", data.partialVolumeReason ?? "other")}` : null),
    rule: meta.office ? "Bab 6.1 dicatat kantor" : "US-M3-03",
    businessDate: meta.businessDate,
  });
  if (conflict) await flagConflict(tx, ctx, updated!, conflict);

  // --- Notifikasi (6.2c / 6.3) ---
  const link = `/pesanan/${trip.orderId}`;
  if (pay && pay.underpayment > 0) {
    await notify(tx, {
      event: "trip.underpayment",
      tenantId: trip.tenantId,
      title: `Kurang bayar ${formatRupiah(pay.underpayment)}: ${tc.customer.name}`,
      body: `Rit ${trip.number} — diterima ${formatRupiah(pay.received)} dari ${formatRupiah(pay.expected)}. ${formatUnderpaymentReason(pay.underpaymentReason)} Faktur kurang bayar jatuh tempo hari ini (PTB-18).`.trim(),
      objectType: "trip",
      objectId: trip.id,
      valueAmount: pay.underpayment,
      link,
      groupKey: `trip.underpayment:${trip.id}`,
      now,
    });
  }
  if (partialVolume) {
    await notify(tx, {
      event: "trip.partial_volume",
      tenantId: trip.tenantId,
      title: `Volume parsial ${data.deliveredVolumeL.toLocaleString("id-ID")} L: rit ${trip.number}`,
      body: `${tc.customer.name} — ${label("partial_volume_reason", data.partialVolumeReason ?? "other")}${data.partialVolumeNote ? `: ${data.partialVolumeNote}` : ""}. Harga rit tetap harga pesanan; penyesuaian hanya lewat koreksi Admin Keuangan (BR-38).`,
      objectType: "trip",
      objectId: trip.id,
      valueText: `${data.deliveredVolumeL} L`,
      link,
      groupKey: `trip.partial_volume:${trip.id}`,
      now,
    });
  }
  if (deviation === "level2") {
    await notify(tx, {
      event: "trip.location_deviation",
      tenantId: trip.tenantId,
      title: `Lokasi Selesai ${(distance! / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} km dari alamat: rit ${trip.number}`,
      body: `${tc.customer.name}. Alasan sopir: ${data.locationReason ? label("location_reason", data.locationReason) : "—"}${data.locationReasonNote ? ` (${data.locationReasonNote})` : ""}. Tinjau H+0 (BR-23).`,
      objectType: "trip",
      objectId: trip.id,
      valueText: `${distance} m`,
      link,
      groupKey: `trip.location_deviation:${trip.id}`,
      now,
    });
  }

  // --- Event (payload mandiri PTB-47) ---
  const bank = pay?.method === "transfer" ? ((await customerFacingBankAccounts(tx, trip.tenantId))[0]?.id ?? null) : null;
  await emit(
    tx,
    "trip.completed",
    {
      tripId: trip.id,
      orderId: trip.orderId,
      customerId: trip.customerId,
      truckId: truckId ?? trip.truckId ?? "",
      driverUserId: actingUserId,
      isInternal: trip.isInternal,
      destinationOutletId: trip.destinationOutletId,
      volumeL: data.deliveredVolumeL,
      price: trip.price,
      paymentMethod: pay?.method ?? (trip.paymentMethod as "internal"),
      cashReceived: pay?.method === "cash" ? pay.received : 0,
      transferAmount: pay?.method === "transfer" ? pay.received : 0,
      creditAmount: pay?.method === "credit" ? pay.expected : 0,
      underpaymentAmount: pay?.underpayment ?? 0,
      completedAt: meta.deviceTime.toISOString(),
      locationDeviationM: distance,
      recordedByOffice: !!meta.office,
      lateSync: meta.lateSync,
      tripNumber: trip.number,
      orderNumber: tc.order.number,
      addressId: trip.addressId,
      profitCenter: "L2",
      businessDate: meta.businessDate,
      originalPaymentMethod: pay?.originalMethod ?? null,
      expectedAmount: pay?.expected ?? 0,
      underpaymentReason: pay?.underpaymentReason ?? null,
      tripPaymentId: payment?.id ?? null,
      depositId,
      plannedVolumeL: trip.plannedVolumeL,
      partialVolume,
      partialVolumeReason: partialVolume ? (data.partialVolumeReason ?? null) : null,
      recipientName,
      signatureSkipped: !!signatureSkippedReason,
      lat: l.lat,
      lng: l.lng,
      accuracyM: l.accuracyM,
      noLocation: l.lat === null,
      distanceToAddressM: distance,
      locationDeviation: deviation,
      locationReason: data.locationReason ?? null,
      ownerReviewRequired: deviation === "level2",
      addressCoordinateLocked: tc.address.coordinateLocked,
      photoAttachmentIds: photos.map((p) => p.id),
      signatureAttachmentId: signature?.id ?? null,
      transferProofAttachmentId: pay?.transferProofAttachmentId ?? null,
      // B-65: dibayar di muka (aplikasi pelanggan) → pendapatan diakui terhadap uang muka (M5/M11), bukan kurang bayar.
      ...(pay?.method === "digital" ? { prepaidAmount: pay.prepaidAmount ?? pay.received, prepaidReference: pay.prepaidReference ?? null } : {}),
    },
    { ctx, businessDate: meta.businessDate, objectType: "trip", objectId: trip.id },
  );
  if (pay && payment) {
    await emit(
      tx,
      "trip.payment_recorded",
      {
        tripPaymentId: payment.id,
        tripId: trip.id,
        customerId: trip.customerId,
        method: pay.method,
        amount: pay.method === "credit" ? pay.expected : pay.received,
        driverUserId: actingUserId,
        tripNumber: trip.number,
        orderId: trip.orderId,
        orderNumber: tc.order.number,
        addressId: trip.addressId,
        truckId: truckId ?? trip.truckId,
        expectedAmount: pay.expected,
        receivedAmount: pay.received,
        underpaymentAmount: pay.underpayment,
        underpaymentReason: pay.underpaymentReason,
        originalMethod: pay.originalMethod,
        methodChangeApprovalId: pay.method === "credit" ? pay.approvalId : null,
        transferProofAttachmentId: pay.transferProofAttachmentId,
        bankAccountId: bank,
        depositId,
        profitCenter: "L2",
        businessDate: meta.businessDate,
        isCredit: pay.method === "credit",
        recordedByOffice: !!meta.office,
        lateSync: meta.lateSync,
        ...(pay.method === "digital" ? { prepaidAmount: pay.prepaidAmount ?? pay.received } : {}),
      },
      { ctx, businessDate: meta.businessDate, objectType: "trip_payment", objectId: payment.id },
    );
  }
  return {
    trip: updated!,
    conflict,
    duplicate: false,
    payment,
    details: {
      distanceToAddressM: distance,
      locationDeviation: deviation,
      partialVolume,
      underpayment: pay?.underpayment ?? 0,
      convertedToUnderpayment: pay?.convertedToUnderpayment ?? false,
      paymentMethod: pay?.method ?? null,
    },
  };
}

// =====================================================================================================================
// Gagal (US-M3-06 KP-1/KP-2)
// =====================================================================================================================

/** Rit gagal berturut untuk pelanggan (BR-24): hitung mundur sampai rit Selesai terakhir. */
export async function consecutiveFailuresFor(tx: M3WriteMeta["tx"], customerId: string): Promise<number> {
  const rows = await tx
    .select({ status: trips.status })
    .from(trips)
    .where(and(eq(trips.customerId, customerId), inArray(trips.status, ["completed", "failed"])))
    .orderBy(desc(sql`coalesce(${trips.failedAt}, ${trips.completedAt})`))
    .limit(20);
  let n = 0;
  for (const r of rows) {
    if (r.status !== "failed") break;
    n++;
  }
  return n;
}

export async function failTrip(
  ctx: ActorContext,
  input: unknown,
  meta: M3WriteMeta,
  opts: { actingUserId?: string; actingEmployeeId?: string | null; officeEvidenceAttachmentId?: string | null } = {},
): Promise<TripActionResult> {
  const data = parseInput(failSchema, input, LABELS);
  const tx = meta.tx;
  const tc = await loadTripContext(tx, data.tripId, { forUpdate: true });
  const trip = tc.trip;
  const actingUserId = opts.actingUserId ?? ctx.userId!;
  const conflict = await tripConflictNote(tx, ctx, trip, meta);
  const truckId = conflict ? ((await actingTruckId(tx, ctx, meta.businessDate)) ?? trip.truckId) : trip.truckId;
  await assertActingOnTruck(tx, ctx, "m3.trip.fail", truckId, meta.businessDate, meta);
  if (trip.status === "failed" && sameActor(trip, ctx)) return { trip, conflict: null, duplicate: true };
  if (trip.status === "completed" || trip.status === "failed") {
    const note = `Rit ${trip.number} sudah ${label("trip_status", trip.status)}; laporan gagal dari ${meta.office ? "kantor" : "perangkat"} diterima sebagai konflik untuk ditinjau.`;
    await flagConflict(tx, ctx, trip, note);
    return { trip, conflict: note, duplicate: false };
  }
  if (trip.status === "assigned" && !meta.office) {
    throw new DomainError("TRIP_STATUS", `Rit gagal hanya dapat ditandai setelah Berangkat/Tiba. Tekan Berangkat dulu atau hubungi Dispatcher.`);
  }
  if (data.reason === "other" && (data.note?.trim().length ?? 0) < 3) throw ValidationError.field("note", "Tulis keterangan alasan (Lainnya).");
  const l = locValues(data.location);
  const photo = attachmentsOfKind(meta, "trip_fail_photo")[0] ?? null;
  const [updated] = await tx
    .update(trips)
    .set({
      status: "failed",
      departedAt: trip.departedAt ?? meta.deviceTime,
      failedAt: meta.deviceTime,
      failReason: data.reason,
      failNote: data.note ?? null,
      failLat: l.lat,
      failLng: l.lng,
      loadedWaterDisposition: data.loadedWaterDisposition,
      noLocation: l.lat === null ? true : trip.noLocation,
      driverUserId: trip.driverUserId ?? actingUserId,
      driverEmployeeId: trip.driverEmployeeId ?? opts.actingEmployeeId ?? ctx.employeeId,
      completionBusinessDate: meta.businessDate,
      ...fieldValues(meta),
      updatedAt: ctx.now,
    })
    .where(eq(trips.id, trip.id))
    .returning();
  const [incident] = await tx
    .insert(tripIncidents)
    .values({
      tenantId: trip.tenantId,
      tripId: trip.id,
      truckId: truckId ?? trip.truckId,
      kind: "trip_failed",
      description: `${label("trip_fail_reason", data.reason)}${data.note ? ` — ${data.note}` : ""}. Air dimuat: ${label("loaded_water_disposition", data.loadedWaterDisposition)}.`,
      occurredAt: meta.deviceTime,
      lat: l.lat,
      lng: l.lng,
      reportedByUserId: actingUserId,
      businessDate: meta.businessDate,
      ...fieldValues(meta),
    })
    .returning({ id: tripIncidents.id });
  if (photo) await linkAttachment(tx, photo.id, { type: "trip_incident", id: incident!.id });
  if (opts.officeEvidenceAttachmentId) await linkAttachment(tx, opts.officeEvidenceAttachmentId, { type: "trip_incident", id: incident!.id });
  await recordStatusEvent(tx, trip, "failed", actingUserId, data.location, meta);
  await auditRecord(tx, {
    ctx,
    objectType: "trip",
    objectId: trip.id,
    action: "fail",
    before: { status: trip.status },
    after: { status: "failed", failReason: data.reason, loadedWaterDisposition: data.loadedWaterDisposition, lat: l.lat, lng: l.lng, recordedByOffice: !!meta.office },
    reason: meta.office?.reason ?? data.note ?? label("trip_fail_reason", data.reason),
    rule: meta.office ? "Bab 6.1 dicatat kantor" : "US-M3-06 KP-1",
    businessDate: meta.businessDate,
  });
  if (conflict) await flagConflict(tx, ctx, updated!, conflict);
  const consecutive = await consecutiveFailuresFor(tx, trip.customerId);
  await emit(
    tx,
    "trip.failed",
    {
      tripId: trip.id,
      orderId: trip.orderId,
      customerId: trip.customerId,
      truckId: truckId ?? trip.truckId ?? "",
      reason: data.reason,
      consecutiveFailures: consecutive,
      tripNumber: trip.number,
      driverUserId: actingUserId,
      note: data.note ?? null,
      failedAt: meta.deviceTime.toISOString(),
      lat: l.lat,
      lng: l.lng,
      noLocation: l.lat === null,
      loadedWaterDisposition: data.loadedWaterDisposition,
      plannedVolumeL: trip.plannedVolumeL,
      isInternal: trip.isInternal,
      destinationOutletId: trip.destinationOutletId,
      photoAttachmentId: photo?.id ?? null,
      businessDate: meta.businessDate,
      recordedByOffice: !!meta.office,
      lateSync: meta.lateSync,
    },
    { ctx, businessDate: meta.businessDate, objectType: "trip", objectId: trip.id },
  );
  return { trip: updated!, conflict, duplicate: false, details: { consecutiveFailures: consecutive, incidentId: incident!.id } };
}

/** Rit Berangkat/Tiba milik pengguna pada tanggal (Setor hanya bila tidak ada, US-M3-07 KP-2). */
export async function activeTripsOfUser(tx: M3WriteMeta["tx"], userId: string, date: string): Promise<TripRow[]> {
  return tx
    .select()
    .from(trips)
    .where(and(eq(trips.driverUserId, userId), inArray(trips.status, ["departed", "arrived"]), or(eq(trips.scheduledDate, date), lt(trips.scheduledDate, date))!));
}

export type { TripContext };
