import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accessLogs, notifications, partnerSupportRequests, posSales, shifts, userRoles } from "@/db/schema";
import { EQUA_TENANT_ID, outletId as seedOutlet, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { setActorResolver } from "@/server/core/actor";
import { query as auditQuery } from "@/server/core/audit";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { DomainError, ForbiddenError, ValidationError } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import {
  buildMonthlyReportData,
  completeSupportRequest,
  getSupportRequest,
  linkSupportSparePart,
  listSupportRequests,
  respondSupportRequest,
  runSupportSlaCheck,
  submitSupportRequest,
  supportSlaSummary,
} from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { uniqueSeq } from "../helpers/db-fixtures";
import { createTestUser, type TestUser } from "../helpers/factories";
import { JPEG } from "../m5-receivables/helpers";
import { at, setupPartner, type PartnerFixture } from "./helpers";

describe("US-P3-11 Permintaan dukungan teknis mitra dengan SLA 48 jam (RL-7, S)", () => {
  const t = useTestDb({ seed: true });
  let p: PartnerFixture;
  let q: PartnerFixture;
  let coach: TestUser;
  const T0 = at("2026-09-15T02:00:00Z");
  beforeAll(async () => {
    bootstrapForTests();
    p = await setupPartner(t.db);
    q = await setupPartner(t.db);
    coach = await createTestUser(t.db, { role: "regional_coach" });
  });
  afterAll(() => setActorResolver(null));

  it("US-P3-11 KP-1 permintaan (jenis, uraian, foto, outlet): Diajukan → Ditanggapi → Selesai dengan waktu tiap perubahan; lintas tenant ditolak & tercatat", async () => {
    const photo = await withTx((tx) => put(tx, { ...systemContext({ tenantId: p.tenantId, now: T0 }), userId: p.partnerOwner.userId }, { blob: JPEG, contentType: "image/jpeg", kind: "support_photo" }));
    const req = await submitSupportRequest(p.portal(T0), { outletId: p.outletId, kind: "equipment", description: "Pompa filter bocor, tekanan air turun", photoAttachmentId: photo.id });
    expect(req).toMatchObject({ tenantId: p.tenantId, status: "submitted", kind: "equipment", photoAttachmentId: photo.id });
    expect(req.slaDueAt!.getTime() - req.submittedAt.getTime()).toBe(48 * 3_600_000);
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.support_submitted"), eq(notifications.objectId, req.id)));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.tenantId === EQUA_TENANT_ID)).toBe(true);
    // Pemilik mitra tidak dapat menanggapi; outlet mitra lain ditolak & tercatat.
    await expect(respondSupportRequest(p.portal(T0), { requestId: req.id, response: "Menanggapi sendiri" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitSupportRequest(p.portal(T0), { outletId: q.outletId, kind: "system", description: "Mencoba outlet mitra lain" })).rejects.toBeInstanceOf(ForbiddenError);
    const denied = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, p.partnerOwner.userId), eq(accessLogs.objectId, q.outletId)));
    expect(denied.length).toBeGreaterThan(0);
    await expect(completeSupportRequest(p.portal(T0), { requestId: req.id })).rejects.toBeInstanceOf(DomainError);
    const T1 = at("2026-09-15T08:00:00Z");
    const responded = await respondSupportRequest({ ...coach.ctx, now: T1 }, { requestId: req.id, response: "Teknisi datang besok pagi membawa seal pompa" });
    expect(responded).toMatchObject({ status: "responded", slaBreached: false });
    expect(responded.respondedAt!.toISOString()).toBe(T1.toISOString());
    const T2 = at("2026-09-16T05:00:00Z");
    const done = await completeSupportRequest(p.portal(T2), { requestId: req.id, note: "Sudah diganti, normal" });
    expect(done.status).toBe("done");
    expect(done.doneAt!.toISOString()).toBe(T2.toISOString());
    const view = await getSupportRequest({ ...coach.ctx, now: T2 }, req.id);
    expect(view).toMatchObject({ responseHours: 6, slaStatus: "on_time" });
    const trail = await withTx((tx) => auditQuery(tx, { objectType: "partner_support_request", objectId: req.id }));
    expect(trail.map((r) => r.action)).toEqual(expect.arrayContaining(["create", "respond", "complete"]));
    // Mitra lain tidak melihat permintaan ini.
    expect((await listSupportRequests(q.portal(T2))).map((r) => r.id)).not.toContain(req.id);
    await expect(getSupportRequest(q.portal(T2), req.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-P3-11 KP-2 lewat 48 jam (PAR-76) tanpa tanggapan → notifikasi pemilik (sekali); ringkasan kepatuhan SLA bulanan masuk laporan bulanan mitra", async () => {
    const late = await submitSupportRequest(q.portal(T0), { outletId: q.outletId, kind: "water_quality", description: "Air berbau setelah ganti filter" });
    const onTime = await submitSupportRequest(q.portal(T0), { outletId: q.outletId, kind: "system", description: "Tablet POS tidak bisa sinkron" });
    await respondSupportRequest({ ...coach.ctx, now: at("2026-09-15T10:00:00Z") }, { requestId: onTime.id, response: "Sudah dipulihkan jarak jauh" });
    expect((await runSupportSlaCheck(at("2026-09-17T01:00:00Z"))).flagged).not.toContain(late.id);
    const res = await runSupportSlaCheck(at("2026-09-17T03:00:00Z"));
    expect(res.flagged).toContain(late.id);
    expect((await runSupportSlaCheck(at("2026-09-17T04:00:00Z"))).flagged).not.toContain(late.id);
    const [row] = await t.db.select().from(partnerSupportRequests).where(eq(partnerSupportRequests.id, late.id));
    expect(row!.slaBreached).toBe(true);
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.support_sla"), eq(notifications.objectId, late.id)));
    const ownerIds = (await t.db.select().from(userRoles).where(eq(userRoles.role, "owner"))).map((r) => r.userId);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => ownerIds.includes(n.recipientUserId!))).toBe(true);
    const summary = await withTx((tx) => supportSlaSummary(tx, q.tenantId, "2026-09", at("2026-09-30T10:00:00Z")));
    expect(summary).toMatchObject({ total: 2, responded: 1, respondedOnTime: 1, late: 1, compliancePct: 50, slaHours: 48 });
    const report = await withTx((tx) => buildMonthlyReportData(tx, q.tenantId, "2026-09", at("2026-10-05T00:00:00Z")));
    expect(report.sla).toMatchObject({ total: 2, late: 1, compliancePct: 50 });
  });

  it("US-P3-11 KP-3 spare part yang dibutuhkan dipesan lewat M7 harga mitra (BR-18) dan dirujuk dari permintaan", async () => {
    const req = await submitSupportRequest(p.portal(T0), { outletId: p.outletId, kind: "spare_part", description: "Butuh lampu UV pengganti" });
    const store = seedOutlet("TK1");
    const [shift] = await t.db
      .insert(shifts)
      .values({ tenantId: EQUA_TENANT_ID, outletId: store, operatorUserId: userIdByUsername("kasir"), businessDate: "2026-09-15", status: "closed", openedAt: T0, closedAt: T0, openingCashFixed: 200_000 })
      .returning();
    const sale = async (priceKind: "partner" | "general") =>
      (
        await t.db
          .insert(posSales)
          .values({ tenantId: EQUA_TENANT_ID, outletId: store, shiftId: shift!.id, number: `TK1-260915-${String(uniqueSeq()).padStart(4, "0")}`, localNumber: `L-${newId()}`, deviceSeq: uniqueSeq(), operatorUserId: userIdByUsername("kasir"), customerId: p.customerId, priceKind, businessDate: "2026-09-15", soldAt: T0, subtotal: 135_000, total: 135_000, paymentMethod: "cash", cashReceived: 135_000, changeAmount: 0 })
          .returning()
      )[0]!;
    const general = await sale("general");
    await expect(linkSupportSparePart({ ...coach.ctx, now: T0 }, { requestId: req.id, posSaleId: general.id })).rejects.toBeInstanceOf(ValidationError);
    const partner = await sale("partner");
    await expect(linkSupportSparePart(p.portal(T0), { requestId: req.id, posSaleId: partner.id })).rejects.toBeInstanceOf(ForbiddenError);
    const linked = await linkSupportSparePart({ ...coach.ctx, now: T0 }, { requestId: req.id, posSaleId: partner.id });
    expect(linked.relatedPosSaleId).toBe(partner.id);
    const view = await getSupportRequest(p.portal(T0), req.id);
    expect(view.sale).toMatchObject({ id: partner.id, total: 135_000 });
  });
});
