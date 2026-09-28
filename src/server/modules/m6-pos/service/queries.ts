/**
 * M6 — tampilan kantor & laporan outlet (pemantauan /outlet, laporan per outlet US-M6-07 KP-5, void per outlet per hari
 * US-M6-03 KP-3, kartu stok US-M6-04 KP-1, pemakaian vs penjualan US-M6-04 KP-6, neraca air US-M6-05 KP-4).
 *
 * ISOLASI TENANT (NFR-30, US-M6-07 KP-2/KP-6): semua kueri berlingkup `ctx.tenantId` + lingkup pelaku; outlet tenant
 * lain diperlakukan "tidak ditemukan". Izin baca: `m6.outlet.read` (pemilik/Admin Keuangan EQUA) atau
 * `p3.partner_report.read` (pemilik tenant mitra, portal RL-7) — laporan yang sama, data tenant sendiri.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";

import {
  approvalRequests,
  consumableReceipts,
  deposits,
  outlets,
  posSaleLines,
  posSales,
  products,
  shiftStockCounts,
  shifts,
  stockBalances,
  stockCountLines,
  stockCounts,
  stockLedger,
  waterSupplyReceipts,
} from "@/db/schema";
import { addDays, businessDateToUtcRange, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { NotFoundError } from "@/server/core/errors";
import { assertTenantScope, authorizeAny, inOutletScope } from "@/server/core/rbac";

import { COUNTED_SALE, isoWeekLabel, loadOutletForOffice, outletPosSettings, type OutletRow, type ShiftRow } from "./common";
import { computeShiftFigures, isCountedSale } from "./figures";
import { consumablesOf, stockBalancesOf } from "./inventory";
import { pendingVoidReversals } from "./sales";
import { shiftSyncStatus } from "./shifts";
import { waterBalancesFor, waterStockNow } from "./water";

export const OUTLET_READ_PERMISSIONS = ["m6.outlet.read", "p3.partner_report.read"] as const;

export async function authorizeOutletRead(ctx: ActorContext, tx?: Tx): Promise<void> {
  await authorizeAny(ctx, OUTLET_READ_PERMISSIONS, { tx });
  assertTenantScope(ctx, ctx.tenantId);
}

/** Outlet tenant pelaku dalam lingkupnya. */
export async function tenantOutlets(tx: Tx, ctx: ActorContext, opts: { outletIds?: string[]; kind?: "depot" | "store" } = {}): Promise<OutletRow[]> {
  const rows = await tx
    .select()
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, ctx.tenantId),
        ...(opts.outletIds?.length ? [inArray(outlets.id, opts.outletIds)] : []),
        ...(opts.kind ? [eq(outlets.kind, opts.kind)] : []),
      ),
    )
    .orderBy(asc(outlets.kind), asc(outlets.code));
  return rows.filter((o) => inOutletScope(ctx, o.id, o.tenantId));
}

/** Nama operator shift (subkueri berkualifikasi tabel agar aman di select satu tabel). */
const employeeName = sql<string | null>`(select e.full_name from users u join employees e on e.id = u.employee_id where u.id = "shifts"."operator_user_id")`;

// =====================================================================================================================
// Agregat penjualan per outlet per tanggal
// =====================================================================================================================

export type SalesAggregateRow = {
  outletId: string;
  businessDate: string;
  salesTotal: number;
  cashSales: number;
  qrisSales: number;
  transactions: number;
  priceMismatch: number;
  gallons: number;
  gallonLiters: number;
};

