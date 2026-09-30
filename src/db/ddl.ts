/**
 * Pembangkit DDL dari skema Drizzle (KHUSUS dev/uji — memakai `drizzle-kit/api`, devDependency). Jangan impor dari
 * kode aplikasi. Produksi memakai `pnpm db:generate` (migrasi SQL di `drizzle/`) atau `pnpm db:push`.
 */
import * as schema from "./schema";

/** Pernyataan DDL lengkap (enum, tabel, FK, indeks) untuk membuat skema dari nol. */
export async function generateSchemaDdl(): Promise<string[]> {
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const empty = generateDrizzleJson({});
  const current = generateDrizzleJson(schema as unknown as Record<string, unknown>);
  return generateMigration(empty, current);
}

/**
 * Tambahan S5-C (migrasi produksi): pernyataan DDL yang BELUM tercakup migrasi `drizzle/` — selisih potret skema
 * migrasi terakhir (`drizzle/meta/NNNN_snapshot.json`) terhadap skema Drizzle saat ini. Kosong = migrasi mutakhir.
 * Tidak kosong → jalankan `pnpm db:generate --name <perubahan>` dan commit berkas `drizzle/` yang baru.
 */
export async function pendingMigrationStatements(rootDir: string = process.cwd()): Promise<string[]> {
  const { readLatestMigrationSnapshot } = await import("./migrations");
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const latest = readLatestMigrationSnapshot(rootDir);
  const current = generateDrizzleJson(schema as unknown as Record<string, unknown>);
  const base = (latest ?? generateDrizzleJson({})) as unknown as Parameters<typeof generateMigration>[0];
  return generateMigration(base, current);
}
