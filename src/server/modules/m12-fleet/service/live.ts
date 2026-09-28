/**
 * M12 — peta posisi truk real-time (US-M12-02; FR-M12-01; NFR-19; NFR-24).
 *
 * `getFleetSnapshot` (izin `m12.position.read` — hanya pemilik & Dispatcher; peran lain TIDAK mendapat data posisi,
 * KP-4): per truk nomor, status (rit aktif ke pelanggan X / menuju sumber / di sumber / di depot / berhenti / di luar
 * jadwal …), sopir hari itu (M2 `resolveDayCrews`) + kontak, kecepatan, umur posisi terakhir (basi > PAR-48), rit hari
 * ini & berikutnya, perkiraan jarak & waktu ke tujuan (`RoutingProvider`, NFR-24), status perangkat GPS/ponsel cadangan.
 * Lapisan: alamat rit hari ini, sumber air, depot, pool, zona tarif (perkiraan radius dari sumber acuan). Interval
 * pembaruan klien = PAR-26 (≤ 1 menit).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { customerAddresses, customers, employees, fleetEvents, gpsPositions, outlets, tariffZones, trips } from "@/db/schema";
import { STRAIGHT_LINE_ROUTE_FACTOR, type LatLng } from "@/lib/geo";
import { label } from "@/lib/labels";
import { isBusinessDate, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { routeDistance } from "@/server/core/maps";
import { authorize } from "@/server/core/rbac";
import { resolveDayCrews } from "@/server/modules/m2-orders";

import { deriveLiveStatus, LIVE_STATUS_TONE, type FleetLiveStatus } from "../domain/status";
import { locationContaining } from "../domain/track";
import { fleetTrucks, inServiceHours, legalLocations, m12Rules, type LegalLocation } from "./common";
import { livePhoneTracking } from "./devices";

export type LiveTrip = {
  id: string;
  number: string;
  orderId: string;
  status: string;
  statusLabel: string;
  routeOrder: number | null;
  customerName: string;
  isInternal: boolean;
  destinationName: string | null;
  lat: number | null;
  lng: number | null;
  departedAt: string | null;
  completedAt: string | null;
};

export type LiveTruck = {
  truckId: string;
  code: string;
  plateNumber: string;
  status: FleetLiveStatus;
  statusLabel: string;
  statusDetail: string;
  tone: "primary" | "success" | "warning" | "danger" | "muted";
  driverName: string | null;
  driverPhone: string | null;
  position: { lat: number; lng: number; at: string; source: string; speedKmh: number | null; heading: number | null } | null;
  ageMinutes: number | null;
  stale: boolean;
  moving: boolean;
  gpsState: string | null;
  phoneTracking: boolean;
  trips: LiveTrip[];
  activeTrip: LiveTrip | null;
  nextTrip: LiveTrip | null;
  eta: { destination: string; km: number; minutes: number; method: string; estimated: boolean } | null;
  openEvents: number;
};

export type FleetLayers = {
  sources: (LegalLocation & { kind: "water_source" })[];
  depots: (LegalLocation & { kind: "outlet" })[];
  pools: (LegalLocation & { kind: "pool" })[];
  /** Perkiraan lingkar zona tarif (jarak rute ÷ 1,3) di sekitar tiap sumber air acuan — opsional (KP-3). */
  zoneRings: { id: string; center: LatLng; radiusM: number; label: string }[];
};

export type FleetSnapshot = {
  date: BusinessDate;
  generatedAt: string;
  refreshSeconds: number;
  staleAfterMinutes: number;
  inServiceHours: boolean;
  trucks: LiveTruck[];
  layers: FleetLayers;
  counts: { total: number; activeTrip: number; moving: number; stale: number; noData: number; offSchedule: number };
};