export async function salesAggregates(tx: Tx, tenantId: string, input: { from: BusinessDate; to: BusinessDate; outletIds?: string[] }): Promise<SalesAggregateRow[]> {
  const where: SQL[] = [eq(posSales.tenantId, tenantId), gte(posSales.businessDate, input.from), lte(posSales.businessDate, input.to)];
  if (input.outletIds?.length) where.push(inArray(posSales.outletId, input.outletIds));
  const rows = await tx
    .select({
      outletId: posSales.outletId,
      businessDate: posSales.businessDate,
      salesTotal: sql<string>`coalesce(sum(case when ${COUNTED_SALE} then ${posSales.total} else 0 end), 0)`,
      cashSales: sql<string>`coalesce(sum(case when ${COUNTED_SALE} and ${posSales.paymentMethod} = 'cash' then ${posSales.total} else 0 end), 0)`,
      qrisSales: sql<string>`coalesce(sum(case when ${COUNTED_SALE} and ${posSales.paymentMethod} = 'qris' then ${posSales.total} else 0 end), 0)`,
      transactions: sql<string>`count(*) filter (where ${posSales.isReversal} = false)`,
      priceMismatch: sql<string>`count(*) filter (where ${posSales.priceMismatch})`,
    })
    .from(posSales)
    .where(and(...where))
    .groupBy(posSales.outletId, posSales.businessDate);
  const lineWhere: SQL[] = [eq(posSaleLines.tenantId, tenantId), gte(posSaleLines.businessDate, input.from), lte(posSaleLines.businessDate, input.to), isNotNull(posSaleLines.gallonSizeL)];
  if (input.outletIds?.length) lineWhere.push(inArray(posSaleLines.outletId, input.outletIds));
  const gallons = await tx
    .select({
      outletId: posSaleLines.outletId,
      businessDate: posSaleLines.businessDate,
      gallons: sql<string>`coalesce(sum(${posSaleLines.quantity}), 0)`,
      liters: sql<string>`coalesce(sum(${posSaleLines.quantity} * ${posSaleLines.gallonSizeL}), 0)`,
    })
    .from(posSaleLines)
    .innerJoin(posSales, eq(posSales.id, posSaleLines.posSaleId))
    .where(and(...lineWhere, COUNTED_SALE))
    .groupBy(posSaleLines.outletId, posSaleLines.businessDate);
  const gMap = new Map(gallons.map((g) => [`${g.outletId}:${g.businessDate}`, g]));
  return rows.map((r) => {
    const g = gMap.get(`${r.outletId}:${r.businessDate}`);
    return {
      outletId: r.outletId,
      businessDate: r.businessDate,
      salesTotal: Number(r.salesTotal),
      cashSales: Number(r.cashSales),
      qrisSales: Number(r.qrisSales),
      transactions: Number(r.transactions),
      priceMismatch: Number(r.priceMismatch),
      gallons: Number(g?.gallons ?? 0),
      gallonLiters: Number(g?.liters ?? 0),
    };
  });
}

export type VoidAggregateRow = { outletId: string; businessDate: string; voidCount: number; voidAmount: number; pendingCount: number; qrisVoidCount: number };

/** Void per outlet per hari (tanggal WIB permintaan void) — US-M6-03 KP-3. */
export async function voidAggregates(tx: Tx, tenantId: string, input: { from: BusinessDate; to: BusinessDate; outletIds?: string[] }): Promise<VoidAggregateRow[]> {
  const { start } = businessDateToUtcRange(input.from);
  const { end } = businessDateToUtcRange(input.to);
  const where: SQL[] = [
    eq(posSales.tenantId, tenantId),
    eq(posSales.isReversal, false),
    gte(posSales.voidRequestedAt, start),
    sql`${posSales.voidRequestedAt} < ${end}`,
    sql`${posSales.status} in ('voided', 'void_pending')`,
  ];
  if (input.outletIds?.length) where.push(inArray(posSales.outletId, input.outletIds));
  const day = sql<string>`to_char(${posSales.voidRequestedAt} at time zone 'Asia/Jakarta', 'YYYY-MM-DD')`;
  const rows = await tx
    .select({
      outletId: posSales.outletId,
      businessDate: day,
      voidCount: sql<string>`count(*)`,
      voidAmount: sql<string>`coalesce(sum(${posSales.total}), 0)`,
      pendingCount: sql<string>`count(*) filter (where ${posSales.status} = 'void_pending')`,
      qrisVoidCount: sql<string>`count(*) filter (where ${posSales.paymentMethod} = 'qris')`,
    })
    .from(posSales)
    .where(and(...where))
    .groupBy(posSales.outletId, day);
  return rows.map((r) => ({
    outletId: r.outletId,
    businessDate: r.businessDate,
    voidCount: Number(r.voidCount),
    voidAmount: Number(r.voidAmount),
    pendingCount: Number(r.pendingCount),
    qrisVoidCount: Number(r.qrisVoidCount),
  }));
}

// =====================================================================================================================
// Pemantauan outlet (/outlet)
// =====================================================================================================================

