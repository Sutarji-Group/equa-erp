/**
 * P3 — standar mutu outlet mitra (Tahap 3 US-P3-05; flag `phase3.partner_portal`).
 *
 * - KP-1 (S): daftar periksa harian di POS saat buka shift (perintah sinkron `p3.quality_checklist.submit`, offline):
 *   butir SOP (`partner_quality_item`), foto bukti untuk butir `p3.partner_rules.quality_photo_items`, butir tidak lulus
 *   wajib tindakan; kepatuhan pengisian per outlet per bulan dihitung.
 * - KP-2: jadwal audit pembina per outlet (job bulanan; frekuensi `audit_interval_months`), lembar audit (skor per
 *   butir, foto, temuan, tenggat tindak lanjut); temuan lewat tenggat → pemicu sanksi (US-P3-07).
 * - KP-3: uji air laboratorium per outlet memakai M8 US-M8-06 (`recordQualityTest` pada tenant mitra); tidak lulus →
 *   tidak memblokir, tindakan wajib + notifikasi pemilik; tidak lulus berturut (`consecutive_failed_tests`) → pemicu.
 * - KP-4: skor mutu bulanan = gabungan berbobot (`p3.quality_weights`, pemilik) daftar periksa/audit/uji; < PAR-80 →
 *   pemicu teguran.
 * - KP-5: bukti mutu per outlet (`qualityEvidence`).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { employees, outlets, partnerAudits, partnerScores, qualityChecklistItems, qualityChecklists, qualityTests, shifts } from "@/db/schema";
import { enumValues, label } from "@/lib/labels";
import { addDays, daysBetween, isBusinessDate, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, authorizeAny, runService } from "@/server/core/rbac";
import { linkAttachment, put } from "@/server/core/storage";
import { fieldMetaValues, type SyncMeta } from "@/server/core/sync";
import { recordQualityTest, type QualityTestInput } from "@/server/modules/m8-production";

import { activeContractFor, assertOwnerTenant, assertPortalEnabled, loadPartnerTenant, loadTenant, monthKey, monthRange, notifyOnce, ownerTenantId, partnerRules, partnerTenants, portalEnabled, tenantOutlets } from "./common";
import { recordSanctionTrigger } from "./sanctions";

export const QUALITY_ITEMS = enumValues("partner_quality_item");

// =====================================================================================================================
// KP-1: daftar periksa harian (perintah POS offline)
// =====================================================================================================================

export const qualityChecklistSchema = z.object({
  checklistId: z.uuid(),
  shiftId: z.uuid().nullable().optional(),
  outletId: z.uuid().nullable().optional(),
  items: z
    .array(
      z.object({
        itemKey: z.string().min(1).max(40),
        result: z.enum(["pass", "fail"]),
        actionNote: z.string().trim().max(500).nullable().optional(),
        photoAttachmentId: z.uuid().nullable().optional(),
      }),
    )
    .min(1, { error: "Isi semua butir daftar periksa." })
    .max(20),
});
export type QualityChecklistPayload = z.output<typeof qualityChecklistSchema>;

/** Handler `p3.quality_checklist.submit` (operator depot mitra; idempoten per perintah & per outlet-hari). */
export async function submitQualityChecklistFromField(ctx: ActorContext, payload: QualityChecklistPayload, meta: SyncMeta) {
  const { tx } = meta;
  const outletId = payload.outletId ?? meta.device.outletId;
  if (!outletId) throw new DomainError("NO_OUTLET", "Perangkat ini belum terikat outlet. Hubungi admin sistem EQUA.");
  const [o] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).limit(1);
  if (!o || o.tenantId !== meta.device.tenantId || (ctx.scope.outletIds.length && !ctx.scope.outletIds.includes(o.id))) {
    throw new DomainError("OUTLET_SCOPE", "Outlet di luar lingkup akun Anda.");
  }
  const tenant = await loadTenant(tx, o.tenantId);
  if (tenant?.kind !== "partner") throw new DomainError("NOT_PARTNER_OUTLET", "Daftar periksa mutu harian khusus outlet mitra.");
  if (!(await portalEnabled(tx, tenant.id))) throw new DomainError("PARTNER_PORTAL_DISABLED", "Daftar periksa mutu harian belum diaktifkan EQUA untuk outlet ini.");
  const date = meta.command.businessDate;
  const [same] = await tx.select().from(qualityChecklists).where(eq(qualityChecklists.syncCommandId, meta.command.id)).limit(1);
  if (same) return { objectType: "quality_checklist", objectId: same.id, result: { duplicate: true } };
  const [existing] = await tx.select().from(qualityChecklists).where(and(eq(qualityChecklists.outletId, o.id), eq(qualityChecklists.businessDate, date))).limit(1);
  if (existing) return { status: "conflict" as const, message: "Daftar periksa outlet ini untuk hari ini sudah diisi.", objectType: "quality_checklist", objectId: existing.id };
  const rules = await partnerRules(tx, date);
  const keys = new Set(payload.items.map((i) => i.itemKey));
  const missing = QUALITY_ITEMS.filter((k) => !keys.has(k));
  if (missing.length) throw new DomainError("CHECKLIST_INCOMPLETE", `Butir belum diisi: ${missing.map((k) => label("partner_quality_item", k)).join(", ")}.`);
  const photoIds = new Set(meta.attachments.map((a) => a.id));
  for (const it of payload.items) {
    if (!(QUALITY_ITEMS as readonly string[]).includes(it.itemKey)) throw new DomainError("CHECKLIST_ITEM", `Butir tidak dikenal: ${it.itemKey}.`);
    if (it.result === "fail" && !it.actionNote?.trim()) throw new DomainError("CHECKLIST_ACTION_REQUIRED", `${label("partner_quality_item", it.itemKey)} tidak lulus — tulis tindakan yang dilakukan.`);
    if (rules.quality_photo_items.includes(it.itemKey) && !it.photoAttachmentId) throw new DomainError("CHECKLIST_PHOTO_REQUIRED", `${label("partner_quality_item", it.itemKey)} wajib foto bukti.`);
    if (it.photoAttachmentId && !photoIds.has(it.photoAttachmentId)) throw new DomainError("CHECKLIST_PHOTO_MISSING", "Foto bukti belum terunggah dari perangkat ini. Kirim ulang.");
  }
  const passedAll = payload.items.every((i) => i.result === "pass");
  const [row] = await tx
    .insert(qualityChecklists)
    .values({ id: payload.checklistId, tenantId: o.tenantId, outletId: o.id, businessDate: date, shiftId: payload.shiftId ?? null, filledBy: ctx.userId, filledAt: meta.command.deviceTime, passedAll, ...fieldMetaValues(meta) })
    .returning();
  for (const it of payload.items) {
    await tx.insert(qualityChecklistItems).values({ tenantId: o.tenantId, checklistId: row!.id, itemKey: it.itemKey, label: label("partner_quality_item", it.itemKey), result: it.result, photoAttachmentId: it.photoAttachmentId ?? null, actionNote: it.actionNote ?? null });
    if (it.photoAttachmentId) await linkAttachment(tx, it.photoAttachmentId, { type: "quality_checklist", id: row!.id });
  }
  await auditRecord(tx, { ctx, objectType: "quality_checklist", objectId: row!.id, action: "create", after: { outletId: o.id, businessDate: date, passedAll, failed: payload.items.filter((i) => i.result === "fail").map((i) => i.itemKey) }, rule: "US-P3-05 KP-1", businessDate: date });
  if (!passedAll) {
    await notify(tx, {
      event: "partner.quality_failed",
      tenantId: await ownerTenantId(tx),
      title: `Daftar periksa mutu ${o.name} ada butir tidak lulus`,
      body: payload.items
        .filter((i) => i.result === "fail")
        .map((i) => `${label("partner_quality_item", i.itemKey)}: ${i.actionNote}`)
        .join("; "),
      objectType: "quality_checklist",
      objectId: row!.id,
      link: `/kemitraan/mutu?outlet=${o.id}`,
      now: meta.receivedAt,
    });
  }
  return { objectType: "quality_checklist", objectId: row!.id, result: { passedAll } };
}

