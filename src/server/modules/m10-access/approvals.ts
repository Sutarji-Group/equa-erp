/**
 * M10 — handler jenis persetujuan milik modul ini (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * | Jenis           | Disetujui                                | Ditolak/dibatalkan                   | Lewat tenggat (6.2a)                          |
 * |-----------------|------------------------------------------|--------------------------------------|-----------------------------------------------|
 * | account_create  | akun + peran + lingkup aktif             | pemberian ditolak; akun tidak aktif   | escalate (D-08): tetap terbuka, akun tidak aktif |
 * | role_grant      | peran baru aktif, peran lama dicabut     | pemberian ditolak                    | escalate: peran tidak aktif                   |
 * | scope_extension | lingkup baru aktif                       | pemberian ditolak                    | escalate: lingkup tidak aktif                 |
 * | multi_role      | peran tambahan aktif (masa berlaku)      | pemberian ditolak                    | tanpa tenggat: tidak aktif                    |
 * | anonymization   | anonimisasi dijalankan / ditunda (piutang) | ditolak                            | tanpa tenggat                                 |
 *
 * `ctx` handler = pemilik (penyetuju) — tulisan langsung dengan `tx` + `audit.record`, tanpa `authorize` izin admin.
 */
import "server-only";

import { registerApprovalHandler } from "@/server/core/approvals";

import { accountCreateHandlers, multiRoleHandlers, roleGrantHandlers, scopeExtensionHandlers } from "./service/access-approvals";
import { anonymizationHandlers } from "./service/anonymization";

export function registerApprovals(): void {
  registerApprovalHandler("account_create", accountCreateHandlers);
  registerApprovalHandler("role_grant", roleGrantHandlers);
  registerApprovalHandler("multi_role", multiRoleHandlers);
  registerApprovalHandler("scope_extension", scopeExtensionHandlers);
  registerApprovalHandler("anonymization", anonymizationHandlers);
}
