/**
 * Kanal Web Push (VAPID; PTB-05). No-op bila `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` kosong (dev/uji).
 * Langganan yang ditolak layanan push (404/410) ditandai dicabut oleh pemanggil (`gone: true`).
 */
import "server-only";

import webpush from "web-push";

import { serverEnv } from "@/lib/env";

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };

export type PushPayload = {
  title: string;
  body?: string | null;
  /** Tautan tindakan (relatif ke APP_URL). */
  url?: string | null;
  /** Pengelompokan di perangkat. */
  tag?: string | null;
  severity?: string;
};

export type PushResult = { ok: boolean; skipped?: boolean; gone?: boolean; error?: string };

/** Benar bila kunci VAPID terkonfigurasi. */
export function isWebPushConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** Kirim satu notifikasi push. Tidak pernah melempar galat. */
export async function sendWebPush(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<PushResult> {
  if (!isWebPushConfigured()) return { ok: false, skipped: true };
  const env = serverEnv();
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      {
        TTL: 60 * 60 * 24,
        urgency: payload.severity === "critical" ? "high" : "normal",
        vapidDetails: { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
      },
    );
    return { ok: true };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    return { ok: false, gone: status === 404 || status === 410, error: error instanceof Error ? error.message : String(error) };
  }
}
