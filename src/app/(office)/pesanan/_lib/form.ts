/**
 * Pembantu Server Action Pesanan & jadwal (M2): baca FormData & bungkus galat layanan menjadi `ActionState` berbahasa
 * Indonesia. Dipakai /pesanan, /jadwal, /langganan.
 */
import "server-only";

import type { ActionState } from "@/components/m2-orders/action-state";
import { isDomainError, toUserMessage } from "@/server/core/errors";

export function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/** Bilangan bulat (titik ribuan dibuang). `null` bila kosong. */
export function int(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (s === null) return null;
  const n = Number(s.replace(/[.\s]/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

export function bool(fd: FormData, name: string): boolean {
  const v = fd.get(name);
  return v === "on" || v === "true" || v === "1";
}

export function all(fd: FormData, name: string): string[] {
  return fd.getAll(name).filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/** Galat → `{ error, code }` (pesan tindakan berbahasa Indonesia). */
export function failure(error: unknown): ActionState {
  return { error: toUserMessage(error), code: isDomainError(error) ? (error as { code?: string }).code : undefined };
}

/** Jalankan fungsi; galat → `{ error }`. */
export async function attempt(fn: () => Promise<ActionState | void>, successMessage?: string): Promise<ActionState> {
  try {
    const res = await fn();
    if (res) return { ok: !res.error, nonce: Date.now(), ...res };
    return { ok: true, message: successMessage, nonce: Date.now() };
  } catch (error) {
    return failure(error);
  }
}
