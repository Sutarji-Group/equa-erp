/**
 * M10 — Pengguna, Hak Akses & Jejak Audit: API PUBLIK modul (PRD 7.10). Modul lain dan UI hanya boleh mengimpor dari
 * berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat event domain. Fungsi layanan berbentuk
 * `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan bisnis + pemisahan tugas → satu transaksi →
 * audit.record → events/notifikasi. Rincian: docs/dev/modules/m10-access.md.
 *
 * Untuk modul lain:
 * - `viewPolicy(ctx, { ownTripToday })`, `maskCustomerPii(ctx, row, …)`, `maskPhone`, `employeeDataAccess`,
 *   `redactEmployeeValues` — kebijakan tampilan data pribadi (US-M10-06 KP-1).
 * - `raiseIncident(tx, { tenantId, kind, title, … })` — catat insiden + peringatan tim IT (mis. M12 GPS mati, NFR-28).
 * - `describeApprovalRules(tx, businessDate)` — aturan 6.2a yang berlaku (ambang dari parameter).
 * - Event yang ditangani: `employee.exited` (M1) → akun dinonaktifkan pada tanggal keluar (BR-37).
 */
import "server-only";

export const MODULE_KEY = "m10-access" as const;
export const MODULE_NAME = "Pengguna, Hak Akses & Jejak Audit" as const;

// --- Pengguna, peran, lingkup (US-M10-01) ---
export {
  createUser,
  createUserSchema,
  deactivateUser,
  getUserDetail,
  initialAccountsSigned,
  issueInitialPin,
  listEmployeesWithoutAccount,
  listUsers,
  requestReactivation,
  requestRoleChange,
  requestScopeExtension,
  resetPassword,
  resetPin,
  resetTwoFactor,
  revokeRole,
  revokeScope,
  type CreateUserInput,
  type CreateUserResult,
  type DeactivationResult,
  type RoleChangeInput,
  type ScopeExtensionInput,
  type UserDetail,
  type UserListFilter,
  type UserListItem,
} from "./service/users";
export { initialAccountsStatus, prepareInitialAccountsSignoff, signInitialAccounts, type InitialAccountEntry } from "./service/initial-accounts";
export { handleEmployeeExited, runExitDateSweep } from "./service/exits";
export {
  accessChangesOn,
  accessReviewList,
  dailyAccessSummary,
  markAccessReviewed,
  remindAccessReview,
  type AccessChangeSummary,
  type AccessReviewFlag,
  type AccessReviewItem,
  type AccessReviewView,
} from "./service/access-review";
export { quarterOf, quarterRange, scopeRuleFor } from "./service/shared";

// --- Perangkat & sinkron (US-M10-02, US-M10-07) ---
export {
  decorateDevices,
  deviceAssignmentSchema,
  getDeviceDetail,
  listDevices,
  updateDeviceAssignment,
  type DeviceDetail,
  type DeviceFilter,
  type DeviceListItem,
  type DeviceSessionItem,
} from "./service/devices";
export {
  blockDevice,
  issueActivationCode,
  registerDevice,
  registerDeviceSchema,
  requestWipe,
  type RegisterDeviceInput,
} from "@/server/core/auth";
export {
  getAppVersionPolicy,
  listSyncConflicts,
  listSyncHealth,
  setMinAppVersion,
  type SyncHealthItem,
  type SyncHealthView,
} from "./service/sync-health";
export {
  acknowledgeIncident,
  incidentMetrics,
  listIncidents,
  raiseIncident,
  resolveIncident,
  runMonitoring,
  failingSyncDevices,
  MONITOR_JOB_KEY,
  type IncidentKind,
  type IncidentRow,
  type IncidentView,
  type MonitorResult,
  type RaiseIncidentInput,
} from "./service/monitoring";
export {
  answerSupportTicket,
  closeSupportTicket,
  listSupportTickets,
  myTicketsForField,
  remindUnansweredTickets,
  type TicketView,
} from "./service/support";

// --- Pemisahan tugas, persetujuan, audit (US-M10-03/04/05) ---
export { describeApprovalRules, listAccessLogs, listDenials, roleMatrixView, type AccessLogFilter, type AccessLogItem, type ApprovalRuleView, type DenialSummary } from "./service/logs";

// --- Data pribadi, retensi, cadangan (US-M10-06) ---
export {
  employeeDataAccess,
  maskCustomerPii,
  maskPhone,
  redactEmployeeValues,
  regionOnly,
  viewPolicy,
  type CustomerPiiFields,
  type CustomerPiiLevel,
  type EmployeeDataKind,
  type ViewPolicy,
} from "./service/personal-data";
export {
  executeAnonymization,
  listAnonymizationRequests,
  openReceivableOf,
  remindDeferredAnonymizations,
  requestAnonymization,
  resubmitAnonymization,
  searchSubjects,
  type AnonymizationRow,
} from "./service/anonymization";
export { ARCHIVABLE_ATTACHMENT_KINDS, retentionOverview, retentionPolicy, runRetention, type RetentionPolicy, type RetentionResult } from "./service/retention";
export { backupOverview, recordBackupStatus, type BackupOverview, type BackupRow } from "./service/backup";
