/**
 * M12 — pembantu bersama layanan armada: aturan (parameter Lampiran B + `m12.fleet_rules`, bertanggal bisnis), lokasi
 * sah (sumber air, depot, pool — PTB-34) dengan radius geofence (master M1 / PAR-54), truk + perangkat GPS, posisi
 * truk dalam rentang waktu, pengguna aktif pada truk (US-M12-05 KP-3), dan jam layanan (PAR-07).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";

import { devices, gpsPositions, outlets, poolLocations, trips, trucks, waterSources } from "@/db/schema";
import type { EnumValue } from "@/lib/labels";
import { isWithinWindow, toBusinessDate, type BusinessDate } from "@/lib/time";

import type { Tx } from "@/server/core/db";
import * as params from "@/server/core/params";

import type { TrackPoint } from "../domain/track";

export type M12Rules = {
  fleet: params.ParamValue<"m12.fleet_rules">;
  /** PAR-07 jam layanan (HH:mm WIB). */
  serviceHours: { start: string; end: string };
  /** PAR-16: > m wajib alasan (tingkat 1) / > m tinjauan pemilik (tingkat 2). */
  deviation: { reasonGtM: number; ownerReviewGtM: number };
  /** PAR-25 menit tanpa posisi → perangkat mati. */
  deadMinutes: number;
  /** PAR-26 pembaruan posisi (menit). */
  updateIntervalMinutes: number;
  /** PAR-42 selisih jam perangkat vs server (menit). */
  clockSkewMinutes: number;
  /** PAR-48 posisi basi (menit). */
  staleMinutes: number;
  /** PAR-49 titik berhenti riwayat (menit). */
  stopMinMinutes: number;
  /** PAR-50 gerak tanpa rit aktif. */
  offSchedule: { distanceMGt: number; minutesGt: number };
  /** PAR-51 berhenti tidak dikenal (menit). */
  unknownStopMinutesGt: number;
  /** PAR-52 retensi posisi mentah (bulan). */
  retentionMonths: number;
  /** PAR-53 konsumsi & harga BBM (ditetapkan pemilik). */
  fuel: { consumptionLPerKm: number | null; pricePerL: number | null; configured: boolean };
  /** PAR-54 radius geofence bawaan per jenis lokasi (m). */
  geofence: { waterSourceM: number; outletM: number; poolM: number };
};

/** Aturan armada yang berlaku pada tanggal bisnis (semua angka dari parameter — tidak ada angka aturan di kode). */
export async function m12Rules(tx: Tx, date: BusinessDate, tenantId: string, opts: { cache?: params.ParamCache } = {}): Promise<M12Rules> {
  const scope = { tenantId };
  // v1.0.1 (D-14 butir 4): `opts.cache` (params.cached) → laporan rentang membaca tiap parameter sekali, bukan per hari.
  const cache = opts.cache;
  const get = <K extends params.ParamKey>(key: K) => (cache ? cache.get(key, date, scope) : params.get(tx, key, date, scope));
  const [fleet, p07, p16, p25, p26, p42, p48, p49, p50, p51, p52, p53, p54] = await Promise.all([
    get("m12.fleet_rules"),
    get("PAR-07"),
    get("PAR-16"),
    get("PAR-25"),
    get("PAR-26"),
    get("PAR-42"),
    get("PAR-48"),
    get("PAR-49"),
    get("PAR-50"),
    get("PAR-51"),
    get("PAR-52"),
    get("PAR-53"),
    get("PAR-54"),
  ]);
  return {
    fleet,
    serviceHours: { start: p07.start, end: p07.end },
    deviation: { reasonGtM: p16.reason_required_gt_m, ownerReviewGtM: p16.owner_review_gt_m },
    deadMinutes: p25.minutes,
    updateIntervalMinutes: p26.max_interval_minutes,
    clockSkewMinutes: p42.minutes_gt,
    staleMinutes: p48.minutes_gt,
    stopMinMinutes: p49.min_minutes,
    offSchedule: { distanceMGt: p50.distance_m_gt, minutesGt: p50.minutes_gt },
    unknownStopMinutesGt: p51.minutes_gt,
    retentionMonths: p52.months,
    fuel: { consumptionLPerKm: p53.consumption_l_per_km, pricePerL: p53.fuel_price_per_l, configured: p53.configured },
    geofence: { waterSourceM: p54.water_source_m, outletM: p54.outlet_m, poolM: p54.pool_m },
  };
}

