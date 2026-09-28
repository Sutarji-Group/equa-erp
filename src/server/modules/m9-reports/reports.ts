/**
 * M9 — laporan yang dapat diekspor (katalog PRD 7.9.4; US-M9-03). Setiap laporan M9 memakai fungsi layanan yang sama
 * dengan layarnya (satu definisi). Ekspor lewat `/api/export/<kunci>?format=xlsx|pdf&<filter>` (log ekspor + BR-39 di
 * inti). Laporan bulanan Final diekspor lewat `/laporan/bulanan/ekspor` (berkas identik, KP-4).
 */
import "server-only";

import { z } from "zod";

import type { DailySnapshot } from "@/client/m9-reports/types";
import { label } from "@/lib/labels";
import { addDays, formatTanggal, isBusinessDate } from "@/lib/time";

import { ctxBusinessDate } from "@/server/core/context";
import { registerReport } from "@/server/core/export";

import { sumTrips, tripsDaily } from "./metrics";
import { getDailyDashboard, listDailySummaries, reportRules } from "./service/h0";
import { computeKpiMonth } from "./service/kpi";
import { getMonthlyReport, monthlyExportRows } from "./service/monthly";
import { parallelChecksInRange } from "./service/parallel";
import { computePerformance } from "./service/performance";
import { computeTrend } from "./service/trends";

const dateSchema = z.string().refine(isBusinessDate, { error: "Tanggal harus berformat YYYY-MM-DD." });
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "Bulan harus berformat YYYY-MM." });

const rangeFilters = z.object({ from: dateSchema.optional(), to: dateSchema.optional() });
const monthFilters = z.object({ month: monthSchema.optional() });

const thisMonth = (today: string) => today.slice(0, 7);

/** Baris H+0 per blok (ekspor Excel/PDF satu tanggal). */
function dailyRows(d: DailySnapshot) {
  const rows: { block: string; item: string; value: number | null; note: string }[] = [];
  const add = (block: string, item: string, value: number | null, note = "") => rows.push({ block, item, value, note });
  add("Omzet per lini", "L2 Air truk", d.revenue.L2.amount, `${d.revenue.L2.trips} rit`);
  add("Omzet per lini", "L3 Depot", d.revenue.L3.amount, `${d.revenue.L3.transactions} transaksi`);
  add("Omzet per lini", "L4 Toko", d.revenue.L4.amount, `${d.revenue.L4.transactions} transaksi`);
  add("Omzet per lini", "Omzet luar (L2+L3+L4)", d.revenue.external);
  add("Transfer internal (BR-33, bukan omzet luar)", "L2 → L3 pasokan depot", d.revenue.internal.truckToDepot.amount, `${d.revenue.internal.truckToDepot.trips} rit, ${d.revenue.internal.truckToDepot.liters} L`);
  add("Transfer internal (BR-33, bukan omzet luar)", "L4 → L3 bahan", d.revenue.internal.storeToDepot.amount, `${d.revenue.internal.storeToDepot.transfers} transfer`);
  for (const l of d.cash.byLine) add("Kas", `${l.label} — seharusnya / diterima / selisih`, l.expected, `diterima ${l.received}, selisih ${l.discrepancy}`);
  add("Kas", "Total seharusnya", d.cash.expected);
  add("Kas", "Total diterima", d.cash.received);
  add("Kas", "Total selisih", d.cash.discrepancy);
  add("Piutang", "Saldo", d.receivables.balance);
  add("Piutang", "Terbentuk", d.receivables.formed);
  add("Piutang", "Dilunasi", d.receivables.paid);
  add("Piutang", "Lewat tempo", d.receivables.overdue, `KPI-04 ${d.receivables.overduePct}% (sasaran < ${d.receivables.targetPct}%)`);
  for (const t of d.trips.byTruck) add("Rit per truk", t.truckCode, t.completed, `terjadwal ${t.scheduled}, gagal ${t.failed}`);
  for (const g of d.gallons.byDepot) add("Galon per depot", `${g.code} ${g.name}`, g.gallons, `${g.transactions} transaksi`);
  add("Pengecualian", "Persetujuan menunggu", d.exceptions.approvalsPending, `${d.exceptions.approvalsOverdue} lewat tenggat`);
  add("Pengecualian", "Selisih menunggu keputusan pemilik", d.exceptions.discrepancies.length);
  add("Pengecualian", "Rit gagal", d.exceptions.failedTrips.length);
  add("Pengecualian", "Kejadian GPS menunggu tinjauan", d.exceptions.fleet.awaitingReview, `${d.exceptions.fleet.unexplained} tanpa keterangan`);
  add("Pengecualian", "Susut air bertanda", d.exceptions.water.lossFlags.length);
  add("Pengecualian", "Transfer belum dicocokkan", d.exceptions.unmatchedTransfers);
  return rows;
}