/** Kepatuhan pengisian per outlet per bulan: hari terisi / hari ber-shift (KP-1). */
export async function checklistCompliance(tx: Tx, outletId: string, month: string) {
  const { from, to } = monthRange(month);
  const filled = await tx
    .select({ d: qualityChecklists.businessDate, passedAll: qualityChecklists.passedAll })
    .from(qualityChecklists)
    .where(and(eq(qualityChecklists.outletId, outletId), gte(qualityChecklists.businessDate, from), lte(qualityChecklists.businessDate, to)));
  const shiftDays = await tx
    .select({ d: sql<string>`distinct ${shifts.businessDate}` })
    .from(shifts)
    .where(and(eq(shifts.outletId, outletId), gte(shifts.businessDate, from), lte(shifts.businessDate, to)));
  const operating = new Set([...shiftDays.map((s) => String(s.d)), ...filled.map((f) => f.d)]).size;
  const passedDays = filled.filter((f) => f.passedAll).length;
  return {
    filledDays: filled.length,
    operatingDays: operating,
    compliancePct: operating ? Math.round((filled.length / operating) * 1000) / 10 : null,
    passRatePct: filled.length ? Math.round((passedDays / filled.length) * 1000) / 10 : null,
  };
}

// =====================================================================================================================
// KP-2: audit pembina
// =====================================================================================================================

