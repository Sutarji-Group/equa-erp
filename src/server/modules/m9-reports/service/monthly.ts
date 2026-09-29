/**
 * M9 — Laporan bulanan laba kotor per lini & konsolidasi (US-M9-02; FR-M9-02, BR-29/30/32/33, KPI-09, PTB-39, CR-09)
 * dan ekspor berkas Final yang identik saat diekspor ulang (US-M9-03 KP-4).
 *
 * - Sumber: jurnal M11 terposting pada PERIODE (bukan tanggal jurnal — posting ke periode terbuka berikutnya tetap masuk
 *   periode itu, BR-32). Pendapatan = Σ (kredit − debit) akun pendapatan; harga pokok/biaya langsung = Σ (debit − kredit)
 *   akun beban berkode `5-` (bagan akun M11 "BEBAN POKOK & BEBAN LANGSUNG"); beban operasional (`6-`, `7-`) sebagai
 *   informasi. Per pusat laba L1–L5 + Umum.
 * - Konsolidasi mengeliminasi akun transfer internal (`accounts.is_internal_transfer`: pendapatan transfer internal
 *   L2→L3 / L4→L3 dan beban air depot transfer internal) sehingga laba gabungan tidak dihitung ganda (BR-33).
 * - Status: "Sementara" selama periode belum Dikunci; "Final" setelah periode Dikunci (BR-32, 7.9.3) — versi Final
 *   disimpan (`report_snapshots`) dan tidak berubah; pembukaan periode → versi Final lama tetap tersimpan, kunci ulang →
 *   revisi baru (US-M11-10 KP-4). Tersedia ≤ tanggal PAR-23 bulan berikutnya (KPI-09).
 * - M11 belum aktif (flag `accounting.m11_active` mati): omzet per lini operasional (metrics) + biaya yang sudah
 *   tercatat (pengeluaran rit M3, pembelian toko M7) berlabel "belum lengkap — M11 belum aktif" (KP-5).
 * - Biaya produksi air per liter L1 = total biaya L1 ÷ liter pengisian M8, per sumber & gabungan, tren bulanan (KP-6).
 */
import "server-only";

import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { accountingPeriods, accounts, attachments, exportLogs, journalLines, journals, reportSnapshots, waterSources } from "@/db/schema";
import type { RevenueFigures } from "@/client/m9-reports/types";
import { label, type ProfitCenter } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { lastDayOfMonth, toBusinessDate, toWibParts, type BusinessDate } from "@/lib/time";

import { logAccess } from "@/server/core/access-log";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { exportReport, type ExportResult } from "@/server/core/export";
import { isEnabled } from "@/server/core/flags";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize } from "@/server/core/rbac";
import { put, readAttachment } from "@/server/core/storage";
import * as m11 from "@/server/modules/m11-accounting";
import * as m8 from "@/server/modules/m8-production";

import { revenueForRange } from "../metrics";
import { exportMonthlySchema, monthlyDrilldownSchema, monthlyReportSchema } from "../schemas";
import { reportRules } from "./h0";

export const MONTHLY_REPORT_KEY = "m9.monthly_gross_profit";
export const PROFIT_CENTERS: readonly ProfitCenter[] = ["L1", "L2", "L3", "L4", "L5", "SHARED"];

export type MonthlyLine = {
  profitCenter: ProfitCenter;
  label: string;
  revenue: number;
  directCost: number;
  grossProfit: number;
  marginPct: number | null;
  operatingExpense: number;
  /** Bagian transfer internal yang dieliminasi pada konsolidasi. */
  internalRevenue: number;
  internalCost: number;
};

export type WaterCostRow = { sourceId: string | null; code: string; name: string; cost: number; liters: number; costPerLiter: number | null };

export type MonthlyFigures = {
  source: "journals" | "operational";
  lines: MonthlyLine[];
  consolidated: { revenue: number; directCost: number; grossProfit: number; marginPct: number | null; eliminatedRevenue: number; eliminatedCost: number; operatingExpense: number };
  /** Omzet bruto per lini (BR-30) — pendapatan luar tanpa transfer internal. */
  grossRevenueByLine: Record<ProfitCenter, number>;
  waterCost: { perSource: WaterCostRow[]; combined: WaterCostRow };
};

export type MonthlyGrossProfit = MonthlyFigures & {
  month: string;
  periodId: string | null;
  periodStatus: string | null;
  periodStatusLabel: string;
  periodRevision: number;
  status: "provisional" | "final";
  statusLabel: string;
  statusNote: string;
  incomplete: boolean;
  incompleteNote: string | null;
  availability: { deadline: BusinessDate; late: boolean };
  /**
   * Pemantauan PKP (US-M11-08 KP-4, B-54): SATU definisi = M11 `pkpStatus` (omzet luar 12 bulan berjalan dari jurnal,
   * sama dengan `/akuntansi/pajak`) termasuk proyeksi bulan tercapai. Selama M11 belum aktif (belum ada jurnal) dipakai
   * perkiraan omzet operasional (`source: "operational"`, tanpa proyeksi).
   */
  pkp: {
    months: string[];
    twelveMonthRevenue: number;
    threshold: number;
    pct: number;
    levels: number[];
    reached: number | null;
    /** Rata-rata omzet 3 bulan terakhir (dasar proyeksi). */
    avg3: number;
    /** Bulan (YYYY-MM) batas PKP diproyeksikan tercapai; null = tidak dalam jangkauan / belum dihitung. */
    projectedPeriod: string | null;
    source: "m11" | "operational";
  };
  comparison: { previous: ComparisonRow | null; lastYear: ComparisonRow | null };
  waterCostTrend: { month: string; cost: number; liters: number; costPerLiter: number | null }[];
  operational: RevenueFigures;
  final: { snapshotId: string; revision: number; generatedAt: string } | null;
  previousFinals: { snapshotId: string; revision: number; generatedAt: string }[];
};

