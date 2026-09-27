import { describe, expect, it } from "vitest";

import { haversineMeters, isValidLatLng, straightLineKmX13, withinRadius } from "@/lib/geo";

// Titik uji di Cianjur (perkiraan).
const ALUN_ALUN_CIANJUR = { lat: -6.8222, lng: 107.1394 };
const CIPANAS = { lat: -6.7336, lng: 107.0417 };

describe("lib/geo — jarak & geofence", () => {
  it("haversineMeters: jarak nol dan jarak yang diketahui", () => {
    expect(haversineMeters(ALUN_ALUN_CIANJUR, ALUN_ALUN_CIANJUR)).toBe(0);
    // 1 derajat lintang ≈ 111,195 km
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -1);
    const d = haversineMeters(ALUN_ALUN_CIANJUR, CIPANAS);
    expect(d).toBeGreaterThan(14_000);
    expect(d).toBeLessThan(15_000);
    expect(haversineMeters(CIPANAS, ALUN_ALUN_CIANJUR)).toBeCloseTo(d, 6);
  });

  it("US-M1-05 KP-2 straightLineKmX13 = garis lurus × 1,3 (km)", () => {
    const km = straightLineKmX13(ALUN_ALUN_CIANJUR, CIPANAS);
    expect(km).toBeCloseTo((haversineMeters(ALUN_ALUN_CIANJUR, CIPANAS) / 1000) * 1.3, 9);
    expect(straightLineKmX13({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, 1)).toBeCloseTo(111.195, 2);
  });

  it("withinRadius inklusif dan memvalidasi masukan", () => {
    const center = { lat: -6.8222, lng: 107.1394 };
    const near = { lat: -6.8226, lng: 107.1394 }; // ±44 m
    expect(withinRadius(near, center, 50)).toBe(true);
    expect(withinRadius(near, center, 30)).toBe(false);
    expect(() => withinRadius(near, center, -1)).toThrow(RangeError);
    expect(() => haversineMeters({ lat: 91, lng: 0 }, center)).toThrow(RangeError);
    expect(isValidLatLng({ lat: -6.8, lng: 107.1 })).toBe(true);
    expect(isValidLatLng({ lat: Number.NaN, lng: 0 })).toBe(false);
    expect(isValidLatLng(null)).toBe(false);
  });
});
