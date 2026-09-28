/**
 * Kata sandi web kantor & PIN lapangan (US-M10-02 KP-3/KP-4): hash argon2id (`@node-rs/argon2`).
 * - Kata sandi minimal 10 karakter (PAR usulan PRD; aturan keamanan, bukan ambang bisnis).
 * - PIN tepat 6 angka; PIN baru yang terlalu mudah ditebak (000000, 123456, 654321, …) ditolak.
 */
import "server-only";

import { hash, verify } from "@node-rs/argon2";

import { ValidationError } from "../errors";

export const MIN_PASSWORD_LENGTH = 10;
export const PIN_LENGTH = 6;
const PIN_PATTERN = /^\d{6}$/;

/** Validasi kata sandi baru. */
export function validateNewPassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw ValidationError.field("password", `Kata sandi minimal ${MIN_PASSWORD_LENGTH} karakter.`);
  }
  if (password.length > 200) throw ValidationError.field("password", "Kata sandi terlalu panjang (maksimal 200 karakter).");
}

export async function hashPassword(password: string): Promise<string> {
  validateNewPassword(password);
  return hash(password);
}

/** Verifikasi hash argon2; galat format dianggap tidak cocok. */
export async function verifySecretHash(hashed: string | null | undefined, secret: string): Promise<boolean> {
  if (!hashed || typeof secret !== "string" || secret.length === 0) return false;
  try {
    return await verify(hashed, secret);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Samakan waktu respons saat pengguna tidak ditemukan (mencegah enumerasi nama pengguna lewat waktu): jalankan
 * verifikasi argon2 terhadap hash tiruan.
 */
export async function burnVerify(secret: string): Promise<void> {
  dummyHash ??= hash("equa-dummy-password-untuk-waktu-konstan");
  await verifySecretHash(await dummyHash, secret || "x");
}

/** Benar bila PIN berupa 6 angka. */
export function isPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_PATTERN.test(pin);
}

/** PIN lemah: semua angka sama, atau urut naik/turun (mis. 123456, 987654). */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const digits = pin.split("").map(Number);
  const asc = digits.every((d, i) => i === 0 || d === (digits[i - 1]! + 1) % 10);
  const desc = digits.every((d, i) => i === 0 || d === (digits[i - 1]! + 9) % 10);
  return asc || desc;
}

/** Validasi PIN baru (6 angka, tidak mudah ditebak). */
export function validateNewPin(pin: string): void {
  if (!isPinFormat(pin)) throw ValidationError.field("pin", "PIN harus 6 angka.");
  if (isWeakPin(pin)) {
    throw ValidationError.field("pin", "PIN terlalu mudah ditebak (angka sama atau berurutan). Pilih 6 angka lain.");
  }
}

export async function hashPin(pin: string): Promise<string> {
  validateNewPin(pin);
  return hash(pin);
}
