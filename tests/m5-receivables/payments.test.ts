import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, customerAdvances, customerPayments, domainEvents, invoices, paymentAllocations, waMessageLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import * as m5 from "@/server/modules/m5-receivables";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { completeCash, departArrive, driverWorld, expectApplied, PRICE } from "../m3-driver/helpers";
import { attachment, creditCustomer, dispatcher, finance, invoiceFor, invoiceRow, owner, today } from "./helpers";

async function eventsOf(db: ReturnType<typeof useTestDb>["db"], type: string, objectId: string) {
  return db.select().from(domainEvents).where(and(eq(domainEvents.type, type), eq(domainEvents.objectId, objectId)));
}

describe("US-M5-02 Mencatat pelunasan dan alokasinya", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-02 KP-1 pelunasan kantor: bawaan tertua dulu, sebagian/penuh; alokasi dapat diubah; tunai kantor & transfer diteruskan ke M4 lewat collection.recorded", async () => {
    const c = await creditCustomer(t.db);
    const d = today();
    const oldest = await invoiceFor(t.db, c.id, { amount: 300_000, issueDate: addDays(d, -30) });
    const newer = await invoiceFor(t.db, c.id, { amount: 500_000, issueDate: addDays(d, -5) });
    const res = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 400_000, method: "cash" });
    expect(res.allocations).toEqual([
      { invoiceId: oldest.id, amount: 300_000 },
      { invoiceId: newer.id, amount: 100_000 },
    ]);
    expect(await invoiceRow(t.db, oldest.id)).toMatchObject({ status: "paid", outstandingAmount: 0 });
    expect(await invoiceRow(t.db, newer.id)).toMatchObject({ status: "partial", paidAmount: 100_000, outstandingAmount: 400_000 });
    const [ev] = await eventsOf(t.db, "collection.recorded", res.payment.id);
    expect(ev!.payload).toMatchObject({ channel: "office", method: "cash", amount: 400_000, advanceAmount: 0 });
    // Alokasi dipilih sendiri (tidak harus tertua).
    const inv3 = await invoiceFor(t.db, c.id, { amount: 200_000, issueDate: addDays(d, -1) });
    const chosen = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 150_000, method: "cash", allocations: [{ invoiceId: inv3.id, amount: 150_000 }] });
    expect(chosen.allocations).toEqual([{ invoiceId: inv3.id, amount: 150_000 }]);
    expect(await invoiceRow(t.db, newer.id)).toMatchObject({ outstandingAmount: 400_000 });
    // Transfer: bukti wajib; rekening & bukti ikut event untuk pencocokan M4 (US-M4-04).
    await expect(m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 50_000, method: "transfer" })).rejects.toThrow(/Bukti transfer wajib/);
    const proof = await attachment(finance(), "transfer_proof");
    const tr = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 50_000, method: "transfer", proofAttachmentId: proof.id });
    const [trEv] = await eventsOf(t.db, "collection.recorded", tr.payment.id);
    expect(trEv!.payload).toMatchObject({ channel: "office", method: "transfer", proofAttachmentId: proof.id });
    // Tanggal di masa depan ditolak; alokasi melebihi sisa ditolak.
    await expect(m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: addDays(d, 1), amount: 1_000, method: "cash" })).rejects.toThrow(/setelah hari ini/);
    await expect(m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 900_000, method: "cash", allocations: [{ invoiceId: inv3.id, amount: 900_000 }] })).rejects.toThrow(/melebihi sisa/);
  });

  it("US-M5-02 KP-1 pemisahan tugas: Dispatcher (tanpa akses kas) dan pemilik (tidak menginput harian) ditolak mencatat pelunasan", async () => {
    const c = await creditCustomer(t.db);
    await invoiceFor(t.db, c.id, { amount: 100_000, issueDate: today() });
    await expect(m5.recordOfficePayment(dispatcher(), { customerId: c.id, businessDate: today(), amount: 100_000, method: "cash" })).rejects.toThrow();
    await expect(m5.recordOfficePayment(owner(), { customerId: c.id, businessDate: today(), amount: 100_000, method: "cash" })).rejects.toThrow();
  });

  it("US-M5-02 KP-2 pelunasan lewat sopir (M3) masuk otomatis dengan alokasinya dan setoran hari itu — Admin Keuangan hanya melihat", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const trip = await w.addTrip();
    const a = await invoiceFor(t.db, w.customer.id, { amount: 120_000, issueDate: addDays(w.date, -20) });
    const b = await invoiceFor(t.db, w.customer.id, { amount: 80_000, issueDate: addDays(w.date, -3) });
    const paymentId = newId();
    expectApplied(await w.send(w.sopir, "m3.collection.create", { paymentId, customerId: w.customer.id, tripId: trip.id, method: "cash", amount: 150_000, invoiceIds: [a.id, b.id] }));
    expect(await invoiceRow(t.db, a.id)).toMatchObject({ status: "paid", paidAmount: 120_000, outstandingAmount: 0 });
    expect(await invoiceRow(t.db, b.id)).toMatchObject({ status: "partial", paidAmount: 30_000, outstandingAmount: 50_000 });
    const list = await m5.listPayments(finance(), { customerId: w.customer.id });
    expect(list.find((p) => p.id === paymentId)).toMatchObject({ channel: "driver", method: "cash", amount: 150_000 });
    const [p] = await t.db.select().from(customerPayments).where(eq(customerPayments.id, paymentId));
    expect(p!.depositId).toBeTruthy();
    // Kirim ulang (idempoten) tidak menggandakan.
    expectApplied(await w.send(w.sopir, "m3.collection.create", { paymentId, customerId: w.customer.id, tripId: trip.id, method: "cash", amount: 150_000, invoiceIds: [a.id, b.id] }));
    expect(await invoiceRow(t.db, b.id)).toMatchObject({ paidAmount: 30_000 });
  });

  it("US-M5-02 KP-3 kelebihan bayar → uang muka yang dialokasikan otomatis ke faktur berikutnya", async () => {
    const c = await creditCustomer(t.db);
    const d = today();
    const inv = await invoiceFor(t.db, c.id, { amount: 100_000, issueDate: d });
    const res = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 160_000, method: "cash" });
    expect(res.advanceAmount).toBe(60_000);
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ status: "paid" });
    const [adv] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.sourcePaymentId, res.payment.id));
    expect(adv).toMatchObject({ amount: 60_000, remainingAmount: 60_000, status: "open" });
    const next = await invoiceFor(t.db, c.id, { amount: 100_000, issueDate: d });
    expect(await invoiceRow(t.db, next.id)).toMatchObject({ paidAmount: 60_000, outstandingAmount: 40_000, status: "partial" });
    const [after] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.id, adv!.id));
    expect(after).toMatchObject({ remainingAmount: 0, status: "applied" });
  });

  it("US-M5-02 KP-3 pengembalian uang muka hanya dengan persetujuan pemilik (customer_refund) → customer_advance.refunded", async () => {
    const c = await creditCustomer(t.db);
    const d = today();
    await invoiceFor(t.db, c.id, { amount: 50_000, issueDate: d });
    const res = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 130_000, method: "cash" });
    const [adv] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.sourcePaymentId, res.payment.id));
    await expect(m5.requestAdvanceRefund(finance(), { advanceId: adv!.id, amount: 100_000, method: "cash", reason: "Kelebihan transfer" })).rejects.toThrow(/melebihi sisa/);
    const req = await m5.requestAdvanceRefund(finance(), { advanceId: adv!.id, amount: 80_000, method: "cash", reason: "Pelanggan minta dikembalikan" });
    expect(req).toMatchObject({ type: "customer_refund", approverRole: "owner", status: "submitted" });
    // Selama diajukan, uang muka tidak dialokasikan otomatis ke faktur baru.
    const other = await invoiceFor(t.db, c.id, { amount: 30_000, issueDate: d });
    expect(await invoiceRow(t.db, other.id)).toMatchObject({ paidAmount: 0 });
    await expect(approvals.decide(finance(), req.id, "approve")).rejects.toThrow();
    await approvals.decide(owner(), req.id, "approve");
    const [after] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.id, adv!.id));
    expect(after).toMatchObject({ remainingAmount: 0, status: "refunded", refundApprovalId: req.id });
    const [ev] = await eventsOf(t.db, "customer_advance.refunded", adv!.id);
    expect(ev!.payload).toMatchObject({ amount: 80_000, method: "cash", approvalId: req.id });
  });

  it("US-M5-02 KP-4 faktur Lunas terkunci; pembatalan pelunasan hanya lewat pembalik beralasan, > PAR-21 dengan persetujuan pemilik (payment.reversed)", async () => {
    const c = await creditCustomer(t.db);
    const d = today();
    const inv = await invoiceFor(t.db, c.id, { amount: 300_000, issueDate: d });
    const small = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 300_000, method: "cash" });
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ status: "paid" });
    // Terkunci: tidak dapat dialokasikan lagi.
    await expect(m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 10_000, method: "cash", allocations: [{ invoiceId: inv.id, amount: 10_000 }] })).rejects.toThrow(/Lunas dan terkunci/);
    // Alasan wajib.
    await expect(m5.reverseCustomerPayment(finance(), { paymentId: small.payment.id, reason: "" })).rejects.toThrow(/Alasan/);
    const rev = await m5.reverseCustomerPayment(finance(), { paymentId: small.payment.id, reason: "Salah pelanggan" });
    expect(rev.status).toBe("reversed");
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ status: "open", outstandingAmount: 300_000, paidAt: null });
    const [ev] = await eventsOf(t.db, "payment.reversed", small.payment.id);
    expect(ev!.payload).toMatchObject({ amount: 300_000, reason: "Salah pelanggan", channel: "office", method: "cash" });
    await expect(m5.reverseCustomerPayment(finance(), { paymentId: small.payment.id, reason: "Dua kali" })).rejects.toThrow(/sudah dibalik/);
    // > PAR-21 → persetujuan pemilik.
    const big = await invoiceFor(t.db, c.id, { amount: 800_000, issueDate: d });
    const bigPay = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 800_000, method: "cash", allocations: [{ invoiceId: big.id, amount: 800_000 }] });
    const pending = await m5.reverseCustomerPayment(finance(), { paymentId: bigPay.payment.id, reason: "Transfer ganda" });
    expect(pending.status).toBe("pending_approval");
    expect(await invoiceRow(t.db, big.id)).toMatchObject({ status: "paid" });
    if (pending.status !== "pending_approval") throw new Error("unexpected");
    const [req] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, pending.approvalId));
    expect(req).toMatchObject({ type: "correction", objectType: "customer_payment", approverRole: "owner" });
    await approvals.decide(owner(), pending.approvalId, "approve");
    expect(await invoiceRow(t.db, big.id)).toMatchObject({ status: "open", outstandingAmount: 800_000 });
    // Ditolak → pelunasan tetap.
    const inv2 = await invoiceFor(t.db, c.id, { amount: 600_000, issueDate: d });
    const pay2 = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 600_000, method: "cash", allocations: [{ invoiceId: inv2.id, amount: 600_000 }] });
    const p2 = await m5.reverseCustomerPayment(finance(), { paymentId: pay2.payment.id, reason: "Coba batalkan" });
    if (p2.status !== "pending_approval") throw new Error("unexpected");
    await approvals.decide(owner(), p2.approvalId, "reject", "Pelunasan benar");
    expect(await invoiceRow(t.db, inv2.id)).toMatchObject({ status: "paid" });
  });

  it("US-M5-02 KP-5 bukti pelunasan digital: PDF & tautan WA (tercatat dibuka)", async () => {
    const c = await creditCustomer(t.db);
    const inv = await invoiceFor(t.db, c.id, { amount: 90_000, issueDate: today() });
    const res = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: today(), amount: 90_000, method: "cash" });
    const pdf = await m5.renderPaymentReceiptPdf(finance(), res.payment.id);
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    const wa = await m5.sendPaymentReceipt(finance(), { paymentId: res.payment.id });
    expect(decodeURIComponent(wa.link)).toContain(inv.number);
    const [log] = await t.db.select().from(waMessageLogs).where(and(eq(waMessageLogs.objectType, "customer_payment"), eq(waMessageLogs.objectId, res.payment.id)));
    expect(log).toMatchObject({ kind: "payment_receipt", status: "link_opened" });
  });
});

