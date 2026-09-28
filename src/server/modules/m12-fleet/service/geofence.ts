/**
 * M12 — geofence sumber air, depot & pool (US-M12-06, S; P-04 langkah 2–3; FR-M8-02; FR-M6-05).
 *
 * - KP-1: radius per lokasi (master M1, bawaan PAR-54) → kejadian masuk/keluar per truk dengan waktu & lama
 *   (`geofence_enter` diperbarui lamanya saat keluar + `geofence_exit`). Histeresis `geofence_exit_margin_m`.
 * - KP-2: pengisian M8 tanpa posisi truk di geofence sumber dalam ± `fill_geofence_window_minutes` → ditandai
 *   (`fill_without_geofence`); truk di geofence sumber > `source_dwell_without_fill_minutes` tanpa pengisian tercatat →
 *   ditandai (`geofence_without_fill`). Dinilai setelah jendela lewat (pengisian dapat tersinkron terlambat).
 * - KP-3: rit internal (pasokan depot) Selesai tanpa posisi truk di geofence depot tujuan → `supply_without_geofence`.
 * - KP-4: kejadian bertanda masuk daftar tinjauan pemilik (+ notifikasi) dan dapat dibaca M8 (neraca air) lewat
 *   `geofenceFlagsFor` / event `fleet_event.detected`. Hanya dinilai bila perangkat GPS truk memang mengirim posisi pada
 *   jendela itu (tanpa data = tidak dapat diverifikasi, bukan pelanggaran).
 */
import "server-only";

import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { fleetEvents, outlets, truckFills, trips, waterSources } from "@/db/schema";
import { haversineMeters } from "@/lib/geo";
import { formatJam, toBusinessDate, type BusinessDate } from "@/lib/time";

import { withTx, type Db, type Tx } from "@/server/core/db";

import { cleanTrack, locationContaining, type TrackPoint } from "../domain/track";
import { fleetTrucks, hasWorkingGps, legalLocations, m12Rules, positionsBetween, tenantsWithTrucks, toTrackPoints, type FleetTruck, type LegalLocation, type M12Rules } from "./common";
import { createFleetEvent, eventLink, extendFleetEvent, notifyOnce, type FleetEventRow } from "./fleet-events";

export type GeofenceRunResult = { truckId: string; entered: number; exited: number; flags: number };

