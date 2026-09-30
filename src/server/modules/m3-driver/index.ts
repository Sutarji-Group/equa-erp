/**
 * M3 — Aplikasi Sopir: API PUBLIK modul. Tindakan lapangan sopir/kernet: berangkat, tiba, selesai, pembayaran, pelunasan, setor (PRD 7.3).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Aksi lapangan HANYA lewat perintah sinkron (`sync.ts`, outbox offline). Kontrak untuk modul lain
 * (rincian: docs/dev/modules/m3-driver.md):
 * - M4: `isDriverDayFullySynced(tx, userId, date)` / `driverDaySyncStatus` (US-M3-09 KP-3, "menunggu sinkron"),
 *   `reopenDriverDeposit(ctx, { depositId, reason })` (US-M3-07 KP-2), `cashOnHand`/`dayFigures` (angka seharusnya).
 * - M4/M5/M11/M12/M6/M1/M2: event `trip.departed|arrived|completed|failed`, `trip.payment_recorded`, `collection.recorded`,
 *   `trip.expense_recorded`, `deposit.submitted` (payload mandiri PTB-47).
 * - Kantor: `officeCompleteTrip`/`officeFailTrip`/`officeRecordCollection`/`officeSubmitDeposit` ("dicatat kantor",
 *   Bab 6.1, US-M3-09 KP-5), `confirmIncident` (truk rusak → Perbaikan).
 */
import "server-only";

export const MODULE_KEY = "m3-driver" as const;
export const MODULE_NAME = "Aplikasi Sopir" as const;

// --- Setoran & kas di tangan (US-M3-07, US-M3-09 KP-3) -------------------------------------------------------------
export {
  cashOnHand,
  dayFigures,
  depositHistory,
  driverDaySyncStatus,
  isDriverDayFullySynced,
  reopenDriverDeposit,
} from "./service/deposits";
export type { DayFiguresFull, DepositSnapshot, DriverDaySyncStatus } from "./service/deposits";

// --- Kunci BR-10 / PAR-83 (US-M3-01 KP-5) --------------------------------------------------------------------------
export { driverLock } from "./service/common";
export type { DriverLock } from "./service/common";

// --- Kantor: dicatat kantor, kendala, laporan ------------------------------------------------------------------------
export { describeOfficeEntry, officeCompleteTrip, officeEntryBoard, officeEntryReport, officeFailTrip, officeRecordCollection, officeSubmitDeposit, uploadOfficeEvidence } from "./service/office";
export type { OfficeDeviceRow, OfficeEntryReportRow, OfficeTripRow } from "./service/office";
export { confirmIncident, listIncidents } from "./service/incidents";
// Tambahan S5 (B-34): koreksi rit & pembalik pembayaran rit oleh Admin Keuangan (FR-M3-07, BR-38).
export { correctTrip, findTripForCorrection, livePaymentOf, reverseTripPayment } from "./service/corrections";
export type { CorrectionTripView, TripCorrectionResult, TripPaymentReversalResult } from "./service/corrections";
export type { IncidentListRow } from "./service/incidents";
export { collectionReport, driverDepositReport, driverTripReport, expenseReport, tripPaymentReport } from "./service/queries";
export type { DriverTripReportRow, RangeFilter } from "./service/queries";

// --- Data referensi aplikasi (pull) & faktur terbuka ------------------------------------------------------------------
export { buildDepositHistory, buildToday } from "./service/pull";
export { openInvoicesFor } from "./service/collections";

// --- Layanan lapangan (dipanggil handler sinkron; diekspor untuk uji & integrasi) -----------------------------------
export { arriveTrip, completeTrip, consecutiveFailuresFor, departTrip, failTrip } from "./service/trips";
export type { TripActionResult } from "./service/trips";
export { requestFieldCredit } from "./service/payments";
export { recordCollection } from "./service/collections";
export { explainFleetEvent, reportIncident } from "./service/incidents";
export { recordExpense } from "./service/expenses";
export { addDepositorNote, depositHolderConditions, submitDeposit } from "./service/deposits";
export type { SubmitDepositResult } from "./service/deposits";
export { recordReceipt } from "./service/receipts";
export { phoneTrackingActive, recordPhonePositions } from "./service/gps";
export { fromSyncMeta } from "./service/common";
export type { M3WriteMeta } from "./service/common";

// --- Pekerjaan terjadwal ---------------------------------------------------------------------------------------------
export { runDepositReminder, runTravelExplanationCheck } from "./service/jobs-logic";
