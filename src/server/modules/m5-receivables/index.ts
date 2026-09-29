/**
 * M5 — Piutang & Penagihan: API PUBLIK modul. Faktur, pelunasan, umur piutang, Ditahan, pengingat, faktur bulanan (PRD 7.5).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Kontrak untuk modul lain (rincian: docs/dev/modules/m5-receivables.md):
 * - M1/M2/M7 (tanpa otorisasi, di dalam transaksi pemanggil): `getReceivableBalance(tx, customerId)`,
 *   `computeExposure(tx, customerId, { extraAmount })`; layar: `getCreditExposure(ctx, customerId)`.
 * - M11: `writeOffInvoice(tx, { ctx, invoiceId, amount?, journalId, approvalId, reason })` (PTB-28).
 * - M4: `pendingTransferInvoice(tx, incomingTransferId)`; event `collection.recorded` (kanal kantor) & `customer_advance.refunded`.
 */
import "server-only";

export const MODULE_KEY = "m5-receivables" as const;
export const MODULE_NAME = "Piutang & Penagihan" as const;

// --- Saldo & eksposur (US-M5-01 KP-3/KP-4) --------------------------------------------------------------------------
export { computeExposure, getCreditExposure, getReceivableBalance } from "./service/balance";
export type { CreditExposureView, ReceivableBalance } from "./service/balance";

// --- Faktur (US-M5-01, 7.5.6) ----------------------------------------------------------------------------------------
export {
  convertUnderpaymentToCredit,
  customerOptions,
  decideDispute,
  disputeInvoice,
  getInvoiceDetail,
  invoiceDocument,
  listInvoices,
  requestCreditNote,
  sendInvoice,
  writeOffInvoice,
} from "./service/invoices";
export type { CreditNoteRequestResult, InvoiceListFilter, InvoiceListRow } from "./service/invoices";
export { renderInvoicePdf, renderPaymentReceiptPdf } from "./service/pdf";
export { pendingTransferInvoice, prepaidAmountOfTrip } from "./service/sources";
export { INVOICE_REVENUE_SOURCES, invoiceSentViaLabel } from "./service/common";
// E-mail faktur/pernyataan dari server (Resend + PDF) atau draf mailto (B-36, D-10 butir 2)
export { emailInvoice, emailStatement, type EmailDeliveryResult } from "./service/delivery";
// Tambahan S5 (B-34): piutang rit terbuka (M3 menghitung bagian uang muka koreksi harga sebelum `trip.corrected`).
export { tripOpenReceivable } from "./service/trip-corrections";
export type { TripOpenReceivable } from "./service/trip-corrections";

// --- Pelunasan & uang muka (US-M5-02, 7.5.6) -------------------------------------------------------------------------
export {
  applyAdvance,
  getPaymentDetail,
  listAdvances,
  listPayments,
  paymentReceipt,
  reallocateCustomerPayment,
  reclassCandidates,
  reclassifyTripCash,
  recordOfficePayment,
  requestAdvanceRefund,
  reverseCustomerPayment,
  sendPaymentReceipt,
} from "./service/payments";
export type {
  AdvanceListRow,
  OfficePaymentResult,
  PaymentDetail,
  PaymentListRow,
  PaymentReceipt,
  ReallocationResult,
  ReclassCandidate,
  ReclassResult,
  ReversalResult,
} from "./service/payments";

// --- Status kredit & Ditahan (US-M5-03) ------------------------------------------------------------------------------
export {
  creditEligibleCustomers,
  creditHistory,
  creditStatusBoard,
  deferCreditHold,
  endCreditHoldDeferral,
  holdDeferralLimit,
  releaseCreditHold,
  requestCreditHoldRelease,
  runHoldEvaluationNow,
  transitionLimit,
} from "./service/credit-hold";
export type { CreditHistoryRow, CreditStatusBoardRow, EligibleRow, HoldRunSummary } from "./service/credit-hold";

// --- Umur piutang, kartu piutang, tindakan harian (US-M5-04) --------------------------------------------------------
export { agingReport, customerStatement, dailyActionList, receivableOverview, sendStatement } from "./service/aging";
export type { AgingCustomerRow, AgingGroupRow, AgingReport, CustomerStatement, ReceivableOverview, StatementEntry } from "./service/aging";

// --- Pengingat & template (US-M5-05) ---------------------------------------------------------------------------------
export { listReminders, openReminder, reminderKindLabel } from "./service/reminders";
export type { ReminderGroup, ReminderKind, ReminderList } from "./service/reminders";
export { listReceivableTemplates, M5_TEMPLATE_KINDS, TEMPLATE_REQUIRED_VARIABLES, updateReceivableTemplate } from "./service/templates";
export type { ActiveTemplate, M5TemplateKind } from "./service/templates";

// --- Faktur bulanan (US-M5-06) ---------------------------------------------------------------------------------------
export { monthlyBoard, monthlyPeriod, requestMonthlyBilling, runMonthlyInvoicingNow } from "./service/monthly";
export type { MonthlyPeriod, MonthlyRunSummary } from "./service/monthly";

// --- Saldo awal (US-M5-07) -------------------------------------------------------------------------------------------
export { cancelOpeningInvoice, createOpeningInvoice, openingBoard, requestOpeningAdjustment, signOpeningBalances } from "./service/opening";

// --- Pull aplikasi sopir ---------------------------------------------------------------------------------------------
export type { CustomerCreditPull, CustomerCreditRef } from "./service/pull";
