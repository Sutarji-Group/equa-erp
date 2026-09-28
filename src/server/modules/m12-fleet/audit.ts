/**
 * M12 — registrasi jejak audit & lampiran milik modul ini (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 *
 * ```ts
 * import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
 * import { registerAttachmentAccess } from "@/server/core/storage";
 * export function registerAudit(): void {
 *   registerAuditObjectLabel("<objek>", "<label bahasa lapangan>");
 *   registerAuditFieldLabel("<objek>", "<kolom>", { label: "…", format: "rupiah" });
 *   registerFinancialObjectType("<objek keuangan>");   // akuntan melihat; admin sistem tanpa nilai (US-M10-06 KP-1)
 *   registerAttachmentAccess("<objek>", { permission: "<izin baca>", check: async (tx, ctx, row) => … lingkup … });
 * }
 * ```
 */
import "server-only";

export function registerAudit(): void {
  // Belum ada registrasi — diisi agen modul M12.
}
