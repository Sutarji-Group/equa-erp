/**
 * M3 — perbaikan S5-B (audit PRD/keamanan): setoran lintas tengah malam (US-M3-07 KP-5, BR-10), Setor per pengguna
 * setelah pengemudi diganti (US-M2-11 KP-3), pelaksana dinilai pada waktu perangkat (Bab 6.4 butir 3), transaksi kas
 * setelah Setor (BR-07), rit ditarik truk lain (US-M10-03 KP-1), rit yang dikeluarkan dari truk (US-M3-01 KP-4),
 * "dicatat kantor" pelunasan & Setor (US-M3-09 KP-5), struk WA, tempo pelanggan Tunai, Tiba tidak direka.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { crewAssignments, customerPayments, deposits, invoices, notifications, trips, tripExpenses, tripPayments } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate, wibToUtc } from "@/lib/time";
import * as m2 from "@/server/modules/m2-orders";
import * as m3 from "@/server/modules/m3-driver";
import * as m4 from "@/server/modules/m4-cash";

import { receiptOutstanding } from "@/client/m3-driver/contract";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createDeposit } from "../helpers/fixtures";
import { HERE, PHOTO, PRICE, SIGNATURE, completeCash, completePayload, departArrive, dispatcher, driverWorld, expectApplied, expectRejected, finance, type World } from "./helpers";

const manifest = () => ({ completedTripIds: [], failedTripIds: [], collectionIds: [], expenseIds: [] });

async function depositOn(w: World, userId: string, date: string) {
  return (await w.db.select().from(deposits).where(and(eq(deposits.depositorUserId, userId), eq(deposits.businessDate, date))))[0] ?? null;
}

/** Rit Selesai tunai pada waktu perangkat tertentu (Berangkat → Tiba → Selesai). */
async function cashTripAt(w: World, tripId: string, date: string, times: [string, string, string], over: Record<string, unknown> = {}) {
  const [d, a, c] = times.map((t) => wibToUtc(date, t)) as [Date, Date, Date];
  const at = (x: Date) => ({ deviceTime: x, businessDate: toBusinessDate(x) });
  expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId, location: HERE }, at(d)));
  expectApplied(await w.send(w.sopir, "m3.trip.arrive", { tripId, location: HERE, clientDistanceM: 0 }, at(a)));
  return w.send(w.sopir, "m3.trip.complete", completePayload(tripId, over), { attach: [PHOTO, SIGNATURE], ...at(c) });
}