export function registerReports(): void {
  registerReport({
    key: "m9.daily_summary",
    title: "Ringkasan H+0",
    module: "m9",
    permission: "m9.daily_summary.read",
    containsPii: false,
    filtersSchema: z.object({ date: dateSchema.optional() }),
    describeFilters: (f: { date?: string }) => [f.date ? `Tanggal: ${formatTanggal(f.date)}` : "Tanggal: hari ini"],
    columns: [
      { key: "block", header: "Blok", width: 26 },
      { key: "item", header: "Butir", width: 38 },
      { key: "value", header: "Nilai", type: "number" },
      { key: "note", header: "Keterangan", width: 40 },
    ],
    fetch: async (ctx, f: { date?: string }, { tx }) => {
      const dash = await getDailyDashboard(ctx, { date: f.date ?? ctxBusinessDate(ctx) }, { tx });
      return {
        rows: dailyRows(dash.data),
        status: dash.unclosed ? "Belum ditutup — angka dapat berubah" : `${dash.status.label}${dash.status.publishedLate ? " (terlambat)" : ""}`,
        summary: [
          { label: "Omzet luar", value: dash.data.revenue.external, type: "rupiah" },
          { label: "Selisih kas", value: dash.data.cash.discrepancy, type: "rupiah" },
          { label: "Catatan tambahan (addenda)", value: dash.addenda.length },
        ],
      };
    },
  });

  registerReport({
    key: "m9.daily_summaries",
    title: "Riwayat ringkasan H+0 (KPI-08)",
    module: "m9",
    permission: "m9.daily_summary.read",
    containsPii: false,
    filtersSchema: rangeFilters,
    describeFilters: (f: { from?: string; to?: string }) => [`Periode: ${f.from ?? "30 hari terakhir"} – ${f.to ?? "hari ini"}`],
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date" },
      { key: "statusLabel", header: "Status" },
      { key: "cashClosedAt", header: "Kas ditutup", type: "datetime" },
      { key: "publishedAt", header: "H+0 terbit", type: "datetime" },
      { key: "publishMinutes", header: "Menit (KPI-08)", type: "number" },
      { key: "publishedLate", header: "Terlambat", type: "boolean" },
      { key: "externalRevenue", header: "Omzet luar", type: "rupiah", total: true },
      { key: "cashDiscrepancy", header: "Selisih kas", type: "rupiah", total: true },
      { key: "exceptions", header: "Pengecualian", type: "number" },
    ],
    fetch: async (ctx, f: { from?: string; to?: string }, { tx }) => {
      const to = f.to ?? ctxBusinessDate(ctx);
      return { rows: await listDailySummaries(ctx, { from: f.from ?? addDays(to, -30), to }, { tx }) };
    },
  });

  registerReport({
    key: "m9.monthly_gross_profit",
    title: "Laba kotor bulanan per lini & konsolidasi",
    module: "m9",
    permission: "m9.monthly_report.read",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: { month?: string }) => [`Bulan: ${f.month ?? "berjalan"}`],
    orientation: "landscape",
    columns: [
      { key: "line", header: "Lini", width: 34 },
      { key: "revenue", header: "Omzet", type: "rupiah" },
      { key: "directCost", header: "Harga pokok/biaya langsung", type: "rupiah" },
      { key: "grossProfit", header: "Laba kotor", type: "rupiah" },
      { key: "marginPct", header: "Marjin", type: "percent" },
      { key: "internal", header: "Transfer internal (dieliminasi)", type: "rupiah" },
      { key: "operatingExpense", header: "Beban operasional (info)", type: "rupiah" },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => {
      const r = await getMonthlyReport(ctx, { month: f.month ?? thisMonth(ctxBusinessDate(ctx)) }, { tx });
      return {
        rows: monthlyExportRows(r),
        status: `${r.statusLabel}${r.final ? ` (revisi ${r.final.revision})` : ""}${r.incomplete ? " — belum lengkap, M11 belum aktif" : ""}`,
        summary: [
          { label: "Periode", value: `${r.month} — ${r.periodStatusLabel}` },
          { label: "Laba kotor konsolidasi", value: r.consolidated.grossProfit, type: "rupiah" },
          { label: "Omzet bruto 12 bulan (PKP)", value: r.pkp.twelveMonthRevenue, type: "rupiah" },
          { label: "Batas PKP terpakai", value: r.pkp.pct, type: "percent" },
          { label: "Biaya air per liter (gabungan)", value: r.waterCost.combined.costPerLiter ?? "—" },
        ],
      };
    },
  });

  registerReport({
    key: "m9.water_cost_per_liter",
    title: "Biaya produksi air per liter (L1)",
    module: "m9",
    permission: "m9.monthly_report.read",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: { month?: string }) => [`Bulan: ${f.month ?? "berjalan"}`],
    columns: [
      { key: "period", header: "Bulan" },
      { key: "source", header: "Sumber" },
      { key: "cost", header: "Biaya L1", type: "rupiah" },
      { key: "liters", header: "Liter pengisian", type: "liter" },
      { key: "costPerLiter", header: "Rp per liter", type: "number" },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => {
      const r = await getMonthlyReport(ctx, { month: f.month ?? thisMonth(ctxBusinessDate(ctx)) }, { tx });
      const rows = [
        ...r.waterCost.perSource.map((s) => ({ period: r.month, source: `${s.code} ${s.name}`, cost: s.cost, liters: s.liters, costPerLiter: s.costPerLiter })),
        { period: r.month, source: "Gabungan", cost: r.waterCost.combined.cost, liters: r.waterCost.combined.liters, costPerLiter: r.waterCost.combined.costPerLiter },
        ...r.waterCostTrend.map((t) => ({ period: t.month, source: "Gabungan (tren)", cost: t.cost, liters: t.liters, costPerLiter: t.costPerLiter })),
      ];
      return { rows, status: r.statusLabel };
    },
  });

  registerReport({
    key: "m9.gross_revenue_pkp",
    title: "Omzet bruto per lini & pemantauan PKP",
    module: "m9",
    permission: "m9.monthly_report.read",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: { month?: string }) => [`Bulan: ${f.month ?? "berjalan"}`],
    columns: [
      { key: "line", header: "Lini" },
      { key: "amount", header: "Omzet bruto", type: "rupiah", total: true },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => {
      const r = await getMonthlyReport(ctx, { month: f.month ?? thisMonth(ctxBusinessDate(ctx)) }, { tx });
      const rows = (["L1", "L2", "L3", "L4", "L5"] as const).map((pc) => ({ line: label("profit_center", pc), amount: r.grossRevenueByLine[pc] ?? 0 }));
      return {
        rows,
        status: r.statusLabel,
        summary: [
          { label: "Omzet bruto 12 bulan berjalan", value: r.pkp.twelveMonthRevenue, type: "rupiah" },
          { label: "Batas PKP (PAR-22)", value: r.pkp.threshold, type: "rupiah" },
          { label: "Persentase terhadap batas", value: r.pkp.pct, type: "percent" },
          { label: "Peringatan tercapai", value: r.pkp.reached ? `${r.pkp.reached}%` : "Belum" },
        ],
      };
    },
  });

  registerReport({
    key: "m9.trip_realization",
    title: "Rit terealisasi vs terjadwal per truk (KPI-07)",
    module: "m9",
    permission: "m9.report.read",
    containsPii: false,
    filtersSchema: rangeFilters,
    describeFilters: (f: { from?: string; to?: string }) => [`Periode: ${f.from ?? "7 hari terakhir"} – ${f.to ?? "hari ini"}`],
    columns: [
      { key: "date", header: "Tanggal", type: "date" },
      { key: "truckCode", header: "Truk" },
      { key: "scheduled", header: "Terjadwal", type: "number", total: true },
      { key: "completed", header: "Selesai", type: "number", total: true },
      { key: "failed", header: "Gagal", type: "number", total: true },
      { key: "customerPct", header: "% pelanggan", type: "percent" },
      { key: "internalPct", header: "% internal", type: "percent" },
      { key: "pct", header: "% gabungan", type: "percent" },
    ],
    fetch: async (ctx, f: { from?: string; to?: string }, { tx }) => {
      const to = f.to ?? ctxBusinessDate(ctx);
      const from = f.from ?? addDays(to, -6);
      const rows = await tripsDaily(tx, ctx.tenantId, from, to);
      const p = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
      const totals = sumTrips(rows).totals;
      return {
        rows: rows
          .sort((a, b) => (a.date === b.date ? a.truckCode.localeCompare(b.truckCode) : a.date.localeCompare(b.date)))
          .map((r) => ({
            ...r,
            customerPct: p(r.completed - r.internalCompleted, r.scheduled - r.internalScheduled),
            internalPct: p(r.internalCompleted, r.internalScheduled),
            pct: p(r.completed, r.scheduled),
          })),
        summary: [{ label: "KPI-07 gabungan", value: p(totals.completed, totals.scheduled) ?? "—", type: "percent" }],
      };
    },
  });

  registerReport({
    key: "m9.performance_drivers",
    title: "Kinerja sopir per bulan",
    module: "m9",
    permission: "m9.performance.read",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: { month?: string }) => [`Bulan: ${f.month ?? "berjalan"}`],
    orientation: "landscape",
    columns: [
      { key: "rank", header: "Peringkat", type: "number" },
      { key: "name", header: "Sopir", width: 22 },
      { key: "zones", header: "Zona/rute", value: (r: { zones: string[] }) => r.zones.join(", ") },
      { key: "scheduled", header: "Terjadwal", type: "number" },
      { key: "completed", header: "Selesai", type: "number" },
      { key: "failed", header: "Gagal", type: "number" },
      { key: "completionPct", header: "% selesai", type: "percent" },
      { key: "onTimePct", header: "% tepat waktu", type: "percent" },
      { key: "partialVolume", header: "Volume parsial", type: "number" },
      { key: "deviationOver200m", header: "Lokasi > 200 m", type: "number" },
      { key: "deviationOver1km", header: "Lokasi > 1 km", type: "number" },
      { key: "br25Events", header: "Kejadian BR-25", type: "number" },
      { key: "discrepancyCount", header: "Selisih (kali)", type: "number" },
      { key: "discrepancyValue", header: "Selisih (nilai)", type: "rupiah" },
      { key: "lateDeposits", header: "Setor terlambat", type: "number" },
      { key: "distanceKm", header: "Jarak (km)", type: "number" },
      { key: "tripExpenses", header: "Pengeluaran rit", type: "rupiah" },
      { key: "daysWithoutDiscrepancy", header: "Hari tanpa selisih", type: "number" },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => ({ rows: (await computePerformance(tx, ctx, f.month ?? thisMonth(ctxBusinessDate(ctx)))).drivers }),
  });

  registerReport({
    key: "m9.performance_outlets",
    title: "Kinerja depot/operator per bulan",
    module: "m9",
    permission: "m9.performance.read",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: { month?: string }) => [`Bulan: ${f.month ?? "berjalan"}`],
    orientation: "landscape",
    columns: [
      { key: "groupLabel", header: "Kelompok" },
      { key: "rank", header: "Peringkat", type: "number" },
      { key: "name", header: "Operator/kasir", width: 22 },
      { key: "outlets", header: "Outlet", value: (r: { outlets: string[] }) => r.outlets.join(", ") },
      { key: "shifts", header: "Shift", type: "number" },
      { key: "gallonsPerDay", header: "Galon/hari", type: "number" },
      { key: "transactions", header: "Transaksi", type: "number" },
      { key: "voidCount", header: "Void (kali)", type: "number" },
      { key: "voidValue", header: "Void (nilai)", type: "rupiah" },
      { key: "cashDifferenceCount", header: "Selisih kas (kali)", type: "number" },
      { key: "cashDifferenceValue", header: "Selisih kas (nilai)", type: "rupiah" },
      { key: "stockDifferenceCount", header: "Selisih stok", type: "number" },
      { key: "lateDeposits", header: "Setor terlambat", type: "number" },
      { key: "cashOverLimit", header: "Kas > batas", type: "number" },
      { key: "daysWithoutDiscrepancy", header: "Hari tanpa selisih", type: "number" },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => ({ rows: (await computePerformance(tx, ctx, f.month ?? thisMonth(ctxBusinessDate(ctx)))).operators }),
  });

  for (const g of ["week", "month"] as const) {
    registerReport({
      key: g === "week" ? "m9.trend_weekly" : "m9.trend_monthly",
      title: g === "week" ? "Tren mingguan (13 minggu)" : "Tren bulanan (13 bulan)",
      module: "m9",
      permission: "m9.trend.read",
      containsPii: false,
      filtersSchema: z.object({ to: dateSchema.optional() }),
      describeFilters: (f: { to?: string }) => [`Sampai: ${f.to ?? "hari ini"}`],
      orientation: "landscape",
      columns: [
        { key: "label", header: g === "week" ? "Minggu mulai" : "Bulan" },
        { key: "L2", header: "Omzet L2", type: "rupiah", total: true },
        { key: "L3", header: "Omzet L3", type: "rupiah", total: true },
        { key: "L4", header: "Omzet L4", type: "rupiah", total: true },
        { key: "external", header: "Omzet luar", type: "rupiah", total: true },
        { key: "internal", header: "Transfer internal", type: "rupiah", total: true },
        { key: "tripsCompleted", header: "Rit selesai", type: "number", total: true },
        { key: "tripsScheduled", header: "Rit terjadwal", type: "number", total: true },
        { key: "gallons", header: "Galon", type: "number", total: true },
        { key: "receivableBalance", header: "Saldo piutang", type: "rupiah" },
        { key: "overduePct", header: "% lewat tempo", type: "percent" },
      ],
      fetch: async (ctx, f: { to?: string }, { tx }) => {
        const today = ctxBusinessDate(ctx);
        const rules = await reportRules(tx, today, ctx.tenantId);
        const t = await computeTrend(tx, ctx.tenantId, g, f.to && f.to < today ? f.to : today, rules.trend_periods);
        return { rows: t.points };
      },
    });
  }

  registerReport({
    key: "m9.kpi",
    title: "Laporan KPI program (KPI-01–KPI-11)",
    module: "m9",
    permission: "m9.kpi.read",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: { month?: string }) => [`Bulan: ${f.month ?? "berjalan"}`, "Untuk rapat komite pengarah (BRD 12.8)"],
    orientation: "landscape",
    columns: [
      { key: "code", header: "KPI" },
      { key: "name", header: "Nama", width: 26 },
      { key: "display", header: "Nilai" },
      { key: "target", header: "Target" },
      { key: "statusLabel", header: "Status" },
      { key: "formula", header: "Cara ukur (PRD 1.3)", width: 48 },
      { key: "detail", header: "Rincian", width: 48 },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => {
      const m = await computeKpiMonth(tx, ctx, f.month ?? thisMonth(ctxBusinessDate(ctx)));
      return { rows: m.values.map((v) => ({ ...v, statusLabel: label("kpi_status", v.status) })), status: m.complete ? "Bulan lengkap" : "Bulan berjalan" };
    },
  });

  registerReport({
    key: "m9.parallel_run_checks",
    title: "Lembar pencocokan periode paralel (NFR-35)",
    module: "m9",
    permission: "m9.parallel_run.read",
    containsPii: false,
    filtersSchema: rangeFilters,
    describeFilters: (f: { from?: string; to?: string }) => [`Periode: ${f.from ?? "30 hari terakhir"} – ${f.to ?? "hari ini"}`],
    orientation: "landscape",
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date" },
      { key: "unitLabel", header: "Unit" },
      { key: "paperCount", header: "Nota kertas", type: "number", total: true },
      { key: "systemCount", header: "Transaksi sistem", type: "number", total: true },
      { key: "differenceCount", header: "Selisih jumlah", type: "number", total: true },
      { key: "paperAmount", header: "Nilai nota", type: "rupiah", total: true },
      { key: "systemAmount", header: "Nilai sistem", type: "rupiah", total: true },
      { key: "differenceAmount", header: "Selisih nilai", type: "rupiah", total: true },
      { key: "explained", header: "Terjelaskan", type: "boolean" },
      { key: "cause", header: "Penyebab", width: 40 },
    ],
    fetch: async (ctx, f: { from?: string; to?: string }, { tx }) => {
      const to = f.to ?? ctxBusinessDate(ctx);
      return { rows: await parallelChecksInRange(tx, ctx.tenantId, f.from ?? addDays(to, -30), to) };
    },
  });
}
