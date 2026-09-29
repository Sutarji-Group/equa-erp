import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accessLogs, invoices, partnerSanctions, qualityChecklistItems, qualityChecklists, tenants } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { P3_DEMO_TENANT_ID, seedDemoP3Partner } from "@/db/seed/demo-p3-partner";
import { newId } from "@/lib/ids";
import { buildActorContext, setActorResolver } from "@/server/core/actor";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import { recordOfficePayment } from "@/server/modules/m5-receivables";
import {
  createContract,
  listPartners,
  portalDashboard,
  portalHome,
  portalInvoices,
  portalMonthlyReports,
  portalOrders,
  portalQuality,
  portalRoyaltyDetail,
  portalSalesReport,
  portalSanctions,
  portalSupplyReport,
  runSanctionChecks,
  runSubscriptionBilling,
} from "@/server/modules/p3-partner";
import { buildChecklistCommand } from "@/components/p3-partner/checklist-command";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { ensurePeriod } from "../helpers/db-fixtures";
import { JPEG } from "../m5-receivables/helpers";
import { at, disablePhase3, enablePhase3, finance, insertSale, owner, setupPartner, T_OCT1 } from "./helpers";

const ITEMS = ["area_cleanliness", "gallon_washing", "sterilization", "cash_handling", "reservoir"] as const;

