import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, customers, devices, employees, notifications, orders, users, userRoles, waterSupplyReceipts } from "@/db/schema";
import { EQUA_TENANT_ID, tariffZoneId } from "@/db/seed";
import { newId } from "@/lib/ids";
import { setActorResolver } from "@/server/core/actor";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { ForbiddenError, ValidationError } from "@/server/core/errors";
import { createOrder } from "@/server/modules/m2-orders";
import { listOutletsOverview, postWaterMovement, waterPeriodBalance } from "@/server/modules/m6-pos";
import {
  getPartnerDetail,
  linkPartnerCustomer,
  partnerWaterBalance,
  registerPartnerDevice,
  registerPartnerOperator,
  runPartnerWaterBalanceCheck,
  runWaterOrderSlaCheck,
  supplyBoard,
} from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createCustomer } from "../helpers/fixtures";
import { expectApplied } from "../m6-pos/helpers";
import { accountant, admin, at, completeTrip, dispatcher, finance, insertOrderTrip, insertSale, owner, setupPartner, T_OCT1, T_SEPT, type PartnerFixture } from "./helpers";

describe("US-P3-08 Pasokan air mitra tercatat di POS mitra & neraca air per mitra", () => {
  const t = useTestDb({ seed: true });
  let p: PartnerFixture;
  beforeAll(async () => {
    bootstrapForTests();
    p = await setupPartner(t.db);
  });
  afterAll(() => setActorResolver(null));

  it("US-P3-08 KP-1 pelanggan mitra (segmen depot pihak ketiga + penanda mitra depot EQUA & mitra toko BR-18) ditautkan ke tenant & outlet mitra", async () => {
    const [c] = await t.db.select().from(customers).where(eq(customers.id, p.customerId));
    expect(c).toMatchObject({ isEquaPartner: true, partnerTenantId: p.tenantId, partnerOutletId: p.outletId, isStorePartner: true, storePartnerSource: "manual" });
    // Segmen selain depot pihak ketiga ditolak; outlet mitra hanya satu pelanggan mitra; izin ditolak & tercatat.
    const hotel = await createCustomer(t.db, { segment: "hotel" });
    await expect(linkPartnerCustomer(finance(), { customerId: hotel.id, tenantId: p.tenantId, outletId: p.outletId, reason: "Salah segmen" })).rejects.toBeInstanceOf(ValidationError);
    const other = await createCustomer(t.db, { segment: "third_party_depot" });
    await expect(linkPartnerCustomer(dispatcher(), { customerId: other.id, tenantId: p.tenantId, outletId: p.outletId, reason: "Outlet sudah tertaut" })).rejects.toThrow(/sudah tertaut/);
    await expect(linkPartnerCustomer(accountant(), { customerId: other.id, tenantId: p.tenantId, outletId: p.outletId, reason: "Akuntan mencoba" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-P3-08 KP-1 pesanan air mitra dibuat di M2 seperti pelanggan biasa dengan harga zona Opsi B (tanpa diskon) + tenggat SLA PAR-76", async () => {
    const res = await createOrder(dispatcher(), { customerId: p.customerId, addressId: p.addressId, tankCount: 2, requestedDate: "2026-09-11", paymentMethod: "cash" });
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    // Pembanding: pelanggan depot pihak ketiga biasa di zona yang sama.
    const regular = await createCustomer(t.db, { segment: "third_party_depot", zoneId: tariffZoneId("Z1") });
    const ref = await createOrder(dispatcher(), { customerId: regular.id, addressId: regular.addressId!, tankCount: 1, requestedDate: "2026-09-11", paymentMethod: "cash" });
    expect(ref.status).toBe("created");
    if (ref.status !== "created") return;
    expect(res.order.pricePerTrip).toBe(ref.order.pricePerTrip);
    expect(res.order.priceSource).toBe("zone");
    const [o] = await t.db.select().from(orders).where(eq(orders.id, res.order.id));
    expect(o!.slaDueAt!.getTime() - o!.createdAt.getTime()).toBe(24 * 3_600_000);
    const [r] = await t.db.select().from(orders).where(eq(orders.id, ref.order.id));
    expect(r!.slaDueAt).toBeNull();
  });

  it("US-P3-08 KP-2 rit pelanggan mitra Selesai muncul di POS outlet mitra sebagai 'pasokan tiba' (idempoten per rit); rit pelanggan biasa tidak", async () => {
    const { trip } = await insertOrderTrip(t.db, p, { date: "2026-09-12" });
    await completeTrip(t.db, trip, { volumeL: 5_000, completedAt: at("2026-09-12T04:00:00Z") });
    await completeTrip(t.db, trip, { volumeL: 5_000, completedAt: at("2026-09-12T04:00:00Z") });
    const rows = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, trip.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: p.tenantId, outletId: p.outletId, status: "arrived", source: "equa_truck", deliveredVolumeL: 5_000, businessDate: "2026-09-12" });
    const regular = await createCustomer(t.db, { segment: "third_party_depot", zoneId: tariffZoneId("Z1") });
    const other = await insertOrderTrip(t.db, { customerId: regular.id, addressId: regular.addressId! }, { date: "2026-09-12" });
    await completeTrip(t.db, other.trip, { volumeL: 5_000, completedAt: at("2026-09-12T05:00:00Z") });
    expect(await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, other.trip.id))).toHaveLength(0);
  });

  it("US-P3-08 KP-2 operator mitra mengonfirmasi pasokan lewat POS (US-M6-05 KP-1–2); selisih kirim–terima ditandai ke Dispatcher EQUA", async () => {
    const { trip } = await insertOrderTrip(t.db, p, { date: "2026-09-13" });
    await completeTrip(t.db, trip, { volumeL: 5_000, completedAt: at("2026-09-13T04:00:00Z") });
    const [receipt] = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, trip.id));
    const pos = await p.pos();
    const res = (await pos.hp.push([pos.hp.command(pos.op, "m6.water_supply.confirm", { receiptId: receipt!.id, receivedVolumeL: 4_500, reason: "Tangki penerima penuh" })])).results[0]!;
    expectApplied(res);
    const [after] = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.id, receipt!.id));
    expect(after).toMatchObject({ receivedVolumeL: 4_500, differenceL: -500 });
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "water_supply.discrepancy"), eq(notifications.objectId, receipt!.id)));
    const equaNotes = notes.filter((n) => n.tenantId === EQUA_TENANT_ID);
    expect(equaNotes.length).toBeGreaterThan(0);
    expect(equaNotes[0]!.title).toContain("-500 L");
  });

  it("US-P3-08 KP-3 neraca air per mitra per bulan (galon × 19 L vs air diterima EQUA) = rumus US-M6-05 KP-4; di atas PAR-79 → pemilik, sekali per outlet-bulan", async () => {
    const q = await setupPartner(t.db, { activatedOn: "2026-08-01" });
    await insertSale(t.db, q, { businessDate: "2026-09-05", gallons: 100 });
    await insertSale(t.db, q, { businessDate: "2026-09-06", gallons: 5, status: "voided" });
    await withTx(async (tx) => {
      await postWaterMovement(tx, { tenantId: q.tenantId, outletId: q.outletId, businessDate: "2026-09-02", kind: "supply_in", volumeL: 1_000, occurredAt: at("2026-09-02T03:00:00Z"), source: null });
      await postWaterMovement(tx, { tenantId: q.tenantId, outletId: q.outletId, businessDate: "2026-09-05", kind: "sales_out", volumeL: -1_900, occurredAt: at("2026-09-05T10:00:00Z"), source: null });
    });
    const [row] = await withTx((tx) => partnerWaterBalance(tx, q.tenantId, "2026-09"));
    const m6 = await withTx((tx) => waterPeriodBalance(tx, q.outletId, "2026-09-01", "2026-09-30"));
    expect(row).toMatchObject({ gallonsSold: 100, soldL: 1_900, receivedFromEquaL: 1_000, tolerancePct: 10, exceeded: true });
    expect(row!.soldL).toBe(m6.soldL);
    expect(row!.excessPct).toBe(m6.excessPct);
    const first = await runPartnerWaterBalanceCheck(T_OCT1);
    expect(first.month).toBe("2026-09");
    expect(first.flagged).toContain(q.outletId);
    const again = await runPartnerWaterBalanceCheck(T_OCT1);
    expect(again.flagged).not.toContain(q.outletId);
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.water_balance_exceeded"), eq(notifications.objectId, q.outletId)));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.tenantId === EQUA_TENANT_ID)).toBe(true);
    expect(new Set(notes.map((n) => n.groupKey))).toEqual(new Set([`partner.water_balance:${q.outletId}:2026-09`]));
  });

  it("US-P3-08 KP-4 pesanan air mitra belum Selesai > 24 jam (PAR-76) → notifikasi Dispatcher & pemilik (sekali); yang sudah Selesai tidak", async () => {
    const created = at("2026-09-14T01:00:00Z");
    const late = await insertOrderTrip(t.db, p, { date: "2026-09-14", createdAt: created });
    const done = await insertOrderTrip(t.db, p, { date: "2026-09-14", createdAt: created });
    await t.db.update(orders).set({ status: "completed", completedAt: at("2026-09-14T05:00:00Z") }).where(eq(orders.id, done.order.id));
    const early = await runWaterOrderSlaCheck(new Date(created.getTime() + 23 * 3_600_000));
    expect(early.flagged).not.toContain(late.order.id);
    const res = await runWaterOrderSlaCheck(new Date(created.getTime() + 25 * 3_600_000));
    expect(res.flagged).toContain(late.order.id);
    expect(res.flagged).not.toContain(done.order.id);
    expect((await runWaterOrderSlaCheck(new Date(created.getTime() + 26 * 3_600_000))).flagged).not.toContain(late.order.id);
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.water_order_sla"), eq(notifications.objectId, late.order.id)));
    const recipients = await t.db.select({ id: userRoles.userId, role: userRoles.role }).from(userRoles);
    const roleOf = (uid: string | null) => recipients.filter((r) => r.id === uid).map((r) => r.role);
    const roles = new Set(notes.flatMap((n) => roleOf(n.recipientUserId)));
    expect(roles.has("dispatcher")).toBe(true);
    expect(roles.has("owner")).toBe(true);
  });

  it("US-P3-08 KP-5 isolasi (NFR-30): EQUA hanya melihat data yang diperjanjikan (agregat penjualan, pasokan, neraca air); pengguna mitra ditolak di layar EQUA", async () => {
    const board = await supplyBoard(owner(), { month: "2026-09", tenantId: p.tenantId });
    const row = board.rows[0]!;
    expect(Object.keys(row).sort()).toEqual(["balance", "customers", "deliveredL", "exceeded", "orders", "outlets", "receipts", "sales", "tenant", "tripsCompleted"]);
    expect(Object.keys(row.sales).sort()).toEqual(["gallons", "salesTotal", "transactions"]);
    // Layar outlet EQUA tidak memuat outlet mitra; pengguna mitra tidak dapat membuka layar kemitraan EQUA.
    expect((await listOutletsOverview(owner())).rows.some((r) => r.outlet.id === p.outletId)).toBe(false);
    await expect(supplyBoard(p.portal(), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getPartnerDetail(p.portal(), p.tenantId)).rejects.toBeInstanceOf(ForbiddenError);
    const detail = await getPartnerDetail(dispatcher(), p.tenantId);
    expect(detail.invoices).toBeNull();
    expect(detail.accounts).toBeNull();
    expect(detail.readRights.map((r) => r.key)).toEqual(["sales", "supply", "water_balance", "quality", "invoices"]);
  });

  it("US-P3-08 KP-1 B-07 admin sistem EQUA membuat akun operator/pemilik mitra (persetujuan pemilik US-M10-01 KP-8) & tablet POS untuk tenant mitra", async () => {
    await expect(registerPartnerOperator(finance(), { tenantId: p.tenantId, outletId: p.outletId, fullName: "Operator Baru", username: "op_baru_uji", role: "depot_operator", reason: "Operator shift pagi" })).rejects.toBeInstanceOf(ForbiddenError);
    const res = await registerPartnerOperator(admin(), { tenantId: p.tenantId, outletId: p.outletId, fullName: "Operator Baru", username: "op_baru_uji", role: "depot_operator", reason: "Operator shift pagi" });
    const [u] = await t.db.select().from(users).where(eq(users.id, res.user.id));
    expect(u).toMatchObject({ tenantId: p.tenantId, status: "pending_approval" });
    const [emp] = await t.db.select().from(employees).where(eq(employees.id, res.employee.id));
    expect(emp!.tenantId).toBe(p.tenantId);
    const [req] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, res.approval!.id));
    expect(req).toMatchObject({ type: "account_create", tenantId: EQUA_TENANT_ID, status: "submitted" });
    await approvals.decide(owner(), req!.id, "approve", "Sesuai perjanjian");
    expect((await t.db.select().from(users).where(eq(users.id, res.user.id)))[0]!.status).toBe("active");
    const dev = await registerPartnerDevice(admin(), { tenantId: p.tenantId, outletId: p.outletId, deviceCode: `TAB-${newId().slice(-6)}`, name: "Tablet kasir mitra", kind: "tablet" });
    const [d] = await t.db.select().from(devices).where(eq(devices.id, dev.device.id));
    expect(d).toMatchObject({ tenantId: p.tenantId, outletId: p.outletId });
    expect(dev.code).toMatch(/^[A-Z0-9]{8}$/);
    // Admin sistem tenant mitra tidak dapat membuat akun di tenant lain.
    const q = await setupPartner(t.db, { contract: false });
    const foreignAdmin = { ...admin(), tenantId: p.tenantId, scope: { truckIds: [], outletIds: [], sourceIds: [], tenantIds: [p.tenantId] } };
    await expect(registerPartnerOperator(foreignAdmin, { tenantId: q.tenantId, outletId: q.outletId, fullName: "Penyusup", username: "penyusup_uji", role: "depot_operator", reason: "Coba lintas tenant" })).rejects.toBeInstanceOf(ForbiddenError);
    void T_SEPT;
  });
});
