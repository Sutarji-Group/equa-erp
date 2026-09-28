/**
 * Harness DB uji (docs/ARCHITECTURE.md §10): PGlite in-memory per berkas uji dengan skema lengkap + trigger pengerasan
 * (+ opsional seed demo), dimuat dari snapshot yang di-cache (lihat `db-snapshot.ts`; ±0,5 detik per DB).
 *
 * Pakai:
 * ```ts
 * import { createTestDb, useTestDb } from "../helpers/db";
 *
 * // A. Hook otomatis (beforeAll/afterAll) + suntik ke getDb() lewat setDbForTests:
 * const t = useTestDb({ seed: true });
 * it("US-M1-01 KP-1 …", async () => { const rows = await t.db.select().from(customers); });
 *
 * // B. Manual:
 * const { db, close } = await createTestDb();        // skema kosong + hardening
 * const seeded = await createTestDb({ seed: true });  // + data demo (runSeed)
 * await close();
 * ```
 */
import { afterAll, beforeAll } from "vitest";

import { setDbForTests, type Db } from "@/db/client";

import { createTestDb, type CreateTestDbOptions, type TestDb } from "./db-snapshot";

export { createTestDb, ensureTestDbSnapshots, testDbSnapshotKey, wrapPglite } from "./db-snapshot";
export type { CreateTestDbOptions, TestDb } from "./db-snapshot";

/**
 * Daftarkan `beforeAll`/`afterAll` yang membuat DB uji untuk berkas ini. Bawaan menyuntik ke `getDb()` lewat
 * `setDbForTests` (`inject: false` untuk menonaktifkan).
 */
export function useTestDb(options: CreateTestDbOptions & { inject?: boolean } = {}): {
  readonly db: Db;
  readonly client: TestDb["client"];
} {
  let current: TestDb | undefined;
  beforeAll(async () => {
    current = await createTestDb(options);
    if (options.inject !== false) setDbForTests(current.db);
  });
  afterAll(async () => {
    if (options.inject !== false) setDbForTests(null);
    await current?.close();
    current = undefined;
  });
  return {
    get db() {
      if (!current) throw new Error("DB uji belum siap — akses hanya di dalam it()/beforeEach().");
      return current.db;
    },
    get client() {
      if (!current) throw new Error("DB uji belum siap — akses hanya di dalam it()/beforeEach().");
      return current.client;
    },
  };
}
