/**
 * M8 — pembacaan meter (US-M8-01) & penyesuaian meter (putaran/penggantian, KP-2, 7.8.6).
 *
 * - Operator (lapangan, offline): angka + foto meter (kamera aplikasi, ≤ PAR-38) + waktu perangkat, pagi (awal) dan malam
 *   (akhir) per meter. Angka lebih kecil dari pembacaan sebelumnya DITOLAK dengan pesan (kecuali putaran tercatat admin);
 *   pembacaan setelah jam batas (m8.production_rules) wajib beralasan (KP-3). Pembacaan tersinkron TIDAK dapat diubah
 *   operator (SOD-05) — koreksi oleh Admin Keuangan dengan alasan + foto pembanding (KP-5, BR-38): baris baru, baris
 *   lama `superseded_by_id` (tidak dihapus).
 * - Admin sistem / Admin Keuangan (`m1.water_meter.update`): putaran meter (angka kembali ke nol) atau penggantian meter
 *   (meter lama ditutup + meter baru dengan angka awal; produksi hari itu diestimasi) — wajib alasan.
 * - Admin Keuangan (`m8.meter_reading.verify`): verifikasi produksi yang menyimpang > PAR-68 (KP-4).
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { attachments, dailyProductions, meterAdjustments, meterReadings, waterMeters, waterSources } from "@/db/schema";
import { isBusinessDate, type BusinessDate } from "@/lib/time";

import { isLateReading, M8_ATTACHMENT_KINDS, meterReadingProblem, PHASE_LABEL } from "@/client/m8-production/contract";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { assertSourceScope, authorize, authorizeAny, runService, sod } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { attachmentOfKind, loadSource, m8Rules, resolveOperatorSource, type M8FieldMeta } from "./common";
import { refreshAfterReading, refreshSourceDay } from "./balance";
import { nextReading, previousReading, type MeterReadingRow, type WaterMeterRow } from "./production";

export type MeterAdjustmentRow = typeof meterAdjustments.$inferSelect;

/** Batas atas angka meter (liter) — di atas ini hampir pasti salah ketik. */
const MAX_READING_L = 1_000_000_000_000;

