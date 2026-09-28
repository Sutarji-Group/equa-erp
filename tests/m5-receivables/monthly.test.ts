import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customers, invoiceLines, invoices, unbilledCharges, waMessageLogs } from "@/db/schema";
import { isHardeningViolation } from "@/db/hardening";
import { EQUA_TENANT_ID } from "@/db/seed";
import { addDays, firstDayOfMonth, lastDayOfMonth } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { runJobNow } from "@/server/core/jobs";
import * as m2 from "@/server/modules/m2-orders";
import * as m5 from "@/server/modules/m5-receivables";
import { createAdvance } from "@/server/modules/m5-receivables/service/ledger";
import { issueMonthlyInvoices } from "@/server/modules/m5-receivables/service/monthly";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { completeCash, departArrive, driverWorld, expectApplied, PRICE, type World } from "../m3-driver/helpers";
import { accountant, attachment, creditCustomer, customerRow, dispatcher, finance, invoiceRow, noonOf, notificationsFor, owner, system } from "./helpers";

/** Tanggal 1 bulan berikutnya dari `d`. */
const nextMonthFirst = (d: string) => addDays(lastDayOfMonth(d), 1);

/** Pelanggan tagihan bulanan (BR-05) di "dunia" satu truk uji. */
async function monthlyWorld(db: Parameters<typeof driverWorld>[0], creditLimit = 50_000_000): Promise<World> {
  const w = await driverWorld(db, { customerCredit: "credit", creditLimit });
  await db.update(customers).set({ monthlyBilling: true }).where(eq(customers.id, w.customer.id));
  return w;
}

/** Rit tempo Selesai (tersinkron lewat aplikasi sopir). */
async function creditTrip(w: World) {
  const trip = await w.addTrip({ paymentMethod: "credit" });
  await departArrive(w, trip.id);
  expectApplied(await completeCash(w, trip.id, w.sopir, { payment: { method: "credit" } }));
  return trip;
}

