import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { tripTracks, trips, truckDaySummaries, truckFills } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername, waterSourceId } from "@/db/seed";
import { haversineMeters, type LatLng } from "@/lib/geo";
import { toBusinessDate } from "@/lib/time";
import { exportReport, listReports } from "@/server/core/export";
import { ForbiddenError } from "@/server/core/errors";
import { getReplay, getTripHistory, getTruckDay, listTripHistory, listTruckDays, runDailySummaries } from "@/server/modules/m12-fleet";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createCustomer, createOrder, createScheduledTrip } from "../helpers/fixtures";
import { completePayload, driverWorld, expectApplied, HOME, PHOTO, SIGNATURE } from "../m3-driver/helpers";
import { attachGps, drive, dwell, ELSEWHERE, feed, gpsTruck, minutesAfter, NOWHERE, offsetMeters, POOL, SA1, wib, type GpsTruck } from "./helpers";
import type { GpsFix } from "@/server/modules/m12-fleet";

const DAY = "2026-09-22";
const owner = () => seededContext("pemilik");
const dispatcher = () => seededContext("dispatcher1");

type Db = ReturnType<typeof useTestDb>["db"];

/** Rit terjadwal truk uji (alamat di `address`) dengan titik status & waktu tertentu. */
async function tripOn(db: Db, g: GpsTruck, input: { address: LatLng; departed?: { at: Date; p: LatLng }; completed?: { at: Date; p: LatLng }; date?: string }) {
  const date = input.date ?? DAY;
  const cust = await createCustomer(db, { lat: input.address.lat, lng: input.address.lng });
  const order = await createOrder(db, { customerId: cust.id, addressId: cust.addressId!, date });
  const trip = await createScheduledTrip(db, { order, truckId: g.truckId, date });
  await db
    .update(trips)
    .set({
      publishedAt: wib(date, "05:00"),
      status: input.completed ? "completed" : input.departed ? "departed" : "assigned",
      departedAt: input.departed?.at ?? null,
      departedLat: input.departed?.p.lat ?? null,
      departedLng: input.departed?.p.lng ?? null,
      completedAt: input.completed?.at ?? null,
      completedLat: input.completed?.p.lat ?? null,
      completedLng: input.completed?.p.lng ?? null,
      completionBusinessDate: input.completed ? date : null,
      driverUserId: userIdByUsername("sopir3"),
    })
    .where(eq(trips.id, trip.id));
  return trip;
}

/** Potongan jejak berurutan; `at()` = waktu posisi terakhir yang ditambahkan. */
function trackBuilder(start: Date) {
  const fixes: GpsFix[] = [];
  let cursor = start;
  return {
    fixes,
    add(part: (s: Date) => GpsFix[]) {
      const f = part(cursor);
      fixes.push(...f);
      cursor = new Date(f[f.length - 1]!.deviceTime.getTime() + 60_000);
      return { first: f[0]!.deviceTime, last: f[f.length - 1]!.deviceTime };
    },
  };
}

