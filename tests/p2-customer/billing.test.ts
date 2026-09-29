import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { customerAppOrders, customerDownloadLogs, customerPayments, customers, domainEvents, incomingTransfers, invoices, orders, paymentIntents, trips } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { addDays } from "@/lib/time";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { ForbiddenError, NotFoundError } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { testContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createOrder } from "../helpers/fixtures";
import { at, dispatcher, emitEvent, enableApp, finance, linkedCustomer, minutes, owner, refresh, setTrip, T0, TODAY, truckWithDriver } from "./helpers";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

let invSeq = 0;
async function openInvoice(db: Parameters<typeof linkedCustomer>[0], customerId: string, amount: number, opts: { dueDate?: string; kind?: "delivery" | "monthly"; periodMonth?: string | null } = {}) {
  invSeq++;
  const [row] = await db
    .insert(invoices)
    .values({
      tenantId: EQUA_TENANT_ID,
      number: `F-26-8${String(invSeq).padStart(5, "0")}`,
      kind: opts.kind ?? "delivery",
      customerId,
      issueDate: addDays(TODAY, -20),
      dueDate: opts.dueDate ?? addDays(TODAY, 5),
      amount,
      outstandingAmount: amount,
      status: "open",
      periodMonth: opts.periodMonth ?? null,
    })
    .returning();
  return row!;
}

