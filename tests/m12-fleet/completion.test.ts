import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customerAddresses, fleetEvents, notifications } from "@/db/schema";
import { EQUA_TENANT_ID, OUTLET_SEEDS, outletId, userIdByUsername } from "@/db/seed";
import { addDays, toBusinessDate } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { DomainError, ForbiddenError, ValidationError } from "@/server/core/errors";
import { closeFleetEvent, getFleetEvent, listFleetEvents, locationDeviationPatterns, recheckRecentCompletions, reviewFleetEvent } from "@/server/modules/m12-fleet";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { completeCash, departArrive, driverWorld, expectApplied, HERE, HOME, north, PHOTO, type World } from "../m3-driver/helpers";
import { attachGps, dwell, feed, minutesAfter } from "./helpers";

const owner = () => seededContext("pemilik");
const dispatcher = () => seededContext("dispatcher1");
const finance = () => seededContext("keuangan1");

type Db = ReturnType<typeof useTestDb>["db"];

async function locationEvents(db: Db, tripId: string) {
  return db
    .select()
    .from(fleetEvents)
    .where(and(eq(fleetEvents.tripId, tripId), inArray(fleetEvents.kind, ["location_deviation_l1", "location_deviation_l2", "location_source_inconsistent", "no_location"])));
}

/** Pasang perangkat GPS di truk dunia M3 (master armada). */
async function withGps(db: Db, w: World): Promise<string> {
  return (await attachGps(db, w.truck.id)).deviceCode;
}