/** Benar bila waktu `at` berada dalam jam layanan PAR-07 (WIB, kedua ujung inklusif). */
export function inServiceHours(rules: Pick<M12Rules, "serviceHours">, at: Date): boolean {
  return isWithinWindow(rules.serviceHours.start, rules.serviceHours.end, at);
}

export type LocationType = EnumValue<"geofence_location_type">;

export type LegalLocation = {
  type: LocationType;
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
};

/** Lokasi sah (PTB-34): sumber air aktif, depot aktif, pool aktif — radius dari master M1 atau PAR-54. */
export async function legalLocations(tx: Tx, tenantId: string, rules: Pick<M12Rules, "geofence">): Promise<LegalLocation[]> {
  const [sources, depots, pools] = await Promise.all([
    tx
      .select({ id: waterSources.id, code: waterSources.code, name: waterSources.name, lat: waterSources.lat, lng: waterSources.lng, radius: waterSources.geofenceRadiusM })
      .from(waterSources)
      .where(and(eq(waterSources.tenantId, tenantId), eq(waterSources.isActive, true))),
    tx
      .select({ id: outlets.id, code: outlets.code, name: outlets.name, lat: outlets.lat, lng: outlets.lng, radius: outlets.geofenceRadiusM })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.kind, "depot"), eq(outlets.isActive, true), isNotNull(outlets.lat), isNotNull(outlets.lng))),
    tx
      .select({ id: poolLocations.id, code: poolLocations.code, name: poolLocations.name, lat: poolLocations.lat, lng: poolLocations.lng, radius: poolLocations.geofenceRadiusM })
      .from(poolLocations)
      .where(and(eq(poolLocations.tenantId, tenantId), eq(poolLocations.isActive, true))),
  ]);
  return [
    ...sources.map((s) => ({ type: "water_source" as const, id: s.id, code: s.code, name: s.name, lat: s.lat, lng: s.lng, radiusM: s.radius ?? rules.geofence.waterSourceM })),
    ...depots.map((o) => ({ type: "outlet" as const, id: o.id, code: o.code, name: o.name, lat: o.lat!, lng: o.lng!, radiusM: o.radius ?? rules.geofence.outletM })),
    ...pools.map((p) => ({ type: "pool" as const, id: p.id, code: p.code, name: p.name, lat: p.lat, lng: p.lng, radiusM: p.radius ?? rules.geofence.poolM })),
  ];
}

export type TruckRow = typeof trucks.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;

export type FleetTruck = TruckRow & { gpsDevice: DeviceRow | null };

/** Truk tenant beserta perangkat GPS terpasangnya (master armada US-M1-03: `trucks.gps_device_id`). */
export async function fleetTrucks(tx: Tx, tenantId: string, opts: { includeInactive?: boolean; truckIds?: readonly string[] } = {}): Promise<FleetTruck[]> {
  const rows = await tx
    .select({ truck: trucks, device: devices })
    .from(trucks)
    .leftJoin(devices, eq(devices.id, trucks.gpsDeviceId))
    .where(
      and(
        eq(trucks.tenantId, tenantId),
        opts.includeInactive ? sql`true` : eq(trucks.isActive, true),
        opts.truckIds?.length ? inArray(trucks.id, [...opts.truckIds]) : sql`true`,
      ),
    )
    .orderBy(asc(trucks.code));
  return rows.map((r) => ({ ...r.truck, gpsDevice: r.device }));
}

/** Perangkat GPS terpasang & dapat dipakai (tidak diblokir/dihapus) yang pernah mengirim posisi. */
export function hasWorkingGps(t: FleetTruck): boolean {
  const d = t.gpsDevice;
  return !!d && !["blocked", "wipe_pending", "wiped"].includes(d.status) && d.gpsLastPositionAt !== null;
}

export type PositionRow = typeof gpsPositions.$inferSelect;
export type PositionSource = EnumValue<"position_source">;

