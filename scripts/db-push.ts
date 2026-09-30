/**
 * `pnpm db:push` — dorong skema Drizzle ke DB terkonfigurasi (bawaan PGlite `.data/pglite`; atau DB_DRIVER=neon/pg +
 * DATABASE_URL) lalu terapkan pengerasan (`src/db/sql/hardening.sql`: tanpa DELETE, append-only, kolom imutabel,
 * penjaga jurnal, FK komposit tenant). Logika: `src/db/push.ts` (`pushDatabase`).
 *
 * Idempoten: push ulang = 0 perubahan. Objek yang dikelola hardening.sql di luar skema Drizzle (FK komposit tenant &
 * indeks unik tujuannya, `HARDENING_MANAGED_CONSTRAINTS`) tidak dikenal drizzle-kit sehingga usulan DROP untuk objek itu
 * diabaikan.
 *
 * KHUSUS DB dev/uji. Produksi memakai migrasi: `pnpm db:migrate` (docs/deploy/README.md).
 * Opsi: `--force` menerapkan perubahan yang berpotensi menghapus data (hanya untuk DB dev).
 * PGlite berbasis berkas hanya boleh dibuka satu proses — hentikan `pnpm dev` dulu.
 */
import { closeDb, getDb, getDbDriver } from "@/db/client";
import { pushDatabase } from "@/db/push";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const db = getDb();
  const driver = getDbDriver();
  console.log(`db:push → driver ${driver}${driver === "pglite" ? ` (${process.env.PGLITE_DATA_DIR || "./.data/pglite"})` : ""}`);

  // DB dev yang sudah berisi data: pre-push.sql menyiapkan kolom NOT NULL baru agar push tidak mengusulkan TRUNCATE.
  const result = await pushDatabase(db, { force });
  for (const warning of result.warnings) console.warn(`Peringatan: ${warning}`);
  if (!result.applied) {
    console.error("Perubahan skema berpotensi menghapus data. Tinjau peringatan di atas; jalankan ulang dengan --force (hanya DB dev).");
    process.exitCode = 1;
    return;
  }
  console.log(result.statements.length === 0 ? "Skema sudah mutakhir (0 perubahan)." : `${result.statements.length} perubahan skema diterapkan.`);
  if (result.ignored > 0) console.log(`(${result.ignored} usulan DROP untuk objek pengerasan diabaikan.)`);
  console.log("Pengerasan diterapkan (tanpa DELETE, append-only, kolom imutabel, penjaga jurnal, FK komposit tenant).");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
