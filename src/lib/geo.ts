/**
 * Geo isomorfik: jarak & geofence. Penyedia peta/rute ada di balik adaptor server (`src/server/core/maps.ts`);
 * cadangan bawaan `straight_line_x1_3` = garis lurus × 1,3 (PRD US-M1-05 KP-2, PTB-02).
 */

export type LatLng = { lat: number; lng: number };

/** Radius rata-rata bumi (meter, IUGG). */
export const EARTH_RADIUS_M = 6_371_008.8;

/** Faktor cadangan jarak rute dari garis lurus (nama metode `straight_line_x1_3`). */
export const STRAIGHT_LINE_ROUTE_FACTOR = 1.3;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Benar bila koordinat berada di rentang lintang/bujur yang sah. */
export function isValidLatLng(p: Partial<LatLng> | null | undefined): p is LatLng {
  return (
    !!p &&
    typeof p.lat === "number" &&
    typeof p.lng === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

function assertLatLng(p: LatLng, label: string): void {
  if (!isValidLatLng(p)) throw new RangeError(`Koordinat ${label} tidak valid.`);
}

/** Jarak lingkaran besar (haversine) dalam meter. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  assertLatLng(a, "asal");
  assertLatLng(b, "tujuan");
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Perkiraan jarak rute (km) = garis lurus × faktor (bawaan 1,3). Tidak dibulatkan. */
export function straightLineKmX13(a: LatLng, b: LatLng, factor: number = STRAIGHT_LINE_ROUTE_FACTOR): number {
  return (haversineMeters(a, b) / 1000) * factor;
}

/** Benar bila `point` berada dalam radius (meter, inklusif) dari `center` — geofence tiba/pool/sumber. */
export function withinRadius(point: LatLng, center: LatLng, radiusMeters: number): boolean {
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) throw new RangeError("Radius harus angka ≥ 0 meter.");
  return haversineMeters(point, center) <= radiusMeters;
}
