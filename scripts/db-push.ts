/**
 * `pnpm db:push` — dorong skema Drizzle ke DB terkonfigurasi (bawaan PGlite `.data/pglite`; atau DB_DRIVER=neon/pg +
 * DATABASE_URL) lalu terapkan trigger pengerasan (`src/db/sql/hardening.sql`).
 *
 * Opsi: `--force` menerapkan perubahan yang berpotensi menghapus data (hanya untuk DB dev).
 * PGlite berbasis berkas hanya boleh dibuka satu proses — hentikan `pnpm dev` dulu.
 */
import { pushSchema } from "drizzle-kit/api";

import { closeDb, getDb, getDbDriver } from "@/db/client";
import { applyDbHardening } from "@/db/hardening";
import * as schema from "@/db/schema";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const db = getDb();
  const driver = getDbDriver();
  console.log(`db:push → driver ${driver}${driver === "pglite" ? ` (${process.env.PGLITE_DATA_DIR || "./.data/pglite"})` : ""}`);

  const result = await pushSchema(schema as unknown as Record<string, unknown>, db as unknown as Parameters<typeof pushSchema>[1]);
  for (const warning of result.warnings) console.warn(`Peringatan: ${warning}`);
  if (result.hasDataLoss && !force) {
    console.error("Perubahan skema berpotensi menghapus data. Tinjau peringatan di atas; jalankan ulang dengan --force (hanya DB dev).");
    process.exitCode = 1;
    return;
  }
  if (result.statementsToExecute.length === 0) {
    console.log("Skema sudah mutakhir.");
  } else {
    console.log(`Menerapkan ${result.statementsToExecute.length} perubahan skema…`);
    await result.apply();
  }
  await applyDbHardening(db);
  console.log("Trigger pengerasan (tanpa DELETE, audit append-only) diterapkan.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
