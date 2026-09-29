import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accounts, bankAccounts, eventAccountMappings, journalLines, journalQueue, journals, trips } from "@/db/schema";
import { EQUA_TENANT_ID, outletId } from "@/db/seed";
import { isHardeningViolation } from "@/db/hardening";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";
import { ForbiddenError } from "@/server/core/errors";
import * as m11 from "@/server/modules/m11-accounting";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { PRICE, driverDay } from "../m4-cash/helpers";
import { expectApplied, isi, openShiftVia, posFor, sellVia } from "../m6-pos/helpers";
import {
  THIS_PERIOD,
  TODAY,
  acc,
  accountant,
  at,
  emitEvent,
  finance,
  journalOfEvent,
  journalsOfSource,
  linesOf,
  notificationsOf,
  queueOfEvent,
  setPeriod,
  tripPayload,
} from "./helpers";

describe("M11 jurnal otomatis dari transaksi operasional (US-M11-02)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M11-02 KP-1 rit Selesai (sinkron sopir) → satu jurnal otomatis L2 per rit dengan rujukan nomor rit; setoran diterima → kas kantor + selisih kurang pada pusat laba sumber", async () => {
    const d = await driverDay(t.db, { trips: 2, transferTrips: 1 });
    expect(d.tripIds).toHaveLength(3);
    const [cashTrip, , transferTrip] = d.tripIds as [string, string, string];

    const cashJournals = await journalsOfSource(t.db, "trip", cashTrip);
    expect(cashJournals).toHaveLength(1);
    const [tripRow] = await t.db.select().from(trips).where(eq(trips.id, cashTrip));
    expect(cashJournals[0]).toMatchObject({ kind: "auto", status: "posted", sourceType: "trip.completed", journalDate: d.date, totalDebit: PRICE });
    expect(cashJournals[0]!.description).toContain(tripRow!.number!);
    expect((await linesOf(t.db, cashJournals[0]!.id)).map((l) => [l.code, l.profitCenter, l.debit, l.credit])).toEqual([
      ["1-1102", "L2", PRICE, 0],
      ["4-1101", "L2", 0, PRICE],
    ]);
    const transferLines = await linesOf(t.db, (await journalsOfSource(t.db, "trip", transferTrip))[0]!.id);
    expect(transferLines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["1-1301", PRICE, 0],
      ["4-1101", 0, PRICE],
    ]);

    // Setoran diterima dengan selisih kurang 10.000 (alasan dari daftar): kas kantor / kas sopir + beban selisih L2.
    const received = 2 * PRICE - 10_000;
    await m4.receiveDeposit(finance(at(d.date, "15:00")), { depositId: d.depositId, receivedAmount: received, discrepancyReason: "wrong_change", discrepancyNote: "Kembalian salah" });
    const dep = await journalsOfSource(t.db, "deposit", d.depositId);
    expect(dep).toHaveLength(1);
    expect((await linesOf(t.db, dep[0]!.id)).map((l) => [l.code, l.profitCenter, l.debit, l.credit])).toEqual([
      ["1-1101", "SHARED", received, 0],
      ["1-1102", "L2", 0, received],
      ["6-1601", "L2", 10_000, 0],
      ["1-1102", "L2", 0, 10_000],
    ]);
  });

  it("US-M11-02 KP-1 penjualan POS depot → pendapatan L3 per outlet; void → jurnal pembalik (jurnal asal tidak berubah) dan jurnal otomatis tidak dapat dibalik/diubah manual", async () => {
    const pos = await posFor("D02");
    const { shiftId, res } = await openShiftVia(pos, { counted: 200_000 });
    expectApplied(res);
    const a = await sellVia(pos, shiftId, [isi(2)], { method: "cash", cashReceived: 10_000 });
    const b = await sellVia(pos, shiftId, [isi(3)], { method: "qris", qrisReference: "QR-UJI-1" });
    expectApplied(a.res);
    expectApplied(b.res);
    const ja = (await journalsOfSource(t.db, "pos_sale", a.saleId))[0]!;
    expect((await linesOf(t.db, ja.id)).map((l) => [l.code, l.profitCenter, l.outletId, l.debit, l.credit])).toEqual([
      ["1-1103", "L3", outletId("D02"), 10_000, 0],
      ["4-1201", "L3", outletId("D02"), 0, 10_000],
    ]);
    const jb = (await journalsOfSource(t.db, "pos_sale", b.saleId))[0]!;
    expect((await linesOf(t.db, jb.id)).map((l) => [l.code, l.profitCenter])).toEqual([
      ["1-1301", "SHARED"],
      ["4-1201", "L3"],
    ]);

    expectApplied(await pos.send("m6.pos_sale.void", { saleId: a.saleId, reason: "wrong_quantity" }));
    const after = await journalsOfSource(t.db, "pos_sale", a.saleId);
    expect(after).toHaveLength(2);
    const reversal = after.find((j) => j.kind === "reversal")!;
    expect(reversal).toMatchObject({ reversalOfId: ja.id, status: "posted", sourceType: "pos_sale.voided" });
    expect((await linesOf(t.db, reversal.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["1-1103", 0, 10_000],
      ["4-1201", 10_000, 0],
    ]);
    // Jurnal asal tetap utuh.
    expect((await linesOf(t.db, ja.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["1-1103", 10_000, 0],
      ["4-1201", 0, 10_000],
    ]);
    await expect(m11.reverseManualJournal(finance(), { journalId: jb.id, reason: "Koreksi manual dicoba" })).rejects.toThrow(/Jurnal otomatis tidak dapat diubah/);
    const err = await t.db
      .update(journalLines)
      .set({ debit: 1 })
      .where(eq(journalLines.journalId, jb.id))
      .catch((e: unknown) => e);
    expect(isHardeningViolation(err)).toBe(true);
  });

  it("US-M11-02 KP-1 (B-30) setor bank dengan slip mendebit akun buku rekening; pencocokan mutasinya tidak dijurnal ulang; invoice.issued tidak dijurnal (B-31)", async () => {
    const bankGl = await m11.createAccount(finance(), { code: "1-1209", name: "Bank Uji Slip", type: "asset", isCash: true, profitCenter: "SHARED" });
    const [bank] = await t.db
      .insert(bankAccounts)
      .values({ tenantId: EQUA_TENANT_ID, bankName: "Bank Uji", accountNumber: "999", accountName: "EQUA", glAccountId: bankGl.id })
      .returning();
    const depositId = newId();
    const ev = await emitEvent("deposit.received", {
      depositId,
      sourceType: "depot_shift",
      outletId: outletId("D03"),
      expectedAmount: 150_000,
      receivedAmount: 150_000,
      discrepancyAmount: 0,
      receivedBy: finance().userId!,
      late: false,
      method: "bank_slip",
      bankAccountId: bank!.id,
    });
    const j = await journalOfEvent(t.db, ev.id);
    expect((await linesOf(t.db, j!.id)).map((l) => [l.code, l.profitCenter, l.debit, l.credit])).toEqual([
      ["1-1209", "SHARED", 150_000, 0],
      ["1-1103", "L3", 0, 150_000],
    ]);
    const matched = await emitEvent("transfer.matched", { incomingTransferId: newId(), amount: 150_000, sourceKind: "bank_deposit_slip", bankAccountId: bank!.id, matchedAt: new Date().toISOString() });
    expect(await journalOfEvent(t.db, matched.id)).toBeNull();
    expect(await queueOfEvent(t.db, matched.id)).toBeNull();
    expect(m11.isJournaledEvent("invoice.issued")).toBe(false);
  });

  it("US-M11-02 KP-2 tanggal jurnal = tanggal bisnis peristiwa; peristiwa terlambat ke periode Ditutup diposting ke periode terbuka pertama dengan penanda asal periode", async () => {
    const first = `${THIS_PERIOD}-01`;
    const onTime = await emitEvent("trip.completed", tripPayload({ businessDate: first }), { businessDate: first });
    const j1 = await journalOfEvent(t.db, onTime.id);
    expect(j1).toMatchObject({ journalDate: first, originPeriod: null, status: "posted" });

    const prev = addDays(first, -1);
    const prevPeriod = prev.slice(0, 7);
    await setPeriod(t.db, prevPeriod, "closed");
    await setPeriod(t.db, THIS_PERIOD, "open");
    try {
      const late = await emitEvent("trip.completed", tripPayload({ businessDate: prev, lateSync: true }), { businessDate: prev });
      const j2 = await journalOfEvent(t.db, late.id);
      expect(j2).toMatchObject({ journalDate: prev, originPeriod: prevPeriod, status: "posted" });
      const detail = await m11.getJournalDetail(accountant(), j2!.id);
      expect(detail.period).toBe(THIS_PERIOD);
    } finally {
      await setPeriod(t.db, prevPeriod, "open");
    }
  });

  it("US-M11-02 KP-3 pemetaan hilang → daftar tunggu beralasan + notifikasi Admin Keuangan (tidak hilang); pemetaan dilengkapi → diproses ulang otomatis", async () => {
    await t.db
      .update(eventAccountMappings)
      .set({ isActive: false })
      .where(and(eq(eventAccountMappings.eventKey, "trip.completed"), eq(eventAccountMappings.entryKey, "transfer")));
    const ev = await emitEvent("trip.completed", tripPayload({ paymentMethod: "transfer", cashReceived: 0, transferAmount: 300_000 }));
    expect(await journalOfEvent(t.db, ev.id)).toBeNull();
    const q = await queueOfEvent(t.db, ev.id);
    expect(q).toMatchObject({ status: "pending", reason: "mapping_missing", eventKey: "trip.completed" });
    expect(q!.message).toMatch(/trip\.completed \/ transfer/);
    expect((await notificationsOf(t.db, "journal.queued")).some((n) => n.objectId === q!.id || (n.body ?? "").includes("trip.completed"))).toBe(true);
    const queue = await m11.listJournalQueue(accountant(), { status: "pending" });
    expect(queue.some((r) => r.id === q!.id)).toBe(true);
    // Akuntan baca-saja: tidak dapat memproses ulang.
    await expect(m11.retryJournalQueueItem(accountant(), { queueId: q!.id })).rejects.toBeInstanceOf(ForbiddenError);

    const saved = await m11.saveMapping(finance(), {
      eventKey: "trip.completed",
      entryKey: "transfer",
      description: "Rit Selesai transfer (dipulihkan)",
      debitAccountId: acc("1-1301"),
      creditAccountId: acc("4-1101"),
      debitProfitCenter: "SHARED",
      creditProfitCenter: "L2",
      effectiveFrom: TODAY,
      reason: "Pemetaan dilengkapi setelah tinjauan akuntan",
    });
    expect(saved.retried.posted).toBeGreaterThanOrEqual(1);
    expect(await queueOfEvent(t.db, ev.id)).toMatchObject({ status: "resolved" });
    const j = await journalOfEvent(t.db, ev.id);
    expect(j).toMatchObject({ status: "posted", totalDebit: 300_000 });
  });

  it("US-M11-02 KP-3 akun nonaktif → daftar tunggu; galat tak terduga → daftar tunggu 'Lainnya'; debit–kredit diperiksa (jurnal tidak seimbang ditolak)", async () => {
    const [partnerRevenue] = await t.db.select().from(accounts).where(and(eq(accounts.tenantId, EQUA_TENANT_ID), eq(accounts.code, "4-1401")));
    await t.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, partnerRevenue!.id));
    const ev = await emitEvent("partner.subscription_invoiced", { invoiceId: newId(), partnerContractId: newId(), partnerTenantId: newId(), amount: 500_000, outletCount: 1 });
    const q = await queueOfEvent(t.db, ev.id);
    expect(q).toMatchObject({ status: "pending", reason: "account_inactive" });
    expect(q!.message).toContain("4-1401");
    await m11.reactivateAccount(finance(), { accountId: partnerRevenue!.id, reason: "Akun dipakai lagi untuk langganan mitra" });
    const retried = await m11.retryJournalQueueItem(finance(), { queueId: q!.id });
    expect(retried.status).toBe("posted");
    expect((await linesOf(t.db, (await journalOfEvent(t.db, ev.id))!.id)).map((l) => [l.code, l.profitCenter])).toEqual([
      ["1-1401", "SHARED"],
      ["4-1401", "L5"],
    ]);

    const bad = await emitEvent("trip.completed", tripPayload({ cashReceived: 100_000.5 }));
    expect(await journalOfEvent(t.db, bad.id)).toBeNull();
    expect(await queueOfEvent(t.db, bad.id)).toMatchObject({ status: "pending", reason: "other" });

    await expect(
      m11.createManualJournal(finance(), {
        date: TODAY,
        description: "Jurnal tidak seimbang",
        lines: [
          { accountId: acc("6-1301"), profitCenter: "SHARED", debit: 100_000 },
          { accountId: acc("1-1101"), profitCenter: "SHARED", credit: 90_000 },
        ],
      }),
    ).rejects.toThrow(/tidak seimbang/);
  });

  it("US-M11-02 KP-5 akuntan (baca-saja) menelusuri jurnal → transaksi sumber dan sebaliknya; jurnal per hari per modul direkonsiliasi dengan peristiwa H+0", async () => {
    const day = TODAY.endsWith("-03") ? `${THIS_PERIOD}-04` : `${THIS_PERIOD}-03`;
    const trip = tripPayload({ businessDate: day, cashReceived: 150_000, creditAmount: 100_000, paymentMethod: "cash" });
    await emitEvent("trip.completed", trip, { businessDate: day });
    const saleId = newId();
    await emitEvent(
      "pos_sale.recorded",
      { posSaleId: saleId, outletId: outletId("D01"), outletKind: "depot", shiftId: newId(), method: "cash", total: 25_000, discount: 0, lines: [], businessDate: day },
      { businessDate: day },
    );
    const ac = accountant();
    const forTrip = await m11.journalsForSource(ac, { type: "trip", id: trip.tripId });
    expect(forTrip).toHaveLength(1);
    expect(forTrip[0]).toMatchObject({ module: "M3", kind: "auto" });
    const detail = await m11.getJournalDetail(ac, forTrip[0]!.id);
    expect(detail.source?.label).toContain("Rit");
    expect(detail.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
      ["1-1102", 150_000, 0],
      ["4-1101", 0, 150_000],
      ["1-1401", 100_000, 0],
      ["4-1101", 0, 100_000],
    ]);
    const posJ = await m11.journalsForSource(ac, { type: "pos_sale", id: saleId });
    expect((await m11.getJournalDetail(ac, posJ[0]!.id)).source?.href).toBe("/outlet");

    const recon = await m11.dailyReconciliation(ac, { date: day });
    const tripRow = recon.rows.find((r) => r.key === "trip")!;
    expect(tripRow).toMatchObject({ events: 1, journals: 1, eventValue: 250_000, journalValue: 250_000, match: true });
    expect(recon.rows.find((r) => r.key === "pos_depot")).toMatchObject({ events: 1, journals: 1, eventValue: 25_000, journalValue: 25_000, match: true });

    // Akuntan tidak dapat membuat jurnal (baca-saja).
    await expect(
      m11.createManualJournal(ac, { date: day, description: "Jurnal oleh akuntan", lines: [{ accountId: acc("6-1301"), profitCenter: "SHARED", debit: 1 }, { accountId: acc("1-1101"), profitCenter: "SHARED", credit: 1 }] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Jurnal otomatis tidak dapat dihapus (hardening).
    const del = await t.db
      .delete(journals)
      .where(eq(journals.id, forTrip[0]!.id))
      .catch((e: unknown) => e);
    expect(isHardeningViolation(del)).toBe(true);
    expect((await t.db.select().from(journalQueue).where(eq(journalQueue.tenantId, EQUA_TENANT_ID))).length).toBeGreaterThan(0);
  });

  it("B-65 US-M11-02 KP-1 uang muka dipakai pada faktur → Dr uang muka 2-1201 / Cr piutang 1-1401; bertanda negatif (alokasi dibatalkan) → sebaliknya; rit prabayar digital → pendapatan", async () => {
    const invoiceId = newId();
    const used = await emitEvent("customer_advance.applied", { customerId: newId(), invoiceId, invoiceNumber: "F-26-777001", customerAdvanceId: newId(), amount: 120_000, reason: "applied", businessDate: TODAY });
    expect((await linesOf(t.db, (await journalOfEvent(t.db, used.id))!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["2-1201", 120_000, 0],
      ["1-1401", 0, 120_000],
    ]);
    const back = await emitEvent("customer_advance.applied", { customerId: newId(), invoiceId, invoiceNumber: "F-26-777001", customerAdvanceId: null, amount: -20_000, reason: "overpayment_to_advance", businessDate: TODAY });
    expect((await linesOf(t.db, (await journalOfEvent(t.db, back.id))!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["1-1401", 20_000, 0],
      ["2-1201", 0, 20_000],
    ]);
    // Rit prabayar digital: pendapatan L2 penuh (sisi piutang dilunasi uang muka oleh M5), tanpa kas/transfer.
    const prepaid = tripPayload({ paymentMethod: "digital", cashReceived: 0, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0, price: 300_000 });
    const ev = await emitEvent("trip.completed", prepaid);
    expect((await linesOf(t.db, (await journalOfEvent(t.db, ev.id))!.id)).map((l) => [l.code, l.profitCenter, l.debit, l.credit])).toEqual([
      ["1-1401", "SHARED", 300_000, 0],
      ["4-1101", "L2", 0, 300_000],
    ]);
  });
});
