/**
 * Konfigurasi uji beban NFR-05 (3× volume saat ini: 20 truk, 30 depot + 50 outlet mitra, 1.000 pelanggan,
 * 5.000 transaksi/hari) — dipakai `scripts/perf/generate.ts` & `scripts/perf/measure.ts`. Metodologi: docs/qa/uji-beban.md.
 *
 * Semua angka volume ada di sini (satu sumber) agar hasil uji dapat diulang persis: pembangkit memakai PRNG berbenih
 * (`rng(seed)`), jadi data yang sama dihasilkan untuk benih & tanggal jangkar yang sama.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

/** Direktori PGlite uji beban (terpisah dari DB dev `.data/pglite` & E2E). */
export const PERF_DATA_DIR = process.env.PERF_PGLITE_DATA_DIR?.trim() || "./.data/pglite-perf";
/** Berkas meta hasil pembangkitan (tanggal jangkar, jumlah baris) — dibaca measure.ts. */
export const PERF_META_FILE = `${PERF_DATA_DIR.replace(/\/+$/, "")}.meta.json`;

export const VOLUME = {
  /** Hari data historis (termasuk hari jangkar yang baru berjalan setengah hari). */
  days: 60,
  /** Truk EQUA (T1..T20). */
  trucks: 20,
  /** Depot EQUA (D01..D30). */
  equaDepots: 30,
  /** Tenant mitra × outlet per tenant = 50 outlet mitra. */
  partnerTenants: 25,
  outletsPerPartner: 2,
  /** Pelanggan luar (tenant EQUA). */
  customers: 1_000,
  /** Rit per truk per hari (rata-rata; ±1). */
  tripsPerTruck: 6,
  /** Rit internal pasokan depot per hari (total, dibagi ke truk; tiap depot dipasok 5.000 L dua hari sekali). */
  internalTripsPerDay: 15,
  /** Transaksi POS per depot EQUA per hari (rata-rata; sebaran ±35%). */
  salesPerEquaDepot: 70,
  /** Transaksi POS per outlet mitra per hari. */
  salesPerPartnerOutlet: 50,
  /** Transaksi toko TK1 per hari. */
  salesPerStore: 150,
  /** Posisi GPS per truk: satu posisi per menit saat mesin hidup (PAR-26). */
  gpsIntervalSec: 60,
} as const;

/** Perkiraan transaksi/hari dari konfigurasi (untuk laporan). */
export function expectedTransactionsPerDay(): number {
  const v = VOLUME;
  return v.trucks * v.tripsPerTruck + v.equaDepots * v.salesPerEquaDepot + v.partnerTenants * v.outletsPerPartner * v.salesPerPartnerOutlet + v.salesPerStore;
}

export type PerfMeta = {
  generatedAt: string;
  /** Tanggal jangkar = "hari ini" data uji (hari terakhir, setengah hari). */
  anchorDate: BusinessDate;
  /** Waktu jangkar (ISO) — dipakai sebagai `ctx.now` saat mengukur. */
  anchorNow: string;
  seed: number;
  days: number;
  durationSec: number;
  counts: Record<string, number>;
  notes: string[];
};

export function readMeta(): PerfMeta {
  if (!existsSync(PERF_META_FILE)) {
    throw new Error(`Meta uji beban ${PERF_META_FILE} tidak ada — jalankan \`pnpm perf:generate\` dulu.`);
  }
  return JSON.parse(readFileSync(PERF_META_FILE, "utf8")) as PerfMeta;
}

export function writeMeta(meta: PerfMeta): void {
  writeFileSync(PERF_META_FILE, `${JSON.stringify(meta, null, 2)}\n`);
}

/** Tanggal & jam jangkar dari argumen `--tanggal YYYY-MM-DD --jam HH:mm` (bawaan: hari ini WIB, 13:30). */
export function anchorFromArgs(argv: string[]): { anchorDate: BusinessDate; anchorNow: Date } {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const anchorDate = arg("tanggal") ?? toBusinessDate(new Date());
  const time = arg("jam") ?? "13:30";
  return { anchorDate, anchorNow: wibToUtc(anchorDate, time) };
}

export function numberArg(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} harus angka positif.`);
  return n;
}

/** Tolak direktori yang bukan milik uji beban (mencegah menimpa DB dev/E2E). */
export function assertPerfDir(dir: string): void {
  const base = path.basename(path.resolve(dir));
  if (!base.includes("perf")) throw new Error(`Direktori "${dir}" bukan direktori uji beban (harus memuat "perf") — dibatalkan.`);
}

// =====================================================================================================================
// PRNG berbenih (mulberry32) — data dapat diulang.
// =====================================================================================================================

export type Rng = {
  next: () => number;
  int: (min: number, max: number) => number;
  pick: <T>(list: readonly T[]) => T;
  chance: (p: number) => boolean;
  /** Bilangan bulat di sekitar `mean` dengan sebaran ±`spread` (proporsi). */
  around: (mean: number, spread: number) => number;
};

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (list) => list[Math.floor(next() * list.length)]!,
    chance: (p) => next() < p,
    around: (mean, spread) => Math.max(1, Math.round(mean * (1 - spread + next() * 2 * spread))),
  };
}
