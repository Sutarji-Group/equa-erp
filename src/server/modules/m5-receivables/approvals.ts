/**
 * M5 — handler jenis persetujuan Piutang (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * | Jenis                         | objectType          | Disetujui                                             | Ditolak / lewat tenggat (6.2a)           |
 * |-------------------------------|---------------------|-------------------------------------------------------|------------------------------------------|
 * | `credit_hold_release`         | `customer`          | Ditahan dibuka, berlaku sampai keterlambatan berikutnya | Tetap Ditahan (tanpa tenggat)            |
 * | `monthly_billing`             | `customer`          | Penanda tagihan bulanan + perjanjian (BR-05)          | Pelanggan tetap ditagih per rit          |
 * | `customer_refund`             | `customer_advance`  | Uang muka dikembalikan → `customer_advance.refunded`  | Uang muka tetap dialokasikan ke faktur berikutnya |
 * | `correction`                  | `customer_payment`  | Pembalik / realokasi pelunasan (BR-38)                | Koreksi tidak berlaku                    |
 * | `correction`                  | `trip_cash_reclass` | Reklasifikasi tunai rit → pelunasan (7.5.6)           | Koreksi tidak berlaku                    |
 * | `correction`                  | `invoice`           | Nota kredit > PAR-21                                  | Koreksi tidak berlaku                    |
 * | `opening_balance_adjustment`  | `opening_receivable`| Koreksi saldo awal piutang (tambah faktur / nota kredit) | Saldo awal tidak berubah              |
 *
 * `ctx` handler = PEMILIK (penyetuju): tulis langsung dengan `tx` + audit (tanpa layanan ber-`authorize` harian, SOD-08).
 * Semua jenis di atas ber-perilaku lewat tenggat `none` di registri → tidak ada `onExpired` yang mengubah data.
 */
import "server-only";

import { record as auditRecord } from "@/server/core/audit";
import { registerApprovalHandler, type ApprovalHandlerArgs } from "@/server/core/approvals";

import { applyHoldRelease } from "./service/credit-hold";
import { applyApprovedCreditNote } from "./service/invoices";
import { applyMonthlyBilling } from "./service/monthly";
import { applyOpeningAdjustment } from "./service/opening";
import { applyAdvanceRefund, applyPaymentReversal, applyReallocation, applyTripCashReclass } from "./service/payments";

async function recordNoChange(args: ApprovalHandlerArgs, what: string) {
  await auditRecord(args.tx, {
    ctx: args.ctx,
    objectType: args.request.objectType,
    objectId: args.request.objectId,
    action: `approval_${args.decision}`,
    after: { approvalId: args.request.id, number: args.request.number, type: args.request.type },
    reason: args.reason,
    rule: "6.2a",
  });
  return { effect: "no_change", note: what };
}

export function registerApprovals(): void {
  registerApprovalHandler(
    "credit_hold_release",
    {
      onApproved: async ({ tx, ctx, request }) => {
        const after = await applyHoldRelease(tx, ctx, request.objectId, { reason: request.reason, approvalId: request.id });
        return after ? { effect: "released", creditStatus: after.creditStatus } : { effect: "no_change", note: "Pelanggan sudah tidak Ditahan." };
      },
      onRejected: (args) => recordNoChange(args, "Tetap Ditahan."),
    },
    { objectType: "customer" },
  );

  registerApprovalHandler(
    "monthly_billing",
    {
      onApproved: ({ tx, ctx, request }) => applyMonthlyBilling(tx, ctx, request),
      onRejected: (args) => recordNoChange(args, "Pelanggan tetap ditagih per rit."),
    },
    { objectType: "customer" },
  );

  registerApprovalHandler(
    "customer_refund",
    {
      onApproved: ({ tx, ctx, request }) => applyAdvanceRefund(tx, ctx, request),
      onRejected: (args) => recordNoChange(args, "Uang muka tetap dialokasikan ke faktur berikutnya."),
    },
    { objectType: "customer_advance" },
  );

  registerApprovalHandler(
    "correction",
    {
      onApproved: async ({ tx, ctx, request }) => {
        const p = (request.payload ?? {}) as { action?: string; allocations?: { invoiceId: string; amount: number }[] };
        if (p.action === "reallocate" && p.allocations) {
          await applyReallocation(tx, ctx, request.objectId, p.allocations, request.reason, request.id);
          return { effect: "reallocated" };
        }
        const reversal = await applyPaymentReversal(tx, ctx, request.objectId, request.reason, request.id);
        return { effect: "reversed", reversalId: reversal.id };
      },
      onRejected: (args) => recordNoChange(args, "Koreksi tidak berlaku."),
    },
    { objectType: "customer_payment" },
  );

  registerApprovalHandler(
    "correction",
    {
      onApproved: async ({ tx, ctx, request }) => {
        const p = (request.payload ?? {}) as { tripId: string; amount: number; allocations?: { invoiceId: string; amount: number }[] | null };
        const res = await applyTripCashReclass(tx, ctx, { tripId: p.tripId, amount: p.amount, allocations: p.allocations ?? null, reason: request.reason, approvalId: request.id });
        return { effect: "reclassified", ...res };
      },
      onRejected: (args) => recordNoChange(args, "Koreksi tidak berlaku."),
    },
    { objectType: "trip_cash_reclass" },
  );

  registerApprovalHandler(
    "correction",
    {
      onApproved: ({ tx, ctx, request }) => applyApprovedCreditNote(tx, ctx, request),
      onRejected: (args) => recordNoChange(args, "Koreksi tidak berlaku."),
    },
    { objectType: "invoice" },
  );

  registerApprovalHandler(
    "opening_balance_adjustment",
    {
      onApproved: ({ tx, ctx, request }) => applyOpeningAdjustment(tx, ctx, request),
      onRejected: (args) => recordNoChange(args, "Saldo awal tidak berubah."),
    },
    { objectType: "opening_receivable" },
  );
}
