/**
 * M8 — produksi harian per sumber dari angka meter (US-M8-01 KP-1/KP-3/KP-4, 7.8.6).
 *
 * Produksi harian = Σ (akhir − awal) per meter aktif sumber itu:
 * - awal = pembacaan PAGI hari itu; bila tidak ada → pembacaan MALAM hari sebelumnya (ditandai "gabungan");
 * - akhir = pembacaan MALAM hari itu; bila terlewat → pembacaan PAGI hari berikutnya menutup hari itu ("gabungan", 7.8.6);
 * - putaran meter (KP-2): akhir = pembacaan pertama sesudah putaran → (angka putaran − awal) + akhir;
 * - penggantian meter hari itu (7.8.6) → produksi diestimasi dari rata-rata PAR-68 `window_days` hari, status "Estimasi";
 * - pembacaan yang belum ada → status "Belum lengkap" (KP-3) sampai dilengkapi (pembacaan terlambat wajib beralasan).
 * Produksi lengkap yang menyimpang > PAR-68 dari rata-rata N hari ditandai untuk verifikasi Admin Keuangan (KP-4).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";

import { dailyProductions, meterAdjustments, meterReadings, waterMeters } from "@/db/schema";
import { addDays, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";

import { liter, loadSource, m8Rules, notifyOnce, pct2 } from "./common";

export type DailyProductionRow = typeof dailyProductions.$inferSelect;
export type MeterReadingRow = typeof meterReadings.$inferSelect;
export type WaterMeterRow = typeof waterMeters.$inferSelect;

export type ProductionMeterDetail = {
  meterId: string;
  meterCode: string;
  startL: number | null;
  startFrom: "morning" | "previous_evening" | null;
  startReadingId: string | null;
  endL: number | null;
  endFrom: "evening" | "next_morning" | null;
  endReadingId: string | null;
  rolloverAtL: number | null;
  producedL: number | null;
  missing: ("morning" | "evening")[];
};

/** Meter yang berlaku untuk sumber pada tanggal (aktif & terpasang, atau diganti pada/sesudah tanggal itu). */
export async function metersForDate(tx: Tx, sourceId: string, date: BusinessDate): Promise<WaterMeterRow[]> {
  const rows = await tx.select().from(waterMeters).where(eq(waterMeters.waterSourceId, sourceId)).orderBy(asc(waterMeters.code));
  return rows.filter((m) => {
    if (m.installedAt && m.installedAt > date) return false;
    if (m.status === "active") return true;
    if (m.status === "replaced" && m.replacedAt) return toBusinessDate(m.replacedAt) >= date;
    return false;
  });
}

/** Pembacaan berlaku (belum dikoreksi) untuk meter & rentang tanggal. */
export async function liveReadings(tx: Tx, meterIds: readonly string[], from: BusinessDate, to: BusinessDate): Promise<MeterReadingRow[]> {
  if (meterIds.length === 0) return [];
  return tx
    .select()
    .from(meterReadings)
    .where(and(inArray(meterReadings.waterMeterId, [...meterIds]), gte(meterReadings.businessDate, from), lte(meterReadings.businessDate, to), isNull(meterReadings.supersededById)))
    .orderBy(asc(meterReadings.businessDate), asc(meterReadings.readAt));
}

/** Urutan waktu pembacaan: tanggal lalu fase (pagi < malam). */
export function readingOrder(r: Pick<MeterReadingRow, "businessDate" | "phase">): string {
  return `${r.businessDate}:${r.phase === "morning" ? 0 : 1}`;
}

/**
 * Pembacaan berlaku terakhir SEBELUM (tanggal, fase) untuk satu meter — batas bawah angka baru (KP-2). `null` = belum
 * pernah dibaca (batas bawah = angka awal cut-over meter).
 */
