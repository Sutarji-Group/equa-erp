/**
 * M12 — riwayat perjalanan per rit & per truk per hari (US-M12-03), putar ulang 24 jam (US-M12-02 KP-5).
 *
 * - Per rit (KP-1): jejak Berangkat → Selesai/Gagal (perangkat GPS + ponsel cadangan), jarak, durasi, titik berhenti ≥
 *   PAR-49 (lokasi & lama), lama di lokasi pelanggan (radius PAR-16), celah jejak; tautan bukti kirim (M3) & pengisian
 *   (M8). Hanya titik status → jarak estimasi rute peta (`RoutingProvider`) bertanda "estimasi" (KP-4).
 * - Per truk per hari (KP-2): jarak total, waktu bergerak/berhenti, gerak pertama & terakhir, jumlah rit, jarak antar-rit
 *   (kembali ke sumber), menit perangkat mati — berdampingan dengan rit terjadwal vs selesai (KPI-07).
 * - Ringkasan disimpan (`trip_tracks`, `truck_day_summaries`) sehingga tetap ada setelah posisi mentah dihapus retensi
 *   PAR-52 (US-M12-01 KP-6). Posisi mentah tidak diekspor (KP-3).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import {
  attachments,
  customerAddresses,
  customers,
  employees,
  fleetEvents,
  gpsPositions,
  orders,
  outlets,
  tripTracks,
  truckDaySummaries,
  truckFills,
  trips,
  trucks,
  users,
  waterSources,
} from "@/db/schema";
import { withRetentionPurge } from "@/db/hardening";
import { haversineMeters, type LatLng } from "@/lib/geo";
import { addDays, businessDateToUtcRange, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { NotFoundError, parseInput } from "@/server/core/errors";
import { routeDistance } from "@/server/core/maps";
import { authorize, assertTruckScope } from "@/server/core/rbac";

import {
  cleanTrack,
  detectStops,
  locationContaining,
  pathDistanceM,
  sampleEvenly,
  simplifyPath,
  summarizeActivity,
  timeWithinRadiusS,
  trackGaps,
  type TrackPoint,
} from "../domain/track";
import { historyFilterSchema, replaySchema, truckDaySchema } from "../schemas";
import { fleetTrucks, legalLocations, m12Rules, positionsBetween, toTrackPoints, tenantsWithTrucks, tripInterval, type LegalLocation, type M12Rules, type TripRow } from "./common";
import { deviceOutageMinutesOn } from "./devices";
import { upsertFuelEstimate } from "./fuel";

export type StopView = { lat: number; lng: number; startedAt: string; endedAt: string; durationS: number; place: string | null };

export type TripTrackData = {
  tripId: string;
  truckId: string;
  startedAt: Date | null;
  endedAt: Date | null;
  distanceM: number | null;
  durationS: number | null;
  stops: StopView[];
  timeAtCustomerS: number | null;
  path: [number, number][];
  isEstimated: boolean;
  hasGaps: boolean;
  gaps: { from: string; to: string; durationS: number }[];
  source: "gps_device" | "phone" | "mixed" | "status_point";
  pointCount: number;
  target: { lat: number; lng: number; kind: "address" | "depot" } | null;
};

/** Tujuan pembanding rit: koordinat alamat (bila ada) atau koordinat depot untuk rit internal (US-M12-04 KP-5). */
export async function tripTarget(tx: Tx, trip: TripRow): Promise<TripTrackData["target"]> {
  if (trip.isInternal && trip.destinationOutletId) {
    const [o] = await tx.select({ lat: outlets.lat, lng: outlets.lng }).from(outlets).where(eq(outlets.id, trip.destinationOutletId)).limit(1);
    if (o?.lat != null && o.lng != null) return { lat: o.lat, lng: o.lng, kind: "depot" };
  }
  const [a] = await tx.select({ lat: customerAddresses.lat, lng: customerAddresses.lng }).from(customerAddresses).where(eq(customerAddresses.id, trip.addressId)).limit(1);
  if (a?.lat != null && a.lng != null) return { lat: a.lat, lng: a.lng, kind: "address" };
  return null;
}

function placeOf(p: LatLng, locations: readonly LegalLocation[], target: TripTrackData["target"], customerRadiusM: number): string | null {
  if (target && haversineMeters(p, target) <= customerRadiusM) return target.kind === "depot" ? "Depot tujuan" : "Lokasi pelanggan";
  return locationContaining(p, locations)?.name ?? null;
}

function toStopViews(points: TrackPoint[], rules: M12Rules, locations: readonly LegalLocation[], target: TripTrackData["target"]): StopView[] {
  return detectStops(points, { radiusM: rules.fleet.stop_radius_m, minDurationS: rules.stopMinMinutes * 60 }).map((s) => ({
    lat: s.lat,
    lng: s.lng,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: new Date(s.endedAt).toISOString(),
    durationS: s.durationS,
    place: placeOf(s, locations, target, rules.deviation.reasonGtM),
  }));
}

