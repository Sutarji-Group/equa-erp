/**
 * M2 — perbaikan S5-B (audit PRD): event `order.status_changed` di setiap transisi (US-M2-02 KP-2), ubah cara bayar
 * tidak menggugurkan persetujuan kurang bayar kedua (US-M2-05 KP-3/KP-6), BR-24 tidak berlaku untuk pasokan internal
 * (PTB-01), penerbitan ulang jalur tidak tertahan penghalang pelanggan yang muncul setelah terbit (PTB-18), pesanan
 * multi-tangki dengan pengiriman terealisasi tidak menjadi Dibatalkan (Bab 5.2).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, domainEvents, orders, trips } from "@/db/schema";
import { internalCustomerId, seedId } from "@/db/seed";
import * as m2 from "@/server/modules/m2-orders";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { at, customer, dispatcher, emitEvent, openInvoice, TODAY, TOMORROW, truckWithCrew } from "./helpers";

type Created = Extract<m2.CreateOrderResult, { status: "created" }>;

describe("M2 — status pesanan & penghalang (perbaikan S5-B)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  async function create(input: Partial<m2.CreateOrderInput> & { customerId: string; addressId: string }): Promise<Created> {
    const res = await m2.createOrder(dispatcher(), { requestedDate: TODAY, ...input });
    if (res.status !== "created") throw new Error(`hasil tak terduga: ${res.status}`);
    return res;
  }

  async function statusEvents(orderId: string) {
    const rows = await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, orderId), eq(domainEvents.type, "order.status_changed")));
    return rows.map((r) => r.payload as { from: string; to: string });
  }

  async function completeTrip(tripId: string, orderId: string, customerId: string, truckId: string, driverUserId: string, now: Date) {
    await t.db.update(trips).set({ status: "completed", departedAt: now, completedAt: now, completionBusinessDate: TODAY }).where(eq(trips.id, tripId));
    await emitEvent("trip.completed", {
      tripId,
      orderId,
      customerId,
      truckId,
      driverUserId,
      isInternal: false,
      volumeL: 5000,
      price: 200_000,
      paymentMethod: "cash",
      cashReceived: 200_000,
      transferAmount: 0,
      creditAmount: 0,
      underpaymentAmount: 0,
      completedAt: now.toISOString(),
      recordedByOffice: false,
      lateSync: false,
    }, { now });
  }

  it("US-M2-02 KP-2 order.status_changed dipancarkan pada setiap transisi yang diturunkan dari rit (terbit → Terjadwal, Selesai)", async () => {
    const c = await customer(t.db);
    const truck = await truckWithCrew(t.db);
    const o = await create({ customerId: c.id, addressId: c.addressId! });
    await m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: truck.id, date: TODAY });
    await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
    expect((await t.db.select().from(orders).where(eq(orders.id, o.order.id)))[0]!.status).toBe("scheduled");
    expect(await statusEvents(o.order.id)).toContainEqual(expect.objectContaining({ from: "new", to: "scheduled" }));
    await completeTrip(o.trips[0]!.id, o.order.id, c.id, truck.id, truck.driver.userId, at(2));
    expect(await statusEvents(o.order.id)).toContainEqual(expect.objectContaining({ from: "scheduled", to: "completed" }));
  });

  it("US-M2-05 KP-3 KP-6 ubah cara bayar tempo → tunai hanya menggugurkan persetujuan tempo; persetujuan kurang bayar kedua tetap menunggu (PTB-18)", async () => {
    const c = await customer(t.db, { creditStatus: "credit", creditLimit: 10_000_000 });
    await openInvoice(t.db, c.id, 40_000, "underpayment");
    await openInvoice(t.db, c.id, 25_000, "underpayment");
    const o = await create({ customerId: c.id, addressId: c.addressId!, paymentMethod: "credit" });
    const approval = await m2.requestUnderpaymentApproval(dispatcher(), o.order.id, { reason: "Pelanggan janji lunasi saat kirim" });
    expect((await t.db.select().from(orders).where(eq(orders.id, o.order.id)))[0]!.status).toBe("awaiting_approval");
    const res = await m2.changePaymentMethod(dispatcher(), o.order.id, { paymentMethod: "cash", reason: "Pelanggan bayar tunai" });
    expect(res.status === "updated" && res.order.status).toBe("awaiting_approval");
    expect((await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, approval.id)))[0]!.status).toBe("submitted");
  });

  it("US-M2-01 KP-6 BR-24 rit internal pasokan depot yang gagal berturut tidak mewajibkan konfirmasi ulang (PTB-01)", async () => {
    const truck = await truckWithCrew(t.db);
    const cid = internalCustomerId("D02");
    const addr = seedId("address:internal:D02");
    const o = await create({ customerId: cid, addressId: addr, tankCount: 1 });
    const next = await create({ customerId: cid, addressId: addr, requestedDate: TOMORROW, duplicateDecision: "additional", duplicateReason: "Pasokan kedua" });
    for (let i = 0; i < 3; i++) {
      const open = (await t.db.select().from(trips).where(and(eq(trips.orderId, o.order.id), eq(trips.status, "assigned"))))[0]!;
      await m2.assignTrip(dispatcher(at(i)), { tripId: open.id, truckId: truck.id, date: TODAY });
      await t.db.update(trips).set({ status: "failed", failedAt: at(i + 0.5), failReason: "truck_broken" }).where(eq(trips.id, open.id));
      await emitEvent("trip.failed", { tripId: open.id, orderId: o.order.id, customerId: cid, truckId: truck.id, reason: "truck_broken", consecutiveFailures: i + 1, isInternal: true }, { now: at(i + 0.5) });
    }
    const after = (await t.db.select().from(orders).where(eq(orders.id, next.order.id)))[0]!;
    expect(after.reconfirmationRequired).toBe(false);
    await m2.assignTrip(dispatcher(at(4)), { tripId: next.trips[0]!.id, truckId: truck.id, date: TOMORROW });
  });

  it("US-M2-05 KP-6 US-M2-03 KP-5 kurang bayar kedua yang muncul setelah rit terbit tidak menahan penerbitan ulang jalur truk", async () => {
    const truck = await truckWithCrew(t.db);
    const a = await customer(t.db);
    const b = await customer(t.db);
    const oa = await create({ customerId: a.id, addressId: a.addressId! });
    await m2.assignTrip(dispatcher(), { tripId: oa.trips[0]!.id, truckId: truck.id, date: TODAY });
    await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
    // Pelanggan A kini punya dua faktur kurang bayar (setelah rit terbit).
    await openInvoice(t.db, a.id, 40_000, "underpayment");
    await openInvoice(t.db, a.id, 25_000, "underpayment");
    const ob = await create({ customerId: b.id, addressId: b.addressId! });
    await m2.assignTrip(dispatcher(), { tripId: ob.trips[0]!.id, truckId: truck.id, date: TODAY });
    const res = await m2.publishSchedule(dispatcher(at(1)), { truckId: truck.id, date: TODAY });
    expect(res.tripIds).toContain(ob.trips[0]!.id);
  });

  it("Bab 5.2 US-M2-02 KP-3 pesanan multi-tangki dengan rit Selesai: status Dalam pengiriman (bukan Baru); batal dari kantor hanya menarik sisa rit dan pesanan menjadi Selesai, bukan Dibatalkan", async () => {
    const c = await customer(t.db);
    const truck = await truckWithCrew(t.db);
    const o = await create({ customerId: c.id, addressId: c.addressId!, tankCount: 2 });
    await m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: truck.id, date: TODAY });
    await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
    await completeTrip(o.trips[0]!.id, o.order.id, c.id, truck.id, truck.driver.userId, at(2));
    // Tangki kedua belum dijadwalkan.
    expect((await t.db.select().from(orders).where(eq(orders.id, o.order.id)))[0]!.status).toBe("in_delivery");
    const res = await m2.cancelOrder(dispatcher(at(3)), o.order.id, { reason: "customer_cancelled", note: "Tangki kedua tidak jadi" });
    expect(res.status).toBe("completed");
    const second = (await t.db.select().from(trips).where(eq(trips.id, o.trips[1]!.id)))[0]!;
    expect(second.withdrawnAt).not.toBeNull();
  });
});
