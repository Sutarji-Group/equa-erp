import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { notifications } from "@/db/schema";
import { userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";
import * as params from "@/server/core/params";
import { runJobNow } from "@/server/core/jobs";
import * as m5 from "@/server/modules/m5-receivables";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { completeCash, departArrive, driverWorld, expectApplied, PRICE } from "../m3-driver/helpers";
import { accountant, creditCustomer, dispatcher, finance, invoiceFor, noonOf, owner, today } from "./helpers";

describe("Layanan layar Piutang (rincian pelunasan, reklasifikasi, status kredit)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-02 KP-4 rincian pelunasan: alokasi hidup per faktur, baris pembalik, dan tautan pembalik ↔ asal", async () => {
    const c = await creditCustomer(t.db, { name: "Pelanggan Rincian Pelunasan" });
    const d = today();
    const a = await invoiceFor(t.db, c.id, { amount: 200_000, issueDate: addDays(d, -10) });
    const b = await invoiceFor(t.db, c.id, { amount: 150_000, issueDate: addDays(d, -2) });
    const pay = await m5.recordOfficePayment(finance(), { customerId: c.id, businessDate: d, amount: 400_000, method: "cash" });
    const detail = await m5.getPaymentDetail(finance(), pay.payment.id);
    expect(detail.allocations.map((x) => [x.invoiceId, x.amount])).toEqual([
      [a.id, 200_000],
      [b.id, 150_000],
    ]);
    expect(detail.advances).toHaveLength(1);
    expect(detail.advances[0]).toMatchObject({ amount: 50_000 });
    expect(detail.reversal).toBeNull();
    const rev = await m5.reverseCustomerPayment(finance(), { paymentId: pay.payment.id, reason: "Salah input jumlah" });
    expect(rev.status).toBe("reversed");
    const after = await m5.getPaymentDetail(finance(), pay.payment.id);
    expect(after.allocations).toHaveLength(0);
    expect(after.allocationRows.some((r) => r.amount < 0)).toBe(true);
    expect(after.reversal).toBeTruthy();
    const reversalDetail = await m5.getPaymentDetail(finance(), after.reversal!.id);
    expect(reversalDetail.reversalOf?.id).toBe(pay.payment.id);
    // Hanya pemilik & Admin Keuangan yang melihat pelunasan.
    await expect(m5.getPaymentDetail(dispatcher(), pay.payment.id)).rejects.toThrow();
  });

  it("US-M5-02 KP-4 7.5.6 daftar tunai rit yang dapat dialihkan menjadi pelunasan; hilang setelah direklasifikasi", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    await invoiceFor(t.db, w.customer.id, { amount: PRICE, issueDate: addDays(w.date, -20) });
    const trip = await w.addTrip({ paymentMethod: "credit" });
    await departArrive(w, trip.id);
    expectApplied(await completeCash(w, trip.id));
    const list = await m5.reclassCandidates(finance(), { customerId: w.customer.id });
    expect(list.find((c) => c.tripId === trip.id)).toMatchObject({ tripNumber: trip.number, amount: PRICE, otherOutstanding: PRICE });
    await expect(m5.reclassCandidates(dispatcher())).rejects.toThrow();
    await m5.reclassifyTripCash(finance(), { tripId: trip.id, reason: "Pelanggan membayar faktur lama" });
    expect((await m5.reclassCandidates(finance(), { customerId: w.customer.id })).some((c) => c.tripId === trip.id)).toBe(false);
  });

  it("US-M5-01 KP-6 7.5.6 nota kredit biasa ditolak untuk faktur bersengketa — koreksi lewat keputusan pemilik", async () => {
    const c = await creditCustomer(t.db, { name: "Resto Sengketa Nota Kredit" });
    const inv = await invoiceFor(t.db, c.id, { amount: 300_000, issueDate: today() });
    await m5.disputeInvoice(finance(), { invoiceId: inv.id, note: "Pelanggan: harga tidak sesuai" });
    await expect(m5.requestCreditNote(finance(), { invoiceId: inv.id, amount: 10_000, reason: "Coba potong harga" })).rejects.toThrow(/bersengketa/);
  });

  it("US-M5-03 KP-5 batas masa transisi untuk layar mengikuti go-live + PAR-41 (Dispatcher dapat melihat)", async () => {
    const d = today();
    await params.set(owner(d), "PAR-41", { max_months_since_go_live: 2, go_live_date: addDays(d, -3) }, d, "Go-live pilot (uji layar)");
    const limit = await m5.holdDeferralLimit(dispatcher(d));
    expect(limit).toMatchObject({ goLive: addDays(d, -3), months: 2, today: d });
    expect(limit.maxUntil! > addDays(d, 50)).toBe(true);
    await expect(m5.holdDeferralLimit(seededContext("sopir1"))).rejects.toThrow();
  });

  it("US-M5-01 KP-3 pilihan pelanggan layar: Dispatcher (status kredit) & akuntan (faktur) boleh; sopir tidak; tanpa pelanggan internal depot", async () => {
    const opts = await m5.customerOptions(dispatcher());
    expect(opts.length).toBeGreaterThan(10);
    expect(opts.every((o) => typeof o.monthlyBilling === "boolean")).toBe(true);
    expect((await m5.customerOptions(accountant())).length).toBe(opts.length);
    await expect(m5.customerOptions(seededContext("sopir1"))).rejects.toThrow();
  });

  it("US-M5-05 KP-1 label & daftar pengingat mengikuti PAR-13 (H-n / H+n dapat diubah pemilik)", async () => {
    const d = today();
    const base = await m5.listReminders(finance());
    expect(m5.reminderKindLabel("before_due", base)).toBe(`H-${base.daysBeforeDue} sebelum jatuh tempo`);
    await params.set(owner(d), "PAR-13", { days_before_due: 5, days_after_due: 2 }, d, "Pengingat lebih awal (uji)");
    const c = await creditCustomer(t.db, { name: "Kafe PAR-13" });
    const inv = await invoiceFor(t.db, c.id, { amount: 80_000, issueDate: addDays(d, -9), dueDate: addDays(d, 5) });
    const list = await m5.listReminders(finance());
    expect(list).toMatchObject({ daysBeforeDue: 5, daysAfterDue: 2 });
    expect(list.groups.find((g) => g.customerId === c.id)?.invoices.map((i) => i.id)).toEqual([inv.id]);
    expect(m5.reminderKindLabel("after_due", list)).toBe("H+2 sesudah jatuh tempo");
  });

  it("US-M5-04 KP-1 ringkasan mingguan & layar umur memuat sasaran KPI-04 dari parameter (bukan angka tertanam)", async () => {
    const d = today();
    await params.set(owner(d), "m5.receivable_rules", { underpayment_due_days: 0, aging_first_bucket_days: 7, aging_second_bucket_days: 30, hold_warning_days: 3, statement_default_days: 90, kpi04_target_percent: 4 }, d, "Sasaran KPI-04 diperketat (uji)");
    const aging = await m5.agingReport(finance());
    expect(aging.kpi04TargetPercent).toBe(4);
    const c = await creditCustomer(t.db, { name: "Pelanggan Sasaran KPI" });
    await invoiceFor(t.db, c.id, { amount: 500_000, issueDate: addDays(d, -40), dueDate: addDays(d, -20) });
    const res = await runJobNow("m5.weekly_aging", noonOf(d), { runKey: `kpi-${newId()}` });
    expect(res.status).toBe("succeeded");
    const [n] = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "receivable.weekly_aging"), eq(notifications.recipientUserId, userIdByUsername("pemilik"))))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(n!.body).toMatch(/Sasaran KPI-04: lewat tempo di bawah 4%/);
  });
});
