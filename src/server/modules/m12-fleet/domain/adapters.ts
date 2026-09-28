/**
 * M12 — penghubung vendor GPS (NFR-21, US-M12-01 KP-1/KP-3). MURNI (tanpa DB): setiap vendor punya adaptor yang
 * memetakan protokolnya ke FORMAT POSISI INTERNAL (`GpsFix`). Mengganti vendor = menambah/mengganti adaptor di sini;
 * layanan penerima (`service/ingest.ts`), tabel `gps_positions`, deteksi, peta, dan riwayat tidak berubah.
 *
 * Adaptor bawaan:
 * - `generic-json` — JSON generik (satu objek, larik, atau `{ positions: [...] }`) untuk vendor yang dapat mengirim
 *   webhook/HTTP POST; juga dipakai simulator `scripts/gps-simulate.ts`.
 * - `osmand` — protokol terbuka OsmAnd / Traccar Client (HTTP GET/POST `?id=&lat=&lon=&timestamp=&speed=…`, kecepatan
 *   dalam knot) dan format JSON Traccar Client baru (`{ device_id, location: { coords, battery, … } }`).
 */
import { z } from "zod";

/** Batas teknis satu permintaan penghubung (bukan aturan bisnis). */
export const MAX_FIXES_PER_REQUEST = 500;

const KNOT_TO_KMH = 1.852;
const MS_TO_KMH = 3.6;

/** Format posisi internal (tetap, apa pun vendornya). */
export type GpsFix = {
  /** Pengenal perangkat dari vendor: IMEI / kode perangkat (`devices.imei` / `devices.device_code`). */
  deviceRef: string;
  deviceTime: Date;
  lat: number;
  lng: number;
  speedKmh: number | null;
  heading: number | null;
  accuracyM: number | null;
  ignitionOn: boolean | null;
  /** Daya eksternal terhubung (false = kabel daya dicabut, US-M12-08 KP-1). */
  powerConnected: boolean | null;
  batteryPct: number | null;
  firmwareVersion: string | null;
  /** Penanda validitas fix dari vendor (null = tidak dilaporkan). */
  vendorValid: boolean | null;
  /** Data mentah vendor untuk posisi ini (disimpan apa adanya, US-M12-01 KP-1). */
  raw: Record<string, unknown>;
};

export type AdapterInput = {
  method: string;
  contentType: string;
  query: URLSearchParams;
  /** Isi permintaan: objek/larik JSON, `URLSearchParams` (form), string, atau null. */
  body: unknown;
};

export type AdapterError = { index: number; message: string };

export type AdapterResult = { fixes: GpsFix[]; errors: AdapterError[] };

export interface GpsVendorAdapter {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  parse(input: AdapterInput): AdapterResult;
}

// =====================================================================================================================
// Pembantu penguraian
// =====================================================================================================================

/** Waktu dari epoch detik/milidetik, string angka, ISO, atau "YYYY-MM-DD HH:mm:ss" (UTC). */
export function parseFixTime(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function bool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "ya"].includes(s)) return true;
  if (["0", "false", "no", "off", "tidak"].includes(s)) return false;
  return null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  return undefined;
}

function round(n: number | null, digits: number): number | null {
  if (n === null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function headingOf(value: unknown): number | null {
  const n = num(value);
  if (n === null) return null;
  return Math.round(((n % 360) + 360) % 360);
}

function batteryOf(value: unknown): number | null {
  const n = num(value);
  if (n === null) return null;
  // Traccar Client JSON mengirim 0..1; protokol lain 0..100.
  const pct = n > 0 && n <= 1 && String(value).includes(".") ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Validasi koordinat & waktu dasar yang sama untuk semua vendor. Mengembalikan pesan galat berbahasa Indonesia. */
export function validateFix(fix: Partial<GpsFix>): string | null {
  if (!fix.deviceRef) return "Pengenal perangkat (IMEI/kode) wajib diisi.";
  if (!fix.deviceTime) return "Waktu posisi tidak valid.";
  if (fix.lat === undefined || fix.lat === null || fix.lng === undefined || fix.lng === null) return "Lintang/bujur wajib diisi.";
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) || fix.lat < -90 || fix.lat > 90 || fix.lng < -180 || fix.lng > 180) {
    return "Lintang/bujur di luar rentang.";
  }
  return null;
}

function collect(items: unknown[], map: (item: Record<string, unknown>) => Partial<GpsFix>): AdapterResult {
  const fixes: GpsFix[] = [];
  const errors: AdapterError[] = [];
  items.slice(0, MAX_FIXES_PER_REQUEST).forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ index, message: "Format posisi tidak dikenal (harus objek)." });
      return;
    }
    const fix = map(item as Record<string, unknown>);
    const problem = validateFix(fix);
    if (problem) errors.push({ index, message: problem });
    else fixes.push(fix as GpsFix);
  });
  if (items.length > MAX_FIXES_PER_REQUEST) {
    errors.push({ index: MAX_FIXES_PER_REQUEST, message: `Maksimal ${MAX_FIXES_PER_REQUEST} posisi per permintaan; sisanya kirim ulang terpisah.` });
  }
  return { fixes, errors };
}

function bodyAsRecord(body: unknown): Record<string, unknown> | null {
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body === "string" && body.trim()) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return Object.fromEntries(new URLSearchParams(body).entries());
    }
  }
  return null;
}

// =====================================================================================================================
// generic-json
// =====================================================================================================================

const positionsEnvelope = z.object({ positions: z.array(z.unknown()) });

