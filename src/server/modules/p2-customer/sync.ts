/**
 * P2 — handler perintah sinkron lapangan (outbox offline, docs/ARCHITECTURE.md §7).
 *
 * Registri sinkron tersedia di `@/server/core/sync` (F3c). Pola:
 * ```ts
 * import { z } from "zod";
 * import { registerPullProvider, registerSyncHandler } from "@/server/core/sync";
 * export function registerSync(): void {
 *   registerSyncHandler("<modul>.<objek>.<aksi>", {
 *     permission: "<modul>.<sumberdaya>.<aksi>",        // atau null (semua pengguna lapangan)
 *     schema: z.object({ … }),                           // payload divalidasi (pesan Indonesia)
 *     handle: async (ctx, payload, { tx, command, clockSkewFlagged, attachments }) => {
 *       // tulis dengan tx; fieldMeta: deviceId: ctx.deviceId, deviceTime: ctx.deviceTime, syncedAt: ctx.now,
 *       // syncCommandId: command.id, clockSkewFlagged
 *       return { objectType: "…", objectId: "…" };       // atau { status: "conflict", message: "…" }
 *     },
 *   });
 *   registerPullProvider("<modul>.<nama>", async ({ ctx, tx, since, device }) => ({ … }));
 * }
 * ```
 */
import "server-only";

export function registerSync(): void {
  // Belum ada handler — diisi agen modul P2 (registri sinkron F3c tersedia: @/server/core/sync).
}
