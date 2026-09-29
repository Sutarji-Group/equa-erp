import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { attachments, crewAssignments, deposits, domainEvents, fleetEvents, orders, outlets, scheduleChangeLogs, trips, tripStatusEvents } from "@/db/schema";
import { outletId } from "@/db/seed";
import { addDays } from "@/lib/time";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createDeposit } from "../helpers/fixtures";
import {
  HERE,
  PHOTO,
  PRICE,
  SIGNATURE,
  completeCash,
  completePayload,
  departArrive,
  driverWorld,
  expectApplied,
  expectRejected,
  north,
  notificationsFor,
} from "./helpers";

describe("M3 — daftar rit, Berangkat/Tiba, Selesai (US-M3-01..03)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M3-01 KP-1 KP-2 daftar rit hari ini truk yang dikemudikan: urutan, nomor rit, pelanggan, alamat singkat, volume, jam, cara bayar, catatan, status, harga pesanan (satu-satunya harga), kontak", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip({ routeOrder: 1 });
    const b = await w.addTrip({ routeOrder: 2, paymentMethod: "credit" });
    await t.db.update(orders).set({ notes: "Masuk lewat gerbang belakang", requestedTime: "08:30:00" }).where(eq(orders.id, b.orderId));
    // Rit truk lain & rit belum terbit tidak tampil.
    const other = await driverWorld(t.db);
    await other.addTrip();
    const draft = await w.addTrip({ routeOrder: 3 });
    await t.db.update(trips).set({ publishedAt: null }).where(eq(trips.id, draft.id));

    const today = await w.today();
    expect(today.actingRole).toBe("driver");
    expect(today.trips.map((x) => x.id)).toEqual([a.id, b.id]);
    const tb = today.trips[1]!;
    expect(tb).toMatchObject({ number: b.number, routeOrder: 2, status: "assigned", price: PRICE, paymentMethod: "credit", plannedVolumeL: 5000, requestedTime: "08:30", hasSpecialNotes: true, orderNotes: "Masuk lewat gerbang belakang" });
    expect(tb.customerName).toBeTruthy();
    expect(tb.addressShort.length).toBeGreaterThan(3);
    expect(tb.customerPhone).toMatch(/^62/);
    expect(tb.contactName).toBe("Ibu Penerima");
    // BR-19: satu-satunya harga yang terlihat = harga pesanan (tidak ada tarif/harga master di data perangkat).
    expect(JSON.stringify(today)).not.toMatch(/zoneTariff|fuelComponent|unitPrice/);
    expect(today.settings.standardVolumeL).toBe(5000);
  });

  it("US-M3-01 KP-1 rit berikutnya ditonjolkan (rit berjalan di atas); rit Selesai/Gagal turun ke bawah", async () => {
    const { nextTrip, sortTripsForDriver } = await import("@/client/m3-driver/contract");
    const w = await driverWorld(t.db);
    const a = await w.addTrip({ routeOrder: 1 });
    const b = await w.addTrip({ routeOrder: 2 });
    const c = await w.addTrip({ routeOrder: 3 });
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: c.id, location: HERE, outOfOrderConfirmed: true }));
    const today = await w.today();
    const sorted = sortTripsForDriver(today.trips).map((x) => x.id);
    expect(sorted).toEqual([c.id, b.id, a.id]);
    expect(nextTrip(today.trips)?.id).toBe(c.id);
  });

  it("US-M3-01 KP-2 detail: penanda rit internal pasokan depot (PTB-01) dan faktur terbuka pelanggan", async () => {
    const w = await driverWorld(t.db);
    const i = await w.addTrip({ isInternal: true, destinationOutletId: outletId("D05"), paymentMethod: "internal" });
    const today = await w.today();
    const trip = today.trips.find((x) => x.id === i.id)!;
    expect(trip.isInternal).toBe(true);
    expect(trip.destinationOutletName).toBeTruthy();
  });

  it("US-M3-01 KP-3 navigasi: koordinat alamat bila ada; tanpa koordinat → teks alamat", async () => {
    const { navigationUrl } = await import("@/client/m3-driver/contract");
    expect(navigationUrl({ lat: -6.8, lng: 107.1, addressText: "Jl. A" })).toBe("geo:-6.8,107.1?q=-6.8,107.1");
    expect(navigationUrl({ lat: null, lng: null, addressText: "Jl. Raya Cianjur No. 1" })).toBe("geo:0,0?q=Jl.%20Raya%20Cianjur%20No.%201");
    expect(navigationUrl({ lat: -6.8, lng: 107.1, addressText: "x" }, "other")).toContain("google.com/maps/dir");
    const w = await driverWorld(t.db, { lockedAddress: false });
    await w.addTrip();
    const today = await w.today();
    expect(today.trips[0]!.coordinateLocked).toBe(false);
  });

  it("US-M3-01 KP-4 pembaruan jadwal setelah terbit tampil dengan penanda \"diperbarui\" + ringkasan; rit ditarik tampil di daftar perubahan; rit Berangkat tidak berubah", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip({ routeOrder: 1 });
    const b = await w.addTrip({ routeOrder: 2 });
    const c = await w.addTrip({ routeOrder: 3 });
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }));
    const now = new Date();
    await t.db.insert(scheduleChangeLogs).values([
      { tenantId: w.truck.tenantId, tripId: b.id, changeType: "reordered", before: { routeOrder: 2 }, after: { routeOrder: 3 }, afterPublish: true, changedAt: now },
      { tenantId: w.truck.tenantId, tripId: a.id, changeType: "reordered", before: { routeOrder: 1 }, after: { routeOrder: 2 }, afterPublish: true, changedAt: now },
      { tenantId: w.truck.tenantId, tripId: c.id, changeType: "withdrawn", afterPublish: true, reason: "Pelanggan menunda", changedAt: now },
    ]);
    await t.db.update(trips).set({ withdrawnAt: now }).where(eq(trips.id, c.id));
    const today = await w.today();
    expect(today.trips.find((x) => x.id === b.id)!.update?.summary[0]).toMatch(/Urutan rit diubah \(urutan 2 → 3\)/);
    expect(today.trips.find((x) => x.id === a.id)!.update).toBeNull();
    expect(today.trips.some((x) => x.id === c.id)).toBe(false);
    expect(today.withdrawn.map((x) => x.tripId)).toContain(c.id);
  });

  it("US-M3-01 KP-5 setoran kemarin belum Ditutup → daftar tampil tetapi Berangkat terkunci dengan pesan + hubungi Admin Keuangan; terbuka otomatis setelah Ditutup", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const dep = await createDeposit(t.db, { date: addDays(w.date, -1), status: "received", depositorUserId: w.driver.userId, depositorEmployeeId: w.driver.employeeId });
    const today = await w.today();
    expect(today.trips).toHaveLength(1);
    expect(today.lock?.kind).toBe("br10");
    expect(today.lock?.message).toMatch(/Setoran kemarin belum ditutup Admin Keuangan/);
    expect(today.financeContacts.length).toBeGreaterThan(0);
    expectRejected(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }), /Setoran kemarin belum ditutup/);
    await t.db.update(deposits).set({ status: "closed", closedAt: new Date(), updatedAt: new Date() }).where(eq(deposits.id, dep.id));
    expect((await w.today()).lock).toBeNull();
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }));
  });

  it("US-M3-01 KP-6 kernet bukan pengganti membaca daftar yang sama tanpa tindakan; kernet pengganti bertindak dan tercatat atas namanya", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const view = await w.today(w.kernet);
    expect(view.actingRole).toBe("readonly");
    expect(view.readOnlyReason).toMatch(/kernet/i);
    expect(view.trips.map((x) => x.id)).toEqual([a.id]);
    expectRejected(await w.send(w.kernet, "m3.trip.depart", { tripId: a.id, location: HERE }), /pengemudi pengganti/);
    // Dispatcher menetapkan kernet sebagai pengemudi pengganti hari ini.
    await t.db.update(crewAssignments).set({ supersededAt: new Date() }).where(and(eq(crewAssignments.truckId, w.truck.id), eq(crewAssignments.businessDate, w.date)));
    await t.db.insert(crewAssignments).values({ tenantId: w.truck.tenantId, truckId: w.truck.id, businessDate: w.date, driverEmployeeId: w.helper.employeeId, source: "helper", reason: "Sopir sakit" });
    const kernet = await w.hp.login(w.helper.userId);
    expect((await w.today(kernet)).actingRole).toBe("substitute");
    await departArrive(w, a.id, kernet);
    expectApplied(await completeCash(w, a.id, kernet));
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row!.driverUserId).toBe(w.helper.userId);
    // Sopir yang digantikan kini hanya membaca.
    const sopir = await w.hp.login(w.driver.userId);
    expect((await w.today(sopir)).actingRole).toBe("readonly");
  });

  it("US-M3-02 KP-1 Berangkat & Tiba satu ketukan: waktu perangkat, GPS & akurasi; satu rit aktif per truk", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip({ routeOrder: 1 });
    const b = await w.addTrip({ routeOrder: 2 });
    const deviceTime = new Date(Date.now() - 60_000);
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: { lat: -6.83, lng: 107.15, accuracyM: 12 } }, { deviceTime }));
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row).toMatchObject({ status: "departed", departedLat: -6.83, departedLng: 107.15, departedAccuracyM: 12, driverUserId: w.driver.userId });
    expect(row!.departedAt!.toISOString()).toBe(deviceTime.toISOString());
    expectRejected(await w.send(w.sopir, "m3.trip.depart", { tripId: b.id, location: HERE }), /masih berjalan/);
    expectApplied(await w.send(w.sopir, "m3.trip.arrive", { tripId: a.id, location: HERE }));
    const events = await t.db.select().from(tripStatusEvents).where(eq(tripStatusEvents.tripId, a.id));
    expect(events.map((e) => e.status).sort()).toEqual(["arrived", "departed"]);
    const emitted = await t.db.select().from(domainEvents).where(eq(domainEvents.objectId, a.id));
    expect(emitted.map((e) => e.type)).toEqual(expect.arrayContaining(["trip.departed", "trip.arrived"]));
  });

  it("US-M3-02 KP-2 rit di luar urutan boleh dengan konfirmasi; urutan aktual tercatat untuk Dispatcher", async () => {
    const w = await driverWorld(t.db);
    await w.addTrip({ routeOrder: 1 });
    const b = await w.addTrip({ routeOrder: 2 });
    const res = await w.send(w.sopir, "m3.trip.depart", { tripId: b.id, location: HERE, outOfOrderConfirmed: true });
    expectApplied(res);
    expect(res.result).toMatchObject({ actualOrder: 1, outOfOrder: true });
    const [row] = await t.db.select().from(trips).where(eq(trips.id, b.id));
    expect(row!.actualOrder).toBe(1);
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, b.id), eq(domainEvents.type, "trip.departed"))))[0]!;
    expect(ev.payload).toMatchObject({ outOfOrder: true, actualOrder: 1, plannedOrder: 2 });
  });

  it("US-M3-02 KP-3 Tiba menghitung jarak posisi ke koordinat alamat", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }));
    const res = await w.send(w.sopir, "m3.trip.arrive", { tripId: a.id, location: north(150) });
    const d = (res.result as { distanceToAddressM: number }).distanceToAddressM;
    expect(d).toBeGreaterThanOrEqual(148);
    expect(d).toBeLessThanOrEqual(152);
    const { distanceToAddressM } = await import("@/client/m3-driver/contract");
    expect(distanceToAddressM(north(150), { lat: -6.82, lng: 107.14 })).toBe(d);
  });

  it("US-M3-02 KP-4 tanpa lokasi: status tetap tercatat dengan penanda \"tanpa lokasi\" (anomali untuk M12 lewat event)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: null }));
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row).toMatchObject({ status: "departed", noLocation: true, departedLat: null });
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, a.id), eq(domainEvents.type, "trip.departed"))))[0]!;
    expect(ev.payload).toMatchObject({ noLocation: true, lat: null });
  });

  it("US-M3-02 KP-6 rit internal pasokan depot memakai tombol yang sama (Berangkat/Tiba/Selesai tanpa pembayaran)", async () => {
    const w = await driverWorld(t.db);
    const i = await w.addTrip({ isInternal: true, destinationOutletId: outletId("D05"), paymentMethod: "internal" });
    await departArrive(w, i.id);
    const res = await w.send(w.sopir, "m3.trip.complete", { tripId: i.id, recipientName: null, deliveredVolumeL: 5000, location: HERE, payment: { method: "none" } }, { attach: [PHOTO] });
    expectApplied(res);
  });

  it("US-M3-03 KP-1 Selesai wajib foto dari kamera aplikasi & nama penerima; tanda tangan hanya dapat dilewati dengan alasan", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectRejected(await w.send(w.sopir, "m3.trip.complete", completePayload(a.id), { attach: [SIGNATURE] }), /Foto bukti kirim wajib/);
    expectRejected(await w.send(w.sopir, "m3.trip.complete", completePayload(a.id, { recipientName: "" }), { attach: [PHOTO, SIGNATURE] }), /Nama penerima wajib/);
    expectRejected(await w.send(w.sopir, "m3.trip.complete", completePayload(a.id), { attach: [PHOTO] }), /tanda tangan/);
    const ok = await w.send(w.sopir, "m3.trip.complete", completePayload(a.id, { signatureSkipReason: "recipient_refused" }), { attach: [PHOTO] });
    expectApplied(ok);
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row).toMatchObject({ status: "completed", recipientName: "Ibu Penerima", signatureSkippedReason: "recipient_refused", deliveredVolumeL: 5000 });
    const photos = await t.db.select().from(attachments).where(and(eq(attachments.objectType, "trip"), eq(attachments.objectId, a.id)));
    expect(photos.map((p) => p.kind)).toEqual(["delivery_photo"]);
  });

  it("US-M3-03 KP-2 volume ≠ PAR-15 wajib alasan dari daftar; rit bertanda volume parsial ke Dispatcher & Admin Keuangan; harga tetap harga pesanan", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectRejected(await completeCash(w, a.id, w.sopir, { deliveredVolumeL: 4200 }), /pilih alasan/);
    const res = await completeCash(w, a.id, w.sopir, { deliveredVolumeL: 4200, partialVolumeReason: "customer_tank_full" });
    expectApplied(res);
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row).toMatchObject({ deliveredVolumeL: 4200, partialVolumeReason: "customer_tank_full", price: PRICE });
    const notes = await notificationsFor(t.db, "trip.partial_volume", a.id);
    expect(notes.length).toBeGreaterThanOrEqual(2); // Dispatcher & Admin Keuangan
  });

  it("US-M3-03 KP-3 jarak Selesai > 200 m alasan wajib; > 1 km alasan + tinjauan pemilik; server menghitung ulang (hasil server berlaku)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const b = await w.addTrip();
    const c = await w.addTrip();
    await departArrive(w, a.id);
    expectRejected(await completeCash(w, a.id, w.sopir, { location: north(350), clientDistanceM: 350 }), /pilih alasan/);
    expectApplied(await completeCash(w, a.id, w.sopir, { location: north(350), clientDistanceM: 350, locationReason: "customer_other_point" }));
    const [ra] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(ra).toMatchObject({ locationDeviation: "level1", locationReason: "customer_other_point", ownerReviewRequired: false });
    expect(ra!.completionDistanceM).toBeGreaterThan(340);

    await departArrive(w, b.id);
    expectApplied(await completeCash(w, b.id, w.sopir, { location: north(1500), clientDistanceM: 1500, locationReason: "gps_inaccurate" }));
    const [rb] = await t.db.select().from(trips).where(eq(trips.id, b.id));
    expect(rb).toMatchObject({ locationDeviation: "level2", ownerReviewRequired: true });
    expect((await notificationsFor(t.db, "trip.location_deviation", b.id)).length).toBeGreaterThan(0);

    // Perangkat menghitung ≤ 200 m (koordinat lama di ponsel) tetapi server > 200 m → hasil server berlaku, tidak ditolak.
    await departArrive(w, c.id);
    expectApplied(await completeCash(w, c.id, w.sopir, { location: north(400), clientDistanceM: 50 }));
    const [rc] = await t.db.select().from(trips).where(eq(trips.id, c.id));
    expect(rc).toMatchObject({ locationDeviation: "level1", completionDistanceClientM: 50 });
  });

  it("US-M3-03 KP-4 alamat belum dikunci: tanpa pembandingan; lokasi Selesai diusulkan sebagai koordinat alamat (M1)", async () => {
    const w = await driverWorld(t.db, { lockedAddress: false });
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id, w.sopir, { location: north(3000), clientDistanceM: null }));
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row).toMatchObject({ locationDeviation: "none", completionDistanceM: null });
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, a.id), eq(domainEvents.type, "trip.completed"))))[0]!;
    expect(ev.payload).toMatchObject({ addressCoordinateLocked: false });
    expect((await notificationsFor(t.db, "address.coordinate_proposed")).length).toBeGreaterThan(0);
  });

  it("US-M3-03 KP-5 rit internal: bukti = volume diserahkan + foto; event trip.completed berisi isInternal, destinationOutletId, volumeL, completedAt (pasokan \"Tiba\" M6)", async () => {
    const w = await driverWorld(t.db);
    const i = await w.addTrip({ isInternal: true, destinationOutletId: outletId("D05"), paymentMethod: "internal" });
    await departArrive(w, i.id);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", { tripId: i.id, recipientName: null, deliveredVolumeL: 4800, partialVolumeReason: "leakage", location: HERE, payment: { method: "none" } }, { attach: [PHOTO] }));
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, i.id), eq(domainEvents.type, "trip.completed"))))[0]!;
    expect(ev.payload).toMatchObject({ isInternal: true, destinationOutletId: outletId("D05"), volumeL: 4800, cashReceived: 0 });
    expect((ev.payload as { completedAt: string }).completedAt).toBeTruthy();
    const { waterSupplyReceipts } = await import("@/db/schema");
    const supply = await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, i.id));
    expect(supply[0]).toMatchObject({ status: "arrived", deliveredVolumeL: 4800 });
  });

  it("US-M3-03 KP-6 setelah Selesai terkunci: waktu Selesai = waktu perangkat, waktu sinkron terpisah; kirim ulang tidak menggandakan", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    const deviceTime = new Date(Date.now() - 5 * 60_000);
    const cmdId = (await import("@/lib/ids")).newId();
    const first = await w.send(w.sopir, "m3.trip.complete", completePayload(a.id), { attach: [PHOTO, SIGNATURE], deviceTime, id: cmdId });
    expectApplied(first);
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row!.completedAt!.toISOString()).toBe(deviceTime.toISOString());
    expect(row!.syncedAt!.getTime()).toBeGreaterThan(deviceTime.getTime());
    // Pengiriman ulang perintah yang sama → duplicate (tanpa efek ganda).
    const again = await w.hp.push([w.hp.command(w.sopir, "m3.trip.complete", completePayload(a.id), { id: cmdId, deviceTime, attachmentIds: [], attachmentHashes: [] })]);
    expect(again.results[0]!.status).toBe("duplicate");
    // Perintah Selesai BARU untuk rit yang sudah Selesai → konflik, pembayaran tidak digandakan (tidak ada ubah/hapus).
    const second = await completeCash(w, a.id, w.sopir, { payment: { method: "cash", cashReceived: 100_000, underpaymentReasonCode: "customer_short" } });
    expect(second.status).toBe("conflict");
    const { tripPayments } = await import("@/db/schema");
    expect(await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, a.id))).toHaveLength(1);
  });

  it("US-M3-03 KP-1 US-M3-10 KP-2 tidak ada Berangkat ulang / perubahan setelah terkirim: Berangkat untuk rit Selesai ditolak", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    expectRejected(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }), /sudah berstatus Selesai/);
  });
});

