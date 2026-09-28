/**
 * M12 — analisis jejak GPS MURNI (tanpa DB, tanpa 'server-only'; dipakai layanan, job, seed demo, simulator & uji).
 *
 * - Pembersihan: urut waktu, buang waktu ganda, buang lonjakan (posisi pencilan yang menyiratkan kecepatan mustahil
 *   terhadap KEDUA tetangganya — getar/lompatan GPS, 7.12.6).
 * - Jarak jejak (US-M12-03 KP-1/KP-4), titik berhenti ≥ PAR-49 (radius diam `stop_radius_m`), segmen gerak di antara
 *   titik berhenti, potongan di luar interval rit (US-M12-05 KP-1), celah jejak (7.12.6), lama di dalam radius (lama di
 *   lokasi pelanggan), posisi terdekat pada waktu tertentu (US-M12-04 KP-2), penyederhanaan jalur untuk peta.
 */
import { haversineMeters, type LatLng } from "../../../../lib/geo";

/** Titik jejak internal: waktu dalam milidetik epoch. */
export type TrackPoint = { t: number; lat: number; lng: number; speedKmh?: number | null };

export type Stop = {
  startIndex: number;
  endIndex: number;
  startedAt: number;
  endedAt: number;
  durationS: number;
  lat: number;
  lng: number;
};

export type Segment = {
  startIndex: number;
  endIndex: number;
  startedAt: number;
  endedAt: number;
  durationS: number;
  distanceM: number;
  start: LatLng;
  end: LatLng;
  /** Segmen berakhir karena truk berhenti (bukan ujung jejak yang masih bergerak). */
  endedByStop: boolean;
};

export type Interval = { start: number; end: number };

export type Run = {
  startIndex: number;
  endIndex: number;
  startedAt: number;
  endedAt: number;
  durationS: number;
  distanceM: number;
  start: LatLng;
  end: LatLng;
  /** Potongan selesai: diikuti titik berhenti ATAU dipotong awal interval (mis. rit Berangkat). */
  ended: boolean;
  /** Dipotong awal interval (rit Berangkat) — bukan berhenti. */
  endedByInterval: boolean;
};

/** Urutkan menurut waktu dan buang titik dengan waktu sama (yang pertama dipertahankan). */
export function sortTrack<T extends TrackPoint>(points: readonly T[]): T[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out: T[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.t === p.t) continue;
    out.push(p);
  }
  return out;
}

function kmh(a: TrackPoint, b: TrackPoint): number {
  const dt = Math.abs(b.t - a.t) / 1000;
  if (dt <= 0) return Number.POSITIVE_INFINITY;
  return (haversineMeters(a, b) / dt) * 3.6;
}

/**
 * Buang lonjakan: titik i dibuang bila kecepatan tersirat dari tetangga sebelum DAN sesudahnya > `maxKmh`, sedangkan
 * tetangga sebelum → sesudah wajar. Titik ujung dipertahankan. Masukan harus sudah terurut.
 */
