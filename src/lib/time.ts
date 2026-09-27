/**
 * Waktu & tanggal bisnis EQUA (isomorfik).
 *
 * - Waktu disimpan UTC (`timestamptz`). Tanggal bisnis = tanggal kalender WIB (Asia/Jakarta, UTC+7, tanpa DST sejak
 *   1964) dengan format `YYYY-MM-DD` (docs/DECISIONS.md D-04, PRD Bab 5.3).
 * - Semua fungsi di sini deterministik & tidak bergantung zona waktu mesin/peramban maupun data ICU.
 * - Format Indonesia: `formatTanggal` → `"Sabtu, 27 Sep 2026"`, `formatJam` → `"14.30"` (PUEBI: titik).
 */

export const WIB_TIMEZONE = "Asia/Jakarta";
export const WIB_OFFSET_MINUTES = 7 * 60;
const WIB_OFFSET_MS = WIB_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;

/** Tanggal bisnis `YYYY-MM-DD` (WIB). */
export type BusinessDate = string;
/** Jam `HH:mm` (24 jam). */
export type HourMinute = string;

export const NAMA_HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"] as const;
export const NAMA_BULAN = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;
export const NAMA_BULAN_SINGKAT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
] as const;

const BUSINESS_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toDate(value: Date | number | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError("Tanggal/waktu tidak valid.");
  return d;
}

/** Komponen kalender & jam WIB dari sebuah instan. */
export type WibParts = {
  instant: Date;
  businessDate: BusinessDate;
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Minggu … 6 = Sabtu */
  weekday: number;
  /** `HH:mm` */
  time: HourMinute;
};

