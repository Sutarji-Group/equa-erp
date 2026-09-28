import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditLogs, crewAssignments, customers, domainEvents, gpsPositions, orders, recurringOrders, scheduleChangeLogs, trips, trucks } from "@/db/schema";
import { EQUA_TENANT_ID, internalCustomerId, seedId } from "@/db/seed";
import { substituteDriverConditions } from "@/server/core/auth";
import { ForbiddenError, ValidationError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import { can } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";

import { bootstrapForTests } from "../helpers/bootstrap";
import { testContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";
import { at, customer, dispatcher, driverDeposit, emitEvent, finance, owner, T0, TODAY, TOMORROW, truckWithCrew, YESTERDAY } from "./helpers";

type Created = Extract<m2.CreateOrderResult, { status: "created" }>;

describe("M2 Papan jadwal & kru", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  async function order(opts: { tankCount?: number; date?: string; customerId?: string; addressId?: string; paymentMethod?: "cash" | "transfer" | "credit" } = {}): Promise<Created> {
    const c = opts.customerId ? { id: opts.customerId, addressId: opts.addressId! } : await customer(t.db);
    const res = await m2.createOrder(dispatcher(), {
      customerId: c.id,
      addressId: c.addressId!,
      requestedDate: opts.date ?? TODAY,
      tankCount: opts.tankCount ?? 1,
      paymentMethod: opts.paymentMethod,
      duplicateDecision: opts.customerId ? "additional" : undefined,
      duplicateReason: opts.customerId ? "Tambahan uji" : undefined,
    });
    if (res.status !== "created") throw new Error(res.status);
    return res;
  }

  // ===================================================================================================================
  describe("US-M2-03 Papan jadwal rit harian", () => {
    it("US-M2-03 KP-1 papan per tanggal: jalur per truk aktif + kru hari itu; 'Belum terjadwal' memuat rit tanggal itu dan tanggal lewat yang belum selesai + hitungan", async () => {
      const truck = await truckWithCrew(t.db);
      const today = await order();
      const past = await order({ date: TODAY });
      await t.db.update(trips).set({ scheduledDate: YESTERDAY }).where(eq(trips.orderId, past.order.id));
      const board = await m2.getBoard(dispatcher(), TODAY);
      const lane = board.lanes.find((l) => l.truck.id === truck.id)!;
      expect(lane.crew).toMatchObject({ driverEmployeeId: truck.driver.employeeId, driverSource: "default", helperEmployeeId: truck.helper.employeeId });
      expect(lane.canReceive).toBe(true);
      const ids = board.unscheduled.map((u) => u.id);
      expect(ids).toContain(today.trips[0]!.id);
      expect(ids).toContain(past.trips[0]!.id);
      expect(board.unscheduled.find((u) => u.id === past.trips[0]!.id)!.overdue).toBe(true);
      expect(board.totals.unscheduled).toBe(board.unscheduled.length);
      expect(board.totals.overdue).toBeGreaterThan(0);
      // Tanggal lewat ditampilkan paling atas (penonjolan).
      expect(board.unscheduled[0]!.overdue).toBe(true);
      // Truk seed T1..T7 tampil dengan sopir default.
      expect(board.lanes.find((l) => l.truck.code === "T1")?.crew.driverName).toBe("Asep Saepudin");
    });

    it("US-M2-03 KP-2 tugaskan & urutkan; hitungan pelanggan/internal terpisah & gabungan; volume vs kapasitas PAR-33 (atur per truk); lebih kapasitas = peringatan", async () => {
      const truck = await truckWithCrew(t.db, { capacity: 2 });
      const a = await order();
      const b = await order();
      const internal = await m2.createOrder(dispatcher(), { customerId: internalCustomerId("D02"), addressId: seedId("address:internal:D02"), requestedDate: TODAY });
      if (internal.status !== "created") throw new Error("internal");
      const r1 = await m2.assignTrip(dispatcher(), { tripId: a.trips[0]!.id, truckId: truck.id, date: TODAY });
      expect(r1.warnings).toEqual([]);
      await m2.assignTrip(dispatcher(), { tripId: b.trips[0]!.id, truckId: truck.id, date: TODAY, position: 1 });
      const r3 = await m2.assignTrip(dispatcher(), { tripId: internal.trips[0]!.id, truckId: truck.id, date: TODAY });
      expect(r3.warnings.join(" ")).toMatch(/melebihi kapasitas 2 rit/);
      const lane = (await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === truck.id)!;
      expect(lane.trips.map((x) => [x.id, x.routeOrder])).toEqual([
        [b.trips[0]!.id, 1],
        [a.trips[0]!.id, 2],
        [internal.trips[0]!.id, 3],
      ]);
      expect(lane.counts).toEqual({ customer: 2, internal: 1, total: 3 });
      expect(lane.volumeL).toBe(15_000);
      expect(lane.capacityTrips).toBe(2);
      expect(lane.capacityVolumeL).toBe(10_000);
      expect(lane.overCapacity).toBe(true);
      const plain = await truckWithCrew(t.db);
      expect((await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === plain.id)!.capacityTrips).toBe(3);
    });

    it("US-M2-03 KP-3 urutan usulan BR-21: langganan & jam-terima-tetap dulu (urut jam), sisanya urut waktu pesanan masuk; Dispatcher dapat mengubah", async () => {
      const truck = await truckWithCrew(t.db);
      const first = await order();
      const fixedCust = await customer(t.db);
      await t.db.update(customers).set({ fixedReceiveTime: "06:00" }).where(eq(customers.id, fixedCust.id));
      const fixed = await order({ customerId: fixedCust.id, addressId: fixedCust.addressId! });
      const rec = await order();
      const [pattern] = await t.db
        .insert(recurringOrders)
        .values({ tenantId: EQUA_TENANT_ID, customerId: rec.order.customerId, addressId: rec.order.addressId, pattern: "weekly", daysOfWeek: [1], startDate: TODAY, requestedTime: "08:00" })
        .returning();
      await t.db.update(orders).set({ recurringOrderId: pattern!.id, source: "recurring", requestedTime: "08:00" }).where(eq(orders.id, rec.order.id));
      for (const o of [first, rec, fixed]) await m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: truck.id, date: TODAY });
      let lane = (await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === truck.id)!;
      expect(lane.trips.map((x) => x.orderId)).toEqual([fixed.order.id, rec.order.id, first.order.id]);
      await m2.reorderTrips(dispatcher(), { truckId: truck.id, date: TODAY, tripIds: [first.trips[0]!.id, fixed.trips[0]!.id, rec.trips[0]!.id] });
      lane = (await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === truck.id)!;
      expect(lane.trips.map((x) => x.orderId)).toEqual([first.order.id, fixed.order.id, rec.order.id]);
      await m2.moveTripInLane(dispatcher(), { tripId: rec.trips[0]!.id, direction: "up" });
      await m2.applySuggestedOrder(dispatcher(), { truckId: truck.id, date: TODAY });
      lane = (await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === truck.id)!;
      expect(lane.trips.map((x) => x.orderId)).toEqual([fixed.order.id, rec.order.id, first.order.id]);
      expect(m2.compareBr21({ recurring: true, fixedTime: null, requestedTime: "09:00", orderCreatedAt: at(5), number: "b" }, { recurring: false, fixedTime: null, requestedTime: null, orderCreatedAt: at(0), number: "a" })).toBeLessThan(0);
    });

    it("US-M2-03 KP-4 tolak truk Perbaikan/Nonaktif atau tanpa sopir hari itu dengan pesan", async () => {
      const o = await order();
      const broken = await truckWithCrew(t.db);
      await t.db.update(trucks).set({ status: "maintenance" }).where(eq(trucks.id, broken.id));
      await expect(m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: broken.id, date: TODAY })).rejects.toMatchObject({ code: "TRUCK_NOT_ACTIVE" });
      const inactive = await truckWithCrew(t.db);
      await t.db.update(trucks).set({ status: "inactive", isActive: false }).where(eq(trucks.id, inactive.id));
      await expect(m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: inactive.id, date: TODAY })).rejects.toThrow(/Nonaktif/);
      const dayOff = await truckWithCrew(t.db);
      await m2.setTruckDayStatus(dispatcher(), { truckId: dayOff.id, date: TODAY, status: "maintenance", reason: "Ganti ban" });
      await expect(m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: dayOff.id, date: TODAY })).rejects.toMatchObject({ code: "TRUCK_MAINTENANCE_DAY" });
      const noDriver = await truckWithCrew(t.db);
      await m2.setRosterEntry(dispatcher(), { employeeId: noDriver.driver.employeeId, date: TODAY, status: "off", notes: "Sakit" });
      await expect(m2.assignTrip(dispatcher(), { tripId: o.trips[0]!.id, truckId: noDriver.id, date: TODAY })).rejects.toMatchObject({ code: "TRUCK_NO_DRIVER" });
      await expect(m2.assignTrip(finance(), { tripId: o.trips[0]!.id, truckId: noDriver.id, date: TODAY })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M2-03 KP-5 'Terbitkan' → rit terbit + event trip.published; perubahan setelah terbit tercatat & terbit ulang; rit Berangkat tidak dapat dipindah; harga sementara tidak dapat terbit", async () => {
      const truck = await truckWithCrew(t.db);
      const other = await truckWithCrew(t.db);
      const a = await order();
      const b = await order();
      await m2.assignTrip(dispatcher(), { tripId: a.trips[0]!.id, truckId: truck.id, date: TODAY });
      const pub = await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
      expect(pub.revision).toBe(0);
      const tripRow = (await t.db.select().from(trips).where(eq(trips.id, a.trips[0]!.id)))[0]!;
      expect(tripRow).toMatchObject({ status: "assigned", driverEmployeeId: truck.driver.employeeId });
      expect(tripRow.publishedAt).toBeTruthy();
      const events = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "trip.published"), eq(domainEvents.objectId, pub.scheduleId)));
      expect(events[0]?.payload).toMatchObject({ truckId: truck.id, revision: 0, tripIds: [a.trips[0]!.id] });
      await expect(m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY })).rejects.toMatchObject({ code: "NOTHING_TO_PUBLISH" });

      // Tambah rit setelah terbit → tercatat, jadwal "ada perubahan", terbit ulang revisi 1.
      await m2.assignTrip(dispatcher(), { tripId: b.trips[0]!.id, truckId: truck.id, date: TODAY });
      const logs = await t.db.select().from(scheduleChangeLogs).where(eq(scheduleChangeLogs.tripId, b.trips[0]!.id));
      expect(logs[0]).toMatchObject({ changeType: "added", afterPublish: true });
      expect((await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === truck.id)!.schedule!.pendingChanges).toBe(true);
      await expect(m2.unassignTrip(dispatcher(), { tripId: a.trips[0]!.id })).rejects.toBeInstanceOf(ValidationError);
      await m2.unassignTrip(dispatcher(), { tripId: a.trips[0]!.id, reason: "Pelanggan minta besok" });
      expect((await t.db.select().from(scheduleChangeLogs).where(eq(scheduleChangeLogs.tripId, a.trips[0]!.id))).some((l) => l.changeType === "withdrawn" && l.afterPublish)).toBe(true);
      const re = await m2.publishSchedule(dispatcher(at(1)), { truckId: truck.id, date: TODAY });
      expect(re.revision).toBe(1);

      // Rit Berangkat tidak dapat dipindah.
      await t.db.update(trips).set({ status: "departed", departedAt: at(2) }).where(eq(trips.id, b.trips[0]!.id));
      await expect(m2.assignTrip(dispatcher(), { tripId: b.trips[0]!.id, truckId: other.id, date: TODAY })).rejects.toMatchObject({ code: "TRIP_NOT_MOVABLE" });
      await expect(m2.unassignTrip(dispatcher(), { tripId: b.trips[0]!.id, reason: "coba" })).rejects.toMatchObject({ code: "TRIP_NOT_MOVABLE" });

      // Harga sementara (alamat tanpa zona) tidak dapat diterbitkan.
      const noZone = await customer(t.db, { zone: null });
      const temp = await order({ customerId: noZone.id, addressId: noZone.addressId! });
      expect(temp.order.priceIsProvisional).toBe(true);
      await m2.assignTrip(dispatcher(), { tripId: temp.trips[0]!.id, truckId: other.id, date: TODAY });
      await expect(m2.publishSchedule(dispatcher(), { truckId: other.id, date: TODAY })).rejects.toMatchObject({ code: "PUBLISH_BLOCKED" });
      await expect(m2.publishSchedule(owner(), { truckId: other.id, date: TODAY })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M2-03 KP-6 status rit real-time dari M3 & posisi truk terakhir (gps_positions) untuk peta berdampingan", async () => {
      const truck = await truckWithCrew(t.db);
      const a = await order();
      await m2.assignTrip(dispatcher(), { tripId: a.trips[0]!.id, truckId: truck.id, date: TODAY });
      await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
      await t.db.update(trips).set({ status: "departed", departedAt: at(1) }).where(eq(trips.id, a.trips[0]!.id));
      await emitEvent("trip.departed", { tripId: a.trips[0]!.id, orderId: a.order.id, truckId: truck.id, driverUserId: truck.driver.userId, departedAt: at(1).toISOString() }, { now: at(1) });
      await t.db.insert(gpsPositions).values([
        { tenantId: EQUA_TENANT_ID, truckId: truck.id, source: "gps_device", deviceTime: at(0.5), lat: -6.81, lng: 107.13 },
        { tenantId: EQUA_TENANT_ID, truckId: truck.id, source: "gps_device", deviceTime: at(1), lat: -6.82, lng: 107.14, speedKmh: 30 },
      ]);
      const lane = (await m2.getBoard(dispatcher(at(1)), TODAY)).lanes.find((l) => l.truck.id === truck.id)!;
      expect(lane.trips[0]!.status).toBe("departed");
      expect(lane.trips[0]!.orderStatus).toBe("in_delivery");
      expect(lane.lastPosition).toMatchObject({ lat: -6.82, lng: 107.14, speedKmh: 30 });
    });

    it("US-M2-03 KP-7 rit yang sopirnya terkunci karena setoran belum Ditutup (BR-10) ditandai pada papan", async () => {
      const truck = await truckWithCrew(t.db);
      await driverDeposit(t.db, { employeeId: truck.driver.employeeId, userId: truck.driver.userId, date: YESTERDAY, status: "submitted", truckId: truck.id });
      const a = await order();
      const res = await m2.assignTrip(dispatcher(), { tripId: a.trips[0]!.id, truckId: truck.id, date: TODAY });
      expect(res.warnings.join(" ")).toMatch(/BR-10/);
      const lane = (await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === truck.id)!;
      expect(lane.crew.lock).toMatchObject({ businessDate: YESTERDAY, status: "submitted" });
      expect(lane.crew.lockMessage).toMatch(/Admin Keuangan/);
      const pub = await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
      expect(pub.warnings.join(" ")).toMatch(/terkunci/);
    });

    it("US-M2-03 konflik: rit ditarik kantor tetapi dikerjakan offline → tetap sah, ditandai konflik di papan dan dapat ditindaklanjuti (Bab 6.4)", async () => {
      const truck = await truckWithCrew(t.db);
      const a = await order();
      await m2.assignTrip(dispatcher(), { tripId: a.trips[0]!.id, truckId: truck.id, date: TODAY });
      await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
      await m2.unassignTrip(dispatcher(), { tripId: a.trips[0]!.id, reason: "Tarik: truk dialihkan" });
      await t.db.update(trips).set({ status: "departed", departedAt: at(1) }).where(eq(trips.id, a.trips[0]!.id));
      await emitEvent("trip.departed", { tripId: a.trips[0]!.id, orderId: a.order.id, truckId: truck.id, driverUserId: truck.driver.userId, departedAt: at(1).toISOString() }, { now: at(1) });
      const board = await m2.getBoard(dispatcher(at(1)), TODAY);
      const conflict = board.conflicts.find((c) => c.id === a.trips[0]!.id)!;
      expect(conflict.syncConflict).toBe(true);
      expect(conflict.syncConflictNote).toMatch(/tetap sah/);
      expect((await t.db.select().from(orders).where(eq(orders.id, a.order.id)))[0]!.status).toBe("in_delivery");
      await m2.resolveTripConflict(dispatcher(at(2)), { tripId: a.trips[0]!.id, note: "Sudah dikonfirmasi sopir, rit sah" });
      expect((await m2.getBoard(dispatcher(at(2)), TODAY)).conflicts.find((c) => c.id === a.trips[0]!.id)).toBeUndefined();
    });

    it("US-M2-03 papan dapat diekspor (Excel) dan dibaca pemilik & Admin Keuangan tanpa hak ubah", async () => {
      const x = await exportReport(dispatcher(), "m2.schedule", "xlsx", { date: TODAY });
      expect(x.rowCount).toBeGreaterThan(0);
      const view = await m2.getBoard(finance(), TODAY);
      expect(view.canEdit).toBe(false);
      expect((await m2.getBoard(owner(), TODAY)).canPublish).toBe(false);
    });
  });

  // ===================================================================================================================
  describe("US-M2-10 Jadwal kerja kru dan ketersediaan truk", () => {
    it("US-M2-10 KP-1 jadwal mingguan per truk per hari: sopir, kernet, libur", async () => {
      const truck = await truckWithCrew(t.db);
      const spare = await createTestUser(t.db, { role: "driver", fullName: "Sopir Cadangan Roster" });
      await m2.setRosterEntry(dispatcher(), { employeeId: truck.driver.employeeId, date: TOMORROW, status: "off", notes: "Libur bergantian" });
      await m2.setRosterEntry(dispatcher(), { employeeId: spare.employeeId, date: TOMORROW, status: "on_duty", truckId: truck.id, role: "driver" });
      await expect(m2.setRosterEntry(dispatcher(), { employeeId: truck.helper.employeeId, date: TOMORROW, status: "on_duty", truckId: truck.id, role: "driver" })).rejects.toMatchObject({ code: "NOT_A_DRIVER" });
      const week = await m2.getWeekRoster(dispatcher(), TODAY);
      const cell = week.cells.find((c) => c.truckId === truck.id && c.date === TOMORROW)!;
      expect(cell.crew).toMatchObject({ driverEmployeeId: spare.employeeId, driverSource: "roster", helperEmployeeId: truck.helper.employeeId });
      expect(week.offByDate[TOMORROW]?.some((o) => o.employeeId === truck.driver.employeeId)).toBe(true);
      expect(week.dates).toHaveLength(7);
    });

    it("US-M2-10 KP-2 status truk per hari memengaruhi kapasitas; kapasitas harian = Σ truk beroperasi; beban = pelanggan + internal", async () => {
      const truck = await truckWithCrew(t.db);
      const before = (await m2.getWeekRoster(dispatcher(), TOMORROW, { days: 1 })).totals[0]!;
      await m2.setTruckDayStatus(dispatcher(), { truckId: truck.id, date: TOMORROW, status: "operating", tripCapacity: 5, reason: "Hari ramai" });
      const more = (await m2.getWeekRoster(dispatcher(), TOMORROW, { days: 1 })).totals[0]!;
      expect(more.capacity).toBe(before.capacity + 5 - 3);
      await expect(m2.setTruckDayStatus(dispatcher(), { truckId: truck.id, date: TOMORROW, status: "maintenance" })).rejects.toBeInstanceOf(ValidationError);
      await m2.setTruckDayStatus(dispatcher(), { truckId: truck.id, date: TOMORROW, status: "maintenance", reason: "Servis rem" });
      const less = (await m2.getWeekRoster(dispatcher(), TOMORROW, { days: 1 })).totals[0]!;
      expect(less.capacity).toBe(before.capacity - 3);
      expect(less.scheduled).toBe(less.customer + less.internal);
    });

    it("US-M2-10 KP-3 papan menampilkan kapasitas vs terjadwal; melebihi kapasitas diperingatkan, tidak diblokir", async () => {
      const truck = await truckWithCrew(t.db, { capacity: 1 });
      const a = await order({ date: TOMORROW });
      const b = await order({ date: TOMORROW });
      await m2.assignTrip(dispatcher(), { tripId: a.trips[0]!.id, truckId: truck.id, date: TOMORROW });
      const r = await m2.assignTrip(dispatcher(), { tripId: b.trips[0]!.id, truckId: truck.id, date: TOMORROW });
      expect(r.trip.truckId).toBe(truck.id);
      expect(r.warnings[0]).toMatch(/melebihi kapasitas/);
      const board = await m2.getBoard(dispatcher(), TOMORROW);
      expect(board.totals.capacity).toBeGreaterThan(0);
      expect(board.lanes.find((l) => l.truck.id === truck.id)!.overCapacity).toBe(true);
      const cell = (await m2.getWeekRoster(dispatcher(), TOMORROW, { days: 1 })).cells.find((c) => c.truckId === truck.id)!;
      expect(cell).toMatchObject({ tripCapacity: 1, scheduledTrips: 2 });
    });

    it("US-M2-10 KP-4 tanpa jadwal mingguan papan memakai kru default, penetapan harian (US-M2-11), dan PAR-33", async () => {
      const truck = await truckWithCrew(t.db);
      const lane = (await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === truck.id)!;
      expect(lane.crew.driverSource).toBe("default");
      expect(lane.capacityTrips).toBe(3);
      await m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: truck.helper.employeeId, reason: "Sopir izin keluarga" });
      const after = (await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === truck.id)!;
      expect(after.crew).toMatchObject({ driverSource: "assignment", driverEmployeeId: truck.helper.employeeId, substitute: true });
    });
  });

  // ===================================================================================================================
  describe("US-M2-11 Penetapan pengemudi pengganti harian", () => {
    it("US-M2-11 KP-1 pengemudi hari itu: sopir default, kernet truk itu, atau sopir lain yang tidak bertugas; ubah wajib alasan", async () => {
      const truck = await truckWithCrew(t.db);
      const busy = await truckWithCrew(t.db);
      const spare = await createTestUser(t.db, { role: "driver", fullName: "Sopir Lepas" });
      const clerk = await createTestUser(t.db, { role: "depot_operator", fullName: "Bukan Sopir" });
      const d1 = await m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: truck.driver.employeeId });
      expect(d1.source).toBe("default_driver");
      await expect(m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: spare.employeeId })).rejects.toBeInstanceOf(ValidationError);
      const d2 = await m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: spare.employeeId, reason: "Sopir default sakit" });
      expect(d2.source).toBe("other_driver");
      await expect(m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: busy.driver.employeeId, reason: "Pinjam sopir" })).rejects.toMatchObject({ code: "DRIVER_BUSY" });
      await expect(m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: clerk.employeeId, reason: "Coba" })).rejects.toMatchObject({ code: "NOT_ELIGIBLE_DRIVER" });
      const d3 = await m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: truck.helper.employeeId, reason: "Kernet menggantikan" });
      expect(d3.source).toBe("helper");
      const rows = await t.db.select().from(crewAssignments).where(and(eq(crewAssignments.truckId, truck.id), eq(crewAssignments.businessDate, TODAY)));
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => !r.supersededAt)).toHaveLength(1);
      await expect(m2.setDailyDriver(owner(), { truckId: truck.id, date: TODAY, employeeId: truck.driver.employeeId, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
      const candidates = await m2.driverCandidates(dispatcher(), truck.id, TODAY);
      expect(candidates.find((c) => c.employeeId === busy.driver.employeeId)).toMatchObject({ available: false });
    });

    it("US-M2-11 KP-2 kernet pengganti mendapat hak tindakan sopir hanya untuk truk & tanggal itu; kernet yang tidak ditetapkan tetap hanya membaca", async () => {
      const truck = await truckWithCrew(t.db);
      const other = await truckWithCrew(t.db);
      await m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: truck.helper.employeeId, reason: "Sopir cuti" });
      const helperCtx = testContext({ role: "helper", userId: truck.helper.userId, employeeId: truck.helper.employeeId, scope: { truckIds: [truck.id] }, now: T0 });
      const cond = await substituteDriverConditions(t.db, helperCtx, truck.id, TODAY);
      expect(cond.substitute_driver).toBe(true);
      expect(can(helperCtx, "m3.trip.complete", cond)).toBe(true);
      expect((await substituteDriverConditions(t.db, helperCtx, truck.id, TOMORROW)).substitute_driver).toBe(false);
      const otherHelper = testContext({ role: "helper", userId: other.helper.userId, employeeId: other.helper.employeeId, scope: { truckIds: [other.id] }, now: T0 });
      const c2 = await substituteDriverConditions(t.db, otherHelper, other.id, TODAY);
      expect(c2.substitute_driver).toBe(false);
      expect(can(otherHelper, "m3.trip.complete", c2)).toBe(false);
      expect(can(otherHelper, "m3.trip.read")).toBe(true);
    });

    it("US-M2-11 KP-3 ganti pengemudi di tengah hari: rit yang sudah Berangkat tetap atas nama pelaksananya, sisanya atas nama pengemudi baru", async () => {
      const truck = await truckWithCrew(t.db);
      const a = await order();
      const b = await order();
      await m2.assignTrip(dispatcher(), { tripId: a.trips[0]!.id, truckId: truck.id, date: TODAY });
      await m2.assignTrip(dispatcher(), { tripId: b.trips[0]!.id, truckId: truck.id, date: TODAY });
      await m2.publishSchedule(dispatcher(), { truckId: truck.id, date: TODAY });
      await t.db.update(trips).set({ status: "completed", departedAt: at(1), completedAt: at(2), driverUserId: truck.driver.userId }).where(eq(trips.id, a.trips[0]!.id));
      await m2.setDailyDriver(dispatcher(at(3)), { truckId: truck.id, date: TODAY, employeeId: truck.helper.employeeId, reason: "Sopir pulang sakit siang" });
      const rows = await t.db.select().from(trips).where(eq(trips.truckId, truck.id));
      expect(rows.find((r) => r.id === a.trips[0]!.id)).toMatchObject({ driverUserId: truck.driver.userId, driverEmployeeId: truck.driver.employeeId });
      expect(rows.find((r) => r.id === b.trips[0]!.id)).toMatchObject({ driverEmployeeId: truck.helper.employeeId });
    });

    it("US-M2-11 KP-4 pengemudi yang setoran hari sebelumnya belum Ditutup tidak dapat ditetapkan (BR-10) — alasan ditampilkan", async () => {
      const truck = await truckWithCrew(t.db);
      const spare = await createTestUser(t.db, { role: "driver", fullName: "Sopir Setoran Tertunda" });
      await driverDeposit(t.db, { employeeId: spare.employeeId, userId: spare.userId, date: YESTERDAY, status: "received" });
      await expect(m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: spare.employeeId, reason: "Ganti" })).rejects.toMatchObject({ code: "DRIVER_LOCKED_BR10" });
      await expect(m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: spare.employeeId, reason: "Ganti" })).rejects.toThrow(/belum menutup setoran/);
      const ok = await createTestUser(t.db, { role: "driver", fullName: "Sopir Setoran Beres" });
      await driverDeposit(t.db, { employeeId: ok.employeeId, date: YESTERDAY, status: "closed" });
      await driverDeposit(t.db, { employeeId: ok.employeeId, date: TODAY, status: "running" });
      const r = await m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: ok.employeeId, reason: "Ganti" });
      expect(r.driverEmployeeId).toBe(ok.employeeId);
    });

    it("US-M2-11 KP-5 setiap penetapan berjejak (pelaku, waktu, alasan), tampil di papan dan dapat diekspor untuk laporan kinerja", async () => {
      const truck = await truckWithCrew(t.db);
      const row = await m2.setDailyDriver(dispatcher(), { truckId: truck.id, date: TODAY, employeeId: truck.helper.employeeId, reason: "Sopir ke dokter" });
      const audit = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "crew_assignment"), eq(auditLogs.objectId, row.id)));
      expect(audit[0]).toMatchObject({ reason: "Sopir ke dokter", rule: "US-M2-11" });
      expect(audit[0]!.actorUserId).toBeTruthy();
      const lane = (await m2.getBoard(dispatcher(), TODAY)).lanes.find((l) => l.truck.id === truck.id)!;
      expect(lane.crew).toMatchObject({ substitute: true, reason: "Sopir ke dokter", assignedByName: "Rina Marlina" });
      const list = await m2.listCrewAssignments(owner(), { from: TODAY, to: TODAY, truckId: truck.id });
      expect(list[0]).toMatchObject({ reason: "Sopir ke dokter", source: "helper", active: true });
      const x = await exportReport(owner(), "m2.crew_assignments", "xlsx", { from: TODAY, to: TODAY });
      expect(x.rowCount).toBeGreaterThan(0);
    });
  });
});