/** Hitung jejak satu rit (tanpa menyimpan). */
export async function computeTripTrackData(tx: Tx, trip: TripRow, now: Date, cache: { rules?: M12Rules; locations?: LegalLocation[] } = {}): Promise<TripTrackData | null> {
  if (!trip.truckId || !trip.departedAt) return null;
  const rules = cache.rules ?? (await m12Rules(tx, trip.completionBusinessDate ?? trip.scheduledDate, trip.tenantId));
  const locations = cache.locations ?? (await legalLocations(tx, trip.tenantId, rules));
  const end = trip.completedAt ?? trip.failedAt ?? now;
  const rows = await positionsBetween(tx, trip.truckId, trip.departedAt, end, { sources: ["gps_device", "phone"] });
  const deviceCount = rows.filter((r) => r.source === "gps_device").length;
  const phoneCount = rows.length - deviceCount;
  const points = cleanTrack(toTrackPoints(rows), rules.fleet.max_plausible_speed_kmh);
  const target = await tripTarget(tx, trip);
  const base = {
    tripId: trip.id,
    truckId: trip.truckId,
    startedAt: trip.departedAt,
    endedAt: trip.completedAt ?? trip.failedAt ?? null,
    durationS: Math.round((end.getTime() - trip.departedAt.getTime()) / 1000),
    target,
  };
  if (points.length >= 2) {
    const gaps = trackGaps(points, rules.fleet.track_gap_minutes * 60_000);
    let atCustomer = target ? timeWithinRadiusS(points, target, rules.deviation.reasonGtM) : null;
    if (!atCustomer && trip.arrivedAt && trip.completedAt) atCustomer = Math.max(0, Math.round((trip.completedAt.getTime() - trip.arrivedAt.getTime()) / 1000));
    return {
      ...base,
      distanceM: Math.round(pathDistanceM(points)),
      stops: toStopViews(points, rules, locations, target),
      timeAtCustomerS: atCustomer,
      path: simplifyPath(points, 15).map((p) => [p.lat, p.lng] as [number, number]),
      isEstimated: false,
      hasGaps: gaps.length > 0,
      gaps: gaps.map((g) => ({ from: new Date(g.from).toISOString(), to: new Date(g.to).toISOString(), durationS: g.durationS })),
      source: deviceCount && phoneCount ? "mixed" : deviceCount ? "gps_device" : "phone",
      pointCount: points.length,
    };
  }
  // KP-4: hanya titik status ponsel → jarak estimasi rute peta dari titik Berangkat ke titik Selesai/Gagal (atau tujuan).
  const from: LatLng | null = trip.departedLat != null && trip.departedLng != null ? { lat: trip.departedLat, lng: trip.departedLng } : null;
  const toPoint: LatLng | null =
    trip.completedLat != null && trip.completedLng != null
      ? { lat: trip.completedLat, lng: trip.completedLng }
      : trip.failLat != null && trip.failLng != null
        ? { lat: trip.failLat, lng: trip.failLng }
        : target;
  let distanceM: number | null = null;
  if (from && toPoint) distanceM = (await routeDistance(from, toPoint)).meters;
  const statusPath = [from, trip.arrivedLat != null && trip.arrivedLng != null ? { lat: trip.arrivedLat, lng: trip.arrivedLng } : null, toPoint].filter((p): p is LatLng => !!p);
  return {
    ...base,
    distanceM,
    stops: [],
    timeAtCustomerS: trip.arrivedAt && trip.completedAt ? Math.max(0, Math.round((trip.completedAt.getTime() - trip.arrivedAt.getTime()) / 1000)) : null,
    path: statusPath.map((p) => [p.lat, p.lng] as [number, number]),
    isEstimated: true,
    hasGaps: true,
    gaps: [],
    source: "status_point",
    pointCount: statusPath.length,
  };
}

/** Hitung & simpan jejak rit (idempoten; dihitung ulang bila posisi terlambat masuk). */
export async function upsertTripTrack(tx: Tx, tripId: string, now: Date, cache: { rules?: M12Rules; locations?: LegalLocation[] } = {}): Promise<TripTrackData | null> {
  const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!trip) return null;
  const data = await computeTripTrackData(tx, trip, now, cache);
  if (!data) return null;
  const values = {
    truckId: data.truckId,
    startedAt: data.startedAt,
    endedAt: data.endedAt,
    distanceM: data.distanceM,
    durationS: data.durationS,
    stops: data.stops as unknown as Record<string, unknown>[],
    timeAtCustomerS: data.timeAtCustomerS,
    path: data.path,
    isEstimated: data.isEstimated,
    hasGaps: data.hasGaps,
    computedAt: now,
    updatedAt: now,
  };
  const existing = await tx.select({ id: tripTracks.id }).from(tripTracks).where(eq(tripTracks.tripId, tripId)).limit(1);
  if (existing[0]) await tx.update(tripTracks).set(values).where(eq(tripTracks.id, existing[0].id));
  else await tx.insert(tripTracks).values({ tripId, ...values, createdAt: now }).onConflictDoNothing();
  if (trip.status === "completed" && !trip.isInternal) {
    await upsertFuelEstimate(tx, { trip, distanceM: data.distanceM, now, rules: cache.rules });
  }
  return data;
}