function genericItems(body: unknown): unknown[] {
  const v = typeof body === "string" ? safeJson(body) : body instanceof URLSearchParams ? Object.fromEntries(body.entries()) : body;
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") return [];
  const env = positionsEnvelope.safeParse(v);
  return env.success ? env.data.positions : [v];
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

/** JSON generik: `deviceId|imei`, `time|timestamp`, `lat`, `lng|lon`, `speedKmh|speed` (km/jam), `heading`, `accuracy`, `ignition`, `power`, `battery`, `valid`, `firmware`. */
export const genericJsonAdapter: GpsVendorAdapter = {
  key: "generic-json",
  label: "JSON generik",
  description: "HTTP POST JSON: satu posisi, larik posisi, atau { positions: [...] }. Kecepatan dalam km/jam.",
  parse(input) {
    return collect(genericItems(input.body), (item) => ({
      deviceRef: str(pick(item, "deviceId", "device_id", "imei", "device", "id")) ?? "",
      deviceTime: parseFixTime(pick(item, "time", "timestamp", "deviceTime", "fixTime")) ?? undefined,
      lat: num(pick(item, "lat", "latitude")) ?? undefined,
      lng: num(pick(item, "lng", "lon", "longitude")) ?? undefined,
      speedKmh: round(num(pick(item, "speedKmh", "speed_kmh", "speed")), 1),
      heading: headingOf(pick(item, "heading", "course", "bearing")),
      accuracyM: round(num(pick(item, "accuracyM", "accuracy", "accuracy_m")), 1),
      ignitionOn: bool(pick(item, "ignition", "ignitionOn")),
      powerConnected: bool(pick(item, "power", "powerConnected", "externalPower", "charge")),
      batteryPct: batteryOf(pick(item, "battery", "batteryPct", "batt")),
      firmwareVersion: str(pick(item, "firmware", "firmwareVersion", "version")),
      vendorValid: bool(pick(item, "valid", "gpsValid")),
      raw: item,
    }));
  },
};

// =====================================================================================================================
// osmand (OsmAnd / Traccar Client)
// =====================================================================================================================

function osmandFromParams(item: Record<string, unknown>): Partial<GpsFix> {
  const speedKnots = num(pick(item, "speed"));
  return {
    deviceRef: str(pick(item, "id", "deviceid", "device_id")) ?? "",
    deviceTime: parseFixTime(pick(item, "timestamp", "time")) ?? undefined,
    lat: num(pick(item, "lat", "latitude")) ?? undefined,
    lng: num(pick(item, "lon", "lng", "longitude")) ?? undefined,
    speedKmh: speedKnots === null ? null : round(speedKnots * KNOT_TO_KMH, 1),
    heading: headingOf(pick(item, "bearing", "heading", "course")),
    accuracyM: round(num(pick(item, "accuracy")), 1),
    ignitionOn: bool(pick(item, "ignition")),
    powerConnected: bool(pick(item, "charge", "power")),
    batteryPct: batteryOf(pick(item, "batt", "battery")),
    firmwareVersion: str(pick(item, "firmware", "version")),
    vendorValid: bool(pick(item, "valid")),
    raw: item,
  };
}

/** Format JSON Traccar Client (≥ v9): `{ device_id, location: { timestamp, coords: {…}, battery: {…} } }` — kecepatan m/detik. */
function osmandFromJson(item: Record<string, unknown>): Partial<GpsFix> {
  const loc = (item.location ?? {}) as Record<string, unknown>;
  const coords = (loc.coords ?? {}) as Record<string, unknown>;
  const battery = (loc.battery ?? {}) as Record<string, unknown>;
  const speedMs = num(coords.speed);
  return {
    deviceRef: str(pick(item, "device_id", "deviceId", "id")) ?? "",
    deviceTime: parseFixTime(loc.timestamp) ?? undefined,
    lat: num(coords.latitude) ?? undefined,
    lng: num(coords.longitude) ?? undefined,
    speedKmh: speedMs === null || speedMs < 0 ? null : round(speedMs * MS_TO_KMH, 1),
    heading: headingOf(coords.heading),
    accuracyM: round(num(coords.accuracy), 1),
    ignitionOn: null,
    powerConnected: bool(battery.is_charging),
    batteryPct: batteryOf(battery.level),
    firmwareVersion: null,
    vendorValid: null,
    raw: item,
  };
}

export const osmandAdapter: GpsVendorAdapter = {
  key: "osmand",
  label: "OsmAnd / Traccar",
  description: "Protokol terbuka OsmAnd (Traccar): HTTP GET/POST ?id=&lat=&lon=&timestamp=&speed=(knot)&bearing=&accuracy=&batt=&charge=&ignition=.",
  parse(input) {
    const fromQuery = Object.fromEntries(input.query.entries());
    const body = bodyAsRecord(input.body);
    if (body && typeof body.location === "object" && body.location !== null) return collect([body], osmandFromJson);
    const merged: Record<string, unknown> = { ...(body ?? {}), ...fromQuery };
    delete merged.token;
    return collect([merged], osmandFromParams);
  },
};

// =====================================================================================================================
// Registri
// =====================================================================================================================

export const GPS_VENDOR_ADAPTERS: Readonly<Record<string, GpsVendorAdapter>> = {
  [genericJsonAdapter.key]: genericJsonAdapter,
  [osmandAdapter.key]: osmandAdapter,
};

/** Adaptor vendor untuk kunci rute `/api/gps/ingest/<vendor>` (null bila tidak dikenal). */
export function getGpsVendorAdapter(key: string): GpsVendorAdapter | null {
  return Object.prototype.hasOwnProperty.call(GPS_VENDOR_ADAPTERS, key) ? GPS_VENDOR_ADAPTERS[key]! : null;
}

export function listGpsVendorAdapters(): { key: string; label: string; description: string }[] {
  return Object.values(GPS_VENDOR_ADAPTERS).map((a) => ({ key: a.key, label: a.label, description: a.description }));
}
