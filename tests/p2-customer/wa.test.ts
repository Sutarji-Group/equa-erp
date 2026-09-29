import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { customerAccounts, trips, waMessageCosts, waMessageLogs } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { addDays } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import * as m2 from "@/server/modules/m2-orders";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { at, dispatcher, emitEvent, enableApp, fakeCloudProvider, finance, linkedCustomer, owner, T0, TODAY, truckWithDriver, zonedCustomer, uniquePhone } from "./helpers";

function statusBody(statuses: object[]) {
  return { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses } }] }] };
}

describe("P2 Kanal WhatsApp Business API (US-P2-08)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await enableApp();
  });
  afterEach(() => p2.setCustomerWaProviderForTests(null));

  it("US-P2-08 KP-1 penyedia 'cloud_api' mengirim TEMPLATE resmi Meta (bahasa id, parameter body); gagal → tautan cadangan (NFR-20)", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const okFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.OK1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = p2.cloudTemplateProvider({ token: "tok", phoneNumberId: "12345", fetchImpl: okFetch });
    const res = await provider.send({ to: "0812-3456-7890", text: "cadangan", kind: "order_confirmation", templateName: "equa_konfirmasi_pesanan", variables: { nomor_pesanan: "P-26-000001", jadwal: "Selasa pagi" } });
    expect(res).toEqual({ mode: "cloud_api", status: "sent", providerMessageId: "wamid.OK1" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v21.0/12345/messages");
    expect(calls[0]!.body).toMatchObject({ messaging_product: "whatsapp", to: "6281234567890", type: "template", template: { name: "equa_konfirmasi_pesanan", language: { code: "id" } } });
    expect(JSON.stringify(calls[0]!.body)).toContain("P-26-000001");
    const failFetch = (async () => new Response(JSON.stringify({ error: { message: "Template tidak disetujui" } }), { status: 400 })) as unknown as typeof fetch;
    const failed = await p2.cloudTemplateProvider({ token: "tok", phoneNumberId: "12345", fetchImpl: failFetch }).send({ to: "081234567890", text: "halo", kind: "order_status" });
    expect(failed).toMatchObject({ mode: "cloud_api", status: "failed", error: "Template tidak disetujui" });
    if (failed.mode === "cloud_api" && failed.status === "failed") expect(failed.fallbackLink).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=halo/);
  });

  it("US-P2-08 KP-1 alur Tahap 1 (konfirmasi pesanan US-M2-07) otomatis bila penyedia aktif tanpa mengubah alur; status terkirim/terbaca dari webhook tercatat", async () => {
    const c = await zonedCustomer(t.db, { phone: uniquePhone() });
    const created = await m2.createOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, requestedDate: addDays(TODAY, 1) });
    if (created.status !== "created") throw new Error(created.status);
    const wa = fakeCloudProvider();
    const sent = await m2.sendOrderConfirmation(dispatcher(), created.order.id, { provider: wa.provider });
    expect(sent.mode).toBe("sent");
    const [log] = await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.id, sent.logId));
    expect(log).toMatchObject({ provider: "cloud_api", status: "sent" });

    const pid = log!.providerMessageId!;
    const ts = Math.floor(at(1).getTime() / 1000);
    const r1 = await p2.handleWaStatusWebhook(statusBody([{ id: pid, status: "delivered", timestamp: String(ts) }]), { now: at(1) });
    expect(r1).toMatchObject({ statuses: 1, updated: 1, unknown: 0 });
    await p2.handleWaStatusWebhook(statusBody([{ id: pid, status: "read", timestamp: String(ts + 60) }]), { now: at(1.1) });
    // Status terlambat "delivered" tidak memundurkan "read".
    await p2.handleWaStatusWebhook(statusBody([{ id: pid, status: "delivered", timestamp: String(ts + 30) }]), { now: at(1.2) });
    const [after] = await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.id, sent.logId));
    expect(after).toMatchObject({ status: "read" });
    expect(after!.deliveredAt).not.toBeNull();
    expect(after!.readAt!.getTime()).toBe((ts + 60) * 1000);
    // Pesan tak dikenal diabaikan dengan aman.
    expect((await p2.handleWaStatusWebhook(statusBody([{ id: "wamid.none", status: "read" }]))).unknown).toBe(1);
  });

  it("US-P2-08 KP-1 webhook: verifikasi langganan (hub.challenge) & tanda tangan X-Hub-Signature-256 (rahasia aplikasi)", () => {
    const env = { WA_WEBHOOK_VERIFY_TOKEN: "rahasia-verifikasi", WA_APP_SECRET: "app-secret" };
    expect(p2.verifyWaWebhookChallenge({ mode: "subscribe", token: "rahasia-verifikasi", challenge: "1158201444" }, env)).toBe("1158201444");
    expect(p2.verifyWaWebhookChallenge({ mode: "subscribe", token: "salah", challenge: "1" }, env)).toBeNull();
    expect(p2.verifyWaWebhookChallenge({ mode: "subscribe", token: "x", challenge: "1" }, {})).toBeNull();
    const raw = JSON.stringify(statusBody([{ id: "wamid.X", status: "sent" }]));
    expect(p2.verifyWaSignature(raw, p2.signWaWebhook(raw, "app-secret"), env)).toBe(true);
    expect(p2.verifyWaSignature(raw, p2.signWaWebhook(raw, "lain"), env)).toBe(false);
    expect(p2.verifyWaSignature(raw, null, env)).toBe(false);
  });

  it("US-P2-08 KP-2 pelanggan yang TIDAK memakai aplikasi tetap menerima pesan WA yang sama (struk & status)", async () => {
    const phone = uniquePhone();
    const c = await zonedCustomer(t.db, { phone });
    const created = await m2.createOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, requestedDate: addDays(TODAY, 2) });
    if (created.status !== "created") throw new Error(created.status);
    const [trip] = await t.db.select().from(trips).where(eq(trips.orderId, created.order.id));
    const truck = await truckWithDriver(t.db);
    await t.db.update(trips).set({ truckId: truck.id, status: "completed", completedAt: at(3), deliveredVolumeL: 5000 }).where(eq(trips.id, trip!.id));
    expect(await t.db.select().from(customerAccounts).where(eq(customerAccounts.customerId, c.id))).toHaveLength(0);
    const wa = fakeCloudProvider();
    p2.setCustomerWaProviderForTests(wa.provider);
    await emitEvent("trip.departed", { tripId: trip!.id, orderId: created.order.id, truckId: truck.id, driverUserId: null, departedAt: at(2).toISOString() }, { now: at(2) });
    await emitEvent(
      "trip.completed",
      { tripId: trip!.id, orderId: created.order.id, customerId: c.id, truckId: truck.id, driverUserId: null, isInternal: false, volumeL: 5000, price: created.order.pricePerTrip, paymentMethod: "cash", cashReceived: created.order.pricePerTrip, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0, completedAt: at(3).toISOString(), recordedByOffice: false, lateSync: false },
      { now: at(3) },
    );
    expect(wa.sent.map((s) => [s.to, s.kind])).toEqual([
      [phone, "order_status"],
      [phone, "trip_receipt"],
    ]);
    expect(wa.sent[1]!.text).toMatch(/Struk EQUA .*5\.000 L/);
    // Rit internal (pasokan depot) tidak dikirimi pesan pelanggan.
    wa.sent.length = 0;
    await emitEvent(
      "trip.completed",
      { tripId: trip!.id, orderId: created.order.id, customerId: c.id, truckId: truck.id, driverUserId: null, isInternal: true, volumeL: 5000, price: 0, paymentMethod: "internal", cashReceived: 0, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0, completedAt: at(3).toISOString(), recordedByOffice: false, lateSync: false },
      { now: at(3.1) },
    );
    expect(wa.sent).toHaveLength(0);
  });

  it("US-P2-08 KP-3 biaya per pesan tertagih dicatat (tarif p2.wa_pricing per kategori, NFR-29) dan tampil di laporan biaya bulanan", async () => {
    const a = await linkedCustomer(t.db);
    const wa = fakeCloudProvider();
    p2.setCustomerWaProviderForTests(wa.provider);
    await withTx((tx) =>
      p2.notifyCustomer(tx, { tenantId: EQUA_TENANT_ID, customerId: a.customer.id, kind: "customer_notice", title: "Uji", body: "Uji biaya", dedupeKey: `uji-biaya:${a.customer.id}`, now: T0, wa: { kind: "order_status", text: "Uji biaya WA" } }),
    );
    const [log] = await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.customerId, a.customer.id));
    const pid = log!.providerMessageId!;
    const body = statusBody([
      { id: pid, status: "sent", timestamp: String(Math.floor(T0.getTime() / 1000)), pricing: { billable: true, category: "utility", pricing_model: "CBP" } },
      { id: "wamid.free", status: "delivered", pricing: { billable: false, category: "service" } },
    ]);
    const r = await p2.handleWaStatusWebhook(body, { now: T0 });
    expect(r.costsRecorded).toBe(1);
    // Webhook berulang tidak menggandakan biaya.
    expect((await p2.handleWaStatusWebhook(body, { now: T0 })).costsRecorded).toBe(0);
    const [cost] = await t.db.select().from(waMessageCosts).where(eq(waMessageCosts.providerMessageId, pid));
    expect(cost).toMatchObject({ category: "utility", costAmount: 320, month: "2026-10", waMessageLogId: log!.id });
    const sum = await p2.waCostSummary(owner(), { month: "2026-10" });
    expect(sum.byCategory.find((c) => c.category === "utility")).toMatchObject({ count: 1, amount: 320 });
    expect(sum.totalCost).toBe(320);
    expect((await p2.waCostSummary(finance(), { month: "2026-10" })).totalCost).toBe(320);
    await expect(p2.waCostSummary(dispatcher(), { month: "2026-10" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-P2-08 tanpa token Cloud API → mode tautan tetap berfungsi: tidak ada kiriman otomatis/klaim terkirim, OTP 'mode uji' di dev", async () => {
    expect(p2.customerWaProvider().kind).toBe("link");
    expect(p2.isAutoWaActive()).toBe(false);
    const a = await linkedCustomer(t.db);
    const res = await withTx((tx) =>
      p2.notifyCustomer(tx, { tenantId: EQUA_TENANT_ID, customerId: a.customer.id, kind: "customer_notice", title: "Uji tautan", dedupeKey: `uji-tautan:${a.customer.id}`, now: T0, wa: { kind: "order_status", text: "Tidak dikirim otomatis" }, waEvenWithoutApp: true }),
    );
    expect(res).toMatchObject({ inApp: 1, wa: null });
    const otp = await p2.requestLoginOtp({ phone: uniquePhone() }, { now: T0 });
    expect(otp.channel).toBe("dev");
  });
});