export const meterReadingSchema = z
  .object({
    readingId: z.uuid({ error: "ID pembacaan tidak valid." }),
    waterMeterId: z.uuid({ error: "Pilih meter." }),
    phase: z.enum(["morning", "evening"], { error: "Pilih pembacaan pagi atau malam." }),
    readingL: z.number({ error: "Angka meter wajib diisi." }).int({ error: "Angka meter harus liter bulat." }).min(0).max(MAX_READING_L),
    lateReason: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export type RecordReadingResult = { reading: MeterReadingRow; duplicate: boolean };

async function loadMeter(tx: Tx, meterId: string): Promise<WaterMeterRow> {
  const rows = await tx.select().from(waterMeters).where(eq(waterMeters.id, meterId)).limit(1);
  if (!rows[0]) throw new NotFoundError("Meter tidak ditemukan.");
  return rows[0];
}

/** Putaran meter tercatat admin yang belum dipakai pembacaan (berlaku sejak tanggalnya). */
export async function pendingRollover(tx: Tx, meterId: string, date: BusinessDate): Promise<MeterAdjustmentRow | null> {
  const rows = await tx
    .select()
    .from(meterAdjustments)
    .where(and(eq(meterAdjustments.waterMeterId, meterId), eq(meterAdjustments.kind, "rollover"), isNull(meterAdjustments.appliedReadingId)))
    .orderBy(desc(meterAdjustments.createdAt))
    .limit(1);
  const r = rows[0];
  return r && r.businessDate <= date ? r : null;
}

/**
 * Handler perintah `m8.meter_reading.create` (US-M8-01 KP-1/KP-2/KP-3/KP-5, US-M8-07). Idempoten per `readingId`.
 */
export async function recordMeterReading(ctx: ActorContext, input: z.output<typeof meterReadingSchema>, meta: M8FieldMeta): Promise<RecordReadingResult> {
  const { tx } = meta;
  await authorize(ctx, "m8.meter_reading.create", { tx, objectType: "water_meter", objectId: input.waterMeterId });
  const source = await resolveOperatorSource(tx, ctx, meta.device);
  const meter = await loadMeter(tx, input.waterMeterId);
  if (meter.waterSourceId !== source.id) throw new NotFoundError("Meter ini bukan milik sumber air perangkat Anda.");

  const date = meta.businessDate;
  // Idempoten: ID pembacaan yang sama (perintah dikirim ulang / diikat ulang) → hasil yang sama; isi berbeda = mengubah.
  const [same] = await tx.select().from(meterReadings).where(eq(meterReadings.id, input.readingId)).limit(1);
  if (same) {
    if (same.waterMeterId === input.waterMeterId && same.phase === input.phase && same.readingL === input.readingL && same.businessDate === date) {
      return { reading: same, duplicate: true };
    }
    sod.assertNotLocked(true, { what: "Pembacaan meter", objectType: "meter_reading", objectId: same.id });
  }
  const [live] = await tx
    .select()
    .from(meterReadings)
    .where(and(eq(meterReadings.waterMeterId, meter.id), eq(meterReadings.businessDate, date), eq(meterReadings.phase, input.phase), isNull(meterReadings.supersededById)))
    .limit(1);
  if (live) {
    // KP-5: tidak dapat diubah setelah tersinkron — koreksi hanya Admin Keuangan (SOD-05).
    sod.assertNotLocked(true, {
      what: `Pembacaan ${PHASE_LABEL[input.phase].toLowerCase()} meter ${meter.code} hari ini (${live.readingL.toLocaleString("id-ID")} L)`,
      objectType: "meter_reading",
      objectId: live.id,
    });
  }
  if (meter.status !== "active") {
    throw new DomainError("METER_INACTIVE", `Meter ${meter.code} sudah ${meter.status === "replaced" ? "diganti" : "nonaktif"}. Catat angka pada meter yang aktif.`);
  }

  const photo = attachmentOfKind(meta, M8_ATTACHMENT_KINDS.meterPhoto);
  if (!photo) throw new DomainError("METER_PHOTO_REQUIRED", "Foto meter wajib diambil dari kamera aplikasi sebelum menyimpan angka.");

  const rules = await m8Rules(tx, date, source.tenantId);
  const lateReason = input.lateReason?.trim() || null;
  const late = isLateReading(input.phase, meta.deviceTime, rules);
  if (late && (!lateReason || lateReason.length < 3)) {
    const deadline = input.phase === "morning" ? rules.morningDeadline : rules.eveningDeadline;
    throw new DomainError("READING_LATE_REASON_REQUIRED", `Pembacaan ${PHASE_LABEL[input.phase].toLowerCase()} dicatat setelah ${deadline.replace(":", ".")} — isi alasan keterlambatan.`);
  }

  // KP-2: tidak boleh lebih kecil dari pembacaan sebelumnya (kecuali putaran tercatat); pagi ≤ malam yang sudah ada.
  const prev = await previousReading(tx, meter.id, date, input.phase);
  const next = input.phase === "morning" ? await nextReading(tx, meter.id, date, "morning") : null;
  const rollover = await pendingRollover(tx, meter.id, date);
  const previousL = prev?.readingL ?? meter.initialReadingL;
  const problem = meterReadingProblem({
    value: input.readingL,
    previousL,
    nextL: next && next.businessDate === date ? next.readingL : null,
    rolloverPending: !!rollover,
    meterCode: meter.code,
  });
  if (problem) throw new DomainError("METER_READING_INVALID", problem);
  const usesRollover = !!rollover && input.readingL < previousL;

  const [reading] = await tx
    .insert(meterReadings)
    .values({
      id: input.readingId,
      tenantId: source.tenantId,
      waterSourceId: source.id,
      waterMeterId: meter.id,
      businessDate: date,
      phase: input.phase,
      readingL: input.readingL,
      photoAttachmentId: photo.id,
      readAt: meta.deviceTime,
      recordedBy: ctx.userId,
      status: "recorded",
      lateReason: late ? lateReason : null,
      adjustmentKind: usesRollover ? "rollover" : null,
      adjustmentReason: usesRollover ? rollover!.reason : null,
      adjustmentId: usesRollover ? rollover!.id : null,
      ...meta.fieldValues,
      createdBy: ctx.userId,
    })
    .returning();
  if (usesRollover) await tx.update(meterAdjustments).set({ appliedReadingId: reading!.id }).where(eq(meterAdjustments.id, rollover!.id));
  await linkAttachment(tx, photo.id, { type: "meter_reading", id: reading!.id });
  await auditRecord(tx, {
    ctx,
    objectType: "meter_reading",
    objectId: reading!.id,
    action: "create",
    after: { meter: meter.code, phase: input.phase, readingL: input.readingL, readAt: meta.deviceTime.toISOString(), lateReason: reading!.lateReason, rollover: usesRollover },
    reason: reading!.lateReason,
    businessDate: date,
  });
  await emit(
    tx,
    "meter.reading_recorded",
    {
      meterReadingId: reading!.id,
      waterSourceId: source.id,
      meterId: meter.id,
      phase: input.phase,
      readingL: input.readingL,
      businessDate: date,
      readAt: meta.deviceTime.toISOString(),
      adjustmentKind: usesRollover ? "rollover" : null,
      lateReason: reading!.lateReason,
      photoAttachmentId: photo.id,
      deviceId: meta.device.id,
      lateSync: meta.lateSync,
    },
    { ctx, objectType: "meter_reading", objectId: reading!.id, businessDate: date },
  );
  await refreshAfterReading(tx, ctx, source.id, date, input.phase);
  return { reading: reading!, duplicate: false };
}

// =====================================================================================================================
// Koreksi pembacaan (Admin Keuangan, KP-5, BR-38)
// =====================================================================================================================

const correctSchema = z
  .object({
    readingId: z.uuid(),
    readingL: z.number({ error: "Angka koreksi wajib diisi." }).int({ error: "Angka meter harus liter bulat." }).min(0).max(MAX_READING_L),
    reason: z.string().trim().min(5, { error: "Alasan koreksi wajib diisi (minimal 5 huruf)." }).max(300),
    /** Foto pembanding (KP-5) — lampiran yang sudah diunggah Admin Keuangan. */
    photoAttachmentId: z.uuid({ error: "Foto pembanding wajib dilampirkan." }),
  })
  .strict();

export type CorrectReadingInput = z.input<typeof correctSchema>;

/**
 * Admin Keuangan mengoreksi pembacaan meter dengan alasan + foto pembanding: baris baru (angka koreksi) menggantikan
 * baris lama (`superseded_by_id`, status "Dikoreksi"); produksi & neraca dihitung ulang. Pencatat asli tidak dapat
 * mengoreksi pembacaannya sendiri (SOD-01).
 */
export async function correctMeterReading(ctx: ActorContext, input: CorrectReadingInput, opts: { tx?: Tx } = {}): Promise<MeterReadingRow> {
  await authorize(ctx, "m8.meter_reading.correct", { tx: opts.tx, objectType: "meter_reading", objectId: input.readingId });
  const data = parseInput(correctSchema, input, { readingL: "Angka koreksi", reason: "Alasan", photoAttachmentId: "Foto pembanding" });
  return runService(ctx, opts, async (tx) => {
    const [old] = await tx.select().from(meterReadings).where(eq(meterReadings.id, data.readingId)).for("update").limit(1);
    if (!old || old.tenantId !== ctx.tenantId) throw new NotFoundError("Pembacaan meter tidak ditemukan.");
    await assertSourceScope(tx, ctx, old.waterSourceId);
    if (old.supersededById) throw new DomainError("READING_ALREADY_CORRECTED", "Pembacaan ini sudah dikoreksi. Koreksi pembacaan pengganti yang berlaku.");
    sod.assertNotSelf(old.recordedBy, ctx.userId, "pembacaan meter", { objectType: "meter_reading", objectId: old.id });
    if (data.readingL === old.readingL) throw new DomainError("NO_CHANGE", "Angka koreksi sama dengan angka tercatat.");
    const [att] = await tx.select().from(attachments).where(eq(attachments.id, data.photoAttachmentId)).limit(1);
    if (!att || att.tenantId !== ctx.tenantId || !att.contentType.startsWith("image/")) {
      throw ValidationError.field("photoAttachmentId", "Foto pembanding tidak ditemukan atau bukan gambar. Unggah ulang fotonya.");
    }
    // Batas angka tetap berlaku untuk koreksi (kecuali putaran yang dipakai pembacaan asal).
    const prev = await previousReading(tx, old.waterMeterId, old.businessDate, old.phase);
    const meter = await loadMeter(tx, old.waterMeterId);
    const next = await nextReading(tx, old.waterMeterId, old.businessDate, old.phase);
    const problem = meterReadingProblem({
      value: data.readingL,
      previousL: prev?.readingL ?? meter.initialReadingL,
      nextL: next ? (next.adjustmentKind === "rollover" ? null : next.readingL) : null,
      rolloverPending: old.adjustmentKind === "rollover",
      meterCode: meter.code,
    });
    if (problem) throw new DomainError("METER_READING_INVALID", problem.replace("Angka pagi", "Angka koreksi"));

    // Keluarkan baris lama dari indeks unik (meter, tanggal, fase) sebelum baris pengganti disisipkan (FK ke diri sendiri).
    await tx.update(meterReadings).set({ supersededById: old.id }).where(eq(meterReadings.id, old.id));
    const [fix] = await tx
      .insert(meterReadings)
      .values({
        tenantId: old.tenantId,
        waterSourceId: old.waterSourceId,
        waterMeterId: old.waterMeterId,
        businessDate: old.businessDate,
        phase: old.phase,
        readingL: data.readingL,
        photoAttachmentId: att.id,
        readAt: old.readAt,
        recordedBy: ctx.userId,
        status: "verified",
        verifiedBy: ctx.userId,
        verifiedAt: ctx.now,
        correctionReason: data.reason,
        anomalyNote: `Koreksi Admin Keuangan atas ${old.readingL.toLocaleString("id-ID")} L.`,
        lateReason: old.lateReason,
        adjustmentKind: old.adjustmentKind,
        adjustmentReason: old.adjustmentReason,
        adjustmentId: old.adjustmentId,
        deviceTime: old.deviceTime,
        createdBy: ctx.userId,
      })
      .returning();
    await tx.update(meterReadings).set({ supersededById: fix!.id, status: "superseded", correctionReason: data.reason }).where(eq(meterReadings.id, old.id));
    await linkAttachment(tx, att.id, { type: "meter_reading", id: fix!.id });
    await auditRecord(tx, {
      ctx,
      objectType: "meter_reading",
      objectId: old.id,
      action: "correct",
      before: { readingL: old.readingL, status: old.status },
      after: { readingL: data.readingL, supersededById: fix!.id },
      reason: data.reason,
      rule: "US-M8-01 KP-5, BR-38",
      businessDate: old.businessDate,
    });
    await emit(
      tx,
      "meter.reading_recorded",
      {
        meterReadingId: fix!.id,
        waterSourceId: old.waterSourceId,
        meterId: old.waterMeterId,
        phase: old.phase,
        readingL: data.readingL,
        businessDate: old.businessDate,
        readAt: old.readAt.toISOString(),
        correctionOfId: old.id,
        correctionReason: data.reason,
        adjustmentKind: old.adjustmentKind,
        photoAttachmentId: att.id,
      },
      { ctx, objectType: "meter_reading", objectId: fix!.id, businessDate: old.businessDate },
    );
    await refreshAfterReading(tx, ctx, old.waterSourceId, old.businessDate, old.phase);
    return fix!;
  });
}

// =====================================================================================================================
// Putaran & penggantian meter (admin sistem / Admin Keuangan, KP-2, 7.8.6)
// =====================================================================================================================

const rolloverSchema = z
  .object({
    meterId: z.uuid(),
    /** Angka meter saat kembali ke nol (mis. 100.000.000 L untuk meter 5 digit m³). */
    rolloverAtL: z.number({ error: "Angka putaran wajib diisi." }).int().min(1).max(MAX_READING_L),
    businessDate: z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).nullable().optional(),
    reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 huruf)." }).max(300),
    photoAttachmentId: z.uuid().nullable().optional(),
  })
  .strict();

