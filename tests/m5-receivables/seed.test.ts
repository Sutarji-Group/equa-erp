import { and, eq, isNull, sum } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { creditNotes, customerAdvances, customerPayments, customers, invoices, paymentAllocations, posSales } from "@/db/schema";
import { customerId } from "@/db/seed";
import { seedDemoM5Receivables } from "@/db/seed/demo-m5-receivables";
import { seedId } from "@/db/seed/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import * as m5 from "@/server/modules/m5-receivables";
import { recomputeInvoice } from "@/server/modules/m5-receivables/service/ledger";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

/** Selasa 20 Okt 2026 10.00 WIB (sesudah tanggal 15: faktur bulanan bulan lalu sudah terkirim & lunas). */
const NOW = new Date("2026-10-20T03:00:00Z");
/** Senin 5 Okt 2026 10.00 WIB (sebelum tanggal 15: faktur bulanan bulan lalu siap kirim). */
const EARLY = new Date("2026-10-05T03:00:00Z");

const ctxAt = (username: string, now: Date) => seededContext(username, { now });
const demoInvoice = (key: string) => seedId(`m5:demo:invoice:${key}`);

/** Buku piutang seed konsisten: hitung ulang tiap faktur tidak mengubah apa pun; uang muka & pelunasan seimbang. */
async function expectLedgerConsistent(db: Db, now: Date) {
  const all = await db.select().from(invoices);
  expect(all.length).toBeGreaterThan(0);
  const sys = systemContext({ now });
  for (const inv of all) {
    const res = await withTx((tx) => recomputeInvoice(tx, sys, inv.id));
    expect({ number: inv.number, changed: res.changed }).toEqual({ number: inv.number, changed: false });
  }
  expect(new Set(all.map((i) => i.number)).size).toBe(all.length);
  for (const inv of all) expect(inv.number).toMatch(/^F-\d{2}-\d{6}$/);
  for (const adv of await db.select().from(customerAdvances)) {
    const [row] = await db.select({ used: sum(paymentAllocations.amount) }).from(paymentAllocations).where(eq(paymentAllocations.customerAdvanceId, adv.id));
    expect(adv.remainingAmount).toBe(adv.amount - Number(row?.used ?? 0));
  }
  for (const pay of await db.select().from(customerPayments)) {
    const [row] = await db.select({ used: sum(paymentAllocations.amount) }).from(paymentAllocations).where(and(eq(paymentAllocations.customerPaymentId, pay.id), isNull(paymentAllocations.creditNoteId)));
    expect(pay.advanceAmount).toBe(pay.amount - Number(row?.used ?? 0));
  }
}