export type OutletOverviewRow = {
  outlet: Pick<OutletRow, "id" | "code" | "name" | "kind" | "isActive" | "storageCapacityL">;
  openShift: { id: string; operatorName: string | null; openedAt: Date; runningCash: number; overLimit: boolean; syncConflict: boolean } | null;
  today: { salesTotal: number; cashSales: number; qrisSales: number; transactions: number; gallons: number; voidCount: number; voidAmount: number; voidPending: number };
  cashLimit: number;
  voidDailyCount: number;
  pendingSupplies: number;
  waterStockL: number | null;
  overCapacity: boolean;
  stockCountThisWeek: "none" | "submitted" | "approved" | "rejected";
  openConflicts: number;
  pendingReversals: number;
  lateDeposits: number;
};

export async function listOutletsOverview(ctx: ActorContext, opts: { date?: BusinessDate; tx?: Tx } = {}): Promise<{ date: string; rows: OutletOverviewRow[] }> {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const date = opts.date ?? ctxBusinessDate(ctx);
  const list = await tenantOutlets(db, ctx);
  const ids = list.map((o) => o.id);
  const sales = ids.length ? await salesAggregates(db, ctx.tenantId, { from: date, to: date, outletIds: ids }) : [];
  const voids = ids.length ? await voidAggregates(db, ctx.tenantId, { from: date, to: date, outletIds: ids }) : [];
  const reversals = await pendingVoidReversals(db, ctx.tenantId, ids);
  const week = isoWeekLabel(date);
  const rows: OutletOverviewRow[] = [];
  for (const o of list) {
    const settings = await outletPosSettings(db, o, date);
    const [open] = await db
      .select({ shift: shifts, operatorName: employeeName })
      .from(shifts)
      .where(and(eq(shifts.outletId, o.id), eq(shifts.status, "open")))
      .orderBy(asc(shifts.syncConflict), desc(shifts.openedAt))
      .limit(1);
    let openShift: OutletOverviewRow["openShift"] = null;
    if (open) {
      const f = await computeShiftFigures(db, open.shift);
      openShift = {
        id: open.shift.id,
        operatorName: open.operatorName,
        openedAt: open.shift.openedAt,
        runningCash: f.expectedDrawer,
        overLimit: f.expectedDrawer > settings.cashLimit,
        syncConflict: open.shift.syncConflict,
      };
    }
    const s = sales.find((r) => r.outletId === o.id);
    const v = voids.find((r) => r.outletId === o.id);
    const [pending] = await db
      .select({ n: sql<string>`count(*)` })
      .from(waterSupplyReceipts)
      .where(and(eq(waterSupplyReceipts.outletId, o.id), eq(waterSupplyReceipts.status, "arrived")));
    const waterStockL = o.kind === "depot" ? await waterStockNow(db, o.id) : null;
    const [sc] = await db
      .select({ status: stockCounts.status })
      .from(stockCounts)
      .where(and(eq(stockCounts.outletId, o.id), eq(stockCounts.periodLabel, week)))
      .orderBy(desc(stockCounts.startedAt))
      .limit(1);
    const [conf] = await db
      .select({ n: sql<string>`count(*)` })
      .from(shifts)
      .where(and(eq(shifts.outletId, o.id), eq(shifts.syncConflict, true), sql`${shifts.conflictResolvedAt} is null`));
    const lateCutoff = addDays(date, -settings.depositLateDays);
    const [late] = await db
      .select({ n: sql<string>`count(*)` })
      .from(shifts)
      .where(and(eq(shifts.outletId, o.id), eq(shifts.status, "closed"), sql`${shifts.depositStatus} <> 'received'`, sql`${shifts.businessDate} < ${lateCutoff}`));
    rows.push({
      outlet: { id: o.id, code: o.code, name: o.name, kind: o.kind, isActive: o.isActive, storageCapacityL: o.storageCapacityL },
      openShift,
      today: {
        salesTotal: s?.salesTotal ?? 0,
        cashSales: s?.cashSales ?? 0,
        qrisSales: s?.qrisSales ?? 0,
        transactions: s?.transactions ?? 0,
        gallons: s?.gallons ?? 0,
        voidCount: v?.voidCount ?? 0,
        voidAmount: v?.voidAmount ?? 0,
        voidPending: v?.pendingCount ?? 0,
      },
      cashLimit: settings.cashLimit,
      voidDailyCount: settings.voidDailyCount,
      pendingSupplies: Number(pending?.n ?? 0),
      waterStockL,
      overCapacity: waterStockL !== null && o.storageCapacityL !== null && waterStockL > o.storageCapacityL,
      stockCountThisWeek: (sc?.status === "counting" ? "submitted" : sc?.status) ?? "none",
      openConflicts: Number(conf?.n ?? 0),
      pendingReversals: reversals.filter((r) => r.sale.outletId === o.id).length,
      lateDeposits: Number(late?.n ?? 0),
    });
  }
  return { date, rows };
}