export type RecordRolloverInput = z.input<typeof rolloverSchema>;

/** Putaran meter: pembacaan pertama sesudahnya boleh lebih kecil; produksi = (angka putaran − sebelumnya) + angka baru. */
export async function recordMeterRollover(ctx: ActorContext, input: RecordRolloverInput, opts: { tx?: Tx } = {}): Promise<MeterAdjustmentRow> {
  await authorize(ctx, "m1.water_meter.update", { tx: opts.tx, objectType: "water_meter", objectId: input.meterId });
  const data = parseInput(rolloverSchema, input, { rolloverAtL: "Angka putaran", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const meter = await loadMeter(tx, data.meterId);
    const source = await loadSource(tx, meter.waterSourceId);
    if (source.tenantId !== ctx.tenantId) throw new NotFoundError("Meter tidak ditemukan.");
    if (meter.status !== "active") throw new DomainError("METER_INACTIVE", "Meter ini sudah diganti/nonaktif.");
    const date = data.businessDate ?? ctxBusinessDate(ctx);
    const pending = await pendingRollover(tx, meter.id, "9999-12-31");
    if (pending) throw new DomainError("ROLLOVER_PENDING", "Putaran meter ini sudah dicatat dan menunggu pembacaan berikutnya.");
    const [last] = await tx
      .select()
      .from(meterReadings)
      .where(and(eq(meterReadings.waterMeterId, meter.id), isNull(meterReadings.supersededById)))
      .orderBy(desc(meterReadings.businessDate), desc(meterReadings.phase))
      .limit(1);
    if (last && data.rolloverAtL <= last.readingL) {
      throw new DomainError("ROLLOVER_BELOW_LAST", `Angka putaran harus lebih besar dari pembacaan terakhir (${last.readingL.toLocaleString("id-ID")} L).`);
    }
    const [row] = await tx
      .insert(meterAdjustments)
      .values({
        tenantId: source.tenantId,
        waterSourceId: source.id,
        waterMeterId: meter.id,
        kind: "rollover",
        businessDate: date,
        occurredAt: ctx.now,
        previousReadingId: last?.id ?? null,
        previousReadingL: last?.readingL ?? meter.initialReadingL,
        rolloverAtL: data.rolloverAtL,
        reason: data.reason,
        photoAttachmentId: data.photoAttachmentId ?? null,
        recordedBy: ctx.userId,
        createdBy: ctx.userId,
      })
      .returning();
    if (data.photoAttachmentId) await linkAttachment(tx, data.photoAttachmentId, { type: "meter_adjustment", id: row!.id });
    await auditRecord(tx, {
      ctx,
      objectType: "meter_adjustment",
      objectId: row!.id,
      action: "create",
      after: { kind: "rollover", meter: meter.code, rolloverAtL: data.rolloverAtL, businessDate: date },
      reason: data.reason,
      rule: "US-M8-01 KP-2",
      businessDate: date,
    });
    return row!;
  });
}

