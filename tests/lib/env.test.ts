import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env";

describe("lib/env — validasi env server", () => {
  it("bawaan dev berlaku tanpa env apa pun", () => {
    const env = parseServerEnv({});
    expect(env.DB_DRIVER).toBe("pglite");
    expect(env.PGLITE_DATA_DIR).toBe("./.data/pglite");
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.MAP_ROUTING_PROVIDER).toBe("straight_line_x1_3");
    expect(env.WA_PROVIDER).toBe("link");
    expect(env.PAYMENT_GATEWAY).toBe("none");
    expect(env.MIDTRANS_IS_PRODUCTION).toBe(false);
  });

  it("string kosong dianggap tidak diisi", () => {
    expect(parseServerEnv({ DB_DRIVER: "", APP_URL: "  " }).DB_DRIVER).toBe("pglite");
  });

  it("DATABASE_URL wajib untuk neon/pg", () => {
    expect(() => parseServerEnv({ DB_DRIVER: "neon" })).toThrow(/DATABASE_URL wajib diisi/);
    expect(parseServerEnv({ DB_DRIVER: "pg", DATABASE_URL: "postgres://u:p@localhost/db" }).DB_DRIVER).toBe("pg");
  });

  it("produksi Vercel menolak PGlite dan rahasia bawaan dev", () => {
    expect(() => parseServerEnv({ VERCEL_ENV: "production" })).toThrow(/DB_DRIVER|SESSION_SECRET/);
    const ok = parseServerEnv({
      VERCEL_ENV: "production",
      DB_DRIVER: "neon",
      DATABASE_URL: "postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/db",
      SESSION_SECRET: "x".repeat(48),
      CRON_SECRET: "cron-prod",
      GPS_INGEST_TOKEN: "gps-prod",
    });
    expect(ok.DB_DRIVER).toBe("neon");
  });

  it("nilai enum tidak dikenal ditolak", () => {
    expect(() => parseServerEnv({ DB_DRIVER: "mysql" })).toThrow(/DB_DRIVER/);
  });
});

describe("lib/env — rahasia bawaan dev fail-closed (tinjauan pasca-F3c)", () => {
  it("NFR-09 self-host NODE_ENV=production tanpa VERCEL_ENV menolak rahasia bawaan dev", () => {
    expect(() => parseServerEnv({ NODE_ENV: "production", DB_DRIVER: "pg", DATABASE_URL: "postgres://u:p@h/db" })).toThrow(/SESSION_SECRET/);
    expect(() => parseServerEnv({ NODE_ENV: "production" })).toThrow(/CRON_SECRET/);
  });

  it("NFR-09 deploy preview Vercel juga menolak rahasia bawaan dev", () => {
    expect(() => parseServerEnv({ VERCEL_ENV: "preview", DB_DRIVER: "neon", DATABASE_URL: "postgres://u:p@h/db" })).toThrow(/SESSION_SECRET/);
  });

  it("NFR-09 fase next build & E2E lokal eksplisit (ALLOW_DEV_SECRETS=1) boleh; tidak pernah di produksi Vercel", async () => {
    const { devSecretsAllowed } = await import("@/lib/env");
    expect(parseServerEnv({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }).DB_DRIVER).toBe("pglite");
    const e2e = parseServerEnv({ NODE_ENV: "production", ALLOW_DEV_SECRETS: "1" });
    expect(devSecretsAllowed(e2e)).toBe(true);
    expect(devSecretsAllowed(parseServerEnv({ NODE_ENV: "production", SESSION_SECRET: "y".repeat(40), CRON_SECRET: "c", GPS_INGEST_TOKEN: "g" }))).toBe(false);
    expect(() =>
      parseServerEnv({
        VERCEL_ENV: "production",
        ALLOW_DEV_SECRETS: "1",
        DB_DRIVER: "neon",
        DATABASE_URL: "postgres://u:p@h/db",
        SESSION_SECRET: "x".repeat(48),
        CRON_SECRET: "c",
        GPS_INGEST_TOKEN: "g",
      }),
    ).toThrow(/ALLOW_DEV_SECRETS/);
  });
});
