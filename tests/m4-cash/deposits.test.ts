import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, deposits, discrepancies, domainEvents, officeCashMovements, parameters, shifts, tripExpenses } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";
import { isDomainError } from "@/server/core/errors";
import * as m3 from "@/server/modules/m3-driver";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";
import { PRICE, at, depositRow, depotDay, driverDay, finance, finance2, manifest, notificationsOf, owner } from "./helpers";

describe("M4 — penerimaan setoran & selisih (US-M4-02)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M4-02 KP-1 daftar setoran Diajukan (sopir) & tutup shift belum disetor (depot); rincian seharusnya per rit, pengeluaran menunggu verifikasi; angka seharusnya tidak dapat diubah", async () => {
    const d = await driverDay(t.db, { trips: 2, expenses: [{ kind: "fuel", amount: 100_000, fundingSource: "cash_on_hand" }] });
    const depot = await depotDay(t.db, "D04", { sales: 3 });
    const fa = finance(at(d.date));
    const list = await m4.listDepositsForReceipt(fa);
    const drv = list.waiting.find((r) => r.id === d.depositId)!;
    expect(drv).toMatchObject({ sourceType: "driver", status: "submitted", pendingExpenses: 1 });
    expect(drv.sync?.fullySynced).toBe(true);
    const shift = list.waiting.find((r) => r.id === depot.depositId)!;
    expect(shift).toMatchObject({ sourceType: "depot_shift", status: "submitted", expectedNet: depot.cashSales });
    const detail = await m4.getDepositDetail(fa, d.depositId);
    expect(detail.figures).toMatchObject({ sameDayCash: 2 * PRICE, expectedCash: 2 * PRICE, pendingExpenses: 1 });
    expect((detail.snapshot as { cashTrips: unknown[] }).cashTrips).toHaveLength(2);
    expect(detail.figures.expenses[0]).toMatchObject({ kind: "fuel", amount: 100_000, status: "pending_verification", fundingSource: "cash_on_hand" });
    // Masukan penerimaan tidak menerima angka seharusnya (skema ketat) — penerima tidak dapat mengubah transaksi lapangan.
    await expect(m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: 2 * PRICE, expectedCash: 1 } as never)).rejects.toThrow();
    // Pengeluaran menunggu verifikasi menahan penerimaan.
    await expect(m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: 2 * PRICE })).rejects.toThrow(/pengeluaran rit menunggu verifikasi/);
  });

  it("US-M4-02 KP-2 verifikasi pengeluaran satu per satu (PTB-20); selisih = diterima − (seharusnya − pengeluaran diterima); uang pribadi diterima → penggantian dari kas kantor; rincian pecahan opsional", async () => {
    const d = await driverDay(t.db, {
      trips: 2,
      expenses: [
        { kind: "fuel", amount: 150_000, fundingSource: "cash_on_hand" },
        { kind: "parking", amount: 20_000, fundingSource: "cash_on_hand" },
        { kind: "toll", amount: 30_000, fundingSource: "personal" },
      ],
    });
    const fa = finance(at(d.date));
    const [fuel, parking, toll] = d.expenseIds as [string, string, string];
    // Tolak wajib alasan.
    await expect(m4.verifyExpense(fa, { expenseId: parking, accept: false })).rejects.toThrow(/Alasan penolakan/);
    await m4.verifyExpense(fa, { expenseId: fuel, accept: true });
    await m4.verifyExpense(fa, { expenseId: parking, accept: false, reason: "Nota tidak terbaca" });
    const exps = await t.db.select().from(tripExpenses).where(eq(tripExpenses.depositId, d.depositId));
    expect(exps.find((e) => e.id === fuel)?.status).toBe("accepted");
    expect(exps.find((e) => e.id === parking)).toMatchObject({ status: "rejected", rejectionReason: "Nota tidak terbaca" });
    // Pecahan tidak sama dengan jumlah diterima → ditolak.
    const expected = 2 * PRICE - 150_000;
    await expect(
      m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: expected, denominations: { "100000": 1 }, expenseDecisions: [{ expenseId: toll, accept: true }] }),
    ).rejects.toThrow(/rincian pecahan/);
    const denominations = { "100000": Math.floor(expected / 100_000), "50000": (expected % 100_000) / 50_000 };
    const res = await m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: expected, denominations, expenseDecisions: [{ expenseId: toll, accept: true }] });
    expect(res.deposit).toMatchObject({ status: "closed", expectedCash: 2 * PRICE, acceptedExpenses: 150_000, expectedNet: expected, receivedAmount: expected, discrepancyAmount: 0 });
    expect(res.deposit.denominations).toEqual(denominations);
    expect(res.discrepancy).toBeNull();
    // Uang pribadi (tol) diterima → penggantian dari kas kantor; setoran fisik masuk kas kantor.
    const moves = await t.db.select().from(officeCashMovements);
    expect(moves.find((m) => m.sourceObjectId === toll)).toMatchObject({ kind: "expense_reimbursement", direction: "out", amount: 30_000 });
    expect(moves.find((m) => m.sourceObjectId === d.depositId)).toMatchObject({ kind: "deposit_received", direction: "in", amount: expected });
    const verified = await t.db.select().from(domainEvents).where(eq(domainEvents.type, "expense.verified"));
    expect(verified.filter((e) => [fuel, parking, toll].includes((e.payload as { tripExpenseId: string }).tripExpenseId))).toHaveLength(3);
  });

  it("US-M4-02 KP-3 selisih ≠ 0 → alasan wajib dari daftar (Lainnya + teks) dan objek Selisih terbentuk", async () => {
    const d = await driverDay(t.db, { trips: 1 });
    const fa = finance(at(d.date));
    await expect(m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: PRICE - 10_000 })).rejects.toThrow(/pilih alasan selisih/);
    await expect(m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: PRICE - 10_000, discrepancyReason: "other" })).rejects.toThrow(/Lainnya/);
    const res = await m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: PRICE - 10_000, discrepancyReason: "wrong_change", discrepancyNote: "Kembalian PLG salah" });
    expect(res.deposit).toMatchObject({ discrepancyAmount: -10_000, discrepancyReason: "wrong_change", status: "closed" });
    expect(res.discrepancy).toMatchObject({ source: "driver", amount: -10_000, reason: "wrong_change", depositId: d.depositId, employeeId: d.driver.employeeId });
    const ev = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "discrepancy.formed"), eq(domainEvents.objectId, res.discrepancy!.id)));
    expect(ev[0]?.payload).toMatchObject({ amount: -10_000, sourceType: "driver", overThreshold: false });
  });

  it("US-M4-02 KP-4 |selisih| ≥ PAR-01 → dikirim ke pemilik seketika (persetujuan 24 jam) dan setoran TETAP Ditutup; di bawah ambang ditutup Admin Keuangan dengan alasan", async () => {
    const big = await driverDay(t.db, { trips: 1 });
    const fa = finance(at(big.date));
    const res = await m4.receiveDeposit(fa, { depositId: big.depositId, receivedAmount: PRICE - 60_000, discrepancyReason: "damaged_or_counterfeit", discrepancyNote: "Uang palsu 50 ribu + rusak" });
    expect(res.deposit.status).toBe("closed");
    expect(res.discrepancy).toMatchObject({ requiresOwnerDecision: true, status: "explained" });
    const req = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, res.discrepancy!.id)))[0]!;
    expect(req).toMatchObject({ type: "cash_discrepancy", status: "submitted", approverRole: "owner", amount: -60_000 });
    expect(req.deadlineAt!.getTime() - req.createdAt.getTime()).toBeLessThanOrEqual(24 * 3_600_000 + 60_000);
    const notes = await notificationsOf(t.db, "discrepancy.over_threshold", res.discrepancy!.id);
    expect(notes.length).toBeGreaterThanOrEqual(2); // pemilik & Admin Keuangan
    expect(notes[0]!.severity).toBe("critical");
    // Di bawah ambang → ditutup Admin Keuangan (Selesai) bersama setoran.
    const small = await driverDay(t.db, { trips: 1 });
    const r2 = await m4.receiveDeposit(finance(at(small.date)), { depositId: small.depositId, receivedAmount: PRICE - 5_000, discrepancyReason: "wrong_change" });
    const disc = (await t.db.select().from(discrepancies).where(eq(discrepancies.id, r2.discrepancy!.id)))[0]!;
    expect(disc).toMatchObject({ status: "done", requiresOwnerDecision: false });
    expect(disc.closedBelowThresholdAt).toBeTruthy();
  });

  it("US-M4-02 KP-5 selisih lebih dicatat dan disetor penuh; tidak ada pengembalian ke penyetor (BR-12)", async () => {
    const d = await driverDay(t.db, { trips: 1 });
    const res = await m4.receiveDeposit(finance(at(d.date)), { depositId: d.depositId, receivedAmount: PRICE + 15_000, discrepancyReason: "other", discrepancyNote: "Pelanggan tidak minta kembalian" });
    expect(res.discrepancy).toMatchObject({ amount: 15_000 });
    const moves = await t.db.select().from(officeCashMovements).where(eq(officeCashMovements.sourceObjectId, d.depositId));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ direction: "in", amount: PRICE + 15_000 });
  });

  it("US-M4-02 KP-6 penerimaan mencatat waktu; setelah PAR-06 atau hari berikutnya ditandai terlambat dengan alasan wajib", async () => {
    const d = await driverDay(t.db, { trips: 1 });
    const late = finance(at(d.date, "22:30"));
    await expect(m4.receiveDeposit(late, { depositId: d.depositId, receivedAmount: PRICE })).rejects.toThrow(/alasan keterlambatan/);
    const res = await m4.receiveDeposit(late, { depositId: d.depositId, receivedAmount: PRICE, lateReason: "Sopir tiba 22.20 karena ban bocor" });
    expect(res.deposit).toMatchObject({ receivedLate: true, lateReason: "Sopir tiba 22.20 karena ban bocor" });
    expect(res.deposit.receivedAt?.toISOString()).toBe(at(d.date, "22:30").toISOString());
    // Hari berikutnya juga terlambat.
    const d2 = await driverDay(t.db, { trips: 1 });
    const next = finance(at(addDays(d2.date, 1), "08:00"));
    await expect(m4.receiveDeposit(next, { depositId: d2.depositId, receivedAmount: PRICE })).rejects.toThrow(/terlambat|keterlambatan/i);
  });

  it("US-M4-02 KP-7 setoran depot diterima fisik atau lewat setor bank dengan slip (Diterima setelah mutasi cocok); tutup shift belum disetor > PAR-27 hari ditandai", async () => {
    const depot = await depotDay(t.db, "D05", { sales: 2 });
    const fa = finance(at(depot.date));
    const res = await m4.receiveDeposit(fa, { depositId: depot.depositId, receivedAmount: depot.cashSales });
    expect(res.deposit.status).toBe("closed");
    // M6 menandai setoran shift Diterima (event deposit.received).
    expect((await t.db.select().from(shifts).where(eq(shifts.id, depot.shiftId)))[0]!.depositStatus).toBe("received");

    // Setor bank dengan slip: tidak dapat diterima fisik; transfer masuk "Setor bank (slip)" lalu dicocokkan.
    const slip = await depotDay(t.db, "D06", { sales: 3 });
    const cmdId = newId();
    const up2 = await slip.pos.hp.upload(slip.pos.op, { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]), kind: "bank_slip", commandId: cmdId });
    const sub = await slip.pos.send("m6.shift_deposit.submit", { shiftId: slip.shiftId, method: "bank_slip" }, { id: cmdId, attachmentIds: [up2.attachmentId], attachmentHashes: [up2.sha256] });
    expect(sub.status, sub.message ?? "").toBe("applied");
    await expect(m4.receiveDeposit(fa, { depositId: slip.depositId, receivedAmount: slip.cashSales })).rejects.toThrow(/lewat bank dengan slip/);
    await m4.sweepSlipDeposits(new Date());
    const transfers = await m4.listIncomingTransfers(fa, { status: "open" });
    const tr = transfers.find((x) => x.sourceObjectId === slip.depositId)!;
    expect(tr).toMatchObject({ sourceKind: "bank_deposit_slip", amount: slip.cashSales, status: "unmatched" });
    await m4.matchTransfer(fa, { transferId: tr.id, refDate: slip.date, refAmount: slip.cashSales, refNote: "SETORAN TUNAI D06" });
    expect(await depositRow(t.db, slip.depositId)).toMatchObject({ status: "closed", receivedAmount: slip.cashSales, discrepancyAmount: 0, slipTransferId: tr.id });

    // Setoran depot belum diterima > PAR-27 hari sejak tutup shift → ditandai.
    const old = await depotDay(t.db, "D07", { sales: 1 });
    const later = finance(new Date(Date.now() + 3 * 86_400_000));
    const rows = await m4.listDepositsForReceipt(later);
    expect(rows.waiting.find((r) => r.id === old.depositId)?.depotLate).toBe(true);
    expect(rows.waiting.find((r) => r.id === depot.depositId)).toBeUndefined();
  });

  it("US-M4-02 KP-8 setoran Ditutup → deposit.closed; kunci rit sopir hari berikutnya terbuka (BR-10) dan hasilnya tampil ke sopir", async () => {
    const d = await driverDay(t.db, { trips: 1 });
    const next = addDays(d.date, 1);
    const lockBefore = await m3.driverLock(t.db, { userId: d.driver.userId, employeeId: d.driver.employeeId, date: next, tenantId: EQUA_TENANT_ID });
    expect(lockBefore?.kind).toBe("br10");
    const fa = finance(at(d.date));
    const r = await m4.receiveDeposit(fa, { depositId: d.depositId, receivedAmount: PRICE, close: false });
    expect(r.deposit.status).toBe("received");
    expect((await m3.driverLock(t.db, { userId: d.driver.userId, employeeId: d.driver.employeeId, date: next, tenantId: EQUA_TENANT_ID }))?.kind).toBe("br10");
    await m4.closeDeposit(fa, { depositId: d.depositId });
    expect(await m3.driverLock(t.db, { userId: d.driver.userId, employeeId: d.driver.employeeId, date: next, tenantId: EQUA_TENANT_ID })).toBeNull();
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "deposit.closed"), eq(domainEvents.objectId, d.depositId))))[0]!;
    expect(ev.payload).toMatchObject({ sourceType: "driver", sourceUserId: d.driver.userId, unlocksTrips: true });
    const result = await notificationsOf(t.db, "deposit.result", d.depositId);
    expect(result.map((n) => n.recipientUserId)).toContain(d.driver.userId);
    // Hasil tampil di aplikasi sopir (pull riwayat setoran M3 & pull M4).
    const pull = await d.hp.pull(d.sopir, { keys: "m4.my_cash" });
    const mine = pull.data["m4.my_cash"] as m4.MyCashReference;
    expect(mine.deposits.find((x) => x.id === d.depositId)).toMatchObject({ status: "closed", receivedAmount: PRICE });
  });

  it("US-M4-02 KP-9 pemisahan tugas: penerima ≠ penyetor; pemilik tidak menerima setoran; Admin Keuangan cadangan (R13) memakai peran yang sama", async () => {
    const d = await driverDay(t.db, { trips: 1 });
    await expect(m4.receiveDeposit(owner(at(d.date)), { depositId: d.depositId, receivedAmount: PRICE })).rejects.toThrow(/Pemilik tidak menginput transaksi harian|SOD-08/);
    // Admin Keuangan yang juga penyetor (setoran dirinya) ditolak (SOD-02).
    const fa = await createTestUser(t.db, { role: "finance_admin" });
    await t.db.update(deposits).set({ depositorUserId: fa.userId }).where(eq(deposits.id, d.depositId));
    const err = await m4.receiveDeposit({ ...fa.ctx, now: at(d.date) }, { depositId: d.depositId, receivedAmount: PRICE }).catch((e) => e);
    expect(isDomainError(err)).toBe(true);
    expect((err as Error).message).toMatch(/setoran Anda sendiri/);
    await t.db.update(deposits).set({ depositorUserId: d.driver.userId }).where(eq(deposits.id, d.depositId));
    // Admin Keuangan cadangan menerima dengan peran yang sama.
    const res = await m4.receiveDeposit(finance2(at(d.date)), { depositId: d.depositId, receivedAmount: PRICE });
    expect(res.deposit).toMatchObject({ status: "closed" });
    expect(res.deposit.receivedBy).toBe(finance2().userId);
  });

  it("US-M4-02 KP-9 tidak dapat menerima bila perangkat masih punya antrean (menunggu sinkron, US-M3-09 KP-3)", async () => {
    const d = await driverDay(t.db, { trips: 1, submit: false });
    // Setor dengan manifest yang memuat rit yang belum tersinkron.
    const ghost = newId();
    const sub = await d.send(d.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest({ completedTripIds: [...d.tripIds, ghost] }) });
    expect(sub.status).toBe("applied");
    const dep = (await t.db.select().from(deposits).where(and(eq(deposits.depositorUserId, d.driver.userId), eq(deposits.businessDate, d.date))))[0]!;
    const fa = finance(at(d.date));
    const detail = await m4.getDepositDetail(fa, dep.id);
    expect(detail.sync.fullySynced).toBe(false);
    expect(detail.canReceive).toBe(false);
    await expect(m4.receiveDeposit(fa, { depositId: dep.id, receivedAmount: PRICE })).rejects.toThrow(/Menunggu sinkron/);
  });

  it("US-M4-02 KP-10 PAR-83 aktif: selisih kurang ≥ ambang mengunci rit sopir sampai pemilik memutuskan + notifikasi kritis pemilik & Dispatcher", async () => {
    await t.db.update(parameters).set({ value: { enabled: true, amount_gte: 100_000 } }).where(eq(parameters.key, "PAR-83"));
    const d = await driverDay(t.db, { trips: 1 });
    const res = await m4.receiveDeposit(finance(at(d.date)), { depositId: d.depositId, receivedAmount: PRICE - 120_000, discrepancyReason: "other", discrepancyNote: "Uang hilang di jalan" });
    expect(res.deposit.status).toBe("closed");
    expect(res.discrepancy).toMatchObject({ locksTrips: true, requiresOwnerDecision: true });
    const next = addDays(d.date, 1);
    expect((await m3.driverLock(t.db, { userId: d.driver.userId, employeeId: d.driver.employeeId, date: next, tenantId: EQUA_TENANT_ID }))?.kind).toBe("par83");
    const lockNotes = await notificationsOf(t.db, "discrepancy.trip_lock", res.discrepancy!.id);
    expect(lockNotes.length).toBeGreaterThanOrEqual(2);
    expect(lockNotes.every((n) => n.severity === "critical")).toBe(true);
    // Pemilik memutuskan → kunci terbuka.
    await m4.decideDiscrepancy(owner(at(d.date, "16:00")), res.discrepancy!.id, { decision: "approve", reason: "Diterima, dibebankan" });
    expect(await m3.driverLock(t.db, { userId: d.driver.userId, employeeId: d.driver.employeeId, date: next, tenantId: EQUA_TENANT_ID })).toBeNull();
    await t.db.update(parameters).set({ value: { enabled: false, amount_gte: 500_000 } }).where(eq(parameters.key, "PAR-83"));
  });
});