describe("US-M5-06 Faktur bulanan untuk pelanggan tagihan bulanan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-06 KP-1 penanda tagihan bulanan hanya dengan perjanjian tertulis terlampir dan disetujui pemilik (BR-05)", async () => {
    const c = await creditCustomer(t.db, { name: "Hotel Calon Bulanan" });
    // Tanpa perjanjian → ditolak.
    await expect(m5.requestMonthlyBilling(finance(), { customerId: c.id, reason: "Hotel berperjanjian" })).rejects.toThrow(/Perjanjian/);
    // Rumah tangga (BR-04) dan pelanggan Tunai tidak dapat bertagihan bulanan.
    const household = await creditCustomer(t.db, { segment: "household", creditStatus: "cash", creditLimit: 0, name: "Rumah Tangga Bulanan" });
    await expect(m5.requestMonthlyBilling(finance(), { customerId: household.id, agreementAttachmentId: (await attachment(finance(), "agreement", true)).id, reason: "Coba rumah tangga" })).rejects.toThrow(/Rumah tangga/);
    const cash = await creditCustomer(t.db, { creditStatus: "cash", creditLimit: 0, segment: "industry", name: "Pabrik Tunai Bulanan" });
    await expect(m5.requestMonthlyBilling(finance(), { customerId: cash.id, agreementAttachmentId: (await attachment(finance(), "agreement", true)).id, reason: "Coba pelanggan tunai" })).rejects.toThrow(/Tempo/);
    // Akuntan (baca-saja) tidak dapat mengajukan.
    await expect(m5.requestMonthlyBilling(accountant(), { customerId: c.id, agreementAttachmentId: (await attachment(finance(), "agreement", true)).id, reason: "Coba akuntan" })).rejects.toThrow();
    // Dispatcher mengajukan dengan perjanjian → persetujuan pemilik; belum berlaku sebelum disetujui.
    const agreement = await attachment(dispatcher(), "agreement", true);
    const req = await m5.requestMonthlyBilling(dispatcher(), { customerId: c.id, agreementAttachmentId: agreement.id, reason: "Perjanjian tagihan bulanan hotel" });
    expect(req).toMatchObject({ type: "monthly_billing", approverRole: "owner", status: "submitted", objectType: "customer", objectId: c.id });
    expect((await customerRow(t.db, c.id)).monthlyBilling).toBe(false);
    await expect(approvals.decide(dispatcher(), req.id, "approve")).rejects.toThrow();
    await approvals.decide(owner(), req.id, "approve", "Perjanjian sah");
    expect(await customerRow(t.db, c.id)).toMatchObject({ monthlyBilling: true, monthlyBillingAgreementAttachmentId: agreement.id, monthlyBillingApprovalId: req.id });
    // Ditolak pemilik → tetap ditagih per rit.
    const c2 = await creditCustomer(t.db, { name: "Pabrik Ditolak Bulanan", segment: "industry" });
    const req2 = await m5.requestMonthlyBilling(finance(), { customerId: c2.id, agreementAttachmentId: (await attachment(finance(), "agreement", true)).id, reason: "Pabrik minta bulanan" });
    await approvals.decide(owner(), req2.id, "reject", "Perjanjian belum ditandatangani direksi");
    expect((await customerRow(t.db, c2.id)).monthlyBilling).toBe(false);
  });

  it("US-M5-06 KP-2 faktur bulanan terbit otomatis tanggal 1 (PAR-12) untuk layanan bulan lalu, jatuh tempo tanggal 15; rincian rit, pelunasan & uang muka, saldo terutang", async () => {
    const w = await monthlyWorld(t.db);
    const t1 = await creditTrip(w);
    const t2 = await creditTrip(w);
    expect(await t.db.select().from(invoices).where(eq(invoices.customerId, w.customer.id))).toHaveLength(0);
    // Uang muka pelanggan (kelebihan bayar sebelumnya) dialokasikan otomatis ke faktur bulanan.
    await withTx((tx) => createAdvance(tx, system(w.date), { tenantId: EQUA_TENANT_ID, customerId: w.customer.id, amount: 100_000, notes: "Kelebihan transfer bulan lalu (uji)", notify: false }));
    const issueDay = nextMonthFirst(w.date);
    // Bukan tanggal terbit → job dilewati.
    const skipped = await runJobNow("m5.monthly_invoices", noonOf(addDays(issueDay, 1)));
    expect(skipped).toMatchObject({ status: "succeeded", result: { skipped: expect.any(String) } });
    const res = await runJobNow("m5.monthly_invoices", noonOf(issueDay));
    expect(res.status).toBe("succeeded");
    const monthly = await t.db.select().from(invoices).where(and(eq(invoices.customerId, w.customer.id), eq(invoices.kind, "monthly")));
    expect(monthly).toHaveLength(1);
    const inv = monthly[0]!;
    expect(inv).toMatchObject({
      periodMonth: firstDayOfMonth(w.date),
      issueDate: issueDay,
      dueDate: `${issueDay.slice(0, 7)}-15`,
      amount: 2 * PRICE,
      paidAmount: 100_000,
      outstandingAmount: 2 * PRICE - 100_000,
      status: "partial",
    });
    expect(inv.number).toMatch(/^F-\d{2}-\d{6}$/);
    const lines = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(invoiceLines.lineNo);
    expect(lines.map((l) => l.tripId).sort()).toEqual([t1.id, t2.id].sort());
    for (const l of lines) {
      expect(l).toMatchObject({ component: "trip", serviceDate: w.date, unitPrice: PRICE, amount: PRICE });
      expect(l.volumeL).toBeGreaterThan(0);
      expect(l.description).toMatch(/rit P-/);
    }
    const charges = await t.db.select().from(unbilledCharges).where(eq(unbilledCharges.customerId, w.customer.id));
    expect(charges.every((c) => c.status === "billed" && c.invoiceId === inv.id)).toBe(true);
    // Idempoten: menjalankan ulang tidak menggandakan.
    await runJobNow("m5.monthly_invoices", noonOf(issueDay), { runKey: "ulang-uji" });
    expect(await t.db.select().from(invoices).where(and(eq(invoices.customerId, w.customer.id), eq(invoices.kind, "monthly")))).toHaveLength(1);
    // Dokumen/PDF memuat rincian rit, pelunasan & uang muka yang diterima, dan saldo terutang.
    const doc = await m5.invoiceDocument(finance(), inv.id);
    expect(doc.lines).toHaveLength(2);
    expect(doc.paymentsReceived).toBe(100_000);
    expect(doc.invoice.outstandingAmount + doc.otherOutstanding).toBeGreaterThanOrEqual(2 * PRICE - 100_000);
    const pdf = await m5.renderInvoicePdf(finance(), inv.id);
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    // Admin Keuangan diberi tahu: siap kirim.
    expect(await notificationsFor(t.db, "receivable.monthly_ready", inv.id)).not.toHaveLength(0);
    // Penerbitan manual: hanya Admin Keuangan.
    await expect(m5.runMonthlyInvoicingNow(dispatcher())).rejects.toThrow();
  });

  it("US-M5-06 KP-3 rit yang tersinkron setelah faktur terbit masuk faktur bulan berikutnya bertanda; faktur terbit tidak berubah (koreksi lewat nota kredit)", async () => {
    const w = await monthlyWorld(t.db);
    await creditTrip(w);
    const issueDay = nextMonthFirst(w.date);
    const first = await withTx((tx) => issueMonthlyInvoices(tx, system(issueDay), EQUA_TENANT_ID, issueDay));
    const inv1 = first.issued.find((i) => i.customerId === w.customer.id)!;
    expect(inv1).toMatchObject({ amount: PRICE, lateLines: 0 });
    // Rit bulan layanan yang sama baru tersinkron setelah faktur bulanannya terbit.
    const late = await creditTrip(w);
    const [charge] = await t.db.select().from(unbilledCharges).where(eq(unbilledCharges.tripId, late.id));
    expect(charge).toMatchObject({ status: "unbilled", lateSync: true, serviceDate: w.date });
    // Faktur yang sudah terbit tidak berubah — basis data menolak perubahan nilai.
    expect(await invoiceRow(t.db, inv1.invoiceId)).toMatchObject({ amount: PRICE });
    let blocked: unknown = null;
    try {
      await t.db.update(invoices).set({ amount: 2 * PRICE, outstandingAmount: 2 * PRICE }).where(eq(invoices.id, inv1.invoiceId));
    } catch (e) {
      blocked = e;
    }
    expect(isHardeningViolation(blocked)).toBe(true);
    // Faktur bulan berikutnya memuat rit susulan dengan penanda.
    const next = nextMonthFirst(issueDay);
    const second = await withTx((tx) => issueMonthlyInvoices(tx, system(next), EQUA_TENANT_ID, next));
    const inv2 = second.issued.find((i) => i.customerId === w.customer.id)!;
    expect(inv2).toMatchObject({ amount: PRICE, lateLines: 1 });
    const [line] = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv2.invoiceId));
    expect(line).toMatchObject({ tripId: late.id });
    expect(line!.description).toMatch(/susulan/);
    // Koreksi faktur terbit hanya lewat nota kredit.
    const cn = await m5.requestCreditNote(finance(), { invoiceId: inv1.invoiceId, amount: 10_000, reason: "Koreksi harga rit bulan lalu" });
    expect(cn.status).toBe("issued");
    expect(await invoiceRow(t.db, inv1.invoiceId)).toMatchObject({ amount: PRICE, creditedAmount: 10_000, outstandingAmount: PRICE - 10_000 });
  });

  it("US-M5-06 KP-4 daftar 'faktur bulanan siap kirim' + PDF; dikirim Admin Keuangan lewat tautan WA/e-mail dan status pengiriman tercatat", async () => {
    const w = await monthlyWorld(t.db);
    await creditTrip(w);
    const issueDay = nextMonthFirst(w.date);
    const run = await withTx((tx) => issueMonthlyInvoices(tx, system(issueDay), EQUA_TENANT_ID, issueDay));
    const inv = run.issued.find((i) => i.customerId === w.customer.id)!;
    const board = await m5.monthlyBoard(finance());
    expect(board.ready.some((r) => r.id === inv.invoiceId)).toBe(true);
    const pdf = await m5.renderInvoicePdf(finance(), inv.invoiceId);
    expect(pdf.filename).toBe(`faktur-${inv.number}.pdf`);
    const wa = await m5.sendInvoice(finance(), { invoiceId: inv.invoiceId, via: "wa" });
    expect(wa.link).toMatch(/^https:\/\/wa\.me\//);
    expect(decodeURIComponent(wa.link!)).toContain(inv.number);
    expect(wa.text).toMatch(/Faktur bulanan/);
    const [log] = await t.db.select().from(waMessageLogs).where(and(eq(waMessageLogs.objectType, "invoice"), eq(waMessageLogs.objectId, inv.invoiceId)));
    expect(log).toMatchObject({ kind: "monthly_invoice", status: "link_opened" });
    const after = await m5.monthlyBoard(finance());
    expect(after.ready.some((r) => r.id === inv.invoiceId)).toBe(false);
    expect(after.sent.find((r) => r.id === inv.invoiceId)).toMatchObject({ sentVia: "wa" });
    // E-mail: draf e-mail terisi (PDF dilampirkan dari tombol unduh), pengiriman tercatat.
    const mail = await m5.sendInvoice(finance(), { invoiceId: inv.invoiceId, via: "email" });
    expect(mail.link).toMatch(/^mailto:\?subject=/);
    expect(decodeURIComponent(mail.link!)).toContain(inv.number);
    expect(await invoiceRow(t.db, inv.invoiceId)).toMatchObject({ sentVia: "email" });
    // Hanya Admin Keuangan yang mengirim; Dispatcher tidak melihat daftar.
    await expect(m5.sendInvoice(owner(), { invoiceId: inv.invoiceId, via: "wa" })).rejects.toThrow();
    await expect(m5.monthlyBoard(dispatcher())).rejects.toThrow();
  });

  it("US-M5-06 KP-5 eksposur pelanggan tagihan bulanan menghitung rit belum ditagih sehingga batas kredit tetap berlaku sepanjang bulan", async () => {
    const w = await monthlyWorld(t.db, 2 * PRICE);
    await creditTrip(w);
    await creditTrip(w);
    const exp = await m5.computeExposure(t.db, w.customer.id);
    expect(exp).toMatchObject({ openInvoices: 0, unbilledCharges: 2 * PRICE, balance: 2 * PRICE, exposure: 2 * PRICE, exceedsLimit: false });
    expect((await m2.computeCreditExposure(t.db, w.customer.id)).unbilledCharges).toBe(2 * PRICE);
    // Pesanan tempo berikutnya melampaui batas → ditolak (US-M2-05).
    expect(await m2.evaluateCreditOrder(t.db, w.customer.id, PRICE)).toMatchObject({ ok: false, reason: "over_limit" });
    // Umur piutang menampilkan belum ditagih.
    const aging = await m5.agingReport(finance());
    expect(aging.customers.find((c) => c.customerId === w.customer.id)).toMatchObject({ unbilled: 2 * PRICE, total: 2 * PRICE });
  });

  it("US-M5-06 KP-2 penerbitan susulan Admin Keuangan setelah tanggal jatuh tempo PAR-12 (job tidak berjalan): jatuh tempo tidak sebelum tanggal faktur", async () => {
    const w = await monthlyWorld(t.db);
    await creditTrip(w);
    const lateDay = `${nextMonthFirst(w.date).slice(0, 7)}-20`;
    // Tanggal terbit tidak boleh setelah hari ini.
    await expect(m5.runMonthlyInvoicingNow(finance(w.date), { date: lateDay })).rejects.toThrow(/setelah hari ini/);
    const res = await m5.runMonthlyInvoicingNow(finance(lateDay));
    const mine = res.issued.find((i) => i.customerId === w.customer.id);
    expect(mine).toBeTruthy();
    expect(await invoiceRow(t.db, mine!.invoiceId)).toMatchObject({ kind: "monthly", periodMonth: firstDayOfMonth(w.date), issueDate: lateDay, dueDate: lateDay, amount: PRICE });
  });
});
