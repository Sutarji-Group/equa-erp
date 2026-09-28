import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accountingPeriods, cashDays, exportLogs, parallelRunChecks, syncCommands, unitPaperWithdrawals } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { exportReport } from "@/server/core/export";
import * as m2 from "@/server/modules/m2-orders";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createTruck } from "../helpers/fixtures";
import { admin, at, dispatcher, earlyWithdrawalRequest, finance, makeSale, makeTrip, owner, postJ } from "./helpers";

const M = "2026-03";
const NOW = at("2026-04-03", "09:00");
const CODES = Array.from({ length: 11 }, (_, i) => `KPI-${String(i + 1).padStart(2, "0")}`);

describe("M9 — laporan KPI program KPI-01–KPI-11 & periode paralel (US-M9-07)", () => {
  const t = useTestDb({ seed: true });
  let truckWithdrawn: string;

  beforeAll(async () => {
    bootstrapForTests();
    const truck = await createTruck(t.db);
    // KPI-01/07: 3 rit Selesai (1 dicatat kantor) + 1 gagal + 1 transaksi POS di sumber.
    await makeTrip(t.db, { date: "2026-03-10", truckId: truck.id });
    await makeTrip(t.db, { date: "2026-03-10", truckId: truck.id });
    await makeTrip(t.db, { date: "2026-03-11", truckId: truck.id, recordedByOffice: true });
    await makeTrip(t.db, { date: "2026-03-11", truckId: truck.id, status: "failed" });
    await makeSale(t.db, { outletCode: "D01", date: "2026-03-10", total: 10_000, gallons: 2 });
    // KPI-02/08: dua hari kas ditutup (12 & 30 menit setelah setoran terakhir); H+0 hanya terbit tepat waktu hari pertama.
    await t.db.insert(cashDays).values([
      { tenantId: EQUA_TENANT_ID, businessDate: "2026-03-10", status: "closed", lastDepositReceivedAt: at("2026-03-10", "19:00"), closedAt: at("2026-03-10", "19:12") },
      { tenantId: EQUA_TENANT_ID, businessDate: "2026-03-11", status: "closed", lastDepositReceivedAt: at("2026-03-11", "19:00"), closedAt: at("2026-03-11", "19:30") },
    ]);
    await withTx((tx) => m9.publishDailySummary(tx, { tenantId: EQUA_TENANT_ID, date: "2026-03-10", now: at("2026-03-10", "19:20"), cashClosedAt: at("2026-03-10", "19:12"), trigger: "catch_up" }));
    // KPI-09: Februari dikunci tepat waktu (≤ 10 Maret).
    await postJ({ date: "2026-02-10", lines: [["1-1102", 100_000, 0], ["4-1101", 0, 100_000]] });
    await t.db.update(accountingPeriods).set({ status: "locked", lockedAt: at("2026-03-08", "10:00") }).where(and(eq(accountingPeriods.tenantId, EQUA_TENANT_ID), eq(accountingPeriods.period, "2026-02")));
    // KPI-11: 7 sopir aktif 10 Maret, 1 sopir aktif 11 Maret (perintah sinkron diterima).
    for (let i = 1; i <= 7; i++) {
      await t.db.insert(syncCommands).values({ id: newId(), tenantId: EQUA_TENANT_ID, userId: userIdByUsername(`sopir${i}`), type: "m3.trip.complete", payload: {}, businessDate: "2026-03-10", receivedAt: at("2026-03-10", "10:00"), status: "applied" });
    }
    await t.db.insert(syncCommands).values({ id: newId(), tenantId: EQUA_TENANT_ID, userId: userIdByUsername("sopir1"), type: "m3.trip.complete", payload: {}, businessDate: "2026-03-11", receivedAt: at("2026-03-11", "10:00"), status: "applied" });
    // Unit periode paralel: nota kertas ditarik pada hari ke-14 (batas NFR-35).
    truckWithdrawn = (await createTruck(t.db)).id;
    const w = await m9.startParallelPeriod(finance(at("2026-03-01", "07:00")), { unitType: "truck", truckId: truckWithdrawn, parallelStartDate: "2026-03-01" });
    await m9.withdrawPaper(finance(at("2026-03-14", "18:00")), { withdrawalId: w.id, withdrawnDate: "2026-03-14" });
  });

  it("US-M9-07 KP-1 satu halaman KPI: definisi & rumus PRD 1.3, nilai bulan berjalan, target BRD 2.3, status; riwayat bulanan", async () => {
    const page = await m9.getKpiReport(owner(NOW), { month: M });
    expect(page.month).toBe(M);
    const v = page.current.values;
    expect(v.map((x) => x.code)).toEqual(CODES);
    for (const x of v) {
      expect(x.formula.length, x.code).toBeGreaterThan(20);
      expect(x.target, x.code).toBeTruthy();
      expect(["met", "not_met", "baseline", "pending", "no_data"]).toContain(x.status);
    }
    const k = (code: string) => v.find((x) => x.code === code)!;
    expect(k("KPI-01")).toMatchObject({ value: 75, status: "not_met", target: "100%" });
    expect(k("KPI-02")).toMatchObject({ value: 21, display: "21 menit", status: "not_met", target: "≤ 15 menit" });
    expect(k("KPI-03")).toMatchObject({ value: 0, status: "met" });
    expect(k("KPI-05")).toMatchObject({ value: 100, status: "met" });
    // KPI-06 = definisi M2 (terlewat + batal dobel) — satu sumber.
    const k6 = await m2.kpi06Report(owner(NOW), M);
    expect(k("KPI-06")).toMatchObject({ value: k6.duplicateCancelled + k6.overdueUnscheduled, status: k6.duplicateCancelled + k6.overdueUnscheduled === 0 ? "met" : "not_met" });
    expect(k("KPI-07")).toMatchObject({ value: 75, status: "baseline" });
    expect(k("KPI-08")).toMatchObject({ value: 50, status: "not_met" });
    expect(k("KPI-09")).toMatchObject({ status: "pending", target: "≤ 2026-04-10" });
    // Riwayat bulanan (bawaan 12 bulan bila tanggal pilot belum diisi) — Februari dikunci tepat waktu.
    expect(page.history).toHaveLength(12);
    expect(page.history.at(-1)!.month).toBe(M);
    const feb = page.history.find((h) => h.month === "2026-02")!;
    expect(feb.values.find((x) => x.code === "KPI-09")).toMatchObject({ status: "met", display: "Final 2026-03-08" });
    // Hanya pemilik.
    await expect(m9.getKpiReport(finance(NOW), { month: M })).rejects.toThrow(/tidak diizinkan/);
    await expect(m9.getKpiReport(owner(NOW), { month: "2026-05" })).rejects.toThrow(/Bulan belum dimulai/);
  });

  it("US-M9-07 KP-2 KPI-10 diinput manual pemilik; KPI-11 dari pengguna aktif per peran + tanggal nota kertas ditarik per unit", async () => {
    await expect(m9.setOwnerHours(admin(NOW), { month: M, hoursPerWeek: 5 })).rejects.toThrow(/diisi pemilik/);
    await expect(m9.setOwnerHours(finance(NOW), { month: M, hoursPerWeek: 5 })).rejects.toThrow(/tidak diizinkan/);
    await expect(m9.setOwnerHours(owner(NOW), { month: M, hoursPerWeek: -1 })).rejects.toThrow(/tidak boleh negatif/);
    await m9.setOwnerHours(owner(NOW), { month: M, hoursPerWeek: 7, note: "Catatan buku saku" });
    await m9.setOwnerHours(owner(NOW), { month: M, hoursPerWeek: 6.5, note: "Revisi setelah cek ulang" });
    const page = await m9.getKpiReport(owner(NOW), { month: M });
    const k10 = page.current.values.find((x) => x.code === "KPI-10")!;
    expect(k10).toMatchObject({ value: 6.5, display: "6,5 jam/minggu", status: "baseline" });
    expect(page.ownerHours).toEqual([{ month: M, value: 6.5, note: "Revisi setelah cek ulang" }]);
    expect(page.canInputOwnerHours).toBe(true);

    const k11 = page.current.values.find((x) => x.code === "KPI-11")!;
    const adoption = await m9.fieldAdoption(t.db, EQUA_TENANT_ID, "2026-03-01", "2026-03-31");
    const drivers = adoption.byRole.find((r) => r.role === "driver")!;
    expect(drivers).toMatchObject({ users: 7, pct: 57.14 });
    expect(adoption.byRole.map((r) => r.role)).toEqual(["driver", "depot_operator", "store_cashier", "production_operator"]);
    expect(k11.value).toBe(adoption.overall);
    expect(k11.detail).toMatch(/Nota kertas ditarik: Truk .+ \(2026-03-14\)/);
  });

  it("US-M9-07 KP-2 periode paralel: lembar pencocokan harian, tarik lebih awal hanya dengan syarat PAR-84 + persetujuan pemilik, perpanjangan maks PAR-88", async () => {
    const truck = (await createTruck(t.db)).id;
    const fa = finance(at("2026-03-20", "20:00"));
    const w = await m9.startParallelPeriod(finance(at("2026-03-16", "07:00")), { unitType: "truck", truckId: truck, parallelStartDate: "2026-03-16" });
    await expect(m9.startParallelPeriod(fa, { unitType: "truck", truckId: truck, parallelStartDate: "2026-03-17" })).rejects.toThrow(/masih dalam periode paralel/);
    // Selisih wajib ditandai & diberi penyebab.
    await makeTrip(t.db, { date: "2026-03-16", truckId: truck, price: 250_000 });
    await expect(m9.recordParallelCheck(fa, { unitType: "truck", truckId: truck, businessDate: "2026-03-16", paperCount: 2, paperAmount: 500_000 })).rejects.toThrow(/Tandai terjelaskan/);
    const c = await m9.recordParallelCheck(fa, { unitType: "truck", truckId: truck, businessDate: "2026-03-16", paperCount: 2, paperAmount: 500_000, explained: false, cause: "Nota kedua tidak ada di sistem" });
    expect(c).toMatchObject({ systemCount: 1, systemAmount: 250_000, differenceCount: 1, differenceAmount: 250_000, explained: false });
    // Tarik lebih awal ditolak bila PAR-84 belum terpenuhi.
    await expect(m9.withdrawPaper(finance(at("2026-03-20", "20:30")), { withdrawalId: w.id, withdrawnDate: "2026-03-20" })).rejects.toThrow(/belum memenuhi PAR-84/);
    // Koreksi lembar (berjejak) → terjelaskan.
    const fixed = await m9.recordParallelCheck(fa, { unitType: "truck", truckId: truck, businessDate: "2026-03-16", paperCount: 1, paperAmount: 250_000 });
    expect(fixed).toMatchObject({ id: c.id, differenceCount: 0, explained: true });
    expect(await t.db.select().from(parallelRunChecks).where(eq(parallelRunChecks.truckId, truck))).toHaveLength(1);
    // Perpanjangan maksimal PAR-88 (1 minggu).
    await expect(m9.extendParallelPeriod(fa, { withdrawalId: w.id, extensionDays: 8, reason: "Keputusan komite pengarah 20 Maret" })).rejects.toThrow(/maksimal 7 hari/);
    const ext = await m9.extendParallelPeriod(fa, { withdrawalId: w.id, extensionDays: 5, reason: "Keputusan komite pengarah 20 Maret" });
    expect(ext.extensionDays).toBe(5);
    // Pengajuan lebih awal yang memenuhi syarat → persetujuan pemilik; Dispatcher tidak berhak.
    const req = await earlyWithdrawalRequest(t.db, { start: "2026-03-18" });
    const units = await m9.listParallelUnits(owner(at("2026-03-24", "09:00")));
    expect(units.find((u) => u.id === req.withdrawalId)).toMatchObject({ status: "early_pending", pendingApprovalId: req.approvalId, par84: { met: true } });
    expect(units.find((u) => u.id === w.id)).toMatchObject({ status: "running", extensionDays: 5, maxDay: 19 });
    await expect(m9.listParallelUnits(dispatcher(NOW))).rejects.toThrow(/tidak diizinkan/);
    await expect(approvals.decide(finance(at("2026-03-24", "09:00")), req.approvalId, "approve")).rejects.toThrow();
    await approvals.decide(owner(at("2026-03-24", "09:30")), req.approvalId, "approve");
    const [row] = await t.db.select().from(unitPaperWithdrawals).where(eq(unitPaperWithdrawals.id, req.withdrawalId));
    expect(row).toMatchObject({ withdrawnDate: req.withdrawnDate, earlyWithdrawalApprovedBy: userIdByUsername("pemilik") });
    await expect(m9.withdrawPaper(finance(at("2026-03-25", "09:00")), { withdrawalId: req.withdrawalId, withdrawnDate: "2026-03-25" })).rejects.toThrow(/sudah ditarik/);
  });

  it("US-M9-07 KP-3 ekspor PDF laporan KPI untuk rapat komite pengarah (+ Excel), tercatat di log ekspor", async () => {
    const pdf = await exportReport(owner(NOW), "m9.kpi", "pdf", { month: M });
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.rowCount).toBe(11);
    const [log] = await t.db.select().from(exportLogs).where(eq(exportLogs.id, pdf.exportLogId));
    expect(log).toMatchObject({ reportKey: "m9.kpi", format: "pdf", filters: { month: M } });
    const xlsx = await exportReport(owner(NOW), "m9.kpi", "xlsx", { month: M });
    expect(xlsx.rowCount).toBe(11);
    await expect(exportReport(finance(NOW), "m9.kpi", "pdf", { month: M })).rejects.toThrow(/tidak diizinkan/);
  });
});
