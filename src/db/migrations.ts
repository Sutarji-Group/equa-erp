/**
 * Migrasi produksi (S5-C; D-12 butir 4, D-13 butir 2). Urutan resmi basis data produksi (Neon) dari KOSONG:
 *
 *   1. `pnpm db:migrate`  → migrasi SQL `drizzle/` (baseline `0000_baseline_v1.sql` + migrasi berikutnya) lalu
 *                           pengerasan `src/db/sql/hardening.sql` (trigger tanpa-hapus, append-only, kolom imutabel,
 *                           penjaga jurnal, FK komposit tenant). Keduanya idempoten.
 *   2. `pnpm db:verify`   → (disarankan) bandingkan katalog DB dengan PGlite segar hasil langkah 1 (harus identik).
 *   3. `pnpm db:seed:prod`→ parameter Lampiran B, tenant EQUA, bagan akun & pemetaan bawaan, template + akun pertama
 *                           pemilik & admin sistem (TANPA data demo) — `src/db/seed/production.ts`.
 *
 * `src/db/sql/pre-push.sql` TIDAK dipakai jalur migrasi: skrip itu hanya membereskan DB dev lama sebelum `db:push`
 * (no-op pada DB kosong/mutakhir — dibuktikan uji `tests/db/migrations.test.ts`).
 *
 * Dipakai `scripts/db-migrate.ts`, `scripts/db-verify.ts`, dan uji. Bukan untuk kode aplikasi (membaca berkas disk).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import type { Db, DbDriver } from "./client";
import { applyDbHardening } from "./hardening";

/** Folder migrasi relatif terhadap akar proyek (sama dengan `out` di `drizzle.config.ts`). */
export const MIGRATIONS_FOLDER = "drizzle";

export type MigrationJournalEntry = { idx: number; tag: string; when: number };

/** Entri jurnal migrasi (`drizzle/meta/_journal.json`). */
export function readMigrationJournal(rootDir: string = process.cwd()): MigrationJournalEntry[] {
  const file = path.join(rootDir, MIGRATIONS_FOLDER, "meta", "_journal.json");
  if (!existsSync(file)) return [];
  const journal = JSON.parse(readFileSync(file, "utf8")) as { entries?: MigrationJournalEntry[] };
  return journal.entries ?? [];
}

/** Potret skema drizzle-kit dari migrasi TERAKHIR (`drizzle/meta/NNNN_snapshot.json`) — untuk cek drift skema. */
export function readLatestMigrationSnapshot(rootDir: string = process.cwd()): Record<string, unknown> | null {
  const dir = path.join(rootDir, MIGRATIONS_FOLDER, "meta");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
    .sort();
  const last = files.at(-1);
  return last ? (JSON.parse(readFileSync(path.join(dir, last), "utf8")) as Record<string, unknown>) : null;
}

/** Jumlah migrasi yang sudah tercatat diterapkan (`drizzle.__drizzle_migrations`); 0 bila belum pernah migrasi. */
export async function appliedMigrationCount(db: Db): Promise<number> {
  const exists = await db.execute<{ ok: boolean }>(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as ok`);
  if (!exists.rows[0]?.ok) return 0;
  const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  return Number(res.rows[0]?.n ?? 0);
}

/** Terapkan migrasi SQL `drizzle/` dengan migrator Drizzle sesuai driver (idempoten: migrasi tercatat dilewati). */
export async function applyMigrations(
  db: Db,
  driver: DbDriver | "injected",
  options: { rootDir?: string } = {},
): Promise<void> {
  const migrationsFolder = path.join(options.rootDir ?? process.cwd(), MIGRATIONS_FOLDER);
  if (readMigrationJournal(options.rootDir).length === 0) {
    throw new Error(`Folder migrasi ${migrationsFolder} kosong. Jalankan \`pnpm db:generate\` lebih dulu.`);
  }
  switch (driver) {
    case "pglite":
    case "injected": {
      // DB uji/in-memory disuntik sebagai PGlite (harness uji & `pnpm db:verify`).
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
      return;
    }
    case "neon": {
      const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
      await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
      return;
    }
    case "pg": {
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
      return;
    }
  }
}

export type MigrateResult = { appliedBefore: number; appliedAfter: number; newlyApplied: number };

/** Urutan resmi `pnpm db:migrate`: migrasi SQL → pengerasan (keduanya idempoten). */
export async function migrateDatabase(
  db: Db,
  driver: DbDriver | "injected",
  options: { rootDir?: string } = {},
): Promise<MigrateResult> {
  const appliedBefore = await appliedMigrationCount(db);
  await applyMigrations(db, driver, options);
  await applyDbHardening(db, options);
  const appliedAfter = await appliedMigrationCount(db);
  return { appliedBefore, appliedAfter, newlyApplied: appliedAfter - appliedBefore };
}
