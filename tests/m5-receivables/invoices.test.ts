import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, creditNotes, customers, domainEvents, invoiceLines, invoices, posSales, unbilledCharges, waMessageLogs } from "@/db/schema";
import { customerId, userIdByUsername } from "@/db/seed";
import { isHardeningViolation } from "@/db/hardening";
import { addDays } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import * as m2 from "@/server/modules/m2-orders";
import * as m5 from "@/server/modules/m5-receivables";
import type { CustomerCreditPull } from "@/server/modules/m5-receivables";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { completeCash, departArrive, driverWorld, expectApplied, PRICE } from "../m3-driver/helpers";
import { closeVia, makeStore, openShiftVia, PARTNER, sellVia, SP, stockUp } from "../m7-store/helpers";
import { creditCustomer, customerRow, dispatcher, finance, invoiceFor, invoiceRow, notificationsFor, owner, today } from "./helpers";

describe("US-M5-01 Piutang terbentuk otomatis dari pengiriman dan penjualan tempo", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-01 KP-1 rit tempo Selesai → faktur kirim per rit (nomor F-YY-NNNNNN, tanggal kirim, pelanggan, alamat, nomor rit, volume, harga, jatuh tempo = tanggal kirim + tempo pelanggan)", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    await t.db.update(customers).set({ paymentTermDays: 21 }).where(eq(customers.id, w.customer.id));
    const trip = await w.addTrip({ paymentMethod: "credit" });
    await departArrive(w, trip.id);
    expectApplied(await completeCash(w, trip.id, w.sopir, { payment: { method: "credit" }, deliveredVolumeL: 5000 }));
    const [inv] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, trip.id), eq(invoices.kind, "delivery")));
    expect(inv).toBeTruthy();
    expect(inv!.number).toMatch(new RegExp(`^F-${w.date.slice(2, 4)}-\\d{6}$`));
    expect(inv).toMatchObject({ customerId: w.customer.id, addressId: w.customer.addressId, issueDate: w.date, dueDate: addDays(w.date, 21), amount: PRICE, outstandingAmount: PRICE, status: "open" });
    const lines = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv!.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ component: "trip", tripId: trip.id, volumeL: 5000, unitPrice: PRICE, amount: PRICE, serviceDate: w.date });
    expect(lines[0]!.description).toContain(trip.number);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "invoice.issued"), eq(domainEvents.objectId, inv!.id)));
    expect(ev!.payload).toMatchObject({ kind: "delivery", amount: PRICE, tripId: trip.id, number: inv!.number, profitCenter: "L2" });
    // Idempoten: event yang diputar ulang tidak menggandakan faktur.
    const [pay] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "trip.payment_recorded"), sql`${domainEvents.payload}->>'tripId' = ${trip.id}`));
    expect(pay).toBeTruthy();
    expect(await t.db.select().from(invoices).where(eq(invoices.tripId, trip.id))).toHaveLength(1);
  });

  it("US-M5-01 KP-1 kurang bayar lapangan (PTB-18) → faktur kurang bayar jatuh tempo H+0 + notifikasi Admin Keuangan & Dispatcher", async () => {
    const w = await driverWorld(t.db);
    const trip = await w.addTrip();
    await departArrive(w, trip.id);
    expectApplied(await completeCash(w, trip.id, w.sopir, { payment: { method: "cash", cashReceived: 200_000, underpaymentReasonCode: "customer_short" } }));
    const [inv] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, trip.id), eq(invoices.kind, "underpayment")));
    expect(inv).toMatchObject({ amount: PRICE - 200_000, issueDate: w.date, dueDate: w.date, status: "open" });
    const notes = await notificationsFor(t.db, "trip.underpayment", trip.id);
    const recipients = new Set(notes.map((n) => n.recipientUserId));
    expect(recipients.has(userIdByUsername("keuangan1")) && recipients.has(userIdByUsername("dispatcher1"))).toBe(true);
    // Tagih kurang bayar di pesanan berikutnya (M2 membaca faktur M5).
    expect(await m2.underpaymentStatus(t.db, w.customer.id)).toMatchObject({ openCount: 1, collect: true });
  });

  it("US-M5-01 KP-1 penjualan tempo toko → faktur per transaksi (pos_sales.invoice_id terisi, jatuh tempo = tempo pelanggan) saat shift ditutup", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.SIKAT, quantity: 5, unitCost: 10_000 }]);
    const shiftId = await openShiftVia(pos);
    const partner = customerId("PLG-0001");
    const s = await sellVia(pos, shiftId, [{ productId: SP.SIKAT, quantity: 2, unitPrice: PARTNER.SIKAT }], { customerId: partner, method: "credit" });
    expectApplied(s.res);
    // Selama shift berjalan (void masih boleh) → belum difakturkan; eksposur menghitungnya sebagai tempo toko.
    const before = await m5.computeExposure(t.db, partner);
    expect(before.uninvoicedStoreCredit).toBeGreaterThanOrEqual(2 * PARTNER.SIKAT);
    expectApplied(await closeVia(pos, shiftId, 200_000));
    const [sale] = await t.db.select().from(posSales).where(eq(posSales.id, s.saleId));
    expect(sale!.invoiceId).toBeTruthy();
    const inv = await invoiceRow(t.db, sale!.invoiceId!);
    const cust = await customerRow(t.db, partner);
    expect(inv).toMatchObject({ kind: "store_sale", posSaleId: s.saleId, customerId: partner, amount: 2 * PARTNER.SIKAT, dueDate: addDays(sale!.businessDate, cust.paymentTermDays) });
    const after = await m5.computeExposure(t.db, partner);
    expect(after.exposure).toBe(before.exposure);
  });

  it("US-M5-01 KP-2 pelanggan tagihan bulanan: rit tempo masuk daftar belum ditagih, bukan faktur per rit", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    await t.db.update(customers).set({ monthlyBilling: true }).where(eq(customers.id, w.customer.id));
    const trip = await w.addTrip({ paymentMethod: "credit" });
    await departArrive(w, trip.id);
    expectApplied(await completeCash(w, trip.id, w.sopir, { payment: { method: "credit" } }));
    expect(await t.db.select().from(invoices).where(eq(invoices.tripId, trip.id))).toHaveLength(0);
    const [ch] = await t.db.select().from(unbilledCharges).where(eq(unbilledCharges.tripId, trip.id));
    expect(ch).toMatchObject({ customerId: w.customer.id, amount: PRICE, status: "unbilled", serviceDate: w.date, lateSync: false });
  });

  it("US-M5-01 KP-3 saldo = Σ sisa faktur + belum ditagih; eksposur = saldo + pesanan tempo berjalan — sama di M2 (pesanan) dan aplikasi sopir (pull)", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 5_000_000 });
    const d = w.date;
    await invoiceFor(t.db, w.customer.id, { amount: 300_000, issueDate: addDays(d, -10) });
    await t.db.insert(unbilledCharges).values({ tenantId: w.customer.tenantId, customerId: w.customer.id, serviceDate: d, description: "Rit uji", amount: 150_000 });
    await w.addTrip({ paymentMethod: "credit" }); // rit tempo Ditugaskan → pesanan tempo berjalan
    const bal = await m5.getReceivableBalance(t.db, w.customer.id);
    expect(bal).toMatchObject({ openInvoices: 300_000, unbilledCharges: 150_000, balance: 450_000 });
    const exp = await m5.getCreditExposure(finance(), w.customer.id);
    expect(exp).toMatchObject({ balance: 450_000, openCreditOrders: PRICE, exposure: 450_000 + PRICE, creditLimit: 5_000_000, remaining: 5_000_000 - 450_000 - PRICE });
    const viaM2 = await m2.computeCreditExposure(t.db, w.customer.id);
    expect(viaM2.exposure).toBe(exp.exposure);
    // Dispatcher boleh melihat eksposur (saat membuat pesanan); akuntan tidak.
    expect((await m5.getCreditExposure(dispatcher(), w.customer.id)).exposure).toBe(exp.exposure);
    const pull = (await w.hp.pull(w.sopir, { keys: "m5.customer_credit" })).data["m5.customer_credit"] as CustomerCreditPull;
    expect(pull.customers.find((c) => c.customerId === w.customer.id)).toMatchObject({ balance: 450_000, exposure: exp.exposure, creditStatus: "credit" });
  });

  it("US-M5-01 KP-4 satu batas kredit lintas lini (air truk + toko): piutang toko ikut menolak pesanan tempo air truk", async () => {
    const c = await creditCustomer(t.db, { creditLimit: 1_000_000, segment: "third_party_depot" });
    const d = today();
    await invoiceFor(t.db, c.id, { amount: 600_000, issueDate: d, kind: "store_sale" });
    await invoiceFor(t.db, c.id, { amount: 300_000, issueDate: d, kind: "delivery" });
    const exp = await m5.computeExposure(t.db, c.id, { extraAmount: 200_000 });
    expect(exp).toMatchObject({ openInvoices: 900_000, exposure: 1_100_000, exceedsLimit: true });
    const check = await m2.evaluateCreditOrder(t.db, c.id, 200_000);
    expect(check).toMatchObject({ ok: false, reason: "over_limit" });
  });

  it("US-M5-01 KP-5 faktur PDF beridentitas usaha tanpa PPN & tanpa faktur pajak; kirim via tautan WA / e-mail tercatat (hanya Admin Keuangan)", async () => {
    const c = await creditCustomer(t.db);
    const inv = await invoiceFor(t.db, c.id, { amount: 750_000, issueDate: today() });
    const doc = await m5.invoiceDocument(finance(), inv.id);
    expect(doc.identity.name).toBeTruthy();
    expect(doc.notes.join(" ")).toMatch(/tanpa PPN/i);
    expect(doc.notes.join(" ")).toMatch(/bukan faktur pajak/i);
    const pdf = await m5.renderInvoicePdf(finance(), inv.id);
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.filename).toBe(`faktur-${inv.number}.pdf`);
    const wa = await m5.sendInvoice(finance(), { invoiceId: inv.id, via: "wa" });
    expect(wa.link).toMatch(/^https:\/\/wa\.me\/62/);
    expect(decodeURIComponent(wa.link!)).toContain(inv.number);
    const logs = await t.db.select().from(waMessageLogs).where(and(eq(waMessageLogs.objectType, "invoice"), eq(waMessageLogs.objectId, inv.id)));
    expect(logs[0]).toMatchObject({ kind: "invoice", status: "link_opened" });
    await m5.sendInvoice(finance(), { invoiceId: inv.id, via: "email" });
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ sentVia: "email" });
    await expect(m5.sendInvoice(dispatcher(), { invoiceId: inv.id, via: "wa" })).rejects.toThrow();
  });

  it("US-M5-01 KP-6 faktur tidak dapat dihapus; koreksi lewat nota kredit beralasan (> PAR-21 persetujuan pemilik); faktur Lunas terkunci", async () => {
    const c = await creditCustomer(t.db);
    const inv = await invoiceFor(t.db, c.id, { amount: 2_000_000, issueDate: today() });
    let blocked: unknown = null;
    try {
      await t.db.execute(sql`delete from invoices where id = ${inv.id}`);
    } catch (e) {
      blocked = e;
    }
    expect(isHardeningViolation(blocked)).toBe(true);
    // ≤ PAR-21 langsung terbit (NK-YY-NNNNNN).
    const small = await m5.requestCreditNote(finance(), { invoiceId: inv.id, amount: 100_000, reason: "Harga salah ketik" });
    expect(small.status).toBe("issued");
    const [cn] = await t.db.select().from(creditNotes).where(eq(creditNotes.invoiceId, inv.id));
    expect(cn!.number).toMatch(/^NK-\d{2}-\d{6}$/);
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ creditedAmount: 100_000, outstandingAmount: 1_900_000, status: "partial" });
    // Alasan wajib.
    await expect(m5.requestCreditNote(finance(), { invoiceId: inv.id, amount: 1_000, reason: "" })).rejects.toThrow(/Alasan/);
    // > PAR-21 → persetujuan pemilik; setelah disetujui nota kredit terbit.
    const big = await m5.requestCreditNote(finance(), { invoiceId: inv.id, amount: 900_000, reason: "Volume dikoreksi" });
    expect(big.status).toBe("pending_approval");
    if (big.status !== "pending_approval") throw new Error("unexpected");
    const [req] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, big.approvalId));
    expect(req).toMatchObject({ type: "correction", objectType: "invoice", approverRole: "owner" });
    await approvals.decide(owner(), big.approvalId, "approve");
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ creditedAmount: 1_000_000, outstandingAmount: 1_000_000 });
    // Pemilik tidak menginput nota kredit (SoD) — hanya menyetujui.
    await expect(m5.requestCreditNote(owner(), { invoiceId: inv.id, amount: 1_000, reason: "Uji pemilik" })).rejects.toThrow();
    // Lunas terkunci: nota kredit ditolak.
    await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: today(), amount: 1_000_000, method: "cash" });
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ status: "paid", outstandingAmount: 0 });
    await expect(m5.requestCreditNote(finance(), { invoiceId: inv.id, amount: 1_000, reason: "Terlambat" })).rejects.toThrow(/Lunas dan terkunci/);
  });

  it("US-M5-01 KP-1 konversi kurang bayar → tempo setelah persetujuan Dispatcher (PTB-19, B-16): kurang bayar ditutup nota kredit, faktur kirim tempo terbit", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const trip = await w.addTrip();
    await departArrive(w, trip.id);
    const req = await w.send(w.sopir, "m3.field_credit.request", { tripId: trip.id, reason: "Minta tempo" });
    await approvals.decide(dispatcher(), req.objectId!, "approve", "Dalam batas");
    // Perangkat tetap mencatat kurang bayar (mis. luring) walau tempo disetujui.
    expectApplied(await completeCash(w, trip.id, w.sopir, { payment: { method: "cash", cashReceived: 0, underpaymentReasonCode: "credit_not_approved" } }));
    const [under] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, trip.id), eq(invoices.kind, "underpayment")));
    expect(under).toMatchObject({ amount: PRICE, dueDate: w.date });
    const res = await m5.convertUnderpaymentToCredit(finance(), { invoiceId: under!.id, reason: "Tempo disetujui Dispatcher" });
    expect(await invoiceRow(t.db, under!.id)).toMatchObject({ outstandingAmount: 0, creditedAmount: PRICE, status: "paid" });
    expect(res.invoice).toMatchObject({ kind: "delivery", tripId: trip.id, amount: PRICE, dueDate: addDays(w.date, 14) });
    // Tanpa persetujuan tempo lapangan → ditolak.
    const w2 = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const trip2 = await w2.addTrip();
    await departArrive(w2, trip2.id);
    expectApplied(await completeCash(w2, trip2.id, w2.sopir, { payment: { method: "cash", cashReceived: 0, underpaymentReasonCode: "customer_short" } }));
    const [under2] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, trip2.id), eq(invoices.kind, "underpayment")));
    await expect(m5.convertUnderpaymentToCredit(finance(), { invoiceId: under2!.id, reason: "Coba konversi" })).rejects.toThrow(/disetujui Dispatcher/);
  });

  it("US-M5-01 KP-1 rit tunai lunas tidak membentuk piutang", async () => {
    const w = await driverWorld(t.db);
    const trip = await w.addTrip();
    await departArrive(w, trip.id);
    expectApplied(await completeCash(w, trip.id));
    expect(await t.db.select().from(invoices).where(eq(invoices.tripId, trip.id))).toHaveLength(0);
    expect(await m5.getReceivableBalance(t.db, w.customer.id)).toMatchObject({ balance: 0 });
  });
});
