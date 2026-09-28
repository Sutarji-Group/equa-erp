/**
 * M2 — handler jenis persetujuan milik modul ini (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
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
 */
import "server-only";

export function registerApprovals(): void {
  // Belum ada handler — diisi agen modul M2.
}
