import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, cashCloseExceptions, cashDays, deposits, discrepancies, domainEvents, shifts, tripPayments, trips } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, userIdByUsername } from "@/db/seed";
import { addDays, toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { put } from "@/server/core/storage";
import * as m3 from "@/server/modules/m3-driver";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createDeposit, createOpenShift } from "../helpers/fixtures";
import { closeVia } from "../m6-pos/helpers";
import { PRICE, at, depotDay, driverDay, finance, isolateCashDays, manifest, notificationsOf, owner } from "./helpers";

const today = () => toBusinessDate(new Date());

describe("M4 — tutup kas: penghalang, layar tutup kas, waktu KPI-02, H+0 (US-M4-06)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await isolateCashDays(t.db, today());
  });

  it("US-M4-06 KP-1 US-M4-06 KP-3 US-M4-06 KP-4 US-M4-06 KP-5 tutup kas hanya aktif bila semua setoran diterima, shift ditutup, tidak ada rit Berangkat/Tiba; layar menampilkan selisih, transfer belum dicocokkan, kas kantor sistem vs fisik; waktu KPI-02 tercatat; cash_day.closed", async () => {
    const date = today();
    const d = await driverDay(t.db, { trips: 1, transferTrips: 1 });
    const depotClosed = await depotDay(t.db, "D09", { sales: 2 });
    const depotOpen = await depotDay(t.db, "D10", { sales: 1, close: false });
    const store = await createOpenShift(t.db, { outletId: outletId("TK1"), operatorUserId: userIdByUsername("kasir"), date });
    const runningTrip = await d.addTrip();
    await t.db.update(trips).set({ status: "departed", departedAt: new Date() }).where(eq(trips.id, runningTrip.id));

    const fa = finance(at(date, "19:00"));
    const screen = await m4.getCashDayScreen(fa);
    const kinds = screen.openBlockers.map((b) => b.kind);
    expect(kinds).toEqual(expect.arrayContaining(["driver_deposit", "shift_deposit", "shift_open", "trip_active"]));
    expect(screen.openBlockers.filter((b) => b.kind === "shift_open").map((b) => b.shiftId)).toEqual(expect.arrayContaining([depotOpen.shiftId, store.shiftId]));
    expect(screen.canClose).toBe(false);
    expect(screen.unmatchedTransfers.some((x) => x.sourceUserId === d.driver.userId)).toBe(true);
    // Mulai tutup kas: dicatat + notifikasi setoran belum diterima (6.3).
    const started = await m4.startCashClose(fa, {});
    expect(started.day.closeStartedAt?.toISOString()).toBe(fa.now.toISOString());
    expect((await notificationsOf(t.db, "deposit.not_received_at_close")).length).toBeGreaterThan(0);
    await expect(m4.closeCashDay(finance(at(date, "19:05")), { officeCashPhysical: 0 })).rejects.toThrow(/Kas belum dapat ditutup/);

    // Selesaikan penghalang: terima setoran (dengan selisih kecil), tutup shift, rit selesai.
    await m4.receiveDeposit(finance(at(date, "19:10")), { depositId: d.depositId, receivedAmount: PRICE - 2_000, discrepancyReason: "wrong_change" });
    await m4.receiveDeposit(finance(at(date, "19:15")), { depositId: depotClosed.depositId, receivedAmount: depotClosed.cashSales });
    const closeRes = await closeVia(depotOpen.pos, depotOpen.shiftId, { counted: 200_000 + depotOpen.cashSales, saleIds: [] });
    expect(closeRes.status).toBe("applied");
    const d10dep = (await t.db.select().from(shifts).where(eq(shifts.id, depotOpen.shiftId)))[0]!.depositId!;
    await m4.receiveDeposit(finance(at(date, "19:20")), { depositId: d10dep, receivedAmount: depotOpen.cashSales });
    await t.db.update(shifts).set({ status: "closed", closedAt: new Date() }).where(eq(shifts.id, store.shiftId));
    await t.db.update(trips).set({ status: "completed" }).where(eq(trips.id, runningTrip.id));

    const ready = await m4.getCashDayScreen(finance(at(date, "19:30")));
    expect(ready.canClose).toBe(true);
    expect(ready.discrepancies.some((x) => x.depositId === d.depositId && x.amount === -2_000)).toBe(true);
    const system = ready.officeCashSystem;
    expect(system).toBe(PRICE - 2_000 + depotClosed.cashSales + depotOpen.cashSales);
    // Selisih kas kantor wajib alasan → alur selisih.
    await expect(m4.closeCashDay(finance(at(date, "19:40")), { officeCashPhysical: system - 1_000 })).rejects.toThrow(/pilih alasan selisih/);
    const closed = await m4.closeCashDay(finance(at(date, "19:40")), { officeCashPhysical: system - 1_000, officeCashReason: "other", officeCashNote: "Kurang seribu saat hitung" });
    expect(closed).toMatchObject({ status: "closed", closedLate: false, officeCashSystem: system, officeCashPhysical: system - 1_000, officeCashDifference: -1_000 });
    expect(closed.closeStartedAt?.toISOString()).toBe(fa.now.toISOString());
    expect(closed.lastDepositReceivedAt?.toISOString()).toBe(at(date, "19:20").toISOString());
    const office = (await t.db.select().from(discrepancies).where(eq(discrepancies.id, closed.officeDiscrepancyId!)))[0]!;
    expect(office).toMatchObject({ source: "office_cash", amount: -1_000, reason: "other" });
    // Saldo sistem disesuaikan ke uang fisik.
    expect((await m4.getOfficeCash(finance(at(date, "19:45")))).day.closing).toBe(system - 1_000);
    const ev = (await t.db.select().from(domainEvents).where(eq(domainEvents.type, "cash_day.closed")))[0]!;
    expect(ev.payload).toMatchObject({ cashDayId: closed.id, late: false, exceptionCount: 0, businessDate: date, kpi02Minutes: 20, officeCashDifference: -1_000 });
    expect((await notificationsOf(t.db, "cash_day.closed", closed.id)).map((n) => n.recipientUserId)).toContain(userIdByUsername("pemilik"));
    const history = await m4.listCashDays(owner());
    expect(history.find((h) => h.businessDate === date)).toMatchObject({ kpi02Minutes: 20, closeDurationMinutes: 40 });
    await expect(m4.closeCashDay(finance(at(date, "19:50")), { officeCashPhysical: 0 })).rejects.toThrow(/sudah ditutup/);
  });

  it("US-M4-06 KP-7 hari yang ditutup terkunci: kas kantor, setor bank, dan kas kecil tanggal itu ditolak", async () => {
    const date = today();
    const slip = await withTx((tx) => put(tx, finance(), { blob: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]), contentType: "image/jpeg", kind: "bank_slip" }));
    const bank = await m4.createBankAccount(finance(), { bankName: "Mandiri", accountNumber: "1320099887766", accountName: "PT EQUA Tirta" });
    await expect(m4.recordBankDeposit(finance(at(date, "20:00")), { bankAccountId: bank.id, amount: 1_000, slipAttachmentId: slip.id })).rejects.toThrow(/sudah ditutup/);
    await expect(m4.recordPettyCash(finance(at(date, "20:00")), { kind: "topup", amount: 1_000, description: "Isi" })).rejects.toThrow(/sudah ditutup/);
    await expect(m4.countPettyCash(finance(at(date, "20:00")), { physicalAmount: 0 })).rejects.toThrow(/sudah ditutup/);
  });
});

