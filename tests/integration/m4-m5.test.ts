/**
 * Uji integrasi ronde M4 + M5: Kas & Setoran (M4) ↔ Piutang & Penagihan (M5) lewat event domain. Kedua modul dibangun
 * paralel dan masing-masing menguji sisinya dengan event tiruan; berkas ini memastikan keduanya tersambung setelah
 * digabung (event nyata dari layanan modul lain) dan tidak ada handler lintas modul yang gagal diam-diam (insiden).
 */
import { eq, like, or } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { creditNotes, customerAdvances, incidents, incomingTransfers, officeCashMovements } from "@/db/schema";
import { EQUA_TENANT_ID, customerId } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import * as m4 from "@/server/modules/m4-cash";
import * as m5 from "@/server/modules/m5-receivables";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { at, finance as financeAt, isolateCashDays } from "../m4-cash/helpers";
import { attachment, creditCustomer, customerRow, finance, invoiceFor, invoiceRow, owner, today } from "../m5-receivables/helpers";

/** Insiden dari handler M4/M5 yang gagal (handler terisolasi savepoint tidak menggagalkan transaksi sumber). */
async function crossModuleIncidents(db: Db) {
  return db
    .select({ title: incidents.title, description: incidents.description })
    .from(incidents)
    .where(or(like(incidents.title, "%(m4-cash:%"), like(incidents.title, "%(m5-receivables:%")));
}

async function officeCashFor(db: Db, sourceObjectId: string) {
  return db.select().from(officeCashMovements).where(eq(officeCashMovements.sourceObjectId, sourceObjectId));
}

const officeClosing = async (date: string) => (await m4.getOfficeCash(finance(date), { date })).day.closing;

