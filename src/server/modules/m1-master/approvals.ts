/**
 * M1 — handler jenis persetujuan milik modul ini (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * | Jenis                 | Disetujui                                   | Ditolak            | Lewat tenggat (6.2a)             |
 * |-----------------------|---------------------------------------------|--------------------|----------------------------------|
 * | `credit_grant`        | status Tempo + batas segmen + tempo standar | status tetap Tunai | — (tanpa tenggat)                |
 * | `credit_terms_change` | batas/tempo baru berlaku                    | batas lama berlaku | — (tanpa tenggat)                |
 * | `special_price`       | harga khusus aktif (tinjauan PAR-24)        | harga master       | — (tanpa tenggat)                |
 * | `price_change`        | tarif/BBM/harga/batas zona aktif            | usulan ditolak     | usulan batal, harga lama berlaku |
 *
 * `ctx` handler = pemilik yang memutuskan (bukan pemohon): tulis langsung dengan `tx` + `audit.record` (tanpa
 * `authorize` izin harian, SOD-08).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { specialPrices } from "@/db/schema";
import { registerApprovalHandler, type ApprovalHandlerArgs } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";

import { applyCreditGrant, applyCreditTermsChange } from "./service/credit";
import { activatePriceRow, closePriceRow } from "./service/pricing";
import { applySpecialPriceDecision } from "./service/special-prices";
import { activateZoneTableRequest, closeZoneTableRequest } from "./service/zones";

async function priceApproved({ tx, request, ctx }: ApprovalHandlerArgs) {
  if (request.objectType === "tariff_zone_table") return activateZoneTableRequest(tx, ctx, request.id);
  const applied = await activatePriceRow(tx, ctx, request.objectType, request.objectId);
  return { applied };
}

function priceClosed(status: "rejected" | "cancelled", note: string | null) {
  return async ({ tx, request, ctx, reason }: ApprovalHandlerArgs) => {
    if (request.objectType === "tariff_zone_table") return closeZoneTableRequest(tx, ctx, request.id, status, reason ?? note);
    const closed = await closePriceRow(tx, ctx, request.objectType, request.objectId, status, reason ?? note);
    return { closed, keptOldPrice: true };
  };
}

export function registerApprovals(): void {
  registerApprovalHandler("credit_grant", {
    onApproved: ({ tx, request, ctx }) => applyCreditGrant(tx, ctx, request),
    onRejected: () => ({ creditStatus: "cash", note: "Status tetap Tunai." }),
  });
  registerApprovalHandler("credit_terms_change", {
    onApproved: ({ tx, request, ctx }) => applyCreditTermsChange(tx, ctx, request),
    onRejected: () => ({ note: "Batas/tempo lama tetap berlaku." }),
  });
  registerApprovalHandler("special_price", {
    onApproved: ({ tx, request, ctx, reason }) => applySpecialPriceDecision(tx, ctx, request, "approved", reason),
    onRejected: ({ tx, request, ctx, reason }) => applySpecialPriceDecision(tx, ctx, request, "rejected", reason),
    onCancelled: async ({ tx, request, ctx, reason }) => {
      const res = await tx.update(specialPrices).set({ status: "cancelled" }).where(eq(specialPrices.id, request.objectId)).returning({ id: specialPrices.id });
      if (res[0]) await auditRecord(tx, { ctx, objectType: "special_price", objectId: request.objectId, action: "cancel", before: { status: "pending" }, after: { status: "cancelled" }, reason });
      return { cancelled: res.length > 0 };
    },
  });
  registerApprovalHandler("price_change", {
    onApproved: priceApproved,
    onRejected: priceClosed("rejected", null),
    // 6.2a "Bila lewat tenggat: harga lama tetap berlaku".
    onExpired: priceClosed("cancelled", "Lewat tenggat sebelum tanggal berlaku — harga lama tetap berlaku."),
    onCancelled: priceClosed("cancelled", "Dibatalkan pemohon."),
  });
}