describe("M4 — hari sebelumnya, terlambat, pengecualian setoran tertunda (US-M4-06 KP-1/KP-2/KP-4)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await isolateCashDays(t.db, addDays(today(), -1));
  });

  it("US-M4-06 KP-1 hari sebelumnya harus sudah ditutup; US-M4-06 KP-4 tutup setelah PAR-06 / hari berikutnya ditandai terlambat", async () => {
    const date = today();
    const yesterday = addDays(date, -1);
    const dep = await createDeposit(t.db, { date: yesterday, status: "closed", expectedCash: 0 });
    void dep;
    const screen = await m4.getCashDayScreen(finance(at(date, "09:00")));
    expect(screen.openBlockers.map((b) => b.kind)).toContain("previous_day");
    const y = await m4.closeCashDay(finance(at(date, "08:00")), { date: yesterday, officeCashPhysical: 0 });
    expect(y).toMatchObject({ status: "closed", closedLate: true, businessDate: yesterday });
    const after = await m4.getCashDayScreen(finance(at(date, "09:00")));
    expect(after.openBlockers.map((b) => b.kind)).not.toContain("previous_day");
  });

  it("US-M4-06 KP-2 pengecualian per kejadian (persetujuan pemilik): tutup kas dengan setoran tertunda; rit sopir tetap terkunci; kas harus diterima ≤ 24 jam — lewat itu menjadi selisih", async () => {
    const date = today();
    const d = await driverDay(t.db, { trips: 1 });
    const fa = finance(at(date, "20:00"));
    const screen = await m4.getCashDayScreen(fa);
    const blocker = screen.openBlockers.find((b) => b.depositId === d.depositId)!;
    expect(blocker.canRequestException).toBe(true);
    await expect(m4.requestCloseException(owner(), { depositId: d.depositId, reason: "Sopir sakit mendadak" })).rejects.toThrow();
    const exc = await m4.requestCloseException(fa, { depositId: d.depositId, reason: "Sopir sakit mendadak, setor besok pagi" });
    expect(exc.status).toBe("submitted");
    // Pengajuan belum diputuskan → tetap menghalangi.
    await expect(m4.closeCashDay(finance(at(date, "20:05")), { officeCashPhysical: 0 })).rejects.toThrow(/belum dapat ditutup/);
    await expect(m4.requestCloseException(fa, { depositId: d.depositId, reason: "Ajukan lagi" })).rejects.toThrow(/per kejadian/);
    const req = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, exc.id)))[0]!;
    expect(req).toMatchObject({ type: "cash_close_exception", status: "submitted" });
    await approvals.decide(owner(at(date, "20:10")), req.id, "approve", "Izinkan sekali ini");
    const closed = await m4.closeCashDay(finance(at(date, "20:15")), { officeCashPhysical: 0 });
    expect(closed.status).toBe("closed");
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "cash_day.closed"), eq(domainEvents.objectId, closed.id))))[0]!;
    expect(ev.payload).toMatchObject({ exceptionCount: 1 });
    // Setoran belum Ditutup → rit sopir besok tetap terkunci (BR-10).
    expect((await m3.driverLock(t.db, { userId: d.driver.userId, employeeId: d.driver.employeeId, date: addDays(date, 1), tenantId: EQUA_TENANT_ID }))?.kind).toBe("br10");
    const e2 = (await t.db.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.id, exc.id)))[0]!;
    expect(e2.status).toBe("approved");
    expect(e2.dueAt!.getTime() - at(date, "20:15").getTime()).toBe(24 * 3_600_000);
    // Lewat 24 jam tanpa kas → selisih setoran tertunda + notifikasi.
    await m4.runPendingDepositDueCheck(new Date(e2.dueAt!.getTime() - 60_000));
    expect((await t.db.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.id, exc.id)))[0]!.status).toBe("approved");
    const r = await m4.runPendingDepositDueCheck(new Date(e2.dueAt!.getTime() + 60_000));
    expect(r.converted).toBe(1);
    const e3 = (await t.db.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.id, exc.id)))[0]!;
    expect(e3.status).toBe("expired");
    const disc = (await t.db.select().from(discrepancies).where(eq(discrepancies.id, e3.convertedDiscrepancyId!)))[0]!;
    expect(disc).toMatchObject({ source: "pending_deposit", amount: -PRICE, status: "formed", employeeId: d.driver.employeeId, requiresOwnerDecision: true });
    expect((await notificationsOf(t.db, "cash_close_exception.overdue", exc.id)).length).toBeGreaterThan(0);
    // Kas akhirnya diterima → pengecualian ditandai kas diterima.
    await m4.receiveDeposit(finance(at(addDays(date, 1), "21:00")), { depositId: d.depositId, receivedAmount: PRICE, lateReason: "Sopir sakit, setor terlambat" });
    expect((await t.db.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.id, exc.id)))[0]!.resolvedAt).toBeTruthy();
  });

  it("US-M4-06 KP-2 setoran tertunda maksimal PAR-89 hari; pengecualian ditolak pemilik tetap menghalangi", async () => {
    const date = addDays(today(), 1);
    // Setoran 2 hari sebelum tanggal tutup → tidak dapat dikecualikan.
    const old = await createDeposit(t.db, { date: addDays(date, -1), status: "submitted", depositorUserId: userIdByUsername("sopir3"), expectedCash: 100_000 });
    const scr = await m4.getCashDayScreen(finance(at(date, "20:00")), { date });
    void scr;
    await expect(m4.requestCloseException(finance(at(date, "20:00")), { date, depositId: old.id, reason: "Sopir cuti" })).rejects.toThrow();
    const fresh = await createDeposit(t.db, { date, status: "submitted", depositorUserId: userIdByUsername("sopir4"), expectedCash: 50_000 });
    const exc = await m4.requestCloseException(finance(at(date, "20:00")), { date, depositId: fresh.id, reason: "Sopir pulang ke kampung" });
    const req = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, exc.id)))[0]!;
    await approvals.decide(owner(at(date, "20:05")), req.id, "reject", "Minta sopir setor malam ini");
    expect((await t.db.select().from(cashCloseExceptions).where(eq(cashCloseExceptions.id, exc.id)))[0]!.status).toBe("rejected");
    const s = await m4.getCashDayScreen(finance(at(date, "20:10")), { date });
    expect(s.openBlockers.some((b) => b.depositId === fresh.id)).toBe(true);
  });
});

