/**
 * M8 — kueri layar kantor & laporan: rincian satu sumber satu hari (produksi, pembacaan + foto, pengisian + selisih rit,
 * pasokan tiga angka, neraca, tandon, penyesuaian meter), daftar neraca harian, neraca bulanan (US-M8-04 KP-4), dan
 * daftar kerja (produksi bertanda, neraca menunggu tindakan, pengisian tanpa rit).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";

import { dailyProductions, employees, meterAdjustments, meterReadings, users, waterBalances, waterMeters, waterSources } from "@/db/schema";
import { addDays, firstDayOfMonth, lastDayOfMonth, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { NotFoundError, ValidationError } from "@/server/core/errors";
import { assertSourceScope, authorize, authorizeAny, inSourceScope } from "@/server/core/rbac";

import { loadSource, m8Rules, pct2, type M8Rules, type WaterSourceRow } from "./common";
import { balanceOf, balancesNeedingAction, type WaterBalanceRow } from "./balance";
import { dayKey, fillTotalsByDay } from "./fill-totals";
import { listFills, openFillIssues, type FillListRow } from "./fills";
import { metersForDate, productionOf, productionsAwaitingVerification, type DailyProductionRow, type MeterReadingRow, type ProductionMeterDetail } from "./production";
import { supplyDifferenceBySourceDay, supplyRows, type SupplyRow } from "./supply";
import { tankLevelsInRange, type TankLevelRow } from "./tank";

export const DAY_READ_PERMISSIONS = ["m8.water_balance.read", "m8.production.read", "m8.truck_fill.read"] as const;

export type ReadingView = MeterReadingRow & { meterCode: string; recordedByName: string | null };

export type SourceDayDetail = {
  source: WaterSourceRow;
  date: BusinessDate;
  rules: M8Rules;
  production: DailyProductionRow | null;
  productionDetail: ProductionMeterDetail[];
  readings: ReadingView[];
  fills: FillListRow[];
  supplies: SupplyRow[];
  balance: WaterBalanceRow | null;
  tankLevels: TankLevelRow[];
  adjustments: (typeof meterAdjustments.$inferSelect)[];
};

/** Rincian satu sumber satu hari (`/produksi/neraca-air/rincian`). */
export async function sourceDayDetail(ctx: ActorContext, input: { sourceId: string; date: BusinessDate }, opts: { tx?: Tx } = {}): Promise<SourceDayDetail> {
  await authorizeAny(ctx, DAY_READ_PERMISSIONS, { tx: opts.tx, objectType: "water_source", objectId: input.sourceId });
  const tx = opts.tx ?? getDb();
  const source = await loadSource(tx, input.sourceId);
  if (source.tenantId !== ctx.tenantId) throw new NotFoundError("Sumber air tidak ditemukan.");
  await assertSourceScope(tx, ctx, source.id);
  const date = input.date;
  const meters = await tx.select().from(waterMeters).where(eq(waterMeters.waterSourceId, source.id));
  const meterCode = new Map(meters.map((m) => [m.id, m.code]));
  const readingRows = await tx
    .select({ r: meterReadings, name: employees.fullName })
    .from(meterReadings)
    .leftJoin(users, eq(users.id, meterReadings.recordedBy))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(meterReadings.waterSourceId, source.id), gte(meterReadings.businessDate, addDays(date, -1)), lte(meterReadings.businessDate, addDays(date, 1))))
    .orderBy(asc(meterReadings.businessDate), asc(meterReadings.readAt));
  const fills = await listFills(tx, ctx.tenantId, { from: date, to: date, sourceId: source.id });
  const supplyTrips = fills.filter((f) => f.isDepotSupply && f.tripId).map((f) => f.tripId!);
  const production = await productionOf(tx, source.id, date);
  return {
    source,
    date,
    rules: await m8Rules(tx, date, source.tenantId),
    production,
    productionDetail: ((production?.detail ?? []) as unknown as ProductionMeterDetail[]) ?? [],
    readings: readingRows.map((x) => ({ ...x.r, meterCode: meterCode.get(x.r.waterMeterId) ?? "—", recordedByName: x.name })),
    fills,
    supplies: supplyTrips.length ? await supplyRows(tx, ctx.tenantId, { from: date, to: date, tripIds: supplyTrips }) : [],
    balance: await balanceOf(tx, source.id, date),
    tankLevels: await tankLevelsInRange(tx, source.id, date, date),
    adjustments: await tx.select().from(meterAdjustments).where(and(eq(meterAdjustments.waterSourceId, source.id), eq(meterAdjustments.businessDate, date))),
  };
}

export type BalanceListRow = WaterBalanceRow & { sourceCode: string; sourceName: string; productionStatus: DailyProductionRow["status"] | null; productionFlagged: boolean };

