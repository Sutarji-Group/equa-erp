/**
 * Pengerasan basis data (NFR-11, Bab 6.1): trigger penolak DELETE/TRUNCATE pada seluruh tabel bisnis dan penolak
 * UPDATE/DELETE pada tabel append-only. Sumber kebenaran: `src/db/sql/hardening.sql` (idempoten).
 *
 * Dipakai oleh: `pnpm db:push`, `pnpm db:migrate`, dan harness uji (`tests/helpers/db.ts`). Bukan untuk kode aplikasi
 * (membaca berkas dari disk). Tabel baru otomatis tercakup saat `applyDbHardening()` dijalankan ulang.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import type { Db, DbOrTx, DbTransaction } from "./client";

/** Jalur berkas SQL relatif terhadap akar proyek. */
export const HARDENING_SQL_RELATIVE_PATH = "src/db/sql/hardening.sql";

/** Tabel teknis sementara yang BOLEH dihapus barisnya (dikecualikan dari trigger penolak DELETE). */
export const DELETABLE_TECHNICAL_TABLES = [
  "sessions",
  "customer_sessions",
  "otp_codes",
  "push_subscriptions",
  "job_runs",
] as const;

/** Tabel append-only: UPDATE & DELETE ditolak (NFR-11). */
export const APPEND_ONLY_TABLES = ["audit_logs", "access_logs", "domain_events"] as const;

/**
 * Tabel yang boleh dihapus job retensi (US-M10-06 KP-3) bila transaksi menjalankan
 * `SET LOCAL equa.retention_purge = 'on'` (lihat `withRetentionPurge`).
 */
export const RETENTION_PURGE_TABLES = ["access_logs", "gps_positions"] as const;

/** SQLSTATE pelanggaran: penghapusan ditolak. */
export const SQLSTATE_NO_DELETE = "EQ001";
/** SQLSTATE pelanggaran: catatan append-only diubah/dihapus. */
export const SQLSTATE_APPEND_ONLY = "EQ002";

/** Baca isi `hardening.sql`. `rootDir` bawaan = direktori kerja proses (akar proyek untuk skrip & uji). */
export function readHardeningSql(rootDir: string = process.cwd()): string {
  return readFileSync(path.join(rootDir, HARDENING_SQL_RELATIVE_PATH), "utf8");
}

/** Pecah skrip SQL pada penanda `--> statement-breakpoint` (konvensi drizzle-kit). */
export function splitSqlStatements(script: string): string[] {
  return script
    .split(/^-->\s*statement-breakpoint\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

/** Terapkan trigger pengerasan ke basis data (idempoten). */
export async function applyDbHardening(db: DbOrTx, options: { rootDir?: string } = {}): Promise<void> {
  for (const statement of splitSqlStatements(readHardeningSql(options.rootDir))) {
    await db.execute(sql.raw(statement));
  }
}

/**
 * Jalankan `fn` di dalam transaksi yang mengizinkan penghapusan retensi pada `RETENTION_PURGE_TABLES`
 * (akses log > PAR-29, posisi GPS mentah > PAR-52). Tabel lain tetap menolak DELETE.
 */
export async function withRetentionPurge<T>(db: Db, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('equa.retention_purge', 'on', true)`);
    return fn(tx);
  });
}

/** Benar bila galat berasal dari trigger pengerasan (untuk dipetakan ke DomainError oleh lapisan layanan). */
export function isHardeningViolation(error: unknown): boolean {
  const code = extractSqlState(error);
  return code === SQLSTATE_NO_DELETE || code === SQLSTATE_APPEND_ONLY;
}

function extractSqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