export type AuditRow = typeof partnerAudits.$inferSelect;

/** Job bulanan: jadwalkan audit outlet mitra Aktif sesuai frekuensi (idempoten per outlet-bulan). */
export async function scheduleAudits(tx: Tx, date: BusinessDate): Promise<string[]> {
  const rules = await partnerRules(tx, date);
  const created: string[] = [];
  for (const tenant of await partnerTenants(tx)) {
    if (!(await portalEnabled(tx, tenant.id))) continue;
    const contract = await activeContractFor(tx, tenant.id, date);
    if (!contract) continue;
    for (const o of await tenantOutlets(tx, tenant.id, { depotOnly: true })) {
      if (!o.isActive || !o.activatedOn) continue;
      const [last] = await tx.select().from(partnerAudits).where(eq(partnerAudits.outletId, o.id)).orderBy(desc(partnerAudits.scheduledDate)).limit(1);
      const due = last ? addDays(last.scheduledDate, rules.audit_interval_months * 30) : date;
      if (last && due > addDays(date, 27)) continue;
      const scheduled = due < date ? date : due;
      const [row] = await tx.insert(partnerAudits).values({ tenantId: tenant.id, outletId: o.id, contractId: contract.id, scheduledDate: scheduled, status: "scheduled" }).returning();
      created.push(row!.id);
    }
  }
  return created;
}

const scheduleSchema = z.object({ outletId: z.uuid(), scheduledDate: z.string().refine(isBusinessDate, { error: "Tanggal audit harus YYYY-MM-DD." }) });

/** Pembina menjadwalkan audit/kunjungan tambahan. */
export async function scheduleAudit(ctx: ActorContext, input: z.input<typeof scheduleSchema>, opts: { tx?: Tx } = {}): Promise<AuditRow> {
  await authorize(ctx, "p3.partner_audit.create", { tx: opts.tx, objectType: "partner_audit" });
  const data = parseInput(scheduleSchema, input, { scheduledDate: "Tanggal audit" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const [o] = await tx.select().from(outlets).where(eq(outlets.id, data.outletId)).limit(1);
    if (!o) throw new NotFoundError("Outlet tidak ditemukan.");
    const tenant = await loadPartnerTenant(tx, o.tenantId);
    await assertPortalEnabled(tx, tenant.id);
    const contract = await activeContractFor(tx, tenant.id, ctxBusinessDate(ctx));
    const [row] = await tx.insert(partnerAudits).values({ tenantId: tenant.id, outletId: o.id, contractId: contract?.id ?? null, scheduledDate: data.scheduledDate, status: "scheduled", createdBy: ctx.userId }).returning();
    await auditRecord(tx, { ctx, objectType: "partner_audit", objectId: row!.id, action: "schedule", after: { outletId: o.id, scheduledDate: data.scheduledDate }, rule: "US-P3-05 KP-2" });
    return row!;
  });
}

