import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, cashDays, dataSignoffs, journals, periodReviewNotes } from "@/db/schema";
import { EQUA_TENANT_ID, outletId } from "@/db/seed";
import { isHardeningViolation } from "@/db/hardening";
import { newId } from "@/lib/ids";
import * as approvals from "@/server/core/approvals";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport, getReport } from "@/server/core/export";
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
  journalOfEvent,
  linesOf,
  notificationsOf,
  owner,
  periodRow,
  queueOfEvent,
  setPeriod,
  settleReconciliations,
  shiftMonth,
  storeCountsDone,
  tripPayload,
} from "./helpers";

const CUT = `${THIS_PERIOD}-01`;
const PREV = shiftMonth(THIS_PERIOD, -1);
const NEXT = shiftMonth(THIS_PERIOD, 1);
const line = (code: string, side: "debit" | "credit", amount: number, pc: "SHARED" | "L2" | "L4" = "SHARED", extra: Record<string, unknown> = {}) => ({
  accountId: acc(code),
  profitCenter: pc,
  [side]: amount,
  ...extra,
});

describe("M11 saldo awal & cut-over (US-M11-09) + jurnal retroaktif (US-M11-02 KP-4)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  const trip = tripPayload({ cashReceived: 250_000 });
  let tripEventId = "";

  beforeAll(async () => {
    await setPeriod(t.db, PREV, "open");
    await setPeriod(t.db, THIS_PERIOD, "open");
  });

  it("US-M11-02 KP-4 M11 menyusul (R04): peristiwa saat M11 nonaktif tidak hilang; setelah cut-over tanggal 1 & aktivasi, jurnal dibangkitkan retroaktif (idempoten) dan diverifikasi akuntan sebelum periode pertama ditutup", async () => {
    await m11.setAccountingActive(owner(), { enabled: false, reason: "M11 belum siap (bagan akun menyusul)" });
    const ev = await emitEvent("trip.completed", trip);
    tripEventId = ev.id;
    const saleId = newId();
    await emitEvent("pos_sale.recorded", { posSaleId: saleId, outletId: outletId("D01"), outletKind: "depot", shiftId: newId(), method: "cash", total: 60_000, discount: 0, lines: [] });
    expect(await journalOfEvent(t.db, ev.id)).toBeNull();
    expect(await queueOfEvent(t.db, ev.id)).toBeNull();

    await expect(m11.generateRetroactiveJournals(finance())).rejects.toThrow(/cut-over/);
    await expect(m11.setCutoverDate(owner(), { date: `${THIS_PERIOD}-15`, reason: "Cut-over tengah bulan" })).rejects.toThrow(/hanya boleh tanggal 1/);
    await expect(m11.setCutoverDate(finance(), { date: CUT, reason: "Cut-over awal bulan" })).rejects.toBeInstanceOf(ForbiddenError);
    await m11.setCutoverDate(owner(), { date: CUT, reason: "Cut-over tanggal 1 bulan go-live operasional" });
    await expect(m11.generateRetroactiveJournals(finance())).rejects.toThrow(/Aktifkan jurnal otomatis/);
    await m11.setAccountingActive(owner(), { enabled: true, reason: "Bagan akun & pemetaan lengkap" });

    await expect(m11.generateRetroactiveJournals(accountant())).rejects.toBeInstanceOf(ForbiddenError);
    const run = await m11.generateRetroactiveJournals(finance());
    expect(run).toMatchObject({ status: "done", posted: 2, periods: [THIS_PERIOD] });
    expect(await journalOfEvent(t.db, ev.id)).toMatchObject({ kind: "auto", status: "posted", journalDate: TODAY });
    expect((await periodRow(t.db, THIS_PERIOD))!.isRetroactive).toBe(true);
    expect((await notificationsOf(t.db, "journal.retroactive_done", run.id)).length).toBeGreaterThan(0);
    const again = await m11.generateRetroactiveJournals(finance());
    expect(again).toMatchObject({ posted: 0, duplicates: 2 });

    // Peristiwa bertanggal sebelum cut-over tidak dimigrasi.
    const old = await emitEvent("trip.completed", tripPayload({ businessDate: `${PREV}-20` }), { businessDate: `${PREV}-20` });
    expect(await journalOfEvent(t.db, old.id)).toBeNull();
    expect(await queueOfEvent(t.db, old.id)).toBeNull();

    const period = (await periodRow(t.db, THIS_PERIOD))!;
    const before = (await m11.periodDetail(finance(), { periodId: period.id })).prerequisites.find((p) => p.key === "retroactive_verified")!;
    expect(before.ok).toBe(false);
    await expect(m11.verifyRetroactiveRun(finance(), { runId: run.id, note: "Diverifikasi" })).rejects.toBeInstanceOf(ForbiddenError);
    await m11.verifyRetroactiveRun(accountant(), { runId: run.id, note: "Jurnal retroaktif dicocokkan dengan ringkasan H+0" });
    const after = (await m11.periodDetail(finance(), { periodId: period.id })).prerequisites.find((p) => p.key === "retroactive_verified")!;
    expect(after.ok).toBe(true);
    const notes = await t.db.select().from(periodReviewNotes).where(eq(periodReviewNotes.periodId, period.id));
    expect(notes.some((n) => n.kind === "retroactive_verification")).toBe(true);
  });

  it("US-M11-09 KP-4 bulan-bulan retroaktif berlabel 'dibangkitkan retroaktif, diverifikasi akuntan' pada laporan", async () => {
    const s = await m11.getStatements(accountant(), { period: THIS_PERIOD });
    expect(s.retroactive).toBe(true);
    const res = await getReport("m11.profit_loss")!.fetch(accountant(), { period: THIS_PERIOD }, { tx: t.db });
    expect(res.status).toBe("Sementara — dibangkitkan retroaktif, diverifikasi akuntan");
    const x = await exportReport(accountant(), "m11.profit_loss", "xlsx", { period: THIS_PERIOD });
    expect(x.rowCount).toBeGreaterThan(0);
    const runs = await m11.listRetroactiveRuns(owner());
    expect(runs.some((r) => r.verifiedBy === accountant().userId && r.posted === 2)).toBe(true);
  });

  it("US-M11-09 KP-1 cut-over hanya tanggal 1; sistem menolak jurnal bertanggal sebelum cut-over kecuali jurnal saldo awal", async () => {
    await expect(m11.createManualJournal(finance(), { date: `${PREV}-28`, description: "Biaya bulan lalu", lines: [line("6-1301", "debit", 100_000), line("1-1101", "credit", 100_000)] })).rejects.toThrow(/sebelum cut-over/);
    const prev = (await periodRow(t.db, PREV))!;
    const direct = await t.db
      .insert(journals)
      .values({ tenantId: EQUA_TENANT_ID, number: "J-UJI-CUT-1", kind: "manual", status: "posted", journalDate: `${PREV}-28`, periodId: prev.id, description: "Sisipan sebelum cut-over", totalDebit: 0, totalCredit: 0 })
      .catch((e: unknown) => e);
    expect(isHardeningViolation(direct)).toBe(true);
    expect((await m11.openingOverview(accountant())).cutover).toBe(CUT);
  });

  it("US-M11-09 KP-2 jurnal saldo awal per kelompok (kas & bank, piutang, utang, persediaan, aset tetap, ekuitas penyeimbang): tiap kelompok ditandatangani pemilik dan disahkan akuntan sebelum terposting", async () => {
    const fa = finance();
    const groups: Record<string, ReturnType<typeof line>[]> = {
      cash_bank: [line("1-1101", "debit", 5_000_000, "SHARED", { description: "Hitung fisik kas kantor" }), line("1-1201", "debit", 20_000_000, "SHARED", { description: "Saldo rekening" })],
      receivables: [line("1-1401", "debit", 3_000_000, "SHARED", { description: "Piutang per faktur (US-M5-07)" })],
      payables: [line("2-1101", "credit", 1_000_000, "L4", { description: "Utang per nota" })],
      inventory: [line("1-1501", "debit", 2_000_000, "L4", { outletId: outletId("TK1"), description: "Opname cut-over toko" })],
      fixed_assets: [line("1-2101", "debit", 240_000_000, "L2"), line("1-2102", "credit", 30_000_000, "L2")],
      equity: [line("3-1101", "credit", 100_000_000, "SHARED", { description: "Modal disetor" })],
    };
    const batches: Record<string, string> = {};
    for (const [group, lines] of Object.entries(groups)) {
      const b = await m11.saveOpeningBatch(fa, { group: group as never, lines: lines as never });
      batches[group] = b.id;
    }
    await expect(m11.saveOpeningBatch(accountant(), { group: "cash_bank", lines: groups.cash_bank as never })).rejects.toBeInstanceOf(ForbiddenError);
    // Draf baru menggantikan draf lama (wajib ditandatangani ulang).
    const old = batches.cash_bank!;
    batches.cash_bank = (await m11.saveOpeningBatch(fa, { group: "cash_bank", lines: groups.cash_bank as never, notes: "Revisi saldo rekening" })).id;
    await expect(m11.signOpeningBatch(owner(), { batchId: old })).rejects.toThrow(/digantikan/);

    await expect(m11.postOpeningBalances(fa)).rejects.toThrow(/belum ditandatangani pemilik/);
    await expect(m11.attestOpeningBalances(accountant(), { note: "Disahkan" })).rejects.toThrow(/belum ditandatangani pemilik/);
    for (const id of Object.values(batches)) await m11.signOpeningBatch(owner(), { batchId: id });
    const signoffs = await t.db.select().from(dataSignoffs).where(and(eq(dataSignoffs.tenantId, EQUA_TENANT_ID), eq(dataSignoffs.status, "signed")));
    expect(new Set(signoffs.map((s) => s.group))).toEqual(new Set(["opening_cash_bank", "opening_receivables", "opening_payables", "stock_opening", "fixed_assets", "opening_equity"]));
    await expect(m11.postOpeningBalances(fa)).rejects.toThrow(/belum disahkan akuntan/);
    await expect(m11.attestOpeningBalances(finance(), { note: "Disahkan" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await m11.attestOpeningBalances(accountant(), { note: "Neraca awal disahkan akuntan" })).toEqual({ attested: 6 });

    const posted = await m11.postOpeningBalances(fa);
    expect(posted.posted).toBe(6);
    const js = await t.db.select().from(journals).where(and(eq(journals.tenantId, EQUA_TENANT_ID), eq(journals.kind, "opening_balance")));
    expect(js).toHaveLength(6);
    expect(js.every((j) => j.journalDate === CUT && j.status === "posted")).toBe(true);
    const cash = js.find((j) => j.sourceObjectId === batches.cash_bank)!;
    expect((await linesOf(t.db, cash.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["1-1101", 5_000_000, 0],
      ["1-1201", 20_000_000, 0],
      ["3-1901", 0, 25_000_000],
    ]);
    const bs = (await m11.getStatements(accountant(), { period: THIS_PERIOD })).balanceSheet;
    expect(bs.balanced).toBe(true);
    await expect(m11.postOpeningBalances(fa)).rejects.toThrow(/Tidak ada saldo awal/);
    await expect(m11.saveOpeningBatch(fa, { group: "equity", lines: groups.equity as never })).rejects.toThrow(/sudah terposting/);
    await expect(m11.setCutoverDate(owner(), { date: `${NEXT}-01`, reason: "Geser cut-over" })).rejects.toThrow(/tidak dapat diubah/);
  });

  it("US-M11-09 KP-3 penyesuaian saldo awal ≤ 3 bulan setelah cut-over (PAR-62) lewat jurnal 'penyesuaian saldo awal' + persetujuan pemilik + catatan akuntan; setelahnya ditolak", async () => {
    const fa = finance();
    const lines = [line("1-1401", "debit", 400_000), line("3-1901", "credit", 400_000)];
    await expect(m11.requestOpeningAdjustment(fa, { lines: lines as never, reason: "Faktur lama terlewat", accountantNote: "" })).rejects.toThrow(/Catatan akuntan/);
    const req = await m11.requestOpeningAdjustment(fa, { lines: lines as never, reason: "Faktur lama terlewat", accountantNote: "Faktur INV-LAMA-9 sah, tambah piutang awal" });
    expect(req.journal).toMatchObject({ kind: "opening_adjustment", status: "submitted" });
    const [ap] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, req.approvalId));
    expect(ap).toMatchObject({ type: "opening_balance_adjustment", objectId: req.journal.id, amount: 400_000 });
    await approvals.decide(owner(), req.approvalId, "approve");
    const [j] = await t.db.select().from(journals).where(eq(journals.id, req.journal.id));
    expect(j).toMatchObject({ status: "posted", approvalRequestId: req.approvalId });
    const detail = await m11.getJournalDetail(accountant(), req.journal.id);
    expect(detail.details?.accountantNote).toContain("INV-LAMA-9");

    const late = finance(at(`${shiftMonth(THIS_PERIOD, 3)}-02`));
    await expect(m11.requestOpeningAdjustment(late, { lines: lines as never, reason: "Terlambat", accountantNote: "Catatan akuntan terlambat" })).rejects.toThrow(/hanya sampai/);
    expect((await m11.openingOverview(accountant())).adjustmentDeadline).toBe(`${shiftMonth(THIS_PERIOD, 2)}-${String(new Date(Date.UTC(Number(THIS_PERIOD.slice(0, 4)), Number(THIS_PERIOD.slice(5, 7)) + 2, 0)).getUTCDate()).padStart(2, "0")}`);
  });

  it("US-M11-10 KP-5 tutup buku bulan pertama setelah cut-over wajib catatan tinjauan akuntan (bukti TG-8)", async () => {
    const period = (await periodRow(t.db, THIS_PERIOD))!;
    const fa = finance(at(`${NEXT}-05`));
    await storeCountsDone(t.db, THIS_PERIOD);
    // Tutup kas harian M4 selesai untuk semua hari periode.
    await isolateCashDays(t.db, `${NEXT}-01`);
    await t.db.update(cashDays).set({ status: "closed", closedAt: new Date() }).where(eq(cashDays.tenantId, EQUA_TENANT_ID));
    await settleReconciliations(period.id, fa);
    const pre = (await m11.periodDetail(fa, { periodId: period.id })).prerequisites;
    expect(pre.find((p) => p.key === "opening_posted")).toMatchObject({ ok: true });
    expect(pre.find((p) => p.key === "accountant_note")).toMatchObject({ ok: false, href: `/akuntansi/periode/${period.id}` });
    await expect(m11.closePeriod(fa, { periodId: period.id })).rejects.toThrow(/catatan tinjauan akuntan/);
    await m11.addPeriodReviewNote(accountant(), { periodId: period.id, kind: "tg8", note: "Tutup buku bulan pertama ditinjau akuntan — bukti TG-8" });
    const closed = await m11.closePeriod(fa, { periodId: period.id });
    expect(closed.period.status).toBe("closed");
    await m11.lockPeriod(owner(at(`${NEXT}-05`)), { periodId: period.id });
    const final = await m11.getStatements(accountant(), { period: THIS_PERIOD });
    expect(final).toMatchObject({ status: "final", retroactive: true });
    expect((await journalOfEvent(t.db, tripEventId))!.status).toBe("posted");
  });
});
