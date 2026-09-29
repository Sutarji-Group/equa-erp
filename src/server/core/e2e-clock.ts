/**
 * Jam tersuntik KHUSUS uji E2E (tambahan S5 QA — skenario lintas modul `e2e/scenarios`, docs/qa/skenario-uji.md).
 *
 * Skenario BRD Bab 5 memuat langkah yang butuh waktu berlalu: rit HARI BERIKUTNYA terbuka setelah setoran ditutup
 * (P-01, BR-10), lewat tempo > PAR-09 hari (P-05), dan pergantian bulan untuk tutup buku (P-07, US-M11-10). Playwright
 * tidak dapat menunggu berhari-hari, jadi uji E2E menyuntik waktu dengan dua cara SAH yang sama-sama melewati lapisan
 * layanan (tidak ada tulis DB langsung):
 *
 * 1. Cookie `equa_e2e_clock=<selisih ms>` — `ctx.now` pelaku web kantor (`getOfficeSession`/`resolveActor`) dan waktu
 *    server permintaan perangkat lapangan (`authenticateDevice` → `auth.now`: sesi PIN, JWT, sinkron) digeser sebesar
 *    selisih itu. Peramban uji menggeser jamnya sendiri (`context.clock.install`) sehingga waktu perangkat (Bab 5.3)
 *    konsisten. Validasi sesi WEB tetap memakai jam nyata (keamanan sesi tidak ikut bergeser).
 * 2. `GET|POST /api/cron/tick?now=<ISO>` — menjalankan job terjadwal "seolah-olah" pada waktu itu (tetap idempoten per
 *    slot `job_runs`). Tetap wajib `Authorization: Bearer $CRON_SECRET`.
 *
 * PENGAMAN: hanya aktif bila `e2eClockAllowed(serverEnv())` — `E2E_CLOCK_OVERRIDE=1` DAN `ALLOW_DEV_SECRETS=1` DAN bukan
 * deploy Vercel production/preview (skema env bahkan MENOLAK flag itu di Vercel). Selain itu cookie & kueri diabaikan
 * dan waktu = jam nyata. Selisih dibatasi ±400 hari. Diuji di `tests/core/e2e-clock.test.ts`.
 */
import "server-only";

import { e2eClockAllowed, serverEnv, type ServerEnv } from "@/lib/env";

/** Nama cookie selisih jam E2E (ms, bilangan bulat bertanda). */
export const E2E_CLOCK_COOKIE = "equa_e2e_clock";
/** Batas selisih yang diterima (±400 hari). */
export const E2E_CLOCK_MAX_OFFSET_MS = 400 * 86_400_000;

type ClockEnv = Pick<ServerEnv, "VERCEL_ENV" | "ALLOW_DEV_SECRETS" | "E2E_CLOCK_OVERRIDE">;

function enabled(env?: ClockEnv): boolean {
  try {
    return e2eClockAllowed(env ?? serverEnv());
  } catch {
    // Env tidak valid → fail-closed.
    return false;
  }
}

/** Urai selisih (ms) dari nilai cookie. `null` bila kosong/tidak sah/di luar batas. */
export function parseE2eClockOffset(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (!/^-?\d{1,14}$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || Math.abs(value) > E2E_CLOCK_MAX_OFFSET_MS) return null;
  return value;
}

/** Selisih jam yang BERLAKU (0 bila fitur mati atau nilai tidak sah). */
export function e2eClockOffset(raw: string | null | undefined, env?: ClockEnv): number {
  if (!enabled(env)) return 0;
  return parseE2eClockOffset(raw) ?? 0;
}

/** Waktu "sekarang" untuk nilai cookie tertentu (jam nyata + selisih yang berlaku). */
export function e2eNow(raw: string | null | undefined, env?: ClockEnv, realNow: number = Date.now()): Date {
  return new Date(realNow + e2eClockOffset(raw, env));
}

function cookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Waktu "sekarang" permintaan (cookie `equa_e2e_clock` di header `Cookie`). Tanpa permintaan → jam nyata. */
export function e2eRequestNow(request: { headers: Headers } | null | undefined, env?: ClockEnv): Date {
  if (!request || !enabled(env)) return new Date();
  return e2eNow(cookieValue(request.headers.get("cookie"), E2E_CLOCK_COOKIE), env);
}

/**
 * Waktu job untuk `/api/cron/tick?now=<ISO>`: tanggal ISO bila fitur aktif & sah (±400 hari dari jam nyata), `null`
 * bila parameter kosong. Melempar bila parameter diisi tetapi fitur mati/nilai tidak sah (pemanggil membalas 400) —
 * agar pemakaian di luar uji tidak diam-diam berjalan dengan jam nyata.
 */
export function e2eCronNow(param: string | null | undefined, env?: ClockEnv, realNow: number = Date.now()): Date | null {
  if (param === null || param === undefined || param.trim() === "") return null;
  if (!enabled(env)) throw new E2eClockDisabledError("Parameter now hanya untuk uji E2E lokal (E2E_CLOCK_OVERRIDE=1).");
  const t = Date.parse(param.trim());
  if (!Number.isFinite(t) || Math.abs(t - realNow) > E2E_CLOCK_MAX_OFFSET_MS) {
    throw new E2eClockDisabledError("Parameter now tidak valid (format ISO, maksimal ±400 hari dari sekarang).");
  }
  return new Date(t);
}

export class E2eClockDisabledError extends Error {
  readonly status = 400;
}
