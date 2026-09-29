/**
 * Uji integrasi ronde P3 + P2: Aplikasi Pelanggan (P2) ↔ Akuntansi (M11). P2 membentuk pelunasan M5 kanal `digital` lalu
 * memancarkan `collection.recorded` DAN `digital_payment.succeeded` untuk satu pembayaran gerbang. M11 menjurnal keduanya;
 * sebelum integrasi, pemetaan `digital_payment.succeeded/default` (Dr 1-1301 / Cr 1-1401) ikut dijurnal sehingga piutang
 * dikredit dua kali. Berkas ini memastikan:
 * - pelunasan piutang/uang muka dijurnal SEKALI (dari `collection.recorded`);
 * - `digital_payment.succeeded` hanya membukukan biaya gerbang sebagai beban (PTB-50);
 * - tanpa handler lintas modul yang gagal diam-diam (insiden).
 */
import { and, eq, inArray, like, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { accounts, customerAdvances, customerPayments, incidents, incomingTransfers, invoices, journalLines, journals, paymentIntents, trips } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { addDays } from "@/lib/time";
import * as m4 from "@/server/modules/m4-cash";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { emitEvent, finance, setPeriod, tripPayload } from "../m11-accounting/helpers";
import { enableApp, linkedCustomer, minutes, refresh, TODAY } from "../p2-customer/helpers";

type Totals = Record<string, { debit: number; credit: number }>;

/** Total debit/kredit per kode akun atas jurnal otomatis objek sumber tertentu. */
async function totalsFor(db: Db, sources: { type: string; id: string }[]): Promise<Totals> {
  const rows = await db
    .select({ code: accounts.code, debit: journalLines.debit, credit: journalLines.credit, sourceType: journals.sourceObjectType, sourceId: journals.sourceObjectId })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journals.tenantId, EQUA_TENANT_ID),
        inArray(
          journals.sourceObjectId,
          sources.map((s) => s.id),
        ),
      ),
    );
  const out: Totals = {};
  for (const r of rows) {
    if (!sources.some((s) => s.type === r.sourceType && s.id === r.sourceId)) continue;
    const t = (out[r.code] ??= { debit: 0, credit: 0 });
    t.debit += Number(r.debit ?? 0);
    t.credit += Number(r.credit ?? 0);
  }
  return out;
}

async function crossModuleIncidents(db: Db) {
  return db
    .select({ title: incidents.title })
    .from(incidents)
    .where(or(like(incidents.title, "%(m11-accounting:%"), like(incidents.title, "%(p2-customer:%")));
}

let invSeq = 0;
async function openInvoice(db: Db, customerId: string, amount: number) {
  invSeq++;
  const [row] = await db
    .insert(invoices)
    .values({
      tenantId: EQUA_TENANT_ID,
      number: `F-26-9${String(invSeq).padStart(5, "0")}`,
      kind: "delivery",
      customerId,
      issueDate: addDays(TODAY, -10),
      dueDate: addDays(TODAY, 5),
      amount,
      outstandingAmount: amount,
      status: "open",
    })
    .returning();
  return row!;
}

