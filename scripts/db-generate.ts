/**
 * `pnpm db:generate` — bangkitkan migrasi SQL produksi ke `drizzle/` (drizzle-kit generate, konfigurasi
 * `drizzle.config.ts`). Argumen tambahan diteruskan, mis. `pnpm db:generate --name awal`.
 * Trigger pengerasan TIDAK masuk migrasi drizzle — diterapkan `pnpm db:migrate` / `pnpm db:push` (idempoten).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const bin = path.join(process.cwd(), "node_modules", "drizzle-kit", "bin.cjs");
const result = spawnSync(process.execPath, [bin, "generate", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.status === 0) {
  console.log("Migrasi dibangkitkan di drizzle/. Terapkan dengan `pnpm db:migrate` (termasuk trigger pengerasan).");
}
process.exitCode = result.status ?? 1;
