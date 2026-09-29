import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { employees, notifications, partnerAudits, partnerSanctions, partnerScores, qualityChecklists, qualityTests, shifts } from "@/db/schema";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import { setActorResolver } from "@/server/core/actor";
import { withTx } from "@/server/core/db";
import { ForbiddenError, ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import {
  checklistCompliance,
  closeAuditFollowUp,
  computeOutletScore,
  conductAudit,
  createPortalWaterOrder,
  qualityEvidence,
  recordPartnerQualityTest,
  runAuditChecks,
  runQualityMonthly,
} from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createTestUser, type TestUser } from "../helpers/factories";
import { JPEG, PDF } from "../m5-receivables/helpers";
import { at, disablePhase3, enablePhase3, owner, setupPartner, T_SEPT, type PartnerFixture } from "./helpers";

const ITEMS = ["area_cleanliness", "gallon_washing", "sterilization", "cash_handling", "reservoir"] as const;

describe("US-P3-05 Standar mutu: daftar periksa harian, jadwal audit, hasil uji air (Tahap 3, flag)", () => {
  const t = useTestDb({ seed: true });
  let p: PartnerFixture;
  let coach: TestUser;
  const coachAt = (now: Date) => ({ ...coach.ctx, now });
  beforeAll(async () => {
    bootstrapForTests();
    p = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    coach = await createTestUser(t.db, { role: "regional_coach", now: T_SEPT });
  });
  afterAll(async () => {
    await disablePhase3();
    setActorResolver(null);
  });

  it("US-P3-05 KP-1 daftar periksa harian di POS saat buka shift (offline, idempoten): butir SOP, foto bukti butir tertentu, butir tidak lulus wajib tindakan; kepatuhan per outlet per bulan", async () => {
    const { hp, op } = await p.pos();
    const today = toBusinessDate(new Date());
    const items = (over: Partial<Record<(typeof ITEMS)[number], { result: "pass" | "fail"; actionNote?: string; photoAttachmentId?: string }>> = {}) =>
      ITEMS.map((k) => ({ itemKey: k, result: "pass" as const, ...(over[k] ?? {}) }));
    const send = async (payload: unknown, opts: { attachmentIds?: string[]; attachmentHashes?: string[]; id?: string } = {}) => (await hp.push([hp.command(op, "p3.quality_checklist.submit", payload, opts)])).results[0]!;
    // Flag mati → ditolak final.
    const off = await send({ checklistId: newId(), items: items() });
    expect(off.status).toBe("rejected");
    await enablePhase3();
    const missing = await send({ checklistId: newId(), items: items().slice(0, 3) });
    expect(missing.status).toBe("rejected");
    expect(missing.message).toMatch(/belum diisi/);
    const noPhoto = await send({ checklistId: newId(), items: items() });
    expect(noPhoto.message).toMatch(/wajib foto/);
    const up1 = await hp.upload(op, { bytes: JPEG, kind: "quality_photo" });
    const up2 = await hp.upload(op, { bytes: JPEG, kind: "quality_photo" });
    const noAction = await send({ checklistId: newId(), items: items({ sterilization: { result: "pass", photoAttachmentId: up1.attachmentId }, reservoir: { result: "fail", photoAttachmentId: up2.attachmentId } }) }, { attachmentIds: [up1.attachmentId, up2.attachmentId], attachmentHashes: [up1.sha256, up2.sha256] });
    expect(noAction.message).toMatch(/tindakan/);
    const checklistId = newId();
    const payload = { checklistId, items: items({ sterilization: { result: "pass", photoAttachmentId: up1.attachmentId }, reservoir: { result: "fail", actionNote: "Tandon dikuras & disikat ulang", photoAttachmentId: up2.attachmentId } }) };
    const cmd = hp.command(op, "p3.quality_checklist.submit", payload, { attachmentIds: [up1.attachmentId, up2.attachmentId], attachmentHashes: [up1.sha256, up2.sha256] });
    const ok = (await hp.push([cmd])).results[0]!;
    expect(ok.status, ok.message ?? "").toBe("applied");
    expect((await hp.push([cmd])).results[0]!.status).toBe("duplicate");
    const up3 = await hp.upload(op, { bytes: JPEG, kind: "quality_photo" });
    const up4 = await hp.upload(op, { bytes: JPEG, kind: "quality_photo" });
    const second = await send({ checklistId: newId(), items: items({ sterilization: { result: "pass", photoAttachmentId: up3.attachmentId }, reservoir: { result: "pass", photoAttachmentId: up4.attachmentId } }) }, { attachmentIds: [up3.attachmentId, up4.attachmentId], attachmentHashes: [up3.sha256, up4.sha256] });
    expect(second.status, second.message ?? "").toBe("conflict");
    const [row] = await t.db.select().from(qualityChecklists).where(eq(qualityChecklists.id, checklistId));
    expect(row).toMatchObject({ tenantId: p.tenantId, outletId: p.outletId, businessDate: today, passedAll: false });
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.quality_failed"), eq(notifications.objectId, checklistId)));
    expect(notes.some((n) => n.recipientUserId === coach.userId)).toBe(true);
    await t.db.insert(shifts).values({ tenantId: p.tenantId, outletId: p.outletId, operatorUserId: p.operator.userId, businessDate: today, status: "closed", openedAt: new Date(), closedAt: new Date(), openingCashFixed: 200_000 });
    const comp = await withTx((tx) => checklistCompliance(tx, p.outletId, today.slice(0, 7)));
    expect(comp).toMatchObject({ filledDays: 1, compliancePct: 100, passRatePct: 0 });
  });

  it("US-P3-05 KP-2 jadwal audit pembina per outlet (bulanan) + lembar audit: skor per butir, foto, temuan, tenggat; temuan lewat tenggat → pemicu sanksi", async () => {
    const run = await runAuditChecks(at("2026-09-10T00:20:00Z"));
    const [audit] = await t.db.select().from(partnerAudits).where(eq(partnerAudits.outletId, p.outletId));
    expect(run.scheduled).toContain(audit!.id);
    expect(audit).toMatchObject({ status: "scheduled", scheduledDate: "2026-09-10" });
    expect((await runAuditChecks(at("2026-09-11T00:20:00Z"))).scheduled).not.toContain(audit!.id);
    await expect(conductAudit(p.portal(), { auditId: audit!.id, items: [{ key: "a", label: "Kebersihan", score: 90 }] })).rejects.toBeInstanceOf(ForbiddenError);
    const done = await conductAudit(coachAt(at("2026-09-12T03:00:00Z")), {
      auditId: audit!.id,
      items: [
        { key: "clean", label: "Kebersihan area", score: 80 },
        { key: "uv", label: "Lampu UV berfungsi", score: 60 },
      ],
      findings: [{ text: "Lampu UV redup, perlu diganti" }],
    });
    expect(done).toMatchObject({ status: "findings", score: 70, followUpDueDate: "2026-09-26" });
    const late = await runAuditChecks(at("2026-09-27T00:20:00Z"));
    expect(late.triggers.length).toBe(1);
    const [trig] = await t.db.select().from(partnerSanctions).where(and(eq(partnerSanctions.tenantId, p.tenantId), eq(partnerSanctions.trigger, "audit_overdue")));
    expect(trig).toMatchObject({ status: "triggered", level: "warning" });
    const closed = await closeAuditFollowUp(coachAt(at("2026-09-28T03:00:00Z")), { auditId: audit!.id, note: "Lampu UV sudah diganti (nota toko)" });
    expect(closed.status).toBe("closed");
  });

  it("US-P3-05 KP-3 uji air lab per outlet (US-M8-06): tidak lulus → tidak diblokir, tindakan wajib + notifikasi pemilik; dua kali tidak lulus berturut → pemicu sanksi", async () => {
    const base = { outletId: p.outletId, laboratory: "Labkesda Cianjur", certificate: { blob: PDF, contentType: "application/pdf", name: "hasil.pdf" } };
    const fail = { results: [{ parameter: "Total coliform", value: "12", unit: "CFU/100 mL", limit: "0", passed: false }], passed: false };
    await expect(recordPartnerQualityTest(coachAt(at("2026-09-15T03:00:00Z")), { ...base, ...fail, testDate: "2026-09-14" })).rejects.toBeInstanceOf(ValidationError);
    const first = await recordPartnerQualityTest(coachAt(at("2026-09-15T03:00:00Z")), { ...base, ...fail, testDate: "2026-09-14", action: { description: "Ganti filter & sterilisasi ulang", dueDate: "2026-09-18" } });
    expect(first).toMatchObject({ tenantId: p.tenantId, outletId: p.outletId, passed: false, actionRequired: "Ganti filter & sterilisasi ulang" });
    const [ownerEmp] = await t.db.select().from(employees).where(eq(employees.id, first.actionOwnerEmployeeId!));
    expect(ownerEmp!.tenantId).toBe(p.tenantId);
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.quality_failed"), eq(notifications.objectId, first.id)));
    expect(notes.length).toBeGreaterThan(0);
    // Tidak memblokir pasokan: pesanan air tetap dapat dibuat.
    const order = await createPortalWaterOrder(p.portal(at("2026-09-15T03:00:00Z")), { outletId: p.outletId, tankCount: 1, requestedDate: "2026-09-16", paymentMethod: "cash" });
    expect(order.status).toBe("created");
    expect(await t.db.select().from(partnerSanctions).where(and(eq(partnerSanctions.tenantId, p.tenantId), eq(partnerSanctions.trigger, "test_failed")))).toHaveLength(0);
    await recordPartnerQualityTest(coachAt(at("2026-09-20T03:00:00Z")), { ...base, ...fail, testDate: "2026-09-19", action: { description: "Kuras tandon", dueDate: "2026-09-22" } });
    const trig = await t.db.select().from(partnerSanctions).where(and(eq(partnerSanctions.tenantId, p.tenantId), eq(partnerSanctions.trigger, "test_failed")));
    expect(trig).toHaveLength(1);
    const pass = await recordPartnerQualityTest(coachAt(at("2026-09-25T03:00:00Z")), { ...base, testDate: "2026-09-24", results: [{ parameter: "Total coliform", value: "0", unit: "CFU/100 mL", limit: "0", passed: true }], passed: true });
    expect(pass.passed).toBe(true);
    expect((await t.db.select().from(qualityTests).where(eq(qualityTests.outletId, p.outletId))).length).toBe(3);
  });

  it("US-P3-05 KP-4 skor mutu bulanan = gabungan berbobot (bobot ditetapkan pemilik) daftar periksa/audit/uji; di bawah PAR-80 → pemicu teguran", async () => {
    const live = await withTx((tx) => computeOutletScore(tx, p.outletId, "2026-09"));
    expect(live).toMatchObject({ auditScore: 70, testScore: 33.33, weights: { checklist: 30, audit: 40, test: 30 }, threshold: 80, belowThreshold: true });
    const res = await runQualityMonthly(at("2026-10-01T00:10:00Z"));
    expect(res.month).toBe("2026-09");
    const [score] = await t.db.select().from(partnerScores).where(and(eq(partnerScores.outletId, p.outletId), eq(partnerScores.period, "2026-09")));
    expect(score).toMatchObject({ belowThreshold: true, auditScore: 70 });
    const trig = await t.db.select().from(partnerSanctions).where(and(eq(partnerSanctions.tenantId, p.tenantId), eq(partnerSanctions.trigger, "low_score")));
    expect(trig).toHaveLength(1);
    // Bobot pemilik: hanya audit → skor = 70.
    await params.set(owner(at("2026-09-10T03:00:00Z")), "p3.quality_weights", { checklist: 0, audit: 100, test: 0 }, "2026-09-10", "Fokus audit pembina");
    const audited = await withTx((tx) => computeOutletScore(tx, p.outletId, "2026-09"));
    expect(audited.totalScore).toBe(70);
  });

  it("US-P3-05 KP-5 seluruh bukti mutu tersimpan per outlet (daftar periksa + butir + foto, audit, uji lab, skor)", async () => {
    const ev = await withTx((tx) => qualityEvidence(tx, p.outletId));
    expect(ev.checklists.length).toBe(1);
    expect(ev.checklists[0]!.items).toHaveLength(5);
    expect(ev.checklists[0]!.items.filter((i) => i.photoAttachmentId)).toHaveLength(2);
    expect(ev.audits.length).toBeGreaterThanOrEqual(1);
    expect(ev.tests).toHaveLength(3);
    expect(ev.scores.map((s) => s.period)).toContain("2026-09");
    expect(ev.tests.every((x) => x.certificateAttachmentId)).toBe(true);
  });
});
