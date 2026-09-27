import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createPgliteDb, getDb, getDbDriver, setDbForTests } from "@/db/client";

describe("db/client — getDb & setDbForTests", () => {
  const { db, client } = createPgliteDb();

  afterAll(async () => {
    setDbForTests(null);
    await client.close();
  });

  it("setDbForTests menyuntik PGlite in-memory ke getDb()", async () => {
    setDbForTests(db);
    expect(getDb()).toBe(db);
    expect(getDbDriver()).toBe("injected");
    const result = await getDb().execute(sql`select 1 + 1 as two`);
    expect(result.rows[0]).toEqual({ two: 2 });
  });

  it("transaksi PGlite berjalan dan dapat dibatalkan", async () => {
    await db.execute(sql`create table if not exists t_probe (id int primary key)`);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into t_probe values (1)`);
        throw new Error("batal");
      }),
    ).rejects.toThrow("batal");
    const res = await db.execute(sql`select count(*)::int as n from t_probe`);
    expect(res.rows[0]).toEqual({ n: 0 });
  });
});
