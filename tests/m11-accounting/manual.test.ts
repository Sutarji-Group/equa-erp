import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, journals, manualJournalDetails } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { isHardeningViolation } from "@/db/hardening";
import { newId } from "@/lib/ids";
import { addDays, firstDayOfMonth, lastDayOfMonth } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { ForbiddenError } from "@/server/core/errors";
import * as m11 from "@/server/modules/m11-accounting";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { THIS_PERIOD, TODAY, acc, accountant, at, emitEvent, evidence, finance, journalById, journalOfEvent, linesOf, manualJournal, notificationsOf, owner, pair, periodRow } from "./helpers";

describe("M11 jurnal manual dengan lampiran & persetujuan (US-M11-03)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M11-03 KP-1 jurnal manual: tanggal, akun debit/kredit, pusat laba, jumlah, keterangan, lampiran WAJIB; template jenis berulang tersedia", async () => {
    const fa = finance();
    const templates = await m11.manualTemplates(accountant());
    expect(templates.map((x) => x.key).sort()).toEqual(["bank_fee", "electricity", "fuel", "maintenance", "other", "rent", "salary"]);
    const electricity = templates.find((x) => x.key === "electricity")!;
    expect(electricity.debitAccountId).toBe(acc("6-1301"));
    expect(templates.find((x) => x.key === "salary")!.deductionAccountId).toBe(acc("2-1301"));

    const draft = await m11.createManualJournal(fa, {
      date: TODAY,
      description: "Pemeliharaan pompa depot",
      template: "maintenance",
      lines: [
        { accountId: acc("6-1401"), profitCenter: "L3", debit: 350_000, memo: "Ganti seal pompa" },
        { accountId: acc("1-1101"), profitCenter: "SHARED", credit: 350_000 },
      ],
    });
    expect(draft).toMatchObject({ kind: "manual", status: "draft", templateKey: "maintenance", totalDebit: 350_000, sourceType: "manual" });
    await expect(m11.submitManualJournal(fa, { journalId: draft.id })).rejects.toThrow(/Lampiran bukti.*wajib/);
    await m11.attachJournalEvidence(fa, { journalId: draft.id, attachmentId: await evidence(fa) });
    const res = await m11.submitManualJournal(fa, { journalId: draft.id });
    expect(res.status).toBe("posted");
    expect((await linesOf(t.db, draft.id)).map((l) => [l.code, l.profitCenter, l.debit, l.credit])).toEqual([
      ["6-1401", "L3", 350_000, 0],
      ["1-1101", "SHARED", 0, 350_000],
    ]);
    // Validasi baris: satu sisi per baris, minimal 2 baris, pusat laba wajib.
    await expect(m11.createManualJournal(fa, { date: TODAY, description: "Satu baris saja", lines: [{ accountId: acc("6-1401"), profitCenter: "L3", debit: 1 }] })).rejects.toThrow(/minimal dua baris/);
    await expect(
      m11.createManualJournal(fa, { date: TODAY, description: "Debit & kredit sekaligus", lines: [{ accountId: acc("6-1401"), profitCenter: "L3", debit: 5, credit: 5 }, { accountId: acc("1-1101"), profitCenter: "SHARED", credit: 0 }] }),
    ).rejects.toThrow(/salah satu/);
    // Pemilik tidak menginput jurnal (hanya menyetujui/meninjau).
    await expect(m11.createManualJournal(owner(), { date: TODAY, description: "Jurnal oleh pemilik", lines: [...pair("6-1401", "1-1101", 1_000)] })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M11-03 KP-2 jurnal > Rp 5 juta (PAR-20) diajukan ke pemilik sebelum terposting; ditolak → tidak terposting", async () => {
    const fa = finance();
    const big = await manualJournal(fa, { date: TODAY, description: "Perbaikan besar truk T1", lines: pair("6-1401", "1-1201", 6_000_000, { debit: "L2" }) });
    expect(big.submitted.status).toBe("submitted");
    if (big.submitted.status !== "submitted") return;
    expect(await journalById(t.db, big.draft.id)).toMatchObject({ status: "submitted", periodId: expect.any(String) });
    const [req] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, big.submitted.approvalId));
    expect(req).toMatchObject({ type: "manual_journal", objectType: "journal", objectId: big.draft.id, amount: 6_000_000, status: "submitted" });
    await approvals.decide(owner(), big.submitted.approvalId, "approve");
    const posted = await journalById(t.db, big.draft.id);
    expect(posted).toMatchObject({ status: "posted", approvalRequestId: big.submitted.approvalId, requiresOwnerReview: false });

    const other = await manualJournal(fa, { date: TODAY, description: "Pembelian ban (ditolak)", lines: pair("6-1401", "1-1201", 7_500_000, { debit: "L2" }) });
    if (other.submitted.status !== "submitted") throw new Error("harus diajukan");
    await approvals.decide(owner(), other.submitted.approvalId, "reject", "Tunggu penawaran lain");
    expect(await journalById(t.db, other.draft.id)).toMatchObject({ status: "rejected", postedAt: null });
  });

  it("US-M11-03 KP-2 jurnal ≤ Rp 5 juta terposting oleh Admin Keuangan dan masuk daftar tinjauan wajib pemilik; pemilik menandai 'ditinjau' (PTB-12)", async () => {
    const fa = finance();
    const edge = await manualJournal(fa, { date: TODAY, description: "Listrik kantor tepat ambang", lines: pair("6-1301", "1-1201", 5_000_000) });
    expect(edge.submitted.status).toBe("posted");
    const row = await journalById(t.db, edge.draft.id);
    expect(row).toMatchObject({ requiresOwnerReview: true, ownerReviewedAt: null });
    const notes = await notificationsOf(t.db, "journal.owner_review", edge.draft.id);
    expect(notes.length).toBeGreaterThan(0);
    const period = await periodRow(t.db, THIS_PERIOD);
    const list = await m11.ownerReviewList(owner(), { periodId: period!.id });
    expect(list.some((j) => j.id === edge.draft.id)).toBe(true);
    await expect(m11.markManualJournalsReviewed(fa, { periodId: period!.id })).rejects.toBeInstanceOf(ForbiddenError);
    const marked = await m11.markManualJournalsReviewed(owner(), { periodId: period!.id, note: "Sudah dicek dengan nota" });
    expect(marked.reviewed).toBeGreaterThanOrEqual(1);
    expect((await journalById(t.db, edge.draft.id)).ownerReviewedAt).not.toBeNull();
    expect((await periodRow(t.db, THIS_PERIOD))!.manualReviewMarkedAt).not.toBeNull();
  });

  it("US-M11-03 KP-3 jurnal manual terposting tidak dapat diubah; koreksi lewat pembalik beralasan; > Rp 500.000 (PAR-21) dengan persetujuan pemilik", async () => {
    const fa = finance();
    const small = await manualJournal(fa, { date: TODAY, description: "Biaya bank bulan ini", template: "bank_fee", lines: pair("6-1901", "1-1201", 25_000) });
    await expect(m11.cancelManualJournal(fa, { journalId: small.draft.id, reason: "Salah input" })).rejects.toThrow(/tidak dapat dibatalkan/);
    const upd = await t.db
      .update(journals)
      .set({ description: "Diubah diam-diam" })
      .where(eq(journals.id, small.draft.id))
      .catch((e: unknown) => e);
    expect(isHardeningViolation(upd)).toBe(true);
    await expect(m11.reverseManualJournal(fa, { journalId: small.draft.id, reason: "" })).rejects.toThrow(/Alasan/);
    const rev = await m11.reverseManualJournal(fa, { journalId: small.draft.id, reason: "Biaya bank ternyata dibebankan bulan depan" });
    expect(rev.status).toBe("reversed");
    if (rev.status !== "reversed") return;
    expect(rev.reversal).toMatchObject({ kind: "reversal", reversalOfId: small.draft.id, status: "posted" });
    expect((await linesOf(t.db, rev.reversal.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["6-1901", 0, 25_000],
      ["1-1201", 25_000, 0],
    ]);
    await expect(m11.reverseManualJournal(fa, { journalId: small.draft.id, reason: "Balik lagi" })).rejects.toThrow(/sudah dibalik/);
    await expect(m11.reverseManualJournal(fa, { journalId: rev.reversal.id, reason: "Balik pembalik" })).rejects.toThrow(/tidak dapat dibalik lagi/);

    const mid = await manualJournal(fa, { date: TODAY, description: "Servis genset depot", lines: pair("6-1401", "1-1201", 800_000, { debit: "L3" }) });
    const pending = await m11.reverseManualJournal(fa, { journalId: mid.draft.id, reason: "Nota ganda dari bengkel" });
    expect(pending.status).toBe("pending_approval");
    if (pending.status !== "pending_approval") return;
    const [req] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, pending.approvalId));
    expect(req).toMatchObject({ type: "correction", objectType: "journal", objectId: mid.draft.id, amount: 800_000 });
    await approvals.decide(owner(), pending.approvalId, "approve");
    const [reversal] = await t.db.select().from(journals).where(eq(journals.reversalOfId, mid.draft.id));
    expect(reversal).toMatchObject({ kind: "reversal", status: "posted", approvalRequestId: pending.approvalId, totalDebit: 800_000 });
  });

  it("US-M11-03 KP-4 jurnal berulang bulanan (sewa K15) dibuat sebagai DRAF yang tetap memerlukan lampiran dan persetujuan sesuai ambang; idempoten per periode", async () => {
    const fa = finance();
    await expect(
      m11.saveRecurringJournal(accountant(), { name: "Sewa gudang", template: "rent", description: "Sewa gudang", lines: [...pair("6-1201", "1-1201", 6_000_000)] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const rec = await m11.saveRecurringJournal(fa, {
      name: "Sewa gudang milik pribadi (K15)",
      template: "rent",
      description: "Sewa gudang milik pribadi ke PT",
      lines: [...pair("6-1201", "1-1201", 6_000_000)],
      dayOfMonth: 1,
    });
    expect(rec).toMatchObject({ template: "rent", isActive: true });
    const created = await m11.generateRecurringDraftsNow(fa);
    expect(created).toHaveLength(1);
    const draft = await journalById(t.db, created[0]!);
    expect(draft).toMatchObject({ status: "draft", kind: "manual", journalDate: `${THIS_PERIOD}-01`, templateKey: "rent", attachmentId: null });
    const [details] = await t.db.select().from(manualJournalDetails).where(eq(manualJournalDetails.journalId, draft.id));
    expect(details).toMatchObject({ recurringJournalId: rec.id, recurringPeriod: THIS_PERIOD });
    expect((await notificationsOf(t.db, "journal.recurring_ready")).length).toBeGreaterThan(0);
    // Idempoten: tombol & job tidak membuat draf ganda.
    expect(await m11.generateRecurringDraftsNow(fa)).toHaveLength(0);
    expect(await m11.runRecurringDrafts(at(TODAY, "06:00"))).toBe(0);
    // Tetap wajib lampiran & persetujuan (> PAR-20).
    await expect(m11.submitManualJournal(fa, { journalId: draft.id })).rejects.toThrow(/Lampiran/);
    await m11.attachJournalEvidence(fa, { journalId: draft.id, attachmentId: await evidence(fa) });
    expect((await m11.submitManualJournal(fa, { journalId: draft.id })).status).toBe("submitted");
  });

  it("US-M11-03 KP-5 gaji = jurnal manual total per bulan dari rekap; potongan ganti rugi dari rekap → pelunasan piutang karyawan (PTB-22)", async () => {
    const fa = finance();
    const salary = await manualJournal(fa, {
      date: TODAY,
      description: "Gaji bulan ini (rekap penggajian di luar sistem)",
      template: "salary",
      lines: [
        { accountId: acc("6-1101"), profitCenter: "SHARED", debit: 4_500_000 },
        { accountId: acc("1-1201"), profitCenter: "SHARED", credit: 4_300_000 },
        { accountId: acc("2-1301"), profitCenter: "SHARED", credit: 200_000, memo: "Potongan ganti rugi sopir" },
      ],
    });
    expect(salary.submitted.status).toBe("posted");
    // M4: pelunasan ganti rugi lewat potongan penggajian → utang gaji / piutang karyawan.
    const ev = await emitEvent("restitution.settled", { restitutionId: newId(), employeeId: newId(), amount: 200_000, method: "payroll_deduction", settlementId: newId(), settledOn: TODAY });
    const j = await journalOfEvent(t.db, ev.id);
    expect((await linesOf(t.db, j!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["2-1301", 200_000, 0],
      ["1-1402", 0, 200_000],
    ]);
    const ledger = await m11.getLedger(accountant(), { accountId: acc("2-1301"), fromPeriod: THIS_PERIOD });
    expect(ledger.closing).toBe(0);
  });

  it("US-M11-03 KP-6 jurnal akrual dibalik otomatis tanggal 1 periode berikutnya; mengikuti ambang & lampiran", async () => {
    const fa = finance();
    const noAttach = await m11.createManualJournal(fa, { date: TODAY, description: "Akrual listrik tanpa bukti", isAccrual: true, lines: [...pair("6-1301", "2-1401", 900_000)] });
    await expect(m11.submitManualJournal(fa, { journalId: noAttach.id })).rejects.toThrow(/Lampiran/);
    const accrual = await manualJournal(fa, { date: lastDayOfMonth(TODAY), description: "Akrual listrik sumber air belum ditagih", isAccrual: true, lines: pair("6-1301", "2-1401", 900_000, { debit: "L1" }) });
    expect(accrual.submitted.status).toBe("posted");
    const nextFirst = firstDayOfMonth(addDays(lastDayOfMonth(TODAY), 1));
    expect(await journalById(t.db, accrual.draft.id)).toMatchObject({ kind: "accrual", autoReverseOn: nextFirst });
    // Belum jatuh tempo → tidak dibalik.
    expect(await m11.runAccrualReversals(at(TODAY, "00:30"))).toBe(0);
    expect(await m11.runAccrualReversals(at(nextFirst, "00:30"))).toBe(1);
    expect(await m11.runAccrualReversals(at(nextFirst, "00:31"))).toBe(0);
    const [rev] = await t.db.select().from(journals).where(and(eq(journals.reversalOfId, accrual.draft.id), eq(journals.tenantId, EQUA_TENANT_ID)));
    expect(rev).toMatchObject({ kind: "accrual_reversal", journalDate: nextFirst, status: "posted" });
    expect((await linesOf(t.db, rev!.id)).map((l) => [l.code, l.profitCenter, l.debit, l.credit])).toEqual([
      ["6-1301", "L1", 0, 900_000],
      ["2-1401", "SHARED", 900_000, 0],
    ]);
    // Akrual di atas ambang tetap lewat persetujuan pemilik.
    const bigAccrual = await manualJournal(fa, { date: TODAY, description: "Akrual gaji belum dibayar", isAccrual: true, lines: pair("6-1101", "2-1301", 9_000_000) });
    expect(bigAccrual.submitted.status).toBe("submitted");
  });
});