describe("M4 — transaksi terlambat sinkron masuk hari itu bertanda, kasnya ke setoran hari berikutnya (US-M4-06 KP-7)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M4-06 KP-7 tunai terlambat sinkron dari hari yang setorannya sudah ditutup dibawa ke setoran hari ini (bertanda) dan dihitung di layar tutup kas hari itu", async () => {
    const date = today();
    const yesterday = addDays(date, -1);
    const d = await driverDay(t.db, { trips: 1, submit: false });
    const late = await d.addTrip();
    await t.db.update(trips).set({ status: "completed", completedAt: at(yesterday, "17:00"), completionBusinessDate: yesterday }).where(eq(trips.id, late.id));
    await t.db.insert(tripPayments).values({
      tenantId: EQUA_TENANT_ID,
      tripId: late.id,
      customerId: d.customer.id,
      driverUserId: d.driver.userId,
      method: "cash",
      expectedAmount: PRICE,
      receivedAmount: PRICE,
      depositId: d.depositId,
      businessDate: yesterday,
      lateSync: true,
      deviceTime: at(yesterday, "17:00"),
    });
    expect((await d.send(d.sopir, "m3.deposit.submit", { method: "physical", manifest: manifest({ completedTripIds: d.tripIds }) })).status).toBe("applied");
    const detail = await m4.getDepositDetail(finance(at(date)), d.depositId);
    expect(detail.figures).toMatchObject({ sameDayCash: PRICE, carryOverCash: PRICE, expectedCash: 2 * PRICE });
    expect(detail.figures.carryOverItems[0]).toMatchObject({ businessDate: yesterday, amount: PRICE });
    const res = await m4.receiveDeposit(finance(at(date)), { depositId: d.depositId, receivedAmount: 2 * PRICE });
    expect(res.deposit).toMatchObject({ carryOverCash: PRICE, expectedNet: 2 * PRICE, discrepancyAmount: 0 });
    const scr = await m4.getCashDayScreen(finance(at(date)), { date: yesterday });
    expect(scr.lateSyncCount).toBe(1);
    const dayRow = (await t.db.select().from(cashDays).where(eq(cashDays.businessDate, date)))[0];
    expect(dayRow?.status ?? "open").toBe("open");
    expect((await t.db.select().from(deposits).where(eq(deposits.id, d.depositId)))[0]!.status).toBe("closed");
  });
});