// =====================================================================================================================
// Rincian outlet (/outlet/[id])
// =====================================================================================================================

export type ShiftListRow = ShiftRow & { operatorName: string | null };

export async function listShifts(tx: Tx, ctx: ActorContext, input: { outletIds: string[]; from: BusinessDate; to: BusinessDate; limit?: number }): Promise<ShiftListRow[]> {
  if (!input.outletIds.length) return [];
  const rows = await tx
    .select({ shift: shifts, operatorName: employeeName })
    .from(shifts)
    .where(and(eq(shifts.tenantId, ctx.tenantId), inArray(shifts.outletId, input.outletIds), gte(shifts.businessDate, input.from), lte(shifts.businessDate, input.to)))
    .orderBy(desc(shifts.openedAt))
    .limit(input.limit ?? 500);
  return rows.map((r) => ({ ...r.shift, operatorName: r.operatorName }));
}

export async function getOutletDetail(ctx: ActorContext, outletId: string, opts: { date?: BusinessDate; tx?: Tx } = {}) {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const outlet = await loadOutletForOffice(db, ctx, outletId);
  const date = opts.date ?? ctxBusinessDate(ctx);
  const settings = await outletPosSettings(db, outlet, date);
  const shiftsList = await listShifts(db, ctx, { outletIds: [outlet.id], from: addDays(date, -30), to: date, limit: 60 });
  const materials = await consumablesOf(db, outlet.tenantId, outlet.kind === "store" ? "store" : "depot");
  const balances = await stockBalancesOf(
    db,
    outlet.id,
    materials.map((m) => m.id),
  );
  const { start, end } = businessDateToUtcRange(date);
  const sales = await db
    .select()
    .from(posSales)
    .where(and(eq(posSales.outletId, outlet.id), sql`(${posSales.businessDate} = ${date} or (${posSales.voidRequestedAt} >= ${start} and ${posSales.voidRequestedAt} < ${end}))`))
    .orderBy(desc(posSales.soldAt))
    .limit(500);
  const supplies = await db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.outletId, outlet.id)).orderBy(desc(waterSupplyReceipts.createdAt)).limit(30);
  const counts = await db.select().from(stockCounts).where(eq(stockCounts.outletId, outlet.id)).orderBy(desc(stockCounts.startedAt)).limit(12);
  const receipts = await db.select().from(consumableReceipts).where(eq(consumableReceipts.outletId, outlet.id)).orderBy(desc(consumableReceipts.receivedAt)).limit(20);
  const reversals = await pendingVoidReversals(db, ctx.tenantId, [outlet.id]);
  const waterStockL = outlet.kind === "depot" ? await waterStockNow(db, outlet.id) : null;
  const voidsToday = (await voidAggregates(db, ctx.tenantId, { from: date, to: date, outletIds: [outlet.id] }))[0] ?? null;
  const salesToday = (await salesAggregates(db, ctx.tenantId, { from: date, to: date, outletIds: [outlet.id] }))[0] ?? null;
  return {
    outlet,
    date,
    settings,
    shifts: shiftsList,
    stock: materials.map((m) => ({ ...m, ...balances.get(m.id)! })),
    sales,
    supplies,
    stockCounts: counts,
    receipts,
    pendingReversals: reversals.map((r) => ({ sale: r.sale, approvalNumber: r.approval.number, approvedAt: r.approval.decidedAt })),
    waterStockL,
    overCapacity: waterStockL !== null && outlet.storageCapacityL !== null && waterStockL > outlet.storageCapacityL,
    voidsToday,
    salesToday,
  };
}

// =====================================================================================================================
// Rincian shift (/outlet/shift/[id])
// =====================================================================================================================