export async function previousReading(tx: Tx, meterId: string, date: BusinessDate, phase: "morning" | "evening"): Promise<MeterReadingRow | null> {
  const rows = await tx
    .select()
    .from(meterReadings)
    .where(
      and(
        eq(meterReadings.waterMeterId, meterId),
        isNull(meterReadings.supersededById),
        phase === "morning"
          ? lt(meterReadings.businessDate, date)
          : or(lt(meterReadings.businessDate, date), and(eq(meterReadings.businessDate, date), eq(meterReadings.phase, "morning"))),
      ),
    )
    .orderBy(desc(meterReadings.businessDate), desc(meterReadings.phase), desc(meterReadings.readAt))
    .limit(5);
  // `phase` enum diurutkan morning < evening secara deklarasi; desc(phase) → evening dulu pada tanggal yang sama.
  return rows.sort((a, b) => (readingOrder(a) < readingOrder(b) ? 1 : -1))[0] ?? null;
}

/** Pembacaan berlaku SESUDAH (tanggal, fase) terdekat (untuk batas atas pembacaan pagi yang menyusul). */
export async function nextReading(tx: Tx, meterId: string, date: BusinessDate, phase: "morning" | "evening"): Promise<MeterReadingRow | null> {
  const rows = await tx
    .select()
    .from(meterReadings)
    .where(
      and(
        eq(meterReadings.waterMeterId, meterId),
        isNull(meterReadings.supersededById),
        phase === "evening"
          ? gte(meterReadings.businessDate, addDays(date, 1))
          : or(gte(meterReadings.businessDate, addDays(date, 1)), and(eq(meterReadings.businessDate, date), eq(meterReadings.phase, "evening"))),
      ),
    )
    .orderBy(asc(meterReadings.businessDate), asc(meterReadings.readAt))
    .limit(5);
  return rows.sort((a, b) => (readingOrder(a) < readingOrder(b) ? -1 : 1))[0] ?? null;
}

async function rolloverValue(tx: Tx, reading: MeterReadingRow): Promise<number | null> {
  if (reading.adjustmentKind !== "rollover" || !reading.adjustmentId) return null;
  const rows = await tx.select({ v: meterAdjustments.rolloverAtL }).from(meterAdjustments).where(eq(meterAdjustments.id, reading.adjustmentId)).limit(1);
  return rows[0]?.v ?? null;
}

