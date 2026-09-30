/**
 * M11 — Akuntansi & Pajak: API PUBLIK modul. Bagan akun, jurnal otomatis/manual, buku besar, aset, rekonsiliasi, periode, pajak (PRD 7.11).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Kontrak untuk modul lain (tanpa otorisasi, di dalam transaksi pemanggil):
 * - `pkpStatus(tx, tenantId, date)` — omzet 12 bulan berjalan vs batas PKP (dasbor M9, US-M11-08 KP-4).
 * - `journalsForSource(ctx, { type, id })` / tautan `/akuntansi/jurnal?sumberTipe=<type>&sumberId=<id>` — jurnal suatu
 *   transaksi sumber (ketertelusuran dua arah, US-M11-02 KP-5).
 * - `dailyReconciliationTx(tx, tenantId, date)` — jurnal per hari per modul vs peristiwa H+0.
 */
import "server-only";

export const MODULE_KEY = "m11-accounting" as const;
export const MODULE_NAME = "Akuntansi & Pajak" as const;

export { REQUIRED_MAPPINGS, SKIPPED_EVENTS, MANUAL_TEMPLATES, SOURCE_OBJECT_LABELS, SOURCE_MODULE } from "./constants";

// Bagan akun & pemetaan (US-M11-01)
export {
  listAccounts,
  listProfitCenters,
  accountOptions,
  createAccount,
  updateAccount,
  deactivateAccount,
  reactivateAccount,
  importChartOfAccounts,
  type AccountListRow,
  type AccountImportResult,
} from "./service/accounts";
export { listMappings, saveMapping, mappingCompleteness, setAccountingActive, type MappingView } from "./service/mappings";

// Jurnal otomatis (US-M11-02)
export { processEvent } from "./service/engine";
export { specForEvent, JOURNALED_EVENTS, isJournaledEvent } from "./service/auto-journals";
export type { AutoResult, EventJournalSpec } from "./service/posting";
export { listJournalQueue, retryJournalQueueItem, retryAllJournalQueue, retryPendingQueue, pendingQueueCount } from "./service/queue";
export { generateRetroactiveJournals, verifyRetroactiveRun, listRetroactiveRuns } from "./service/retroactive";
export { listJournals, getJournalDetail, journalsForSource, sourceLink, formOptions, openManualJournals } from "./service/journals";
export { dailyReconciliation, dailyReconciliationTx, type DailyReconRow } from "./service/daily";

// Jurnal manual (US-M11-03)
export {
  createManualJournal,
  attachJournalEvidence,
  submitManualJournal,
  cancelManualJournal,
  reverseManualJournal,
  ownerReviewList,
  markManualJournalsReviewed,
  listRecurringJournals,
  saveRecurringJournal,
  generateRecurringDraftsNow,
  runRecurringDrafts,
  runAccrualReversals,
  manualTemplates,
  manualJournalSchema,
  type ManualJournalInput,
  type SubmitResult,
  type ReverseResult,
} from "./service/manual";

// Laporan keuangan (US-M11-04)
export {
  getStatements,
  getLedger,
  loadStatements,
  computeTrialBalance,
  computeProfitLoss,
  computeInternalMarkup,
  computeBalanceSheet,
  computeCashFlow,
  finalVersions,
  accountBalanceAt,
  CASH_FLOW_LABELS,
  STATEMENTS_REPORT_KEY,
  type Statements,
  type Basis,
} from "./service/statements";
export { allocationStatus, runCostAllocation, setSharedCostKey, splitByWeights } from "./service/allocation";

// Aset tetap (US-M11-05)
export {
  assetRegister,
  assetDetail,
  createAsset,
  importAssets,
  signAssetRegister,
  updateAssetEstimate,
  disposeAsset,
  runDepreciation,
  runMonthlyDepreciation,
  monthlyDepreciation,
  depreciationStart,
} from "./service/assets";

// Rekonsiliasi (US-M11-06)
export { reconciliationOverview, saveBankReconciliation, saveCashReconciliation, reconciliationHistory, ADJUSTING_LABELS } from "./service/reconciliation";

// Utang (US-M11-07)
export { payablesView, runJournalPayableReminders, PAYABLE_AGING_LABELS } from "./service/payables";

// Pajak (US-M11-08)
export { taxOverview, monthlyRevenueReport, setTaxScheme, pkpStatus, runPkpMonitor, listExportTemplates, saveExportTemplate, exportWithTemplate, EXPORT_FIELDS, type PkpStatus } from "./service/tax";

// Akun buku per rekening bank (B-53) — kontrak untuk M4 (tanpa otorisasi, di dalam transaksi pemanggil)
export { assertBankGlAccount, bankGlAccountOptions, createBankGlAccount, nextBankGlCode, type BankGlOption } from "./service/bank-gl";

// Biaya komunikasi, cloud & WhatsApp bulanan (NFR-29, B-67)
export { itCostReport, computeItCostReport, type ItCostReport } from "./service/it-costs";

// Saldo awal (US-M11-09)
export {
  openingOverview,
  setCutoverDate,
  prefillOpeningGroup,
  saveOpeningBatch,
  signOpeningBatch,
  attestOpeningBalances,
  postOpeningBalances,
  requestOpeningAdjustment,
  OPENING_GROUPS,
} from "./service/opening";

// Periode (US-M11-10)
export { listPeriods, periodDetail, closePeriod, lockPeriod, reopenPeriod, addPeriodReviewNote, periodPrerequisites, runPeriodReminders, type Prerequisite } from "./service/periods";

// Sumber jurnal transfer internal yang dieliminasi pada konsolidasi (dipakai M9 — satu definisi, US-M9-02 KP-2).
export { INTERNAL_TRANSFER_SOURCES } from "./constants";

// Status aktivasi jurnal otomatis (US-M11-01 KP-2): flag bawaan saja tidak cukup — pemetaan wajib lengkap atau aktivasi
// pemilik (dipakai M9 agar "M11 aktif" satu definisi).
export { accountingActivation, m11Active as isAccountingActive, type AccountingActivation } from "./service/common";
