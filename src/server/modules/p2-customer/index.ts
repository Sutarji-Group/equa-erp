/**
 * P2 — Aplikasi Pelanggan (Tahap 2): API PUBLIK modul. Akun pelanggan, pesanan mandiri, pembayaran digital, keluhan (PRD Bab 8; flag phase2.customer_app).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Dua jenis pelaku:
 * - PELANGGAN (`CustomerContext`, autentikasi terpisah `customer_accounts`, sesi 30 hari): fungsi `(cctx, input)` —
 *   kepemilikan data diperiksa di P2 ("data pribadi hanya milik sendiri", 8.6), lalu layanan M1/M2/M5 dipanggil atas
 *   nama Sistem sehingga aturan Tahap 1 berlaku tanpa pengecualian.
 * - KANTOR (`ActorContext`): pola `authorize → Zod → aturan/SoD → runService(tx) → audit → emit`.
 */
import "server-only";

export const MODULE_KEY = "p2-customer" as const;
export const MODULE_NAME = "Aplikasi Pelanggan (Tahap 2)" as const;

// --- Bersama -------------------------------------------------------------------------------------------------------
export { customerBusinessDate, isAppEnabled, maskPhone } from "./service/common";
export type { CustomerContext } from "./service/common";

// --- Autentikasi & sesi (US-P2-01 KP-1/KP-4, 8.6) --------------------------------------------------------------------
export {
  confirmOldPhone,
  createCustomerSession,
  isReverified,
  logoutCustomer,
  requestLoginOtp,
  requestPaymentOtp,
  resolveCustomerSession,
  revokeAccountSessions,
  startPhoneChange,
  verifyLoginOtp,
  verifyPaymentOtp,
} from "./service/auth";
export type { LoginResult, OtpRequestResult, RequestMeta, SessionIssue } from "./service/auth";

// --- Akun (US-P2-01 KP-2/KP-4/KP-5) -----------------------------------------------------------------------------------
export {
  completePhoneChange,
  completeRegistration,
  customerAppStatus,
  getMyProfile,
  linkedAccounts,
  listAccountRequests,
  listAccounts,
  nameSimilarity,
  officeChangePhone,
  requestAccountDeletion,
  setCustomerAppEnabled,
  verifyAccount,
} from "./service/accounts";
export type { AccountListRow, AccountRequestRow, CompleteRegistrationInput, CompleteRegistrationResult, CustomerProfile } from "./service/accounts";

// --- Alamat (US-P2-01 KP-3) -------------------------------------------------------------------------------------------
export { addMyAddress, deactivateMyAddress, listMyAddresses, updateMyAddress } from "./service/addresses";
export type { CustomerAddressInput, CustomerAddressView } from "./service/addresses";

// --- Slot, pesanan, status (US-P2-02, US-P2-03 KP-1/KP-3) ------------------------------------------------------------
export { slotAvailability, slotLabel } from "./service/slots";
export type { DayAvailability, SlotAvailability } from "./service/slots";
export {
  cancelMyOrder,
  confirmAppOrder,
  getMyOrder,
  listAppOrders,
  listMyOrders,
  notifyOverdueConfirmations,
  placeOrder,
  quoteOrder,
  rejectAppOrder,
  reorder,
  shortCreditReason,
} from "./service/orders";
export type { AppOrderRow, DeliveryView, MyOrderDetail, MyOrderRow, OrderQuote, PaymentChoice, PaymentOption, PlaceOrderInput, PlaceOrderResult, TimelineStep } from "./service/orders";

// --- Posisi truk (US-P2-03 KP-2/KP-5, PTB-54) -------------------------------------------------------------------------
export { getTracking } from "./service/tracking";
export type { TrackingView } from "./service/tracking";

// --- Riwayat, struk, tagihan (US-P2-04 KP-1/KP-2/KP-5) -----------------------------------------------------------------
export { myBilling, myHistoryPdf, myInvoicePdf, myReceipt, readMyAttachment } from "./service/billing";
export type { BillingInvoiceRow, MyBilling, ReceiptView } from "./service/billing";

// --- Pembayaran digital (US-P2-04 KP-3/KP-4, PTB-50) ------------------------------------------------------------------
export {
  createPaymentIntent,
  expirePendingIntents,
  getMyPaymentIntent,
  handleGatewayNotification,
  listPaymentIntents,
  markIntentMatched,
  prepaidTrips,
  simulateMockPayment,
} from "./service/payments";
export type { CreatePaymentInput, NotificationOutcome, OfficePaymentRow, PaymentIntentView } from "./service/payments";
export { activeGateway, digitalPaymentAvailable, midtransGateway, mockGateway, setPaymentGatewayForTests, signMockNotification } from "./service/gateway";
export type { PaymentGateway } from "./service/gateway";

// --- Langganan & pengingat isi ulang (US-P2-05) -----------------------------------------------------------------------
export {
  listMySubscriptions,
  myRefillReminder,
  notifyRecurringFailures,
  refillEstimate,
  saveMySubscription,
  sendRefillReminders,
  setMySubscriptionStatus,
  setRefillReminder,
} from "./service/subscriptions";
export type { RefillEstimate, SubscriptionInput, SubscriptionView } from "./service/subscriptions";

// --- Penilaian & keluhan (US-P2-06) -----------------------------------------------------------------------------------
export {
  complaintBoxFor,
  complaintMonthlyReport,
  complaintReport,
  defaultBox,
  disputeInvoiceFromComplaint,
  getComplaint,
  getMyComplaint,
  listComplaints,
  listMyComplaints,
  notifyOverdueComplaints,
  rateDelivery,
  ratingAggregates,
  ratingOverview,
  reassignComplaint,
  resolveComplaint,
  respondComplaint,
  submitComplaint,
} from "./service/feedback";
export type { ComplaintBox, ComplaintInput, ComplaintMonthlyReport, CustomerComplaintView, OfficeComplaintDetail, OfficeComplaintRow, RatingAggregate } from "./service/feedback";

// --- Kanal pesan & notifikasi pelanggan (US-P2-03 KP-4, US-P2-08) ------------------------------------------------------
export {
  cloudTemplateProvider,
  customerWaProvider,
  isAutoWaActive,
  notifyCustomer,
  setCustomerPushSenderForTests,
  setCustomerWaProviderForTests,
  WA_TEMPLATE_NAMES,
} from "./service/messaging";
export { listMyNotifications, markMyNotificationsRead, registerPushSubscription, unreadNotificationCount } from "./service/inbox";
export type { CustomerNotificationView } from "./service/inbox";
export { handleWaStatusWebhook, signWaWebhook, verifyWaSignature, verifyWaWebhookChallenge, waCostSummary } from "./service/wa-cloud";
export type { WaCostSummary, WaWebhookOutcome } from "./service/wa-cloud";

// --- Ringkasan adopsi & pull sopir ------------------------------------------------------------------------------------
export { adoptionOverview, prepaidTripsPull } from "./service/overview";
export type { AdoptionOverview, PrepaidTripPull } from "./service/overview";