describe("7.5.6 Pengecualian pelunasan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-02 KP-1 7.5.6 transfer untuk beberapa faktur tanpa keterangan: tertua dulu, lalu diubah setelah konfirmasi pelanggan (realokasi beralasan)", async () => {
    const c = await creditCustomer(t.db);
    const d = today();
    const a = await invoiceFor(t.db, c.id, { amount: 200_000, issueDate: addDays(d, -20) });
    const b = await invoiceFor(t.db, c.id, { amount: 200_000, issueDate: addDays(d, -2) });
    const proof = await attachment(finance(), "transfer_proof");
    const pay = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 200_000, method: "transfer", proofAttachmentId: proof.id });
    expect(pay.allocations).toEqual([{ invoiceId: a.id, amount: 200_000 }]);
    // Pelanggan mengonfirmasi transfer untuk faktur b.
    await expect(m5.reallocateCustomerPayment(finance(), { paymentId: pay.payment.id, allocations: [{ invoiceId: b.id, amount: 150_000 }], reason: "Konfirmasi pelanggan" })).rejects.toThrow(/harus sama/);
    const res = await m5.reallocateCustomerPayment(finance(), { paymentId: pay.payment.id, allocations: [{ invoiceId: b.id, amount: 200_000 }], reason: "Konfirmasi pelanggan: untuk faktur terbaru" });
    expect(res.status).toBe("reallocated");
    expect(await invoiceRow(t.db, a.id)).toMatchObject({ status: "open", outstandingAmount: 200_000 });
    expect(await invoiceRow(t.db, b.id)).toMatchObject({ status: "paid", outstandingAmount: 0 });
    const allocs = await t.db.select().from(paymentAllocations).where(eq(paymentAllocations.customerPaymentId, pay.payment.id));
    expect(allocs.some((x) => x.amount < 0 && x.reversalOfId)).toBe(true);
  });

  it("US-M5-02 KP-4 7.5.6 pelanggan membayar ke sopir tetapi dicatat tunai rit: Admin Keuangan membalik & mengalokasikan ulang beralasan; kas tidak berubah", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const old = await invoiceFor(t.db, w.customer.id, { amount: PRICE, issueDate: addDays(w.date, -20) });
    const trip = await w.addTrip({ paymentMethod: "credit" });
    await departArrive(w, trip.id);
    expectApplied(await completeCash(w, trip.id)); // sopir mencatat tunai rit penuh
    const cashBefore = (await w.today()).cash;
    const res = await m5.reclassifyTripCash(finance(), { tripId: trip.id, reason: "Pelanggan membayar faktur lama lewat sopir" });
    expect(res.status).toBe("reclassified");
    if (res.status !== "reclassified") throw new Error("unexpected");
    expect(await invoiceRow(t.db, old.id)).toMatchObject({ status: "paid" });
    expect(await invoiceRow(t.db, res.invoiceId)).toMatchObject({ kind: "delivery", tripId: trip.id, amount: PRICE, outstandingAmount: PRICE });
    const [p] = await t.db.select().from(customerPayments).where(eq(customerPayments.id, res.paymentId));
    expect(p).toMatchObject({ method: "internal", channel: "office", amount: PRICE });
    const cashAfter = (await w.today()).cash;
    expect(cashAfter).toEqual(cashBefore);
    const [ev] = await eventsOf(t.db, "collection.recorded", res.paymentId);
    expect(ev!.payload).toMatchObject({ method: "internal", reclassifiedFromTripPaymentId: expect.any(String) });
    await expect(m5.reclassifyTripCash(finance(), { tripId: trip.id, reason: "Ulang lagi" })).rejects.toThrow(/sudah/);
  });

  it("US-M5-02 KP-3 kelebihan bayar lewat sopir karena sisa berubah (luring) menjadi uang muka untuk ditinjau Admin Keuangan", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const trip = await w.addTrip();
    const inv = await invoiceFor(t.db, w.customer.id, { amount: 60_000, issueDate: addDays(w.date, -4) });
    await m5.recordOfficePayment(finance(), { customerId: w.customer.id, businessDate: w.date, amount: 40_000, method: "cash" });
    const paymentId = newId();
    const res = await w.send(w.sopir, "m3.collection.create", { paymentId, customerId: w.customer.id, tripId: trip.id, method: "cash", amount: 60_000, invoiceIds: [inv.id] });
    expect(res.status).toBe("conflict");
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ status: "paid", outstandingAmount: 0 });
    const [adv] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.sourcePaymentId, paymentId));
    expect(adv).toMatchObject({ amount: 40_000, status: "open" });
    const invs = await t.db.select().from(invoices).where(eq(invoices.customerId, w.customer.id));
    expect(invs.every((i) => i.outstandingAmount >= 0)).toBe(true);
  });
});
