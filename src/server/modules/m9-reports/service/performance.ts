/**
 * M9 — Kinerja per sopir/truk dan per depot/operator (US-M9-05; FR-M9-05, BR-12, BR-25, KPI-07). Hanya pemilik
 * (`m9.performance.read`); sopir/operator melihat kinerjanya sendiri di aplikasinya (US-M3-07 KP-6, US-M6-06 KP-6).
 *
 * Satu definisi: rit per truk dari `metrics.tripsDaily` (tanggal jadwal), omzet/galon dari `metrics.gallonsDaily`,
 * void dari M6 `voidAggregates`, selisih & deret hari tanpa selisih dari M4 (`discrepancyHistory`), jarak tempuh dari
 * ringkasan harian M12 (`truck_day_summaries`), neraca air outlet dari M6 `waterBalancesFor`.
 * Peringkat hanya antar peran yang sebanding (sopir dengan sopir, operator depot dengan operator depot, kasir toko
 * dengan kasir toko) dan menampilkan zona/rute agar adil (KP-3).
 */
import "server-only";

import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { customerAddresses, deposits, discrepancies, employees, fleetEvents, orders, outlets, shifts, tariffZones, tripExpenses, trips, truckDaySummaries, trucks, users } from "@/db/schema";
import { label } from "@/lib/labels";
import { businessDateToUtcRange, lastDayOfMonth, parseHourMinute, toWibParts, type BusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { parseInput } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { authorize } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";
import * as m6 from "@/server/modules/m6-pos";
import * as m12 from "@/server/modules/m12-fleet";
import * as p2 from "@/server/modules/p2-customer";

import { gallonsDaily, sumTrips, tripsDaily } from "../metrics";
import { performanceSchema } from "../schemas";
import { reportRules } from "./h0";

export type DriverPerformance = {
  employeeId: string;
  name: string;
  userId: string | null;
  truckCodes: string[];
  zones: string[];
  scheduled: number;
  completed: number;
  failed: number;
  failedByReason: Record<string, number>;
  onTime: number;
  onTimeEligible: number;
  partialVolume: number;
  deviationOver200m: number;
  deviationOver1km: number;
  /** Pola penyimpangan lokasi M12 (kejadian lokasi Selesai/GPS tak konsisten per sopir) — US-M12-04, B-44. */
  locationSourceInconsistent: number;
  br25Events: number;
  br25Explained: number;
  br25Notes: string[];
  discrepancyCount: number;
  discrepancyValue: number;
  lateDeposits: number;
  distanceKm: number;
  tripExpenses: number;
  daysWithoutDiscrepancy: number | null;
  completionPct: number | null;
  onTimePct: number | null;
  /** Penilaian pelanggan aplikasi (P2 `ratingAggregates`, B-66): jumlah, rata-rata (1–5), jumlah nilai ≤ 2. */
  ratingCount: number;
  ratingAverage: number | null;
  lowRatings: number;
  rank: number;
};

export type TruckPerformance = {
  truckId: string;
  code: string;
  scheduled: number;
  completed: number;
  failed: number;
  internalCompleted: number;
  distanceKm: number;
  tripExpenses: number;
  completionPct: number | null;
  /** Penilaian pelanggan aplikasi per truk (P2, B-66). */
  ratingCount: number;
  ratingAverage: number | null;
  lowRatings: number;
  /** Keluhan pelanggan aplikasi pada bulan itu (P2 `complaintMonthlyReport`, B-66) + rincian per jenis. */
  complaintCount: number;
  complaintKinds: Record<string, number>;
};

/** Ringkasan umpan balik pelanggan aplikasi bulan itu (P2, B-66). */
export type CustomerFeedbackSummary = {
  ratingCount: number;
  ratingAverage: number | null;
  complaints: number;
  openComplaints: number;
  complaintsWithoutTruck: number;
  byKind: { kind: string; label: string; count: number; open: number }[];
};

export type OutletPerformance = {
  outletId: string;
  code: string;
  name: string;
  kind: "depot" | "store";
  gallons: number;
  gallonsPerDay: number;
  transactions: number;
  sales: number;
  voidCount: number;
  voidValue: number;
  cashDifferenceCount: number;
  cashDifferenceValue: number;
  stockDifferenceCount: number;
  lateDeposits: number;
  cashOverLimit: number;
  supplyReceivedL: number | null;
  waterExcessL: number | null;
  waterExcessPct: number | null;
};

export type OperatorPerformance = {
  userId: string;
  employeeId: string | null;
  name: string;
  group: "depot_operator" | "store_cashier";
  groupLabel: string;
  outlets: string[];
  shifts: number;
  gallons: number;
  gallonsPerDay: number;
  transactions: number;
  voidCount: number;
  voidValue: number;
  cashDifferenceCount: number;
  cashDifferenceValue: number;
  stockDifferenceCount: number;
  lateDeposits: number;
  cashOverLimit: number;
  daysWithoutDiscrepancy: number | null;
  rank: number;
};

export type PerformanceReport = {
  month: string;
  from: BusinessDate;
  to: BusinessDate;
  onTimeWindowMinutes: number;
  drivers: DriverPerformance[];
  trucks: TruckPerformance[];
  outlets: OutletPerformance[];
  operators: OperatorPerformance[];
  customerFeedback: CustomerFeedbackSummary;
};

const pct = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
const n = (v: unknown) => Number(v ?? 0);

function rankBy<T extends { rank: number }>(rows: T[], key: (r: T) => number[]): T[] {
  const sorted = [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return 0;
  });
  sorted.forEach((r, i) => (r.rank = i + 1));
  return sorted;
}

