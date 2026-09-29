/**
 * Uji integrasi ronde M8 + M12: Produksi & Stok Air (M8) ↔ Pelacakan Armada / GPS (M12) lewat event domain. Kedua modul
 * dibangun paralel; M12 menguji geofence dengan baris pengisian tiruan dan M8 menguji penanda geofence dengan event
 * tiruan. Berkas ini memastikan keduanya tersambung setelah digabung: pengisian nyata dari aplikasi operator (sinkron
 * `m8.truck_fill.create`) → `truck_fill.recorded` → pencocokan geofence M12 → hasilnya kembali ke `truck_fills` M8,
 * tanpa handler lintas modul yang gagal diam-diam (insiden).
 */
import { and, eq, gte, inArray, like, lte, or } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { fleetEvents, gpsPositions, incidents, trips, truckFills, waterSources } from "@/db/schema";
import { EQUA_TENANT_ID, truckId } from "@/db/seed";
import { seedDemoM12Fleet } from "@/db/seed/demo-m12-fleet";
import { seedDemoM8Production } from "@/db/seed/demo-m8-production";
import { POOL_SEED } from "@/db/seed/org";
import { haversineMeters } from "@/lib/geo";
import { addDays, toBusinessDate } from "@/lib/time";
import { geofenceFlagsForSourceDay, runGeofenceProcessing, runTravelDetection } from "@/server/modules/m12-fleet";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createCustomer, createOrder, createScheduledTrip, createTruck } from "../helpers/fixtures";
import { productionWorld } from "../m8-production/helpers";
import { attachGps, chain, drive, dwell, feed, gpsTruck, minutesAfter, NOWHERE, offsetMeters, wib } from "../m12-fleet/helpers";

/** Insiden dari handler M8/M12 yang gagal (handler terisolasi savepoint tidak menggagalkan transaksi sumber). */
async function crossModuleIncidents(db: Db) {
  return db
    .select({ title: incidents.title, description: incidents.description })
    .from(incidents)
    .where(or(like(incidents.title, "%(m8-production:%"), like(incidents.title, "%(m12-fleet:%")));
}

async function fillsOf(db: Db, truckId: string) {
  return db.select().from(truckFills).where(eq(truckFills.truckId, truckId));
}

