/**
 * DB & transaksi untuk lapisan layanan (docs/ARCHITECTURE.md §3, §5).
 *
 * - `getDb()` — instans Drizzle tunggal (PGlite dev/test, Neon/pg produksi) dari `src/db/client`.
 * - `withTx(fn)` — jalankan `fn` dalam SATU transaksi; setelah COMMIT berhasil, callback `onAfterCommit(tx, …)`
 *   dijalankan (mis. kirim web push) — tidak dijalankan bila rollback.
 * - `runInTx(tx | undefined, fn)` — pakai transaksi pemanggil bila ada, bila tidak buka transaksi baru. Pola untuk
 *   fungsi layanan yang boleh dipanggil dari dalam transaksi modul lain (`opts?.tx`).
 * - `withSavepoint(tx, fn)` — savepoint terkelola (isolasi handler event lintas modul); `onBeforeCommit(tx, fn)`;
 *   `txQueue(tx, key)` — antrean per transaksi (dipakai audit tertunda).
 * - Tipe `Tx` = transaksi ATAU db (fungsi yang hanya membaca/menulis tanpa peduli batas transaksi).
 *
 * PENTING (PGlite = satu koneksi): di dalam transaksi JANGAN memakai `getDb()` — selalu teruskan `tx`. Memakai
 * `getDb()` saat transaksi terbuka membuat kueri menunggu transaksi itu sendiri (deadlock) di dev/uji.
 *
 * Uji: `useTestDb()`/`createTestDb()` dari `tests/helpers/db.ts` menyuntik PGlite in-memory lewat `setDbForTests`.
 */
import "server-only";

import { PgTransaction } from "drizzle-orm/pg-core";

import { getDb, runInTransactionScope, runOutsideTransactionScope, setDbForTests, type Db, type DbOrTx, type DbTransaction } from "@/db/client";

export { getDb, setDbForTests };
export type { Db, DbTransaction };

/** Transaksi atau basis data. */
export type Tx = DbOrTx;

/** Benar bila `tx` adalah transaksi terbuka (bukan instans db). */
export function isTransaction(tx: Tx | undefined): tx is DbTransaction {
  return tx instanceof PgTransaction;
}

type AfterCommitFn = () => unknown;
type BeforeCommitFn = (tx: DbTransaction) => Promise<unknown> | unknown;

/**
 * Status per transaksi TERKELOLA (dibuka `withTx`/`runInTx`; savepoint `withSavepoint` berbagi status induknya):
 * callback setelah/sebelum commit dan antrean lokal per kunci (mis. baris audit tertunda). Savepoint yang rollback
 * memotong kembali semua daftar ke panjang sebelum savepoint dibuka.
 */
type TxState = {
  afterCommit: AfterCommitFn[];
  beforeCommit: BeforeCommitFn[];
  queues: Map<symbol, unknown[]>;
};

const txStates = new WeakMap<object, TxState>();

/** Benar bila `tx` adalah transaksi (atau savepoint) yang dikelola core. */
export function isManagedTransaction(tx: Tx | undefined): boolean {
  return !!tx && txStates.has(tx);
}

/**
 * Daftarkan callback yang dijalankan SETELAH transaksi terluar (dibuka lewat `withTx`/`runInTx`) berhasil COMMIT.
 * Bila `tx` bukan transaksi yang dikelola core (mis. dibuka modul dengan `db.transaction` langsung) atau `tx` adalah
 * db tanpa transaksi, callback dijalankan pada microtask berikutnya (best effort, tanpa jaminan terhadap commit — job
 * cadangan menangani sisanya, mis. `core.notifications.push_pending`). Galat callback hanya dicatat ke log, tidak
 * memengaruhi hasil transaksi. Savepoint `withSavepoint` yang rollback membatalkan callback yang didaftarkan di dalamnya.
 */
export function onAfterCommit(tx: Tx, fn: AfterCommitFn): void {
  const state = txStates.get(tx);
  if (state) {
    state.afterCommit.push(fn);
    return;
  }
  // Bukan transaksi terkelola: jalankan terpisah (tidak menunggu), tanpa jaminan urutan terhadap commit.
  queueMicrotask(() => {
    void runOutsideTransactionScope(() => runHook(fn));
  });
}

/**
 * Daftarkan callback yang dijalankan TEPAT SEBELUM COMMIT transaksi terkelola terluar (masih di dalam transaksi;
 * galat → rollback). Mengembalikan false bila `tx` tidak dikelola core (pemanggil harus menangani sendiri).
 * Dipakai jejak audit: baris ditulis berantai di akhir transaksi sehingga kunci rantai diambil terakhir & singkat.
 */
export function onBeforeCommit(tx: Tx, fn: BeforeCommitFn): boolean {
  const state = txStates.get(tx);
  if (!state) return false;
  state.beforeCommit.push(fn);
  return true;
}

/** Antrean per transaksi terkelola untuk `key` (null bila `tx` tidak dikelola). Ikut dipotong saat savepoint rollback. */
export function txQueue<T>(tx: Tx, key: symbol): T[] | null {
  const state = txStates.get(tx);
  if (!state) return null;
  let queue = state.queues.get(key) as T[] | undefined;
  if (!queue) {
    queue = [];
    state.queues.set(key, queue);
  }
  return queue;
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
  let state: TxState = { afterCommit: [], beforeCommit: [], queues: new Map() };
  const result = await db.transaction(async (tx) => {
    state = { afterCommit: [], beforeCommit: [], queues: new Map() };
    txStates.set(tx, state);
    try {
      // Lingkup transaksi (dev/uji): `getDb()` di dalamnya melempar galat jelas, bukan deadlock PGlite.
      return await runInTransactionScope(async () => {
        const value = await fn(tx);
        // Callback sebelum commit boleh mendaftarkan callback baru (diproses berurutan sampai habis).
        for (let i = 0; i < state.beforeCommit.length; i++) await state.beforeCommit[i]!(tx);
        return value;
      });
    } finally {
      txStates.delete(tx);
    }
  });
  await runOutsideTransactionScope(async () => {
    for (const hook of state.afterCommit) await runHook(hook);
  });
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

/**
 * Jalankan `fn` dalam SAVEPOINT di dalam transaksi `tx` (mis. handler event modul lain, R04): galat di dalamnya hanya
 * membatalkan perubahan savepoint (termasuk baris audit tertunda & callback yang didaftarkan di dalamnya), transaksi
 * induk tetap berjalan. Galat diteruskan ke pemanggil (yang memutuskan menelan/mencatatnya).
 */
export async function withSavepoint<T>(tx: Tx, fn: (sp: DbTransaction) => Promise<T>): Promise<T> {
  if (!isTransaction(tx)) return withTx(fn);
  const parent = txStates.get(tx);
  const snapshot = parent
    ? {
        after: parent.afterCommit.length,
        before: parent.beforeCommit.length,
        queues: new Map([...parent.queues.entries()].map(([k, q]) => [k, q.length])),
      }
    : null;
  try {
    return await tx.transaction(async (sp) => {
      if (parent) txStates.set(sp, parent);
      try {
        return await fn(sp);
      } finally {
        txStates.delete(sp);
      }
    });
  } catch (error) {
    if (parent && snapshot) {
      parent.afterCommit.length = snapshot.after;
      parent.beforeCommit.length = snapshot.before;
      for (const [key, queue] of parent.queues) queue.length = snapshot.queues.get(key) ?? 0;
    }
    throw error;
  }
}
