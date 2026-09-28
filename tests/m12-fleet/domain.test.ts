import { describe, expect, it } from "vitest";

import { haversineMeters } from "@/lib/geo";
import { genericJsonAdapter, getGpsVendorAdapter, listGpsVendorAdapters, MAX_FIXES_PER_REQUEST, osmandAdapter, parseFixTime } from "@/server/modules/m12-fleet/domain/adapters";
import { simulateTruckDay } from "@/server/modules/m12-fleet/domain/simulator";
import { deriveLiveStatus } from "@/server/modules/m12-fleet/domain/status";
import {
  cleanTrack,
  detectStops,
  locationContaining,
  movementSegments,
  nearestInTime,
  pathDistanceM,
  runsOutside,
  simplifyPath,
  summarizeActivity,
  timeWithinRadiusS,
  trackGaps,
  type TrackPoint,
} from "@/server/modules/m12-fleet/domain/track";

import { NOWHERE, offsetMeters, POOL, SA1 } from "./helpers";

const T0 = Date.UTC(2026, 8, 28, 1, 0, 0); // 08.00 WIB

function pts(list: [number, { lat: number; lng: number }][]): TrackPoint[] {
  return list.map(([min, p]) => ({ t: T0 + min * 60_000, lat: p.lat, lng: p.lng }));
}

describe("M12 penghubung vendor (NFR-21)", () => {
  it("US-M12-01 KP-1 JSON generik: waktu perangkat, lintang/bujur, kecepatan, arah, kontak/daya, akurasi & data mentah dipetakan ke format internal", () => {
    const res = genericJsonAdapter.parse({
      method: "POST",
      contentType: "application/json",
      query: new URLSearchParams(),
      body: {
        positions: [
          { deviceId: "GPS-T1", time: "2026-09-28T01:00:00Z", lat: -6.8, lng: 107.1, speed: 42.5, heading: 370, accuracy: 6, ignition: true, power: "false", battery: 88, firmware: "v2.1", valid: true },
          { imei: "861000000000001", timestamp: 1790557260, latitude: -6.81, longitude: 107.11 },
          { deviceId: "", time: "x", lat: 999, lng: 0 },
        ],
      },
    });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.message).toMatch(/Pengenal perangkat/);
    expect(res.fixes).toHaveLength(2);
    const a = res.fixes[0]!;
    expect(a).toMatchObject({ deviceRef: "GPS-T1", lat: -6.8, lng: 107.1, speedKmh: 42.5, heading: 10, accuracyM: 6, ignitionOn: true, powerConnected: false, batteryPct: 88, firmwareVersion: "v2.1", vendorValid: true });
    expect(a.deviceTime.toISOString()).toBe("2026-09-28T01:00:00.000Z");
    expect(a.raw).toMatchObject({ deviceId: "GPS-T1", speed: 42.5 });
    expect(res.fixes[1]!.deviceTime.getTime()).toBe(1790557260 * 1000);
  });

  it("US-M12-01 KP-3 ganti vendor hanya mengganti adaptor: OsmAnd/Traccar (knot, JSON Traccar Client) menghasilkan format internal yang sama", () => {
    const generic = genericJsonAdapter.parse({ method: "POST", contentType: "application/json", query: new URLSearchParams(), body: { deviceId: "GPS-T1", time: "2026-09-28T01:00:00Z", lat: -6.8, lng: 107.1, speedKmh: 37, heading: 90, accuracy: 5, power: true } }).fixes[0]!;
    const q = new URLSearchParams({ id: "GPS-T1", timestamp: "1790557200", lat: "-6.8", lon: "107.1", speed: String(37 / 1.852), bearing: "90", accuracy: "5", charge: "true", token: "rahasia" });
    const osmand = osmandAdapter.parse({ method: "GET", contentType: "", query: q, body: null }).fixes[0]!;
    const traccar = osmandAdapter.parse({
      method: "POST",
      contentType: "application/json",
      query: new URLSearchParams(),
      body: { device_id: "GPS-T1", location: { timestamp: "2026-09-28T01:00:00Z", coords: { latitude: -6.8, longitude: 107.1, speed: 37 / 3.6, heading: 90, accuracy: 5 }, battery: { level: 0.5, is_charging: true } } },
    }).fixes[0]!;
    const core = (f: typeof generic) => ({ deviceRef: f.deviceRef, t: f.deviceTime.toISOString(), lat: f.lat, lng: f.lng, speedKmh: f.speedKmh, heading: f.heading, accuracyM: f.accuracyM, power: f.powerConnected });
    expect(core(osmand)).toEqual(core(generic));
    expect(core(traccar)).toEqual(core(generic));
    expect(traccar.batteryPct).toBe(50);
    expect(osmand.raw.token).toBeUndefined();
    expect(getGpsVendorAdapter("osmand")).toBe(osmandAdapter);
    expect(getGpsVendorAdapter("tidak-ada")).toBeNull();
    expect(listGpsVendorAdapters().map((a) => a.key)).toEqual(["generic-json", "osmand"]);
  });

  it("US-M12-01 KP-1 batas teknis per permintaan & waktu dari epoch detik/milidetik/ISO/'YYYY-MM-DD HH:mm:ss'", () => {
    expect(parseFixTime(1790557200)?.toISOString()).toBe("2026-09-28T01:00:00.000Z");
    expect(parseFixTime(1790557200000)?.toISOString()).toBe("2026-09-28T01:00:00.000Z");
    expect(parseFixTime("2026-09-28 01:00:00")?.toISOString()).toBe("2026-09-28T01:00:00.000Z");
    expect(parseFixTime("bukan waktu")).toBeNull();
    const many = Array.from({ length: MAX_FIXES_PER_REQUEST + 3 }, (_, i) => ({ deviceId: "X", time: T0 + i * 1000, lat: -6.8, lng: 107.1 }));
    const res = genericJsonAdapter.parse({ method: "POST", contentType: "application/json", query: new URLSearchParams(), body: many });
    expect(res.fixes).toHaveLength(MAX_FIXES_PER_REQUEST);
    expect(res.errors.at(-1)!.message).toMatch(/Maksimal/);
  });
});

