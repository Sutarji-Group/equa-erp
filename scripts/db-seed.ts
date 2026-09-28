/**
 * `pnpm db:seed` — isi data awal & demo (idempoten; aman dijalankan ulang). Lihat `src/db/seed/` dan README
 * (akun demo). Jalankan `pnpm db:push` lebih dulu. Menolak berjalan di produksi Vercel.
 */
import { closeDb, getDb, getDbDriver } from "@/db/client";
import { runSeed } from "@/db/seed";

async function main(): Promise<void> {
  if (process.env.VERCEL_ENV === "production" && !process.argv.includes("--allow-production")) {
    console.error("db:seed berisi data demo dan tidak boleh dijalankan di produksi.");
    process.exitCode = 1;
    return;
  }
  const db = getDb();
  console.log(`db:seed → driver ${getDbDriver()}`);
  const summary = await runSeed(db);
  console.log(`Parameter baru: ${summary.parameters}; pengguna baru: ${summary.users}; pelanggan baru: ${summary.customers}.`);
  console.table(summary.counts);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
