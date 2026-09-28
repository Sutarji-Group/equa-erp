/**
 * M6 — handler persetujuan kerangka POS (PRD 6.2a; registri `src/server/core/approvals/registry.ts`). Dipakai SEMUA
 * jenis outlet (depot M6, toko M7) — M7 tidak mendaftarkan ulang jenis ini.
 *
 * | Jenis              | Disetujui                                                         | Ditolak                 | Lewat tenggat                                   |
 * |--------------------|-------------------------------------------------------------------|-------------------------|-------------------------------------------------|
 * | `pos_void`         | shift terbuka → Di-void; sudah ditutup → Admin Keuangan membuat   | kembali Sah (dihitung)  | `expire`: dianggap ditolak di akhir shift —     |
 * |                    | pembalik (notifikasi `pos.void_reversal_needed`, PTB-43)          |                         | transaksi tetap dihitung                        |
 * | `stock_adjustment` | saldo disesuaikan + `stock.adjusted` (jurnal M11)                  | saldo tetap             | `escalate`: saldo tidak berubah, tetap di daftar |
 *
 * `ctx` handler = pelaku keputusan (pemilik) atau sistem (lewat tenggat) — handler menulis langsung dengan `tx`.
 */
import "server-only";

import { registerApprovalHandler } from "@/server/core/approvals";

import { onVoidApproved, onVoidRejected } from "./service/sales";
import { onStockAdjustmentApproved, onStockAdjustmentRejected } from "./service/stock";

export function registerApprovals(): void {
  registerApprovalHandler("pos_void", {
    onApproved: ({ tx, request, ctx }) => onVoidApproved(tx, request, ctx),
    onRejected: ({ tx, request, ctx }) => onVoidRejected(tx, request, ctx, "rejected"),
    onExpired: ({ tx, request, ctx }) => onVoidRejected(tx, request, ctx, "expired"),
    onCancelled: ({ tx, request, ctx }) => onVoidRejected(tx, request, ctx, "rejected"),
  });
  registerApprovalHandler("stock_adjustment", {
    onApproved: ({ tx, request, ctx }) => onStockAdjustmentApproved(tx, request, ctx),
    onRejected: ({ tx, request, ctx }) => onStockAdjustmentRejected(tx, request, ctx),
    onCancelled: ({ tx, request, ctx }) => onStockAdjustmentRejected(tx, request, ctx),
    // Lewat tenggat (escalate, 6.2a): saldo tidak berubah; permintaan tetap terbuka di kotak persetujuan.
  });
}