describe("Integrasi M5 → M4: pelunasan & pengembalian uang muka di kantor menggerakkan kas kantor / transfer masuk", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-02 KP-1 US-M4-01 KP-3 pelunasan tunai kantor (M5) masuk kas kantor M4; pembaliknya (US-M5-02 KP-4) keluar merujuk mutasi asal; reklasifikasi internal & pelunasan lewat sopir tidak menggerakkan kas kantor", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Hotel Bayar di Kantor" });
    await invoiceFor(t.db, c.id, { amount: 300_000, issueDate: addDays(d, -10) });
    const before = await officeClosing(d);

    const pay = await m5.recordOfficePayment(finance(d), { customerId: c.id, businessDate: d, amount: 300_000, method: "cash" });
    const [mvIn] = await officeCashFor(t.db, pay.payment.id);
    expect(mvIn).toMatchObject({ kind: "customer_payment", direction: "in", amount: 300_000, businessDate: d, sourceObjectType: "customer_payment", reversalOfId: null });
    expect(mvIn!.description).toContain("Hotel Bayar di Kantor");
    expect(await officeClosing(d)).toBe(before + 300_000);

    const rev = await m5.reverseCustomerPayment(finance(d), { paymentId: pay.payment.id, reason: "Salah pelanggan" });
    if (rev.status !== "reversed") throw new Error("pembalik seharusnya langsung (≤ PAR-21)");
    const [mvOut] = await t.db.select().from(officeCashMovements).where(eq(officeCashMovements.reversalOfId, mvIn!.id));
    expect(mvOut).toMatchObject({ kind: "customer_payment", direction: "out", amount: 300_000, sourceObjectId: rev.reversal.id });
    expect(await officeClosing(d)).toBe(before);

    // Kanal/cara lain: reklasifikasi tunai rit (internal, 7.5.6) & pelunasan lewat sopir (masuk lewat setoran M4).
    for (const [channel, method] of [
      ["office", "internal"],
      ["driver", "cash"],
      ["office", "transfer"],
    ] as const) {
      const paymentId = newId();
      await withTx((tx) =>
        emit(
          tx,
          "collection.recorded",
          { customerPaymentId: paymentId, customerId: customerId("PLG-0024"), amount: 125_000, channel, method, allocations: [], advanceAmount: 0, businessDate: d },
          { ctx: systemContext({ tenantId: EQUA_TENANT_ID }), businessDate: d },
        ),
      );
      expect(await officeCashFor(t.db, paymentId)).toHaveLength(0);
    }
    expect(await officeClosing(d)).toBe(before);
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });

  it("US-M5-02 KP-3 pengembalian uang muka tunai yang disetujui pemilik (customer_refund) mengurangi kas kantor M4 per pengembalian; pengembalian lewat transfer tidak", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Hotel Uang Muka" });
    await invoiceFor(t.db, c.id, { amount: 50_000, issueDate: d });
    const pay = await m5.recordOfficePayment(finance(d), { customerId: c.id, businessDate: d, amount: 250_000, method: "cash" });
    const [adv] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.sourcePaymentId, pay.payment.id));
    expect(adv).toMatchObject({ amount: 200_000, remainingAmount: 200_000, status: "open" });
    const before = await officeClosing(d);

    const cash1 = await m5.requestAdvanceRefund(finance(d), { advanceId: adv!.id, amount: 80_000, method: "cash", reason: "Pelanggan minta dikembalikan" });
    await approvals.decide(owner(d), cash1.id, "approve");
    const [mv1] = await officeCashFor(t.db, cash1.id);
    expect(mv1).toMatchObject({ kind: "advance_refund", direction: "out", amount: 80_000, sourceObjectType: "approval_request", businessDate: d });

    const viaBank = await m5.requestAdvanceRefund(finance(d), { advanceId: adv!.id, amount: 50_000, method: "transfer", reason: "Sebagian lewat transfer" });
    await approvals.decide(owner(d), viaBank.id, "approve");
    expect(await officeCashFor(t.db, viaBank.id)).toHaveLength(0);

    // Pengembalian bertahap atas uang muka yang sama tetap tercatat masing-masing (tidak tertelan indeks unik sumber).
    const cash2 = await m5.requestAdvanceRefund(finance(d), { advanceId: adv!.id, amount: 70_000, method: "cash", reason: "Sisa dikembalikan tunai" });
    await approvals.decide(owner(d), cash2.id, "approve");
    expect(await officeCashFor(t.db, cash2.id)).toHaveLength(1);
    const [after] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.id, adv!.id));
    expect(after).toMatchObject({ remainingAmount: 0, status: "refunded" });
    expect(await officeClosing(d)).toBe(before - 80_000 - 70_000);
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });

  it("US-M4-04 KP-4 US-M5-01 KP-3 pelunasan kantor transfer (M5) menjadi transfer masuk M4; tidak ditemukan > PAR-39 hari → piutang sementara 'transfer belum diterima' (M5); mutasi datang & dicocokkan → piutang sementara ditutup", async () => {
    const d = today();
    const paidOn = addDays(d, -5);
    const c = await creditCustomer(t.db, { name: "Hotel Transfer Hilang" });
    const inv = await invoiceFor(t.db, c.id, { amount: 450_000, issueDate: addDays(d, -20) });
    const proof = await attachment(finance(paidOn), "transfer_proof");
    const pay = await m5.recordOfficePayment(finance(paidOn), { customerId: c.id, businessDate: paidOn, amount: 450_000, method: "transfer", proofAttachmentId: proof.id });
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ status: "paid", outstandingAmount: 0 });
    expect(await officeCashFor(t.db, pay.payment.id)).toHaveLength(0);
    const [tr] = await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceObjectId, pay.payment.id));
    expect(tr).toMatchObject({ sourceKind: "office_payment", sourceObjectType: "customer_payment", status: "unmatched", amount: 450_000, customerId: c.id, transferDate: paidOn, proofAttachmentId: proof.id });

    // Job M4 pagi hari: > PAR-39 hari tanpa mutasi → Tidak ditemukan → M5 membentuk piutang sementara.
    await m4.runTransferNotFoundCheck(at(d, "07:00"));
    expect((await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.id, tr!.id)))[0]).toMatchObject({ status: "not_found" });
    const temp = await m5.pendingTransferInvoice(t.db, tr!.id);
    expect(temp).toMatchObject({ customerId: c.id, amount: 450_000, outstandingAmount: 450_000, dueDate: d });
    expect((await m5.getReceivableBalance(t.db, c.id)).balance).toBe(450_000);

    // Mutasi ternyata masuk: Admin Keuangan mencocokkan (M4) → piutang sementara ditutup nota kredit reklasifikasi (M5).
    await m4.matchTransfer(financeAt(at(d, "10:00")), { transferId: tr!.id, refDate: d, refAmount: 450_000, refNote: "TRSF CR terlambat" });
    expect(await invoiceRow(t.db, temp!.id)).toMatchObject({ pendingTransferId: null, outstandingAmount: 0 });
    const notes = await t.db.select().from(creditNotes).where(eq(creditNotes.invoiceId, temp!.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ amount: 450_000, status: "issued" });
    expect((await m5.getReceivableBalance(t.db, c.id)).balance).toBe(0);
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });

  it("US-M5-02 KP-4 US-M4-04 KP-1 pembalik pelunasan transfer kantor yang belum dicocokkan → transfer masuk M4 Dibatalkan (tidak ditunggu lagi di mutasi, tanpa piutang sementara)", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Hotel Bukti Keliru" });
    await invoiceFor(t.db, c.id, { amount: 200_000, issueDate: addDays(d, -3) });
    const proof = await attachment(finance(d), "transfer_proof");
    const pay = await m5.recordOfficePayment(finance(d), { customerId: c.id, businessDate: d, amount: 200_000, method: "transfer", proofAttachmentId: proof.id });
    const [tr] = await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceObjectId, pay.payment.id));
    expect(tr).toMatchObject({ sourceKind: "office_payment", status: "unmatched", customerId: c.id });

    const rev = await m5.reverseCustomerPayment(finance(d), { paymentId: pay.payment.id, reason: "Bukti transfer keliru" });
    expect(rev.status).toBe("reversed");
    const [after] = await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.id, tr!.id));
    expect(after).toMatchObject({ status: "cancelled", cancelReason: "Bukti transfer keliru" });
    // Transfer dibatalkan tidak ikut job "Tidak ditemukan" → tidak ada piutang sementara.
    await m4.runTransferNotFoundCheck(at(addDays(d, 5), "07:00"));
    expect(await m5.pendingTransferInvoice(t.db, tr!.id)).toBeNull();
    expect(await officeCashFor(t.db, pay.payment.id)).toHaveLength(0);
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });
});