/** Daftar neraca harian (terbaru dulu) — `m8.water_balance.read`. */
export async function listWaterBalances(ctx: ActorContext, input: { from: BusinessDate; to: BusinessDate; sourceId?: string | null; status?: string | null }, opts: { tx?: Tx } = {}): Promise<BalanceListRow[]> {
  await authorize(ctx, "m8.water_balance.read", { tx: opts.tx });
  if (input.to < input.from) throw ValidationError.field("to", "Tanggal akhir tidak boleh sebelum tanggal awal.");
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ b: waterBalances, code: waterSources.code, name: waterSources.name, pStatus: dailyProductions.status, pFlag: dailyProductions.flaggedForVerification })
    .from(waterBalances)
    .innerJoin(waterSources, eq(waterSources.id, waterBalances.waterSourceId))
    .leftJoin(dailyProductions, and(eq(dailyProductions.waterSourceId, waterBalances.waterSourceId), eq(dailyProductions.businessDate, waterBalances.businessDate)))
    .where(
      and(
        eq(waterBalances.tenantId, ctx.tenantId),
        gte(waterBalances.businessDate, input.from),
        lte(waterBalances.businessDate, input.to),
        ...(input.sourceId ? [eq(waterBalances.waterSourceId, input.sourceId)] : []),
        ...(input.status ? [eq(waterBalances.status, input.status as WaterBalanceRow["status"])] : []),
      ),
    )
    .orderBy(desc(waterBalances.businessDate), asc(waterSources.code));
  return rows
    .filter((r) => inSourceScope(ctx, r.b.waterSourceId, r.b.tenantId))
    .map((r) => ({ ...r.b, sourceCode: r.code, sourceName: r.name, productionStatus: r.pStatus, productionFlagged: !!r.pFlag }));
}

export type MonthlyBalanceRow = {
  month: string;
  sourceId: string | null;
  sourceCode: string;
  sourceName: string;
  daysWithProduction: number;
  producedL: number;
  customerFillsL: number;
  depotSupplyL: number;
  returnedL: number;
  lossL: number;
  lossPct: number | null;
  avgProducedPerDayL: number | null;
  avgLossPerDayL: number | null;
  /** Selisih pasokan depot (diisi − diterima) — masuk perhitungan susut (US-M8-03 KP-2). */
  supplyDifferenceL: number;
  incompleteDays: number;
  overThresholdDays: number;
  negativeDays: number;
};

/** US-M8-04 KP-4: neraca bulanan per sumber (+ gabungan): produksi, pengisian pelanggan, pasokan depot, susut, rata-rata/hari. */
export async function computeMonthlyBalance(tx: Tx, tenantId: string, month: string, today: BusinessDate, sourceId?: string | null): Promise<MonthlyBalanceRow[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw ValidationError.field("month", "Bulan harus berformat YYYY-MM.");
  const first = firstDayOfMonth(`${month}-01`);
  const lastOfMonth = lastDayOfMonth(first);
  const last = lastOfMonth < today ? lastOfMonth : today;
  const sources = (await tx.select().from(waterSources).where(eq(waterSources.tenantId, tenantId)).orderBy(asc(waterSources.code))).filter((s) =>
    sourceId ? s.id === sourceId : true,
  );
  if (last < first || sources.length === 0) return [];
  const ids = sources.map((s) => s.id);
  const totals = await fillTotalsByDay(tx, ids, first, last);
  const prods = await tx
    .select()
    .from(dailyProductions)
    .where(and(inArray(dailyProductions.waterSourceId, ids), gte(dailyProductions.businessDate, first), lte(dailyProductions.businessDate, last)));
  const bals = await tx
    .select()
    .from(waterBalances)
    .where(and(inArray(waterBalances.waterSourceId, ids), gte(waterBalances.businessDate, first), lte(waterBalances.businessDate, last)));
  const supplyDiff = await supplyDifferenceBySourceDay(tx, tenantId, first, last);
  const out: MonthlyBalanceRow[] = [];
  const all: MonthlyBalanceRow = {
    month,
    sourceId: null,
    sourceCode: "GAB",
    sourceName: "Gabungan semua sumber",
    daysWithProduction: 0,
    producedL: 0,
    customerFillsL: 0,
    depotSupplyL: 0,
    returnedL: 0,
    lossL: 0,
    lossPct: null,
    avgProducedPerDayL: null,
    avgLossPerDayL: null,
    supplyDifferenceL: 0,
    incompleteDays: 0,
    overThresholdDays: 0,
    negativeDays: 0,
  };
  let allLossBase = 0;
  for (const s of sources) {
    const sp = prods.filter((p) => p.waterSourceId === s.id && p.status !== "incomplete" && p.producedL !== null);
    const sb = bals.filter((b) => b.waterSourceId === s.id);
    let customer = 0;
    let depot = 0;
    let returned = 0;
    let diff = 0;
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const t = totals.get(dayKey(s.id, d));
      customer += t?.customerL ?? 0;
      depot += t?.depotL ?? 0;
      returned += t?.returnedL ?? 0;
      diff += supplyDiff.get(`${s.id}:${d}`) ?? 0;
    }
    const produced = sp.reduce((a, p) => a + (p.producedL ?? 0), 0);
    const lossRows = sb.filter((b) => b.lossL !== null && !b.isIncomplete);
    const loss = lossRows.reduce((a, b) => a + (b.lossL ?? 0), 0);
    const lossBase = lossRows.reduce((a, b) => a + (b.producedL ?? 0), 0);
    const row: MonthlyBalanceRow = {
      month,
      sourceId: s.id,
      sourceCode: s.code,
      sourceName: s.name,
      daysWithProduction: sp.length,
      producedL: produced,
      customerFillsL: customer,
      depotSupplyL: depot,
      returnedL: returned,
      lossL: loss,
      lossPct: pct2(loss, lossBase),
      avgProducedPerDayL: sp.length ? Math.round(produced / sp.length) : null,
      avgLossPerDayL: lossRows.length ? Math.round(loss / lossRows.length) : null,
      supplyDifferenceL: diff,
      incompleteDays: sb.filter((b) => b.isIncomplete).length,
      overThresholdDays: sb.filter((b) => ["over_threshold", "investigating"].includes(b.status) || (b.status === "done" && (b.lossL ?? 0) > 0)).length,
      negativeDays: sb.filter((b) => (b.lossL ?? 0) < 0).length,
    };
    out.push(row);
    all.daysWithProduction = Math.max(all.daysWithProduction, row.daysWithProduction);
    all.producedL += row.producedL;
    all.customerFillsL += row.customerFillsL;
    all.depotSupplyL += row.depotSupplyL;
    all.returnedL += row.returnedL;
    all.lossL += row.lossL;
    all.supplyDifferenceL += row.supplyDifferenceL;
    all.incompleteDays += row.incompleteDays;
    all.overThresholdDays += row.overThresholdDays;
    all.negativeDays += row.negativeDays;
    allLossBase += lossBase;
  }
  if (sources.length > 1) {
    all.lossPct = pct2(all.lossL, allLossBase);
    const days = Math.max(1, all.daysWithProduction);
    all.avgProducedPerDayL = all.daysWithProduction ? Math.round(all.producedL / days) : null;
    all.avgLossPerDayL = all.daysWithProduction ? Math.round(all.lossL / days) : null;
    out.push(all);
  }
  return out;
}

