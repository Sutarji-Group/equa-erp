import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accountingPeriods, notifications, reportSnapshots } from "@/db/schema";
import { EQUA_TENANT_ID, accountId, userIdByUsername, waterSourceId } from "@/db/seed";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import * as flags from "@/server/core/flags";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createTruck } from "../helpers/fixtures";
import { accountant, at, dispatcher, finance, makeFill, makeTrip, makeTripExpense, owner, postJ } from "./helpers";

const M = "2026-05";
const NOW = at("2026-06-05", "09:00");

async function period(db: ReturnType<typeof useTestDb>["db"], month: string) {
  return (await db.select().from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, EQUA_TENANT_ID), eq(accountingPeriods.period, month))))[0]!;
}

describe("M9 — laporan bulanan laba kotor per lini & konsolidasi (US-M9-02)", () => {
  const t = useTestDb({ seed: true });
  let trip: Awaited<ReturnType<typeof makeTrip>>;

  beforeAll(async () => {
    bootstrapForTests();
    trip = await makeTrip(t.db, { date: "2026-05-12", price: 1_000_000 });
    // Mei 2026: L2 omzet 1.000.000 + transfer internal L2→L3 150.000; L3 400.000; L4 300.000 (HPP 180.000);
    // BBM truk 200.000; biaya produksi air L1 600.000 (SA1) + 400.000 (SA2); beban gaji 50.000.
    await postJ({ date: "2026-05-12", sourceObject: { type: "trip", id: trip.id }, lines: [["1-1102", 1_000_000, 0], ["4-1101", 0, 1_000_000]] });
    await postJ({ date: "2026-05-13", lines: [["1-1103", 400_000, 0], ["4-1201", 0, 400_000]] });
    await postJ({ date: "2026-05-14", lines: [["1-1104", 300_000, 0], ["4-1301", 0, 300_000], ["5-1101", 180_000, 0], ["1-1501", 0, 180_000]] });
    await postJ({ date: "2026-05-15", lines: [["5-1301", 200_000, 0], ["1-1102", 0, 200_000]] });
    await postJ({ date: "2026-05-16", lines: [["5-1201", 150_000, 0], ["4-1501", 0, 150_000]] });
    await postJ({ date: "2026-05-17", lines: [["6-1101", 50_000, 0], ["1-1101", 0, 50_000]] });
    await postJ({
      date: "2026-05-18",
      lines: [
        ["5-1401", 600_000, 0, { waterSourceId: waterSourceId("SA1") }],
        ["5-1401", 400_000, 0, { waterSourceId: waterSourceId("SA2") }],
        ["1-1201", 0, 1_000_000],
      ],
    });
    await postJ({ date: "2026-05-19", kind: "manual", description: "Koreksi manual beban lain", lines: [["6-9101", 20_000, 0], ["1-1101", 0, 20_000]] });
    // April 2026 (pembanding + PKP) dan Mei 2025 (tahun lalu).
    await postJ({ date: "2026-04-10", lines: [["1-1102", 4_000_000_000, 0], ["4-1101", 0, 4_000_000_000]] });
    await postJ({ date: "2025-05-10", lines: [["1-1103", 250_000, 0], ["4-1201", 0, 250_000]] });
    // Liter pengisian M8 bulan Mei: SA1 20.000 L, SA2 10.000 L.
    const truck = await createTruck(t.db);
    await makeFill(t.db, { sourceId: waterSourceId("SA1"), truckId: truck.id, date: "2026-05-18", volumeL: 20_000 });
    await makeFill(t.db, { sourceId: waterSourceId("SA2"), truckId: truck.id, date: "2026-05-19", volumeL: 10_000 });
  });

  it("US-M9-02 KP-1 per lini L1–L5: omzet, biaya langsung, laba kotor, marjin; konsolidasi mengeliminasi transfer internal (BR-33)", async () => {
    const r = await m9.getMonthlyReport(owner(NOW), { month: M });
    expect(r.source).toBe("journals");
    const line = (pc: string) => r.lines.find((l) => l.profitCenter === pc)!;
    expect(r.lines.map((l) => l.profitCenter)).toEqual(["L1", "L2", "L3", "L4", "L5", "SHARED"]);
    expect(line("L2")).toMatchObject({ revenue: 1_150_000, directCost: 200_000, grossProfit: 950_000, internalRevenue: 150_000 });
    expect(line("L3")).toMatchObject({ revenue: 400_000, directCost: 150_000, grossProfit: 250_000, internalCost: 150_000 });
    expect(line("L4")).toMatchObject({ revenue: 300_000, directCost: 180_000, grossProfit: 120_000, marginPct: 40 });
    expect(line("L1")).toMatchObject({ revenue: 0, directCost: 1_000_000, marginPct: null });
    expect(line("L5")).toMatchObject({ revenue: 0, directCost: 0, grossProfit: 0 });
    expect(line("SHARED").operatingExpense).toBe(70_000);
    // Konsolidasi: transfer internal 150.000 dieliminasi dari omzet DAN biaya → laba tidak dihitung ganda.
    expect(r.consolidated).toMatchObject({ revenue: 1_700_000, directCost: 1_380_000, grossProfit: 320_000, eliminatedRevenue: 150_000, eliminatedCost: 150_000, operatingExpense: 70_000 });
    const sumLines = r.lines.reduce((s, l) => s + l.grossProfit, 0);
    expect(sumLines).toBe(r.consolidated.grossProfit);
    // BR-29/BR-30: omzet bruto per lini (tanpa transfer internal) + pemantauan PKP 12 bulan berjalan.
    expect(r.grossRevenueByLine).toMatchObject({ L2: 1_000_000, L3: 400_000, L4: 300_000 });
    expect(r.pkp).toMatchObject({ twelveMonthRevenue: 4_001_700_000, threshold: 4_800_000_000, pct: 83.37, reached: 80 });
    expect(r.pkp.months).toHaveLength(12);
    // Akuntan (baca-saja) berhak; Dispatcher tidak.
    await expect(m9.getMonthlyReport(accountant(NOW), { month: M })).resolves.toMatchObject({ month: M });
    await expect(m9.getMonthlyReport(dispatcher(NOW), { month: M })).rejects.toThrow(/tidak diizinkan/);
    await expect(m9.getMonthlyReport(owner(NOW), { month: "2026-13" })).rejects.toThrow();
  });

  it("US-M9-02 KP-3 perbandingan dengan bulan sebelumnya dan bulan yang sama tahun lalu (bila datanya ada)", async () => {
    const r = await m9.getMonthlyReport(owner(NOW), { month: M });
    expect(r.comparison.previous).toMatchObject({ month: "2026-04", revenue: 4_000_000_000 });
    expect(r.comparison.previous!.byLine.L2.revenue).toBe(4_000_000_000);
    expect(r.comparison.lastYear).toMatchObject({ month: "2025-05", revenue: 250_000 });
    const april = await m9.getMonthlyReport(owner(NOW), { month: "2026-04" });
    expect(april.comparison.lastYear).toBeNull();
    expect(april.comparison.previous).toBeNull();
  });

  it("US-M9-02 KP-4 setiap angka turun ke akun lalu ke transaksi sumber (rit, jurnal manual)", async () => {
    const ctx = owner(NOW);
    const l2 = await m9.monthlyDrilldown(ctx, { month: M, profitCenter: "L2" });
    expect(l2.accounts.find((a) => a.code === "4-1101")).toMatchObject({ cls: "revenue", amount: 1_000_000, internal: false });
    expect(l2.accounts.find((a) => a.code === "4-1501")).toMatchObject({ internal: true, amount: 150_000 });
    expect(l2.accounts.find((a) => a.code === "5-1301")).toMatchObject({ cls: "direct", amount: 200_000 });
    const rev = await m9.monthlyDrilldown(ctx, { month: M, profitCenter: "L2", accountId: accountId("4-1101") });
    expect(rev.journals).toHaveLength(1);
    expect(rev.journals[0]).toMatchObject({ amount: 1_000_000, sourceRef: `Rit ${trip.number}`, sourceHref: `/pesanan/${trip.orderId}` });
    const manual = await m9.monthlyDrilldown(ctx, { month: M, accountId: accountId("6-9101") });
    expect(manual.journals[0]).toMatchObject({ kind: "manual", sourceRef: "Jurnal manual", amount: 20_000 });
    expect(manual.accounts.find((a) => a.code === "6-9101")!.cls).toBe("operating");
    await expect(m9.monthlyDrilldown(dispatcher(NOW), { month: M })).rejects.toThrow(/tidak diizinkan/);
  });

  it("US-M9-02 KP-6 biaya produksi air per liter L1 = biaya L1 ÷ liter pengisian, per sumber dan gabungan, dengan tren bulanan", async () => {
    const r = await m9.getMonthlyReport(owner(NOW), { month: M });
    const sa1 = r.waterCost.perSource.find((s) => s.code === "SA1")!;
    const sa2 = r.waterCost.perSource.find((s) => s.code === "SA2")!;
    expect(sa1).toMatchObject({ cost: 600_000, liters: 20_000, costPerLiter: 30 });
    expect(sa2).toMatchObject({ cost: 400_000, liters: 10_000, costPerLiter: 40 });
    expect(r.waterCost.combined).toMatchObject({ cost: 1_000_000, liters: 30_000, costPerLiter: 33.33 });
    expect(r.waterCostTrend.at(-1)).toMatchObject({ month: M, costPerLiter: 33.33 });
    expect(r.waterCostTrend.length).toBeGreaterThanOrEqual(2);
  });

  it("US-M9-02 KP-2 Sementara sampai periode Dikunci, lalu Final tersimpan (+ notifikasi); tenggat PAR-23 tanggal 10; perubahan setelah Final hanya lewat periode berikutnya (BR-32)", async () => {
    const early = await m9.getMonthlyReport(owner(NOW), { month: M });
    expect(early).toMatchObject({ status: "provisional", statusLabel: "Sementara", final: null, availability: { deadline: "2026-06-10", late: false } });
    const late = await m9.getMonthlyReport(owner(at("2026-06-11", "09:00")), { month: M });
    expect(late.availability.late).toBe(true);

    // Ditutup Admin Keuangan → masih Sementara (Final hanya setelah Dikunci, BR-32 / 7.9.3).
    const p = await period(t.db, M);
    await t.db.update(accountingPeriods).set({ status: "closed", closedAt: at("2026-06-08", "10:00") }).where(eq(accountingPeriods.id, p.id));
    const closed = await m9.getMonthlyReport(owner(at("2026-06-08", "11:00")), { month: M });
    expect(closed.status).toBe("provisional");
    expect(closed.statusNote).toMatch(/menunggu dikunci pemilik/);

    // Dikunci pemilik → event period.locked → versi Final tersimpan + notifikasi pemilik.
    await withTx(async (tx) => {
      await tx.update(accountingPeriods).set({ status: "locked", lockedAt: at("2026-06-09", "10:00") }).where(eq(accountingPeriods.id, p.id));
      await emit(tx, "period.locked", { periodId: p.id, period: M, lockedBy: userIdByUsername("pemilik") }, { tenantId: EQUA_TENANT_ID, businessDate: "2026-06-09", occurredAt: at("2026-06-09", "10:00") });
    });
    const snaps = await t.db.select().from(reportSnapshots).where(and(eq(reportSnapshots.reportKey, m9.MONTHLY_REPORT_KEY), eq(reportSnapshots.period, M)));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ status: "final", revision: 1, supersededById: null });
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "monthly_report.final"), eq(notifications.objectId, snaps[0]!.id)));
    expect(notes.map((n) => n.recipientUserId)).toContain(userIdByUsername("pemilik"));
    const final = await m9.getMonthlyReport(owner(at("2026-06-09", "11:00")), { month: M });
    expect(final).toMatchObject({ status: "final", statusLabel: "Final", final: { snapshotId: snaps[0]!.id, revision: 1 }, availability: { late: false } });
    expect(final.consolidated.grossProfit).toBe(320_000);

    // Transaksi Mei yang datang setelah dikunci → jurnal masuk periode Juni (originPeriod Mei); Final Mei tidak berubah.
    const moved = await postJ({ date: "2026-05-28", lines: [["1-1103", 90_000, 0], ["4-1201", 0, 90_000]] });
    expect(moved).toMatchObject({ period: "2026-06", originPeriod: M });
    const again = await m9.getMonthlyReport(owner(at("2026-06-12", "09:00")), { month: M });
    expect(again.final!.snapshotId).toBe(snaps[0]!.id);
    expect(again.consolidated.revenue).toBe(1_700_000);
    const june = await m9.getMonthlyReport(owner(at("2026-06-12", "09:00")), { month: "2026-06" });
    expect(june.lines.find((l) => l.profitCenter === "L3")!.revenue).toBe(90_000);
    // Job cadangan idempoten: tidak membuat Final baru.
    expect((await m9.finalizeLockedPeriods(at("2026-06-12", "06:30"))).finalized).not.toContain(`${EQUA_TENANT_ID}:${M}`);

    // Dibuka kembali → Sementara (Final lama tetap tersimpan); dikunci ulang → revisi 2, revisi 1 tetap ada.
    await t.db.update(accountingPeriods).set({ status: "reopened", revision: 2 }).where(eq(accountingPeriods.id, p.id));
    const reopened = await m9.getMonthlyReport(owner(at("2026-06-13", "09:00")), { month: M });
    expect(reopened).toMatchObject({ status: "provisional", final: null });
    expect(reopened.previousFinals.map((f) => f.revision)).toEqual([1]);
    await postJ({ date: "2026-05-29", lines: [["1-1104", 10_000, 0], ["4-1301", 0, 10_000]] });
    await t.db.update(accountingPeriods).set({ status: "locked", lockedAt: at("2026-06-14", "10:00") }).where(eq(accountingPeriods.id, p.id));
    const res = await m9.finalizeLockedPeriods(at("2026-06-15", "06:30"));
    expect(res.finalized).toContain(`${EQUA_TENANT_ID}:${M}`);
    const rev2 = await m9.getMonthlyReport(owner(at("2026-06-15", "09:00")), { month: M });
    expect(rev2.final!.revision).toBe(2);
    expect(rev2.consolidated.revenue).toBe(1_710_000);
    expect(rev2.previousFinals.map((f) => f.revision)).toEqual([1]);
    const [old] = await t.db.select().from(reportSnapshots).where(eq(reportSnapshots.id, snaps[0]!.id));
    expect(old!.supersededById).toBe(rev2.final!.snapshotId);
    expect((old!.data as { consolidated: { revenue: number } }).consolidated.revenue).toBe(1_700_000);
  });

  it("US-M9-02 KP-5 M11 belum aktif: omzet operasional per lini + biaya yang sudah tercatat, berlabel belum lengkap", async () => {
    const truck = await createTruck(t.db);
    const tr = await makeTrip(t.db, { date: "2026-03-10", truckId: truck.id, price: 250_000 });
    await makeTripExpense(t.db, { truckId: truck.id, tripId: tr.id, date: "2026-03-10", amount: 40_000 });
    await flags.set(owner(NOW), "accounting.m11_active", false, { reason: "Uji: akuntansi menyusul (R04)" });
    try {
      const r = await m9.getMonthlyReport(finance(NOW), { month: "2026-03" });
      expect(r).toMatchObject({ source: "operational", incomplete: true, status: "provisional" });
      expect(r.incompleteNote).toMatch(/Belum lengkap — M11 belum aktif/);
      const l2 = r.lines.find((l) => l.profitCenter === "L2")!;
      expect(l2).toMatchObject({ revenue: 250_000, directCost: 40_000, grossProfit: 210_000 });
      expect(r.waterCost.combined.costPerLiter).toBeNull();
    } finally {
      await flags.set(owner(NOW), "accounting.m11_active", true, { reason: "Uji selesai: M11 aktif kembali" });
    }
    const on = await m9.getMonthlyReport(owner(NOW), { month: "2026-03" });
    expect(on).toMatchObject({ source: "journals", incomplete: false, incompleteNote: null });
  });
});
