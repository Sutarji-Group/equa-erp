import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { employees, trips } from "@/db/schema";
import { OUTLET_SEEDS, WATER_SOURCE_SEEDS, userIdByUsername } from "@/db/seed";
import { haversineMeters, type LatLng } from "@/lib/geo";
import { setActorResolver } from "@/server/core/actor";
import { ForbiddenError } from "@/server/core/errors";
import { getBoard } from "@/server/modules/m2-orders";
import { getFleetSnapshot, getReplay, runTravelDetection, type LiveTruck } from "@/server/modules/m12-fleet";
import { GET as liveGet } from "@/app/api/gps/live/route";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";
import { assignCrew, createCustomer, createOrder, createScheduledTrip } from "../helpers/fixtures";
import { chain, D01, drive, dwell, feed, gpsTruck, minutesAfter, NOWHERE, POOL, SA1, wib, type GpsTruck } from "./helpers";

const DAY = "2026-09-22";
const NOW = wib(DAY, "10:00");
const at = (ctxName: string, now = NOW) => seededContext(ctxName, { now });

type Db = ReturnType<typeof useTestDb>["db"];

async function tripOn(db: Db, g: GpsTruck, input: { address: LatLng; name?: string; status?: "assigned" | "departed"; routeOrder?: number }) {
  const cust = await createCustomer(db, { lat: input.address.lat, lng: input.address.lng, name: input.name });
  const order = await createOrder(db, { customerId: cust.id, addressId: cust.addressId!, date: DAY });
  const trip = await createScheduledTrip(db, { order, truckId: g.truckId, date: DAY });
  await db
    .update(trips)
    .set({
      publishedAt: wib(DAY, "05:00"),
      routeOrder: input.routeOrder ?? 1,
      status: input.status ?? "assigned",
      departedAt: input.status === "departed" ? minutesAfter(NOW, -12) : null,
      driverUserId: input.status === "departed" ? userIdByUsername("sopir2") : null,
    })
    .where(eq(trips.id, trip.id));
  return trip;
}

