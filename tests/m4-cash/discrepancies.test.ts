import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, deposits, discrepancies, domainEvents, officeCashMovements, restitutions } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { addDays, monthOf } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { exportReport } from "@/server/core/export";
import * as flags from "@/server/core/flags";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createDeposit } from "../helpers/fixtures";
import { PRICE, at, driverDay, finance, notificationsOf, owner } from "./helpers";

async function shortage(db: Parameters<typeof driverDay>[0], amount: number, reason: "wrong_change" | "other" = "other") {
  const d = await driverDay(db, { trips: 1 });
  const res = await m4.receiveDeposit(finance(at(d.date)), { depositId: d.depositId, receivedAmount: PRICE - amount, discrepancyReason: reason, discrepancyNote: "Uang kurang saat dihitung" });
  return { d, disc: res.discrepancy! };
}

describe("M4 — tindak lanjut selisih & ganti rugi (US-M4-03)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M4-03 KP-1 daftar selisih terbuka dengan umur; belum Selesai > 24 jam ditonjolkan (di atas) dan dihitung KPI-03", async () => {
    const { d, disc } = await shortage(t.db, 70_000);
    const fresh = await m4.listDiscrepancies(owner(at(d.date, "16:00")), { view: "open" });
    const row = fresh.rows.find((r) => r.id === disc.id)!;
    expect(row).toMatchObject({ overdue: false, approvalStatus: "submitted", amount: -70_000 });
    expect(row.sourceLabel).toContain("Sopir");
    const later = owner(new Date(disc.createdAt.getTime() + 25 * 3_600_000));
    const old = await m4.listDiscrepancies(later, { view: "open" });
    expect(old.rows[0]!.overdue).toBe(true);
    expect(old.overdueCount).toBeGreaterThanOrEqual(1);
    expect(old.rows.find((r) => r.id === disc.id)!.ageHours).toBeGreaterThanOrEqual(25);
    const k = await m4.kpi03(t.db, EQUA_TENANT_ID, { from: d.date, to: d.date, now: later.now });
    expect(k.overdue).toBeGreaterThanOrEqual(1);
    expect(k.followUpHours).toBe(24);
    // Selesai dalam 24 jam tidak dihitung.
    await m4.decideDiscrepancy(owner(new Date(disc.createdAt.getTime() + 3_600_000)), disc.id, { decision: "approve" });
    const k2 = await m4.kpi03(t.db, EQUA_TENANT_ID, { from: d.date, to: d.date, now: later.now });
    expect(k2.overdue).toBe(k.overdue - 1);
  });

  it("US-M4-03 KP-2 pemilik Disetujui → Selesai + beban selisih kas pusat laba sumber (discrepancy.decided); Admin Keuangan tidak dapat memutuskan", async () => {
    const { d, disc } = await shortage(t.db, 55_000);
    await expect(m4.decideDiscrepancy(finance(at(d.date)), disc.id, { decision: "approve" })).rejects.toThrow();
    const res = await m4.decideDiscrepancy(owner(at(d.date, "17:00")), disc.id, { decision: "approve", reason: "Penjelasan diterima" });
    expect(res).toMatchObject({ status: "done", decision: "approved" });
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "discrepancy.decided"), eq(domainEvents.objectId, disc.id))))[0]!;
    expect(ev.payload).toMatchObject({ decision: "approved", amount: -55_000, profitCenter: "L2", source: "driver" });
    const req = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, disc.id)))[0]!;
    expect(req.status).toBe("approved");
  });

  it("US-M4-03 KP-2 US-M4-06 KP-6 pemilik Ditolak → dikembalikan ke Admin Keuangan (notifikasi); Admin Keuangan menindaklanjuti → Selesai; sistem tidak memotong gaji", async () => {
    const { d, disc } = await shortage(t.db, 60_000);
    await expect(m4.decideDiscrepancy(owner(at(d.date, "17:00")), disc.id, { decision: "reject" })).rejects.toThrow(/Alasan wajib/);
    // Keputusan dari kotak masuk persetujuan (satu ketuk) sama efeknya.
    const req = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, disc.id)))[0]!;
    await approvals.decide(owner(at(d.date, "17:00")), req.id, "reject", "Tidak ada bukti uang rusak");
    const row = (await t.db.select().from(discrepancies).where(eq(discrepancies.id, disc.id)))[0]!;
    expect(row).toMatchObject({ status: "rejected", decision: "rejected", decisionReason: "Tidak ada bukti uang rusak" });
    expect(await t.db.select().from(restitutions).where(eq(restitutions.discrepancyId, disc.id))).toHaveLength(0);
    expect((await notificationsOf(t.db, "discrepancy.returned", disc.id)).length).toBeGreaterThan(0);
    await expect(m4.completeDiscrepancyFollowUp(owner(), { discrepancyId: disc.id, note: "Sudah dibicarakan" })).rejects.toThrow();
    const done = await m4.completeDiscrepancyFollowUp(finance(at(d.date, "18:00")), { discrepancyId: disc.id, note: "Sudah dibicarakan dengan sopir" });
    expect(done).toMatchObject({ status: "done", followUpNote: "Sudah dibicarakan dengan sopir" });
  });

  it("US-M4-03 KP-4 sebelum 'ganti rugi aktif' diatur pemilik, selisih Ditolak tercatat tanpa beban ganti rugi; setelah aktif → ganti rugi per kejadian (PTB-22)", async () => {
    const { d, disc } = await shortage(t.db, 80_000);
    // Hanya pemilik mengatur flag (6.2b).
    await expect(flags.set(finance(), "cash.restitution_active", true, { reason: "PP berlaku" })).rejects.toThrow();
    await flags.set(owner(), "cash.restitution_active", true, { reason: "Peraturan Perusahaan berlaku" });
    await m4.decideDiscrepancy(owner(at(d.date, "17:00")), disc.id, { decision: "reject", reason: "Kelalaian sopir" });
    const row = (await t.db.select().from(discrepancies).where(eq(discrepancies.id, disc.id)))[0]!;
    expect(row.status).toBe("followed_up");
    const rest = (await t.db.select().from(restitutions).where(eq(restitutions.discrepancyId, disc.id)))[0]!;
    expect(rest).toMatchObject({ employeeId: d.driver.employeeId, amount: 80_000, status: "recorded", businessDate: d.date });
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "discrepancy.decided"), eq(domainEvents.objectId, disc.id))))[0]!;
    expect(ev.payload).toMatchObject({ decision: "rejected", restitutionActive: true, restitutionId: rest.id });
    expect((await t.db.select().from(domainEvents).where(eq(domainEvents.type, "restitution.recorded"))).some((e) => e.objectId === rest.id)).toBe(true);
    await flags.set(owner(), "cash.restitution_active", false, { reason: "Kembali ke bawaan uji" });
  });

  it("US-M4-03 KP-3 rekap bulanan ganti rugi per karyawan diekspor Excel/PDF; pelunasan (setor tunai / potongan penggajian) oleh Admin Keuangan; saldo terlihat pemilik & karyawan bersangkutan", async () => {
    await flags.set(owner(), "cash.restitution_active", true, { reason: "Peraturan Perusahaan berlaku" });
    const { d, disc } = await shortage(t.db, 100_000);
    await m4.decideDiscrepancy(owner(at(d.date, "17:00")), disc.id, { decision: "reject", reason: "Tidak dapat dijelaskan" });
    const rest = (await t.db.select().from(restitutions).where(eq(restitutions.discrepancyId, disc.id)))[0]!;
    // Pemilik tidak mencatat pelunasan (harian); Admin Keuangan mencatat.
    await expect(m4.settleRestitution(owner(), { restitutionId: rest.id, amount: 40_000, method: "cash" })).rejects.toThrow();
    await expect(m4.settleRestitution(finance(at(d.date, "18:00")), { restitutionId: rest.id, amount: 200_000, method: "cash" })).rejects.toThrow(/melebihi sisa/);
    const s1 = await m4.settleRestitution(finance(at(d.date, "18:00")), { restitutionId: rest.id, amount: 40_000, method: "cash", reference: "Setor tunai sopir" });
    expect(s1.restitution).toMatchObject({ status: "partially_settled", settledAmount: 40_000 });
    expect((await t.db.select().from(officeCashMovements).where(eq(officeCashMovements.sourceObjectId, s1.settlement.id)))[0]).toMatchObject({ kind: "restitution_payment", direction: "in", amount: 40_000 });
    const balances = await m4.restitutionBalances(owner());
    expect(balances.find((b) => b.employeeId === d.driver.employeeId)).toMatchObject({ recorded: 100_000, settled: 40_000, outstanding: 60_000 });
    const pull = await d.hp.pull(d.sopir, { keys: "m4.my_cash" });
    expect((pull.data["m4.my_cash"] as m4.MyCashReference).restitution).toMatchObject({ outstanding: 60_000, recorded: 100_000 });
    const s2 = await m4.settleRestitution(finance(at(d.date, "18:05")), { restitutionId: rest.id, amount: 60_000, method: "payroll_deduction", reference: "Potongan gaji Okt" });
    expect(s2.restitution.status).toBe("settled");
    // Ganti rugi lunas → tindak lanjut selisih Selesai; event pelunasan untuk jurnal M11.
    expect((await t.db.select().from(discrepancies).where(eq(discrepancies.id, disc.id)))[0]!.status).toBe("done");
    expect((await t.db.select().from(domainEvents).where(eq(domainEvents.type, "restitution.settled"))).filter((e) => e.objectId === rest.id)).toHaveLength(2);
    const recap = await m4.restitutionMonthlyRecap(owner(), { month: monthOf(d.date) });
    expect(recap.find((r) => r.employeeId === d.driver.employeeId)).toMatchObject({ incidents: 1, recorded: 100_000, settledCash: 40_000, settledPayroll: 60_000, outstandingEndOfMonth: 0 });
    const xlsx = await exportReport(owner(), "m4.restitution_recap", "xlsx", { month: monthOf(d.date) });
    expect(xlsx.rowCount).toBeGreaterThanOrEqual(1);
    const pdf = await exportReport(finance(), "m4.restitution_recap", "pdf", { month: monthOf(d.date) });
    expect(pdf.contentType).toContain("pdf");
    await flags.set(owner(), "cash.restitution_active", false, { reason: "Kembali ke bawaan uji" });
  });

  it("US-M4-03 KP-5 pemilik membuka kembali selisih di bawah ambang yang ditutup Admin Keuangan ≤ 7 hari lalu memutuskannya", async () => {
    const { d, disc } = await shortage(t.db, 20_000, "wrong_change");
    const closed = (await t.db.select().from(discrepancies).where(eq(discrepancies.id, disc.id)))[0]!;
    expect(closed.status).toBe("done");
    await expect(m4.reopenDiscrepancy(finance(), { discrepancyId: disc.id, reason: "Periksa lagi" })).rejects.toThrow();
    const late = owner(new Date(closed.closedBelowThresholdAt!.getTime() + 8 * 86_400_000));
    await expect(m4.reopenDiscrepancy(late, { discrepancyId: disc.id, reason: "Periksa lagi" })).rejects.toThrow(/lebih dari 7 hari/);
    const re = await m4.reopenDiscrepancy(owner(at(d.date, "19:00")), { discrepancyId: disc.id, reason: "Sering terjadi pada sopir ini" });
    expect(re).toMatchObject({ status: "explained", requiresOwnerDecision: true, reopenReason: "Sering terjadi pada sopir ini" });
    expect((await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "discrepancy.reopened"), eq(domainEvents.objectId, disc.id))))).toHaveLength(1);
    const decided = await m4.decideDiscrepancy(owner(at(d.date, "19:05")), disc.id, { decision: "reject", reason: "Minta sopir lebih teliti" });
    expect(decided).toMatchObject({ decision: "rejected" });
  });

  it("US-M4-03 KP-6 riwayat selisih per sopir/operator: jumlah kejadian, nilai kurang/lebih, alasan per bulan, deret hari tanpa selisih", async () => {
    const { d } = await shortage(t.db, 30_000, "wrong_change");
    // Hari-hari berikutnya tanpa selisih (setoran ditutup tanpa selisih).
    for (let i = 1; i <= 3; i++) {
      const dep = await createDeposit(t.db, { date: addDays(d.date, i), status: "closed", depositorUserId: d.driver.userId, depositorEmployeeId: d.driver.employeeId, expectedCash: PRICE });
      await t.db.update(deposits).set({ receivedAmount: PRICE, discrepancyAmount: 0 }).where(eq(deposits.id, dep.id));
    }
    // Selisih lebih kemarin.
    await t.db.insert(discrepancies).values({ tenantId: EQUA_TENANT_ID, source: "driver", employeeId: d.driver.employeeId, userId: d.driver.userId, businessDate: addDays(d.date, -1), amount: 5_000, reason: "other", status: "done" });
    const ctx = owner(at(addDays(d.date, 3), "20:00"));
    const hist = await m4.discrepancyHistory(ctx, { employeeId: d.driver.employeeId, months: 3 });
    const months = hist.rows.filter((r) => r.employeeId === d.driver.employeeId);
    const all = months.reduce((s, r) => ({ count: s.count + r.count, shortage: s.shortage + r.shortage, surplus: s.surplus + r.surplus }), { count: 0, shortage: 0, surplus: 0 });
    expect(all).toEqual({ count: 2, shortage: 30_000, surplus: 5_000 });
    expect(months.some((m) => m.reasons.wrong_change === 1)).toBe(true);
    const streak = hist.streaks.find((s) => s.employeeId === d.driver.employeeId)!;
    expect(streak.daysWithoutDiscrepancy).toBe(3);
    expect(streak.lastDiscrepancyDate).toBe(d.date);
    expect(streak.zeroForMonths).toBe(false);
    const xlsx = await exportReport(owner(), "m4.discrepancy_history", "xlsx", { months: 3 });
    expect(xlsx.rowCount).toBeGreaterThanOrEqual(1);
  });
});
