/**
 * B-81 / D-12 butir 1 — uang muka rit prabayar ditandai pesanan (P2 → M3 → M5 → M11):
 * - pembayaran P2 yang menarget pesanan → uang muka `customer_advances.order_id` = pesanan itu;
 * - faktur lain pelanggan (mis. kurang bayar rit lain) TIDAK memakai uang muka bertanda itu;
 * - faktur rit pesanan itu memakai uang muka bertandanya lebih dulu → Lunas; jurnal 2-1201 terpakai habis;
 * - pesanan dibatalkan → tanda dilepas (uang muka umum) dan tercatat di jejak audit.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accounts, auditLogs, customerAdvances, customerPayments, invoices, journalLines, journals, trips } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { emitEvent, setPeriod, tripPayload } from "../m11-accounting/helpers";
import { enableApp, linkedCustomer, minutes, TODAY } from "../p2-customer/helpers";

describe("B-81 D-12 butir 1 uang muka rit prabayar bertanda pesanan (P2 → M3 → M5 → M11)", () => {
  const t = useTestDb({ seed: true });

  beforeAll(async () => {
    bootstrapForTests();
    await enableApp();
    await setPeriod(t.db, TODAY.slice(0, 7), "open");
    p2.setPaymentGatewayForTests(p2.mockGateway());
  });
  afterAll(() => p2.setPaymentGatewayForTests(undefined));

  async function prepaidOrder(a: Awaited<ReturnType<typeof linkedCustomer>>) {
    const [addr] = await p2.listMyAddresses(a.cctx);
    const placed = await p2.placeOrder(a.cctx, { addressId: addr!.id, tankCount: 1, date: TODAY, slot: "afternoon", paymentMethod: "digital" });
    const intent = await p2.createPaymentIntent(a.cctx, { target: "order", orderId: placed.orderId, method: "virtual_account" });
    await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(15) });
    const [pay] = await t.db.select().from(customerPayments).where(eq(customerPayments.paymentIntentId, intent.id));
    const [adv] = await t.db.select().from(customerAdvances).where(eq(customerAdvances.sourcePaymentId, pay!.id));
    return { placed, adv: adv! };
  }

  it("B-81 US-P2-04 KP-4 faktur lain pelanggan tidak memakai uang muka pesanan prabayar; faktur rit pesanan itu memakai uang muka bertandanya (Lunas) — jurnal uang muka terpakai sekali", async () => {
    const a = await linkedCustomer(t.db);
    const { placed, adv } = await prepaidOrder(a);
    expect(adv).toMatchObject({ orderId: placed.orderId, remainingAmount: placed.total, status: "open" });

    // Rit lain pelanggan yang sama kurang bayar → faktur kurang bayar terbit; uang muka bertanda TIDAK dipakai.
    const [addr] = await p2.listMyAddresses(a.cctx);
    const other = await p2.placeOrder(a.cctx, { addressId: addr!.id, tankCount: 1, date: TODAY, slot: "afternoon", paymentMethod: "cash" });
    const [otherTrip] = await t.db.select().from(trips).where(eq(trips.orderId, other.orderId));
    await t.db.update(trips).set({ status: "completed", deliveredVolumeL: otherTrip!.plannedVolumeL, completionBusinessDate: TODAY }).where(eq(trips.id, otherTrip!.id));
    await emitEvent(
      "trip.completed",
      tripPayload({ tripId: otherTrip!.id, orderId: other.orderId, customerId: a.customer.id, price: otherTrip!.price, paymentMethod: "cash", cashReceived: otherTrip!.price - 100_000, underpaymentAmount: 100_000, businessDate: TODAY, tripNumber: otherTrip!.number }),
    );
    const [under] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, otherTrip!.id), eq(invoices.kind, "underpayment")));
    expect(under).toMatchObject({ amount: 100_000, outstandingAmount: 100_000, status: "open" });
    expect((await t.db.select().from(customerAdvances).where(eq(customerAdvances.id, adv.id)))[0]).toMatchObject({ remainingAmount: placed.total, status: "open" });

    // Rit prabayar Selesai → faktur rit memakai uang muka bertandanya → Lunas.
    const [trip] = await t.db.select().from(trips).where(eq(trips.orderId, placed.orderId));
    await t.db.update(trips).set({ status: "completed", deliveredVolumeL: trip!.plannedVolumeL, completionBusinessDate: TODAY }).where(eq(trips.id, trip!.id));
    await emitEvent(
      "trip.completed",
      tripPayload({ tripId: trip!.id, orderId: placed.orderId, customerId: a.customer.id, price: trip!.price, paymentMethod: "digital", cashReceived: 0, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0, businessDate: TODAY, tripNumber: trip!.number }),
    );
    const [inv] = await t.db.select().from(invoices).where(and(eq(invoices.tripId, trip!.id), eq(invoices.kind, "delivery")));
    expect(inv).toMatchObject({ outstandingAmount: 0, status: "paid" });
    expect((await t.db.select().from(customerAdvances).where(eq(customerAdvances.id, adv.id)))[0]).toMatchObject({ remainingAmount: 0, status: "applied" });
    // M11: uang muka 2-1201 dari pesanan itu terpakai tepat sekali (Dr) oleh faktur rit pesanan itu.
    const rows = await t.db
      .select({ code: accounts.code, debit: journalLines.debit, sourceType: journals.sourceObjectType, sourceId: journals.sourceObjectId })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(and(eq(journals.tenantId, EQUA_TENANT_ID), eq(accounts.code, "2-1201")));
    const usedOnTrip = rows.filter((r) => r.sourceId === inv!.id || r.sourceId === adv.id).reduce((s, r) => s + Number(r.debit ?? 0), 0);
    expect(usedOnTrip).toBe(trip!.price);
    const usedOnUnder = rows.filter((r) => r.sourceId === under!.id).reduce((s, r) => s + Number(r.debit ?? 0), 0);
    expect(usedOnUnder).toBe(0);
  });

  it("B-81 D-12 butir 1 pesanan prabayar dibatalkan → tanda pesanan pada uang muka dilepas (uang muka umum) dan tercatat di jejak audit", async () => {
    const a = await linkedCustomer(t.db);
    const { placed, adv } = await prepaidOrder(a);
    await p2.cancelMyOrder(a.cctx, placed.orderId, { reason: "Tidak jadi pesan" });
    const after = (await t.db.select().from(customerAdvances).where(eq(customerAdvances.id, adv.id)))[0]!;
    expect(after).toMatchObject({ orderId: null, remainingAmount: placed.total, status: "open" });
    const [audit] = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "customer_advance"), eq(auditLogs.objectId, adv.id), eq(auditLogs.action, "release_order")));
    expect(audit!.before).toMatchObject({ orderId: placed.orderId });
    expect(audit!.reason).toMatch(/dibatalkan/);
  });
});