describe("Integrasi M4 → M5: tutup kas memicu evaluasi Ditahan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await isolateCashDays(t.db, today());
  });

  it("US-M4-06 KP-4 US-M5-03 KP-1 kas kantor sistem memuat pelunasan tunai kantor (M5); tutup kas nyata (M4, cash_day.closed) → faktur lewat tempo > PAR-09 Ditahan otomatis (M5)", async () => {
    const d = today();
    const late = await creditCustomer(t.db, { name: "Hotel Lewat Tempo" });
    await invoiceFor(t.db, late.id, { amount: 400_000, issueDate: addDays(d, -30), dueDate: addDays(d, -8) });
    const payer = await creditCustomer(t.db, { name: "Hotel Bayar Tunai" });
    await invoiceFor(t.db, payer.id, { amount: 350_000, issueDate: addDays(d, -30), dueDate: addDays(d, -8) });

    const systemBefore = (await m4.getCashDayScreen(financeAt(at(d, "18:00")))).officeCashSystem;
    await m5.recordOfficePayment(finance(d), { customerId: payer.id, businessDate: d, amount: 350_000, method: "cash" });
    const screen = await m4.getCashDayScreen(financeAt(at(d, "19:30")));
    expect(screen.canClose).toBe(true);
    expect(screen.officeCashSystem).toBe(systemBefore + 350_000);

    const closed = await m4.closeCashDay(financeAt(at(d, "19:40")), { officeCashPhysical: screen.officeCashSystem });
    expect(closed).toMatchObject({ status: "closed", officeCashDifference: 0 });
    expect((await customerRow(t.db, late.id)).creditStatus).toBe("on_hold");
    expect((await customerRow(t.db, payer.id)).creditStatus).toBe("credit");
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });
});
