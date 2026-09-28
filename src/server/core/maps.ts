/**
 * Peta & jarak (US-M1-05 KP-2, NFR-24, D-01): antarmuka `RoutingProvider { distanceKm(a, b) }` dengan implementasi bawaan
 * `straight_line_x1_3` (garis lurus × 1,3 — cadangan PRD) dan OSRM (opsional, `MAP_ROUTING_URL`; jatuh ke garis lurus
 * bila gagal, ditandai `estimated`). `zoneForDistance` memetakan jarak ke zona tarif [min, max).
 */
import "server-only";

import { serverEnv } from "@/lib/env";
import { isValidLatLng, straightLineKmX13, STRAIGHT_LINE_ROUTE_FACTOR, type LatLng } from "@/lib/geo";

import { ValidationError } from "./errors";

export type DistanceMethod = "route" | "straight_line_x1_3";

export type DistanceResult = {
  km: number;
  meters: number;
  method: DistanceMethod;
  /** Benar bila hasil cadangan (garis lurus) karena layanan rute tidak tersedia — tandai untuk hitung ulang. */
  estimated: boolean;
};

export interface RoutingProvider {
  readonly name: "straight_line_x1_3" | "osrm" | "google";
  distanceKm(a: LatLng, b: LatLng): Promise<DistanceResult>;
}

function assertPoints(a: LatLng, b: LatLng): void {
  if (!isValidLatLng(a) || !isValidLatLng(b)) throw ValidationError.field("coordinates", "Koordinat tidak valid.");
}

function straightLine(a: LatLng, b: LatLng, estimated: boolean): DistanceResult {
  const km = straightLineKmX13(a, b, STRAIGHT_LINE_ROUTE_FACTOR);
  return { km, meters: Math.round(km * 1000), method: "straight_line_x1_3", estimated };
}

/** Garis lurus × 1,3 (bawaan; tanpa layanan eksternal). */
export const straightLineProvider: RoutingProvider = {
  name: "straight_line_x1_3",
  async distanceKm(a, b) {
    assertPoints(a, b);
    return straightLine(a, b, false);
  },
};

/** OSRM `/route/v1/driving` — cadangan otomatis ke garis lurus bila gagal. */
export function osrmProvider(baseUrl: string, fetchImpl: typeof fetch = fetch): RoutingProvider {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    name: "osrm",
    async distanceKm(a, b) {
      assertPoints(a, b);
      try {
        const res = await fetchImpl(`${base}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`, {
          signal: AbortSignal.timeout(5000),
        });
        const body = (await res.json()) as { code?: string; routes?: { distance: number }[] };
        const meters = body.routes?.[0]?.distance;
        if (!res.ok || body.code !== "Ok" || typeof meters !== "number") return straightLine(a, b, true);
        return { km: meters / 1000, meters: Math.round(meters), method: "route", estimated: false };
      } catch {
        return straightLine(a, b, true);
      }
    },
  };
}

/** Penyedia aktif dari env `MAP_ROUTING_PROVIDER` (google belum diimplementasikan → garis lurus). */
export function getRoutingProvider(): RoutingProvider {
  const env = serverEnv();
  if (env.MAP_ROUTING_PROVIDER === "osrm" && env.MAP_ROUTING_URL) return osrmProvider(env.MAP_ROUTING_URL);
  return straightLineProvider;
}

/** Jarak (km) dengan penyedia aktif. */
export async function routeDistance(a: LatLng, b: LatLng, provider: RoutingProvider = getRoutingProvider()): Promise<DistanceResult> {
  return provider.distanceKm(a, b);
}

export type ZoneBand = { id: string; code?: string; minDistanceM: number; maxDistanceM: number | null };

/** Zona untuk jarak (km): `min ≤ jarak < max` (max kosong = tanpa batas atas). */
export function zoneForDistance<Z extends ZoneBand>(zones: readonly Z[], km: number): Z | null {
  const m = km * 1000;
  const sorted = [...zones].sort((x, y) => x.minDistanceM - y.minDistanceM);
  return sorted.find((z) => m >= z.minDistanceM && (z.maxDistanceM === null || m < z.maxDistanceM)) ?? null;
}

/** Validasi tabel zona: tidak tumpang tindih, tanpa celah, mulai dari 0 (US-M1-05 KP-1). Mengembalikan pesan galat. */
export function validateZoneTable(zones: readonly ZoneBand[]): string[] {
  const errors: string[] = [];
  const sorted = [...zones].sort((x, y) => x.minDistanceM - y.minDistanceM);
  if (sorted.length === 0) return ["Tabel zona kosong."];
  if (sorted[0]!.minDistanceM !== 0) errors.push("Zona pertama harus mulai dari 0 km.");
  for (let i = 0; i < sorted.length; i++) {
    const z = sorted[i]!;
    if (z.maxDistanceM !== null && z.maxDistanceM <= z.minDistanceM) {
      errors.push(`Zona ${z.code ?? z.id}: batas atas harus lebih besar dari batas bawah.`);
    }
    const next = sorted[i + 1];
    if (next) {
      if (z.maxDistanceM === null) errors.push(`Zona ${z.code ?? z.id} tanpa batas atas harus menjadi zona terakhir.`);
      else if (next.minDistanceM > z.maxDistanceM) errors.push(`Ada celah antara zona ${z.code ?? z.id} dan ${next.code ?? next.id}.`);
      else if (next.minDistanceM < z.maxDistanceM) errors.push(`Zona ${z.code ?? z.id} dan ${next.code ?? next.id} tumpang tindih.`);
    }
  }
  return errors;
}