describe("P2 Riwayat, struk, tagihan & pembayaran digital (US-P2-04)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await enableApp();
    p2.setPaymentGatewayForTests(p2.mockGateway());
  });
  afterAll(() => p2.setPaymentGatewayForTests(undefined));

  it("US-P2-04 KP-1 riwayat pesanan 24 bulan (semua asal) dengan status akhir", async () => {
    const a = await linkedCustomer(t.db);
    const [addr] = await p2.listMyAddresses(a.cctx);
    const recent = await createOrder(t.db, { customerId: a.customer.id, addressId: addr!.id, date: addDays(TODAY, -600) });
    const old = await createOrder(t.db, { customerId: a.customer.id, addressId: addr!.id, date: addDays(TODAY, -800) });
    await t.db.update(orders).set({ status: "completed" }).where(eq(orders.id, recent.id));
    const rows = await p2.listMyOrders(a.cctx);
    expect(rows.find((r) => r.id === recent.id)).toMatchObject({ statusLabel: "Selesai", fromApp: false });
    expect(rows.some((r) => r.id === old.id)).toBe(false);
    expect((await p2.listMyOrders(a.cctx, { status: "done" })).some((r) => r.id === recent.id)).toBe(true);
  });

  it("US-P2-04 KP-1 struk digital per pengiriman (nomor, tanggal, volume, harga, cara bayar, penerima) + foto bukti kirim milik sendiri", async () => {
    const a = await linkedCustomer(t.db);
    const [addr] = await p2.listMyAddresses(a.cctx);
    const placed = await p2.placeOrder(a.cctx, { addressId: addr!.id, tankCount: 1, date: addDays(TODAY, 1), slot: "morning", paymentMethod: "cash" });
    const [trip] = await t.db.select().from(trips).where(eq(trips.orderId, placed.orderId));
    await expect(p2.myReceipt(a.cctx, trip!.id)).rejects.toThrow(/setelah air diterima/);
    const truck = await truckWithDriver(t.db);
    await setTrip(t.db, trip!.id, { truckId: truck.id, status: "completed", completedAt: at(2), deliveredVolumeL: 4800, recipientName: "Pak Dedi", partialVolumeReason: "customer_tank_full" });
    const photo = await withTx((tx) => put(tx, systemContext({ now: T0 }), { blob: JPEG, contentType: "image/jpeg", kind: "delivery_photo", objectRef: { type: "trip", id: trip!.id } }));
    const r = await p2.myReceipt(a.cctx, trip!.id);
    expect(r).toMatchObject({ number: trip!.number, orderNumber: placed.number, deliveredVolumeL: 4800, price: placed.pricePerTank, paymentLabel: "Tunai", recipientName: "Pak Dedi", partialReason: "Tangki pelanggan penuh" });
    expect(r.photos).toEqual([{ id: photo.id, kind: "delivery_photo", url: `/api/customer/lampiran/${photo.id}` }]);
    const file = await p2.readMyAttachment(a.cctx, photo.id);
    expect(file.contentType).toBe("image/jpeg");
    // Pelanggan lain tidak dapat membuka foto/struk ini.
    const b = await linkedCustomer(t.db);
    await expect(p2.readMyAttachment(b.cctx, photo.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(p2.myReceipt(b.cctx, trip!.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("US-P2-04 KP-2 tagihan: faktur terbuka (jatuh tempo & sisa), kartu piutang, faktur bulanan; pelanggan Ditahan melihat keterangan & cara melunasi", async () => {
    const a = await linkedCustomer(t.db, { creditStatus: "credit", creditLimit: 5_000_000 });
    const overdue = await openInvoice(t.db, a.customer.id, 400_000, { dueDate: addDays(TODAY, -10) });
    await openInvoice(t.db, a.customer.id, 900_000, { kind: "monthly", periodMonth: "2026-09-01" });
    await t.db.update(customers).set({ creditStatus: "on_hold" }).where(eq(customers.id, a.customer.id));
    const b = await p2.myBilling(await refresh(a.token));
    expect(b.openInvoices.map((i) => i.number)).toContain(overdue.number);
    expect(b.openInvoices.find((i) => i.id === overdue.id)).toMatchObject({ outstanding: 400_000, overdueDays: 10 });
    expect(b.totalOutstanding).toBe(1_300_000);
    expect(b.monthlyInvoices).toHaveLength(1);
    expect(b.onHold).toBe(true);
    expect(b.holdMessage).toMatch(/Ditahan.*lewat jatuh tempo.*Lunasi/);
    expect(b.statement.entries).toBeDefined();
  });

  it("US-P2-04 KP-5 unduhan faktur PDF (termasuk faktur bulanan) & riwayat PDF tercatat; faktur pelanggan lain tidak dapat diunduh", async () => {
    const a = await linkedCustomer(t.db);
    const inv = await openInvoice(t.db, a.customer.id, 250_000, { kind: "monthly", periodMonth: "2026-09-01" });
    const pdf = await p2.myInvoicePdf(a.cctx, inv.id);
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    const hist = await p2.myHistoryPdf(a.cctx);
    expect(hist.filename).toMatch(/riwayat-pesanan/);
    const logs = await t.db.select().from(customerDownloadLogs).where(eq(customerDownloadLogs.customerAccountId, a.cctx.accountId));
    expect(logs.map((l) => l.kind).sort()).toEqual(["history_pdf", "invoice_pdf"]);
    const b = await linkedCustomer(t.db);
    await expect(p2.myInvoicePdf(b.cctx, inv.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("US-P2-04 KP-3 pembayaran digital: verifikasi ulang OTP (8.6) → QRIS dinamis/VA per tagihan lewat gerbang; Berhasil otomatis → pelunasan M5 + transfer masuk 'pembayaran digital' M4 + biaya gerbang", async () => {
    const a = await linkedCustomer(t.db, { creditStatus: "credit", creditLimit: 5_000_000 });
    const inv = await openInvoice(t.db, a.customer.id, 600_000);
    const later = { ...(await refresh(a.token, minutes(30))) };
    await expect(p2.createPaymentIntent(later, { target: "invoice", invoiceId: inv.id, method: "qris_dynamic" })).rejects.toThrow(/kode verifikasi/);
    const otp = await p2.requestPaymentOtp(later);
    await p2.verifyPaymentOtp(later, { code: otp.devCode! });
    const verified = await refresh(a.token, minutes(31));
    const intent = await p2.createPaymentIntent(verified, { target: "invoice", invoiceId: inv.id, method: "qris_dynamic" });
    expect(intent).toMatchObject({ status: "pending", amount: 600_000, gateway: "mock", method: "qris_dynamic" });
    expect(intent.qrString).toMatch(/MOCKQRIS/);
    // Kode yang masih berlaku dipakai ulang.
    expect((await p2.createPaymentIntent(verified, { target: "invoice", invoiceId: inv.id, method: "qris_dynamic" })).id).toBe(intent.id);
    const va = await p2.createPaymentIntent(verified, { target: "all_invoices", method: "virtual_account" });
    expect(va.vaNumber).toMatch(/^8808\d{10}$/);

    // Tanda tangan palsu ditolak; tidak ada pelunasan.
    expect(await p2.handleGatewayNotification({ order_id: intent.gatewayOrderId, transaction_status: "settlement", gross_amount: "600000", signature: "palsu" })).toEqual({ result: "invalid" });
    const res = await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(35) });
    expect(res).toMatchObject({ result: "applied", status: "succeeded" });
    const again = await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(36) });
    expect(again.result).toBe("duplicate");

    const [paid] = await t.db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(paid).toMatchObject({ outstandingAmount: 0, status: "paid" });
    const pays = await t.db.select().from(customerPayments).where(eq(customerPayments.customerId, a.customer.id));
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ channel: "digital", method: "digital", amount: 600_000 });
    const [pi] = await t.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
    expect(pi).toMatchObject({ status: "succeeded", gatewayFee: 4_200, customerPaymentId: pays[0]!.id });
    const ev = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "digital_payment.succeeded"), eq(domainEvents.objectId, intent.id)));
    expect(ev).toHaveLength(1);
    const [tr] = await t.db.select().from(incomingTransfers).where(and(eq(incomingTransfers.sourceKind, "digital_payment"), eq(incomingTransfers.sourceObjectId, intent.id)));
    // B-63: transfer masuk = settlement gerbang neto (bruto 600.000 − biaya QRIS 0,7% = 4.200).
    expect(tr).toMatchObject({ amount: 595_800, status: "unmatched" });
    // M4 mencocokkan settlement bank → Dicocokkan.
    await emitEvent("transfer.matched", { incomingTransferId: tr!.id, amount: 595_800, sourceKind: "digital_payment", matchedAt: minutes(60).toISOString() }, { now: minutes(60) });
    const [matched] = await t.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
    expect(matched!.status).toBe("matched");
    // Kantor melihat daftar pembayaran digital (Admin Keuangan, pemilik).
    expect((await p2.listPaymentIntents(finance())).some((r) => r.id === intent.id)).toBe(true);
    expect((await p2.listMyNotifications(verified)).some((n) => n.kind === "payment_succeeded")).toBe(true);
  });

  it("US-P2-04 KP-3 kode bayar kedaluwarsa / gagal dari gerbang tidak mencatat pelunasan", async () => {
    const a = await linkedCustomer(t.db);
    const inv = await openInvoice(t.db, a.customer.id, 150_000);
    const intent = await p2.createPaymentIntent(a.cctx, { target: "invoice", invoiceId: inv.id, method: "virtual_account" });
    expect(await withTx((tx) => p2.expirePendingIntents(tx, at(3)))).toBeGreaterThanOrEqual(1);
    const [pi] = await t.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
    expect(pi!.status).toBe("expired");
    const intent2 = await p2.createPaymentIntent(a.cctx, { target: "invoice", invoiceId: inv.id, method: "qris_dynamic" });
    await p2.simulateMockPayment(intent2.id, "deny");
    const [pi2] = await t.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent2.id));
    expect(pi2!.status).toBe("failed");
    const [still] = await t.db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(still!.outstandingAmount).toBe(150_000);
  });

  it("US-P2-04 KP-4 bayar di muka untuk pesanan → 'lunas di muka'; sopir melihat 'sudah dibayar' (pull p2.prepaid_trips)", async () => {
    const a = await linkedCustomer(t.db);
    const [addr] = await p2.listMyAddresses(a.cctx);
    const placed = await p2.placeOrder(a.cctx, { addressId: addr!.id, tankCount: 1, date: TODAY, slot: "afternoon", paymentMethod: "digital" });
    const detail = await p2.getMyOrder(a.cctx, placed.orderId);
    expect(detail.canPay).toBe(true);
    const intent = await p2.createPaymentIntent(a.cctx, { target: "order", orderId: placed.orderId, method: "qris_dynamic" });
    expect(intent.amount).toBe(placed.total);
    await p2.simulateMockPayment(intent.id, "settlement", { now: minutes(10) });
    const [o] = await t.db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(o!.paymentMethod).toBe("digital");
    const [trip] = await t.db.select().from(trips).where(eq(trips.orderId, placed.orderId));
    expect(trip!.paymentMethod).toBe("digital");
    const [app] = await t.db.select().from(customerAppOrders).where(eq(customerAppOrders.orderId, placed.orderId));
    expect(app!.prepaidAmount).toBe(placed.total);
    const after = await p2.getMyOrder(a.cctx, placed.orderId);
    expect(after).toMatchObject({ prepaid: true, canPay: false, paymentLabel: "Sudah dibayar (digital)" });
    await expect(p2.createPaymentIntent(a.cctx, { target: "order", orderId: placed.orderId, method: "qris_dynamic" })).rejects.toThrow(/sudah dibayar/);

    const truck = await truckWithDriver(t.db);
    await setTrip(t.db, trip!.id, { truckId: truck.id, scheduledDate: TODAY });
    const driverCtx = testContext({ role: "driver", now: T0, scope: { truckIds: [truck.id] } });
    const pull = await withTx((tx) => p2.prepaidTripsPull(tx, driverCtx));
    expect(pull.trips).toEqual([expect.objectContaining({ tripId: trip!.id, paidAmount: placed.total, reference: intent.gatewayOrderId })]);
    // Uang di muka tercatat sebagai uang muka pelanggan (US-M5-02 KP-3).
    const [pay] = await t.db.select().from(customerPayments).where(eq(customerPayments.paymentIntentId, intent.id));
    expect(pay!.advanceAmount).toBe(placed.total);
  });

  it("US-P2-04 kantor: daftar pembayaran digital hanya pemilik & Admin Keuangan", async () => {
    expect(Array.isArray(await p2.listPaymentIntents(owner()))).toBe(true);
    await expect(p2.listPaymentIntents(dispatcher())).rejects.toBeInstanceOf(ForbiddenError);
  });
});