const conductSchema = z.object({
  auditId: z.uuid(),
  items: z
    .array(z.object({ key: z.string().min(1).max(60), label: z.string().trim().min(2).max(120), score: z.coerce.number().min(0).max(100), note: z.string().trim().max(500).nullable().optional() }))
    .min(1, { error: "Isi skor minimal satu butir audit." })
    .max(40),
  findings: z.array(z.object({ text: z.string().trim().min(5).max(500), photoAttachmentId: z.uuid().nullable().optional() })).max(30).default([]),
  followUpDueDate: z
    .string()
    .refine(isBusinessDate, { error: "Tenggat tindak lanjut harus YYYY-MM-DD." })
    .nullable()
    .optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  photoAttachmentIds: z.array(z.uuid()).max(10).default([]),
});
export type ConductAuditInput = z.input<typeof conductSchema>;

/** Lembar audit: skor per butir, foto, temuan, tenggat tindak lanjut (bawaan `audit_follow_up_days`). */
export async function conductAudit(ctx: ActorContext, input: ConductAuditInput, opts: { tx?: Tx } = {}): Promise<AuditRow> {
  await authorize(ctx, "p3.partner_audit.create", { tx: opts.tx, objectType: "partner_audit", objectId: input?.auditId });
  const data = parseInput(conductSchema, input, { items: "Butir audit", findings: "Temuan", followUpDueDate: "Tenggat tindak lanjut" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const [a] = await tx.select().from(partnerAudits).where(eq(partnerAudits.id, data.auditId)).for("update").limit(1);
    if (!a) throw new NotFoundError("Jadwal audit tidak ditemukan.");
    await assertPortalEnabled(tx, a.tenantId);
    if (a.status !== "scheduled") throw new DomainError("AUDIT_DONE", `Audit ini sudah ${label("partner_audit_status", a.status).toLowerCase()}.`);
    const today = ctxBusinessDate(ctx);
    const rules = await partnerRules(tx, today);
    const score = Math.round((data.items.reduce((s, i) => s + i.score, 0) / data.items.length) * 100) / 100;
    const hasFindings = data.findings.length > 0;
    const followUpDueDate = hasFindings ? (data.followUpDueDate ?? addDays(today, rules.audit_follow_up_days)) : null;
    if (followUpDueDate && followUpDueDate < today) throw ValidationError.field("followUpDueDate", "Tenggat tindak lanjut tidak boleh sebelum hari ini.");
    const [row] = await tx
      .update(partnerAudits)
      .set({ conductedAt: ctx.now, auditorUserId: ctx.userId, status: hasFindings ? "findings" : "closed", score, items: data.items, findings: data.findings, followUpDueDate, notes: data.notes ?? null, updatedAt: ctx.now })
      .where(eq(partnerAudits.id, a.id))
      .returning();
    for (const id of [...data.photoAttachmentIds, ...data.findings.map((f) => f.photoAttachmentId).filter((x): x is string => !!x)]) await linkAttachment(tx, id, { type: "partner_audit", id: a.id });
    await auditRecord(tx, { ctx, objectType: "partner_audit", objectId: a.id, action: "conduct", before: { status: a.status }, after: { status: row!.status, score, findings: data.findings.length, followUpDueDate }, rule: "US-P3-05 KP-2" });
    return row!;
  });
}

const followUpSchema = z.object({ auditId: z.uuid(), note: z.string().trim().min(5, { error: "Tulis hasil tindak lanjut (minimal 5 karakter)." }).max(1000) });

