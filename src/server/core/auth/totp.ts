/**
 * TOTP 2FA web kantor (PTB-35; US-M10-02 KP-4) memakai otplib v13 (API fungsional).
 *
 * Rahasia disimpan terenkripsi (`v1:…`, lihat `./crypto.ts`). Seed demo memakai awalan `plain:` — diterima HANYA bila
 * rahasia dev diizinkan (`devSecretsAllowed`: dev/uji, atau E2E lokal dengan ALLOW_DEV_SECRETS=1; TIDAK pernah di
 * produksi/preview) dan dienkripsi ulang saat dipakai (`readTotpSecret` → `reencrypted`).
 * Toleransi ±30 detik (satu langkah). Pemakaian ulang kode dicegah dengan `afterTimeStep` (langkah terakhir yang
 * berhasil, disimpan di `access_logs.details.totpTimeStep`).
 */
import "server-only";

import { generateSecret, generateURI, verify } from "otplib";

import { PLAIN_SECRET_PREFIX } from "@/db/seed/constants";
import { devSecretsAllowed, serverEnv } from "@/lib/env";

import { decryptSecret, encryptSecret, ENCRYPTED_SECRET_PREFIX } from "./crypto";

export const TOTP_ISSUER = "EQUA";
/** Toleransi jam (detik) — satu langkah 30 detik ke depan/belakang. */
export const TOTP_EPOCH_TOLERANCE = 30;

export function generateTotpSecret(): string {
  return generateSecret({ length: 20 });
}

export function buildOtpAuthUrl(secret: string, username: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: username, secret });
}

export type TotpCheck = { valid: false } | { valid: true; timeStep: number };

/** Verifikasi kode 6 angka. `afterTimeStep` menolak kode dari langkah yang sudah dipakai. */
export async function verifyTotpCode(
  secret: string,
  code: string,
  options: { now?: Date; afterTimeStep?: number | null } = {},
): Promise<TotpCheck> {
  const token = String(code ?? "").replace(/\D+/g, "");
  if (token.length !== 6) return { valid: false };
  try {
    const result = await verify({
      secret,
      token,
      epoch: Math.floor((options.now ?? new Date()).getTime() / 1000),
      epochTolerance: TOTP_EPOCH_TOLERANCE,
      ...(options.afterTimeStep != null ? { afterTimeStep: options.afterTimeStep } : {}),
    });
    return result.valid && "timeStep" in result ? { valid: true, timeStep: result.timeStep } : { valid: false };
  } catch {
    return { valid: false };
  }
}

export type StoredTotpSecret = { secret: string; reencrypted: string | null };

/**
 * Baca rahasia TOTP dari `users.totp_secret_enc`. `plain:<base32>` diterima hanya bila bukan produksi (seed demo);
 * `reencrypted` berisi nilai `v1:…` pengganti yang harus disimpan pemanggil. Null bila kosong/tidak valid.
 */
export function readTotpSecret(stored: string | null | undefined): StoredTotpSecret | null {
  if (!stored) return null;
  if (stored.startsWith(ENCRYPTED_SECRET_PREFIX)) {
    try {
      return { secret: decryptSecret(stored), reencrypted: null };
    } catch {
      return null;
    }
  }
  if (stored.startsWith(PLAIN_SECRET_PREFIX)) {
    // Sama dengan aturan rahasia bawaan di src/lib/env.ts: produksi/preview menolak `plain:`; E2E lokal eksplisit boleh.
    if (!devSecretsAllowed(serverEnv())) return null;
    const secret = stored.slice(PLAIN_SECRET_PREFIX.length);
    return secret ? { secret, reencrypted: encryptSecret(secret) } : null;
  }
  return null;
}

/** Enkripsi rahasia TOTP untuk disimpan. */
export function sealTotpSecret(secret: string): string {
  return encryptSecret(secret);
}
