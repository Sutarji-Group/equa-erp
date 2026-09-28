import { and, eq, inArray, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { devices, fleetEvents, gpsPositions, phoneTrackingFlags, trips, tripTracks, truckDaySummaries, trucks } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import { withTx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { markDeviceOutage, purgeExpiredPositions, runTravelDetection } from "@/server/modules/m12-fleet";

import { GET as ingestGet, POST as ingestPost } from "@/app/api/gps/ingest/[vendor]/route";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createCustomer, createOrder, createScheduledTrip } from "../helpers/fixtures";
import { departArrive, driverWorld, expectApplied, HERE } from "../m3-driver/helpers";
import { chain, drive, dwell, feed, fix, gpsTruck, minutesAfter, NOWHERE, POOL, SA1, wib } from "./helpers";

const TOKEN = "dev-gps-ingest-token";
const DAY = "2026-09-21";

function routeCtx(vendor: string) {
  return { params: Promise.resolve({ vendor }) } as unknown as RouteContext<"/api/gps/ingest/[vendor]">;
}

describe("M12 — penerimaan posisi GPS (US-M12-01)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M12-01 KP-1 posisi perangkat terpasang disimpan mentah dengan waktu server & penanda kualitas (akurasi, valid); kirim ulang tidak menggandakan", async () => {
    const g = await gpsTruck(t.db);
    const t0 = wib(DAY, "08:00");
    const received = minutesAfter(t0, 3);
    const fixes = [
      fix(g.deviceCode, t0, SA1, { speedKmh: 0, ignitionOn: true, firmwareVersion: "FW-2.4", batteryPct: 91 }),
      fix(g.imei, minutesAfter(t0, 1), SA1, { accuracyM: 250 }),
      fix(g.deviceCode, minutesAfter(t0, 2), SA1, { vendorValid: false }),
    ];
    const res = await feed(t.db, fixes, { receivedAt: received });
    expect(res).toMatchObject({ received: 3, accepted: 3, duplicates: 0, rejected: 0 });
    const rows = await t.db.select().from(gpsPositions).where(eq(gpsPositions.truckId, g.truckId)).orderBy(gpsPositions.deviceTime);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.isValid)).toEqual([true, false, false]);
    expect(rows[0]).toMatchObject({ source: "gps_device", deviceId: g.deviceId, vendor: "generic-json", ignitionOn: true, accuracyM: 8 });
    expect(rows[0]!.serverTime.toISOString()).toBe(received.toISOString());
    expect(rows[0]!.raw).toEqual({ uji: true });
    // Kirim ulang (retry vendor) → duplikat, tidak menggandakan.
    const again = await feed(t.db, fixes, { receivedAt: received });
    expect(again).toMatchObject({ accepted: 0, duplicates: 3 });
    expect(await t.db.select().from(gpsPositions).where(eq(gpsPositions.truckId, g.truckId))).toHaveLength(3);
    // Kesehatan perangkat diperbarui (US-M12-08 KP-4).
    const [dev] = await t.db.select().from(devices).where(eq(devices.id, g.deviceId));
    expect(dev!.gpsLastPositionAt!.toISOString()).toBe(minutesAfter(t0, 2).toISOString());
    expect(dev!.lastSeenAt!.toISOString()).toBe(received.toISOString());
    expect(dev!.firmwareVersion).toBe("FW-2.4");
    expect(dev!.gpsPowerConnected).toBe(true);
    expect(dev!.gpsState).toBe("active");
  });

  it("US-M12-01 KP-1 perangkat tak dikenal, diblokir, atau belum dipasang di truk ditolak per butir tanpa menggagalkan butir lain", async () => {
    const ok = await gpsTruck(t.db);
    const blocked = await gpsTruck(t.db);
    await t.db.update(devices).set({ status: "blocked" }).where(eq(devices.id, blocked.deviceId));
    const looseId = newId();
    await t.db.insert(devices).values({ id: looseId, tenantId: EQUA_TENANT_ID, deviceCode: `GPS-LEPAS-${looseId.slice(-5)}`, name: "GPS lepas", kind: "gps", status: "active" });
    const t0 = wib(DAY, "09:00");
    const res = await feed(t.db, [fix("TIDAK-ADA-123", t0, SA1), fix(blocked.deviceCode, t0, SA1), fix(`GPS-LEPAS-${looseId.slice(-5)}`, t0, SA1), fix(ok.deviceCode, t0, SA1)]);
    expect(res).toMatchObject({ accepted: 1, rejected: 3 });
    expect(res.results[0]!.message).toMatch(/belum terdaftar/);
    expect(res.results[1]!.message).toMatch(/diblokir/);
    expect(res.results[2]!.message).toMatch(/belum dipasang/);
  });

  it("US-M12-01 KP-2 perangkat dipetakan ke truk lewat master armada; ganti ke perangkat cadangan tidak memutus riwayat truk", async () => {
    const g = await gpsTruck(t.db);
    const t0 = wib(DAY, "10:00");
    await feed(t.db, drive(g.deviceCode, POOL, SA1, t0));
    // Perangkat rusak → admin memasang GPS cadangan pada truk yang sama (master armada).
    const spareId = newId();
    const spareCode = `GPS-CAD-${spareId.slice(-5)}`;
    await t.db.insert(devices).values({ id: spareId, tenantId: EQUA_TENANT_ID, deviceCode: spareCode, name: "GPS cadangan uji", kind: "gps", status: "active", isSpare: true });
    await t.db.update(trucks).set({ gpsDeviceId: spareId }).where(eq(trucks.id, g.truckId));
    const t1 = minutesAfter(t0, 90);
    await feed(t.db, drive(spareCode, SA1, NOWHERE, t1));
    const rows = await t.db.select().from(gpsPositions).where(eq(gpsPositions.truckId, g.truckId)).orderBy(gpsPositions.deviceTime);
    const byDevice = new Set(rows.map((r) => r.deviceId));
    expect(byDevice).toEqual(new Set([g.deviceId, spareId]));
    expect(rows[0]!.deviceTime < t1 && rows.at(-1)!.deviceTime > t1).toBe(true);
    // Perangkat lama tidak lagi terpasang → posisinya ditolak (tidak tercampur ke truk).
    const late = await feed(t.db, [fix(g.deviceCode, minutesAfter(t1, 5), SA1)]);
    expect(late.rejected).toBe(1);
  });

  it("US-M12-01 KP-3 rute penghubung: token wajib, vendor tak dikenal 404, OsmAnd (GET) & JSON generik (POST) masuk ke format internal yang sama", async () => {
    const g = await gpsTruck(t.db);
    const noToken = await ingestPost(new Request("http://localhost/api/gps/ingest/generic-json", { method: "POST", body: "{}" }), routeCtx("generic-json"));
    expect(noToken.status).toBe(401);
    const unknown = await ingestPost(new Request("http://localhost/api/gps/ingest/vendorx", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" }), routeCtx("vendorx"));
    expect(unknown.status).toBe(404);
    const at = wib(DAY, "11:00");
    const q = new URLSearchParams({ id: g.deviceCode, lat: String(SA1.lat), lon: String(SA1.lng), timestamp: String(at.getTime() / 1000), speed: "10", token: TOKEN });
    const osm = await ingestGet(new Request(`http://localhost/api/gps/ingest/osmand?${q}`), routeCtx("osmand"));
    expect(osm.status).toBe(200);
    expect(await osm.json()).toMatchObject({ ok: true, accepted: 1 });
    const body = { positions: [{ deviceId: g.imei, time: new Date(at.getTime() + 60_000).toISOString(), lat: SA1.lat, lng: SA1.lng, speedKmh: 18.52 }] };
    const gen = await ingestPost(new Request("http://localhost/api/gps/ingest/generic-json", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }), routeCtx("generic-json"));
    expect(gen.status).toBe(200);
    const rows = await t.db.select().from(gpsPositions).where(eq(gpsPositions.truckId, g.truckId)).orderBy(gpsPositions.deviceTime);
    expect(rows.map((r) => r.vendor)).toEqual(["osmand", "generic-json"]);
    expect(rows.map((r) => r.speedKmh)).toEqual([18.5, 18.5]);
    const bad = await ingestPost(new Request("http://localhost/api/gps/ingest/generic-json", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{bukan json" }), routeCtx("generic-json"));
    expect(bad.status).toBe(400);
  });

  it("US-M12-01 KP-4 titik status M3 (Berangkat/Tiba/Selesai) selalu disimpan bertanda sumber `status_point`", async () => {
    const w = await driverWorld(t.db);
    const trip = await w.addTrip();
    await departArrive(w, trip.id);
    const rows = await t.db.select().from(gpsPositions).where(and(eq(gpsPositions.truckId, w.truck.id), eq(gpsPositions.tripId, trip.id)));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["status_point"]));
    expect(rows[0]).toMatchObject({ lat: HERE.lat, lng: HERE.lng, userId: w.driver.userId });
  });

  it("US-M12-01 KP-4 GPS ponsel aktif otomatis untuk truk yang perangkatnya Mati (pull aplikasi sopir), posisi ponsel bertanda sumber `phone`, dan berhenti saat perangkat aktif kembali", async () => {
    const w = await driverWorld(t.db);
    const deviceId = newId();
    const code = `GPS-M3-${deviceId.slice(-5)}`;
    await t.db.insert(devices).values({ id: deviceId, tenantId: EQUA_TENANT_ID, deviceCode: code, name: "GPS truk M3", kind: "gps", status: "active", truckId: w.truck.id });
    await t.db.update(trucks).set({ gpsDeviceId: deviceId }).where(eq(trucks.id, w.truck.id));
    const last = new Date(Date.now() - 30 * 60_000);
    await feed(t.db, [fix(code, last, SA1)], { receivedAt: last });
    expect((await w.today()).gpsTracking.enabled).toBe(false);

    const [dev] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    await withTx((tx) => markDeviceOutage(tx, { device: dev!, truck: { id: w.truck.id, code: w.truck.code, tenantId: EQUA_TENANT_ID }, kind: "device_offline", since: last, now: new Date() }), { db: t.db });
    expect((await w.today()).gpsTracking.enabled).toBe(true);

    const trip = await w.addTrip();
    await departArrive(w, trip.id);
    expectApplied(await w.send(w.sopir, "gps.phone_positions", { truckId: w.truck.id, positions: [{ deviceTime: new Date().toISOString(), lat: HERE.lat, lng: HERE.lng, accuracyM: 12, tripId: trip.id }] }));
    const sources = (await t.db.select({ s: gpsPositions.source }).from(gpsPositions).where(eq(gpsPositions.truckId, w.truck.id))).map((r) => r.s);
    expect(new Set(sources)).toEqual(new Set(["gps_device", "status_point", "phone"]));

    // Perangkat mengirim lagi → aktif kembali → pelacakan ponsel otomatis berakhir.
    await feed(t.db, [fix(code, new Date(), SA1)]);
    expect((await w.today()).gpsTracking.enabled).toBe(false);
    const live = await t.db.select().from(phoneTrackingFlags).where(and(eq(phoneTrackingFlags.truckId, w.truck.id), isNull(phoneTrackingFlags.endedAt)));
    expect(live).toHaveLength(0);
  });

  it("US-M12-01 KP-5 jam perangkat menyimpang > PAR-42 ditandai (+ kejadian informasional); posisi berakurasi buruk tetap disimpan tetapi tidak dibaca deteksi", async () => {
    const g = await gpsTruck(t.db);
    const received = wib(DAY, "12:30");
    const { minutes_gt } = await params.get(t.db, "PAR-42", DAY);
    const skewed = minutesAfter(received, -(minutes_gt + 10));
    await feed(t.db, [fix(g.deviceCode, skewed, SA1)], { receivedAt: received });
    const [row] = await t.db.select().from(gpsPositions).where(eq(gpsPositions.truckId, g.truckId));
    expect(row!.clockSkewFlagged).toBe(true);
    const ev = await t.db.select().from(fleetEvents).where(and(eq(fleetEvents.truckId, g.truckId), eq(fleetEvents.kind, "clock_skew")));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ skewMinutes: minutes_gt + 10 });
    const g2 = await gpsTruck(t.db);
    await feed(t.db, [fix(g2.deviceCode, received, SA1, { accuracyM: 500 })], { receivedAt: received });
    const [bad] = await t.db.select().from(gpsPositions).where(eq(gpsPositions.truckId, g2.truckId));
    expect(bad!.isValid).toBe(false);
    expect(bad!.clockSkewFlagged).toBe(false);

    // Perjalanan yang sama tanpa rit: jejak berakurasi baik → kejadian; jejak berakurasi buruk → tersimpan, tanpa kejadian.
    const t0 = wib(DAY, "13:00");
    const route = (code: string) => chain([(s) => dwell(code, POOL, s, 8), (s) => drive(code, POOL, NOWHERE, s), (s) => dwell(code, NOWHERE, s, 10)], t0);
    const good = await gpsTruck(t.db);
    const noisy = await gpsTruck(t.db);
    await feed(t.db, route(good.deviceCode));
    const noisyFixes = route(noisy.deviceCode).map((f, i) => (i > 8 ? { ...f, accuracyM: 500 } : f));
    await feed(t.db, noisyFixes);
    await runTravelDetection(minutesAfter(t0, 40), t.db);
    const kinds = ["off_schedule_trip", "off_hours_trip", "unknown_stop"] as const;
    const evOf = (truckId: string) => t.db.select().from(fleetEvents).where(and(eq(fleetEvents.truckId, truckId), inArray(fleetEvents.kind, [...kinds])));
    expect((await evOf(good.truckId)).map((e) => e.kind)).toEqual(["off_schedule_trip"]);
    expect(await evOf(noisy.truckId)).toHaveLength(0);
    const stored = await t.db.select().from(gpsPositions).where(eq(gpsPositions.truckId, noisy.truckId));
    expect(stored).toHaveLength(noisyFixes.length);
    expect(stored.filter((r) => !r.isValid)).toHaveLength(noisyFixes.length - 9);
  });

  it("US-M12-01 KP-6 posisi mentah lebih tua dari PAR-52 bulan dihapus job retensi; ringkasan per rit & per hari tetap tersimpan", async () => {
    const g = await gpsTruck(t.db);
    const now = wib("2027-10-05", "02:20");
    const oldDay = "2026-09-01";
    const t0 = wib(oldDay, "08:00");
    await feed(t.db, [...dwell(g.deviceCode, SA1, t0, 10), ...drive(g.deviceCode, SA1, NOWHERE, minutesAfter(t0, 11))]);
    const cust = await createCustomer(t.db, { lat: NOWHERE.lat, lng: NOWHERE.lng });
    const order = await createOrder(t.db, { customerId: cust.id, addressId: cust.addressId!, date: oldDay });
    const trip = await createScheduledTrip(t.db, { order, truckId: g.truckId, date: oldDay });
    await t.db
      .update(trips)
      .set({ status: "completed", departedAt: minutesAfter(t0, 10), completedAt: minutesAfter(t0, 40), completionBusinessDate: oldDay, publishedAt: t0 })
      .where(eq(trips.id, trip.id));
    const recent = wib(toBusinessDate(now), "01:00");
    await feed(t.db, [fix(g.deviceCode, recent, POOL)], { receivedAt: recent });
    const res = await purgeExpiredPositions(now, t.db);
    expect(res.purged).toBeGreaterThan(10);
    expect(res.summariesEnsured).toBeGreaterThanOrEqual(1);
    const left = await t.db.select().from(gpsPositions).where(eq(gpsPositions.truckId, g.truckId));
    expect(left).toHaveLength(1);
    const [day] = await t.db.select().from(truckDaySummaries).where(and(eq(truckDaySummaries.truckId, g.truckId), eq(truckDaySummaries.businessDate, oldDay)));
    expect(day!.distanceM).toBeGreaterThan(1000);
    const [track] = await t.db.select().from(tripTracks).where(eq(tripTracks.tripId, trip.id));
    expect(track!.distanceM).toBeGreaterThan(1000);
    expect(track!.isEstimated).toBe(false);
  });
});