/** Tindak lanjut temuan selesai → audit Selesai. */
export async function closeAuditFollowUp(ctx: ActorContext, input: z.input<typeof followUpSchema>, opts: { tx?: Tx } = {}): Promise<AuditRow> {
  await authorize(ctx, "p3.partner_audit.create", { tx: opts.tx, objectType: "partner_audit", objectId: input?.auditId });
  const data = parseInput(followUpSchema, input, { note: "Hasil tindak lanjut" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const [a] = await tx.select().from(partnerAudits).where(eq(partnerAudits.id, data.auditId)).for("update").limit(1);
    if (!a) throw new NotFoundError("Audit tidak ditemukan.");
    if (a.status !== "findings" && a.status !== "follow_up") throw new DomainError("AUDIT_NO_FINDINGS", "Audit ini tidak punya temuan terbuka.");
    const [row] = await tx
      .update(partnerAudits)
      .set({ status: "closed", followUpDoneAt: ctx.now, notes: [a.notes, `Tindak lanjut: ${data.note}`].filter(Boolean).join("\n"), updatedAt: ctx.now })
      .where(eq(partnerAudits.id, a.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "partner_audit", objectId: a.id, action: "follow_up_done", before: { status: a.status }, after: { status: "closed" }, reason: data.note, rule: "US-P3-05 KP-2" });
    return row!;
  });
}

// =====================================================================================================================
// KP-3: uji air laboratorium (M8 US-M8-06 pada tenant mitra)
// =====================================================================================================================

export type PartnerQualityTestInput = Omit<QualityTestInput, "locationType" | "waterSourceId" | "certificateAttachmentId" | "action"> & {
  outletId: string;
  certificate: { blob: Blob | Buffer | Uint8Array; contentType: string; name?: string | null };
  action?: { description: string; dueDate: string } | null;
};

/** Pembina mencatat hasil uji lab outlet mitra (sertifikat wajib); tidak lulus → notifikasi pemilik + pemicu berturut. */
export async function recordPartnerQualityTest(ctx: ActorContext, input: PartnerQualityTestInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_quality_test.create", { tx: opts.tx, objectType: "quality_test" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const [o] = await tx.select().from(outlets).where(eq(outlets.id, input.outletId)).limit(1);
    if (!o) throw new NotFoundError("Outlet tidak ditemukan.");
    const tenant = await loadPartnerTenant(tx, o.tenantId);
    await assertPortalEnabled(tx, tenant.id);
    const partnerCtx = systemContext({ tenantId: tenant.id, now: ctx.now, businessDate: ctxBusinessDate(ctx) });
    const cert = await put(tx, partnerCtx, { blob: input.certificate.blob, contentType: input.certificate.contentType, kind: "quality_certificate", originalName: input.certificate.name ?? null });
    let action: QualityTestInput["action"] = null;
    if (!input.passed) {
      if (!input.action) throw ValidationError.field("action", "Hasil tidak lulus: isi tindakan dan tenggat.");
      // Penanggung jawab = karyawan pemilik mitra (tenant mitra).
      const [owner] = await tx.select({ id: employees.id }).from(employees).where(and(eq(employees.tenantId, tenant.id), eq(employees.isActive, true))).orderBy(asc(employees.createdAt)).limit(1);
      if (!owner) throw new DomainError("NO_PARTNER_EMPLOYEE", "Mitra belum punya karyawan/akun terdaftar sebagai penanggung jawab tindakan.");
      action = { description: input.action.description, ownerEmployeeId: owner.id, dueDate: input.action.dueDate };
    }
    const test = await recordQualityTest(
      partnerCtx,
      { testDate: input.testDate, laboratory: input.laboratory, results: input.results, passed: input.passed, notes: input.notes ?? null, action, locationType: "outlet", outletId: o.id, certificateAttachmentId: cert.id },
      { tx },
    );
    await auditRecord(tx, { ctx, objectType: "quality_test", objectId: test.id, action: "create", after: { outletId: o.id, passed: test.passed, testDate: test.testDate, laboratory: test.laboratory }, rule: "US-P3-05 KP-3, US-M8-06" });
    if (!test.passed) {
      const equa = await ownerTenantId(tx);
      await notify(tx, {
        event: "partner.quality_failed",
        tenantId: equa,
        title: `Uji air lab ${o.name} (${tenant.name}) TIDAK LULUS`,
        body: `Tindakan wajib: ${input.action?.description ?? "-"} (tenggat ${input.action?.dueDate ?? "-"}). Pasokan/penjualan tidak diblokir otomatis.`,
        objectType: "quality_test",
        objectId: test.id,
        link: `/kemitraan/mutu?outlet=${o.id}`,
        now: ctx.now,
      });
      const rules = await partnerRules(tx, ctxBusinessDate(ctx));
      const recent = await tx.select({ id: qualityTests.id, passed: qualityTests.passed }).from(qualityTests).where(eq(qualityTests.outletId, o.id)).orderBy(desc(qualityTests.testDate), desc(qualityTests.createdAt)).limit(rules.consecutive_failed_tests);
      if (recent.length >= rules.consecutive_failed_tests && recent.every((r) => !r.passed)) {
        await recordSanctionTrigger(tx, {
          partnerTenantId: tenant.id,
          trigger: "test_failed",
          key: `test_failed:${o.id}:${test.id}`,
          summary: `Uji air ${o.name} tidak lulus ${rules.consecutive_failed_tests} kali berturut-turut.`,
          detail: { outletId: o.id, testIds: recent.map((r) => r.id) },
          now: ctx.now,
        });
      }
    }
    return test;
  });
}

