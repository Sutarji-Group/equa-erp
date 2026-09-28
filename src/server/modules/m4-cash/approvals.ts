/**
 * M4 — handler jenis persetujuan (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * | Jenis | Objek | Disetujui | Ditolak | Lewat tenggat |
 * | --- | --- | --- | --- | --- |
 * | `cash_discrepancy` | `discrepancy` | Selesai; beban selisih kas pusat laba sumber (`discrepancy.decided`, M11) | ganti rugi karyawan bila flag aktif (PTB-22) → dikembalikan ke Admin Keuangan | `escalate` (inti): tetap terbuka, naik ke puncak, dihitung KPI-03 |
 * | `petty_cash` | `petty_cash_transaction` | berlaku (kas kantor/kas kecil, event jurnal) | Ditolak — "Tidak berlaku" | — |
 * | `cash_close_exception` | `cash_close_exception` | penghalang tertutup pengecualian (setoran tertunda ≤ PAR-89) | Ditolak | `expire`: "Kas tidak dapat ditutup" |
 * | `correction` | `bank_deposit`, `restitution_settlement` | pembalik diterapkan (BR-38) | koreksi tidak berlaku | — |
 *
 * `ctx` handler = PENYETUJU (pemilik): tulis langsung dengan `tx` + audit (bukan layanan harian — SOD-08).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { discrepancies } from "@/db/schema";
import { registerApprovalHandler } from "@/server/core/approvals";

import { decideCloseException } from "./service/cash-day";
import { applyDiscrepancyDecision } from "./service/discrepancies";
import { applyBankDepositReversal } from "./service/office-cash";
import { decidePettyCash } from "./service/petty-cash";
import { applySettlementReversal } from "./service/restitutions";

function payloadReason(payload: Record<string, unknown> | null | undefined, fallback: string): string {
  const r = payload?.reason;
  return typeof r === "string" && r.trim() ? r : fallback;
}

export function registerApprovals(): void {
  registerApprovalHandler("cash_discrepancy", {
    onApproved: async ({ tx, request, ctx, reason }) => {
      const res = await applyDiscrepancyDecision(tx, ctx, request.objectId, "approved", reason, { approvalId: request.id });
      return { discrepancyStatus: res.discrepancy.status };
    },
    onRejected: async ({ tx, request, ctx, reason }) => {
      const res = await applyDiscrepancyDecision(tx, ctx, request.objectId, "rejected", reason, { approvalId: request.id });
      return { discrepancyStatus: res.discrepancy.status, restitutionId: res.restitutionId };
    },
    onCancelled: async ({ tx, request }) => {
      await tx.update(discrepancies).set({ approvalRequestId: null, updatedAt: new Date() }).where(eq(discrepancies.id, request.objectId));
    },
  });

  registerApprovalHandler("petty_cash", {
    onApproved: async ({ tx, request, ctx }) => decidePettyCash(tx, ctx, request.objectId, true),
    onRejected: async ({ tx, request, ctx }) => decidePettyCash(tx, ctx, request.objectId, false),
    onCancelled: async ({ tx, request, ctx }) => decidePettyCash(tx, ctx, request.objectId, false),
  });

  registerApprovalHandler("cash_close_exception", {
    onApproved: async ({ tx, request, ctx }) => decideCloseException(tx, ctx, request.objectId, "approved"),
    onRejected: async ({ tx, request, ctx }) => decideCloseException(tx, ctx, request.objectId, "rejected"),
    onExpired: async ({ tx, request, ctx }) => decideCloseException(tx, ctx, request.objectId, "expired"),
    onCancelled: async ({ tx, request, ctx }) => decideCloseException(tx, ctx, request.objectId, "rejected"),
  });

  registerApprovalHandler(
    "correction",
    {
      onApproved: async ({ tx, request, ctx }) => {
        const rev = await applyBankDepositReversal(tx, ctx, request.objectId, payloadReason(request.payload, request.reason));
        return { reversalId: rev.id };
      },
    },
    { objectType: "bank_deposit" },
  );
  registerApprovalHandler(
    "correction",
    {
      onApproved: async ({ tx, request, ctx }) => {
        const rev = await applySettlementReversal(tx, ctx, request.objectId, payloadReason(request.payload, request.reason));
        return { reversalId: rev.id };
      },
    },
    { objectType: "restitution_settlement" },
  );
}
