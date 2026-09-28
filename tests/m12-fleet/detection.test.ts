import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditLogs, devices, fleetEvents, notifications, trips, trucks } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import * as flags from "@/server/core/flags";
import * as params from "@/server/core/params";
import { fleetDaySummary, getFleetEvent, reviewFleetEvent, runTravelDetection } from "@/server/modules/m12-fleet";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createCustomer, createOrder, createScheduledTrip } from "../helpers/fixtures";
import { driverWorld, expectApplied } from "../m3-driver/helpers";
import { chain, D01, drive, dwell, ELSEWHERE, feed, gpsTruck, minutesAfter, NOWHERE, POOL, SA1, wib, type GpsTruck } from "./helpers";

const DAY = "2026-09-22";
const owner = (now?: Date) => seededContext("pemilik", now ? { now } : {});
const dispatcher = (now?: Date) => seededContext("dispatcher1", now ? { now } : {});

async function eventsOf(db: ReturnType<typeof useTestDb>["db"], truckId: string) {
  return db.select().from(fleetEvents).where(eq(fleetEvents.truckId, truckId)).orderBy(fleetEvents.startedAt);
}

async function travelEvents(db: ReturnType<typeof useTestDb>["db"], truckId: string) {
  return db
    .select()
    .from(fleetEvents)
    .where(and(eq(fleetEvents.truckId, truckId), inArray(fleetEvents.kind, ["off_schedule_trip", "off_hours_trip", "unknown_stop", "maintenance_trip"])));
}

/** Truk dengan ponsel yang terakhir dipakai sopir seed (pengguna aktif, US-M12-05 KP-3). */
async function withActiveUser(db: ReturnType<typeof useTestDb>["db"], g: GpsTruck, username = "sopir1"): Promise<string> {
  const phoneId = newId();
  const userId = userIdByUsername(username);
  await db.insert(devices).values({ id: phoneId, tenantId: EQUA_TENANT_ID, deviceCode: `HP-U-${phoneId.slice(-6)}`, name: "Ponsel uji", kind: "phone", status: "active", truckId: g.truckId, lastUserId: userId });
  await db.update(trucks).set({ fieldDeviceId: phoneId }).where(eq(trucks.id, g.truckId));
  return userId;
}

/** Rit terjadwal milik truk uji dengan Berangkat/Selesai pada waktu tertentu. */
async function tripFor(db: ReturnType<typeof useTestDb>["db"], g: GpsTruck, at: { departed: Date; completed?: Date; address?: { lat: number; lng: number } }) {
  const cust = await createCustomer(db, { lat: at.address?.lat ?? ELSEWHERE.lat, lng: at.address?.lng ?? ELSEWHERE.lng });
  const order = await createOrder(db, { customerId: cust.id, addressId: cust.addressId!, date: DAY });
  const trip = await createScheduledTrip(db, { order, truckId: g.truckId, date: DAY });
  await db
    .update(trips)
    .set({
      status: at.completed ? "completed" : "departed",
      departedAt: at.departed,
      completedAt: at.completed ?? null,
      completionBusinessDate: at.completed ? DAY : null,
      publishedAt: minutesAfter(at.departed, -60),
      driverUserId: userIdByUsername("sopir2"),
    })
    .where(eq(trips.id, trip.id));
  return trip;
}

