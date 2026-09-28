/**
 * M6 — data referensi offline POS (pull `m6.pos`; Bab 6.4 butir 4, US-M6-06 KP-1): pengaturan outlet (kas awal tetap,
 * ambang), shift terbuka + transaksinya, stok bahan & resep, pasokan air tiba, transfer internal masuk, opname minggu
 * ini, riwayat shift MILIK operator (US-M6-02 KP-6). Katalog & harga dari M1 (`m1.catalog`).
 *
 * ISOLASI TENANT (NFR-30): hanya outlet perangkat (atau lingkup operator untuk perangkat cadangan) di tenant perangkat.
 */
import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { employees, internalTransferLines, internalTransfers, outlets, posSaleLines, posSales, products, shiftStockCounts, shifts, stockCounts, trips, users, waterSupplyReceipts } from "@/db/schema";
import type { PosReference, PosSaleRef, PosShiftRef } from "@/client/m6-pos/contract";
import { toBusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import * as params from "@/server/core/params";

import { isoWeekLabel, loadOutlet, outletPosSettings, type ShiftRow } from "./common";
import { consumablesOf, stockBalancesOf, tenantRecipes } from "./inventory";
import { voidCountOn } from "./sales";
import { operatorShiftHistory } from "./shifts";
import { waterStockNow } from "./water";

async function shiftRef(tx: Tx, shift: ShiftRow): Promise<PosShiftRef> {
  const [op] = await tx
    .select({ name: employees.fullName })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.id, shift.operatorUserId))
    .limit(1);
  const sales = await tx.select().from(posSales).where(eq(posSales.shiftId, shift.id)).orderBy(asc(posSales.soldAt));
  const lines = sales.length ? await tx.select().from(posSaleLines).where(inArray(posSaleLines.posSaleId, sales.map((s) => s.id))) : [];
  const opening = await tx
    .select({ productId: shiftStockCounts.productId, systemQty: shiftStockCounts.systemQty })
    .from(shiftStockCounts)
    .where(and(eq(shiftStockCounts.shiftId, shift.id), eq(shiftStockCounts.phase, "opening")));
  return {
    id: shift.id,
    businessDate: shift.businessDate,
    openedAt: shift.openedAt.toISOString(),
    operatorUserId: shift.operatorUserId,
    operatorName: op?.name ?? null,
    openingCash: shift.openingCashFixed,
    openingCashCounted: shift.openingCashCounted,
    partialDepositTotal: shift.partialDepositTotal,
    cashLimitAlerted: !!shift.cashLimitAlertAt,
    syncConflict: shift.syncConflict,
    status: shift.status,
    openingStock: opening,
    sales: sales.map(
      (s): PosSaleRef => ({
        id: s.id,
        number: s.number,
        localNumber: s.localNumber,
        soldAt: s.soldAt.toISOString(),
        total: s.total,
        paymentMethod: s.paymentMethod,
        cashReceived: s.cashReceived,
        changeAmount: s.changeAmount,
        qrisReference: s.qrisReference,
        status: s.status,
        voidReason: s.voidReason,
        priceMismatch: s.priceMismatch,
        isReversal: s.isReversal,
        reversalReason: s.reversalReason,
        replacesSaleId: s.replacesSaleId,
        lines: lines
          .filter((l) => l.posSaleId === s.id)
          .sort((a, b) => a.lineNo - b.lineNo)
          .map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, gallonSizeL: l.gallonSizeL })),
      }),
    ),
  };
}