export async function getShiftDetail(ctx: ActorContext, shiftId: string, opts: { tx?: Tx } = {}) {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const [row] = await db.select({ shift: shifts, operatorName: employeeName }).from(shifts).where(eq(shifts.id, shiftId)).limit(1);
  if (!row || row.shift.tenantId !== ctx.tenantId) throw new NotFoundError("Shift tidak ditemukan.");
  const outlet = await loadOutletForOffice(db, ctx, row.shift.outletId);
  const sales = await db.select().from(posSales).where(eq(posSales.shiftId, shiftId)).orderBy(asc(posSales.soldAt));
  const saleIds = sales.map((s) => s.id);
  const lines = saleIds.length
    ? await db
        .select({ line: posSaleLines, productName: products.name })
        .from(posSaleLines)
        .innerJoin(products, eq(products.id, posSaleLines.productId))
        .where(inArray(posSaleLines.posSaleId, saleIds))
        .orderBy(asc(posSaleLines.lineNo))
    : [];
  const approvals = saleIds.length
    ? await db.select().from(approvalRequests).where(and(eq(approvalRequests.objectType, "pos_sale"), inArray(approvalRequests.objectId, saleIds)))
    : [];
  const stock = await db
    .select({ count: shiftStockCounts, productName: products.name })
    .from(shiftStockCounts)
    .innerJoin(products, eq(products.id, shiftStockCounts.productId))
    .where(eq(shiftStockCounts.shiftId, shiftId))
    .orderBy(asc(shiftStockCounts.phase), asc(products.sortOrder));
  const deps = await db.select().from(deposits).where(eq(deposits.shiftId, shiftId)).orderBy(asc(deposits.createdAt));
  const figures = await computeShiftFigures(db, row.shift);
  const sync = await shiftSyncStatus(db, shiftId);
  return {
    shift: row.shift,
    operatorName: row.operatorName,
    outlet,
    sales: sales.map((s) => ({
      ...s,
      counted: isCountedSale(s),
      lines: lines.filter((l) => l.line.posSaleId === s.id).map((l) => ({ ...l.line, productName: l.productName })),
      approval: approvals.find((a) => a.id === s.voidApprovalId) ?? null,
    })),
    stock: stock.map((s) => ({ ...s.count, productName: s.productName })),
    deposits: deps,
    figures: { ...figures, usage: Object.fromEntries(figures.usage) },
    sync,
  };
}

// =====================================================================================================================
// Laporan
// =====================================================================================================================

export type DailyOutletRow = SalesAggregateRow & { outletCode: string; outletName: string; voidCount: number; voidAmount: number; shiftsClosed: number; depositTotal: number; cashDifference: number };

/** Ringkasan harian per outlet (laporan outlet US-M6-07 KP-5). */
export async function dailyOutletReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; outletId?: string | null }, opts: { tx?: Tx } = {}): Promise<DailyOutletRow[]> {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const list = await tenantOutlets(db, ctx, { outletIds: input.outletId ? [input.outletId] : undefined });
  if (input.outletId && !list.length) throw new NotFoundError("Outlet tidak ditemukan.");
  const ids = list.map((o) => o.id);
  if (!ids.length) return [];
  const sales = await salesAggregates(db, ctx.tenantId, { from: input.from, to: input.to, outletIds: ids });
  const voids = await voidAggregates(db, ctx.tenantId, { from: input.from, to: input.to, outletIds: ids });
  const shiftRows = await db
    .select({
      outletId: shifts.outletId,
      businessDate: shifts.businessDate,
      closed: sql<string>`count(*) filter (where ${shifts.status} = 'closed')`,
      deposit: sql<string>`coalesce(sum(${shifts.depositAmount}), 0)`,
      diff: sql<string>`coalesce(sum(${shifts.cashDifference}), 0)`,
    })
    .from(shifts)
    .where(and(eq(shifts.tenantId, ctx.tenantId), inArray(shifts.outletId, ids), gte(shifts.businessDate, input.from), lte(shifts.businessDate, input.to)))
    .groupBy(shifts.outletId, shifts.businessDate);
  const keys = new Set<string>([...sales.map((s) => `${s.outletId}:${s.businessDate}`), ...voids.map((v) => `${v.outletId}:${v.businessDate}`), ...shiftRows.map((s) => `${s.outletId}:${s.businessDate}`)]);
  const byId = new Map(list.map((o) => [o.id, o]));
  const out: DailyOutletRow[] = [];
  for (const key of keys) {
    const [outletId, businessDate] = key.split(":") as [string, string];
    const s = sales.find((r) => r.outletId === outletId && r.businessDate === businessDate);
    const v = voids.find((r) => r.outletId === outletId && r.businessDate === businessDate);
    const sh = shiftRows.find((r) => r.outletId === outletId && r.businessDate === businessDate);
    const o = byId.get(outletId)!;
    out.push({
      outletId,
      businessDate,
      outletCode: o.code,
      outletName: o.name,
      salesTotal: s?.salesTotal ?? 0,
      cashSales: s?.cashSales ?? 0,
      qrisSales: s?.qrisSales ?? 0,
      transactions: s?.transactions ?? 0,
      priceMismatch: s?.priceMismatch ?? 0,
      gallons: s?.gallons ?? 0,
      gallonLiters: s?.gallonLiters ?? 0,
      voidCount: v?.voidCount ?? 0,
      voidAmount: v?.voidAmount ?? 0,
      shiftsClosed: Number(sh?.closed ?? 0),
      depositTotal: Number(sh?.deposit ?? 0),
      cashDifference: Number(sh?.diff ?? 0),
    });
  }
  return out.sort((a, b) => (a.businessDate === b.businessDate ? a.outletCode.localeCompare(b.outletCode) : b.businessDate.localeCompare(a.businessDate)));
}

