/**
 * M8 — handler perintah sinkron lapangan (outbox offline, docs/ARCHITECTURE.md §7).
 *
 * Registri sinkron tersedia di `@/server/core/sync` (F3c). Pola:
 * ```ts
 * import { z } from "zod";
 * import { registerPullProvider, registerSyncHandler } from "@/server/core/sync";
 * export function registerSync(): void {
 *   registerSyncHandler("<modul>.<objek>.<aksi>", {
 *     permission: "<modul>.<sumberdaya>.<aksi>",        // atau null (semua pengguna lapangan)
 *     // Izin bersyarat (kernet pengganti US-M2-11) — WAJIB untuk izin m3.* yang ada di CONDITIONAL_GRANTS:
 *     conditions: async (ctx, payload, { tx }) => substituteDriverConditions(tx, ctx, truckIdDari(payload), ctxBusinessDate(ctx)),
 *     schema: z.object({ … }),                           // payload divalidasi (pesan Indonesia)
 *     handle: async (ctx, payload, meta) => {
 *       // tulis dengan meta.tx; kolom fieldMeta(): { ...fieldMetaValues(meta) } (device_id, device_time, synced_at,
 *       // sync_command_id, late_sync, clock_skew_flagged); lampiran = meta.attachments (sudah diverifikasi pemiliknya).
 *       // DomainError = ditolak FINAL (disimpan); galat lain = retry. Nomor resmi dokumen perangkat:
 *       // assignOfficialNumber(meta.tx, "pos_sale", { tenantId: meta.device.tenantId, businessDate: meta.command.businessDate, outletCode }).
 *       return { objectType: "…", objectId: "…" };       // atau { status: "conflict", message: "…" } (tabrakan kantor)
 *     },
 *   });
 *   registerPullProvider("<modul>.<nama>", async ({ ctx, tx, since, device }) => ({ … }));
 * }
 * ```
 */
import "server-only";

export function registerSync(): void {
  // Belum ada handler — diisi agen modul M8 (registri sinkron F3c tersedia: @/server/core/sync).
}