describe("M12 — perjalanan di luar jadwal/jam & berhenti tidak dikenal (US-M12-05)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M12-05 KP-1 KP-3 truk bergerak > PAR-50 tanpa rit Berangkat → kejadian (waktu, lokasi, jarak/durasi, truk, pengguna aktif) + notifikasi Dispatcher & pemilik + tugas keterangan sopir", async () => {
    const g = await gpsTruck(t.db);
    const activeUser = await withActiveUser(t.db, g);
    const t0 = wib(DAY, "08:00");
    await feed(t.db, chain([(s) => dwell(g.deviceCode, POOL, s, 10), (s) => drive(g.deviceCode, POOL, NOWHERE, s), (s) => dwell(g.deviceCode, NOWHERE, s, 12)], t0));
    await runTravelDetection(minutesAfter(t0, 40), t.db);
    const evs = await travelEvents(t.db, g.truckId);
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev).toMatchObject({ kind: "off_schedule_trip", status: "detected", requiresExplanation: true, userId: activeUser, businessDate: DAY, deviceId: g.deviceId });
    expect(ev.distanceM!).toBeGreaterThan(2_000);
    expect(ev.durationS!).toBeGreaterThan(300);
    expect(Math.abs(ev.lat! - NOWHERE.lat)).toBeLessThan(0.001);
    expect(ev.startedAt.getTime()).toBeGreaterThanOrEqual(minutesAfter(t0, 10).getTime());
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.off_schedule"), eq(notifications.objectId, ev.id)));
    const recipients = new Set(notes.map((n) => n.recipientUserId));
    expect(recipients.has(userIdByUsername("pemilik"))).toBe(true);
    expect(recipients.has(userIdByUsername("dispatcher1"))).toBe(true);
    const toDriver = await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.explanation_requested"), eq(notifications.objectId, ev.id)));
    expect(toDriver.map((n) => n.recipientUserId)).toEqual([activeUser]);
    // Job berjalan ulang → tidak menggandakan kejadian (idempoten).
    await runTravelDetection(minutesAfter(t0, 45), t.db);
    expect(await travelEvents(t.db, g.truckId)).toHaveLength(1);
    const detail = await getFleetEvent(dispatcher(), ev.id);
    expect(detail).toMatchObject({ kindLabel: "Perjalanan di luar jadwal", truckCode: g.code, userName: expect.any(String) });
  });

  it("US-M12-05 KP-1 perjalanan yang diharapkan menuju lokasi sah (ke sumber sebelum rit pertama; kembali ke pool setelah rit terakhir) tidak ditandai", async () => {
    const g = await gpsTruck(t.db);
    const t0 = wib(DAY, "06:00");
    const trip = await tripFor(t.db, g, { departed: wib(DAY, "07:05"), completed: wib(DAY, "07:40"), address: NOWHERE });
    await feed(
      t.db,
      chain(
        [
          (s) => dwell(g.deviceCode, POOL, s, 8), // pool
          (s) => drive(g.deviceCode, POOL, SA1, s, { speedKmh: 40 }), // ke sumber sebelum rit pertama
          (s) => dwell(g.deviceCode, SA1, s, 20),
        ],
        t0,
      ),
    );
    await feed(t.db, [...drive(g.deviceCode, SA1, NOWHERE, wib(DAY, "07:05"), { speedKmh: 40 }), ...dwell(g.deviceCode, NOWHERE, wib(DAY, "07:30"), 10)]);
    await feed(t.db, chain([(s) => drive(g.deviceCode, NOWHERE, POOL, s), (s) => dwell(g.deviceCode, POOL, s, 15)], wib(DAY, "07:45")));
    await runTravelDetection(wib(DAY, "09:00"), t.db);
    expect(await travelEvents(t.db, g.truckId)).toHaveLength(0);
    expect(trip.id).toBeTruthy();
  });

  it("US-M12-05 KP-1 gerak di luar jam layanan PAR-07 ditandai 'di luar jam layanan'; gerak kecil ≤ PAR-50 pada jam layanan tidak ditandai", async () => {
    const g = await gpsTruck(t.db);
    const night = wib(DAY, "22:30");
    await feed(t.db, chain([(s) => dwell(g.deviceCode, POOL, s, 6), (s) => drive(g.deviceCode, POOL, NOWHERE, s), (s) => dwell(g.deviceCode, NOWHERE, s, 8)], night));
    await runTravelDetection(minutesAfter(night, 30), t.db);
    const evs = await travelEvents(t.db, g.truckId);
    expect(evs.map((e) => e.kind)).toEqual(["off_hours_trip"]);
    expect(evs[0]!.details).toMatchObject({ offHours: true });

    const g2 = await gpsTruck(t.db);
    const day = wib(DAY, "10:00");
    const near = { lat: NOWHERE.lat + 300 / 111_320, lng: NOWHERE.lng };
    await feed(t.db, chain([(s) => dwell(g2.deviceCode, NOWHERE, s, 6), (s) => drive(g2.deviceCode, NOWHERE, near, s, { speedKmh: 10 }), (s) => dwell(g2.deviceCode, near, s, 8)], day));
    await runTravelDetection(minutesAfter(day, 30), t.db);
    expect(await travelEvents(t.db, g2.truckId)).toHaveLength(0);
  });

  it("US-M12-05 KP-1 gerak selama rit aktif bukan kejadian; Berangkat yang tersinkron terlambat menyelesaikan kejadian yang ternyata bagian rit", async () => {
    const g = await gpsTruck(t.db);
    const t0 = wib(DAY, "11:00");
    await tripFor(t.db, g, { departed: minutesAfter(t0, 9), completed: minutesAfter(t0, 50), address: NOWHERE });
    await feed(t.db, chain([(s) => dwell(g.deviceCode, SA1, s, 8), (s) => drive(g.deviceCode, SA1, NOWHERE, s), (s) => dwell(g.deviceCode, NOWHERE, s, 25)], t0));
    await runTravelDetection(minutesAfter(t0, 80), t.db);
    expect(await travelEvents(t.db, g.truckId)).toHaveLength(0);

    // Sopir berangkat offline: detektor melihat gerak tanpa rit → kejadian; Berangkat tersinkron → kejadian selesai otomatis.
    const g2 = await gpsTruck(t.db);
    const t1 = wib(DAY, "13:00");
    await feed(t.db, chain([(s) => dwell(g2.deviceCode, SA1, s, 8), (s) => drive(g2.deviceCode, SA1, ELSEWHERE, s), (s) => dwell(g2.deviceCode, ELSEWHERE, s, 10)], t1));
    await runTravelDetection(minutesAfter(t1, 60), t.db);
    const [ev] = await travelEvents(t.db, g2.truckId);
    expect(ev!.status).toBe("detected");
    const trip = await tripFor(t.db, g2, { departed: minutesAfter(t1, 7) });
    await withTx(
      (tx) =>
        emit(
          tx,
          "trip.departed",
          { tripId: trip.id, orderId: trip.orderId, truckId: g2.truckId, driverUserId: null, departedAt: minutesAfter(t1, 7).toISOString(), lat: SA1.lat, lng: SA1.lng, tripNumber: trip.number, businessDate: DAY, lateSync: true },
          { ctx: seededContext("sopir2", { now: minutesAfter(t1, 65) }), businessDate: DAY },
        ),
      { db: t.db },
    );
    const [after] = await travelEvents(t.db, g2.truckId);
    expect(after).toMatchObject({ status: "done", requiresExplanation: false });
    expect(after!.details).toMatchObject({ autoResolved: "late_departure_sync" });
  });

  it("US-M12-05 KP-2 berhenti > PAR-51 di luar alamat rit, sumber, depot, pool selama rit aktif → 'berhenti tidak dikenal' (juga saat masih berlangsung); berhenti di alamat rit tidak ditandai", async () => {
    const g = await gpsTruck(t.db);
    const t0 = wib(DAY, "14:00");
    const trip = await tripFor(t.db, g, { departed: t0, address: ELSEWHERE });
    // Dari depot D01 (± 2,2 km) → berhenti 20 menit di warung (bukan lokasi sah, bukan alamat rit).
    await feed(t.db, chain([(s) => drive(g.deviceCode, D01, NOWHERE, s), (s) => dwell(g.deviceCode, NOWHERE, s, 20)], t0));
    const firstRun = minutesAfter(t0, 32);
    await runTravelDetection(firstRun, t.db);
    const evs = await travelEvents(t.db, g.truckId);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: "unknown_stop", tripId: trip.id, requiresExplanation: true });
    const before = evs[0]!.durationS!;
    expect(before).toBeGreaterThan(15 * 60);
    expect(await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.unknown_stop"), eq(notifications.objectId, evs[0]!.id)))).not.toHaveLength(0);
    // Masih berhenti → lama diperbarui, bukan kejadian baru.
    const last = evs[0]!.endedAt!;
    await feed(t.db, dwell(g.deviceCode, NOWHERE, minutesAfter(last, 1), 10));
    await runTravelDetection(minutesAfter(firstRun, 15), t.db);
    const again = await travelEvents(t.db, g.truckId);
    expect(again).toHaveLength(1);
    expect(again[0]!.durationS!).toBeGreaterThan(before);

    // Berhenti lama di alamat rit sendiri → tidak ditandai.
    const g2 = await gpsTruck(t.db);
    const t1 = wib(DAY, "15:00");
    await tripFor(t.db, g2, { departed: t1, address: NOWHERE });
    await feed(t.db, chain([(s) => drive(g2.deviceCode, SA1, NOWHERE, s), (s) => dwell(g2.deviceCode, NOWHERE, s, 30)], t1));
    await runTravelDetection(minutesAfter(t1, 45), t.db);
    expect(await travelEvents(t.db, g2.truckId)).toHaveLength(0);
  });

  it("US-M12-05 KP-5 parameter deteksi (PAR-50) diubah pemilik dengan tanggal berlaku, berjejak, dan dipakai deteksi; Dispatcher ditolak", async () => {
    const date = addDays(toBusinessDate(new Date()), 3); // parameter tidak berlaku surut
    await expect(params.set(dispatcher(), "PAR-50", { distance_m_gt: 5_000, minutes_gt: 60 }, date, "Uji dispatcher")).rejects.toBeInstanceOf(ForbiddenError);
    await params.set(owner(), "PAR-50", { distance_m_gt: 5_000, minutes_gt: 60 }, date, "Kalibrasi pilot: gerak pendek diabaikan");
    const audit = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "parameter"), eq(auditLogs.objectId, "PAR-50")));
    expect(audit.at(-1)!.reason).toBe("Kalibrasi pilot: gerak pendek diabaikan");
    const g = await gpsTruck(t.db);
    const t0 = wib(date, "09:00");
    await feed(t.db, chain([(s) => dwell(g.deviceCode, POOL, s, 8), (s) => drive(g.deviceCode, POOL, NOWHERE, s), (s) => dwell(g.deviceCode, NOWHERE, s, 10)], t0));
    await runTravelDetection(minutesAfter(t0, 40), t.db);
    expect(await travelEvents(t.db, g.truckId)).toHaveLength(0);
  });

  it("US-M12-05 7.12.6 deteksi dinonaktifkan per truk (flag `fleet.offschedule_detection`, perangkat belum terpasang); truk Perbaikan → 'perjalanan perbaikan' tanpa keterangan; posisi berakurasi buruk tidak memicu kejadian", async () => {
    const t0 = wib(DAY, "16:00");
    const route = (code: string) => chain([(s) => dwell(code, POOL, s, 8), (s) => drive(code, POOL, NOWHERE, s), (s) => dwell(code, NOWHERE, s, 10)], t0);
    const off = await gpsTruck(t.db);
    await flags.set(owner(), "fleet.offschedule_detection", false, { scope: { type: "truck", refId: off.truckId }, reason: "Perangkat GPS baru dipasang, masa uji" });
    await feed(t.db, route(off.deviceCode));
    const repair = await gpsTruck(t.db, { status: "maintenance" });
    await feed(t.db, route(repair.deviceCode));
    const noisy = await gpsTruck(t.db);
    await feed(t.db, route(noisy.deviceCode).map((f, i) => (i > 8 ? { ...f, accuracyM: 400 } : f)));
    const noDevice = await gpsTruck(t.db, { withDevice: false });
    const results = await runTravelDetection(minutesAfter(t0, 40), t.db);
    expect(results.find((r) => r.truckId === off.truckId)!.skipped).toBe("flag_off");
    expect(results.find((r) => r.truckId === noDevice.truckId)!.skipped).toBe("no_device");
    expect(await travelEvents(t.db, off.truckId)).toHaveLength(0);
    expect(await travelEvents(t.db, noisy.truckId)).toHaveLength(0);
    const rep = await travelEvents(t.db, repair.truckId);
    expect(rep.map((e) => [e.kind, e.requiresExplanation])).toEqual([["maintenance_trip", false]]);
    expect(await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.off_schedule"), eq(notifications.objectId, rep[0]!.id)))).toHaveLength(0);
    expect((await eventsOf(t.db, off.truckId)).length).toBe(0);
  });

  it("US-M12-05 KP-3 KP-4 alur: tugas keterangan di aplikasi sopir (hari yang sama) → keterangan sopir → pemilik meninjau (terima) → Selesai; tanpa keterangan saat tutup kas → ditandai, kotak masuk pemilik & H+0", async () => {
    const w = await driverWorld(t.db);
    const deviceId = newId();
    const code = `GPS-D-${deviceId.slice(-5)}`;
    await t.db.insert(devices).values({ id: deviceId, tenantId: EQUA_TENANT_ID, deviceCode: code, name: "GPS truk uji", kind: "gps", status: "active", truckId: w.truck.id });
    await t.db.update(trucks).set({ gpsDeviceId: deviceId }).where(eq(trucks.id, w.truck.id));
    const now = new Date();
    const start = minutesAfter(now, -60);
    const g: GpsTruck = { truckId: w.truck.id, code: w.truck.code, deviceId, deviceCode: code, imei: "" };
    await feed(t.db, chain([(s) => dwell(g.deviceCode, POOL, s, 8), (s) => drive(g.deviceCode, POOL, NOWHERE, s), (s) => dwell(g.deviceCode, NOWHERE, s, 12)], start));
    await runTravelDetection(minutesAfter(start, 45), t.db);
    const created = await travelEvents(t.db, w.truck.id);
    expect(created).toHaveLength(1);
    const [ev1] = created;
    // Kejadian kedua (tanpa keterangan) untuk tutup kas.
    await feed(t.db, chain([(s) => drive(g.deviceCode, NOWHERE, ELSEWHERE, s), (s) => dwell(g.deviceCode, ELSEWHERE, s, 12)], minutesAfter(start, 34)));
    await runTravelDetection(minutesAfter(start, 59), t.db);
    const both = await travelEvents(t.db, w.truck.id);
    expect(both).toHaveLength(2);
    const ev2 = both.find((e) => e.id !== ev1!.id)!;

    const tasks = (await w.today()).explanationTasks.map((x) => x.fleetEventId);
    expect(tasks).toEqual(expect.arrayContaining([ev1!.id, ev2.id]));
    expectApplied(await w.send(w.sopir, "m3.travel_explanation.create", { fleetEventId: ev1!.id, explanation: "Ke bengkel tambal ban dekat pool, diminta Dispatcher." }));
    const [explained] = await t.db.select().from(fleetEvents).where(eq(fleetEvents.id, ev1!.id));
    expect(explained!.status).toBe("explained");
    await reviewFleetEvent(owner(), { fleetEventId: ev1!.id, decision: "accepted", note: "Sesuai konfirmasi Dispatcher" });
    const [done] = await t.db.select().from(fleetEvents).where(eq(fleetEvents.id, ev1!.id));
    expect(done).toMatchObject({ status: "done", reviewDecision: "accepted", reviewedBy: userIdByUsername("pemilik") });
    const trail = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "fleet_event"), eq(auditLogs.objectId, ev1!.id)));
    expect(trail.map((a) => a.action)).toEqual(expect.arrayContaining(["detect", "explain", "review"]));

    // Tutup kas hari kejadian: kejadian kedua belum diberi keterangan → ditandai + kotak masuk pemilik + H+0.
    const date = ev2.businessDate;
    await withTx(
      (tx) =>
        emit(tx, "cash_day.closed", { cashDayId: newId(), closedBy: userIdByUsername("keuangan1"), late: false, exceptionCount: 0, businessDate: date, closedAt: now.toISOString() }, { ctx: seededContext("keuangan1", { now }), businessDate: date }),
      { db: t.db },
    );
    const [flagged] = await t.db.select().from(fleetEvents).where(eq(fleetEvents.id, ev2.id));
    expect(flagged!.details).toMatchObject({ unexplainedAtCashClose: now.toISOString() });
    const inbox = await t.db.select().from(notifications).where(and(eq(notifications.event, "travel_explanation.missing"), eq(notifications.recipientUserId, userIdByUsername("pemilik"))));
    expect(inbox.length).toBeGreaterThanOrEqual(1);
    const h0 = await fleetDaySummary(t.db, EQUA_TENANT_ID, date, now);
    expect(h0.unexplained.map((u) => u.id)).toContain(ev2.id);
    expect(h0.unexplained.map((u) => u.id)).not.toContain(ev1!.id);
  });
});
