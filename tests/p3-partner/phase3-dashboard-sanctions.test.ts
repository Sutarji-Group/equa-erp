import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { invoices, notifications, partnerContracts, partnerSanctions, posSales, tenants } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { setActorResolver } from "@/server/core/actor";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { ForbiddenError, ValidationError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import { createOrder } from "@/server/modules/m2-orders";
import { postWaterMovement } from "@/server/modules/m6-pos";
import {
  coachPortfolio,
  createPortalWaterOrder,
  liftSanction,
  listSanctions,
  markPartnerDataExported,
  partnerDashboard,
  partnershipEconomics,
  portalHome,
  proposeSanction,
  recordSanctionTrigger,
  runSanctionChecks,
  runSubscriptionBilling,
  sanctionsOfTenant,
} from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { ensurePeriod, uniqueSeq } from "../helpers/db-fixtures";
import { createTestUser, type TestUser } from "../helpers/factories";
import { at, completeTrip, disablePhase3, dispatcher, enablePhase3, finance, insertOrderTrip, insertSale, owner, setupPartner, T_OCT1, T_SEPT, type PartnerFixture } from "./helpers";

describe("US-P3-06 Dashboard kinerja mitra dan pembina wilayah (Tahap 3, flag)", () => {
  const t = useTestDb({ seed: true });
  let good: PartnerFixture;
  let risky: PartnerFixture;
  let coach: TestUser;
  beforeAll(async () => {
    bootstrapForTests();
    await ensurePeriod(t.db, "2026-10");
    await enablePhase3();
    coach = await createTestUser(t.db, { role: "regional_coach", now: T_SEPT });
    good = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    risky = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    await insertSale(t.db, good, { businessDate: "2026-09-03", gallons: 50 });
    await insertSale(t.db, risky, { businessDate: "2026-09-03", gallons: 200 });
    const { trip } = await insertOrderTrip(t.db, good, { date: "2026-09-04", price: 200_000 });
    await completeTrip(t.db, trip, { volumeL: 5_000, completedAt: at("2026-09-04T04:00:00Z") });
    await withTx(async (tx) => {
      await postWaterMovement(tx, { tenantId: good.tenantId, outletId: good.outletId, businessDate: "2026-09-04", kind: "supply_in", volumeL: 5_000, occurredAt: at("2026-09-04T05:00:00Z") });
      await postWaterMovement(tx, { tenantId: good.tenantId, outletId: good.outletId, businessDate: "2026-09-05", kind: "sales_out", volumeL: -950, occurredAt: at("2026-09-05T10:00:00Z") });
      await postWaterMovement(tx, { tenantId: risky.tenantId, outletId: risky.outletId, businessDate: "2026-09-02", kind: "supply_in", volumeL: 1_000, occurredAt: at("2026-09-02T05:00:00Z") });
      await postWaterMovement(tx, { tenantId: risky.tenantId, outletId: risky.outletId, businessDate: "2026-09-05", kind: "sales_out", volumeL: -3_800, occurredAt: at("2026-09-05T10:00:00Z") });
    });
    await t.db.insert(invoices).values({ tenantId: EQUA_TENANT_ID, number: `F-26-${String(700_000 + uniqueSeq())}`, kind: "partner_subscription", customerId: risky.customerId, periodMonth: "2026-07-01", partnerContractId: risky.contractId, issueDate: "2026-08-01", dueDate: "2026-08-15", amount: 150_000, outstandingAmount: 150_000 });
    await runSubscriptionBilling(T_OCT1);
  });
  afterAll(async () => {
    await disablePhase3();
    setActorResolver(null);
  });

  it("US-P3-06 KP-1 per mitra/outlet per bulan: omzet POS, galon/hari, air dibeli (rit, liter), neraca air merah > PAR-79, spare part, tagihan (terbit, dibayar, lewat tempo), skor, sanksi, evaluasi", async () => {
    const d = await partnerDashboard(owner(at("2026-10-02T03:00:00Z")), { month: "2026-09" });
    const g = d.rows.find((r) => r.tenant.id === good.tenantId)!;
    const r = d.rows.find((x) => x.tenant.id === risky.tenantId)!;
    expect(g).toMatchObject({ salesTotal: 250_000, gallons: 50, waterTrips: 1, waterL: 5_000, waterAmount: 200_000, waterBalanceExceeded: false, contractNumber: expect.any(String), nextEvaluationDate: "2026-11-01" });
    expect(g.outlets[0]!.gallonsPerDay).toBeCloseTo(50 / 30, 1);
    expect(r).toMatchObject({ waterBalanceExceeded: true });
    expect(r.invoices.overdue).toBe(150_000);
    expect(r.invoices.maxOverdueDays).toBeGreaterThan(30);
    expect(d.tolerancePct).toBe(10);
    await expect(partnerDashboard(dispatcher(), {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-P3-06 KP-2 portofolio pembina: peringkat risiko (neraca air, tunggakan, mutu), jadwal audit & kunjungan, temuan terbuka", async () => {
    const pf = await coachPortfolio({ ...coach.ctx, now: at("2026-10-02T03:00:00Z") }, { month: "2026-09" });
    const idx = (id: string) => pf.rows.findIndex((r) => r.metrics.tenant.id === id);
    expect(idx(risky.tenantId)).toBeLessThan(idx(good.tenantId));
    const r = pf.rows[idx(risky.tenantId)]!;
    expect(r.risk).toBe("high");
    expect(r.reasons.join(" ")).toMatch(/Neraca air/);
    expect(pf.rows[idx(good.tenantId)]!.risk).toBe("low");
    expect(Array.isArray(pf.upcomingAudits)).toBe(true);
  });

  it("US-P3-06 KP-3 ekonomi kemitraan untuk pemilik: pendapatan EQUA per mitra (air, spare part, langganan, royalti) vs ilustrasi 9.7; komitmen kapasitas vs ruang K22", async () => {
    await expect(partnershipEconomics({ ...coach.ctx, now: T_OCT1 }, {})).rejects.toBeInstanceOf(ForbiddenError);
    const e = await partnershipEconomics(owner(at("2026-10-02T03:00:00Z")), { month: "2026-09" });
    const g = e.rows.find((r) => r.tenant.id === good.tenantId)!;
    expect(g.revenue).toMatchObject({ water: 200_000, sparePart: 0, royalty: 0 });
    expect(g.illustration).toBe(e.illustration.water_per_month + e.illustration.spare_part_per_month + e.illustration.subscription_per_month + e.illustration.royalty_per_month);
    expect(e.capacity.roomTrips).toBe(57);
    expect(e.capacity.committedTrips).toBeGreaterThan(0);
  });

  it("US-P3-06 KP-4 mitra melihat dashboard outletnya sendiri — data yang sama, sudut pandang berbeda", async () => {
    const home = await portalHome(good.portal(at("2026-10-02T03:00:00Z")), { month: "2026-09" });
    const d = await partnerDashboard(owner(at("2026-10-02T03:00:00Z")), { month: "2026-09" });
    const g = d.rows.find((r) => r.tenant.id === good.tenantId)!;
    expect(home.summary.salesTotal).toBe(g.salesTotal);
    expect(home.summary.gallons).toBe(g.gallons);
    expect(home.waterBalance).toEqual(g.outlets.map((o) => o.balance));
  });

  it("US-P3-06 KP-5 ekspor dashboard (US-M9-03) Excel/PDF", async () => {
    const xlsx = await exportReport(owner(at("2026-10-02T03:00:00Z")), "p3.partner_dashboard", "xlsx", { month: "2026-09" });
    expect(xlsx.body.byteLength).toBeGreaterThan(1_000);
    const pdf = await exportReport(owner(at("2026-10-02T03:00:00Z")), "p3.coach_portfolio", "pdf", { month: "2026-09" });
    expect(pdf.contentType).toBe("application/pdf");
  });
});

describe("US-P3-07 Sanksi bertingkat, pemutusan, dan pelepasan (Tahap 3, flag)", () => {
  const t = useTestDb({ seed: true });
  let p: PartnerFixture;
  let coach: TestUser;
  const coachAt = (now: Date = T_SEPT) => ({ ...coach.ctx, now });
  beforeAll(async () => {
    bootstrapForTests();
    await enablePhase3();
    coach = await createTestUser(t.db, { role: "regional_coach", now: T_SEPT });
    p = await setupPartner(t.db, { activatedOn: "2026-08-01" });
  });
  afterAll(async () => {
    await disablePhase3();
    setActorResolver(null);
  });

  it("US-P3-07 KP-1 pemicu tercatat otomatis (tunggakan, POS tidak dipakai) tetapi sanksi selalu diputuskan pemilik beralasan: teguran bersurat → penghentian pasokan (pesanan air diblokir + alasan & syarat di portal)", async () => {
    await t.db.insert(invoices).values({ tenantId: EQUA_TENANT_ID, number: `F-26-${String(600_000 + uniqueSeq())}`, kind: "partner_subscription", customerId: p.customerId, periodMonth: "2026-07-01", partnerContractId: p.contractId, issueDate: "2026-08-01", dueDate: "2026-08-15", amount: 150_000, outstandingAmount: 150_000 });
    const res = await runSanctionChecks(at("2026-09-10T00:00:00Z"));
    const rows = await t.db.select().from(partnerSanctions).where(eq(partnerSanctions.tenantId, p.tenantId));
    expect(rows.map((r) => r.trigger).sort()).toEqual(["overdue", "pos_unused"]);
    expect(res.triggers.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.status === "triggered" && r.level === "warning")).toBe(true);
    expect((await runSanctionChecks(at("2026-09-11T00:00:00Z"))).triggers.filter((id) => rows.some((r) => r.id === id))).toHaveLength(0);
    const note = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.sanction_triggered"), eq(notifications.tenantId, EQUA_TENANT_ID)));
    expect(note.length).toBeGreaterThan(0);
    const overdue = rows.find((r) => r.trigger === "overdue")!;
    // Bertingkat: tidak boleh langsung pemutusan / penghentian pasokan sebelum teguran.
    await expect(proposeSanction(coachAt(), { sanctionId: overdue.id, level: "termination", reason: "Langsung putus" })).rejects.toBeInstanceOf(ValidationError);
    await expect(proposeSanction(p.portal(), { sanctionId: overdue.id, reason: "Mitra mencoba" })).rejects.toBeInstanceOf(ForbiddenError);
    const w = await proposeSanction(coachAt(), { sanctionId: overdue.id, reason: "Tunggakan langganan Juli lewat 26 hari" });
    await expect(approvals.decide(coachAt(), w.approval.id, "approve", "Pembina memutuskan")).rejects.toThrow();
    await approvals.decide(owner(), w.approval.id, "approve", "Teguran tertulis pertama");
    const [warned] = await t.db.select().from(partnerSanctions).where(eq(partnerSanctions.id, overdue.id));
    expect(warned).toMatchObject({ status: "active", level: "warning", decisionReason: "Teguran tertulis pertama" });
    expect((warned!.triggerDetail as { letterText: string }).letterText).toMatch(/SURAT TEGURAN TERTULIS — Kemitraan Depot EQUA/);
    // Tahap berikutnya: penghentian pasokan wajib syarat pemulihan.
    const pos = rows.find((r) => r.trigger === "pos_unused")!;
    await expect(proposeSanction(coachAt(), { sanctionId: pos.id, level: "supply_suspension", reason: "Tunggakan berlanjut" })).rejects.toThrow(/syarat pemulihan/);
    const s = await proposeSanction(coachAt(), { sanctionId: pos.id, level: "supply_suspension", reason: "Tunggakan berlanjut & POS tidak dipakai", recoveryConditions: "Lunasi faktur Juli dan pakai POS setiap hari" });
    await approvals.decide(owner(), s.approval.id, "approve", "Penghentian pasokan sementara");
    await expect(createPortalWaterOrder(p.portal(), { outletId: p.outletId, tankCount: 1, requestedDate: "2026-09-12", paymentMethod: "cash" })).rejects.toThrow(/Lunasi faktur Juli dan pakai POS setiap hari/);
    await expect(createOrder(dispatcher(), { customerId: p.customerId, addressId: p.addressId, tankCount: 1, requestedDate: "2026-09-12", paymentMethod: "cash" })).rejects.toThrow(/penghentian pasokan/);
    const portalView = await withTx((tx) => sanctionsOfTenant(tx, p.tenantId));
    expect(portalView.find((x) => x.level === "supply_suspension")!.detail.recoveryConditions).toBe("Lunasi faktur Juli dan pakai POS setiap hari");
  });

  it("US-P3-07 KP-3 seluruh tahap tampil di riwayat & dashboard pembina; sanksi yang dicabut tercatat dengan alasan", async () => {
    const list = await listSanctions(coachAt(), { tenantId: p.tenantId });
    expect(list.map((s) => s.status)).toEqual(expect.arrayContaining(["active", "active"]));
    const suspension = list.find((s) => s.level === "supply_suspension")!;
    await expect(liftSanction(coachAt(), { sanctionId: suspension.id, reason: "Pembina mencabut" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(liftSanction(owner(), { sanctionId: suspension.id, reason: "Pendek" })).rejects.toBeInstanceOf(ValidationError);
    const lifted = await liftSanction(owner(at("2026-09-15T03:00:00Z")), { sanctionId: suspension.id, reason: "Tunggakan lunas dan POS dipakai kembali" });
    expect(lifted).toMatchObject({ status: "lifted", liftReason: "Tunggakan lunas dan POS dipakai kembali" });
    const ok = await createPortalWaterOrder(p.portal(at("2026-09-15T03:00:00Z")), { outletId: p.outletId, tankCount: 1, requestedDate: "2026-09-16", paymentMethod: "cash" });
    expect(ok.status).toBe("created");
    const pf = await coachPortfolio(coachAt(at("2026-09-15T03:00:00Z")), {});
    expect(pf.rows.find((r) => r.metrics.tenant.id === p.tenantId)!.metrics.activeSanctions.length).toBe(1);
  });

  it("US-P3-07 KP-2 pemutusan: tenant nonaktif pada tanggal berakhir; ekspor data outlet ke mitra ≤ 30 hari (PTB-58); data tetap tersimpan", async () => {
    await insertSale(t.db, p, { businessDate: "2026-09-16", gallons: 10 });
    const salesBefore = await t.db.select().from(posSales).where(eq(posSales.tenantId, p.tenantId));
    const trig = await withTx((tx) => recordSanctionTrigger(tx, { partnerTenantId: p.tenantId, trigger: "water_balance", key: `wb:${p.outletId}:2026-09`, summary: "Neraca air merah 3 bulan berturut", now: at("2026-09-20T00:00:00Z") }));
    expect(trig!.level).toBe("supply_suspension");
    await expect(proposeSanction(coachAt(), { sanctionId: trig!.id, level: "termination", reason: "Memakai sumber lain" })).rejects.toBeInstanceOf(ValidationError);
    const sup = await proposeSanction(coachAt(), { sanctionId: trig!.id, level: "supply_suspension", reason: "Neraca air merah berulang", recoveryConditions: "Beli air hanya dari EQUA" });
    await approvals.decide(owner(), sup.approval.id, "approve", "Penghentian pasokan");
    const term = await proposeSanction(coachAt(at("2026-09-25T03:00:00Z")), { tenantId: p.tenantId, level: "termination", reason: "Pelanggaran berulang setelah penghentian pasokan", effectiveDate: "2026-09-30" });
    await approvals.decide(owner(at("2026-09-25T04:00:00Z")), term.approval.id, "approve", "Pemutusan kemitraan");
    const [c] = await t.db.select().from(partnerContracts).where(eq(partnerContracts.id, p.contractId!));
    expect(c).toMatchObject({ status: "terminated", endDate: "2026-09-30", dataExportDueDate: "2026-10-30" });
    expect((await t.db.select().from(tenants).where(eq(tenants.id, p.tenantId)))[0]!.isActive).toBe(true);
    const job = await runSanctionChecks(at("2026-09-30T00:05:00Z"));
    expect(job.deactivated).toContain(p.tenantId);
    expect((await t.db.select().from(tenants).where(eq(tenants.id, p.tenantId)))[0]!.isActive).toBe(false);
    const dueJob = await runSanctionChecks(at("2026-10-24T00:05:00Z"));
    expect(dueJob.exportsDue).toContain(p.contractId);
    await expect(exportReport(coachAt(), "p3.partner_data_export", "xlsx", { tenantId: p.tenantId })).rejects.toBeInstanceOf(ForbiddenError);
    const file = await exportReport(owner(at("2026-10-01T03:00:00Z")), "p3.partner_data_export", "xlsx", { tenantId: p.tenantId }, "Serah data ke mitra (PTB-58)");
    expect(file.body.byteLength).toBeGreaterThan(1_000);
    const marked = await markPartnerDataExported(owner(at("2026-10-01T03:00:00Z")), { tenantId: p.tenantId });
    expect(marked.contractId).toBe(p.contractId);
    expect(await t.db.select().from(posSales).where(eq(posSales.tenantId, p.tenantId))).toHaveLength(salesBefore.length);
    const termination = (await listSanctions(owner(), { tenantId: p.tenantId })).find((s) => s.level === "termination")!;
    await expect(liftSanction(owner(), { sanctionId: termination.id, reason: "Coba cabut pemutusan" })).rejects.toThrow(/kontrak baru/);
    void finance;
  });
});
