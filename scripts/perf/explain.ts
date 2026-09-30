/**
 * `pnpm perf:explain -- "<SQL>"` — EXPLAIN ANALYZE satu kueri di DB uji beban (`.data/pglite-perf`), untuk menelusuri
 * hambatan yang ditemukan `perf:measure --profil`. Hanya-baca (dibungkus transaksi yang di-ROLLBACK).
 */
import { PGlite } from "@electric-sql/pglite";

import { PERF_DATA_DIR } from "./lib/config";

async function main(): Promise<void> {
  const sqlText = process.argv.slice(2).filter((a) => a !== "--").join(" ");
  if (!sqlText) throw new Error('Pakai: pnpm perf:explain -- "select …"');
  const client = new PGlite(PERF_DATA_DIR);
  try {
    await client.exec("begin");
    const res = await client.query<{ "QUERY PLAN": string }>(`explain (analyze, buffers) ${sqlText}`);
    for (const r of res.rows) console.log(r["QUERY PLAN"]);
  } finally {
    await client.exec("rollback").catch(() => undefined);
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
