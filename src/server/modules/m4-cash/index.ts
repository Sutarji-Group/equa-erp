/**
 * M4 — Kas & Setoran: API PUBLIK modul. Posisi kas, setoran, selisih, transfer masuk, kas kantor, kas kecil, tutup kas (PRD 7.4).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Kontrak untuk modul lain (rincian: docs/dev/modules/m4-cash.md):
 * - M9 (dashboard H+0): `decideDiscrepancy(ctx, id, { decision, reason })` — satu ketuk per selisih (US-M4-06 KP-6),
 *   `getCashPosition`, `kpi03`, `listCashDays` (KPI-02), event `cash_day.closed`.
 * - M11 (jurnal): event `deposit.received`, `expense.verified`, `discrepancy.decided`, `transfer.matched`,
 *   `bank_deposit.recorded|reversed`, `office_cash.moved`, `petty_cash.recorded`, `restitution.*`.
 * - M5 (piutang): event `transfer.not_found` (piutang sementara "transfer belum diterima"), `transfer.matched`.
 */
import "server-only";

export const MODULE_KEY = "m4-cash" as const;
export const MODULE_NAME = "Kas & Setoran" as const;

// --- Kas hari ini (US-M4-01) ---------------------------------------------------------------------------------------
export { getCashPosition, buildCashPosition } from "./service/position";
export type { CashPosition, CashSourceRow, CashLineTotal, CashLine, CashFlag } from "./service/position";

// --- Setoran (US-M4-02) --------------------------------------------------------------------------------------------
export {
  listDepositsForReceipt,
  listDeposits,
  getDepositDetail,
  depositFigures,
  depositSyncStatus,
  verifyExpense,
  receiveDeposit,
  closeDeposit,
  reopenDeposit,
} from "./service/deposits";
export type { DepositListRow, DepositDetail, DepositFigures, DepositExpense, CarryOverItem, ReceiveResult, DepositSyncStatus } from "./service/deposits";

// --- Selisih (US-M4-03) --------------------------------------------------------------------------------------------
export {
  decideDiscrepancy,
  explainDiscrepancy,
  completeDiscrepancyFollowUp,
  reopenDiscrepancy,
  listDiscrepancies,
  discrepancyHistory,
  kpi03,
} from "./service/discrepancies";
export type { DiscrepancyRow, DiscrepancyListRow, DiscrepancyHistoryRow, DiscrepancyStreak } from "./service/discrepancies";

// --- Ganti rugi (US-M4-03 KP-2..KP-4) ---------------------------------------------------------------------------------
export {
  settleRestitution,
  reverseRestitutionSettlement,
  listRestitutions,
  restitutionBalances,
  restitutionMonthlyRecap,
  getRestitutionActive,
  setRestitutionActive,
} from "./service/restitutions";
export type { RestitutionListRow, RestitutionBalance, RestitutionRecapRow } from "./service/restitutions";

// --- Transfer masuk & mutasi (US-M4-04) ------------------------------------------------------------------------------
export {
  listIncomingTransfers,
  matchTransfer,
  importBankStatement,
  proposeStatementMatches,
  confirmStatementMatches,
  markStatementLine,
  listStatementLines,
  dailyMatchingResults,
  runTransferNotFoundCheck,
  sweepSlipDeposits,
} from "./service/transfers";
export type { TransferListRow, MatchProposal, ImportResult } from "./service/transfers";
export { parseStatement, parseStatementCsv, parseBankAmount, parseBankDate } from "./service/statement-parse";

// --- Kas kantor, setor bank, rekening (US-M4-05) -----------------------------------------------------------------------
export {
  getOfficeCash,
  listOfficeCashMovements,
  recordOfficeCashOpening,
  recordBankDeposit,
  reverseBankDeposit,
  listBankAccounts,
  createBankAccount,
  setBankAccountGlAccount,
  bankAccountsNeedingGl,
  bankGlChoices,
  deactivateBankAccount,
} from "./service/office-cash";
export type { BankAccountRow, BankDepositRow, OfficeCashDay } from "./service/office-cash";

// --- Kas kecil (US-M4-05 KP-2, S) --------------------------------------------------------------------------------------
export { recordPettyCash, countPettyCash, getPettyCash, pettyCashOutletOptions } from "./service/petty-cash";

// --- Tutup kas (US-M4-06) ------------------------------------------------------------------------------------------
export { getCashDayScreen, startCashClose, requestCloseException, closeCashDay, listCashDays, runPendingDepositDueCheck } from "./service/cash-day";
export type { CashBlocker, CashDayScreen } from "./service/cash-day";

// --- Pekerjaan terjadwal & data lapangan -------------------------------------------------------------------------------
export { runDriverNotSubmittedCheck } from "./service/events-logic";
export { buildMyCash } from "./service/pull";
export type { MyCashReference } from "./service/pull";
