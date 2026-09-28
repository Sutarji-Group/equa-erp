/**
 * M12 — deteksi perjalanan di luar jadwal/jam & berhenti tidak dikenal (US-M12-05; BR-25; P-01 langkah 8; 7.12.6).
 *
 * Job tiap 5 menit menilai jejak perangkat GPS (posisi VALID saja — KP-5 US-M12-01) dalam jendela
 * `detection_lookback_hours`:
 * - Segmen gerak (di antara titik berhenti ≥ PAR-49) dipotong oleh interval rit (Berangkat → Selesai/Gagal). Potongan di
 *   LUAR rit yang sudah berakhir (truk berhenti / rit dimulai) dinilai:
 *   · berakhir di lokasi sah (sumber air, depot, pool — PTB-34, radius M1/PAR-54) → perjalanan yang diharapkan (ke
 *     sumber sebelum/antar rit, kembali ke pool setelah rit terakhir) → tidak ditandai;
 *   · menyentuh luar jam layanan PAR-07 → "perjalanan di luar jam layanan";
 *   · > PAR-50 meter ATAU > PAR-50 menit → "perjalanan di luar jadwal".
 * - Selama rit aktif, berhenti > PAR-51 menit di luar alamat rit (radius PAR-16), sumber, depot, pool → "berhenti tidak
 *   dikenal" (dinilai juga saat masih berlangsung).
 * - Setiap kejadian memuat waktu, lokasi, jarak/durasi, truk, pengguna aktif; notifikasi Dispatcher & pemilik (6.3);
 *   `requires_explanation` → tugas keterangan sopir hari itu di aplikasi M3 (BR-25).
 * - Dinonaktifkan per truk bila perangkat GPS belum terpasang/aktif (R05), bila flag `fleet.offschedule_detection` mati
 *   untuk truk itu, atau `trucks.fleet_detection_enabled` = false. Truk Perbaikan: gerak dicatat "perjalanan perbaikan"
 *   tanpa keterangan (7.12.6).
 */
import "server-only";

import { and, eq, isNotNull, or } from "drizzle-orm";

import { customerAddresses, outlets, trips } from "@/db/schema";
import { haversineMeters, type LatLng } from "@/lib/geo";
import { formatJam, toBusinessDate, toWibParts } from "@/lib/time";

import { withTx, type Db, type Tx } from "@/server/core/db";
import { isEnabled } from "@/server/core/flags";

import { cleanTrack, detectStops, locationContaining, movementSegments, runsOutside, type Interval, type Run, type Stop } from "../domain/track";
import {
  activeUserOnTruck,
  fleetTrucks,
  hasWorkingGps,
  inServiceHours,
  legalLocations,
  m12Rules,
  positionsBetween,
  tenantsWithTrucks,
  toTrackPoints,
  tripInterval,
  tripsTouching,
  type FleetTruck,
  type LegalLocation,
  type M12Rules,
} from "./common";
import { createFleetEvent, eventLink, extendFleetEvent, findFleetEventByKey } from "./fleet-events";
import { notify } from "@/server/core/notifications";

export type DetectionTruckResult = {
  truckId: string;
  truckCode: string;
  skipped: "no_device" | "flag_off" | "disabled" | null;
  created: number;
  updated: number;
};

/** Apakah deteksi aktif untuk truk (flag per truk + master truk + perangkat GPS aktif). */
export async function detectionEnabledFor(tx: Tx, truck: FleetTruck): Promise<DetectionTruckResult["skipped"]> {
  if (!truck.fleetDetectionEnabled) return "disabled";
  if (!hasWorkingGps(truck)) return "no_device";
  if (!(await isEnabled(tx, "fleet.offschedule_detection", { tenantId: truck.tenantId, truckId: truck.id }))) return "flag_off";
  return null;
}

function touchesOffHours(rules: M12Rules, points: { t: number }[], from: number, to: number): boolean {
  for (let i = from; i <= to; i++) if (!inServiceHours(rules, new Date(points[i]!.t))) return true;
  return false;
}

async function tripAddressPoints(tx: Tx, truckId: string, dates: string[]): Promise<LatLng[]> {
  const rows = await tx
    .select({ lat: customerAddresses.lat, lng: customerAddresses.lng, isInternal: trips.isInternal, outletLat: outlets.lat, outletLng: outlets.lng })
    .from(trips)
    .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
    .leftJoin(outlets, eq(outlets.id, trips.destinationOutletId))
    .where(and(eq(trips.truckId, truckId), or(...dates.map((d) => eq(trips.scheduledDate, d)))!, isNotNull(trips.publishedAt)));
  const out: LatLng[] = [];
  for (const r of rows) {
    if (r.lat != null && r.lng != null) out.push({ lat: r.lat, lng: r.lng });
    if (r.isInternal && r.outletLat != null && r.outletLng != null) out.push({ lat: r.outletLat, lng: r.outletLng });
  }
  return out;
}

