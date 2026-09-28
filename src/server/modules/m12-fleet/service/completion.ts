/**
 * M12 — titik status rit & pencocokan lokasi Selesai (US-M12-01 KP-4, US-M12-04; BR-23; FR-M12-03).
 *
 * Dipanggil handler event rit M3 (di SAVEPOINT transaksi sinkron M3):
 * - Titik status Berangkat/Tiba/Selesai/Gagal SELALU disimpan sebagai posisi sumber `status_point` (cadangan jejak).
 * - Selesai: server menghitung jarak titik Selesai ke koordinat alamat kirim (alamat Dikunci) atau ke koordinat depot
 *   untuk rit internal (KP-5): > PAR-16 `reason_required_gt_m` → penyimpangan tingkat 1 (alasan sopir tercatat);
 *   > `owner_review_gt_m` → tingkat 2 (daftar tinjauan pemilik). Alamat Belum dikunci → tanpa penyimpangan (KP-4; M1
 *   mengusulkan titik Selesai sebagai koordinat).
 * - Posisi perangkat GPS pada waktu Selesai (± `inconsistency_window_minutes`) vs titik Selesai ponsel berbeda >
 *   `source_inconsistent_gt_m` → "sumber lokasi tidak konsisten" (KP-2) → pemilik.
 * - Jejak rit & estimasi BBM dihitung (US-M12-03, US-M12-07).
 */
import "server-only";

import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";

