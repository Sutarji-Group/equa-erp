import { and, eq, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { dataSignoffs, domainEvents, invoices, journals } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { addDays, firstDayOfMonth } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import * as params from "@/server/core/params";
import * as m5 from "@/server/modules/m5-receivables";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { attachment, creditCustomer, customerRow, finance, invoiceRow, owner, today } from "./helpers";

/** Bukti konfirmasi saldo dari pelanggan (PDF) yang diunggah Admin Keuangan. */
const confirmation = () => attachment(finance(), "customer_confirmation", true);

/** Tanggal 1 bulan, `months` bulan sebelum `d`. */
function monthsBefore(d: string, months: number): string {
  let x = firstDayOfMonth(d);
  for (let i = 0; i < months; i++) x = firstDayOfMonth(addDays(x, -1));
  return x;
}

describe("US-M5-07 KP-1 Input saldo awal piutang", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-07 KP-1 faktur saldo awal per pelanggan (tanggal, keterangan, jumlah, jatuh tempo, bukti konfirmasi) bertanda 'saldo awal' tanpa jurnal penjualan", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Pabrik Saldo Awal" });
    const base = { customerId: c.id, issueDate: addDays(d, -40), dueDate: addDays(d, -26), description: "Nota kertas 0457 (rit bulan lalu)", amount: 1_200_000 };
    // Bukti konfirmasi pelanggan wajib.
    await expect(m5.createOpeningInvoice(finance(), base)).rejects.toThrow(/Bukti konfirmasi/);
    // Pemilik tidak menginput data harian/awal (hanya menandatangani).
    await expect(m5.createOpeningInvoice(owner(), { ...base, confirmationAttachmentId: (await confirmation()).id })).rejects.toThrow();
    const proof = await confirmation();
    const inv = await m5.createOpeningInvoice(finance(), { ...base, confirmationAttachmentId: proof.id });
    expect(inv).toMatchObject({
      kind: "opening_balance",
      isOpeningBalance: true,
      amount: 1_200_000,
      outstandingAmount: 1_200_000,
      issueDate: base.issueDate,
      dueDate: base.dueDate,
      description: base.description,
      openingConfirmationAttachmentId: proof.id,
    });
    expect(inv.number).toMatch(/^F-\d{2}-\d{6}$/);
    // Event bertanda saldo awal (M11: neraca awal, bukan jurnal penjualan) dan tidak ada jurnal penjualan.
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "invoice.issued"), eq(domainEvents.objectId, inv.id)));
    expect(ev!.payload).toMatchObject({ kind: "opening_balance", isOpeningBalance: true, profitCenter: null });
    expect(await t.db.select().from(journals).where(eq(journals.sourceEventId, ev!.id))).toHaveLength(0);
    // Ringkasan draf untuk tanda tangan pemilik (NFR-34).
    const board = await m5.openingBoard(finance());
    expect(board.signoff).toMatchObject({ status: "draft", group: "opening_receivables" });
    expect(board.summary).toMatchObject({ total: 1_200_000, count: 1 });
    // Tanggal setelah hari ini / jatuh tempo sebelum tanggal faktur ditolak.
    await expect(m5.createOpeningInvoice(finance(), { ...base, issueDate: addDays(d, 1), dueDate: addDays(d, 10), confirmationAttachmentId: (await confirmation()).id })).rejects.toThrow(/setelah hari ini/);
    await expect(m5.createOpeningInvoice(finance(), { ...base, dueDate: addDays(d, -45), confirmationAttachmentId: (await confirmation()).id })).rejects.toThrow(/Jatuh tempo/);
    // Setelah tanggal cut-over ditetapkan: faktur saldo awal harus bertanggal sebelum cut-over.
    const cutover = firstDayOfMonth(d);
    await params.set(owner(), "accounting.cutover_date", { date: cutover }, d, "Cut-over akuntansi pilot");
    await expect(m5.createOpeningInvoice(finance(), { ...base, issueDate: cutover, dueDate: addDays(cutover, 14), confirmationAttachmentId: (await confirmation()).id })).rejects.toThrow(/sebelum cut-over/);
  });
});

describe("B-37 lini asal faktur saldo awal", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-37 US-M5-07 KP-1 US-M5-04 KP-1 faktur saldo awal menyimpan lini asal (toko/kemitraan/air truk) sehingga umur piutang per lini tepat", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Toko Mitra Saldo Awal" });
    const store = await m5.createOpeningInvoice(finance(), { customerId: c.id, line: "store", issueDate: addDays(d, -20), dueDate: addDays(d, -5), description: "Nota toko kertas 0112", amount: 450_000, confirmationAttachmentId: (await confirmation()).id });
    const truck = await m5.createOpeningInvoice(finance(), { customerId: c.id, issueDate: addDays(d, -20), dueDate: addDays(d, -5), description: "Nota air kertas 0113", amount: 700_000, confirmationAttachmentId: (await confirmation()).id });
    expect(store.openingLine).toBe("store");
    // Tanpa pilihan → air truk (perilaku lama).
    expect(truck.openingLine).toBe("truck");
    await expect(m5.createOpeningInvoice(finance(), { customerId: c.id, line: "gudang", issueDate: addDays(d, -20), dueDate: addDays(d, -5), description: "Lini salah", amount: 1_000, confirmationAttachmentId: (await confirmation()).id })).rejects.toThrow(/Lini piutang/);
    expect((await m5.getInvoiceDetail(finance(), store.id)).line).toBe("store");
    const aging = await m5.agingReport(finance(), { line: "store" });
    const storeLine = aging.byLine.find((g) => g.key === "store");
    expect(storeLine?.total).toBeGreaterThanOrEqual(450_000);
    expect(aging.customers.find((r) => r.customerId === c.id)?.total).toBe(450_000);
    const truckAging = await m5.agingReport(finance(), { line: "truck" });
    expect(truckAging.customers.find((r) => r.customerId === c.id)?.total).toBe(700_000);
  });
});