/** Nilai satu truk pada `now` (idempoten per kunci segmen/titik berhenti). */
export async function detectTruckTravel(
  tx: Tx,
  truck: FleetTruck,
  now: Date,
  cache: { rules: M12Rules; locations: LegalLocation[] },
): Promise<DetectionTruckResult> {
  const result: DetectionTruckResult = { truckId: truck.id, truckCode: truck.code, skipped: null, created: 0, updated: 0 };
  const skip = await detectionEnabledFor(tx, truck);
  if (skip) {
    result.skipped = skip;
    return result;
  }
  const { rules, locations } = cache;
  const from = new Date(now.getTime() - rules.fleet.detection_lookback_hours * 3_600_000);
  const rows = await positionsBetween(tx, truck.id, from, now, { sources: ["gps_device"] });
  const points = cleanTrack(toTrackPoints(rows), rules.fleet.max_plausible_speed_kmh);
  if (points.length < 2) return result;
  const tripRows = await tripsTouching(tx, truck.id, from, now);
  const intervals: Interval[] = tripRows.map((t) => tripInterval(t, now.getTime())).filter((x): x is Interval => !!x);
  const maintenance = truck.status === "maintenance";

  // --- Segmen gerak di luar rit (KP-1) ---
  const stops = detectStops(points, { radiusM: rules.fleet.stop_radius_m, minDurationS: rules.stopMinMinutes * 60 });
  const segments = movementSegments(points, stops, { minMoveM: rules.fleet.min_move_m });
  for (const seg of segments) {
    for (const run of runsOutside(points, seg, intervals, { minMoveM: rules.fleet.min_move_m })) {
      if (!run.ended) continue;
      const created = await evaluateRun(tx, { truck, run, points, rules, locations, maintenance, now });
      if (created) result.created++;
    }
  }

  // --- Berhenti tidak dikenal selama rit aktif (KP-2) ---
  if (!maintenance) {
    const dates = [...new Set(tripRows.map((t) => t.scheduledDate))];
    const addresses = dates.length ? await tripAddressPoints(tx, truck.id, dates) : [];
    for (const stop of stops) {
      if (stop.durationS <= rules.unknownStopMinutesGt * 60) continue;
      const trip = tripRows.find((t) => {
        const iv = tripInterval(t, now.getTime());
        return iv && stop.startedAt >= iv.start && stop.startedAt <= iv.end;
      });
      if (!trip) continue;
      if (locationContaining(stop, locations)) continue;
      if (addresses.some((a) => haversineMeters(stop, a) <= rules.deviation.reasonGtM)) continue;
      const res = await recordUnknownStop(tx, { truck, trip, stop, rules, now, ongoing: stop.endIndex === points.length - 1 });
      if (res === "created") result.created++;
      if (res === "updated") result.updated++;
    }
  }
  return result;
}

async function evaluateRun(
  tx: Tx,
  input: { truck: FleetTruck; run: Run; points: { t: number }[]; rules: M12Rules; locations: LegalLocation[]; maintenance: boolean; now: Date },
): Promise<boolean> {
  const { truck, run, rules, locations, maintenance, now } = input;
  const endLocation = locationContaining(run.end, locations);
  const startLocation = locationContaining(run.start, locations);
  const offHours = touchesOffHours(rules, input.points, run.startIndex, run.endIndex);
  let kind: "maintenance_trip" | "off_hours_trip" | "off_schedule_trip";
  if (maintenance) kind = "maintenance_trip";
  else if (endLocation) return false; // perjalanan yang diharapkan menuju lokasi sah (sumber/depot/pool)
  else if (offHours) kind = "off_hours_trip";
  else if (run.distanceM > rules.offSchedule.distanceMGt || run.durationS > rules.offSchedule.minutesGt * 60) kind = "off_schedule_trip";
  else return false;
  const startedAt = new Date(run.startedAt);
  const endedAt = new Date(run.endedAt);
  const userId = await activeUserOnTruck(tx, truck.id, startedAt);
  const { event, created } = await createFleetEvent(tx, {
    tenantId: truck.tenantId,
    kind,
    dedupeKey: `move:${truck.id}:${startedAt.toISOString()}`,
    truckId: truck.id,
    deviceId: truck.gpsDeviceId,
    userId,
    businessDate: toBusinessDate(startedAt),
    startedAt,
    endedAt,
    durationS: run.durationS,
    distanceM: run.distanceM,
    lat: run.end.lat,
    lng: run.end.lng,
    requiresExplanation: kind !== "maintenance_trip",
    details: {
      start: run.start,
      end: run.end,
      startPlace: startLocation?.name ?? null,
      endedByDeparture: run.endedByInterval,
      offHours,
      serviceHours: rules.serviceHours,
      thresholds: rules.offSchedule,
    },
    rule: kind === "maintenance_trip" ? "7.12.6 (truk Perbaikan)" : kind === "off_hours_trip" ? "BR-25, US-M12-05 KP-1, PAR-07" : "BR-25, US-M12-05 KP-1, PAR-50",
    now,
  });
  if (!created || kind === "maintenance_trip") return created;
  const km = (run.distanceM / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 });
  const minutes = Math.round(run.durationS / 60);
  const what = kind === "off_hours_trip" ? "di luar jam layanan" : "tanpa rit Berangkat";
  await notify(tx, {
    event: "fleet.off_schedule",
    tenantId: truck.tenantId,
    title: `Truk ${truck.code} bergerak ${what} (${km} km, ${minutes} menit)`,
    body: `${formatJam(startedAt)}–${formatJam(endedAt)} WIB, berakhir di luar lokasi sah. Sopir diminta keterangan hari ini (BR-25).`,
    objectType: "fleet_event",
    objectId: event.id,
    valueText: `${km} km`,
    link: eventLink(event.id),
    groupKey: `fleet.off_schedule:${event.id}`,
    now,
  });
  if (userId) await notifyDriver(tx, { tenantId: truck.tenantId, userId, eventId: event.id, title: `Keterangan perjalanan truk ${truck.code} ${formatJam(startedAt)}–${formatJam(endedAt)}`, now });
  return true;
}

