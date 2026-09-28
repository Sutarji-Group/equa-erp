/**
 * M6 — Penjualan Depot (POS): API PUBLIK modul. POS depot, shift, void, bahan habis pakai, pasokan air, multi-tenant (PRD 7.6).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Kontrak untuk modul lain (rincian: docs/dev/modules/m6-pos.md):
 * - M4 kas: `isShiftFullySynced(tx, shiftId)` / `shiftSyncStatus` sebelum menerima setoran shift (US-M6-06 KP-3);
 *   baris `deposits` (source_type depot_shift/store_shift, final + sebagian) dibuat M6; event `shift.closed`
 *   (payload lengkap: per cara bayar, QRIS, void, setoran, selisih, pemakaian bahan) & `deposit.submitted`.
 * - M7 toko: kerangka POS yang sama — `registerPosKindPolicy(storePolicy)` + fungsi inti `recordSale`, `voidSale`,
 *   `openShift`, `closeShift`, `recordPartialDeposit`, `submitStockCount`, primitif `postStockMovement`.
 * - M3/M8: event `trip.completed` (rit internal → pasokan "Tiba"); `water_supply.confirmed` (+ `waterBalancesFor`).
 * - M9/P3: laporan per outlet (`dailyOutletReport`, `usageVsSalesReport`, `waterBalanceReport`, …; berlingkup tenant).
 */
import "server-only";

export const MODULE_KEY = "m6-pos" as const;
export const MODULE_NAME = "Penjualan Depot (POS)" as const;

// --- Titik perluasan kerangka POS (M7) -------------------------------------------------------------------------------
export { registerPosKindPolicy, posKindPolicy, hasPosKindPolicy } from "./service/policy";
export type { PosKindPolicy, PosSaleHookArgs, PosShiftClosingArgs, PosSaleLineInput } from "./service/policy";
export { depotPolicy } from "./service/depot-policy";
export type { FieldWriteMeta, PosDevice, OutletPosSettings } from "./service/common";
export { outletPosSettings, fixedOpeningCash, isoWeekLabel, isoWeekRange, COUNTED_SALE } from "./service/common";
export { toFieldWriteMeta } from "./sync";

// --- Persediaan (kartu stok, buku air, resep) -------------------------------------------------------------------------
export {
  postStockMovement,
  stockBalancesOf,
  consumablesOf,
  recipesFor,
  tenantRecipes,
  usageFromLines,
  postWaterMovement,
  waterBalance,
  waterPeriodBalance,
} from "./service/inventory";
export type { StockMovementInput, StockMovementResult, WaterPeriodBalance, RecipeLine } from "./service/inventory";

// --- Shift & setoran (US-M6-02) ---------------------------------------------------------------------------------------
export {
  openShift,
  closeShift,
  recordPartialDeposit,
  submitShiftDeposit,
  checkCashLimit,
  resolveShiftConflict,
  operatorShiftHistory,
  isShiftFullySynced,
  shiftSyncStatus,
  openShiftSchema,
  closeShiftSchema,
  partialDepositSchema,
  submitShiftDepositSchema,
} from "./service/shifts";
export type { ShiftSyncStatus, OpenShiftResult, CloseShiftResult, OperatorShiftHistoryRow } from "./service/shifts";
export { computeShiftFigures, isCountedSale } from "./service/figures";
export type { ShiftFigures } from "./service/figures";

// --- Transaksi & void (US-M6-01, US-M6-03) ----------------------------------------------------------------------------
export { recordSale, voidSale, reverseSaleAfterClose, pendingVoidReversals, voidCountOn, recordSaleSchema, voidSaleSchema } from "./service/sales";
export type { RecordSaleInput, RecordSaleResult, VoidSaleResult } from "./service/sales";

// --- Stok bahan & opname (US-M6-04) -----------------------------------------------------------------------------------
export {
  recordConsumableReceipt,
  receiveInternalTransfer,
  submitStockCount,
  outletsWithoutStockCount,
  latestStockCounts,
  consumableReceiptSchema,
  receiveTransferSchema,
  stockCountSchema,
} from "./service/stock";

// --- Pasokan & neraca air (US-M6-05) ----------------------------------------------------------------------------------
export {
  recordSupplyArrival,
  confirmWaterSupply,
  recordOtherSupply,
  autoAcceptPendingSupplies,
  waterStockNow,
  waterBalancesFor,
  runWaterBalanceCheck,
  transferValueFor,
} from "./service/water";
export type { WaterBalanceCheck } from "./service/water";

// --- Multi-tenant & pengaturan outlet (US-M6-07) ----------------------------------------------------------------------
export { createPartnerTenant, copyStandardCatalog, listTenants, updateOutletPosSettings, setOutletThreshold, OUTLET_THRESHOLD_KEYS } from "./service/tenants";
export type { CreatePartnerTenantInput, CreatePartnerTenantResult, TenantListRow, OutletThresholdKey } from "./service/tenants";

// --- Tampilan kantor & laporan ----------------------------------------------------------------------------------------
export {
  listOutletsOverview,
  getOutletDetail,
  getShiftDetail,
  dailyOutletReport,
  voidReport,
  usageVsSalesReport,
  stockCardReport,
  waterBalanceReport,
  waterSupplyReport,
  shiftReport,
  salesReport,
  stockCountReport,
  listShiftConflicts,
  listTenantOutlets,
  salesAggregates,
  voidAggregates,
  defaultRange,
  OUTLET_READ_PERMISSIONS,
} from "./service/queries";
export type { OutletOverviewRow, DailyOutletRow, VoidReportRow, UsageReportRow } from "./service/queries";

// --- Data offline & pekerjaan terjadwal -------------------------------------------------------------------------------
export { buildPosReference } from "./service/pull";
export { runStockCountCheck, runLateDepositCheck } from "./service/jobs-logic";
