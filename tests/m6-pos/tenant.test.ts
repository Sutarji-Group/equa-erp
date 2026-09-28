import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as exportRoute } from "@/app/api/export/[report]/route";
import { GET as pullRoute } from "@/app/api/sync/pull/route";
import { depotRecipes, outlets, posSales, productPrices, products, shifts, tenants } from "@/db/schema";
import { EQUA_TENANT_ID, outletId } from "@/db/seed";
import type { CatalogRef, PosReference } from "@/client/m6-pos/contract";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import { setActorResolver } from "@/server/core/actor";
import { signDeviceToken } from "@/server/core/auth";
import { ForbiddenError, NotFoundError } from "@/server/core/errors";
import {
  createPartnerTenant,
  dailyOutletReport,
  getOutletDetail,
  getShiftDetail,
  listOutletsOverview,
  listTenants,
  setOutletThreshold,
  updateOutletPosSettings,
} from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";
import { admin, closeVia, expectApplied, isi, makeTestTenant, openShiftVia, owner, P, posFor, sellVia, type Pos, type TestTenant } from "./helpers";

describe("US-M6-07 Paket standar multi-tenant", () => {
  const t = useTestDb({ seed: true });
  let mitra: TestTenant;
  let mitraPos: Pos;
  let equaPos: Pos;
  let equaShift: string;
  let equaSale: string;
  let mitraShift: string;
  let mitraSale: string;
  beforeAll(() => bootstrapForTests());
  afterAll(() => setActorResolver(null));

  it("US-M6-07 KP-1 admin sistem membuat tenant mitra baru dengan katalog standar EQUA (produk, harga, resep) tersalin — seketika tanpa rilis aplikasi", async () => {
    await expect(createPartnerTenant(owner(), { code: "X", name: "Mitra X", outlets: [{ code: "M01", name: "Depot X" }], reason: "Uji izin" })).rejects.toBeInstanceOf(ForbiddenError);
    const started = Date.now();
    mitra = await makeTestTenant(t.db, async (code) => {
      const res = await createPartnerTenant(admin(), {
        code,
        name: "Mitra Depot Uji",
        outlets: [{ code: "M01", name: "Depot Mitra Uji Cipanas", storageCapacityL: 3_000 }],
        reason: "Perjanjian kemitraan uji UAT (tenant fiktif)",
      });
      expect(res.copied).toEqual({ products: 6, prices: 5, recipes: 6 });
      return { tenantId: res.tenant.id, outletId: res.outlets[0]!.id, outletCode: "M01" };
    });
    expect(Date.now() - started).toBeLessThan(60 * 60 * 1000);
    const [tenant] = await t.db.select().from(tenants).where(eq(tenants.id, mitra.tenantId));
    expect(tenant).toMatchObject({ kind: "partner", code: "UJI" });
    const copied = await t.db.select().from(products).where(eq(products.tenantId, mitra.tenantId));
    expect(copied.every((p) => p.sourceProductId !== null && p.line === "depot")).toBe(true);
    const prices = await t.db.select().from(productPrices).where(eq(productPrices.tenantId, mitra.tenantId));
    expect(prices.every((p) => p.recommendedPrice === p.price && p.status === "active")).toBe(true);
    expect(await t.db.select().from(depotRecipes).where(eq(depotRecipes.tenantId, mitra.tenantId))).toHaveLength(6);
    await expect(createPartnerTenant(admin(), { code: "UJI", name: "Ganda", outlets: [{ code: "M01", name: "Depot" }], reason: "Kode ganda" })).rejects.toThrow(/sudah dipakai/);
    expect((await listTenants(admin())).map((x) => x.code)).toEqual(expect.arrayContaining(["EQUA", "UJI"]));
    // Operator mitra langsung dapat bekerja dengan aplikasi POS yang sama.
    mitraPos = await mitra.pos();
    const pull = await mitraPos.hp.pull(mitraPos.op, { keys: "m1.catalog,m6.pos" });
    const catalog = pull.data["m1.catalog"] as CatalogRef;
    expect(catalog.products.find((p) => p.code === "ISI-ULANG")?.prices.standard).toBe(5_000);
    const opened = await openShiftVia(mitraPos);
    expectApplied(opened.res);
    mitraShift = opened.shiftId;
    const isiMitra = catalog.products.find((p) => p.code === "ISI-ULANG")!.id;
    const sale = await sellVia(mitraPos, mitraShift, [{ productId: isiMitra, quantity: 2, unitPrice: 5_000 }]);
    expectApplied(sale.res);
    mitraSale = sale.saleId;
    expect((sale.res.result as { number: string }).number).toMatch(/^M01-\d{6}-0001$/);
  });

  it("US-M6-07 KP-2 data transaksi, shift, stok & pengguna terpisah per tenant; tidak ada tampilan/pencarian/ekspor lintas tenant dari POS", async () => {
    equaPos = await posFor("D04");
    const o = await openShiftVia(equaPos);
    equaShift = o.shiftId;
    equaSale = (await sellVia(equaPos, equaShift, [isi(1)])).saleId;
    const equaOverview = await listOutletsOverview(owner());
    expect(equaOverview.rows.some((r) => r.outlet.id === mitra.outletId)).toBe(false);
    const mitraOverview = await listOutletsOverview(mitra.owner.ctx);
    expect(mitraOverview.rows.map((r) => r.outlet.id)).toEqual([mitra.outletId]);
    // Operator EQUA tidak dapat masuk di perangkat mitra (pengguna per tenant).
    const hp = mitraPos.hp;
    await expect(hp.login("depot04")).rejects.toThrow();
    const ref = (await mitraPos.hp.pull(mitraPos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref.outlet?.tenantId).toBe(mitra.tenantId);
    expect(ref.openShift!.sales.map((s) => s.id)).toEqual([mitraSale]);
  });

  it("US-M6-07 KP-3 pengaturan per tenant/outlet tanpa kode: kas awal tetap, QRIS, printer, ambang void & kas", async () => {
    await expect(updateOutletPosSettings(seededContext("depot04"), { outletId: outletId("D04"), fixedOpeningCash: 1, qrisEnabled: true, printerEnabled: false, reason: "Coba ubah" })).rejects.toBeInstanceOf(ForbiddenError);
    await updateOutletPosSettings(mitra.owner.ctx, { outletId: mitra.outletId, fixedOpeningCash: 150_000, qrisEnabled: false, printerEnabled: true, reason: "Kas awal mitra sesuai perjanjian" });
    await setOutletThreshold(mitra.owner.ctx, { outletId: mitra.outletId, key: "PAR-04", value: 5_000, effectiveFrom: toBusinessDate(new Date()), reason: "Ambang void mitra lebih ketat" });
    const ref = (await mitraPos.hp.pull(mitraPos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref.settings).toMatchObject({ fixedOpeningCash: 150_000, qrisEnabled: false, printerEnabled: true, voidApprovalAbove: 5_000 });
    // Pemilik tenant lain tidak dapat mengatur outlet EQUA.
    await expect(updateOutletPosSettings(mitra.owner.ctx, { outletId: outletId("D04"), fixedOpeningCash: 1, qrisEnabled: true, printerEnabled: false, reason: "Lintas tenant" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("US-M6-07 KP-4 aturan kontrol (void beralasan + persetujuan, selisih otomatis) berlaku sama untuk tenant mitra — tanpa logika khusus EQUA", async () => {
    const res = await mitraPos.send("m6.pos_sale.void", { saleId: mitraSale, reason: "wrong_product" });
    expectApplied(res);
    expect(res.result).toMatchObject({ status: "void_pending" }); // 10.000 > PAR-04 outlet mitra (5.000)
    const noReason = await closeVia(mitraPos, mitraShift, { counted: 190_000 });
    expect(noReason.status).toBe("rejected");
    expectApplied(await closeVia(mitraPos, mitraShift, { counted: 190_000, reason: "Uang kembalian tertukar" }));
    const [shift] = await t.db.select().from(shifts).where(eq(shifts.id, mitraShift));
    expect(shift).toMatchObject({ cashDifference: -20_000, cashSales: 10_000 });
  });

  it("US-M6-07 KP-5 laporan per outlet yang sama tersedia untuk pemilik tenant (dan portal mitra), bersumber dari data yang sama", async () => {
    const d = toBusinessDate(new Date());
    const mine = await dailyOutletReport(mitra.owner.ctx, { from: d, to: d });
    expect(mine.map((r) => r.outletId)).toEqual([mitra.outletId]);
    expect(mine[0]).toMatchObject({ salesTotal: 10_000, gallons: 2 });
    const portal = await createTestUser(t.db, { role: "partner_owner", tenantId: mitra.tenantId, scope: { tenantIds: [mitra.tenantId] } });
    const viaPortal = await dailyOutletReport(portal.ctx, { from: d, to: d });
    expect(viaPortal).toEqual(mine);
    const equa = await dailyOutletReport(owner(), { from: d, to: d });
    expect(equa.some((r) => r.outletId === mitra.outletId)).toBe(false);
  });

  it("US-M6-07 KP-6 uji isolasi dua arah: tenant uji tidak melihat data EQUA dan sebaliknya — layanan, penyedia pull, sinkron, dan route", async () => {
    // Layanan (kantor).
    await expect(getOutletDetail(owner(), mitra.outletId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getOutletDetail(mitra.owner.ctx, outletId("D04"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(getShiftDetail(owner(), mitraShift)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getShiftDetail(mitra.owner.ctx, equaShift)).rejects.toBeInstanceOf(NotFoundError);
    await expect(dailyOutletReport(owner(), { from: "2026-01-01", to: "2030-12-31", outletId: mitra.outletId })).rejects.toBeInstanceOf(NotFoundError);
    // Sinkron (POS): produk/shift/transaksi tenant lain ditolak.
    const eqIsi = await sellVia(mitraPos, (await openShiftVia(mitraPos, { counted: 150_000 })).shiftId, [isi(1)]);
    expect(eqIsi.res.status).toBe("rejected");
    expect((await sellVia(mitraPos, equaShift, [isi(1)])).res.status).not.toBe("applied");
    expect((await mitraPos.send("m6.pos_sale.void", { saleId: equaSale, reason: "wrong_product" })).status).toBe("rejected");
    expect((await equaPos.send("m6.pos_sale.void", { saleId: mitraSale, reason: "wrong_product" })).status).toBe("rejected");
    expect((await t.db.select().from(posSales).where(eq(posSales.id, equaSale)))[0]!.status).toBe("valid");
    // Penyedia pull: masing-masing hanya tenant sendiri.
    const mitraPull = await mitraPos.hp.pull(mitraPos.op, { keys: "m1.catalog,m6.pos" });
    const mitraCatalog = mitraPull.data["m1.catalog"] as CatalogRef;
    expect(mitraCatalog.products.some((p) => p.id === P.ISI)).toBe(false);
    const equaPull = await equaPos.hp.pull(equaPos.op, { keys: "m1.catalog,m6.pos" });
    expect((equaPull.data["m1.catalog"] as CatalogRef).products.some((p) => mitraCatalog.products.some((m) => m.id === p.id))).toBe(false);
    expect((equaPull.data["m6.pos"] as PosReference).outlet?.tenantId).toBe(EQUA_TENANT_ID);
    // Route: /api/sync/pull dengan token perangkat mitra & /api/export dengan pelaku kantor tiap tenant.
    const token = await signDeviceToken(mitraPos.hp.secret, { deviceId: mitraPos.hp.deviceId, sessionId: mitraPos.op.sessionId });
    const pullRes = await pullRoute(new Request("http://x/api/sync/pull?keys=m6.pos", { headers: { authorization: `Bearer ${token}` } }));
    expect(pullRes.status).toBe(200);
    const body = (await pullRes.json()) as { data: { "m6.pos": PosReference } };
    expect(body.data["m6.pos"].outlet?.id).toBe(mitra.outletId);
    const d = toBusinessDate(new Date());
    const params = { params: Promise.resolve({ report: "m6.pos_sales" }) };
    setActorResolver(async () => owner());
    const equaCsv = await (await exportRoute(new Request(`http://x/api/export/m6.pos_sales?format=csv&from=${d}&to=${d}`), params)).text();
    setActorResolver(async () => mitra.owner.ctx);
    const mitraCsvRes = await exportRoute(new Request(`http://x/api/export/m6.pos_sales?format=csv&from=${d}&to=${d}`, { headers: { "sec-fetch-site": "same-origin" } }), params);
    const mitraCsv = await mitraCsvRes.text();
    setActorResolver(null);
    expect(equaCsv).toContain("D04-");
    expect(equaCsv).not.toContain("M01-");
    expect(mitraCsv).toContain("M01-");
    expect(mitraCsv).not.toContain("D04-");
    const [o] = await t.db.select().from(outlets).where(and(eq(outlets.tenantId, mitra.tenantId), eq(outlets.code, "M01")));
    expect(o!.id).toBe(mitra.outletId);
    expect(newId()).not.toBe(mitra.outletId);
  });
});