// =====================================================================================================================
// Per truk per hari
// =====================================================================================================================

export type TruckDayData = {
  truckId: string;
  date: BusinessDate;
  distanceM: number | null;
  movingS: number;
  stoppedS: number;
  firstMoveAt: Date | null;
  lastMoveAt: Date | null;
  tripCount: number;
  betweenTripDistanceM: number | null;
  gpsDeadMinutes: number;
  isEstimated: boolean;
  /** KPI-07: rit terjadwal (terbit, tidak ditarik) vs Selesai. */
  scheduledTrips: number;
  completedTrips: number;
  failedTrips: number;
  stops: StopView[];
  path: [number, number][];
  pointCount: number;
};

/** Hitung ringkasan satu truk satu hari (tanpa menyimpan). */
export async function computeTruckDayData(tx: Tx, truckId: string, tenantId: string, date: BusinessDate, now: Date, cache: { rules?: M12Rules; locations?: LegalLocation[] } = {}): Promise<TruckDayData> {
  const rules = cache.rules ?? (await m12Rules(tx, date, tenantId));
  const locations = cache.locations ?? (await legalLocations(tx, tenantId, rules));
  const range = businessDateToUtcRange(date);
  const end = new Date(Math.min(range.end.getTime() - 1, now.getTime()));
  const rows = end.getTime() > range.start.getTime() ? await positionsBetween(tx, truckId, range.start, end, { sources: ["gps_device", "phone"] }) : [];
  const points = cleanTrack(toTrackPoints(rows), rules.fleet.max_plausible_speed_kmh);
  const activity = summarizeActivity(points, { stopRadiusM: rules.fleet.stop_radius_m, minStopS: rules.stopMinMinutes * 60, minMoveM: rules.fleet.min_move_m });

  const dayTrips = await tx
    .select()
    .from(trips)
    .where(and(eq(trips.truckId, truckId), or(eq(trips.scheduledDate, date), eq(trips.completionBusinessDate, date))))
    .orderBy(asc(trips.departedAt));
  const scheduled = dayTrips.filter((t) => t.scheduledDate === date && t.publishedAt && !t.withdrawnAt);
  const completed = dayTrips.filter((t) => t.status === "completed" && (t.completionBusinessDate ?? t.scheduledDate) === date);
  const failed = dayTrips.filter((t) => t.status === "failed" && (t.completionBusinessDate ?? t.scheduledDate) === date);

  // Jarak antar-rit: gerak di luar interval rit, di antara Berangkat pertama dan akhir rit terakhir (kembali ke sumber).
  const intervals = dayTrips.map((t) => tripInterval(t, now.getTime())).filter((x): x is { start: number; end: number } => !!x);
  let betweenM: number | null = null;
  if (intervals.length >= 2 && points.length >= 2) {
    const first = Math.min(...intervals.map((i) => i.start));
    const last = Math.max(...intervals.map((i) => i.end));
    const inTrip = (t: number) => intervals.some((i) => t >= i.start && t <= i.end);
    betweenM = 0;
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1]!;
      const b = points[k]!;
      if (a.t >= first && b.t <= last && !inTrip(a.t) && !inTrip(b.t)) betweenM += haversineMeters(a, b);
    }
    betweenM = Math.round(betweenM);
  }

  let distanceM: number | null = points.length >= 2 ? activity.distanceM : null;
  let isEstimated = false;
  if (distanceM === null && (completed.length || failed.length)) {
    // Hanya titik status → jumlah jarak estimasi per rit (KP-4).
    const tracks = await tx.select({ distanceM: tripTracks.distanceM }).from(tripTracks).where(inArray(tripTracks.tripId, [...completed, ...failed].map((t) => t.id)));
    const sum = tracks.reduce((s, t) => s + (t.distanceM ?? 0), 0);
    distanceM = sum || null;
    isEstimated = true;
  }
  const dead = await deviceOutageMinutesOn(tx, [truckId], date, now);
  return {
    truckId,
    date,
    distanceM,
    movingS: activity.movingS,
    stoppedS: activity.stoppedS,
    firstMoveAt: activity.firstMoveAt ? new Date(activity.firstMoveAt) : null,
    lastMoveAt: activity.lastMoveAt ? new Date(activity.lastMoveAt) : null,
    tripCount: completed.length,
    betweenTripDistanceM: betweenM,
    gpsDeadMinutes: dead.get(truckId) ?? 0,
    isEstimated,
    scheduledTrips: scheduled.length,
    completedTrips: completed.length,
    failedTrips: failed.length,
    stops: activity.stops.map((s) => ({
      lat: s.lat,
      lng: s.lng,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(s.endedAt).toISOString(),
      durationS: s.durationS,
      place: locationContaining(s, locations)?.name ?? null,
    })),
    path: simplifyPath(points, 20).map((p) => [p.lat, p.lng] as [number, number]),
    pointCount: points.length,
  };
}

