import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { attachments, customerAddresses, devices, trips, truckFills, users, userScopes } from "@/db/schema";
import { EQUA_TENANT_ID, SEED_DEMO_PIN, internalCustomerId, outletId } from "@/db/seed";
import { newId } from "@/lib/ids";
import { hash } from "@node-rs/argon2";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { fillsVsSchedule, linkTruckFill, listFills, reverseTruckFill } from "@/server/modules/m8-production";
import { exportReport } from "@/server/core/export";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";
import { fieldDevice } from "../helpers/field";
import { createTruck } from "../helpers/fixtures";
import { dispatcher, finance, owner, productionWorld } from "./helpers";

describe("M8 — pengisian truk per rit (US-M8-02)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M8-02 KP-1 daftar truk yang dijadwalkan mengisi di sumber ini + rit berikutnya disarankan; volume bawaan PAR-15", async () => {
    const w = await productionWorld(t.db);
    const trip1 = await w.addTrip({ routeOrder: 1 });
    const trip2 = await w.addTrip({ routeOrder: 2 });
    const today = await w.today();
    expect(today.rules.standardVolumeL).toBe(5_000);
    const truck = today.trucks.find((x) => x.id === w.truck.id)!;
    expect(truck.planned).toBe(true);
    expect(truck.nextTripId).toBe(trip1.id);
    expect(truck.trips.map((x) => x.id)).toEqual([trip1.id, trip2.id]);
    // Truk lain (tanpa rit di sumber ini) tampil sebagai pilihan "truk lain" (tidak dijadwalkan).
    expect(today.trucks.some((x) => x.id !== w.truck.id && !x.planned)).toBe(true);

    const res = await w.fill({ tripId: trip1.id, photo: true });
    expect(res.status).toBe("applied");
    expect(res.result).toMatchObject({ status: "linked", tripId: trip1.id, unplannedTruck: false });
    const [row] = await t.db.select().from(truckFills).where(eq(truckFills.id, res.objectId!));
    expect(row).toMatchObject({ volumeL: 5_000, volumeReason: null, filledAt: w.at("09:00"), businessDate: w.date });
    expect(row!.photoAttachmentId).toBeTruthy();
    const [att] = await t.db.select().from(attachments).where(eq(attachments.id, row!.photoAttachmentId!));
    expect(att).toMatchObject({ objectType: "truck_fill", objectId: row!.id });
    // Setelah terisi, rit berikutnya yang disarankan = rit kedua.
    const after = await w.today(w.at("09:05"));
    expect(after.trucks.find((x) => x.id === w.truck.id)!.nextTripId).toBe(trip2.id);
  });

  it("US-M8-02 KP-1 volume ≠ PAR-15 wajib alasan (mis. sisa muatan); foto opsional", async () => {
    const w = await productionWorld(t.db);
    const trip = await w.addTrip();
    const noReason = await w.fill({ tripId: trip.id, volumeL: 3_000 });
    expect(noReason.status).toBe("rejected");
    expect(noReason.message).toMatch(/pilih\/isi alasannya/);
    const ok = await w.fill({ tripId: trip.id, volumeL: 3_000, volumeReason: "Sisa muatan (air rit gagal masih di tangki)" });
    expect(ok.status).toBe("applied");
    const [row] = await t.db.select().from(truckFills).where(eq(truckFills.id, ok.objectId!));
    expect(row!.volumeReason).toMatch(/Sisa muatan/);
    expect(row!.photoAttachmentId).toBeNull();
    // Melebihi kapasitas tangki ditolak.
    const over = await w.fill({ volumeL: 6_000, volumeReason: "Coba lebih" });
    expect(over.status).toBe("rejected");
  });

  it("US-M8-02 KP-1 truk di luar rencana sumber ini dapat dipilih dengan konfirmasi → Dispatcher diberi tahu; rit tetap terkait (7.8.6)", async () => {
    const w = await productionWorld(t.db);
    const other = await createTruck(t.db, { code: `OT${Math.random().toString(36).slice(2, 6)}` });
    const res = await w.fill({ truckId: other.id, unplannedConfirmed: true });
    expect(res.status).toBe("applied");
    expect(res.result).toMatchObject({ unplannedTruck: true });
    const notes = await w.notificationsFor("production.fill_unplanned_truck", res.objectId!);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("US-M8-02 KP-2 satu pengisian satu rit; tanpa rit → 'pengisian tanpa rit' ditandai ke Dispatcher & pemilik", async () => {
    const w = await productionWorld(t.db);
    const trip = await w.addTrip();
    expect((await w.fill({ tripId: trip.id })).status).toBe("applied");
    // Pengisian kedua untuk rit yang sama (perangkat lain/pencatatan ganda) → tetap dicatat tanpa rit + konflik.
    const second = await w.fill({ tripId: trip.id, at: w.at("09:30") });
    expect(second.status).toBe("conflict");
    expect(second.message).toMatch(/sudah punya pengisian lain/);
    const [row] = await t.db.select().from(truckFills).where(eq(truckFills.id, second.objectId!));
    expect(row).toMatchObject({ tripId: null, requestedTripId: trip.id, status: "unlinked" });
    const live = await t.db.select().from(truckFills).where(eq(truckFills.tripId, trip.id));
    expect(live).toHaveLength(1);

    const noTrip = await w.fill({ at: w.at("10:00") });
    expect(noTrip.status).toBe("applied");
    expect(noTrip.result).toMatchObject({ status: "unlinked", tripId: null });
    const notes = await w.notificationsFor("production.fill_without_trip", noTrip.objectId!);
    const recipients = new Set(notes.map((n) => n.recipientUserId));
    const disp = (await t.db.select({ id: users.id }).from(users).where(eq(users.username, "dispatcher1")))[0]!.id;
    const own = (await t.db.select({ id: users.id }).from(users).where(eq(users.username, "pemilik")))[0]!.id;
    expect(recipients.has(disp)).toBe(true);
    expect(recipients.has(own)).toBe(true);

    // Dispatcher melihat pengisian vs jadwal rit.
    const board = await fillsVsSchedule(dispatcher(), { date: w.date, sourceId: w.source.id });
    const truckRow = board.find((b) => b.truckId === w.truck.id)!;
    expect(truckRow.trips[0]!.fill?.volumeL).toBe(5_000);
    expect(truckRow.fillsWithoutTrip.length).toBe(2);
  });

  it("US-M8-02 KP-2 Admin Keuangan menautkan pengisian tanpa rit ke rit truk yang sama (sekali)", async () => {
    const w = await productionWorld(t.db);
    const trip = await w.addTrip();
    const res = await w.fill({});
    await expect(linkTruckFill(dispatcher(), { fillId: res.objectId!, tripId: trip.id, reason: "Rit lupa dipilih" })).rejects.toThrow(/tidak diizinkan/);
    const linked = await linkTruckFill(finance(), { fillId: res.objectId!, tripId: trip.id, reason: "Rit lupa dipilih operator" });
    expect(linked).toMatchObject({ tripId: trip.id, status: "linked" });
    await expect(linkTruckFill(finance(), { fillId: res.objectId!, tripId: trip.id, reason: "Ulang tautan" })).rejects.toThrow(/sudah terkait/);
  });

  it("US-M8-02 KP-3 pengisian untuk rit internal pasokan depot ditandai otomatis sebagai pasokan (US-M8-03)", async () => {
    const w = await productionWorld(t.db);
    const [intAddr] = await t.db.select().from(customerAddresses).where(eq(customerAddresses.customerId, internalCustomerId("D06"))).limit(1);
    await t.db.update(customerAddresses).set({ referenceWaterSourceId: w.source.id }).where(eq(customerAddresses.id, intAddr!.id));
    const trip = await w.addTrip({ isInternal: true, destinationOutletId: outletId("D06"), customer: { id: internalCustomerId("D06"), code: "INT-D06", addressId: intAddr!.id, tenantId: EQUA_TENANT_ID } });
    const res = await w.fill({ tripId: trip.id });
    expect(res.result).toMatchObject({ isDepotSupply: true });
    const today = await w.today();
    expect(today.fills.find((f) => f.id === res.objectId)?.isDepotSupply).toBe(true);
  });

  it("US-M8-02 KP-4 pengisian dicocokkan geofence sumber (M12) — ketidaksesuaian ditandai, pencatatan tidak diblokir", async () => {
    const w = await productionWorld(t.db);
    const trip = await w.addTrip();
    const res = await w.fill({ tripId: trip.id });
    expect(res.status).toBe("applied");
    await withTx((tx) =>
      emit(
        tx,
        "fleet_event.detected",
        { fleetEventId: newId(), truckId: w.truck.id, kind: "fill_without_geofence", startedAt: w.at("09:00").toISOString(), tripId: trip.id },
        { ctx: systemContext({ now: w.at("09:40") }) },
      ),
    );
    const [row] = await t.db.select().from(truckFills).where(eq(truckFills.id, res.objectId!));
    expect(row!.geofenceMismatch).toBe(true);
    expect(row!.status).toBe("linked");
    expect(row!.volumeL).toBe(5_000);
  });

  it("US-M8-02 KP-5 operator hanya mencatat sumber yang ditugaskan (lingkup); pergantian antar sumber lewat lingkup; ponsel cadangan ditandai", async () => {
    const w = await productionWorld(t.db);
    const w2 = await productionWorld(t.db);
    const stranger = await createTestUser(t.db, { role: "production_operator", scope: { sourceIds: [w2.source.id] } });
    await t.db.update(users).set({ pinHash: await hash(SEED_DEMO_PIN), pinSetAt: new Date() }).where(eq(users.id, stranger.userId));
    // Ponsel sumber A menolak login operator yang tidak ditugaskan di sumber A (inti US-M10-01 KP-3).
    await expect(w.hp.login(stranger.userId, { now: w.at("05:10") })).rejects.toThrow(/tidak terdaftar untuk perangkat ini/);

    // Ponsel cadangan lapangan (BRD 10.5) dipasang di sumber A: siapa pun dapat masuk, tetapi layanan menolak di luar lingkup.
    const spareId = newId();
    await t.db.insert(devices).values({ id: spareId, tenantId: EQUA_TENANT_ID, deviceCode: `HP-CAD-U-${spareId.slice(-5)}`, name: "Ponsel cadangan uji", kind: "phone", status: "registered", isSpare: true, waterSourceId: w.source.id });
    const spare = await fieldDevice(spareId);
    const op = await spare.login(stranger.userId, { now: w.at("05:15") });
    const push = (fillId: string) =>
      spare.push([spare.command(op, "m8.truck_fill.create", { fillId, truckId: w.truck.id, tripId: null, volumeL: 5_000 }, { deviceTime: w.at("09:00") })], { now: w.at("09:01") });
    const denied = (await push(newId())).results[0]!;
    expect(denied.status).toBe("rejected");
    expect(denied.message).toMatch(/lingkup tugas/);
    const pull = await spare.pull(op, { keys: "m8.today" }, { now: w.at("09:10") });
    const data = pull.data["m8.today"] as { blockedReason: string | null; trucks: unknown[] };
    expect(data.blockedReason).toMatch(/tidak ditugaskan/);
    expect(data.trucks).toHaveLength(0);

    // Pergantian operator antar sumber: admin memberi lingkup sumber A → pencatatan diterima, bertanda perangkat cadangan.
    await t.db.insert(userScopes).values({ userId: stranger.userId, scopeType: "water_source", refId: w.source.id, status: "active", validFrom: "2025-01-01" });
    const ok = (await push(newId())).results[0]!;
    expect(ok.status).toBe("applied");
    const rows = await listFills(t.db, EQUA_TENANT_ID, { from: w.date, to: w.date, sourceId: w.source.id });
    expect(rows.find((r) => r.id === ok.objectId)?.deviceSpare).toBe(true);

    // Peran lain (sopir) tidak berizin mencatat pengisian (US-M10-03).
    const driver = await createTestUser(t.db, { role: "driver", scope: { truckIds: [w.truck.id] } });
    await t.db.update(users).set({ pinHash: await hash(SEED_DEMO_PIN), pinSetAt: new Date() }).where(eq(users.id, driver.userId));
    const sopir = await spare.login(driver.userId, { now: w.at("05:20") });
    const res = await spare.push([spare.command(sopir, "m8.truck_fill.create", { fillId: newId(), truckId: w.truck.id, tripId: null, volumeL: 5_000 }, { deviceTime: w.at("09:05") })], { now: w.at("09:06") });
    expect(res.results[0]!.status).toBe("rejected");
  });

  it("US-M8-02 KP-6 pengisian tersimpan tidak dapat diubah operator; koreksi Admin Keuangan lewat pembalik (volume negatif)", async () => {
    const w = await productionWorld(t.db);
    const trip = await w.addTrip();
    const fillId = newId();
    const res = await w.fill({ tripId: trip.id, fillId });
    // ID sama, isi beda (operator mencoba mengubah) → ditolak SOD-05.
    const change = await w.fill({ tripId: trip.id, fillId, volumeL: 4_000, volumeReason: "Ubah volume" });
    expect(change.status).toBe("rejected");
    expect(change.message).toMatch(/terkunci/);
    // Operator/dispatcher tidak dapat membalik.
    await expect(reverseTruckFill(w.operator.ctx, { fillId: res.objectId!, reason: "Pengisian ganda" })).rejects.toThrow();
    await expect(reverseTruckFill(dispatcher(), { fillId: res.objectId!, reason: "Pengisian ganda" })).rejects.toThrow();
    const { original, reversal } = await reverseTruckFill(finance(), { fillId: res.objectId!, reason: "Pengisian ganda dari perangkat cadangan" });
    expect(reversal).toMatchObject({ volumeL: -5_000, reversalOfId: original.id, businessDate: w.date });
    expect(original.reversedAt).toBeTruthy();
    expect(original.reversedById).toBe(reversal.id);
    await expect(reverseTruckFill(finance(), { fillId: res.objectId!, reason: "Balik lagi" })).rejects.toThrow(/sudah dibalik/);
    // Rit dapat diisi lagi setelah pengisian asal dibalik.
    expect((await w.fill({ tripId: trip.id, at: w.at("10:00") })).status).toBe("applied");
  });

  it("US-M8-02 KP-6 volume terkirim ke pelanggan (M3) < volume pengisian → selisih rit untuk neraca air", async () => {
    const w = await productionWorld(t.db);
    const trip = await w.addTrip();
    await w.fill({ tripId: trip.id });
    await t.db.update(trips).set({ status: "completed", deliveredVolumeL: 4_700, completedAt: w.at("10:30") }).where(eq(trips.id, trip.id));
    const rows = await listFills(t.db, EQUA_TENANT_ID, { from: w.date, to: w.date, sourceId: w.source.id });
    expect(rows[0]).toMatchObject({ volumeL: 5_000, deliveredVolumeL: 4_700 });
    const exp = await exportReport(owner(), "m8.truck_fills", "csv", { from: w.date, to: w.date, sourceId: w.source.id });
    const csv = exp.body.toString("utf8");
    expect(csv).toMatch(/Selisih rit/);
    expect(csv).toMatch(/300/);
  });

  it("US-M3-06 KP-2 air rit gagal 'kembali ke sumber' dikurangkan dari pengisian neraca", async () => {
    const w = await productionWorld(t.db);
    const trip = await w.addTrip();
    await w.fill({ tripId: trip.id });
    await w.reading("morning", 1_000_000);
    await w.reading("evening", 1_020_000);
    expect((await w.balance())?.filledTotalL).toBe(5_000);
    await t.db.update(trips).set({ status: "failed", failedAt: w.at("11:00"), loadedWaterDisposition: "returned_to_source" }).where(eq(trips.id, trip.id));
    await withTx((tx) =>
      emit(
        tx,
        "trip.failed",
        { tripId: trip.id, orderId: trip.orderId, customerId: w.customer.id, truckId: w.truck.id, reason: "customer_absent", consecutiveFailures: 1, loadedWaterDisposition: "returned_to_source" },
        { ctx: systemContext({ now: w.at("22:00") }) },
      ),
    );
    const bal = await w.balance();
    expect(bal).toMatchObject({ filledTotalL: 0, returnedL: 5_000, lossL: 20_000 });
    const rows = await t.db.select().from(truckFills).where(and(eq(truckFills.tripId, trip.id)));
    expect(rows).toHaveLength(1);
  });
});
