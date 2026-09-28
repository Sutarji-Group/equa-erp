/**
 * M8 — data referensi offline aplikasi operator produksi (pull `m8.today`; US-M8-07 KP-1).
 *
 * Diunduh saat login dan diperbarui di latar: sumber air perangkat, meter + pembacaan terakhir & hari ini (batas angka
 * KP-2, putaran tercatat), produksi hari ini/kemarin, JADWAL RIT HARI INI (daftar truk yang akan mengisi di sumber ini
 * + rit berikutnya yang disarankan + air rit gagal yang dibawa), pengisian hari ini, level tandon, tugas investigasi
 * susut, neraca terakhir, jadwal & hasil uji mutu, dan riwayat singkat. `undefined` bila tidak ada perubahan sejak
 * kursor (hemat kuota NFR-17).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte, max } from "drizzle-orm";

import {
  dailyProductions,
  dailySchedules,
  meterAdjustments,
  meterReadings,
  qualityTests,
  qualityTestSchedules,
  tankLevelReadings,
  trips,
  truckFills,
  trucks,
  waterBalances,
  waterMeters,
  waterSources,
} from "@/db/schema";
import { addDays, toBusinessDate, type BusinessDate } from "@/lib/time";

import type { M8FillRef, M8MeterRef, M8Today, M8TruckRef } from "@/client/m8-production/contract";

import type { DeviceRow } from "@/server/core/auth";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { inSourceScope } from "@/server/core/rbac";

import { m8Rules } from "./common";
import { dayKey, fillTotalsByDay } from "./fill-totals";
import { truckPlansForDay } from "./fills";
import { liveReadings, metersForDate, previousReading } from "./production";
import { actionOwnerCandidates, qualityForSource } from "./quality";

async function lastChange(tx: Tx, sourceId: string, tenantId: string, date: BusinessDate): Promise<number> {
  const stamps: (Date | null | undefined)[] = [];
  const pick = async (q: Promise<{ m: Date | null }[]>) => stamps.push((await q)[0]?.m);
  await pick(tx.select({ m: max(meterReadings.updatedAt) }).from(meterReadings).where(eq(meterReadings.waterSourceId, sourceId)));
  await pick(tx.select({ m: max(truckFills.updatedAt) }).from(truckFills).where(eq(truckFills.waterSourceId, sourceId)));
  await pick(tx.select({ m: max(dailyProductions.updatedAt) }).from(dailyProductions).where(eq(dailyProductions.waterSourceId, sourceId)));
  await pick(tx.select({ m: max(waterBalances.updatedAt) }).from(waterBalances).where(eq(waterBalances.waterSourceId, sourceId)));
  await pick(tx.select({ m: max(tankLevelReadings.updatedAt) }).from(tankLevelReadings).where(eq(tankLevelReadings.waterSourceId, sourceId)));
  await pick(tx.select({ m: max(meterAdjustments.updatedAt) }).from(meterAdjustments).where(eq(meterAdjustments.waterSourceId, sourceId)));
  await pick(tx.select({ m: max(waterMeters.updatedAt) }).from(waterMeters).where(eq(waterMeters.waterSourceId, sourceId)));
  await pick(tx.select({ m: max(qualityTestSchedules.updatedAt) }).from(qualityTestSchedules).where(eq(qualityTestSchedules.waterSourceId, sourceId)));
  await pick(tx.select({ m: max(qualityTests.updatedAt) }).from(qualityTests).where(eq(qualityTests.waterSourceId, sourceId)));
  await pick(tx.select({ m: max(trips.updatedAt) }).from(trips).where(and(eq(trips.tenantId, tenantId), eq(trips.scheduledDate, date))));
  await pick(tx.select({ m: max(dailySchedules.updatedAt) }).from(dailySchedules).where(and(eq(dailySchedules.tenantId, tenantId), eq(dailySchedules.businessDate, date))));
  await pick(tx.select({ m: max(trucks.updatedAt) }).from(trucks).where(eq(trucks.tenantId, tenantId)));
  await pick(tx.select({ m: max(waterSources.updatedAt) }).from(waterSources).where(eq(waterSources.id, sourceId)));
  return Math.max(0, ...stamps.filter((d): d is Date => !!d).map((d) => new Date(d).getTime()));
}

function emptyToday(date: BusinessDate, now: Date, rules: M8Today["rules"], blockedReason: string | null): M8Today {
  return {
    date,
    generatedAt: now.toISOString(),
    source: null,
    blockedReason,
    rules,
    meters: [],
    production: { today: null, yesterday: null },
    trucks: [],
    fills: [],
    tankLevels: [],
    investigations: [],
    lastBalance: null,
    quality: { schedules: [], recent: [], employees: [] },
    history: [],
  };
}

/** Bangun `m8.today` untuk operator produksi pada perangkat sumber air. */
export async function buildProductionToday(tx: Tx, ctx: ActorContext, device: Pick<DeviceRow, "waterSourceId" | "tenantId">, since: Date | null, opts: { now: Date }): Promise<M8Today | undefined> {
  const now = opts.now;
  const date = toBusinessDate(now);
  const r = await m8Rules(tx, date, ctx.tenantId);
  const rules: M8Today["rules"] = {
    standardVolumeL: r.standardVolumeL,
    maxPhotoKb: r.maxPhotoKb,
    morningDeadline: r.morningDeadline,
    eveningDeadline: r.eveningDeadline,
    lossMaxPct: r.lossMaxPct,
    supplyTolerancePct: r.supplyTolerancePct,
  };
  if (!device.waterSourceId) {
    return emptyToday(date, now, rules, "Ponsel ini belum terdaftar untuk sumber air mana pun. Minta admin sistem mendaftarkan ponsel ke sumber air Anda.");
  }
  const [source] = await tx.select().from(waterSources).where(eq(waterSources.id, device.waterSourceId)).limit(1);
  if (!source || source.tenantId !== ctx.tenantId) return emptyToday(date, now, rules, "Sumber air perangkat tidak ditemukan. Hubungi admin sistem.");
  if (!inSourceScope(ctx, source.id, source.tenantId)) {
    return emptyToday(date, now, rules, `Anda tidak ditugaskan di ${source.name}. Pakai ponsel sumber air Anda atau minta admin sistem memperbarui lingkup tugas.`);
  }
  if (since && toBusinessDate(since) === date && (await lastChange(tx, source.id, source.tenantId, date)) <= since.getTime()) return undefined;

  // --- Meter & pembacaan (KP-1/KP-2) -----------------------------------------------------------------------------------
  const meters = (await metersForDate(tx, source.id, date)).filter((m) => m.status === "active");
  const readings = await liveReadings(
    tx,
    meters.map((m) => m.id),
    addDays(date, -1),
    date,
  );
  const pendingRollovers = meters.length
    ? await tx
        .select()
        .from(meterAdjustments)
        .where(
          and(
            inArray(
              meterAdjustments.waterMeterId,
              meters.map((m) => m.id),
            ),
            eq(meterAdjustments.kind, "rollover"),
            isNull(meterAdjustments.appliedReadingId),
          ),
        )
    : [];
  const meterRefs: M8MeterRef[] = [];
  for (const m of meters) {
    const [last] = await tx
      .select()
      .from(meterReadings)
      .where(and(eq(meterReadings.waterMeterId, m.id), isNull(meterReadings.supersededById)))
      .orderBy(desc(meterReadings.businessDate), desc(meterReadings.phase), desc(meterReadings.readAt))
      .limit(1);
    const today = (phase: "morning" | "evening") => {
      const x = readings.find((rd) => rd.waterMeterId === m.id && rd.businessDate === date && rd.phase === phase);
      return x ? { id: x.id, readingL: x.readingL, readAt: x.readAt.toISOString(), status: x.status, lateReason: x.lateReason } : null;
    };
    const ro = pendingRollovers.find((a) => a.waterMeterId === m.id && a.businessDate <= date);
    const before = await previousReading(tx, m.id, date, "morning");
    meterRefs.push({
      id: m.id,
      code: m.code,
      name: m.name,
      initialReadingL: m.initialReadingL,
      last: last ? { businessDate: last.businessDate, phase: last.phase, readingL: last.readingL, readAt: last.readAt.toISOString() } : null,
      previousDayL: before?.readingL ?? m.initialReadingL,
      today: { morning: today("morning"), evening: today("evening") },
      rollover: ro ? { rolloverAtL: ro.rolloverAtL ?? 0, businessDate: ro.businessDate } : null,
    });
  }

  // --- Produksi -------------------------------------------------------------------------------------------------------
  const prods = await tx
    .select()
    .from(dailyProductions)
    .where(and(eq(dailyProductions.waterSourceId, source.id), gte(dailyProductions.businessDate, addDays(date, -r.operatorHistoryDays)), lte(dailyProductions.businessDate, date)));
  const prodOf = (d: BusinessDate) => {
    const p = prods.find((x) => x.businessDate === d);
    return p ? { producedL: p.producedL, status: p.status } : null;
  };

  // --- Truk & rit hari ini (jadwal M2) ---------------------------------------------------------------------------------
  const plans = await truckPlansForDay(tx, source.tenantId, source.id, date);
  const truckRows = await tx.select().from(trucks).where(and(eq(trucks.tenantId, source.tenantId), eq(trucks.isActive, true))).orderBy(asc(trucks.code));
  const sourceNames = new Map((await tx.select({ id: waterSources.id, name: waterSources.name }).from(waterSources).where(eq(waterSources.tenantId, source.tenantId))).map((s) => [s.id, s.name]));
  const fillRows = await tx
    .select({ fill: truckFills, truckCode: trucks.code, tripNumber: trips.number })
    .from(truckFills)
    .innerJoin(trucks, eq(trucks.id, truckFills.truckId))
    .leftJoin(trips, eq(trips.id, truckFills.tripId))
    .where(and(eq(truckFills.waterSourceId, source.id), eq(truckFills.businessDate, date), isNull(truckFills.reversalOfId)))
    .orderBy(desc(truckFills.filledAt))
    .limit(200);
  const fills: M8FillRef[] = fillRows.map((x) => ({
    id: x.fill.id,
    truckId: x.fill.truckId,
    truckCode: x.truckCode,
    tripId: x.fill.tripId,
    tripNumber: x.tripNumber,
    volumeL: x.fill.volumeL,
    volumeReason: x.fill.volumeReason,
    filledAt: x.fill.filledAt.toISOString(),
    status: x.fill.status,
    isDepotSupply: x.fill.isDepotSupply,
    unplannedTruck: x.fill.unplannedTruck,
    reversed: !!x.fill.reversedAt,
  }));
  const truckRefs: M8TruckRef[] = [];
  for (const t of truckRows) {
    const plan = plans.get(t.id);
    const tripRefs = (plan?.trips ?? []).map((tr) => ({
      id: tr.id,
      number: tr.number,
      customerName: tr.customerName,
      isInternal: tr.isInternal,
      destinationName: tr.destinationName,
      routeOrder: tr.routeOrder,
      status: tr.status,
      plannedVolumeL: tr.plannedVolumeL,
      filled: tr.filled,
    }));
    // US-M3-06 KP-2: air rit gagal "dibawa ke rit berikutnya" yang belum diikuti pengisian baru → sisa muatan.
    const failedCarried = (plan?.trips ?? [])
      .filter((tr) => tr.status === "failed" && tr.loadedWaterDisposition === "carried_to_next" && tr.failedAt)
      .sort((a, b) => b.failedAt!.getTime() - a.failedAt!.getTime())[0];
    let carriedWater: M8TruckRef["carriedWater"] = null;
    if (failedCarried) {
      const later = fills.some((f) => f.truckId === t.id && !f.reversed && new Date(f.filledAt).getTime() > failedCarried.failedAt!.getTime());
      if (!later) carriedWater = { tripNumber: failedCarried.number, volumeL: failedCarried.plannedVolumeL };
    }
    truckRefs.push({
      id: t.id,
      code: t.code,
      plateNumber: t.plateNumber,
      capacityL: t.capacityL,
      planned: !!plan?.planned,
      plannedSourceName: plan && !plan.planned && plan.plannedSourceId ? (sourceNames.get(plan.plannedSourceId) ?? null) : null,
      nextTripId: plan?.nextTripId ?? null,
      trips: tripRefs,
      carriedWater,
      filledTodayL: fills.filter((f) => f.truckId === t.id && !f.reversed).reduce((a, f) => a + f.volumeL, 0),
    });
  }

  // --- Tandon, investigasi, neraca terakhir ------------------------------------------------------------------------------
  const tanks = await tx
    .select()
    .from(tankLevelReadings)
    .where(and(eq(tankLevelReadings.waterSourceId, source.id), eq(tankLevelReadings.businessDate, date)))
    .orderBy(desc(tankLevelReadings.readAt));
  const invest = await tx
    .select()
    .from(waterBalances)
    .where(and(eq(waterBalances.waterSourceId, source.id), inArray(waterBalances.status, ["over_threshold", "investigating"]), gte(waterBalances.businessDate, addDays(date, -31))))
    .orderBy(desc(waterBalances.businessDate));
  const [lastBal] = await tx
    .select()
    .from(waterBalances)
    .where(and(eq(waterBalances.waterSourceId, source.id), lte(waterBalances.businessDate, date)))
    .orderBy(desc(waterBalances.businessDate))
    .limit(1);

  // --- Riwayat singkat ---------------------------------------------------------------------------------------------------
  const from = addDays(date, -r.operatorHistoryDays);
  const totals = await fillTotalsByDay(tx, [source.id], from, date);
  const bals = await tx
    .select({ d: waterBalances.businessDate, lossPct: waterBalances.lossPct })
    .from(waterBalances)
    .where(and(eq(waterBalances.waterSourceId, source.id), gte(waterBalances.businessDate, from), lte(waterBalances.businessDate, date)));
  const history: M8Today["history"] = [];
  for (let d = date; d >= from; d = addDays(d, -1)) {
    const p = prods.find((x) => x.businessDate === d);
    const t = totals.get(dayKey(source.id, d));
    if (!p && !t) continue;
    history.push({
      businessDate: d,
      producedL: p?.producedL ?? null,
      productionStatus: p?.status ?? null,
      fillsL: t?.totalL ?? 0,
      fillCount: t?.count ?? 0,
      lossPct: bals.find((b) => b.d === d)?.lossPct ?? null,
    });
  }

  const quality = await qualityForSource(tx, source.id, date, r.qualityReminderDaysBefore);
  return {
    date,
    generatedAt: now.toISOString(),
    source: { id: source.id, code: source.code, name: source.name, dailyCapacityL: source.dailyCapacityL },
    blockedReason: null,
    rules,
    meters: meterRefs,
    production: { today: prodOf(date), yesterday: prodOf(addDays(date, -1)) },
    trucks: truckRefs,
    fills,
    tankLevels: tanks.map((t) => ({ id: t.id, levelL: t.levelL, levelPct: t.levelPct, readAt: t.readAt.toISOString() })),
    investigations: invest.map((b) => ({
      waterBalanceId: b.id,
      businessDate: b.businessDate,
      producedL: b.producedL,
      filledTotalL: b.filledTotalL,
      lossL: b.lossL,
      lossPct: b.lossPct,
      status: b.status as "over_threshold" | "investigating",
      reason: b.investigationReason,
      note: b.investigationNote,
      reviewNote: b.reviewNote,
    })),
    lastBalance: lastBal
      ? {
          businessDate: lastBal.businessDate,
          producedL: lastBal.producedL,
          filledTotalL: lastBal.filledTotalL,
          lossL: lastBal.lossL,
          lossPct: lastBal.lossPct,
          avgLossPct: lastBal.avgLoss7dPct,
          status: lastBal.status,
          utilizationPct: lastBal.utilizationPct,
        }
      : null,
    quality: { ...quality, employees: await actionOwnerCandidates(tx, source.tenantId, { sourceId: source.id }) },
    history,
  };
}