describe("Integrasi P2 ↔ M11: pembayaran digital dijurnal sekali + biaya gerbang", () => {
  const t = useTestDb({ seed: true });

  beforeAll(async () => {
    bootstrapForTests();
    await enableApp();
    await setPeriod(t.db, TODAY.slice(0, 7), "open");
    p2.setPaymentGatewayForTests(p2.mockGateway());
  });
  afterAll(() => p2.setPaymentGatewayForTests(undefined));

  it("US-P2-04 KP-3 bayar tagihan lewat QRIS → piutang 1-1401 dikredit sekali (collection.recorded), biaya gerbang Dr beban / Cr transfer belum dicocokkan (PTB-50)", async () => {
    const a = await linkedCustomer(t.db, { creditStatus: "credit", creditLimit: 5_000_000 });
    const inv = await openInvoice(t.db, a.customer.id, 600_000);
    const otp = await p2.requestPaymentOtp(await refresh(a.token, minutes(5)));
    await p2.verifyPaymentOtp(await refresh(a.token, minutes(5)), { code: otp.devCode! });
    const intent = await p2.createPaymentIntent(await refresh(a.token, minutes(6)), { target: "invoice", invoiceId: inv.id, method: "qris_dynamic" });
    await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(10) });

    const [pay] = await t.db.select().from(customerPayments).where(eq(customerPayments.paymentIntentId, intent.id));
    expect(pay).toMatchObject({ channel: "digital", amount: 600_000, advanceAmount: 0 });
    const totals = await totalsFor(t.db, [
      { type: "customer_payment", id: pay!.id },
      { type: "payment_intent", id: intent.id },
    ]);
    // QRIS 0,7% × 600.000 = 4.200 (p2.payment_rules).
    expect(totals["1-1401"]).toEqual({ debit: 0, credit: 600_000 });
    expect(totals["1-1301"]).toEqual({ debit: 600_000, credit: 4_200 });
    expect(totals["6-1901"]).toEqual({ debit: 4_200, credit: 0 });
    const intentJournals = await t.db.select().from(journals).where(and(eq(journals.sourceObjectType, "payment_intent"), eq(journals.sourceObjectId, intent.id)));
    expect(intentJournals).toHaveLength(1);
    expect(intentJournals[0]).toMatchObject({ status: "posted" });
  });

  it("US-P2-04 KP-4 bayar di muka pesanan → seluruh nilai menjadi uang muka 2-1201 sekali (tanpa kredit piutang ganda)", async () => {
    const a = await linkedCustomer(t.db);
    const [addr] = await p2.listMyAddresses(a.cctx);
    const placed = await p2.placeOrder(a.cctx, { addressId: addr!.id, tankCount: 1, date: TODAY, slot: "afternoon", paymentMethod: "digital" });
    const intent = await p2.createPaymentIntent(a.cctx, { target: "order", orderId: placed.orderId, method: "virtual_account" });
    await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(15) });

    const [pay] = await t.db.select().from(customerPayments).where(eq(customerPayments.paymentIntentId, intent.id));
    expect(pay!.advanceAmount).toBe(placed.total);
    const totals = await totalsFor(t.db, [
      { type: "customer_payment", id: pay!.id },
      { type: "payment_intent", id: intent.id },
    ]);
    // Dr 1-1301 / Cr 1-1401 lalu Dr 1-1401 / Cr 2-1201 → piutang netral, uang muka = nilai bayar.
    expect(totals["1-1401"]).toEqual({ debit: placed.total, credit: placed.total });
    expect(totals["2-1201"]).toEqual({ debit: 0, credit: placed.total });
    expect(totals["1-1301"]!.debit).toBe(placed.total);
    const [pi] = await t.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
    expect(pi!.gatewayFee).toBeGreaterThan(0);
    expect(totals["6-1901"]).toEqual({ debit: pi!.gatewayFee, credit: 0 });
  });

  it("B-63 US-M4-04 KP-2 PTB-50 transfer masuk pembayaran digital = settlement neto (bruto − biaya gerbang); dicocokkan dengan mutasi neto → akun perantara 1-1301 kembali nol", async () => {
    const a = await linkedCustomer(t.db, { creditStatus: "credit", creditLimit: 5_000_000 });
    const inv = await openInvoice(t.db, a.customer.id, 800_000);
    const otp = await p2.requestPaymentOtp(await refresh(a.token, minutes(5)));
    await p2.verifyPaymentOtp(await refresh(a.token, minutes(5)), { code: otp.devCode! });
    const intent = await p2.createPaymentIntent(await refresh(a.token, minutes(6)), { target: "invoice", invoiceId: inv.id, method: "qris_dynamic" });
    await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(10) });
    const [pi] = await t.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
    const fee = pi!.gatewayFee!;
    expect(fee).toBe(5_600); // QRIS 0,7% × 800.000 (p2.payment_rules)
    const [tr] = await t.db.select().from(incomingTransfers).where(and(eq(incomingTransfers.sourceObjectType, "payment_intent"), eq(incomingTransfers.sourceObjectId, intent.id)));
    expect(tr).toMatchObject({ sourceKind: "digital_payment", amount: 800_000 - fee, status: "unmatched" });
    expect(tr!.notes).toMatch(/bruto Rp\s?800\.000 − biaya gerbang Rp\s?5\.600/);
    // Mutasi bruto (tanpa potongan gerbang) tidak cocok; mutasi settlement neto cocok.
    await expect(m4.matchTransfer(finance(minutes(60)), { transferId: tr!.id, refDate: TODAY, refAmount: 800_000, refNote: "Settlement Midtrans" })).rejects.toThrow(/berbeda dengan transfer tercatat/);
    await m4.matchTransfer(finance(minutes(60)), { transferId: tr!.id, refDate: TODAY, refAmount: 800_000 - fee, refNote: "Settlement Midtrans" });
    const [pay] = await t.db.select().from(customerPayments).where(eq(customerPayments.paymentIntentId, intent.id));
    const totals = await totalsFor(t.db, [
      { type: "customer_payment", id: pay!.id },
      { type: "payment_intent", id: intent.id },
      { type: "incoming_transfer", id: tr!.id },
    ]);
    expect(totals["1-1301"]!.debit - totals["1-1301"]!.credit).toBe(0);
    expect(totals["1-1201"]).toEqual({ debit: 800_000 - fee, credit: 0 });
    expect(totals["6-1901"]).toEqual({ debit: fee, credit: 0 });
    expect(totals["1-1401"]).toEqual({ debit: 0, credit: 800_000 });
    // P2: pembayaran berstatus Dicocokkan (US-P2-04 KP-3) merujuk transfer settlement neto.
    expect((await t.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id)))[0]).toMatchObject({ status: "matched", incomingTransferId: tr!.id });
  });

  it("B-65 US-P2-04 KP-4 D-11 butir 4 rit prabayar digital Selesai → faktur rit lunas oleh uang muka; pendapatan diakui terhadap uang muka 2-1201 (bukan kurang bayar/tempo)", async () => {
    const a = await linkedCustomer(t.db);
    const [addr] = await p2.listMyAddresses(a.cctx);
    const placed = await p2.placeOrder(a.cctx, { addressId: addr!.id, tankCount: 1, date: TODAY, slot: "afternoon", paymentMethod: "digital" });
    const intent = await p2.createPaymentIntent(a.cctx, { target: "order", orderId: placed.orderId, method: "virtual_account" });
    await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(15) });
    const [trip] = await t.db.select().from(trips).where(eq(trips.orderId, placed.orderId));
    expect(trip!.paymentMethod).toBe("digital");
    // M3 (paket A) memancarkan rit Selesai berbayar digital: tanpa uang diterima sopir, tanpa kurang bayar.
    await t.db.update(trips).set({ status: "completed", deliveredVolumeL: trip!.plannedVolumeL, completionBusinessDate: TODAY }).where(eq(trips.id, trip!.id));
    await emitEvent(
      "trip.completed",
      tripPayload({ tripId: trip!.id, orderId: placed.orderId, customerId: a.customer.id, price: trip!.price, paymentMethod: "digital", cashReceived: 0, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0, businessDate: TODAY, tripNumber: trip!.number }),
    );
    const tripInvoices = await t.db.select().from(invoices).where(eq(invoices.tripId, trip!.id));
    expect(tripInvoices.map((i) => i.kind)).toEqual(["delivery"]);
    expect(tripInvoices[0]).toMatchObject({ amount: trip!.price, outstandingAmount: 0, status: "paid" });
    const [pay] = await t.db.select().from(customerPayments).where(eq(customerPayments.paymentIntentId, intent.id));
    const [adv] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.sourcePaymentId, pay!.id));
    expect(adv).toMatchObject({ remainingAmount: 0, status: "applied" });
    // Idempoten: peristiwa yang sama terkirim ulang tidak menerbitkan faktur kedua.
    const totals = await totalsFor(t.db, [
      { type: "customer_payment", id: pay!.id },
      { type: "trip", id: trip!.id },
      { type: "invoice", id: tripInvoices[0]!.id },
    ]);
    // Pendapatan diakui; piutang netral; uang muka terpakai habis → pendapatan terhadap uang muka.
    expect(totals["4-1101"]).toEqual({ debit: 0, credit: trip!.price });
    expect(totals["1-1401"]!.debit - totals["1-1401"]!.credit).toBe(0);
    expect(totals["2-1201"]).toEqual({ debit: trip!.price, credit: trip!.price });
    // Bukan kurang bayar/tempo: tidak ada faktur kurang bayar dan saldo piutang pelanggan nol.
    expect(tripInvoices.some((i) => i.kind === "underpayment")).toBe(false);
  });

  it("tanpa insiden handler lintas modul (M11/P2) selama alur pembayaran digital", async () => {
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });
});