describe("B-48 rit internal: tingkat penyimpangan lokasi Selesai M3 = M12 (acuan depot tujuan)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-48 US-M12-04 KP-5 US-M3-03 KP-4 rit internal diukur ke koordinat depot tujuan (bukan alamat pesanan); tingkat M3 sama dengan kejadian M12; pull memakai titik depot", async () => {
    const w = await driverWorld(t.db);
    const [depot] = await t.db.select({ lat: outlets.lat, lng: outlets.lng }).from(outlets).where(eq(outlets.id, outletId("D05")));
    const atDepot = { lat: depot!.lat!, lng: depot!.lng!, accuracyM: 8 };
    const far = { lat: depot!.lat! + 1_500 / 111_320, lng: depot!.lng!, accuracyM: 8 };

    const near = await w.addTrip({ isInternal: true, destinationOutletId: outletId("D05"), paymentMethod: "internal" });
    const ref = (await w.today()).trips.find((x) => x.id === near.id)!;
    expect(ref).toMatchObject({ lat: depot!.lat, lng: depot!.lng, coordinateLocked: true });
    await departArrive(w, near.id);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", { tripId: near.id, recipientName: null, deliveredVolumeL: 5000, location: atDepot, clientDistanceM: 0, payment: { method: "none" } }, { attach: [PHOTO] }));
    const [okRow] = await t.db.select().from(trips).where(eq(trips.id, near.id));
    expect(okRow).toMatchObject({ locationDeviation: "none", completionDistanceM: 0 });

    const away = await w.addTrip({ isInternal: true, destinationOutletId: outletId("D05"), paymentMethod: "internal" });
    await departArrive(w, away.id);
    // Perangkat menghitung jarak ke depot (> 1 km) → alasan wajib, sama dengan server.
    expectRejected(await w.send(w.sopir, "m3.trip.complete", { tripId: away.id, recipientName: null, deliveredVolumeL: 5000, location: far, clientDistanceM: 1_500, payment: { method: "none" } }, { attach: [PHOTO] }), /pilih alasan/);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", { tripId: away.id, recipientName: null, deliveredVolumeL: 5000, location: far, clientDistanceM: 1_500, locationReason: "gps_inaccurate", payment: { method: "none" } }, { attach: [PHOTO] }));
    const [row] = await t.db.select().from(trips).where(eq(trips.id, away.id));
    expect(row!.locationDeviation).toBe("level2");
    expect(row!.completionDistanceM).toBeGreaterThan(1_400);
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, away.id), eq(domainEvents.type, "trip.completed"))))[0]!;
    expect(ev.payload).toMatchObject({ isInternal: true, locationDeviation: "level2", distanceToAddressM: row!.completionDistanceM });
    // M12 menghitung ulang terhadap depot yang sama → tingkat 2, jarak sama dengan M3.
    const [fleet] = await t.db.select().from(fleetEvents).where(and(eq(fleetEvents.tripId, away.id), eq(fleetEvents.kind, "location_deviation_l2")));
    expect(fleet?.distanceM).toBe(row!.completionDistanceM);
    expect((fleet?.details as { targetKind?: string } | undefined)?.targetKind).toBe("depot");
  });
});