describe("M12 — peta posisi truk real-time (US-M12-02)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  afterAll(() => setActorResolver(null));

  const trucksOf = (snapshot: { trucks: LiveTruck[] }, ...g: GpsTruck[]) => g.map((x) => snapshot.trucks.find((tr) => tr.truckId === x.truckId)!);

  it("US-M12-02 KP-1 peta: per truk nomor, status (rit aktif ke pelanggan X / menuju sumber / di sumber / berhenti / di luar jadwal), sopir hari itu, kecepatan, umur posisi; posisi > PAR-48 ditandai basi; pembaruan ≤ 1 menit", async () => {
    const onTrip = await gpsTruck(t.db);
    const driver = await createTestUser(t.db, { role: "driver", fullName: "Sopir Peta Uji" });
    await t.db.update(employees).set({ phone: "6281234500001" }).where(eq(employees.id, driver.employeeId));
    await assignCrew(t.db, { truckId: onTrip.truckId, driverEmployeeId: driver.employeeId, date: DAY });
    await tripOn(t.db, onTrip, { address: NOWHERE, name: "Warung Bu Tini", status: "departed" });
    await feed(t.db, drive(onTrip.deviceCode, D01, NOWHERE, minutesAfter(NOW, -3), { speedKmh: 30 }).slice(0, 4));

    const atSource = await gpsTruck(t.db);
    await tripOn(t.db, atSource, { address: NOWHERE });
    await feed(t.db, dwell(atSource.deviceCode, SA1, minutesAfter(NOW, -10), 9));

    const heading = await gpsTruck(t.db);
    await tripOn(t.db, heading, { address: NOWHERE });
    await feed(t.db, drive(heading.deviceCode, POOL, SA1, minutesAfter(NOW, -4), { speedKmh: 40 }).slice(0, 4));

    const stale = await gpsTruck(t.db);
    await feed(t.db, dwell(stale.deviceCode, NOWHERE, minutesAfter(NOW, -30), 18));

    const wander = await gpsTruck(t.db);
    await feed(t.db, chain([(s) => dwell(wander.deviceCode, POOL, s, 6), (s) => drive(wander.deviceCode, POOL, NOWHERE, s), (s) => dwell(wander.deviceCode, NOWHERE, s, 6)], minutesAfter(NOW, -20)));
    await runTravelDetection(NOW, t.db);

    const empty = await gpsTruck(t.db);

    const snap = await getFleetSnapshot(at("dispatcher1"), {});
    expect(snap.date).toBe(DAY);
    expect(snap.refreshSeconds).toBeLessThanOrEqual(60);
    expect(snap.staleAfterMinutes).toBe(5);
    const [a, b, c, d, e, f] = trucksOf(snap, onTrip, atSource, heading, stale, wander, empty);
    expect(a).toMatchObject({ code: onTrip.code, status: "active_trip", statusDetail: "Rit aktif ke Warung Bu Tini", driverName: "Sopir Peta Uji", driverPhone: "6281234500001", moving: true, stale: false });
    expect(a!.position!.speedKmh).toBe(30);
    expect(a!.ageMinutes).toBeLessThanOrEqual(1);
    expect(b).toMatchObject({ status: "at_source", statusLabel: "Di sumber", statusDetail: `Di ${WATER_SOURCE_SEEDS[0]!.name}` });
    expect(c).toMatchObject({ status: "heading_to_source", moving: true });
    expect(d).toMatchObject({ stale: true });
    expect(d!.ageMinutes).toBeGreaterThan(5);
    expect(e).toMatchObject({ status: "off_schedule", tone: "danger" });
    expect(f).toMatchObject({ status: "no_data", position: null });
    expect(snap.counts.stale).toBeGreaterThanOrEqual(1);
  });

  it("US-M12-02 KP-2 klik truk: rit hari ini & statusnya, rit berikutnya, perkiraan jarak & waktu ke tujuan (penyedia rute), kontak sopir", async () => {
    const g = await gpsTruck(t.db);
    const first = await tripOn(t.db, g, { address: NOWHERE, name: "Pelanggan Pertama", status: "departed", routeOrder: 1 });
    const second = await tripOn(t.db, g, { address: POOL, name: "Pelanggan Kedua", routeOrder: 2 });
    const here = D01;
    await feed(t.db, dwell(g.deviceCode, here, minutesAfter(NOW, -2), 2));
    const snap = await getFleetSnapshot(at("pemilik"), {});
    const [truck] = trucksOf(snap, g);
    expect(truck!.trips.map((x) => [x.number, x.statusLabel])).toEqual([
      [first.number, "Berangkat"],
      [second.number, "Ditugaskan"],
    ]);
    expect(truck!.activeTrip!.id).toBe(first.id);
    expect(truck!.nextTrip!.id).toBe(second.id);
    const expectedKm = (haversineMeters(here, NOWHERE) * 1.3) / 1000;
    expect(truck!.eta!.destination).toBe("Pelanggan Pertama");
    expect(Math.abs(truck!.eta!.km - expectedKm)).toBeLessThan(0.2);
    expect(truck!.eta!.minutes).toBe(Math.max(1, Math.round((truck!.eta!.km / 30) * 60)));
    expect(truck!.eta!.estimated).toBe(true);
  });

  it("US-M12-02 KP-3 lapisan peta: sumber air, depot, pool (PTB-34), zona tarif (opsional)", async () => {
    const snap = await getFleetSnapshot(at("pemilik"), {});
    expect(snap.layers.sources.map((s) => s.code).sort()).toEqual(WATER_SOURCE_SEEDS.map((s) => s.code).sort());
    expect(snap.layers.depots).toHaveLength(OUTLET_SEEDS.filter((o) => o.kind === "depot").length);
    expect(snap.layers.pools.length).toBeGreaterThanOrEqual(1);
    expect(snap.layers.sources.every((s) => s.radiusM > 0)).toBe(true);
    expect(snap.layers.zoneRings.length).toBeGreaterThan(0);
  });

  it("US-M12-02 KP-4 hanya pemilik & Dispatcher mendapat posisi (peta, rute /api/gps/live, papan jadwal M2); sopir & keuangan tidak", async () => {
    await expect(getFleetSnapshot(at("keuangan1"), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getFleetSnapshot(at("sopir1"), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getReplay(at("sopir1"), { truckId: (await gpsTruck(t.db)).truckId })).rejects.toBeInstanceOf(ForbiddenError);

    setActorResolver(async () => at("dispatcher1"));
    const ok = await liveGet(new Request(`http://x/api/gps/live?tanggal=${DAY}`));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; snapshot: { date: string; trucks: unknown[] } };
    expect(body.snapshot.date).toBe(DAY);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    setActorResolver(async () => at("sopir1"));
    expect((await liveGet(new Request("http://x/api/gps/live"))).status).toBe(403);
    setActorResolver(async () => null);
    expect((await liveGet(new Request("http://x/api/gps/live"))).status).toBe(401);
    setActorResolver(null);

    // Papan jadwal (M2, US-M2-03 KP-6): keuangan boleh membaca papan tetapi tanpa posisi truk.
    const g = await gpsTruck(t.db);
    await feed(t.db, dwell(g.deviceCode, POOL, minutesAfter(NOW, -2), 2));
    const lane = (board: Awaited<ReturnType<typeof getBoard>>) => board.lanes.find((l) => l.truck.id === g.truckId)!;
    expect(lane(await getBoard(at("dispatcher1"), DAY)).lastPosition).not.toBeNull();
    expect(lane(await getBoard(at("keuangan1"), DAY)).lastPosition).toBeNull();
  });

  it("US-M12-02 KP-5 putar ulang 24 jam terakhir dari peta (posisi lebih lama tidak ikut)", async () => {
    const g = await gpsTruck(t.db);
    await feed(t.db, dwell(g.deviceCode, POOL, minutesAfter(NOW, -30 * 60), 3), { receivedAt: minutesAfter(NOW, -30 * 60 + 3) });
    await feed(t.db, drive(g.deviceCode, POOL, SA1, minutesAfter(NOW, -120), { speedKmh: 40 }), { receivedAt: minutesAfter(NOW, -100) });
    const replay = await getReplay(at("dispatcher1"), { truckId: g.truckId });
    expect(replay.to.getTime()).toBe(NOW.getTime());
    expect(replay.to.getTime() - replay.from.getTime()).toBe(24 * 3_600_000);
    expect(replay.points.length).toBeGreaterThan(10);
    expect(replay.points.every((p) => new Date(p.t) >= replay.from)).toBe(true);
    expect(replay.points[0]).toMatchObject({ source: "gps_device" });
  });
});
