/**
 * M8 — catatan mutu air (US-M8-06; FR-M8-05, BRD 9.5, 9.9, EP-3-05).
 *
 * - Jadwal uji per lokasi (sumber air, depot) dengan frekuensi yang ditetapkan pemilik/konsultan (PAR-70; tanpa bawaan
 *   BRD → wajib diisi bila PAR-70 belum ditetapkan). Pengingat H-N (m8.production_rules, bawaan H-7) ke pemilik &
 *   operator lokasi itu.
 * - Hasil uji: tanggal, laboratorium, parameter & nilai, lulus/tidak, lampiran foto/PDF sertifikat (wajib). Tidak lulus →
 *   tindakan WAJIB (deskripsi, penanggung jawab, tenggat) + notifikasi pemilik. Jadwal berikutnya = tanggal uji + frekuensi.
 * - Riwayat per lokasi untuk audit & prospektus kemitraan (Bab 9). Daftar periksa mutu harian depot = Tahap 3 (tidak dibangun).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";

import { attachments, employees, outlets, qualityTests, qualityTestSchedules, userRoles, users, userScopes, waterSources } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addDays, isBusinessDate, toBusinessDate, type BusinessDate } from "@/lib/time";

import { M8_ATTACHMENT_KINDS } from "@/client/m8-production/contract";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, authorizeAny, inOutletScope, inSourceScope, runService } from "@/server/core/rbac";
import type { AttachmentRow } from "@/server/core/storage";
import { linkAttachment } from "@/server/core/storage";

import { attachmentOfKind, m8Rules, notifyOnce, resolveOperatorSource, type M8FieldMeta } from "./common";

export type QualityScheduleRow = typeof qualityTestSchedules.$inferSelect;
export type QualityTestRow = typeof qualityTests.$inferSelect;

const dateField = (label: string) => z.string().refine(isBusinessDate, { error: `${label} harus berformat YYYY-MM-DD.` });

// =====================================================================================================================
// Jadwal uji (pemilik, KP-1)
// =====================================================================================================================

const scheduleSchema = z
  .object({
    scheduleId: z.uuid().nullable().optional(),
    locationType: z.enum(["water_source", "outlet"], { error: "Pilih jenis lokasi (sumber air / depot)." }),
    waterSourceId: z.uuid().nullable().optional(),
    outletId: z.uuid().nullable().optional(),
    frequencyDays: z.number().int({ error: "Frekuensi dalam hari bulat." }).min(1).max(730).nullable().optional(),
    nextDueDate: dateField("Tanggal uji berikutnya"),
    laboratory: z.string().trim().max(120).nullable().optional(),
    parameters: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
  })
  .strict();

export type QualityScheduleInput = z.input<typeof scheduleSchema>;

async function resolveLocation(tx: Tx, ctx: ActorContext, input: { locationType: "water_source" | "outlet"; waterSourceId?: string | null; outletId?: string | null }) {
  if (input.locationType === "water_source") {
    if (!input.waterSourceId) throw ValidationError.field("waterSourceId", "Pilih sumber air.");
    const [s] = await tx.select().from(waterSources).where(eq(waterSources.id, input.waterSourceId)).limit(1);
    if (!s || s.tenantId !== ctx.tenantId) throw new NotFoundError("Sumber air tidak ditemukan.");
    return { waterSourceId: s.id, outletId: null, name: s.name };
  }
  if (!input.outletId) throw ValidationError.field("outletId", "Pilih depot.");
  const [o] = await tx.select().from(outlets).where(eq(outlets.id, input.outletId)).limit(1);
  if (!o || o.tenantId !== ctx.tenantId) throw new NotFoundError("Depot tidak ditemukan.");
  if (o.kind !== "depot") throw ValidationError.field("outletId", "Uji mutu air hanya untuk sumber air dan depot.");
  return { waterSourceId: null, outletId: o.id, name: o.name };
}

/** Pemilik menetapkan/mengubah jadwal uji per lokasi (frekuensi PAR-70 atau ditetapkan per jadwal). */
export async function upsertQualitySchedule(ctx: ActorContext, input: QualityScheduleInput, opts: { tx?: Tx } = {}): Promise<QualityScheduleRow> {
  await authorize(ctx, "m8.quality_schedule.update", { tx: opts.tx });
  const data = parseInput(scheduleSchema, input, { frequencyDays: "Frekuensi uji", nextDueDate: "Tanggal uji berikutnya", laboratory: "Laboratorium" });
  return runService(ctx, opts, async (tx) => {
    const loc = await resolveLocation(tx, ctx, data);
    const rules = await m8Rules(tx, ctxBusinessDate(ctx), ctx.tenantId);
    const frequencyDays = data.frequencyDays ?? rules.qualityFrequencyDays;
    if (!frequencyDays) {
      throw ValidationError.field("frequencyDays", "Frekuensi uji belum ditetapkan (PAR-70 tidak punya nilai bawaan). Isi frekuensi dalam hari sesuai arahan konsultan.");
    }
    const values = {
      locationType: data.locationType,
      waterSourceId: loc.waterSourceId,
      outletId: loc.outletId,
      frequencyDays,
      nextDueDate: data.nextDueDate,
      laboratory: data.laboratory ?? null,
      parameters: data.parameters ?? [],
      isActive: true,
    };
    if (data.scheduleId) {
      const [before] = await tx.select().from(qualityTestSchedules).where(eq(qualityTestSchedules.id, data.scheduleId)).limit(1);
      if (!before || before.tenantId !== ctx.tenantId) throw new NotFoundError("Jadwal uji tidak ditemukan.");
      const [row] = await tx.update(qualityTestSchedules).set(values).where(eq(qualityTestSchedules.id, before.id)).returning();
      await auditRecord(tx, {
        ctx,
        objectType: "quality_test_schedule",
        objectId: before.id,
        action: "update",
        before: { frequencyDays: before.frequencyDays, nextDueDate: before.nextDueDate, laboratory: before.laboratory, parameters: before.parameters },
        after: { frequencyDays, nextDueDate: data.nextDueDate, laboratory: values.laboratory, parameters: values.parameters },
        rule: "US-M8-06 KP-1, PAR-70",
      });
      return row!;
    }
    const [row] = await tx
      .insert(qualityTestSchedules)
      .values({ tenantId: ctx.tenantId, ...values, createdBy: ctx.userId })
      .returning();
    await auditRecord(tx, { ctx, objectType: "quality_test_schedule", objectId: row!.id, action: "create", after: { location: loc.name, ...values }, rule: "US-M8-06 KP-1, PAR-70" });
    return row!;
  });
}

