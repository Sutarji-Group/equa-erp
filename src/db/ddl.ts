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
