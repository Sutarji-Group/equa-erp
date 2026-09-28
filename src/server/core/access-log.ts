/**
 * Log akses (US-M10-05 KP-4; retensi PAR-29 1 tahun): login/logout, login gagal, perangkat, ekspor (BR-39), percobaan
 * tindakan yang ditolak (US-M10-03 KP-2). Terpisah dari jejak audit; append-only (trigger DB menolak UPDATE/DELETE).
 */
import "server-only";

import { and, count, eq, gte, lt } from "drizzle-orm";

import { accessLogs } from "@/db/schema";
import type { AccessEvent } from "@/lib/labels";
import { businessDateToUtcRange, toBusinessDate } from "@/lib/time";

import type { Tx } from "./db";

export type AccessLogInput = {
  tenantId?: string | null;
  userId?: string | null;
  event: AccessEvent;
  success?: boolean;
  usernameAttempted?: string | null;
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  permission?: string | null;
  rule?: string | null;
  reason?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  details?: Record<string, unknown> | null;
  occurredAt?: Date;
};

export type AccessLogRow = typeof accessLogs.$inferSelect;

/** Catat satu kejadian akses. */
export async function logAccess(tx: Tx, input: AccessLogInput): Promise<AccessLogRow> {
  const [row] = await tx
    .insert(accessLogs)
    .values({
      tenantId: input.tenantId ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      event: input.event,
      success: input.success ?? true,
      userId: input.userId ?? null,
      usernameAttempted: input.usernameAttempted ?? null,
      deviceId: input.deviceId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      permission: input.permission ?? null,
      rule: input.rule ?? null,
      reason: input.reason ?? null,
      objectType: input.objectType ?? null,
      objectId: input.objectId ?? null,
      details: input.details ?? null,
    })
    .returning();
  return row!;
}

/** Jumlah kejadian `event` oleh pengguna pada tanggal bisnis WIB dari `now`. */
export async function countUserEventsOnDay(tx: Tx, userId: string, event: AccessEvent, now: Date): Promise<number> {
  const { start, end } = businessDateToUtcRange(toBusinessDate(now));
  const rows = await tx
    .select({ n: count() })
    .from(accessLogs)
    .where(
      and(eq(accessLogs.userId, userId), eq(accessLogs.event, event), gte(accessLogs.occurredAt, start), lt(accessLogs.occurredAt, end)),
    );
  return Number(rows[0]?.n ?? 0);
}
