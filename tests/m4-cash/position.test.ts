import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { trips } from "@/db/schema";
import { outletId, userIdByUsername } from "@/db/seed";
import { addDays, toBusinessDate } from "@/lib/time";
import { exportReport } from "@/server/core/export";
import * as params from "@/server/core/params";
import * as m4 from "@/server/modules/m4-cash";

import { withTx } from "@/server/core/db";
import { put } from "@/server/core/storage";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { PRICE, at, completeCash, departArrive, depotDay, driverDay, expectApplied, finance, notificationsOf, owner } from "./helpers";

describe("M4 — Kas hari ini (US-M4-01)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  const today = () => toBusinessDate(new Date());

  it("US-M4-01 KP-1 satu baris per sumber (sopir bertugas, 10 depot, toko, kas kantor): seharusnya dari M3/M6 diperbarui saat sinkron, status, diterima, selisih, alasan; total per lini & keseluruhan", async () => {
    const d = await driverDay(t.db, { trips: 1, submit: false });
    const fa = finance(at(today(), "12:00"));
    let pos = await m4.getCashPosition(fa);
    const depots = pos.rows.filter((r) => r.line === "depot");
    expect(depots).toHaveLength(10);
    expect(pos.rows.filter((r) => r.line === "store")).toHaveLength(1);
    expect(pos.rows.filter((r) => r.line === "office")).toHaveLength(1);
    // Sopir default ketujuh truk seed tetap tampil walau belum ada setoran.
    expect(pos.rows.filter((r) => r.line === "driver").length).toBeGreaterThanOrEqual(8);
    expect(pos.rows.find((r) => r.userId === userIdByUsername("sopir1"))).toMatchObject({ status: "none", statusText: "Belum ada setoran" });
    const mine = () => pos.rows.find((r) => r.userId === d.driver.userId)!;
    expect(mine()).toMatchObject({ expected: PRICE, status: "running" });
    // Rit kedua tersinkron → seharusnya bertambah.
    const t2 = await d.addTrip();
    await departArrive(d, t2.id);
    expectApplied(await completeCash(d, t2.id));
    pos = await m4.getCashPosition(fa);
    expect(mine().expected).toBe(2 * PRICE);
    // Diterima + selisih + alasan.
    expectApplied(await d.send(d.sopir, "m3.deposit.submit", { method: "physical", manifest: { completedTripIds: [...d.tripIds, t2.id], failedTripIds: [], collectionIds: [], expenseIds: [] } }));
    await m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: 2 * PRICE - 3_000, discrepancyReason: "wrong_change", discrepancyNote: "Kembalian" });
    pos = await m4.getCashPosition(fa);
    expect(mine()).toMatchObject({ status: "closed", received: 2 * PRICE - 3_000, discrepancy: -3_000 });
    expect(mine().reason).toContain("Salah kembalian");
    const driverTotal = pos.totals.find((x) => x.line === "driver")!;
    expect(driverTotal.received).toBe(pos.rows.filter((r) => r.line === "driver").reduce((s, r) => s + (r.received ?? 0), 0));
    expect(pos.overall.expected).toBe(pos.totals.filter((x) => x.line !== "office").reduce((s, x) => s + x.expected, 0));
  });

  it("US-M4-01 KP-2 kolom terpisah transfer belum dicocokkan dan QRIS (PTB-04), tidak tercampur kas fisik", async () => {
    const d = await driverDay(t.db, { trips: 1, transferTrips: 1, submit: false });
    const depot = await depotDay(t.db, "D08", { sales: 1, qris: 1 });
    const pos = await m4.getCashPosition(finance(at(today(), "18:00")));
    const drv = pos.rows.find((r) => r.userId === d.driver.userId)!;
    expect(drv).toMatchObject({ expected: PRICE, unmatchedTransfers: PRICE });
    const dp = pos.rows.find((r) => r.outletId === outletId("D08"))!;
    expect(dp.qris).toBeGreaterThanOrEqual(15_000);
    expect(dp.unmatchedTransfers).toBeGreaterThanOrEqual(15_000);
    expect(dp.expected).toBeGreaterThanOrEqual(depot.cashSales);
    expect(pos.overall.qris).toBeGreaterThanOrEqual(15_000);
  });

  it("US-M4-01 KP-3 kas kantor = saldo awal + setoran diterima − setor ke bank − kas kecil − penggantian pengeluaran rit", async () => {
    const date = today();
    const fa = finance(at(date, "13:00"));
    const before = await m4.getCashPosition(fa);
    const office0 = before.office;
    const d = await driverDay(t.db, { trips: 1, expenses: [{ kind: "toll", amount: 25_000, fundingSource: "personal" }] });
    await m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: PRICE, expenseDecisions: [{ expenseId: d.expenseIds[0]!, accept: true }] });
    const bank = await m4.createBankAccount(fa, { bankName: "BNI", accountNumber: "0987654321", accountName: "PT EQUA Tirta" });
    const slip = await withTx((tx) => put(tx, fa, { blob: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]), contentType: "image/jpeg", kind: "bank_slip" }));
    await m4.recordBankDeposit(fa, { bankAccountId: bank.id, amount: 100_000, slipAttachmentId: slip.id });
    await m4.recordPettyCash(fa, { kind: "topup", amount: 50_000, description: "Isi kas kecil" });
    const pos = await m4.getCashPosition(fa);
    const o = pos.office;
    expect(o.depositsReceived - office0.depositsReceived).toBe(PRICE);
    expect(o.bankDeposits - office0.bankDeposits).toBe(100_000);
    expect(o.pettyCashTopups - office0.pettyCashTopups).toBe(50_000);
    expect(o.expenseReimbursements - office0.expenseReimbursements).toBe(25_000);
    expect(o.closing).toBe(o.opening + o.depositsReceived - o.bankDeposits - o.pettyCashTopups - o.expenseReimbursements + o.otherIn - o.otherOut);
    expect(pos.rows.find((r) => r.line === "office")!.expected).toBe(o.closing);
  });

  it("US-M4-01 KP-4 sorotan: setoran sopir belum Diajukan > PAR-44 setelah rit terakhir Selesai; setoran depot > PAR-27; kas outlet > PAR-02", async () => {
    const date = today();
    const d = await driverDay(t.db, { trips: 1, submit: false });
    const last = (await t.db.select().from(trips).where(eq(trips.id, d.tripIds[0]!)))[0]!.completedAt!;
    const soon = await m4.getCashPosition(finance(new Date(last.getTime() + 30 * 60_000)), { date: d.date });
    expect(soon.rows.find((r) => r.userId === d.driver.userId)!.flags.map((f) => f.code)).not.toContain("driver_not_submitted");
    const later = new Date(last.getTime() + 2 * 3_600_000);
    const pos = await m4.getCashPosition(finance(later), { date: d.date });
    expect(pos.rows.find((r) => r.userId === d.driver.userId)!.flags.map((f) => f.code)).toContain("driver_not_submitted");
    // Job notifikasi Admin Keuangan (sekali per setoran).
    await m4.runDriverNotSubmittedCheck(later);
    await m4.runDriverNotSubmittedCheck(later);
    expect(await notificationsOf(t.db, "deposit.not_submitted", d.depositId)).toHaveLength(2); // keuangan1 & keuangan2, sekali
    // Setoran depot belum diterima > PAR-27 hari sejak tutup shift.
    const depot = await depotDay(t.db, "D06", { sales: 1 });
    const posLate = await m4.getCashPosition(finance(new Date(Date.now() + 3 * 86_400_000)), { date: depot.date });
    expect(posLate.rows.find((r) => r.outletId === outletId("D06"))!.flags.map((f) => f.code)).toContain("depot_late");
    // Kas di laci outlet > PAR-02 (batas per outlet diatur pemilik).
    await params.set(owner(at(date, "07:00")), "PAR-02", { amount: 5_000 }, date, "Batas uji outlet D07", { outletId: outletId("D07") });
    await depotDay(t.db, "D07", { sales: 2, close: false });
    const posCash = await m4.getCashPosition(finance(at(date, "16:00")));
    const d07 = posCash.rows.find((r) => r.outletId === outletId("D07"))!;
    expect(d07.status).toBe("shift_open");
    expect(d07.flags.map((f) => f.code)).toContain("outlet_cash_over");
  });

  it("US-M4-01 KP-5 riwayat per tanggal dan ekspor Excel", async () => {
    const date = today();
    const yesterday = await m4.getCashPosition(finance(at(date)), { date: addDays(date, -1) });
    expect(yesterday.date).toBe(addDays(date, -1));
    expect(yesterday.isToday).toBe(false);
    const x = await exportReport(owner(), "m4.cash_position", "xlsx", { date });
    expect(x.rowCount).toBeGreaterThanOrEqual(12);
    expect(x.contentType).toContain("spreadsheet");
    const pdf = await exportReport(finance(), "m4.cash_position", "pdf", { date });
    expect(pdf.contentType).toContain("pdf");
    await expect(exportReport(finance(), "m4.deposits", "xlsx", { from: addDays(date, -7), to: date })).resolves.toBeTruthy();
  });
});
