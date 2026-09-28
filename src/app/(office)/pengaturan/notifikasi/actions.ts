"use server";

import { revalidatePath } from "next/cache";

import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import * as notifications from "@/server/core/notifications";

export type PrefResult = { error?: string } | undefined;

/** Ubah mode satu jenis notifikasi (kritis selalu seketika — ditolak di layanan). */
export async function setPreferenceAction(event: string, mode: "immediate" | "daily_digest" | "off"): Promise<PrefResult> {
  const { ctx } = await requireOfficeSession();
  try {
    await notifications.setPreference(ctx, event, mode);
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/pengaturan/notifikasi");
  return undefined;
}

/** Jam tenang pribadi untuk notifikasi non-kritis (`null` = bawaan PAR-56). */
export async function setQuietHoursAction(hours: { start: string; end: string } | null): Promise<PrefResult> {
  const { ctx } = await requireOfficeSession();
  try {
    await notifications.setQuietHours(ctx, hours);
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/pengaturan/notifikasi");
  return undefined;
}
