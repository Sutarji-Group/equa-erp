import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { attachments, domainEvents, fleetEvents, trips, tripIncidents, trucks } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";
import * as m3 from "@/server/modules/m3-driver";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { HERE, departArrive, dispatcher, driverWorld, expectApplied, expectRejected, notificationsFor, owner } from "./helpers";

describe("M3 — rit gagal, kendala & keterangan perjalanan (US-M3-06)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M3-06 KP-1 rit gagal pada Berangkat/Tiba: alasan wajib, foto opsional, waktu & posisi otomatis; rit → Gagal, pesanan kembali ke Dispatcher (M2); dua gagal berturut → BR-24", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const b = await w.addTrip();
    expectRejected(await w.send(w.sopir, "m3.trip.fail", { tripId: a.id, reason: "customer_absent", loadedWaterDisposition: "carried_to_next", location: HERE }), /setelah Berangkat/);
    await departArrive(w, a.id);
    expectRejected(await w.send(w.sopir, "m3.trip.fail", { tripId: a.id, reason: "", loadedWaterDisposition: "carried_to_next", location: HERE }), /alasan/i);
    const res = await w.send(w.sopir, "m3.trip.fail", { tripId: a.id, reason: "customer_absent", note: "Rumah kosong", loadedWaterDisposition: "carried_to_next", location: HERE }, { attach: [{ kind: "trip_fail_photo" }] });
    expectApplied(res);
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row).toMatchObject({ status: "failed", failReason: "customer_absent", failNote: "Rumah kosong", failLat: HERE.lat, loadedWaterDisposition: "carried_to_next" });
    const incident = (await t.db.select().from(tripIncidents).where(and(eq(tripIncidents.tripId, a.id), eq(tripIncidents.kind, "trip_failed"))))[0]!;
    const photo = await t.db.select().from(attachments).where(and(eq(attachments.objectType, "trip_incident"), eq(attachments.objectId, incident.id)));
    expect(photo).toHaveLength(1);
    // M2 menjadwalkan ulang: rit pengganti dibuat, Dispatcher diberi tahu.
    const replacement = await t.db.select().from(trips).where(eq(trips.orderId, a.orderId));
    expect(replacement.length).toBe(2);
    expect((await notificationsFor(t.db, "trip.failed")).length).toBeGreaterThan(0);
    // Gagal kedua berturut untuk pelanggan yang sama → consecutiveFailures = 2 (BR-24 di M2).
    await departArrive(w, b.id);
    expectApplied(await w.send(w.sopir, "m3.trip.fail", { tripId: b.id, reason: "customer_refused", loadedWaterDisposition: "returned_to_source", location: HERE }));
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, b.id), eq(domainEvents.type, "trip.failed"))))[0]!;
    expect(ev.payload).toMatchObject({ consecutiveFailures: 2, reason: "customer_refused" });
  });

  it("US-M3-06 KP-2 tindak lanjut air yang sudah dimuat wajib dipilih dan tercatat untuk neraca air M8", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectRejected(await w.send(w.sopir, "m3.trip.fail", { tripId: a.id, reason: "location_inaccessible", location: HERE }), /tindak lanjut air/i);
    expectApplied(await w.send(w.sopir, "m3.trip.fail", { tripId: a.id, reason: "location_inaccessible", loadedWaterDisposition: "unloaded_at_depot", location: null }));
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, a.id), eq(domainEvents.type, "trip.failed"))))[0]!;
    expect(ev.payload).toMatchObject({ loadedWaterDisposition: "unloaded_at_depot", plannedVolumeL: 5000, noLocation: true });
  });

  it("US-M3-06 KP-3 kendala tanpa mengakhiri rit: jenis, foto, catatan → Dispatcher; \"truk rusak\" → status truk Perbaikan setelah dikonfirmasi Dispatcher", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    const incidentId = newId();
    expectApplied(await w.send(w.sopir, "m3.trip_incident.create", { incidentId, tripId: a.id, kind: "truck_broken", description: "Ban pecah di Jl. Raya Cugenang", location: HERE }, { attach: [{ kind: "incident_photo" }] }));
    const [trip] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(trip!.status).toBe("arrived"); // rit tidak berakhir
    expect((await notificationsFor(t.db, "trip_incident.reported", incidentId)).length).toBeGreaterThan(0);
    // Status truk belum berubah sebelum konfirmasi.
    expect((await t.db.select({ s: trucks.status }).from(trucks).where(eq(trucks.id, w.truck.id)))[0]!.s).toBe("active");
    // Pemilik tidak dapat mengonfirmasi (izin Dispatcher).
    await expect(m3.confirmIncident(owner(), { incidentId, setTruckMaintenance: true, note: "ok" })).rejects.toThrow();
    const res = await m3.confirmIncident(dispatcher(), { incidentId, setTruckMaintenance: true, note: "Truk ditarik ke bengkel" });
    expect(res.truckStatusChanged).toBe(true);
    expect((await t.db.select({ s: trucks.status }).from(trucks).where(eq(trucks.id, w.truck.id)))[0]!.s).toBe("maintenance");
    const list = await m3.listIncidents(dispatcher(), { from: w.date, to: w.date });
    expect(list.find((i) => i.id === incidentId)).toMatchObject({ truckStatusChanged: true, tripNumber: a.number });
    await expect(m3.confirmIncident(dispatcher(), { incidentId, setTruckMaintenance: false, note: "lagi" })).rejects.toThrow(/sudah dikonfirmasi/);
  });

  it("US-M3-06 KP-4 keterangan perjalanan (BR-25): permintaan M12 tampil sebagai tugas; diisi hari yang sama (waktu perangkat); terlambat ditandai; belum diisi saat tutup kas → pemilik", async () => {
    const w = await driverWorld(t.db);
    await w.addTrip();
    const mk = async (date: string) => {
      const [ev] = await t.db
        .insert(fleetEvents)
        .values({ tenantId: w.truck.tenantId, kind: "off_schedule_trip", truckId: w.truck.id, businessDate: date, startedAt: new Date(), requiresExplanation: true, distanceM: 2300 })
        .returning();
      return ev!;
    };
    const todayEv = await mk(w.date);
    const yesterdayEv = await mk(addDays(w.date, -1));
    const other = await mk(w.date);
    const view = await w.today();
    expect(view.explanationTasks.map((x) => x.fleetEventId).sort()).toEqual([todayEv.id, yesterdayEv.id, other.id].sort());
    expect(view.explanationTasks[0]!.kindLabel).toBe("Perjalanan di luar jadwal");
    expectApplied(await w.send(w.sopir, "m3.travel_explanation.create", { fleetEventId: todayEv.id, explanation: "Mengisi BBM di SPBU Cianjur" }));
    expectApplied(await w.send(w.sopir, "m3.travel_explanation.create", { fleetEventId: yesterdayEv.id, explanation: "Mengantar truk ke tambal ban kemarin" }));
    const [a, b] = await Promise.all([todayEv, yesterdayEv].map(async (e) => (await t.db.select().from(fleetEvents).where(eq(fleetEvents.id, e.id)))[0]!));
    expect(a).toMatchObject({ status: "explained", explanationLate: false, explainedBy: w.driver.userId, explanationBusinessDate: w.date });
    expect(a!.explanationDeviceTime).toBeTruthy();
    expect(b).toMatchObject({ explanationLate: true });
    expect((await w.today()).explanationTasks.map((x) => x.fleetEventId)).toEqual([other.id]);
    // Tutup kas: tugas yang belum diisi dilaporkan ke pemilik.
    const res = await m3.runTravelExplanationCheck(new Date());
    expect(res.missing).toBeGreaterThanOrEqual(1);
    expect((await notificationsFor(t.db, "travel_explanation.missing")).length).toBeGreaterThan(0);
  });
});