describe("M12 analisis jejak (murni)", () => {
  it("US-M12-03 KP-1 titik berhenti ≥ PAR-49 (5 menit) dengan lokasi & lama; berhenti singkat (lampu merah) bukan titik berhenti", () => {
    const a = SA1;
    const b = offsetMeters(SA1, 3000, 0);
    const track = pts([
      [0, a],
      [1, a],
      [2, offsetMeters(a, 10, 0)],
      [7, a], // 7 menit diam di sumber
      [9, offsetMeters(a, 1000, 0)],
      [10, offsetMeters(a, 1020, 0)], // 1 menit berhenti (tidak dihitung)
      [12, offsetMeters(a, 2000, 0)],
      [14, b],
      [20, b],
      [26, offsetMeters(b, 15, 5)], // 12 menit diam di b
    ]);
    const stops = detectStops(track, { radiusM: 60, minDurationS: 300 });
    expect(stops).toHaveLength(2);
    expect(stops[0]).toMatchObject({ durationS: 420 });
    expect(haversineMeters(stops[0]!, a)).toBeLessThan(20);
    expect(stops[1]!.durationS).toBe(720);
    const segs = movementSegments(track, stops, { minMoveM: 200 });
    expect(segs).toHaveLength(1);
    expect(segs[0]!.endedByStop).toBe(true);
    expect(Math.round(segs[0]!.distanceM / 100)).toBe(30);
    expect(Math.round(pathDistanceM(track) / 100)).toBe(30);
  });

  it("7.12.6 lonjakan posisi (getar/lompatan GPS) dibuang dari jarak; celah jejak ditandai", () => {
    const track = pts([
      [0, SA1],
      [1, offsetMeters(SA1, 300, 0)],
      [2, offsetMeters(SA1, 30_000, 0)], // lompatan mustahil
      [3, offsetMeters(SA1, 900, 0)],
      [15, offsetMeters(SA1, 1500, 0)], // celah 12 menit
    ]);
    const clean = cleanTrack(track, 130);
    expect(clean).toHaveLength(4);
    expect(Math.round(pathDistanceM(clean))).toBeLessThan(1600);
    expect(trackGaps(clean, 5 * 60_000)).toHaveLength(1);
  });

  it("US-M12-05 KP-1 potongan gerak di luar interval rit: dipotong saat rit Berangkat (selesai karena rit), di dalam rit tidak dinilai", () => {
    const track = pts([
      [0, POOL],
      [6, POOL],
      [8, offsetMeters(POOL, 800, 0)],
      [10, offsetMeters(POOL, 1600, 0)],
      [12, offsetMeters(POOL, 2400, 0)], // rit Berangkat pada menit 11
      [14, offsetMeters(POOL, 3200, 0)],
    ]);
    const stops = detectStops(track, { radiusM: 60, minDurationS: 300 });
    const segs = movementSegments(track, stops, { minMoveM: 200 });
    const runs = runsOutside(track, segs[0]!, [{ start: T0 + 11 * 60_000, end: T0 + 60 * 60_000 }], { minMoveM: 200 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ended: true, endedByInterval: true });
    expect(Math.round(runs[0]!.distanceM)).toBeGreaterThan(1500);
  });

  it("US-M12-03 KP-1 lama di lokasi pelanggan, posisi terdekat waktu tertentu, penyederhanaan jalur, ringkasan aktivitas hari", () => {
    const customer = NOWHERE;
    const track = pts([
      [0, offsetMeters(customer, -900, 0)],
      [2, offsetMeters(customer, -50, 0)],
      [5, customer],
      [20, offsetMeters(customer, 20, 0)],
      [22, offsetMeters(customer, 700, 0)],
    ]);
    expect(timeWithinRadiusS(track, customer, 200)).toBe(18 * 60);
    expect(nearestInTime(track, T0 + 6 * 60_000, 5 * 60_000)?.t).toBe(T0 + 5 * 60_000);
    expect(nearestInTime(track, T0 + 60 * 60_000, 5 * 60_000)).toBeNull();
    expect(simplifyPath(track, 15).length).toBeLessThanOrEqual(track.length);
    const act = summarizeActivity(track, { stopRadiusM: 60, minStopS: 300, minMoveM: 200 });
    // Titik menit ke-2 (50 m dari alamat) sudah dalam radius diam → berhenti 2..20 = 18 menit.
    expect(act.stoppedS).toBe(18 * 60);
    expect(act.firstMoveAt).toBe(T0);
    expect(locationContaining(customer, [{ ...customer, radiusM: 100, id: "x" }])?.id).toBe("x");
  });

  it("US-M12-02 KP-1 status truk di peta: rit aktif ke pelanggan / menuju sumber / di sumber / di depot / berhenti / di luar jadwal", () => {
    const base = { maintenance: false, hasPosition: true, activeTrip: null, offSchedule: false, location: null, moving: false, remainingTrips: 0 };
    expect(deriveLiveStatus({ ...base, activeTrip: { status: "departed", customerName: "PT Maju", isInternal: false, destinationName: null } })).toEqual({ status: "active_trip", detail: "Rit aktif ke PT Maju" });
    expect(deriveLiveStatus({ ...base, activeTrip: { status: "arrived", customerName: "X", isInternal: true, destinationName: "Depot D05" } }).detail).toBe("Tiba di pasokan Depot D05");
    expect(deriveLiveStatus({ ...base, moving: true, remainingTrips: 2 }).status).toBe("heading_to_source");
    expect(deriveLiveStatus({ ...base, moving: true, remainingTrips: 0 }).status).toBe("returning_to_pool");
    expect(deriveLiveStatus({ ...base, location: { type: "water_source", name: "Sumber Air Cugenang" } })).toEqual({ status: "at_source", detail: "Di Sumber Air Cugenang" });
    expect(deriveLiveStatus({ ...base, location: { type: "outlet", name: "Depot EQUA Muka" } }).status).toBe("at_depot");
    expect(deriveLiveStatus({ ...base, location: { type: "pool", name: "Pool" } }).status).toBe("at_pool");
    expect(deriveLiveStatus(base).status).toBe("stopped");
    expect(deriveLiveStatus({ ...base, offSchedule: true, moving: true }).status).toBe("off_schedule");
    expect(deriveLiveStatus({ ...base, hasPosition: false }).status).toBe("no_data");
    expect(deriveLiveStatus({ ...base, maintenance: true }).status).toBe("maintenance");
  });

  it("US-M12-01 KP-1 simulator menggerakkan truk demo ≥ 1 posisi per menit saat bergerak (pool → sumber → pelanggan → pool)", () => {
    const fixes = simulateTruckDay({ pool: POOL, source: SA1, customers: [NOWHERE], start: new Date(T0), seed: 3 });
    expect(fixes.length).toBeGreaterThan(30);
    for (let i = 1; i < fixes.length; i++) expect(fixes[i]!.t.getTime() - fixes[i - 1]!.t.getTime()).toBe(60_000);
    expect(haversineMeters(fixes[0]!, POOL)).toBeLessThan(30);
    expect(haversineMeters(fixes.at(-1)!, POOL)).toBeLessThan(30);
    expect(fixes.some((f) => f.speedKmh > 0)).toBe(true);
  });
});