// =====================================================================================================================
// KP-4: skor mutu bulanan
// =====================================================================================================================

export type ScoreRow = typeof partnerScores.$inferSelect;

/** Hitung skor satu outlet untuk bulan (tanpa menulis). */
export async function computeOutletScore(tx: Tx, outletId: string, month: string) {
  const { from, to } = monthRange(month);
  const comp = await checklistCompliance(tx, outletId, month);
  const checklistScore = comp.compliancePct === null ? null : Math.round(((comp.compliancePct * (comp.passRatePct ?? 0)) / 100) * 100) / 100;
  const audits = await tx
    .select({ score: partnerAudits.score })
    .from(partnerAudits)
    .where(and(eq(partnerAudits.outletId, outletId), sql`${partnerAudits.conductedAt} is not null`, gte(partnerAudits.scheduledDate, from), lte(partnerAudits.scheduledDate, to)));
  const scored = audits.filter((a) => a.score !== null);
  const auditScore = scored.length ? Math.round((scored.reduce((s, a) => s + Number(a.score), 0) / scored.length) * 100) / 100 : null;
  const tests = await tx.select({ passed: qualityTests.passed }).from(qualityTests).where(and(eq(qualityTests.outletId, outletId), gte(qualityTests.testDate, from), lte(qualityTests.testDate, to)));
  const testScore = tests.length ? Math.round((tests.filter((t) => t.passed).length / tests.length) * 10_000) / 100 : null;
  const w = await params.get(tx, "p3.quality_weights", to);
  const parts: [number | null, number][] = [
    [checklistScore, w.checklist],
    [auditScore, w.audit],
    [testScore, w.test],
  ];
  const used = parts.filter(([v, wt]) => v !== null && wt > 0) as [number, number][];
  const weightSum = used.reduce((s, [, wt]) => s + wt, 0);
  const total = weightSum ? Math.round((used.reduce((s, [v, wt]) => s + v * wt, 0) / weightSum) * 100) / 100 : null;
  const threshold = await params.get(tx, "PAR-80", to);
  return { checklistScore, auditScore, testScore, weights: { checklist: w.checklist, audit: w.audit, test: w.test }, totalScore: total, belowThreshold: total !== null && total < threshold.percent, threshold: threshold.percent, compliance: comp };
}

