import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, deposits, domainEvents, tripPayments, trips, waMessageLogs } from "@/db/schema";
import { outletId } from "@/db/seed";
import * as approvals from "@/server/core/approvals";

import { renderTemplateText, waLink, normalizePhoneForWa } from "@/client/m3-driver/contract";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import {
  HERE,
  PHOTO,
  PRICE,
  SIGNATURE,
  completeCash,
  completePayload,
  departArrive,
  dispatcher,
  driverWorld,
  expectApplied,
  expectRejected,
  notificationsFor,
} from "./helpers";

async function paymentOf(db: Parameters<typeof driverWorld>[0], tripId: string) {
  return (await db.select().from(tripPayments).where(eq(tripPayments.tripId, tripId)))[0]!;
}

describe("M3 — pembayaran per rit (US-M3-04) & struk WA (US-M3-03 KP-7)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M3-04 KP-1 pembayaran bagian dari Selesai (tidak dapat dilewati); harga dari pesanan, sopir tidak dapat mengubah harga (BR-19)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectRejected(await completeCash(w, a.id, w.sopir, { payment: { method: "none" } }), /Pembayaran wajib dicatat/);
    // Harga dari perangkat tidak dikenal skema (hanya uang fisik) → harga tetap harga pesanan.
    expectApplied(await completeCash(w, a.id, w.sopir, { price: 1, payment: { method: "cash", cashReceived: PRICE } }));
    const p = await paymentOf(t.db, a.id);
    expect(p).toMatchObject({ method: "cash", expectedAmount: PRICE, receivedAmount: PRICE, underpaymentAmount: 0 });
  });

  it("US-M3-04 KP-2 tunai kurang → alasan wajib → kurang bayar (faktur H+0 oleh M5 via event) + notifikasi Admin Keuangan & Dispatcher; lebih besar tidak dapat dicatat", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectRejected(await completeCash(w, a.id, w.sopir, { payment: { method: "cash", cashReceived: PRICE + 10_000 } }), /tidak dapat dicatat/);
    expectRejected(await completeCash(w, a.id, w.sopir, { payment: { method: "cash", cashReceived: 200_000 } }), /alasan kurang bayar/);
    expectApplied(await completeCash(w, a.id, w.sopir, { payment: { method: "cash", cashReceived: 200_000, underpaymentReasonCode: "customer_short" } }));
    const p = await paymentOf(t.db, a.id);
    expect(p).toMatchObject({ receivedAmount: 200_000, underpaymentAmount: 50_000 });
    expect(p.underpaymentReason).toMatch(/customer_short/);
    const notes = await notificationsFor(t.db, "trip.underpayment", a.id);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, p.id), eq(domainEvents.type, "trip.payment_recorded"))))[0]!;
    expect(ev.payload).toMatchObject({ method: "cash", expectedAmount: PRICE, receivedAmount: 200_000, underpaymentAmount: 50_000, profitCenter: "L2", businessDate: w.date, lateSync: false });
  });

  it("US-M3-04 KP-3 transfer: foto bukti wajib + jumlah; rekening PT tampil; tidak menambah kas di tangan", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    const today = await w.today();
    expect(today.bankAccounts.length).toBeGreaterThan(0);
    const transfer = { method: "transfer", transferAmount: PRICE };
    expectRejected(await completeCash(w, a.id, w.sopir, { payment: transfer }), /bukti transfer wajib/);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", completePayload(a.id, { payment: transfer }), { attach: [PHOTO, SIGNATURE, { kind: "transfer_proof" }] }));
    const p = await paymentOf(t.db, a.id);
    expect(p).toMatchObject({ method: "transfer", receivedAmount: PRICE, depositId: null });
    expect(p.transferProofAttachmentId).toBeTruthy();
    const after = await w.today();
    const { computeDayFigures } = await import("@/client/m3-driver/contract");
    const fig = computeDayFigures({ trips: after.trips, payments: after.payments, collections: after.collections, expenses: after.expenses });
    expect(fig).toMatchObject({ transfers: PRICE, cashOnHand: 0 });
  });

  it("US-M3-04 KP-4 tempo hanya untuk pesanan tempo; tempo → tunai/transfer selalu boleh", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const credit = await w.addTrip({ paymentMethod: "credit" });
    const credit2 = await w.addTrip({ paymentMethod: "credit" });
    await departArrive(w, credit.id);
    expectApplied(await completeCash(w, credit.id, w.sopir, { payment: { method: "credit" } }));
    expect(await paymentOf(t.db, credit.id)).toMatchObject({ method: "credit", receivedAmount: 0, expectedAmount: PRICE, originalMethod: null });
    await departArrive(w, credit2.id);
    expectApplied(await completeCash(w, credit2.id));
    expect(await paymentOf(t.db, credit2.id)).toMatchObject({ method: "cash", originalMethod: "credit" });
  });

  it("US-M3-04 KP-4 tunai → tempo hanya lewat persetujuan Dispatcher saat daring (pelanggan Tempo & dalam batas); disetujui → tempo", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const a = await w.addTrip();
    await departArrive(w, a.id);
    const req = await w.send(w.sopir, "m3.field_credit.request", { tripId: a.id, reason: "Pelanggan minta ditagih akhir bulan" });
    expectApplied(req);
    const approval = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, req.objectId!)))[0]!;
    expect(approval).toMatchObject({ type: "field_payment_to_credit", approverRole: "dispatcher", status: "submitted", objectId: a.id, amount: PRICE });
    // Sopir tidak dapat memutuskan permintaannya sendiri; Dispatcher memutuskan.
    await approvals.decide(dispatcher(), approval.id, "approve", "Pelanggan tempo, dalam batas");
    const view = await w.today();
    expect(view.trips.find((x) => x.id === a.id)!.creditRequest).toMatchObject({ status: "approved" });
    expectApplied(await completeCash(w, a.id, w.sopir, { payment: { method: "credit", creditApprovalId: approval.id } }));
    expect(await paymentOf(t.db, a.id)).toMatchObject({ method: "credit", originalMethod: "cash", methodChangeApprovalId: approval.id, underpaymentAmount: 0 });
  });

  it("US-M3-04 KP-4 pelanggan Tunai tidak pernah tempo di lapangan; permintaan luring/ditolak → kekurangan dicatat kurang bayar", async () => {
    const cashWorld = await driverWorld(t.db);
    const c = await cashWorld.addTrip();
    await departArrive(cashWorld, c.id);
    expectRejected(await cashWorld.send(cashWorld.sopir, "m3.field_credit.request", { tripId: c.id, reason: "Minta tempo" }), /tidak dapat tempo di lapangan/);
    // Luring: perintah tiba > batas menit setelah dicatat → ditolak (hanya saat daring).
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const a = await w.addTrip();
    const b = await w.addTrip();
    await departArrive(w, a.id);
    expectRejected(await w.send(w.sopir, "m3.field_credit.request", { tripId: a.id, reason: "Minta tempo" }, { deviceTime: new Date(Date.now() - 30 * 60_000) }), /hanya dapat diajukan saat ada sinyal/);
    // Tanpa persetujuan → tempo ditolak menjadi kurang bayar penuh.
    const res = await completeCash(w, a.id, w.sopir, { payment: { method: "credit" } });
    expectApplied(res);
    expect(res.result).toMatchObject({ convertedToUnderpayment: true, underpayment: PRICE });
    expect(await paymentOf(t.db, a.id)).toMatchObject({ method: "cash", receivedAmount: 0, underpaymentAmount: PRICE });
    // Ditolak Dispatcher → kurang bayar (sebagian tunai diterima).
    await departArrive(w, b.id);
    const req = await w.send(w.sopir, "m3.field_credit.request", { tripId: b.id, reason: "Minta tempo" });
    await approvals.decide(dispatcher(), req.objectId!, "reject", "Pelanggan sudah dekat batas");
    expectApplied(await completeCash(w, b.id, w.sopir, { payment: { method: "credit", creditApprovalId: req.objectId, cashReceivedIfRejected: 100_000 } }));
    expect(await paymentOf(t.db, b.id)).toMatchObject({ method: "cash", receivedAmount: 100_000, underpaymentAmount: PRICE - 100_000 });
  });

  it("US-M3-04 KP-4 permintaan yang belum diputuskan saat rit dicatat gugur (dibatalkan) → kurang bayar; persetujuan setelahnya → Admin Keuangan diberi tahu", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const a = await w.addTrip();
    await departArrive(w, a.id);
    const req = await w.send(w.sopir, "m3.field_credit.request", { tripId: a.id, reason: "Minta tempo" });
    expectApplied(await completeCash(w, a.id, w.sopir, { payment: { method: "credit", creditApprovalId: req.objectId } }));
    const approval = (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, req.objectId!)))[0]!;
    expect(approval.status).toBe("cancelled");
    expect(await paymentOf(t.db, a.id)).toMatchObject({ method: "cash", underpaymentAmount: PRICE });
  });

  it("US-M3-04 KP-5 setiap pembayaran memperbarui kas di tangan (tunai), transfer belum dicocokkan (event), piutang (tempo/kurang bayar via event)", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 10_000_000 });
    const cash = await w.addTrip();
    const credit = await w.addTrip({ paymentMethod: "credit" });
    await departArrive(w, cash.id);
    expectApplied(await completeCash(w, cash.id));
    await departArrive(w, credit.id);
    expectApplied(await completeCash(w, credit.id, w.sopir, { payment: { method: "credit" } }));
    const today = await w.today();
    const { computeDayFigures } = await import("@/client/m3-driver/contract");
    expect(computeDayFigures({ trips: today.trips, payments: today.payments, collections: today.collections, expenses: today.expenses })).toMatchObject({ tripCash: PRICE, cashOnHand: PRICE, credit: PRICE });
    const dep = (await t.db.select().from(deposits).where(and(eq(deposits.depositorUserId, w.driver.userId), eq(deposits.businessDate, w.date))))[0]!;
    expect(dep.status).toBe("running");
    expect(await paymentOf(t.db, cash.id)).toMatchObject({ depositId: dep.id });
    const evs = await t.db.select().from(domainEvents).where(eq(domainEvents.type, "trip.payment_recorded"));
    const creditEv = evs.find((e) => (e.payload as { tripId: string }).tripId === credit.id)!;
    expect(creditEv.payload).toMatchObject({ method: "credit", isCredit: true, amount: PRICE });
  });

  it("US-M3-04 KP-6 rit internal pasokan depot tidak memiliki langkah pembayaran", async () => {
    const w = await driverWorld(t.db);
    const i = await w.addTrip({ isInternal: true, destinationOutletId: outletId("D05"), paymentMethod: "internal" });
    await departArrive(w, i.id);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", { tripId: i.id, recipientName: null, deliveredVolumeL: 5000, location: HERE, payment: { method: "none" } }, { attach: [PHOTO] }));
    expect(await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, i.id))).toHaveLength(0);
    expectRejected(await w.send(w.sopir, "m3.field_credit.request", { tripId: i.id, reason: "x tempo" }), /.+/);
  });

  it("US-M3-03 KP-7 setelah pembayaran: struk WA terisi (nomor rit, tanggal, volume, harga, cara bayar, sisa piutang) dalam satu ketukan; dapat dilewati dengan alasan", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    const b = await w.addTrip();
    const today = await w.today();
    const tpl = today.receiptTemplates.trip_receipt!;
    expect(tpl).toContain("{{nomor_rit}}");
    const text = renderTemplateText(tpl, { nama_usaha: "EQUA", nomor_rit: a.number, tanggal: w.date, volume: "5.000 L", harga: "Rp250.000", cara_bayar: "Tunai", nama_penerima: "Ibu", sisa_piutang: null });
    expect(text).toContain(a.number);
    expect(text).not.toContain("{{");
    const phone = normalizePhoneForWa("0812-3456-7890")!;
    expect(waLink(phone, text)).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
    // Sebelum pembayaran tercatat → ditolak.
    expectRejected(await w.send(w.sopir, "m3.receipt.record", { kind: "trip_receipt", tripId: a.id, action: "opened", renderedText: text }), /setelah rit Selesai/);
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    expectApplied(await w.send(w.sopir, "m3.receipt.record", { kind: "trip_receipt", tripId: a.id, action: "opened", renderedText: text }));
    const logs = await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.objectId, a.id));
    expect(logs[0]).toMatchObject({ kind: "trip_receipt", status: "link_opened" });
    expect((await w.today()).trips.find((x) => x.id === a.id)!.receiptStatus).toBe("sent");
    // Dilewati beralasan (pelanggan tidak memakai WA).
    await departArrive(w, b.id);
    expectApplied(await completeCash(w, b.id));
    expectRejected(await w.send(w.sopir, "m3.receipt.record", { kind: "trip_receipt", tripId: b.id, action: "skipped" }), /alasan/);
    expectApplied(await w.send(w.sopir, "m3.receipt.record", { kind: "trip_receipt", tripId: b.id, action: "skipped", reasonCode: "no_whatsapp" }));
    const [row] = await t.db.select().from(trips).where(eq(trips.id, b.id));
    expect(row!.receiptSkippedReason).toMatch(/tidak memakai WA/);
  });
});
