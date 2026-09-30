/**
 * P2 — kotak notifikasi pelanggan & langganan Web Push perangkat (US-P2-03 KP-4). Hanya milik akun sendiri.
 */
import "server-only";

import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { customerNotifications, customerPushSubscriptions } from "@/db/schema";

import { getDb, runInTx, type Tx } from "@/server/core/db";
import { ConflictError, parseInput } from "@/server/core/errors";

import type { CustomerContext } from "./common";

export type CustomerNotificationView = { id: string; kind: string; title: string; body: string | null; link: string | null; createdAt: Date; read: boolean };

export async function listMyNotifications(cctx: CustomerContext, opts: { tx?: Tx; limit?: number } = {}): Promise<CustomerNotificationView[]> {
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select()
    .from(customerNotifications)
    .where(eq(customerNotifications.customerAccountId, cctx.accountId))
    .orderBy(desc(customerNotifications.createdAt))
    .limit(opts.limit ?? 100);
  return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.createdAt, read: !!r.readAt }));
}

export async function unreadNotificationCount(cctx: CustomerContext, opts: { tx?: Tx } = {}): Promise<number> {
  const tx = opts.tx ?? getDb();
  const [row] = await tx
    .select({ n: count() })
    .from(customerNotifications)
    .where(and(eq(customerNotifications.customerAccountId, cctx.accountId), isNull(customerNotifications.readAt)));
  return Number(row?.n ?? 0);
}

export async function markMyNotificationsRead(cctx: CustomerContext, opts: { tx?: Tx } = {}): Promise<number> {
  return runInTx(opts.tx, async (tx) => {
    const rows = await tx
      .update(customerNotifications)
      .set({ readAt: cctx.now })
      .where(and(eq(customerNotifications.customerAccountId, cctx.accountId), isNull(customerNotifications.readAt)))
      .returning({ id: customerNotifications.id });
    return rows.length;
  });
}

/**
 * Layanan push peramban yang dikenal (Chrome/Edge FCM, Firefox Mozilla autopush, Windows WNS, Safari/Apple). Server
 * hanya mengirim POST ke host ini — mencegah SSRF lewat endpoint langganan palsu (US-P2-03 KP-4, NFR keamanan).
 */
const PUSH_SERVICE_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
];

/** Endpoint Web Push sah: https, port bawaan, tanpa kredensial/IP literal, host layanan push dikenal. */
export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  return PUSH_SERVICE_HOSTS.some((re) => re.test(host));
}

const pushSchema = z.object({
  endpoint: z
    .url({ error: "Langganan notifikasi tidak valid." })
    .max(1000)
    .refine(isAllowedPushEndpoint, { error: "Langganan notifikasi tidak valid. Aktifkan ulang notifikasi dari peramban Anda." }),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
});

/**
 * Simpan langganan Web Push perangkat pelanggan (idempoten per endpoint). Endpoint yang sudah milik akun LAIN hanya
 * berpindah bila pengirim membuktikan memegang langganan yang sama (kunci `auth` sama — peramban yang sama dipakai
 * akun lain); bila tidak, ditolak (tidak dapat diambil alih hanya dengan mengetahui URL endpoint).
 */
export async function registerPushSubscription(cctx: CustomerContext, input: unknown, meta: { userAgent?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<{ id: string }> {
  const data = parseInput(pushSchema, input, { endpoint: "Langganan", keys: "Kunci" });
  return runInTx(opts.tx, async (tx) => {
    const [existing] = await tx.select().from(customerPushSubscriptions).where(eq(customerPushSubscriptions.endpoint, data.endpoint)).limit(1).for("update");
    if (existing) {
      if (existing.customerAccountId !== cctx.accountId && !existing.revokedAt && existing.auth !== data.keys.auth) {
        throw new ConflictError("PUSH_SUBSCRIPTION_OWNED", "Langganan notifikasi ini terdaftar di akun lain. Aktifkan ulang notifikasi dari peramban Anda.");
      }
      await tx
        .update(customerPushSubscriptions)
        .set({ customerAccountId: cctx.accountId, p256dh: data.keys.p256dh, auth: data.keys.auth, revokedAt: null, lastUsedAt: cctx.now, userAgent: meta.userAgent?.slice(0, 300) ?? existing.userAgent })
        .where(eq(customerPushSubscriptions.id, existing.id));
      return { id: existing.id };
    }
    const [row] = await tx
      .insert(customerPushSubscriptions)
      .values({ customerAccountId: cctx.accountId, endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth, userAgent: meta.userAgent?.slice(0, 300) ?? null, lastUsedAt: cctx.now, createdAt: cctx.now })
      .returning({ id: customerPushSubscriptions.id });
    return { id: row!.id };
  });
}
