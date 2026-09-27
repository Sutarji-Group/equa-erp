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
