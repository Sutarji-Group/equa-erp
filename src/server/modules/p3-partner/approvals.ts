/**
 * P3 — handler jenis persetujuan milik modul ini (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * | Jenis | Objek | Disetujui | Ditolak | Lewat tenggat (6.2a) |
 * | --- | --- | --- | --- | --- |
 * | `partner_contract` | `partner_contract` | kind `create` → kontrak Aktif (batas kredit & tagihan bulanan pelanggan mitra, tanggal mulai tagih outlet, wilayah eksklusif, daftar periksa onboarding); kind `terms_change` → parameter berlaku bulan berikutnya | kontrak tetap Draf (tidak ditagih) | tanpa tenggat — "Kontrak belum aktif" |
 * | `partner_prospect` | `partner_prospect` | calon mitra Disetujui pemilik | Ditolak | tanpa tenggat — "Prospek belum disetujui" |
 * | `partner_sanction` | `partner_sanction` | sanksi Berlaku (teguran bersurat / penghentian pasokan / pemutusan + ekspor data PTB-58) | Tidak dilanjutkan | tanpa tenggat — "Sanksi tidak berlaku" |
 *
 * `ctx` handler = pemilik (penyetuju): menulis langsung dengan `tx` + audit (tidak memanggil layanan ber-izin harian).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { partnerContracts } from "@/db/schema";
import { registerApprovalHandler } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";

import { activateContract, scheduleContractTerms } from "./service/contracts";
import { decideProspect } from "./service/prospects";
import { applySanctionDecision, dismissSanctionOnRejection } from "./service/sanctions";

export function registerApprovals(): void {
  registerApprovalHandler("partner_contract", {
    onApproved: async ({ tx, request, ctx }) => {
      const kind = (request.payload as { kind?: string } | null)?.kind;
      return kind === "terms_change" ? scheduleContractTerms(tx, ctx, request.objectId, request) : activateContract(tx, ctx, request.objectId, request);
    },
    onRejected: async ({ tx, request, ctx, reason }) => {
      const kind = (request.payload as { kind?: string } | null)?.kind;
      const [c] = await tx.select({ id: partnerContracts.id, status: partnerContracts.status }).from(partnerContracts).where(eq(partnerContracts.id, request.objectId)).limit(1);
      if (!c) return { skipped: true };
      await auditRecord(tx, { ctx, objectType: "partner_contract", objectId: c.id, action: kind === "terms_change" ? "terms_rejected" : "rejected", after: { status: c.status, approval: request.number }, reason, rule: "6.2a" });
      return { status: c.status };
    },
    onExpired: async () => ({ note: "Kontrak belum aktif (tanpa tenggat, 6.2a)." }),
  });
  registerApprovalHandler("partner_prospect", {
    onApproved: async ({ tx, request, ctx, reason }) => decideProspect(tx, ctx, request, "approved", reason),
    onRejected: async ({ tx, request, ctx, reason }) => decideProspect(tx, ctx, request, "rejected", reason),
    onExpired: async () => ({ note: "Prospek belum disetujui (tanpa tenggat, 6.2a)." }),
  });
  registerApprovalHandler("partner_sanction", {
    onApproved: async ({ tx, request, ctx, reason }) => applySanctionDecision(tx, ctx, request, reason),
    onRejected: async ({ tx, request, ctx, reason }) => dismissSanctionOnRejection(tx, ctx, request, reason),
    onExpired: async () => ({ note: "Sanksi tidak berlaku (tanpa tenggat, 6.2a)." }),
  });
}
