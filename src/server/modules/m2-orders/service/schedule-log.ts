/**
 * M2 — jadwal harian per truk (Draf/Terbit) & log perubahan (US-M2-03 KP-5).
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { dailySchedules, scheduleChangeLogs } from "@/db/schema";
import type { EnumValue } from "@/lib/labels";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";

export type ScheduleRow = typeof dailySchedules.$inferSelect;

/** Jadwal harian truk (dibuat Draf bila belum ada). */
export async function ensureSchedule(tx: Tx, ctx: ActorContext, input: { tenantId: string; truckId: string; date: string }): Promise<ScheduleRow> {
  const existing = await tx
    .select()
    .from(dailySchedules)
    .where(and(eq(dailySchedules.truckId, input.truckId), eq(dailySchedules.businessDate, input.date)))
    .limit(1);
  if (existing[0]) return existing[0];
  const [row] = await tx
    .insert(dailySchedules)
    .values({ tenantId: input.tenantId, truckId: input.truckId, businessDate: input.date, status: "draft", createdBy: ctx.userId })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const again = await tx
    .select()
    .from(dailySchedules)
    .where(and(eq(dailySchedules.truckId, input.truckId), eq(dailySchedules.businessDate, input.date)))
    .limit(1);
  return again[0]!;
}

/** Tandai jadwal berubah (perubahan setelah terbit menunggu "Terbitkan" ulang). */
export async function markScheduleChanged(tx: Tx, ctx: ActorContext, scheduleId: string): Promise<void> {
  await tx.update(dailySchedules).set({ lastChangedAt: ctx.now, updatedAt: ctx.now }).where(eq(dailySchedules.id, scheduleId));
}

/** Catat perubahan jadwal (tambah/geser/tarik/urutan/pindah truk) — `afterPublish` bila jadwal sudah terbit. */
export async function logScheduleChange(
  tx: Tx,
  ctx: ActorContext,
  input: {
    tenantId: string;
    scheduleId: string | null;
    tripId: string;
    changeType: EnumValue<"schedule_change_type">;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reason?: string | null;
    afterPublish: boolean;
  },
): Promise<void> {
  await tx.insert(scheduleChangeLogs).values({
    tenantId: input.tenantId,
    scheduleId: input.scheduleId,
    tripId: input.tripId,
    changeType: input.changeType,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    afterPublish: input.afterPublish,
    changedBy: ctx.userId,
    changedAt: ctx.now,
  });
  if (input.scheduleId) await markScheduleChanged(tx, ctx, input.scheduleId);
}
