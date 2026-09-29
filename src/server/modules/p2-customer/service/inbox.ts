/**
 * P2 — kotak notifikasi pelanggan & langganan Web Push perangkat (US-P2-03 KP-4). Hanya milik akun sendiri.
 */
import "server-only";

import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { customerNotifications, customerPushSubscriptions } from "@/db/schema";

import { getDb, runInTx, type Tx } from "@/server/core/db";
import { parseInput } from "@/server/core/errors";

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

const pushSchema = z.object({
  endpoint: z.url({ error: "Langganan notifikasi tidak valid." }),
  keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(4) }),
});

/** Simpan langganan Web Push perangkat pelanggan (idempoten per endpoint). */
export async function registerPushSubscription(cctx: CustomerContext, input: unknown, meta: { userAgent?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<{ id: string }> {
  const data = parseInput(pushSchema, input, { endpoint: "Langganan", keys: "Kunci" });
  return runInTx(opts.tx, async (tx) => {
    const [existing] = await tx.select().from(customerPushSubscriptions).where(eq(customerPushSubscriptions.endpoint, data.endpoint)).limit(1);
    if (existing) {
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
