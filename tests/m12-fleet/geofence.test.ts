import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { domainEvents, fleetEvents, notifications, trips, truckFills } from "@/db/schema";
import { EQUA_TENANT_ID, OUTLET_SEEDS, outletId, userIdByUsername, waterSourceId } from "@/db/seed";
import type { LatLng } from "@/lib/geo";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { geofenceFlagsFor, listFleetEvents, runGeofenceProcessing } from "@/server/modules/m12-fleet";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createCustomer, createOrder, createScheduledTrip } from "../helpers/fixtures";
import { chain, drive, dwell, feed, gpsTruck, minutesAfter, NOWHERE, offsetMeters, POOL, SA1, wib, type GpsTruck } from "./helpers";

const DAY = "2026-09-22";
const D03 = OUTLET_SEEDS.find((o) => o.code === "D03")!;
const DEPOT: LatLng = { lat: D03.lat, lng: D03.lng };

type Db = ReturnType<typeof useTestDb>["db"];

async function kindsOf(db: Db, truckId: string, kinds: string[]) {
  return db
    .select()
    .from(fleetEvents)
    .where(and(eq(fleetEvents.truckId, truckId), inArray(fleetEvents.kind, kinds as never[])))
    .orderBy(fleetEvents.startedAt);
}

async function recordFill(db: Db, g: GpsTruck, filledAt: Date, opts: { tripId?: string | null } = {}) {
  const [row] = await db
    .insert(truckFills)
    .values({ tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA1"), truckId: g.truckId, tripId: opts.tripId ?? null, businessDate: DAY, volumeL: 5_000, filledAt })
    .returning();
  return row!;
}

/** Event `truck_fill.recorded` (M8) diproses pada waktu `now`. */
async function fillRecorded(db: Db, fill: { id: string; truckId: string; tripId: string | null }, now: Date) {
  await withTx(
    (tx) =>
      emit(
        tx,
        "truck_fill.recorded",
        { truckFillId: fill.id, waterSourceId: waterSourceId("SA1"), truckId: fill.truckId, tripId: fill.tripId, volumeL: 5_000, isSupply: false },
        { ctx: seededContext("produksi1", { now }), businessDate: DAY, objectType: "truck_fill", objectId: fill.id },
      ),
    { db },
  );
}

describe("M12 — geofence sumber air & depot (US-M12-06)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M12-06 KP-1 geofence radius per lokasi (bawaan PAR-54 100 m) → kejadian masuk/keluar per truk dengan waktu & lama; getar di tepi tidak membuat masuk/keluar berulang", async () => {
    const g = await gpsTruck(t.db);
    const t0 = wib(DAY, "06:00");
    const edge = offsetMeters(SA1, 0, 110); // di luar 100 m tetapi dalam histeresis keluar
    const inside = (s: Date) => dwell(g.deviceCode, SA1, s, 16).map((f, i) => (i % 4 === 3 ? { ...f, lat: edge.lat, lng: edge.lng } : f));
    const fixes = chain([(s) => drive(g.deviceCode, offsetMeters(SA1, -3_000, 0), SA1, s, { speedKmh: 40 }), inside, (s) => drive(g.deviceCode, SA1, offsetMeters(SA1, 3_000, 0), s, { speedKmh: 40 })], t0);
    // Dua kali proses: saat masih di dalam (kunjungan terbuka) lalu setelah keluar — tetap satu kunjungan.
    const mid = fixes.find((f) => f.deviceTime.getTime() >= minutesAfter(t0, 12).getTime())!.deviceTime;
    await feed(t.db, fixes.filter((f) => f.deviceTime <= mid));
    await runGeofenceProcessing(mid, t.db);
    const open = await kindsOf(t.db, g.truckId, ["geofence_enter"]);
    expect(open).toHaveLength(1);
    expect(open[0]!.endedAt).toBeNull();
    await feed(t.db, fixes.filter((f) => f.deviceTime > mid));
    const end = fixes.at(-1)!.deviceTime;
    await runGeofenceProcessing(end, t.db);
    await runGeofenceProcessing(minutesAfter(end, 5), t.db);
    const events = await kindsOf(t.db, g.truckId, ["geofence_enter", "geofence_exit"]);
    expect(events.map((e) => [e.kind, e.locationId])).toEqual([
      ["geofence_enter", waterSourceId("SA1")],
      ["geofence_exit", waterSourceId("SA1")],
    ]);
    const [enter, exit] = events;
    expect(enter!.durationS!).toBeGreaterThanOrEqual(15 * 60);
    expect(enter!.durationS!).toBeLessThanOrEqual(18 * 60);
    expect(enter!.endedAt!.getTime()).toBe(exit!.startedAt.getTime());
    expect(exit!.details).toMatchObject({ enterEventId: enter!.id, locationName: expect.any(String) });
  });

  it("US-M12-06 KP-2 pengisian tanpa truk di geofence sumber ± 30 menit → ditandai (juga bila tersinkron terlambat); truk di sumber > 10 menit tanpa pengisian → ditandai; pengisian di sumber tidak ditandai", async () => {
    // (a) Pengisian dicatat saat truk jauh dari sumber.
    const away = await gpsTruck(t.db);
    const t0 = wib(DAY, "08:00");
    await feed(t.db, dwell(away.deviceCode, NOWHERE, t0, 60));
    const fill = await recordFill(t.db, away, minutesAfter(t0, 20));
    await fillRecorded(t.db, fill, minutesAfter(t0, 21)); // jendela belum lewat → belum dinilai
    expect(await kindsOf(t.db, away.truckId, ["fill_without_geofence"])).toHaveLength(0);
    await runGeofenceProcessing(minutesAfter(t0, 55), t.db);
    const [flag] = await kindsOf(t.db, away.truckId, ["fill_without_geofence"]);
    expect(flag).toMatchObject({ status: "detected", locationType: "water_source", locationId: waterSourceId("SA1") });
    expect(flag!.details).toMatchObject({ truckFillId: fill.id, waterSourceId: waterSourceId("SA1"), windowMinutes: 30 });
    const note = await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.geofence_mismatch"), eq(notifications.objectId, flag!.id)));
    expect(note.map((n) => n.recipientUserId)).toContain(userIdByUsername("pemilik"));

    // Sinkron terlambat: event pengisian diproses setelah jendela → langsung dinilai.
    const late = await gpsTruck(t.db);
    await feed(t.db, dwell(late.deviceCode, NOWHERE, t0, 60));
    const lateFill = await recordFill(t.db, late, minutesAfter(t0, 10));
    await fillRecorded(t.db, lateFill, minutesAfter(t0, 58));
    expect(await kindsOf(t.db, late.truckId, ["fill_without_geofence"])).toHaveLength(1);

    // Pengisian saat truk di sumber → tidak ditandai.
    const ok = await gpsTruck(t.db);
    await feed(t.db, chain([(s) => dwell(ok.deviceCode, SA1, s, 8), (s) => drive(ok.deviceCode, SA1, NOWHERE, s)], t0));
    const okFill = await recordFill(t.db, ok, minutesAfter(t0, 5));
    await fillRecorded(t.db, okFill, minutesAfter(t0, 50));
    expect(await kindsOf(t.db, ok.truckId, ["fill_without_geofence", "geofence_without_fill"])).toHaveLength(0);

    // (b) Truk 25 menit di sumber tanpa pengisian tercatat.
    const idle = await gpsTruck(t.db);
    await feed(t.db, chain([(s) => drive(idle.deviceCode, POOL, SA1, s, { speedKmh: 40 }), (s) => dwell(idle.deviceCode, SA1, s, 25), (s) => drive(idle.deviceCode, SA1, POOL, s, { speedKmh: 40 })], t0));
    await runGeofenceProcessing(wib(DAY, "09:30"), t.db);
    await runGeofenceProcessing(wib(DAY, "10:30"), t.db);
    const [nofill] = await kindsOf(t.db, idle.truckId, ["geofence_without_fill"]);
    expect(nofill).toMatchObject({ locationId: waterSourceId("SA1"), status: "detected" });
    expect((nofill!.details as { dwellMinutes: number }).dwellMinutes).toBeGreaterThan(10);
    expect(await kindsOf(t.db, idle.truckId, ["geofence_without_fill"])).toHaveLength(1);
  });

  it("US-M12-06 KP-3 rit internal (pasokan depot) Selesai tanpa masuk geofence depot → ditandai; masuk depot → tidak", async () => {
    const internalTrip = async (g: GpsTruck, departed: Date, completed: Date) => {
      const cust = await createCustomer(t.db, { lat: DEPOT.lat, lng: DEPOT.lng });
      const order = await createOrder(t.db, { customerId: cust.id, addressId: cust.addressId!, date: DAY });
      const trip = await createScheduledTrip(t.db, { order, truckId: g.truckId, date: DAY });
      await t.db
        .update(trips)
        .set({ isInternal: true, destinationOutletId: outletId("D03"), status: "completed", publishedAt: wib(DAY, "05:00"), departedAt: departed, completedAt: completed, completionBusinessDate: DAY, deliveredVolumeL: 5_000 })
        .where(eq(trips.id, trip.id));
      return trip;
    };
    const t0 = wib(DAY, "11:00");
    const bad = await gpsTruck(t.db);
    await feed(t.db, chain([(s) => dwell(bad.deviceCode, SA1, s, 3), (s) => drive(bad.deviceCode, SA1, NOWHERE, s, { speedKmh: 40 }), (s) => dwell(bad.deviceCode, NOWHERE, s, 20)], t0));
    const badTrip = await internalTrip(bad, minutesAfter(t0, 3), minutesAfter(t0, 30));
    const good = await gpsTruck(t.db);
    await feed(t.db, chain([(s) => dwell(good.deviceCode, SA1, s, 3), (s) => drive(good.deviceCode, SA1, DEPOT, s, { speedKmh: 40 }), (s) => dwell(good.deviceCode, DEPOT, s, 20)], t0));
    await internalTrip(good, minutesAfter(t0, 3), minutesAfter(t0, 30));
    await runGeofenceProcessing(minutesAfter(t0, 75), t.db);
    const [flag] = await kindsOf(t.db, bad.truckId, ["supply_without_geofence"]);
    expect(flag).toMatchObject({ tripId: badTrip.id, locationType: "outlet", locationId: outletId("D03") });
    expect(await kindsOf(t.db, good.truckId, ["supply_without_geofence"])).toHaveLength(0);
    expect((await kindsOf(t.db, good.truckId, ["geofence_enter"])).some((e) => e.locationId === outletId("D03"))).toBe(true);
  });

  it("US-M12-06 KP-4 kejadian bertanda masuk daftar tinjauan pemilik dan pertimbangan neraca air (M8: `geofenceFlagsFor` + event `fleet_event.detected`)", async () => {
    const g = await gpsTruck(t.db);
    const t0 = wib(DAY, "13:00");
    await feed(t.db, dwell(g.deviceCode, NOWHERE, t0, 60));
    const fill = await recordFill(t.db, g, minutesAfter(t0, 15));
    await fillRecorded(t.db, fill, minutesAfter(t0, 50));
    const [flag] = await kindsOf(t.db, g.truckId, ["fill_without_geofence"]);
    const review = await listFleetEvents(seededContext("pemilik", { now: wib(DAY, "18:00") }), { view: "review" });
    expect(review.find((r) => r.id === flag!.id)).toMatchObject({ needsReview: true, group: "geofence" });
    const forBalance = await withTx((tx) => geofenceFlagsFor(tx, { tenantId: EQUA_TENANT_ID, date: DAY, waterSourceId: waterSourceId("SA1") }), { db: t.db });
    expect(forBalance.map((e) => e.id)).toContain(flag!.id);
    const [evt] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "fleet_event.detected"), eq(domainEvents.objectId, flag!.id)));
    expect(evt!.payload).toMatchObject({ kind: "fill_without_geofence", truckFillId: fill.id, waterSourceId: waterSourceId("SA1"), locationType: "water_source" });
  });
});
