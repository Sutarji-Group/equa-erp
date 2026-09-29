/**
 * P3 — Kemitraan (RL-7 & Tahap 3): API PUBLIK modul. Mitra depot, kontrak, pasokan mitra, tagihan langganan, dukungan,
 * portal pemilik mitra, calon mitra, onboarding, pesanan portal, mutu, sanksi, dashboard (PRD Bab 9).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 * Rincian kontrak: docs/dev/modules/p3-partner.md.
 */
import "server-only";

export const MODULE_KEY = "p3-partner" as const;
export const MODULE_NAME = "Kemitraan (RL-7 & Tahap 3)" as const;

// --- Bersama -------------------------------------------------------------------------------------------------------
export { partnerTerms, portalEnabled, assertPortalEnabled, LIVE_CONTRACT_STATUSES } from "./service/common";
export type { PartnerTerms } from "./service/common";

// --- RL-7 US-P3-08: mitra, tautan pelanggan, pasokan & neraca air ---------------------------------------------------
export {
  EQUA_READ_RIGHTS,
  getPartnerDetail,
  issuePartnerOperatorPin,
  linkPartnerCustomer,
  listPartners,
  partnerFormOptions,
  registerPartnerDevice,
  registerPartnerOperator,
} from "./service/partners";
export type { PartnerDetail, PartnerListRow, RegisterPartnerOperatorInput } from "./service/partners";
export {
  partnerPurchaseHistory,
  partnerWaterBalance,
  purchaseHistory,
  runPartnerWaterBalanceCheck,
  runWaterOrderSlaCheck,
  supplyBoard,
} from "./service/supply";
export type { PartnerSupplyBoard, PartnerWaterBalanceRow, PurchaseHistoryRow } from "./service/supply";

// --- RL-7 US-P3-09 / Tahap 3 US-P3-04: kontrak & tagihan -----------------------------------------------------------
export { createContract, describeContractTerms, effectiveTerms, getContract, listContracts, proposeContractTerms, recordEvaluation, runContractLifecycle } from "./service/contracts";
export type { ContractListRow, ContractTerms, CreateContractInput } from "./service/contracts";
export { billingPeriodFor, computePartnerBill, disputePartnerInvoice, royaltyDetail, runSubscriptionBilling, runSubscriptionBillingNow, subscriptionBoard } from "./service/billing";
export type { PartnerBill, PartnerInvoiceRow, SubscriptionRunSummary } from "./service/billing";

// --- RL-7 US-P3-10: portal pemilik mitra & laporan bulanan ---------------------------------------------------------
export {
  portalHome,
  portalInvoice,
  portalInvoices,
  portalMonthlyReport,
  portalMonthlyReports,
  portalOpenTenant,
  portalPurchaseHistory,
  portalSalesReport,
  portalSupplyReport,
} from "./service/portal";
export type { PortalHome, PortalInvoiceDetail } from "./service/portal";
export { buildMonthlyReportData, monthlyReportsOf, publishMonthlyReportsNow, runMonthlyReports } from "./service/monthly-report";
export type { PartnerMonthlyReportData } from "./service/monthly-report";

// --- RL-7 US-P3-11: dukungan teknis --------------------------------------------------------------------------------
export {
  completeSupportRequest,
  getSupportRequest,
  linkSupportSparePart,
  listSupportRequests,
  respondSupportRequest,
  runSupportSlaCheck,
  submitSupportRequest,
  supportSlaSummary,
} from "./service/support";
export type { SubmitSupportInput, SupportRequestView, SupportSlaSummary } from "./service/support";

// --- Tahap 3 US-P3-01: calon mitra & onboarding --------------------------------------------------------------------
export { assessLocation, createContractFromProspect, createProspect, getProspect, listProspects, overrideRadius, recordSurvey, registerProspectFromPortal, submitProspect } from "./service/prospects";
export type { ContractFromProspectInput, ProspectAssessment, ProspectInput, SurveyInput } from "./service/prospects";
export { completeOnboardingItem, onboardingBoard, onboardingCandidates, onboardingViews, signSop, ONBOARDING_ITEMS } from "./service/onboarding";
export type { OnboardingOutletView } from "./service/onboarding";

// --- Tahap 3 US-P3-02: pengaturan POS mitra ------------------------------------------------------------------------
export { partnerSettingsView, updatePartnerPosSettings } from "./service/settings";
export type { PartnerSettingsInput } from "./service/settings";

// --- Tahap 3 US-P3-03: pesanan portal ------------------------------------------------------------------------------
export {
  cancelPortalSparePartOrder,
  createPortalSparePartOrder,
  createPortalWaterOrder,
  discountedWaterPrice,
  linkPortalOrderSale,
  pendingSparePartOrders,
  portalOrdersOf,
  portalOrderStatusText,
  sparePartCatalog,
} from "./service/portal-orders";
export type { PortalOrderView, PortalSparePartOrderInput, PortalWaterOrderInput, PortalWaterOrderResult } from "./service/portal-orders";

// --- Tahap 3 US-P3-05: mutu ----------------------------------------------------------------------------------------
export {
  checklistCompliance,
  closeAuditFollowUp,
  computeOutletScore,
  conductAudit,
  qualityBoard,
  qualityEvidence,
  recordPartnerQualityTest,
  runAuditChecks,
  runQualityMonthly,
  scheduleAudit,
  QUALITY_ITEMS,
} from "./service/quality";
export type { ConductAuditInput, PartnerQualityTestInput } from "./service/quality";

// --- Tahap 3 US-P3-06: dashboard -----------------------------------------------------------------------------------
export { coachPortfolio, partnerDashboard, partnerMetrics, partnershipEconomics } from "./service/dashboard";
export type { PartnerMetrics, PortfolioRow } from "./service/dashboard";

// --- Tahap 3 US-P3-07: sanksi --------------------------------------------------------------------------------------
export { activeSanctions, activeSupplySuspension, liftSanction, listSanctions, markPartnerDataExported, proposeSanction, recordSanctionTrigger, runSanctionChecks, sanctionsOfTenant } from "./service/sanctions";
export type { ProposeSanctionInput, SanctionView } from "./service/sanctions";

// --- Lampiran lintas tenant yang diperjanjikan ---------------------------------------------------------------------
export { readPartnerAttachmentForEqua, readPartnerAttachmentForPortal } from "./service/attachments";
