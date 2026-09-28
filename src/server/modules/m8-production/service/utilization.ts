/**
 * M8 — utilisasi kapasitas sumber (US-M8-05; FR-M8-04, K1, K22, R06).
 *
 * Utilisasi harian = Σ pengisian bersih ÷ kapasitas harian sumber (master M1). Bulanan = rata-rata harian + jumlah hari
 * > PAR-19; per sumber dan gabungan (Σ pengisian ÷ Σ kapasitas). Dua tingkat satu definisi (KP-2): harian > PAR-19
 * ditandai (dashboard & H+0 — `utilizationFlags`), > PAR-19 selama PAR-85 hari berturut → notifikasi push pemilik
 * (sekali per rangkaian, RP-10). Ruang tumbuh = kapasitas − rata-rata pengisian (liter/hari) & setara rit (÷ PAR-15).
 */
import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { waterSources } from "@/db/schema";
import { addDays, daysBetween, firstDayOfMonth, isBusinessDate, lastDayOfMonth, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ValidationError } from "@/server/core/errors";
import { authorize } from "@/server/core/rbac";

import { m8Rules, notifyOnce, pct2, type WaterSourceRow } from "./common";
import { dayKey, EMPTY_TOTALS, fillTotalsByDay } from "./fill-totals";

export type UtilizationDayRow = {
  businessDate: BusinessDate;
  sourceId: string | null;
  sourceCode: string;
  sourceName: string;
  capacityL: number;
  filledL: number;
  customerL: number;
  depotL: number;
  fillCount: number;
  utilizationPct: number | null;
  /** > PAR-19 (penanda dashboard & H+0). */
  high: boolean;
};

export type UtilizationMonthRow = {
  month: string;
  sourceId: string | null;
  sourceCode: string;
  sourceName: string;
  capacityL: number;
  days: number;
  totalFilledL: number;
  avgFilledL: number;
  avgUtilizationPct: number | null;
  maxUtilizationPct: number | null;
  daysAboveThreshold: number;
  /** Ruang tumbuh (liter/hari) = kapasitas − rata-rata pengisian harian. */
  growthRoomL: number;
  /** Setara rit (÷ volume standar rit PAR-15). */
  growthRoomTrips: number;
};

async function activeSources(tx: Tx, tenantId: string, sourceId?: string | null): Promise<WaterSourceRow[]> {
  const rows = await tx.select().from(waterSources).where(eq(waterSources.tenantId, tenantId)).orderBy(asc(waterSources.code));
  return rows.filter((s) => (sourceId ? s.id === sourceId : s.isActive));
}

