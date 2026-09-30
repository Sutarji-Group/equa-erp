/**
 * `pnpm db:migrate` — terapkan migrasi SQL `drizzle/` (baseline `0000_baseline_v1` + migrasi berikutnya hasil
 * `pnpm db:generate`) ke DB terkonfigurasi (produksi Neon: DB_DRIVER=neon + DATABASE_URL), lalu pengerasan
 * (`src/db/sql/hardening.sql`). Keduanya idempoten — menjalankan ulang tidak mengubah apa pun.
 *
 * Urutan produksi dari DB kosong (docs/deploy/README.md): `db:migrate` → `db:verify` → `db:seed:prod`.
 * `src/db/sql/pre-push.sql` hanya untuk DB dev lama (`pnpm db:push`), tidak dipakai di sini.
 */
import { closeDb, getDb, getDbDriver } from "@/db/client";
import { MIGRATIONS_FOLDER, migrateDatabase, readMigrationJournal } from "@/db/migrations";

async function main(): Promise<void> {
  const db = getDb();
  const driver = getDbDriver();
  const journal = readMigrationJournal();
  console.log(`db:migrate → driver ${driver}, folder ${MIGRATIONS_FOLDER}/ (${journal.length} migrasi: ${journal.map((j) => j.tag).join(", ")})`);
  const result = await migrateDatabase(db, driver);
  console.log(
    result.newlyApplied === 0
      ? `Skema sudah mutakhir (${result.appliedAfter} migrasi tercatat, 0 baru).`
      : `${result.newlyApplied} migrasi baru diterapkan (total ${result.appliedAfter}).`,
  );
  console.log("Pengerasan diterapkan (tanpa DELETE, append-only, kolom imutabel, penjaga jurnal, FK komposit tenant).");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