describe("US-P3-04 Pembayaran tagihan mitra & portal Tahap 3 (flag)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await ensurePeriod(t.db, "2026-09");
    await ensurePeriod(t.db, "2026-10");
    await ensurePeriod(t.db, "2026-11");
    await enablePhase3();
  });
  afterAll(async () => {
    await disablePhase3();
    setActorResolver(null);
  });

  it("US-P3-04 KP-3 pembayaran transfer (bukti) / tunai ke Admin Keuangan lewat pelunasan M5; tagihan lewat tempo memicu sanksi bertingkat (US-P3-07)", async () => {
    const p = await setupPartner(t.db, { contract: false, creditStatus: "credit", creditLimit: 3_000_000 });
    const res = await createContract(finance(), { tenantId: p.tenantId, customerId: p.customerId, option: "option_a", startDate: "2026-08-01", royaltyPercent: 3, waterDiscountPercent: 5, reason: "Waralaba Opsi A" });
    await approvals.decide(owner(), res.approval.id, "approve", "Setuju");
    await insertSale(t.db, p, { businessDate: "2026-09-11", gallons: 100 });
    const run = await runSubscriptionBilling(T_OCT1);
    const bill = run.issued.find((i) => i.tenantId === p.tenantId)!;
    // Omzet 100 × 5.000 = 500.000 → royalti 3% = 15.000; langganan 150.000.
    expect(bill.amount).toBe(165_000);
    // Transfer wajib bukti (aturan M5), lalu Lunas; mitra melihatnya di portal (tagihan & pembayaran).
    const payDay = at("2026-10-06T03:00:00Z");
    await expect(recordOfficePayment(finance(payDay), { customerId: p.customerId, businessDate: "2026-10-06", amount: 165_000, method: "transfer" })).rejects.toThrow(/Bukti transfer/);
    const proof = await withTx((tx) => put(tx, finance(payDay), { blob: Buffer.from(JPEG), contentType: "image/jpeg", kind: "transfer_proof" }));
    await recordOfficePayment(finance(payDay), { customerId: p.customerId, businessDate: "2026-10-06", amount: 165_000, method: "transfer", proofAttachmentId: proof.id });
    const view = (await portalInvoices(p.portal(payDay))).find((i) => i.id === bill.invoiceId)!;
    expect(view).toMatchObject({ status: "paid", outstandingAmount: 0 });
    expect(view.payments).toEqual([{ businessDate: "2026-10-06", method: "transfer", amount: 165_000 }]);
    expect(view.lines.map((l) => l.component).sort()).toEqual(["royalty", "subscription"]);
    // Mitra lain tidak membayar sampai lewat tempo → pemicu sanksi "tunggakan" (diputuskan pemilik, PTB-59).
    const q = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    await insertSale(t.db, q, { businessDate: "2026-09-12", gallons: 20 });
    await insertSale(t.db, q, { businessDate: "2026-10-20", gallons: 20 });
    const qBill = (await runSubscriptionBilling(T_OCT1)).issued.find((i) => i.tenantId === q.tenantId) ?? (await t.db.select().from(invoices).where(and(eq(invoices.customerId, q.customerId), eq(invoices.kind, "partner_subscription"))))[0];
    expect(qBill).toBeTruthy();
    await runSanctionChecks(at("2026-10-21T00:10:00Z"));
    const trig = await t.db.select().from(partnerSanctions).where(eq(partnerSanctions.tenantId, q.tenantId));
    expect(trig.find((s) => s.trigger === "overdue")).toMatchObject({ status: "triggered", level: "warning" });
    expect((await t.db.select().from(partnerSanctions).where(eq(partnerSanctions.tenantId, p.tenantId))).filter((s) => s.trigger === "overdue")).toHaveLength(0);
    // Dasar royalti tampil ke mitra (portal) — omzet per outlet per hari.
    const roy = await portalRoyaltyDetail(p.portal(payDay), { month: "2026-09" });
    expect(roy[0]).toMatchObject({ royaltyAmount: 15_000, grossSales: 500_000, royaltyPercent: 3 });
    expect(roy[0]!.daily).toEqual([{ outletCode: "M01", businessDate: "2026-09-11", sales: 500_000, transactions: 1 }]);
  });

  it("US-P3-02 KP-2 US-P3-07 KP-1 layar portal Tahap 3 memakai tenant pelaku saja: pesanan, mutu, sanksi (alasan & syarat pemulihan), dashboard", async () => {
    const p = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    const q = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    const now = at("2026-09-15T03:00:00Z");
    const orders = await portalOrders(p.portal(now));
    expect(orders.enabled).toBe(true);
    expect(orders.outlets.map((o) => o.id)).toEqual([p.outletId]);
    expect(orders.catalog.length).toBeGreaterThan(0);
    expect(orders.catalog.every((c) => c.partnerPrice > 0)).toBe(true);
    const quality = await portalQuality(p.portal(now), { month: "2026-09" });
    expect(quality.outlets.map((o) => o.outletId)).toEqual([p.outletId]);
    expect(quality.onboarding.every((v) => v.outletId === p.outletId)).toBe(true);
    const sanctions = await portalSanctions(p.portal(now));
    expect(sanctions).toMatchObject({ enabled: true, readOnly: false, sanctions: [], suspension: null });
    const dash = await portalDashboard(q.portal(now), { month: "2026-09" });
    expect(dash!.tenant.id).toBe(q.tenantId);
    // Pengguna EQUA tidak memakai layanan portal (bukan tenant mitra) → ditolak & tercatat.
    await expect(portalOrders(owner(now))).rejects.toBeInstanceOf(ForbiddenError);
    const denied = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, userIdByUsername("pemilik")), eq(accessLogs.success, false)));
    expect(denied.length).toBeGreaterThan(0);
    // Flag mati → layar Tahap 3 kosong (RL-7 tetap: beranda & laporan).
    await disablePhase3();
    expect((await portalOrders(p.portal(now))).enabled).toBe(false);
    expect(await portalDashboard(p.portal(now), { month: "2026-09" })).toBeNull();
    expect((await portalHome(p.portal(now))).phase3).toBe(false);
    await enablePhase3();
  });

  it("US-P3-05 KP-1 daftar periksa POS: muatan klien + foto per butir lewat jenis lampiran `quality_photo_<butir>` (offline, tanpa ID lampiran)", async () => {
    const photo = { blob: new Blob([new Uint8Array(JPEG)], { type: "image/jpeg" }), capturedAt: new Date("2026-09-15T00:00:00Z") };
    const items = ITEMS.map((key) => ({ key, photoRequired: key === "sterilization" || key === "reservoir" }));
    const pass = (extra: Record<string, unknown> = {}) => ({ result: "pass" as const, actionNote: "", photo: null, ...extra });
    expect(buildChecklistCommand(items, {}, { checklistId: newId() })).toEqual({ error: expect.stringMatching(/semua butir/) });
    const noPhoto = Object.fromEntries(ITEMS.map((k) => [k, pass()]));
    expect(buildChecklistCommand(items, noPhoto, { checklistId: newId() })).toEqual({ error: expect.stringMatching(/foto bukti/) });
    const noAction = { ...noPhoto, sterilization: pass({ photo }), reservoir: { result: "fail" as const, actionNote: "", photo } };
    expect(buildChecklistCommand(items, noAction, { checklistId: newId() })).toEqual({ error: expect.stringMatching(/tindakan/) });
    const ok = buildChecklistCommand(items, { ...noAction, reservoir: { result: "fail" as const, actionNote: "Tandon dikuras ulang", photo } }, { checklistId: newId(), shiftId: null });
    if ("error" in ok) throw new Error(ok.error);
    expect(ok.attachments.map((a) => a.kind)).toEqual(["quality_photo_sterilization", "quality_photo_reservoir"]);
    expect(ok.payload.items.find((i) => i.itemKey === "reservoir")).toEqual({ itemKey: "reservoir", result: "fail", actionNote: "Tandon dikuras ulang" });

    // Server memetakan lampiran perintah ke butir menurut jenisnya (perangkat mitra, idempoten).
    const p = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    const { hp, op } = await p.pos();
    const up1 = await hp.upload(op, { bytes: JPEG, kind: "quality_photo_sterilization" });
    const up2 = await hp.upload(op, { bytes: JPEG, kind: "quality_photo_reservoir" });
    const cmd = hp.command(op, "p3.quality_checklist.submit", ok.payload, { attachmentIds: [up1.attachmentId, up2.attachmentId], attachmentHashes: [up1.sha256, up2.sha256] });
    const res = (await hp.push([cmd])).results[0]!;
    expect(res.status, res.message ?? "").toBe("applied");
    expect((await hp.push([cmd])).results[0]!.status).toBe("duplicate");
    const [row] = await t.db.select().from(qualityChecklists).where(eq(qualityChecklists.id, ok.payload.checklistId));
    expect(row).toMatchObject({ outletId: p.outletId, passedAll: false });
    const itemRows = await t.db.select().from(qualityChecklistItems).where(eq(qualityChecklistItems.checklistId, row!.id));
    expect(itemRows.find((i) => i.itemKey === "sterilization")!.photoAttachmentId).toBe(up1.attachmentId);
    expect(itemRows.find((i) => i.itemKey === "reservoir")!.photoAttachmentId).toBe(up2.attachmentId);
  });
});