export type VoidReportRow = VoidAggregateRow & { outletCode: string; outletName: string; overLimit: boolean };

export async function voidReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; outletId?: string | null }, opts: { tx?: Tx } = {}): Promise<VoidReportRow[]> {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const list = await tenantOutlets(db, ctx, { outletIds: input.outletId ? [input.outletId] : undefined });
  const ids = list.map((o) => o.id);
  if (!ids.length) return [];
  const rows = await voidAggregates(db, ctx.tenantId, { from: input.from, to: input.to, outletIds: ids });
  const out: VoidReportRow[] = [];
  for (const r of rows) {
    const o = list.find((x) => x.id === r.outletId)!;
    const settings = await outletPosSettings(db, o, r.businessDate);
    out.push({ ...r, outletCode: o.code, outletName: o.name, overLimit: r.voidCount > settings.voidDailyCount });
  }
  return out.sort((a, b) => b.businessDate.localeCompare(a.businessDate) || a.outletCode.localeCompare(b.outletCode));
}

export type UsageReportRow = {
  outletId: string;
  outletCode: string;
  outletName: string;
  period: string;
  productId: string;
  productName: string;
  gallonsSold: number;
  expectedUsage: number;
  opnameAdjustment: number;
  shiftDifference: number;
  effectiveUsage: number;
  ratioPerGallon: number | null;
};

function periodKey(date: string, granularity: "week" | "month"): string {
  return granularity === "week" ? isoWeekLabel(date) : date.slice(0, 7);
}