/** Snapshot armada untuk peta (US-M12-02 KP-1..KP-4). */
export async function getFleetSnapshot(ctx: ActorContext, input: { date?: string } = {}, opts: { tx?: Tx } = {}): Promise<FleetSnapshot> {
  await authorize(ctx, "m12.position.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const date = input.date && isBusinessDate(input.date) ? input.date : today;
  const rules = await m12Rules(tx, date, ctx.tenantId);
  const locations = await legalLocations(tx, ctx.tenantId, rules);
  const fleet = (await fleetTrucks(tx, ctx.tenantId)).filter((t) => t.status !== "inactive");
  const truckIds = fleet.map((t) => t.id);
  const now = ctx.now;

  const lastRows = truckIds.length
    ? await tx
        .selectDistinctOn([gpsPositions.truckId], {
          truckId: gpsPositions.truckId,
          lat: gpsPositions.lat,
          lng: gpsPositions.lng,
          at: gpsPositions.deviceTime,
          source: gpsPositions.source,
          speedKmh: gpsPositions.speedKmh,
          heading: gpsPositions.heading,
        })
        .from(gpsPositions)
        .where(and(inArray(gpsPositions.truckId, truckIds), eq(gpsPositions.isValid, true), sql`${gpsPositions.deviceTime} <= ${now}`))
        .orderBy(gpsPositions.truckId, desc(gpsPositions.deviceTime))
    : [];
  // Gerak: dua posisi perangkat terakhir (kecepatan dilaporkan atau perpindahan).
  const recent = truckIds.length
    ? await tx
        .select({ truckId: gpsPositions.truckId, lat: gpsPositions.lat, lng: gpsPositions.lng, at: gpsPositions.deviceTime, speedKmh: gpsPositions.speedKmh })
        .from(gpsPositions)
        .where(and(inArray(gpsPositions.truckId, truckIds), eq(gpsPositions.isValid, true), gte(gpsPositions.deviceTime, new Date(now.getTime() - rules.staleMinutes * 60_000)), sql`${gpsPositions.deviceTime} <= ${now}`))
        .orderBy(asc(gpsPositions.deviceTime))
    : [];

  const tripRows = truckIds.length
    ? await tx
        .select({ t: trips, customerName: customers.name, lat: customerAddresses.lat, lng: customerAddresses.lng, outletName: outlets.name, outletLat: outlets.lat, outletLng: outlets.lng })
        .from(trips)
        .innerJoin(customers, eq(customers.id, trips.customerId))
        .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
        .leftJoin(outlets, eq(outlets.id, trips.destinationOutletId))
        .where(and(inArray(trips.truckId, truckIds), eq(trips.scheduledDate, date), isNull(trips.withdrawnAt), sql`${trips.publishedAt} is not null`))
        .orderBy(asc(trips.routeOrder), asc(trips.number))
    : [];
  const crews = truckIds.length ? await resolveDayCrews(tx, ctx.tenantId, date, today, truckIds) : new Map();
  const driverIds = [...crews.values()].map((c) => c.driverEmployeeId).filter((x): x is string => !!x);
  const phones = driverIds.length ? await tx.select({ id: employees.id, phone: employees.phone }).from(employees).where(inArray(employees.id, driverIds)) : [];
  const phoneTracking = await livePhoneTracking(tx, truckIds);
  const recentEvents = truckIds.length
    ? await tx
        .select({ truckId: fleetEvents.truckId, kind: fleetEvents.kind, status: fleetEvents.status, endedAt: fleetEvents.endedAt, requiresExplanation: fleetEvents.requiresExplanation, explanation: fleetEvents.explanation })
        .from(fleetEvents)
        .where(and(inArray(fleetEvents.truckId, truckIds), eq(fleetEvents.businessDate, date)))
    : [];

  const out: LiveTruck[] = [];
  for (const truck of fleet) {
    const last = lastRows.find((r) => r.truckId === truck.id) ?? null;
    const own = tripRows.filter((r) => r.t.truckId === truck.id);
    const toLive = (r: (typeof tripRows)[number]): LiveTrip => ({
      id: r.t.id,
      number: r.t.number,
      orderId: r.t.orderId,
      status: r.t.status,
      statusLabel: label("trip_status", r.t.status),
      routeOrder: r.t.routeOrder,
      customerName: r.customerName,
      isInternal: r.t.isInternal,
      destinationName: r.outletName,
      lat: r.t.isInternal && r.outletLat != null ? r.outletLat : r.lat,
      lng: r.t.isInternal && r.outletLng != null ? r.outletLng : r.lng,
      departedAt: r.t.departedAt?.toISOString() ?? null,
      completedAt: (r.t.completedAt ?? r.t.failedAt)?.toISOString() ?? null,
    });
    const liveTrips = own.map(toLive);
    const activeTrip = liveTrips.find((t) => t.status === "departed" || t.status === "arrived") ?? null;
    const nextTrip = liveTrips.find((t) => t.status === "assigned") ?? null;
    const ageMinutes = last ? Math.max(0, Math.round((now.getTime() - last.at.getTime()) / 60_000)) : null;
    const pts = recent.filter((r) => r.truckId === truck.id);
    const lastTwo = pts.slice(-2);
    const displacement = lastTwo.length === 2 ? Math.hypot((lastTwo[1]!.lat - lastTwo[0]!.lat) * 111_320, (lastTwo[1]!.lng - lastTwo[0]!.lng) * 111_320 * Math.cos((lastTwo[1]!.lat * Math.PI) / 180)) : 0;
    const dtS = lastTwo.length === 2 ? Math.max(1, (lastTwo[1]!.at.getTime() - lastTwo[0]!.at.getTime()) / 1000) : 1;
    const moving = !!last && ageMinutes !== null && ageMinutes <= rules.staleMinutes && ((last.speedKmh ?? 0) >= rules.fleet.moving_speed_kmh || (displacement / dtS) * 3.6 >= rules.fleet.moving_speed_kmh);
    const openOffSchedule = recentEvents.some(
      (e) => e.truckId === truck.id && (e.kind === "off_schedule_trip" || e.kind === "off_hours_trip") && e.status === "detected" && e.endedAt && now.getTime() - e.endedAt.getTime() <= 30 * 60_000,
    );
    const offHoursMoving = moving && !activeTrip && !inServiceHours(rules, now);
    const loc = last ? locationContaining(last, locations) : null;
    const status = deriveLiveStatus({
      maintenance: truck.status === "maintenance",
      hasPosition: !!last,
      activeTrip: activeTrip ? { status: activeTrip.status as "departed" | "arrived", customerName: activeTrip.customerName, isInternal: activeTrip.isInternal, destinationName: activeTrip.destinationName } : null,
      offSchedule: openOffSchedule || offHoursMoving,
      location: loc ? { type: loc.type, name: loc.name } : null,
      moving,
      remainingTrips: liveTrips.filter((t) => t.status === "assigned").length,
    });
    const crew = crews.get(truck.id);
    const dest = activeTrip ?? nextTrip;
    let eta: LiveTruck["eta"] = null;
    if (last && dest?.lat != null && dest.lng != null) {
      const d = await routeDistance({ lat: last.lat, lng: last.lng }, { lat: dest.lat, lng: dest.lng });
      eta = {
        destination: dest.isInternal ? `Pasokan ${dest.destinationName ?? "depot"}` : dest.customerName,
        km: Math.round(d.km * 10) / 10,
        minutes: Math.max(1, Math.round((d.km / rules.fleet.eta_avg_speed_kmh) * 60)),
        method: d.method,
        estimated: d.estimated || d.method === "straight_line_x1_3",
      };
    }
    out.push({
      truckId: truck.id,
      code: truck.code,
      plateNumber: truck.plateNumber,
      status: status.status,
      statusLabel: label("fleet_live_status", status.status),
      statusDetail: status.detail,
      tone: LIVE_STATUS_TONE[status.status],
      driverName: crew?.driverName ?? null,
      driverPhone: phones.find((p) => p.id === crew?.driverEmployeeId)?.phone ?? null,
      position: last ? { lat: last.lat, lng: last.lng, at: last.at.toISOString(), source: last.source, speedKmh: last.speedKmh, heading: last.heading } : null,
      ageMinutes,
      stale: ageMinutes !== null && ageMinutes > rules.staleMinutes,
      moving,
      gpsState: truck.gpsDevice?.gpsState ?? null,
      phoneTracking: phoneTracking.has(truck.id),
      trips: liveTrips,
      activeTrip,
      nextTrip,
      eta,
      openEvents: recentEvents.filter((e) => e.truckId === truck.id && e.requiresExplanation && !e.explanation).length,
    });
  }

  const zones = await tx
    .select({ id: tariffZones.id, code: tariffZones.code, name: tariffZones.name, maxDistanceM: tariffZones.maxDistanceM })
    .from(tariffZones)
    .where(and(eq(tariffZones.tenantId, ctx.tenantId), eq(tariffZones.isActive, true)))
    .orderBy(asc(tariffZones.minDistanceM));
  const sources = locations.filter((l): l is LegalLocation & { type: "water_source" } => l.type === "water_source");
  const zoneRings: FleetLayers["zoneRings"] = [];
  for (const s of sources) {
    for (const z of zones) {
      if (z.maxDistanceM === null) continue;
      zoneRings.push({ id: `${s.id}:${z.id}`, center: { lat: s.lat, lng: s.lng }, radiusM: Math.round(z.maxDistanceM / STRAIGHT_LINE_ROUTE_FACTOR), label: `${z.code} ${z.name} (batas ± dari ${s.name})` });
    }
  }
  return {
    date,
    generatedAt: now.toISOString(),
    refreshSeconds: Math.min(60, rules.updateIntervalMinutes * 60),
    staleAfterMinutes: rules.staleMinutes,
    inServiceHours: inServiceHours(rules, now),
    trucks: out,
    layers: {
      sources: sources.map((s) => ({ ...s, kind: "water_source" as const })),
      depots: locations.filter((l) => l.type === "outlet").map((l) => ({ ...l, kind: "outlet" as const })),
      pools: locations.filter((l) => l.type === "pool").map((l) => ({ ...l, kind: "pool" as const })),
      zoneRings,
    },
    counts: {
      total: out.length,
      activeTrip: out.filter((t) => t.status === "active_trip" || t.status === "arrived").length,
      moving: out.filter((t) => t.moving).length,
      stale: out.filter((t) => t.stale).length,
      noData: out.filter((t) => t.status === "no_data").length,
      offSchedule: out.filter((t) => t.status === "off_schedule").length,
    },
  };
}
