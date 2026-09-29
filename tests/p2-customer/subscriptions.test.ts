import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customers, orders, recurringOrderFailures, recurringOrders } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { addDays } from "@/lib/time";
import { withTx } from "@/server/core/db";
import * as m2 from "@/server/modules/m2-orders";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createOrder } from "../helpers/fixtures";
import { enableApp, linkedCustomer, refresh, T0, TODAY } from "./helpers";

describe("P2 Langganan & pengingat isi ulang (US-P2-05)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await enableApp();
  });

  it("US-P2-05 KP-1 pelanggan membuat/mengubah/menjeda langganan (hari, jumlah, slot) = pesanan berulang M2; perubahan hanya untuk pesanan yang belum dibuat", async () => {
    const a = await linkedCustomer(t.db);
    const [addr] = await p2.listMyAddresses(a.cctx);
    await expect(p2.saveMySubscription(a.cctx, { addressId: addr!.id, pattern: "weekly", daysOfWeek: [], tankCount: 1, slot: "morning", paymentMethod: "cash", startDate: TODAY })).rejects.toThrow(/minimal satu hari/);
    const sub = await p2.saveMySubscription(a.cctx, { addressId: addr!.id, pattern: "weekly", daysOfWeek: [1, 2, 3, 4, 5, 6, 7], tankCount: 1, slot: "morning", paymentMethod: "cash", startDate: TODAY });
    expect(sub).toMatchObject({ createdVia: "customer_app", slot: "morning", status: "active", tankCount: 1, customerId: a.customer.id });
    expect(sub.requestedTime?.slice(0, 5)).toBe("06:00");

    const gen = await m2.generateRecurringOrders(T0, { db: t.db, tenantId: EQUA_TENANT_ID });
    expect(gen.created).toBeGreaterThan(0);
    const made = await t.db.select().from(orders).where(eq(orders.recurringOrderId, sub.id));
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((o) => o.tankCount === 1)).toBe(true);

    const updated = await p2.saveMySubscription(a.cctx, { id: sub.id, addressId: addr!.id, pattern: "interval", intervalDays: 3, tankCount: 2, slot: "afternoon", paymentMethod: "cash", startDate: TODAY });
    expect(updated).toMatchObject({ pattern: "interval", intervalDays: 3, tankCount: 2, slot: "afternoon" });
    const unchanged = await t.db.select().from(orders).where(eq(orders.recurringOrderId, sub.id));
    expect(unchanged.every((o) => o.tankCount === 1)).toBe(true);

    const paused = await p2.setMySubscriptionStatus(a.cctx, sub.id, { status: "paused" });
    expect(paused.status).toBe("paused");
    const list = await p2.listMySubscriptions(a.cctx);
    expect(list[0]).toMatchObject({ id: sub.id, statusLabel: "Jeda", patternText: "Setiap 3 hari", fromApp: true, nextDates: [] });
    // Langganan pelanggan lain tidak dapat diubah.
    const b = await linkedCustomer(t.db);
    await expect(p2.setMySubscriptionStatus(b.cctx, sub.id, { status: "ended" })).rejects.toThrow(/tidak ditemukan/);
  });

  it("US-P2-05 KP-1 pesanan langganan tetap melalui kontrol kredit; KP-3 gagal dibuat (kredit ditahan) → notifikasi pelanggan dengan tindakan", async () => {
    const a = await linkedCustomer(t.db, { creditStatus: "credit", creditLimit: 5_000_000 });
    const [addr] = await p2.listMyAddresses(a.cctx);
    const sub = await p2.saveMySubscription(a.cctx, { addressId: addr!.id, pattern: "weekly", daysOfWeek: [1, 2, 3, 4, 5, 6, 7], tankCount: 1, slot: "midday", paymentMethod: "credit", startDate: addDays(TODAY, 1) });
    await t.db.update(customers).set({ creditStatus: "on_hold" }).where(eq(customers.id, a.customer.id));
    const gen = await m2.generateRecurringOrders(T0, { db: t.db, tenantId: EQUA_TENANT_ID });
    expect(gen.failed).toBeGreaterThan(0);
    const fails = await t.db.select().from(recurringOrderFailures).where(eq(recurringOrderFailures.recurringOrderId, sub.id));
    expect(fails.length).toBeGreaterThan(0);
    expect(fails[0]!.reason).toBe("credit_on_hold");

    const sent = await withTx((tx) => p2.notifyRecurringFailures(tx, T0));
    expect(sent).toBeGreaterThan(0);
    const notes = (await p2.listMyNotifications(await refresh(a.token))).filter((n) => n.kind === "recurring_failed");
    expect(notes.length).toBe(fails.length);
    expect(notes[0]!.body).toMatch(/Lunasi di menu Tagihan/);
    expect(notes[0]!.link).toBe("/app/tagihan");
    // Idempoten per kegagalan.
    await withTx((tx) => p2.notifyRecurringFailures(tx, T0));
    expect((await p2.listMyNotifications(await refresh(a.token))).filter((n) => n.kind === "recurring_failed")).toHaveLength(fails.length);
    const view = await p2.listMySubscriptions(await refresh(a.token));
    expect(view.find((s) => s.id === sub.id)!.failures[0]!.message).toMatch(/Tagihan/);
  });

  it("US-P2-05 KP-2 pengingat isi ulang dari rata-rata jarak antar pesanan: H-2 'biasanya Anda memesan sekitar …' + pesan ulang satu ketukan; dapat dimatikan", async () => {
    const a = await linkedCustomer(t.db);
    const [addr] = await p2.listMyAddresses(a.cctx);
    let last = "";
    for (const d of [-19, -12, -5]) {
      const o = await createOrder(t.db, { customerId: a.customer.id, addressId: addr!.id, date: addDays(TODAY, d) });
      await t.db.update(orders).set({ status: "completed", tankCount: 2 }).where(eq(orders.id, o.id));
      last = o.id;
    }
    const est = await p2.refillEstimate(t.db, { customerId: a.customer.id, tenantId: EQUA_TENANT_ID, today: TODAY });
    expect(est).toMatchObject({ available: true, avgIntervalDays: 7, lastOrderId: last, expectedDate: addDays(TODAY, 2), reminderDate: TODAY, suppressedReason: null });

    const n1 = await withTx((tx) => p2.sendRefillReminders(tx, T0, { tenantId: EQUA_TENANT_ID }));
    expect(n1).toBeGreaterThanOrEqual(1);
    const notes = (await p2.listMyNotifications(a.cctx)).filter((n) => n.kind === "refill_reminder");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toMatch(/Biasanya Anda memesan sekitar/);
    expect(notes[0]!.link).toBe(`/app/pesan/ulang?dari=${last}`);
    await withTx((tx) => p2.sendRefillReminders(tx, T0, { tenantId: EQUA_TENANT_ID }));
    expect((await p2.listMyNotifications(a.cctx)).filter((n) => n.kind === "refill_reminder")).toHaveLength(1);

    // Pesan ulang satu ketukan: alamat & jumlah tangki pesanan terakhir, slot tersedia terdekat.
    const again = await p2.reorder(a.cctx, { orderId: last });
    const [o] = await t.db.select().from(orders).where(eq(orders.id, again.orderId));
    expect(o).toMatchObject({ addressId: addr!.id, tankCount: 2, source: "customer_app", status: "new" });
    // Pesanan berjalan → pengingat ditahan.
    expect((await p2.refillEstimate(t.db, { customerId: a.customer.id, tenantId: EQUA_TENANT_ID, today: TODAY })).suppressedReason).toMatch(/pesanan berjalan/);

    // Matikan pengingat.
    const b = await linkedCustomer(t.db);
    const [addrB] = await p2.listMyAddresses(b.cctx);
    for (const d of [-19, -12, -5]) {
      const ob = await createOrder(t.db, { customerId: b.customer.id, addressId: addrB!.id, date: addDays(TODAY, d) });
      await t.db.update(orders).set({ status: "completed" }).where(eq(orders.id, ob.id));
    }
    expect(await p2.setRefillReminder(b.cctx, { enabled: false })).toEqual({ enabled: false });
    expect((await p2.myRefillReminder(b.cctx)).enabled).toBe(false);
    await withTx((tx) => p2.sendRefillReminders(tx, T0, { tenantId: EQUA_TENANT_ID }));
    expect((await p2.listMyNotifications(b.cctx)).filter((n) => n.kind === "refill_reminder")).toHaveLength(0);
    const subs = await t.db.select().from(recurringOrders).where(and(eq(recurringOrders.customerId, b.customer.id)));
    expect(subs).toHaveLength(0);
  });
});
