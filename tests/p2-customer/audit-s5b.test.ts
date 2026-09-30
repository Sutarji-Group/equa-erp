/**
 * Uji regresi temuan audit S5-B (Paket B, P2): gerbang flag Tahap 2 pada notifikasi otomatis & sesi, pencocokan nama
 * saat menautkan nomor daur ulang, validasi endpoint Web Push (SSRF), dan permintaan OTP tanpa enumerasi + batas laju.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { customerNotifications, customerPushSubscriptions, otpCodes, trips } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import { withTx } from "@/server/core/db";
import * as flags from "@/server/core/flags";
import * as params from "@/server/core/params";
import * as m2 from "@/server/modules/m2-orders";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { at, dispatcher, emitEvent, enableApp, fakeCloudProvider, linkedCustomer, login, minutes, owner, TODAY, truckWithDriver, uniquePhone, zonedCustomer } from "./helpers";

const setApp = (enabled: boolean) => flags.set(owner(), "phase2.customer_app", enabled, { scope: { type: "tenant", refId: EQUA_TENANT_ID }, reason: enabled ? "Uji: Tahap 2 aktif" : "Uji: Tahap 2 dimatikan kembali" });

describe("P2 — regresi temuan audit S5-B", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  afterEach(() => p2.setCustomerWaProviderForTests(null));

  it("D-02 butir 3 US-P2-08 KP-1 US-P2-03 KP-4 flag Tahap 2 mati → TIDAK ada notifikasi/WA otomatis dari handler P2 walau WA Cloud API aktif", async () => {
    expect(await withTx((tx) => p2.isAppEnabled(tx, EQUA_TENANT_ID))).toBe(false);
    const phone = uniquePhone();
    const c = await zonedCustomer(t.db, { phone });
    const created = await m2.createOrder(dispatcher(), { customerId: c.id, addressId: c.addressId!, requestedDate: addDays(TODAY, 1) });
    if (created.status !== "created") throw new Error(created.status);
    const [trip] = await t.db.select().from(trips).where(eq(trips.orderId, created.order.id));
    const truck = await truckWithDriver(t.db);
    await t.db.update(trips).set({ truckId: truck.id, status: "completed", completedAt: at(3), deliveredVolumeL: 5000 }).where(eq(trips.id, trip!.id));
    const wa = fakeCloudProvider();
    p2.setCustomerWaProviderForTests(wa.provider);
    const completed = {
      tripId: trip!.id,
      orderId: created.order.id,
      customerId: c.id,
      truckId: truck.id,
      driverUserId: null,
      isInternal: false,
      volumeL: 5000,
      price: created.order.pricePerTrip,
      paymentMethod: "cash" as const,
      cashReceived: created.order.pricePerTrip,
      transferAmount: 0,
      creditAmount: 0,
      underpaymentAmount: 0,
      completedAt: at(3).toISOString(),
      recordedByOffice: false,
      lateSync: false,
    };
    await emitEvent("trip.departed", { tripId: trip!.id, orderId: created.order.id, truckId: truck.id, driverUserId: null, departedAt: at(2).toISOString() }, { now: at(2) });
    await emitEvent("trip.completed", completed, { now: at(3) });
    expect(wa.sent).toHaveLength(0);
    expect(await t.db.select().from(customerNotifications).where(eq(customerNotifications.customerId, c.id))).toHaveLength(0);

    // Setelah pemilik mengaktifkan Tahap 2, alur otomatis berjalan (kejadian berikutnya).
    await enableApp();
    await emitEvent("trip.completed", completed, { now: at(3.5) });
    expect(wa.sent.map((s) => [s.to, s.kind])).toEqual([[phone, "trip_receipt"]]);
  });

  it("D-02 butir 3 US-P2-02 KP-5 US-P2-03 KP-2 Tahap 2 dimatikan kembali → sesi pelanggan tidak berlaku (rute/aksi → belum masuk) dan batal pesanan ditolak", async () => {
    await enableApp();
    const a = await linkedCustomer(t.db);
    expect(await withTx((tx) => p2.resolveCustomerSession(tx, a.token, minutes(1)))).not.toBeNull();
    await setApp(false);
    try {
      expect(await withTx((tx) => p2.resolveCustomerSession(tx, a.token, minutes(1)))).toBeNull();
      await expect(p2.cancelMyOrder(a.cctx, newId(), { reason: "Tidak jadi pesan" })).rejects.toThrow(/belum aktif/);
    } finally {
      await setApp(true);
    }
    expect(await withTx((tx) => p2.resolveCustomerSession(tx, a.token, minutes(1)))).not.toBeNull();
  });

  it("US-P2-01 KP-2 PRD 8.7 nomor daur ulang: satu kata/awalan pendek atau kata umum ('Hot', 'PT') TIDAK menautkan; pelanggan Tempo/harga khusus wajib semua token nama cocok", async () => {
    await enableApp();
    expect(p2.nameSimilarity("Hot", "Hotel Puncak Sejuk")).toBe(0);
    expect(p2.nameSimilarity("PT", "PT Sinar Jaya Abadi")).toBe(0);
    expect(p2.nameSimilarity("Hotel", "Hotel Puncak Sejuk")).toBe(0);
    expect(p2.nameSimilarity("Pun", "Hotel Puncak Sejuk")).toBe(0);
    expect(p2.nameSimilarity("Punc Sejuk", "Hotel Puncak Sejuk")).toBe(100);
    expect(p2.nameSimilarity("Bpk. Hotel Puncak Sejuk", "Hotel Puncak Sejuk")).toBe(100);

    const register = async (customerName: string, typed: string, opts: { creditStatus?: "cash" | "credit"; creditLimit?: number } = {}) => {
      const phone = uniquePhone();
      const c = await zonedCustomer(t.db, { name: customerName, phone, creditStatus: opts.creditStatus, creditLimit: opts.creditLimit });
      const { cctx } = await login(t.db, phone);
      return { c, res: await p2.completeRegistration(cctx, { name: typed, consent: true }) };
    };
    expect((await register("Hotel Puncak Sejuk", "Hot", { creditStatus: "credit", creditLimit: 5_000_000 })).res.status).toBe("pending_review");
    expect((await register("PT Sinar Jaya Abadi", "PT")).res.status).toBe("pending_review");
    // Tunai: ambang PAR p2 name_match_min_pct (60%) atas token bermakna nama M1.
    const cash = await register("PT Sinar Jaya Abadi", "Sinar Jaya");
    expect(cash.res).toMatchObject({ status: "linked", customerId: cash.c.id });
    // Tempo: 2 dari 3 token (67%) belum cukup → verifikasi Dispatcher; semua token → tertaut.
    expect((await register("Hotel Puncak Sejuk Indah", "Puncak Sejuk", { creditStatus: "credit", creditLimit: 5_000_000 })).res.status).toBe("pending_review");
    const full = await register("Hotel Puncak Sejuk Indah", "Puncak Sejuk Indah", { creditStatus: "credit", creditLimit: 5_000_000 });
    expect(full.res).toMatchObject({ status: "linked", customerId: full.c.id });
  });

  it("US-P2-03 KP-4 NFR keamanan (SSRF) endpoint Web Push hanya layanan push dikenal (https, tanpa IP/port); endpoint akun lain tidak dapat diambil alih", async () => {
    await enableApp();
    expect(p2.isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toBe(true);
    expect(p2.isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/xyz")).toBe(true);
    expect(p2.isAllowedPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
    expect(p2.isAllowedPushEndpoint("https://10.0.0.5:8443/admin")).toBe(false);
    expect(p2.isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(p2.isAllowedPushEndpoint("https://fcm.googleapis.com:8443/fcm/send/abc")).toBe(false);
    expect(p2.isAllowedPushEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(p2.isAllowedPushEndpoint("https://[::1]/x")).toBe(false);

    const a = await linkedCustomer(t.db);
    const b = await linkedCustomer(t.db);
    const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
    await expect(p2.registerPushSubscription(a.cctx, { endpoint: "https://10.0.0.5:8443/admin", keys })).rejects.toThrow(/Langganan notifikasi tidak valid/);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${newId()}`;
    const sub = await p2.registerPushSubscription(a.cctx, { endpoint, keys });
    await expect(p2.registerPushSubscription(b.cctx, { endpoint, keys: { ...keys, auth: "kunciPenyerangLain0" } })).rejects.toThrow(/akun lain/);
    const [still] = await t.db.select().from(customerPushSubscriptions).where(eq(customerPushSubscriptions.id, sub.id));
    expect(still!.customerAccountId).toBe(a.cctx.accountId);
    // Peramban yang sama (kunci sama) dipakai akun lain → langganan berpindah.
    await p2.registerPushSubscription(b.cctx, { endpoint, keys });
    const [moved] = await t.db.select().from(customerPushSubscriptions).where(eq(customerPushSubscriptions.id, sub.id));
    expect(moved!.customerAccountId).toBe(b.cctx.accountId);
  });

  it("US-P2-01 KP-1 PAR-74 permintaan OTP tidak membedakan nomor terdaftar/nonaktif; batas per alamat IP & total per jam (p2.otp_request_limits)", async () => {
    await enableApp();
    const ip = "203.0.113.7";
    const now = at(30);
    for (let i = 0; i < 20; i++) await p2.requestLoginOtp({ phone: uniquePhone() }, { now, ip });
    await expect(p2.requestLoginOtp({ phone: uniquePhone() }, { now, ip })).rejects.toThrow(/jaringan ini/);
    // IP lain tidak terdampak; baris OTP mencatat IP peminta.
    await p2.requestLoginOtp({ phone: uniquePhone() }, { now, ip: "198.51.100.9" });
    const rows = await t.db.select().from(otpCodes).where(and(eq(otpCodes.requestIp, ip)));
    expect(rows).toHaveLength(20);

    // Total per jam diatur parameter (berlaku mulai hari itu).
    await params.set(owner(at(30)), "p2.otp_request_limits", { per_ip_per_hour: 20, global_per_hour: 5 }, toBusinessDate(now), "Uji rem biaya pesan WA");
    await expect(p2.requestLoginOtp({ phone: uniquePhone() }, { now, ip: "192.0.2.44" })).rejects.toThrow(/sedang sibuk/);
    await params.set(owner(at(30)), "p2.otp_request_limits", { per_ip_per_hour: 20, global_per_hour: 500 }, toBusinessDate(now), "Kembalikan batas bawaan");
  });
});
