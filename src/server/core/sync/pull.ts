/**
 * `GET /api/sync/pull?since=<ISO>&keys=a,b` (docs/ARCHITECTURE.md §7; Bab 6.4 butir 4; NFR-06).
 *
 * Wajib sesi lapangan (klaim `sessionId`). Mengembalikan:
 * - `data[key]` dari setiap penyedia `registerPullProvider` (sesuai lingkup pelaku — truk hari itu untuk sopir/kernet);
 *   penyedia yang gagal dilaporkan di `errors[key]` tanpa menggagalkan pull;
 * - status perangkat & versi minimal aplikasi (`app.min_supported_version`, NFR-32);
 * - parameter yang dibutuhkan offline (PAR-30, PAR-36, PAR-37, PAR-38, PAR-42);
 * - `cursor` (= waktu server) untuk pull berikutnya.
 */
import "server-only";

import { eq } from "drizzle-orm";

import { devices } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";

import { getDb } from "../db";
import { toUserMessage, ValidationError } from "../errors";
import { get as getParam } from "../params-read";
import type { DeviceAuth } from "../auth/device-auth";
import { publicDevice, type PublicDevice } from "../auth/devices";
import { AuthError } from "../auth/errors";
import { buildFieldActorContext } from "../auth/field-login";
import { listPullProviders } from "./registry";

export type OfflineParams = {
  /** PAR-30: antrean minimal (hari) & target sinkron (menit). */
  queue: { minQueueDays: number; syncMaxMinutes: number };
  /** PAR-36: PIN salah berturut → kunci. */
  pinLock: { maxAttempts: number; lockMinutes: number };
  /** PAR-37: kunci layar saat tidak aktif. */
  screenLockMinutes: number;
  /** PAR-38: batas ukuran foto (KB). */
  photoMaxKb: number;
  /** PAR-42: selisih jam yang ditandai (menit). */
  clockSkewMinutes: number;
};

export type PullResponse = {
  ok: true;
  serverTime: string;
  cursor: string;
  device: PublicDevice;
  minVersion: string;
  updateRequired: boolean;
  params: OfflineParams;
  data: Record<string, unknown>;
  errors: Record<string, string>;
};

/** Bandingkan versi X.Y.Z (a < b → negatif). Bagian non-angka dianggap 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function offlineParams(now: Date): Promise<OfflineParams> {
  const db = getDb();
  const day = toBusinessDate(now);
  const [q, lock, idle, photo, skew] = await Promise.all([
    getParam(db, "PAR-30", day),
    getParam(db, "PAR-36", day),
    getParam(db, "PAR-37", day),
    getParam(db, "PAR-38", day),
    getParam(db, "PAR-42", day),
  ]);
  return {
    queue: { minQueueDays: q.min_queue_days, syncMaxMinutes: q.sync_max_minutes },
    pinLock: { maxAttempts: lock.max_attempts, lockMinutes: lock.lock_minutes },
    screenLockMinutes: idle.idle_minutes,
    photoMaxKb: photo.max_kb,
    clockSkewMinutes: skew.minutes_gt,
  };
}

export async function minSupportedVersion(now: Date): Promise<string> {
  const v = await getParam(getDb(), "app.min_supported_version", toBusinessDate(now));
  return v.version;
}

export async function processPull(auth: DeviceAuth, query: { since?: string | null; keys?: string | null }): Promise<PullResponse> {
  if (!auth.user || !auth.session) {
    throw new AuthError("SESSION_EXPIRED", "Sesi Anda di perangkat ini berakhir. Masukkan PIN saat ada sinyal untuk melanjutkan.");
  }
  const now = auth.now;
  let since: Date | null = null;
  if (query.since) {
    const d = new Date(query.since);
    if (Number.isNaN(d.getTime())) throw ValidationError.field("since", "Kursor sinkron tidak valid.");
    since = d;
  }
  const wanted = query.keys ? new Set(query.keys.split(",").map((k) => k.trim()).filter(Boolean)) : null;
  const db = getDb();
  const ctx = await buildFieldActorContext(db, auth.device, auth.user.id, { now });

  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [key, def] of listPullProviders()) {
    if (wanted && !wanted.has(key)) continue;
    if (def.roles?.length && !def.roles.some((r) => ctx.roles.includes(r))) continue;
    try {
      const value = await def.fetch({ ctx, device: auth.device, since, now, tx: db });
      if (value !== undefined) data[key] = value;
    } catch (error) {
      console.error(`[equa] penyedia pull ${key} gagal:`, error);
      errors[key] = toUserMessage(error);
    }
  }

  await db.update(devices).set({ lastSyncAt: now, lastSeenAt: now, lastUserId: auth.user.id }).where(eq(devices.id, auth.device.id));
  const minVersion = await minSupportedVersion(now);
  return {
    ok: true,
    serverTime: now.toISOString(),
    cursor: now.toISOString(),
    device: await publicDevice(db, auth.device),
    minVersion,
    updateRequired: !!auth.appVersion && compareVersions(auth.appVersion, minVersion) < 0,
    params: await offlineParams(now),
    data,
    errors,
  };
}