describe("US-M5-07 KP-2 Tanda tangan pemilik & koreksi berjejak", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-07 KP-2 total saldo awal ditandatangani pemilik sebelum dipakai; setelahnya perubahan hanya lewat koreksi berjejak dengan persetujuan pemilik", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Hotel Saldo Awal" });
    const a = await m5.createOpeningInvoice(finance(), { customerId: c.id, issueDate: addDays(d, -50), dueDate: addDays(d, -36), description: "Tagihan lama A", amount: 500_000, confirmationAttachmentId: (await confirmation()).id });
    await m5.createOpeningInvoice(finance(), { customerId: c.id, issueDate: addDays(d, -30), dueDate: addDays(d, -16), description: "Tagihan lama B", amount: 300_000, confirmationAttachmentId: (await confirmation()).id });
    // Entri salah sebelum tanda tangan → dibatalkan lewat nota kredit berjejak (tanpa penghapusan).
    const wrong = await m5.createOpeningInvoice(finance(), { customerId: c.id, issueDate: addDays(d, -30), dueDate: addDays(d, -16), description: "Salah pelanggan", amount: 99_000, confirmationAttachmentId: (await confirmation()).id });
    await m5.cancelOpeningInvoice(finance(), { invoiceId: wrong.id, reason: "Salah pelanggan, milik pelanggan lain" });
    expect(await invoiceRow(t.db, wrong.id)).toMatchObject({ creditedAmount: 99_000, outstandingAmount: 0 });
    const before = await m5.openingBoard(owner());
    expect(before.summary.total).toBe(800_000);
    // Admin Keuangan tidak dapat menandatangani; total yang berubah sejak ditinjau ditolak.
    await expect(m5.signOpeningBalances(finance(), { expectedTotal: 800_000 })).rejects.toThrow();
    await expect(m5.signOpeningBalances(owner(), { expectedTotal: 700_000 })).rejects.toThrow(/berubah/);
    const signed = await m5.signOpeningBalances(owner(), { expectedTotal: 800_000, note: "Sesuai konfirmasi pelanggan" });
    expect(signed).toMatchObject({ status: "signed", signedBy: userIdByUsername("pemilik") });
    const [row] = await t.db.select().from(dataSignoffs).where(eq(dataSignoffs.id, signed.id));
    expect(row!.summary).toMatchObject({ total: 800_000 });
    // Setelah ditandatangani: input & pembatalan langsung ditolak; nota kredit biasa atas saldo awal ditolak.
    await expect(m5.createOpeningInvoice(finance(), { customerId: c.id, issueDate: addDays(d, -20), dueDate: addDays(d, -6), description: "Tambahan", amount: 10_000, confirmationAttachmentId: (await confirmation()).id })).rejects.toThrow(/ditandatangani/);
    await expect(m5.cancelOpeningInvoice(finance(), { invoiceId: a.id, reason: "Coba batal setelah tanda tangan" })).rejects.toThrow(/ditandatangani/);
    await expect(m5.requestCreditNote(finance(), { invoiceId: a.id, amount: 1_000, reason: "Coba nota kredit" })).rejects.toThrow(/saldo awal/);
    // Koreksi berjejak: tambah faktur saldo awal → persetujuan pemilik.
    const addReq = await m5.requestOpeningAdjustment(finance(), {
      action: "add",
      customerId: c.id,
      issueDate: addDays(d, -35),
      dueDate: addDays(d, -21),
      description: "Nota tertinggal",
      amount: 150_000,
      confirmationAttachmentId: (await confirmation()).id,
      reason: "Pelanggan menemukan nota yang belum tercatat",
    });
    expect(addReq).toMatchObject({ type: "opening_balance_adjustment", approverRole: "owner", objectType: "opening_receivable", status: "submitted" });
    await expect(approvals.decide(finance(), addReq.id, "approve")).rejects.toThrow();
    await approvals.decide(owner(), addReq.id, "approve", "Sesuai bukti pelanggan");
    const [added] = await t.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.customerId, c.id), eq(invoices.isOpeningBalance, true), like(invoices.description, "Koreksi saldo awal:%")));
    expect(added).toMatchObject({ amount: 150_000, kind: "opening_balance" });
    // Koreksi berjejak: kurangi faktur saldo awal → nota kredit setelah disetujui; ditolak → tidak berubah.
    const redReq = await m5.requestOpeningAdjustment(finance(), { action: "reduce", invoiceId: a.id, amount: 50_000, reason: "Potongan harga disepakati" });
    await approvals.decide(owner(), redReq.id, "approve", "Setuju");
    expect(await invoiceRow(t.db, a.id)).toMatchObject({ creditedAmount: 50_000, outstandingAmount: 450_000 });
    const rejReq = await m5.requestOpeningAdjustment(finance(), { action: "reduce", invoiceId: a.id, amount: 20_000, reason: "Potongan tambahan" });
    await approvals.decide(owner(), rejReq.id, "reject", "Tidak ada dasar");
    expect(await invoiceRow(t.db, a.id)).toMatchObject({ outstandingAmount: 450_000 });
    // PAR-62: penyesuaian hanya sampai N bulan setelah cut-over.
    await params.set(owner(), "accounting.cutover_date", { date: monthsBefore(d, 6) }, d, "Cut-over enam bulan lalu (uji)");
    await expect(m5.requestOpeningAdjustment(finance(), { action: "reduce", invoiceId: a.id, amount: 1_000, reason: "Terlambat diajukan" })).rejects.toThrow(/PAR-62/);
  });
});

