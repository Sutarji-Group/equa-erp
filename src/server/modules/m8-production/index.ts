/**
 * M8 — Produksi & Stok Air: API PUBLIK modul. Meter, pengisian truk, pasokan depot, neraca air, utilisasi, mutu (PRD 7.8).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Kontrak untuk modul lain (rincian: docs/dev/modules/m8-production.md):
 * - M9 (H+0/dashboard): `utilizationFlags(tx, tenantId, date)` (utilisasi > PAR-19), event `water_balance.computed`
 *   (susut, status, belum lengkap, utilisasi), `computeMonthlyBalance`, `computeUtilizationDays/Month`.
 * - M6/M9/P3 (neraca air outlet & mitra): `depotSupplySummary` / `supplyRows` (pasokan per depot per hari/bulan).
 * - M11 (alokasi biaya L1, PAR-65): `truck_fill.recorded` (volume BERSIH; pembalik bervolume negatif) / `fillTotalsByDay`.
 * - M12 (geofence US-M12-06): `setFillGeofenceResult(tx, { truckFillId, result })`; M8 juga mendengar
 *   `fleet_event.detected` kind `fill_without_geofence`.
 * Aksi lapangan operator produksi HANYA lewat handler sinkron (`sync.ts`).
 */
import "server-only";

export const MODULE_KEY = "m8-production" as const;
export const MODULE_NAME = "Produksi & Stok Air" as const;

// --- Aturan & konteks --------------------------------------------------------------------------------------------------
export { m8Rules, fromSyncMeta, plannedSourceByAddress } from "./service/common";
export type { M8Rules, M8FieldMeta } from "./service/common";

// --- Meter & produksi (US-M8-01) --------------------------------------------------------------------------------------
export {
  correctMeterReading,
  listMetersOverview,
  meterReadingSchema,
  pendingRollover,
  recordMeterReading,
  recordMeterReplacement,
  recordMeterRollover,
  verifyProduction,
} from "./service/meters";
export type { CorrectReadingInput, MeterAdjustmentRow, MeterOverviewRow, RecordReadingResult, RecordReplacementInput, RecordRolloverInput } from "./service/meters";
export { computeDailyProduction, liveReadings, metersForDate, productionOf, productionsAwaitingVerification } from "./service/production";
export type { DailyProductionRow, MeterReadingRow, ProductionMeterDetail, WaterMeterRow } from "./service/production";

// --- Pengisian truk & pasokan depot (US-M8-02, US-M8-03) ---------------------------------------------------------------
export {
  fillsInRange,
  fillsVsSchedule,
  handleFleetEventForFills,
  linkTruckFill,
  listFills,
  openFillIssues,
  recordTruckFill,
  reverseTruckFill,
  setFillGeofenceResult,
  truckFillSchema,
  truckPlansForDay,
} from "./service/fills";
export type { FillListRow, RecordFillResult, ScheduleVsFillRow, TruckFillRow } from "./service/fills";
export { depotSupplyList, depotSupplySummary, evaluateSupply, summarizeSupply, supplyRows } from "./service/supply";
export type { SupplyRow, SupplySummaryRow } from "./service/supply";
export { fillTotalsByDay, fillTotalsOf } from "./service/fill-totals";
export type { FillTotals } from "./service/fill-totals";

// --- Neraca air & susut (US-M8-04) --------------------------------------------------------------------------------------
export {
  acceptLossInvestigation,
  balanceOf,
  balancesNeedingAction,
  computeWaterBalance,
  lossInvestigationSchema,
  refreshSourceDay,
  returnLossInvestigation,
  submitLossInvestigation,
  verifyNegativeBalance,
} from "./service/balance";
export type { WaterBalanceRow } from "./service/balance";
export { recordTankLevel, tankLevelSchema, tankLevelsInRange } from "./service/tank";

// --- Stok air awal depot saat cut-over (backlog B-10; buku air M6) ----------------------------------------------------
export { depotWaterOpenings, recordDepotOpeningWater } from "./service/depot-opening";
export type { DepotOpeningInput, DepotOpeningRow } from "./service/depot-opening";

// --- Utilisasi (US-M8-05) -----------------------------------------------------------------------------------------------
export {
  checkUtilizationStreak,
  computeUtilizationDays,
  computeUtilizationMonth,
  listActiveSources,
  utilizationDaily,
  utilizationExportRange,
  utilizationFlags,
  utilizationMonthly,
} from "./service/utilization";
export type { UtilizationDayRow, UtilizationMonthRow } from "./service/utilization";

// --- Mutu air (US-M8-06) ------------------------------------------------------------------------------------------------
export {
  actionOwnerCandidates,
  completeQualityAction,
  deactivateQualitySchedule,
  qualityLocations,
  qualityOverview,
  qualityTestFieldSchema,
  recordQualityTest,
  recordQualityTestFromField,
  runQualityReminders,
  upsertQualitySchedule,
} from "./service/quality";
export type { QualityLocation, QualityScheduleInput, QualityScheduleView, QualityTestInput, QualityTestView } from "./service/quality";

// --- Kantor: rincian, daftar, bulanan ------------------------------------------------------------------------------------
export {
  computeMonthlyBalance,
  DAY_READ_PERMISSIONS,
  listWaterBalances,
  monthlyWaterBalance,
  productionWorklist,
  sourceDayDetail,
  sourceOptions,
} from "./service/queries";
export type { BalanceListRow, MonthlyBalanceRow, ProductionWorklist, ReadingView, SourceDayDetail } from "./service/queries";

// --- Offline (US-M8-07) & pekerjaan terjadwal ---------------------------------------------------------------------------
export { buildProductionToday } from "./service/pull";
export { runReadingCheck } from "./service/jobs-logic";
