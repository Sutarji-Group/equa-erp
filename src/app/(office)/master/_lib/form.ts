/**
 * Pembantu Server Action Data master: baca FormData & bungkus galat layanan menjadi `ActionState` berbahasa Indonesia.
 */
import "server-only";

import type { ActionState } from "@/components/m1-master/action-state";
import { toUserMessage } from "@/server/core/errors";

export function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/** Angka dari isian (menerima "1.250.000" / "1250000" / "-6,82"). `null` bila kosong. */
export function num(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (s === null) return null;
  const n = Number(s.replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Bilangan bulat rupiah/liter (titik ribuan dibuang). */
export function int(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (s === null) return null;
  const n = Number(s.replace(/[.\s]/g, "").replace(/^Rp/i, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

export function bool(fd: FormData, name: string): boolean {
  const v = fd.get(name);
  return v === "on" || v === "true" || v === "1";
}

export function coord(fd: FormData, prefix = ""): { lat: number | null; lng: number | null } {
  const lat = num(fd, `${prefix}lat`);
  const lng = num(fd, `${prefix}lng`);
  return { lat: lat === null || Number.isNaN(lat) ? null : lat, lng: lng === null || Number.isNaN(lng) ? null : lng };
}

/** Jalankan fungsi; galat → `{ error }` (pesan tindakan berbahasa Indonesia). */
export async function attempt(fn: () => Promise<ActionState | void>, successMessage?: string): Promise<ActionState> {
  try {
    const res = await fn();
    if (res) return res;
    return { ok: true, message: successMessage, nonce: Date.now() };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}
