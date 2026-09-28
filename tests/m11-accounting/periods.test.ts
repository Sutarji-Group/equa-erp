import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, auditLogs, cashDays, eventAccountMappings, journals, notifications, stockCounts, truckFills } from "@/db/schema";
import { EQUA_TENANT_ID, truckId, waterSourceId } from "@/db/seed";
import { isHardeningViolation } from "@/db/hardening";
import { newId } from "@/lib/ids";
import * as approvals from "@/server/core/approvals";
import { ForbiddenError } from "@/server/core/errors";
import * as m11 from "@/server/modules/m11-accounting";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { isolateCashDays } from "../m4-cash/helpers";
import {
  THIS_PERIOD,
  TODAY,
  acc,
  accountant,
  at,
  emitEvent,
  finance,
  journalById,
  journalOfEvent,
  manualJournal,
  notificationsOf,
  owner,
  pair,
  periodRow,
  queueOfEvent,
  setPeriod,
  settleReconciliations,
  shiftMonth,
  storeCountsDone,
  tripPayload,
} from "./helpers";

const PREV = shiftMonth(THIS_PERIOD, -1);
const PREV2 = shiftMonth(THIS_PERIOD, -2);
/** Hari kerja kantor pada periode berjalan sebelum/ sesudah batas tutup buku (PAR-23 = tanggal 10). */
const DAY5 = `${THIS_PERIOD}-05`;

