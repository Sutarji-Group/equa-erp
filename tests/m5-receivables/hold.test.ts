import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customerCreditHistory, customers, domainEvents, incomingTransfers, invoices, orders, trips } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { addDays } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { runJobNow } from "@/server/core/jobs";
import * as params from "@/server/core/params";
import * as m2 from "@/server/modules/m2-orders";
import * as m5 from "@/server/modules/m5-receivables";
import { evaluateCreditHolds } from "@/server/modules/m5-receivables/service/credit-hold";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createOrder, createScheduledTrip, createTruck } from "../helpers/fixtures";
import { creditCustomer, customerRow, dispatcher, finance, invoiceFor, invoiceRow, noonOf, notificationsFor, owner, system, today } from "./helpers";

/** Evaluasi pada tanggal tertentu (internal modul — uji tanggal bisnis berbeda dari jam dinding). */
const m5Internal = {
  evaluate: (tx: Parameters<typeof evaluateCreditHolds>[0], date: string) => evaluateCreditHolds(tx, system(date), EQUA_TENANT_ID, date),
};

describe("US-M5-03 Kontrol jatuh tempo dan status Ditahan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-03 KP-1 setelah tutup kas: faktur lewat tempo > PAR-09 → Ditahan otomatis + notifikasi Dispatcher/Admin Keuangan/pemilik; pesanan tempo baru diblokir", async () => {
    const d = today();
    const late = await creditCustomer(t.db, { name: "Hotel Telat" });
    const edge = await creditCustomer(t.db, { name: "Hotel Tepat 7 Hari" });
    await invoiceFor(t.db, late.id, { amount: 400_000, issueDate: addDays(d, -30), dueDate: addDays(d, -8) });
    await invoiceFor(t.db, edge.id, { amount: 400_000, issueDate: addDays(d, -30), dueDate: addDays(d, -7) });
    // Dipicu event tutup kas (M4).
    await withTx((tx) => emit(tx, "cash_day.closed", { cashDayId: "00000000-0000-7000-8000-000000000001", closedBy: userIdByUsername("keuangan1"), late: false, exceptionCount: 0 }, { ctx: system(d), businessDate: d }));
    expect((await customerRow(t.db, late.id)).creditStatus).toBe("on_hold");
    expect((await customerRow(t.db, edge.id)).creditStatus).toBe("credit");
    const notes = await notificationsFor(t.db, "credit.on_hold", late.id);
    const who = new Set(notes.map((n) => n.recipientUserId));
    for (const u of ["pemilik", "keuangan1", "dispatcher1"]) expect(who.has(userIdByUsername(u))).toBe(true);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "credit_status.changed"), eq(domainEvents.objectId, late.id)));
    expect(ev!.payload).toMatchObject({ from: "credit", to: "on_hold", automatic: true, rule: "BR-03" });
    expect(await m2.evaluateCreditOrder(t.db, late.id, 100_000)).toMatchObject({ ok: false, reason: "on_hold" });
    // Job harian (PAR-55) idempoten — tidak menahan ulang / menggandakan riwayat.
    await runJobNow("m5.credit_hold.daily", noonOf(d));
    const hist = await t.db.select().from(customerCreditHistory).where(and(eq(customerCreditHistory.customerId, late.id), eq(customerCreditHistory.toStatus, "on_hold")));
    expect(hist).toHaveLength(1);
  });

  it("US-M5-03 KP-2 rit tempo pelanggan Ditahan yang belum Berangkat ditandai ke Dispatcher; rit yang sudah Berangkat berlanjut (PTB-27)", async () => {
    const d = today();
    const c = await creditCustomer(t.db);
    const truck = await createTruck(t.db);
    const o1 = await createOrder(t.db, { customerId: c.id, addressId: c.addressId!, date: d });
    const waiting = await createScheduledTrip(t.db, { order: o1, truckId: truck.id, date: d, paymentMethod: "credit" });
    const o2 = await createOrder(t.db, { customerId: c.id, addressId: c.addressId!, date: d });
    const gone = await createScheduledTrip(t.db, { order: o2, truckId: truck.id, date: d, paymentMethod: "credit", sequence: 1 });
    await t.db.update(trips).set({ status: "departed", departedAt: new Date() }).where(eq(trips.id, gone.id));
    await invoiceFor(t.db, c.id, { amount: 100_000, issueDate: addDays(d, -40), dueDate: addDays(d, -20) });
    await m5.runHoldEvaluationNow(finance(d));
    const [w] = await t.db.select().from(trips).where(eq(trips.id, waiting.id));
    const [g] = await t.db.select().from(trips).where(eq(trips.id, gone.id));
    expect(w!.creditHoldFlaggedAt).toBeTruthy();
    expect(g!.creditHoldFlaggedAt).toBeNull();
    expect(await notificationsFor(t.db, "order.credit_hold_trips", c.id)).not.toHaveLength(0);
  });

  it("US-M5-03 KP-3 Ditahan dilepas otomatis saat seluruh faktur lewat tempo lunas", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { creditStatus: "credit_migrated" });
    const inv = await invoiceFor(t.db, c.id, { amount: 250_000, issueDate: addDays(d, -40), dueDate: addDays(d, -15) });
    await m5.runHoldEvaluationNow(finance(d));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("on_hold");
    await m5.recordOfficePayment(finance(d), { customerId: c.id, businessDate: d, amount: 250_000, method: "cash" });
    expect(await invoiceRow(t.db, inv.id)).toMatchObject({ status: "paid" });
    // Kembali ke status sebelum Ditahan (Tempo migrasi).
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("credit_migrated");
    expect(await notificationsFor(t.db, "credit.hold_released", c.id)).not.toHaveLength(0);
  });

  it("US-M5-03 KP-3 pembukaan sebelum lunas hanya pemilik beralasan (persetujuan bila diajukan Dispatcher/Admin Keuangan); berlaku sampai keterlambatan berikutnya", async () => {
    const d = today();
    const c = await creditCustomer(t.db);
    await invoiceFor(t.db, c.id, { amount: 300_000, issueDate: addDays(d, -40), dueDate: addDays(d, -20) });
    await m5.runHoldEvaluationNow(finance(d));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("on_hold");
    // Admin Keuangan tidak dapat membuka langsung.
    await expect(m5.releaseCreditHold(finance(d), { customerId: c.id, reason: "Pelanggan janji bayar" })).rejects.toThrow();
    await expect(m5.releaseCreditHold(owner(d), { customerId: c.id, reason: "" })).rejects.toThrow(/Alasan/);
    await m5.releaseCreditHold(owner(d), { customerId: c.id, reason: "Pelanggan besar, janji bayar Jumat" });
    const after = await customerRow(t.db, c.id);
    expect(after).toMatchObject({ creditStatus: "credit", holdReleaseCoversDueUntil: addDays(d, -20), holdReleasedBy: userIdByUsername("pemilik") });
    // Evaluasi berikutnya tidak menahan ulang atas faktur yang sama…
    await m5.runHoldEvaluationNow(finance(d));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("credit");
    // …tetapi keterlambatan berikutnya menahan lagi.
    await invoiceFor(t.db, c.id, { amount: 100_000, issueDate: addDays(d, -30), dueDate: addDays(d, -9) });
    await m5.runHoldEvaluationNow(finance(d));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("on_hold");
    // Dispatcher mengajukan → pemilik menyetujui.
    const req = await m5.requestCreditHoldRelease(dispatcher(d), { customerId: c.id, reason: "Pelanggan sudah transfer, menunggu mutasi" });
    expect(req).toMatchObject({ type: "credit_hold_release", approverRole: "owner", status: "submitted" });
    await approvals.decide(owner(d), req.id, "approve", "Setuju");
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("credit");
  });

  it("US-M5-03 KP-4 riwayat status kredit per pelanggan (kapan, oleh siapa, alasan) tersimpan", async () => {
    const d = today();
    const c = await creditCustomer(t.db);
    await invoiceFor(t.db, c.id, { amount: 300_000, issueDate: addDays(d, -40), dueDate: addDays(d, -20) });
    await m5.runHoldEvaluationNow(finance(d));
    await m5.releaseCreditHold(owner(d), { customerId: c.id, reason: "Keputusan pemilik: pelanggan lama" });
    const hist = await m5.creditHistory(finance(d), c.id);
    expect(hist.length).toBeGreaterThanOrEqual(2);
    const [released, held] = hist;
    expect(released).toMatchObject({ fromStatus: "on_hold", toStatus: "credit", rule: "BR-03" });
    expect(released!.reason).toContain("pelanggan lama");
    expect(released!.changedByName).toBeTruthy();
    expect(held).toMatchObject({ fromStatus: "credit", toStatus: "on_hold", changedByName: "Sistem" });
    expect(held!.changedAt).toBeInstanceOf(Date);
  });

  it("US-M5-03 KP-5 masa transisi: pemilik menunda penahanan per pelanggan ≤ 2 bulan sejak go-live (PAR-41); tetap tampil di laporan lewat tempo", async () => {
    const d = today();
    await params.set(owner(d), "PAR-41", { max_months_since_go_live: 2, go_live_date: addDays(d, -10) }, d, "Go-live pilot");
    const c = await creditCustomer(t.db, { name: "Kolam Transisi" });
    await invoiceFor(t.db, c.id, { amount: 500_000, issueDate: addDays(d, -40), dueDate: addDays(d, -20) });
    await expect(m5.deferCreditHold(dispatcher(d), { customerId: c.id, until: addDays(d, 10), reason: "Masa transisi" })).rejects.toThrow();
    await expect(m5.deferCreditHold(owner(d), { customerId: c.id, until: addDays(d, 70), reason: "Masa transisi" })).rejects.toThrow(/paling lama 2 bulan/);
    const res = await m5.deferCreditHold(owner(d), { customerId: c.id, until: addDays(d, 20), reason: "Pelanggan lama, transisi sistem" });
    expect(res.customer.holdDeferralUntil).toBe(addDays(d, 20));
    await m5.runHoldEvaluationNow(finance(d));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("credit");
    const aging = await m5.agingReport(finance(d));
    expect(aging.customers.find((r) => r.customerId === c.id)).toMatchObject({ inTransition: true, overdue: 500_000 });
    const board = await m5.creditStatusBoard(finance(d));
    expect(board.transition.some((r) => r.customerId === c.id)).toBe(true);
    expect(await notificationsFor(t.db, "credit.hold_deferred", c.id)).not.toHaveLength(0);
    // Setelah masa transisi berakhir → ditahan.
    const later = addDays(d, 21);
    await withTx((tx) => m5Internal.evaluate(tx, later));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("on_hold");
  });

  it("US-M5-03 KP-6 pelanggan Tunai yang memenuhi PAR-11 + PAR-82 tampil sebagai 'layak diajukan Tempo'", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { creditStatus: "cash", creditLimit: 0, segment: "industry", name: "Pabrik Layak" });
    const truck = await createTruck(t.db);
    void truck;
    const o = await createOrder(t.db, { customerId: c.id, addressId: c.addressId!, date: addDays(d, -130) });
    await t.db.update(orders).set({ status: "completed", completedAt: noonOf(addDays(d, -130)) }).where(eq(orders.id, o.id));
    const household = await creditCustomer(t.db, { creditStatus: "cash", creditLimit: 0, segment: "household", name: "Rumah Tangga" });
    const oh = await createOrder(t.db, { customerId: household.id, addressId: household.addressId!, date: addDays(d, -130) });
    await t.db.update(orders).set({ status: "completed", completedAt: noonOf(addDays(d, -130)) }).where(eq(orders.id, oh.id));
    const list = await m5.creditEligibleCustomers(dispatcher(d));
    expect(list.some((r) => r.customerId === c.id)).toBe(true);
    expect(list.some((r) => r.customerId === household.id)).toBe(false);
  });
});