describe("M12 — riwayat perjalanan per rit & per hari (US-M12-03)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M12-03 KP-1 per rit: jejak Berangkat → Selesai, jarak, durasi, titik berhenti ≥ PAR-49 (lokasi & lama), lama di pelanggan; tertaut bukti kirim (M3) & pengisian (M8)", async () => {
    const w = await driverWorld(t.db);
    const gps = await attachGps(t.db, w.truck.id);
    const now = new Date();
    const base = toBusinessDate(minutesAfter(now, -50)) === w.date ? minutesAfter(now, -50) : minutesAfter(now, 1);
    const at = (m: number) => minutesAfter(base, m);
    const START = offsetMeters(HOME, 3_000, 0);
    const MID = offsetMeters(HOME, 1_500, 0);
    // Perangkat GPS: berangkat → berhenti ± 6 menit di warung → pelanggan ± 17 menit.
    await feed(t.db, [
      ...dwell(gps.deviceCode, START, at(-2), 2),
      ...drive(gps.deviceCode, START, MID, at(0)),
      ...dwell(gps.deviceCode, MID, at(4), 6),
      ...drive(gps.deviceCode, MID, HOME, at(11)),
      ...dwell(gps.deviceCode, HOME, at(15), 17),
    ]);
    const a = await w.addTrip();
    const loc = (p: LatLng) => ({ lat: p.lat, lng: p.lng, accuracyM: 8 });
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: loc(START) }, { deviceTime: at(0), now: at(0.05) }));
    expectApplied(await w.send(w.sopir, "m3.trip.arrive", { tripId: a.id, location: loc(HOME), clientDistanceM: 0 }, { deviceTime: at(15), now: at(15.05) }));
    expectApplied(await w.send(w.sopir, "m3.trip.complete", completePayload(a.id), { deviceTime: at(31), now: at(31.05), attach: [PHOTO, SIGNATURE] }));
    await t.db.insert(truckFills).values({ tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA1"), truckId: w.truck.id, tripId: a.id, businessDate: w.date, volumeL: 5_000, filledAt: at(-30) });

    // Jejak rit disimpan saat Selesai tersinkron (ringkasan tetap ada setelah retensi posisi mentah).
    const [saved] = await t.db.select().from(tripTracks).where(eq(tripTracks.tripId, a.id));
    expect(saved!.distanceM!).toBeGreaterThan(2_850);
    expect(saved!.distanceM!).toBeLessThan(3_200);

    const detail = await getTripHistory(owner(), a.id);
    expect(detail.track).toMatchObject({ isEstimated: false, source: "gps_device", durationS: 31 * 60 });
    expect(detail.track.distanceM!).toBeGreaterThan(2_850);
    expect(detail.track.distanceM!).toBeLessThan(3_200);
    const warung = detail.track.stops.find((s) => haversineMeters(s, MID) < 80)!;
    expect(warung.place).toBeNull();
    expect(warung.durationS).toBeGreaterThanOrEqual(5 * 60);
    expect(warung.durationS).toBeLessThanOrEqual(9 * 60);
    expect(detail.track.stops.find((s) => haversineMeters(s, HOME) < 80)!.place).toBe("Lokasi pelanggan");
    expect(detail.track.timeAtCustomerS!).toBeGreaterThanOrEqual(15 * 60);
    expect(detail.statusPoints.map((s) => s.status)).toEqual(["departed", "arrived", "completed"]);
    expect(detail.photos.map((p) => p.kind).sort()).toEqual(["delivery_photo", "signature"]);
    expect(detail.fill).toMatchObject({ volumeL: 5_000, waterSourceName: expect.any(String), geofenceFlag: false });

    const list = await listTripHistory(dispatcher(), { date: w.date, truckId: w.truck.id });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ tripId: a.id, computed: true, isEstimated: false });
    expect(list.rows[0]!.stopCount).toBeGreaterThanOrEqual(2);
    await expect(listTripHistory(seededContext("sopir1"), {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M12-03 KP-2 per truk per hari: jarak total, waktu bergerak & berhenti, gerak pertama & terakhir, jumlah rit, jarak antar-rit (kembali ke sumber) — berdampingan rit terjadwal vs Selesai (KPI-07)", async () => {
    const g = await gpsTruck(t.db);
    const b = trackBuilder(wib(DAY, "06:00"));
    b.add((s) => dwell(g.deviceCode, POOL, s, 10));
    const toSource = b.add((s) => drive(g.deviceCode, POOL, SA1, s, { speedKmh: 40 }));
    b.add((s) => dwell(g.deviceCode, SA1, s, 20));
    const trip1Go = b.add((s) => drive(g.deviceCode, SA1, NOWHERE, s, { speedKmh: 40 }));
    const trip1At = b.add((s) => dwell(g.deviceCode, NOWHERE, s, 15));
    b.add((s) => drive(g.deviceCode, NOWHERE, SA1, s, { speedKmh: 40 }));
    b.add((s) => dwell(g.deviceCode, SA1, s, 15));
    const trip2Go = b.add((s) => drive(g.deviceCode, SA1, ELSEWHERE, s, { speedKmh: 40 }));
    const trip2At = b.add((s) => dwell(g.deviceCode, ELSEWHERE, s, 15));
    const home = b.add((s) => drive(g.deviceCode, ELSEWHERE, POOL, s, { speedKmh: 40 }));
    b.add((s) => dwell(g.deviceCode, POOL, s, 10));
    await feed(t.db, b.fixes);
    await tripOn(t.db, g, { address: NOWHERE, departed: { at: trip1Go.first, p: SA1 }, completed: { at: trip1At.last, p: NOWHERE } });
    await tripOn(t.db, g, { address: ELSEWHERE, departed: { at: trip2Go.first, p: SA1 }, completed: { at: trip2At.last, p: ELSEWHERE } });
    await tripOn(t.db, g, { address: POOL }); // terjadwal, belum dijalankan

    const day = await getTruckDay(owner(), { truckId: g.truckId, date: DAY });
    const straight = haversineMeters(POOL, SA1) + haversineMeters(SA1, NOWHERE) + haversineMeters(NOWHERE, SA1) + haversineMeters(SA1, ELSEWHERE) + haversineMeters(ELSEWHERE, POOL);
    expect(day.distanceM!).toBeGreaterThan(straight * 0.97);
    expect(day.distanceM!).toBeLessThan(straight * 1.03);
    expect(day.betweenTripDistanceM!).toBeGreaterThan(haversineMeters(NOWHERE, SA1) * 0.95);
    expect(day.betweenTripDistanceM!).toBeLessThan(haversineMeters(NOWHERE, SA1) * 1.05);
    expect(day).toMatchObject({ tripCount: 2, completedTrips: 2, scheduledTrips: 3, failedTrips: 0, isEstimated: false });
    expect(Math.abs(day.firstMoveAt!.getTime() - toSource.first.getTime())).toBeLessThanOrEqual(2 * 60_000);
    expect(Math.abs(day.lastMoveAt!.getTime() - home.last.getTime())).toBeLessThanOrEqual(2 * 60_000);
    expect(day.movingS).toBeGreaterThan(50 * 60);
    expect(day.stoppedS).toBeGreaterThan(60 * 60);
    expect(day.trips.map((x) => x.status).sort()).toEqual(["completed", "completed"]);
    expect(day.trips.every((x) => (x.distanceM ?? 0) > 9_000)).toBe(true);

    // Ringkasan per hari disimpan job harian (idempoten) dan tampil di daftar semua truk.
    await runDailySummaries(wib("2026-09-23", "00:40"), t.db, { date: DAY });
    await runDailySummaries(wib("2026-09-23", "00:45"), t.db, { date: DAY });
    const persisted = await t.db.select().from(truckDaySummaries).where(and(eq(truckDaySummaries.truckId, g.truckId), eq(truckDaySummaries.businessDate, DAY)));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ tripCount: 2, isEstimated: false });
    const all = await listTruckDays(dispatcher(), { date: DAY });
    expect(all.rows.find((r) => r.truckId === g.truckId)).toMatchObject({ persisted: true, completedTrips: 2, scheduledTrips: 3 });
  });

  it("US-M12-03 KP-3 jejak dapat diputar ulang dan diekspor (PDF ringkasan, Excel titik berhenti); posisi mentah tidak diekspor", async () => {
    const g = await gpsTruck(t.db);
    const b = trackBuilder(wib(DAY, "13:00"));
    const go = b.add((s) => drive(g.deviceCode, SA1, NOWHERE, s, { speedKmh: 40 }));
    const stay = b.add((s) => dwell(g.deviceCode, NOWHERE, s, 12));
    await feed(t.db, b.fixes);
    await tripOn(t.db, g, { address: NOWHERE, departed: { at: go.first, p: SA1 }, completed: { at: stay.last, p: NOWHERE } });

    const replay = await getReplay(owner(), { truckId: g.truckId, to: wib(DAY, "14:00").toISOString() });
    expect(replay.points.length).toBe(b.fixes.length);
    expect(replay.points[0]).toMatchObject({ source: "gps_device" });
    expect(replay.statusPoints.map((s) => s.status)).toEqual(["departed", "completed"]);
    expect(replay.stops.length).toBeGreaterThanOrEqual(1);

    const pdf = await exportReport(owner(), "m12.trips", "pdf", { from: DAY, to: DAY, truckId: g.truckId });
    expect(pdf.contentType).toContain("pdf");
    expect(pdf.rowCount).toBe(1);
    const xlsx = await exportReport(dispatcher(), "m12.stops", "xlsx", { from: DAY, to: DAY, truckId: g.truckId });
    expect(xlsx.contentType).toContain("spreadsheet");
    expect(xlsx.rowCount).toBeGreaterThanOrEqual(1);
    await expect(exportReport(seededContext("keuangan1"), "m12.trips", "xlsx", { from: DAY, to: DAY })).rejects.toBeInstanceOf(ForbiddenError);
    // Tidak ada laporan M12 yang memuat posisi mentah (waktu perangkat/kecepatan per posisi).
    const m12 = listReports(owner()).filter((r) => r.key.startsWith("m12."));
    expect(m12.length).toBeGreaterThanOrEqual(8);
    for (const r of m12) {
      expect(r.key).not.toMatch(/position|raw/);
      expect(r.columns.map((c) => c.key)).not.toContain("speedKmh");
      expect(r.columns.map((c) => c.key)).not.toContain("deviceTime");
    }
  });

  it("US-M12-03 KP-1 rit yang Berangkat di luar urutan rencana (M3 `actual_order`) ditandai pada riwayat per rit", async () => {
    const g = await gpsTruck(t.db, { withDevice: false });
    const trip = await tripOn(t.db, g, { address: NOWHERE, departed: { at: wib(DAY, "12:00"), p: SA1 }, completed: { at: wib(DAY, "12:40"), p: NOWHERE } });
    await t.db.update(trips).set({ routeOrder: 2, actualOrder: 1 }).where(eq(trips.id, trip.id));
    const row = (await listTripHistory(owner(), { date: DAY, truckId: g.truckId })).rows[0]!;
    expect(row).toMatchObject({ outOfOrder: true, plannedOrder: 2, actualOrder: 1 });
  });

  it("US-M12-03 KP-4 jarak dari jejak perangkat; bila hanya titik status ponsel tersedia, jarak diestimasi dari rute peta dan ditandai 'estimasi'", async () => {
    const g = await gpsTruck(t.db, { withDevice: false });
    const trip = await tripOn(t.db, g, { address: NOWHERE, departed: { at: wib(DAY, "09:00"), p: SA1 }, completed: { at: wib(DAY, "09:40"), p: NOWHERE } });
    const detail = await getTripHistory(owner(), trip.id);
    expect(detail.track).toMatchObject({ isEstimated: true, source: "status_point" });
    const expected = haversineMeters(SA1, NOWHERE) * 1.3;
    expect(Math.abs(detail.track.distanceM! - expected)).toBeLessThan(150);

    await runDailySummaries(wib("2026-09-23", "00:40"), t.db, { date: DAY });
    const [saved] = await t.db.select().from(tripTracks).where(eq(tripTracks.tripId, trip.id));
    expect(saved).toMatchObject({ isEstimated: true });
    const day = await getTruckDay(owner(), { truckId: g.truckId, date: DAY });
    expect(day.isEstimated).toBe(true);
    expect(Math.abs(day.distanceM! - expected)).toBeLessThan(150);
    const row = (await listTripHistory(owner(), { date: DAY, truckId: g.truckId })).rows[0]!;
    expect(row).toMatchObject({ isEstimated: true, computed: true });
  });
});
