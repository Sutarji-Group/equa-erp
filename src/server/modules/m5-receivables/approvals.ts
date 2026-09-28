/**
 * M5 — handler jenis persetujuan milik modul ini (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * ```ts
 * import { registerApprovalHandler } from "@/server/core/approvals";
 * export function registerApprovals(): void {
 *   registerApprovalHandler("<jenis>", {
 *     onApproved: async ({ tx, request, ctx }) => { … ubah objek sumber … },
 *     onRejected: async ({ tx, request, reason }) => { … },
 *     onExpired: async ({ tx, request }) => { … perilaku "bila lewat tenggat" … },
 *   });
 * }
 * ```
 * PERHATIAN: `ctx` handler = pelaku KEPUTUSAN (pemilik/penyetuju), bukan pemohon. Jangan memanggil layanan modul yang
 * `authorize` izin harian (pemilik ditolak SOD-08). Tulis langsung dengan `tx` + `audit.record(tx, { ctx, … })`, atau
 * panggil fungsi internal modul tanpa `authorize` (atau `systemContext({ tenantId: request.tenantId })` + `rule: "6.2a"`).
 */
import "server-only";

export function registerApprovals(): void {
  // Belum ada handler — diisi agen modul M5.
}