describe("M3 — setoran lintas tengah malam & kepemilikan kas (perbaikan S5-B)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M3-07 KP-5 BR-10 setoran kemarin yang belum diajukan: Setor pagi ini mengajukannya (terlambat) tanpa mengunci hari ini; Admin Keuangan menutup → Berangkat terbuka", async () => {
    const today = toBusinessDate(new Date());
    const yesterday = addDays(today, -1);
    const w = await driverWorld(t.db, { date: yesterday });
    const a = await w.addTrip();
    expectApplied(await cashTripAt(w, a.id, yesterday, ["15:00", "15:20", "15:40"]));
    const stale = (await depositOn(w, w.driver.userId, yesterday))!;
    expect(stale.status).toBe("running");
    // Pagi ini: kunci BR-10 menyuruh mengajukan setoran kemarin; setoran tertinggal tampil di menu Setor.
    let pull = await w.today();
    expect(pull.lock?.kind).toBe("br10");
    expect(pull.lock?.message).toMatch(/belum diajukan/);
    expect(pull.pendingDeposits).toEqual([expect.objectContaining({ id: stale.id, businessDate: yesterday, expectedNet: PRICE })]);
    // Klien lama menekan Setor (tanpa depositDate) → setoran kemarin diajukan terlambat; tidak ada setoran kosong hari ini.
    const res = await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest() });
    expectApplied(res);
    expect(res.result).toMatchObject({ number: stale.number, expectedNet: PRICE, late: true });
    expect(await depositOn(w, w.driver.userId, yesterday)).toMatchObject({ status: "submitted", submittedLate: true, expectedNet: PRICE });
    expect(await depositOn(w, w.driver.userId, today)).toBeNull();
    // M4 menerima & menutup → kunci lepas.
    const rec = await m4.receiveDeposit(finance(), { depositId: stale.id, receivedAmount: PRICE, lateReason: "Sopir lupa Setor kemarin malam" });
    expect(rec.deposit.status).toBe("closed");
    pull = await w.today();
    expect(pull.lock).toBeNull();
    expect(pull.pendingDeposits).toEqual([]);
  });

  it("US-M3-07 KP-5 rit lewat tengah malam: setoran kemarin diajukan eksplisit (depositDate) → tunai rit 00.15 tetap di setoran hari ini yang berjalan", async () => {
    const today = toBusinessDate(new Date());
    const yesterday = addDays(today, -1);
    const w = await driverWorld(t.db, { date: yesterday });
    const a = await w.addTrip();
    const b = await w.addTrip();
    expectApplied(await cashTripAt(w, a.id, yesterday, ["15:00", "15:20", "15:40"]));
    // Rit b berangkat 23.30 kemarin, Selesai 00.15 hari ini (tanggal perangkat).
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: b.id, location: HERE }, { deviceTime: wibToUtc(yesterday, "23:30"), businessDate: yesterday }));
    expectApplied(await w.send(w.sopir, "m3.trip.arrive", { tripId: b.id, location: HERE }, { deviceTime: wibToUtc(yesterday, "23:50"), businessDate: yesterday }));
    const at = wibToUtc(today, "00:15");
    expectApplied(await w.send(w.sopir, "m3.trip.complete", completePayload(b.id), { attach: [PHOTO, SIGNATURE], deviceTime: at, businessDate: today }));
    const res = await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest(), depositDate: yesterday, deviceExpectedNet: PRICE }, { deviceTime: new Date(at.getTime() + 5 * 60_000), businessDate: today });
    expectApplied(res);
    expect(await depositOn(w, w.driver.userId, yesterday)).toMatchObject({ status: "submitted", submittedLate: true, expectedNet: PRICE });
    const running = (await depositOn(w, w.driver.userId, today))!;
    expect(running).toMatchObject({ status: "running" });
    const pay = (await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, b.id)))[0]!;
    expect(pay).toMatchObject({ businessDate: today, depositId: running.id });
    // Pengajuan ulang tanggal yang sama ditolak (sudah Diajukan).
    expectRejected(await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest(), depositDate: yesterday }), /sudah diajukan/);
  });

  it("US-M2-11 KP-3 setoran dipisah per pengguna: sopir yang digantikan tetap Setor kas yang diterimanya; kernet pengganti Setor kasnya sendiri", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip({ routeOrder: 1 });
    const b = await w.addTrip({ routeOrder: 2 });
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    await m2.setDailyDriver(dispatcher(), { truckId: w.truck.id, date: w.date, employeeId: w.helper.employeeId, reason: "Sopir sakit siang hari" });
    // Kernet pengganti mengerjakan rit berikutnya.
    await departArrive(w, b.id, w.kernet);
    expectApplied(await completeCash(w, b.id, w.kernet));
    // Sopir yang digantikan: kas di tangan & Setor tetap miliknya.
    expect((await m3.cashOnHand(w.driver.ctx, { date: w.date })).cashOnHand).toBe(PRICE);
    expectApplied(await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest() }));
    expect(await depositOn(w, w.driver.userId, w.date)).toMatchObject({ status: "submitted", expectedNet: PRICE });
    expectApplied(await w.send(w.kernet, "m3.deposit.submit", { method: "physical", manifest: manifest() }));
    expect(await depositOn(w, w.helper.userId, w.date)).toMatchObject({ status: "submitted", expectedNet: PRICE });
    // Kernet yang dikembalikan menjadi kernet tetap dapat mengirim keterangan setoran miliknya (izin bersyarat pemegang kas).
    await m2.setDailyDriver(dispatcher(), { truckId: w.truck.id, date: w.date, employeeId: w.driver.employeeId, reason: "Sopir kembali bertugas" });
    const kernetDep = (await depositOn(w, w.helper.userId, w.date))!;
    await t.db.update(deposits).set({ status: "received", receivedAmount: PRICE - 5_000, discrepancyAmount: -5_000, updatedAt: new Date() }).where(eq(deposits.id, kernetDep.id));
    expectApplied(await w.send(w.kernet, "m3.deposit.note", { depositId: kernetDep.id, note: "Kembalian pelanggan kurang" }));
  });

  it("Bab 6.4 butir 3 US-M2-11 KP-3 tindakan yang dicatat di ponsel SEBELUM pengemudi diganti tetap diterima (konflik untuk ditinjau), bukan ditolak", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip({ routeOrder: 1 });
    const b = await w.addTrip({ routeOrder: 2 });
    // Penetapan pengemudi dibuat pagi hari (sebelum tindakan di ponsel).
    await t.db.update(crewAssignments).set({ createdAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(crewAssignments.truckId, w.truck.id));
    await departArrive(w, a.id);
    const offlineComplete = new Date(Date.now() - 20 * 60_000);
    const offlineDepart = new Date(Date.now() - 10 * 60_000);
    // Kantor mengganti pengemudi SETELAH tindakan tercatat di ponsel, sebelum data tersinkron.
    await m2.setDailyDriver(dispatcher(), { truckId: w.truck.id, date: w.date, employeeId: w.helper.employeeId, reason: "Sopir dipanggil kantor" });
    // Rit yang sudah ia Berangkatkan tetap miliknya (US-M2-11 KP-3).
    const done = await w.send(w.sopir, "m3.trip.complete", completePayload(a.id), { attach: [PHOTO, SIGNATURE], deviceTime: offlineComplete });
    expectApplied(done);
    const pay = (await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, a.id)))[0]!;
    expect(pay).toMatchObject({ driverUserId: w.driver.userId, receivedAmount: PRICE });
    // Berangkat rit baru dicatat sebelum penggantian → diterima sebagai konflik (data lapangan tidak ditimpa kantor).
    await t.db.update(trips).set({ driverUserId: null }).where(eq(trips.id, b.id));
    const dep = await w.send(w.sopir, "m3.trip.depart", { tripId: b.id, location: HERE }, { deviceTime: offlineDepart });
    expect(dep.status).toBe("conflict");
    expect(dep.message).toMatch(/Pengemudi truk diganti Dispatcher setelah tindakan/);
    expect((await t.db.select().from(trips).where(eq(trips.id, b.id)))[0]).toMatchObject({ status: "departed", syncConflict: true });
    // Tindakan yang dicatat SETELAH penggantian ditolak (sopir hanya membaca).
    const c = await w.addTrip({ routeOrder: 3 });
    expectRejected(await w.send(w.sopir, "m3.trip.depart", { tripId: c.id, location: HERE }), /bukan pengemudi truk ini/);
  });

  it("Bab 6.4 butir 3 BR-10 kunci setoran yang terbentuk SETELAH Berangkat dicatat di ponsel tidak menolak data lapangan (konflik)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const departedAt = new Date(Date.now() - 15 * 60_000);
    await createDeposit(t.db, { date: addDays(w.date, -1), status: "received", depositorUserId: w.driver.userId, depositorEmployeeId: w.driver.employeeId });
    const res = await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }, { deviceTime: departedAt });
    expect(res.status).toBe("conflict");
    expect(res.message).toMatch(/sebelum kunci setoran terbentuk/);
  });

  it("BR-07 US-M3-07 KP-2 US-M3-08 KP-2 setelah setoran Diterima/Ditutup: pelunasan & pengeluaran baru ditolak; data sebelum Setor yang terlambat sinkron masuk setoran berjalan berikutnya (bertanda)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    // Tunai kurang Rp 80.000 → faktur kurang bayar (untuk pelunasan).
    expectApplied(await completeCash(w, a.id, w.sopir, { payment: { method: "cash", cashReceived: PRICE - 80_000, underpaymentReasonCode: "customer_short" } }));
    const beforeSetor = new Date(Date.now() - 60_000);
    expectApplied(await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest() }));
    const dep = (await depositOn(w, w.driver.userId, w.date))!;
    const inv = (await t.db.select().from(invoices).where(and(eq(invoices.customerId, w.customer.id), eq(invoices.tripId, a.id))))[0]!;
    // Setelah Diajukan: pelunasan tunai baru ditolak dengan tindakan.
    expectRejected(await w.send(w.sopir, "m3.collection.create", { paymentId: newId(), customerId: w.customer.id, tripId: a.id, method: "cash", amount: 80_000, invoiceIds: [inv.id] }), /sudah diajukan/);
    const rec = await m4.receiveDeposit(finance(), { depositId: dep.id, receivedAmount: PRICE - 80_000 });
    expect(rec.deposit.status).toBe("closed");
    expectRejected(await w.send(w.sopir, "m3.collection.create", { paymentId: newId(), customerId: w.customer.id, tripId: a.id, method: "cash", amount: 80_000, invoiceIds: [inv.id] }), /sudah diterima Admin Keuangan/);
    expectRejected(
      await w.send(w.sopir, "m3.trip_expense.create", { expenseId: newId(), tripId: a.id, kind: "parking", amount: 5_000, fundingSource: "cash_on_hand" }, { attach: [{ kind: "receipt_note" }] }),
      /sudah diterima Admin Keuangan/,
    );
    // Pelunasan yang dicatat di ponsel SEBELUM Setor tetapi baru tersinkron → setoran berjalan berikutnya (bukan setoran tertutup).
    const paymentId = newId();
    const late = await w.send(w.sopir, "m3.collection.create", { paymentId, customerId: w.customer.id, tripId: a.id, method: "cash", amount: 80_000, invoiceIds: [inv.id] }, { deviceTime: beforeSetor });
    expect(late.status).toBe("conflict");
    expect(late.message).toMatch(/masuk setoran berjalan/);
    const col = (await t.db.select().from(customerPayments).where(eq(customerPayments.id, paymentId)))[0]!;
    expect(col.depositId).not.toBe(dep.id);
    expect((await t.db.select().from(deposits).where(eq(deposits.id, col.depositId!)))[0]).toMatchObject({ status: "running", businessDate: addDays(w.date, 1) });
  });

  it("US-M10-03 KP-1 sopir tidak dapat mengerjakan rit ditarik milik truk lain yang tidak pernah ada di perangkatnya (SOD-05)", async () => {
    const a = await driverWorld(t.db);
    const b = await driverWorld(t.db);
    const other = await b.addTrip();
    await t.db.update(trips).set({ withdrawnAt: new Date() }).where(eq(trips.id, other.id));
    expectRejected(await a.send(a.sopir, "m3.trip.depart", { tripId: other.id, location: HERE }), /milik truk lain/);
    expect((await t.db.select().from(trips).where(eq(trips.id, other.id)))[0]!.status).toBe("assigned");
    // Rit truk sendiri yang ditarik setelah diunduh tetap dapat dikerjakan (konflik).
    const mine = await a.addTrip();
    await t.db.update(trips).set({ withdrawnAt: new Date() }).where(eq(trips.id, mine.id));
    const res = await a.send(a.sopir, "m3.trip.depart", { tripId: mine.id, location: HERE });
    expect(res.status).toBe("conflict");
  });

  it("US-M3-01 KP-4 US-M2-03 KP-5 rit terbit yang dikeluarkan Dispatcher dari truk (tarik ke daftar belum dijadwalkan) tampil sebagai ditarik dengan ringkasan", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip({ routeOrder: 1 });
    const b = await w.addTrip({ routeOrder: 2 });
    await m2.unassignTrip(dispatcher(), { tripId: b.id, reason: "Pelanggan minta besok" });
    const pull = await w.today();
    expect(pull.trips.map((x) => x.id)).toEqual([a.id]);
    const gone = pull.withdrawn.find((x) => x.tripId === b.id);
    expect(gone?.summary).toMatch(/Rit ditarik dari jadwal — Pelanggan minta besok/);
    // Dikerjakan offline setelah ditarik → tetap diterima sebagai konflik (bukan ditolak).
    const res = await w.send(w.sopir, "m3.trip.depart", { tripId: b.id, location: HERE });
    expect(res.status).toBe("conflict");
  });

  it("US-M3-09 KP-5 dicatat kantor: pelunasan tertahan di antrean perangkat hilang & Setor atas nama sopir (alasan, penanda, laporan KPI-01, pemilik diberi tahu)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id, w.sopir, { payment: { method: "cash", cashReceived: PRICE - 50_000, underpaymentReasonCode: "customer_short" } }));
    const col = await m3.officeRecordCollection(finance(), {
      tripId: a.id,
      customerId: w.customer.id,
      paymentId: newId(),
      method: "cash",
      amount: 50_000,
      reason: "HP sopir hilang; pelunasan tercatat di nota kertas",
      occurredTime: "16:00",
    });
    expect(col.payment).toMatchObject({ recordedByOffice: true, channel: "driver", driverUserId: w.driver.userId, amount: 50_000 });
    const dep = (await depositOn(w, w.driver.userId, w.date))!;
    expect(col.payment.depositId).toBe(dep.id);
    await expect(m3.officeSubmitDeposit(finance(), { depositId: dep.id, reason: "pendek", occurredTime: "17:00" })).rejects.toThrow(/minimal 10 karakter/);
    const sub = await m3.officeSubmitDeposit(finance(), { depositId: dep.id, reason: "HP sopir hilang sebelum sempat Setor", occurredTime: "17:00" });
    expect(sub.deposit).toMatchObject({ status: "submitted", recordedByOffice: true, expectedNet: PRICE });
    const report = await m3.officeEntryReport(finance(), { from: w.date, to: w.date });
    expect(report.some((r) => r.kind === "collection" && r.amount === 50_000)).toBe(true);
    expect(report.some((r) => r.kind === "deposit" && r.tripNumber === dep.number)).toBe(true);
    const owner = await t.db.select().from(notifications).where(and(eq(notifications.event, "device.lost_queue"), eq(notifications.objectId, dep.id)));
    expect(owner.length).toBeGreaterThan(0);
    // Sopir tidak dapat mencatat pengeluaran lagi setelah Setor kantor.
    expect((await t.db.select().from(tripExpenses).where(eq(tripExpenses.depositId, dep.id)))).toHaveLength(0);
  });

  it("US-M3-04 KP-4 pelanggan Tunai tidak pernah menjadi tempo di lapangan: pilihan Tempo tanpa permintaan ditolak dengan tindakan", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectRejected(await completeCash(w, a.id, w.sopir, { payment: { method: "credit", cashReceivedIfRejected: 0 } }), /tidak dapat tempo/);
  });

  it("Bab 5.2 US-M3-02 KP-3 Selesai tanpa Tiba tidak mereka waktu tiba", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: a.id, location: HERE }));
    expectApplied(await completeCash(w, a.id));
    const row = (await t.db.select().from(trips).where(eq(trips.id, a.id)))[0]!;
    expect(row.status).toBe("completed");
    expect(row.arrivedAt).toBeNull();
  });

  it("US-M3-03 KP-7 US-M3-04 KP-5 sisa piutang struk WA tidak menghitung faktur rit ini dua kali (sebelum & sesudah pull)", () => {
    const pay = { method: "cash" as const, expectedAmount: PRICE, underpaymentAmount: 50_000 };
    // Sebelum pull: faktur kurang bayar rit ini belum ada.
    expect(receiptOutstanding([{ outstanding: 30_000, tripId: "lain" }], "rit-1", pay)).toBe(80_000);
    // Sesudah pull: faktur kurang bayar rit ini sudah terbit → tidak dijumlah lagi.
    expect(receiptOutstanding([{ outstanding: 30_000, tripId: "lain" }, { outstanding: 50_000, tripId: "rit-1" }], "rit-1", pay)).toBe(80_000);
    // Tempo: harga rit dihitung sekali.
    expect(receiptOutstanding([{ outstanding: PRICE, tripId: "rit-1" }], "rit-1", { method: "credit", expectedAmount: PRICE, underpaymentAmount: 0 })).toBe(PRICE);
  });
});