/** Pemakaian bahan vs penjualan per outlet per minggu/bulan dengan rasio bahan per galon (US-M6-04 KP-6). */
export async function usageVsSalesReport(
  ctx: ActorContext,
  input: { from: BusinessDate; to: BusinessDate; outletId?: string | null; granularity?: "week" | "month" },
  opts: { tx?: Tx } = {},
): Promise<UsageReportRow[]> {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const granularity = input.granularity ?? "week";
  const list = await tenantOutlets(db, ctx, { outletIds: input.outletId ? [input.outletId] : undefined, kind: "depot" });
  const ids = list.map((o) => o.id);
  if (!ids.length) return [];
  const sales = await salesAggregates(db, ctx.tenantId, { from: input.from, to: input.to, outletIds: ids });
  const ledger = await db
    .select({ outletId: stockLedger.outletId, productId: stockLedger.productId, kind: stockLedger.kind, businessDate: stockLedger.businessDate, qty: stockLedger.quantity })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.tenantId, ctx.tenantId),
        inArray(stockLedger.outletId, ids),
        gte(stockLedger.businessDate, input.from),
        lte(stockLedger.businessDate, input.to),
        sql`${stockLedger.kind} in ('consumption', 'consumption_reversal', 'adjustment')`,
      ),
    );
  const diffs = await db
    .select({ outletId: shiftStockCounts.outletId, productId: shiftStockCounts.productId, businessDate: shifts.businessDate, diff: shiftStockCounts.difference })
    .from(shiftStockCounts)
    .innerJoin(shifts, eq(shifts.id, shiftStockCounts.shiftId))
    .where(
      and(
        eq(shiftStockCounts.tenantId, ctx.tenantId),
        inArray(shiftStockCounts.outletId, ids),
        eq(shiftStockCounts.phase, "closing"),
        gte(shifts.businessDate, input.from),
        lte(shifts.businessDate, input.to),
      ),
    );
  const out = new Map<string, UsageReportRow>();
  const materialsByTenant = await consumablesOf(db, ctx.tenantId, "depot");
  const matName = new Map(materialsByTenant.map((m) => [m.id, m.name]));
  const gallonsBy = new Map<string, number>();
  for (const s of sales) {
    const k = `${s.outletId}|${periodKey(s.businessDate, granularity)}`;
    gallonsBy.set(k, (gallonsBy.get(k) ?? 0) + s.gallons);
  }
  const ensure = (outletId: string, period: string, productId: string) => {
    const k = `${outletId}|${period}|${productId}`;
    let row = out.get(k);
    if (!row) {
      const o = list.find((x) => x.id === outletId)!;
      row = {
        outletId,
        outletCode: o.code,
        outletName: o.name,
        period,
        productId,
        productName: matName.get(productId) ?? productId,
        gallonsSold: gallonsBy.get(`${outletId}|${period}`) ?? 0,
        expectedUsage: 0,
        opnameAdjustment: 0,
        shiftDifference: 0,
        effectiveUsage: 0,
        ratioPerGallon: null,
      };
      out.set(k, row);
    }
    return row;
  };
  for (const l of ledger) {
    const row = ensure(l.outletId, periodKey(l.businessDate, granularity), l.productId);
    if (l.kind === "adjustment") row.opnameAdjustment += l.qty;
    else row.expectedUsage += -l.qty;
  }
  for (const d of diffs) {
    if (d.diff === null) continue;
    ensure(d.outletId, periodKey(d.businessDate, granularity), d.productId).shiftDifference += d.diff;
  }
  for (const row of out.values()) {
    row.effectiveUsage = row.expectedUsage - row.opnameAdjustment;
    row.ratioPerGallon = row.gallonsSold > 0 ? Math.round((row.effectiveUsage / row.gallonsSold) * 1000) / 1000 : null;
  }
  return [...out.values()].sort((a, b) => b.period.localeCompare(a.period) || a.outletCode.localeCompare(b.outletCode) || a.productName.localeCompare(b.productName));
}

/** Kartu stok per bahan per outlet (US-M6-04 KP-1). */
export async function stockCardReport(
  ctx: ActorContext,
  input: { outletId: string; productId?: string | null; from: BusinessDate; to: BusinessDate },
  opts: { tx?: Tx } = {},
) {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const outlet = await loadOutletForOffice(db, ctx, input.outletId);
  const rows = await db
    .select({ entry: stockLedger, productName: products.name })
    .from(stockLedger)
    .innerJoin(products, eq(products.id, stockLedger.productId))
    .where(
      and(
        eq(stockLedger.outletId, outlet.id),
        ...(input.productId ? [eq(stockLedger.productId, input.productId)] : []),
        gte(stockLedger.businessDate, input.from),
        lte(stockLedger.businessDate, input.to),
      ),
    )
    .orderBy(asc(stockLedger.occurredAt), asc(stockLedger.createdAt));
  return { outlet, rows: rows.map((r) => ({ ...r.entry, productName: r.productName })) };
}

export async function waterBalanceReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; outletId?: string | null }, opts: { tx?: Tx } = {}) {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const list = await tenantOutlets(db, ctx, { outletIds: input.outletId ? [input.outletId] : undefined, kind: "depot" });
  if (!list.length) return [];
  return waterBalancesFor(
    db,
    ctx.tenantId,
    input.from,
    input.to,
    list.map((o) => o.id),
  );
}

export async function waterSupplyReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; outletId?: string | null }, opts: { tx?: Tx } = {}) {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const list = await tenantOutlets(db, ctx, { outletIds: input.outletId ? [input.outletId] : undefined, kind: "depot" });
  const ids = list.map((o) => o.id);
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(waterSupplyReceipts)
    .where(and(eq(waterSupplyReceipts.tenantId, ctx.tenantId), inArray(waterSupplyReceipts.outletId, ids), gte(waterSupplyReceipts.businessDate, input.from), lte(waterSupplyReceipts.businessDate, input.to)))
    .orderBy(desc(waterSupplyReceipts.businessDate));
  return rows.map((r) => ({ ...r, outletCode: list.find((o) => o.id === r.outletId)!.code, outletName: list.find((o) => o.id === r.outletId)!.name }));
}

