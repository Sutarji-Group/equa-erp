/**
 * M6 — kebijakan POS DEPOT (`PosKindPolicy` kind `depot`): harga standar dari master (BR-15), tanpa diskon (PTB-48),
 * tanpa pelanggan (FR-M6-08 C), pemakaian bahan dari resep & buku air dibukukan per shift saat tutup shift
 * (US-M6-04 KP-1/KP-2, US-M6-05 KP-3), pasokan air belum dikonfirmasi diterima otomatis (PAR-61).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { posSaleLines } from "@/db/schema";

import type { Tx } from "@/server/core/db";
import { emit } from "@/server/core/events";

import type { OutletRow, PosSaleRow } from "./common";
import { postStockMovement, postWaterMovement, recipesFor, usageFromLines } from "./inventory";
import type { PosKindPolicy } from "./policy";
import { autoAcceptPendingSupplies } from "./water";

/** Bukukan pemakaian bahan + air untuk satu transaksi (tersinkron setelah shift-nya ditutup, atau pembaliknya). */
async function postSaleConsumption(
  tx: Tx,
  input: { outlet: OutletRow; sale: PosSaleRow; direction: 1 | -1; source: { type: string; id: string }; occurredAt: Date; businessDate: string; userId: string | null },
): Promise<void> {
  const lines = await tx.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, input.sale.id));
  const recipes = await recipesFor(
    tx,
    input.outlet.tenantId,
    lines.map((l) => l.productId),
    input.sale.businessDate,
  );
  const usage = usageFromLines(lines, recipes);
  for (const [materialId, qty] of usage) {
    if (qty === 0) continue;
    await postStockMovement(tx, {
      tenantId: input.outlet.tenantId,
      outletId: input.outlet.id,
      productId: materialId,
      kind: input.direction === 1 ? "consumption" : "consumption_reversal",
      quantity: -input.direction * qty,
      businessDate: input.businessDate,
      occurredAt: input.occurredAt,
      source: input.source,
      createdBy: input.userId,
      note: input.direction === 1 ? `Pemakaian transaksi ${input.sale.number ?? input.sale.localNumber} (setelah tutup shift)` : "Pembalik pemakaian (void setelah tutup shift)",
    });
  }
  const liters = lines.reduce((sum, l) => sum + (l.gallonSizeL ? Math.abs(l.quantity) * l.gallonSizeL : 0), 0);
  if (liters > 0) {
    await postWaterMovement(tx, {
      tenantId: input.outlet.tenantId,
      outletId: input.outlet.id,
      kind: input.direction === 1 ? "sales_out" : "adjustment",
      volumeL: -input.direction * liters,
      businessDate: input.businessDate,
      occurredAt: input.occurredAt,
      source: input.source,
    });
  }
}

export const depotPolicy: PosKindPolicy = {
  kind: "depot",
  label: "Depot",
  depositSourceType: "depot_shift",
  stockCountKind: "weekly_depot",
  permissions: {
    saleCreate: "m6.pos_sale.create",
    saleVoid: "m6.pos_sale.void",
    saleCorrect: "m6.pos_sale.correct",
    shiftOpen: "m6.shift.open",
    shiftClose: "m6.shift.close",
    shiftRead: "m6.shift.read",
    shiftDeposit: "m6.shift_deposit.create",
    stockCount: "m6.stock_count.create",
    stockAdjustment: "m6.stock_adjustment.request",
    consumableReceipt: "m6.consumable_receipt.create",
  },
  priceKind: () => "standard",
  acceptsCustomer: false,
  productLine: "depot",

  async afterSaleRecorded({ tx, ctx, outlet, sale, shiftClosed }) {
    // Shift sudah ditutup (dibukukan per shift) → transaksi terlambat dibukukan sendiri.
    if (!shiftClosed) return;
    await postSaleConsumption(tx, {
      outlet,
      sale,
      direction: 1,
      source: { type: "pos_sale", id: sale.id },
      occurredAt: sale.soldAt,
      businessDate: sale.businessDate,
      userId: ctx.userId,
    });
  },

  async afterSaleVoided({ tx, ctx, outlet, sale, afterClose, reversalId }) {
    // Void di shift terbuka tidak pernah dibukukan (pemakaian dihitung dari transaksi yang dihitung saat tutup shift).
    if (!afterClose || !reversalId) return;
    await postSaleConsumption(tx, {
      outlet,
      sale,
      direction: -1,
      source: { type: "pos_sale_reversal", id: reversalId },
      occurredAt: ctx.now,
      businessDate: ctx.businessDate ?? sale.businessDate,
      userId: ctx.userId,
    });
  },

  async onShiftClosing({ tx, ctx, outlet, shift, figures, closedAt, businessDate }) {
    const lines: { productId: string; quantity: number; value: number }[] = [];
    for (const [materialId, qty] of figures.usage) {
      if (qty === 0) continue;
      const res = await postStockMovement(tx, {
        tenantId: outlet.tenantId,
        outletId: outlet.id,
        productId: materialId,
        kind: "consumption",
        quantity: -qty,
        businessDate,
        occurredAt: closedAt,
        source: { type: "shift", id: shift.id },
        createdBy: ctx.userId,
        note: "Pemakaian seharusnya (resep) — tutup shift",
      });
      lines.push({ productId: materialId, quantity: qty, value: -res.totalCost });
    }
    if (figures.gallonLitersSold > 0) {
      await postWaterMovement(tx, {
        tenantId: outlet.tenantId,
        outletId: outlet.id,
        kind: "sales_out",
        volumeL: -figures.gallonLitersSold,
        businessDate,
        occurredAt: closedAt,
        source: { type: "shift", id: shift.id },
      });
    }
    const totalValue = lines.reduce((s, l) => s + l.value, 0);
    if (lines.length) {
      await emit(
        tx,
        "consumable.usage_posted",
        { shiftId: shift.id, outletId: outlet.id, totalValue, lines },
        { ctx, objectType: "shift", objectId: shift.id, businessDate },
      );
    }
    const autoAccepted = await autoAcceptPendingSupplies(tx, { outlet, shift, closedAt, businessDate });
    return { consumptionValue: totalValue, consumptionLines: lines, waterSoldL: figures.gallonLitersSold, autoAcceptedSupplyIds: autoAccepted };
  },
};
