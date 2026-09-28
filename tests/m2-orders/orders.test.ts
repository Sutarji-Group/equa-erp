import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, auditLogs, customers, invoices, notifications, orders, trips, unbilledCharges } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { EQUA_TENANT_ID, internalCustomerId, outletId, productId, seedId, userIdByUsername } from "@/db/seed";
import * as approvals from "@/server/core/approvals";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import * as m1 from "@/server/modules/m1-master";
import * as m2 from "@/server/modules/m2-orders";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { AFTER_CUTOFF, at, customer, dispatcher, dispatcher2, emitEvent, finance, openInvoice, owner, T0, TODAY, TOMORROW, truckWithCrew } from "./helpers";

type Created = Extract<m2.CreateOrderResult, { status: "created" }>;

describe("M2 Pesanan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  async function create(input: Partial<m2.CreateOrderInput> & { customerId: string; addressId: string }, ctx = dispatcher()): Promise<Created> {
    const res = await m2.createOrder(ctx, { requestedDate: TODAY, ...input });
    if (res.status !== "created") throw new Error(`hasil tak terduga: ${res.status}`);
    return res;
  }

  // ===================================================================================================================
  describe("US-M2-01 Membuat pesanan dalam kurang dari 60 detik", () => {
    it("US-M2-01 KP-1 bawaan layar: tanggal hari ini sebelum 15.00 (PAR-05), H+1 sesudahnya; tangki 1; tunai; jam terima tetap terisi", async () => {
      const before = await m2.orderFormDefaults(dispatcher(T0));
      expect(before).toMatchObject({ defaultDate: TODAY, afterCutoff: false, sameDayCutoff: "15:00" });
      const after = await m2.orderFormDefaults(dispatcher(AFTER_CUTOFF));
      expect(after).toMatchObject({ defaultDate: TOMORROW, afterCutoff: true });

      const c = await customer(t.db);
      await t.db.update(customers).set({ fixedReceiveTime: "07:30" }).where(eq(customers.id, c.id));
      const res = await create({ customerId: c.id, addressId: c.addressId!, requestedDate: undefined });
      expect(res.order.requestedDate).toBe(TODAY);
      expect(res.order.tankCount).toBe(1);
      expect(res.order.paymentMethod).toBe("cash");
      expect(res.order.requestedTime?.slice(0, 5)).toBe("07:30");
      const preview = await m2.previewOrder(dispatcher(), { customerId: c.id, addressId: c.addressId! });
      expect(preview.defaultTime).toBe("07:30");
    });

    it("US-M2-01 KP-1 cari pelanggan ≥ 2 karakter ≤ 1 detik; alamat bawaan = alamat terakhir dipakai pesanan", async () => {
      const c = await customer(t.db);
      await create({ customerId: c.id, addressId: c.addressId! });
      const started = Date.now();
      const found = await m1.searchCustomers(dispatcher(), c.code);
      expect(Date.now() - started).toBeLessThan(1000);
      const hit = found.find((f) => f.id === c.id)!;
      expect(hit.lastAddressId).toBe(c.addressId);
      expect(await m1.searchCustomers(dispatcher(), "U")).toEqual([]);
    });

    it("US-M2-01 KP-2 harga per rit otomatis dari zona + BBM atau harga khusus; total = harga × tangki; Dispatcher tidak dapat mengubah harga (BR-19)", async () => {
      const c = await customer(t.db);
      const master = await m1.resolveTruckWaterPrice(t.db, { customerId: c.id, addressId: c.addressId!, date: TODAY });
      const preview = await m2.previewOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, tankCount: 3 });
      expect(preview.price).toMatchObject({ pricePerTrip: master.unitPrice, totalAmount: master.unitPrice * 3, source: "zone" });
      const res = await create({ customerId: c.id, addressId: c.addressId!, tankCount: 3, ...({ pricePerTrip: 1, totalAmount: 1 } as object) });
      expect(res.order.pricePerTrip).toBe(master.unitPrice);
      expect(res.order.totalAmount).toBe(master.unitPrice * 3);
      expect(res.trips.every((tr) => tr.price === master.unitPrice)).toBe(true);
    });

    it("US-M2-01 KP-3 pelanggan baru di layar yang sama (nama, WA, alamat, segmen) otomatis Tunai lalu langsung dipesan", async () => {
      const created = await m1.quickCreateCustomer(dispatcher(), {
        name: `Warung Baru ${Math.random().toString(36).slice(2, 7)}`,
        waPhone: `0813${String(Date.now()).slice(-8)}`,
        segment: "industry",
        addressText: "Jl. Pesanan Baru No. 1, Cianjur",
        manualZoneId: seedId("tariff_zone:Z2"),
        manualZoneReason: "Belum ada koordinat",
        confirmDuplicate: true,
      });
      if (created.status !== "created") throw new Error("duplikat");
      expect(created.customer.creditStatus).toBe("cash");
      const res = await create({ customerId: created.customer.id, addressId: created.addresses[0]!.id });
      expect(res.order.status).toBe("new");
      const credit = await m2.createOrder(dispatcher(), { customerId: created.customer.id, addressId: created.addresses[0]!.id, requestedDate: TOMORROW, paymentMethod: "credit" });
      expect(credit).toMatchObject({ status: "credit_blocked", check: { reason: "cash_customer", canRequestApproval: false } });
    });

    it("US-M2-01 KP-4 H+0 setelah 15.00 diusulkan H+1; paksa H+0 wajib alasan dan tercatat (BR-20, 6.2c)", async () => {
      const c = await customer(t.db);
      await expect(m2.createOrder(dispatcher(AFTER_CUTOFF), { customerId: c.id, addressId: c.addressId!, requestedDate: TODAY })).rejects.toMatchObject({ code: "AFTER_CUTOFF" });
      const auto = await m2.createOrder(dispatcher(AFTER_CUTOFF), { customerId: c.id, addressId: c.addressId! });
      expect(auto.status === "created" && auto.order.requestedDate).toBe(TOMORROW);
      const forced = await create({ customerId: c.id, addressId: c.addressId!, requestedDate: TODAY, forceSameDayReason: "Pelanggan darurat, truk T1 masih kosong" }, dispatcher(AFTER_CUTOFF));
      expect(forced.order).toMatchObject({ afterCutoffForced: true, afterCutoffReason: "Pelanggan darurat, truk T1 masih kosong" });
      const log = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "order"), eq(auditLogs.objectId, forced.order.id), eq(auditLogs.action, "create")));
      expect(log[0]?.rule).toBe("BR-20 6.2c");
      const review = await m2.overridesReport(owner(AFTER_CUTOFF), "2026-10");
      expect(review.some((r) => r.number === forced.order.number && r.kind === "after_cutoff")).toBe(true);
    });

    it("US-M2-01 KP-5 n tangki → n rit bernomor /1../n yang dapat dijadwalkan ke truk dan hari berbeda (PTB-09)", async () => {
      const c = await customer(t.db);
      const res = await create({ customerId: c.id, addressId: c.addressId!, tankCount: 2 });
      expect(res.trips.map((x) => x.number)).toEqual([`${res.order.number}/1`, `${res.order.number}/2`]);
      const a = await truckWithCrew(t.db);
      const b = await truckWithCrew(t.db);
      await m2.assignTrip(dispatcher(), { tripId: res.trips[0]!.id, truckId: a.id, date: TODAY });
      await m2.assignTrip(dispatcher(), { tripId: res.trips[1]!.id, truckId: b.id, date: TOMORROW });
      const rows = await t.db.select().from(trips).where(eq(trips.orderId, res.order.id));
      expect(rows.find((r) => r.sequenceInOrder === 1)).toMatchObject({ truckId: a.id, scheduledDate: TODAY });
      expect(rows.find((r) => r.sequenceInOrder === 2)).toMatchObject({ truckId: b.id, scheduledDate: TOMORROW });
    });

    it("US-M2-01 KP-6 pesanan internal pasokan depot: pelanggan depot sendiri, produk transfer internal, cara bayar internal, tampil di papan (PTB-01)", async () => {
      const cid = internalCustomerId("D01");
      const addr = seedId("address:internal:D01");
      const res = await create({ customerId: cid, addressId: addr, paymentMethod: "credit" });
      expect(res.order).toMatchObject({ isInternal: true, paymentMethod: "internal", priceSource: "internal_transfer", productId: productId("AIR-TRUK-INT"), internalOutletId: outletId("D01") });
      expect(res.trips[0]).toMatchObject({ isInternal: true, paymentMethod: "internal", destinationOutletId: outletId("D01") });
      const board = await m2.getBoard(dispatcher(), TODAY);
      expect(board.unscheduled.find((u) => u.id === res.trips[0]!.id)?.isInternal).toBe(true);
      await expect(create({ customerId: (await customer(t.db)).id, addressId: (await customer(t.db)).addressId!, paymentMethod: "internal" })).rejects.toThrow();
    });

    it("US-M2-01 KP-7 (proksi otomatis UAT) 10 pesanan berturut untuk pelanggan yang sudah ada tersimpan tanpa pindah layar, masing-masing < 2 detik di layanan", async () => {
      const c = await customer(t.db);
      for (let i = 0; i < 10; i++) {
        const started = Date.now();
        const res = await m2.createOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, requestedDate: TOMORROW, duplicateDecision: i ? "additional" : undefined, duplicateReason: i ? `Tambahan ke-${i}` : undefined });
        expect(res.status).toBe("created");
        expect(Date.now() - started).toBeLessThan(2000);
      }
    });

    it("US-M2-01 KP-8 setelah tersimpan nomor pesanan tersedia untuk ditampilkan besar + konfirmasi WA dapat dibuka", async () => {
      const c = await customer(t.db);
      const res = await create({ customerId: c.id, addressId: c.addressId! });
      expect(res.order.number).toMatch(/^P-26-\d{6}$/);
      const msg = await m2.previewOrderConfirmation(dispatcher(), res.order.id);
      expect(msg.text).toContain(res.order.number);
    });

    it("US-M2-01 menolak Pemilik (SOD-08) dan Admin Keuangan (SOD-03) membuat pesanan", async () => {
      const c = await customer(t.db);
      await expect(m2.createOrder(owner(), { customerId: c.id, addressId: c.addressId! })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(m2.createOrder(finance(), { customerId: c.id, addressId: c.addressId! })).rejects.toMatchObject({ rule: "SOD-03" });
    });

    it("US-M2-01 pelanggan nonaktif / alamat bukan milik pelanggan ditolak dengan pesan tindakan", async () => {
      const c = await customer(t.db);
      const other = await customer(t.db);
      await expect(create({ customerId: c.id, addressId: other.addressId! })).rejects.toThrow(/Alamat kirim tidak ditemukan/);
      await t.db.update(customers).set({ isActive: false }).where(eq(customers.id, c.id));
      await expect(create({ customerId: c.id, addressId: c.addressId! })).rejects.toThrow(/nonaktif/);
    });
  });

  // ===================================================================================================================
  describe("US-M2-02 Nomor dan status pesanan", () => {
    it("US-M2-02 KP-1 nomor otomatis unik berurutan per tahun P-YY-NNNNNN; nomor rit = nomor pesanan + urutan tangki", async () => {
      const c = await customer(t.db);
      const a = await create({ customerId: c.id, addressId: c.addressId! });
      const b = await create({ customerId: c.id, addressId: c.addressId!, requestedDate: TOMORROW });
      const na = Number(a.order.number.slice(5));
      const nb = Number(b.order.number.slice(5));
      expect(a.order.number.slice(0, 5)).toBe("P-26-");
      expect(nb).toBe(na + 1);
      expect(a.trips[0]!.number).toBe(`${a.order.number}/1`);
    });

    it("US-M2-02 KP-2 siklus Baru → Terjadwal → Dalam pengiriman → Selesai; tiap transisi mencatat waktu & pelaku; Selesai terkunci", async () => {
      const c = await customer(t.db);
      const truck = await truckWithCrew(t.db);
      const res = await create({ customerId: c.id, addressId: c.addressId! });
      const trip = res.trips[0]!;
      await m2.assignTrip(dispatcher(), { tripId: trip.id, truckId: truck.id, date: TODAY });
      await m2.publishSchedule(dispatcher(at(0.5)), { truckId: truck.id, date: TODAY });
      expect((await t.db.select().from(orders).where(eq(orders.id, res.order.id)))[0]!.status).toBe("scheduled");
      await t.db.update(trips).set({ status: "departed", departedAt: at(1), driverUserId: truck.driver.userId }).where(eq(trips.id, trip.id));
      await emitEvent("trip.departed", { tripId: trip.id, orderId: res.order.id, truckId: truck.id, driverUserId: truck.driver.userId, departedAt: at(1).toISOString() }, { now: at(1), actorUserId: truck.driver.userId });
      expect((await t.db.select().from(orders).where(eq(orders.id, res.order.id)))[0]!.status).toBe("in_delivery");
      await t.db.update(trips).set({ status: "completed", completedAt: at(2) }).where(eq(trips.id, trip.id));
      await emitEvent(
        "trip.completed",
        { tripId: trip.id, orderId: res.order.id, customerId: c.id, truckId: truck.id, driverUserId: truck.driver.userId, isInternal: false, volumeL: 5000, price: trip.price, paymentMethod: "cash", cashReceived: trip.price, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0, completedAt: at(2).toISOString(), recordedByOffice: false, lateSync: false },
        { now: at(2), actorUserId: truck.driver.userId },
      );
      const done = (await t.db.select().from(orders).where(eq(orders.id, res.order.id)))[0]!;
      expect(done).toMatchObject({ status: "completed" });
      expect(done.completedAt).toBeTruthy();
      const statusLogs = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "order"), eq(auditLogs.objectId, res.order.id), eq(auditLogs.action, "status")));
      const seq = statusLogs.sort((x, y) => x.seq - y.seq).map((l) => (l.after as { status: string }).status);
      expect(seq).toEqual(["scheduled", "in_delivery", "completed"]);
      expect(statusLogs.find((l) => (l.after as { status: string }).status === "scheduled")?.actorUserId).toBe(userIdByUsername("dispatcher1"));
      expect(statusLogs.find((l) => (l.after as { status: string }).status === "in_delivery")?.actorUserId).toBe(truck.driver.userId);
      await expect(m2.cancelOrder(dispatcher(), res.order.id, { reason: "customer_cancelled" })).rejects.toBeInstanceOf(ConflictError);
      await expect(m2.rescheduleOrder(dispatcher(), res.order.id, { requestedDate: TOMORROW, reason: "coba ubah" })).rejects.toBeInstanceOf(ConflictError);
    });

    it("US-M2-02 KP-3 pembatalan wajib alasan dari daftar (Lainnya + teks); rit ditarik; Dalam pengiriman tidak dapat dibatalkan dari kantor", async () => {
      const c = await customer(t.db);
      const res = await create({ customerId: c.id, addressId: c.addressId! });
      await expect(m2.cancelOrder(dispatcher(), res.order.id, { reason: "bukan_alasan" as never })).rejects.toBeInstanceOf(ValidationError);
      await expect(m2.cancelOrder(dispatcher(), res.order.id, { reason: "other" })).rejects.toBeInstanceOf(ValidationError);
      const cancelled = await m2.cancelOrder(dispatcher(), res.order.id, { reason: "other", note: "Pelanggan pindah pemasok" });
      expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "other", cancelNote: "Pelanggan pindah pemasok" });
      expect((await t.db.select().from(trips).where(eq(trips.orderId, res.order.id)))[0]!.withdrawnAt).toBeTruthy();

      const truck = await truckWithCrew(t.db);
      const moving = await create({ customerId: c.id, addressId: c.addressId!, requestedDate: TOMORROW });
      await m2.assignTrip(dispatcher(), { tripId: moving.trips[0]!.id, truckId: truck.id, date: TODAY });
      await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
      await t.db.update(trips).set({ status: "departed", departedAt: at(1) }).where(eq(trips.id, moving.trips[0]!.id));
      await emitEvent("trip.departed", { tripId: moving.trips[0]!.id, orderId: moving.order.id, truckId: truck.id, driverUserId: null, departedAt: at(1).toISOString() }, { now: at(1) });
      await expect(m2.cancelOrder(dispatcher(at(2)), moving.order.id, { reason: "customer_cancelled" })).rejects.toMatchObject({ code: "ORDER_IN_DELIVERY" });
    });

    it("US-M2-02 KP-4 cari & saring: nomor, pelanggan, tanggal, status, truk, cara bayar; ekspor Excel/PDF", async () => {
      const c = await customer(t.db);
      const truck = await truckWithCrew(t.db);
      const a = await create({ customerId: c.id, addressId: c.addressId!, paymentMethod: "transfer" });
      await m2.assignTrip(dispatcher(), { tripId: a.trips[0]!.id, truckId: truck.id, date: TODAY });
      expect((await m2.listOrders(dispatcher(), { q: a.order.number })).map((r) => r.id)).toEqual([a.order.id]);
      expect((await m2.listOrders(dispatcher(), { customerId: c.id })).length).toBeGreaterThan(0);
      expect((await m2.listOrders(dispatcher(), { truckId: truck.id })).map((r) => r.id)).toContain(a.order.id);
      expect((await m2.listOrders(dispatcher(), { paymentMethod: "transfer", from: TODAY, to: TODAY })).map((r) => r.id)).toContain(a.order.id);
      expect((await m2.listOrders(dispatcher(), { status: "cancelled", customerId: c.id })).length).toBe(0);
      const xlsx = await exportReport(dispatcher(), "m2.orders", "xlsx", { customerId: c.id });
      expect(xlsx.rowCount).toBeGreaterThan(0);
      const pdf = await exportReport(owner(), "m2.orders", "pdf", { from: TODAY, to: TODAY }, "Rekap pesanan harian untuk pemilik");
      expect(pdf.contentType).toBe("application/pdf");
      await expect(exportReport(finance(), "m2.orders", "xlsx", {})).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  // ===================================================================================================================
  describe("US-M2-04 Peringatan pesanan dobel", () => {
    it("US-M2-04 KP-1 pelanggan + alamat + tanggal sama dengan pesanan berjalan → tampil pesanan yang ada (nomor, jumlah, status, pembuat) + pilihan", async () => {
      const c = await customer(t.db);
      const first = await create({ customerId: c.id, addressId: c.addressId!, tankCount: 2 });
      const dup = await m2.createOrder(dispatcher2(), { customerId: c.id, addressId: c.addressId!, requestedDate: TODAY });
      expect(dup.status).toBe("duplicate");
      if (dup.status !== "duplicate") return;
      expect(dup.existing[0]).toMatchObject({ number: first.order.number, tankCount: 2, status: "new", createdByName: "Rina Marlina" });
      await expect(m2.createOrder(dispatcher2(), { customerId: c.id, addressId: c.addressId!, requestedDate: TODAY, duplicateDecision: "additional" })).rejects.toBeInstanceOf(ValidationError);
      const extra = await create({ customerId: c.id, addressId: c.addressId!, duplicateDecision: "additional", duplicateReason: "Kolam diisi dua kali hari ini" }, dispatcher2());
      expect(extra.order).toMatchObject({ possibleDuplicate: true, duplicateOfOrderId: first.order.id, duplicateReason: "Kolam diisi dua kali hari ini" });
      const notif = await t.db.select().from(notifications).where(and(eq(notifications.event, "order.duplicate"), eq(notifications.objectId, extra.order.id)));
      expect(notif.map((n) => n.recipientUserId)).toContain(userIdByUsername("dispatcher1"));
      const cancel = await m2.createOrder(dispatcher2(), { customerId: c.id, addressId: c.addressId!, requestedDate: TODAY, duplicateDecision: "cancel" });
      expect(cancel.status).toBe("cancelled_duplicate");
      if (cancel.status === "cancelled_duplicate") expect(cancel.order).toMatchObject({ status: "cancelled", cancelReason: "duplicate" });
    });

    it("US-M2-04 KP-2 penanda 'kemungkinan dobel' tetap di papan sampai salah satunya Selesai/Dibatalkan", async () => {
      const c = await customer(t.db);
      const first = await create({ customerId: c.id, addressId: c.addressId! });
      const extra = await create({ customerId: c.id, addressId: c.addressId!, duplicateDecision: "additional", duplicateReason: "Tambahan" });
      const board = await m2.getBoard(dispatcher(), TODAY);
      expect(board.unscheduled.find((u) => u.orderId === extra.order.id)?.possibleDuplicate).toBe(true);
      await m2.cancelOrder(dispatcher(), first.order.id, { reason: "duplicate" });
      expect((await t.db.select().from(orders).where(eq(orders.id, extra.order.id)))[0]!.possibleDuplicate).toBe(false);
    });

    it("US-M2-04 KP-3 KPI-06 bulanan: dibatalkan alasan dobel + lewat tanggal tanpa jadwal ulang; dapat diekspor", async () => {
      const c = await customer(t.db);
      const first = await create({ customerId: c.id, addressId: c.addressId! });
      await create({ customerId: c.id, addressId: c.addressId!, duplicateDecision: "additional", duplicateReason: "Tambahan" });
      await m2.cancelOrder(dispatcher(), first.order.id, { reason: "duplicate" });
      const report = await m2.kpi06Report(owner(at(48)), "2026-10");
      expect(report.rows.some((r) => r.kind === "duplicate_cancelled" && r.number === first.order.number)).toBe(true);
      expect(report.rows.some((r) => r.kind === "overdue_unscheduled")).toBe(true);
      const x = await exportReport(owner(at(48)), "m2.kpi06_monthly", "xlsx", { month: "2026-10" });
      expect(x.rowCount).toBe(report.rows.length);
    });
  });

  // ===================================================================================================================
  describe("US-M2-05 Kontrol kredit pada pesanan tempo", () => {
    it("US-M2-05 KP-1 tempo hanya untuk status Tempo; Tunai → tidak tersedia; Ditahan → ditolak dengan keterangan + dapat diajukan", async () => {
      const cash = await customer(t.db);
      const r1 = await m2.createOrder(dispatcher(), { customerId: cash.id, addressId: cash.addressId!, requestedDate: TODAY, paymentMethod: "credit" });
      expect(r1).toMatchObject({ status: "credit_blocked", check: { reason: "cash_customer", canRequestApproval: false } });
      const preview = await m2.previewOrder(dispatcher(), { customerId: cash.id, addressId: cash.addressId! });
      expect(preview.creditSelectable).toBe(false);
      expect(preview.creditNote).toMatch(/Tunai/);
      const hold = await customer(t.db, { creditStatus: "on_hold", creditLimit: 10_000_000 });
      const r2 = await m2.createOrder(dispatcher(), { customerId: hold.id, addressId: hold.addressId!, requestedDate: TODAY, paymentMethod: "credit" });
      expect(r2).toMatchObject({ status: "credit_blocked", check: { reason: "on_hold", canRequestApproval: true } });
      if (r2.status === "credit_blocked") expect(r2.check.message).toMatch(/lewat tempo/);
    });

    it("US-M2-05 KP-2 eksposur = piutang belum lunas + pesanan tempo berjalan + pesanan ini; > batas → ditolak dengan angka eksposur & batas", async () => {
      const probe = await customer(t.db);
      const unit = (await m1.resolveTruckWaterPrice(t.db, { customerId: probe.id, addressId: probe.addressId!, date: TODAY })).unitPrice;
      const limit = 300_000 + 100_000 + unit * 2;
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: limit });
      await openInvoice(t.db, c.id, 300_000);
      await t.db.insert(unbilledCharges).values({ tenantId: EQUA_TENANT_ID, customerId: c.id, serviceDate: TODAY, description: "Uji", amount: 100_000 });
      const ok = await create({ customerId: c.id, addressId: c.addressId!, paymentMethod: "credit" });
      const exposure = await m2.computeCreditExposure(t.db, c.id, { extraAmount: 0 });
      expect(exposure).toMatchObject({ openInvoices: 300_000, unbilledCharges: 100_000, openCreditOrders: ok.order.totalAmount });
      const blocked = await m2.createOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, requestedDate: TOMORROW, paymentMethod: "credit", tankCount: 2 });
      expect(blocked.status).toBe("credit_blocked");
      if (blocked.status !== "credit_blocked") return;
      expect(blocked.check.exposure.exposure).toBe(300_000 + 100_000 + ok.order.totalAmount + blocked.check.exposure.extraAmount);
      expect(blocked.check.exposure.exposure).toBeGreaterThan(limit);
      expect(blocked.check.message).toContain(`melampaui batas kredit ${formatRupiah(limit)}`);
    });

    it("US-M2-05 KP-3 ajukan persetujuan → Menunggu persetujuan, tidak dapat dijadwalkan; pemilik memutuskan; Dispatcher dapat ubah ke tunai kapan saja", async () => {
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: 100_000 });
      const truck = await truckWithCrew(t.db);
      const res = await create({ customerId: c.id, addressId: c.addressId!, paymentMethod: "credit", creditApprovalReason: "Hotel langganan, bayar akhir pekan" });
      expect(res.order.status).toBe("awaiting_approval");
      expect(res.approvalNumbers).toHaveLength(1);
      await expect(m2.assignTrip(dispatcher(), { tripId: res.trips[0]!.id, truckId: truck.id, date: TODAY })).rejects.toMatchObject({ code: "AWAITING_APPROVAL" });
      const approval = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, res.order.creditApprovalRequestId!)))[0]!;
      expect(approval).toMatchObject({ type: "credit_order", status: "submitted", objectId: res.order.id });
      expect(approval.deadlineAt).toBeTruthy();
      await expect(approvals.decide(dispatcher(), approval.id, "approve")).rejects.toBeInstanceOf(ForbiddenError);
      await approvals.decide(owner(at(1)), approval.id, "approve", "Boleh untuk pesanan ini");
      expect((await t.db.select().from(orders).where(eq(orders.id, res.order.id)))[0]!.status).toBe("new");
      await m2.assignTrip(dispatcher(at(1)), { tripId: res.trips[0]!.id, truckId: truck.id, date: TODAY });

      const res2 = await create({ customerId: c.id, addressId: c.addressId!, requestedDate: TOMORROW, paymentMethod: "credit", creditApprovalReason: "Coba lagi" });
      expect(res2.order.status).toBe("awaiting_approval");
      const changed = await m2.changePaymentMethod(dispatcher(), res2.order.id, { paymentMethod: "cash", reason: "Pelanggan setuju tunai" });
      expect(changed.status === "updated" && changed.order).toMatchObject({ status: "new", paymentMethod: "cash" });
      expect((await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, res2.order.creditApprovalRequestId!)))[0]!.status).toBe("cancelled");
      expect((await t.db.select().from(trips).where(eq(trips.orderId, res2.order.id)))[0]!.paymentMethod).toBe("cash");
    });

    it("US-M2-05 KP-3 ditolak pemilik (alasan wajib) → tidak dapat dijadwalkan sampai diubah ke tunai; lewat tenggat → tetap tunai", async () => {
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: 100_000 });
      const truck = await truckWithCrew(t.db);
      const res = await create({ customerId: c.id, addressId: c.addressId!, paymentMethod: "credit", creditApprovalReason: "Mohon izin" });
      await expect(approvals.decide(owner(at(1)), res.order.creditApprovalRequestId!, "reject")).rejects.toBeInstanceOf(ValidationError);
      await approvals.decide(owner(at(1)), res.order.creditApprovalRequestId!, "reject", "Piutang terlalu besar");
      await expect(m2.assignTrip(dispatcher(at(1)), { tripId: res.trips[0]!.id, truckId: truck.id, date: TODAY })).rejects.toMatchObject({ code: "CREDIT_REJECTED" });

      const res2 = await create({ customerId: c.id, addressId: c.addressId!, requestedDate: TOMORROW, paymentMethod: "credit", creditApprovalReason: "Mohon izin" });
      const expired = await approvals.expireDue(new Date(res2.order.createdAt.getTime() + 3 * 86_400_000));
      expect(expired.expired).toBeGreaterThan(0);
      const after = (await t.db.select().from(orders).where(eq(orders.id, res2.order.id)))[0]!;
      expect(after).toMatchObject({ status: "new", paymentMethod: "cash" });
    });

    it("US-M2-05 KP-4 persetujuan berlaku untuk pesanan itu saja — batas pelanggan tidak berubah, pesanan tempo berikutnya tetap dinilai", async () => {
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: 100_000 });
      const res = await create({ customerId: c.id, addressId: c.addressId!, paymentMethod: "credit", creditApprovalReason: "Sekali ini" });
      await approvals.decide(owner(at(1)), res.order.creditApprovalRequestId!, "approve");
      expect((await t.db.select().from(customers).where(eq(customers.id, c.id)))[0]!.creditLimit).toBe(100_000);
      const next = await m2.createOrder(dispatcher(at(1)), { customerId: c.id, addressId: c.addressId!, requestedDate: TOMORROW, paymentMethod: "credit" });
      expect(next.status).toBe("credit_blocked");
    });

    it("US-M2-05 KP-5 keputusan dan eksposur saat keputusan tercatat pada pesanan", async () => {
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: 150_000 });
      await openInvoice(t.db, c.id, 50_000);
      const res = await create({ customerId: c.id, addressId: c.addressId!, paymentMethod: "credit", creditApprovalReason: "Izin" });
      await approvals.decide(owner(at(1)), res.order.creditApprovalRequestId!, "approve", "OK");
      const after = (await t.db.select().from(orders).where(eq(orders.id, res.order.id)))[0]!;
      expect(after.creditExposureAtDecision).toBe(50_000 + res.order.totalAmount);
      expect(after.creditLimitAtDecision).toBe(150_000);
      const detail = await m2.getOrderDetail(owner(at(1)), res.order.id);
      expect(detail.timeline.some((x) => x.action === "credit_approved")).toBe(true);
      expect(detail.approvals[0]!.status).toBe("approved");
    });

    it("US-M2-05 KP-6 faktur kurang bayar terbuka → 'tagih kurang bayar'; kurang bayar kedua → hanya dijadwalkan setelah lunas atau disetujui pemilik (PTB-18)", async () => {
      const c = await customer(t.db);
      const truck = await truckWithCrew(t.db);
      const inv1 = await openInvoice(t.db, c.id, 40_000, "underpayment");
      const one = await create({ customerId: c.id, addressId: c.addressId! });
      expect(one.order.collectUnderpayment).toBe(true);
      expect(one.warnings.join(" ")).toMatch(/Tagih kurang bayar/);
      await openInvoice(t.db, c.id, 25_000, "underpayment");
      const two = await create({ customerId: c.id, addressId: c.addressId!, requestedDate: TOMORROW });
      await expect(m2.assignTrip(dispatcher(), { tripId: two.trips[0]!.id, truckId: truck.id, date: TOMORROW })).rejects.toMatchObject({ code: "SECOND_UNDERPAYMENT" });
      const approval = await m2.requestUnderpaymentApproval(dispatcher(), two.order.id, { reason: "Pelanggan janji lunasi saat kirim" });
      expect((await t.db.select().from(orders).where(eq(orders.id, two.order.id)))[0]!.status).toBe("awaiting_approval");
      await approvals.decide(owner(at(1)), approval.id, "approve");
      const assigned = await m2.assignTrip(dispatcher(at(1)), { tripId: two.trips[0]!.id, truckId: truck.id, date: TOMORROW });
      expect(assigned.trip.truckId).toBe(truck.id);
      // Setelah lunas, pesanan lain tidak lagi terhalang.
      const three = await create({ customerId: c.id, addressId: c.addressId!, requestedDate: TOMORROW, duplicateDecision: "additional", duplicateReason: "Tambahan" });
      await expect(m2.assignTrip(dispatcher(), { tripId: three.trips[0]!.id, truckId: truck.id, date: TOMORROW })).rejects.toMatchObject({ code: "SECOND_UNDERPAYMENT" });
      await t.db.update(invoices).set({ paidAmount: inv1.amount, outstandingAmount: 0, status: "paid" }).where(eq(invoices.id, inv1.id));
      await m2.assignTrip(dispatcher(), { tripId: three.trips[0]!.id, truckId: truck.id, date: TOMORROW });
    });

    it("US-M2-05 menolak pengajuan persetujuan saat eksposur dalam batas & oleh pemilik (SOD-08)", async () => {
      const c = await customer(t.db, { creditStatus: "credit", creditLimit: 10_000_000 });
      const res = await create({ customerId: c.id, addressId: c.addressId!, paymentMethod: "credit" });
      expect(res.order.status).toBe("new");
      await expect(m2.requestCreditApproval(dispatcher(), res.order.id, { reason: "Coba" })).rejects.toMatchObject({ code: "CREDIT_OK" });
      await expect(m2.requestCreditApproval(owner(), res.order.id, { reason: "Coba" })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