describe("Integrasi M8 ↔ M12: pengisian truk dicocokkan dengan geofence sumber air", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M12-06 KP-2 US-M8-02 KP-4 pengisian nyata operator saat truk GPS di sumber → pengisian M8 'Terverifikasi geofence'; truk jauh dari sumber → kejadian M12 `fill_without_geofence` dan pengisian M8 ditandai tidak cocok (tetap sah, tidak diblokir)", async () => {
    const w = await productionWorld(t.db);
    const [source] = await t.db.select({ lat: waterSources.lat, lng: waterSources.lng }).from(waterSources).where(eq(waterSources.id, w.source.id));
    const SRC = { lat: source!.lat, lng: source!.lng };
    const t0 = w.at("08:00");

    // (a) Truk dunia M8 berperangkat GPS: diam 15 menit di sumber (pengisian menit ke-10) lalu pergi.
    const gps = await attachGps(t.db, w.truck.id);
    const trip = await w.addTrip({ routeOrder: 1 });
    await feed(t.db, chain([(s) => dwell(gps.deviceCode, SRC, s, 15), (s) => drive(gps.deviceCode, SRC, offsetMeters(SRC, 3_000, 0), s, { speedKmh: 40 })], t0));
    const ok = await w.fill({ tripId: trip.id, at: minutesAfter(t0, 10) });
    expect(ok.status).toBe("applied");
    const [okFill] = await fillsOf(t.db, w.truck.id);
    // Event diproses 1 menit setelah pengisian: jendela ± 30 menit belum lewat → belum dinilai.
    expect(okFill).toMatchObject({ status: "linked", tripId: trip.id, geofenceMismatch: false });

    // (b) Truk lain (di luar rencana, dikonfirmasi operator) berada jauh dari sumber saat pengisian dicatat.
    const away = await gpsTruck(t.db);
    await feed(t.db, dwell(away.deviceCode, NOWHERE, t0, 60));
    const bad = await w.fill({ truckId: away.truckId, unplannedConfirmed: true, at: minutesAfter(t0, 20) });
    expect(bad.status).toBe("applied");

    // Job geofence M12 (tiap 5 menit) setelah jendela lewat.
    await runGeofenceProcessing(minutesAfter(t0, 65), t.db);

    const [verified] = await fillsOf(t.db, w.truck.id);
    expect(verified).toMatchObject({ status: "geofence_verified", geofenceMismatch: false, tripId: trip.id });
    expect(await t.db.select().from(fleetEvents).where(and(eq(fleetEvents.truckId, w.truck.id), eq(fleetEvents.kind, "fill_without_geofence")))).toHaveLength(0);

    const [badFill] = await fillsOf(t.db, away.truckId);
    const [flag] = await t.db.select().from(fleetEvents).where(and(eq(fleetEvents.truckId, away.truckId), eq(fleetEvents.kind, "fill_without_geofence")));
    expect(flag).toMatchObject({ locationType: "water_source", locationId: w.source.id });
    expect(flag!.details).toMatchObject({ truckFillId: badFill!.id });
    // M8 (handler `fleet_event.detected`) menandai pengisian; status & volume tetap (tidak memblokir pencatatan).
    expect(badFill).toMatchObject({ geofenceMismatch: true, status: "unlinked", volumeL: 5_000 });

    // Job berikutnya idempoten: tidak ada kejadian ganda, penanda tidak terhapus, status terverifikasi tetap.
    await runGeofenceProcessing(minutesAfter(t0, 70), t.db);
    expect(await t.db.select().from(fleetEvents).where(and(eq(fleetEvents.truckId, away.truckId), eq(fleetEvents.kind, "fill_without_geofence")))).toHaveLength(1);
    expect((await fillsOf(t.db, away.truckId))[0]).toMatchObject({ geofenceMismatch: true });
    expect((await fillsOf(t.db, w.truck.id))[0]).toMatchObject({ status: "geofence_verified" });

    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });

  it("US-M12-05 KP-4 US-M12-06 KP-2 seed demo gabungan M8 + M12 konsisten: jejak T4 kemarin memuat perjalanan di luar jadwal 15.00 walau M8 memberi T4 rit (SA2); pengisian demo M8 tidak ditandai geofence; jejak hari ini tidak memunculkan kejadian", async () => {
    const NOW = wib("2026-12-03", "12:00");
    const yesterday = addDays(toBusinessDate(NOW), -1);
    await seedDemoM8Production(t.db, NOW, { force: true });
    await seedDemoM12Fleet(t.db, NOW, { force: true });

    const t4Trips = await t.db.select({ id: trips.id }).from(trips).where(and(eq(trips.truckId, truckId("T4")), eq(trips.scheduledDate, yesterday), eq(trips.status, "completed")));
    expect(t4Trips.length).toBeGreaterThan(0);
    const warung = offsetMeters({ lat: POOL_SEED.lat, lng: POOL_SEED.lng }, -2_400, -1_300);
    const atWarung = await t.db
      .select({ lat: gpsPositions.lat, lng: gpsPositions.lng })
      .from(gpsPositions)
      .where(and(eq(gpsPositions.truckId, truckId("T4")), gte(gpsPositions.deviceTime, wib(yesterday, "15:00")), lte(gpsPositions.deviceTime, wib(yesterday, "15:40"))));
    expect(atWarung.some((p) => haversineMeters(p, warung) < 100)).toBe(true);
    const [offSchedule] = await t.db.select().from(fleetEvents).where(and(eq(fleetEvents.truckId, truckId("T4")), eq(fleetEvents.kind, "off_schedule_trip")));
    expect(offSchedule).toMatchObject({ businessDate: yesterday, status: "explained" });

    await runGeofenceProcessing(NOW, t.db);
    const demoTrucks = ["T3", "T4"].map((c) => truckId(c));
    expect(await t.db.select().from(fleetEvents).where(and(inArray(fleetEvents.truckId, demoTrucks), eq(fleetEvents.kind, "fill_without_geofence")))).toEqual([]);
    const detection = await runTravelDetection(NOW, t.db);
    expect(detection.filter((r) => /^T[1-7]$/.test(r.truckCode)).reduce((sum, r) => sum + r.created, 0)).toBe(0);
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });
});