/** Job bulanan (tgl 1): skor bulan lalu per outlet mitra Aktif; < PAR-80 → pemicu teguran; temuan lewat tenggat → pemicu. */
export async function runQualityMonthly(now: Date, opts: { db?: Db; month?: string } = {}) {
  const today = toBusinessDate(now);
  const month = opts.month ?? monthKey(addDays(`${today.slice(0, 7)}-01`, -1));
  return withTx(
    async (tx) => {
      const scores: string[] = [];
      const triggers: string[] = [];
      for (const tenant of await partnerTenants(tx)) {
        if (!(await portalEnabled(tx, tenant.id))) continue;
        for (const o of await tenantOutlets(tx, tenant.id, { depotOnly: true })) {
          if (!o.activatedOn || o.activatedOn > monthRange(month).to) continue;
          const s = await computeOutletScore(tx, o.id, month);
          if (s.totalScore === null) continue;
          await tx
            .insert(partnerScores)
            .values({ tenantId: tenant.id, outletId: o.id, period: month, checklistScore: s.checklistScore, auditScore: s.auditScore, testScore: s.testScore, weights: s.weights, totalScore: s.totalScore, belowThreshold: s.belowThreshold, computedAt: now })
            .onConflictDoUpdate({ target: [partnerScores.outletId, partnerScores.period], set: { checklistScore: s.checklistScore, auditScore: s.auditScore, testScore: s.testScore, weights: s.weights, totalScore: s.totalScore, belowThreshold: s.belowThreshold, computedAt: now, updatedAt: now } });
          scores.push(o.id);
          if (s.belowThreshold) {
            const row = await recordSanctionTrigger(tx, {
              partnerTenantId: tenant.id,
              trigger: "low_score",
              key: `low_score:${o.id}:${month}`,
              summary: `Skor mutu ${o.name} ${month} = ${s.totalScore} < ${s.threshold} (PAR-80).`,
              detail: { outletId: o.id, month, score: s.totalScore },
              now,
            });
            if (row) triggers.push(row.id);
          }
        }
      }
      return { month, scores, triggers };
    },
    opts.db ? { db: opts.db } : {},
  );
}

/** Job harian: jadwal audit + temuan audit lewat tenggat → pemicu sanksi (KP-2). */
export async function runAuditChecks(now: Date, opts: { db?: Db } = {}) {
  const today = toBusinessDate(now);
  return withTx(
    async (tx) => {
      const scheduled = await scheduleAudits(tx, today);
      const overdue = await tx
        .select()
        .from(partnerAudits)
        .where(and(inArray(partnerAudits.status, ["findings", "follow_up"]), isNull(partnerAudits.followUpDoneAt), lt(partnerAudits.followUpDueDate, today)));
      const triggers: string[] = [];
      for (const a of overdue) {
        const [o] = await tx.select({ name: outlets.name }).from(outlets).where(eq(outlets.id, a.outletId)).limit(1);
        const row = await recordSanctionTrigger(tx, {
          partnerTenantId: a.tenantId,
          trigger: "audit_overdue",
          key: `audit_overdue:${a.id}`,
          summary: `Temuan audit ${o?.name ?? ""} (${a.scheduledDate}) belum ditindaklanjuti; tenggat ${a.followUpDueDate} lewat ${daysBetween(a.followUpDueDate!, today)} hari.`,
          detail: { auditId: a.id, outletId: a.outletId },
          now,
        });
        if (row) triggers.push(row.id);
      }
      await notifyDueAudits(tx, today, now);
      return { scheduled, triggers };
    },
    opts.db ? { db: opts.db } : {},
  );
}

async function notifyDueAudits(tx: Tx, today: BusinessDate, now: Date) {
  const due = await tx.select().from(partnerAudits).where(and(eq(partnerAudits.status, "scheduled"), lte(partnerAudits.scheduledDate, addDays(today, 3))));
  if (!due.length) return;
  const equa = await ownerTenantId(tx);
  for (const a of due) {
    await notifyOnce(tx, {
      event: "partner.evaluation_due",
      tenantId: equa,
      title: `Audit mutu outlet mitra dijadwalkan ${a.scheduledDate}`,
      body: "Siapkan kunjungan & lembar audit (skor per butir, foto, temuan, tenggat tindak lanjut).",
      objectType: "partner_audit",
      objectId: a.id,
      link: `/kemitraan/mutu?audit=${a.id}`,
      groupKey: `partner.audit_due:${a.id}`,
      now,
    });
  }
}

