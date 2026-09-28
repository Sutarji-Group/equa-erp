import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { exportLogs, notifications, unbilledCharges, waMessageLogs } from "@/db/schema";
import { userIdByUsername } from "@/db/seed";
import { addDays } from "@/lib/time";
import { exportReport } from "@/server/core/export";
import { runJobNow } from "@/server/core/jobs";
import * as m5 from "@/server/modules/m5-receivables";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { accountant, creditCustomer, dispatcher, finance, invoiceFor, noonOf, owner, today } from "./helpers";

describe("US-M5-04 Laporan umur piutang dan kartu piutang", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-04 KP-1 umur per pelanggan/segmen/lini (belum jatuh tempo / 1–7 / 8–30 / > 30) + % lewat tempo (KPI-04), tersedia kapan saja", async () => {
    const d = today();
    const hotel = await creditCustomer(t.db, { segment: "hotel", name: "Hotel Umur" });
    const depot = await creditCustomer(t.db, { segment: "third_party_depot", name: "Depot Umur" });
    await invoiceFor(t.db, hotel.id, { amount: 100_000, issueDate: addDays(d, -2), dueDate: addDays(d, 5) });
    await invoiceFor(t.db, hotel.id, { amount: 200_000, issueDate: addDays(d, -20), dueDate: addDays(d, -3) });
    await invoiceFor(t.db, hotel.id, { amount: 300_000, issueDate: addDays(d, -30), dueDate: addDays(d, -15) });
    await invoiceFor(t.db, hotel.id, { amount: 400_000, issueDate: addDays(d, -60), dueDate: addDays(d, -40) });
    await invoiceFor(t.db, depot.id, { amount: 50_000, issueDate: addDays(d, -10), dueDate: addDays(d, -1), kind: "store_sale" });
    await t.db.insert(unbilledCharges).values({ tenantId: hotel.tenantId, customerId: hotel.id, serviceDate: d, description: "Rit belum ditagih", amount: 70_000 });
    const r = await m5.agingReport(finance());
    const row = r.customers.find((c) => c.customerId === hotel.id)!;
    expect(row).toMatchObject({ not_due: 100_000, d1_7: 200_000, d8_30: 300_000, over_30: 400_000, unbilled: 70_000, total: 1_070_000, overdue: 900_000, segment: "hotel" });
    expect(r.customers.find((c) => c.customerId === depot.id)).toMatchObject({ d1_7: 50_000 });
    const store = r.byLine.find((g) => g.key === "store")!;
    const truck = r.byLine.find((g) => g.key === "truck")!;
    expect(store.total).toBeGreaterThanOrEqual(50_000);
    expect(truck.total).toBeGreaterThanOrEqual(1_070_000);
    expect(r.bySegment.find((g) => g.key === "hotel")!.total).toBeGreaterThanOrEqual(1_070_000);
    expect(r.totals.overduePct).toBeCloseTo(Math.round((r.totals.overdue / r.totals.total) * 10_000) / 100, 2);
    expect(r.bucketLabels).toMatchObject({ d1_7: "1–7 hari", d8_30: "8–30 hari", over_30: "> 30 hari" });
    // Posisi per tanggal lain (kapan saja).
    const past = await m5.agingReport(finance(), { asOf: addDays(d, -20) });
    expect(past.customers.find((c) => c.customerId === hotel.id)!.over_30).toBe(0);
    // Filter lini toko.
    const onlyStore = await m5.agingReport(finance(), { line: "store" });
    expect(onlyStore.customers.every((c) => c.customerId !== hotel.id)).toBe(true);
    // Akuntan (baca-saja) dapat melihat; Dispatcher tidak.
    expect((await m5.agingReport(accountant())).totals.total).toBe(r.totals.total);
    await expect(m5.agingReport(dispatcher())).rejects.toThrow();
  });

  it("US-M5-04 KP-1 ringkasan umur piutang mingguan otomatis ke pemilik setiap Senin pagi (PAR-40)", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Pelanggan Mingguan" });
    await invoiceFor(t.db, c.id, { amount: 900_000, issueDate: addDays(d, -40), dueDate: addDays(d, -20) });
    const res = await runJobNow("m5.weekly_aging", noonOf(d));
    expect(res.status).toBe("succeeded");
    const [n] = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "receivable.weekly_aging"), eq(notifications.recipientUserId, userIdByUsername("pemilik"))))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(n!.title).toMatch(/lewat tempo/);
    expect(n!.body).toContain("Pelanggan Mingguan");
    expect(n!.link).toBe("/piutang/umur");
  });

  it("US-M5-04 KP-2 kartu piutang: faktur, pelunasan, uang muka, saldo berjalan; ekspor PDF/Excel; dikirim sebagai pernyataan piutang", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Pelanggan Kartu" });
    const a = await invoiceFor(t.db, c.id, { amount: 500_000, issueDate: addDays(d, -20) });
    await invoiceFor(t.db, c.id, { amount: 300_000, issueDate: addDays(d, -5) });
    const small = await invoiceFor(t.db, c.id, { amount: 50_000, issueDate: addDays(d, -3) });
    await m5.requestCreditNote(finance(), { invoiceId: small.id, amount: 10_000, reason: "Pembulatan harga" });
    // 500 + 300 + (50 − 10) = 840 terbuka; bayar 900 → lebih 60 menjadi uang muka.
    await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: addDays(d, -2), amount: 900_000, method: "cash" });
    await invoiceFor(t.db, c.id, { amount: 100_000, issueDate: d });
    const st = await m5.customerStatement(finance(), c.id, { from: addDays(d, -30), to: d });
    const kinds = st.entries.map((e) => e.kind);
    expect(kinds).toContain("invoice");
    expect(kinds).toContain("payment");
    expect(kinds).toContain("advance");
    expect(kinds).toContain("credit_note");
    // Saldo berjalan = Σ debit − Σ kredit; saldo akhir = sisa faktur terbuka.
    const last = st.entries[st.entries.length - 1]!;
    expect(st.closingBalance).toBe(last.balance);
    expect(st.closingBalance).toBe(st.openInvoices.reduce((s, i) => s + i.outstanding, 0));
    expect(st.openAdvance).toBeGreaterThanOrEqual(0);
    void a;
    // Ekspor Excel & PDF (data pelanggan → tujuan wajib, BR-39).
    const xlsx = await exportReport(finance(), "m5.customer_card", "xlsx", { customerId: c.id }, "Konfirmasi saldo ke pelanggan");
    expect(xlsx.rowCount).toBeGreaterThan(1);
    const pdf = await exportReport(owner(), "m5.customer_card", "pdf", { customerId: c.id }, "Tinjauan pemilik");
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    const sent = await m5.sendStatement(finance(), { customerId: c.id });
    expect(decodeURIComponent(sent.link)).toContain("Pernyataan piutang");
    const [log] = await t.db.select().from(waMessageLogs).where(and(eq(waMessageLogs.kind, "statement"), eq(waMessageLogs.customerId, c.id)));
    expect(log).toBeTruthy();
  });

  it("US-M5-04 KP-3 daftar tindakan harian Admin Keuangan: perlu diingatkan (H-3/H+1) dan yang akan/sudah Ditahan", async () => {
    const d = today();
    const remindBefore = await creditCustomer(t.db, { name: "Ingat H-3" });
    const remindAfter = await creditCustomer(t.db, { name: "Ingat H+1" });
    const soon = await creditCustomer(t.db, { name: "Akan Ditahan" });
    const held = await creditCustomer(t.db, { name: "Sudah Ditahan" });
    await invoiceFor(t.db, remindBefore.id, { amount: 100_000, issueDate: d, dueDate: addDays(d, 3) });
    await invoiceFor(t.db, remindAfter.id, { amount: 100_000, issueDate: addDays(d, -15), dueDate: addDays(d, -1) });
    await invoiceFor(t.db, soon.id, { amount: 100_000, issueDate: addDays(d, -20), dueDate: addDays(d, -6) });
    await invoiceFor(t.db, held.id, { amount: 100_000, issueDate: addDays(d, -40), dueDate: addDays(d, -20) });
    await m5.runHoldEvaluationNow(finance());
    const list = await m5.dailyActionList(finance());
    expect(list.remind.some((g) => g.customerId === remindBefore.id && g.kind === "before_due")).toBe(true);
    expect(list.remind.some((g) => g.customerId === remindAfter.id && g.kind === "after_due")).toBe(true);
    expect(list.willHold.find((r) => r.customerId === soon.id)).toMatchObject({ holdOn: addDays(d, 2) });
    expect(list.onHold.some((r) => r.customerId === held.id)).toBe(true);
  });

  it("US-M5-04 KP-4 ekspor yang memuat data pelanggan hanya pemilik/Admin Keuangan dengan tujuan tercatat (BR-39)", async () => {
    await expect(exportReport(finance(), "m5.aging", "xlsx", {}, "")).rejects.toThrow(/Tujuan ekspor wajib/);
    const ok = await exportReport(finance(), "m5.aging", "xlsx", {}, "Rapat penagihan mingguan");
    const [log] = await t.db.select().from(exportLogs).where(eq(exportLogs.id, ok.exportLogId));
    expect(log).toMatchObject({ reportKey: "m5.aging", purpose: "Rapat penagihan mingguan", containsPersonalData: true });
    await expect(exportReport(accountant(), "m5.aging", "xlsx", {}, "Audit")).rejects.toThrow();
    await expect(exportReport(dispatcher(), "m5.aging", "xlsx", {}, "Penagihan")).rejects.toThrow();
    // Ringkasan per segmen & lini tanpa data pribadi: akuntan boleh.
    const groups = await exportReport(accountant(), "m5.aging_groups", "pdf", {});
    expect(groups.containsPersonalData).toBe(false);
  });
});
