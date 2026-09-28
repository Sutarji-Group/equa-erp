import "server-only";

import type { ScopeType } from "@/lib/labels";
import type { ActionState } from "@/components/m10-access/action-state";
import { toUserMessage } from "@/server/core/errors";

/** Jalankan tindakan Server Action; galat → pesan tindakan berbahasa Indonesia (tanpa kode teknis). */
export async function runAction(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { ok: true, message: "Tersimpan." };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

/** Nilai teks isian formulir (dipangkas; kosong → null). */
export function str(formData: FormData, name: string): string | null {
  const v = formData.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Semua nilai isian bernama sama (kotak centang). */
export function strs(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());
}

/** Kotak centang tercentang? */
export function bool(formData: FormData, name: string): boolean {
  const v = formData.get(name);
  return v === "on" || v === "true" || v === "1";
}

/** Nilai lingkup `jenis:id` → `{ type, refId }`. */
export function scopes(formData: FormData, name = "scope"): { type: ScopeType; refId: string }[] {
  return strs(formData, name)
    .map((v) => v.split(":"))
    .filter((p): p is [string, string] => p.length === 2)
    .map(([type, refId]) => ({ type: type as ScopeType, refId }));
}

/** Bilangan bulat (kosong → null). */
export function int(formData: FormData, name: string): number | null {
  const v = str(formData, name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** `datetime-local` (WIB) → Date. */
export function wibDateTime(formData: FormData, name: string): Date | null {
  const v = str(formData, name);
  if (!v) return null;
  const d = new Date(`${v.length === 16 ? `${v}:00` : v}+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