// =====================================================================================================================
// Kueri & KP-5: bukti mutu per outlet
// =====================================================================================================================

export async function qualityBoard(ctx: ActorContext, input: { month?: string | null; outletId?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.quality_checklist.read", "p3.partner_score.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const month = input.month && /^\d{4}-\d{2}$/.test(input.month) ? input.month : monthKey(ctxBusinessDate(ctx));
  const outletsOut: {
    outletId: string;
    outletName: string;
    tenantId: string;
    tenantName: string;
    compliance: Awaited<ReturnType<typeof checklistCompliance>>;
    score: ScoreRow | null;
    live: Awaited<ReturnType<typeof computeOutletScore>>;
  }[] = [];
  for (const tenant of await partnerTenants(tx)) {
    for (const o of await tenantOutlets(tx, tenant.id, { depotOnly: true })) {
      if (input.outletId && o.id !== input.outletId) continue;
      const [score] = await tx.select().from(partnerScores).where(and(eq(partnerScores.outletId, o.id), eq(partnerScores.period, month))).limit(1);
      outletsOut.push({ outletId: o.id, outletName: o.name, tenantId: tenant.id, tenantName: tenant.name, compliance: await checklistCompliance(tx, o.id, month), score: score ?? null, live: await computeOutletScore(tx, o.id, month) });
    }
  }
  const audits = await tx
    .select({ a: partnerAudits, outletName: outlets.name })
    .from(partnerAudits)
    .innerJoin(outlets, eq(outlets.id, partnerAudits.outletId))
    .where(input.outletId ? eq(partnerAudits.outletId, input.outletId) : undefined)
    .orderBy(desc(partnerAudits.scheduledDate))
    .limit(100);
  const outletIds = outletsOut.map((o) => o.outletId);
  const tests = outletIds.length
    ? await tx.select().from(qualityTests).where(inArray(qualityTests.outletId, outletIds)).orderBy(desc(qualityTests.testDate)).limit(100)
    : [];
  const checklists = outletIds.length
    ? await tx.select().from(qualityChecklists).where(inArray(qualityChecklists.outletId, outletIds)).orderBy(desc(qualityChecklists.businessDate)).limit(60)
    : [];
  return { month, outlets: outletsOut, audits: audits.map((r) => ({ ...r.a, outletName: r.outletName })), tests, checklists };
}

/** KP-5: seluruh bukti mutu satu outlet (daftar periksa + butir, audit, uji lab) — untuk prospektus & audit merek. */
export async function qualityEvidence(tx: Tx, outletId: string) {
  const checklists = await tx.select().from(qualityChecklists).where(eq(qualityChecklists.outletId, outletId)).orderBy(desc(qualityChecklists.businessDate));
  const items = checklists.length ? await tx.select().from(qualityChecklistItems).where(inArray(qualityChecklistItems.checklistId, checklists.map((c) => c.id))) : [];
  const audits = await tx.select().from(partnerAudits).where(eq(partnerAudits.outletId, outletId)).orderBy(desc(partnerAudits.scheduledDate));
  const tests = await tx.select().from(qualityTests).where(eq(qualityTests.outletId, outletId)).orderBy(desc(qualityTests.testDate));
  const scores = await tx.select().from(partnerScores).where(eq(partnerScores.outletId, outletId)).orderBy(desc(partnerScores.period));
  return { checklists: checklists.map((c) => ({ ...c, items: items.filter((i) => i.checklistId === c.id) })), audits, tests, scores };
}

/** Status daftar periksa hari ini per outlet (pull POS mitra). */
export async function todayChecklistStatus(tx: Tx, outletId: string, date: BusinessDate) {
  const [row] = await tx.select().from(qualityChecklists).where(and(eq(qualityChecklists.outletId, outletId), eq(qualityChecklists.businessDate, date))).limit(1);
  const rules = await partnerRules(tx, date);
  return { filled: !!row, passedAll: row?.passedAll ?? null, items: QUALITY_ITEMS.map((k) => ({ key: k, label: label("partner_quality_item", k), photoRequired: rules.quality_photo_items.includes(k) })) };
}