export type ComparisonRow = { month: string; revenue: number; grossProfit: number; marginPct: number | null; byLine: Record<ProfitCenter, { revenue: number; grossProfit: number }> };

const pct = (num: number, den: number) => (den === 0 ? null : Math.round((num / den) * 10_000) / 100);

function monthRange(month: string): { from: BusinessDate; to: BusinessDate } {
  const from = `${month}-01`;
  return { from, to: lastDayOfMonth(from) };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

async function periodOf(tx: Tx, tenantId: string, month: string) {
  const [p] = await tx.select().from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, tenantId), eq(accountingPeriods.period, month))).limit(1);
  return p ?? null;
}

// =====================================================================================================================
// Perhitungan dari jurnal M11
// =====================================================================================================================

type AccountAgg = { profitCenter: ProfitCenter; accountId: string; code: string; name: string; type: string; internal: boolean; internalSource: boolean; debit: number; credit: number };

async function accountAggregates(tx: Tx, tenantId: string, periodId: string): Promise<AccountAgg[]> {
  const rows = await tx
    .select({
      profitCenter: journalLines.profitCenter,
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      internal: accounts.isInternalTransfer,
      // Satu definisi dengan konsolidasi M11: baris jurnal dari transfer internal (mis. HPP toko atas barang yang
      // dikirim ke depot) dieliminasi walau akunnya bukan akun internal (US-M9-02 KP-2, BR-33).
      internalSource: sql<boolean>`coalesce(${journals.sourceType} in (${sql.join(
        [...m11.INTERNAL_TRANSFER_SOURCES].map((x) => sql`${x}`),
        sql`, `,
      )}), false)`,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journals.tenantId, tenantId), eq(journals.status, "posted"), eq(journals.periodId, periodId), inArray(accounts.type, ["revenue", "expense"])))
    .groupBy(journalLines.profitCenter, accounts.id, accounts.code, accounts.name, accounts.type, accounts.isInternalTransfer, sql`7`);
  return rows.map((r) => ({ ...r, internalSource: Boolean(r.internalSource), profitCenter: r.profitCenter as ProfitCenter, debit: Number(r.debit), credit: Number(r.credit) }));
}

/** Klasifikasi akun: pendapatan / biaya langsung (`5-`) / beban operasional. */
export function accountClass(a: { type: string; code: string }): "revenue" | "direct" | "operating" {
  if (a.type === "revenue") return "revenue";
  return a.code.startsWith("5") ? "direct" : "operating";
}

function emptyLines(): Map<ProfitCenter, MonthlyLine> {
  return new Map(
    PROFIT_CENTERS.map((pc) => [
      pc,
      { profitCenter: pc, label: label("profit_center", pc), revenue: 0, directCost: 0, grossProfit: 0, marginPct: null, operatingExpense: 0, internalRevenue: 0, internalCost: 0 },
    ]),
  );
}

function finishLines(map: Map<ProfitCenter, MonthlyLine>): MonthlyFigures["lines"] {
  for (const l of map.values()) {
    l.grossProfit = l.revenue - l.directCost;
    l.marginPct = pct(l.grossProfit, l.revenue);
  }
  return [...map.values()];
}

/**
 * Konsolidasi (US-M9-02 KP-2, BR-33): pendapatan & biaya transfer internal dieliminasi (akun internal + baris jurnal
 * bersumber transfer internal), lalu markup harga mitra yang ikut terpakai sebagai beban bahan depot dikurangkan dari
 * biaya — sama dengan laba rugi konsolidasi M11 (`computeInternalMarkup`).
 */
function consolidate(lines: MonthlyLine[], markupRealized = 0): MonthlyFigures["consolidated"] {
  const revenue = lines.reduce((s, l) => s + l.revenue - l.internalRevenue, 0);
  const directCost = lines.reduce((s, l) => s + l.directCost - l.internalCost, 0) - markupRealized;
  return {
    revenue,
    directCost,
    grossProfit: revenue - directCost,
    marginPct: pct(revenue - directCost, revenue),
    eliminatedRevenue: lines.reduce((s, l) => s + l.internalRevenue, 0),
    eliminatedCost: lines.reduce((s, l) => s + l.internalCost, 0) + markupRealized,
    operatingExpense: lines.reduce((s, l) => s + l.operatingExpense, 0),
  };
}