/** Bangun data `m6.pos` untuk perangkat & pengguna POS. */
export async function buildPosReference(tx: Tx, ctx: ActorContext, device: { outletId: string | null; tenantId: string }, now: Date): Promise<PosReference | null> {
  const outletId = device.outletId ?? ctx.scope.outletIds[0] ?? null;
  if (!outletId) return null;
  const outlet = await loadOutlet(tx, outletId).catch(() => null);
  // NFR-30: outlet harus milik tenant perangkat & pengguna, dan dalam lingkup operator.
  if (!outlet || outlet.tenantId !== device.tenantId || outlet.tenantId !== ctx.tenantId) return null;
  if (!ctx.scope.outletIds.includes(outlet.id) && !ctx.scope.tenantIds.includes(outlet.tenantId)) return null;
  const date = toBusinessDate(now);
  const settings = await outletPosSettings(tx, outlet, date);
  const identity = await params.get(tx, "company.identity", date, { tenantId: outlet.tenantId }).catch(() => ({ name: "EQUA" }));

  const openRows = await tx.select().from(shifts).where(and(eq(shifts.outletId, outlet.id), eq(shifts.status, "open"))).orderBy(asc(shifts.openedAt));
  const main = openRows.find((s) => !s.syncConflict) ?? null;
  const conflictRows = openRows.filter((s) => s.syncConflict);
  const [lastClosed] = await tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.outletId, outlet.id), eq(shifts.status, "closed")))
    .orderBy(desc(shifts.closedAt))
    .limit(1);

  const materials = await consumablesOf(tx, outlet.tenantId, outlet.kind === "store" ? "store" : "depot");
  const balances = await stockBalancesOf(
    tx,
    outlet.id,
    materials.map((m) => m.id),
  );

  let water: PosReference["water"] = null;
  if (outlet.kind === "depot") {
    const pending = await tx
      .select({ r: waterSupplyReceipts, tripNumber: trips.number })
      .from(waterSupplyReceipts)
      .leftJoin(trips, eq(trips.id, waterSupplyReceipts.tripId))
      .where(and(eq(waterSupplyReceipts.outletId, outlet.id), eq(waterSupplyReceipts.status, "arrived")))
      .orderBy(asc(waterSupplyReceipts.createdAt));
    const stockL = await waterStockNow(tx, outlet.id);
    water = {
      stockL,
      capacityL: outlet.storageCapacityL,
      overCapacity: outlet.storageCapacityL !== null && stockL > outlet.storageCapacityL,
      pending: pending.map(({ r, tripNumber }) => ({
        id: r.id,
        tripId: r.tripId,
        tripNumber: tripNumber ?? null,
        deliveredVolumeL: r.deliveredVolumeL,
        arrivedAt: r.createdAt.toISOString(),
        businessDate: r.businessDate,
        status: r.status,
      })),
    };
  }

  const transfersRows = await tx
    .select({ t: internalTransfers, fromName: outlets.name })
    .from(internalTransfers)
    .innerJoin(outlets, eq(outlets.id, internalTransfers.fromOutletId))
    .where(and(eq(internalTransfers.toOutletId, outlet.id), eq(internalTransfers.status, "sent")))
    .orderBy(asc(internalTransfers.sentAt));
  const tLines = transfersRows.length
    ? await tx
        .select({ l: internalTransferLines, productName: products.name, unit: products.unit })
        .from(internalTransferLines)
        .innerJoin(products, eq(products.id, internalTransferLines.productId))
        .where(inArray(internalTransferLines.transferId, transfersRows.map((r) => r.t.id)))
    : [];

  const week = isoWeekLabel(date);
  const [sc] = await tx
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.outletId, outlet.id), eq(stockCounts.periodLabel, week)))
    .orderBy(desc(stockCounts.startedAt))
    .limit(1);

  const history = ctx.userId ? await operatorShiftHistory(tx, { userId: ctx.userId, outletId: outlet.id, today: date, days: settings.rules.operator_history_days }) : [];

  return {
    version: 1,
    generatedAt: now.toISOString(),
    businessDate: date,
    outlet: { id: outlet.id, code: outlet.code, name: outlet.name, kind: outlet.kind, tenantId: outlet.tenantId, storageCapacityL: outlet.storageCapacityL },
    companyName: identity.name,
    settings: {
      fixedOpeningCash: settings.fixedOpeningCash,
      cashLimit: settings.cashLimit,
      voidApprovalAbove: settings.voidApprovalAbove,
      voidDailyCount: settings.voidDailyCount,
      stockTolerance: settings.stockTolerance,
      gridMax: settings.rules.grid_max_products,
      maxSaleLines: settings.rules.max_sale_lines,
      maxQuantityPerLine: settings.rules.max_quantity_per_line,
      qrisEnabled: settings.qrisEnabled,
      printerEnabled: settings.printerEnabled,
    },
    openShift: main ? await shiftRef(tx, main) : null,
    conflictShifts: await Promise.all(conflictRows.map((s) => shiftRef(tx, s))),
    lastClosedShift: lastClosed
      ? { id: lastClosed.id, businessDate: lastClosed.businessDate, closedAt: lastClosed.closedAt?.toISOString() ?? null, depositStatus: lastClosed.depositStatus, depositAmount: lastClosed.depositAmount }
      : null,
    materials: materials.map((m) => ({ id: m.id, code: m.code, name: m.name, unit: m.unit, balance: balances.get(m.id)?.quantity ?? 0 })),
    recipes: await tenantRecipes(tx, outlet.tenantId, date),
    water,
    transfers: transfersRows.map(({ t, fromName }) => ({
      id: t.id,
      number: t.number,
      localNumber: t.localNumber,
      sentAt: t.sentAt.toISOString(),
      fromOutletName: fromName,
      lines: tLines.filter((l) => l.l.transferId === t.id).map((l) => ({ lineId: l.l.id, productName: l.productName, quantitySent: l.l.quantitySent, unit: l.unit })),
    })),
    stockCountThisWeek: sc ? { id: sc.id, status: sc.status, periodLabel: sc.periodLabel, startedAt: sc.startedAt.toISOString() } : null,
    history,
    voidsToday: (await voidCountOn(tx, outlet.id, date)).count,
  };
}