export function dropSpikes<T extends TrackPoint>(points: readonly T[], maxKmh: number): T[] {
  if (points.length < 3) return [...points];
  const keep: T[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = keep[keep.length - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const spike = kmh(prev, cur) > maxKmh && kmh(cur, next) > maxKmh && kmh(prev, next) <= maxKmh;
    if (!spike) keep.push(cur);
  }
  keep.push(points[points.length - 1]!);
  return keep;
}

/** Bersihkan jejak: urut, tanpa waktu ganda, tanpa lonjakan. */
export function cleanTrack<T extends TrackPoint>(points: readonly T[], maxKmh: number): T[] {
  return dropSpikes(sortTrack(points), maxKmh);
}

/** Jarak jejak (meter) = jumlah jarak antar-titik berurutan dalam rentang indeks [from, to]. */
export function pathDistanceM(points: readonly TrackPoint[], from = 0, to = points.length - 1): number {
  let d = 0;
  for (let i = Math.max(from, 0) + 1; i <= Math.min(to, points.length - 1); i++) d += haversineMeters(points[i - 1]!, points[i]!);
  return d;
}

/**
 * Titik berhenti: kumpulan titik berurutan yang tetap dalam `radiusM` dari pusatnya selama ≥ `minDurationS` detik
 * (PAR-49 untuk riwayat, PAR-51 untuk berhenti tidak dikenal). Celah posisi di tengah titik berhenti (truk parkir,
 * perangkat jarang mengirim) tetap dihitung sebagai berhenti.
 */
export function detectStops(points: readonly TrackPoint[], opts: { radiusM: number; minDurationS: number }): Stop[] {
  const stops: Stop[] = [];
  const n = points.length;
  let i = 0;
  while (i < n) {
    let sumLat = points[i]!.lat;
    let sumLng = points[i]!.lng;
    let count = 1;
    let j = i;
    while (j + 1 < n) {
      const center = { lat: sumLat / count, lng: sumLng / count };
      if (haversineMeters(center, points[j + 1]!) > opts.radiusM) break;
      j++;
      sumLat += points[j]!.lat;
      sumLng += points[j]!.lng;
      count++;
    }
    const durationS = (points[j]!.t - points[i]!.t) / 1000;
    if (j > i && durationS >= opts.minDurationS) {
      stops.push({
        startIndex: i,
        endIndex: j,
        startedAt: points[i]!.t,
        endedAt: points[j]!.t,
        durationS: Math.round(durationS),
        lat: sumLat / count,
        lng: sumLng / count,
      });
      i = j + 1;
    } else {
      i++;
    }
  }
  return stops;
}

function segmentOf(points: readonly TrackPoint[], from: number, to: number, endedByStop: boolean): Segment {
  const a = points[from]!;
  const b = points[to]!;
  return {
    startIndex: from,
    endIndex: to,
    startedAt: a.t,
    endedAt: b.t,
    durationS: Math.round((b.t - a.t) / 1000),
    distanceM: pathDistanceM(points, from, to),
    start: { lat: a.lat, lng: a.lng },
    end: { lat: b.lat, lng: b.lng },
    endedByStop,
  };
}

/**
 * Segmen gerak di antara titik berhenti (termasuk sebelum titik berhenti pertama dan sesudah yang terakhir). Segmen
 * lebih pendek dari `minMoveM` dianggap getar GPS dan dibuang.
 */
export function movementSegments(points: readonly TrackPoint[], stops: readonly Stop[], opts: { minMoveM: number }): Segment[] {
  const out: Segment[] = [];
  if (points.length < 2) return out;
  let from = 0;
  for (const s of stops) {
    if (s.startIndex > from) {
      const seg = segmentOf(points, from, s.startIndex, true);
      if (seg.distanceM >= opts.minMoveM) out.push(seg);
    }
    from = s.endIndex;
  }
  if (from < points.length - 1) {
    const seg = segmentOf(points, from, points.length - 1, false);
    if (seg.distanceM >= opts.minMoveM) out.push(seg);
  }
  return out;
}

function inAny(t: number, intervals: readonly Interval[]): boolean {
  return intervals.some((iv) => t >= iv.start && t <= iv.end);
}

/**
 * Potongan segmen yang berada DI LUAR semua interval (mis. rit Berangkat → Selesai/Gagal). Potongan yang diikuti titik
 * di dalam interval = selesai karena rit dimulai (`endedByInterval`); potongan di ujung segmen mewarisi `endedByStop`.
 */
export function runsOutside(points: readonly TrackPoint[], segment: Segment, intervals: readonly Interval[], opts: { minMoveM: number }): Run[] {
  const runs: Run[] = [];
  let k = segment.startIndex;
  while (k <= segment.endIndex) {
    if (inAny(points[k]!.t, intervals)) {
      k++;
      continue;
    }
    const from = k;
    while (k + 1 <= segment.endIndex && !inAny(points[k + 1]!.t, intervals)) k++;
    const to = k;
    const cutByInterval = to < segment.endIndex;
    const a = points[from]!;
    const b = points[to]!;
    const distanceM = pathDistanceM(points, from, to);
    if (to > from && distanceM >= opts.minMoveM) {
      runs.push({
        startIndex: from,
        endIndex: to,
        startedAt: a.t,
        endedAt: b.t,
        durationS: Math.round((b.t - a.t) / 1000),
        distanceM,
        start: { lat: a.lat, lng: a.lng },
        end: { lat: b.lat, lng: b.lng },
        ended: cutByInterval || segment.endedByStop,
        endedByInterval: cutByInterval,
      });
    }
    k = to + 1;
  }
  return runs;
}

/** Celah jejak: pasangan titik berurutan berjarak waktu > `gapMs`. */
export function trackGaps(points: readonly TrackPoint[], gapMs: number): { from: number; to: number; durationS: number }[] {
  const out: { from: number; to: number; durationS: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const dt = points[i]!.t - points[i - 1]!.t;
    if (dt > gapMs) out.push({ from: points[i - 1]!.t, to: points[i]!.t, durationS: Math.round(dt / 1000) });
  }
  return out;
}

/** Lama (detik) jejak berada dalam radius dari titik pusat (dua titik berurutan sama-sama di dalam radius). */
export function timeWithinRadiusS(points: readonly TrackPoint[], center: LatLng, radiusM: number): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (haversineMeters(a, center) <= radiusM && haversineMeters(b, center) <= radiusM) s += (b.t - a.t) / 1000;
  }
  return Math.round(s);
}