/** Biaya L1 per sumber air (jurnal non-alokasi) ÷ liter pengisian M8 (PTB-39, CR-09). */
async function waterCostForPeriod(tx: Tx, tenantId: string, month: string, periodId: string | null, m11Active: boolean): Promise<MonthlyFigures["waterCost"]> {
  const { from, to } = monthRange(month);
  const sources = await tx.select({ id: waterSources.id, code: waterSources.code, name: waterSources.name }).from(waterSources).where(eq(waterSources.tenantId, tenantId)).orderBy(asc(waterSources.code));
  const totals = await m8.fillTotalsByDay(tx, sources.map((s) => s.id), from, to);
  const liters = new Map<string, number>();
  for (const [key, v] of totals) {
    const sourceId = key.split(":")[0]!;
    liters.set(sourceId, (liters.get(sourceId) ?? 0) + v.totalL);
  }
  const costBySource = new Map<string | null, number>();
  if (m11Active && periodId) {
    const rows = await tx
      .select({ sourceId: journalLines.waterSourceId, amount: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(
        and(
          eq(journals.tenantId, tenantId),
          eq(journals.status, "posted"),
          eq(journals.periodId, periodId),
          eq(journalLines.profitCenter, "L1"),
          eq(accounts.type, "expense"),
          sql`${journals.kind} <> 'allocation'`,
        ),
      )
      .groupBy(journalLines.waterSourceId);
    for (const r of rows) costBySource.set(r.sourceId, Number(r.amount));
  }
  const totalLiters = [...liters.values()].reduce((s, v) => s + v, 0);
  const unassigned = costBySource.get(null) ?? 0;
  const perSource: WaterCostRow[] = sources.map((s) => {
    const l = liters.get(s.id) ?? 0;
    const share = totalLiters > 0 ? Math.round((unassigned * l) / totalLiters) : 0;
    const cost = (costBySource.get(s.id) ?? 0) + share;
    return { sourceId: s.id, code: s.code, name: s.name, cost, liters: l, costPerLiter: m11Active && l > 0 ? Math.round((cost / l) * 100) / 100 : null };
  });
  const totalCost = [...costBySource.values()].reduce((s, v) => s + v, 0);
  return {
    perSource,
    combined: { sourceId: null, code: "GAB", name: "Gabungan", cost: totalCost, liters: totalLiters, costPerLiter: m11Active && totalLiters > 0 ? Math.round((totalCost / totalLiters) * 100) / 100 : null },
  };
}

/** Angka bulanan dari jurnal M11 (atau operasional bila M11 belum aktif). Tanpa otorisasi. */
export async function computeMonthlyFigures(
  tx: Tx,
  tenantId: string,
  month: string,
  m11Active: boolean,
  opts: { withWaterCost?: boolean } = {},
): Promise<MonthlyFigures & { operational: RevenueFigures; periodId: string | null }> {
  const { from, to } = monthRange(month);
  const period = await periodOf(tx, tenantId, month);
  const operational = await revenueForRange(tx, tenantId, from, to);
  const map = emptyLines();
  if (m11Active) {
    if (period) {
      for (const a of await accountAggregates(tx, tenantId, period.id)) {
        const line = map.get(a.profitCenter) ?? map.get("SHARED")!;
        const cls = accountClass(a);
        if (cls === "revenue") {
          const amount = a.credit - a.debit;
          line.revenue += amount;
          if (a.internal || a.internalSource) line.internalRevenue += amount;
        } else if (cls === "direct") {
          const amount = a.debit - a.credit;
          line.directCost += amount;
          if (a.internal || a.internalSource) line.internalCost += amount;
        } else {
          line.operatingExpense += a.debit - a.credit;
        }
      }
    }
  } else {
    // KP-5: omzet operasional per lini + biaya yang sudah tercatat (pengeluaran rit, pembelian toko).
    map.get("L2")!.revenue = operational.L2.amount;
    map.get("L3")!.revenue = operational.L3.amount;
    map.get("L4")!.revenue = operational.L4.amount;
    const exp = await tx.execute<{ total: string }>(sql`
      select coalesce(sum(amount), 0) as total from trip_expenses
      where tenant_id = ${tenantId} and business_date >= ${from} and business_date <= ${to} and status = 'accepted'`);
    map.get("L2")!.directCost = Number(exp.rows[0]?.total ?? 0);
    const buys = await tx.execute<{ total: string }>(sql`
      select coalesce(sum(case when reversal_of_id is null then total_amount else -abs(total_amount) end), 0) as total from purchase_receipts
      where tenant_id = ${tenantId} and business_date >= ${from} and business_date <= ${to}
        and status in ('received', 'reversed') and is_opening_payable = false`);
    map.get("L4")!.directCost = Number(buys.rows[0]?.total ?? 0);
  }
  const lines = finishLines(map);
  const markupRealized = m11Active && period ? (await m11.computeInternalMarkup(tx, tenantId, month, month)).realized : 0;
  const grossRevenueByLine = Object.fromEntries(lines.map((l) => [l.profitCenter, l.revenue - l.internalRevenue])) as Record<ProfitCenter, number>;
  return {
    source: m11Active ? "journals" : "operational",
    lines,
    consolidated: consolidate(lines, markupRealized),
    grossRevenueByLine,
    waterCost:
      opts.withWaterCost === false
        ? { perSource: [], combined: { sourceId: null, code: "GAB", name: "Gabungan", cost: 0, liters: 0, costPerLiter: null } }
        : await waterCostForPeriod(tx, tenantId, month, period?.id ?? null, m11Active),
    operational,
    periodId: period?.id ?? null,
  };
}

function comparisonOf(month: string, f: MonthlyFigures): ComparisonRow {
  return {
    month,
    revenue: f.consolidated.revenue,
    grossProfit: f.consolidated.grossProfit,
    marginPct: f.consolidated.marginPct,
    byLine: Object.fromEntries(f.lines.map((l) => [l.profitCenter, { revenue: l.revenue, grossProfit: l.grossProfit }])) as ComparisonRow["byLine"],
  };
}

function hasMonthData(f: MonthlyFigures & { periodId: string | null }, m11Active: boolean): boolean {
  if (m11Active && !f.periodId) return false;
  return f.lines.some((l) => l.revenue !== 0 || l.directCost !== 0);
}

/** Omzet bruto usaha (BR-30): pendapatan luar L1–L5 tanpa transfer internal & tanpa pendapatan lain-lain Umum. */
export function grossBusinessRevenue(f: MonthlyFigures): number {
  return (["L1", "L2", "L3", "L4", "L5"] as const).reduce((s, pc) => s + (f.grossRevenueByLine[pc] ?? 0), 0);
}

async function finalSnapshots(tx: Tx, tenantId: string, month: string) {
  return tx
    .select()
    .from(reportSnapshots)
    .where(and(eq(reportSnapshots.tenantId, tenantId), eq(reportSnapshots.reportKey, MONTHLY_REPORT_KEY), eq(reportSnapshots.period, month), eq(reportSnapshots.status, "final")))
    .orderBy(desc(reportSnapshots.revision));
}

/**
 * Status PKP untuk bulan `month` (B-54). M11 aktif → `m11.pkpStatus` per akhir bulan itu (atau hari ini untuk bulan
 * berjalan); M11 belum aktif → perkiraan omzet operasional 12 bulan (tanpa jurnal, tanpa proyeksi).
 */
async function pkpFor(
  tx: Tx,
  tenantId: string,
  month: string,
  today: BusinessDate,
  m11Active: boolean,
  figures: Awaited<ReturnType<typeof computeMonthlyFigures>>,
  prev: Awaited<ReturnType<typeof computeMonthlyFigures>>,
): Promise<MonthlyGrossProfit["pkp"]> {
  const monthEnd = lastDayOfMonth(`${month}-01`);
  const asOf = monthEnd < today ? monthEnd : today;
  if (m11Active) {
    const s = await m11.pkpStatus(tx, tenantId, asOf);
    return {
      months: s.months.map((m) => m.period).reverse(),
      twelveMonthRevenue: s.total,
      threshold: s.threshold,
      pct: s.percent,
      levels: s.warnPercents,
      reached: s.level,
      avg3: s.avg3,
      projectedPeriod: s.projectedPeriod,
      source: "m11",
    };
  }
  const par22 = await params.get(tx, "PAR-22", asOf, { tenantId });
  const threshold = Number(par22.threshold);
  const levels = par22.warn_percents.map(Number);
  const months: string[] = [];
  const revenues: number[] = [];
  for (let i = 0; i < par22.window_months; i++) {
    const m = shiftMonth(month, -i);
    months.push(m);
    const f = i === 0 ? figures : i === 1 ? prev : await computeMonthlyFigures(tx, tenantId, m, m11Active, { withWaterCost: false });
    revenues.push(grossBusinessRevenue(f));
  }
  const twelve = revenues.reduce((a, b) => a + b, 0);
  const pct = threshold > 0 ? Math.round((twelve / threshold) * 10_000) / 100 : 0;
  const reached = [...levels].sort((a, b) => b - a).find((lv) => pct >= lv) ?? null;
  const last3 = revenues.slice(0, 3);
  const avg3 = last3.length ? Math.round(last3.reduce((a, b) => a + b, 0) / last3.length) : 0;
  return { months, twelveMonthRevenue: twelve, threshold, pct, levels, reached, avg3, projectedPeriod: null, source: "operational" };
}

/** Laporan lengkap (tanpa versi Final) untuk satu bulan — dasar Sementara dan isi snapshot Final. */
async function buildReport(tx: Tx, tenantId: string, month: string, today: BusinessDate): Promise<Omit<MonthlyGrossProfit, "final" | "previousFinals">> {
  const m11Active = await isEnabled(tx, "accounting.m11_active", { tenantId });
  const figures = await computeMonthlyFigures(tx, tenantId, month, m11Active);
  const period = figures.periodId ? await periodOf(tx, tenantId, month) : null;
  const par23 = await params.get(tx, "PAR-23", today, { tenantId });
  const next = shiftMonth(month, 1);
  const deadline = `${next}-${String(par23.day_of_next_month).padStart(2, "0")}`;
  const isFinal = period?.status === "locked";
  // Pembanding (KP-3): bulan sebelumnya & bulan yang sama tahun lalu — bila datanya ada.
  const prevMonth = shiftMonth(month, -1);
  const lyMonth = shiftMonth(month, -12);
  const prev = await computeMonthlyFigures(tx, tenantId, prevMonth, m11Active, { withWaterCost: false });
  const ly = await computeMonthlyFigures(tx, tenantId, lyMonth, m11Active, { withWaterCost: false });
  // PKP (BR-29, FR-M11-12, B-54): omzet bruto usaha 12 bulan berjalan (s.d. bulan ini) vs batas PAR-22 + peringatan
  // 80%/90% + proyeksi — dari M11 `pkpStatus` (satu definisi dengan /akuntansi/pajak).
  const pkp = await pkpFor(tx, tenantId, month, today, m11Active, figures, prev);
  // Tren biaya air per liter (KP-6).
  const rules = await reportRules(tx, today, tenantId);
  const trend: MonthlyGrossProfit["waterCostTrend"] = [];
  for (let i = rules.water_cost_trend_months - 1; i >= 0; i--) {
    const m = shiftMonth(month, -i);
    const p = await periodOf(tx, tenantId, m);
    const w = await waterCostForPeriod(tx, tenantId, m, p?.id ?? null, m11Active);
    trend.push({ month: m, cost: w.combined.cost, liters: w.combined.liters, costPerLiter: w.combined.costPerLiter });
  }
  return {
    ...figures,
    month,
    periodId: period?.id ?? null,
    periodStatus: period?.status ?? null,
    periodStatusLabel: period ? label("period_status", period.status) : "Belum ada jurnal",
    periodRevision: period?.revision ?? 0,
    status: isFinal ? "final" : "provisional",
    statusLabel: label("report_status", isFinal ? "final" : "provisional"),
    statusNote: isFinal
      ? "Periode dikunci pemilik — angka Final; perubahan hanya lewat jurnal periode berikutnya (BR-32)."
      : period?.status === "closed"
        ? "Periode sudah ditutup Admin Keuangan, menunggu dikunci pemilik — angka masih Sementara."
        : "Periode belum ditutup/dikunci — angka Sementara dan dapat berubah.",
    incomplete: !m11Active,
    incompleteNote: m11Active ? null : "Belum lengkap — M11 belum aktif: omzet operasional per lini dan biaya yang sudah tercatat (pengeluaran rit, pembelian toko).",
    availability: { deadline, late: !isFinal && today > deadline },
    pkp,
    comparison: {
      previous: hasMonthData(prev, m11Active) ? comparisonOf(prevMonth, prev) : null,
      lastYear: hasMonthData(ly, m11Active) ? comparisonOf(lyMonth, ly) : null,
    },
    waterCostTrend: trend,
  };
}

/**
 * Simpan versi Final (idempoten) bila periode Dikunci: revisi baru bila periode dibuka & dikunci ulang (US-M11-10 KP-4).
 * Mengembalikan snapshot Final yang berlaku atau `null` bila periode belum Dikunci.
 */
export async function finalizeMonthlyReport(tx: Tx, input: { tenantId: string; month: string; now: Date; notifyOwner?: boolean }): Promise<typeof reportSnapshots.$inferSelect | null> {
  const period = await periodOf(tx, input.tenantId, input.month);
  if (!period || period.status !== "locked") return null;
  const existing = await finalSnapshots(tx, input.tenantId, input.month);
  const current = existing.find((s) => !s.supersededById);
  if (current && Number((current.data as { periodRevision?: number }).periodRevision ?? 0) === period.revision) return current;
  const report = await buildReport(tx, input.tenantId, input.month, toBusinessDate(input.now));
  const revision = (existing[0]?.revision ?? 0) + 1;
  if (current) {
    // Versi lama tetap tersimpan; ditandai digantikan sebelum versi baru disisipkan (unik satu Final berlaku).
    await tx.update(reportSnapshots).set({ supersededById: current.id, updatedAt: input.now }).where(eq(reportSnapshots.id, current.id));
  }
  const [row] = await tx
    .insert(reportSnapshots)
    .values({
      tenantId: input.tenantId,
      reportKey: MONTHLY_REPORT_KEY,
      period: input.month,
      revision,
      status: "final",
      scopeKey: "",
      filters: { month: input.month },
      data: { ...report, final: null, previousFinals: [] } as unknown as Record<string, unknown>,
      accountingPeriodId: period.id,
      generatedAt: input.now,
    })
    .returning();
  if (current) await tx.update(reportSnapshots).set({ supersededById: row!.id }).where(eq(reportSnapshots.id, current.id));
  const ctx = systemContext({ tenantId: input.tenantId, now: input.now });
  await auditRecord(tx, {
    ctx,
    objectType: "report_snapshot",
    objectId: row!.id,
    action: "finalize",
    after: { reportKey: MONTHLY_REPORT_KEY, period: input.month, revision, periodRevision: period.revision, grossProfit: report.consolidated.grossProfit },
    rule: "BR-32, US-M9-02 KP-2",
  });
  if (input.notifyOwner) {
    await notify(tx, {
      event: "monthly_report.final",
      tenantId: input.tenantId,
      title: `Laporan laba kotor ${input.month} Final${revision > 1 ? ` (revisi ${revision})` : ""}`,
      body: `Laba kotor gabungan ${formatRupiah(report.consolidated.grossProfit)} dari omzet ${formatRupiah(report.consolidated.revenue)}.`,
      objectType: "report_snapshot",
      objectId: row!.id,
      valueAmount: report.consolidated.grossProfit,
      link: `/laporan/bulanan?bulan=${input.month}`,
      now: input.now,
    });
  }
  return row!;
}

export async function finalizeMonthlyReportForPeriod(tx: Tx, input: { tenantId: string; periodId: string; now: Date; notifyOwner?: boolean }) {
  const [p] = await tx.select().from(accountingPeriods).where(eq(accountingPeriods.id, input.periodId)).limit(1);
  if (!p) return null;
  return finalizeMonthlyReport(tx, { tenantId: input.tenantId, month: p.period, now: input.now, notifyOwner: input.notifyOwner });
}

/** Job cadangan: periode Dikunci tanpa versi Final yang berlaku. */
export async function finalizeLockedPeriods(now: Date, db: Tx = getDb()): Promise<{ finalized: string[] }> {
  const locked = await db.select().from(accountingPeriods).where(eq(accountingPeriods.status, "locked"));
  const finalized: string[] = [];
  for (const p of locked) {
    await withTx(async (tx) => {
      const before = (await finalSnapshots(tx, p.tenantId, p.period)).find((s) => !s.supersededById);
      const row = await finalizeMonthlyReport(tx, { tenantId: p.tenantId, month: p.period, now, notifyOwner: true });
      if (row && row.id !== before?.id) finalized.push(`${p.tenantId}:${p.period}`);
    });
  }
  return { finalized };
}

/** Laporan laba kotor bulanan (US-M9-02). Periode Dikunci → versi Final tersimpan (dibuat bila belum ada). */
export async function getMonthlyReport(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<MonthlyGrossProfit> {
  await authorize(ctx, "m9.monthly_report.read", { tx: opts.tx });
  const { month } = parseInput(monthlyReportSchema, input, { month: "Bulan" });
  const db = opts.tx ?? getDb();
  const period = await periodOf(db, ctx.tenantId, month);
  if (period?.status === "locked") {
    const current = (await finalSnapshots(db, ctx.tenantId, month)).find((s) => !s.supersededById);
    const fresh = current && Number((current.data as { periodRevision?: number }).periodRevision ?? 0) === period.revision ? current : null;
    const snap = fresh ?? (opts.tx ? await finalizeMonthlyReport(opts.tx, { tenantId: ctx.tenantId, month, now: ctx.now }) : await withTx((tx) => finalizeMonthlyReport(tx, { tenantId: ctx.tenantId, month, now: ctx.now })));
    const all = await finalSnapshots(db, ctx.tenantId, month);
    const data = snap!.data as unknown as MonthlyGrossProfit;
    // Versi Final sebelum B-54 tidak menyimpan proyeksi/sumber PKP.
    const storedPkp = data.pkp as Partial<MonthlyGrossProfit["pkp"]> & Omit<MonthlyGrossProfit["pkp"], "avg3" | "projectedPeriod" | "source">;
    return {
      ...data,
      pkp: { ...storedPkp, avg3: storedPkp.avg3 ?? 0, projectedPeriod: storedPkp.projectedPeriod ?? null, source: storedPkp.source ?? "m11" },
      final: { snapshotId: snap!.id, revision: snap!.revision, generatedAt: snap!.generatedAt.toISOString() },
      previousFinals: all.filter((s) => s.id !== snap!.id).map((s) => ({ snapshotId: s.id, revision: s.revision, generatedAt: s.generatedAt.toISOString() })),
    };
  }
  const report = await buildReport(db, ctx.tenantId, month, ctxBusinessDate(ctx));
  const all = await finalSnapshots(db, ctx.tenantId, month);
  return { ...report, final: null, previousFinals: all.map((s) => ({ snapshotId: s.id, revision: s.revision, generatedAt: s.generatedAt.toISOString() })) };
}

/**
 * Status batas PKP untuk dasbor M9 (US-M11-08 KP-4 "tampil di dashboard M9", B-54) — SATU definisi: M11 `pkpStatus`
 * (sama dengan /akuntansi/pajak, termasuk proyeksi). `null` bila M11 belum aktif (belum ada jurnal omzet).
 */
export async function pkpDashboard(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<m11.PkpStatus | null> {
  await authorize(ctx, "m9.monthly_report.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  if (!(await isEnabled(db, "accounting.m11_active", { tenantId: ctx.tenantId }))) return null;
  return m11.pkpStatus(db, ctx.tenantId, ctxBusinessDate(ctx));
}

// =====================================================================================================================
// Turun ke akun & transaksi sumber (KP-4)
// =====================================================================================================================

export type MonthlyAccountRow = { accountId: string; code: string; name: string; cls: "revenue" | "direct" | "operating"; internal: boolean; amount: number };
export type MonthlyJournalRow = {
  journalId: string;
  number: string;
  date: string;
  kind: string;
  kindLabel: string;
  description: string;
  sourceType: string | null;
  sourceRef: string | null;
  sourceHref: string | null;
  amount: number;
  originPeriod: string | null;
};

async function sourceLinks(tx: Tx, rows: { sourceObjectType: string | null; sourceObjectId: string | null; journalId: string; kind: string }[]): Promise<Map<string, { ref: string | null; href: string | null }>> {
  const out = new Map<string, { ref: string | null; href: string | null }>();
  const ids = (t: string) => [...new Set(rows.filter((r) => r.sourceObjectType === t && r.sourceObjectId).map((r) => r.sourceObjectId!))];
  const tripIds = ids("trip");
  const saleIds = ids("pos_sale");
  const trips = tripIds.length ? (await tx.execute<{ id: string; number: string; order_id: string }>(sql`select id, number, order_id from trips where id::text = any(${`{${tripIds.join(",")}}`}::text[])`)).rows : [];
  const sales = saleIds.length ? (await tx.execute<{ id: string; number: string | null; shift_id: string }>(sql`select id, number, shift_id from pos_sales where id::text = any(${`{${saleIds.join(",")}}`}::text[])`)).rows : [];
  for (const r of rows) {
    const t = r.sourceObjectType;
    const id = r.sourceObjectId;
    let ref: string | null = null;
    let href: string | null = null;
    if (t === "trip" && id) {
      const tr = trips.find((x) => x.id === id);
      ref = tr ? `Rit ${tr.number}` : "Rit";
      href = tr ? `/pesanan/${tr.order_id}` : null;
    } else if (t === "pos_sale" && id) {
      const s = sales.find((x) => x.id === id);
      ref = s ? `Transaksi ${s.number ?? ""}`.trim() : "Transaksi POS";
      href = s ? `/outlet/shift/${s.shift_id}` : null;
    } else if (t === "shift" && id) {
      ref = "Shift";
      href = `/outlet/shift/${id}`;
    } else if (t === "invoice" && id) {
      ref = "Faktur";
      href = `/piutang/faktur/${id}`;
    } else if (t === "deposit" && id) {
      ref = "Setoran";
      href = `/kas/setoran/${id}`;
    } else if (t === "purchase_receipt" && id) {
      ref = "Nota pembelian";
      href = `/toko/pembelian/${id}`;
    } else if (r.kind === "manual") {
      ref = "Jurnal manual";
      href = `/akuntansi/jurnal?id=${r.journalId}`;
    } else if (t) {
      ref = t;
    }
    out.set(r.journalId, { ref, href });
  }
  return out;
}

/** Turun ke akun (per pusat laba) dan ke jurnal & transaksi sumbernya (US-M9-02 KP-4). */
export async function monthlyDrilldown(
  ctx: ActorContext,
  input: unknown,
  opts: { tx?: Tx } = {},
): Promise<{ month: string; profitCenter: ProfitCenter | null; accounts: MonthlyAccountRow[]; journals: MonthlyJournalRow[] }> {
  await authorize(ctx, "m9.monthly_report.read", { tx: opts.tx });
  const data = parseInput(monthlyDrilldownSchema, input, { month: "Bulan", profitCenter: "Lini", accountId: "Akun" });
  const db = opts.tx ?? getDb();
  const period = await periodOf(db, ctx.tenantId, data.month);
  if (!period) return { month: data.month, profitCenter: data.profitCenter ?? null, accounts: [], journals: [] };
  const aggs = (await accountAggregates(db, ctx.tenantId, period.id)).filter((a) => !data.profitCenter || a.profitCenter === data.profitCenter);
  const byAccount = new Map<string, MonthlyAccountRow>();
  for (const a of aggs) {
    const cls = accountClass(a);
    const cur = byAccount.get(a.accountId) ?? { accountId: a.accountId, code: a.code, name: a.name, cls, internal: a.internal, amount: 0 };
    cur.amount += cls === "revenue" ? a.credit - a.debit : a.debit - a.credit;
    byAccount.set(a.accountId, cur);
  }
  const accountsList = [...byAccount.values()].sort((x, y) => x.code.localeCompare(y.code));
  let journalRows: MonthlyJournalRow[] = [];
  if (data.accountId) {
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, data.accountId)).limit(1);
    if (!acc || acc.tenantId !== ctx.tenantId) throw new NotFoundError("Akun tidak ditemukan.");
    const cls = accountClass(acc);
    const conds = [eq(journals.tenantId, ctx.tenantId), eq(journals.status, "posted"), eq(journals.periodId, period.id), eq(journalLines.accountId, data.accountId)];
    if (data.profitCenter) conds.push(eq(journalLines.profitCenter, data.profitCenter));
    const rows = await db
      .select({
        journalId: journals.id,
        number: journals.number,
        date: journals.journalDate,
        kind: journals.kind,
        description: journals.description,
        sourceType: journals.sourceType,
        sourceObjectType: journals.sourceObjectType,
        sourceObjectId: journals.sourceObjectId,
        originPeriod: journals.originPeriod,
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(and(...conds))
      .groupBy(journals.id)
      .orderBy(asc(journals.journalDate), asc(journals.number))
      .limit(500);
    const links = await sourceLinks(db, rows.map((r) => ({ sourceObjectType: r.sourceObjectType, sourceObjectId: r.sourceObjectId, journalId: r.journalId, kind: r.kind })));
    journalRows = rows.map((r) => ({
      journalId: r.journalId,
      number: r.number,
      date: r.date,
      kind: r.kind,
      kindLabel: label("journal_kind", r.kind),
      description: r.description,
      sourceType: r.sourceType,
      sourceRef: links.get(r.journalId)?.ref ?? null,
      sourceHref: links.get(r.journalId)?.href ?? null,
      amount: cls === "revenue" ? Number(r.credit) - Number(r.debit) : Number(r.debit) - Number(r.credit),
      originPeriod: r.originPeriod,
    }));
  }
  return { month: data.month, profitCenter: data.profitCenter ?? null, accounts: accountsList, journals: journalRows };
}

// =====================================================================================================================
// Ekspor berkas Final identik (US-M9-03 KP-4)
// =====================================================================================================================

const CONTENT_TYPE: Record<"xlsx" | "pdf", string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

export type MonthlyExportResult = { filename: string; contentType: string; body: Buffer; sha256: string; reused: boolean; final: boolean };

/**
 * Ekspor laporan bulanan. Periode Final → berkas pertama disimpan dan disajikan ulang IDENTIK (byte sama) pada ekspor
 * berikutnya; setiap ekspor tetap tercatat di `export_logs` + log akses (KP-2). Sementara → dirender ulang.
 */
export async function exportMonthlyReport(ctx: ActorContext, input: unknown): Promise<MonthlyExportResult> {
  await authorize(ctx, "m9.monthly_report.read");
  const data = parseInput(exportMonthlySchema, input, { month: "Bulan", format: "Format" });
  const report = await getMonthlyReport(ctx, { month: data.month });
  if (!report.final) {
    const res: ExportResult = await exportReport(ctx, MONTHLY_REPORT_KEY, data.format, { month: data.month });
    return { filename: res.filename, contentType: res.contentType, body: res.body, sha256: res.sha256, reused: false, final: false };
  }
  const snapshotId = report.final.snapshotId;
  const kind = `report_final_${data.format}`;
  const db = getDb();
  const [stored] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.objectType, "report_snapshot"), eq(attachments.objectId, snapshotId), eq(attachments.kind, kind), isNull(attachments.archivedAt)))
    .orderBy(asc(attachments.createdAt))
    .limit(1);
  if (stored) {
    const { row, body } = await readAttachment(ctx, stored.id);
    const sha256 = createHash("sha256").update(body).digest("hex");
    await withTx(async (tx) => {
      const [log] = await tx
        .insert(exportLogs)
        .values({ tenantId: ctx.tenantId, userId: ctx.userId!, reportKey: MONTHLY_REPORT_KEY, format: data.format, filters: { month: data.month, final: true, revision: report.final!.revision }, containsPersonalData: false, purpose: null, rowCount: null, fileSha256: sha256 })
        .returning({ id: exportLogs.id });
      await logAccess(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId: ctx.deviceId,
        event: "export",
        success: true,
        objectType: "report",
        objectId: MONTHLY_REPORT_KEY,
        details: { format: data.format, final: true, reused: true, snapshotId, exportLogId: log!.id },
        occurredAt: ctx.now,
      });
    });
    return { filename: row.originalName ?? `laporan-laba-kotor-${data.month}.${data.format}`, contentType: CONTENT_TYPE[data.format], body, sha256, reused: true, final: true };
  }
  const res = await exportReport(ctx, MONTHLY_REPORT_KEY, data.format, { month: data.month });
  const filename = `laporan-laba-kotor-${data.month}-final-r${report.final.revision}.${data.format}`;
  await withTx(async (tx) => {
    await put(tx, systemContext({ tenantId: ctx.tenantId, now: ctx.now }), {
      blob: res.body,
      contentType: CONTENT_TYPE[data.format],
      kind,
      objectRef: { type: "report_snapshot", id: snapshotId },
      originalName: filename,
    });
    if (data.format === "xlsx") await tx.update(reportSnapshots).set({ fileSha256: res.sha256 }).where(eq(reportSnapshots.id, snapshotId));
  });
  return { filename, contentType: res.contentType, body: res.body, sha256: res.sha256, reused: false, final: true };
}

/** Baris ekspor laporan bulanan (ReportDef `m9.monthly_gross_profit`). */
export function monthlyExportRows(r: MonthlyGrossProfit) {
  const rows = r.lines.map((l) => ({
    line: l.label,
    revenue: l.revenue,
    directCost: l.directCost,
    grossProfit: l.grossProfit,
    marginPct: l.marginPct,
    internal: l.internalRevenue - l.internalCost,
    operatingExpense: l.operatingExpense,
  }));
  rows.push({
    line: "Eliminasi transfer internal (BR-33)",
    revenue: -r.consolidated.eliminatedRevenue,
    directCost: -r.consolidated.eliminatedCost,
    grossProfit: -(r.consolidated.eliminatedRevenue - r.consolidated.eliminatedCost),
    marginPct: null,
    internal: 0,
    operatingExpense: 0,
  });
  rows.push({
    line: "Konsolidasi",
    revenue: r.consolidated.revenue,
    directCost: r.consolidated.directCost,
    grossProfit: r.consolidated.grossProfit,
    marginPct: r.consolidated.marginPct,
    internal: 0,
    operatingExpense: r.consolidated.operatingExpense,
  });
  return rows;
}

/** Tanggal WIB untuk nama berkas/keterangan. */
export function stampOf(now: Date): string {
  const w = toWibParts(now);
  return `${w.businessDate} ${w.time}`;
}

export function assertMonthNotFuture(month: string, today: BusinessDate): void {
  if (`${month}-01` > today) throw new DomainError("FUTURE_MONTH", "Bulan belum dimulai. Pilih bulan berjalan atau sebelumnya.");
}
