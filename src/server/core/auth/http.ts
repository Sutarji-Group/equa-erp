/**
 * Pembantu route handler API lapangan: respons galat JSON yang membawa instruksi untuk klien (`wipe: true` untuk
 * perintah hapus data, `lockedUntil`/`attemptsLeft` untuk PIN) + pembaca body JSON yang aman.
 */
import "server-only";

import { e2eRequestNow } from "../e2e-clock";
import { errorResponse, ValidationError } from "../errors";
import { AuthError } from "./errors";

const SAFE_DETAIL_KEYS = ["wipe", "lockedUntil", "attemptsLeft"] as const;

/**
 * Seperti `errorResponse`, ditambah detail aman dari `AuthError`. `request` (opsional, tambahan S5 QA) agar `serverTime`
 * mengikuti jam tersuntik uji E2E yang sama dengan `authenticateDevice` (../e2e-clock.ts).
 */
export function apiErrorResponse(error: unknown, request?: { headers: Headers }): Response {
  if (error instanceof AuthError) {
    // `serverTime` agar klien dapat mengoreksi selisih jam walau permintaannya ditolak (mis. token kedaluwarsa).
    const body: Record<string, unknown> = { ok: false, code: error.code, message: error.message, serverTime: e2eRequestNow(request).toISOString() };
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
