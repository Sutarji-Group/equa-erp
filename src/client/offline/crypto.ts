/**
 * WebCrypto di perangkat lapangan (NFR-10): kunci perangkat non-extractable, token perangkat JWT HS256, verifikasi
 * PIN offline (PBKDF2-SHA256 terhadap verifier dari server — PIN tidak pernah disimpan), serta kunci perintah per
 * pengguna (terbungkus kunci turunan PIN; `src/lib/sync-signature.ts`).
 */
import type { PinVerifier } from "./types";

const enc = new TextEncoder();

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Peramban ini tidak mendukung enkripsi yang dibutuhkan. Gunakan Chrome terbaru.");
  return s;
}

/** Impor secret perangkat sebagai kunci HMAC-SHA256 NON-extractable (tidak dapat dibaca ulang oleh skrip). */
export async function importDeviceKey(secret: string, extractable = false): Promise<CryptoKey> {
  return subtle().importKey("raw", base64UrlToBytes(secret), { name: "HMAC", hash: "SHA-256" }, extractable, ["sign"]);
}

/** Token perangkat JWT HS256 `{ deviceId, userId?, sessionId?, iat, exp }` (jam server terkoreksi). */
export async function signDeviceJwt(
  key: CryptoKey,
  claims: { deviceId: string; userId?: string | null; sessionId?: string | null },
  nowMs: number,
  ttlSeconds = 300,
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const payload: Record<string, unknown> = { deviceId: claims.deviceId, iat, exp: iat + ttlSeconds };
  if (claims.userId) payload.userId = claims.userId;
  if (claims.sessionId) payload.sessionId = claims.sessionId;
  const head = bytesToBase64Url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const sig = await subtle().sign("HMAC", key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${bytesToBase64Url(sig)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Turunkan PBKDF2-SHA256 (32 byte, base64url). */
export async function derivePinVerifier(pin: string, salt: string, iterations: number): Promise<string> {
  const base = await subtle().importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: base64UrlToBytes(salt), iterations }, base, 256);
  return bytesToBase64Url(bits);
}

/** Verifikasi PIN offline terhadap verifier tersimpan. */
export async function verifyPinOffline(pin: string, verifier: PinVerifier): Promise<boolean> {
  if (!/^\d{6}$/.test(pin) || verifier.algorithm !== "PBKDF2-SHA256") return false;
  return constantTimeEqual(await derivePinVerifier(pin, verifier.salt, verifier.iterations), verifier.verifier);
}

// ---------------------------------------------------------------------------------------------------------------------
// Kunci perintah per pengguna (tanda tangan outbox)
// ---------------------------------------------------------------------------------------------------------------------

/** Kunci perintah terbungkus PBKDF2(PIN) → AES-GCM (disimpan di `credentials`, bukan teks biasa). */
export type WrappedCommandKey = { v: 1; iterations: number; salt: string; iv: string; ct: string };

export const COMMAND_KEY_WRAP_ITERATIONS = 150_000;

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  globalThis.crypto.getRandomValues(out);
  return out;
}

async function pinWrappingKey(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Bungkus kunci perintah (base64url dari server) dengan kunci turunan PIN. */
export async function wrapCommandKey(pin: string, commandKey: string, iterations = COMMAND_KEY_WRAP_ITERATIONS): Promise<WrappedCommandKey> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await pinWrappingKey(pin, salt, iterations);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, key, base64UrlToBytes(commandKey));
  return { v: 1, iterations, salt: bytesToBase64Url(salt), iv: bytesToBase64Url(iv), ct: bytesToBase64Url(ct) };
}

/** Buka kunci perintah dengan PIN → CryptoKey HMAC non-extractable (null bila PIN salah / data rusak). */
export async function unwrapCommandKey(pin: string, wrapped: WrappedCommandKey): Promise<CryptoKey | null> {
  try {
    const key = await pinWrappingKey(pin, base64UrlToBytes(wrapped.salt), wrapped.iterations);
    const raw = await subtle().decrypt({ name: "AES-GCM", iv: base64UrlToBytes(wrapped.iv) }, key, base64UrlToBytes(wrapped.ct));
    return subtle().importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    return null;
  }
}

/** Impor kunci perintah (base64url) sebagai HMAC non-extractable. */
export async function importCommandKey(commandKey: string): Promise<CryptoKey> {
  return subtle().importKey("raw", base64UrlToBytes(commandKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Tanda tangan HMAC-SHA256 (base64url) atas string perintah. */
export async function signCommandString(key: CryptoKey, signing: string): Promise<string> {
  return bytesToBase64Url(await subtle().sign("HMAC", key, enc.encode(signing)));
}

/** SHA-256 hex isi Blob (hash lampiran yang ikut ditandatangani). */
export async function sha256HexOfBlob(blob: Blob): Promise<string> {
  const digest = await subtle().digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
