/**
 * Jalur `pnpm db:push` (DB dev/uji): perbaikan pra-push (`src/db/sql/pre-push.sql`) → drizzle-kit `pushSchema` →
 * pengerasan (`hardening.sql`). Usulan DROP drizzle-kit untuk objek yang dikelola hardening.sql
 * (`HARDENING_MANAGED_CONSTRAINTS`) diabaikan agar push idempoten.
 *
 * KHUSUS dev/uji — memakai `drizzle-kit/api` (devDependency). Produksi memakai `pnpm db:migrate` (`./migrations.ts`).
 * Dipakai `scripts/db-push.ts` dan uji `tests/db/migrations.test.ts` (pembanding migrasi vs push).
 */
import { sql } from "drizzle-orm";

import type { Db } from "./client";
import { applyDbHardening, applyPrePushFixups, isHardeningManagedDrop } from "./hardening";
import * as schema from "./schema";

export type PushPlan = {
  /** Pernyataan yang akan/telah dijalankan (sudah tanpa DROP objek pengerasan). */
  statements: string[];
  /** Jumlah usulan DROP objek pengerasan yang diabaikan. */
  ignored: number;
  warnings: string[];
  hasDataLoss: boolean;
};

/** Rencana push drizzle-kit terhadap DB (tanpa menerapkan). */
export async function planPush(db: Db): Promise<PushPlan> {
  const { pushSchema } = await import("drizzle-kit/api");
  const result = await pushSchema(schema as unknown as Record<string, unknown>, db as unknown as Parameters<typeof pushSchema>[1]);
  const statements = result.statementsToExecute.filter((s) => !isHardeningManagedDrop(s));
  return {
    statements,
    ignored: result.statementsToExecute.length - statements.length,
    warnings: result.warnings,
    hasDataLoss: result.hasDataLoss,
  };
}

export type PushResult = PushPlan & { applied: boolean };

/**
 * Urutan `pnpm db:push`: pre-push → push → pengerasan. Bila perubahan berpotensi menghapus data dan `force` tidak
 * diberikan, tidak ada yang diterapkan (`applied: false`).
 */
export async function pushDatabase(db: Db, options: { force?: boolean; rootDir?: string } = {}): Promise<PushResult> {
  await applyPrePushFixups(db, options);
  const plan = await planPush(db);
  if (plan.hasDataLoss && !options.force) return { ...plan, applied: false };
  for (const statement of plan.statements) await db.execute(sql.raw(statement));
  await applyDbHardening(db, options);
  return { ...plan, applied: true };
}
