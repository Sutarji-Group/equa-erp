/**
 * DB & transaksi untuk lapisan layanan (docs/ARCHITECTURE.md §3, §5).
 *
 * - `getDb()` — instans Drizzle tunggal (PGlite dev/test, Neon/pg produksi) dari `src/db/client`.
 * - `withTx(fn)` — jalankan `fn` dalam SATU transaksi; setelah COMMIT berhasil, callback `onAfterCommit(tx, …)`
 *   dijalankan (mis. kirim web push) — tidak dijalankan bila rollback.
 * - `runInTx(tx | undefined, fn)` — pakai transaksi pemanggil bila ada, bila tidak buka transaksi baru. Pola untuk
 *   fungsi layanan yang boleh dipanggil dari dalam transaksi modul lain (`opts?.tx`).
 * - Tipe `Tx` = transaksi ATAU db (fungsi yang hanya membaca/menulis tanpa peduli batas transaksi).
 *
 * PENTING (PGlite = satu koneksi): di dalam transaksi JANGAN memakai `getDb()` — selalu teruskan `tx`. Memakai
 * `getDb()` saat transaksi terbuka membuat kueri menunggu transaksi itu sendiri (deadlock) di dev/uji.
 *
 * Uji: `useTestDb()`/`createTestDb()` dari `tests/helpers/db.ts` menyuntik PGlite in-memory lewat `setDbForTests`.
 */
import "server-only";

import { PgTransaction } from "drizzle-orm/pg-core";

import { getDb, setDbForTests, type Db, type DbOrTx, type DbTransaction } from "@/db/client";

export { getDb, setDbForTests };
export type { Db, DbTransaction };

/** Transaksi atau basis data. */
export type Tx = DbOrTx;

/** Benar bila `tx` adalah transaksi terbuka (bukan instans db). */
export function isTransaction(tx: Tx | undefined): tx is DbTransaction {
  return tx instanceof PgTransaction;
}

type AfterCommitFn = () => unknown;

const afterCommitHooks = new WeakMap<object, AfterCommitFn[]>();

/**
 * Daftarkan callback yang dijalankan SETELAH transaksi terluar (dibuka lewat `withTx`/`runInTx`) berhasil COMMIT.
 * Bila `tx` bukan transaksi yang dikelola core (mis. dibuka modul dengan `db.transaction` langsung, atau savepoint
 * `tx.transaction(…)`) atau `tx` adalah db tanpa transaksi, callback dijalankan pada microtask berikutnya (best
 * effort, tanpa jaminan terhadap commit — job cadangan menangani sisanya, mis. `core.notifications.push_pending`).
 * Galat callback hanya dicatat ke log, tidak memengaruhi hasil transaksi.
 */
export function onAfterCommit(tx: Tx, fn: AfterCommitFn): void {
  const hooks = afterCommitHooks.get(tx);
  if (hooks) {
    hooks.push(fn);
    return;
  }
  // Bukan transaksi terkelola: jalankan terpisah (tidak menunggu), tanpa jaminan urutan terhadap commit.
  queueMicrotask(() => {
    void runHook(fn);
  });
}

async function runHook(fn: AfterCommitFn): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error("[equa] callback setelah commit gagal:", error);
  }
}

/** Jalankan `fn` dalam satu transaksi baru. `opts.db` untuk memakai instans lain (uji). */
export async function withTx<T>(fn: (tx: DbTransaction) => Promise<T>, opts: { db?: Db } = {}): Promise<T> {
  const db = opts.db ?? getDb();
  let hooks: AfterCommitFn[] = [];
  const result = await db.transaction(async (tx) => {
    hooks = [];
    afterCommitHooks.set(tx, hooks);
    try {
      return await fn(tx);
    } finally {
      afterCommitHooks.delete(tx);
    }
  });
  for (const hook of hooks) await runHook(hook);
  return result;
}

/**
 * Pakai transaksi `tx` bila diberikan (tanpa savepoint), bila tidak buka transaksi baru lewat `withTx`.
 * Contoh: `export async function submit(ctx, input, opts: { tx?: Tx } = {}) { return runInTx(opts.tx, async (tx) => …) }`.
 */
export async function runInTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (tx) return fn(tx);
  return withTx(fn);
}
