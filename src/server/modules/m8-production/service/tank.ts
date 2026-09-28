/**
 * M8 — level tandon opsional (US-M8-04 KP-3, PTB-41): informasi tambahan untuk menjelaskan pergeseran stok antar hari.
 * Peringatan susut BR-26 tetap memakai angka harian (level tandon tidak mengubah susut).
 */
import "server-only";

import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import { tankLevelReadings } from "@/db/schema";
import type { BusinessDate } from "@/lib/time";

import { M8_ATTACHMENT_KINDS } from "@/client/m8-production/contract";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { authorize, sod } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { attachmentOfKind, resolveOperatorSource, type M8FieldMeta } from "./common";

export type TankLevelRow = typeof tankLevelReadings.$inferSelect;

export const tankLevelSchema = z
  .object({
    tankLevelId: z.uuid({ error: "ID catatan level tandon tidak valid." }),
    levelL: z.number().int({ error: "Level tandon dalam liter bulat." }).min(0).max(100_000_000).nullable().optional(),
    levelPct: z.number().min(0, { error: "Persen minimal 0." }).max(100, { error: "Persen maksimal 100." }).nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((v) => (v.levelL !== null && v.levelL !== undefined) || (v.levelPct !== null && v.levelPct !== undefined), {
    error: "Isi level tandon dalam liter atau persen.",
    path: ["levelL"],
  });

/** Handler perintah `m8.tank_level.create` (idempoten per `tankLevelId`). */
export async function recordTankLevel(ctx: ActorContext, input: z.output<typeof tankLevelSchema>, meta: M8FieldMeta): Promise<{ row: TankLevelRow; duplicate: boolean }> {
  const { tx } = meta;
  await authorize(ctx, "m8.tank_level.create", { tx });
  const source = await resolveOperatorSource(tx, ctx, meta.device);
  const [same] = await tx.select().from(tankLevelReadings).where(eq(tankLevelReadings.id, input.tankLevelId)).limit(1);
  if (same) {
    if (same.levelL === (input.levelL ?? null) && same.levelPct === (input.levelPct ?? null)) return { row: same, duplicate: true };
    sod.assertNotLocked(true, { what: "Catatan level tandon", objectType: "tank_level_reading", objectId: same.id });
  }
  const photo = attachmentOfKind(meta, M8_ATTACHMENT_KINDS.tankPhoto);
  const [row] = await tx
    .insert(tankLevelReadings)
    .values({
      id: input.tankLevelId,
      tenantId: source.tenantId,
      waterSourceId: source.id,
      businessDate: meta.businessDate,
      levelL: input.levelL ?? null,
      levelPct: input.levelPct ?? null,
      readAt: meta.deviceTime,
      recordedBy: ctx.userId,
      photoAttachmentId: photo?.id ?? null,
      notes: input.notes?.trim() || null,
      ...meta.fieldValues,
    })
    .returning();
  if (photo) await linkAttachment(tx, photo.id, { type: "tank_level_reading", id: row!.id });
  await auditRecord(tx, {
    ctx,
    objectType: "tank_level_reading",
    objectId: row!.id,
    action: "create",
    after: { levelL: row!.levelL, levelPct: row!.levelPct, notes: row!.notes },
    rule: "US-M8-04 KP-3, PTB-41",
    businessDate: meta.businessDate,
  });
  return { row: row!, duplicate: false };
}

/** Level tandon satu sumber pada rentang tanggal (terbaru dulu). */
export async function tankLevelsInRange(tx: Tx, sourceId: string, from: BusinessDate, to: BusinessDate): Promise<TankLevelRow[]> {
  return tx
    .select()
    .from(tankLevelReadings)
    .where(and(eq(tankLevelReadings.waterSourceId, sourceId), gte(tankLevelReadings.businessDate, from), lte(tankLevelReadings.businessDate, to)))
    .orderBy(desc(tankLevelReadings.readAt));
}