async function averageProduction(tx: Tx, sourceId: string, date: BusinessDate, windowDays: number): Promise<number | null> {
  const rows = await tx
    .select({ producedL: dailyProductions.producedL })
    .from(dailyProductions)
    .where(
      and(
        eq(dailyProductions.waterSourceId, sourceId),
        gte(dailyProductions.businessDate, addDays(date, -windowDays)),
        lt(dailyProductions.businessDate, date),
        inArray(dailyProductions.status, ["complete", "combined"]),
      ),
    );
  const vals = rows.map((r) => r.producedL).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export type ComputeProductionResult = { production: DailyProductionRow; changed: boolean; flaggedNow: boolean };

/**
 * Hitung (ulang) produksi harian satu sumber pada tanggal (idempoten). `ctx` = pelaku pemicu (operator, Admin Keuangan,
 * atau sistem) untuk jejak audit perubahan status/angka.
 */
export async function computeDailyProduction(tx: Tx, ctx: ActorContext, sourceId: string, date: BusinessDate): Promise<ComputeProductionResult> {
  const source = await loadSource(tx, sourceId);
  const rules = await m8Rules(tx, date, source.tenantId);
  const meters = await metersForDate(tx, sourceId, date);
  const readings = await liveReadings(
    tx,
    meters.map((m) => m.id),
    addDays(date, -1),
    addDays(date, 1),
  );
  const replacement = (
    await tx
      .select()
      .from(meterAdjustments)
      .where(and(eq(meterAdjustments.waterSourceId, sourceId), eq(meterAdjustments.businessDate, date), eq(meterAdjustments.kind, "replacement")))
      .limit(1)
  )[0];

  const details: ProductionMeterDetail[] = [];
  const lateReasons: string[] = [];
  for (const m of meters) {
    const pick = (d: BusinessDate, phase: "morning" | "evening") => readings.find((r) => r.waterMeterId === m.id && r.businessDate === d && r.phase === phase) ?? null;
    const morning = pick(date, "morning");
    const evening = pick(date, "evening");
    const start = morning ?? pick(addDays(date, -1), "evening");
    const end = evening ?? pick(addDays(date, 1), "morning");
    const missing: ("morning" | "evening")[] = [];
    if (!start) missing.push("morning");
    if (!end) missing.push("evening");
    let produced: number | null = null;
    let rolloverAtL: number | null = null;
    if (start && end) {
      rolloverAtL = await rolloverValue(tx, end);
      produced = rolloverAtL !== null ? rolloverAtL - start.readingL + end.readingL : end.readingL - start.readingL;
    }
    for (const r of [morning, evening]) if (r?.lateReason) lateReasons.push(`${m.code} ${r.phase === "morning" ? "pagi" : "malam"}: ${r.lateReason}`);
    details.push({
      meterId: m.id,
      meterCode: m.code,
      startL: start?.readingL ?? null,
      startFrom: morning ? "morning" : start ? "previous_evening" : null,
      startReadingId: start?.id ?? null,
      endL: end?.readingL ?? null,
      endFrom: evening ? "evening" : end ? "next_morning" : null,
      endReadingId: end?.id ?? null,
      rolloverAtL,
      producedL: produced,
      missing,
    });
  }

  let status: DailyProductionRow["status"];
  let producedL: number | null;
  let incompleteReason: string | null = null;
  if (replacement) {
    // 7.8.6: meter rusak/diganti → estimasi dari rata-rata N hari, ditandai.
    const avg = await averageProduction(tx, sourceId, date, rules.deviationWindowDays);
    status = "estimated";
    producedL = avg === null ? null : Math.round(avg);
    incompleteReason = avg === null ? "Meter diganti; belum ada data rata-rata untuk estimasi." : `Meter diganti: produksi diestimasi dari rata-rata ${rules.deviationWindowDays} hari.`;
  } else if (meters.length === 0) {
    status = "incomplete";
    producedL = null;
    incompleteReason = "Sumber belum memiliki meter aktif.";
  } else if (details.some((d) => d.missing.length > 0)) {
    status = "incomplete";
    producedL = null;
    incompleteReason = `Belum ada: ${details
      .filter((d) => d.missing.length > 0)
      .map((d) => `${d.missing.map((p) => (p === "morning" ? "pembacaan pagi" : "pembacaan malam")).join(" & ")} ${d.meterCode}`)
      .join("; ")}.`;
  } else {
    producedL = details.reduce((a, d) => a + (d.producedL ?? 0), 0);
    status = details.some((d) => d.startFrom === "previous_evening" || d.endFrom === "next_morning") ? "combined" : "complete";
    if (status === "combined") {
      incompleteReason = `Produksi gabungan: ${details
        .filter((d) => d.startFrom === "previous_evening" || d.endFrom === "next_morning")
        .map((d) => `${d.meterCode} ${d.endFrom === "next_morning" ? "ditutup pembacaan pagi berikutnya" : "dibuka pembacaan malam sebelumnya"}`)
        .join("; ")}.`;
    }
    if (lateReasons.length) incompleteReason = [incompleteReason, `Dilengkapi terlambat — ${lateReasons.join("; ")}`].filter(Boolean).join(" ");
  }

  // KP-4: menyimpang > PAR-68 dari rata-rata N hari → verifikasi (hanya produksi lengkap; gabungan/estimasi sudah bertanda).
  let deviationPct: number | null = null;
  let flag = false;
  if (status === "complete" && producedL !== null) {
    const avg = await averageProduction(tx, sourceId, date, rules.deviationWindowDays);
    if (avg !== null && avg > 0) {
      deviationPct = pct2(producedL - avg, avg);
      flag = deviationPct !== null && Math.abs(deviationPct) > rules.deviationPct;
    }
  }

  const [before] = await tx
    .select()
    .from(dailyProductions)
    .where(and(eq(dailyProductions.waterSourceId, sourceId), eq(dailyProductions.businessDate, date)))
    .limit(1);
  const verified = !!before?.verifiedAt;
  const flagged = flag && !verified;
  const values = {
    producedL,
    status,
    incompleteReason,
    detail: details as unknown as Record<string, unknown>[],
    deviationPct,
    flaggedForVerification: flagged,
    computedAt: ctx.now,
  };
  let row: DailyProductionRow;
  if (before) {
    [row] = (await tx.update(dailyProductions).set(values).where(eq(dailyProductions.id, before.id)).returning()) as [DailyProductionRow];
  } else {
    [row] = (await tx
      .insert(dailyProductions)
      .values({ tenantId: source.tenantId, waterSourceId: sourceId, businessDate: date, ...values })
      .returning()) as [DailyProductionRow];
  }
  const changed = !before || before.status !== row.status || before.producedL !== row.producedL || before.flaggedForVerification !== row.flaggedForVerification;
  if (changed) {
    await auditRecord(tx, {
      ctx,
      objectType: "daily_production",
      objectId: row.id,
      action: before ? "recompute" : "create",
      before: before ? { status: before.status, producedL: before.producedL, flaggedForVerification: before.flaggedForVerification } : undefined,
      after: { status: row.status, producedL: row.producedL, deviationPct: row.deviationPct, flaggedForVerification: row.flaggedForVerification, incompleteReason: row.incompleteReason },
      rule: "US-M8-01",
      businessDate: date,
    });
  }
  const flaggedNow = flagged && !before?.flaggedForVerification;
  if (flaggedNow) {
    const ids = details.flatMap((d) => [d.startReadingId, d.endReadingId]).filter((x): x is string => !!x);
    if (ids.length) {
      await tx
        .update(meterReadings)
        .set({ status: "flagged", anomalyNote: `Produksi ${liter(producedL)} menyimpang ${deviationPct}% dari rata-rata ${rules.deviationWindowDays} hari (PAR-68).` })
        .where(and(inArray(meterReadings.id, ids), eq(meterReadings.status, "recorded")));
    }
    await notifyOnce(tx, {
      event: "production.deviation",
      tenantId: source.tenantId,
      groupKey: `production_deviation:${row.id}`,
      title: `Produksi ${source.name} ${date} menyimpang ${deviationPct}% dari rata-rata`,
      body: `Produksi ${liter(producedL)}; batas PAR-68 ${rules.deviationPct}%. Bandingkan foto meter lalu verifikasi atau koreksi pembacaan.`,
      objectType: "daily_production",
      objectId: row.id,
      valueText: `${deviationPct}%`,
      link: `/produksi/neraca-air/rincian?sumber=${sourceId}&tanggal=${date}`,
      now: ctx.now,
    });
  }
  return { production: row, changed, flaggedNow };
}

/** Produksi tersimpan (tanpa menghitung ulang). */
export async function productionOf(tx: Tx, sourceId: string, date: BusinessDate): Promise<DailyProductionRow | null> {
  const rows = await tx
    .select()
    .from(dailyProductions)
    .where(and(eq(dailyProductions.waterSourceId, sourceId), eq(dailyProductions.businessDate, date)))
    .limit(1);
  return rows[0] ?? null;
}

/** Tanggal-tanggal yang produksinya terpengaruh pembacaan (tanggal, fase): hari itu + hari sebelum/sesudahnya (gabungan). */
export function affectedProductionDates(date: BusinessDate, phase: "morning" | "evening"): BusinessDate[] {
  return phase === "morning" ? [addDays(date, -1), date] : [date, addDays(date, 1)];
}

/** Produksi yang bertanda verifikasi, belum diverifikasi (daftar kerja Admin Keuangan). */
export async function productionsAwaitingVerification(tx: Tx, tenantId: string): Promise<DailyProductionRow[]> {
  return tx
    .select()
    .from(dailyProductions)
    .where(and(eq(dailyProductions.tenantId, tenantId), eq(dailyProductions.flaggedForVerification, true), isNull(dailyProductions.verifiedAt), ne(dailyProductions.status, "incomplete")))
    .orderBy(desc(dailyProductions.businessDate));
}