describe("M5 seed demo (sesudah tanggal 15)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("snapshot uji tidak memuat data demo M5 (tanggal relatif hari ini) — seed dilewati di Vitest tanpa force", async () => {
    expect(await seedDemoM5Receivables(t.db)).toEqual({ invoices: 0, created: false });
    expect(await t.db.select().from(invoices)).toHaveLength(0);
  });

  it("US-M5-01 KP-1 US-M5-02 KP-3 seed demo idempoten; faktur, pelunasan, uang muka & nota kredit konsisten dengan buku piutang", async () => {
    const first = await seedDemoM5Receivables(t.db, NOW, { force: true });
    expect(first.created).toBe(true);
    expect(first.invoices).toBeGreaterThanOrEqual(14);
    expect(await seedDemoM5Receivables(t.db, NOW, { force: true })).toEqual({ invoices: 0, created: false });
    expect(await t.db.select().from(invoices)).toHaveLength(first.invoices);
    await expectLedgerConsistent(t.db, NOW);

    const [cn] = await t.db.select().from(creditNotes).where(eq(creditNotes.invoiceId, demoInvoice("sinar-b")));
    expect(cn!.number).toMatch(/^NK-26-\d{6}$/);
    const [sinarA] = await t.db.select().from(invoices).where(eq(invoices.id, demoInvoice("sinar-a")));
    expect(sinarA).toMatchObject({ amount: 900_000, paidAmount: 400_000, outstandingAmount: 500_000, status: "partial", dueDate: "2026-10-14" });
    const [kencana] = await t.db.select().from(invoices).where(eq(invoices.id, demoInvoice("kencana-a")));
    expect(kencana).toMatchObject({ status: "paid", outstandingAmount: 0 });
    expect(kencana!.paidAt!.toISOString()).toBe(new Date("2026-10-03T03:30:00Z").toISOString());
  });

  it("B-23 penjualan tempo toko demo M7 difakturkan (pos_sales.invoice_id terisi) dan terpotong uang muka pelanggan", async () => {
    const sales = await t.db
      .select()
      .from(posSales)
      .where(and(eq(posSales.paymentMethod, "credit"), eq(posSales.status, "valid"), eq(posSales.isReversal, false)));
    expect(sales.length).toBeGreaterThanOrEqual(1);
    for (const sale of sales) {
      expect(sale.invoiceId).toBeTruthy();
      const [inv] = await t.db.select().from(invoices).where(eq(invoices.id, sale.invoiceId!));
      expect(inv).toMatchObject({ kind: "store_sale", posSaleId: sale.id, customerId: sale.customerId, amount: sale.total, issueDate: sale.businessDate });
    }
    const [advance] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.id, seedId("m5:demo:advance:tirta-cash")));
    expect(advance).toMatchObject({ amount: 50_000, remainingAmount: 0, status: "applied" });
    const [applied] = await t.db.select().from(paymentAllocations).where(eq(paymentAllocations.customerAdvanceId, advance!.id));
    expect(applied).toMatchObject({ invoiceId: sales[0]!.invoiceId, amount: 50_000 });
  });

  it("US-M5-04 KP-1 US-M5-03 KP-1 layar umur piutang & status kredit berisi (lewat tempo per kelompok, akan Ditahan, Ditahan); evaluasi malam tidak menahan yang belum waktunya", async () => {
    const aging = await m5.agingReport(ctxAt("keuangan1", NOW));
    const sinar = aging.customers.find((c) => c.customerId === customerId("PLG-0024"))!;
    expect(sinar).toMatchObject({ d1_7: 500_000, not_due: 425_000, overdue: 500_000 });
    const kerupuk = aging.customers.find((c) => c.customerId === customerId("PLG-0026"))!;
    expect(kerupuk).toMatchObject({ d8_30: 1_350_000, over_30: 150_000 });
    expect(aging.customers.find((c) => c.customerId === customerId("PLG-0034"))).toMatchObject({ unbilled: 3 * 550_000 });

    const board = await m5.creditStatusBoard(ctxAt("dispatcher1", NOW));
    expect(board.willHold.find((r) => r.customerId === customerId("PLG-0024"))).toMatchObject({ holdOn: "2026-10-22", worstDaysPastDue: 6 });
    expect(board.onHold.some((r) => r.customerId === customerId("PLG-0026"))).toBe(true);
    // Faktur bersengketa (dalam PAR-45) dan saldo awal yang belum ditandatangani tidak memicu "akan Ditahan".
    expect(board.willHold.some((r) => r.customerId === customerId("PLG-0033"))).toBe(false);
    expect(board.willHold.some((r) => r.customerId === customerId("PLG-0028"))).toBe(false);

    await m5.runHoldEvaluationNow(ctxAt("keuangan1", NOW));
    const statusOf = async (code: string) => (await t.db.select({ s: customers.creditStatus }).from(customers).where(eq(customers.id, customerId(code))))[0]!.s;
    expect(await statusOf("PLG-0024")).toBe("credit");
    expect(await statusOf("PLG-0026")).toBe("on_hold");
    expect(await statusOf("PLG-0028")).toBe("credit_migrated");
    expect(await statusOf("PLG-0033")).toBe("credit");
  });

  it("US-M5-05 KP-1 US-M5-06 KP-5 US-M5-07 KP-2 pengingat hari ini, faktur bulanan & rit belum ditagih, saldo awal menunggu tanda tangan", async () => {
    const reminders = await m5.listReminders(ctxAt("keuangan1", NOW));
    const tahuBefore = reminders.groups.find((g) => g.customerId === customerId("PLG-0025") && g.kind === "before_due");
    const tahuAfter = reminders.groups.find((g) => g.customerId === customerId("PLG-0025") && g.kind === "after_due");
    expect(tahuBefore).toMatchObject({ status: "scheduled", total: 450_000 });
    expect(tahuAfter).toMatchObject({ status: "opened", total: 900_000 });
    expect(reminders.groups.find((g) => g.customerId === customerId("PLG-0018"))).toMatchObject({ kind: "after_due", status: "scheduled", total: 150_000 });
    expect(reminders.groups.some((g) => g.customerId === customerId("PLG-0028"))).toBe(false);

    const monthly = await m5.monthlyBoard(ctxAt("keuangan1", NOW));
    expect(monthly.sent.find((i) => i.id === demoInvoice("bukit-monthly"))).toMatchObject({ periodMonth: "2026-09-01", issueDate: "2026-10-01", dueDate: "2026-10-15", status: "paid", amount: 4 * 550_000 });
    expect(monthly.unbilled.find((u) => u.customerId === customerId("PLG-0034"))).toMatchObject({ n: 3, total: 3 * 550_000 });

    const opening = await m5.openingBoard(ctxAt("pemilik", NOW));
    expect(opening.summary).toMatchObject({ total: 2_000_000, count: 2 });
    expect(opening.signoff).toMatchObject({ status: "draft" });
    expect((opening.signoff!.summary as { total: number }).total).toBe(2_000_000);
    // Pemilik dapat langsung menandatangani total seed (ringkasan konsisten dengan faktur saldo awal).
    const signed = await m5.signOpeningBalances(ctxAt("pemilik", NOW), { expectedTotal: 2_000_000 });
    expect(signed.status).toBe("signed");
  });
});

describe("M5 seed demo (sebelum tanggal 15)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-06 KP-1 faktur bulanan bulan lalu terbit tanggal 1 dan siap kirim; rit bulan ini belum ditagih; buku konsisten", async () => {
    const res = await seedDemoM5Receivables(t.db, EARLY, { force: true });
    expect(res.created).toBe(true);
    await expectLedgerConsistent(t.db, EARLY);
    const monthly = await m5.monthlyBoard(ctxAt("keuangan1", EARLY));
    expect(monthly.ready.find((i) => i.id === demoInvoice("bukit-monthly"))).toMatchObject({ issueDate: "2026-10-01", dueDate: "2026-10-15", status: "open", sentAt: null });
    // Rit sebelum tanggal 1 bulan ini tidak dimasukkan sebagai "belum ditagih" (sudah masuk faktur bulan lalu).
    expect(monthly.unbilled.find((u) => u.customerId === customerId("PLG-0034"))).toMatchObject({ n: 2 });
    const toBe = toBusinessDate(EARLY);
    const [griya] = await t.db.select().from(invoices).where(eq(invoices.id, demoInvoice("griya-under")));
    expect(griya).toMatchObject({ kind: "underpayment", issueDate: addDays(toBe, -1), dueDate: addDays(toBe, -1), outstandingAmount: 150_000 });
  });
});
