/**
 * M8 — handler perintah sinkron lapangan (outbox offline, docs/ARCHITECTURE.md §7).
 *
 * Registri sinkron (`src/server/core/sync`) disediakan agen F3c. Pola yang direncanakan:
 * ```ts
 * import { registerSyncHandler } from "@/server/core/sync";
 * export function registerSync(): void {
 *   registerSyncHandler("<modul>.<perintah>", { schema, handle: async (ctx, payload, { tx, command }) => … });
 * }
 * ```
 */
import "server-only";

export function registerSync(): void {
  // Belum ada handler — diisi agen modul M8 (setelah registri sinkron F3c tersedia).
}
