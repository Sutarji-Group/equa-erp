/**
 * M9 — handler jenis persetujuan milik modul ini (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * `paper_withdrawal_early` (NFR-35, 11.5 butir 2): penarikan nota kertas unit SEBELUM hari ke-14 periode paralel —
 * pemohon Admin Keuangan/manajer proyek (admin sistem), penyetuju pemilik, syarat PAR-84 diperiksa saat diajukan.
 * - Disetujui → nota kertas ditarik pada tanggal yang diajukan (`unit_paper_withdrawals.withdrawn_date`,
 *   `early_withdrawal_approved_by` = pemilik) — masukan KPI-11.
 * - Ditolak / dibatalkan → periode paralel berlanjut (tanpa perubahan data).
 * - Lewat tenggat (hari ke-14) → kedaluwarsa: nota kertas ditarik pada hari ke-14 sesuai batas NFR-35 lewat jalur biasa.
 * Handler menulis dengan `tx` + `audit.record` (ctx penyetuju) — tidak memanggil layanan berizin harian (SOD-08).
 */
import "server-only";

import { registerApprovalHandler } from "@/server/core/approvals";

import { applyEarlyWithdrawal } from "./service/parallel";

export function registerApprovals(): void {
  registerApprovalHandler("paper_withdrawal_early", {
    onApproved: async ({ tx, request, ctx }) => applyEarlyWithdrawal(tx, ctx, { id: request.id, objectId: request.objectId, payload: request.payload as Record<string, unknown> | null }),
    onRejected: async () => ({ note: "Periode paralel berlanjut; nota kertas ditarik pada hari ke-14 (NFR-35)." }),
    onExpired: async () => ({ note: "Lewat tenggat: nota kertas ditarik pada hari ke-14 sesuai batas NFR-35." }),
    onCancelled: async () => ({ note: "Pengajuan dibatalkan; periode paralel berlanjut." }),
  });
}
