import { beforeAll, describe, expect, it } from "vitest";

import { EQUA_TENANT_ID } from "@/db/seed";
import { exportReport } from "@/server/core/export";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createTruck } from "../helpers/fixtures";
import { at, finance, makeInvoice, makeSale, makeTrip, owner, payInvoice } from "./helpers";

const NOW = at("2026-03-18", "21:00");

describe("M9 — tren mingguan/bulanan (US-M9-06)", () => {
  const t = useTestDb({ seed: true });
  let truckCode: string;

  beforeAll(async () => {
    bootstrapForTests();
    const truck = await createTruck(t.db);
    truckCode = truck.code;
    await makeTrip(t.db, { date: "2026-03-02", truckId: truck.id, price: 100_000 });
    await makeTrip(t.db, { date: "2026-03-09", truckId: truck.id, price: 200_000 });
    await makeTrip(t.db, { date: "2026-03-16", truckId: truck.id, price: 300_000 });
    await makeTrip(t.db, { date: "2026-02-20", truckId: truck.id, price: 150_000 });
    await makeTrip(t.db, { date: "2026-03-17", truckId: truck.id, price: 120_000, internal: true });
    await makeSale(t.db, { outletCode: "D01", date: "2026-03-10", total: 20_000, gallons: 4 });
    await makeSale(t.db, { outletCode: "D01", date: "2026-03-17", total: 30_000, gallons: 6 });
    const inv = await makeInvoice(t.db, { issueDate: "2026-02-01", dueDate: "2026-02-15", amount: 400_000 });
    await makeInvoice(t.db, { issueDate: "2026-03-16", dueDate: "2026-03-30", amount: 100_000 });
    await payInvoice(t.db, { invoiceId: inv.id, customerId: inv.customerId, amount: 100_000, date: "2026-03-17" });
  });

  it("US-M9-06 KP-1 grafik & tabel 13 periode (minggu/bulan): omzet per lini, rit per truk, galon per depot, piutang (saldo, % lewat tempo) + perbandingan periode sebelumnya", async () => {
    const week = await m9.getTrend(owner(NOW), { granularity: "week" });
    expect(week.points).toHaveLength(13);
    const last = week.points.at(-1)!;
    const prev = week.points.at(-2)!;
    expect(last).toMatchObject({ key: "2026-03-16", from: "2026-03-16", to: "2026-03-18", L2: 300_000, L3: 30_000, external: 330_000, internal: 120_000, tripsCompleted: 2, gallons: 6 });
    expect(prev).toMatchObject({ key: "2026-03-09", from: "2026-03-09", to: "2026-03-15", L2: 200_000, L3: 20_000, gallons: 4 });
    expect(last.byTruck[truckCode]).toBe(2);
    expect(last.byDepot.D01).toBe(6);
    expect(week.trucks).toContain(truckCode);
    expect(week.depots).toContain("D01");
    // Piutang per akhir periode: 300.000 lewat tempo + 100.000 belum jatuh tempo.
    expect(last).toMatchObject({ receivableBalance: 400_000, overduePct: 75 });
    expect(prev).toMatchObject({ receivableBalance: 400_000, overduePct: 100 });
    expect(week.change).toMatchObject({ L2: 50, L3: 50, gallons: 50, receivableBalance: 0, overduePct: -25 });
    // Label minggu tanpa tahun; senin berurutan 7 hari.
    expect(week.points.map((p) => p.key).slice(-3)).toEqual(["2026-03-02", "2026-03-09", "2026-03-16"]);

    const month = await m9.getTrend(owner(NOW), { granularity: "month" });
    expect(month.points).toHaveLength(13);
    expect(month.points.at(-1)).toMatchObject({ key: "2026-03", label: "Mar 26", from: "2026-03-01", to: "2026-03-18", L2: 600_000, L3: 50_000 });
    expect(month.points.at(-2)).toMatchObject({ key: "2026-02", label: "Feb 26", L2: 150_000 });
    expect(month.change.L2).toBe(300);
    expect(month.points[0]!.key).toBe("2025-03");
  });

  it("US-M9-06 KP-2 definisi ukuran sama dengan H+0 dan laporan bulanan (satu definisi omzet)", async () => {
    const week = await m9.getTrend(owner(NOW), { granularity: "week" });
    const direct = await m9.revenueForRange(t.db, EQUA_TENANT_ID, week.points[0]!.from, "2026-03-18");
    expect(week.points.reduce((s, p) => s + p.external, 0)).toBe(direct.external);
    const month = await m9.getTrend(owner(NOW), { granularity: "month" });
    const h0Month = await m9.getDailyDashboard(owner(NOW), { range: "month" });
    const pt = month.points.at(-1)!;
    expect(pt.L2).toBe(h0Month.data.revenue.L2.amount);
    expect(pt.L3).toBe(h0Month.data.revenue.L3.amount);
    expect(pt.tripsCompleted).toBe(h0Month.data.trips.totals.completed);
    expect(pt.gallons).toBe(h0Month.data.gallons.total);
    expect(pt.receivableBalance).toBe(h0Month.data.receivables.balance);
    const monthly = await m9.getMonthlyReport(owner(NOW), { month: "2026-03" });
    expect(monthly.operational.L2.amount).toBe(pt.L2);
    expect(monthly.operational.external).toBe(pt.external);
  });

  it("US-M9-06 KP-3 ekspor Excel/PDF sesuai US-M9-03; hanya pemilik", async () => {
    const x = await exportReport(owner(NOW), "m9.trend_weekly", "xlsx", { to: "2026-03-18" });
    expect(x.rowCount).toBe(13);
    const p = await exportReport(owner(NOW), "m9.trend_monthly", "pdf", { to: "2026-03-18" });
    expect(p.body.subarray(0, 4).toString()).toBe("%PDF");
    await expect(m9.getTrend(finance(NOW), { granularity: "week" })).rejects.toThrow(/tidak diizinkan/);
    await expect(exportReport(finance(NOW), "m9.trend_weekly", "xlsx", {})).rejects.toThrow(/tidak diizinkan/);
  });
});
