/**
 * P2 — WhatsApp Cloud API: webhook status & biaya per pesan (US-P2-08 KP-1/KP-3, NFR-20, NFR-29, PTB-60).
 *
 * - GET verifikasi langganan webhook Meta: `hub.mode=subscribe` + `hub.verify_token` = env `WA_WEBHOOK_VERIFY_TOKEN`
 *   → balas `hub.challenge`.
 * - POST status: tanda tangan `X-Hub-Signature-256` = HMAC-SHA256(env `WA_APP_SECRET`, badan mentah). Tanpa rahasia
 *   aplikasi, webhook hanya diterima bila rahasia dev diizinkan (dev/uji/E2E) — tidak pernah di produksi.
 * - Setiap status (`sent` → `delivered` → `read`, `failed`) memperbarui `wa_message_logs` milik modul mana pun
 *   (konfirmasi pesanan M2, pengingat M5, struk, notifikasi P2) lewat `provider_message_id`; status tidak pernah mundur.
 * - Pesan tertagih (`pricing.billable`) → satu baris `wa_message_costs` (tarif `p2.wa_pricing` per kategori Meta) untuk
 *   laporan biaya bulanan (NFR-29).
 */
import "server-only";

import { createHmac } from "node:crypto";

import { and, asc, eq, gte, lt, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { waMessageCosts, waMessageLogs } from "@/db/schema";
import { devSecretsAllowed, serverEnv } from "@/lib/env";
import { label, type EnumValue } from "@/lib/labels";
import { addDays, lastDayOfMonth, monthOf, toBusinessDate, wibToUtc } from "@/lib/time";

import { safeEqual } from "@/server/core/auth/crypto";
import type { ActorContext } from "@/server/core/context";
import { getDb, runInTx, type Tx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { authorize } from "@/server/core/rbac";

import { CUSTOMER_APP_TENANT_ID } from "./common";
import { isAutoWaActive } from "./messaging";

/** Verifikasi langganan webhook (GET). Mengembalikan `challenge` atau null. */
export function verifyWaWebhookChallenge(query: { mode?: string | null; token?: string | null; challenge?: string | null }, env: Record<string, string | undefined> = process.env): string | null {
  const expected = env.WA_WEBHOOK_VERIFY_TOKEN;
  if (!expected || query.mode !== "subscribe" || !query.token || !query.challenge) return null;
  return safeEqual(query.token, expected) ? query.challenge : null;
}

/** Tanda tangan `X-Hub-Signature-256` untuk badan mentah (dipakai uji & simulasi dev). */
export function signWaWebhook(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/** Periksa tanda tangan webhook status. */
export function verifyWaSignature(rawBody: string, header: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const secret = env.WA_APP_SECRET;
  if (!secret) return devSecretsAllowed(serverEnv());
  if (!header) return false;
  return safeEqual(signWaWebhook(rawBody, secret), header.trim());
}

type WaStatus = {
  id?: string;
  status?: string;
  timestamp?: string | number;
  recipient_id?: string;
  pricing?: { billable?: boolean; category?: string; pricing_model?: string };
  errors?: { code?: number; title?: string; message?: string }[];
};

type WaWebhookBody = { object?: string; entry?: { changes?: { field?: string; value?: { statuses?: WaStatus[] } }[] }[] };

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

export type WaWebhookOutcome = { statuses: number; updated: number; unknown: number; costsRecorded: number };

/** Proses badan webhook status Cloud API (idempoten: status tidak mundur, biaya sekali per pesan). */
export async function handleWaStatusWebhook(body: unknown, opts: { now?: Date; tx?: Tx } = {}): Promise<WaWebhookOutcome> {
  const payload = (body ?? {}) as WaWebhookBody;
  const statuses: WaStatus[] = (payload.entry ?? []).flatMap((e) => (e.changes ?? []).flatMap((c) => c.value?.statuses ?? []));
  const out: WaWebhookOutcome = { statuses: statuses.length, updated: 0, unknown: 0, costsRecorded: 0 };
  if (!statuses.length) return out;
  const now = opts.now ?? new Date();
  return runInTx(opts.tx, async (tx) => {
    for (const s of statuses) {
      if (!s.id || !s.status) continue;
      const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : now;
      const when = Number.isNaN(at.getTime()) ? now : at;
      const [log] = await tx.select().from(waMessageLogs).where(eq(waMessageLogs.providerMessageId, s.id)).limit(1).for("update");
      if (!log) {
        out.unknown++;
      } else {
        const patch: Partial<typeof waMessageLogs.$inferInsert> = {};
        if (s.status === "failed") {
          if (log.status !== "read" && log.status !== "delivered") {
            patch.status = "failed";
            patch.error = s.errors?.map((e) => e.title ?? e.message ?? String(e.code ?? "")).filter(Boolean).join("; ") || "Gagal terkirim (Cloud API)";
          }
        } else if (RANK[s.status]) {
          const current = RANK[log.status] ?? 0;
          if (RANK[s.status]! > current) patch.status = s.status as EnumValue<"wa_message_status">;
          if ((s.status === "delivered" || s.status === "read") && !log.deliveredAt) patch.deliveredAt = when;
          if (s.status === "read" && !log.readAt) patch.readAt = when;
          if (s.status === "sent" && !log.sentAt) patch.sentAt = when;
        }
        if (Object.keys(patch).length) {
          await tx.update(waMessageLogs).set({ ...patch, updatedAt: now }).where(eq(waMessageLogs.id, log.id));
          out.updated++;
        }
      }
      if (s.pricing && s.pricing.billable !== false && s.pricing.category) {
        const tenantId = log?.tenantId ?? CUSTOMER_APP_TENANT_ID;
        const date = toBusinessDate(when);
        const pricing = await params.get(tx, "p2.wa_pricing", date, { tenantId });
        const category = s.pricing.category as keyof typeof pricing;
        const cost = pricing[category] ?? 0;
        const res = await tx
          .insert(waMessageCosts)
          .values({ tenantId, waMessageLogId: log?.id ?? null, providerMessageId: s.id, category: s.pricing.category, billable: true, costAmount: cost, month: monthOf(date), createdAt: now })
          .onConflictDoNothing()
          .returning({ id: waMessageCosts.id });
        if (res.length) out.costsRecorded++;
      }
    }
    return out;
  });
}

export type WaCostSummary = {
  month: string;
  providerActive: boolean;
  totalCost: number;
  billableMessages: number;
  byCategory: { category: string; count: number; amount: number }[];
  byKind: { kind: EnumValue<"wa_message_kind">; label: string; sent: number; delivered: number; read: number; failed: number }[];
  pricing: Record<string, number>;
};

export type WaMonthCost = { month: string; totalCost: number; billableMessages: number; byCategory: { category: string; count: number; amount: number }[] };

/**
 * Biaya pesan WA tertagih satu bulan (`wa_message_costs`) — tanpa otorisasi, untuk modul lain di dalam transaksinya
 * (laporan biaya bulanan M11, NFR-29 / B-67).
 */
export async function waCostForMonth(tx: Tx | Db, tenantId: string, month: string): Promise<WaMonthCost> {
  const costs = await tx
    .select({ category: waMessageCosts.category, count: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${waMessageCosts.costAmount}), 0)::bigint` })
    .from(waMessageCosts)
    .where(and(eq(waMessageCosts.tenantId, tenantId), eq(waMessageCosts.month, month), eq(waMessageCosts.billable, true)))
    .groupBy(waMessageCosts.category)
    .orderBy(asc(waMessageCosts.category));
  const byCategory = costs.map((c) => ({ category: c.category, count: Number(c.count), amount: Number(c.amount) }));
  return { month, totalCost: byCategory.reduce((s, c) => s + c.amount, 0), billableMessages: byCategory.reduce((s, c) => s + c.count, 0), byCategory };
}

/** Ringkasan biaya pesan WA per bulan (NFR-29; US-P2-08 KP-3). */
export async function waCostSummary(ctx: ActorContext, filter: { month?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<WaCostSummary> {
  await authorize(ctx, "p2.wa_cost.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const month = filter.month && /^\d{4}-\d{2}$/.test(filter.month) ? filter.month : monthOf(toBusinessDate(ctx.now));
  const from = `${month}-01`;
  const end = wibToUtc(addDays(lastDayOfMonth(from), 1), "00:00");
  const cost = await waCostForMonth(tx, ctx.tenantId, month);
  const logs = await tx
    .select({ kind: waMessageLogs.kind, status: waMessageLogs.status, n: sql<number>`count(*)::int` })
    .from(waMessageLogs)
    .where(and(eq(waMessageLogs.tenantId, ctx.tenantId), eq(waMessageLogs.provider, "cloud_api"), gte(waMessageLogs.createdAt, wibToUtc(from, "00:00")), lt(waMessageLogs.createdAt, end)))
    .groupBy(waMessageLogs.kind, waMessageLogs.status);
  const kinds = [...new Set(logs.map((l) => l.kind))];
  const pricing = await params.get(tx, "p2.wa_pricing", from, { tenantId: ctx.tenantId });
  const byCategory = cost.byCategory;
  return {
    month,
    providerActive: isAutoWaActive(),
    totalCost: cost.totalCost,
    billableMessages: cost.billableMessages,
    byCategory,
    byKind: kinds.map((k) => {
      const n = (st: string) => logs.filter((l) => l.kind === k && l.status === st).reduce((s, l) => s + Number(l.n), 0);
      return { kind: k, label: label("wa_message_kind", k), sent: n("sent"), delivered: n("delivered"), read: n("read"), failed: n("failed") };
    }),
    pricing: { ...pricing },
  };
}
