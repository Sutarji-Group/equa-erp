/**
 * Integrasi B-34 (S5): koreksi Admin Keuangan atas rit Selesai & pembalik pembayaran rit (M3, FR-M3-07, BR-38) sampai
 * ke Piutang (M5), Kas (M4) dan Akuntansi (M11) lewat `trip.corrected` / `trip_payment.reversed`.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { creditNotes, customerAdvances, deposits, domainEvents, incomingTransfers, invoices, tripPayments, trips } from "@/db/schema";
import * as approvals from "@/server/core/approvals";
import { DomainError, ForbiddenError, ValidationError } from "@/server/core/errors";
import * as m3 from "@/server/modules/m3-driver";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { journalsOfSource, linesOf } from "../m11-accounting/helpers";
import { PHOTO, PRICE, SIGNATURE, completeCash, completePayload, departArrive, dispatcher, driverWorld, expectApplied, finance, owner } from "../m3-driver/helpers";

async function eventsOf(db: Parameters<typeof driverWorld>[0], type: string, objectId: string) {
  return db.select().from(domainEvents).where(and(eq(domainEvents.type, type), eq(domainEvents.objectId, objectId)));
}

async function linesOfSourceType(db: Parameters<typeof driverWorld>[0], objectType: string, objectId: string, sourceType: string) {
  const js = (await journalsOfSource(db, objectType, objectId)).filter((j) => j.sourceType === sourceType);
  return (await Promise.all(js.map((j) => linesOf(db, j.id)))).flat();
}

function amountOn(lines: { code: string; debit: number; credit: number }[], code: string, side: "debit" | "credit"): number {
  return lines.filter((l) => l.code === code).reduce((s, l) => s + l[side], 0);
}

describe("B-34 koreksi rit & pembalik pembayaran rit (M3 → M5, M4, M11)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-34 US-M3-10 KP-2 FR-M3-07 harga rit tunai yang sudah lunas diturunkan → trip.corrected; kelebihan bayar menjadi uang muka pelanggan (M5) & jurnal D pendapatan / K uang muka (M11)", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));

    const res = await m3.correctTrip(finance(), { tripId: a.id, price: PRICE - 50_000, reason: "Volume parsial 4.000 L — harga disepakati turun" });
    expect(res).toMatchObject({ status: "corrected", priceDelta: -50_000, advanceAmount: 50_000 });
    const [row] = await t.db.select().from(trips).where(eq(trips.id, a.id));
    expect(row!.price).toBe(PRICE - 50_000);

    const [ev] = await eventsOf(t.db, "trip.corrected", a.id);
    expect(ev!.payload).toMatchObject({ tripId: a.id, priceDelta: -50_000, advanceAmount: 50_000, changes: { price: { from: PRICE, to: PRICE - 50_000 } }, tripNumber: a.number });

    const adv = await t.db.select().from(customerAdvances).where(eq(customerAdvances.customerId, w.customer.id));
    expect(adv.map((x) => x.amount)).toEqual([50_000]);
    expect(adv[0]!.notes).toContain(a.number);
    expect(await t.db.select().from(creditNotes).where(eq(creditNotes.customerId, w.customer.id))).toHaveLength(0);

    const lines = await linesOfSourceType(t.db, "trip", a.id, "trip.corrected");
    expect(amountOn(lines, "4-1101", "debit")).toBe(50_000);
    expect(amountOn(lines, "2-1201", "credit")).toBe(50_000);
    // Piutang: dikredit oleh koreksi lalu didebit kembali saat dipindah ke uang muka → netto nol.
    expect(amountOn(lines, "1-1401", "debit") - amountOn(lines, "1-1401", "credit")).toBe(0);
  });

  it("B-34 US-M5-01 KP-1 rit tempo: harga naik → faktur koreksi; harga turun → nota kredit trip_correction atas faktur rit (tanpa jurnal ganda M11)", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 5_000_000 });
    const a = await w.addTrip({ paymentMethod: "credit" });
    await departArrive(w, a.id);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", completePayload(a.id, { payment: { method: "credit" } }), { attach: [PHOTO, SIGNATURE] }));
    const [delivery] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, a.id), eq(invoices.kind, "delivery")));
    expect(delivery!.amount).toBe(PRICE);

    expect(await m3.correctTrip(finance(), { tripId: a.id, price: PRICE + 50_000, reason: "Harga zona salah — dikoreksi naik" })).toMatchObject({ status: "corrected", priceDelta: 50_000, advanceAmount: 0 });
    const correction = (await t.db.select().from(invoices).where(and(eq(invoices.tripId, a.id), eq(invoices.kind, "underpayment"))))[0]!;
    expect(correction).toMatchObject({ amount: 50_000, outstandingAmount: 50_000 });
    expect(correction.description).toContain("Koreksi harga");

    expect(await m3.correctTrip(finance(), { tripId: a.id, price: PRICE - 70_000, reason: "Volume parsial — harga turun" })).toMatchObject({ status: "corrected", priceDelta: -120_000, advanceAmount: 0 });
    const cns = await t.db.select().from(creditNotes).where(eq(creditNotes.customerId, w.customer.id));
    expect(cns.reduce((s, c) => s + c.amount, 0)).toBe(120_000);
    const after = await t.db.select().from(invoices).where(eq(invoices.tripId, a.id));
    expect(after.reduce((s, i) => s + i.outstandingAmount, 0)).toBe(PRICE - 70_000);
    // Nota kredit koreksi harga rit TIDAK dijurnal (pendapatan dikoreksi pada trip.corrected).
    for (const cn of cns) expect(await journalsOfSource(t.db, "credit_note", cn.id)).toHaveLength(0);
    const lines = await linesOfSourceType(t.db, "trip", a.id, "trip.corrected");
    // +50.000 lalu −120.000: pendapatan & piutang netto turun 70.000.
    expect(amountOn(lines, "4-1101", "debit") - amountOn(lines, "4-1101", "credit")).toBe(70_000);
    expect(amountOn(lines, "1-1401", "credit") - amountOn(lines, "1-1401", "debit")).toBe(70_000);
  });

  it("B-34 US-M3-10 KP-2 BR-38 pembalik pembayaran transfer rit → baris pembalik (asal tidak dihapus), transfer masuk M4 dibatalkan, faktur koreksi M5, jurnal D piutang / K transfer M11", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip({ paymentMethod: "transfer" });
    await departArrive(w, a.id);
    expectApplied(
      await w.send(w.sopir, "m3.trip.complete", completePayload(a.id, { payment: { method: "transfer", transferAmount: PRICE } }), { attach: [PHOTO, SIGNATURE, { kind: "transfer_proof" }] }),
    );
    const pay = (await m3.livePaymentOf(t.db, a.id))!;
    const [transfer] = await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceObjectId, pay.id));
    expect(transfer!.status).toBe("unmatched");

    const res = await m3.reverseTripPayment(finance(), { tripPaymentId: pay.id, reason: "Transfer pelanggan ternyata gagal (bukti palsu)" });
    expect(res.status).toBe("reversed");
    const rows = await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, a.id));
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === pay.id)!;
    const reversal = rows.find((r) => r.reversalOfId === pay.id)!;
    expect(original.reversedAt).not.toBeNull();
    expect(reversal).toMatchObject({ method: "transfer", receivedAmount: -PRICE, expectedAmount: -PRICE, reversalReason: expect.stringContaining("gagal") });
    expect(await m3.livePaymentOf(t.db, a.id)).toBeNull();

    const [ev] = await eventsOf(t.db, "trip_payment.reversed", pay.id);
    expect(ev!.payload).toMatchObject({ tripPaymentId: pay.id, reversalId: reversal.id, method: "transfer", amount: PRICE, tripNumber: a.number });
    expect((await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.id, transfer!.id)))[0]!.status).toBe("cancelled");
    const inv = (await t.db.select().from(invoices).where(and(eq(invoices.tripId, a.id), eq(invoices.kind, "underpayment"))))[0]!;
    expect(inv).toMatchObject({ amount: PRICE, outstandingAmount: PRICE });
    expect(inv.description).toContain("Pembalik pembayaran");
    const lines = await linesOfSourceType(t.db, "trip", a.id, "trip_payment.reversed");
    expect(amountOn(lines, "1-1401", "debit")).toBe(PRICE);
    expect(amountOn(lines, "1-1301", "credit")).toBe(PRICE);

    // Tidak dapat dibalik dua kali; baris pembalik tidak dapat dibalik.
    await expect(m3.reverseTripPayment(finance(), { tripPaymentId: pay.id, reason: "Coba balik lagi (uji)" })).rejects.toMatchObject({ code: "ALREADY_REVERSED" });
    await expect(m3.reverseTripPayment(finance(), { tripPaymentId: reversal.id, reason: "Coba balik pembalik (uji)" })).rejects.toMatchObject({ code: "REVERSAL_OF_REVERSAL" });
  });

  it("B-34 US-M3-07 KP-1 BR-38 pembalik tunai rit selama setoran sopir Berjalan → kas di tangan berkurang & jurnal D piutang / K kas sopir; setelah setoran Diterima ditolak dengan arahan ke selisih setoran", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    const b = await w.addTrip();
    await departArrive(w, b.id);
    expectApplied(await completeCash(w, b.id));
    expect((await m3.dayFigures(t.db, w.driver.userId, w.date)).cashOnHand).toBe(2 * PRICE);

    const payA = (await m3.livePaymentOf(t.db, a.id))!;
    expect((await m3.reverseTripPayment(finance(), { tripPaymentId: payA.id, reason: "Tunai dicatat ganda — pelanggan belum bayar" })).status).toBe("reversed");
    expect((await m3.dayFigures(t.db, w.driver.userId, w.date)).cashOnHand).toBe(PRICE);
    const lines = await linesOfSourceType(t.db, "trip", a.id, "trip_payment.reversed");
    expect(amountOn(lines, "1-1401", "debit")).toBe(PRICE);
    expect(amountOn(lines, "1-1102", "credit")).toBe(PRICE);

    // Setoran sopir sudah Diterima Admin Keuangan → hari kas terkunci; pembalik tunai ditolak.
    const payB = (await m3.livePaymentOf(t.db, b.id))!;
    await t.db.update(deposits).set({ status: "received" }).where(eq(deposits.id, payB.depositId!));
    await expect(m3.reverseTripPayment(finance(), { tripPaymentId: payB.id, reason: "Tunai salah catat (uji setoran diterima)" })).rejects.toMatchObject({ code: "DEPOSIT_ALREADY_RECEIVED" });
  });

  it("B-34 BR-38 PAR-21 koreksi > Rp 500.000 menunggu persetujuan pemilik (tanpa efek) → disetujui → berlaku sekali dengan rujukan persetujuan", async () => {
    const w = await driverWorld(t.db);
    const a = await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));

    const res = await m3.correctTrip(finance(), { tripId: a.id, price: PRICE + 650_000, reason: "Tambahan 2 tangki di lokasi — harga dikoreksi" });
    expect(res.status).toBe("pending_approval");
    expect((await t.db.select().from(trips).where(eq(trips.id, a.id)))[0]!.price).toBe(PRICE);
    expect(await eventsOf(t.db, "trip.corrected", a.id)).toHaveLength(0);

    const approvalId = res.status === "pending_approval" ? res.approval.id : "";
    // Pemohon tidak dapat menyetujui sendiri (pemisahan tugas).
    await expect(approvals.decide(finance(), approvalId, "approve", "Setuju")).rejects.toBeInstanceOf(ForbiddenError);
    await approvals.decide(owner(), approvalId, "approve", "Disetujui pemilik");
    expect((await t.db.select().from(trips).where(eq(trips.id, a.id)))[0]!.price).toBe(PRICE + 650_000);
    const evs = await eventsOf(t.db, "trip.corrected", a.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ priceDelta: 650_000, approvalId });
    const inv = (await t.db.select().from(invoices).where(and(eq(invoices.tripId, a.id), eq(invoices.kind, "underpayment"))))[0]!;
    expect(inv.amount).toBe(650_000);
  });

  it("B-34 FR-M3-07 US-M3-10 KP-2 hanya Admin Keuangan; rit belum Selesai, tempo & alasan pendek ditolak dengan pesan tindakan", async () => {
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 5_000_000 });
    const open = await w.addTrip();
    await expect(m3.correctTrip(dispatcher(), { tripId: open.id, price: 1, reason: "Dispatcher mencoba koreksi" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(m3.correctTrip(finance(), { tripId: open.id, price: 1, reason: "Rit belum berjalan" })).rejects.toBeInstanceOf(DomainError);
    await expect(m3.correctTrip(finance(), { tripId: open.id, price: 1, reason: "pendek" })).rejects.toBeInstanceOf(ValidationError);

    const credit = await w.addTrip({ paymentMethod: "credit" });
    await departArrive(w, credit.id);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", completePayload(credit.id, { payment: { method: "credit" } }), { attach: [PHOTO, SIGNATURE] }));
    const pay = (await m3.livePaymentOf(t.db, credit.id))!;
    await expect(m3.reverseTripPayment(finance(), { tripPaymentId: pay.id, reason: "Tempo mau dibalik (uji)" })).rejects.toMatchObject({ code: "PAYMENT_NOT_REVERSIBLE" });
    await expect(m3.correctTrip(finance(), { tripId: credit.id, price: PRICE, reason: "Tanpa perubahan harga" })).rejects.toBeInstanceOf(ValidationError);
  });
});
