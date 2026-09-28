/**
 * `pnpm db:push` — dorong skema Drizzle ke DB terkonfigurasi (bawaan PGlite `.data/pglite`; atau DB_DRIVER=neon/pg +
 * DATABASE_URL) lalu terapkan pengerasan (`src/db/sql/hardening.sql`: tanpa DELETE, append-only, kolom imutabel,
 * penjaga jurnal, FK komposit tenant).
 *
 * Idempoten: push ulang = 0 perubahan. Objek yang dikelola hardening.sql di luar skema Drizzle (FK komposit tenant &
 * indeks unik tujuannya, `HARDENING_MANAGED_CONSTRAINTS`) tidak dikenal drizzle-kit sehingga usulan DROP untuk objek itu
 * diabaikan di sini.
 *
 * Opsi: `--force` menerapkan perubahan yang berpotensi menghapus data (hanya untuk DB dev).
 * PGlite berbasis berkas hanya boleh dibuka satu proses — hentikan `pnpm dev` dulu.
 */
import { sql } from "drizzle-orm";
import { pushSchema } from "drizzle-kit/api";

import { closeDb, getDb, getDbDriver } from "@/db/client";
import { applyDbHardening, applyPrePushFixups, isHardeningManagedDrop } from "@/db/hardening";
import * as schema from "@/db/schema";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const db = getDb();
  const driver = getDbDriver();
  console.log(`db:push → driver ${driver}${driver === "pglite" ? ` (${process.env.PGLITE_DATA_DIR || "./.data/pglite"})` : ""}`);

  // DB dev yang sudah berisi data: siapkan kolom NOT NULL baru (src/db/sql/pre-push.sql) agar push tidak mengusulkan TRUNCATE.
  await applyPrePushFixups(db);
  const result = await pushSchema(schema as unknown as Record<string, unknown>, db as unknown as Parameters<typeof pushSchema>[1]);
  const statements = result.statementsToExecute.filter((s) => !isHardeningManagedDrop(s));
  const ignored = result.statementsToExecute.length - statements.length;
  for (const warning of result.warnings) console.warn(`Peringatan: ${warning}`);
  if (result.hasDataLoss && !force) {
    console.error("Perubahan skema berpotensi menghapus data. Tinjau peringatan di atas; jalankan ulang dengan --force (hanya DB dev).");
    process.exitCode = 1;
    return;
  }
  if (statements.length === 0) {
    console.log("Skema sudah mutakhir (0 perubahan).");
  } else {
    console.log(`Menerapkan ${statements.length} perubahan skema…`);
    for (const statement of statements) await db.execute(sql.raw(statement));
  }
  if (ignored > 0) console.log(`(${ignored} usulan DROP untuk objek pengerasan diabaikan.)`);
  await applyDbHardening(db);
  console.log("Pengerasan diterapkan (tanpa DELETE, append-only, kolom imutabel, penjaga jurnal, FK komposit tenant).");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