/** Posisi terdekat dengan waktu `t` dalam ± `windowMs` (null bila tidak ada). */
export function nearestInTime<T extends TrackPoint>(points: readonly T[], t: number, windowMs: number): T | null {
  let best: T | null = null;
  let bestDt = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const dt = Math.abs(p.t - t);
    if (dt <= windowMs && dt < bestDt) {
      best = p;
      bestDt = dt;
    }
  }
  return best;
}

/** Jarak tegak lurus (meter, proyeksi ekuirektangular lokal) titik p ke garis a–b. */
function perpendicularM(p: LatLng, a: LatLng, b: LatLng): number {
  const k = 111_320;
  const cos = Math.cos((a.lat * Math.PI) / 180);
  const ax = a.lng * k * cos;
  const ay = a.lat * k;
  const bx = b.lng * k * cos - ax;
  const by = b.lat * k - ay;
  const px = p.lng * k * cos - ax;
  const py = p.lat * k - ay;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const u = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - u * bx, py - u * by);
}

/** Penyederhanaan jalur Douglas–Peucker (toleransi meter) untuk peta & putar ulang ringkas. */
export function simplifyPath<T extends LatLng>(points: readonly T[], toleranceM: number): T[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = from + 1; i < to; i++) {
      const d = perpendicularM(points[i]!, points[from]!, points[to]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > toleranceM) {
      keep[idx] = true;
      stack.push([from, idx], [idx, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Batasi jumlah titik (untuk putar ulang) dengan mengambil sampel merata; titik ujung dipertahankan. */
export function sampleEvenly<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

export type ActivitySummary = {
  distanceM: number;
  movingS: number;
  stoppedS: number;
  firstMoveAt: number | null;
  lastMoveAt: number | null;
  stops: Stop[];
  segments: Segment[];
};

/** Ringkasan aktivitas jejak (US-M12-03 KP-2): jarak, waktu bergerak/berhenti, gerak pertama & terakhir. */
export function summarizeActivity(
  points: readonly TrackPoint[],
  opts: { stopRadiusM: number; minStopS: number; minMoveM: number },
): ActivitySummary {
  const stops = detectStops(points, { radiusM: opts.stopRadiusM, minDurationS: opts.minStopS });
  const segments = movementSegments(points, stops, { minMoveM: opts.minMoveM });
  return {
    distanceM: Math.round(pathDistanceM(points)),
    movingS: segments.reduce((s, x) => s + x.durationS, 0),
    stoppedS: stops.reduce((s, x) => s + x.durationS, 0),
    firstMoveAt: segments[0]?.startedAt ?? null,
    lastMoveAt: segments[segments.length - 1]?.endedAt ?? null,
    stops,
    segments,
  };
}

/** Lokasi (geofence lingkaran) yang memuat titik — yang terdekat bila tumpang tindih. */
export function locationContaining<L extends LatLng & { radiusM: number }>(point: LatLng, locations: readonly L[], marginM = 0): L | null {
  let best: L | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const loc of locations) {
    const d = haversineMeters(point, loc);
    if (d <= loc.radiusM + marginM && d < bestD) {
      best = loc;
      bestD = d;
    }
  }
  return best;
}