/** Pecah instan menjadi komponen WIB. */
export function toWibParts(value: Date | number | string = new Date()): WibParts {
  const instant = toDate(value);
  const shifted = new Date(instant.getTime() + WIB_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return {
    instant,
    businessDate: `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`,
    year,
    month,
    day,
    hour,
    minute,
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
    time: `${pad2(hour)}:${pad2(minute)}`,
  };
}

/** Komponen WIB saat ini (atau dari `now` yang diberikan, mis. `ctx.now`). */
export function nowWib(now: Date = new Date()): WibParts {
  return toWibParts(now);
}

/** Tanggal bisnis WIB `YYYY-MM-DD` dari sebuah instan. `2026-09-26T17:00:00Z` → `"2026-09-27"`. */
export function toBusinessDate(value: Date | number | string = new Date()): BusinessDate {
  return toWibParts(value).businessDate;
}

/** Benar bila string berformat `YYYY-MM-DD` dan tanggalnya ada di kalender. */
export function isBusinessDate(value: unknown): value is BusinessDate {
  if (typeof value !== "string") return false;
  const m = BUSINESS_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function parseBusinessDate(value: BusinessDate): { y: number; m: number; d: number } {
  if (!isBusinessDate(value)) throw new RangeError(`Tanggal bisnis tidak valid: "${value}" (format YYYY-MM-DD).`);
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

/** Tengah malam UTC untuk tanggal kalender (alat bantu aritmetika tanggal). */
function businessDateToUtcMidnight(value: BusinessDate): number {
  const { y, m, d } = parseBusinessDate(value);
  return Date.UTC(y, m - 1, d);
}

function utcMidnightToBusinessDate(ms: number): BusinessDate {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Rentang instan UTC setengah terbuka `[start, end)` yang dicakup satu tanggal bisnis WIB.
 * `"2026-09-27"` → `{ start: 2026-09-26T17:00:00Z, end: 2026-09-27T17:00:00Z }`. Kueri: `at >= start AND at < end`.
 */
export function businessDateToUtcRange(value: BusinessDate): { start: Date; end: Date } {
  const midnight = businessDateToUtcMidnight(value);
  return { start: new Date(midnight - WIB_OFFSET_MS), end: new Date(midnight + DAY_MS - WIB_OFFSET_MS) };
}

/** Instan UTC dari tanggal bisnis + jam WIB. `("2026-09-27", "05:00")` → `2026-09-26T22:00:00Z`. */
export function wibToUtc(date: BusinessDate, time: HourMinute = "00:00"): Date {
  const minutes = parseHourMinute(time);
  return new Date(businessDateToUtcMidnight(date) - WIB_OFFSET_MS + minutes * 60_000);
}

/** Tambah/kurangi hari kalender pada tanggal bisnis. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  if (!Number.isInteger(days)) throw new RangeError("Jumlah hari harus bilangan bulat.");
  return utcMidnightToBusinessDate(businessDateToUtcMidnight(date) + days * DAY_MS);
}

/** Selisih hari kalender `to - from` (mis. umur piutang). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  return Math.round((businessDateToUtcMidnight(to) - businessDateToUtcMidnight(from)) / DAY_MS);
}

/** Hari dalam minggu (0 = Minggu … 6 = Sabtu) untuk tanggal bisnis. */
export function weekdayOf(date: BusinessDate): number {
  return new Date(businessDateToUtcMidnight(date)).getUTCDay();
}

export type BusinessDayOptions = {
  /** Hari libur akhir pekan (0 = Minggu … 6 = Sabtu). Bawaan `[0, 6]` (Sabtu & Minggu). */
  weekendDays?: readonly number[];
  /** Tanggal libur tambahan `YYYY-MM-DD` (mis. libur nasional). */
  holidays?: Iterable<BusinessDate>;
};

/** Benar bila tanggal adalah hari kerja (bukan akhir pekan / libur). */
export function isBusinessDay(date: BusinessDate, options: BusinessDayOptions = {}): boolean {
  const weekend = options.weekendDays ?? [0, 6];
  if (weekend.includes(weekdayOf(date))) return false;
  if (options.holidays) {
    for (const h of options.holidays) if (h === date) return false;
  }
  return true;
}

/**
 * Tambah `days` HARI KERJA (melewati akhir pekan & libur) — mis. tenggat "≤ 2 hari kerja" (PRD 6.2a).
 * `days = 0` mengembalikan tanggal itu sendiri. Nilai negatif mundur. Untuk hari kalender gunakan `addDays`.
 */
export function addBusinessDays(date: BusinessDate, days: number, options: BusinessDayOptions = {}): BusinessDate {
  if (!Number.isInteger(days)) throw new RangeError("Jumlah hari kerja harus bilangan bulat.");
  const holidays = options.holidays ? new Set(options.holidays) : undefined;
  const opts: BusinessDayOptions = { weekendDays: options.weekendDays, holidays };
  const step = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  let current = date;
  while (remaining > 0) {
    current = addDays(current, step);
    if (isBusinessDay(current, opts)) remaining -= 1;
  }
  return current;
}

/** `"2026-09-27"` → `"2026-09"`. */
export function monthOf(date: BusinessDate): string {
  parseBusinessDate(date);
  return date.slice(0, 7);
}

/** Tanggal pertama bulan dari tanggal bisnis. */
export function firstDayOfMonth(date: BusinessDate): BusinessDate {
  return `${monthOf(date)}-01`;
}

/** Tanggal terakhir bulan dari tanggal bisnis. */
export function lastDayOfMonth(date: BusinessDate): BusinessDate {
  const { y, m } = parseBusinessDate(date);
  return utcMidnightToBusinessDate(Date.UTC(y, m, 0));
}

/** Menit sejak tengah malam dari `HH:mm`. */
export function parseHourMinute(value: HourMinute): number {
  const m = HHMM_RE.exec(value);
  if (!m) throw new RangeError(`Jam tidak valid: "${value}" (format HH:mm).`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Benar bila jam WIB dari `date` berada di jendela `[start, end]` (resolusi menit, kedua ujung inklusif).
 * `isWithinWindow("05:00", "22:00", d)` — jam 22.00 masih di dalam, 22.01 di luar.
 * Jendela melewati tengah malam didukung (`"22:00"`–`"05:00"`).
 */
export function isWithinWindow(start: HourMinute, end: HourMinute, date: Date | number | string = new Date()): boolean {
  const s = parseHourMinute(start);
  const e = parseHourMinute(end);
  const { hour, minute } = toWibParts(date);
  const t = hour * 60 + minute;
  return s <= e ? t >= s && t <= e : t >= s || t <= e;
}

export type FormatTanggalOptions = {
  /** Tampilkan nama hari (bawaan `true`). */
  weekday?: boolean;
  /** Nama bulan singkat `"Sep"` (bawaan) atau panjang `"September"`. */
  month?: "short" | "long";
};

/**
 * `"Sabtu, 27 Sep 2026"`. Menerima instan (`Date`/epoch/ISO dengan jam → dikonversi ke WIB) atau tanggal bisnis
 * `YYYY-MM-DD` (dipakai apa adanya).
 */
export function formatTanggal(value: Date | number | string, options: FormatTanggalOptions = {}): string {
  const { weekday = true, month = "short" } = options;
  let y: number, m: number, d: number, wd: number;
  if (typeof value === "string" && BUSINESS_DATE_RE.test(value)) {
    ({ y, m, d } = parseBusinessDate(value));
    wd = weekdayOf(value);
  } else {
    const p = toWibParts(value);
    [y, m, d, wd] = [p.year, p.month, p.day, p.weekday];
  }
  const monthName = (month === "long" ? NAMA_BULAN : NAMA_BULAN_SINGKAT)[m - 1];
  const core = `${d} ${monthName} ${y}`;
  return weekday ? `${NAMA_HARI[wd]}, ${core}` : core;
}

/** Jam WIB `"14.30"` (atau `"14.30.05"` dengan `seconds: true`). */
export function formatJam(value: Date | number | string, options: { seconds?: boolean } = {}): string {
  const p = toWibParts(value);
  const base = `${pad2(p.hour)}.${pad2(p.minute)}`;
  return options.seconds ? `${base}.${pad2(p.second)}` : base;
}

/** `"Sabtu, 27 Sep 2026 14.30"`. */
export function formatTanggalJam(value: Date | number | string, options: FormatTanggalOptions = {}): string {
  return `${formatTanggal(value, options)} ${formatJam(value)}`;
}