/** Kantor: neraca bulanan (izin `m8.water_balance.read`). */
export async function monthlyWaterBalance(ctx: ActorContext, input: { month: string; sourceId?: string | null }, opts: { tx?: Tx } = {}): Promise<MonthlyBalanceRow[]> {
  await authorize(ctx, "m8.water_balance.read", { tx: opts.tx });
  return computeMonthlyBalance(opts.tx ?? getDb(), ctx.tenantId, input.month, ctxBusinessDate(ctx), input.sourceId ?? null);
}

export type ProductionWorklist = {
  flaggedProductions: (DailyProductionRow & { sourceName: string })[];
  balances: (WaterBalanceRow & { sourceName: string })[];
  fillIssues: number;
};

/** Daftar kerja produksi (kartu ringkas di halaman kantor). */
export async function productionWorklist(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<ProductionWorklist> {
  await authorizeAny(ctx, DAY_READ_PERMISSIONS, { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const names = new Map((await tx.select({ id: waterSources.id, name: waterSources.name }).from(waterSources).where(eq(waterSources.tenantId, ctx.tenantId))).map((s) => [s.id, s.name]));
  const flagged = await productionsAwaitingVerification(tx, ctx.tenantId);
  const balances = await balancesNeedingAction(tx, ctx.tenantId);
  const issues = await openFillIssues(tx, ctx.tenantId);
  return {
    flaggedProductions: flagged.map((p) => ({ ...p, sourceName: names.get(p.waterSourceId) ?? "—" })),
    balances: balances.map((b) => ({ ...b, sourceName: names.get(b.waterSourceId) ?? "—" })),
    fillIssues: issues.length,
  };
}

/** Sumber air tenant (pilihan filter layar kantor). */
export async function sourceOptions(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<{ id: string; code: string; name: string; dailyCapacityL: number }[]> {
  const tx = opts.tx ?? getDb();
  const rows = await tx.select().from(waterSources).where(eq(waterSources.tenantId, ctx.tenantId)).orderBy(asc(waterSources.code));
  return rows.filter((s) => inSourceScope(ctx, s.id, s.tenantId)).map((s) => ({ id: s.id, code: s.code, name: s.name, dailyCapacityL: s.dailyCapacityL }));
}

/** Meter aktif sumber pada tanggal (untuk formulir koreksi). */
export async function activeMetersOf(tx: Tx, sourceId: string, date: BusinessDate) {
  return metersForDate(tx, sourceId, date);
}
