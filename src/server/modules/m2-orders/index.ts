/**
 * M2 — Pesanan & Penjadwalan Rit: API PUBLIK modul. Pesanan, rit, papan jadwal, kru harian, pesanan berulang (PRD 7.2).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Kontrak untuk modul lain (rincian: docs/dev/modules/m2-orders.md):
 * - M5/M7: `computeCreditExposure(tx, customerId, { extraAmount })` — SATU batas kredit lintas lini (BR-06, PTB-25).
 * - M3: pull `m2.schedule` (jadwal terbit truk hari itu + catatan khusus + kunci BR-10); event yang ditangani M2:
 *   `trip.departed`, `trip.completed`, `trip.failed` (pesanan Dalam pengiriman / Selesai / Baru + perlu jadwal ulang).
 * - M5: event `credit_status.changed` → rit tempo belum Berangkat ditandai (PTB-27).
 * - Semua: event `order.created`, `order.status_changed`, `trip.published`.
 */
import "server-only";

export const MODULE_KEY = "m2-orders" as const;
export const MODULE_NAME = "Pesanan & Penjadwalan Rit" as const;

// --- Kontrol kredit (US-M2-05; PTB-25 dipakai M7) -------------------------------------------------------------------
export { computeCreditExposure, evaluateCreditOrder, getCreditExposure, underpaymentStatus } from "./service/credit";
export type { CreditCheck, CreditExposure, UnderpaymentStatus } from "./service/credit";

// --- Pesanan (US-M2-01/02/04/05/08/09) ------------------------------------------------------------------------------
export {
  approvalDeadline,
  cancelOrder,
  changePaymentMethod,
  createOrder,
  customerOrderHistory,
  getOrderDetail,
  listOrders,
  orderFormDefaults,
  previewOrder,
  reconfirmOrder,
  refreshOrderPrice,
  requestCreditApproval,
  requestUnderpaymentApproval,
  rescheduleOrder,
  updateOrderNotes,
} from "./service/orders";
export type { CreateOrderResult, CustomerHistoryRow, DuplicateOrderView, OrderDetail, OrderFormDefaults, OrderListRow, OrderPreview, OrderPrice } from "./service/orders";
export type { CancelOrderInput, ChangePaymentInput, CreateOrderInput, ListOrdersFilter, ReconfirmInput, RecurringInput, RescheduleOrderInput } from "./schemas";

// --- Siklus status (Bab 5.2) -------------------------------------------------------------------------------------------
export { deriveOrderStatus, schedulingBlockers } from "./service/lifecycle";
export type { SchedulingBlocker } from "./service/lifecycle";

// --- Papan jadwal (US-M2-03) ---------------------------------------------------------------------------------------------
export {
  applySuggestedOrder,
  assignTrip,
  compareBr21,
  getBoard,
  moveTripInLane,
  publishAllSchedules,
  publishSchedule,
  reorderTrips,
  resolveTripConflict,
  scheduleChangeHistory,
  unassignTrip,
} from "./service/schedule";
export type { AssignResult, Board, BoardLane, BoardTrip, PublishResult } from "./service/schedule";

// --- Kru harian & jadwal kru (US-M2-10, US-M2-11) ----------------------------------------------------------------------
export {
  driverCandidates,
  driverDepositLocks,
  getWeekRoster,
  listCrewAssignments,
  resolveDayCrews,
  setDailyDriver,
  setRosterEntry,
  setTruckDayStatus,
  truckCapacity,
} from "./service/crew";
export type { DayCrew, DepositLock, DriverCandidate, WeekRoster, WeekRosterCell } from "./service/crew";

// --- Pesanan berulang (US-M2-06) ---------------------------------------------------------------------------------------
export {
  createRecurringOrder,
  generateRecurringOrders,
  listRecurringFailures,
  listRecurringOrders,
  nextOccurrences,
  occursOn,
  resolveRecurringFailure,
  runRecurringGenerationNow,
  setRecurringStatus,
  updateRecurringOrder,
} from "./service/recurring";
export type { GenerateResult, RecurringFailureRow, RecurringListRow } from "./service/recurring";

// --- Konfirmasi WA (US-M2-07) ------------------------------------------------------------------------------------------
export { getOrderConfirmationTemplate, ORDER_TEMPLATE_VARIABLES, previewOrderConfirmation, sendOrderConfirmation, updateOrderConfirmationTemplate } from "./service/wa";
export type { OrderConfirmationMessage, SendConfirmationResult } from "./service/wa";

// --- Laporan bulanan & hitungan (US-M2-04 KP-3, US-M2-09 KP-4, 6.2c) ---------------------------------------------------
export { kpi06Report, monthlyCancelFailReport, orderCounters, overridesReport } from "./service/reporting";
export type { CancelFailRow, Kpi06Row, OverrideRow } from "./service/reporting";

// --- Aplikasi sopir (pull `m2.schedule`) & job pagi ------------------------------------------------------------------
export { driverSchedule, notifyUnscheduledToday } from "./service/field";
export type { DriverSchedule, DriverTrip } from "./service/field";
