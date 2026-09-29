import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { customers, deposits, invoices, orders, partnerPortalOrders, partnerSanctions, posSales, shifts, tenants, trips, waterSupplyReceipts } from "@/db/schema";
import { EQUA_TENANT_ID, outletId as seedOutlet, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import { setActorResolver } from "@/server/core/actor";
import * as approvals from "@/server/core/approvals";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { DomainError, ForbiddenError, ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { put } from "@/server/core/storage";
import { listDepositsForReceipt } from "@/server/modules/m4-cash";
import { dailyOutletReport, listOutletsOverview } from "@/server/modules/m6-pos";
import {
  createContract,
  createPortalSparePartOrder,
  createPortalWaterOrder,
  partnerPurchaseHistory,
  partnerSettingsView,
  partnerWaterBalance,
  portalHome,
  portalOrdersOf,
  portalPurchaseHistory,
  proposeSanction,
  readPartnerAttachmentForPortal,
  runSanctionChecks,
  sparePartCatalog,
  updatePartnerPosSettings,
} from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { uniqueSeq } from "../helpers/db-fixtures";
import { createTestUser, type TestUser } from "../helpers/factories";
import { closeVia, expectApplied, openShiftVia, sellVia, type Pos } from "../m6-pos/helpers";
import { JPEG } from "../m5-receivables/helpers";
import { at, completeTrip, disablePhase3, dispatcher, enablePhase3, finance, insertSale, owner, setupPartner, T_SEPT, type PartnerFixture } from "./helpers";

async function posOf(p: PartnerFixture): Promise<Pos> {
  const { hp, op } = await p.pos();
  let n = 0;
  return { hp, op, outletId: p.outletId, outletCode: p.outletCode, deviceCode: `POS-${p.tenantCode}`, send: async (type, payload, opts = {}) => (await hp.push([hp.command(op, type, payload, opts)], { now: opts.now })).results[0]!, seq: () => ++n };
}

describe("US-P3-02 POS depot standar dengan data terpisah per mitra (Tahap 3, flag)", () => {
  const t = useTestDb({ seed: true });
  let p: PartnerFixture;
  let coach: TestUser;
  beforeAll(async () => {
    bootstrapForTests();
    await enablePhase3();
    p = await setupPartner(t.db);
    coach = await createTestUser(t.db, { role: "regional_coach", now: T_SEPT });
  });
  afterAll(async () => {
    await disablePhase3();
    setActorResolver(null);
  });

  it("US-P3-02 KP-1 tenant mitra memakai POS M6 tanpa perubahan; harga jual ditetapkan mitra dengan harga anjuran EQUA tampil (PTB-56); kas awal & ambang void dapat diubah dalam batas EQUA", async () => {
    const pos = await posOf(p);
    const opened = await openShiftVia(pos);
    expectApplied(opened.res);
    const view = await partnerSettingsView(p.portal(), { outletId: p.outletId });
    const isi = view.prices.find((r) => r.code === "ISI-ULANG")!;
    expect(isi).toMatchObject({ price: 5_000, recommendedPrice: 5_000, min: 4_000, max: 7_500 });
    const sale = await sellVia(pos, opened.shiftId, [{ productId: isi.productId, quantity: 2, unitPrice: 5_000 }]);
    expectApplied(sale.res);
    expectApplied(await closeVia(pos, opened.shiftId, { counted: 210_000 }));
    await expect(updatePartnerPosSettings(p.portal(), { outletId: p.outletId, prices: [{ productId: isi.productId, price: 8_000 }], reason: "Terlalu mahal" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updatePartnerPosSettings(p.portal(), { outletId: p.outletId, fixedOpeningCash: 900_000, reason: "Kas awal terlalu besar" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updatePartnerPosSettings(p.portal(), { outletId: p.outletId, voidThreshold: 1_000, reason: "Ambang terlalu kecil" })).rejects.toBeInstanceOf(ValidationError);
    const res = await updatePartnerPosSettings(p.portal(), { outletId: p.outletId, prices: [{ productId: isi.productId, price: 6_000 }], fixedOpeningCash: 150_000, voidThreshold: 30_000, reason: "Penyesuaian harga pasar lokal" });
    expect(res.effectiveFrom).toBe("2026-09-11");
    const tomorrow = await withTx((tx) => params.get(tx, "PAR-04", "2026-09-11", { tenantId: p.tenantId, outletId: p.outletId }));
    expect(tomorrow.amount_gt).toBe(30_000);
    const after = await partnerSettingsView({ ...p.portal(), now: at("2026-09-11T03:00:00Z") }, { outletId: p.outletId });
    expect(after.prices.find((r) => r.code === "ISI-ULANG")).toMatchObject({ price: 6_000, recommendedPrice: 5_000 });
    expect(after.outlet.fixedOpeningCash).toBe(150_000);
    // Bukan pemilik mitra / tenant lain → ditolak.
    const q = await setupPartner(t.db);
    await expect(updatePartnerPosSettings(q.portal(), { outletId: p.outletId, fixedOpeningCash: 100_000, reason: "Lintas tenant" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-P3-02 KP-2 isolasi: mitra hanya melihat outletnya; EQUA melihat data yang diperjanjikan; hak baca EQUA ditampilkan ke mitra", async () => {
    const d = toBusinessDate(new Date());
    const mine = await dailyOutletReport(p.portal(), { from: "2026-01-01", to: d });
    expect(mine.every((r) => r.outletId === p.outletId)).toBe(true);
    expect((await listOutletsOverview(owner())).rows.some((r) => r.outlet.id === p.outletId)).toBe(false);
    const home = await portalHome(p.portal());
    expect(home.readRights.map((r) => r.label)).toEqual(expect.arrayContaining(["Neraca air", "Pasokan air diterima"]));
    expect(home.phase3).toBe(true);
  });

  it("US-P3-02 KP-3 setoran & selisih kas mitra dikelola mitra sendiri (tidak masuk M4 EQUA)", async () => {
    const partnerDeposits = await t.db.select().from(deposits).where(eq(deposits.tenantId, p.tenantId));
    expect(partnerDeposits.length).toBeGreaterThan(0);
    const equa = await listDepositsForReceipt(finance());
    const ids = [...equa.waiting, ...equa.received].map((r) => r.id);
    expect(partnerDeposits.some((x) => ids.includes(x.id))).toBe(false);
  });

  it("US-P3-02 KP-4 tunggakan > 30 hari SETELAH teguran → mode baca-saja (tidak dapat membuka shift baru), bukan diblokir mendadak; pulih saat lunas", async () => {
    const [inv] = await t.db
      .insert(invoices)
      .values({ tenantId: EQUA_TENANT_ID, number: `F-26-${String(800_000 + uniqueSeq())}`, kind: "partner_subscription", customerId: p.customerId, periodMonth: "2026-07-01", partnerContractId: p.contractId, issueDate: "2026-08-01", dueDate: "2026-08-15", amount: 150_000, outstandingAmount: 150_000 })
      .returning();
    // Tanpa teguran: belum baca-saja.
    await runSanctionChecks(at("2026-09-20T00:00:00Z"));
    expect((await t.db.select().from(tenants).where(eq(tenants.id, p.tenantId)))[0]!.readOnly).toBe(false);
    const [trigger] = await t.db.select().from(partnerSanctions).where(and(eq(partnerSanctions.tenantId, p.tenantId), eq(partnerSanctions.trigger, "overdue")));
    expect(trigger).toMatchObject({ status: "triggered", level: "warning" });
    const prop = await proposeSanction({ ...coach.ctx, now: at("2026-09-20T02:00:00Z") }, { sanctionId: trigger!.id, reason: "Tunggakan langganan Juli belum dibayar" });
    await approvals.decide(owner(at("2026-09-20T03:00:00Z")), prop.approval.id, "approve", "Teguran tertulis");
    await runSanctionChecks(at("2026-09-21T00:00:00Z"));
    expect((await t.db.select().from(tenants).where(eq(tenants.id, p.tenantId)))[0]!.readOnly).toBe(true);
    const pos = await posOf(p);
    const blocked = await openShiftVia(pos);
    expect(blocked.res.status).toBe("rejected");
    expect(blocked.res.message).toMatch(/baca-saja/);
    await expect(updatePartnerPosSettings(p.portal(), { outletId: p.outletId, fixedOpeningCash: 120_000, reason: "Ubah saat baca-saja" })).rejects.toBeInstanceOf(DomainError);
    await t.db.update(invoices).set({ paidAmount: 150_000, outstandingAmount: 0, status: "paid" }).where(eq(invoices.id, inv!.id));
    const res = await runSanctionChecks(at("2026-09-22T00:00:00Z"));
    expect(res.restored).toContain(p.tenantId);
    expectApplied((await openShiftVia(pos)).res);
  });

  it("US-P3-02 KP-5 neraca air mitra bulanan dengan toleransi PAR-79 (galon terjual × 19 L vs air dibeli EQUA)", async () => {
    const q = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    await insertSale(t.db, q, { businessDate: "2026-08-10", gallons: 55 });
    const { postWaterMovement } = await import("@/server/modules/m6-pos");
    await withTx(async (tx) => {
      await postWaterMovement(tx, { tenantId: q.tenantId, outletId: q.outletId, businessDate: "2026-08-02", kind: "supply_in", volumeL: 1_000, occurredAt: at("2026-08-02T03:00:00Z") });
      await postWaterMovement(tx, { tenantId: q.tenantId, outletId: q.outletId, businessDate: "2026-08-10", kind: "sales_out", volumeL: -1_045, occurredAt: at("2026-08-10T10:00:00Z") });
    });
    const [row] = await withTx((tx) => partnerWaterBalance(tx, q.tenantId, "2026-08"));
    expect(row).toMatchObject({ gallonsSold: 55, soldL: 1_045, excessPct: 4.5, tolerancePct: 10, exceeded: false });
    await params.set(owner(at("2026-07-20T03:00:00Z")), "PAR-79", { percent: 3 }, "2026-07-20", "Toleransi lebih ketat untuk uji");
    const [strict] = await withTx((tx) => partnerWaterBalance(tx, q.tenantId, "2026-08"));
    expect(strict).toMatchObject({ tolerancePct: 3, exceeded: true });
    await params.set(owner(at("2026-07-21T03:00:00Z")), "PAR-79", { percent: 10 }, "2026-07-21", "Kembalikan toleransi");
  });
});

describe("US-P3-03 Memesan air dan spare part ke EQUA dengan harga mitra dan tagihan (Tahap 3, flag)", () => {
  const t = useTestDb({ seed: true });
  let p: PartnerFixture;
  beforeAll(async () => {
    bootstrapForTests();
    p = await setupPartner(t.db, { creditStatus: "credit", creditLimit: 500_000, contract: { creditLimit: 500_000 } });
  });
  afterAll(() => setActorResolver(null));

  it("US-P3-03 KP-1 pesanan air dari portal masuk M2 (asal portal mitra) dengan harga zona (Opsi B) / zona − diskon (Opsi A) dan SLA PAR-76", async () => {
    await expect(createPortalWaterOrder(p.portal(), { outletId: p.outletId, tankCount: 1, requestedDate: "2026-09-11", paymentMethod: "cash" })).rejects.toBeInstanceOf(ForbiddenError);
    await enablePhase3();
    const res = await createPortalWaterOrder(p.portal(), { outletId: p.outletId, tankCount: 2, requestedDate: "2026-09-11", requestedTime: "09:00", paymentMethod: "cash" });
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    const [o] = await t.db.select().from(orders).where(eq(orders.id, res.orderId));
    expect(o).toMatchObject({ source: "partner_portal", customerId: p.customerId, tankCount: 2, priceSource: "zone" });
    expect(o!.slaDueAt!.getTime() - o!.createdAt.getTime()).toBe(24 * 3_600_000);
    expect(res.discountBp).toBe(0);
    const zonePrice = o!.pricePerTrip;
    // Opsi A: diskon mitra 5% dari tarif zona (kontrak berlaku).
    const a = await setupPartner(t.db, { contract: false });
    const ca = await createContract(finance(), { tenantId: a.tenantId, customerId: a.customerId, option: "option_a", startDate: "2026-08-01", royaltyPercent: 3, waterDiscountPercent: 5, reason: "Waralaba" });
    await approvals.decide(owner(), ca.approval.id, "approve", "Setuju");
    const ra = await createPortalWaterOrder(a.portal(), { outletId: a.outletId, tankCount: 1, requestedDate: "2026-09-11", paymentMethod: "cash" });
    expect(ra.status).toBe("created");
    if (ra.status !== "created") return;
    expect(ra.pricePerTrip).toBe(Math.round(zonePrice * 0.95));
    const [ta] = await t.db.select().from(trips).where(eq(trips.orderId, ra.orderId));
    expect(ta!.price).toBe(ra.pricePerTrip);
    const [row] = await t.db.select().from(partnerPortalOrders).where(eq(partnerPortalOrders.orderId, ra.orderId));
    expect(row).toMatchObject({ kind: "water", status: "confirmed", tenantId: a.tenantId });
  });

  it("US-P3-03 KP-2 tempo dalam batas kredit kontrak (satu batas lintas lini); Ditahan memblokir & dinaikkan ke pemicu sanksi; penghentian pasokan menolak pesanan air beralasan", async () => {
    const over = await createPortalWaterOrder(p.portal(), { outletId: p.outletId, tankCount: 5, requestedDate: "2026-09-12", paymentMethod: "credit" });
    expect(over.status).toBe("credit_blocked");
    const ok = await createPortalWaterOrder(p.portal(), { outletId: p.outletId, tankCount: 1, requestedDate: "2026-09-12", paymentMethod: "credit" });
    expect(ok.status).toBe("created");
    // Ditahan (M5) → pesanan tempo diblokir + pemicu sanksi tercatat (bukan blokir diam-diam).
    await t.db.update(customers).set({ creditStatus: "on_hold" }).where(eq(customers.id, p.customerId));
    await withTx((tx) => emit(tx, "credit_status.changed", { customerId: p.customerId, from: "credit", to: "on_hold", reason: "Faktur lewat tempo > PAR-09", automatic: true }, { ctx: systemContext({ now: T_SEPT }) }));
    const held = await createPortalWaterOrder(p.portal(), { outletId: p.outletId, tankCount: 1, requestedDate: "2026-09-13", paymentMethod: "credit", confirmAdditional: true });
    expect(held).toMatchObject({ status: "credit_blocked" });
    const [trig] = await t.db.select().from(partnerSanctions).where(and(eq(partnerSanctions.tenantId, p.tenantId), eq(partnerSanctions.trigger, "overdue")));
    expect(trig).toMatchObject({ status: "triggered" });
    await t.db.update(customers).set({ creditStatus: "credit" }).where(eq(customers.id, p.customerId));
    // Penghentian pasokan sementara → pesanan air ditolak (portal & kantor).
    await t.db.update(partnerSanctions).set({ level: "supply_suspension", status: "active", effectiveFrom: "2026-09-10", decisionReason: "Tunggakan 2 bulan", triggerDetail: { key: "manual-uji", recoveryConditions: "Lunasi faktur Juli & Agustus" } }).where(eq(partnerSanctions.id, trig!.id));
    await expect(createPortalWaterOrder(p.portal(), { outletId: p.outletId, tankCount: 1, requestedDate: "2026-09-14", paymentMethod: "cash" })).rejects.toThrow(/Lunasi faktur Juli & Agustus/);
    const { createOrder } = await import("@/server/modules/m2-orders");
    await expect(createOrder(dispatcher(), { customerId: p.customerId, addressId: p.addressId, tankCount: 1, requestedDate: "2026-09-14", paymentMethod: "cash" })).rejects.toThrow(/penghentian pasokan/);
    await t.db.update(partnerSanctions).set({ status: "lifted", liftedAt: T_SEPT, liftReason: "Lunas" }).where(eq(partnerSanctions.id, trig!.id));
  });

  it("US-P3-03 KP-3 spare part dari katalog M7 harga mitra; dikonfirmasi kasir saat mencatat penjualan harga mitra; ambil di toko atau ikut truk (ditandai pada rit); tempo satu batas kredit", async () => {
    const catalog = await withTx((tx) => sparePartCatalog(tx, "2026-09-10"));
    const uv = catalog.find((c) => c.code === "TK-LAMPU-UV")!;
    expect(uv.partnerPrice).toBe(135_000);
    await expect(createPortalSparePartOrder(p.portal(), { outletId: p.outletId, items: [{ productId: uv.productId, quantity: 10 }], pickup: "store_pickup", paymentMethod: "credit" })).rejects.toThrow(/batas kredit/);
    const order = await createPortalSparePartOrder(p.portal(), { outletId: p.outletId, items: [{ productId: uv.productId, quantity: 1 }], pickup: "with_truck", paymentMethod: "cash" });
    expect(order).toMatchObject({ kind: "spare_part", status: "submitted", estimatedAmount: 135_000, pickup: "with_truck" });
    const store = seedOutlet("TK1");
    const [shift] = await t.db.insert(shifts).values({ tenantId: EQUA_TENANT_ID, outletId: store, operatorUserId: userIdByUsername("kasir"), businessDate: "2026-09-10", status: "open", openedAt: T_SEPT, openingCashFixed: 200_000 }).returning();
    const [sale] = await t.db
      .insert(posSales)
      .values({ tenantId: EQUA_TENANT_ID, outletId: store, shiftId: shift!.id, number: `TK1-260910-${String(uniqueSeq()).padStart(4, "0")}`, localNumber: `L-${newId()}`, deviceSeq: uniqueSeq(), operatorUserId: userIdByUsername("kasir"), customerId: p.customerId, priceKind: "partner", businessDate: "2026-09-10", soldAt: T_SEPT, subtotal: 135_000, total: 135_000, paymentMethod: "cash", cashReceived: 135_000, changeAmount: 0 })
      .returning();
    await withTx((tx) =>
      emit(
        tx,
        "pos_sale.recorded",
        { posSaleId: sale!.id, outletId: store, outletKind: "store", shiftId: shift!.id, method: "cash", total: 135_000, discount: 0, customerId: p.customerId, lines: [], priceKind: "partner", number: sale!.number },
        { ctx: systemContext({ now: T_SEPT }), tenantId: EQUA_TENANT_ID },
      ),
    );
    const [confirmed] = await t.db.select().from(partnerPortalOrders).where(eq(partnerPortalOrders.id, order.id));
    expect(confirmed).toMatchObject({ status: "confirmed", posSaleId: sale!.id });
    expect(confirmed!.notes).toMatch(/Ikut truk air rit/);
  });

  it("US-P3-03 KP-4 status pesanan & pengiriman tampil di portal: rit, volume kirim, bukti kirim (tanda tangan), konfirmasi volume operator mitra", async () => {
    const res = await createPortalWaterOrder(p.portal(), { outletId: p.outletId, tankCount: 1, requestedDate: "2026-09-15", paymentMethod: "cash", confirmAdditional: true });
    if (res.status !== "created") throw new Error(res.status);
    const [trip] = await t.db.select().from(trips).where(eq(trips.orderId, res.orderId));
    const sig = await withTx((tx) => put(tx, { ...systemContext({ now: T_SEPT }), userId: userIdByUsername("sopir1") }, { blob: JPEG, contentType: "image/jpeg", kind: "signature" }));
    await t.db.update(trips).set({ signatureAttachmentId: sig.id }).where(eq(trips.id, trip!.id));
    await completeTrip(t.db, { ...trip!, price: trip!.price }, { volumeL: 5_000, completedAt: at("2026-09-15T04:00:00Z") });
    const [receipt] = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, trip!.id));
    await t.db.update(waterSupplyReceipts).set({ status: "confirmed", receivedVolumeL: 4_950, differenceL: -50 }).where(eq(waterSupplyReceipts.id, receipt!.id));
    const views = await withTx((tx) => portalOrdersOf(tx, p.tenantId));
    const v = views.find((x) => x.orderId === res.orderId)!;
    expect(v.trips[0]).toMatchObject({ status: "completed", deliveredVolumeL: 5_000, hasSignature: true, receiptStatus: "confirmed", receivedVolumeL: 4_950 });
    const file = await readPartnerAttachmentForPortal(p.portal(), sig.id);
    expect(file.body.byteLength).toBe(JPEG.byteLength);
    const q = await setupPartner(t.db);
    await expect(readPartnerAttachmentForPortal(q.portal(), sig.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-P3-03 KP-5 riwayat pembelian air & spare part per bulan tersedia bagi mitra dan EQUA", async () => {
    const mine = await portalPurchaseHistory(p.portal(at("2026-09-30T03:00:00Z")));
    const sept = mine.find((m) => m.month === "2026-09")!;
    expect(sept.waterTrips).toBeGreaterThanOrEqual(1);
    expect(sept.waterL).toBeGreaterThanOrEqual(5_000);
    expect(sept.sparePartAmount).toBe(135_000);
    const equa = await partnerPurchaseHistory(finance(at("2026-09-30T03:00:00Z")), { tenantId: p.tenantId });
    expect(equa.find((m) => m.month === "2026-09")).toEqual(sept);
    await disablePhase3();
  });
});
