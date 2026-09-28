/**
 * `pnpm e2e:prepare` — siapkan DB PGlite khusus E2E (bawaan `.data/pglite-e2e`): hapus, dorong skema + trigger
 * pengerasan, isi data demo, lalu terbitkan kode aktivasi perangkat demo (HP-T1 = ponsel truk T1) agar skenario
 * aktivasi → PIN → offline dapat dijalankan Playwright. Menolak berjalan pada direktori yang tidak memuat "e2e".
 */
import { rmSync } from "node:fs";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

import { closeDb, getDb } from "@/db/client";
import { applyDbHardening } from "@/db/hardening";
import * as schema from "@/db/schema";
import { devices } from "@/db/schema";
import { deviceId, runSeed } from "@/db/seed";
import { hashCode } from "@/server/core/auth/crypto";

/** Kode aktivasi perangkat demo E2E (HP-T1). */
export const E2E_ACTIVATION_CODE = "UJIE2E26";

async function main(): Promise<void> {
  const dir = process.env.PGLITE_DATA_DIR?.trim() || "./.data/pglite-e2e";
  if (!dir.includes("e2e")) throw new Error(`PGLITE_DATA_DIR "${dir}" bukan direktori E2E — dibatalkan.`);
  process.env.PGLITE_DATA_DIR = dir;
  process.env.DB_DRIVER = "pglite";
  rmSync(dir, { recursive: true, force: true });

  const db = getDb();
  const result = await pushSchema(schema as unknown as Record<string, unknown>, db as unknown as Parameters<typeof pushSchema>[1]);
  await result.apply();
  await applyDbHardening(db);
  await runSeed(db);
  await db
    .update(devices)
    .set({
      status: "registered",
      activationCodeHash: hashCode("device-activation", E2E_ACTIVATION_CODE),
      activationExpiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
      secretHash: null,
    })
    .where(eq(devices.id, deviceId("HP-T1")));
  console.log(`e2e:prepare → ${dir} siap (kode aktivasi HP-T1: ${E2E_ACTIVATION_CODE}).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
