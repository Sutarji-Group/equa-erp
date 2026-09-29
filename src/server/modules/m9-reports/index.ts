/**
 * M9 — Laporan & Dashboard: API PUBLIK modul. Ringkasan H+0, laporan bulanan, katalog laporan, kinerja, tren, KPI, kotak masuk (PRD 7.9).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * M9 tidak memiliki transaksi usaha sendiri: setiap angka dihitung dari M2–M8, M11, M12 lewat SATU definisi
 * (`metrics.ts`) yang dipakai H+0, laporan bulanan, tren, kinerja, dan KPI. Rincian: docs/dev/modules/m9-reports.md.
 */
import "server-only";

export const MODULE_KEY = "m9-reports" as const;
export const MODULE_NAME = "Laporan & Dashboard" as const;

// --- Satu definisi angka (tx-first, tanpa otorisasi; untuk modul lain & uji) ------------------------------------------
export {
  cashForDay,
  datesInRange,
  discrepanciesAwaitingOwner,
  exceptionsForRange,
  gallonsDaily,
  gallonsForRange,
  receivablesAsOf,
  receivablesFlow,
  receivablesForRange,
  revenueDaily,
  revenueForRange,
  sumCash,
  sumGallons,
  sumRevenue,
  sumTrips,
  tripsDaily,
  tripsForRange,
} from "./metrics";
export type { GallonDayRow, TripDayRow } from "./metrics";
export type {
  AddendumView,
  CashFigures,
  DailySnapshot,
  ExceptionFigures,
  GallonFigures,
  H0Range,
  KpiValue,
  ReceivableFigures,
  RevenueFigures,
  SummaryStatusView,
  TrendPoint,
  TripFigures,
} from "@/client/m9-reports/types";

// --- Ringkasan H+0 (US-M9-01) -----------------------------------------------------------------------------------------
export {
  computeDaySnapshot,
  decideDiscrepancyFromDashboard,
  getDailyDashboard,
  getDailyDrilldown,
  listAddenda,
  listDailySummaries,
  markSummaryReviewed,
  publishDailySummary,
  publishPendingSummaries,
  reportRules,
} from "./service/h0";
export type { DailyDashboard, DailySummaryRow, DrilldownResult, M9ReportRules, PublishInput } from "./service/h0";
export { addendumFromEvent, recordAddendum, ADDENDUM_EVENT_TYPES } from "./service/addenda";

// --- Laporan bulanan laba kotor & ekspor Final (US-M9-02, US-M9-03 KP-4) -------------------------------------------------
export {
  computeMonthlyFigures,
  exportMonthlyReport,
  finalizeLockedPeriods,
  finalizeMonthlyReport,
  getMonthlyReport,
  monthlyDrilldown,
  MONTHLY_REPORT_KEY,
  pkpDashboard,
  shiftMonth,
} from "./service/monthly";
export type { MonthlyAccountRow, MonthlyExportResult, MonthlyGrossProfit, MonthlyJournalRow, MonthlyLine, WaterCostRow } from "./service/monthly";

// --- Katalog laporan 7.9.4 (US-M9-03) ----------------------------------------------------------------------------------
export { getReportCatalog, missingCatalogReports, REPORT_CATALOG } from "./service/catalog";
export type { CatalogEntry, CatalogReportView, CatalogView } from "./service/catalog";

// --- Kotak masuk pemilik (US-M9-04) ------------------------------------------------------------------------------------
export { actOnInboxItem, clearInboxBadgeCache, getInbox, inboxBadgeCount, inboxCount } from "./service/inbox";
export type { InboxAction, InboxGroup, InboxItem, InboxKind, OwnerInbox } from "./service/inbox";

// --- Kinerja (US-M9-05) ------------------------------------------------------------------------------------------------
export { computePerformance, getPerformance } from "./service/performance";
export type { DriverPerformance, OperatorPerformance, OutletPerformance, PerformanceReport, TruckPerformance } from "./service/performance";

// --- Tren (US-M9-06) ---------------------------------------------------------------------------------------------------
export { computeTrend, getTrend, trendBuckets } from "./service/trends";
export type { TrendReport } from "./service/trends";

// --- KPI program & periode paralel (US-M9-07, NFR-35) ------------------------------------------------------------------
export { computeKpiMonth, fieldAdoption, getKpiReport, setOwnerHours, KPI11_ROLES } from "./service/kpi";
export type { KpiMonth, KpiPage } from "./service/kpi";
export {
  extendParallelPeriod,
  listParallelChecks,
  listParallelUnits,
  par84Status,
  parallelUnitOptions,
  recordParallelCheck,
  sourceRecordedForUnit,
  startParallelPeriod,
  systemFiguresForUnit,
  withdrawPaper,
} from "./service/parallel";
export type { ParallelUnitView } from "./service/parallel";
