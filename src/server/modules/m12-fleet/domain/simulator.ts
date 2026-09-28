/**
 * M12 — simulator jejak GPS (MURNI, deterministik): menggerakkan truk di antara titik-titik (pool → sumber → pelanggan →
 * sumber → … → pool) dengan kecepatan tetap, berhenti di tiap titik, dan getar GPS kecil. Dipakai seed demo
 * (`src/db/seed/demo-m12-fleet.ts`), skrip `scripts/gps-simulate.ts` (mengirim ke `/api/gps/ingest/<vendor>`), dan uji.
 */
import { haversineMeters, type LatLng } from "../../../../lib/geo";

export type SimWaypoint = LatLng & {
  /** Lama berhenti di titik ini (menit). */
  dwellMin?: number;
  label?: string;
};

export type SimFix = { t: Date; lat: number; lng: number; speedKmh: number; heading: number; label?: string };

export type SimulateOptions = {
  start: Date;
  waypoints: readonly SimWaypoint[];
  /** Kecepatan jalan (km/jam). Bawaan 30. */
  speedKmh?: number;
  /** Jarak waktu antar-posisi (detik). Bawaan 60 (PAR-26 ≤ 1 menit). */
  intervalS?: number;
  /** Getar GPS maksimal (meter). Bawaan 8. */
  jitterM?: number;
  seed?: number;
  /** Hentikan pada waktu ini (posisi setelahnya tidak dibuat). */
  endAt?: Date;
};

/** PRNG mulberry32 (deterministik per `seed`). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Arah (derajat 0..359) dari a ke b. */
export function bearing(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

/** Geser titik sejauh `m` meter (utara/timur) — untuk getar GPS & titik uji. */
export function offsetMeters(p: LatLng, northM: number, eastM: number): LatLng {
  return { lat: p.lat + northM / 111_320, lng: p.lng + eastM / (111_320 * Math.cos((p.lat * Math.PI) / 180)) };
}

/** Jejak posisi per `intervalS` detik mengikuti titik-titik jalan (garis lurus antar-titik). */
export function simulateRoute(opts: SimulateOptions): SimFix[] {
  const speedKmh = opts.speedKmh ?? 30;
  const intervalS = opts.intervalS ?? 60;
  const jitterM = opts.jitterM ?? 8;
  const rand = prng(opts.seed ?? 1);
  const end = opts.endAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const out: SimFix[] = [];
  let t = opts.start.getTime();
  const push = (p: LatLng, speed: number, heading: number, label?: string) => {
    if (t > end) return false;
    const j = offsetMeters(p, (rand() - 0.5) * 2 * jitterM, (rand() - 0.5) * 2 * jitterM);
    out.push({ t: new Date(t), lat: j.lat, lng: j.lng, speedKmh: speed, heading, label });
    t += intervalS * 1000;
    return true;
  };
  const wps = opts.waypoints;
  for (let w = 0; w < wps.length; w++) {
    const wp = wps[w]!;
    const dwellSteps = Math.max(1, Math.round(((wp.dwellMin ?? 0) * 60) / intervalS));
    for (let k = 0; k < dwellSteps; k++) if (!push(wp, 0, 0, wp.label)) return out;
    const next = wps[w + 1];
    if (!next) break;
    const dist = haversineMeters(wp, next);
    const legS = dist / (speedKmh / 3.6);
    const steps = Math.max(1, Math.ceil(legS / intervalS));
    const head = bearing(wp, next);
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      const p = { lat: wp.lat + (next.lat - wp.lat) * f, lng: wp.lng + (next.lng - wp.lng) * f };
      if (!push(p, Math.round(speedKmh * (0.85 + rand() * 0.3)), head)) return out;
    }
  }
  return out;
}

export type TruckDayPlan = {
  pool: LatLng;
  source: LatLng;
  customers: readonly LatLng[];
  start: Date;
  seed: number;
  speedKmh?: number;
};

/**
 * Rencana satu hari truk: pool → sumber (isi) → pelanggan 1 → sumber → pelanggan 2 → … → pool. Lama berhenti:
 * pool 5 menit, sumber 15 menit (pengisian), pelanggan 20 menit (bongkar), pool akhir 10 menit.
 */
export function truckDayWaypoints(plan: TruckDayPlan): SimWaypoint[] {
  const wps: SimWaypoint[] = [{ ...plan.pool, dwellMin: 5, label: "pool" }];
  for (let i = 0; i < plan.customers.length; i++) {
    wps.push({ ...plan.source, dwellMin: 15, label: "source" });
    wps.push({ ...plan.customers[i]!, dwellMin: 20, label: `customer:${i}` });
  }
  wps.push({ ...plan.pool, dwellMin: 10, label: "pool" });
  return wps;
}

export function simulateTruckDay(plan: TruckDayPlan, opts: { intervalS?: number; endAt?: Date } = {}): SimFix[] {
  return simulateRoute({
    start: plan.start,
    waypoints: truckDayWaypoints(plan),
    speedKmh: plan.speedKmh ?? 30,
    intervalS: opts.intervalS ?? 60,
    seed: plan.seed,
    endAt: opts.endAt,
  });
}
