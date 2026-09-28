/**
 * M9 — pekerjaan terjadwal milik modul ini (`/api/cron/tick`, idempoten per slot).
 *
 * ```ts
 * import { registerJob } from "@/server/core/jobs";
 * export function registerJobs(): void {
 *   registerJob({ key: "m9.contoh", description: "…", schedule: { kind: "daily", at: "22:15" },
 *     run: async ({ now, db }) => { … } });
 * }
 * ```
 */
import "server-only";

export function registerJobs(): void {
  // Belum ada job — diisi agen modul M9.
}
