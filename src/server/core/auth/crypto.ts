/**
 * Kriptografi autentikasi (docs/ARCHITECTURE.md §6; NFR-10). Murni Node (`node:crypto`), TANPA 'server-only' agar skrip
 * tsx (mis. `scripts/e2e-prepare.ts`) dapat memakainya — jangan impor dari komponen klien.
 *
 * - Kunci turunan per keperluan: HKDF-SHA256 dari `SESSION_SECRET` (`deriveKey("totp-secret")`, …). Mengganti
 *   `SESSION_SECRET` membatalkan rahasia TOTP terenkripsi, kode aktivasi yang beredar, dan secret perangkat (perangkat
 *   harus diaktifkan ulang) — lakukan hanya bersama prosedur rotasi.
 * - Rahasia TOTP: AES-256-GCM, format `v1:<iv>:<tag>:<ct>` (base64url).
 * - Token sesi: 32 byte acak (base64url); DB menyimpan `sha256` hex.
 * - Kode aktivasi perangkat / aktivasi akun lapangan: 8 karakter dari alfabet tanpa huruf mirip; DB menyimpan HMAC.
 * - Secret perangkat: diturunkan `HMAC(kunci "device-secret", deviceId:nonce)`; DB menyimpan `d1:<nonce>:<sha256>` —
 *   kebocoran DB saja tidak cukup untuk memalsukan token perangkat.
 * - Verifier PIN offline: PBKDF2-SHA256 ≥ 100.000 iterasi + salt acak (bukan PIN; US-M10-02 KP-5, NFR-10).
 * - Kunci perintah sinkron per sesi lapangan: `HMAC(kunci "field-command", sessionId)` — tidak disimpan di DB (dapat
 *   diturunkan ulang); diberikan ke perangkat saat login PIN untuk menandatangani perintah outbox
 *   (`src/lib/sync-signature.ts`).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, pbkdf2, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { serverEnv } from "@/lib/env";

const pbkdf2Async = promisify(pbkdf2);

// ---------------------------------------------------------------------------------------------------------------------
// Pembantu dasar
// ---------------------------------------------------------------------------------------------------------------------

/** Base64url tanpa padding. */
export function toBase64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function fromBase64Url(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

/** Token acak kuat (bawaan 32 byte) dalam base64url. */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Perbandingan waktu-konstan dua string (panjang berbeda → false). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export type KeyPurpose = "totp-secret" | "code-hmac" | "device-secret" | "field-command";

const keyCache = new Map<string, Buffer>();

/** Kunci 32 byte per keperluan, diturunkan HKDF-SHA256 dari `SESSION_SECRET`. */
export function deriveKey(purpose: KeyPurpose): Buffer {
  const secret = serverEnv().SESSION_SECRET;
  const cacheKey = `${sha256Hex(secret)}:${purpose}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "equa-erp", `equa:${purpose}:v1`, 32));
    keyCache.set(cacheKey, key);
  }
  return key;
}

/** HMAC-SHA256 hex dengan kunci turunan. */
export function hmacHex(purpose: KeyPurpose, data: string): string {
  return createHmac("sha256", deriveKey(purpose)).update(data).digest("hex");
}

// ---------------------------------------------------------------------------------------------------------------------
// Enkripsi rahasia (TOTP) — AES-256-GCM `v1:<iv>:<tag>:<ct>`
// ---------------------------------------------------------------------------------------------------------------------

export const ENCRYPTED_SECRET_PREFIX = "v1:";

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey("totp-secret"), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${toBase64Url(iv)}:${toBase64Url(tag)}:${toBase64Url(ct)}`;
}

/** Dekripsi `v1:…`. Melempar Error bila format salah atau data diubah (tag GCM tidak cocok). */
export function decryptSecret(enc: string): string {
  const parts = enc.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Format rahasia terenkripsi tidak dikenal.");
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", deriveKey("totp-secret"), fromBase64Url(ivB64));
  decipher.setAuthTag(fromBase64Url(tagB64));
  return Buffer.concat([decipher.update(fromBase64Url(ctB64)), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------------------------------------------------
// Kode 8 karakter (aktivasi perangkat, aktivasi akun lapangan)
// ---------------------------------------------------------------------------------------------------------------------

/** Alfabet kode: tanpa 0/O, 1/I/L (mudah dibaca & diketik dari layar admin). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

export function randomCode(length = CODE_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Normalisasi ketikan pengguna: huruf besar, hanya huruf/angka (tanda '-' dan spasi dibuang). */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** `ABCD1234` → `ABCD-1234` untuk ditampilkan. */
export function formatCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export type CodeKind = "device-activation" | "pin-enrollment";

/** HMAC kode (disimpan di DB, bukan kodenya). */
export function hashCode(kind: CodeKind, code: string): string {
  return hmacHex("code-hmac", `${kind}:${normalizeCode(code)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Secret perangkat
// ---------------------------------------------------------------------------------------------------------------------

export const DEVICE_SECRET_RECORD_PREFIX = "d1:";

function deriveDeviceSecret(deviceId: string, nonce: string): string {
  return toBase64Url(createHmac("sha256", deriveKey("device-secret")).update(`${deviceId}:${nonce}`).digest());
}

/** Secret perangkat baru + rekaman yang disimpan di `devices.secret_hash` (tanpa secret). */
export function issueDeviceSecret(deviceId: string): { secret: string; record: string } {
  const nonce = randomToken(16);
  const secret = deriveDeviceSecret(deviceId, nonce);
  return { secret, record: `${DEVICE_SECRET_RECORD_PREFIX}${nonce}:${sha256Hex(secret)}` };
}

/** Pulihkan secret perangkat dari rekaman DB (null bila rekaman rusak/tidak cocok, mis. SESSION_SECRET diganti). */
export function deviceSecretFromRecord(deviceId: string, record: string | null | undefined): string | null {
  if (!record || !record.startsWith(DEVICE_SECRET_RECORD_PREFIX)) return null;
  const [nonce, digest] = record.slice(DEVICE_SECRET_RECORD_PREFIX.length).split(":");
  if (!nonce || !digest) return null;
  const secret = deriveDeviceSecret(deviceId, nonce);
  return safeEqual(sha256Hex(secret), digest) ? secret : null;
}

/** Byte kunci HS256 dari secret perangkat (base64url 32 byte). */
export function deviceSecretKeyBytes(secret: string): Uint8Array {
  return new Uint8Array(fromBase64Url(secret));
}

// ---------------------------------------------------------------------------------------------------------------------
// Verifier PIN offline (PBKDF2-SHA256)
// ---------------------------------------------------------------------------------------------------------------------

export const PIN_VERIFIER_ALGORITHM = "PBKDF2-SHA256" as const;
/** ≥ 100.000 iterasi (NFR-10). */
export const PIN_VERIFIER_ITERATIONS = 150_000;

export type PinVerifier = {
  algorithm: typeof PIN_VERIFIER_ALGORITHM;
  iterations: number;
  /** Salt acak 16 byte (base64url). */
  salt: string;
  /** Turunan 32 byte (base64url). */
  verifier: string;
};

/** Hitung verifier PIN (salt acak bila tidak diberikan). Perangkat memverifikasi login offline dengan WebCrypto. */
export async function computePinVerifier(pin: string, options: { salt?: string; iterations?: number } = {}): Promise<PinVerifier> {
  const salt = options.salt ?? randomToken(16);
  const iterations = options.iterations ?? PIN_VERIFIER_ITERATIONS;
  const derived = await pbkdf2Async(pin, fromBase64Url(salt), iterations, 32, "sha256");
  return { algorithm: PIN_VERIFIER_ALGORITHM, iterations, salt, verifier: toBase64Url(derived) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Kunci & tanda tangan perintah sinkron lapangan (src/lib/sync-signature.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Kunci perintah (32 byte, base64url) untuk sesi lapangan — diturunkan, tidak disimpan. */
export function fieldCommandKey(sessionId: string): string {
  return toBase64Url(createHmac("sha256", deriveKey("field-command")).update(`session:${sessionId}`).digest());
}

/** Tanda tangan HMAC-SHA256 (base64url) atas string perintah dengan kunci perintah sesi. */
export function signFieldCommand(sessionId: string, signingString: string): string {
  return toBase64Url(createHmac("sha256", fromBase64Url(fieldCommandKey(sessionId))).update(signingString, "utf8").digest());
}

/** Verifikasi tanda tangan perintah (waktu-konstan). */
export function verifyFieldCommand(sessionId: string, signingString: string, signature: string | null | undefined): boolean {
  if (!signature) return false;
  return safeEqual(signFieldCommand(sessionId, signingString), signature);
}