/** Simpan ringkasan truk per hari (idempoten). */
export async function upsertTruckDaySummary(tx: Tx, truckId: string, tenantId: string, date: BusinessDate, now: Date, cache: { rules?: M12Rules; locations?: LegalLocation[] } = {}): Promise<TruckDayData> {
  const d = await computeTruckDayData(tx, truckId, tenantId, date, now, cache);
  const values = {
    distanceM: d.distanceM,
    movingS: d.movingS,
    stoppedS: d.stoppedS,
    firstMoveAt: d.firstMoveAt,
    lastMoveAt: d.lastMoveAt,
    tripCount: d.tripCount,
    betweenTripDistanceM: d.betweenTripDistanceM,
    gpsDeadMinutes: d.gpsDeadMinutes,
    isEstimated: d.isEstimated,
    computedAt: now,
    updatedAt: now,
  };
  const existing = await tx.select({ id: truckDaySummaries.id }).from(truckDaySummaries).where(and(eq(truckDaySummaries.truckId, truckId), eq(truckDaySummaries.businessDate, date))).limit(1);
  if (existing[0]) await tx.update(truckDaySummaries).set(values).where(eq(truckDaySummaries.id, existing[0].id));
  else await tx.insert(truckDaySummaries).values({ truckId, businessDate: date, ...values, createdAt: now }).onConflictDoNothing();
  return d;
}

/**
 * Job harian: jejak rit & ringkasan truk hari kemarin (dan hari-hari tertinggal dalam `catchUpDays`), estimasi BBM.
 * Idempoten — menghitung ulang bila posisi terlambat masuk.
 */
export async function runDailySummaries(now: Date, db?: Db, opts: { date?: BusinessDate; catchUpDays?: number } = {}): Promise<{ trips: number; truckDays: number }> {
  const today = toBusinessDate(now);
  const dates = opts.date ? [opts.date] : Array.from({ length: opts.catchUpDays ?? 3 }, (_, i) => addDays(today, -(i + 1)));
  return withTx(
    async (tx) => {
      let tripCount = 0;
      let dayCount = 0;
      for (const tenantId of await tenantsWithTrucks(tx)) {
        for (const date of dates) {
          const rules = await m12Rules(tx, date, tenantId);
          const locations = await legalLocations(tx, tenantId, rules);
          const cache = { rules, locations };
          const doneTrips = await tx
            .select({ id: trips.id })
            .from(trips)
            .where(and(eq(trips.tenantId, tenantId), isNotNull(trips.departedAt), inArray(trips.status, ["completed", "failed"]), eq(trips.completionBusinessDate, date)));
          for (const t of doneTrips) {
            await upsertTripTrack(tx, t.id, now, cache);
            tripCount++;
          }
          // Kemarin (atau tanggal yang diminta) selalu dihitung ulang; hari-hari sebelumnya hanya yang belum berringkasan.
          const always = !!opts.date || date === addDays(today, -1);
          const have = always
            ? new Set<string>()
            : new Set((await tx.select({ truckId: truckDaySummaries.truckId }).from(truckDaySummaries).where(eq(truckDaySummaries.businessDate, date))).map((e) => e.truckId));
          for (const truck of await fleetTrucks(tx, tenantId, { includeInactive: true })) {
            if (have.has(truck.id)) continue;
            await upsertTruckDaySummary(tx, truck.id, tenantId, date, now, cache);
            dayCount++;
          }
        }
      }
      return { trips: tripCount, truckDays: dayCount };
    },
    { db },
  );
}

/**
 * Retensi posisi mentah PAR-52 (US-M12-01 KP-6, PTB-33): ringkasan per rit/hari dipastikan tersimpan untuk hari-hari
 * yang akan dihapus, lalu posisi lebih tua dari PAR-52 bulan dihapus lewat `withRetentionPurge` (satu-satunya jalur hapus
 * yang diizinkan trigger pengerasan). Ringkasan tidak pernah dihapus.
 */
