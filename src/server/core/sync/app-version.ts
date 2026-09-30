/**
 * Penegakan versi minimal aplikasi lapangan/POS DI SERVER (US-M10-07 KP-4, NFR-32; temuan S5B). Klien sudah
 * menampilkan gerbang "perbarui aplikasi" dari pull, tetapi klien lama atau gerbang yang bermasalah tetap dapat
 * menulis data — maka server:
 * - `processPush`: semua perintah dari versi di bawah minimal dijawab `retry` + `APP_UPDATE_REQUIRED` (antrean tetap
 *   tersimpan di perangkat, TIDAK ditolak final) dan kejadiannya dicatat di log perangkat (`update_required`);
 * - `pinLogin`: login PIN daring ditolak `APP_UPDATE_REQUIRED` (426) dengan pesan tindakan.
 * Header `X-App-Version` kosong (klien sangat lama/uji) tidak diblokir — sama dengan `updateRequired` di pull.
 */
import "server-only";

import { toBusinessDate } from "@/lib/time";

import { getDb, type Tx } from "../db";
import { get as getParam } from "../params-read";
import { compareVersions } from "./pull";

/** Versi minimal yang berlaku bila `appVersion` DI BAWAHNYA; `null` bila versi memenuhi (atau tidak dikirim). */
export async function appUpdateRequired(appVersion: string | null | undefined, now: Date, db: Tx = getDb()): Promise<string | null> {
  if (!appVersion) return null;
  const { version } = await getParam(db, "app.min_supported_version", toBusinessDate(now));
  return compareVersions(appVersion, version) < 0 ? version : null;
}

/** Pesan tindakan untuk pengguna lapangan (tanpa kode teknis). */
export function appUpdateMessage(minVersion: string): string {
  return `Aplikasi perlu diperbarui ke versi ${minVersion} atau lebih baru. Tutup lalu buka ulang aplikasi saat ada sinyal. Data yang belum terkirim tetap tersimpan di perangkat.`;
}
