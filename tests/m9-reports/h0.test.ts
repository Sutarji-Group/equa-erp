import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { cashDays, dailySummaries, dailySummaryAddenda, deposits, discrepancies, notifications } from "@/db/schema";
import { EQUA_TENANT_ID, employeeId, outletId, userIdByUsername } from "@/db/seed";
import { addDays, toBusinessDate } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import * as m4 from "@/server/modules/m4-cash";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { createTestDb, useTestDb } from "../helpers/db";
import { createDeposit, createTruck } from "../helpers/fixtures";
import { PRICE, driverDay, finance as m4Finance, isolateCashDays } from "../m4-cash/helpers";
import { at, dispatcher, finance, makeInvoice, makeSale, makeStoreOutlet, makeTrip, owner, payInvoice } from "./helpers";

const D = "2026-06-10";

describe("M9 — Dashboard H+0 (US-M9-01)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M9-01 KP-1 enam blok: omzet L2/L3/L4 dengan transfer internal L2→L3 terpisah (BR-33), kas seharusnya/diterima/selisih, piutang + KPI-04, rit per truk, galon per depot, pengecualian", async () => {
    const truck = await createTruck(t.db);
    await makeTrip(t.db, { date: D, truckId: truck.id, price: 250_000 });
    await makeTrip(t.db, { date: D, truckId: truck.id, price: 250_000 });
    await makeTrip(t.db, { date: D, truckId: truck.id, status: "failed", failReason: "customer_absent" });
    await makeTrip(t.db, { date: D, truckId: truck.id, price: 180_000, internal: true });
    await makeSale(t.db, { outletCode: "D01", date: D, total: 10_000, gallons: 2 });
    await makeSale(t.db, { outletCode: "D01", date: D, total: 10_000, gallons: 2 });
    await makeSale(t.db, { outletCode: "D01", date: D, total: 99_000, gallons: 9, status: "voided" });
    const store = await makeStoreOutlet(t.db);
    await makeSale(t.db, { outletId: store, date: D, total: 40_000 });
    // Piutang: faktur hari ini (belum jatuh tempo) + faktur lama lewat tempo dibayar sebagian hari ini.
    await makeInvoice(t.db, { issueDate: D, dueDate: addDays(D, 14), amount: 500_000 });
    const old = await makeInvoice(t.db, { issueDate: addDays(D, -30), dueDate: addDays(D, -16), amount: 300_000 });
    await payInvoice(t.db, { invoiceId: old.id, customerId: old.customerId, amount: 100_000, date: D });
    // Kas: setoran sopir Ditutup dengan selisih −20.000; selisih ≥ ambang menunggu pemilik.
    const dep = await createDeposit(t.db, { date: D, status: "closed", expectedCash: 500_000, depositorUserId: userIdByUsername("sopir1"), depositorEmployeeId: employeeId("EQ-009"), truckId: truck.id });
    await t.db.update(deposits).set({ receivedAmount: 480_000, discrepancyAmount: -20_000 }).where(eq(deposits.id, dep.id));
    await t.db.insert(discrepancies).values({ tenantId: EQUA_TENANT_ID, source: "driver", depositId: dep.id, businessDate: D, amount: -60_000, requiresOwnerDecision: true, status: "formed" });

    const dash = await m9.getDailyDashboard(owner(at(D, "21:30")), {});
    expect(dash).toMatchObject({ range: "today", from: D, to: D, isSingleDay: true, unclosed: true });
    const r = dash.data.revenue;
    expect(r.L2).toEqual({ amount: 500_000, trips: 2 });
    expect(r.L3).toMatchObject({ amount: 20_000, transactions: 3 });
    expect(r.L4).toMatchObject({ amount: 40_000, transactions: 1 });
    expect(r.external).toBe(560_000);
    // BR-33: transfer internal tampil terpisah, tidak masuk omzet luar.
    expect(r.internal.truckToDepot).toMatchObject({ amount: 180_000, trips: 1, liters: 5000 });
    expect(dash.data.cash.expected).toBeGreaterThanOrEqual(500_000);
    expect(dash.data.cash.received).toBe(480_000);
    expect(dash.data.cash.discrepancy).toBe(-20_000);
    expect(dash.data.cash.byLine.map((l) => l.line)).toEqual(["driver", "depot", "store", "office"]);
    expect(dash.data.receivables).toMatchObject({ balance: 700_000, formed: 500_000, paid: 100_000, overdue: 200_000, overduePct: 28.57, targetPct: 5 });
    const tr = dash.data.trips.byTruck.find((x) => x.truckId === truck.id)!;
    expect(tr).toMatchObject({ scheduled: 4, completed: 3, failed: 1, internalScheduled: 1, internalCompleted: 1 });
    expect(dash.data.gallons.byDepot.find((g) => g.code === "D01")).toMatchObject({ gallons: 4, liters: 76 });
    expect(dash.data.exceptions.failedTrips).toHaveLength(1);
    expect(dash.data.exceptions.discrepancies.some((d) => d.amount === -60_000)).toBe(true);
    expect(dash.pendingDiscrepancies.length).toBeGreaterThan(0);
    expect(dash.canDecide).toBe(true);
  });

  it("US-M9-01 KP-7 rentang hari ini, kemarin, 7 hari, bulan berjalan memakai definisi angka yang sama (Σ harian)", async () => {
    const d1 = "2026-06-08";
    const d2 = "2026-06-09";
    const truck = await createTruck(t.db);
    await makeTrip(t.db, { date: d1, truckId: truck.id, price: 100_000 });
    await makeTrip(t.db, { date: d2, truckId: truck.id, price: 200_000 });
    await makeSale(t.db, { outletCode: "D03", date: d1, total: 15_000, gallons: 3 });
    const ctx = owner(at(D, "21:30"));
    const today = await m9.getDailyDashboard(ctx, { range: "today" });
    const yesterday = await m9.getDailyDashboard(ctx, { range: "yesterday" });
    const day1 = await m9.getDailyDashboard(ctx, { date: d1 });
    const week = await m9.getDailyDashboard(ctx, { range: "last7" });
    const month = await m9.getDailyDashboard(ctx, { range: "month" });
    expect(yesterday).toMatchObject({ range: "yesterday", from: d2, to: d2 });
    expect(yesterday.data.revenue.L2.amount).toBe(200_000);
    expect(day1.range).toBe("history");
    expect(week).toMatchObject({ from: addDays(D, -6), to: D, isSingleDay: false });
    const sumL2 = today.data.revenue.L2.amount + yesterday.data.revenue.L2.amount + day1.data.revenue.L2.amount;
    expect(week.data.revenue.L2.amount).toBe(sumL2);
    expect(week.data.revenue.L3.amount).toBe(today.data.revenue.L3.amount + day1.data.revenue.L3.amount);
    expect(month.data.revenue.external).toBe(week.data.revenue.external);
    expect(week.data.gallons.byDepot.find((g) => g.code === "D03")!.gallons).toBe(3);
    expect(week.data.trips.byTruck.find((x) => x.truckId === truck.id)).toMatchObject({ scheduled: 2, completed: 2 });
    // Metrik langsung = dashboard (satu definisi).
    const direct = await m9.revenueForRange(t.db, EQUA_TENANT_ID, addDays(D, -6), D);
    expect(direct.external).toBe(week.data.revenue.external);
    // Piutang rentang = saldo akhir rentang.
    expect(week.data.receivables.balance).toBe(today.data.receivables.balance);
  });

  it("US-M9-01 KP-3 setiap angka turun ke rincian tanpa pindah modul: truk → rit, depot → shift, selisih → setoran, piutang → pelanggan", async () => {
    const ctx = owner(at(D, "21:30"));
    const dash = await m9.getDailyDashboard(ctx, {});
    const truckId = dash.data.trips.byTruck.find((x) => x.scheduled === 4)!.truckId;
    const truck = await m9.getDailyDrilldown(ctx, { kind: "truck", from: D, to: D, id: truckId });
    expect(truck.kind).toBe("truck");
    expect(truck.rows).toHaveLength(4);
    expect(truck.kind === "truck" && truck.rows.filter((r) => r.status === "failed")[0]!.failReason).toBe("Pelanggan tidak ada");
    const depot = await m9.getDailyDrilldown(ctx, { kind: "depot", from: D, to: D, id: outletId("D01") });
    expect(depot.kind === "depot" && depot.rows[0]).toMatchObject({ sales: 20_000, gallons: 4, transactions: 3 });
    const disc = await m9.getDailyDrilldown(ctx, { kind: "discrepancy", from: D, to: D });
    expect(disc.kind === "discrepancy" && disc.rows.find((r) => r.discrepancy === -20_000)).toBeTruthy();
    const recv = await m9.getDailyDrilldown(ctx, { kind: "receivable", from: D, to: D });
    expect(recv.kind === "receivable" && recv.rows.reduce((s, r) => s + r.formed, 0)).toBe(500_000);
    expect(recv.kind === "receivable" && recv.rows.find((r) => r.overdue === 200_000)).toBeTruthy();
    // Admin Keuangan juga berhak (m9.daily_summary.read); Dispatcher tidak.
    await expect(m9.getDailyDrilldown(finance(at(D)), { kind: "discrepancy", from: D, to: D })).resolves.toBeTruthy();
    await expect(m9.getDailyDrilldown(dispatcher(at(D)), { kind: "discrepancy", from: D, to: D })).rejects.toThrow(/tidak diizinkan/i);
  });

  it("US-M9-01 KP-5 dashboard hari ini dihitung < 2 detik (NFR-03, data teragregasi)", async () => {
    const dash = await m9.getDailyDashboard(owner(at(D, "21:30")), {});
    expect(dash.computeMs).toBeLessThan(2_000);
  });

  it("US-M9-01 KP-2 tidak ada H+0 manual: terbit hanya setelah kas ditutup; tutup kas terlambat → terbit bertanda terlambat dengan cap waktu (7.9.7)", async () => {
    const date = "2026-06-05";
    await expect(withTx((tx) => m9.publishDailySummary(tx, { tenantId: EQUA_TENANT_ID, date, now: at(date, "22:00"), trigger: "catch_up" }))).rejects.toThrow(/setelah kas harian ditutup/);
    await t.db.insert(cashDays).values({ tenantId: EQUA_TENANT_ID, businessDate: date, status: "closed", closedAt: at(date, "21:00"), closedLate: false });
    // Job cadangan berjalan 2 jam setelah tutup kas → terbit terlambat (> 30 menit).
    const res = await m9.publishPendingSummaries(at(date, "23:00"));
    expect(res.published).toContain(`${EQUA_TENANT_ID}:${date}`);
    const [s] = await t.db.select().from(dailySummaries).where(and(eq(dailySummaries.tenantId, EQUA_TENANT_ID), eq(dailySummaries.businessDate, date)));
    expect(s).toMatchObject({ status: "published", publishedLate: true });
    expect(s!.cashClosedAt!.toISOString()).toBe(at(date, "21:00").toISOString());
    expect(s!.publishedAt!.toISOString()).toBe(at(date, "23:00").toISOString());
    // Idempoten: job berikutnya tidak menerbitkan ulang.
    expect((await m9.publishPendingSummaries(at(date, "23:05"))).published).not.toContain(`${EQUA_TENANT_ID}:${date}`);
    const dash = await m9.getDailyDashboard(owner(at(addDays(date, 1), "08:00")), { date });
    expect(dash.status).toMatchObject({ status: "published", publishedLate: true, publishMinutes: 120 });
    // Pemilik menandai Ditinjau; Admin Keuangan tidak berhak.
    await expect(m9.markSummaryReviewed(finance(at(date, "23:10")), { date })).rejects.toThrow(/izin|berhak/i);
    const reviewed = await m9.markSummaryReviewed(owner(at(date, "23:10")), { date });
    expect(reviewed.status).toBe("reviewed");
  });

  it("US-M9-01 KP-5 akses ditolak untuk peran tanpa izin (Dispatcher) dan tanggal masa depan ditolak", async () => {
    await expect(m9.getDailyDashboard(dispatcher(at(D)), {})).rejects.toThrow(/izin|berhak/i);
    await expect(m9.getDailyDashboard(owner(at(D)), { date: addDays(D, 1) })).rejects.toThrow(/belum terjadi/);
  });
});