describe("US-P3-10 Seed demo kemitraan (portal mitra & layar EQUA tidak kosong)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  afterAll(() => setActorResolver(null));

  it("US-P3-10 KP-2 seed demo idempoten: pemilik mitra melihat penjualan, pasokan, neraca air, tagihan & laporan bulanan tenantnya; EQUA melihat mitra di daftar", async () => {
    const now = at("2026-10-07T03:00:00Z");
    const first = await withTx((tx) => seedDemoP3Partner(tx, now, { force: true }));
    expect(first).toMatchObject({ created: true, invoices: 2 });
    expect(first.sales).toBeGreaterThan(50);
    const again = await withTx((tx) => seedDemoP3Partner(tx, now, { force: true }));
    expect(again.created).toBe(false);
    const [tenant] = await t.db.select().from(tenants).where(eq(tenants.id, P3_DEMO_TENANT_ID));
    expect(tenant).toMatchObject({ kind: "partner", isActive: true });

    const mitra = { ...(await buildActorContext(t.db, userIdByUsername("mitra1"), { source: "partner_portal", now })), now };
    const home = await portalHome(mitra, { month: "2026-09" });
    expect(home.tenant.id).toBe(P3_DEMO_TENANT_ID);
    expect(home.summary.gallons).toBeGreaterThan(1_000);
    expect(home.contract).toMatchObject({ status: "active", option: "option_b", subscriptionFeePerOutlet: 150_000 });
    const sales = await portalSalesReport(mitra, { from: "2026-09-01", to: "2026-09-30" });
    expect(sales.daily).toHaveLength(30);
    const supply = await portalSupplyReport(mitra, { month: "2026-09" });
    expect(supply.supply.length).toBeGreaterThanOrEqual(10);
    expect(supply.balance[0]!.receivedFromEquaL).toBeGreaterThan(0);
    const inv = await portalInvoices(mitra);
    expect(inv.map((i) => i.status).sort()).toEqual(["open", "paid"]);
    expect((await portalMonthlyReports(mitra)).map((r) => r.period)).toEqual(["2026-09"]);
    const partners = await listPartners(owner(now));
    expect(partners.find((r) => r.tenant.id === P3_DEMO_TENANT_ID)).toMatchObject({ openSupport: 1 });
    // Akun pembina demo = web kantor (Pembina wilayah) di tenant EQUA.
    const coach = await buildActorContext(t.db, userIdByUsername("pembina1"), { source: "web", now });
    expect(coach).toMatchObject({ tenantId: EQUA_TENANT_ID, roles: ["regional_coach"] });
  });
});
