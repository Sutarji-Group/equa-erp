import { entityKind, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb, isTransaction, withSavepoint, withTx } from "@/server/core/db";

import { useTestDb } from "../helpers/db";

/**
 * Integrasi ronde M3+M7: di runtime Next tiap rute membawa salinan drizzle-orm sendiri, sedangkan handle db di
 * `globalThis` dibuat oleh rute pertama. Transaksi `/api/sync/push` (aksi sopir offline) lalu bukan `instanceof`
 * kelas `PgTransaction` milik bundel lain → handler event terisolasi salah membuka transaksi baru (deadlock PGlite).
 */
describe("db.ts isTransaction — lintas salinan drizzle (NFR-06 sinkron lapangan, US-M3-02)", () => {
  useTestDb();

  it("NFR-06 transaksi asli dikenali; instans db bukan transaksi", async () => {
    expect(isTransaction(getDb())).toBe(false);
    expect(isTransaction(undefined)).toBe(false);
    await withTx(async (tx) => {
      expect(isTransaction(tx)).toBe(true);
    });
  });

  it("NFR-06 transaksi dari salinan kelas drizzle lain (entityKind sama) tetap dikenali sebagai transaksi", () => {
    class ForeignPgDatabase {
      static readonly [entityKind]: string = "PgDatabase";
    }
    class ForeignPgTransaction extends ForeignPgDatabase {
      static override readonly [entityKind]: string = "PgTransaction";
    }
    class ForeignPgliteTransaction extends ForeignPgTransaction {
      static override readonly [entityKind]: string = "PgliteTransaction";
    }
    expect(isTransaction(new ForeignPgliteTransaction() as never)).toBe(true);
    expect(isTransaction(new ForeignPgDatabase() as never)).toBe(false);
  });

  it("NFR-06 withSavepoint di dalam transaksi memakai savepoint (rollback savepoint tidak membatalkan induk)", async () => {
    const result = await withTx(async (tx) => {
      await tx.execute(sql`create temp table sp_probe (v int) on commit drop`);
      await tx.execute(sql`insert into sp_probe values (1)`);
      await expect(
        withSavepoint(tx, async (sp) => {
          await sp.execute(sql`insert into sp_probe values (2)`);
          throw new Error("gagal di savepoint");
        }),
      ).rejects.toThrow("gagal di savepoint");
      const rows = await tx.execute<{ v: number }>(sql`select v from sp_probe order by v`);
      return rows.rows.map((r) => Number(r.v));
    });
    expect(result).toEqual([1]);
  });
});
