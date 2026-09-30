"use server";

import { revalidatePath } from "next/cache";

import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage, ValidationError } from "@/server/core/errors";
import * as flags from "@/server/core/flags";
import * as params from "@/server/core/params";

export type SetParamResult = { error?: string; ok?: boolean } | undefined;

/**
 * Ubah parameter Lampiran B (6.2b: keputusan langsung pemilik; tanggal berlaku wajib, tidak surut; alasan; berjejak
 * audit; notifikasi Admin Keuangan & peran terdampak). Hanya pemilik — diperiksa di `params.set`.
 */
export async function setParameterAction(key: string, valueJson: string, effectiveFrom: string, reason: string): Promise<SetParamResult> {
  const { ctx } = await requireOfficeSession();
  try {
    if (!params.isParamKey(key)) throw ValidationError.field("key", "Parameter tidak dikenal.");
    let value: unknown;
    try {
      value = JSON.parse(valueJson);
    } catch {
      throw ValidationError.field("value", "Nilai parameter tidak terbaca. Periksa isian.");
    }
    await params.set(ctx, key, value as never, effectiveFrom, reason);
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/pengaturan/parameter");
  return { ok: true };
}

export type SetFlagResult = { error?: string; ok?: boolean } | undefined;

/**
 * Tambahan S5-C (gerbang tahap, docs/uat/gerbang-tahap.md): pemilik menyalakan/mematikan fitur bertahap (feature flag)
 * secara global atau PER TENANT — mis. `phase3.partner_portal` untuk satu tenant mitra, `phase2.customer_app` untuk
 * tenant EQUA. Peran penyetel, lingkup yang diizinkan, alasan wajib & jejak audit diperiksa di core `flags.set`.
 */
export async function setFeatureFlagAction(key: string, scopeRefId: string, enabled: boolean, reason: string): Promise<SetFlagResult> {
  const { ctx } = await requireOfficeSession();
  try {
    if (!flags.isFlagKey(key)) throw ValidationError.field("key", "Fitur tidak dikenal.");
    const scope = scopeRefId ? { type: "tenant" as const, refId: scopeRefId } : { type: "global" as const };
    await flags.set(ctx, key, enabled, { scope, reason });
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/pengaturan/parameter");
  return { ok: true };
}
