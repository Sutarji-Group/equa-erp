import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { complaints, customerAccounts, deposits, discrepancies, fleetEvents, orders, shifts, trips, tripRatings, truckDaySummaries } from "@/db/schema";
import { EQUA_TENANT_ID, employeeId, outletId, userIdByUsername } from "@/db/seed";
import * as m9 from "@/server/modules/m9-reports";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createDeposit, createTruck } from "../helpers/fixtures";
import { accountant, at, dispatcher, finance, makeSale, makeTrip, makeTripExpense, owner } from "./helpers";

const M = "2026-04";
const NOW = at("2026-05-05", "09:00");
const A = { emp: employeeId("EQ-009"), user: userIdByUsername("sopir1") };
const B = { emp: employeeId("EQ-010"), user: userIdByUsername("sopir2") };

describe("M9 — kinerja sopir/truk & depot/operator (US-M9-05)", () => {
  const t = useTestDb({ seed: true });
  let truckA: string;
  let truckB: string;

  beforeAll(async () => {
    bootstrapForTests();
    truckA = (await createTruck(t.db)).id;
    truckB = (await createTruck(t.db)).id;
    const drv = (d: typeof A, truckId: string) => ({ truckId, driverEmployeeId: d.emp, driverUserId: d.user });
    // Sopir A: 4 rit Selesai (1 tepat waktu, 1 terlambat > 60 menit, 1 parsial, 1 menyimpang > 1 km) + 1 gagal.
    const onTime = await makeTrip(t.db, { date: "2026-04-10", ...drv(A, truckA), completedTime: "09:30" });
    const late = await makeTrip(t.db, { date: "2026-04-10", ...drv(A, truckA), completedTime: "13:00" });
    await t.db.update(orders).set({ requestedTime: "09:00" }).where(eq(orders.id, onTime.orderId));
    await t.db.update(orders).set({ requestedTime: "10:00" }).where(eq(orders.id, late.orderId));
    const partial = await makeTrip(t.db, { date: "2026-04-11", ...drv(A, truckA) });
    await t.db.update(trips).set({ deliveredVolumeL: 3000, partialVolumeReason: "customer_tank_full" }).where(eq(trips.id, partial.id));
    const dev = await makeTrip(t.db, { date: "2026-04-12", ...drv(A, truckA) });
    await t.db.update(trips).set({ locationDeviation: "level2" }).where(eq(trips.id, dev.id));
    await makeTrip(t.db, { date: "2026-04-12", ...drv(A, truckA), status: "failed", failReason: "customer_refused" });
    // Sopir B: 2 rit Selesai tanpa kejadian.
    await makeTrip(t.db, { date: "2026-04-10", ...drv(B, truckB) });
    await makeTrip(t.db, { date: "2026-04-11", ...drv(B, truckB) });
    // Jarak tempuh (M12), kejadian BR-25, pengeluaran rit (M3).
    await t.db.insert(truckDaySummaries).values([
      { truckId: truckA, businessDate: "2026-04-10", distanceM: 42_300 },
      { truckId: truckA, businessDate: "2026-04-11", distanceM: 10_000 },
    ]);
    await t.db.insert(fleetEvents).values({ tenantId: EQUA_TENANT_ID, kind: "off_hours_trip", status: "explained", truckId: truckA, userId: A.user, businessDate: "2026-04-11", startedAt: at("2026-04-11", "21:00"), requiresExplanation: true, explanation: "Antar tandon darurat" });
    await t.db.insert(fleetEvents).values({ tenantId: EQUA_TENANT_ID, kind: "location_source_inconsistent", status: "detected", truckId: truckA, userId: A.user, tripId: dev.id, businessDate: "2026-04-12", startedAt: at("2026-04-12", "11:00") });
    await makeTripExpense(t.db, { truckId: truckA, date: "2026-04-11", amount: 75_000 });
    // Setoran & selisih: A selisih pada 10 April, setor terlambat 11 April; B setoran bersih.
    for (const [who, date] of [[A, "2026-04-10"], [A, "2026-04-11"], [A, "2026-04-12"], [B, "2026-04-10"], [B, "2026-04-11"]] as const) {
      await createDeposit(t.db, { date, status: "closed", depositorUserId: who.user, depositorEmployeeId: who.emp, truckId: who === A ? truckA : truckB, expectedCash: 250_000 });
    }
    await t.db.insert(discrepancies).values({ tenantId: EQUA_TENANT_ID, source: "driver", employeeId: A.emp, businessDate: "2026-04-10", amount: -20_000, status: "done", reason: "wrong_change" });
    await t.db.update(deposits).set({ submittedLate: true }).where(and(eq(deposits.depositorEmployeeId, A.emp), eq(deposits.businessDate, "2026-04-11")));
    // Depot D01 (operator depot01) & toko baru (kasir): penjualan, void, selisih kas shift.
    await makeSale(t.db, { outletCode: "D01", date: "2026-04-10", total: 25_000, gallons: 5, operatorUserId: userIdByUsername("depot01") });
    await makeSale(t.db, { outletCode: "D01", date: "2026-04-11", total: 15_000, gallons: 3, operatorUserId: userIdByUsername("depot01") });
    await makeSale(t.db, { outletCode: "D01", date: "2026-04-11", total: 10_000, gallons: 2, status: "voided", operatorUserId: userIdByUsername("depot01") });
    await makeSale(t.db, { outletCode: "D02", date: "2026-04-10", total: 30_000, gallons: 6, operatorUserId: userIdByUsername("depot02") });
    await makeSale(t.db, { outletCode: "TK1", date: "2026-04-10", total: 80_000, operatorUserId: userIdByUsername("kasir") });
    await t.db.update(shifts).set({ cashDifference: -5_000 }).where(and(eq(shifts.outletId, outletId("D01")), eq(shifts.businessDate, "2026-04-10")));
  });

  it("US-M9-05 KP-1 sopir/truk per bulan: terjadwal, selesai, gagal per alasan, tepat waktu ±60 menit, parsial, penyimpangan lokasi, BR-25, selisih, setor terlambat, jarak, pengeluaran rit", async () => {
    const r = await m9.getPerformance(owner(NOW), { month: M });
    expect(r).toMatchObject({ month: M, from: "2026-04-01", to: "2026-04-30", onTimeWindowMinutes: 60 });
    const a = r.drivers.find((d) => d.employeeId === A.emp)!;
    expect(a).toMatchObject({
      scheduled: 5,
      completed: 4,
      failed: 1,
      failedByReason: { "Pelanggan menolak": 1 },
      onTime: 1,
      onTimeEligible: 2,
      onTimePct: 50,
      partialVolume: 1,
      deviationOver200m: 1,
      deviationOver1km: 1,
      locationSourceInconsistent: 1,
      br25Events: 1,
      br25Explained: 1,
      br25Notes: ["Antar tandon darurat"],
      discrepancyCount: 1,
      discrepancyValue: -20_000,
      lateDeposits: 1,
      distanceKm: 52.3,
      completionPct: 80,
    });
    expect(a.truckCodes).toHaveLength(1);
    const truck = r.trucks.find((x) => x.truckId === truckA)!;
    expect(truck).toMatchObject({ scheduled: 5, completed: 4, failed: 1, distanceKm: 52.3, tripExpenses: 75_000, completionPct: 80 });
  });

  it("B-66 US-M9-05 KP-1 kinerja sopir/truk menampilkan agregat penilaian & keluhan pelanggan aplikasi (P2 ratingAggregates & complaintReport)", async () => {
    // Dua rit sopir A (truk A) dinilai 5 & 2, satu rit sopir B (truk B) dinilai 4; satu keluhan volume atas rit truk A.
    const r1 = await makeTrip(t.db, { date: "2026-04-14", truckId: truckA, driverEmployeeId: A.emp, driverUserId: A.user });
    const r2 = await makeTrip(t.db, { date: "2026-04-15", truckId: truckA, driverEmployeeId: A.emp, driverUserId: A.user });
    const r3 = await makeTrip(t.db, { date: "2026-04-15", truckId: truckB, driverEmployeeId: B.emp, driverUserId: B.user });
    for (const [trip, rating, phone] of [[r1, 5, "081300000661"], [r2, 2, "081300000662"], [r3, 4, "081300000663"]] as const) {
      const [acc] = await t.db.insert(customerAccounts).values({ tenantId: EQUA_TENANT_ID, phone, customerId: trip.customerId, status: "linked" }).returning();
      await t.db.insert(tripRatings).values({
        tenantId: EQUA_TENANT_ID,
        tripId: trip.id,
        customerAccountId: acc!.id,
        customerId: trip.customerId,
        truckId: trip.truckId,
        driverEmployeeId: trip.truckId === truckA ? A.emp : B.emp,
        rating,
        comment: "Komentar pelanggan tidak ikut laporan kinerja",
        createdAt: at("2026-04-16", "08:00"),
      });
    }
    await t.db.insert(complaints).values({ tenantId: EQUA_TENANT_ID, customerId: r2.customerId, tripId: r2.id, kind: "volume", description: "Volume kurang", assignedRole: "dispatcher", createdAt: at("2026-04-16", "09:00") });
    const r = await m9.getPerformance(owner(NOW), { month: M });
    const a = r.drivers.find((d) => d.employeeId === A.emp)!;
    const b = r.drivers.find((d) => d.employeeId === B.emp)!;
    expect(a).toMatchObject({ ratingCount: 2, ratingAverage: 3.5, lowRatings: 1 });
    expect(b).toMatchObject({ ratingCount: 1, ratingAverage: 4, lowRatings: 0 });
    const ta = r.trucks.find((x) => x.truckId === truckA)!;
    expect(ta).toMatchObject({ ratingCount: 2, ratingAverage: 3.5, complaintCount: 1, complaintKinds: { volume: 1 } });
    expect(r.trucks.find((x) => x.truckId === truckB)).toMatchObject({ ratingCount: 1, complaintCount: 0 });
    expect(r.customerFeedback).toMatchObject({ ratingCount: 3, complaints: 1, openComplaints: 1 });
    // Angka sama dengan fungsi P2 (satu definisi).
    const agg = await p2.ratingAggregates(t.db, { tenantId: EQUA_TENANT_ID, from: `${M}-01`, to: `${M}-30` });
    expect(r.customerFeedback.ratingAverage).toBe(agg.overall.average);
  });

  it("US-M9-05 KP-2 depot/operator per bulan: galon per hari, transaksi, void (jumlah, nilai), selisih kas, setoran terlambat", async () => {
    const r = await m9.getPerformance(owner(NOW), { month: M });
    const d01 = r.outlets.find((o) => o.code === "D01")!;
    expect(d01).toMatchObject({ kind: "depot", gallons: 8, gallonsPerDay: 4, transactions: 3, voidCount: 1, voidValue: 10_000, cashDifferenceCount: 1, cashDifferenceValue: -5_000 });
    expect(r.outlets.find((o) => o.code === "TK1")).toMatchObject({ kind: "store", sales: 80_000 });
    const op = r.operators.find((o) => o.userId === userIdByUsername("depot01"))!;
    expect(op).toMatchObject({ group: "depot_operator", groupLabel: expect.any(String), outlets: ["D01"], shifts: 2, gallons: 8, gallonsPerDay: 4, voidCount: 1, voidValue: 10_000, cashDifferenceCount: 1 });
  });

  it("US-M9-05 KP-3 deret hari tanpa selisih per orang (BR-12); peringkat hanya antar peran sebanding dan menampilkan zona/rute", async () => {
    const r = await m9.getPerformance(owner(NOW), { month: M });
    const a = r.drivers.find((d) => d.employeeId === A.emp)!;
    const b = r.drivers.find((d) => d.employeeId === B.emp)!;
    expect(a.daysWithoutDiscrepancy).toBe(2);
    expect(b.daysWithoutDiscrepancy).toBe(2);
    // Sopir diperingkat sesama sopir: B (100% selesai) di atas A (80%).
    expect(b.rank).toBeLessThan(a.rank);
    expect(r.drivers.map((d) => d.rank)).toEqual(r.drivers.map((_, i) => i + 1));
    expect(Array.isArray(a.zones)).toBe(true);
    // Operator depot & kasir toko diperingkat terpisah (masing-masing mulai dari 1).
    const depots = r.operators.filter((o) => o.group === "depot_operator");
    const cashiers = r.operators.filter((o) => o.group === "store_cashier");
    expect(depots.map((o) => o.rank).sort()).toEqual(depots.map((_, i) => i + 1));
    expect(cashiers.map((o) => o.rank)).toEqual([1]);
    expect(cashiers[0]!.userId).toBe(userIdByUsername("kasir"));
    // D02 (tanpa selisih/void) di atas D01.
    expect(depots.find((o) => o.userId === userIdByUsername("depot02"))!.rank).toBeLessThan(depots.find((o) => o.userId === userIdByUsername("depot01"))!.rank);
  });

  it("US-M9-05 KP-4 hanya pemilik; Admin Keuangan, Dispatcher, Akuntan ditolak", async () => {
    for (const ctx of [finance(NOW), dispatcher(NOW), accountant(NOW)]) {
      await expect(m9.getPerformance(ctx, { month: M })).rejects.toThrow(/tidak diizinkan/);
    }
  });
});
