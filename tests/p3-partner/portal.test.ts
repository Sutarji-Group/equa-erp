import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accessLogs, notifications, partnerMonthlyReports, users } from "@/db/schema";
import { outletId as seedOutlet } from "@/db/seed";
import { setActorResolver } from "@/server/core/actor";
import { hashPassword, loginWithPassword } from "@/server/core/auth";
import { withTx } from "@/server/core/db";
import { ForbiddenError, NotFoundError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import { permissionsForRoles } from "@/server/core/rbac";
import { dailyOutletReport, postWaterMovement } from "@/server/modules/m6-pos";
import {
  createContract,
  createPortalWaterOrder,
  linkPartnerCustomer,
  portalHome,
  portalInvoice,
  portalInvoices,
  portalMonthlyReports,
  portalOpenTenant,
  portalSalesReport,
  portalSupplyReport,
  runMonthlyReports,
  runSubscriptionBilling,
  supplyBoard,
} from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { ensurePeriod } from "../helpers/db-fixtures";
import { at, finance, insertSale, owner, setupPartner, T_OCT1, type PartnerFixture } from "./helpers";

describe("US-P3-10 Akses baca Pemilik mitra dan laporan bulanan (RL-7)", () => {
  const t = useTestDb({ seed: true });
  let p: PartnerFixture;
  let q: PartnerFixture;
  beforeAll(async () => {
    bootstrapForTests();
    await ensurePeriod(t.db, "2026-10");
    p = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    q = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    await insertSale(t.db, p, { businessDate: "2026-09-05", gallons: 40 });
    await insertSale(t.db, p, { businessDate: "2026-09-06", gallons: 25 });
    await insertSale(t.db, p, { businessDate: "2026-09-06", gallons: 3, status: "voided" });
    await insertSale(t.db, q, { businessDate: "2026-09-05", gallons: 99 });
    await withTx(async (tx) => {
      await postWaterMovement(tx, { tenantId: p.tenantId, outletId: p.outletId, businessDate: "2026-09-02", kind: "supply_in", volumeL: 5_000, occurredAt: at("2026-09-02T03:00:00Z") });
      await postWaterMovement(tx, { tenantId: p.tenantId, outletId: p.outletId, businessDate: "2026-09-06", kind: "sales_out", volumeL: -1_235, occurredAt: at("2026-09-06T10:00:00Z") });
    });
    await runSubscriptionBilling(T_OCT1);
  });
  afterAll(() => setActorResolver(null));

  it("US-P3-10 KP-1 peran Pemilik mitra baca-saja, lingkup tenant sendiri, masuk lewat portal (bukan web kantor); akun aktif setelah persetujuan (US-M10-01 KP-8)", async () => {
    const perms = permissionsForRoles(["partner_owner"]);
    expect(perms.every((x) => /\.(read)$/.test(x) || x === "p3.support_request.create" || x === "m10.support_ticket.create")).toBe(true);
    expect(perms).toContain("p3.partner_report.read");
    // Tulis ditolak: tautan pelanggan, kontrak, pesanan portal (Tahap 3 mati).
    await expect(linkPartnerCustomer(p.portal(), { customerId: p.customerId, tenantId: p.tenantId, outletId: p.outletId, reason: "Mitra mencoba" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createContract(p.portal(), { tenantId: p.tenantId, customerId: p.customerId, startDate: "2026-10-01", reason: "Mitra mencoba" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPortalWaterOrder(p.portal(), { outletId: p.outletId, tankCount: 1, requestedDate: "2026-10-02", paymentMethod: "cash" })).rejects.toBeInstanceOf(ForbiddenError);
    // Login: antarmuka portal diterima, web kantor ditolak; akun Menunggu persetujuan tidak dapat masuk.
    const password = "mitra-uji-2026!";
    await t.db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, p.partnerOwner.userId));
    const ok = await loginWithPassword({ username: p.partnerOwner.username, password }, {}, { interface: "portal" });
    expect(ok.next).toBe("done");
    await expect(loginWithPassword({ username: p.partnerOwner.username, password }, {}, { interface: "web" })).rejects.toMatchObject({ code: "PORTAL_ACCOUNT" });
    await t.db.update(users).set({ status: "pending_approval" }).where(eq(users.id, p.partnerOwner.userId));
    await expect(loginWithPassword({ username: p.partnerOwner.username, password }, {}, { interface: "portal" })).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
    await t.db.update(users).set({ status: "active" }).where(eq(users.id, p.partnerOwner.userId));
  });

  it("US-P3-10 KP-2 laporan: penjualan per hari per outlet, galon, void, selisih shift, pasokan diterima, neraca air versi mitra, tagihan & pembayaran — data sama dengan EQUA (fungsi laporan M6/M5, B-13)", async () => {
    const ctx = p.portal(at("2026-10-02T03:00:00Z"));
    const sales = await portalSalesReport(ctx, { from: "2026-09-01", to: "2026-09-30" });
    const m6 = await dailyOutletReport(ctx, { from: "2026-09-01", to: "2026-09-30" });
    expect(sales.daily).toEqual(m6);
    expect(sales.daily.map((d) => [d.businessDate, d.gallons, d.salesTotal]).sort()).toEqual([
      ["2026-09-05", 40, 200_000],
      ["2026-09-06", 25, 125_000],
    ]);
    expect(sales.daily.every((d) => d.outletId === p.outletId)).toBe(true);
    const supply = await portalSupplyReport(ctx, { month: "2026-09" });
    const equa = await supplyBoard(owner(at("2026-10-02T03:00:00Z")), { month: "2026-09", tenantId: p.tenantId });
    expect(supply.balance).toEqual(equa.rows[0]!.balance);
    expect(supply.balance[0]).toMatchObject({ soldL: 1_235, receivedFromEquaL: 5_000, exceeded: false });
    const inv = await portalInvoices(ctx);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ amount: 150_000, periodMonth: "2026-09-01" });
    expect(inv[0]!.lines[0]).toMatchObject({ component: "subscription", amount: 150_000 });
    const home = await portalHome(ctx, { month: "2026-09" });
    expect(home.summary).toMatchObject({ salesTotal: 325_000, gallons: 65 });
    expect(home.invoices.outstanding).toBe(150_000);
    expect(home.readRights.length).toBe(5);
  });

  it("US-P3-10 KP-3 laporan bulanan mitra terbit otomatis tanggal 5 (sekali per bulan) ke portal & dapat diunduh PDF (US-M9-03)", async () => {
    expect((await runMonthlyReports(at("2026-10-04T00:00:00Z"))).notDue).toBe(true);
    const run = await runMonthlyReports(at("2026-10-05T00:00:00Z"));
    expect(run.month).toBe("2026-09");
    expect(run.published).toEqual(expect.arrayContaining([p.tenantId, q.tenantId]));
    expect((await runMonthlyReports(at("2026-10-06T00:00:00Z"))).published).toHaveLength(0);
    const [rep] = await t.db.select().from(partnerMonthlyReports).where(and(eq(partnerMonthlyReports.tenantId, p.tenantId), eq(partnerMonthlyReports.period, "2026-09")));
    const data = rep!.data as { totals: { salesTotal: number; gallons: number; voidCount: number; invoiced: number }; sla: { total: number }; waterBalance: unknown[] };
    expect(data.totals).toMatchObject({ salesTotal: 325_000, gallons: 65, voidCount: 1, invoiced: 150_000 });
    expect(data.waterBalance).toHaveLength(1);
    expect(data.sla).toMatchObject({ total: 0 });
    const list = await portalMonthlyReports(p.portal());
    expect(list.map((r) => r.period)).toEqual(["2026-09"]);
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.monthly_report_published"), eq(notifications.recipientUserId, p.partnerOwner.userId)));
    expect(notes).toHaveLength(1);
    const pdf = await exportReport(p.portal(at("2026-10-06T03:00:00Z")), "p3.partner_monthly", "pdf", { period: "2026-09" });
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.body.byteLength).toBeGreaterThan(1_000);
  });

  it("US-P3-10 KP-4 uji penetrasi lintas tenant (9.6): tidak ada data mitra lain/EQUA; setiap percobaan ditolak & tercatat di log akses (US-M10-03)", async () => {
    const ctx = p.portal(at("2026-10-02T03:00:00Z"));
    const before = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, p.partnerOwner.userId), eq(accessLogs.success, false)));
    await expect(portalSalesReport(ctx, { outletId: q.outletId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalSupplyReport(ctx, { outletId: q.outletId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalSalesReport(ctx, { outletId: seedOutlet("D01") })).rejects.toBeInstanceOf(ForbiddenError);
    const qInv = await portalInvoices(q.portal(at("2026-10-02T03:00:00Z")));
    await expect(portalInvoice(ctx, qInv[0]!.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalOpenTenant(ctx, q.tenantId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportReport(ctx, "p3.partner_supply", "xlsx", {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(supplyBoard(ctx, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(dailyOutletReport(ctx, { from: "2026-09-01", to: "2026-09-30", outletId: q.outletId })).rejects.toBeInstanceOf(NotFoundError);
    // Semua baris yang terlihat milik tenant sendiri.
    const all = await portalSalesReport(ctx, { from: "2026-09-01", to: "2026-09-30" });
    expect(all.daily.every((d) => d.outletId === p.outletId)).toBe(true);
    expect((await portalInvoices(ctx)).map((i) => i.id)).not.toContain(qInv[0]!.id);
    const after = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, p.partnerOwner.userId), eq(accessLogs.success, false)));
    expect(after.length - before.length).toBeGreaterThanOrEqual(7);
    expect(after.some((l) => l.rule === "NFR-30")).toBe(true);
    void finance;
  });
});
