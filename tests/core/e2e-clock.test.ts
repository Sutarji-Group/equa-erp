import { afterEach, describe, expect, it } from "vitest";

import { e2eClockAllowed, parseServerEnv, resetServerEnvCache } from "@/lib/env";
import { signDeviceToken, authenticateDevice } from "@/server/core/auth";
import { apiErrorResponse } from "@/server/core/auth/http";
import { AuthError } from "@/server/core/auth/errors";
import {
  E2E_CLOCK_COOKIE,
  E2E_CLOCK_MAX_OFFSET_MS,
  e2eClockOffset,
  e2eCronNow,
  e2eNow,
  e2eRequestNow,
  parseE2eClockOffset,
} from "@/server/core/e2e-clock";

import { useTestDb } from "../helpers/db";
import { fieldDevice } from "../helpers/field";

/**
 * Jam tersuntik KHUSUS E2E (skenario lintas modul P-01..P-07, docs/qa/skenario-uji.md). Pengaman NFR-09: mati secara
 * bawaan, tidak pernah aktif di deploy Vercel production/preview, dan butuh dua flag eksplisit.
 */
const DAY = 86_400_000;
const E2E_ENV = parseServerEnv({ NODE_ENV: "production", ALLOW_DEV_SECRETS: "1", E2E_CLOCK_OVERRIDE: "1" });

function withEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetServerEnvCache();
}

afterEach(() => {
  withEnv({ E2E_CLOCK_OVERRIDE: undefined, ALLOW_DEV_SECRETS: undefined });
});