describe("M12 — pencocokan lokasi Selesai dengan alamat pelanggan (US-M12-04)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M12-04 KP-1 Selesai > 200 m dari alamat Dikunci → tingkat 1 (informasi, alasan sopir tercatat); > 1 km → tingkat 2 untuk tinjauan pemilik; hitungan server menggantikan hitungan aplikasi", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    // Aplikasi mengira 0 m (GPS ponsel usang) — server menghitung ± 450 m.
    expectApplied(await completeCash(w, a.id, w.sopir, { location: north(450), clientDistanceM: 0 }));
    const [l1] = await locationEvents(t.db, a.id);
    expect(l1).toMatchObject({ kind: "location_deviation_l1", status: "done", userId: w.driver.userId });
    expect(l1!.distanceM!).toBeGreaterThan(430);
    expect(l1!.distanceM!).toBeLessThan(470);
    expect(l1!.details).toMatchObject({ targetKind: "address", target: { lat: HOME.lat, lng: HOME.lng }, reason: null });

    const b = await w.addTrip();
    await departArrive(w, b.id);
    expectApplied(await completeCash(w, b.id, w.sopir, { location: north(1_500), clientDistanceM: 1_480, locationReason: "customer_other_point" }));
    const [l2] = await locationEvents(t.db, b.id);
    expect(l2).toMatchObject({ kind: "location_deviation_l2", status: "explained" });
    expect(l2!.details).toMatchObject({ reason: "customer_other_point", reasonLabel: "Pelanggan minta titik lain" });
    const review = await listFleetEvents(owner(), { view: "review" });
    expect(review.map((r) => r.id)).toContain(l2!.id);
    expect(review.map((r) => r.id)).not.toContain(l1!.id);

    // Titik dalam 200 m → tidak ada penyimpangan. Sinkron ulang perintah yang sama tidak menggandakan kejadian.
    const c = await w.addTrip();
    await departArrive(w, c.id);
    expectApplied(await completeCash(w, c.id, w.sopir, { location: north(120) }));
    expect(await locationEvents(t.db, c.id)).toHaveLength(0);
  });

  it("US-M12-04 KP-2 posisi perangkat GPS saat Selesai vs titik Selesai ponsel beda > 200 m → 'sumber lokasi tidak konsisten' ke pemilik; posisi perangkat yang tiba terlambat dinilai ulang job", async () => {
    const w = await driverWorld(t.db);
    const code = await withGps(t.db, w);
    const now = new Date();
    // Truk (perangkat GPS) diam ± 900 m dari alamat; sopir menekan Selesai dengan titik ponsel di alamat.
    await feed(t.db, dwell(code, north(900), minutesAfter(now, -6), 6));
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    const [ev] = (await locationEvents(t.db, a.id)).filter((e) => e.kind === "location_source_inconsistent");
    expect(ev).toBeTruthy();
    expect(ev!.distanceM!).toBeGreaterThan(850);
    expect(ev!.details).toMatchObject({ phonePoint: { lat: HERE.lat, lng: HERE.lng }, thresholdM: 200 });
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.location_inconsistent"), eq(notifications.objectId, ev!.id)));
    expect(notes.map((n) => n.recipientUserId)).toContain(userIdByUsername("pemilik"));
    expect((await listFleetEvents(owner(), { view: "review" })).map((r) => r.id)).toContain(ev!.id);

    // Perangkat di dekat titik Selesai → konsisten.
    const w2 = await driverWorld(t.db);
    const code2 = await withGps(t.db, w2);
    await feed(t.db, dwell(code2, north(40), minutesAfter(new Date(), -4), 4));
    const b = await w2.addTrip();
    await departArrive(w2, b.id);
    expectApplied(await completeCash(w2, b.id));
    expect((await locationEvents(t.db, b.id)).filter((e) => e.kind === "location_source_inconsistent")).toHaveLength(0);

    // Posisi perangkat baru tiba setelah rit tersinkron → job menilai ulang (idempoten).
    const w3 = await driverWorld(t.db);
    const code3 = await withGps(t.db, w3);
    const c = await w3.addTrip();
    await departArrive(w3, c.id);
    const completedAt = new Date();
    expectApplied(await completeCash(w3, c.id));
    expect(await locationEvents(t.db, c.id)).toHaveLength(0);
    await feed(t.db, dwell(code3, north(1_200), minutesAfter(completedAt, -3), 5));
    const later = minutesAfter(completedAt, 10);
    expect(await withTx((tx) => recheckRecentCompletions(tx, EQUA_TENANT_ID, later), { db: t.db })).toBeGreaterThanOrEqual(1);
    await withTx((tx) => recheckRecentCompletions(tx, EQUA_TENANT_ID, later), { db: t.db });
    expect((await locationEvents(t.db, c.id)).map((e) => e.kind)).toEqual(["location_source_inconsistent"]);
  });

  it("US-M12-04 KP-3 daftar tinjauan pemilik (rit, pelanggan, jarak, alasan sopir, peta kecil) dengan tindakan terima / minta keterangan (tugas ke M3) / tindak lanjut — berjejak; Dispatcher tidak dapat memutus, keuangan tidak melihat", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id, w.sopir, { location: north(1_600), clientDistanceM: 1_600, locationReason: "gps_inaccurate" }));
    const b = await w.addTrip();
    await departArrive(w, b.id);
    expectApplied(await completeCash(w, b.id, w.sopir, { location: north(2_200), clientDistanceM: 2_200, locationReason: "wrong_master_address" }));
    const [evA] = await locationEvents(t.db, a.id);
    const [evB] = await locationEvents(t.db, b.id);

    const list = await listFleetEvents(owner(), { view: "review" });
    const rowA = list.find((r) => r.id === evA!.id)!;
    expect(rowA).toMatchObject({ tripNumber: a.number, customerName: expect.any(String), needsReview: true, kindLabel: "Penyimpangan lokasi tingkat 2" });
    expect(rowA.distanceM!).toBeGreaterThan(1_500);
    expect(rowA.details).toMatchObject({ reasonLabel: "GPS tidak akurat" });
    const detail = await getFleetEvent(owner(), evA!.id);
    expect(detail.target).toEqual({ lat: HOME.lat, lng: HOME.lng });
    expect(detail.lat).toBeCloseTo(north(1_600).lat, 5);
    expect(detail.addressText).toContain("Jl. Uji");

    await expect(reviewFleetEvent(dispatcher(), { fleetEventId: evA!.id, decision: "accepted" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listFleetEvents(finance(), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reviewFleetEvent(dispatcher(), { fleetEventId: evA!.id, decision: "request_explanation" })).rejects.toBeInstanceOf(ValidationError);

    // Minta keterangan → tugas di aplikasi sopir (M3) + pemberitahuan sopir; sopir menjelaskan; pemilik menerima.
    await reviewFleetEvent(dispatcher(), { fleetEventId: evA!.id, decision: "request_explanation", note: "Jelaskan kenapa Selesai jauh dari rumah pelanggan." });
    const toDriver = await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.explanation_requested"), eq(notifications.objectId, evA!.id)));
    expect(toDriver.map((n) => n.recipientUserId)).toEqual([w.driver.userId]);
    expect((await w.today()).explanationTasks.map((x) => x.fleetEventId)).toContain(evA!.id);
    expectApplied(await w.send(w.sopir, "m3.travel_explanation.create", { fleetEventId: evA!.id, explanation: "Pelanggan pindah titik bongkar ke kebun belakang." }));
    const accepted = await reviewFleetEvent(owner(), { fleetEventId: evA!.id, decision: "accepted", note: "Dikonfirmasi pelanggan lewat telepon." });
    expect(accepted).toMatchObject({ status: "done", reviewDecision: "accepted" });
    await expect(reviewFleetEvent(owner(), { fleetEventId: evA!.id, decision: "follow_up", note: "ubah" })).rejects.toBeInstanceOf(DomainError);

    // Tindak lanjut di luar sistem → Ditinjau → Selesai dengan hasil.
    const followed = await reviewFleetEvent(owner(), { fleetEventId: evB!.id, decision: "follow_up", note: "Cek alamat master bersama Dispatcher." });
    expect(followed.status).toBe("reviewed");
    const closed = await closeFleetEvent(owner(), { fleetEventId: evB!.id, note: "Koordinat alamat dikoreksi lewat Data master." });
    expect(closed.status).toBe("done");
    const trail = (await getFleetEvent(owner(), evB!.id)).trail.map((x) => x.action);
    expect(trail).toEqual(["detect", "review", "close"]);
    const trailA = (await getFleetEvent(owner(), evA!.id)).trail.map((x) => x.action);
    expect(trailA).toEqual(expect.arrayContaining(["detect", "request_explanation", "explain", "review"]));

    // Pola berulang per sopir & per pelanggan (masukan US-M9-05).
    const today = toBusinessDate(new Date());
    const patterns = await locationDeviationPatterns(owner(), { from: addDays(today, -1), to: today });
    expect(patterns.byDriver.find((p) => p.key === w.driver.userId)).toMatchObject({ locationEvents: 2, level2: 2 });
    expect(patterns.byCustomer.find((p) => p.key === w.customer.id)).toMatchObject({ locationEvents: 2 });
  });

  it("US-M12-04 KP-4 alamat Belum dikunci: tanpa penyimpangan; titik Selesai diusulkan sebagai koordinat alamat (M1) — tanpa titik ponsel, posisi perangkat saat itu dicatat sebagai usulan", async () => {
    const w = await driverWorld(t.db, { lockedAddress: false });
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id, w.sopir, { location: north(3_000), clientDistanceM: 0 }));
    expect((await locationEvents(t.db, a.id)).filter((e) => e.kind.startsWith("location_deviation"))).toHaveLength(0);
    const [addr] = await t.db.select().from(customerAddresses).where(eq(customerAddresses.id, w.customer.addressId!));
    expect(addr!.proposedLat).toBeCloseTo(north(3_000).lat, 6);
    expect(addr!.proposedFromTripId).toBe(a.id);

    // Selesai tanpa lokasi ponsel: kejadian "tanpa lokasi" memuat posisi perangkat GPS saat itu.
    const w2 = await driverWorld(t.db, { lockedAddress: false });
    const code = await withGps(t.db, w2);
    await feed(t.db, dwell(code, north(60), minutesAfter(new Date(), -3), 3));
    const b = await w2.addTrip();
    await departArrive(w2, b.id);
    expectApplied(await completeCash(w2, b.id, w2.sopir, { location: null }));
    const [noLoc] = (await locationEvents(t.db, b.id)).filter((e) => e.kind === "no_location");
    expect(noLoc!.details).toMatchObject({ tripStatus: "completed", devicePosition: { lat: expect.closeTo(north(60).lat, 5), lng: expect.closeTo(HOME.lng, 5) } });
  });

  it("US-M12-04 KP-5 rit internal: tujuan pembanding = koordinat depot (bukan alamat pesanan)", async () => {
    const w = await driverWorld(t.db);
    const depot = OUTLET_SEEDS.find((o) => o.code === "D05")!;
    const at = (lat: number, lng: number) => ({ lat, lng, accuracyM: 6 });
    const complete = (tripId: string, loc: { lat: number; lng: number; accuracyM: number }) =>
      w.send(w.sopir, "m3.trip.complete", { tripId, recipientName: null, deliveredVolumeL: 5_000, location: loc, payment: { method: "none" } }, { attach: [PHOTO] });

    const i1 = await w.addTrip({ isInternal: true, destinationOutletId: outletId("D05"), paymentMethod: "internal" });
    await departArrive(w, i1.id);
    expectApplied(await complete(i1.id, at(depot.lat, depot.lng)));
    // Selesai tepat di depot (jauh dari alamat pesanan) → tidak ada penyimpangan menurut M12.
    expect((await locationEvents(t.db, i1.id)).filter((e) => e.kind.startsWith("location_deviation"))).toHaveLength(0);

    const i2 = await w.addTrip({ isInternal: true, destinationOutletId: outletId("D05"), paymentMethod: "internal" });
    await departArrive(w, i2.id);
    expectApplied(await complete(i2.id, at(depot.lat + 1_400 / 111_320, depot.lng)));
    const [ev] = await locationEvents(t.db, i2.id);
    expect(ev).toMatchObject({ kind: "location_deviation_l2", locationType: "outlet", locationId: outletId("D05") });
    expect(ev!.distanceM!).toBeGreaterThan(1_350);
    expect(ev!.distanceM!).toBeLessThan(1_450);
    expect(ev!.details).toMatchObject({ targetKind: "depot", target: { lat: depot.lat, lng: depot.lng } });
  });
});