describe("M11 tutup & kunci periode (US-M11-10) + laporan Sementara/Final (US-M11-04 KP-2)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  let bigApprovalId = "";
  let partnerEventId = "";

  beforeAll(async () => {
    await isolateCashDays(t.db, `${THIS_PERIOD}-01`);
    await setPeriod(t.db, PREV2, "open");
    await setPeriod(t.db, PREV, "open");
    await setPeriod(t.db, THIS_PERIOD, "open");
  });

  it("US-M11-10 KP-2 pengingat tanggal 5 & 8 (PAR-71) bila periode lalu belum ditutup; lewat tanggal 10 → pengingat terlambat", async () => {
    expect(await m11.runPeriodReminders(at(DAY5, "07:15"))).toBe(1);
    expect(await m11.runPeriodReminders(at(DAY5, "07:16"))).toBe(0);
    expect(await m11.runPeriodReminders(at(`${THIS_PERIOD}-06`, "07:15"))).toBe(0);
    expect(await m11.runPeriodReminders(at(`${THIS_PERIOD}-08`, "07:15"))).toBe(1);
    expect(await m11.runPeriodReminders(at(`${THIS_PERIOD}-11`, "07:15"))).toBe(1);
    const sent = (await notificationsOf(t.db, "period.not_closed")).filter((n) => n.title.includes(PREV));
    expect(sent.map((n) => n.title)).toEqual(expect.arrayContaining([`Pengingat: tutup periode ${PREV}`, `Periode ${PREV} TERLAMBAT ditutup`]));
  });

  it("US-M11-10 KP-1 prasyarat tutup periode diperiksa sistem; yang belum terpenuhi tampil dengan tautan tindakan dan tutup DITOLAK", async () => {
    const fa = finance(at(DAY5));
    // Hari kas belum ditutup (M4).
    await t.db.insert(cashDays).values({ tenantId: EQUA_TENANT_ID, businessDate: `${PREV}-27`, status: "open" }).onConflictDoNothing();
    await t.db.update(cashDays).set({ status: "open", closedAt: null }).where(and(eq(cashDays.tenantId, EQUA_TENANT_ID), eq(cashDays.businessDate, `${PREV}-27`)));
    // Jurnal manual: satu ≤ PAR-20 (tinjauan pemilik), satu > PAR-20 (menunggu persetujuan); biaya L1 → alokasi wajib.
    await manualJournal(fa, { date: `${PREV}-15`, description: "Listrik pompa sumber air", lines: pair("6-1301", "1-1201", 600_000, { debit: "L1" }) });
    const big = await manualJournal(fa, { date: `${PREV}-16`, description: "Perbaikan besar pompa", lines: pair("6-1401", "1-1201", 6_000_000, { debit: "L1" }) });
    if (big.submitted.status !== "submitted") throw new Error("harus menunggu persetujuan");
    bigApprovalId = big.submitted.approvalId;
    // Daftar tunggu: pemetaan langganan mitra hilang.
    await t.db
      .update(eventAccountMappings)
      .set({ isActive: false })
      .where(and(eq(eventAccountMappings.eventKey, "partner.subscription_invoiced"), eq(eventAccountMappings.entryKey, "default")));
    const ev = await emitEvent("partner.subscription_invoiced", { invoiceId: newId(), partnerContractId: newId(), partnerTenantId: newId(), amount: 300_000, outletCount: 1 }, { businessDate: `${PREV}-20` });
    partnerEventId = ev.id;
    expect(await queueOfEvent(t.db, ev.id)).toMatchObject({ status: "pending" });
    // Opname toko bulan itu belum selesai (M7).
    await t.db
      .update(stockCounts)
      .set({ status: "counting" })
      .where(and(eq(stockCounts.tenantId, EQUA_TENANT_ID), eq(stockCounts.kind, "monthly_store"), eq(stockCounts.periodLabel, PREV)));
    // Aset baru → penyusutan periode ini belum terposting.
    await m11.createAsset(fa, { code: "TRK-UJI-1", name: "Truk tangki uji", category: "truck", acquisitionDate: `${PREV}-05`, acquisitionCost: 120_000_000, usefulLifeMonths: 60, truckId: truckId("T1") });

    const detail = await m11.periodDetail(accountant(at(DAY5)), { period: PREV });
    const failing = detail.prerequisites.filter((p) => !p.ok);
    expect(failing.map((p) => p.key).sort()).toEqual(
      ["allocations_posted", "bank_reconciled", "cash_days_closed", "depreciation_posted", "manual_decided", "manual_reviewed", "queue_empty", "store_count_done"].sort(),
    );
    for (const p of failing) expect(p.href).toMatch(/^\//);
    expect(failing.find((p) => p.key === "manual_reviewed")!.href).toBe(`/akuntansi/jurnal?tinjauan=${PREV}`);
    expect(failing.find((p) => p.key === "cash_days_closed")!.detail).toContain(`${PREV}-27`);

    await expect(m11.closePeriod(fa, { periodId: detail.period.id })).rejects.toThrow(/belum dapat ditutup/);
    const current = await periodRow(t.db, THIS_PERIOD);
    await expect(m11.closePeriod(fa, { periodId: current!.id })).rejects.toThrow(/baru dapat ditutup setelah/);
    await expect(m11.closePeriod(accountant(at(DAY5)), { periodId: detail.period.id })).rejects.toBeInstanceOf(ForbiddenError);
    // Penolakan tidak menutup & tidak memposting apa pun.
    expect((await periodRow(t.db, PREV))!.status).toBe("open");
  });

  it("US-M11-10 KP-2 prasyarat dipenuhi → Admin Keuangan menutup (penyusutan otomatis, tepat waktu) → pemilik mengunci; laporan 'Final' tersimpan (US-M11-04 KP-2)", async () => {
    const fa = finance(at(DAY5));
    const period = (await periodRow(t.db, PREV))!;
    await t.db.update(cashDays).set({ status: "closed", closedAt: new Date() }).where(and(eq(cashDays.tenantId, EQUA_TENANT_ID), eq(cashDays.businessDate, `${PREV}-27`)));
    await approvals.decide(owner(at(DAY5)), bigApprovalId, "approve");
    await m11.markManualJournalsReviewed(owner(at(DAY5)), { periodId: period.id });
    await m11.saveMapping(fa, {
      eventKey: "partner.subscription_invoiced",
      entryKey: "default",
      description: "Tagihan langganan sistem mitra (dipulihkan)",
      debitAccountId: acc("1-1401"),
      creditAccountId: acc("4-1401"),
      debitProfitCenter: "SHARED",
      creditProfitCenter: "L5",
      effectiveFrom: DAY5,
      reason: "Pemetaan dilengkapi akuntan",
    });
    expect(await queueOfEvent(t.db, partnerEventId)).toMatchObject({ status: "resolved" });
    expect((await journalOfEvent(t.db, partnerEventId))!.journalDate).toBe(`${PREV}-20`);
    await storeCountsDone(t.db, PREV);
    await t.db.insert(truckFills).values([
      { tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA2"), truckId: truckId("T3"), businessDate: `${PREV}-10`, volumeL: 20_000, filledAt: new Date(), isDepotSupply: false },
      { tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA2"), truckId: truckId("T4"), businessDate: `${PREV}-10`, volumeL: 20_000, filledAt: new Date(), isDepotSupply: true },
    ]);
    await m11.runCostAllocation(fa, { periodId: period.id, kind: "l1_allocation" });
    const rec = await settleReconciliations(period.id, fa);
    expect(rec.bankOk && rec.cashOk).toBe(true);

    const provisional = await m11.getStatements(accountant(at(DAY5)), { period: PREV });
    expect(provisional.status).toBe("provisional");

    const closed = await m11.closePeriod(fa, { periodId: period.id });
    expect(closed.period).toMatchObject({ status: "closed", closedLate: false });
    const dep = await t.db.select().from(journals).where(and(eq(journals.periodId, period.id), eq(journals.kind, "depreciation")));
    expect(dep).toHaveLength(1);
    expect(dep[0]!.totalDebit).toBe(2_000_000);
    const [req] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, closed.approvalId));
    expect(req).toMatchObject({ type: "period_lock", objectType: "accounting_period", objectId: period.id, status: "submitted" });

    await expect(m11.lockPeriod(fa, { periodId: period.id })).rejects.toBeInstanceOf(ForbiddenError);
    const locked = await m11.lockPeriod(owner(at(DAY5)), { periodId: period.id, note: "Laporan sesuai" });
    expect(locked).toMatchObject({ status: "locked", revision: 1 });
    const final = await m11.getStatements(accountant(), { period: PREV });
    expect(final).toMatchObject({ status: "final", revision: 1 });
    expect(final.trialBalance.balanced).toBe(true);
    const again = await m11.getStatements(owner(), { period: PREV });
    expect(JSON.stringify(again)).toBe(JSON.stringify(final));
  });

  it("US-M11-10 KP-3 periode Dikunci menolak semua posting; peristiwa terlambat & koreksi masuk periode terbuka berikutnya dengan rujukan periode asal; laporan Final tidak berubah (US-M11-04 KP-2)", async () => {
    const before = await m11.getStatements(accountant(), { period: PREV });
    const late = await emitEvent("trip.completed", tripPayload({ businessDate: `${PREV}-25`, lateSync: true }), { businessDate: `${PREV}-25` });
    const lj = await journalOfEvent(t.db, late.id);
    expect(lj).toMatchObject({ status: "posted", originPeriod: PREV, journalDate: `${PREV}-25` });
    expect(lj!.periodId).toBe((await periodRow(t.db, THIS_PERIOD))!.id);

    const fa = finance();
    await expect(m11.createManualJournal(fa, { date: `${PREV}-28`, description: "Koreksi di periode terkunci", lines: [...pair("6-1401", "1-1201", 100_000)] })).rejects.toThrow(/dikunci.*periode terbuka berikutnya/);
    const corr = await manualJournal(fa, { date: TODAY, description: "Koreksi beban pemeliharaan periode lalu", originPeriod: PREV, lines: pair("6-1401", "1-1201", 100_000) });
    expect(await journalById(t.db, corr.draft.id)).toMatchObject({ status: "posted", originPeriod: PREV });

    const period = (await periodRow(t.db, PREV))!;
    const direct = await t.db
      .insert(journals)
      .values({ tenantId: EQUA_TENANT_ID, number: "J-UJI-LOCK-1", kind: "manual", status: "posted", journalDate: `${PREV}-28`, periodId: period.id, description: "Sisipan langsung", totalDebit: 0, totalCredit: 0 })
      .catch((e: unknown) => e);
    expect(isHardeningViolation(direct)).toBe(true);

    const after = await m11.getStatements(accountant(), { period: PREV });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("US-M11-10 KP-4 pemilik membuka periode terkunci dengan alasan (berjejak, akuntan diberi tahu); Final lama tersimpan, versi baru bernomor revisi", async () => {
    const period = (await periodRow(t.db, PREV))!;
    await expect(m11.reopenPeriod(finance(), { periodId: period.id, reason: "Ada koreksi besar dari akuntan" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(m11.reopenPeriod(owner(), { periodId: period.id, reason: "singkat" })).rejects.toThrow(/Alasan/);
    const reopened = await m11.reopenPeriod(owner(at(DAY5)), { periodId: period.id, reason: "Koreksi nilai sewa dari akuntan" });
    expect(reopened).toMatchObject({ status: "reopened", revision: 2 });
    const note = (await notificationsOf(t.db, "period.reopened", period.id))[0];
    expect(note).toBeTruthy();
    const accountantNote = await t.db.select().from(notifications).where(and(eq(notifications.event, "period.reopened"), eq(notifications.recipientUserId, accountant().userId!)));
    expect(accountantNote.length).toBeGreaterThan(0);
    const trail = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "accounting_period"), eq(auditLogs.objectId, period.id), eq(auditLogs.action, "reopen")));
    expect(trail[0]).toMatchObject({ reason: "Koreksi nilai sewa dari akuntan" });
    expect((await m11.getStatements(accountant(), { period: PREV })).status).toBe("provisional");

    // Tindakan sesudah dibuka: koreksi di periode itu, tutup & kunci ulang → revisi 2 Final; revisi 1 tetap tersimpan.
    const fa = finance(at(DAY5));
    await manualJournal(fa, { date: `${PREV}-28`, description: "Koreksi sewa (setelah dibuka)", lines: pair("6-1201", "1-1201", 250_000) });
    await m11.markManualJournalsReviewed(owner(at(DAY5)), { periodId: period.id });
    await settleReconciliations(period.id, fa);
    const bank = (await m11.reconciliationOverview(fa, { periodId: period.id })).bank.filter((b) => b.required);
    for (const b of bank) {
      await m11.saveBankReconciliation(fa, { periodId: period.id, bankAccountId: b.bankAccountId, statementBalance: b.bookBalance + b.autoItems.reduce((s, i) => s + i.amount, 0) });
    }
    await m11.closePeriod(fa, { periodId: period.id });
    await m11.lockPeriod(owner(at(DAY5)), { periodId: period.id });
    const versions = await m11.finalVersions(t.db, EQUA_TENANT_ID, PREV);
    const periodVersions = versions.filter((v) => v.scopeKey === "period");
    expect(periodVersions.map((v) => v.revision)).toEqual([2, 1]);
    expect(periodVersions[0]!.supersededById).toBeNull();
    expect(periodVersions[1]!.supersededById).toBe(periodVersions[0]!.id);
    expect(await m11.getStatements(accountant(), { period: PREV })).toMatchObject({ status: "final", revision: 2 });
  });

  it("US-M11-10 KP-2 tutup setelah tanggal 10 bulan berikutnya (PAR-23) ditandai terlambat (BR-32)", async () => {
    const period = (await periodRow(t.db, PREV2))!;
    const late = finance(at(`${PREV}-12`));
    await storeCountsDone(t.db, PREV2);
    await settleReconciliations(period.id, late);
    const res = await m11.closePeriod(late, { periodId: period.id });
    expect(res).toMatchObject({ late: true });
    expect((await periodRow(t.db, PREV2))!.closedLate).toBe(true);
  });
});
