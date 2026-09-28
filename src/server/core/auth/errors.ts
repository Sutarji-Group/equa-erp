/**
 * Galat autentikasi (HTTP 401/403/410/423) — pesan Bahasa Indonesia berisi tindakan. Isomorfik (tanpa 'server-only').
 *
 * Kode (`code`) dipakai klien lapangan untuk bereaksi: `DEVICE_WIPE` → hapus IndexedDB; `DEVICE_BLOCKED` /
 * `DEVICE_UNKNOWN` → kembali ke aktivasi; `SESSION_EXPIRED` → minta login PIN daring; `APP_UPDATE_REQUIRED` → perbarui.
 */
import { DomainError } from "../errors";

export type AuthErrorCode =
  | "AUTH_FAILED"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_INACTIVE"
  | "NO_ACTIVE_ROLE"
  | "FIELD_ACCOUNT"
  | "TOTP_REQUIRED"
  | "TOTP_INVALID"
  | "TOTP_NOT_ENROLLED"
  | "SESSION_EXPIRED"
  | "SESSION_REQUIRED"
  | "DEVICE_UNKNOWN"
  | "DEVICE_BLOCKED"
  | "DEVICE_WIPE"
  | "DEVICE_NOT_ACTIVE"
  | "DEVICE_TOKEN_INVALID"
  | "ACTIVATION_INVALID"
  | "ACTIVATION_RATE_LIMITED"
  | "PIN_INVALID"
  | "PIN_LOCKED"
  | "PIN_NOT_SET"
  | "PIN_ENROLLMENT_INVALID"
  | "USER_NOT_ALLOWED_ON_DEVICE"
  | "APP_UPDATE_REQUIRED";

const STATUS: Partial<Record<AuthErrorCode, number>> = {
  ACCOUNT_LOCKED: 423,
  PIN_LOCKED: 423,
  ACCOUNT_INACTIVE: 403,
  NO_ACTIVE_ROLE: 403,
  FIELD_ACCOUNT: 403,
  DEVICE_BLOCKED: 403,
  DEVICE_NOT_ACTIVE: 403,
  USER_NOT_ALLOWED_ON_DEVICE: 403,
  DEVICE_WIPE: 410,
  ACTIVATION_RATE_LIMITED: 429,
  APP_UPDATE_REQUIRED: 426,
};

export class AuthError extends DomainError {
  override readonly status: number;
  declare readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = "AuthError";
    this.status = STATUS[code] ?? 401;
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