async function recordUnknownStop(
  tx: Tx,
  input: { truck: FleetTruck; trip: { id: string; number: string; driverUserId: string | null }; stop: Stop; rules: M12Rules; now: Date; ongoing: boolean },
): Promise<"created" | "updated" | "none"> {
  const { truck, trip, stop, now } = input;
  const startedAt = new Date(stop.startedAt);
  const key = `stop:${truck.id}:${startedAt.toISOString()}`;
  const existing = await findFleetEventByKey(tx, truck.tenantId, key);
  if (existing) {
    const after = await extendFleetEvent(tx, existing, { endedAt: new Date(stop.endedAt), durationS: stop.durationS, details: { ongoing: input.ongoing } }, now);
    return after !== existing ? "updated" : "none";
  }
  const { event, created } = await createFleetEvent(tx, {
    tenantId: truck.tenantId,
    kind: "unknown_stop",
    dedupeKey: key,
    truckId: truck.id,
    tripId: trip.id,
    deviceId: truck.gpsDeviceId,
    userId: trip.driverUserId,
    businessDate: toBusinessDate(startedAt),
    startedAt,
    endedAt: new Date(stop.endedAt),
    durationS: stop.durationS,
    lat: stop.lat,
    lng: stop.lng,
    requiresExplanation: true,
    details: { tripNumber: trip.number, ongoing: input.ongoing, thresholdMinutes: input.rules.unknownStopMinutesGt },
    rule: "BR-25, US-M12-05 KP-2, PAR-51",
    now,
  });
  if (!created) return "none";
  const minutes = Math.round(stop.durationS / 60);
  await notify(tx, {
    event: "fleet.unknown_stop",
    tenantId: truck.tenantId,
    title: `Truk ${truck.code} berhenti ${minutes} menit di luar lokasi sah (rit ${trip.number})`,
    body: `Sejak ${formatJam(startedAt)} WIB, bukan di alamat rit, sumber, depot, atau pool. Sopir diminta keterangan hari ini (BR-25).`,
    objectType: "fleet_event",
    objectId: event.id,
    valueText: `${minutes} menit`,
    link: eventLink(event.id),
    groupKey: `fleet.unknown_stop:${event.id}`,
    now,
  });
  if (trip.driverUserId) await notifyDriver(tx, { tenantId: truck.tenantId, userId: trip.driverUserId, eventId: event.id, title: `Keterangan berhenti rit ${trip.number} sejak ${formatJam(startedAt)}`, now });
  return "created";
}

/** Pemberitahuan ke sopir (tampil di aplikasi M3 sebagai pemberitahuan; tugas keterangan dari `requires_explanation`). */
export async function notifyDriver(tx: Tx, input: { tenantId: string; userId: string; eventId: string; title: string; now: Date }): Promise<void> {
  await notify(tx, {
    event: "fleet.explanation_requested",
    tenantId: input.tenantId,
    recipients: { userIds: [input.userId] },
    title: input.title,
    body: "Isi keterangan perjalanan di aplikasi sopir (menu Keterangan) hari ini.",
    objectType: "fleet_event",
    objectId: input.eventId,
    groupKey: `fleet.explanation_requested:${input.eventId}`,
    now: input.now,
  });
}

/** Job tiap 5 menit: deteksi perjalanan untuk semua truk aktif. */
export async function runTravelDetection(now: Date, db?: Db): Promise<DetectionTruckResult[]> {
  return withTx(
    async (tx) => {
      const out: DetectionTruckResult[] = [];
      for (const tenantId of await tenantsWithTrucks(tx)) {
        const rules = await m12Rules(tx, toBusinessDate(now), tenantId);
        const locations = await legalLocations(tx, tenantId, rules);
        for (const truck of await fleetTrucks(tx, tenantId)) out.push(await detectTruckTravel(tx, truck, now, { rules, locations }));
      }
      return out;
    },
    { db },
  );
}

/** Jam WIB (HH:mm) — pembantu uji/tampilan. */
export function wibTime(d: Date): string {
  return toWibParts(d).time;
}
