/**
 * B-43 — usulan koordinat alamat dari rit Selesai TANPA lokasi ponsel (`no_location`): memakai posisi perangkat GPS
 * truk saat Selesai (US-M12-04 KP-4) — dari penanda M12 `fleet_events(no_location).details.devicePosition`, atau
 * dihitung dengan aturan M12 bila handler M1 berjalan lebih dulu (alur event `trip.completed` nyata).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditLogs, customerAddresses, fleetEvents, gpsPositions, notifications, trips } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import * as m1 from "@/server/modules/m1-master";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createOrder, createScheduledTrip, createTruck } from "../helpers/fixtures";
import { dispatcher, T0, TODAY, uniqueWa } from "./helpers";

describe("B-43 usulan koordinat dari posisi GPS truk saat rit Selesai tanpa lokasi ponsel", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  /** Pelanggan dengan alamat Belum dikunci + rit Selesai tanpa lokasi ponsel pada T0. */
  async function noLocationTrip() {
    const res = await m1.createCustomer(dispatcher(), {
      name: `Kolam Uji ${Math.random().toString(36).slice(2, 8)}`,
      segment: "swimming_pool",
      waPhone: uniqueWa(),
      addresses: [{ label: "Utama", addressText: "Kp. Tanpa Sinyal, Cibeber", manualZoneId: null }],
      confirmDuplicate: true,
    });
    if (res.status !== "created") throw new Error("duplikat tak terduga");
    const address = res.addresses[0]!;
    const truck = await createTruck(t.db);
    const order = await createOrder(t.db, { customerId: res.customer.id, addressId: address.id, date: TODAY });
    const trip = await createScheduledTrip(t.db, { order, truckId: truck.id, date: TODAY });
    await t.db.update(trips).set({ status: "completed", completedAt: T0, completedLat: null, completedLng: null, noLocation: true, completionBusinessDate: TODAY }).where(eq(trips.id, trip.id));
    const payload = {
      tripId: trip.id,
      orderId: order.id,
      customerId: res.customer.id,
      truckId: truck.id,
      driverUserId: null,
      isInternal: false,
      volumeL: 5000,
      price: 200_000,
      paymentMethod: "cash" as const,
      cashReceived: 200_000,
      transferAmount: 0,
      creditAmount: 0,
      underpaymentAmount: 0,
      completedAt: T0.toISOString(),
      noLocation: true,
      lat: null,
      lng: null,
      recordedByOffice: false,
      lateSync: false,
    };
    return { res, address, truck, trip, payload };
  }

  it("B-43 US-M1-01 KP-2 US-M12-04 KP-4 rit Selesai tanpa lokasi ponsel → posisi perangkat GPS truk saat Selesai diusulkan (alur event nyata, M1 sebelum M12)", async () => {
    const { address, truck, trip, payload } = await noLocationTrip();
    // Fix perangkat GPS 2 menit sebelum Selesai (dalam jendela `inconsistency_window_minutes`).
    await t.db.insert(gpsPositions).values({ tenantId: EQUA_TENANT_ID, truckId: truck.id, source: "gps_device", deviceTime: new Date(T0.getTime() - 120_000), serverTime: T0, lat: -6.9012, lng: 107.1234, isValid: true, vendor: "uji" });
    await withTx((tx) => emit(tx, "trip.completed", payload, { tenantId: EQUA_TENANT_ID, occurredAt: T0 }));

    const [row] = await t.db.select().from(customerAddresses).where(eq(customerAddresses.id, address.id));
    expect(row).toMatchObject({ proposedLat: -6.9012, proposedLng: 107.1234, proposedFromTripId: trip.id, coordinateStatus: "unlocked" });
    // Penanda M12 "tanpa lokasi" menyimpan posisi perangkat yang sama.
    const [flag] = await t.db.select().from(fleetEvents).where(and(eq(fleetEvents.tripId, trip.id), eq(fleetEvents.kind, "no_location")));
    expect(flag!.details).toMatchObject({ devicePosition: { lat: -6.9012, lng: 107.1234 } });
    const [audit] = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "customer_address"), eq(auditLogs.objectId, address.id), eq(auditLogs.action, "update")));
    expect(audit!.after).toMatchObject({ pointSource: "gps_device" });
    const [note] = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "address.coordinate_proposed"), eq(notifications.objectId, address.id), eq(notifications.recipientUserId, userIdByUsername("dispatcher1"))));
    expect(note!.body).toContain("tanpa lokasi ponsel");
    const locked = await m1.confirmCoordinateProposal(dispatcher(), address.id);
    expect(locked).toMatchObject({ coordinateStatus: "locked", lat: -6.9012, lng: 107.1234 });
  });

  it("B-43 US-M12-04 KP-4 penanda M12 fleet_events(no_location).devicePosition dipakai bila sudah ada; tanpa posisi perangkat → tidak ada usulan", async () => {
    const withFlag = await noLocationTrip();
    await t.db.insert(fleetEvents).values({
      tenantId: EQUA_TENANT_ID,
      kind: "no_location",
      status: "done",
      truckId: withFlag.truck.id,
      tripId: withFlag.trip.id,
      businessDate: TODAY,
      startedAt: T0,
      details: { tripNumber: withFlag.trip.number, tripStatus: "completed", devicePosition: { lat: -6.95, lng: 107.2, at: T0.toISOString() } },
    });
    const r1 = await withTx((tx) => m1.proposeCoordinateFromTrip(tx, { tripId: withFlag.trip.id, tenantId: EQUA_TENANT_ID, now: T0 }));
    expect(r1).toEqual({ proposed: true, addressId: withFlag.address.id });
    const [a1] = await t.db.select().from(customerAddresses).where(eq(customerAddresses.id, withFlag.address.id));
    expect(a1).toMatchObject({ proposedLat: -6.95, proposedLng: 107.2 });

    // Tanpa fix perangkat di sekitar waktu Selesai → tidak ada usulan (alamat tetap Belum dikunci tanpa usulan).
    const bare = await noLocationTrip();
    const r2 = await withTx((tx) => m1.proposeCoordinateFromTrip(tx, { tripId: bare.trip.id, tenantId: EQUA_TENANT_ID, now: T0 }));
    expect(r2).toEqual({ proposed: false });
    const [a2] = await t.db.select().from(customerAddresses).where(eq(customerAddresses.id, bare.address.id));
    expect(a2!.proposedLat).toBeNull();
  });
});