describe("US-M5-07 KP-3 Saldo awal ikut umur, pengingat, penahanan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-07 KP-3 faktur saldo awal mengikuti aturan umur, pengingat, dan penahanan yang sama setelah ditandatangani, termasuk masa transisi US-M5-03 KP-5", async () => {
    const d = today();
    const late = await creditCustomer(t.db, { name: "Pelanggan Lama Telat" });
    const remind = await creditCustomer(t.db, { name: "Pelanggan Lama Diingatkan" });
    const transit = await creditCustomer(t.db, { name: "Pelanggan Lama Transisi" });
    const lateInv = await m5.createOpeningInvoice(finance(), { customerId: late.id, issueDate: addDays(d, -44), dueDate: addDays(d, -30), description: "Tagihan lama telat", amount: 700_000, confirmationAttachmentId: (await confirmation()).id });
    const remindInv = await m5.createOpeningInvoice(finance(), { customerId: remind.id, issueDate: addDays(d, -11), dueDate: addDays(d, 3), description: "Tagihan lama segera jatuh tempo", amount: 200_000, confirmationAttachmentId: (await confirmation()).id });
    await m5.createOpeningInvoice(finance(), { customerId: transit.id, issueDate: addDays(d, -34), dueDate: addDays(d, -20), description: "Tagihan lama transisi", amount: 400_000, confirmationAttachmentId: (await confirmation()).id });
    // Piutang diakui di umur piutang sejak dicatat…
    const aging = await m5.agingReport(finance());
    expect(aging.customers.find((r) => r.customerId === late.id)).toMatchObject({ d8_30: 700_000, overdue: 700_000 });
    // …tetapi sebelum ditandatangani pemilik belum dipakai untuk penahanan & pengingat.
    await m5.runHoldEvaluationNow(finance());
    expect((await customerRow(t.db, late.id)).creditStatus).toBe("credit");
    expect((await m5.listReminders(finance())).groups.some((g) => g.customerId === remind.id)).toBe(false);
    // Masa transisi (6.2b) untuk satu pelanggan lama.
    await params.set(owner(d), "PAR-41", { max_months_since_go_live: 2, go_live_date: addDays(d, -5) }, d, "Go-live pilot");
    await m5.deferCreditHold(owner(d), { customerId: transit.id, until: addDays(d, 30), reason: "Pelanggan lama, transisi sistem" });
    const board = await m5.openingBoard(owner());
    await m5.signOpeningBalances(owner(), { expectedTotal: board.summary.total });
    // Setelah ditandatangani: aturan yang sama berlaku.
    await m5.runHoldEvaluationNow(finance());
    expect((await customerRow(t.db, late.id)).creditStatus).toBe("on_hold");
    expect((await customerRow(t.db, transit.id)).creditStatus).toBe("credit");
    const reminders = await m5.listReminders(finance());
    const g = reminders.groups.find((x) => x.customerId === remind.id);
    expect(g).toMatchObject({ kind: "before_due", total: 200_000 });
    expect(g!.invoices.map((i) => i.id)).toEqual([remindInv.id]);
    const after = await m5.agingReport(finance());
    expect(after.customers.find((r) => r.customerId === transit.id)).toMatchObject({ inTransition: true, overdue: 400_000 });
    // Lunas → Ditahan dilepas otomatis (BR-03).
    await m5.recordOfficePayment(finance(), { customerId: late.id, businessDate: d, amount: 700_000, method: "cash" });
    expect(await invoiceRow(t.db, lateInv.id)).toMatchObject({ status: "paid" });
    expect((await customerRow(t.db, late.id)).creditStatus).toBe("credit");
    void EQUA_TENANT_ID;
  });
});