function datesBetween(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  const out: BusinessDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Utilisasi harian per sumber + baris gabungan (`sourceId = null`) — tanpa otorisasi (pemanggil sudah berizin). */
export async function computeUtilizationDays(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate, opts: { sourceId?: string | null; combined?: boolean } = {}): Promise<UtilizationDayRow[]> {
  const sources = await activeSources(tx, tenantId, opts.sourceId);
  const rules = await m8Rules(tx, to, tenantId);
  const totals = await fillTotalsByDay(
    tx,
    sources.map((s) => s.id),
    from,
    to,
  );
  const rows: UtilizationDayRow[] = [];
  for (const d of datesBetween(from, to)) {
    let sumFilled = 0;
    let sumCap = 0;
    let sumCustomer = 0;
    let sumDepot = 0;
    let sumCount = 0;
    for (const s of sources) {
      const t = totals.get(dayKey(s.id, d)) ?? EMPTY_TOTALS;
      const util = pct2(t.totalL, s.dailyCapacityL);
      rows.push({
        businessDate: d,
        sourceId: s.id,
        sourceCode: s.code,
        sourceName: s.name,
        capacityL: s.dailyCapacityL,
        filledL: t.totalL,
        customerL: t.customerL,
        depotL: t.depotL,
        fillCount: t.count,
        utilizationPct: util,
        high: util !== null && util > rules.utilizationHighPct,
      });
      sumFilled += t.totalL;
      sumCap += s.dailyCapacityL;
      sumCustomer += t.customerL;
      sumDepot += t.depotL;
      sumCount += t.count;
    }
    if ((opts.combined ?? true) && sources.length > 1) {
      const util = pct2(sumFilled, sumCap);
      rows.push({
        businessDate: d,
        sourceId: null,
        sourceCode: "GAB",
        sourceName: "Gabungan semua sumber",
        capacityL: sumCap,
        filledL: sumFilled,
        customerL: sumCustomer,
        depotL: sumDepot,
        fillCount: sumCount,
        utilizationPct: util,
        high: util !== null && util > rules.utilizationHighPct,
      });
    }
  }
  return rows;
}

/** Ringkasan bulanan dari baris harian (rata-rata, maks, hari > PAR-19, ruang tumbuh). */
export async function computeUtilizationMonth(tx: Tx, tenantId: string, month: string, today: BusinessDate, sourceId?: string | null): Promise<UtilizationMonthRow[]> {
  const first = firstDayOfMonth(`${month}-01`);
  const last = lastDayOfMonth(first);
  const to = last < today ? last : today;
  if (to < first) return [];
  const rules = await m8Rules(tx, to, tenantId);
  const days = await computeUtilizationDays(tx, tenantId, first, to, { sourceId });
  const groups = new Map<string, UtilizationDayRow[]>();
  for (const r of days) {
    const key = r.sourceId ?? "__all__";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: UtilizationMonthRow[] = [];
  for (const rows of groups.values()) {
    const head = rows[0]!;
    const n = rows.length;
    const total = rows.reduce((a, r) => a + r.filledL, 0);
    const avgFilled = n ? total / n : 0;
    const utils = rows.map((r) => r.utilizationPct).filter((v): v is number => v !== null);
    const growth = Math.max(0, head.capacityL - avgFilled);
    out.push({
      month,
      sourceId: head.sourceId,
      sourceCode: head.sourceCode,
      sourceName: head.sourceName,
      capacityL: head.capacityL,
      days: n,
      totalFilledL: total,
      avgFilledL: Math.round(avgFilled),
      avgUtilizationPct: utils.length ? Math.round((utils.reduce((a, b) => a + b, 0) / utils.length) * 100) / 100 : null,
      maxUtilizationPct: utils.length ? Math.max(...utils) : null,
      daysAboveThreshold: rows.filter((r) => r.high).length,
      growthRoomL: Math.round(growth),
      growthRoomTrips: Math.round((growth / Math.max(1, rules.standardVolumeL)) * 10) / 10,
    });
  }
  return out.sort((a, b) => (a.sourceId === null ? 1 : b.sourceId === null ? -1 : a.sourceCode.localeCompare(b.sourceCode)));
}

// =====================================================================================================================
// API kantor (ber-otorisasi)
// =====================================================================================================================

const rangeSchema = z.object({
  from: z.string().refine(isBusinessDate, { error: "Tanggal awal harus YYYY-MM-DD." }),
  to: z.string().refine(isBusinessDate, { error: "Tanggal akhir harus YYYY-MM-DD." }),
  sourceId: z.uuid().nullable().optional(),
});

/** US-M8-05 KP-1/KP-2: utilisasi harian per sumber & gabungan. Maks 400 hari per permintaan. */
export async function utilizationDaily(ctx: ActorContext, input: z.input<typeof rangeSchema>, opts: { tx?: Tx; permission?: string } = {}): Promise<UtilizationDayRow[]> {
  await authorize(ctx, opts.permission ?? "m8.utilization.read", { tx: opts.tx });
  const data = rangeSchema.parse(input);
  if (data.to < data.from) throw ValidationError.field("to", "Tanggal akhir tidak boleh sebelum tanggal awal.");
  if (daysBetween(data.from, data.to) > 400) throw ValidationError.field("from", "Rentang terlalu panjang (maksimal 400 hari).");
  return computeUtilizationDays(opts.tx ?? getDb(), ctx.tenantId, data.from, data.to, { sourceId: data.sourceId ?? null });
}

/** US-M8-05 KP-1: utilisasi bulanan (rata-rata harian, hari > PAR-19, ruang tumbuh). */
export async function utilizationMonthly(ctx: ActorContext, input: { month: string; sourceId?: string | null }, opts: { tx?: Tx } = {}): Promise<UtilizationMonthRow[]> {
  await authorize(ctx, "m8.utilization.read", { tx: opts.tx });
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw ValidationError.field("month", "Bulan harus berformat YYYY-MM.");
  return computeUtilizationMonth(opts.tx ?? getDb(), ctx.tenantId, input.month, ctxBusinessDate(ctx), input.sourceId ?? null);
}

/**
 * Penanda utilisasi harian > PAR-19 untuk dashboard & H+0 (M9, US-M8-05 KP-2) — tanpa otorisasi (pemanggil M9 sudah
 * berizin membaca ringkasan). Mengembalikan baris sumber (dan gabungan) yang tinggi pada tanggal itu.
 */
export async function utilizationFlags(tx: Tx, tenantId: string, date: BusinessDate): Promise<UtilizationDayRow[]> {
  return (await computeUtilizationDays(tx, tenantId, date, date)).filter((r) => r.high);
}

/**
 * KP-2: utilisasi > PAR-19 selama PAR-85 hari berturut (berakhir di `date`) → notifikasi push ke pemilik, SEKALI per
 * rangkaian (kunci = tanggal awal rangkaian) agar tidak berlebih (RP-10).
 */
export async function checkUtilizationStreak(tx: Tx, ctx: ActorContext, source: WaterSourceRow, date: BusinessDate): Promise<{ streak: number; notified: boolean }> {
  const rules = await m8Rules(tx, date, source.tenantId);
  const need = rules.utilizationStreakDays;
  const lookback = Math.max(need * 3, 14);
  const from = addDays(date, -(lookback - 1));
  const totals = await fillTotalsByDay(tx, [source.id], from, date);
  let streak = 0;
  for (let d = date; d >= from; d = addDays(d, -1)) {
    const t = totals.get(dayKey(source.id, d)) ?? EMPTY_TOTALS;
    const util = pct2(t.totalL, source.dailyCapacityL);
    if (util !== null && util > rules.utilizationHighPct) streak++;
    else break;
  }
  if (streak < need) return { streak, notified: false };
  const streakStart = addDays(date, -(streak - 1));
  const notified = await notifyOnce(tx, {
    event: "source.utilization_high",
    tenantId: source.tenantId,
    groupKey: `utilization_streak:${source.id}:${streakStart}`,
    recipients: { roles: ["owner"] },
    title: `Utilisasi ${source.name} di atas ${rules.utilizationHighPct}% selama ${streak} hari berturut`,
    body: `Sejak ${streakStart}. Pertimbangkan rencana kapasitas (K22); lihat ruang tumbuh di Produksi air > Utilisasi.`,
    objectType: "water_source",
    objectId: source.id,
    valueText: `${streak} hari`,
    link: `/produksi/utilisasi`,
    now: ctx.now,
  });
  return { streak, notified };
}

/** Rentang bawaan ekspor harian utilisasi (US-M8-05 KP-3): tepat N bulan terakhir s.d. hari ini (inklusif). */
export function utilizationExportRange(today: BusinessDate, months: number): { from: BusinessDate; to: BusinessDate } {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  let yy = y;
  let mm = m - months;
  while (mm <= 0) {
    mm += 12;
    yy -= 1;
  }
  const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const same = `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
  return { from: addDays(same, 1), to: today };
}

/** Sumber aktif tenant (untuk daftar pilihan & job). */
export async function listActiveSources(tx: Tx, tenantId: string): Promise<WaterSourceRow[]> {
  return tx
    .select()
    .from(waterSources)
    .where(and(eq(waterSources.tenantId, tenantId), eq(waterSources.isActive, true)))
    .orderBy(asc(waterSources.code));
}