export async function shiftReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; outletId?: string | null }, opts: { tx?: Tx } = {}) {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const list = await tenantOutlets(db, ctx, { outletIds: input.outletId ? [input.outletId] : undefined });
  const rows = await listShifts(db, ctx, { outletIds: list.map((o) => o.id), from: input.from, to: input.to, limit: 5000 });
  return rows.map((r) => ({ ...r, outletCode: list.find((o) => o.id === r.outletId)!.code, outletName: list.find((o) => o.id === r.outletId)!.name }));
}

export async function salesReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; outletId?: string | null }, opts: { tx?: Tx } = {}) {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const list = await tenantOutlets(db, ctx, { outletIds: input.outletId ? [input.outletId] : undefined });
  const ids = list.map((o) => o.id);
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(posSales)
    .where(and(eq(posSales.tenantId, ctx.tenantId), inArray(posSales.outletId, ids), gte(posSales.businessDate, input.from), lte(posSales.businessDate, input.to)))
    .orderBy(desc(posSales.soldAt))
    .limit(20_000);
  return rows.map((r) => ({ ...r, outletCode: list.find((o) => o.id === r.outletId)!.code, counted: isCountedSale(r) }));
}

export async function stockCountReport(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; outletId?: string | null }, opts: { tx?: Tx } = {}) {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const list = await tenantOutlets(db, ctx, { outletIds: input.outletId ? [input.outletId] : undefined });
  const ids = list.map((o) => o.id);
  if (!ids.length) return [];
  const { start } = businessDateToUtcRange(input.from);
  const { end } = businessDateToUtcRange(input.to);
  const rows = await db
    .select({ line: stockCountLines, count: stockCounts, productName: products.name })
    .from(stockCountLines)
    .innerJoin(stockCounts, eq(stockCounts.id, stockCountLines.stockCountId))
    .innerJoin(products, eq(products.id, stockCountLines.productId))
    .where(and(eq(stockCounts.tenantId, ctx.tenantId), inArray(stockCounts.outletId, ids), gte(stockCounts.startedAt, start), sql`${stockCounts.startedAt} < ${end}`))
    .orderBy(desc(stockCounts.startedAt));
  return rows.map((r) => ({ ...r.line, periodLabel: r.count.periodLabel, status: r.count.status, outletCode: list.find((o) => o.id === r.count.outletId)!.code, productName: r.productName, startedAt: r.count.startedAt }));
}

/** Shift konflik yang belum ditinjau (Admin Keuangan). */
export async function listShiftConflicts(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const ids = (await tenantOutlets(db, ctx)).map((o) => o.id);
  if (!ids.length) return [];
  return db
    .select({ shift: shifts, operatorName: employeeName, outletName: outlets.name })
    .from(shifts)
    .innerJoin(outlets, eq(outlets.id, shifts.outletId))
    .where(and(inArray(shifts.outletId, ids), eq(shifts.syncConflict, true), sql`${shifts.conflictResolvedAt} is null`))
    .orderBy(desc(shifts.openedAt));
}

/** Saldo stok semua bahan per outlet (ringkas). */
export async function stockBalanceRows(tx: Tx, outletId: string) {
  return tx
    .select({ balance: stockBalances, productName: products.name, unit: products.unit })
    .from(stockBalances)
    .innerJoin(products, eq(products.id, stockBalances.productId))
    .where(eq(stockBalances.outletId, outletId))
    .orderBy(asc(products.sortOrder));
}

/** Daftar outlet tenant pelaku (untuk filter laporan kantor). */
export async function listTenantOutlets(ctx: ActorContext, opts: { tx?: Tx; kind?: "depot" | "store" } = {}): Promise<Pick<OutletRow, "id" | "code" | "name" | "kind" | "isActive">[]> {
  await authorizeOutletRead(ctx, opts.tx);
  const db = opts.tx ?? getDb();
  const rows = await tenantOutlets(db, ctx, { kind: opts.kind });
  return rows.map((o) => ({ id: o.id, code: o.code, name: o.name, kind: o.kind, isActive: o.isActive }));
}

export function defaultRange(ctx: ActorContext, days = 7): { from: BusinessDate; to: BusinessDate } {
  const to = ctxBusinessDate(ctx);
  return { from: addDays(to, -(days - 1)), to };
}

