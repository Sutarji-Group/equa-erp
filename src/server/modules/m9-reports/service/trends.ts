/**
 * M9 — Tren mingguan/bulanan (US-M9-06, FR-M9-06; RL-6): 13 periode terakhir untuk omzet per lini, rit per truk, galon
 * per depot, dan piutang (saldo, % lewat tempo), dengan perbandingan terhadap periode sebelumnya. Definisi SAMA dengan
 * H+0 & laporan bulanan (fungsi `metrics.ts`: omzet = Σ harian, rit per tanggal jadwal, galon POS, piutang as-of akhir
 * periode). Hanya pemilik (`m9.trend.read`).
 */
import "server-only";

import type { TrendPoint } from "@/client/m9-reports/types";
import { addDays, firstDayOfMonth, formatTanggal, lastDayOfMonth, weekdayOf, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { parseInput } from "@/server/core/errors";
import { authorize } from "@/server/core/rbac";

import { gallonsDaily, receivablesAsOf, revenueDaily, sumGallons, sumRevenue, sumTrips, tripsDaily } from "../metrics";
import { trendSchema } from "../schemas";
import { reportRules } from "./h0";
import { shiftMonth } from "./monthly";

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** Senin minggu (ISO) tanggal. */
export function mondayOf(date: BusinessDate): BusinessDate {
  const wd = weekdayOf(date); // 0 = Minggu
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export type TrendBucket = { key: string; label: string; from: BusinessDate; to: BusinessDate };

export function trendBuckets(granularity: "week" | "month", to: BusinessDate, count: number): TrendBucket[] {
  const out: TrendBucket[] = [];
  if (granularity === "week") {
    const lastMonday = mondayOf(to);
    for (let i = count - 1; i >= 0; i--) {
      const from = addDays(lastMonday, -7 * i);
      const end = addDays(from, 6);
      out.push({ key: from, label: formatTanggal(from, { weekday: false }).replace(/ \d{4}$/, ""), from, to: end > to ? to : end });
    }
  } else {
    const month = to.slice(0, 7);
    for (let i = count - 1; i >= 0; i--) {
      const m = shiftMonth(month, -i);
      const from = firstDayOfMonth(`${m}-01`);
      const end = lastDayOfMonth(from);
      out.push({ key: m, label: `${BULAN[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`, from, to: end > to ? to : end });
    }
  }
  return out;
}

export type TrendReport = {
  granularity: "week" | "month";
  points: TrendPoint[];
  trucks: string[];
  depots: string[];
  /** Perubahan periode terakhir terhadap periode sebelumnya (%) per ukuran. */
  change: Record<"external" | "L2" | "L3" | "L4" | "tripsCompleted" | "gallons" | "receivableBalance" | "overduePct", number | null>;
};

const change = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10);

/** Tren tanpa otorisasi (dipakai ekspor). */
export async function computeTrend(tx: Tx, tenantId: string, granularity: "week" | "month", to: BusinessDate, count: number): Promise<TrendReport> {
  const buckets = trendBuckets(granularity, to, count);
  const from = buckets[0]!.from;
  const [rev, tripsRows, gallonRows] = await Promise.all([revenueDaily(tx, tenantId, from, to), tripsDaily(tx, tenantId, from, to), gallonsDaily(tx, tenantId, from, to)]);
  const trucks = new Set<string>();
  const depots = new Set<string>();
  const points: TrendPoint[] = [];
  for (const b of buckets) {
    const r = sumRevenue([...rev.entries()].filter(([d]) => d >= b.from && d <= b.to).map(([, v]) => v));
    const t = sumTrips(tripsRows.filter((x) => x.date >= b.from && x.date <= b.to));
    const g = sumGallons(gallonRows.filter((x) => x.date >= b.from && x.date <= b.to));
    const recv = await receivablesAsOf(tx, tenantId, b.to);
    const byTruck: Record<string, number> = {};
    for (const x of t.byTruck) {
      byTruck[x.truckCode] = x.completed;
      trucks.add(x.truckCode);
    }
    const byDepot: Record<string, number> = {};
    for (const x of g.byDepot) {
      byDepot[x.code] = x.gallons;
      depots.add(x.code);
    }
    points.push({
      key: b.key,
      label: b.label,
      from: b.from,
      to: b.to,
      L2: r.L2.amount,
      L3: r.L3.amount,
      L4: r.L4.amount,
      external: r.external,
      internal: r.internal.truckToDepot.amount + r.internal.storeToDepot.amount,
      tripsCompleted: t.totals.completed,
      tripsScheduled: t.totals.scheduled,
      gallons: g.total,
      receivableBalance: recv.balance,
      overduePct: recv.overduePct,
      byTruck,
      byDepot,
    });
  }
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const c = (k: keyof TrendReport["change"]) => (last && prev ? change(last[k] as number, prev[k] as number) : null);
  return {
    granularity,
    points,
    trucks: [...trucks].sort(),
    depots: [...depots].sort(),
    change: { external: c("external"), L2: c("L2"), L3: c("L3"), L4: c("L4"), tripsCompleted: c("tripsCompleted"), gallons: c("gallons"), receivableBalance: c("receivableBalance"), overduePct: c("overduePct") },
  };
}

/** Tren 13 minggu/bulan (US-M9-06) — hanya pemilik. */
export async function getTrend(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<TrendReport> {
  await authorize(ctx, "m9.trend.read", { tx: opts.tx });
  const data = parseInput(trendSchema, input, { granularity: "Periode", to: "Sampai" });
  const db = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const to = data.to && data.to < today ? data.to : today;
  const rules = await reportRules(db, today, ctx.tenantId);
  return computeTrend(db, ctx.tenantId, data.granularity, to, rules.trend_periods);
}