/** Nonaktifkan jadwal uji (tidak dihapus). */
export async function deactivateQualitySchedule(ctx: ActorContext, input: { scheduleId: string; reason: string }, opts: { tx?: Tx } = {}): Promise<QualityScheduleRow> {
  await authorize(ctx, "m8.quality_schedule.update", { tx: opts.tx });
  const data = parseInput(z.object({ scheduleId: z.uuid(), reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 huruf)." }).max(300) }), input);
  return runService(ctx, opts, async (tx) => {
    const [before] = await tx.select().from(qualityTestSchedules).where(eq(qualityTestSchedules.id, data.scheduleId)).limit(1);
    if (!before || before.tenantId !== ctx.tenantId) throw new NotFoundError("Jadwal uji tidak ditemukan.");
    if (!before.isActive) throw new DomainError("NO_CHANGE", "Jadwal uji sudah nonaktif.");
    const [row] = await tx.update(qualityTestSchedules).set({ isActive: false }).where(eq(qualityTestSchedules.id, before.id)).returning();
    await auditRecord(tx, { ctx, objectType: "quality_test_schedule", objectId: before.id, action: "deactivate", before: { isActive: true }, after: { isActive: false }, reason: data.reason });
    return row!;
  });
}

// =====================================================================================================================
// Hasil uji (Admin Keuangan di kantor; operator produksi di aplikasi lapangan) — KP-2
// =====================================================================================================================

const resultLine = z
  .object({
    parameter: z.string().trim().min(1, { error: "Nama parameter wajib diisi." }).max(60),
    value: z.string().trim().min(1, { error: "Nilai parameter wajib diisi." }).max(60),
    unit: z.string().trim().max(20).nullable().optional(),
    limit: z.string().trim().max(60).nullable().optional(),
    passed: z.boolean(),
  })
  .strict();

const actionSchema = z
  .object({
    description: z.string().trim().min(5, { error: "Tindakan wajib dijelaskan (minimal 5 huruf)." }).max(500),
    ownerEmployeeId: z.uuid({ error: "Pilih penanggung jawab tindakan." }),
    dueDate: dateField("Tenggat tindakan"),
  })
  .strict();

export const qualityTestSchema = z
  .object({
    qualityTestId: z.uuid().optional(),
    scheduleId: z.uuid().nullable().optional(),
    locationType: z.enum(["water_source", "outlet"]),
    waterSourceId: z.uuid().nullable().optional(),
    outletId: z.uuid().nullable().optional(),
    testDate: dateField("Tanggal uji"),
    laboratory: z.string().trim().min(2, { error: "Nama laboratorium wajib diisi." }).max(120),
    results: z.array(resultLine).min(1, { error: "Isi minimal satu parameter hasil uji." }).max(40),
    passed: z.boolean(),
    action: actionSchema.nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    /** Lampiran sertifikat (foto/PDF) yang sudah diunggah — jalur kantor. */
    certificateAttachmentId: z.uuid().optional(),
  })
  .strict();

export type QualityTestInput = z.input<typeof qualityTestSchema>;

/** Payload perintah lapangan `m8.quality_test.create` (lokasi = sumber air perangkat). */
export const qualityTestFieldSchema = z
  .object({
    qualityTestId: z.uuid(),
    scheduleId: z.uuid().nullable().optional(),
    testDate: dateField("Tanggal uji"),
    laboratory: z.string().trim().min(2, { error: "Nama laboratorium wajib diisi." }).max(120),
    results: z.array(resultLine).min(1, { error: "Isi minimal satu parameter hasil uji." }).max(40),
    passed: z.boolean(),
    action: actionSchema.nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

type QualityCore = z.output<typeof qualityTestSchema> & { qualityTestId: string };

async function writeQualityTest(tx: Tx, ctx: ActorContext, data: QualityCore, certificate: AttachmentRow): Promise<{ test: QualityTestRow; duplicate: boolean }> {
  const [same] = await tx.select().from(qualityTests).where(eq(qualityTests.id, data.qualityTestId)).limit(1);
  if (same) return { test: same, duplicate: true };
  const loc = await resolveLocation(tx, ctx, data);
  if (data.testDate > ctxBusinessDate(ctx)) throw ValidationError.field("testDate", "Tanggal uji tidak boleh di masa depan.");
  if (data.passed && data.results.some((r) => !r.passed)) {
    throw ValidationError.field("passed", "Ada parameter yang tidak lulus — hasil uji harus \"tidak lulus\" dan tindakan wajib diisi.");
  }
  if (!data.passed) {
    // KP-2: hasil tidak lulus → tindakan wajib (deskripsi, penanggung jawab, tenggat).
    if (!data.action) throw ValidationError.field("action", "Hasil tidak lulus: isi tindakan, penanggung jawab, dan tenggat.");
    if (data.action.dueDate < data.testDate) throw ValidationError.field("action.dueDate", "Tenggat tindakan tidak boleh sebelum tanggal uji.");
    const [emp] = await tx.select().from(employees).where(eq(employees.id, data.action.ownerEmployeeId)).limit(1);
    if (!emp || emp.tenantId !== ctx.tenantId || !emp.isActive) throw ValidationError.field("action.ownerEmployeeId", "Penanggung jawab tidak ditemukan atau tidak aktif.");
  }
  if (!certificate.contentType.startsWith("image/") && certificate.contentType !== "application/pdf") {
    throw ValidationError.field("certificateAttachmentId", "Sertifikat harus foto atau PDF.");
  }
  let schedule: QualityScheduleRow | null = null;
  if (data.scheduleId) {
    const [s] = await tx.select().from(qualityTestSchedules).where(eq(qualityTestSchedules.id, data.scheduleId)).for("update").limit(1);
    if (!s || s.tenantId !== ctx.tenantId) throw new NotFoundError("Jadwal uji tidak ditemukan.");
    if (s.locationType !== data.locationType || (s.waterSourceId ?? null) !== loc.waterSourceId || (s.outletId ?? null) !== loc.outletId) {
      throw ValidationError.field("scheduleId", "Jadwal uji ini untuk lokasi lain.");
    }
    schedule = s;
  }
  const [test] = await tx
    .insert(qualityTests)
    .values({
      id: data.qualityTestId,
      tenantId: ctx.tenantId,
      scheduleId: schedule?.id ?? null,
      locationType: data.locationType,
      waterSourceId: loc.waterSourceId,
      outletId: loc.outletId,
      testDate: data.testDate,
      laboratory: data.laboratory,
      results: data.results as unknown as Record<string, unknown>[],
      passed: data.passed,
      certificateAttachmentId: certificate.id,
      actionRequired: data.passed ? null : data.action!.description,
      actionOwnerEmployeeId: data.passed ? null : data.action!.ownerEmployeeId,
      actionDueDate: data.passed ? null : data.action!.dueDate,
      actionNote: data.notes ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  await linkAttachment(tx, certificate.id, { type: "quality_test", id: test!.id });
  if (schedule?.frequencyDays) {
    const next = addDays(data.testDate, schedule.frequencyDays);
    if (!schedule.nextDueDate || next > schedule.nextDueDate || schedule.nextDueDate <= data.testDate) {
      await tx.update(qualityTestSchedules).set({ nextDueDate: next }).where(eq(qualityTestSchedules.id, schedule.id));
    }
  }
  await auditRecord(tx, {
    ctx,
    objectType: "quality_test",
    objectId: test!.id,
    action: "create",
    after: { location: loc.name, testDate: data.testDate, laboratory: data.laboratory, passed: data.passed, results: data.results, action: data.action ?? null },
    rule: "US-M8-06 KP-2",
    businessDate: data.testDate,
  });
  if (!data.passed) {
    await notify(tx, {
      event: "quality_test.failed",
      tenantId: ctx.tenantId,
      title: `Uji mutu ${loc.name} ${data.testDate} TIDAK LULUS`,
      body: `Parameter tidak lulus: ${data.results
        .filter((r) => !r.passed)
        .map((r) => `${r.parameter} ${r.value}${r.unit ? ` ${r.unit}` : ""}${r.limit ? ` (batas ${r.limit})` : ""}`)
        .join(", ")}. Tindakan: ${data.action!.description} — tenggat ${data.action!.dueDate}.`,
      objectType: "quality_test",
      objectId: test!.id,
      link: `/produksi/mutu?lokasi=${loc.waterSourceId ?? loc.outletId}`,
      deadlineAt: new Date(`${data.action!.dueDate}T16:59:00Z`),
      now: ctx.now,
    });
  }
  return { test: test!, duplicate: false };
}

/** Kantor (Admin Keuangan): catat hasil uji + sertifikat yang sudah diunggah. */
export async function recordQualityTest(ctx: ActorContext, input: QualityTestInput, opts: { tx?: Tx } = {}): Promise<QualityTestRow> {
  await authorize(ctx, "m8.quality_test.create", { tx: opts.tx });
  const data = parseInput(qualityTestSchema, input, { testDate: "Tanggal uji", laboratory: "Laboratorium", results: "Hasil uji", certificateAttachmentId: "Sertifikat" });
  return runService(ctx, opts, async (tx) => {
    if (!data.certificateAttachmentId) throw ValidationError.field("certificateAttachmentId", "Lampirkan foto/PDF sertifikat hasil uji.");
    const [att] = await tx.select().from(attachments).where(eq(attachments.id, data.certificateAttachmentId)).limit(1);
    if (!att || att.tenantId !== ctx.tenantId) throw ValidationError.field("certificateAttachmentId", "Sertifikat tidak ditemukan. Unggah ulang berkasnya.");
    return (await writeQualityTest(tx, ctx, { ...data, qualityTestId: data.qualityTestId ?? newId() }, att)).test;
  });
}

/** Handler perintah lapangan `m8.quality_test.create` (operator produksi; lokasi = sumber air perangkat). */
export async function recordQualityTestFromField(ctx: ActorContext, input: z.output<typeof qualityTestFieldSchema>, meta: M8FieldMeta): Promise<{ test: QualityTestRow; duplicate: boolean }> {
  const { tx } = meta;
  await authorize(ctx, "m8.quality_test.create", { tx });
  const source = await resolveOperatorSource(tx, ctx, meta.device);
  const certificate = attachmentOfKind(meta, M8_ATTACHMENT_KINDS.certificate);
  if (!certificate) throw new DomainError("QUALITY_CERTIFICATE_REQUIRED", "Foto sertifikat hasil uji wajib diambil sebelum menyimpan.");
  return writeQualityTest(tx, ctx, { ...input, locationType: "water_source", waterSourceId: source.id, outletId: null }, certificate);
}

const actionDoneSchema = z
  .object({
    qualityTestId: z.uuid(),
    note: z.string().trim().min(5, { error: "Tulis hasil tindakan (minimal 5 huruf)." }).max(500),
  })
  .strict();

/** Tandai tindakan hasil tidak lulus selesai (Admin Keuangan / pemilik) — berjejak. */
export async function completeQualityAction(ctx: ActorContext, input: z.input<typeof actionDoneSchema>, opts: { tx?: Tx } = {}): Promise<QualityTestRow> {
  await authorizeAny(ctx, ["m8.quality_test.create", "m8.quality_schedule.update"], { tx: opts.tx });
  const data = parseInput(actionDoneSchema, input, { note: "Hasil tindakan" });
  return runService(ctx, opts, async (tx) => {
    const [t] = await tx.select().from(qualityTests).where(eq(qualityTests.id, data.qualityTestId)).for("update").limit(1);
    if (!t || t.tenantId !== ctx.tenantId) throw new NotFoundError("Hasil uji tidak ditemukan.");
    if (t.passed || !t.actionRequired) throw new DomainError("NO_ACTION", "Hasil uji ini tidak memerlukan tindakan.");
    if (t.actionDoneAt) throw new DomainError("ACTION_DONE", "Tindakan sudah ditandai selesai.");
    const [row] = await tx
      .update(qualityTests)
      .set({ actionDoneAt: ctx.now, actionDoneBy: ctx.userId, actionNote: [t.actionNote, `Selesai: ${data.note}`].filter(Boolean).join(" · ") })
      .where(eq(qualityTests.id, t.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "quality_test", objectId: t.id, action: "action_done", before: { actionDoneAt: null }, after: { actionDoneAt: ctx.now.toISOString() }, reason: data.note });
    return row!;
  });
}

// =====================================================================================================================
// Kueri & pengingat
// =====================================================================================================================

export type QualityScheduleView = QualityScheduleRow & { locationName: string; dueSoon: boolean; overdue: boolean };
export type QualityTestView = QualityTestRow & { locationName: string; actionOwnerName: string | null };

async function locationNames(tx: Tx, tenantId: string): Promise<Map<string, string>> {
  const s = await tx.select({ id: waterSources.id, name: waterSources.name }).from(waterSources).where(eq(waterSources.tenantId, tenantId));
  const o = await tx.select({ id: outlets.id, name: outlets.name }).from(outlets).where(eq(outlets.tenantId, tenantId));
  return new Map([...s, ...o].map((x) => [x.id, x.name]));
}

/** Kantor: jadwal & hasil uji (lingkup pelaku), riwayat per lokasi bila `locationId` diisi (KP-3). */
export async function qualityOverview(ctx: ActorContext, input: { locationId?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<{ schedules: QualityScheduleView[]; tests: QualityTestView[] }> {
  await authorize(ctx, "m8.quality_test.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const rules = await m8Rules(tx, today, ctx.tenantId);
  const names = await locationNames(tx, ctx.tenantId);
  const visible = (r: { waterSourceId: string | null; outletId: string | null }) =>
    (r.waterSourceId ? inSourceScope(ctx, r.waterSourceId, ctx.tenantId) : true) && (r.outletId ? inOutletScope(ctx, r.outletId, ctx.tenantId) : true);
  const schedules = (await tx.select().from(qualityTestSchedules).where(eq(qualityTestSchedules.tenantId, ctx.tenantId)).orderBy(asc(qualityTestSchedules.nextDueDate)))
    .filter(visible)
    .filter((s) => !input.locationId || s.waterSourceId === input.locationId || s.outletId === input.locationId)
    .map((s) => ({
      ...s,
      locationName: names.get(s.waterSourceId ?? s.outletId ?? "") ?? "—",
      dueSoon: !!s.isActive && !!s.nextDueDate && s.nextDueDate >= today && s.nextDueDate <= addDays(today, rules.qualityReminderDaysBefore),
      overdue: !!s.isActive && !!s.nextDueDate && s.nextDueDate < today,
    }));
  const rows = await tx
    .select({ t: qualityTests, ownerName: employees.fullName })
    .from(qualityTests)
    .leftJoin(employees, eq(employees.id, qualityTests.actionOwnerEmployeeId))
    .where(eq(qualityTests.tenantId, ctx.tenantId))
    .orderBy(desc(qualityTests.testDate), desc(qualityTests.createdAt));
  const tests = rows
    .map((r) => ({ ...r.t, locationName: names.get(r.t.waterSourceId ?? r.t.outletId ?? "") ?? "—", actionOwnerName: r.ownerName }))
    .filter(visible)
    .filter((t) => !input.locationId || t.waterSourceId === input.locationId || t.outletId === input.locationId);
  return { schedules, tests };
}

/** Karyawan aktif yang dapat menjadi penanggung jawab tindakan (pemilik, Admin Keuangan, operator sumber/depot). */
export async function actionOwnerCandidates(tx: Tx | Db, tenantId: string, opts: { sourceId?: string | null } = {}): Promise<{ id: string; name: string }[]> {
  const rows = await tx
    .selectDistinct({ id: employees.id, name: employees.fullName, role: userRoles.role, userId: users.id })
    .from(employees)
    .innerJoin(users, eq(users.employeeId, employees.id))
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(
      and(
        eq(employees.tenantId, tenantId),
        eq(employees.isActive, true),
        eq(userRoles.status, "active"),
        inArray(userRoles.role, ["owner", "finance_admin", "production_operator", "system_admin"]),
        isNull(employees.exitDate),
      ),
    )
    .orderBy(asc(employees.fullName));
  let allowed = rows;
  if (opts.sourceId) {
    const scoped = new Set(
      (
        await tx
          .select({ userId: userScopes.userId })
          .from(userScopes)
          .where(and(eq(userScopes.scopeType, "water_source"), eq(userScopes.refId, opts.sourceId), eq(userScopes.status, "active")))
      ).map((r) => r.userId),
    );
    allowed = rows.filter((r) => r.role !== "production_operator" || scoped.has(r.userId));
  }
  const seen = new Map<string, string>();
  for (const r of allowed) if (!seen.has(r.id)) seen.set(r.id, r.name);
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

/**
 * Job pengingat H-N (KP-1): jadwal aktif yang jatuh tempo dalam N hari → pemilik + operator lokasi (sumber: operator
 * produksi sumber itu; depot: operator depot outlet itu). Sekali per jadwal per tanggal jatuh tempo.
 */
export async function runQualityReminders(now: Date, db?: Db): Promise<{ reminded: number }> {
  return withTx(
    async (tx) => {
      const today = toBusinessDate(now);
      const schedules = await tx.select().from(qualityTestSchedules).where(and(eq(qualityTestSchedules.isActive, true), gte(qualityTestSchedules.nextDueDate, today)));
      let reminded = 0;
      for (const s of schedules) {
        const rules = await m8Rules(tx, today, s.tenantId);
        if (!s.nextDueDate || s.nextDueDate > addDays(today, rules.qualityReminderDaysBefore)) continue;
        const names = await locationNames(tx, s.tenantId);
        const name = names.get(s.waterSourceId ?? s.outletId ?? "") ?? "lokasi";
        const sent = await notifyOnce(tx, {
          event: "quality_test.due",
          tenantId: s.tenantId,
          groupKey: `quality_due:${s.id}:${s.nextDueDate}`,
          recipients: s.waterSourceId
            ? { roles: ["owner", "production_operator"], scope: { sourceId: s.waterSourceId } }
            : { roles: ["owner", "depot_operator"], scope: { outletId: s.outletId } },
          title: `Jadwal uji mutu ${name}: ${s.nextDueDate}`,
          body: `Siapkan pengambilan sampel${s.laboratory ? ` untuk ${s.laboratory}` : ""}${(s.parameters ?? []).length ? ` (parameter: ${(s.parameters ?? []).join(", ")})` : ""}.`,
          objectType: "quality_test_schedule",
          objectId: s.id,
          link: `/produksi/mutu?lokasi=${s.waterSourceId ?? s.outletId}`,
          now,
        });
        if (sent) reminded++;
      }
      return { reminded };
    },
    db ? { db } : {},
  );
}

/** Jadwal & hasil uji satu sumber (pull aplikasi operator). */
export async function qualityForSource(tx: Tx, sourceId: string, today: BusinessDate, reminderDays: number) {
  const schedules = await tx
    .select()
    .from(qualityTestSchedules)
    .where(and(eq(qualityTestSchedules.waterSourceId, sourceId), eq(qualityTestSchedules.isActive, true)))
    .orderBy(asc(qualityTestSchedules.nextDueDate));
  const recent = await tx
    .select()
    .from(qualityTests)
    .where(and(eq(qualityTests.waterSourceId, sourceId), lte(qualityTests.testDate, today)))
    .orderBy(desc(qualityTests.testDate))
    .limit(5);
  return {
    schedules: schedules.map((s) => ({
      id: s.id,
      nextDueDate: s.nextDueDate,
      frequencyDays: s.frequencyDays,
      laboratory: s.laboratory,
      parameters: s.parameters ?? [],
      dueSoon: !!s.nextDueDate && s.nextDueDate >= today && s.nextDueDate <= addDays(today, reminderDays),
      overdue: !!s.nextDueDate && s.nextDueDate < today,
    })),
    recent: recent.map((t) => ({ id: t.id, testDate: t.testDate, laboratory: t.laboratory, passed: t.passed })),
  };
}
