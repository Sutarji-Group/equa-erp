/**
 * `pnpm db:mask -- --yes` — samarkan data pribadi (WA, alamat, nama penerima, koordinat, identitas karyawan, jejak
 * aplikasi pelanggan) pada DB LINGKUNGAN UJI sesudah menyalin data produksi (NFR-27; langkah runbook rilis). MENOLAK
 * berjalan di lingkungan produksi (Vercel production/preview atau `NODE_ENV=production`). Memakai DB dari
 * `DATABASE_URL` (atau PGlite dev `.data/`).
 */
import { closeDb, getDb, getDbDriver } from "@/db/client";
import { maskPersonalData } from "@/db/mask";
import { isProductionLike } from "@/lib/env";

async function main(): Promise<void> {
  const env = { NODE_ENV: (process.env.NODE_ENV ?? "development") as "development" | "production" | "test", VERCEL_ENV: process.env.VERCEL_ENV as "production" | "preview" | "development" | undefined, NEXT_PHASE: process.env.NEXT_PHASE };
  if (isProductionLike(env) || process.env.EQUA_ENV === "production") {
    console.error("db:mask hanya untuk lingkungan uji — DITOLAK di produksi. Jalankan pada salinan DB di lingkungan uji.");
    process.exitCode = 1;
    return;
  }
  if (!process.argv.includes("--yes")) {
    console.error("db:mask mengubah data secara permanen. Jalankan ulang dengan `pnpm db:mask -- --yes` pada DB lingkungan uji.");
    process.exitCode = 1;
    return;
  }
  const db = getDb();
  console.log(`db:mask → driver ${getDbDriver()}`);
  const summary = await maskPersonalData(db);
  console.table(summary);
  console.log("Selesai: data pribadi disamarkan. Periksa acak: tidak ada nomor WA/alamat nyata.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
