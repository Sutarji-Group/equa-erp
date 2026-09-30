/**
 * `pnpm db:verify` — verifikasi skema DB terkonfigurasi (mis. Neon produksi sesudah `pnpm db:migrate`): katalog
 * (enum, kolom, constraint, indeks, trigger pengerasan, fungsi) dibandingkan dengan PGlite in-memory SEGAR yang
 * dibangun dengan urutan yang sama (migrasi `drizzle/` + hardening.sql). Hanya MEMBACA DB sasaran.
 *
 * Keluar 0 = identik & semua migrasi tercatat; 1 = ada perbedaan (dicetak) atau migrasi belum lengkap.
 * Catatan: versi Postgres berbeda (Neon vs PGlite) dapat mencetak definisi sedikit berbeda — tinjau perbedaan yang
 * dilaporkan; perbedaan kolom/indeks/trigger yang hilang selalu berarti migrasi/hardening belum dijalankan.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { closeDb, getDb, getDbDriver, schema, type Db } from "@/db/client";
import { describeSchema, diffSchemas, formatSchemaDifferences, schemaObjectCounts } from "@/db/introspect";
import { appliedMigrationCount, migrateDatabase, readMigrationJournal } from "@/db/migrations";

async function main(): Promise<void> {
  const target = getDb();
  console.log(`db:verify → driver ${getDbDriver()}`);

  const reference = new PGlite();
  try {
    const refDb = drizzle({ client: reference, schema }) as unknown as Db;
    await migrateDatabase(refDb, "injected");
    const expected = await describeSchema(refDb);
    const actual = await describeSchema(target);
    const journal = readMigrationJournal();
    const applied = await appliedMigrationCount(target);

    console.log("Acuan (PGlite segar):", schemaObjectCounts(expected));
    console.log("DB sasaran          :", schemaObjectCounts(actual));
    let ok = true;
    if (applied !== journal.length) {
      ok = false;
      console.error(`Migrasi tercatat di DB sasaran: ${applied}; di folder drizzle/: ${journal.length}. Jalankan \`pnpm db:migrate\`.`);
    }
    const diffs = diffSchemas(expected, actual);
    if (diffs.length > 0) {
      ok = false;
      console.error(`${diffs.length} perbedaan skema:\n${formatSchemaDifferences(diffs)}`);
    }
    if (ok) console.log("Skema DB sasaran IDENTIK dengan migrasi + pengerasan.");
    else process.exitCode = 1;
  } finally {
    await reference.close();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
