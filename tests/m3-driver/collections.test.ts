import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customerPayments, domainEvents, invoices, paymentAllocations, waMessageLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";

import { allocateOldestFirst, sortInvoicesForCollection } from "@/client/m3-driver/contract";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { departArrive, driverWorld, expectApplied, expectRejected, makeCustomer, completeCash, type World } from "./helpers";

let invSeq = 0;
async function invoice(w: World, o: { kind?: "underpayment" | "delivery" | "monthly"; amount: number; daysAgo: number; customerId?: string }) {
  invSeq++;
  const id = newId();
  await w.db.insert(invoices).values({
    id,
    tenantId: w.truck.tenantId,
    number: `F-UJI-${Date.now().toString(36)}-${invSeq}`,
    kind: o.kind ?? "delivery",
    customerId: o.customerId ?? w.customer.id,
    issueDate: addDays(w.date, -o.daysAgo),
    dueDate: addDays(w.date, -o.daysAgo + 14),
    amount: o.amount,
    outstandingAmount: o.amount,
  });
  return id;
}

describe("M3 — pelunasan piutang saat pengiriman (US-M3-05)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M3-05 KP-1 faktur terbuka pelanggan rit hari itu tampil (nomor, tanggal, sisa) dari data sinkron terakhir + waktunya; kurang bayar paling atas bertanda \"tagih kurang bayar\"", async () => {
    const w = await driverWorld(t.db);
    await w.addTrip();
    const old = await invoice(w, { amount: 300_000, daysAgo: 20 });
    const under = await invoice(w, { kind: "underpayment", amount: 50_000, daysAgo: 2 });
    const other = await makeCustomer(t.db);
    await invoice(w, { amount: 99_000, daysAgo: 5, customerId: other.id });
    const today = await w.today();
    const list = today.invoicesByCustomer[w.customer.id]!;
    expect(list.map((i) => i.id)).toEqual([under, old]);
    expect(list[0]).toMatchObject({ isUnderpayment: true, outstanding: 50_000 });
    expect(today.invoicesByCustomer[other.id]).toBeUndefined();
    expect(Date.parse(today.generatedAt)).toBeGreaterThan(0);
    expect(sortInvoicesForCollection(list)[0]!.isUnderpayment).toBe(true);
  });

  it("US-M3-05 KP-2 faktur terpilih (bawaan tertua), sebagian boleh, alokasi dari yang tertua; tunai atau transfer (foto bukti)", async () => {
    const w = await driverWorld(t.db);
    const trip = await w.addTrip();
    const a = await invoice(w, { amount: 100_000, daysAgo: 30 });
    const b = await invoice(w, { amount: 200_000, daysAgo: 10 });
    expect(allocateOldestFirst([{ id: b, issueDate: "2026-09-18", number: "B", outstanding: 200_000 }, { id: a, issueDate: "2026-08-29", number: "A", outstanding: 100_000 }], 150_000)).toEqual({
      allocations: [
        { invoiceId: a, amount: 100_000 },
        { invoiceId: b, amount: 50_000 },
      ],
      excess: 0,
    });
    const paymentId = newId();
    const res = await w.send(w.sopir, "m3.collection.create", { paymentId, customerId: w.customer.id, tripId: trip.id, method: "cash", amount: 150_000, invoiceIds: [a, b] });
    expectApplied(res);
    const allocs = await t.db.select().from(paymentAllocations).where(eq(paymentAllocations.customerPaymentId, paymentId));
    expect(allocs.map((x) => [x.invoiceId, x.amount]).sort()).toEqual([[a, 100_000], [b, 50_000]].sort());
    // Sisa efektif langsung berkurang di data perangkat.
    const today = await w.today();
    expect(today.invoicesByCustomer[w.customer.id]!.map((i) => [i.id, i.outstanding])).toEqual([[b, 150_000]]);
    // Transfer wajib foto bukti.
    expectRejected(await w.send(w.sopir, "m3.collection.create", { paymentId: newId(), customerId: w.customer.id, tripId: trip.id, method: "transfer", amount: 50_000, invoiceIds: [b] }), /bukti transfer wajib/);
    expectApplied(
      await w.send(w.sopir, "m3.collection.create", { paymentId: newId(), customerId: w.customer.id, tripId: trip.id, method: "transfer", amount: 50_000, invoiceIds: [b] }, { attach: [{ kind: "collection_transfer_proof" }] }),
    );
  });

  it("US-M3-05 KP-3 pelunasan tunai menambah kas di tangan & masuk setoran hari itu; tercatat di M5 tanpa input ulang (customer_payments + event collection.recorded)", async () => {
    const w = await driverWorld(t.db);
    const trip = await w.addTrip();
    const inv = await invoice(w, { amount: 80_000, daysAgo: 3 });
    const paymentId = newId();
    expectApplied(await w.send(w.sopir, "m3.collection.create", { paymentId, customerId: w.customer.id, tripId: trip.id, method: "cash", amount: 80_000, invoiceIds: [inv] }));
    const [p] = await t.db.select().from(customerPayments).where(eq(customerPayments.id, paymentId));
    expect(p).toMatchObject({ channel: "driver", method: "cash", amount: 80_000, driverUserId: w.driver.userId, tripId: trip.id });
    expect(p!.depositId).toBeTruthy();
    const ev = (await t.db.select().from(domainEvents).where(and(eq(domainEvents.objectId, paymentId), eq(domainEvents.type, "collection.recorded"))))[0]!;
    expect(ev.payload).toMatchObject({ channel: "driver", method: "cash", amount: 80_000, allocations: [{ invoiceId: inv, amount: 80_000 }], advanceAmount: 0, profitCenter: "L2", depositId: p!.depositId });
    const today = await w.today();
    const { computeDayFigures } = await import("@/client/m3-driver/contract");
    expect(computeDayFigures({ trips: today.trips, payments: today.payments, collections: today.collections, expenses: today.expenses })).toMatchObject({ collectionsCash: 80_000, cashOnHand: 80_000 });
    // Idempoten: kirim ulang ID pelunasan yang sama (perintah baru) tidak menggandakan.
    const again = await w.send(w.sopir, "m3.collection.create", { paymentId, customerId: w.customer.id, tripId: trip.id, method: "cash", amount: 80_000, invoiceIds: [inv] });
    expectApplied(again);
    expect(again.result).toMatchObject({ duplicate: true });
    expect(await t.db.select().from(paymentAllocations).where(eq(paymentAllocations.customerPaymentId, paymentId))).toHaveLength(1);
  });

  it("US-M3-05 KP-4 pelunasan hanya untuk pelanggan pada rit hari itu", async () => {
    const w = await driverWorld(t.db);
    const trip = await w.addTrip();
    const other = await makeCustomer(t.db);
    const inv = await invoice(w, { amount: 50_000, daysAgo: 3, customerId: other.id });
    expectRejected(await w.send(w.sopir, "m3.collection.create", { paymentId: newId(), customerId: other.id, tripId: trip.id, method: "cash", amount: 50_000, invoiceIds: [inv] }), /pelanggan rit ini/);
  });

  it("US-M3-05 KP-2 sisa berubah di kantor saat ponsel luring → kelebihan menjadi uang muka (konflik ditinjau), bukan ditolak", async () => {
    const w = await driverWorld(t.db);
    const trip = await w.addTrip();
    const inv = await invoice(w, { amount: 60_000, daysAgo: 4 });
    // Kantor sudah menerima sebagian (M5) sebelum data sopir tiba.
    await t.db.update(invoices).set({ paidAmount: 40_000, outstandingAmount: 20_000 }).where(eq(invoices.id, inv));
    const res = await w.send(w.sopir, "m3.collection.create", { paymentId: newId(), customerId: w.customer.id, tripId: trip.id, method: "cash", amount: 60_000, invoiceIds: [inv] });
    expect(res.status).toBe("conflict");
    expect(res.result).toMatchObject({ advanceAmount: 40_000 });
  });

  it("US-M3-05 KP-5 bukti pelunasan digital via WA (template bukti pelunasan, dicatat dibuka)", async () => {
    const w = await driverWorld(t.db);
    const trip = await w.addTrip();
    await departArrive(w, trip.id);
    expectApplied(await completeCash(w, trip.id));
    const inv = await invoice(w, { amount: 30_000, daysAgo: 1 });
    const paymentId = newId();
    expectApplied(await w.send(w.sopir, "m3.collection.create", { paymentId, customerId: w.customer.id, tripId: trip.id, method: "cash", amount: 30_000, invoiceIds: [inv] }));
    const today = await w.today();
    expect(today.receiptTemplates.payment_receipt).toContain("{{jumlah}}");
    expectApplied(await w.send(w.sopir, "m3.receipt.record", { kind: "payment_receipt", customerPaymentId: paymentId, action: "opened", renderedText: "Bukti pelunasan" }));
    const logs = await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.objectId, paymentId));
    expect(logs[0]).toMatchObject({ kind: "payment_receipt", objectType: "customer_payment" });
  });
});