const replacementSchema = z
  .object({
    meterId: z.uuid(),
    finalReadingL: z.number({ error: "Angka akhir meter lama wajib diisi." }).int().min(0).max(MAX_READING_L),
    newMeterCode: z.string().trim().min(2, { error: "Pengenal meter baru wajib diisi." }).max(30),
    newMeterName: z.string().trim().max(120).nullable().optional(),
    newInitialReadingL: z.number({ error: "Angka awal meter baru wajib diisi." }).int().min(0).max(MAX_READING_L),
    businessDate: z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).nullable().optional(),
    reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 huruf)." }).max(300),
    photoAttachmentId: z.uuid().nullable().optional(),
  })
  .strict();

export type RecordReplacementInput = z.input<typeof replacementSchema>;

/**
 * Penggantian meter (7.8.6): meter lama ditutup (status Diganti + angka akhir), meter baru dengan angka awal; produksi
 * hari penggantian diestimasi dari rata-rata PAR-68 hari dan ditandai "Estimasi".
 */
export async function recordMeterReplacement(ctx: ActorContext, input: RecordReplacementInput, opts: { tx?: Tx } = {}): Promise<{ adjustment: MeterAdjustmentRow; newMeter: WaterMeterRow }> {
  await authorize(ctx, "m1.water_meter.update", { tx: opts.tx, objectType: "water_meter", objectId: input.meterId });
  const data = parseInput(replacementSchema, input, { finalReadingL: "Angka akhir meter lama", newMeterCode: "Pengenal meter baru", newInitialReadingL: "Angka awal meter baru", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const meter = await loadMeter(tx, data.meterId);
    const source = await loadSource(tx, meter.waterSourceId);
    if (source.tenantId !== ctx.tenantId) throw new NotFoundError("Meter tidak ditemukan.");
    if (meter.status !== "active") throw new DomainError("METER_INACTIVE", "Meter ini sudah diganti/nonaktif.");
    const dup = await tx.select({ id: waterMeters.id }).from(waterMeters).where(eq(waterMeters.code, data.newMeterCode)).limit(1);
    if (dup[0]) throw new DomainError("METER_DUPLICATE", `Pengenal meter ${data.newMeterCode} sudah dipakai.`);
    const date = data.businessDate ?? ctxBusinessDate(ctx);
    const [last] = await tx
      .select()
      .from(meterReadings)
      .where(and(eq(meterReadings.waterMeterId, meter.id), isNull(meterReadings.supersededById)))
      .orderBy(desc(meterReadings.businessDate), desc(meterReadings.phase))
      .limit(1);
    const [newMeter] = await tx
      .insert(waterMeters)
      .values({
        waterSourceId: source.id,
        code: data.newMeterCode,
        name: data.newMeterName ?? null,
        unit: meter.unit,
        initialReadingL: data.newInitialReadingL,
        installedAt: date,
        initialPhotoAttachmentId: data.photoAttachmentId ?? null,
        notes: `Pengganti ${meter.code}: ${data.reason}`,
        createdBy: ctx.userId,
      })
      .returning();
    await tx
      .update(waterMeters)
      .set({ status: "replaced", replacedByMeterId: newMeter!.id, replacedAt: ctx.now, finalReadingL: data.finalReadingL })
      .where(eq(waterMeters.id, meter.id));
    const [adj] = await tx
      .insert(meterAdjustments)
      .values({
        tenantId: source.tenantId,
        waterSourceId: source.id,
        waterMeterId: meter.id,
        kind: "replacement",
        businessDate: date,
        occurredAt: ctx.now,
        previousReadingId: last?.id ?? null,
        previousReadingL: last?.readingL ?? meter.initialReadingL,
        finalReadingL: data.finalReadingL,
        newMeterId: newMeter!.id,
        newInitialReadingL: data.newInitialReadingL,
        reason: data.reason,
        photoAttachmentId: data.photoAttachmentId ?? null,
        recordedBy: ctx.userId,
        createdBy: ctx.userId,
      })
      .returning();
    if (data.photoAttachmentId) await linkAttachment(tx, data.photoAttachmentId, { type: "meter_adjustment", id: adj!.id });
    await auditRecord(tx, {
      ctx,
      objectType: "water_meter",
      objectId: meter.id,
      action: "replace",
      before: { status: meter.status },
      after: { status: "replaced", finalReadingL: data.finalReadingL, replacedBy: newMeter!.code, newInitialReadingL: data.newInitialReadingL },
      reason: data.reason,
      rule: "US-M8-01 KP-2, 7.8.6",
      businessDate: date,
    });
    await auditRecord(tx, { ctx, objectType: "water_meter", objectId: newMeter!.id, action: "create", after: newMeter, reason: data.reason, businessDate: date });
    if (date <= ctxBusinessDate(ctx)) await refreshSourceDay(tx, ctx, source.id, date);
    return { adjustment: adj!, newMeter: newMeter! };
  });
}

