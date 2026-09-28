import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { deviceUsageLogs, domainEvents, gpsPositions, phoneTrackingFlags, tripPayments, trips } from "@/db/schema";
import { SEED_DEMO_PIN } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays, wibToUtc } from "@/lib/time";
import { OFFLINE_MESSAGE } from "@/client/offline/api";
import { SYNC_INTERVAL_MS } from "@/client/offline/sync";
import { blockDevice } from "@/server/core/auth";
import { withTx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { listPullProviders, listSyncHandlerTypes } from "@/server/core/sync";
import * as m3 from "@/server/modules/m3-driver";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { HERE, PHOTO, PRICE, SIGNATURE, completeCash, completePayload, departArrive, driverWorld, expectApplied, expectRejected, finance, notificationsFor, owner } from "./helpers";

describe("M3 — bekerja tanpa sinyal, sinkron & dicatat kantor (US-M3-09), keamanan perangkat (US-M3-10), GPS ponsel cadangan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M3-09 KP-1 data rit hari ini, koordinat & catatan, harga, faktur terbuka, template struk diunduh saat login; aksi dicatat luring sehari penuh lalu tersinkron (waktu perangkat & tanggal bisnis perangkat)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const today = await w.today();
    expect(today.trips[0]).toMatchObject({ id: a.id, lat: -6.82, lng: 107.14, price: PRICE });
    expect(today.receiptTemplates.trip_receipt).toBeTruthy();
    expect(today.invoicesByCustomer).toBeDefined();
    // Aksi dicatat pagi hari tanpa sinyal, dikirim sore — waktu transaksi = waktu perangkat.
    const morning = wibToUtc(w.date, "06:05");
    const noon = wibToUtc(w.date, "06:40");
    const depart = await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }, { deviceTime: morning, now: new Date(Math.max(Date.now(), noon.getTime())) });
    expectApplied(depart);
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row!.departedAt!.toISOString()).toBe(morning.toISOString());
    // Data kemarin yang baru terkirim hari ini tetap masuk tanggal bisnisnya dengan penanda "terlambat sinkron".
    const y = await driverWorld(t.db, { date: addDays(w.date, -1) });
    const b = await y.addTrip();
    const yesterday = wibToUtc(y.date, "10:00");
    expectApplied(await y.send(y.sopir, "m3.trip.depart", { tripId: b.id, location: HERE }, { deviceTime: yesterday, businessDate: y.date }));
    expectApplied(await y.send(y.sopir, "m3.trip.arrive", { tripId: b.id, location: HERE }, { deviceTime: new Date(yesterday.getTime() + 60_000), businessDate: y.date }));
    expectApplied(await y.send(y.sopir, "m3.trip.complete", completePayload(b.id), { attach: [PHOTO, SIGNATURE], deviceTime: new Date(yesterday.getTime() + 120_000), businessDate: y.date }));
    const [rb] = await t.db.select().from(trips).where(eq(trips.id, b.id));
    expect(rb).toMatchObject({ status: "completed", completionBusinessDate: y.date, lateSync: true });
    const [pay] = await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, b.id));
    expect(pay).toMatchObject({ businessDate: y.date, lateSync: true });
  });

  it("US-M3-09 KP-2 sinkron otomatis ≤ 5 menit (PAR-30), dapat dipicu manual; pengiriman ulang tidak menggandakan; tiap item berstatus", async () => {
    const rules = await withTx((tx) => params.get(tx, "PAR-30", "2026-09-28"));
    expect(SYNC_INTERVAL_MS).toBeLessThanOrEqual(rules.sync_max_minutes * 60_000);
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const cmd = w.hp.command(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE });
    const first = await w.hp.push([cmd]);
    const again = await w.hp.push([cmd]);
    expect(first.results[0]!.status).toBe("applied");
    expect(again.results[0]!.status).toBe("duplicate");
    const evs = await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, a.id), eq(domainEvents.type, "trip.departed")));
    expect(evs).toHaveLength(1);
    // Ketukan ganda offline (perintah berbeda) untuk aksi yang sama → idempoten, bukan data ganda.
    const tap2 = await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE });
    expectApplied(tap2);
    expect(tap2.result).toMatchObject({ duplicate: true });
  });

  it("US-M3-09 KP-3 Admin Keuangan tidak dapat menerima setoran sebelum seluruh transaksi hari itu dari perangkat tersinkron (\"menunggu sinkron\")", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const b = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    // Perangkat mencatat rit b Selesai luring tetapi perintahnya belum sampai; Setor sudah terkirim.
    expect(await m3.isDriverDayFullySynced(t.db, w.driver.userId, w.date)).toBe(false); // belum Setor
    expectApplied(await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: { completedTripIds: [a.id, b.id], failedTripIds: [], collectionIds: [], expenseIds: [] } }));
    const status = await m3.driverDaySyncStatus(t.db, w.driver.userId, w.date);
    expect(status).toMatchObject({ submitted: true, fullySynced: false });
    expect(status.missing.completedTripIds).toEqual([b.id]);
    expect(status.message).toMatch(/Menunggu sinkron/);
    // Laporan kesehatan perangkat setelah Setor: antrean pengguna 0, tetapi manifest belum lengkap → tetap menunggu.
    await t.db.update(trips).set({ status: "completed" }).where(eq(trips.id, b.id));
    expect(await m3.isDriverDayFullySynced(t.db, w.driver.userId, w.date)).toBe(true);
    await t.db.insert(deviceUsageLogs).values({ tenantId: w.truck.tenantId, deviceId: w.deviceId, event: "health_report", occurredAt: new Date(Date.now() + 1000), queueCount: 2, details: { queueByUser: { [w.driver.userId]: 2 } } });
    expect(await m3.isDriverDayFullySynced(t.db, w.driver.userId, w.date)).toBe(false);
  });

  it("US-M3-09 KP-4 pergantian pengguna (sopir ↔ kernet pengganti) di ponsel yang sama tidak menghapus antrean: perintah keduanya diterima dalam satu kiriman", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const expenseId = newId();
    const up = await w.hp.upload(w.kernet, { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), kind: "incident_photo" });
    void up;
    const res = await w.hp.push([
      w.hp.command(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }),
      w.hp.command(w.kernet, "m3.trip_incident.create", { incidentId: expenseId, tripId: a.id, kind: "road_blocked", description: "Jalan ditutup", location: null }),
    ]);
    expect(res.results[0]!.status).toBe("applied");
    // Kernet bukan pengganti → tindakan ditolak final (bukan hilang), antrean sopir tetap diterapkan.
    expect(res.results[1]!.status).toBe("rejected");
    expect(res.results[1]!.message).toMatch(/pengemudi pengganti/);
  });

  it("US-M3-09 KP-5 perangkat rusak/hilang: Admin Keuangan mencatat Selesai + pembayaran atas nama sopir berdasar bukti dengan alasan & penanda \"dicatat kantor\" (KPI-01) dan pemilik diberi tahu", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const b = await w.addTrip();
    await departArrive(w, a.id);
    // Ponsel hilang: Admin Keuangan mencatat.
    await expect(m3.officeCompleteTrip(seededContext("dispatcher1"), { tripId: a.id, reason: "Ponsel sopir jatuh ke sungai, bukti nota kertas", occurredTime: "09:30", recipientName: "Ibu Penerima", deliveredVolumeL: 5000, payment: { method: "cash", cashReceived: PRICE } })).rejects.toThrow();
    await expect(m3.officeCompleteTrip(finance(), { tripId: a.id, reason: "singkat", occurredTime: "09:30", recipientName: "Ibu", deliveredVolumeL: 5000, payment: { method: "cash", cashReceived: PRICE } })).rejects.toThrow(/Alasan/);
    const res = await m3.officeCompleteTrip(finance(), { tripId: a.id, reason: "Ponsel sopir jatuh ke sungai, bukti nota kertas No. 17", occurredTime: "09:30", recipientName: "Ibu Penerima", deliveredVolumeL: 5000, payment: { method: "cash", cashReceived: PRICE } });
    expect(res.driverName).toBeTruthy();
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row).toMatchObject({ status: "completed", recordedByOffice: true, driverUserId: w.driver.userId });
    expect(row!.officeRecordReason).toMatch(/Ponsel sopir jatuh/);
    const [pay] = await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, a.id));
    expect(pay).toMatchObject({ recordedByOffice: true, driverUserId: w.driver.userId, receivedAmount: PRICE });
    expect((await notificationsFor(t.db, "device.lost_queue", a.id)).length).toBeGreaterThan(0);
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, a.id), eq(domainEvents.type, "trip.completed"))))[0]!;
    expect(ev.payload).toMatchObject({ recordedByOffice: true, driverUserId: w.driver.userId });
    // Rit gagal atas nama sopir (belum sempat Berangkat di sistem).
    await m3.officeFailTrip(finance(), { tripId: b.id, reason: "Ponsel hilang; sopir melapor lewat telepon", occurredTime: "11:00", failReason: "customer_absent", loadedWaterDisposition: "carried_to_next" });
    // Laporan pemilik (KPI-01 tidak di sumber).
    const report = await m3.officeEntryReport(owner(), { from: w.date, to: w.date });
    expect(report.filter((r) => r.tripNumber === a.number || r.tripNumber === b.number)).toHaveLength(2);
    await expect(m3.officeEntryReport(seededContext("dispatcher1"))).rejects.toThrow();
    // Ponsel ternyata hidup kembali: data Selesai dari perangkat tidak menimpa, ditandai konflik.
    const late = await completeCash(w, a.id);
    expect(late.status).toBe("conflict");
    expect(await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, a.id))).toHaveLength(1);
    const board = await m3.officeEntryBoard(finance(), { date: w.date });
    expect(board.trips.find((x) => x.id === a.id)).toMatchObject({ recordedByOffice: true, syncConflict: true });
  });

  it("US-M3-10 KP-1 hanya perangkat terdaftar & PIN 6 digit per pengguna; 5 kali salah → terkunci; perangkat diblokir menolak semua data", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    for (let i = 0; i < 5; i++) await expect(w.hp.login(w.driver.userId, { pin: "000000" })).rejects.toThrow();
    await expect(w.hp.login(w.driver.userId, { pin: SEED_DEMO_PIN })).rejects.toThrow(/terkunci/);
    // Pengguna truk lain tidak terdaftar untuk perangkat ini.
    const other = await driverWorld(t.db);
    await expect(w.hp.login(other.driver.userId)).rejects.toThrow(/tidak terdaftar untuk perangkat ini/);
    await blockDevice(seededContext("admin1"), w.deviceId, "Ponsel hilang (uji)");
    await expect(w.hp.push([w.hp.command(w.kernet, "m3.trip.depart", { tripId: a.id, location: HERE })])).rejects.toThrow();
  });

  it("US-M3-10 KP-2 tidak ada ubah/hapus transaksi terkirim dari aplikasi: tidak ada perintah ubah/hapus m3.*, DB menolak DELETE; koreksi hanya Admin Keuangan", async () => {
    const types = listSyncHandlerTypes().filter((x) => x.startsWith("m3.") || x.startsWith("gps."));
    expect(types.length).toBeGreaterThanOrEqual(12);
    expect(types.filter((x) => /(^|\.)(update|delete|edit|correct|void)$/.test(x.split(".").pop() ?? ""))).toEqual([]);
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    await expect(t.db.delete(tripPayments).where(eq(tripPayments.tripId, a.id))).rejects.toThrow();
    await expect(t.db.update(tripPayments).set({ receivedAmount: 1 }).where(eq(tripPayments.tripId, a.id))).rejects.toThrow();
    const { can } = await import("@/server/core/rbac");
    expect(can(w.driver.ctx, "m3.trip.correct")).toBe(false);
    expect(can(finance(), "m3.trip.correct")).toBe(true);
  });

  it("US-M3-10 KP-3 panduan 1 halaman untuk sopir & kernet tersedia (pelatihan ≤ 2 jam diukur saat pilot)", () => {
    const guide = readFileSync("docs/guides/m3-driver.md", "utf8");
    const section = guide.split(/^## /m).find((s) => s.startsWith("Sopir & kernet"))!;
    expect(section).toBeTruthy();
    expect(section.split("\n").length).toBeLessThanOrEqual(70);
    expect(section).toMatch(/Berangkat/);
    expect(section).toMatch(/Setor/);
  });

  it("US-M3-10 KP-4 hemat kuota: data referensi tidak diunduh ulang bila tidak berubah; GPS ponsel hanya cadangan; foto dibatasi PAR-38", async () => {
    const w = await driverWorld(t.db);
    await w.addTrip();
    const first = await w.hp.pull(w.sopir, { keys: "m3.today" });
    expect(first.data["m3.today"]).toBeTruthy();
    const second = await w.hp.pull(w.sopir, { keys: "m3.today", since: first.cursor });
    expect(second.data["m3.today"]).toBeUndefined();
    const today = await w.today();
    expect(today.settings.maxPhotoKb).toBe(300);
    expect(today.gpsTracking.enabled).toBe(false);
  });

  it("US-M3-10 KP-5 perangkat hilang diblokir admin sistem; akun karyawan keluar tidak dapat mengirim data", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const { employees } = await import("@/db/schema");
    await t.db.update(employees).set({ exitDate: addDays(w.date, -1) }).where(eq(employees.id, w.driver.employeeId));
    const res = await w.hp.push([w.hp.command(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE })]);
    expect(res.results[0]!.status).toBe("rejected");
  });

  it("US-M3-10 KP-6 pesan kesalahan berbahasa Indonesia berisi tindakan, tanpa kode teknis", async () => {
    expect(OFFLINE_MESSAGE).toMatch(/Sinyal hilang — data tersimpan/);
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const r = await w.send(w.sopir, "m3.trip.complete", completePayload(a.id), { attach: [PHOTO] });
    expectRejected(r);
    expect(r.message).toMatch(/Tekan Berangkat/);
    expect(r.message).not.toMatch(/Error|undefined|null|SQL|TRIP_STATUS/);
  });

  it("US-M3-02 KP-5 GPS ponsel cadangan hanya bila pelacakan ponsel aktif untuk truk & rit aktif: posisi batch → gps_positions sumber phone (dedupe)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    expect((await w.today()).gpsTracking).toMatchObject({ enabled: false, intervalS: 60 });
    await t.db.insert(phoneTrackingFlags).values({ truckId: w.truck.id, reason: "device_dead", startedAt: new Date() });
    const view = await w.today();
    expect(view.gpsTracking).toMatchObject({ enabled: true, truckId: w.truck.id, intervalS: 60 });
    await departArrive(w, a.id);
    const base = Date.now() - 180_000;
    const positions = [0, 60_000, 120_000].map((d) => ({ deviceTime: new Date(base + d).toISOString(), lat: -6.82 + d / 1e9, lng: 107.14, accuracyM: 15, tripId: a.id }));
    const res = await w.send(w.sopir, "gps.phone_positions", { truckId: w.truck.id, positions });
    expectApplied(res);
    expect(res.result).toMatchObject({ inserted: 3, received: 3 });
    const again = await w.send(w.sopir, "gps.phone_positions", { truckId: w.truck.id, positions });
    expect(again.result).toMatchObject({ inserted: 0 });
    const rows = await t.db.select().from(gpsPositions).where(eq(gpsPositions.truckId, w.truck.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === "phone" && r.tripId === a.id)).toBe(true);
    // Truk lain ditolak.
    const other = await driverWorld(t.db);
    expectRejected(await w.send(w.sopir, "gps.phone_positions", { truckId: other.truck.id, positions }), /truk yang dikemudikan/);
  });

  it("registrasi M3: perintah sinkron, penyedia pull, persetujuan, job & laporan terdaftar", async () => {
    const types = listSyncHandlerTypes();
    for (const x of ["m3.trip.depart", "m3.trip.arrive", "m3.trip.complete", "m3.trip.fail", "m3.field_credit.request", "m3.collection.create", "m3.trip_incident.create", "m3.travel_explanation.create", "m3.trip_expense.create", "m3.deposit.submit", "m3.deposit.note", "m3.receipt.record", "gps.phone_positions"]) {
      expect(types).toContain(x);
    }
    expect(listPullProviders().map(([k]) => k)).toEqual(expect.arrayContaining(["m3.today", "m3.deposits"]));
    const { getApprovalHandlers } = await import("@/server/core/approvals");
    expect(getApprovalHandlers("field_payment_to_credit", "trip")?.onExpired).toBeTypeOf("function");
    const { listJobs } = await import("@/server/core/jobs");
    expect(listJobs().map((j) => j.key)).toEqual(expect.arrayContaining(["m3.deposit.reminder", "m3.travel_explanation.missing"]));
    const { listReports } = await import("@/server/core/export");
    expect(listReports().map((r) => r.key)).toEqual(expect.arrayContaining(["m3.trips", "m3.trip_payments", "m3.collections", "m3.expenses", "m3.driver_deposits", "m3.office_entries", "m3.incidents"]));
  });
});