export async function purgeExpiredPositions(now: Date, db?: Db): Promise<{ cutoff: BusinessDate; summariesEnsured: number; purged: number }> {
  const database = db ?? getDb();
  const today = toBusinessDate(now);
  const tenants = await tenantsWithTrucks(database);
  if (tenants.length === 0) return { cutoff: today, summariesEnsured: 0, purged: 0 };
  const months = (await m12Rules(database, today, tenants[0]!)).retentionMonths;
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const cutoff = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`;
  const cutoffAt = wibToUtc(cutoff);
  // Hari bertanda posisi yang akan dihapus tetapi belum berringkasan → hitung dulu.
  const pending = await database
    .selectDistinct({ truckId: gpsPositions.truckId, tenantId: gpsPositions.tenantId, day: sql<string>`to_char(${gpsPositions.deviceTime} at time zone 'Asia/Jakarta', 'YYYY-MM-DD')` })
    .from(gpsPositions)
    .leftJoin(truckDaySummaries, and(eq(truckDaySummaries.truckId, gpsPositions.truckId), sql`${truckDaySummaries.businessDate} = to_char(${gpsPositions.deviceTime} at time zone 'Asia/Jakarta', 'YYYY-MM-DD')::date`))
    .where(and(lt(gpsPositions.deviceTime, cutoffAt), isNull(truckDaySummaries.id)));
  let ensured = 0;
  if (pending.length) {
    await withTx(
      async (tx) => {
        for (const p of pending) {
          await upsertTruckDaySummary(tx, p.truckId, p.tenantId, p.day, now);
          ensured++;
        }
        const tripsPending = await tx
          .select({ id: trips.id })
          .from(trips)
          .leftJoin(tripTracks, eq(tripTracks.tripId, trips.id))
          .where(and(isNotNull(trips.departedAt), lt(trips.departedAt, cutoffAt), inArray(trips.status, ["completed", "failed"]), isNull(tripTracks.id)));
        for (const t of tripsPending) await upsertTripTrack(tx, t.id, now);
      },
      { db: database },
    );
  }
  const purged = await withRetentionPurge(database, async (tx) => {
    const rows = await tx.delete(gpsPositions).where(lt(gpsPositions.deviceTime, cutoffAt)).returning({ id: gpsPositions.id });
    return rows.length;
  });
  return { cutoff, summariesEnsured: ensured, purged };
}

// =====================================================================================================================
// Layar riwayat (US-M12-03) & putar ulang (US-M12-02 KP-5)
// =====================================================================================================================

export type TripHistoryRow = {
  tripId: string;
  number: string;
  orderId: string;
  status: string;
  isInternal: boolean;
  truckId: string;
  truckCode: string;
  customerName: string;
  driverName: string | null;
  departedAt: Date | null;
  endedAt: Date | null;
  distanceM: number | null;
  durationS: number | null;
  stopCount: number;
  stopTotalS: number;
  timeAtCustomerS: number | null;
  isEstimated: boolean;
  hasGaps: boolean;
  computed: boolean;
  /** US-M3-02 KP-2: urutan rencana Dispatcher vs urutan Berangkat aktual (M3 `actual_order`). */
  plannedOrder: number | null;
  actualOrder: number | null;
  outOfOrder: boolean;
};

async function tripRowsForDate(tx: Tx, tenantId: string, date: BusinessDate, truckId?: string) {
  return tx
    .select({ t: trips, truckCode: trucks.code, customerName: customers.name, driverName: employees.fullName, track: tripTracks })
    .from(trips)
    .innerJoin(trucks, eq(trucks.id, trips.truckId))
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .leftJoin(users, eq(users.id, trips.driverUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .leftJoin(tripTracks, eq(tripTracks.tripId, trips.id))
    .where(
      and(
        eq(trips.tenantId, tenantId),
        isNotNull(trips.departedAt),
        or(eq(trips.completionBusinessDate, date), and(eq(trips.scheduledDate, date), inArray(trips.status, ["departed", "arrived"])))!,
        truckId ? eq(trips.truckId, truckId) : sql`true`,
      ),
    )
    .orderBy(asc(trucks.code), asc(trips.departedAt));
}

type TripTrackView = TripHistoryRow & { stops: StopView[] };

/** Jejak rit pada tanggal: dari `trip_tracks` bila sudah dihitung setelah rit berakhir, bila tidak dihitung langsung. */
async function tripTrackViews(tx: Tx, tenantId: string, date: BusinessDate, now: Date, truckId?: string): Promise<TripTrackView[]> {
  const rules = await m12Rules(tx, date, tenantId);
  const locations = await legalLocations(tx, tenantId, rules);
  const rows = await tripRowsForDate(tx, tenantId, date, truckId);
  const out: TripTrackView[] = [];
  for (const r of rows) {
    const ended = r.t.completedAt ?? r.t.failedAt;
    const fresh = r.track && ended && r.track.computedAt && r.track.computedAt.getTime() >= ended.getTime();
    const live = fresh ? null : await computeTripTrackData(tx, r.t, now, { rules, locations });
    const stops = (fresh ? (r.track!.stops as unknown as StopView[] | null) : live?.stops) ?? [];
    out.push({
      tripId: r.t.id,
      number: r.t.number,
      orderId: r.t.orderId,
      status: r.t.status,
      isInternal: r.t.isInternal,
      truckId: r.t.truckId!,
      truckCode: r.truckCode,
      customerName: r.customerName,
      driverName: r.driverName,
      departedAt: r.t.departedAt,
      endedAt: ended,
      distanceM: fresh ? r.track!.distanceM : (live?.distanceM ?? null),
      durationS: fresh ? r.track!.durationS : (live?.durationS ?? null),
      stopCount: stops.length,
      stopTotalS: stops.reduce((sum, x) => sum + x.durationS, 0),
      timeAtCustomerS: fresh ? r.track!.timeAtCustomerS : (live?.timeAtCustomerS ?? null),
      isEstimated: fresh ? r.track!.isEstimated : (live?.isEstimated ?? false),
      hasGaps: fresh ? r.track!.hasGaps : (live?.hasGaps ?? false),
      computed: !!fresh,
      plannedOrder: r.t.routeOrder,
      actualOrder: r.t.actualOrder,
      outOfOrder: r.t.actualOrder !== null && r.t.routeOrder !== null && r.t.actualOrder !== r.t.routeOrder,
      stops,
    });
  }
  return out;
}

/** Daftar rit dengan jejak pada tanggal (Selesai/Gagal pada tanggal itu + rit berjalan). */
export async function listTripHistory(ctx: ActorContext, input: unknown = {}, opts: { tx?: Tx } = {}): Promise<{ date: BusinessDate; rows: TripHistoryRow[] }> {
  await authorize(ctx, "m12.trip_history.read", { tx: opts.tx });
  const data = parseInput(historyFilterSchema, input, { date: "Tanggal", truckId: "Truk" });
  const tx = opts.tx ?? getDb();
  const date = data.date ?? ctxBusinessDate(ctx);
  const views = await tripTrackViews(tx, ctx.tenantId, date, ctx.now, data.truckId);
  return { date, rows: views.map(({ stops: _stops, ...row }) => row) };
}

export type TripHistoryDetail = {
  trip: TripRow;
  truckCode: string;
  customerName: string;
  addressText: string;
  driverName: string | null;
  orderNumber: string;
  track: TripTrackData;
  statusPoints: { status: string; at: Date; lat: number; lng: number }[];
  photos: { id: string; kind: string }[];
  fill: { id: string; volumeL: number; filledAt: Date; waterSourceName: string; geofenceFlag: boolean } | null;
  events: { id: string; kind: string; status: string; startedAt: Date; distanceM: number | null }[];
};

/** Rincian riwayat satu rit: jejak, titik berhenti, titik status, bukti kirim & pengisian, kejadian terkait. */
export async function getTripHistory(ctx: ActorContext, tripId: string, opts: { tx?: Tx } = {}): Promise<TripHistoryDetail> {
  await authorize(ctx, "m12.trip_history.read", { tx: opts.tx, objectType: "trip", objectId: tripId });
  const tx = opts.tx ?? getDb();
  const [row] = await tx
    .select({ t: trips, truckCode: trucks.code, customerName: customers.name, addressText: customerAddresses.addressText, driverName: employees.fullName, orderNumber: orders.number })
    .from(trips)
    .innerJoin(trucks, eq(trucks.id, trips.truckId))
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .leftJoin(users, eq(users.id, trips.driverUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(trips.id, tripId))
    .limit(1);
  if (!row || row.t.tenantId !== ctx.tenantId) throw new NotFoundError("Rit tidak ditemukan.");
  const track = await computeTripTrackData(tx, row.t, ctx.now);
  if (!track) throw new NotFoundError("Rit ini belum Berangkat — belum ada jejak perjalanan.");
  const t = row.t;
  const statusPoints = [
    t.departedAt && t.departedLat != null && t.departedLng != null ? { status: "departed", at: t.departedAt, lat: t.departedLat, lng: t.departedLng } : null,
    t.arrivedAt && t.arrivedLat != null && t.arrivedLng != null ? { status: "arrived", at: t.arrivedAt, lat: t.arrivedLat, lng: t.arrivedLng } : null,
    t.completedAt && t.completedLat != null && t.completedLng != null ? { status: "completed", at: t.completedAt, lat: t.completedLat, lng: t.completedLng } : null,
    t.failedAt && t.failLat != null && t.failLng != null ? { status: "failed", at: t.failedAt, lat: t.failLat, lng: t.failLng } : null,
  ].filter((x): x is { status: string; at: Date; lat: number; lng: number } => !!x);
  const photos = await tx
    .select({ id: attachments.id, kind: attachments.kind })
    .from(attachments)
    .where(and(eq(attachments.objectType, "trip"), eq(attachments.objectId, tripId)))
    .orderBy(asc(attachments.createdAt));
  const [fill] = await tx
    .select({ id: truckFills.id, volumeL: truckFills.volumeL, filledAt: truckFills.filledAt, waterSourceName: waterSources.name })
    .from(truckFills)
    .innerJoin(waterSources, eq(waterSources.id, truckFills.waterSourceId))
    .where(and(eq(truckFills.tripId, tripId), isNull(truckFills.reversalOfId), isNull(truckFills.reversedAt)))
    .limit(1);
  const events = await tx
    .select({ id: fleetEvents.id, kind: fleetEvents.kind, status: fleetEvents.status, startedAt: fleetEvents.startedAt, distanceM: fleetEvents.distanceM, details: fleetEvents.details })
    .from(fleetEvents)
    .where(eq(fleetEvents.tripId, tripId))
    .orderBy(asc(fleetEvents.startedAt));
  const fillFlag = fill ? events.some((e) => e.kind === "fill_without_geofence" && (e.details as { truckFillId?: string } | null)?.truckFillId === fill.id) : false;
  return {
    trip: t,
    truckCode: row.truckCode,
    customerName: row.customerName,
    addressText: row.addressText,
    driverName: row.driverName,
    orderNumber: row.orderNumber,
    track,
    statusPoints,
    photos: photos.map((p) => ({ id: p.id, kind: p.kind })),
    fill: fill ? { ...fill, geofenceFlag: fillFlag } : null,
    events: events.map(({ details: _d, ...e }) => e),
  };
}

export type TruckDayRow = TruckDayData & { truckCode: string; plateNumber: string; persisted: boolean };

/** Ringkasan semua truk pada tanggal (hari lalu dari tabel ringkasan; hari ini dihitung langsung). */
export async function listTruckDays(ctx: ActorContext, input: unknown = {}, opts: { tx?: Tx } = {}): Promise<{ date: BusinessDate; rows: TruckDayRow[] }> {
  await authorize(ctx, "m12.trip_history.read", { tx: opts.tx });
  const data = parseInput(historyFilterSchema, input, { date: "Tanggal" });
  const tx = opts.tx ?? getDb();
  const date = data.date ?? ctxBusinessDate(ctx);
  const rules = await m12Rules(tx, date, ctx.tenantId);
  const locations = await legalLocations(tx, ctx.tenantId, rules);
  const fleet = await fleetTrucks(tx, ctx.tenantId, { truckIds: data.truckId ? [data.truckId] : undefined });
  const rows: TruckDayRow[] = [];
  for (const t of fleet) {
    const d = await computeTruckDayData(tx, t.id, ctx.tenantId, date, ctx.now, { rules, locations });
    const [persisted] = await tx.select({ id: truckDaySummaries.id }).from(truckDaySummaries).where(and(eq(truckDaySummaries.truckId, t.id), eq(truckDaySummaries.businessDate, date))).limit(1);
    rows.push({ ...d, truckCode: t.code, plateNumber: t.plateNumber, persisted: !!persisted });
  }
  return { date, rows };
}

export type TruckDayDetail = TruckDayData & {
  truckCode: string;
  plateNumber: string;
  trips: { id: string; number: string; status: string; customerName: string; departedAt: Date | null; endedAt: Date | null; distanceM: number | null; isEstimated: boolean }[];
  events: { id: string; kind: string; status: string; startedAt: Date; durationS: number | null; distanceM: number | null }[];
};

/** Rincian satu truk satu hari: jejak, titik berhenti, rit (jarak per rit), kejadian, KPI-07. */
export async function getTruckDay(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<TruckDayDetail> {
  await authorize(ctx, "m12.trip_history.read", { tx: opts.tx });
  const data = parseInput(truckDaySchema, input, { truckId: "Truk", date: "Tanggal" });
  const tx = opts.tx ?? getDb();
  const [truck] = await tx.select().from(trucks).where(eq(trucks.id, data.truckId)).limit(1);
  if (!truck || truck.tenantId !== ctx.tenantId) throw new NotFoundError("Truk tidak ditemukan.");
  const rules = await m12Rules(tx, data.date, ctx.tenantId);
  const locations = await legalLocations(tx, ctx.tenantId, rules);
  const day = await computeTruckDayData(tx, truck.id, ctx.tenantId, data.date, ctx.now, { rules, locations });
  const history = await listTripHistory(ctx, { date: data.date, truckId: truck.id }, { tx });
  const events = await tx
    .select({ id: fleetEvents.id, kind: fleetEvents.kind, status: fleetEvents.status, startedAt: fleetEvents.startedAt, durationS: fleetEvents.durationS, distanceM: fleetEvents.distanceM })
    .from(fleetEvents)
    .where(and(eq(fleetEvents.truckId, truck.id), eq(fleetEvents.businessDate, data.date), ne(fleetEvents.kind, "geofence_enter"), ne(fleetEvents.kind, "geofence_exit")))
    .orderBy(asc(fleetEvents.startedAt));
  return {
    ...day,
    truckCode: truck.code,
    plateNumber: truck.plateNumber,
    trips: history.rows.map((r) => ({ id: r.tripId, number: r.number, status: r.status, customerName: r.customerName, departedAt: r.departedAt, endedAt: r.endedAt, distanceM: r.distanceM, isEstimated: r.isEstimated })),
    events,
  };
}

export type ReplayData = {
  truckId: string;
  truckCode: string;
  from: Date;
  to: Date;
  points: { t: string; lat: number; lng: number; speedKmh: number | null; source: string }[];
  statusPoints: { status: string; at: string; lat: number; lng: number; tripNumber: string }[];
  stops: StopView[];
};

/** Putar ulang jejak truk `replay_hours` jam terakhir (US-M12-02 KP-5; US-M12-03 KP-3). Hanya peran berizin peta. */
export async function getReplay(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<ReplayData> {
  await authorize(ctx, "m12.position.read", { tx: opts.tx });
  const data = parseInput(replaySchema, input, { truckId: "Truk", to: "Waktu" });
  const tx = opts.tx ?? getDb();
  await assertTruckScope(tx, ctx, data.truckId);
  const [truck] = await tx.select({ id: trucks.id, code: trucks.code, tenantId: trucks.tenantId }).from(trucks).where(eq(trucks.id, data.truckId)).limit(1);
  if (!truck || truck.tenantId !== ctx.tenantId) throw new NotFoundError("Truk tidak ditemukan.");
  const rules = await m12Rules(tx, ctxBusinessDate(ctx), ctx.tenantId);
  const locations = await legalLocations(tx, ctx.tenantId, rules);
  const to = data.to ? new Date(data.to) : ctx.now;
  const from = new Date(to.getTime() - rules.fleet.replay_hours * 3_600_000);
  const rows = await positionsBetween(tx, truck.id, from, to, { sources: ["gps_device", "phone"] });
  const clean = cleanTrack(
    rows.map((r) => ({ t: r.deviceTime.getTime(), lat: r.lat, lng: r.lng, speedKmh: r.speedKmh, source: r.source })),
    rules.fleet.max_plausible_speed_kmh,
  );
  const tripRows = await tx
    .select({ t: trips })
    .from(trips)
    .where(and(eq(trips.truckId, truck.id), isNotNull(trips.departedAt), lte(trips.departedAt, to), or(gte(trips.departedAt, from), gte(trips.completedAt, from), gte(trips.failedAt, from))))
    .orderBy(desc(trips.departedAt));
  const statusPoints: ReplayData["statusPoints"] = [];
  for (const { t } of tripRows) {
    const add = (status: string, at: Date | null, lat: number | null, lng: number | null) => {
      if (at && lat != null && lng != null && at >= from && at <= to) statusPoints.push({ status, at: at.toISOString(), lat, lng, tripNumber: t.number });
    };
    add("departed", t.departedAt, t.departedLat, t.departedLng);
    add("arrived", t.arrivedAt, t.arrivedLat, t.arrivedLng);
    add("completed", t.completedAt, t.completedLat, t.completedLng);
    add("failed", t.failedAt, t.failLat, t.failLng);
  }
  statusPoints.sort((a, b) => a.at.localeCompare(b.at));
  return {
    truckId: truck.id,
    truckCode: truck.code,
    from,
    to,
    points: sampleEvenly(clean, 1500).map((p) => ({ t: new Date(p.t).toISOString(), lat: p.lat, lng: p.lng, speedKmh: p.speedKmh ?? null, source: p.source })),
    statusPoints,
    stops: detectStops(clean, { radiusM: rules.fleet.stop_radius_m, minDurationS: rules.stopMinMinutes * 60 }).map((s) => ({
      lat: s.lat,
      lng: s.lng,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(s.endedAt).toISOString(),
      durationS: s.durationS,
      place: locationContaining(s, locations)?.name ?? null,
    })),
  };
}

/** Titik berhenti per rit dalam rentang tanggal (ekspor Excel titik berhenti, US-M12-03 KP-3 — tanpa posisi mentah). */
export async function stopsReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; truckId?: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m12.trip_history.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const out: { date: BusinessDate; truckCode: string; tripNumber: string; customerName: string; startedAt: Date; endedAt: Date; durationMin: number; place: string | null; lat: number; lng: number }[] = [];
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    for (const r of await tripTrackViews(tx, ctx.tenantId, d, ctx.now, input.truckId)) {
      for (const st of r.stops) {
        out.push({ date: d, truckCode: r.truckCode, tripNumber: r.number, customerName: r.customerName, startedAt: new Date(st.startedAt), endedAt: new Date(st.endedAt), durationMin: Math.round(st.durationS / 60), place: st.place, lat: st.lat, lng: st.lng });
      }
    }
  }
  return out;
}

/** Ringkasan perjalanan per rit untuk rentang tanggal (ekspor PDF/Excel ringkasan, US-M12-03 KP-3). */
export async function tripSummaryReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; truckId?: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m12.trip_history.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const out: (TripHistoryRow & { date: BusinessDate })[] = [];
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    for (const { stops: _stops, ...r } of await tripTrackViews(tx, ctx.tenantId, d, ctx.now, input.truckId)) out.push({ ...r, date: d });
  }
  return out;
}

/** Ringkasan truk per hari untuk rentang tanggal (ekspor, KPI-07). */
export async function truckDayReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; truckId?: string }, opts: { tx?: Tx } = {}) {
  const out: (TruckDayRow & { date: BusinessDate })[] = [];
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    const res = await listTruckDays(ctx, { date: d, truckId: input.truckId }, opts);
    for (const r of res.rows) out.push({ ...r, date: d });
  }
  return out;
}
