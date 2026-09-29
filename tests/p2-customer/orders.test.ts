import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customerAppOrders, domainEvents, notifications, orders, trips } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { addDays } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import * as m1 from "@/server/modules/m1-master";
import * as m2 from "@/server/modules/m2-orders";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { at, dispatcher, emitEvent, enableApp, finance, linkedCustomer, owner, setTrip, T0, TODAY, TOMORROW } from "./helpers";

async function firstAddress(cctx: p2.CustomerContext) {
  const [a] = await p2.listMyAddresses(cctx);
  if (!a) throw new Error("tanpa alamat");
  return a;
}

describe("P2 Pesanan mandiri (US-P2-02)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await enableApp();
  });

  it("US-P2-02 KP-1 ringkasan harga: harga per tangki dari zona + BBM (atau harga khusus), total sebelum kirim; harga tidak dapat ditawar", async () => {
    const a = await linkedCustomer(t.db);
    const addr = await firstAddress(a.cctx);
    const master = await m1.resolveTruckWaterPrice(t.db, { customerId: a.customer.id, addressId: addr.id, date: TOMORROW });
    const quote = await p2.quoteOrder(a.cctx, { addressId: addr.id, tankCount: 3, date: TOMORROW });
    expect(quote).toMatchObject({ pricePerTank: master.unitPrice, total: master.unitPrice * 3, priceSource: "zone" });
    expect(quote.priceText).toMatch(/tarif .* \+ komponen BBM/);
    const placed = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 3, date: TOMORROW, slot: "morning", paymentMethod: "cash", ...({ pricePerTank: 1, total: 3 } as object) });
    expect(placed.total).toBe(master.unitPrice * 3);
    const [o] = await t.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(o!.pricePerTrip).toBe(master.unitPrice);
  });

  it("US-P2-02 KP-1 alur ≤ 4 langkah: alamat → jumlah tangki → tanggal & slot → ringkasan harga → kirim (satu panggilan per langkah)", async () => {
    const a = await linkedCustomer(t.db);
    const addresses = await p2.listMyAddresses(a.cctx); // 1. alamat
    const days = await withTx((tx) => p2.slotAvailability(tx, { tenantId: EQUA_TENANT_ID, now: T0, tankCount: 2 })); // 2–3. tangki + tanggal/slot
    const day = days.find((d) => d.slots.some((s) => s.available))!;
    const slot = day.slots.find((s) => s.available)!;
    const quote = await p2.quoteOrder(a.cctx, { addressId: addresses[0]!.id, tankCount: 2, date: day.date }); // 4. ringkasan
    const res = await p2.placeOrder(a.cctx, { addressId: addresses[0]!.id, tankCount: 2, date: day.date, slot: slot.key, paymentMethod: "cash" }); // kirim
    expect(res.total).toBe(quote.total);
  });

  it("US-P2-02 KP-2 slot dari kapasitas rit harian M2 dikurangi rit terjadwal; slot penuh tidak dapat dipilih", async () => {
    const date = addDays(TODAY, 3);
    const [before] = await withTx((tx) => p2.slotAvailability(tx, { tenantId: EQUA_TENANT_ID, now: T0, from: date, days: 1 }));
    const roster = await m2.getWeekRoster(owner(), date, { days: 1 });
    expect(before!.capacity).toBe(roster.totals.find((x) => x.date === date)!.capacity);
    const morning = before!.slots.find((s) => s.key === "morning")!;
    expect(morning.available).toBe(true);
    expect(morning.capacity).toBeGreaterThan(0);
    const a = await linkedCustomer(t.db);
    const addr = await firstAddress(a.cctx);
    let left = morning.remaining;
    while (left > 0) {
      const n = Math.min(left, 20);
      await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: n, date, slot: "morning", paymentMethod: "cash" });
      left -= n;
    }
    const [after] = await withTx((tx) => p2.slotAvailability(tx, { tenantId: EQUA_TENANT_ID, now: T0, from: date, days: 1 }));
    const full = after!.slots.find((s) => s.key === "morning")!;
    expect(full).toMatchObject({ available: false, reason: "Penuh", remaining: 0 });
    expect(after!.used).toBe(before!.used + morning.remaining);
    await expect(p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date, slot: "morning", paymentMethod: "cash" })).rejects.toThrow(/penuh/);
  });

  it("US-P2-02 KP-2 pemesanan H+0 setelah 15.00 (BR-20) tidak tersedia — diarahkan ke H+1 atau telepon", async () => {
    const a = await linkedCustomer(t.db);
    const addr = await firstAddress(a.cctx);
    const late = at(6.5); // 16.30 WIB
    const days = await withTx((tx) => p2.slotAvailability(tx, { tenantId: EQUA_TENANT_ID, now: late }));
    expect(days[0]!.date).toBe(TODAY);
    expect(days[0]!.note).toMatch(/ditutup.*15\.00/);
    expect(days[0]!.slots.every((s) => !s.available)).toBe(true);
    expect(days[1]!.slots.some((s) => s.available)).toBe(true);
    await expect(p2.placeOrder({ ...a.cctx, now: late }, { addressId: addr.id, tankCount: 1, date: TODAY, slot: "afternoon", paymentMethod: "cash" })).rejects.toThrow(/Pilih besok atau telepon kantor/);
  });

  it("US-P2-02 KP-3 cara bayar: tunai (bawaan), transfer, digital; tempo hanya Tempo & dalam batas — penolakan singkat TANPA angka batas", async () => {
    const cash = await linkedCustomer(t.db);
    const q1 = await p2.quoteOrder(cash.cctx, { addressId: (await firstAddress(cash.cctx)).id, tankCount: 1 });
    const credit1 = q1.paymentOptions.find((o) => o.method === "credit")!;
    expect(q1.paymentOptions.find((o) => o.method === "cash")!.available).toBe(true);
    expect(q1.paymentOptions.find((o) => o.method === "transfer")!.available).toBe(true);
    expect(credit1.available).toBe(false);
    expect(credit1.reason).not.toMatch(/\d/);

    const tempo = await linkedCustomer(t.db, { creditStatus: "credit", creditLimit: 1_000_000 });
    const addrT = await firstAddress(tempo.cctx);
    const ok = await p2.quoteOrder(tempo.cctx, { addressId: addrT.id, tankCount: 1, date: TOMORROW });
    expect(ok.paymentOptions.find((o) => o.method === "credit")!.available).toBe(true);
    const over = await p2.quoteOrder(tempo.cctx, { addressId: addrT.id, tankCount: 10, date: TOMORROW });
    const overOpt = over.paymentOptions.find((o) => o.method === "credit")!;
    expect(overOpt.available).toBe(false);
    expect(overOpt.reason).toMatch(/batas tempo/);
    expect(overOpt.reason).not.toMatch(/\d/);
    await expect(p2.placeOrder(tempo.cctx, { addressId: addrT.id, tankCount: 10, date: TOMORROW, slot: "afternoon", paymentMethod: "credit" })).rejects.toThrow(/batas tempo/);
    const placed = await p2.placeOrder(tempo.cctx, { addressId: addrT.id, tankCount: 1, date: TOMORROW, slot: "afternoon", paymentMethod: "credit" });
    const [o] = await t.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(o!.paymentMethod).toBe("credit");
  });

  it("US-P2-02 KP-4 pesanan masuk M2 Baru bertanda 'dari aplikasi', cek dobel, Dispatcher diberi tahu dengan tenggat PAR-75 (2 jam layanan)", async () => {
    const a = await linkedCustomer(t.db);
    const addr = await firstAddress(a.cctx);
    const first = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: TOMORROW, slot: "midday", paymentMethod: "transfer", clientRequestId: "0192a000-0000-7000-8000-000000000001" });
    const [o] = await t.db.select().from(orders).where(eq(orders.id, first.orderId));
    expect(o).toMatchObject({ status: "new", source: "customer_app", slot: "midday", createdByCustomerAccountId: a.cctx.accountId, paymentMethod: "transfer" });
    expect(first.confirmDueAt!.getTime() - T0.getTime()).toBe(2 * 3_600_000);
    const notif = await t.db.select().from(notifications).where(and(eq(notifications.event, "customer_app.order_submitted"), eq(notifications.objectId, first.orderId)));
    expect(notif.some((n) => n.recipientUserId === userIdByUsername("dispatcher1"))).toBe(true);
    // Ketukan ganda (kunci permintaan sama) → pesanan yang sama.
    const replay = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: TOMORROW, slot: "midday", paymentMethod: "transfer", clientRequestId: "0192a000-0000-7000-8000-000000000001" });
    expect(replay).toMatchObject({ orderId: first.orderId, replay: true });
    // Pesan telepon + aplikasi sekaligus (8.7) → pesanan kedua bertanda kemungkinan dobel.
    await m2.createOrder(dispatcher(), { customerId: a.customer.id, addressId: addr.id, requestedDate: addDays(TODAY, 2) });
    const second = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: addDays(TODAY, 2), slot: "morning", paymentMethod: "cash" });
    expect(second.duplicate).toBe(true);

    // Tenggat dihitung pada jam layanan (PAR-07 05.00–22.00): pesanan 21.30 → tenggat 06.30 esok.
    const night = new Date("2026-10-05T14:30:00Z"); // 21.30 WIB
    const late = await p2.placeOrder({ ...a.cctx, now: night }, { addressId: addr.id, tankCount: 1, date: addDays(TODAY, 4), slot: "morning", paymentMethod: "cash" });
    expect(late.confirmDueAt!.toISOString()).toBe("2026-10-05T23:30:00.000Z");
  });

  it("B-64 US-P2-02 KP-4 order.created dari aplikasi membawa asal customer_app & slot (M2 createOrder menerima source/slot); layar kantor tidak dapat mengaku asal aplikasi", async () => {
    const a = await linkedCustomer(t.db);
    const addr = await firstAddress(a.cctx);
    const placed = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: addDays(TODAY, 3), slot: "afternoon", paymentMethod: "cash" });
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "order.created"), eq(domainEvents.objectId, placed.orderId)));
    expect(ev!.payload).toMatchObject({ source: "customer_app", slot: "afternoon" });
    const [o] = await t.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(o).toMatchObject({ source: "customer_app", slot: "afternoon" });
    // Pengguna kantor tidak boleh menandai pesanan sebagai asal aplikasi/portal.
    await expect(m2.createOrder(dispatcher(), { customerId: a.customer.id, addressId: addr.id, requestedDate: addDays(TODAY, 5), source: "customer_app" })).rejects.toThrow(/sistem/);
    const office = await m2.createOrder(dispatcher(), { customerId: a.customer.id, addressId: addr.id, requestedDate: addDays(TODAY, 6) });
    if (office.status !== "created") throw new Error(office.status);
    const [oev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "order.created"), eq(domainEvents.objectId, office.order.id)));
    expect(oev!.payload).toMatchObject({ source: "office", slot: null });
  });

  it("US-P2-02 KP-4 Dispatcher mengonfirmasi (pelanggan diberi tahu) atau menolak beralasan; lewat PAR-75 → notifikasi; Admin Keuangan ditolak", async () => {
    const a = await linkedCustomer(t.db);
    const addr = await firstAddress(a.cctx);
    const o1 = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: addDays(TODAY, 5), slot: "morning", paymentMethod: "cash" });
    const o2 = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: addDays(TODAY, 6), slot: "morning", paymentMethod: "cash" });
    const pending = await p2.listAppOrders(dispatcher());
    expect(pending.map((r) => r.orderId)).toEqual(expect.arrayContaining([o1.orderId, o2.orderId]));

    await expect(p2.confirmAppOrder(finance(), o1.orderId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(p2.confirmAppOrder(owner(), o1.orderId)).rejects.toBeInstanceOf(ForbiddenError);
    await p2.confirmAppOrder(dispatcher(at(1)), o1.orderId);
    const d1 = await p2.getMyOrder(a.cctx, o1.orderId);
    expect(d1.timeline.find((s) => s.key === "confirmed")!.state).toBe("done");
    const inbox = await p2.listMyNotifications(a.cctx);
    expect(inbox.some((n) => n.kind === "order_confirmed" && n.link === `/app/pesanan/${o1.orderId}`)).toBe(true);

    await expect(p2.rejectAppOrder(dispatcher(), o2.orderId, { reason: "no" })).rejects.toThrow(/minimal 5/);
    // Lewat tenggat → notifikasi sekali (job).
    expect(await withTx((tx) => p2.notifyOverdueConfirmations(tx, at(3)))).toBeGreaterThanOrEqual(1);
    expect(await withTx((tx) => p2.notifyOverdueConfirmations(tx, at(4)))).toBe(0);
    const overdue = await t.db.select().from(notifications).where(and(eq(notifications.event, "customer_app.order_confirm_overdue"), eq(notifications.objectId, o2.orderId)));
    expect(overdue.length).toBeGreaterThan(0);
    await p2.rejectAppOrder(dispatcher(at(3)), o2.orderId, { reason: "Truk penuh pada tanggal itu" });
    const [o] = await t.db.select().from(orders).where(eq(orders.id, o2.orderId));
    expect(o).toMatchObject({ status: "cancelled", cancelReason: "rejected_by_dispatcher" });
    const d2 = await p2.getMyOrder(a.cctx, o2.orderId);
    expect(d2.rejectReason).toBe("Truk penuh pada tanggal itu");
    expect(d2.timeline.at(-1)).toMatchObject({ title: "Ditolak kantor", state: "failed" });
    expect((await p2.listMyNotifications(a.cctx)).some((n) => n.kind === "order_rejected")).toBe(true);
  });

  it("US-P2-02 KP-4 Dispatcher menjadwalkan di papan (Terjadwal) → pesanan aplikasi Dikonfirmasi otomatis + notifikasi", async () => {
    const a = await linkedCustomer(t.db);
    const addr = await firstAddress(a.cctx);
    const placed = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: addDays(TODAY, 7), slot: "afternoon", paymentMethod: "cash" });
    await emitEvent("order.status_changed", { orderId: placed.orderId, number: placed.number, customerId: a.customer.id, from: "new", to: "scheduled" }, { now: at(0.5) });
    const [app] = await t.db.select().from(customerAppOrders).where(eq(customerAppOrders.orderId, placed.orderId));
    expect(app!.confirmedAt).not.toBeNull();
    expect((await p2.listMyNotifications(a.cctx)).filter((n) => n.kind === "order_confirmed")).toHaveLength(1);
  });

  it("US-P2-02 KP-5 pelanggan membatalkan sendiri sampai rit Berangkat (PAR-72), beralasan (KPI-06); setelah itu hanya lewat Dispatcher", async () => {
    const a = await linkedCustomer(t.db);
    const addr = await firstAddress(a.cctx);
    const o1 = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: addDays(TODAY, 8), slot: "morning", paymentMethod: "cash" });
    await expect(p2.cancelMyOrder(a.cctx, o1.orderId, { reason: "" })).rejects.toThrow(/alasan/i);
    const cancelled = await p2.cancelMyOrder(a.cctx, o1.orderId, { reason: "Tandon masih penuh" });
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "customer_cancelled" });
    const [o] = await t.db.select().from(orders).where(eq(orders.id, o1.orderId));
    expect(o!.cancelledByCustomerAccountId).toBe(a.cctx.accountId);
    expect(o!.cancelNote).toMatch(/Tandon masih penuh/);
    const kpi = await m2.kpi06Report(owner(), TOMORROW.slice(0, 7));
    expect(kpi).toBeDefined();

    const o2 = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: addDays(TODAY, 8), slot: "midday", paymentMethod: "cash" });
    const [trip] = await t.db.select().from(trips).where(eq(trips.orderId, o2.orderId));
    await setTrip(t.db, trip!.id, { status: "departed", departedAt: at(1) });
    const detail = await p2.getMyOrder(a.cctx, o2.orderId);
    expect(detail.canCancel).toBe(false);
    expect(detail.cancelBlockedReason).toMatch(/kantor/);
    await expect(p2.cancelMyOrder(a.cctx, o2.orderId, { reason: "Batal saja" })).rejects.toThrow(/Hubungi kantor/);
  });

  it("US-P2-02 KP-6 nomor pesanan (PTB-14, P-YY-NNNNNN) tampil dan dapat dirujuk", async () => {
    const a = await linkedCustomer(t.db);
    const addr = await firstAddress(a.cctx);
    const res = await p2.placeOrder(a.cctx, { addressId: addr.id, tankCount: 1, date: addDays(TODAY, 9), slot: "morning", paymentMethod: "cash" });
    expect(res.number).toMatch(/^P-26-\d{6}$/);
    const list = await p2.listMyOrders(a.cctx);
    expect(list.find((r) => r.id === res.orderId)).toMatchObject({ number: res.number, fromApp: true, statusLabel: "Diajukan" });
    expect((await p2.getMyOrder(a.cctx, res.orderId)).timeline[0]!.description).toContain(res.number);
  });
});