async function lastGeofenceEvent(tx: Tx, truckId: string): Promise<FleetEventRow | null> {
  const rows = await tx
    .select()
    .from(fleetEvents)
    .where(and(eq(fleetEvents.truckId, truckId), inArray(fleetEvents.kind, ["geofence_enter", "geofence_exit"])))
    .orderBy(desc(fleetEvents.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function openVisit(tx: Tx, truckId: string): Promise<FleetEventRow | null> {
  const rows = await tx
    .select()
    .from(fleetEvents)
    .where(and(eq(fleetEvents.truckId, truckId), eq(fleetEvents.kind, "geofence_enter"), isNull(fleetEvents.endedAt)))
    .orderBy(desc(fleetEvents.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Proses kunjungan geofence satu truk dari posisi valid sesudah kejadian geofence terakhir (KP-1). */
export async function processTruckGeofences(tx: Tx, truck: FleetTruck, now: Date, cache: { rules: M12Rules; locations: LegalLocation[] }): Promise<GeofenceRunResult> {
  const { rules, locations } = cache;
  const result: GeofenceRunResult = { truckId: truck.id, entered: 0, exited: 0, flags: 0 };
  const windowStart = new Date(now.getTime() - rules.fleet.detection_lookback_hours * 3_600_000);
  const last = await lastGeofenceEvent(tx, truck.id);
  const from = last && last.startedAt > windowStart ? new Date(last.startedAt.getTime() + 1) : windowStart;
  const rows = await positionsBetween(tx, truck.id, from, now, { sources: ["gps_device"] });
  const points = cleanTrack(toTrackPoints(rows), rules.fleet.max_plausible_speed_kmh);
  let visit = await openVisit(tx, truck.id);
  let visitLoc = visit ? (locations.find((l) => l.id === visit!.locationId) ?? null) : null;
  let lastInside: TrackPoint | null = null;
  for (const p of points) {
    if (visit && visitLoc) {
      if (haversineMeters(p, visitLoc) <= visitLoc.radiusM + rules.fleet.geofence_exit_margin_m) {
        lastInside = p;
        continue;
      }
      const exitAt = new Date((lastInside ?? p).t);
      await closeVisit(tx, { truck, visit, loc: visitLoc, exitAt, now });
      result.exited++;
      visit = null;
      visitLoc = null;
      lastInside = null;
    } else if (visit && !visitLoc) {
      // Lokasi sudah nonaktif — tutup kunjungan pada titik ini.
      await extendFleetEvent(tx, visit, { endedAt: new Date(p.t), durationS: Math.round((p.t - visit.startedAt.getTime()) / 1000) }, now);
      visit = null;
    }
    const loc = locationContaining(p, locations);
    if (loc) {
      const at = new Date(p.t);
      const res = await createFleetEvent(tx, {
        tenantId: truck.tenantId,
        kind: "geofence_enter",
        dedupeKey: `geo-in:${truck.id}:${loc.id}:${at.toISOString()}`,
        truckId: truck.id,
        deviceId: truck.gpsDeviceId,
        businessDate: toBusinessDate(at),
        startedAt: at,
        lat: loc.lat,
        lng: loc.lng,
        locationType: loc.type,
        locationId: loc.id,
        status: "done",
        details: { locationName: loc.name, radiusM: loc.radiusM },
        rule: "US-M12-06 KP-1, PAR-54",
        now,
      });
      visit = res.event;
      visitLoc = loc;
      lastInside = p;
      if (res.created) result.entered++;
    }
  }
  return result;
}

async function closeVisit(tx: Tx, input: { truck: FleetTruck; visit: FleetEventRow; loc: LegalLocation; exitAt: Date; now: Date }): Promise<void> {
  const { truck, visit, loc, exitAt, now } = input;
  const durationS = Math.max(0, Math.round((exitAt.getTime() - visit.startedAt.getTime()) / 1000));
  await extendFleetEvent(tx, visit, { endedAt: exitAt, durationS }, now);
  await createFleetEvent(tx, {
    tenantId: truck.tenantId,
    kind: "geofence_exit",
    dedupeKey: `geo-out:${truck.id}:${loc.id}:${exitAt.toISOString()}`,
    truckId: truck.id,
    deviceId: truck.gpsDeviceId,
    businessDate: toBusinessDate(exitAt),
    startedAt: exitAt,
    durationS,
    lat: loc.lat,
    lng: loc.lng,
    locationType: loc.type,
    locationId: loc.id,
    status: "done",
    details: { locationName: loc.name, enterEventId: visit.id, enteredAt: visit.startedAt.toISOString() },
    rule: "US-M12-06 KP-1",
    now,
  });
}

/** Posisi valid perangkat GPS truk dalam jendela ± menit di sekitar `at`. */
async function devicePointsAround(tx: Tx, truckId: string, from: Date, to: Date): Promise<TrackPoint[]> {
  return toTrackPoints(await positionsBetween(tx, truckId, from, to, { sources: ["gps_device"] }));
}

async function flagMismatch(
  tx: Tx,
  input: {
    truck: FleetTruck;
    kind: "fill_without_geofence" | "geofence_without_fill" | "supply_without_geofence";
    key: string;
    startedAt: Date;
    endedAt?: Date | null;
    durationS?: number | null;
    tripId?: string | null;
    lat: number;
    lng: number;
    locationType: "water_source" | "outlet";
    locationId: string;
    details: Record<string, unknown>;
    title: string;
    body: string;
    now: Date;
  },
): Promise<boolean> {
  const { event, created } = await createFleetEvent(tx, {
    tenantId: input.truck.tenantId,
    kind: input.kind,
    dedupeKey: input.key,
    truckId: input.truck.id,
    tripId: input.tripId ?? null,
    deviceId: input.truck.gpsDeviceId,
    businessDate: toBusinessDate(input.startedAt),
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    durationS: input.durationS ?? null,
    lat: input.lat,
    lng: input.lng,
    locationType: input.locationType,
    locationId: input.locationId,
    details: input.details,
    rule: input.kind === "supply_without_geofence" ? "US-M12-06 KP-3" : "US-M12-06 KP-2",
    now: input.now,
  });
  if (created) {
    await notifyOnce(tx, {
      event: "fleet.geofence_mismatch",
      tenantId: input.truck.tenantId,
      title: input.title,
      body: input.body,
      objectType: "fleet_event",
      objectId: event.id,
      link: eventLink(event.id),
      groupKey: `fleet.geofence_mismatch:${event.id}`,
      now: input.now,
    });
  }
  return created;
}

/** KP-2 (a): pengisian tanpa posisi truk di geofence sumber ± jendela. Dinilai setelah jendela lewat. */
export async function checkFillGeofence(tx: Tx, fillId: string, now: Date): Promise<"flagged" | "ok" | "pending" | "unverifiable"> {
  const [fill] = await tx
    .select({ f: truckFills, sourceName: waterSources.name, sourceLat: waterSources.lat, sourceLng: waterSources.lng, sourceRadius: waterSources.geofenceRadiusM })
    .from(truckFills)
    .innerJoin(waterSources, eq(waterSources.id, truckFills.waterSourceId))
    .where(eq(truckFills.id, fillId))
    .limit(1);
  if (!fill || fill.f.reversalOfId || fill.f.reversedAt) return "ok";
  const rules = await m12Rules(tx, fill.f.businessDate, fill.f.tenantId);
  const w = rules.fleet.fill_geofence_window_minutes * 60_000;
  if (now.getTime() < fill.f.filledAt.getTime() + w) return "pending";
  const [truck] = await fleetTrucks(tx, fill.f.tenantId, { truckIds: [fill.f.truckId], includeInactive: true });
  if (!truck || !hasWorkingGps(truck)) return "unverifiable";
  const points = await devicePointsAround(tx, truck.id, new Date(fill.f.filledAt.getTime() - w), new Date(fill.f.filledAt.getTime() + w));
  if (points.length === 0) return "unverifiable";
  const radius = fill.sourceRadius ?? rules.geofence.waterSourceM;
  const center = { lat: fill.sourceLat, lng: fill.sourceLng };
  if (points.some((p) => haversineMeters(p, center) <= radius)) return "ok";
  const created = await flagMismatch(tx, {
    truck,
    kind: "fill_without_geofence",
    key: `fill:${fill.f.id}`,
    startedAt: fill.f.filledAt,
    tripId: fill.f.tripId,
    lat: center.lat,
    lng: center.lng,
    locationType: "water_source",
    locationId: fill.f.waterSourceId,
    details: { truckFillId: fill.f.id, waterSourceId: fill.f.waterSourceId, sourceName: fill.sourceName, volumeL: fill.f.volumeL, windowMinutes: rules.fleet.fill_geofence_window_minutes },
    title: `Pengisian truk ${truck.code} di ${fill.sourceName} tanpa truk di sumber`,
    body: `Pengisian ${fill.f.volumeL.toLocaleString("id-ID")} L pukul ${formatJam(fill.f.filledAt)}: posisi GPS truk tidak masuk geofence sumber ± ${rules.fleet.fill_geofence_window_minutes} menit. Periksa pencatatan (neraca air M8).`,
    now,
  });
  return created ? "flagged" : "ok";
}

/** KP-2 (b): kunjungan sumber > ambang tanpa pengisian tercatat (dinilai setelah jendela sinkron pengisian lewat). */
export async function checkSourceVisitsWithoutFill(tx: Tx, truck: FleetTruck, now: Date, rules: M12Rules): Promise<number> {
  const w = rules.fleet.fill_geofence_window_minutes * 60_000;
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const visits = await tx
    .select()
    .from(fleetEvents)
    .where(
      and(
        eq(fleetEvents.truckId, truck.id),
        eq(fleetEvents.kind, "geofence_enter"),
        eq(fleetEvents.locationType, "water_source"),
        gte(fleetEvents.startedAt, since),
        sql`${fleetEvents.endedAt} is not null`,
        lte(fleetEvents.endedAt, new Date(now.getTime() - w)),
        sql`${fleetEvents.durationS} > ${rules.fleet.source_dwell_without_fill_minutes * 60}`,
      ),
    );
  let flagged = 0;
  for (const v of visits) {
    const fills = await tx
      .select({ id: truckFills.id })
      .from(truckFills)
      .where(
        and(
          eq(truckFills.truckId, truck.id),
          eq(truckFills.waterSourceId, v.locationId!),
          isNull(truckFills.reversalOfId),
          isNull(truckFills.reversedAt),
          gte(truckFills.filledAt, new Date(v.startedAt.getTime() - w)),
          lte(truckFills.filledAt, new Date(v.endedAt!.getTime() + w)),
        ),
      )
      .limit(1);
    if (fills[0]) continue;
    const name = (v.details as { locationName?: string } | null)?.locationName ?? "sumber";
    const minutes = Math.round((v.durationS ?? 0) / 60);
    if (
      await flagMismatch(tx, {
        truck,
        kind: "geofence_without_fill",
        key: `nofill:${v.id}`,
        startedAt: v.startedAt,
        endedAt: v.endedAt,
        durationS: v.durationS,
        lat: v.lat ?? 0,
        lng: v.lng ?? 0,
        locationType: "water_source",
        locationId: v.locationId!,
        details: { enterEventId: v.id, waterSourceId: v.locationId, sourceName: name, dwellMinutes: minutes, thresholdMinutes: rules.fleet.source_dwell_without_fill_minutes },
        title: `Truk ${truck.code} ${minutes} menit di ${name} tanpa pengisian tercatat`,
        body: `Truk berada di geofence ${name} ${formatJam(v.startedAt)}–${formatJam(v.endedAt!)} tanpa catatan pengisian operator (M8). Periksa pencatatan (neraca air).`,
        now,
      })
    )
      flagged++;
  }
  return flagged;
}

/** KP-3: rit internal Selesai tanpa posisi truk di geofence depot tujuan (dinilai setelah jendela lewat). */
export async function checkInternalSupplyGeofence(tx: Tx, truck: FleetTruck, now: Date, rules: M12Rules): Promise<number> {
  const w = rules.fleet.fill_geofence_window_minutes * 60_000;
  const rows = await tx
    .select({ t: trips, outletName: outlets.name, outletLat: outlets.lat, outletLng: outlets.lng, outletRadius: outlets.geofenceRadiusM })
    .from(trips)
    .innerJoin(outlets, eq(outlets.id, trips.destinationOutletId))
    .where(
      and(
        eq(trips.truckId, truck.id),
        eq(trips.isInternal, true),
        eq(trips.status, "completed"),
        gte(trips.completedAt, new Date(now.getTime() - 24 * 3_600_000)),
        lte(trips.completedAt, new Date(now.getTime() - w)),
      ),
    );
  let flagged = 0;
  for (const r of rows) {
    if (!r.t.departedAt || !r.t.completedAt || r.outletLat == null || r.outletLng == null) continue;
    const points = await devicePointsAround(tx, truck.id, r.t.departedAt, new Date(r.t.completedAt.getTime() + w));
    if (points.length === 0) continue; // tanpa data perangkat: tidak dapat diverifikasi
    const center = { lat: r.outletLat, lng: r.outletLng };
    const radius = r.outletRadius ?? rules.geofence.outletM;
    if (points.some((p) => haversineMeters(p, center) <= radius)) continue;
    if (
      await flagMismatch(tx, {
        truck,
        kind: "supply_without_geofence",
        key: `supply:${r.t.id}`,
        startedAt: r.t.completedAt,
        tripId: r.t.id,
        lat: center.lat,
        lng: center.lng,
        locationType: "outlet",
        locationId: r.t.destinationOutletId!,
        details: { tripNumber: r.t.number, outletName: r.outletName, volumeL: r.t.deliveredVolumeL },
        title: `Pasokan ${r.outletName} (rit ${r.t.number}) tanpa truk masuk geofence depot`,
        body: `Rit internal Selesai pukul ${formatJam(r.t.completedAt)} tetapi posisi GPS truk ${truck.code} tidak pernah masuk geofence depot. Periksa penerimaan pasokan (M6/M8).`,
        now,
      })
    )
      flagged++;
  }
  return flagged;
}

/** Job tiap 5 menit: kunjungan geofence + pencocokan pengisian/pasokan. */
export async function runGeofenceProcessing(now: Date, db?: Db): Promise<GeofenceRunResult[]> {
  return withTx(
    async (tx) => {
      const out: GeofenceRunResult[] = [];
      for (const tenantId of await tenantsWithTrucks(tx)) {
        const date = toBusinessDate(now);
        const rules = await m12Rules(tx, date, tenantId);
        const locations = await legalLocations(tx, tenantId, rules);
        for (const truck of await fleetTrucks(tx, tenantId)) {
          if (!hasWorkingGps(truck)) continue;
          const res = await processTruckGeofences(tx, truck, now, { rules, locations });
          res.flags += await checkSourceVisitsWithoutFill(tx, truck, now, rules);
          res.flags += await checkInternalSupplyGeofence(tx, truck, now, rules);
          out.push(res);
        }
        const w = rules.fleet.fill_geofence_window_minutes * 60_000;
        const fills = await tx
          .select({ id: truckFills.id })
          .from(truckFills)
          .where(
            and(
              eq(truckFills.tenantId, tenantId),
              isNull(truckFills.reversalOfId),
              isNull(truckFills.reversedAt),
              gte(truckFills.filledAt, new Date(now.getTime() - 24 * 3_600_000)),
              lte(truckFills.filledAt, new Date(now.getTime() - w)),
            ),
          );
        for (const f of fills) await checkFillGeofence(tx, f.id, now);
      }
      return out;
    },
    { db },
  );
}

/** Penanda geofence untuk pertimbangan neraca air M8 (US-M12-06 KP-4): per sumber air & tanggal. */
export async function geofenceFlagsFor(tx: Tx, input: { tenantId: string; date: BusinessDate; waterSourceId?: string }) {
  return tx
    .select()
    .from(fleetEvents)
    .where(
      and(
        eq(fleetEvents.tenantId, input.tenantId),
        eq(fleetEvents.businessDate, input.date),
        inArray(fleetEvents.kind, ["fill_without_geofence", "geofence_without_fill", "supply_without_geofence"]),
        input.waterSourceId ? or(eq(fleetEvents.locationId, input.waterSourceId), sql`${fleetEvents.details} ->> 'waterSourceId' = ${input.waterSourceId}`) : sql`true`,
      ),
    );
}
