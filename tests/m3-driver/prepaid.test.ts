/**
 * B-65 (S5, D-11 butir 4; US-P2-04 KP-4, perubahan kecil US-M3-04): rit yang sudah dibayar di muka lewat pembayaran
 * digital aplikasi pelanggan tampil "sudah dibayar" di aplikasi sopir dan TIDAK ditagih tunai; pembayaran rit dicatat
 * `digital` (bukan kurang bayar) dan `trip.completed` memuat `prepaidAmount` untuk pengakuan pendapatan terhadap uang
 * muka (M5/M11, kontrak hand-off M3 §2).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { domainEvents, invoices, paymentIntents, tripPayments } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { newId } from "@/lib/ids";
import { M3_EXTERNAL_REFS, prepaidInfo, type DriverPrepaidTripsPull, type M3TripRef } from "@/client/m3-driver/contract";
import { paymentFromComplete } from "@/client/m3-driver/optimistic";
import * as m3 from "@/server/modules/m3-driver";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { PHOTO, PRICE, SIGNATURE, completePayload, departArrive, driverWorld, expectApplied, expectRejected, type World } from "./helpers";

async function prepaidTrip(w: World, opts: { paid?: boolean; amount?: number } = {}) {
  const trip = await w.addTrip({ paymentMethod: "digital" });
  if (opts.paid ?? true) {
    await w.db.insert(paymentIntents).values({
      tenantId: EQUA_TENANT_ID,
      customerId: w.customer.id,
      orderId: trip.orderId,
      amount: opts.amount ?? PRICE,
      method: "qris_dynamic",
      status: "succeeded",
      gatewayOrderId: `UJI-${newId()}`,
      succeededAt: new Date(),
    });
  }
  return trip;
}

describe("B-65 rit prabayar digital di aplikasi sopir (US-P2-04 KP-4, D-11 butir 4)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-65 US-P2-04 KP-4 US-M3-04 KP-1 pull sopir: cara bayar digital + p2.prepaid_trips; Selesai 'Sudah dibayar' tanpa tunai → pembayaran digital, tanpa faktur kurang bayar, kas di tangan tetap; trip.completed memuat prepaidAmount", async () => {
    const w = await driverWorld(t.db);
    const a = await prepaidTrip(w);
    const pull = await w.hp.pull(w.sopir, { keys: `m3.today,${M3_EXTERNAL_REFS.prepaidTrips}` });
    const ref = (pull.data["m3.today"] as { trips: M3TripRef[] }).trips.find((x) => x.id === a.id)!;
    expect(ref.paymentMethod).toBe("digital");
    const prepaid = pull.data[M3_EXTERNAL_REFS.prepaidTrips] as DriverPrepaidTripsPull;
    expect(prepaidInfo(ref, prepaid)).toMatchObject({ paidAmount: PRICE });

    await departArrive(w, a.id);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", completePayload(a.id, { payment: { method: "prepaid" } }), { attach: [PHOTO, SIGNATURE] }));

    const [pay] = await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, a.id));
    expect(pay).toMatchObject({ method: "digital", expectedAmount: PRICE, receivedAmount: PRICE, underpaymentAmount: 0, depositId: null });
    expect(await t.db.select().from(invoices).where(eq(invoices.tripId, a.id))).toHaveLength(0);
    const figures = await m3.dayFigures(t.db, w.driver.userId, w.date);
    expect(figures).toMatchObject({ tripCash: 0, cashOnHand: 0, underpayments: 0 });

    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "trip.completed"), eq(domainEvents.objectId, a.id)));
    expect(ev!.payload).toMatchObject({ paymentMethod: "digital", prepaidAmount: PRICE, cashReceived: 0, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0 });
    const [pe] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "trip.payment_recorded"), eq(domainEvents.objectId, pay!.id)));
    expect(pe!.payload).toMatchObject({ method: "digital", prepaidAmount: PRICE, underpaymentAmount: 0 });
  });

  it("B-65 D-11 butir 4 'Sudah dibayar' hanya untuk rit prabayar berhasil: rit tunai ditolak; rit digital tanpa pembayaran berhasil ditolak; tanpa cara bayar diarahkan ke 'Sudah dibayar'; bayar di muka kurang → sisa kurang bayar", async () => {
    const w = await driverWorld(t.db);
    const cash = await w.addTrip();
    await departArrive(w, cash.id);
    expectRejected(await w.send(w.sopir, "m3.trip.complete", completePayload(cash.id, { payment: { method: "prepaid" } }), { attach: [PHOTO, SIGNATURE] }), /belum dibayar di muka/);
    expectApplied(await w.send(w.sopir, "m3.trip.complete", completePayload(cash.id), { attach: [PHOTO, SIGNATURE] }));

    const unpaid = await prepaidTrip(w, { paid: false });
    await departArrive(w, unpaid.id);
    expectRejected(await w.send(w.sopir, "m3.trip.complete", completePayload(unpaid.id, { payment: { method: "none" } }), { attach: [PHOTO, SIGNATURE] }), /Sudah dibayar/);
    expectRejected(await w.send(w.sopir, "m3.trip.complete", completePayload(unpaid.id, { payment: { method: "prepaid" } }), { attach: [PHOTO, SIGNATURE] }), /belum tercatat berhasil/);

    // Satu rit berjalan per truk: rit yang ditolak di atas masih Tiba → truk lain.
    const w2 = await driverWorld(t.db);
    const short = await prepaidTrip(w2, { amount: PRICE - 20_000 });
    await departArrive(w2, short.id);
    expectApplied(await w2.send(w2.sopir, "m3.trip.complete", completePayload(short.id, { payment: { method: "prepaid" } }), { attach: [PHOTO, SIGNATURE] }));
    const [pay] = await t.db.select().from(tripPayments).where(eq(tripPayments.tripId, short.id));
    expect(pay).toMatchObject({ method: "digital", receivedAmount: PRICE - 20_000, underpaymentAmount: 20_000 });
    const [inv] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, short.id), eq(invoices.kind, "underpayment")));
    expect(inv!.amount).toBe(20_000);
  });

  it("B-65 US-M3-04 KP-1 perangkat: status prabayar dari cara bayar digital atau pull P2; optimistis mencatat pembayaran digital tanpa kurang bayar", () => {
    const trip = { id: "t1", number: "P-26-000001/1", customerId: "c1", customerName: "Pelanggan", price: 250_000, paymentMethod: "cash", isInternal: false, creditRequest: null } as unknown as M3TripRef;
    expect(prepaidInfo(trip, null)).toBeNull();
    expect(prepaidInfo({ ...trip, paymentMethod: "digital" }, null)).toEqual({ paidAmount: null, paidAt: null });
    expect(prepaidInfo(trip, { date: "2026-09-29", trips: [{ tripId: "t1", orderId: "o1", paidAmount: 250_000, paidAt: "2026-09-29T01:00:00.000Z", reference: "X" }] })).toEqual({ paidAmount: 250_000, paidAt: "2026-09-29T01:00:00.000Z" });
    expect(prepaidInfo({ ...trip, isInternal: true, paymentMethod: "digital" }, null)).toBeNull();
    const pay = paymentFromComplete({ ...trip, paymentMethod: "digital" }, { tripId: "t1", recipientName: "X", deliveredVolumeL: 5000, location: null, payment: { method: "prepaid" } }, "2026-09-29T02:00:00.000Z");
    expect(pay).toMatchObject({ method: "digital", receivedAmount: 250_000, underpaymentAmount: 0 });
  });
});