import { customerAddresses, customers, fleetEvents, gpsPositions, outlets, trips } from "@/db/schema";
import { haversineMeters, isValidLatLng, type LatLng } from "@/lib/geo";
import { label } from "@/lib/labels";
import { formatJam, toBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { systemContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";

import { nearestInTime } from "../domain/track";
import { m12Rules, positionsBetween, toTrackPoints, type M12Rules } from "./common";
import { createFleetEvent, eventLink, notifyOnce } from "./fleet-events";
import { upsertTripTrack } from "./history";

/** Simpan titik status rit (US-M12-01 KP-4). Idempoten (unik truk + sumber + waktu). */
export async function recordStatusPoint(
  tx: Tx,
  input: { tenantId: string; truckId: string; tripId: string; at: Date; lat: number | null | undefined; lng: number | null | undefined; accuracyM?: number | null; userId?: string | null; receivedAt: Date; rules: M12Rules },
): Promise<boolean> {
  if (input.lat === null || input.lat === undefined || input.lng === null || input.lng === undefined) return false;
  if (!isValidLatLng({ lat: input.lat, lng: input.lng })) return false;
  const rows = await tx
    .insert(gpsPositions)
    .values({
      tenantId: input.tenantId,
      truckId: input.truckId,
      deviceId: null,
      source: "status_point",
      deviceTime: input.at,
      serverTime: input.receivedAt,
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM ?? null,
      isValid: input.accuracyM === null || input.accuracyM === undefined || input.accuracyM <= input.rules.fleet.max_accuracy_m,
      tripId: input.tripId,
      userId: input.userId ?? null,
      vendor: "m3-status",
    })
    .onConflictDoNothing()
    .returning({ id: gpsPositions.id });
  return rows.length > 0;
}

/** Posisi perangkat GPS terdekat dengan waktu `at` (± jendela). */
export async function devicePositionAt(tx: Tx, truckId: string, at: Date, windowMinutes: number): Promise<{ lat: number; lng: number; t: Date } | null> {
  const w = windowMinutes * 60_000;
  const rows = await positionsBetween(tx, truckId, new Date(at.getTime() - w), new Date(at.getTime() + w), { sources: ["gps_device"] });
  const best = nearestInTime(toTrackPoints(rows), at.getTime(), w);
  return best ? { lat: best.lat, lng: best.lng, t: new Date(best.t) } : null;
}

type StatusName = "departed" | "arrived" | "completed" | "failed";

async function noLocationEvent(tx: Tx, input: { tenantId: string; truckId: string; tripId: string; tripNumber: string; status: StatusName; at: Date; userId: string | null; rules: M12Rules; now: Date }) {
  const device = await devicePositionAt(tx, input.truckId, input.at, input.rules.fleet.inconsistency_window_minutes);
  await createFleetEvent(tx, {
    tenantId: input.tenantId,
    kind: "no_location",
    dedupeKey: `noloc:${input.tripId}:${input.status}`,
    truckId: input.truckId,
    tripId: input.tripId,
    userId: input.userId,
    businessDate: toBusinessDate(input.at),
    startedAt: input.at,
    lat: device?.lat ?? null,
    lng: device?.lng ?? null,
    status: "done",
    details: {
      tripNumber: input.tripNumber,
      tripStatus: input.status,
      tripStatusLabel: label("trip_status", input.status),
      // US-M12-04 KP-4: posisi perangkat saat itu (usulan koordinat alamat bila titik ponsel tidak ada).
      devicePosition: device ? { lat: device.lat, lng: device.lng, at: device.t.toISOString() } : null,
    },
    rule: "US-M3-02 KP-4, US-M12-01 KP-4",
    now: input.now,
  });
}

/** Handler `trip.departed` / `trip.arrived` / `trip.failed`: titik status + penanda tanpa lokasi. */
export async function handleTripStatus(
  tx: Tx,
  event: DomainEvent<"trip.departed"> | DomainEvent<"trip.arrived"> | DomainEvent<"trip.failed">,
): Promise<void> {
  const p = event.payload;
  const tenantId = event.tenantId;
  if (!tenantId || !p.truckId) return;
  const status: StatusName = event.type === "trip.departed" ? "departed" : event.type === "trip.arrived" ? "arrived" : "failed";
  const atIso = "departedAt" in p ? p.departedAt : "arrivedAt" in p ? p.arrivedAt : (p as { failedAt?: string }).failedAt;
  const at = atIso ? new Date(atIso) : event.occurredAt;
  const rules = await m12Rules(tx, p.businessDate ?? toBusinessDate(at), tenantId);
  const driverUserId = "driverUserId" in p ? (p.driverUserId ?? null) : null;
  await recordStatusPoint(tx, { tenantId, truckId: p.truckId, tripId: p.tripId, at, lat: p.lat, lng: p.lng, accuracyM: "accuracyM" in p ? p.accuracyM : null, userId: driverUserId, receivedAt: event.occurredAt, rules });
  if (p.noLocation) {
    await noLocationEvent(tx, { tenantId, truckId: p.truckId, tripId: p.tripId, tripNumber: p.tripNumber ?? "", status, at, userId: driverUserId, rules, now: event.occurredAt });
  }
  if (event.type === "trip.departed") await resolveLateDepartureEvents(tx, { tenantId, truckId: p.truckId, departedAt: at, tripNumber: p.tripNumber ?? "", now: event.occurredAt });
  if (event.type === "trip.failed") await upsertTripTrack(tx, p.tripId, event.occurredAt, { rules });
}

/**
 * Berangkat tersinkron terlambat (offline): kejadian "di luar jadwal" yang terdeteksi SETELAH waktu Berangkat di
 * perangkat ternyata bagian rit → otomatis Selesai (bukan penghapusan; berjejak).
 */
export async function resolveLateDepartureEvents(tx: Tx, input: { tenantId: string; truckId: string; departedAt: Date; tripNumber: string; now: Date }): Promise<number> {
  const rows = await tx
    .select()
    .from(fleetEvents)
    .where(
      and(
        eq(fleetEvents.truckId, input.truckId),
        inArray(fleetEvents.kind, ["off_schedule_trip", "off_hours_trip"]),
        eq(fleetEvents.status, "detected"),
        isNull(fleetEvents.explanation),
        gte(fleetEvents.startedAt, input.departedAt),
        lte(fleetEvents.startedAt, input.now),
      ),
    );
  const ctx = systemContext({ tenantId: input.tenantId, now: input.now });
  for (const ev of rows) {
    await tx
      .update(fleetEvents)
      .set({
        status: "done",
        requiresExplanation: false,
        doneAt: input.now,
        reviewNote: `Otomatis selesai: rit ${input.tripNumber} Berangkat pukul ${formatJam(input.departedAt)} tersinkron terlambat — perjalanan termasuk rit.`,
        details: { ...(ev.details ?? {}), autoResolved: "late_departure_sync" },
        updatedAt: input.now,
      })
      .where(eq(fleetEvents.id, ev.id));
    await auditRecord(tx, {
      ctx,
      objectType: "fleet_event",
      objectId: ev.id,
      action: "close",
      before: { status: ev.status, requiresExplanation: ev.requiresExplanation },
      after: { status: "done", requiresExplanation: false },
      reason: `Rit ${input.tripNumber} Berangkat tersinkron terlambat.`,
      rule: "US-M12-05 KP-1, Bab 6.4",
    });
  }
  return rows.length;
}

/** Handler `trip.completed` (US-M12-04 KP-1/KP-2/KP-4/KP-5; US-M12-03; US-M12-07). */
export async function handleTripCompleted(tx: Tx, event: DomainEvent<"trip.completed">): Promise<void> {
  const p = event.payload;
  const tenantId = event.tenantId;
  if (!tenantId || !p.truckId) return;
  const now = event.occurredAt;
  const at = new Date(p.completedAt);
  const date = p.businessDate ?? toBusinessDate(at);
  const rules = await m12Rules(tx, date, tenantId);
  await recordStatusPoint(tx, { tenantId, truckId: p.truckId, tripId: p.tripId, at, lat: p.lat, lng: p.lng, accuracyM: p.accuracyM, userId: p.driverUserId, receivedAt: now, rules });
  const [trip] = await tx.select().from(trips).where(eq(trips.id, p.tripId)).limit(1);
  if (!trip) return;
  const tripNumber = p.tripNumber ?? trip.number;
  if (p.noLocation || p.lat === null || p.lat === undefined || p.lng === null || p.lng === undefined) {
    await noLocationEvent(tx, { tenantId, truckId: p.truckId, tripId: p.tripId, tripNumber, status: "completed", at, userId: p.driverUserId, rules, now });
  } else {
    const point: LatLng = { lat: p.lat, lng: p.lng };
    await checkCompletionDeviation(tx, { tenantId, trip, tripNumber, point, at, date, rules, payload: p, now });
    await checkSourceConsistency(tx, { tenantId, truckId: p.truckId, trip, tripNumber, point, at, date, rules, userId: p.driverUserId, now });
  }
  await upsertTripTrack(tx, p.tripId, now, { rules });
}

/** KP-1/KP-4/KP-5: jarak titik Selesai → alamat (Dikunci) / depot (rit internal), tingkat 1 / tingkat 2. */
export async function checkCompletionDeviation(
  tx: Tx,
  input: {
    tenantId: string;
    trip: typeof trips.$inferSelect;
    tripNumber: string;
    point: LatLng;
    at: Date;
    date: string;
    rules: M12Rules;
    payload: DomainEvent<"trip.completed">["payload"];
    now: Date;
  },
): Promise<{ distanceM: number | null; level: 0 | 1 | 2 }> {
  const { trip, rules } = input;
  let target: (LatLng & { kind: "address" | "depot"; name: string }) | null = null;
  if (trip.isInternal && trip.destinationOutletId) {
    const [o] = await tx.select({ lat: outlets.lat, lng: outlets.lng, name: outlets.name }).from(outlets).where(eq(outlets.id, trip.destinationOutletId)).limit(1);
    if (o?.lat != null && o.lng != null) target = { lat: o.lat, lng: o.lng, kind: "depot", name: o.name };
  } else {
    const [a] = await tx
      .select({ lat: customerAddresses.lat, lng: customerAddresses.lng, status: customerAddresses.coordinateStatus, name: customers.name })
      .from(customerAddresses)
      .innerJoin(customers, eq(customers.id, customerAddresses.customerId))
      .where(eq(customerAddresses.id, trip.addressId))
      .limit(1);
    // KP-4: alamat Belum dikunci → tidak ada penyimpangan.
    if (a?.status === "locked" && a.lat != null && a.lng != null) target = { lat: a.lat, lng: a.lng, kind: "address", name: a.name };
  }
  if (!target) return { distanceM: null, level: 0 };
  const distanceM = Math.round(haversineMeters(input.point, target));
  const level: 0 | 1 | 2 = distanceM > rules.deviation.ownerReviewGtM ? 2 : distanceM > rules.deviation.reasonGtM ? 1 : 0;
  if (level === 0) return { distanceM, level };
  const reason = input.payload.locationReason ?? null;
  const { event, created } = await createFleetEvent(tx, {
    tenantId: input.tenantId,
    kind: level === 2 ? "location_deviation_l2" : "location_deviation_l1",
    dedupeKey: `loc:${trip.id}`,
    truckId: trip.truckId,
    tripId: trip.id,
    userId: input.payload.driverUserId,
    businessDate: input.date,
    startedAt: input.at,
    distanceM,
    lat: input.point.lat,
    lng: input.point.lng,
    locationType: target.kind === "depot" ? "outlet" : null,
    locationId: target.kind === "depot" ? trip.destinationOutletId : null,
    // Tingkat 1: alasan sopir sudah tercatat (6.2c) — informasi. Tingkat 2: menunggu tinjauan pemilik.
    status: level === 1 ? "done" : reason ? "explained" : "detected",
    details: {
      tripNumber: input.tripNumber,
      targetKind: target.kind,
      targetName: target.name,
      target: { lat: target.lat, lng: target.lng },
      reason,
      reasonLabel: reason ? label("location_reason", reason) : null,
      m3DistanceM: input.payload.distanceToAddressM ?? null,
      thresholds: rules.deviation,
    },
    rule: level === 2 ? "BR-23, US-M12-04 KP-1 (tingkat 2)" : "BR-23, US-M12-04 KP-1 (tingkat 1)",
    now: input.now,
  });
  // M3 sudah memberi tahu pemilik untuk tingkat 2 alamat pelanggan; M12 menambah hanya bila hitungan M3 berbeda
  // (mis. rit internal dibanding koordinat depot) — kunci grup sama sehingga tidak ganda.
  if (created && level === 2 && input.payload.locationDeviation !== "level2") {
    await notifyOnce(tx, {
      event: "trip.location_deviation",
      tenantId: input.tenantId,
      title: `Lokasi Selesai ${(distanceM / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} km dari ${target.kind === "depot" ? "depot" : "alamat"}: rit ${input.tripNumber}`,
      body: `${target.name}. Alasan sopir: ${reason ? label("location_reason", reason) : "—"}. Tinjau H+0 (BR-23).`,
      objectType: "fleet_event",
      objectId: event.id,
      valueText: `${distanceM} m`,
      link: eventLink(event.id),
      groupKey: `trip.location_deviation:${trip.id}`,
      now: input.now,
    });
  }
  return { distanceM, level };
}

/** KP-2: posisi perangkat GPS saat Selesai vs titik Selesai ponsel. Null bila tidak ada posisi perangkat di jendela. */
export async function checkSourceConsistency(
  tx: Tx,
  input: { tenantId: string; truckId: string; trip: typeof trips.$inferSelect; tripNumber: string; point: LatLng; at: Date; date: string; rules: M12Rules; userId: string | null; now: Date },
): Promise<{ distanceM: number | null; inconsistent: boolean }> {
  const device = await devicePositionAt(tx, input.truckId, input.at, input.rules.fleet.inconsistency_window_minutes);
  if (!device) return { distanceM: null, inconsistent: false };
  const distanceM = Math.round(haversineMeters(device, input.point));
  if (distanceM <= input.rules.fleet.source_inconsistent_gt_m) return { distanceM, inconsistent: false };
  const { event, created } = await createFleetEvent(tx, {
    tenantId: input.tenantId,
    kind: "location_source_inconsistent",
    dedupeKey: `src:${input.trip.id}`,
    truckId: input.truckId,
    tripId: input.trip.id,
    userId: input.userId,
    businessDate: input.date,
    startedAt: input.at,
    distanceM,
    lat: input.point.lat,
    lng: input.point.lng,
    details: {
      tripNumber: input.tripNumber,
      phonePoint: input.point,
      devicePoint: { lat: device.lat, lng: device.lng, at: device.t.toISOString() },
      thresholdM: input.rules.fleet.source_inconsistent_gt_m,
    },
    rule: "US-M12-04 KP-2",
    now: input.now,
  });
  if (created) {
    await notifyOnce(tx, {
      event: "fleet.location_inconsistent",
      tenantId: input.tenantId,
      title: `Sumber lokasi tidak konsisten: rit ${input.tripNumber}`,
      body: `Titik Selesai ponsel berjarak ${distanceM} m dari posisi GPS truk pada ${formatJam(device.t)} — Selesai mungkin ditekan bukan di lokasi truk. Tinjau H+0.`,
      objectType: "fleet_event",
      objectId: event.id,
      valueText: `${distanceM} m`,
      link: eventLink(event.id),
      groupKey: `fleet.location_inconsistent:${input.trip.id}`,
      now: input.now,
    });
  }
  return { distanceM, inconsistent: true };
}

/**
 * Job: periksa ulang konsistensi sumber lokasi rit Selesai dalam `hours` jam terakhir (posisi perangkat dapat tiba
 * setelah rit tersinkron). Idempoten (kunci `src:<rit>`).
 */
export async function recheckRecentCompletions(tx: Tx, tenantId: string, now: Date, hours = 3): Promise<number> {
  const since = new Date(now.getTime() - hours * 3_600_000);
  const rows = await tx
    .select()
    .from(trips)
    .where(and(eq(trips.tenantId, tenantId), eq(trips.status, "completed"), gte(trips.completedAt, since), lte(trips.completedAt, now)));
  let flagged = 0;
  for (const trip of rows) {
    if (!trip.truckId || trip.completedLat == null || trip.completedLng == null || !trip.completedAt) continue;
    const date = trip.completionBusinessDate ?? toBusinessDate(trip.completedAt);
    const rules = await m12Rules(tx, date, tenantId);
    const res = await checkSourceConsistency(tx, {
      tenantId,
      truckId: trip.truckId,
      trip,
      tripNumber: trip.number,
      point: { lat: trip.completedLat, lng: trip.completedLng },
      at: trip.completedAt,
      date,
      rules,
      userId: trip.driverUserId,
      now,
    });
    if (res.inconsistent) flagged++;
  }
  return flagged;
}
