/**
 * Pembantu uji modul M12 (bukan berkas uji): truk uji BARU dengan perangkat GPS terpasang (master armada), pembangun
 * posisi (diam/berjalan) di sekitar lokasi seed Cianjur, dan pengirim posisi lewat penerima penghubung vendor yang sama
 * dengan rute `/api/gps/ingest/[vendor]` (`ingestGpsFixes`).
 */
import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { devices, trucks } from "@/db/schema";
import { EQUA_TENANT_ID, OUTLET_SEEDS, WATER_SOURCE_SEEDS } from "@/db/seed";
import { POOL_SEED } from "@/db/seed/org";
import { newId } from "@/lib/ids";
import type { LatLng } from "@/lib/geo";
import type { EnumValue } from "@/lib/labels";
import { wibToUtc } from "@/lib/time";
import type { GpsFix } from "@/server/modules/m12-fleet";
import { ingestGpsFixes } from "@/server/modules/m12-fleet";
import { offsetMeters, simulateRoute } from "@/server/modules/m12-fleet/domain/simulator";

import { createTruck } from "../helpers/fixtures";

export { offsetMeters };

/** Lokasi sah seed (PTB-34). */
export const SA1: LatLng = { lat: WATER_SOURCE_SEEDS[0]!.lat, lng: WATER_SOURCE_SEEDS[0]!.lng };
export const SA2: LatLng = { lat: WATER_SOURCE_SEEDS[1]!.lat, lng: WATER_SOURCE_SEEDS[1]!.lng };
export const POOL: LatLng = { lat: POOL_SEED.lat, lng: POOL_SEED.lng };
export const D01: LatLng = { lat: OUTLET_SEEDS[0]!.lat, lng: OUTLET_SEEDS[0]!.lng };
/** Titik "warung" di luar semua lokasi sah (± 2,5 km selatan pool). */
export const NOWHERE: LatLng = offsetMeters(POOL, -2_500, -1_200);
/** Titik lain di luar lokasi sah (± 3 km utara pool). */
export const ELSEWHERE: LatLng = offsetMeters(POOL, 3_000, 1_500);

let seq = 0;

export type GpsTruck = { truckId: string; code: string; deviceId: string; deviceCode: string; imei: string };

/** Truk uji baru + perangkat GPS aktif terpasang lewat master armada (`trucks.gps_device_id`). */
export async function gpsTruck(
  db: Db,
  opts: { status?: EnumValue<"truck_status">; detection?: boolean; withDevice?: boolean; vendor?: string } = {},
): Promise<GpsTruck> {
  seq++;
  const suffix = `${seq}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const truck = await createTruck(db, { code: `G${suffix}`.slice(0, 10) });
  const deviceId = newId();
  const deviceCode = `GPS-U${suffix}`;
  const imei = `35${String(Date.now()).slice(-9)}${String(seq).padStart(4, "0")}`;
  if (opts.withDevice !== false) {
    await db.insert(devices).values({ id: deviceId, tenantId: EQUA_TENANT_ID, deviceCode, name: `GPS uji ${suffix}`, kind: "gps", status: "active", truckId: truck.id, imei, vendor: opts.vendor ?? "Vendor uji" });
    await db.update(trucks).set({ gpsDeviceId: deviceId }).where(eq(trucks.id, truck.id));
  }
  if (opts.status) await db.update(trucks).set({ status: opts.status }).where(eq(trucks.id, truck.id));
  if (opts.detection === false) await db.update(trucks).set({ fleetDetectionEnabled: false }).where(eq(trucks.id, truck.id));
  return { truckId: truck.id, code: truck.code, deviceId, deviceCode, imei };
}

/** Pasang perangkat GPS baru di truk yang sudah ada (mis. truk dunia M3) lewat master armada. */
export async function attachGps(db: Db, truckId: string, opts: { vendor?: string } = {}): Promise<{ deviceId: string; deviceCode: string }> {
  const deviceId = newId();
  const deviceCode = `GPS-A-${deviceId.slice(-6)}`;
  await db.insert(devices).values({ id: deviceId, tenantId: EQUA_TENANT_ID, deviceCode, name: "GPS truk uji", kind: "gps", status: "active", truckId, vendor: opts.vendor ?? "Vendor uji" });
  await db.update(trucks).set({ gpsDeviceId: deviceId }).where(eq(trucks.id, truckId));
  return { deviceId, deviceCode };
}

/** Satu posisi format internal. */
export function fix(deviceRef: string, at: Date, p: LatLng, extra: Partial<GpsFix> = {}): GpsFix {
  return {
    deviceRef,
    deviceTime: at,
    lat: p.lat,
    lng: p.lng,
    speedKmh: extra.speedKmh ?? null,
    heading: extra.heading ?? null,
    accuracyM: extra.accuracyM ?? 8,
    ignitionOn: extra.ignitionOn ?? null,
    powerConnected: extra.powerConnected ?? true,
    batteryPct: extra.batteryPct ?? null,
    firmwareVersion: extra.firmwareVersion ?? null,
    vendorValid: extra.vendorValid ?? true,
    raw: extra.raw ?? { uji: true },
  };
}

/** Diam di satu titik selama `minutes` (posisi tiap `intervalS`). */
export function dwell(deviceRef: string, p: LatLng, start: Date, minutes: number, intervalS = 60): GpsFix[] {
  const out: GpsFix[] = [];
  for (let s = 0; s <= minutes * 60; s += intervalS) out.push(fix(deviceRef, new Date(start.getTime() + s * 1000), p, { speedKmh: 0 }));
  return out;
}

/** Berjalan lurus a → b dengan kecepatan tetap (posisi tiap `intervalS`, tanpa getar). */
export function drive(deviceRef: string, a: LatLng, b: LatLng, start: Date, opts: { speedKmh?: number; intervalS?: number } = {}): GpsFix[] {
  return simulateRoute({ start, waypoints: [a, b], speedKmh: opts.speedKmh ?? 30, intervalS: opts.intervalS ?? 60, jitterM: 0, seed: 7 }).map((f) =>
    fix(deviceRef, f.t, f, { speedKmh: f.speedKmh }),
  );
}

/** Rangkai beberapa potongan jejak; waktu berikutnya = waktu posisi terakhir + interval. */
export function chain(parts: ((start: Date) => GpsFix[])[], start: Date, intervalS = 60): GpsFix[] {
  const out: GpsFix[] = [];
  let t = start;
  for (const part of parts) {
    const fixes = part(t);
    out.push(...fixes);
    const last = fixes[fixes.length - 1];
    if (last) t = new Date(last.deviceTime.getTime() + intervalS * 1000);
  }
  return out;
}

/** Kirim posisi lewat penerima penghubung (waktu terima = posisi terbaru, agar jam tidak dianggap menyimpang). */
export async function feed(db: Db, fixes: GpsFix[], opts: { receivedAt?: Date; vendor?: string } = {}) {
  const newest = fixes.reduce((m, f) => Math.max(m, f.deviceTime.getTime()), 0);
  return ingestGpsFixes(fixes, { vendor: opts.vendor ?? "generic-json", receivedAt: opts.receivedAt ?? new Date(newest), db });
}

/** Waktu WIB pada tanggal tertentu. */
export function wib(date: string, time: string): Date {
  return wibToUtc(date, time);
}

export function minutesAfter(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}
