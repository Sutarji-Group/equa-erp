/**
 * M11 — handler jenis persetujuan (PRD 6.2a; registri `src/server/core/approvals/registry.ts`):
 *
 * | Jenis | Objek | Disetujui | Ditolak | Lewat tenggat (6.2a) |
 * |---|---|---|---|---|
 * | `manual_journal` (> PAR-20) | `journal` | jurnal terposting | Ditolak (dapat diperbaiki & diajukan ulang) | eskalasi: tetap terbuka, "tidak terposting; periode tidak dapat ditutup" (prasyarat) |
 * | `correction` (> PAR-21) | `journal` | jurnal pembalik terposting | jurnal asal tetap | — (tanpa tenggat) |
 * | `period_lock` | `accounting_period` | Dikunci + laporan Final disimpan | kembali Terbuka | eskalasi: ditandai terlambat |
 * | `opening_balance_adjustment` (≤ PAR-62 bln) | `opening_adjustment_journal` | penyesuaian terposting | Ditolak | — ("saldo awal tidak berubah") |
 *
 * `ctx` handler = pemilik (penyetuju): tulis langsung dengan `tx` + audit (bukan layanan harian yang ber-`authorize`).
 */
import "server-only";

import { registerApprovalHandler } from "@/server/core/approvals";

import { onJournalCorrectionApproved, onManualJournalApproved, onManualJournalRejected } from "./service/manual";
import { onOpeningAdjustmentApproved, onOpeningAdjustmentRejected } from "./service/opening";
import { onPeriodLockApproved, onPeriodLockOverdue, onPeriodLockRejected } from "./service/periods";

export function registerApprovals(): void {
  registerApprovalHandler(
    "manual_journal",
    {
      onApproved: ({ tx, request, ctx }) => onManualJournalApproved(tx, request, ctx),
      onRejected: ({ tx, request, ctx, reason }) => onManualJournalRejected(tx, request, ctx, reason),
      // Eskalasi: permintaan tetap terbuka; jurnal tidak terposting dan menghalangi tutup periode (prasyarat).
      onOverdue: () => ({ blocking: "period_close" }),
    },
    { objectType: "journal" },
  );
  registerApprovalHandler("correction", { onApproved: ({ tx, request, ctx }) => onJournalCorrectionApproved(tx, request, ctx) }, { objectType: "journal" });
  registerApprovalHandler("period_lock", {
    onApproved: ({ tx, request, ctx }) => onPeriodLockApproved(tx, request, ctx),
    onRejected: ({ tx, request, ctx, reason }) => onPeriodLockRejected(tx, request, ctx, reason),
    onOverdue: ({ tx, request }) => onPeriodLockOverdue(tx, request),
  });
  registerApprovalHandler(
    "opening_balance_adjustment",
    {
      onApproved: ({ tx, request, ctx }) => onOpeningAdjustmentApproved(tx, request, ctx),
      onRejected: ({ tx, request, ctx, reason }) => onOpeningAdjustmentRejected(tx, request, ctx, reason),
    },
    { objectType: "opening_adjustment_journal" },
  );
}