/** Laporan kinerja satu bulan (tanpa otorisasi; pemanggil berizin). */
export async function computePerformance(tx: Tx, ctx: ActorContext, month: string): Promise<PerformanceReport> {
  const tenantId = ctx.tenantId;
  const from = `${month}-01`;
  const monthEnd = lastDayOfMonth(from);
  const today = toWibParts(ctx.now).businessDate;
  const to = monthEnd < today ? monthEnd : today;
  const rules = await reportRules(tx, to, tenantId);
  const window = rules.on_time_window_minutes;
  const { start } = businessDateToUtcRange(from);
  const { end } = businessDateToUtcRange(to);

  // ---------------------------------------------------------------- Sopir (per pengemudi pelaksana rit)
  const tripRows = await tx
    .select({
      t: trips,
      truckCode: trucks.code,
      requestedDate: orders.requestedDate,
      requestedTime: orders.requestedTime,
      zone: tariffZones.name,
    })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .leftJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
    .leftJoin(tariffZones, eq(tariffZones.id, customerAddresses.tariffZoneId))
    .where(and(eq(trips.tenantId, tenantId), isNotNull(trips.driverEmployeeId), gte(trips.scheduledDate, from), lte(trips.scheduledDate, to)));
  const drivers = new Map<string, DriverPerformance>();
  const driverTruckDays = new Map<string, Set<string>>();
  const zonesByDriver = new Map<string, Map<string, number>>();
  for (const { t, truckCode, requestedDate, requestedTime, zone } of tripRows) {
    const id = t.driverEmployeeId!;
    const d = drivers.get(id) ?? {
      employeeId: id,
      name: "",
      userId: t.driverUserId,
      truckCodes: [],
      zones: [],
      scheduled: 0,
      completed: 0,
      failed: 0,
      failedByReason: {},
      onTime: 0,
      onTimeEligible: 0,
      partialVolume: 0,
      deviationOver200m: 0,
      deviationOver1km: 0,
      locationSourceInconsistent: 0,
      ratingCount: 0,
      ratingAverage: null,
      lowRatings: 0,
      br25Events: 0,
      br25Explained: 0,
      br25Notes: [],
      discrepancyCount: 0,
      discrepancyValue: 0,
      lateDeposits: 0,
      distanceKm: 0,
      tripExpenses: 0,
      daysWithoutDiscrepancy: null,
      completionPct: null,
      onTimePct: null,
      rank: 0,
    };
    if (!d.userId && t.driverUserId) d.userId = t.driverUserId;
    if (truckCode && !d.truckCodes.includes(truckCode)) d.truckCodes.push(truckCode);
    if (t.publishedAt) d.scheduled++;
    if (t.status === "completed") {
      d.completed++;
      if (t.partialVolumeReason || (t.deliveredVolumeL !== null && t.deliveredVolumeL < t.plannedVolumeL)) d.partialVolume++;
      if (t.locationDeviation === "level1") d.deviationOver200m++;
      if (t.locationDeviation === "level2") {
        d.deviationOver200m++;
        d.deviationOver1km++;
      }
      if (requestedTime && t.completedAt) {
        d.onTimeEligible++;
        const wanted = parseHourMinute(requestedTime.slice(0, 5));
        const doneParts = toWibParts(t.completedAt);
        const sameDay = doneParts.businessDate === requestedDate;
        const doneMin = doneParts.hour * 60 + doneParts.minute;
        if (sameDay && Math.abs(doneMin - wanted) <= window) d.onTime++;
      }
    }
    if (t.status === "failed") {
      d.failed++;
      const r = t.failReason ? label("trip_fail_reason", t.failReason) : "Tanpa alasan";
      d.failedByReason[r] = (d.failedByReason[r] ?? 0) + 1;
    }
    if (t.truckId) {
      const set = driverTruckDays.get(id) ?? new Set<string>();
      set.add(`${t.truckId}|${t.scheduledDate}`);
      driverTruckDays.set(id, set);
    }
    if (zone) {
      const zm = zonesByDriver.get(id) ?? new Map<string, number>();
      zm.set(zone, (zm.get(zone) ?? 0) + 1);
      zonesByDriver.set(id, zm);
    }
    drivers.set(id, d);
  }
  const empIds = [...drivers.keys()];
  const names = empIds.length ? await tx.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, empIds)) : [];
  for (const nme of names) drivers.get(nme.id)!.name = nme.name;
  const userOfEmployee = empIds.length ? await tx.select({ id: users.id, employeeId: users.employeeId }).from(users).where(inArray(users.employeeId, empIds)) : [];
  for (const u of userOfEmployee) if (u.employeeId && drivers.get(u.employeeId) && !drivers.get(u.employeeId)!.userId) drivers.get(u.employeeId)!.userId = u.id;
  for (const [id, zm] of zonesByDriver) drivers.get(id)!.zones = [...zm.entries()].sort((a, b) => b[1] - a[1]).map(([z]) => z).slice(0, 3);

  // Jarak tempuh (M12) — hari-truk yang dikemudikan sopir.
  const dist = await tx
    .select({ truckId: truckDaySummaries.truckId, date: truckDaySummaries.businessDate, meters: truckDaySummaries.distanceM })
    .from(truckDaySummaries)
    .innerJoin(trucks, eq(trucks.id, truckDaySummaries.truckId))
    .where(and(eq(trucks.tenantId, tenantId), gte(truckDaySummaries.businessDate, from), lte(truckDaySummaries.businessDate, to)));
  const distMap = new Map(dist.map((r) => [`${r.truckId}|${r.date}`, n(r.meters)]));
  for (const [id, set] of driverTruckDays) {
    let m = 0;
    for (const k of set) m += distMap.get(k) ?? 0;
    drivers.get(id)!.distanceKm = Math.round(m / 100) / 10;
  }
  // Kejadian BR-25 & keterangannya (M12).
  const userIds = [...drivers.values()].map((d) => d.userId).filter((x): x is string => !!x);
  if (userIds.length) {
    const evs = await tx
      .select({ userId: fleetEvents.userId, explanation: fleetEvents.explanation })
      .from(fleetEvents)
      .where(and(eq(fleetEvents.tenantId, tenantId), eq(fleetEvents.requiresExplanation, true), inArray(fleetEvents.userId, userIds), gte(fleetEvents.businessDate, from), lte(fleetEvents.businessDate, to)));
    for (const d of drivers.values()) {
      const mine = evs.filter((e) => e.userId === d.userId);
      d.br25Events = mine.length;
      d.br25Explained = mine.filter((e) => !!e.explanation).length;
      d.br25Notes = mine.map((e) => e.explanation).filter((x): x is string => !!x).slice(0, 3);
    }
    const exp = await tx
      .select({ userId: tripExpenses.driverUserId, total: sql<string>`coalesce(sum(${tripExpenses.amount}), 0)` })
      .from(tripExpenses)
      .where(and(eq(tripExpenses.tenantId, tenantId), eq(tripExpenses.status, "accepted"), inArray(tripExpenses.driverUserId, userIds), gte(tripExpenses.businessDate, from), lte(tripExpenses.businessDate, to)))
      .groupBy(tripExpenses.driverUserId);
    for (const e of exp) for (const d of drivers.values()) if (d.userId === e.userId) d.tripExpenses = n(e.total);
  }
  // Pola penyimpangan lokasi (M12, B-44) — pelaku tanpa izin kejadian armada: kolom tetap 0.
  try {
    const patterns = await m12.locationDeviationPatterns(ctx, { from, to }, { tx });
    for (const d of drivers.values()) d.locationSourceInconsistent = patterns.byDriver.find((p) => p.key === d.userId)?.inconsistent ?? 0;
  } catch {
    // tanpa izin m12.fleet_event.read
  }
  // Selisih setoran & setoran terlambat (M4).
  const discs = await tx
    .select({ employeeId: discrepancies.employeeId, source: discrepancies.source, amount: discrepancies.amount })
    .from(discrepancies)
    .where(and(eq(discrepancies.tenantId, tenantId), gte(discrepancies.businessDate, from), lte(discrepancies.businessDate, to)));
  const deps = await tx
    .select({ d: deposits, closedAt: shifts.closedAt, operatorUserId: shifts.operatorUserId })
    .from(deposits)
    .leftJoin(shifts, eq(shifts.id, deposits.shiftId))
    .where(and(eq(deposits.tenantId, tenantId), eq(deposits.isPartial, false), gte(deposits.businessDate, from), lte(deposits.businessDate, to)));
  for (const d of drivers.values()) {
    const mine = discs.filter((x) => x.employeeId === d.employeeId && x.source === "driver");
    d.discrepancyCount = mine.length;
    d.discrepancyValue = mine.reduce((s, x) => s + x.amount, 0);
    d.lateDeposits = deps.filter((x) => x.d.sourceType === "driver" && x.d.depositorEmployeeId === d.employeeId && (x.d.submittedLate || x.d.receivedLate)).length;
  }
  // Deret hari tanpa selisih (BR-12) — definisi M4.
  const streaks = new Map<string, number>();
  try {
    const hist = await m4.discrepancyHistory(ctx, {}, { tx });
    for (const s of hist.streaks) streaks.set(s.employeeId, s.daysWithoutDiscrepancy);
  } catch {
    // Pelaku tanpa izin riwayat selisih: deret tidak ditampilkan.
  }
  // Penilaian & keluhan pelanggan aplikasi (US-M9-05, B-66) — satu definisi P2 (`ratingAggregates`,
  // `complaintMonthlyReport`); tanpa komentar pelanggan.
  const ratings = await p2.ratingAggregates(tx, { tenantId, from, to });
  const complaints = await p2.complaintMonthlyReport(tx, { tenantId, month, now: ctx.now });
  for (const d of drivers.values()) {
    d.daysWithoutDiscrepancy = streaks.get(d.employeeId) ?? null;
    d.completionPct = pct(d.completed, d.scheduled);
    d.onTimePct = pct(d.onTime, d.onTimeEligible);
    const r = ratings.drivers.find((x) => x.key === d.employeeId);
    d.ratingCount = r?.count ?? 0;
    d.ratingAverage = r ? r.average : null;
    d.lowRatings = r?.lowCount ?? 0;
  }
  const driverList = rankBy([...drivers.values()], (d) => [-(d.completionPct ?? -1), -(d.onTimePct ?? -1), d.discrepancyCount, d.lateDeposits]);

  // ---------------------------------------------------------------- Truk
  const truckTrips = sumTrips(await tripsDaily(tx, tenantId, from, to));
  const truckExp = await tx
    .select({ truckId: tripExpenses.truckId, total: sql<string>`coalesce(sum(${tripExpenses.amount}), 0)` })
    .from(tripExpenses)
    .where(and(eq(tripExpenses.tenantId, tenantId), eq(tripExpenses.status, "accepted"), gte(tripExpenses.businessDate, from), lte(tripExpenses.businessDate, to)))
    .groupBy(tripExpenses.truckId);
  const truckFeedback = (truckId: string) => {
    const r = ratings.trucks.find((x) => x.key === truckId);
    const c = complaints.byTruck.find((x) => x.truckId === truckId);
    return { ratingCount: r?.count ?? 0, ratingAverage: r ? r.average : null, lowRatings: r?.lowCount ?? 0, complaintCount: c?.count ?? 0, complaintKinds: c?.kinds ?? {} };
  };
  const truckList: TruckPerformance[] = truckTrips.byTruck.map((t) => {
    let m = 0;
    for (const r of dist) if (r.truckId === t.truckId) m += n(r.meters);
    return {
      truckId: t.truckId,
      code: t.truckCode,
      scheduled: t.scheduled,
      completed: t.completed,
      failed: t.failed,
      internalCompleted: t.internalCompleted,
      distanceKm: Math.round(m / 100) / 10,
      tripExpenses: n(truckExp.find((e) => e.truckId === t.truckId)?.total),
      completionPct: pct(t.completed, t.scheduled),
      ...truckFeedback(t.truckId),
    };
  });
  // Truk yang hanya muncul di umpan balik (mis. keluhan atas rit bulan lalu) tetap tampil.
  for (const fb of [...ratings.trucks.map((r) => r.key), ...complaints.byTruck.map((c) => c.truckId)]) {
    if (!fb || truckList.some((t) => t.truckId === fb)) continue;
    const label = ratings.trucks.find((r) => r.key === fb)?.label ?? complaints.byTruck.find((c) => c.truckId === fb)?.truck ?? "—";
    truckList.push({ truckId: fb, code: label, scheduled: 0, completed: 0, failed: 0, internalCompleted: 0, distanceKm: 0, tripExpenses: 0, completionPct: null, ...truckFeedback(fb) });
  }
  const customerFeedback: CustomerFeedbackSummary = {
    ratingCount: ratings.overall.count,
    ratingAverage: ratings.overall.count ? ratings.overall.average : null,
    complaints: complaints.total,
    openComplaints: complaints.open,
    complaintsWithoutTruck: complaints.byTruck.find((c) => !c.truckId)?.count ?? 0,
    byKind: complaints.byKind.map((k) => ({ kind: k.kind, label: k.label, count: k.count, open: k.open })),
  };

  // ---------------------------------------------------------------- Depot/toko & operator
  const outletRows = await tx.select().from(outlets).where(and(eq(outlets.tenantId, tenantId), inArray(outlets.kind, ["depot", "store"])));
  const gallons = await gallonsDaily(tx, tenantId, from, to);
  const sales = await m6.salesAggregates(tx, tenantId, { from, to });
  const voids = await m6.voidAggregates(tx, tenantId, { from, to });
  const shiftRows = await tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.tenantId, tenantId), gte(shifts.businessDate, from), lte(shifts.businessDate, to)));
  const stockDiff = await tx.execute<{ shift_id: string; n: string }>(sql`
    select c.shift_id, count(*) as n from shift_stock_counts c join shifts s on s.id = c.shift_id
    where s.tenant_id = ${tenantId} and s.business_date >= ${from} and s.business_date <= ${to} and coalesce(c.difference, 0) <> 0
    group by c.shift_id`);
  const stockByShift = new Map(stockDiff.rows.map((r) => [r.shift_id, n(r.n)]));
  const lateDays = (await params.get(tx, "PAR-27", to, { tenantId })).days_gt;
  const isLateShiftDeposit = (x: (typeof deps)[number]) =>
    x.d.receivedLate || (!!x.closedAt && !!x.d.receivedAt && x.d.receivedAt.getTime() - x.closedAt.getTime() > lateDays * 86_400_000) || (!!x.closedAt && !x.d.receivedAt && x.d.status !== "closed" && end.getTime() - x.closedAt.getTime() > lateDays * 86_400_000);
  const water = await m6.waterBalancesFor(tx, tenantId, from, to);
  const outletList: OutletPerformance[] = outletRows
    .map((o) => {
      const s = sales.filter((r) => r.outletId === o.id);
      const g = gallons.filter((r) => r.outletId === o.id);
      const v = voids.filter((r) => r.outletId === o.id);
      const sh = shiftRows.filter((r) => r.outletId === o.id);
      const days = new Set(s.filter((r) => r.transactions > 0).map((r) => r.businessDate)).size;
      const gallonTotal = g.reduce((acc, r) => acc + r.gallons, 0);
      const w = water.find((r) => r.outletId === o.id);
      return {
        outletId: o.id,
        code: o.code,
        name: o.name,
        kind: o.kind as "depot" | "store",
        gallons: gallonTotal,
        gallonsPerDay: days ? Math.round((gallonTotal / days) * 10) / 10 : 0,
        transactions: s.reduce((acc, r) => acc + r.transactions, 0),
        sales: s.reduce((acc, r) => acc + r.salesTotal, 0),
        voidCount: v.reduce((acc, r) => acc + r.voidCount, 0),
        voidValue: v.reduce((acc, r) => acc + r.voidAmount, 0),
        cashDifferenceCount: sh.filter((r) => (r.cashDifference ?? 0) !== 0).length,
        cashDifferenceValue: sh.reduce((acc, r) => acc + (r.cashDifference ?? 0), 0),
        stockDifferenceCount: sh.reduce((acc, r) => acc + (stockByShift.get(r.id) ?? 0), 0),
        lateDeposits: deps.filter((x) => x.d.outletId === o.id && isLateShiftDeposit(x)).length,
        cashOverLimit: sh.filter((r) => !!r.cashLimitAlertAt).length,
        supplyReceivedL: w ? w.receivedL : null,
        waterExcessL: w ? w.excessL : null,
        waterExcessPct: w ? w.excessPct : null,
      };
    })
    .filter((o) => o.transactions > 0 || o.voidCount > 0 || o.cashDifferenceCount > 0 || o.supplyReceivedL)
    .sort((a, b) => a.code.localeCompare(b.code, "id"));

  // Operator per pengguna shift (penjualan per shift operator).
  const saleByOperator = await tx.execute<{ operator: string; n: string; gallons: string }>(sql`
    select s.operator_user_id as operator,
      count(distinct s.id) filter (where s.is_reversal = false) as n,
      coalesce(sum(l.quantity) filter (where l.gallon_size_l is not null and (s.is_reversal = true or s.status in ('valid','void_pending') or (s.status = 'voided' and s.reversal_reason is not null))), 0) as gallons
    from pos_sales s left join pos_sale_lines l on l.pos_sale_id = s.id
    where s.tenant_id = ${tenantId} and s.business_date >= ${from} and s.business_date <= ${to}
    group by s.operator_user_id`);
  const voidByOperator = await tx.execute<{ operator: string; n: string; value: string }>(sql`
    select operator_user_id as operator, count(*) as n, coalesce(sum(total), 0) as value from pos_sales
    where tenant_id = ${tenantId} and is_reversal = false and status in ('voided','void_pending')
      and void_requested_at >= ${start} and void_requested_at < ${end}
    group by operator_user_id`);
  const opIds = [...new Set(shiftRows.map((s) => s.operatorUserId))];
  const opUsers = opIds.length
    ? await tx.select({ id: users.id, employeeId: users.employeeId, name: employees.fullName }).from(users).leftJoin(employees, eq(employees.id, users.employeeId)).where(inArray(users.id, opIds))
    : [];
  const outletById = new Map(outletRows.map((o) => [o.id, o]));
  const operators: OperatorPerformance[] = opIds.map((uid) => {
    const mine = shiftRows.filter((s) => s.operatorUserId === uid);
    const kinds = new Set(mine.map((s) => outletById.get(s.outletId)?.kind));
    const group: OperatorPerformance["group"] = kinds.has("store") && !kinds.has("depot") ? "store_cashier" : "depot_operator";
    const u = opUsers.find((x) => x.id === uid);
    const days = new Set(mine.map((s) => s.businessDate)).size;
    const g = n(saleByOperator.rows.find((r) => r.operator === uid)?.gallons);
    return {
      userId: uid,
      employeeId: u?.employeeId ?? null,
      name: u?.name ?? "Operator",
      group,
      groupLabel: label("performance_group", group),
      outlets: [...new Set(mine.map((s) => outletById.get(s.outletId)?.code ?? "—"))],
      shifts: mine.length,
      gallons: g,
      gallonsPerDay: days ? Math.round((g / days) * 10) / 10 : 0,
      transactions: n(saleByOperator.rows.find((r) => r.operator === uid)?.n),
      voidCount: n(voidByOperator.rows.find((r) => r.operator === uid)?.n),
      voidValue: n(voidByOperator.rows.find((r) => r.operator === uid)?.value),
      cashDifferenceCount: mine.filter((s) => (s.cashDifference ?? 0) !== 0).length,
      cashDifferenceValue: mine.reduce((acc, s) => acc + (s.cashDifference ?? 0), 0),
      stockDifferenceCount: mine.reduce((acc, s) => acc + (stockByShift.get(s.id) ?? 0), 0),
      lateDeposits: deps.filter((x) => x.operatorUserId === uid && isLateShiftDeposit(x)).length,
      cashOverLimit: mine.filter((s) => !!s.cashLimitAlertAt).length,
      daysWithoutDiscrepancy: u?.employeeId ? (streaks.get(u.employeeId) ?? null) : null,
      rank: 0,
    };
  });
  const rankedOperators = (["depot_operator", "store_cashier"] as const).flatMap((grp) =>
    rankBy(
      operators.filter((o) => o.group === grp),
      (o) => [o.cashDifferenceCount, o.voidCount, o.lateDeposits, -o.gallonsPerDay],
    ),
  );
  return { month, from, to, onTimeWindowMinutes: window, drivers: driverList, trucks: truckList, outlets: outletList, operators: rankedOperators, customerFeedback };
}

/** Kinerja sopir/truk & depot/operator per bulan — hanya pemilik (US-M9-05 KP-4). */
export async function getPerformance(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<PerformanceReport> {
  await authorize(ctx, "m9.performance.read", { tx: opts.tx });
  const { month } = parseInput(performanceSchema, input, { month: "Bulan" });
  return computePerformance(opts.tx ?? getDb(), ctx, month);
}