describe("M9 — H+0 terbit dari tutup kas nyata, addenda & keputusan selisih (US-M9-01 KP-2/KP-4/KP-6)", () => {
  it("US-M9-01 KP-2 US-M9-01 KP-6 cash_day.closed → H+0 terbit terkunci ≤ 30 menit + notifikasi pemilik; data terlambat sinkron & koreksi menjadi addenda bertanda, snapshot tidak berubah", async () => {
    const { db, close } = await createTestDb({ seed: true });
    try {
      bootstrapForTests();
      const { setDbForTests } = await import("@/db/client");
      setDbForTests(db);
      const date = toBusinessDate(new Date());
      await isolateCashDays(db, date);
      const d = await driverDay(db, { trips: 1 });
      await m4.receiveDeposit(m4Finance(at(date, "19:10")), { depositId: d.depositId, receivedAmount: PRICE });
      const screen = await m4.getCashDayScreen(m4Finance(at(date, "19:30")));
      expect(screen.openBlockers).toEqual([]);
      expect(screen.canClose).toBe(true);
      await m4.closeCashDay(m4Finance(at(date, "19:40")), { officeCashPhysical: screen.officeCashSystem });

      const [s] = await db.select().from(dailySummaries).where(eq(dailySummaries.businessDate, date));
      expect(s).toMatchObject({ status: "published", publishedLate: false });
      expect(s!.cashClosedAt!.toISOString()).toBe(at(date, "19:40").toISOString());
      expect(s!.publishedAt!.getTime() - s!.cashClosedAt!.getTime()).toBeLessThanOrEqual(30 * 60_000);
      const snap = s!.snapshot as unknown as m9.DailySnapshot;
      expect(snap.revenue.L2.amount).toBe(PRICE);
      expect(snap.cash.cashDayStatus).toBe("closed");
      const notes = await db.select().from(notifications).where(and(eq(notifications.event, "daily_summary.published"), eq(notifications.objectId, s!.id)));
      expect(notes.map((n) => n.recipientUserId)).toContain(userIdByUsername("pemilik"));
      expect(notes[0]!.body).toMatch(/Kas ditutup 19\.40 · H\+0 terbit 19\.40 \(0 menit\)/);
      expect(notes[0]!.link).toBe(`/laporan/hari-ini?tanggal=${date}`);

      // Transaksi terlambat sinkron (rit Selesai bertanggal hari itu) setelah terbit → addendum, angka H+0 tetap.
      const truck = await createTruck(db);
      const trip = await makeTrip(db, { date, truckId: truck.id, price: 300_000, lateSync: true });
      await withTx(async (tx) => {
        await emit(
          tx,
          "trip.completed",
          {
            tripId: trip.id,
            orderId: trip.orderId,
            customerId: trip.customerId,
            truckId: truck.id,
            driverUserId: null,
            isInternal: false,
            volumeL: 5000,
            price: 300_000,
            paymentMethod: "cash",
            cashReceived: 300_000,
            transferAmount: 0,
            creditAmount: 0,
            underpaymentAmount: 0,
            completedAt: at(date, "17:00").toISOString(),
            recordedByOffice: false,
            lateSync: true,
            tripNumber: trip.number,
            businessDate: date,
          },
          { tenantId: EQUA_TENANT_ID, businessDate: date, occurredAt: at(date, "20:30") },
        );
      });
      const addenda = await db.select().from(dailySummaryAddenda).where(eq(dailySummaryAddenda.dailySummaryId, s!.id));
      expect(addenda).toHaveLength(1);
      expect(addenda[0]).toMatchObject({ kind: "late_sync", objectType: "trip", objectId: trip.id, businessDate: date });
      expect(addenda[0]!.delta).toMatchObject({ revenue: { L2: 300_000 } });
      const [after] = await db.select().from(dailySummaries).where(eq(dailySummaries.id, s!.id));
      expect(after!.snapshot).toEqual(s!.snapshot);
      const dash = await m9.getDailyDashboard(owner(at(date, "21:00")), { date });
      expect(dash.unclosed).toBe(false);
      expect(dash.data.revenue.L2.amount).toBe(PRICE);
      expect(dash.addenda.map((a) => a.kindLabel)).toEqual(["Terlambat sinkron"]);
      // Angka berjalan (live) memang berubah — tetapi tidak menimpa snapshot terbit.
      const live = await m9.revenueForRange(db, EQUA_TENANT_ID, date, date);
      expect(live.L2.amount).toBe(PRICE + 300_000);
      // Kiriman ulang event yang sama tidak menggandakan addendum (idempoten).
      await withTx(async (tx) => {
        await m9.addendumFromEvent(
          { id: "x", seq: 0, type: "trip.completed", payload: { tripId: trip.id, orderId: trip.orderId, customerId: trip.customerId, truckId: truck.id, driverUserId: null, isInternal: false, volumeL: 5000, price: 300_000, paymentMethod: "cash", cashReceived: 0, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0, completedAt: "", recordedByOffice: false, lateSync: true, businessDate: date }, occurredAt: at(date, "20:40"), businessDate: date, tenantId: EQUA_TENANT_ID, actorUserId: null, source: null, objectType: null, objectId: null },
          tx,
        );
      });
      expect(await db.select().from(dailySummaryAddenda).where(eq(dailySummaryAddenda.dailySummaryId, s!.id))).toHaveLength(1);

      // Koreksi (void setelah tutup shift) dicatat BESOK atas transaksi hari itu → addendum pada tanggal asal,
      // tampil pada tanggal koreksi dengan rujukan hari asal (7.9.7).
      const saleId = await makeSale(db, { outletCode: "D01", date, total: 25_000, gallons: 5 });
      const tomorrow = addDays(date, 1);
      await withTx(async (tx) => {
        await emit(
          tx,
          "pos_sale.voided",
          { posSaleId: saleId, outletId: outletId("D01"), outletKind: "depot", shiftId: "00000000-0000-7000-8000-000000000000", method: "cash", total: 25_000, reason: "Salah produk", afterClose: true, reversalId: saleId, businessDate: tomorrow },
          { tenantId: EQUA_TENANT_ID, businessDate: tomorrow, occurredAt: at(tomorrow, "09:00") },
        );
      });
      const corr = (await db.select().from(dailySummaryAddenda).where(eq(dailySummaryAddenda.dailySummaryId, s!.id))).find((a) => a.kind === "correction")!;
      expect(corr).toMatchObject({ businessDate: date, recordedOn: tomorrow, objectType: "pos_sale" });
      const next = await m9.getDailyDashboard(owner(at(tomorrow, "10:00")), {});
      expect(next.correctionsRecorded.map((c) => c.businessDate)).toContain(date);
    } finally {
      const { setDbForTests } = await import("@/db/client");
      setDbForTests(null);
      await close();
    }
  });

  it("US-M9-01 KP-4 setujui/tolak penjelasan selisih langsung dari H+0 (satu ketuk; alasan wajib bila menolak; hanya pemilik)", async () => {
    const { db, close } = await createTestDb({ seed: true });
    const { setDbForTests } = await import("@/db/client");
    try {
      bootstrapForTests();
      setDbForTests(db);
      const date = toBusinessDate(new Date());
      const a = await driverDay(db, { trips: 1 });
      await m4.receiveDeposit(m4Finance(at(date, "19:10")), { depositId: a.depositId, receivedAmount: PRICE - 60_000, discrepancyReason: "wrong_change" });
      const pending = await m9.getDailyDashboard(owner(at(date, "19:20")), {});
      const disc = pending.pendingDiscrepancies.find((x) => x.depositId === a.depositId)!;
      expect(disc).toMatchObject({ amount: -60_000 });
      await expect(m9.decideDiscrepancyFromDashboard(owner(at(date, "19:21")), { discrepancyId: disc.id, decision: "reject" })).rejects.toThrow(/Alasan wajib/);
      await expect(m9.decideDiscrepancyFromDashboard(finance(at(date, "19:21")), { discrepancyId: disc.id, decision: "approve" })).rejects.toThrow(/izin|berhak|tidak dapat/i);
      await m9.decideDiscrepancyFromDashboard(owner(at(date, "19:22")), { discrepancyId: disc.id, decision: "approve" });
      const [row] = await db.select().from(discrepancies).where(eq(discrepancies.id, disc.id));
      expect(row).toMatchObject({ decision: "approved", status: "done" });
      const after = await m9.getDailyDashboard(owner(at(date, "19:23")), {});
      expect(after.pendingDiscrepancies.find((x) => x.id === disc.id)).toBeUndefined();
      // Tolak dengan alasan → dikembalikan ke Admin Keuangan.
      const b = await driverDay(db, { trips: 1 });
      await m4.receiveDeposit(m4Finance(at(date, "19:30")), { depositId: b.depositId, receivedAmount: PRICE - 70_000, discrepancyReason: "wrong_change" });
      const d2 = (await m9.getDailyDashboard(owner(at(date, "19:31")), {})).pendingDiscrepancies.find((x) => x.depositId === b.depositId)!;
      await m9.decideDiscrepancyFromDashboard(owner(at(date, "19:32")), { discrepancyId: d2.id, decision: "reject", reason: "Uang kembalian tidak masuk akal" });
      const [row2] = await db.select().from(discrepancies).where(eq(discrepancies.id, d2.id));
      expect(row2!.decision).toBe("rejected");
    } finally {
      setDbForTests(null);
      await close();
    }
  });
});
