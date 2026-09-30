/**
 * Parameter offline hasil pull (`PullResponse.params`, disimpan di baris `device`): PAR-30 (target sinkron), PAR-36/37
 * (PIN & kunci layar), PAR-38 (batas foto), PAR-42 (selisih jam). Klien membaca angka aturan dari sini — bukan
 * konstanta — dan memakai bawaan Lampiran B hanya bila perangkat belum pernah menarik data (D-14 butir 2).
 */
import { DEFAULT_PHOTO_MAX_KB, photoMaxBytes } from "@/client/media/compress-image";

import { fieldDb } from "./db";
import type { OfflineParams } from "./types";

/** Bawaan PAR-30 "sinkron ≤ 5 menit" bila parameter belum diunduh. */
export const DEFAULT_SYNC_MAX_MINUTES = 5;

/** Parameter offline terakhir dari server (null bila belum pernah pull / bukan peramban). */
export async function fieldOfflineParams(): Promise<OfflineParams | null> {
  try {
    return (await fieldDb().device.get("device"))?.params ?? null;
  } catch {
    return null;
  }
}

/** PAR-38 (KB) dari data pull; bawaan 150 KB bila belum ada. */
export async function fieldPhotoMaxKb(): Promise<number> {
  const kb = (await fieldOfflineParams())?.photoMaxKb;
  return typeof kb === "number" && kb > 0 ? kb : DEFAULT_PHOTO_MAX_KB;
}

/** PAR-38 dalam byte (batas kompresi foto aplikasi lapangan). */
export async function fieldPhotoMaxBytes(): Promise<number> {
  return photoMaxBytes(await fieldPhotoMaxKb());
}

/** PAR-30 target sinkron (menit) dari data pull; bawaan 5. */
export function syncMaxMinutesOf(params: Pick<OfflineParams, "queue"> | null | undefined): number {
  const m = params?.queue?.syncMaxMinutes;
  return typeof m === "number" && Number.isFinite(m) && m > 0 ? m : DEFAULT_SYNC_MAX_MINUTES;
}
