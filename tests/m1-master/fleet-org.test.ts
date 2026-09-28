import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  attachments,
  auditLogs,
  customers,
  devices,
  domainEvents,
  employees,
  notifications,
  outlets,
  trips,
  trucks,
  waterMeters,
  waterSources,
} from "@/db/schema";
import {
  deviceId,
  EQUA_TENANT_ID,
  POOL_ID,
  truckId,
  userIdByUsername,
} from "@/db/seed";
import { addDays } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as m1 from "@/server/modules/m1-master";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";
import {
  createOrder,
  createScheduledTrip,
  createCustomer,
} from "../helpers/fixtures";
import { days, dispatcher, owner, sysadmin, T0, TODAY } from "./helpers";

describe("M1 Master Data", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  let plateSeq = 100;
  const plate = () => `F ${9000 + plateSeq++} UJ`;

  describe("US-M1-03 Mengelola armada, kru, dan perangkat", () => {
    it("US-M1-03 KP-1 truk: nopol, kapasitas bawaan 5.000 L, status, sopir & kernet default, GPS & ponsel lapangan, kapasitas rit (PAR-33 bila kosong)", async () => {
      const driver = await createTestUser(t.db, { role: "driver" });
      const helper = await createTestUser(t.db, { role: "helper" });
      const truck = await m1.createTruck(dispatcher(), {
        code: "t9",
        plateNumber: plate(),
        defaultDriverEmployeeId: driver.employeeId,
        defaultHelperEmployeeId: helper.employeeId,
        gpsDeviceId: deviceId("GPS-CAD-1"),
        fieldDeviceId: deviceId("HP-CAD-1"),
        poolLocationId: POOL_ID,
      });
      expect(truck).toMatchObject({
        code: "T9",
        capacityL: 5000,
        status: "active",
        dailyTripCapacity: null,
      });
      expect(await m1.truckDailyTripCapacity(t.db, truck.id, TODAY)).toBe(3);
      const upd = await m1.updateTruck(dispatcher(), truck.id, {
        dailyTripCapacity: 4,
        capacityL: 6000,
      });
      expect(upd.dailyTripCapacity).toBe(4);
      expect(await m1.truckDailyTripCapacity(t.db, truck.id, TODAY)).toBe(4);
      const list = await m1.listTrucks(dispatcher());
      expect(list.find((x) => x.id === truck.id)).toMatchObject({
        gpsDeviceCode: "GPS-CAD-1",
        fieldDeviceCode: "HP-CAD-1",
        effectiveTripCapacity: 4,
      });
      await expect(
        m1.createTruck(owner(), { code: "T10", plateNumber: plate() }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        m1.createTruck(dispatcher(), {
          code: "T11",
          plateNumber: truck.plateNumber,
        }),
      ).rejects.toMatchObject({ code: "TRUCK_DUPLICATE" });
    });

    it("US-M1-03 KP-2 truk Perbaikan/Nonaktif tidak menerima rit; rit Ditugaskan ditandai untuk dipindahkan + notifikasi Dispatcher + event", async () => {
      const truck = await m1.createTruck(dispatcher(), {
        code: "T12",
        plateNumber: plate(),
      });
      const c = await createCustomer(t.db, { segment: "hotel" });
      const order = await createOrder(t.db, {
        customerId: c.id,
        addressId: c.addressId!,
        date: TODAY,
      });
      const trip = await createScheduledTrip(t.db, {
        order,
        truckId: truck.id,
        date: TODAY,
      });
      await expect(
        m1.setTruckStatus(dispatcher(), truck.id, {
          status: "maintenance",
          reason: "",
        }),
      ).rejects.toThrow(/Alasan/);
      const res = await m1.setTruckStatus(dispatcher(), truck.id, {
        status: "maintenance",
        reason: "Rem blong, bengkel 2 hari",
      });
      expect(res.truck.status).toBe("maintenance");
      expect(res.flaggedTrips.map((f) => f.id)).toContain(trip.id);
      const [row] = await t.db
        .select()
        .from(trips)
        .where(eq(trips.id, trip.id));
      expect(row!.needsReassignment).toBe(true);
      await expect(
        withTx((tx) => m1.assertTruckCanReceiveTrips(tx, truck.id)),
      ).rejects.toMatchObject({ code: "TRUCK_NOT_ACTIVE" });
      const n = await t.db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.event, "truck.trips_need_reassignment"),
            eq(notifications.recipientUserId, userIdByUsername("dispatcher1")),
          ),
        );
      expect(n.length).toBeGreaterThan(0);
      const trail = await t.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.objectType, "truck"),
            eq(auditLogs.objectId, truck.id),
            eq(auditLogs.rule, "US-M1-03 KP-2"),
          ),
        );
      expect(trail[0]!.before).toMatchObject({ status: "active" });
      expect(trail[0]!.after).toMatchObject({ status: "maintenance" });
      await m1.setTruckStatus(dispatcher(), truck.id, {
        status: "active",
        reason: "Selesai servis",
      });
      await expect(
        withTx((tx) => m1.assertTruckCanReceiveTrips(tx, truck.id)),
      ).resolves.toBeTruthy();
      const off = await m1.setTruckStatus(owner(), truck.id, {
        status: "inactive",
        reason: "Dijual",
      });
      expect(off.truck.isActive).toBe(false);
    });

    it("US-M1-03 KP-3 kru = karyawan berperan Sopir/Kernet; satu karyawan hanya satu truk default", async () => {
      const driver = await createTestUser(t.db, {
        roles: ["driver", "helper"],
      });
      const finance = await createTestUser(t.db, { role: "finance_admin" });
      await m1.createTruck(dispatcher(), {
        code: "T13",
        plateNumber: plate(),
        defaultDriverEmployeeId: driver.employeeId,
      });
      await expect(
        m1.createTruck(dispatcher(), {
          code: "T14",
          plateNumber: plate(),
          defaultDriverEmployeeId: driver.employeeId,
        }),
      ).rejects.toMatchObject({ code: "CREW_ALREADY_DEFAULT" });
      await expect(
        m1.createTruck(dispatcher(), {
          code: "T15",
          plateNumber: plate(),
          defaultHelperEmployeeId: driver.employeeId,
        }),
      ).rejects.toMatchObject({ code: "CREW_ALREADY_DEFAULT" });
      await expect(
        m1.createTruck(dispatcher(), {
          code: "T16",
          plateNumber: plate(),
          defaultDriverEmployeeId: finance.employeeId,
        }),
      ).rejects.toMatchObject({ code: "CREW_ROLE" });
      // Kru default truk seed (T1) tidak dapat dipasang di truk lain.
      const [t1] = await t.db
        .select()
        .from(trucks)
        .where(eq(trucks.id, truckId("T1")));
      await expect(
        m1.updateTruck(dispatcher(), truckId("T2"), {
          defaultDriverEmployeeId: t1!.defaultDriverEmployeeId,
        }),
      ).rejects.toMatchObject({ code: "CREW_ALREADY_DEFAULT" });
    });

    it("US-M1-03 KP-4 perangkat didaftarkan admin sistem (M10); M1 hanya memilih perangkat terdaftar sesuai jenis, bukan yang diblokir", async () => {
      await expect(
        m1.createTruck(dispatcher(), {
          code: "T17",
          plateNumber: plate(),
          gpsDeviceId: deviceId("HP-CAD-2"),
        }),
      ).rejects.toThrow(/berjenis GPS/);
      await expect(
        m1.createTruck(dispatcher(), {
          code: "T18",
          plateNumber: plate(),
          fieldDeviceId: deviceId("GPS-T1"),
        }),
      ).rejects.toThrow(/bukan perangkat GPS/);
      await expect(
        m1.createTruck(dispatcher(), {
          code: "T19",
          plateNumber: plate(),
          gpsDeviceId: deviceId("GPS-T2"),
        }),
      ).rejects.toMatchObject({ code: "DEVICE_IN_USE" });
      await t.db
        .update(devices)
        .set({ status: "blocked" })
        .where(eq(devices.id, deviceId("HP-CAD-2")));
      await expect(
        m1.createTruck(dispatcher(), {
          code: "T20",
          plateNumber: plate(),
          fieldDeviceId: deviceId("HP-CAD-2"),
        }),
      ).rejects.toMatchObject({ code: "DEVICE_BLOCKED" });
      const opts = await m1.truckFormOptions(dispatcher());
      expect(opts.gpsDevices.every((d) => d.label.startsWith("GPS-"))).toBe(
        true,
      );
      expect(
        opts.fieldDevices.some((d) => d.label.startsWith("HP-CAD-2")),
      ).toBe(false);
    });
  });

  describe("US-M1-04 Mengelola depot, sumber air, dan karyawan", () => {
    it("US-M1-04 KP-1 depot: kode, nama, tenant EQUA, koordinat & geofence, operator default, kapasitas simpan, status (+ pelanggan internal PTB-01)", async () => {
      const op = await createTestUser(t.db, { role: "depot_operator" });
      const depot = await m1.createOutlet(owner(), {
        code: "d11",
        name: "Depot EQUA Uji",
        kind: "depot",
        address: "Jl. Uji Depot, Cianjur",
        lat: -6.84,
        lng: 107.13,
        geofenceRadiusM: 80,
        storageCapacityL: 6000,
        defaultOperatorEmployeeId: op.employeeId,
      });
      expect(depot).toMatchObject({
        code: "D11",
        tenantId: EQUA_TENANT_ID,
        geofenceRadiusM: 80,
        storageCapacityL: 6000,
        isActive: true,
      });
      const internal = await t.db
        .select()
        .from(customers)
        .where(eq(customers.internalOutletId, depot.id));
      expect(internal[0]).toMatchObject({
        code: "INT-D11",
        segment: "third_party_depot",
        creditStatus: "cash",
      });
      const price = await m1.resolveInternalTransferPrice(t.db, {
        depotOutletId: depot.id,
        date: TODAY,
      });
      expect(price.unitPrice).toBeGreaterThan(0);
      await expect(
        m1.createOutlet(dispatcher(), {
          code: "D12",
          name: "X Depot",
          kind: "depot",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        m1.updateOutlet(owner(), depot.id, { code: "D99" }),
      ).rejects.toThrow(/tidak dapat diubah/);
      const upd = await m1.updateOutlet(owner(), depot.id, {
        storageCapacityL: 8000,
      });
      expect(upd.storageCapacityL).toBe(8000);
    });

    it("US-M1-04 KP-2 sumber air: nama, lokasi, kapasitas harian 50.000 L, geofence, meter (pengenal, satuan, angka awal cut-over, foto)", async () => {
      const src = await m1.createWaterSource(owner(), {
        code: "sa3",
        name: "Sumber Air Uji",
        address: "Kp. Uji",
        lat: -6.8,
        lng: 107.1,
        geofenceRadiusM: 120,
      });
      expect(src).toMatchObject({
        code: "SA3",
        dailyCapacityL: 50_000,
        geofenceRadiusM: 120,
      });
      const jpeg = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      ]);
      const photo = await withTx((tx) =>
        put(tx, owner(), {
          blob: jpeg,
          contentType: "image/jpeg",
          kind: "meter_photo",
        }),
      );
      const meter = await m1.addWaterMeter(owner(), src.id, {
        code: "MTR-SA3-01",
        unit: "liter",
        initialReadingL: 1_234_567,
        installedAt: TODAY,
        initialPhotoAttachmentId: photo.id,
      });
      expect(meter).toMatchObject({
        initialReadingL: 1_234_567,
        initialPhotoAttachmentId: photo.id,
        status: "active",
      });
      const [a] = await t.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, photo.id));
      expect(a).toMatchObject({
        objectType: "water_meter",
        objectId: meter.id,
      });
      const list = await m1.listWaterSources(owner());
      expect(list.find((s) => s.id === src.id)!.meters).toHaveLength(1);
      await expect(
        m1.addWaterMeter(owner(), src.id, {
          code: "MTR-SA3-01",
          initialReadingL: 0,
        }),
      ).rejects.toMatchObject({ code: "METER_DUPLICATE" });
      await expect(
        m1.createWaterSource(dispatcher(), {
          code: "SA4",
          name: "X Sumber",
          lat: -6.8,
          lng: 107.1,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M1-04 KP-3 karyawan: nama, jabatan, lokasi tugas, peran, tanggal masuk/keluar; tanggal keluar → employee.exited & akses dicabut hari itu (BR-37)", async () => {
      const emp = await m1.createEmployee(sysadmin(), {
        employeeNo: "EQ-900",
        fullName: "Karyawan Uji Keluar",
        position: "Sopir",
        intendedRoles: ["driver"],
        hireDate: "2026-01-05",
        workLocation: "Pool",
      });
      expect(emp.isActive).toBe(true);
      await expect(
        m1.createEmployee(owner(), {
          employeeNo: "EQ-901",
          fullName: "Xyz",
          position: "Sopir",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        m1.updateEmployee(sysadmin(), emp.id, { exitDate: "2025-12-31" }),
      ).rejects.toThrow(/sebelum tanggal masuk/);
      const exit = addDays(TODAY, 3);
      await m1.updateEmployee(sysadmin(), emp.id, { exitDate: exit });
      const scheduled = await t.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, "employee.exited"),
            eq(domainEvents.objectId, emp.id),
          ),
        );
      expect(scheduled[0]!.payload).toMatchObject({
        employeeId: emp.id,
        exitDate: exit,
        tenantId: EQUA_TENANT_ID,
      });
      // Belum tercapai → job tidak memproses.
      expect(
        (await withTx((tx) => m1.processEmployeeExits(tx, T0))).processed,
      ).toBe(0);
      // Tercapai → nonaktif + event dipancarkan lagi (M10 mencabut akses), sekali saja (idempoten).
      const r1 = await withTx((tx) => m1.processEmployeeExits(tx, days(3)));
      const r2 = await withTx((tx) => m1.processEmployeeExits(tx, days(4)));
      expect(r1.processed).toBe(1);
      expect(r2.processed).toBe(0);
      const [row] = await t.db
        .select()
        .from(employees)
        .where(eq(employees.id, emp.id));
      expect(row!.isActive).toBe(false);
      const all = await t.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, "employee.exited"),
            eq(domainEvents.objectId, emp.id),
          ),
        );
      // Satu saat tanggal keluar diisi + satu saat tercapai.
      expect(all).toHaveLength(2);
      // Keluar hari ini → langsung nonaktif & dilepas dari kru default.
      const drv = await createTestUser(t.db, { role: "driver" });
      const truck = await m1.createTruck(dispatcher(), {
        code: "T21",
        plateNumber: plate(),
        defaultDriverEmployeeId: drv.employeeId,
      });
      await m1.updateEmployee(sysadmin(), drv.employeeId, { exitDate: TODAY });
      const [tr] = await t.db
        .select()
        .from(trucks)
        .where(eq(trucks.id, truck.id));
      expect(tr!.defaultDriverEmployeeId).toBeNull();
    });

    it("US-M1-04 KP-4 semua entitas dinonaktifkan beralasan, bukan dihapus (DB menolak DELETE)", async () => {
      const pool = await m1.createPool(owner(), {
        code: "pl9",
        name: "Pool Uji",
        lat: -6.81,
        lng: 107.16,
      });
      expect(pool.approvedBy).toBe(userIdByUsername("pemilik"));
      const offPool = await m1.setPoolActive(owner(), pool.id, {
        active: false,
        reason: "Sewa habis",
      });
      expect(offPool.isActive).toBe(false);
      const depot = (
        await t.db.select().from(outlets).where(eq(outlets.code, "D10"))
      )[0]!;
      const offDepot = await m1.setOutletActive(owner(), depot.id, {
        active: false,
        reason: "Renovasi",
      });
      expect(offDepot).toMatchObject({
        isActive: false,
        deactivationReason: "Renovasi",
      });
      await m1.setOutletActive(owner(), depot.id, {
        active: true,
        reason: "Buka kembali",
      });
      const src = (
        await t.db
          .select()
          .from(waterSources)
          .where(eq(waterSources.code, "SA2"))
      )[0]!;
      const offSrc = await m1.setWaterSourceActive(owner(), src.id, {
        active: false,
        reason: "Perbaikan pompa",
      });
      expect(offSrc.isActive).toBe(false);
      await m1.setWaterSourceActive(owner(), src.id, {
        active: true,
        reason: "Pompa normal",
      });
      const emp = await m1.createEmployee(sysadmin(), {
        employeeNo: "EQ-902",
        fullName: "Karyawan Nonaktif",
        position: "Kernet",
        intendedRoles: ["helper"],
      });
      const offEmp = await m1.setEmployeeActive(sysadmin(), emp.id, {
        active: false,
        reason: "Cuti panjang",
      });
      expect(offEmp.isActive).toBe(false);
      const meter = (await t.db.select().from(waterMeters).limit(1))[0]!;
      await expect(
        t.db.delete(waterMeters).where(eq(waterMeters.id, meter.id)),
      ).rejects.toThrow();
      await expect(
        t.db.delete(outlets).where(eq(outlets.id, depot.id)),
      ).rejects.toThrow();
      await expect(
        t.db.delete(employees).where(eq(employees.id, emp.id)),
      ).rejects.toThrow();
      await expect(
        m1.setOutletActive(owner(), depot.id, { active: false, reason: "" }),
      ).rejects.toThrow(/Alasan/);
    });
  });
});
