import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customers, notifications, orderDateHistory, orders, recurringOrderFailures, trips, tripIncidents, waMessageLogs, waTemplates, zoneTariffs } from "@/db/schema";
import { EQUA_TENANT_ID, truckId as seedTruckId, userIdByUsername } from "@/db/seed";
import { addDays, toBusinessDate } from "@/lib/time";
import { ForbiddenError, ValidationError } from "@/server/core/errors";
import { listHandlers } from "@/server/core/events";
import { exportReport, getReport } from "@/server/core/export";
import { getJob, runJobNow } from "@/server/core/jobs";
import { listPullProviders } from "@/server/core/sync";
import type { WhatsAppProvider } from "@/server/core/wa";
import * as m1 from "@/server/modules/m1-master";
import * as m2 from "@/server/modules/m2-orders";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { fieldDevice } from "../helpers/field";
import { today } from "../helpers/fixtures";
import { at, customer, dispatcher, emitEvent, openInvoice, owner, T0, TODAY, TOMORROW, truckWithCrew } from "./helpers";

type Created = Extract<m2.CreateOrderResult, { status: "created" }>;

describe("M2 Siklus, langganan, WA, riwayat", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  async function order(c: { id: string; addressId: string | null }, opts: { date?: string; tankCount?: number; ctx?: ReturnType<typeof dispatcher>; extra?: boolean } = {}): Promise<Created> {
    const res = await m2.createOrder(opts.ctx ?? dispatcher(), {
      customerId: c.id,
      addressId: c.addressId!,
      requestedDate: opts.date ?? TODAY,
      tankCount: opts.tankCount ?? 1,
      duplicateDecision: opts.extra ? "additional" : undefined,
      duplicateReason: opts.extra ? "Tambahan uji" : undefined,
    });
    if (res.status !== "created") throw new Error(res.status);
    return res;
  }

  async function fail(tripRow: { id: string; orderId: string; customerId: string }, truck: string, now: Date, reason: "customer_absent" | "customer_refused" = "customer_absent") {
    await t.db.update(trips).set({ status: "failed", failedAt: now, failReason: reason, failNote: "Rumah kosong", failLat: -6.83, failLng: 107.15 }).where(eq(trips.id, tripRow.id));
    await emitEvent("trip.failed", { tripId: tripRow.id, orderId: tripRow.orderId, customerId: tripRow.customerId, truckId: truck, reason, consecutiveFailures: 0 }, { now });
  }

  // ===================================================================================================================
  describe("US-M2-09 Pembatalan, penjadwalan ulang, dan rit gagal", () => {
    it("US-M2-09 KP-1 jadwal ulang mengubah tanggal diminta beralasan; riwayat tanggal tersimpan; rit kembali ke Belum terjadwal", async () => {
      const c = await customer(t.db);
      const truck = await truckWithCrew(t.db);
      const o = await order(c);
      await m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: truck.id, date: TODAY });
      await expect(m2.rescheduleOrder(dispatcher(), o.order.id, { requestedDate: TOMORROW, reason: "" })).rejects.toBeInstanceOf(ValidationError);
      const res = await m2.rescheduleOrder(dispatcher(), o.order.id, { requestedDate: TOMORROW, requestedTime: "09:00", reason: "Pelanggan minta besok pagi" });
      expect(res.order).toMatchObject({ requestedDate: TOMORROW, status: "new" });
      const hist = await t.db.select().from(orderDateHistory).where(eq(orderDateHistory.orderId, o.order.id));
      expect(hist[0]).toMatchObject({ fromDate: TODAY, toDate: TOMORROW, reason: "Pelanggan minta besok pagi", changedBy: userIdByUsername("dispatcher1") });
      expect((await t.db.select().from(trips).where(eq(trips.id, o.trips[0]!.id)))[0]).toMatchObject({ truckId: null, scheduledDate: TOMORROW });
      expect(o.order.number).toBe(res.order.number);
    });

    it("US-M2-09 KP-2 rit Gagal dari M3 → kejadian (alasan, waktu, lokasi), pesanan Baru + 'perlu jadwal ulang', rit pengganti di kolom Belum terjadwal; idempoten", async () => {
      const c = await customer(t.db);
      const truck = await truckWithCrew(t.db);
      const o = await order(c);
      await m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: truck.id, date: TODAY });
      await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
      await fail({ id: o.trips[0]!.id, orderId: o.order.id, customerId: c.id }, truck.id, at(2));
      const incident = await t.db.select().from(tripIncidents).where(eq(tripIncidents.tripId, o.trips[0]!.id));
      expect(incident[0]).toMatchObject({ kind: "trip_failed", lat: -6.83, lng: 107.15, businessDate: TODAY });
      expect(incident[0]!.description).toMatch(/Pelanggan tidak ada/);
      const after = (await t.db.select().from(orders).where(eq(orders.id, o.order.id)))[0]!;
      expect(after).toMatchObject({ status: "new", needsReschedule: true });
      const all = await t.db.select().from(trips).where(eq(trips.orderId, o.order.id));
      expect(all).toHaveLength(2);
      const replacement = all.find((x) => x.status === "assigned")!;
      expect(replacement.number).toBe(`${o.order.number}/2`);
      const board = await m2.getBoard(dispatcher(at(2)), TODAY);
      expect(board.unscheduled.find((u) => u.id === replacement.id)?.needsReschedule).toBe(true);
      const notif = await t.db.select().from(notifications).where(and(eq(notifications.event, "trip.failed"), eq(notifications.objectId, o.order.id)));
      expect(notif.length).toBeGreaterThan(0);
      // Idempoten: event terulang tidak menggandakan rit pengganti/kejadian.
      await emitEvent("trip.failed", { tripId: o.trips[0]!.id, orderId: o.order.id, customerId: c.id, truckId: truck.id, reason: "customer_absent", consecutiveFailures: 1 }, { now: at(2) });
      expect(await t.db.select().from(trips).where(eq(trips.orderId, o.order.id))).toHaveLength(2);
      expect(await t.db.select().from(tripIncidents).where(eq(tripIncidents.tripId, o.trips[0]!.id))).toHaveLength(1);
    });

    it("US-M2-09 KP-3 dua rit gagal berturut (PAR-17) → pesanan berikutnya wajib 'sudah dikonfirmasi ulang' (waktu & cara) sebelum dijadwalkan (BR-24)", async () => {
      const c = await customer(t.db);
      const truck = await truckWithCrew(t.db);
      const o1 = await order(c);
      await m2.assignTrip(dispatcher(), { tripId: o1.trips[0]!.id, truckId: truck.id, date: TODAY });
      await fail({ id: o1.trips[0]!.id, orderId: o1.order.id, customerId: c.id }, truck.id, at(1));
      const repl = (await t.db.select().from(trips).where(and(eq(trips.orderId, o1.order.id), eq(trips.status, "assigned"))))[0]!;
      await m2.assignTrip(dispatcher(at(1)), { tripId: repl.id, truckId: truck.id, date: TODAY });
      await fail({ id: repl.id, orderId: o1.order.id, customerId: c.id }, truck.id, at(2), "customer_refused");
      const next = await order(c, { date: TOMORROW, ctx: dispatcher(at(3)) });
      expect(next.order.reconfirmationRequired).toBe(true);
      await expect(m2.assignTrip(dispatcher(at(3)), { tripId: next.trips[0]!.id, truckId: truck.id, date: TOMORROW })).rejects.toMatchObject({ code: "RECONFIRMATION" });
      await expect(m2.reconfirmOrder(dispatcher(at(3)), next.order.id, { confirmedAt: at(2.5), method: "" })).rejects.toBeInstanceOf(ValidationError);
      const confirmed = await m2.reconfirmOrder(dispatcher(at(3)), next.order.id, { confirmedAt: at(2.5), method: "Telepon", note: "Bu pemilik rumah ada besok pagi" });
      expect(confirmed.reconfirmedAt?.toISOString()).toBe(at(2.5).toISOString());
      expect(confirmed.reconfirmationMethod).toMatch(/Telepon/);
      await m2.assignTrip(dispatcher(at(3)), { tripId: next.trips[0]!.id, truckId: truck.id, date: TOMORROW });
      const high = await t.db.select().from(notifications).where(and(eq(notifications.event, "trip.failed"), eq(notifications.severity, "high")));
      expect(high.some((n) => n.title.includes("gagal berturut"))).toBe(true);
    });

    it("US-M2-09 KP-4 laporan bulanan alasan pembatalan dan kegagalan per pelanggan dan per truk; dapat diekspor", async () => {
      const c = await customer(t.db);
      const truck = await truckWithCrew(t.db);
      const o = await order(c);
      await m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: truck.id, date: TODAY });
      await fail({ id: o.trips[0]!.id, orderId: o.order.id, customerId: c.id }, truck.id, at(1));
      const o2 = await order(c, { date: TOMORROW });
      await m2.cancelOrder(dispatcher(at(1)), o2.order.id, { reason: "price" });
      const rep = await m2.monthlyCancelFailReport(owner(at(2)), "2026-10");
      expect(rep.rows.some((r) => r.groupType === "truck" && r.groupName === truck.code && r.kind === "fail" && r.reason === "customer_absent")).toBe(true);
      expect(rep.rows.some((r) => r.groupType === "customer" && r.kind === "cancel" && r.reason === "price")).toBe(true);
      expect(rep.totals.failed).toBeGreaterThan(0);
      const x = await exportReport(owner(at(2)), "m2.cancel_fail_monthly", "xlsx", { month: "2026-10" });
      expect(x.rowCount).toBe(rep.rows.length);
    });
  });

  // ===================================================================================================================
  describe("US-M2-06 Pesanan berulang / langganan", () => {
    it("US-M2-06 KP-1 pola: pelanggan, alamat, hari/interval, tangki, jam, cara bayar, mulai/berakhir; status Aktif/Jeda/Berakhir", async () => {
      const c = await customer(t.db);
      await expect(m2.createRecurringOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, pattern: "weekly", daysOfWeek: [], startDate: TODAY })).rejects.toBeInstanceOf(ValidationError);
      const r = await m2.createRecurringOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, pattern: "weekly", daysOfWeek: [1, 4], tankCount: 2, requestedTime: "07:00", paymentMethod: "cash", startDate: TODAY, endDate: addDays(TODAY, 60) });
      expect(r).toMatchObject({ status: "active", pattern: "weekly", daysOfWeek: [1, 4], tankCount: 2 });
      const i = await m2.createRecurringOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, pattern: "interval", intervalDays: 3, startDate: TODAY });
      expect(m2.nextOccurrences(i, TODAY, 3)).toEqual([TODAY, addDays(TODAY, 3), addDays(TODAY, 6)]);
      await m2.setRecurringStatus(dispatcher(), i.id, { status: "paused", reason: "Hotel renovasi" });
      await m2.setRecurringStatus(dispatcher(), i.id, { status: "ended", reason: "Kontrak selesai" });
      await expect(m2.setRecurringStatus(dispatcher(), i.id, { status: "active", reason: "Coba aktifkan" })).rejects.toMatchObject({ code: "RECURRING_ENDED" });
      await expect(m2.createRecurringOrder(owner(), { customerId: c.id, addressId: c.addressId!, pattern: "interval", intervalDays: 3, startDate: TODAY })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M2-06 KP-2 job H-2 (PAR-34) membuat pesanan Baru bertanda langganan, idempoten, mengikuti kontrol kredit & prioritas BR-21", async () => {
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: 10_000_000 });
      const target = addDays(TODAY, 2);
      const r = await m2.createRecurringOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, pattern: "interval", intervalDays: 2, startDate: TODAY, paymentMethod: "credit", requestedTime: "06:30" });
      const res = await m2.generateRecurringOrders(T0, { tenantId: EQUA_TENANT_ID });
      expect(res.created).toBeGreaterThanOrEqual(2);
      const made = await t.db.select().from(orders).where(eq(orders.recurringOrderId, r.id));
      expect(made.map((o) => o.requestedDate).sort()).toEqual([TODAY, target]);
      expect(made.every((o) => o.status === "new" && o.source === "recurring" && o.paymentMethod === "credit" && o.createdBy === null)).toBe(true);
      const again = await m2.generateRecurringOrders(T0, { tenantId: EQUA_TENANT_ID });
      expect(again.errors).toEqual([]);
      expect(await t.db.select().from(orders).where(eq(orders.recurringOrderId, r.id))).toHaveLength(2);
      const job = await runJobNow("m2.recurring_generate", T0);
      expect(job.status).toBe("succeeded");
      expect(await t.db.select().from(orders).where(eq(orders.recurringOrderId, r.id))).toHaveLength(2);
      // Prioritas BR-21: rit langganan di urutan atas kolom Belum terjadwal.
      const board = await m2.getBoard(dispatcher(), TODAY);
      const recurringIdx = board.unscheduled.findIndex((u) => u.orderId === made.find((o) => o.requestedDate === TODAY)!.id);
      const plain = board.unscheduled.findIndex((u) => !u.recurring && !u.overdue && !u.fixedReceiveTime);
      expect(recurringIdx).toBeGreaterThanOrEqual(0);
      if (plain >= 0) expect(recurringIdx).toBeLessThan(plain);
    });

    it("US-M2-06 KP-3 pola dijeda tidak menghasilkan pesanan; mengubah pola tidak mengubah pesanan yang sudah dibuat", async () => {
      const c = await customer(t.db);
      const r = await m2.createRecurringOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, pattern: "interval", intervalDays: 1, startDate: TODAY, tankCount: 1 });
      await m2.generateRecurringOrders(T0, { tenantId: EQUA_TENANT_ID });
      const made = await t.db.select().from(orders).where(eq(orders.recurringOrderId, r.id));
      expect(made.length).toBe(3);
      await m2.updateRecurringOrder(dispatcher(), r.id, { customerId: c.id, addressId: c.addressId!, pattern: "interval", intervalDays: 1, startDate: TODAY, tankCount: 4 });
      const unchanged = await t.db.select().from(orders).where(eq(orders.recurringOrderId, r.id));
      expect(unchanged.every((o) => o.tankCount === 1)).toBe(true);
      await m2.setRecurringStatus(dispatcher(), r.id, { status: "paused", reason: "Libur hotel" });
      await m2.generateRecurringOrders(at(24), { tenantId: EQUA_TENANT_ID });
      expect(await t.db.select().from(orders).where(eq(orders.recurringOrderId, r.id))).toHaveLength(3);
    });

    it("US-M2-06 KP-4 langganan yang gagal dibuat (kredit ditahan) masuk daftar untuk Dispatcher + notifikasi; dapat ditindaklanjuti", async () => {
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: 5_000_000 });
      const r = await m2.createRecurringOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, pattern: "interval", intervalDays: 10, startDate: TODAY, paymentMethod: "credit" });
      await t.db.update(customers).set({ creditStatus: "on_hold" }).where(eq(customers.id, c.id));
      const res = await m2.generateRecurringOrders(T0, { tenantId: EQUA_TENANT_ID });
      expect(res.failed).toBeGreaterThan(0);
      const failures = await m2.listRecurringFailures(dispatcher());
      const mine = failures.find((f) => f.recurringOrderId === r.id)!;
      expect(mine).toMatchObject({ reason: "credit_on_hold", targetDate: TODAY });
      const again = await m2.generateRecurringOrders(T0, { tenantId: EQUA_TENANT_ID });
      expect(again.errors).toEqual([]);
      expect(await t.db.select().from(recurringOrderFailures).where(eq(recurringOrderFailures.recurringOrderId, r.id))).toHaveLength(1);
      expect((await t.db.select().from(notifications).where(eq(notifications.event, "order.recurring_failed"))).length).toBeGreaterThan(0);
      await m2.resolveRecurringFailure(dispatcher(), mine.id, { note: "Pelanggan dihubungi, tunggu pelunasan" });
      expect((await m2.listRecurringFailures(dispatcher())).find((f) => f.id === mine.id)).toBeUndefined();
      const x = await exportReport(dispatcher(), "m2.recurring_failures", "xlsx", {});
      expect(x.rowCount).toBeGreaterThan(0);
    });
  });

  // ===================================================================================================================
  describe("US-M2-07 Konfirmasi pesanan ke pelanggan lewat WA", () => {
    it("US-M2-07 KP-1 template (dikelola pemilik) memuat nomor, tanggal/jam, tangki, harga, cara bayar, kontak; tombol membuka WhatsApp ke nomor pelanggan", async () => {
      const c = await customer(t.db);
      const o = await order(c, { tankCount: 2 });
      const msg = await m2.previewOrderConfirmation(dispatcher(), o.order.id);
      const cust = (await t.db.select().from(customers).where(eq(customers.id, c.id)))[0]!;
      expect(msg.link.startsWith(`https://wa.me/${cust.waPhone}?text=`)).toBe(true);
      expect(msg.text).toContain(o.order.number);
      expect(msg.text).toContain("2 tangki");
      expect(msg.text).toContain("Tunai");
      await expect(m2.updateOrderConfirmationTemplate(dispatcher(), { body: "Halo {{nomor_pesanan}}", reason: "coba" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(m2.updateOrderConfirmationTemplate(owner(), { body: "Pesanan {{nomor_pesanan}} dicatat, terima kasih banyak.", reason: "Singkat" })).rejects.toBeInstanceOf(ValidationError);
      const tpl = await m2.updateOrderConfirmationTemplate(owner(), {
        body: "Pesanan {{nomor_pesanan}}: {{jumlah_tangki}} tangki, {{tanggal_kirim}} {{jam_kirim}}, {{harga_per_rit}}/rit, bayar {{cara_bayar}}. Kontak {{kontak_equa}}.",
        reason: "Versi ringkas",
      });
      expect(tpl.version).toBe(2);
      const old = await t.db.select().from(waTemplates).where(and(eq(waTemplates.kind, "order_confirmation"), eq(waTemplates.version, 1)));
      expect(old[0]!.isActive).toBe(false);
      expect((await m2.previewOrderConfirmation(dispatcher(), o.order.id)).text).toMatch(/^Pesanan P-26-/);
    });

    it("US-M2-07 KP-2 sistem mencatat 'konfirmasi dibuka' (waktu, pelaku) tanpa klaim terkirim/terbaca", async () => {
      const c = await customer(t.db);
      const o = await order(c);
      const res = await m2.sendOrderConfirmation(dispatcher(at(1)), o.order.id);
      expect(res.mode).toBe("link");
      const log = (await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.objectId, o.order.id)))[0]!;
      expect(log).toMatchObject({ status: "link_opened", provider: "link", openedBy: userIdByUsername("dispatcher1"), sentAt: null });
      expect(log.openedAt?.toISOString()).toBe(at(1).toISOString());
      const detail = await m2.getOrderDetail(dispatcher(), o.order.id);
      expect(detail.waLogs[0]).toMatchObject({ status: "link_opened", openedByName: "Rina Marlina" });
      await expect(m2.sendOrderConfirmation(owner(), o.order.id)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M2-07 KP-3 bila WhatsApp Business API aktif pengiriman otomatis tanpa mengubah alur Dispatcher", async () => {
      const c = await customer(t.db);
      const o = await order(c);
      const sent: string[] = [];
      const api: WhatsAppProvider = { kind: "cloud_api", send: async (r) => (sent.push(r.to), { mode: "cloud_api", status: "sent", providerMessageId: "wamid.1" }) };
      const res = await m2.sendOrderConfirmation(dispatcher(), o.order.id, { provider: api });
      expect(res.mode).toBe("sent");
      expect(sent).toHaveLength(1);
      const log = (await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.objectId, o.order.id)))[0]!;
      expect(log).toMatchObject({ provider: "cloud_api", status: "sent", providerMessageId: "wamid.1" });
    });
  });

  // ===================================================================================================================
  describe("US-M2-08 Riwayat dan catatan khusus pelanggan", () => {
    it("US-M2-08 KP-1 panel pelanggan: 10 pesanan terakhir (tanggal, jumlah, status, truk), piutang terbuka & batas tersisa, catatan khusus, harga khusus", async () => {
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: 2_000_000 });
      await t.db.update(customers).set({ notes: "Gerbang belakang, klakson 2x", fixedReceiveTime: "08:00" }).where(eq(customers.id, c.id));
      await openInvoice(t.db, c.id, 250_000);
      const truck = await truckWithCrew(t.db);
      const o = await order(c);
      await m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: truck.id, date: TODAY });
      for (let i = 0; i < 11; i++) await order(c, { date: TOMORROW, extra: i > 0 });
      const summary = await m1.getCustomerSummary(dispatcher(), c.id);
      expect(summary.lastOrders).toHaveLength(10);
      expect(summary.openReceivable).toBe(250_000);
      expect(summary.notes).toBe("Gerbang belakang, klakson 2x");
      expect(summary.fixedReceiveTime?.slice(0, 5)).toBe("08:00");
      const withTruck = await m1.getCustomerSummary(dispatcher(), c.id);
      expect(withTruck.remainingLimit).toBeLessThan(2_000_000);
      const preview = await m2.previewOrder(dispatcher(), { customerId: c.id, addressId: c.addressId! });
      expect(preview.customer.notes).toBe("Gerbang belakang, klakson 2x");
    });

    it("US-M2-08 KP-2 catatan khusus ikut terkirim ke aplikasi sopir pada rit terkait (pull m2.schedule)", async () => {
      const date = today();
      const c = await customer(t.db);
      await t.db.update(customers).set({ notes: "Anjing galak, telepon dulu" }).where(eq(customers.id, c.id));
      const res = await m2.createOrder(dispatcher(new Date()), { customerId: c.id, addressId: c.addressId!, requestedDate: date, notes: "Isi tandon atas", forceSameDayReason: "Uji sinkron sopir" });
      if (res.status !== "created") throw new Error(res.status);
      await m2.assignTrip(dispatcher(new Date()), { tripId: res.trips[0]!.id, truckId: seedTruckId("T1"), date });
      await m2.publishSchedule(dispatcher(new Date()), { truckId: seedTruckId("T1"), date });
      const hp = await fieldDevice("HP-T1");
      const sopir = await hp.login("sopir1");
      const pull = await hp.pull(sopir, { keys: "m2.schedule" });
      const data = pull.data["m2.schedule"] as m2.DriverSchedule;
      const trip = data.trips.find((x) => x.id === res.trips[0]!.id)!;
      expect(trip).toMatchObject({ customerNotes: "Anjing galak, telepon dulu", orderNotes: "Isi tandon atas", locked: false, truckCode: "T1" });
      const again = await hp.pull(sopir, { keys: "m2.schedule", since: pull.cursor });
      expect(again.data["m2.schedule"]).toBeUndefined();
      expect(listPullProviders().map(([k]) => k)).toContain("m2.schedule");
    });

    it("US-M2-08 KP-3 riwayat lengkap dapat diekspor per pelanggan", async () => {
      const c = await customer(t.db);
      await order(c);
      await order(c, { date: TOMORROW });
      const hist = await m2.customerOrderHistory(dispatcher(), c.id);
      expect(hist.rows).toHaveLength(2);
      const x = await exportReport(dispatcher(), "m2.customer_history", "xlsx", { customerId: c.id });
      expect(x.rowCount).toBe(2);
      const pdf = await exportReport(owner(), "m2.customer_history", "pdf", { customerId: c.id }, "Tinjauan riwayat pelanggan");
      expect(pdf.containsPersonalData).toBe(true);
    });
  });

  // ===================================================================================================================
  describe("Registrasi modul M2", () => {
    it("handler event, persetujuan, job, laporan, dan pull terdaftar lewat bootstrap", () => {
      expect(listHandlers("trip.departed")).toContain("m2-orders:order_in_delivery");
      expect(listHandlers("trip.completed")).toContain("m2-orders:order_completed");
      expect(listHandlers("trip.failed")).toContain("m2-orders:trip_failed");
      expect(listHandlers("credit_status.changed")).toContain("m2-orders:credit_hold_trips");
      expect(getJob("m2.recurring_generate")).toBeTruthy();
      expect(getJob("m2.unscheduled_morning")).toBeTruthy();
      for (const k of ["m2.orders", "m2.customer_history", "m2.schedule", "m2.cancel_fail_monthly", "m2.kpi06_monthly", "m2.overrides_monthly", "m2.crew_assignments", "m2.crew_roster", "m2.recurring_orders", "m2.recurring_failures"]) {
        expect(getReport(k), k).toBeTruthy();
      }
    });

    it("US-M2-03 notifikasi 6.3 'pesanan hari ini belum terjadwal' pada pagi H (job PAR-07), satu per hari", async () => {
      const c = await customer(t.db);
      await order(c);
      const morning = new Date(`${TODAY}T00:00:00Z`);
      const r = await runJobNow("m2.unscheduled_morning", morning);
      expect(r.status).toBe("succeeded");
      const rows = await t.db.select().from(notifications).where(and(eq(notifications.event, "order.unscheduled"), eq(notifications.recipientUserId, userIdByUsername("dispatcher1"))));
      expect(rows.some((n) => n.link === `/jadwal?tanggal=${TODAY}`)).toBe(true);
      expect(toBusinessDate(morning)).toBe(TODAY);
    });

    it("PTB-27 status kredit Ditahan → rit tempo belum berangkat ditandai; tidak dapat terbit sampai diubah ke tunai", async () => {
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: 10_000_000 });
      const truck = await truckWithCrew(t.db);
      const o = await m2.createOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, requestedDate: TODAY, paymentMethod: "credit" });
      if (o.status !== "created") throw new Error(o.status);
      await m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: truck.id, date: TODAY });
      await t.db.update(customers).set({ creditStatus: "on_hold" }).where(eq(customers.id, c.id));
      await emitEvent("credit_status.changed", { customerId: c.id, from: "credit", to: "on_hold", reason: "Lewat tempo > 7 hari", automatic: true, rule: "BR-03" }, { now: at(1) });
      const trip = (await t.db.select().from(trips).where(eq(trips.id, o.trips[0]!.id)))[0]!;
      expect(trip.creditHoldFlaggedAt).toBeTruthy();
      expect((await m2.getBoard(dispatcher(at(1)), TODAY)).lanes.find((l) => l.truck.id === truck.id)!.trips[0]!.creditHold).toBe(true);
      await expect(m2.publishSchedule(dispatcher(at(1)), { truckId: truck.id, date: TODAY })).rejects.toMatchObject({ code: "PUBLISH_BLOCKED" });
      await m2.changePaymentMethod(dispatcher(at(1)), o.order.id, { paymentMethod: "cash", reason: "Pelanggan Ditahan, bayar tunai" });
      expect((await t.db.select().from(trips).where(eq(trips.id, o.trips[0]!.id)))[0]!.creditHoldResolution).toBe("changed_to_cash");
      await m2.publishSchedule(dispatcher(at(1)), { truckId: truck.id, date: TODAY });
      expect((await t.db.select().from(notifications).where(eq(notifications.event, "order.credit_hold_trips"))).length).toBeGreaterThan(0);
    });

    it("PTB-13 harga berubah sebelum kirim → peringatan di rincian; perbarui harga hanya dengan catatan konfirmasi pelanggan", async () => {
      const c = await customer(t.db);
      const o = await order(c, { date: TOMORROW });
      const tariff = (await m1.resolveTruckWaterPrice(t.db, { customerId: c.id, addressId: c.addressId!, date: TOMORROW })).zoneTariffId!;
      await t.db.update(zoneTariffs).set({ pricePerTrip: 999_000 }).where(eq(zoneTariffs.id, tariff));
      const detail = await m2.getOrderDetail(dispatcher(), o.order.id);
      expect(detail.priceChange?.changed).toBe(true);
      await expect(m2.refreshOrderPrice(dispatcher(), o.order.id, { note: "" })).rejects.toBeInstanceOf(ValidationError);
      const updated = await m2.refreshOrderPrice(dispatcher(), o.order.id, { note: "Pelanggan setuju harga baru via telepon" });
      expect(updated.pricePerTrip).toBe(detail.priceChange!.currentUnitPrice);
      expect(updated.priceUpdateNote).toMatch(/setuju/);
    });
  });
});