// =====================================================================================================================
// Verifikasi produksi menyimpang (Admin Keuangan, KP-4)
// =====================================================================================================================

const verifyProductionSchema = z
  .object({
    productionId: z.uuid(),
    note: z.string().trim().min(5, { error: "Tulis hasil pembandingan foto meter (minimal 5 huruf)." }).max(500),
  })
  .strict();

/** Admin Keuangan memverifikasi produksi bertanda (foto meter dibandingkan) → penanda dilepas, pembacaan Diverifikasi. */
export async function verifyProduction(ctx: ActorContext, input: z.input<typeof verifyProductionSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m8.meter_reading.verify", { tx: opts.tx, objectType: "daily_production", objectId: input.productionId });
  const data = parseInput(verifyProductionSchema, input, { note: "Hasil verifikasi" });
  return runService(ctx, opts, async (tx) => {
    const [row] = await tx.select().from(dailyProductions).where(eq(dailyProductions.id, data.productionId)).for("update").limit(1);
    if (!row || row.tenantId !== ctx.tenantId) throw new NotFoundError("Produksi harian tidak ditemukan.");
    await assertSourceScope(tx, ctx, row.waterSourceId);
    if (!row.flaggedForVerification) throw new DomainError("PRODUCTION_NOT_FLAGGED", "Produksi ini tidak bertanda verifikasi.");
    const [after] = await tx
      .update(dailyProductions)
      .set({ flaggedForVerification: false, verifiedBy: ctx.userId, verifiedAt: ctx.now })
      .where(eq(dailyProductions.id, row.id))
      .returning();
    await tx
      .update(meterReadings)
      .set({ status: "verified", verifiedBy: ctx.userId, verifiedAt: ctx.now })
      .where(and(eq(meterReadings.waterSourceId, row.waterSourceId), eq(meterReadings.status, "flagged"), eq(meterReadings.businessDate, row.businessDate)));
    await auditRecord(tx, {
      ctx,
      objectType: "daily_production",
      objectId: row.id,
      action: "verify",
      before: { flaggedForVerification: true, deviationPct: row.deviationPct },
      after: { flaggedForVerification: false },
      reason: data.note,
      rule: "US-M8-01 KP-4, PAR-68",
      businessDate: row.businessDate,
    });
    return after!;
  });
}