describe("7.5.6 Sengketa, piutang tak tertagih, transfer tidak ditemukan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-03 KP-1 7.5.6 faktur bersengketa: penahanan & pengingat ditunda ≤ PAR-45 hari sampai diputuskan pemilik (nota kredit / ditolak)", async () => {
    const d = today();
    const c = await creditCustomer(t.db);
    const inv = await invoiceFor(t.db, c.id, { amount: 600_000, issueDate: addDays(d, -40), dueDate: addDays(d, -10) });
    await expect(m5.disputeInvoice(dispatcher(d), { invoiceId: inv.id, note: "Volume kurang" })).rejects.toThrow();
    const disputed = await m5.disputeInvoice(finance(d), { invoiceId: inv.id, note: "Pelanggan: volume hanya 4.000 L" });
    expect(disputed).toMatchObject({ disputeStatus: "disputed", disputeUntil: addDays(d, 7) });
    expect(await notificationsFor(t.db, "receivable.dispute_opened", inv.id)).not.toHaveLength(0);
    await m5.runHoldEvaluationNow(finance(d));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("credit");
    // Lewat PAR-45 tanpa keputusan → dihitung lagi.
    await withTx((tx) => m5Internal.evaluate(tx, addDays(d, 8)));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("on_hold");
    // Admin Keuangan tidak memutuskan; pemilik memutuskan nota kredit.
    await expect(m5.decideDispute(finance(d), { invoiceId: inv.id, decision: "reject", reason: "Tidak berdasar" })).rejects.toThrow();
    const res = await m5.decideDispute(owner(d), { invoiceId: inv.id, decision: "credit_note", amount: 120_000, reason: "Volume terbukti 4.000 L" });
    expect(res.invoice).toMatchObject({ disputeStatus: "resolved", creditedAmount: 120_000, outstandingAmount: 480_000 });
    // Sengketa ditolak.
    const inv2 = await invoiceFor(t.db, c.id, { amount: 100_000, issueDate: d });
    await m5.disputeInvoice(finance(d), { invoiceId: inv2.id, note: "Harga berbeda" });
    const rej = await m5.decideDispute(owner(d), { invoiceId: inv2.id, decision: "reject", reason: "Harga sesuai daftar" });
    expect(rej.invoice).toMatchObject({ disputeStatus: "rejected", outstandingAmount: 100_000 });
  });

  it("US-M5-03 KP-3 7.5.6 piutang tak tertagih dihapus lewat jurnal manual M11 (writeOffInvoice) — pelanggan tetap Ditahan (PTB-28)", async () => {
    const d = today();
    const c = await creditCustomer(t.db);
    const bad = await invoiceFor(t.db, c.id, { amount: 700_000, issueDate: addDays(d, -90), dueDate: addDays(d, -60) });
    await m5.runHoldEvaluationNow(finance(d));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("on_hold");
    const after = await withTx((tx) => m5.writeOffInvoice(tx, { ctx: owner(d), invoiceId: bad.id, reason: "Pelanggan tutup usaha" }));
    expect(after).toMatchObject({ writtenOffAmount: 700_000, outstandingAmount: 0, status: "paid" });
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "invoice.written_off"), eq(domainEvents.objectId, bad.id)));
    expect(ev!.payload).toMatchObject({ amount: 700_000, reason: "Pelanggan tutup usaha" });
    await m5.runHoldEvaluationNow(finance(d));
    expect((await customerRow(t.db, c.id)).creditStatus).toBe("on_hold");
    // Pelanggan dinonaktifkan: piutang tetap tampil sampai lunas/dihapus.
    const other = await invoiceFor(t.db, c.id, { amount: 50_000, issueDate: d });
    await t.db.update(customers).set({ isActive: false }).where(eq(customers.id, c.id));
    expect((await m5.agingReport(finance(d))).customers.find((r) => r.customerId === c.id)?.total).toBe(50_000);
    void other;
  });

  it("US-M5-01 KP-3 7.5.6 transfer tidak ditemukan → piutang sementara 'transfer belum diterima'; dicocokkan → penanda dihapus", async () => {
    const d = today();
    const c = await creditCustomer(t.db);
    const [tr] = await t.db
      .insert(incomingTransfers)
      .values({ tenantId: EQUA_TENANT_ID, sourceKind: "trip_payment", customerId: c.id, amount: 250_000, transferDate: addDays(d, -3), businessDate: addDays(d, -3), status: "not_found" })
      .returning();
    await withTx((tx) => emit(tx, "transfer.not_found", { incomingTransferId: tr!.id, amount: 250_000, sourceKind: "trip_payment", customerId: c.id }, { ctx: system(d), businessDate: d }));
    const [temp] = await t.db.select().from(invoices).where(eq(invoices.pendingTransferId, tr!.id));
    expect(temp).toMatchObject({ customerId: c.id, amount: 250_000, outstandingAmount: 250_000, dueDate: d });
    expect((await m5.getReceivableBalance(t.db, c.id)).balance).toBe(250_000);
    expect(await m5.pendingTransferInvoice(t.db, tr!.id)).toMatchObject({ id: temp!.id });
    await withTx((tx) => emit(tx, "transfer.matched", { incomingTransferId: tr!.id, amount: 250_000, sourceKind: "trip_payment", matchedAt: new Date().toISOString(), customerId: c.id }, { ctx: system(d) }));
    expect(await invoiceRow(t.db, temp!.id)).toMatchObject({ pendingTransferId: null, outstandingAmount: 0 });
    expect((await m5.getReceivableBalance(t.db, c.id)).balance).toBe(0);
  });
});