/** Posisi truk dalam [from, to] (urut waktu). Bawaan: hanya posisi valid. */
export async function positionsBetween(
  tx: Tx,
  truckId: string,
  from: Date,
  to: Date,
  opts: { sources?: readonly PositionSource[]; includeInvalid?: boolean } = {},
): Promise<PositionRow[]> {
  return tx
    .select()
    .from(gpsPositions)
    .where(
      and(
        eq(gpsPositions.truckId, truckId),
        gte(gpsPositions.deviceTime, from),
        lte(gpsPositions.deviceTime, to),
        opts.includeInvalid ? sql`true` : eq(gpsPositions.isValid, true),
        opts.sources?.length ? inArray(gpsPositions.source, [...opts.sources]) : sql`true`,
      ),
    )
    .orderBy(asc(gpsPositions.deviceTime));
}

/** Baris posisi → titik jejak murni. */
export function toTrackPoints(rows: readonly Pick<PositionRow, "deviceTime" | "lat" | "lng" | "speedKmh">[]): TrackPoint[] {
  return rows.map((r) => ({ t: r.deviceTime.getTime(), lat: r.lat, lng: r.lng, speedKmh: r.speedKmh }));
}

export type TripRow = typeof trips.$inferSelect;

/** Rit truk yang bersinggungan dengan [from, to] (Berangkat sebelum `to`, belum selesai atau selesai setelah `from`). */
export async function tripsTouching(tx: Tx, truckId: string, from: Date, to: Date): Promise<TripRow[]> {
  return tx
    .select()
    .from(trips)
    .where(
      and(
        eq(trips.truckId, truckId),
        isNotNull(trips.departedAt),
        lte(trips.departedAt, to),
        or(
          and(eq(trips.status, "completed"), gte(trips.completedAt, from)),
          and(eq(trips.status, "failed"), gte(trips.failedAt, from)),
          inArray(trips.status, ["departed", "arrived"]),
        ),
      ),
    )
    .orderBy(asc(trips.departedAt));
}

/** Interval rit aktif: Berangkat → Selesai/Gagal (rit berjalan → sampai `openEnd`). */
export function tripInterval(t: Pick<TripRow, "departedAt" | "completedAt" | "failedAt" | "status">, openEnd: number): { start: number; end: number } | null {
  if (!t.departedAt) return null;
  const end = t.status === "completed" ? t.completedAt : t.status === "failed" ? t.failedAt : null;
  return { start: t.departedAt.getTime(), end: end ? end.getTime() : openEnd };
}

/**
 * Pengguna aktif pada truk saat `at` (US-M12-05 KP-3): sopir rit yang sedang/terakhir dikerjakan truk itu hari itu,
 * bila tidak ada → pengguna terakhir ponsel truk (`trucks.field_device_id`).
 */
export async function activeUserOnTruck(tx: Tx, truckId: string, at: Date): Promise<string | null> {
  const date = toBusinessDate(at);
  const [trip] = await tx
    .select({ driverUserId: trips.driverUserId })
    .from(trips)
    .where(and(eq(trips.truckId, truckId), isNotNull(trips.driverUserId), isNotNull(trips.departedAt), lte(trips.departedAt, at), or(eq(trips.scheduledDate, date), eq(trips.completionBusinessDate, date))))
    .orderBy(desc(trips.departedAt))
    .limit(1);
  if (trip?.driverUserId) return trip.driverUserId;
  const [dev] = await tx
    .select({ lastUserId: devices.lastUserId })
    .from(trucks)
    .innerJoin(devices, eq(devices.id, trucks.fieldDeviceId))
    .where(and(eq(trucks.id, truckId), ne(devices.status, "wiped")))
    .limit(1);
  return dev?.lastUserId ?? null;
}

/** Tenant yang memiliki truk (job lintas tenant). */
export async function tenantsWithTrucks(tx: Tx): Promise<string[]> {
  const rows = await tx.selectDistinct({ tenantId: trucks.tenantId }).from(trucks);
  return rows.map((r) => r.tenantId);
}

/** Meter → km dengan satu desimal (tampilan). */
export function km(m: number | null | undefined): number | null {
  return m === null || m === undefined ? null : Math.round(m / 100) / 10;
}