// =====================================================================================================================
// Kueri meter (kantor)
// =====================================================================================================================

export type MeterOverviewRow = WaterMeterRow & {
  sourceCode: string;
  sourceName: string;
  lastReading: MeterReadingRow | null;
  pendingRollover: MeterAdjustmentRow | null;
  adjustments: MeterAdjustmentRow[];
};

/** Meter per sumber + pembacaan terakhir + riwayat putaran/penggantian (`/produksi/kelola-meter`). */
export async function listMetersOverview(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<MeterOverviewRow[]> {
  await authorizeAny(ctx, ["m8.production.read", "m1.water_meter.update"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const sources = await tx.select().from(waterSources).where(eq(waterSources.tenantId, ctx.tenantId)).orderBy(asc(waterSources.code));
  if (sources.length === 0) return [];
  const meters = await tx
    .select()
    .from(waterMeters)
    .where(
      inArray(
        waterMeters.waterSourceId,
        sources.map((s) => s.id),
      ),
    )
    .orderBy(asc(waterMeters.code));
  const adjustments = meters.length
    ? await tx
        .select()
        .from(meterAdjustments)
        .where(
          inArray(
            meterAdjustments.waterMeterId,
            meters.map((m) => m.id),
          ),
        )
        .orderBy(desc(meterAdjustments.createdAt))
    : [];
  const out: MeterOverviewRow[] = [];
  for (const m of meters) {
    const s = sources.find((x) => x.id === m.waterSourceId)!;
    const [last] = await tx
      .select()
      .from(meterReadings)
      .where(and(eq(meterReadings.waterMeterId, m.id), isNull(meterReadings.supersededById)))
      .orderBy(desc(meterReadings.businessDate), desc(meterReadings.phase))
      .limit(1);
    const adj = adjustments.filter((a) => a.waterMeterId === m.id);
    out.push({
      ...m,
      sourceCode: s.code,
      sourceName: s.name,
      lastReading: last ?? null,
      pendingRollover: adj.find((a) => a.kind === "rollover" && !a.appliedReadingId) ?? null,
      adjustments: adj,
    });
  }
  return out;
}
