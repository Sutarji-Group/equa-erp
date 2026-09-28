/**
 * Klien basis data EQUA.
 *
 * `getDb()` mengembalikan instans Drizzle tunggal (singleton per proses) yang dipilih lewat env `DB_DRIVER`:
 * - `pglite` (bawaan dev): Postgres WASM tanpa server, data di `PGLITE_DATA_DIR` (bawaan `./.data/pglite`).
 *   Satu direktori hanya boleh dibuka SATU proses — hentikan `pnpm dev` sebelum `pnpm db:push`/`db:seed`.
 * - `neon` (produksi Vercel): `DATABASE_URL` + `@neondatabase/serverless` Pool (WebSocket; `ws` untuk Node).
 * - `pg`: node-postgres ke Postgres biasa (`DATABASE_URL`).
 *
 * Uji: buat PGlite in-memory lewat `createPgliteDb()` lalu suntik dengan `setDbForTests(db)`.
 *
 * Catatan: berkas ini sengaja TIDAK mengimpor 'server-only' karena dipakai juga oleh skrip `tsx` (db:push/db:seed).
 * Jangan impor dari komponen klien.
 */
import { PGlite } from "@electric-sql/pglite";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import type { Assume, ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import pg from "pg";
import ws from "ws";

import * as schema from "./schema";

export type Schema = typeof schema;
export type DbDriver = "pglite" | "neon" | "pg";

/**
 * Bentuk hasil kueri mentah (`db.execute(sql…)`) yang sama di ketiga driver: `{ rows }`.
 * (PGlite `Results`, node-postgres & Neon `QueryResult` sama-sama memiliki `rows`.)
 */
export type DbRawResult<TRow> = { rows: TRow[] };
export interface DbQueryResultHKT extends PgQueryResultHKT {
  type: DbRawResult<Assume<this["row"], Record<string, unknown>>>;
}

/** Tipe basis data yang kompatibel untuk ketiga driver (PGlite, Neon, node-postgres). */
export type Db = PgDatabase<DbQueryResultHKT, Schema>;

/** Tipe transaksi Drizzle (argumen callback `db.transaction(async (tx) => …)`). */
export type DbTransaction = PgTransaction<DbQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** Basis data atau transaksi — dipakai fungsi yang boleh berjalan di dalam/luar transaksi. */
export type DbOrTx = Db | DbTransaction;

type DbHandle = {
  db: Db;
  driver: DbDriver | "injected";
  close: () => Promise<void>;
};

const globalForDb = globalThis as typeof globalThis & { __equaDb?: DbHandle };

function resolveDriver(value: string | undefined): DbDriver {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "pglite") return "pglite";
  if (v === "neon" || v === "pg") return v;
  throw new Error(`DB_DRIVER tidak dikenal: "${value}". Gunakan salah satu dari: pglite, neon, pg.`);
}

function requireDatabaseUrl(driver: DbDriver): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(`DATABASE_URL wajib diisi bila DB_DRIVER=${driver}. Lihat .env.example.`);
  }
  return url;
}

function createHandle(driver: DbDriver): DbHandle {
  switch (driver) {
    case "pglite": {
      const dataDir = process.env.PGLITE_DATA_DIR?.trim() || "./.data/pglite";
      if (!dataDir.startsWith("memory://")) mkdirSync(dataDir, { recursive: true });
      const client = new PGlite(dataDir);
      const db = drizzlePglite({ client, schema });
      return { db, driver, close: () => client.close() };
    }
    case "neon": {
      // Node < 22 tidak punya WebSocket global; `ws` selalu dipakai agar perilaku seragam di Vercel Functions.
      neonConfig.webSocketConstructor = ws;
      const pool = new NeonPool({ connectionString: requireDatabaseUrl(driver) });
      const db = drizzleNeon({ client: pool, schema });
      return { db, driver, close: () => pool.end() };
    }
    case "pg": {
      const pool = new pg.Pool({ connectionString: requireDatabaseUrl(driver) });
      const db = drizzleNodePg({ client: pool, schema });
      return { db, driver, close: () => pool.end() };
    }
  }
}

/**
 * Penanda "sedang di dalam transaksi terkelola" (`withTx` di src/server/core/db.ts). Di dev/uji, `getDb()` di dalamnya
 * adalah bug: PGlite hanya SATU koneksi, jadi kueri lewat `getDb()` menunggu transaksi itu sendiri (deadlock, uji
 * menggantung sampai timeout). Penjaga ini mengubahnya menjadi galat yang jelas.
 */
const txScope = new AsyncLocalStorage<{ label: string }>();

/** Jalankan `fn` sebagai lingkup transaksi terkelola (dipanggil `withTx`). */
export function runInTransactionScope<T>(fn: () => T): T {
  return txScope.run({ label: "withTx" }, fn);
}

/** Jalankan `fn` DI LUAR lingkup transaksi (mis. callback setelah commit yang dimulai dari dalam transaksi). */
export function runOutsideTransactionScope<T>(fn: () => T): T {
  return txScope.exit(fn);
}

/** Benar bila kode berjalan di dalam `withTx` (lingkup async yang sama). */
export function inTransactionScope(): boolean {
  return txScope.getStore() !== undefined;
}

function guardEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Instans Drizzle tunggal untuk proses ini. */
export function getDb(): Db {
  if (guardEnabled() && txScope.getStore()) {
    throw new Error(
      "getDb() dipanggil di dalam transaksi — teruskan `tx` (opts.tx) ke fungsi core. Di PGlite (satu koneksi) ini deadlock.",
    );
  }
  if (!globalForDb.__equaDb) {
    globalForDb.__equaDb = createHandle(resolveDriver(process.env.DB_DRIVER));
  }
  return globalForDb.__equaDb.db;
}

/** Driver yang sedang aktif (`injected` bila disuntik lewat `setDbForTests`). */
export function getDbDriver(): DbDriver | "injected" {
  getDb();
  return globalForDb.__equaDb!.driver;
}

/**
 * Suntik instans basis data (khusus uji). `null` mengosongkan singleton sehingga `getDb()` berikutnya
 * membuat koneksi baru dari env. Tidak menutup koneksi lama — tutup sendiri bila perlu.
 */
export function setDbForTests(db: Db | null): void {
  globalForDb.__equaDb = db ? { db, driver: "injected", close: async () => {} } : undefined;
}

/** Tutup koneksi singleton (untuk skrip CLI). */
export async function closeDb(): Promise<void> {
  const handle = globalForDb.__equaDb;
  globalForDb.__equaDb = undefined;
  if (handle) await handle.close();
}

/**
 * Buat instans PGlite + Drizzle baru dengan skema lengkap terpasang di tipe.
 * Tanpa `dataDir` = in-memory (untuk uji). Skema tabel BELUM didorong — lihat helper uji F2 (`tests/helpers/db.ts`).
 */
export function createPgliteDb(dataDir?: string): { db: Db; client: PGlite } {
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzlePglite({ client, schema });
  return { db, client };
}

export { schema };
