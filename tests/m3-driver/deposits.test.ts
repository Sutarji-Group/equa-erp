import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { deposits, discrepancies, domainEvents, employees, tripExpenses } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addDays, wibToUtc } from "@/lib/time";
import * as m3 from "@/server/modules/m3-driver";

import { computeDayFigures, type M3DepositHistory } from "@/client/m3-driver/contract";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createDeposit } from "../helpers/fixtures";
import { HERE, PRICE, completeCash, departArrive, driverWorld, expectApplied, expectRejected, finance, notificationsFor, owner, type World } from "./helpers";

const manifest = (o: Partial<Record<"completedTripIds" | "failedTripIds" | "collectionIds" | "expenseIds", string[]>> = {}) => ({
  completedTripIds: [],
  failedTripIds: [],
  collectionIds: [],
  expenseIds: [],
  ...o,
});

async function depositFor(w: World) {
  return (await w.db.select().from(deposits).where(and(eq(deposits.depositorUserId, w.driver.userId), eq(deposits.businessDate, w.date))))[0];
}

describe("M3 — kas di tangan & Setor (US-M3-07), pengeluaran rit (US-M3-08)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M3-07 KP-1 kas di tangan = Σ tunai rit + Σ pelunasan tunai − Σ pengeluaran dari kas; dihitung sistem, tidak dapat diubah sopir", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    expectApplied(await w.send(w.sopir, "m3.trip_expense.create", { expenseId: newId(), tripId: a.id, kind: "fuel", amount: 150_000, fundingSource: "cash_on_hand" }, { attach: [{ kind: "receipt_note" }] }));
    expectApplied(await w.send(w.sopir, "m3.trip_expense.create", { expenseId: newId(), kind: "parking", amount: 5_000, fundingSource: "personal" }, { attach: [{ kind: "receipt_note" }] }));
    const f = await m3.cashOnHand(w.driver.ctx, { date: w.date });
    expect(f).toMatchObject({ tripCash: PRICE, expensesFromCash: 150_000, expensesPersonal: 5_000, cashOnHand: PRICE - 150_000 });
    const today = await w.today();
    expect(computeDayFigures({ trips: today.trips, payments: today.payments, collections: today.collections, expenses: today.expenses }).cashOnHand).toBe(PRICE - 150_000);
    // Tidak ada perintah untuk mengubah kas: jenis perintah tak dikenal ditolak.
    const res = await w.send(w.sopir, "m3.cash_on_hand.update", { amount: 1 });
    expect(res.status).toBe("rejected");
  });

  it("US-M3-07 KP-2 Setor aktif bila tidak ada rit Berangkat/Tiba; ringkasan terkunci (Diajukan) & dikirim ke Admin Keuangan; setelah Setor tidak ada rit baru kecuali dibuka kembali", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const b = await w.addTrip();
    const c = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    await departArrive(w, b.id);
    expectApplied(await w.send(w.sopir, "m3.trip.fail", { tripId: b.id, reason: "customer_absent", loadedWaterDisposition: "carried_to_next", location: HERE }));
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: c.id, location: HERE }));
    expectRejected(await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest() }), /masih berjalan/);
    expectApplied(await w.send(w.sopir, "m3.trip.fail", { tripId: c.id, reason: "truck_broken", loadedWaterDisposition: "returned_to_source", location: HERE }));
    const res = await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest({ completedTripIds: [a.id], failedTripIds: [b.id, c.id] }), deviceExpectedNet: PRICE });
    expectApplied(res);
    const dep = (await depositFor(w))!;
    expect(dep).toMatchObject({ status: "submitted", expectedCash: PRICE, expectedNet: PRICE, method: "physical" });
    const snap = dep.summarySnapshot as { figures: { completedTrips: number; failedTrips: number }; cashTrips: unknown[]; missing: { completedTripIds: string[] } };
    expect(snap.figures).toMatchObject({ completedTrips: 1, failedTrips: 2 });
    expect(snap.cashTrips).toHaveLength(1);
    expect(snap.missing.completedTripIds).toEqual([]);
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, dep.id), eq(domainEvents.type, "deposit.submitted"))))[0]!;
    expect(ev.payload).toMatchObject({ sourceType: "driver", sourceUserId: w.driver.userId, expectedAmount: PRICE, depositNumber: dep.number });
    // Setelah Setor: tidak ada rit baru hari itu.
    const d = await w.addTrip();
    expectRejected(await w.send(w.sopir, "m3.trip.depart", { tripId: d.id, location: HERE }), /Setoran hari ini .* sudah diajukan/);
    expectRejected(await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest() }), /sudah diajukan/);
    // Admin Keuangan membuka kembali setoran yang belum Diterima (alasan wajib) → rit dapat dilanjutkan.
    await expect(m3.reopenDriverDeposit(finance(), { depositId: dep.id, reason: "x" })).rejects.toThrow(/Alasan/);
    await expect(m3.reopenDriverDeposit(owner(), { depositId: dep.id, reason: "Masih ada rit tambahan" })).rejects.toThrow();
    const reopened = await m3.reopenDriverDeposit(finance(), { depositId: dep.id, reason: "Masih ada rit tambahan" });
    expect(reopened).toMatchObject({ status: "running", reopenReason: "Masih ada rit tambahan" });
    expectApplied(await w.send(w.sopir, "m3.trip.depart", { tripId: d.id, location: HERE }));
    // Setoran Diterima tidak dapat dibuka kembali.
    await t.db.update(deposits).set({ status: "received" }).where(eq(deposits.id, dep.id));
    await expect(m3.reopenDriverDeposit(finance(), { depositId: dep.id, reason: "Coba buka lagi" })).rejects.toThrow(/hanya setoran Diajukan/);
  });

  it("US-M3-07 KP-3 cara setor: bawaan serah fisik; setor bank dengan slip hanya untuk sopir yang diizinkan pemilik (PTB-23)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    expectRejected(await w.send(w.sopir, "m3.deposit.submit", { method: "bank_slip", manifest: manifest() }, { attach: [{ kind: "deposit_slip" }] }), /belum diizinkan setor ke bank/);
    await t.db.update(employees).set({ allowBankDeposit: true }).where(eq(employees.id, w.driver.employeeId));
    expect((await w.today()).allowBankDeposit).toBe(true);
    expectRejected(await w.send(w.sopir, "m3.deposit.submit", { method: "bank_slip", manifest: manifest() }), /slip setoran bank wajib/);
    expectApplied(await w.send(w.sopir, "m3.deposit.submit", { method: "bank_slip", manifest: manifest() }, { attach: [{ kind: "deposit_slip" }] }));
    const dep = (await depositFor(w))!;
    expect(dep.method).toBe("bank_slip");
    expect(dep.bankSlipAttachmentId).toBeTruthy();
  });

  it("US-M3-07 KP-4 hasil penerimaan (diterima, selisih, alasan, status) tampil ke sopir; sopir menambah keterangan atas selisih (masuk alur selisih M4)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    expectApplied(await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest() }));
    const dep = (await depositFor(w))!;
    expectRejected(await w.send(w.sopir, "m3.deposit.note", { depositId: dep.id, note: "Uang kembalian salah" }), /setelah setoran diterima/);
    // M4 menerima: kurang Rp 20.000.
    await t.db.update(deposits).set({ status: "received", receivedAmount: PRICE - 20_000, discrepancyAmount: -20_000, discrepancyReason: "wrong_change", receivedAt: new Date(), updatedAt: new Date() }).where(eq(deposits.id, dep.id));
    await t.db.insert(discrepancies).values({ tenantId: w.truck.tenantId, source: "driver", depositId: dep.id, userId: w.driver.userId, employeeId: w.driver.employeeId, businessDate: w.date, amount: -20_000, reason: "wrong_change" });
    const pull = await w.hp.pull(w.sopir, { keys: "m3.deposits" });
    const hist = pull.data["m3.deposits"] as M3DepositHistory;
    const row = hist.rows.find((r) => r.id === dep.id)!;
    expect(row).toMatchObject({ status: "received", receivedAmount: PRICE - 20_000, discrepancyAmount: -20_000, discrepancyReason: "wrong_change" });
    expect(row.discrepancies[0]).toMatchObject({ amount: -20_000, status: "formed" });
    expectApplied(await w.send(w.sopir, "m3.deposit.note", { depositId: dep.id, note: "Kembalian pelanggan PLG salah hitung" }));
    expect((await depositFor(w))!.depositorNote).toBe("Kembalian pelanggan PLG salah hitung");
    expect((await notificationsFor(t.db, "deposit.depositor_note", dep.id)).length).toBeGreaterThan(0);
  });

  it("US-M3-07 KP-5 setoran belum Diajukan pada PAR-06 → pengingat sopir + Admin Keuangan; tetap dapat diajukan setelahnya dengan penanda terlambat", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    const res = await m3.runDepositReminder(new Date());
    expect(res.reminded).toContain(w.driver.userId);
    const driverNote = (await notificationsFor(t.db, "deposit.driver_reminder")).filter((n) => n.recipientUserId === w.driver.userId);
    expect(driverNote.length).toBe(1);
    expect((await notificationsFor(t.db, "deposit.not_submitted")).length).toBeGreaterThan(0);
    // Idempoten per hari.
    await m3.runDepositReminder(new Date());
    expect((await notificationsFor(t.db, "deposit.driver_reminder")).filter((n) => n.recipientUserId === w.driver.userId)).toHaveLength(1);
    // Diajukan setelah 22.00 WIB → terlambat (waktu perangkat).
    const late = wibToUtc(w.date, "22:15");
    const now = new Date(Math.max(Date.now(), late.getTime()) + 60_000);
    const sub = await w.send(w.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest() }, { deviceTime: late, now, businessDate: w.date });
    expectApplied(sub);
    expect((await depositFor(w))!.submittedLate).toBe(true);
  });

  it("US-M3-07 KP-6 riwayat setoran & selisih sendiri 90 hari; tidak melihat data sopir lain", async () => {
    const w = await driverWorld(t.db);
    const other = await driverWorld(t.db);
    await createDeposit(t.db, { date: addDays(w.date, -10), status: "closed", depositorUserId: w.driver.userId, expectedCash: 300_000 });
    await createDeposit(t.db, { date: addDays(w.date, -120), status: "closed", depositorUserId: w.driver.userId, expectedCash: 100_000 });
    const mine = await createDeposit(t.db, { date: addDays(w.date, -3), status: "closed", depositorUserId: other.driver.userId, expectedCash: 999_000 });
    const pull = await w.hp.pull(w.sopir, { keys: "m3.deposits" });
    const hist = pull.data["m3.deposits"] as M3DepositHistory;
    expect(hist.days).toBe(90);
    expect(hist.rows.map((r) => r.businessDate)).toEqual([addDays(w.date, -10)]);
    expect(hist.rows.some((r) => r.id === mine.id)).toBe(false);
  });

  it("US-M3-08 KP-1 pengeluaran: jenis, jumlah, foto nota WAJIB, terkait rit atau hari & truk, sumber dana kas di tangan / pribadi", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    expectRejected(await w.send(w.sopir, "m3.trip_expense.create", { expenseId: newId(), tripId: a.id, kind: "toll", amount: 12_000, fundingSource: "cash_on_hand" }), /Foto nota wajib/);
    const expenseId = newId();
    expectApplied(await w.send(w.sopir, "m3.trip_expense.create", { expenseId, tripId: a.id, kind: "toll", amount: 12_000, fundingSource: "cash_on_hand", note: "Tol Cianjur" }, { attach: [{ kind: "receipt_note" }] }));
    const dayExpense = newId();
    expectApplied(await w.send(w.sopir, "m3.trip_expense.create", { expenseId: dayExpense, kind: "parking", amount: 3_000, fundingSource: "personal" }, { attach: [{ kind: "receipt_note" }] }));
    const [e1] = await t.db.select().from(tripExpenses).where(eq(tripExpenses.id, expenseId));
    expect(e1).toMatchObject({ tripId: a.id, truckId: w.truck.id, kind: "toll", amount: 12_000, fundingSource: "cash_on_hand", driverUserId: w.driver.userId });
    expect(e1!.receiptAttachmentId).toBeTruthy();
    const [e2] = await t.db.select().from(tripExpenses).where(eq(tripExpenses.id, dayExpense));
    expect(e2).toMatchObject({ tripId: null, truckId: w.truck.id, fundingSource: "personal" });
  });

  it("US-M3-08 KP-2 pengeluaran berstatus \"menunggu verifikasi\" sampai Admin Keuangan menerima nota saat penerimaan setoran; tertaut setoran hari itu", async () => {
    const w = await driverWorld(t.db);
    const expenseId = newId();
    expectApplied(await w.send(w.sopir, "m3.trip_expense.create", { expenseId, kind: "fuel", amount: 200_000, fundingSource: "cash_on_hand" }, { attach: [{ kind: "receipt_note" }] }));
    const [e] = await t.db.select().from(tripExpenses).where(eq(tripExpenses.id, expenseId));
    const dep = (await depositFor(w))!;
    expect(e).toMatchObject({ status: "pending_verification", depositId: dep.id });
    expect((await w.today()).expenses[0]).toMatchObject({ status: "pending_verification" });
  });

  it("US-M3-08 KP-3 pengeluaran BBM terkait truk & tanggal dipancarkan untuk jurnal M11 & biaya per rit M12 (trip.expense_recorded)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const expenseId = newId();
    expectApplied(await w.send(w.sopir, "m3.trip_expense.create", { expenseId, tripId: a.id, kind: "fuel", amount: 300_000, fundingSource: "cash_on_hand" }, { attach: [{ kind: "receipt_note" }] }));
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, expenseId), eq(domainEvents.type, "trip.expense_recorded"))))[0]!;
    expect(ev.payload).toMatchObject({ tripExpenseId: expenseId, tripId: a.id, truckId: w.truck.id, kind: "fuel", amount: 300_000, fundingSource: "cash_on_hand", businessDate: w.date });
  });
});
