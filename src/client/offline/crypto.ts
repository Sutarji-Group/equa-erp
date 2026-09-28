/**
 * WebCrypto di perangkat lapangan (NFR-10): kunci perangkat non-extractable, token perangkat JWT HS256, verifikasi
 * PIN offline (PBKDF2-SHA256 terhadap verifier dari server — PIN tidak pernah disimpan).
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
