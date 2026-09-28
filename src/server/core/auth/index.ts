/**
 * Autentikasi, perangkat & sesi — API publik (docs/ARCHITECTURE.md §6; US-M10-02). Tanpa ketergantungan Next.js
 * (aman untuk uji). Pembantu halaman/Server Action (cookie, redirect) ada di `@/server/core/auth/office`.
 *
 * - Web kantor: `loginWithPassword`, `verifyTotpLogin`, `startTotpEnrollment`, `confirmTotpEnrollment`, `logout`.
 * - Sesi: `validateSession`, `revokeAllSessions(userId, reason)` (M10: nonaktifkan akun → sesi diputus, BR-37),
 *   `revokeSession`, `SESSION_COOKIE`.
 * - Perangkat: `registerDevice`, `issueActivationCode`, `activateDevice`, `blockDevice`, `requestWipe`,
 *   `listDeviceUsage`, `authenticateDevice` (JWT perangkat).
 * - Lapangan: `issuePinEnrollment` (kode aktivasi akun / reset PIN), `enrollPin`, `pinLogin`, `listDeviceUsers`,
 *   `buildFieldActorContext`, `isActingDriver`, `applyCrewScope`.
 * - Kata sandi: `hashPassword` (≥ 10 karakter), `validateNewPassword`.
 */
import "server-only";

import { registerJob } from "../jobs";
import { registerCoreSync } from "../sync/core-sync";
import { installActorResolver } from "./resolver";
import { purgeOldSessions } from "./session";

export * from "./errors";
export {
  SESSION_COOKIE,
  FIELD_SESSION_MAX_HOURS,
  PENDING_2FA_MINUTES,
  createSession,
  findFieldSessionCovering,
  isUserUsable,
  revokeAllSessions,
  revokeDeviceSessions,
  revokeSession,
  validateSession,
  webSessionPolicy,
  type RevokeReason,
  type SessionRow,
  type SessionValidation,
} from "./session";
export {
  loginWithPassword,
  verifyTotpLogin,
  startTotpEnrollment,
  confirmTotpEnrollment,
  logout,
  type LoginResult,
  type LoginStep,
  type RequestMeta,
  type TotpEnrollment,
} from "./web-login";
export { hashPassword, validateNewPassword, validateNewPin, isWeakPin, MIN_PASSWORD_LENGTH } from "./password";
export { readTotpSecret, verifyTotpCode, generateTotpSecret, buildOtpAuthUrl } from "./totp";
export {
  ACTIVATION_CODE_TTL_HOURS,
  activateDevice,
  blockDevice,
  deviceHome,
  deviceSource,
  getDevice,
  issueActivationCode,
  listDeviceUsage,
  logDeviceUsage,
  publicDevice,
  registerDevice,
  registerDeviceSchema,
  requestWipe,
  type ActivationResult,
  type DeviceRow,
  type PublicDevice,
  type RegisterDeviceInput,
} from "./devices";
export { authenticateDevice, signDeviceToken, requestIp, type DeviceAuth, type DeviceTokenClaims } from "./device-auth";
export {
  FIELD_ROLES,
  buildFieldActorContext,
  enrollPin,
  issuePinEnrollment,
  listDeviceUsers,
  pinLogin,
  type DeviceUserInfo,
  type FieldLoginResult,
  type FieldUserInfo,
} from "./field-login";
export { applyCrewScope, crewTrucksForDay, isActingDriver, substituteDriverConditions } from "./field-scope";
export { resolveActor, webActorFromToken, readCookie } from "./resolver";
export { computePinVerifier, PIN_VERIFIER_ITERATIONS, type PinVerifier } from "./crypto";

let registered = false;

/**
 * Registrasi inti autentikasi (dipanggil `ensureBootstrapped`): pasang resolver pelaku, handler sinkron inti
 * (`core.ping`, pull `core.me`/`core.device_users`), dan job pembersih sesi.
 */
export function registerCoreAuth(): void {
  if (registered) return;
  registered = true;
  installActorResolver();
  registerCoreSync();
  registerJob({
    key: "core.auth.purge_sessions",
    description: "Hapus baris sesi yang kedaluwarsa > 30 hari (tabel teknis).",
    schedule: { kind: "daily", at: "03:10" },
    run: ({ now, db }) => purgeOldSessions(now, db),
  });
}