describe("S5-QA jam tersuntik E2E — pengaman (NFR-09)", () => {
  it("NFR-09 bawaan MATI: tanpa flag, dev/uji maupun produksi self-host mengabaikan cookie", () => {
    expect(e2eClockAllowed(parseServerEnv({}))).toBe(false);
    expect(e2eClockAllowed(parseServerEnv({ ALLOW_DEV_SECRETS: "1" }))).toBe(false);
    expect(e2eClockAllowed(parseServerEnv({ E2E_CLOCK_OVERRIDE: "1" }))).toBe(false);
    const prod = parseServerEnv({ NODE_ENV: "production", SESSION_SECRET: "s".repeat(40), CRON_SECRET: "c", GPS_INGEST_TOKEN: "g", E2E_CLOCK_OVERRIDE: "1" });
    expect(e2eClockAllowed(prod)).toBe(false);
    expect(e2eClockOffset(String(DAY), prod)).toBe(0);
    const t = Date.UTC(2026, 8, 30, 1, 0, 0);
    expect(e2eNow(String(DAY), prod, t).getTime()).toBe(t);
  });

  it("NFR-09 deploy Vercel production/preview MENOLAK flag (validasi env gagal), bukan diam-diam aktif", () => {
    const base = { DB_DRIVER: "neon", DATABASE_URL: "postgres://u:p@h/db", SESSION_SECRET: "s".repeat(40), CRON_SECRET: "c", GPS_INGEST_TOKEN: "g" };
    expect(() => parseServerEnv({ ...base, VERCEL_ENV: "production", E2E_CLOCK_OVERRIDE: "1" })).toThrow(/E2E_CLOCK_OVERRIDE/);
    expect(() => parseServerEnv({ ...base, VERCEL_ENV: "preview", E2E_CLOCK_OVERRIDE: "1", ALLOW_DEV_SECRETS: "1" })).toThrow(/E2E_CLOCK_OVERRIDE/);
    // Walau objek env dipalsukan, fungsi pengaman tetap menolak Vercel.
    expect(e2eClockAllowed({ VERCEL_ENV: "preview", ALLOW_DEV_SECRETS: true, E2E_CLOCK_OVERRIDE: true })).toBe(false);
    expect(e2eClockAllowed({ VERCEL_ENV: "production", ALLOW_DEV_SECRETS: true, E2E_CLOCK_OVERRIDE: true })).toBe(false);
  });

  it("NFR-09 E2E lokal (`next start` + ALLOW_DEV_SECRETS=1 + E2E_CLOCK_OVERRIDE=1): selisih cookie berlaku & dibatasi ±400 hari", () => {
    expect(e2eClockAllowed(E2E_ENV)).toBe(true);
    const t = Date.UTC(2026, 8, 30, 1, 0, 0);
    expect(e2eNow(String(DAY), E2E_ENV, t).getTime()).toBe(t + DAY);
    expect(e2eNow(String(-3 * DAY), E2E_ENV, t).getTime()).toBe(t - 3 * DAY);
    for (const bad of ["", "abc", "1.5", "1e9", String(E2E_CLOCK_MAX_OFFSET_MS + 1), "--5"]) {
      expect(parseE2eClockOffset(bad), bad).toBeNull();
      expect(e2eNow(bad, E2E_ENV, t).getTime(), bad).toBe(t);
    }
  });

  it("NFR-09 waktu permintaan dibaca dari cookie `equa_e2e_clock` hanya bila diizinkan", () => {
    const req = { headers: new Headers({ cookie: `equa_session=abc; ${E2E_CLOCK_COOKIE}=${DAY}` }) };
    const shifted = e2eRequestNow(req, E2E_ENV).getTime() - Date.now();
    expect(shifted).toBeGreaterThan(DAY - 5_000);
    expect(shifted).toBeLessThan(DAY + 5_000);
    expect(Math.abs(e2eRequestNow(req, parseServerEnv({})).getTime() - Date.now())).toBeLessThan(5_000);
    expect(Math.abs(e2eRequestNow(null, E2E_ENV).getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("NFR-09 `/api/cron/tick?now=` hanya untuk E2E: kosong → jam nyata; diisi saat mati → ditolak; nilai ngawur ditolak", () => {
    const t = Date.UTC(2026, 8, 30, 1, 0, 0);
    expect(e2eCronNow(null, E2E_ENV, t)).toBeNull();
    expect(e2eCronNow("", parseServerEnv({}), t)).toBeNull();
    expect(e2eCronNow("2026-10-08T00:30:00.000Z", E2E_ENV, t)!.toISOString()).toBe("2026-10-08T00:30:00.000Z");
    expect(() => e2eCronNow("2026-10-08T00:30:00.000Z", parseServerEnv({}), t)).toThrow(/hanya untuk uji E2E/);
    expect(() => e2eCronNow("bukan-tanggal", E2E_ENV, t)).toThrow(/tidak valid/);
    expect(() => e2eCronNow("2030-01-01T00:00:00Z", E2E_ENV, t)).toThrow(/400 hari/);
  });

  it("NFR-09 rute cron menolak `now` bila jam tersuntik mati (bawaan) — 400 tanpa menjalankan job", async () => {
    withEnv({ E2E_CLOCK_OVERRIDE: undefined, ALLOW_DEV_SECRETS: undefined });
    const { GET } = await import("@/app/api/cron/tick/route");
    const res = await GET(new Request("http://localhost/api/cron/tick?now=2026-10-08T00:30:00Z&only=tidak.ada", { headers: { authorization: "Bearer dev-cron-secret" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});

describe("S5-QA jam tersuntik E2E — perangkat lapangan & galat API (US-M10-02)", () => {
  useTestDb({ seed: true });

  async function deviceRequest(secret: string, deviceId: string, tokenNow: Date, cookie?: string): Promise<Request> {
    const headers: Record<string, string> = { authorization: `Bearer ${await signDeviceToken(secret, { deviceId }, { now: tokenNow })}` };
    if (cookie) headers.cookie = cookie;
    return new Request("http://localhost/api/device/status", { headers });
  }

  it("US-M10-02 KP-1 NFR-09 `authenticateDevice`: cookie diabaikan bila mati; bila E2E aktif `auth.now` & verifikasi JWT memakai jam tergeser", async () => {
    const hp = await fieldDevice("HP-T6");
    const cookie = `${E2E_CLOCK_COOKIE}=${DAY}`;

    // Bawaan (mati): cookie diabaikan — jam permintaan = jam nyata, galat API memakai jam nyata.
    const real = await authenticateDevice(await deviceRequest(hp.secret, hp.deviceId, new Date(), cookie));
    expect(Math.abs(real.now.getTime() - Date.now())).toBeLessThan(5_000);
    const realErr = (await apiErrorResponse(new AuthError("SESSION_EXPIRED", "Sesi berakhir."), { headers: new Headers({ cookie }) }).json()) as { serverTime: string };
    expect(Math.abs(Date.parse(realErr.serverTime) - Date.now())).toBeLessThan(5_000);

    // E2E aktif: jam server permintaan = nyata + selisih — token berjam nyata kini kedaluwarsa, token berjam tergeser sah.
    withEnv({ E2E_CLOCK_OVERRIDE: "1", ALLOW_DEV_SECRETS: "1" });
    await expect(authenticateDevice(await deviceRequest(hp.secret, hp.deviceId, new Date(), cookie))).rejects.toBeInstanceOf(AuthError);
    const shifted = await authenticateDevice(await deviceRequest(hp.secret, hp.deviceId, new Date(Date.now() + DAY), cookie));
    expect(shifted.now.getTime() - Date.now()).toBeGreaterThan(DAY - 10_000);
    // Tanpa cookie → jam nyata walau fitur aktif.
    const plain = await authenticateDevice(await deviceRequest(hp.secret, hp.deviceId, new Date()));
    expect(Math.abs(plain.now.getTime() - Date.now())).toBeLessThan(5_000);
    const res = apiErrorResponse(new AuthError("SESSION_EXPIRED", "Sesi berakhir."), { headers: new Headers({ cookie }) });
    const body = (await res.json()) as { serverTime: string };
    expect(Date.parse(body.serverTime) - Date.now()).toBeGreaterThan(DAY - 10_000);
  });
});
