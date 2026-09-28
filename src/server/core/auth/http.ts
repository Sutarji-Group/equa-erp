/**
 * Pembantu route handler API lapangan: respons galat JSON yang membawa instruksi untuk klien (`wipe: true` untuk
 * perintah hapus data, `lockedUntil`/`attemptsLeft` untuk PIN) + pembaca body JSON yang aman.
 */
import "server-only";

import { errorResponse, ValidationError } from "../errors";
import { AuthError } from "./errors";

const SAFE_DETAIL_KEYS = ["wipe", "lockedUntil", "attemptsLeft"] as const;

/** Seperti `errorResponse`, ditambah detail aman dari `AuthError`. */
export function apiErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    // `serverTime` agar klien dapat mengoreksi selisih jam walau permintaannya ditolak (mis. token kedaluwarsa).
    const body: Record<string, unknown> = { ok: false, code: error.code, message: error.message, serverTime: new Date().toISOString() };
    for (const key of SAFE_DETAIL_KEYS) {
      if (error.details && key in error.details) body[key] = error.details[key];
    }
    if (error.code === "DEVICE_WIPE") body.wipe = true;
    return Response.json(body, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  return errorResponse(error);
}

/** Baca body JSON; body rusak → ValidationError Indonesia. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("Data kiriman tidak terbaca. Coba kirim ulang.");
  }
}

/** Respons JSON sukses tanpa cache. */
export function okJson(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, { ...init, headers: { "Cache-Control": "no-store", ...(init.headers ?? {}) } });
}