describe("B-45 rincian neraca air memuat penanda geofence armada selain per pengisian (US-M12-06 KP-4)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-45 US-M12-06 KP-4 US-M8-04 KP-3 geofence_without_fill di sumber & supply_without_geofence rit pasokan dari sumber tampil untuk sumber-hari itu; sumber lain tidak", async () => {
    const date = "2026-09-22";
    const [src] = await t.db.insert(waterSources).values({ tenantId: EQUA_TENANT_ID, code: "SUB45", name: "Sumber Uji B-45", lat: -6.77, lng: 107.08, dailyCapacityL: 50_000 }).returning();
    const [other] = await t.db.insert(waterSources).values({ tenantId: EQUA_TENANT_ID, code: "SUB45X", name: "Sumber Lain B-45", lat: -6.7, lng: 107.0, dailyCapacityL: 50_000 }).returning();
    const truck = await createTruck(t.db, { code: "B45T1" });
    const cust = await createCustomer(t.db);
    const order = await createOrder(t.db, { customerId: cust.id, addressId: cust.addressId!, date });
    const trip = await createScheduledTrip(t.db, { order, truckId: truck.id, date });
    await t.db.insert(truckFills).values({ tenantId: EQUA_TENANT_ID, waterSourceId: src!.id, truckId: truck.id, tripId: trip.id, businessDate: date, volumeL: 5_000, filledAt: wib(date, "07:00") });
    await t.db.insert(fleetEvents).values([
      { tenantId: EQUA_TENANT_ID, kind: "geofence_without_fill", truckId: truck.id, businessDate: date, startedAt: wib(date, "09:00"), durationS: 1_800, locationType: "water_source", locationId: src!.id, details: { waterSourceId: src!.id, dwellMinutes: 30, thresholdMinutes: 20 } },
      { tenantId: EQUA_TENANT_ID, kind: "supply_without_geofence", truckId: truck.id, tripId: trip.id, businessDate: date, startedAt: wib(date, "08:10"), locationType: "outlet", details: { tripNumber: trip.number, outletName: "Depot Uji", volumeL: 5_000 } },
      { tenantId: EQUA_TENANT_ID, kind: "geofence_without_fill", truckId: truck.id, businessDate: date, startedAt: wib(date, "10:00"), locationType: "water_source", locationId: other!.id, details: { waterSourceId: other!.id, dwellMinutes: 25 } },
    ]);
    const flags = await geofenceFlagsForSourceDay(seededContext("keuangan1"), { sourceId: src!.id, date });
    expect(flags.map((f) => f.kind)).toEqual(["supply_without_geofence", "geofence_without_fill"]);
    expect(flags[0]!.note).toContain(trip.number);
    expect(flags[1]!.note).toMatch(/30 menit/);
    expect(flags.every((f) => f.truckCode === "B45T1")).toBe(true);
    expect(await geofenceFlagsForSourceDay(seededContext("keuangan1"), { sourceId: other!.id, date })).toHaveLength(1);
    // Izin: pembaca neraca air (M8) atau kejadian armada (M12).
    await expect(geofenceFlagsForSourceDay(seededContext("dispatcher1"), { sourceId: src!.id, date })).resolves.toHaveLength(2);
  });
});
