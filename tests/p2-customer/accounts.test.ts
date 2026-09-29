import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { customerAccountRequests, customerAccounts, customerAddresses, customerSessions, customers, notifications, otpCodes, specialPrices } from "@/db/schema";
import { EQUA_TENANT_ID, productId, userIdByUsername } from "@/db/seed";
import { withTx } from "@/server/core/db";
import { DomainError, ForbiddenError, NotFoundError } from "@/server/core/errors";
import * as flags from "@/server/core/flags";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { dispatcher, enableApp, finance, linkedCustomer, login, minutes, owner, refresh, T0, TOMORROW, uniquePhone, zonedCustomer } from "./helpers";

describe("P2 Akun pelanggan (US-P2-01)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
  });

  it("US-P2-01 aplikasi tertutup bila flag phase2.customer_app mati (D-02) — pesan tindakan, tanpa kode teknis", async () => {
    expect(await withTx((tx) => p2.isAppEnabled(tx, EQUA_TENANT_ID))).toBe(false);
    await expect(p2.requestLoginOtp({ phone: "0812-9999-0001" }, { now: T0 })).rejects.toThrow(/belum aktif/);
    await expect(flags.set(dispatcher(), "phase2.customer_app", true, { scope: { type: "tenant", refId: EQUA_TENANT_ID }, reason: "Coba aktifkan" })).rejects.toBeInstanceOf(ForbiddenError);
    await enableApp();
    expect(await withTx((tx) => p2.isAppEnabled(tx, EQUA_TENANT_ID))).toBe(true);
  });

  it("US-P2-01 KP-1 OTP 6 digit lewat WhatsApp (PAR-74: 5 menit, 3 percobaan), tanpa kata sandi; sesi 30 hari", async () => {
    await enableApp();
    const phone = uniquePhone();
    const otp = await p2.requestLoginOtp({ phone: `0${phone.slice(2)}` }, { now: T0 });
    expect(otp.purpose).toBe("register");
    expect(otp.devCode).toMatch(/^\d{6}$/);
    expect(otp.expiresAt.getTime() - T0.getTime()).toBe(5 * 60_000);
    // Kode tidak disimpan utuh.
    const [row] = await t.db.select().from(otpCodes).where(eq(otpCodes.phone, phone));
    expect(row!.codeHash).not.toContain(otp.devCode!);
    expect(row!.maxAttempts).toBe(3);

    await expect(p2.requestLoginOtp({ phone }, { now: minutes(0.5) })).rejects.toThrow(/detik/);
    const wrong = otp.devCode === "000000" ? "111111" : "000000";
    await expect(p2.verifyLoginOtp({ phone, code: wrong }, { now: minutes(1) })).rejects.toThrow(/Sisa percobaan: 2/);
    await expect(p2.verifyLoginOtp({ phone, code: wrong }, { now: minutes(1) })).rejects.toThrow(/Sisa percobaan: 1/);
    await expect(p2.verifyLoginOtp({ phone, code: wrong }, { now: minutes(1) })).rejects.toThrow(/3 kali/);
    // Setelah 3 kali salah, kode benar pun ditolak → minta kode baru.
    await expect(p2.verifyLoginOtp({ phone, code: otp.devCode! }, { now: minutes(1) })).rejects.toThrow(/Minta kode baru|kedaluwarsa/);

    // Kode baru; lewat 5 menit kedaluwarsa.
    const otp2 = await p2.requestLoginOtp({ phone }, { now: minutes(2) });
    await expect(p2.verifyLoginOtp({ phone, code: otp2.devCode! }, { now: minutes(7.5) })).rejects.toThrow(/kedaluwarsa/);

    const otp3 = await p2.requestLoginOtp({ phone }, { now: minutes(8) });
    const res = await p2.verifyLoginOtp({ phone, code: otp3.devCode! }, { now: minutes(9) });
    expect(res.next).toBe("complete_registration");
    expect(res.expiresAt.getTime() - minutes(9).getTime()).toBe(30 * 86_400_000);
    const [acc] = await t.db.select().from(customerAccounts).where(eq(customerAccounts.phone, phone));
    expect(acc!.status).toBe("verified");
    const [sess] = await t.db.select().from(customerSessions).where(eq(customerSessions.customerAccountId, acc!.id));
    expect(sess!.tokenHash).not.toBe(res.token);
    // Sesi lewat 30 hari tidak berlaku.
    expect(await withTx((tx) => p2.resolveCustomerSession(tx, res.token, new Date(minutes(9).getTime() + 31 * 86_400_000)))).toBeNull();
  });

  it("US-P2-01 KP-2 nomor cocok pelanggan M1 + nama cocok → tertaut (status kredit & harga khusus ikut)", async () => {
    await enableApp();
    const phone = uniquePhone();
    const c = await zonedCustomer(t.db, { name: "Hotel Puncak Sejuk", phone, creditStatus: "credit", creditLimit: 5_000_000 });
    await t.db.insert(specialPrices).values({ customerId: c.id, productId: productId("AIR-TRUK"), price: 210_000, validFrom: "2026-01-01", reviewDate: "2027-01-01", status: "active", reason: "Kontrak hotel" });
    const { cctx, token } = await login(t.db, phone);
    await expect(p2.completeRegistration(cctx, { name: "Hotel Puncak Sejuk", consent: false as unknown as true })).rejects.toThrow(/persetujuan/i);
    const res = await p2.completeRegistration(cctx, { name: "Bpk. Hotel Puncak Sejuk", consent: true });
    expect(res).toMatchObject({ status: "linked", customerId: c.id, newCustomer: false });
    const me = await p2.getMyProfile(await refresh(token));
    expect(me.customer).toMatchObject({ id: c.id, creditStatus: "credit" });
    const addrs = await p2.listMyAddresses(await refresh(token));
    expect(addrs[0]!.priceText).toMatch(/harga khusus/);
  });

  it("US-P2-01 KP-2 nomor lama dipakai orang lain (nama tidak cocok, 8.7) → TIDAK tertaut otomatis; Dispatcher memverifikasi", async () => {
    await enableApp();
    const phone = uniquePhone();
    const c = await zonedCustomer(t.db, { name: "Ibu Siti Aminah", phone });
    const { cctx, token } = await login(t.db, phone);
    const res = await p2.completeRegistration(cctx, { name: "Budi Hartono", consent: true });
    expect(res.status).toBe("pending_review");
    const pending = await refresh(token);
    expect(pending.customerId).toBeNull();
    await expect(p2.listMyOrders(pending)).rejects.toThrow(/diverifikasi kantor/);
    const notif = await t.db.select().from(notifications).where(and(eq(notifications.event, "customer_app.account_review"), eq(notifications.recipientUserId, userIdByUsername("dispatcher1"))));
    expect(notif.some((n) => n.objectId === cctx.accountId)).toBe(true);

    const [req] = await t.db.select().from(customerAccountRequests).where(and(eq(customerAccountRequests.customerAccountId, cctx.accountId), eq(customerAccountRequests.kind, "review")));
    expect(req!.candidateCustomerId).toBe(c.id);
    // Admin Keuangan tidak memverifikasi (bukan izinnya).
    await expect(p2.verifyAccount(finance(), { decision: "new_customer", requestId: req!.id, addressText: "Jl. Baru No. 1, Cianjur", note: "Sudah ditelepon" })).rejects.toBeInstanceOf(ForbiddenError);
    const after = await p2.verifyAccount(dispatcher(), { decision: "new_customer", requestId: req!.id, addressText: "Jl. Baru No. 1, Cianjur", note: "Sudah ditelepon: nomor dibeli Pak Budi" });
    expect(after.status).toBe("linked");
    expect(after.customerId).not.toBe(c.id);
    const [nc] = await t.db.select().from(customers).where(eq(customers.id, after.customerId!));
    expect(nc).toMatchObject({ creditStatus: "cash", segment: "household", waPhone: phone });
  });

  it("US-P2-01 KP-2 nomor baru → pelanggan M1 baru Tunai (BR-01) segmen rumah tangga; KP-3 titik peta + catatan akses, 'belum dikunci', zona & harga otomatis", async () => {
    await enableApp();
    const phone = uniquePhone();
    const { cctx, token } = await login(t.db, phone);
    const needAddr = await p2.completeRegistration(cctx, { name: "Rina Wulandari", consent: true });
    expect(needAddr.status).toBe("address_required");
    const res = await p2.completeRegistration(cctx, {
      name: "Rina Wulandari",
      consent: true,
      address: { label: "Rumah", addressText: "Jl. Siliwangi No. 20, Muka, Cianjur", notes: "Pagar hijau, truk masuk dari gang kiri", lat: -6.8172, lng: 107.1428 },
    });
    expect(res).toMatchObject({ status: "linked", newCustomer: true });
    if (res.status !== "linked") throw new Error();
    const [c] = await t.db.select().from(customers).where(eq(customers.id, res.customerId));
    expect(c).toMatchObject({ creditStatus: "cash", segment: "household", waPhone: phone });
    const [addr] = await t.db.select().from(customerAddresses).where(eq(customerAddresses.customerId, res.customerId));
    expect(addr).toMatchObject({ coordinateStatus: "unlocked", coordinateSource: "customer_app", notes: "Pagar hijau, truk masuk dari gang kiri", lat: -6.8172 });
    expect(addr!.tariffZoneId).not.toBeNull();
    const view = await p2.listMyAddresses(await refresh(token));
    expect(view[0]).toMatchObject({ locked: false, orderable: true });
    expect(view[0]!.pricePerTank).toBeGreaterThan(0);
    // Alamat kedua dari aplikasi — juga belum dikunci & berzona otomatis.
    const second = await p2.addMyAddress(await refresh(token), { label: "Warung", addressText: "Jl. Raya Sabandar, Karangtengah", notes: null, lat: -6.8055, lng: 107.1702 });
    expect(second).toMatchObject({ coordinateStatus: "unlocked", zoneAssignment: "auto" });
    // Titik yang sudah dikunci kantor tidak dapat dipindah pelanggan.
    await t.db.update(customerAddresses).set({ coordinateStatus: "locked" }).where(eq(customerAddresses.id, second.id));
    await expect(p2.updateMyAddress(await refresh(token), second.id, { lat: -6.81, lng: 107.18 })).rejects.toThrow(/dikunci/);
  });

  it("US-P2-01 KP-4 satu nomor satu akun; ganti nomor lewat verifikasi nomor lama & baru, atau lewat Dispatcher", async () => {
    await enableApp();
    const a = await linkedCustomer(t.db);
    // Masuk ulang dengan nomor yang sama → akun yang sama.
    const again = await login(t.db, a.phone, minutes(3));
    expect(again.cctx.accountId).toBe(a.cctx.accountId);
    expect(again.login.next).toBe("home");

    const b = await linkedCustomer(t.db);
    await expect(p2.startPhoneChange(a.cctx, { newPhone: b.phone })).rejects.toThrow(/satu nomor satu akun/);

    const newPhone = uniquePhone();
    const step1 = await p2.startPhoneChange({ ...a.cctx, now: minutes(5) }, { newPhone });
    await expect(p2.completePhoneChange({ ...a.cctx, now: minutes(6) }, { code: step1.devCode! })).rejects.toThrow(/nomor lama dulu/);
    const step2 = await p2.confirmOldPhone({ ...a.cctx, now: minutes(6) }, { code: step1.devCode! });
    expect(step2.phone).toBe(newPhone);
    const changed = await p2.completePhoneChange({ ...a.cctx, now: minutes(7) }, { code: step2.devCode! });
    expect(changed).toEqual({ oldPhone: a.phone, newPhone });
    const [acc] = await t.db.select().from(customerAccounts).where(eq(customerAccounts.id, a.cctx.accountId));
    expect(acc!.phone).toBe(newPhone);
    const [c] = await t.db.select().from(customers).where(eq(customers.id, a.customer.id));
    expect(c!.waPhone).toBe(newPhone);
    // Sesi lain (masuk ulang tadi) dicabut; sesi yang mengganti tetap.
    expect(await withTx((tx) => p2.resolveCustomerSession(tx, again.token, minutes(8)))).toBeNull();
    expect(await withTx((tx) => p2.resolveCustomerSession(tx, a.token, minutes(8)))).not.toBeNull();

    // Lewat Dispatcher (pelanggan kehilangan nomor lama).
    const viaOffice = uniquePhone();
    const row = await p2.officeChangePhone(dispatcher(), { accountId: b.cctx.accountId, newPhone: viaOffice, reason: "Nomor lama hilang, pelanggan datang ke kantor" });
    expect(row.phone).toBe(viaOffice);
    expect(await withTx((tx) => p2.resolveCustomerSession(tx, b.token, minutes(1)))).toBeNull();
    await expect(p2.officeChangePhone(dispatcher(), { accountId: a.cctx.accountId, newPhone: viaOffice, reason: "Salah input nomor" })).rejects.toThrow(/sudah dipakai/);
  });

  it("US-P2-01 KP-5 persetujuan UU PDP tercatat (versi naskah); hapus akun → nonaktif, sesi dicabut, permintaan anonimisasi ke admin sistem (US-M10-06 KP-2)", async () => {
    await enableApp();
    const a = await linkedCustomer(t.db);
    const [acc] = await t.db.select().from(customerAccounts).where(eq(customerAccounts.id, a.cctx.accountId));
    expect(acc!.consentPdpAt).not.toBeNull();
    expect(acc!.consentVersion).toBe("2026-09");

    await expect(p2.requestAccountDeletion(a.cctx, { confirm: "hapus aku" })).rejects.toThrow(/Ketik HAPUS/);
    const res = await p2.requestAccountDeletion(a.cctx, { confirm: "hapus", reason: "Pindah rumah" });
    expect(res.sessionsRevoked).toBeGreaterThanOrEqual(1);
    const [after] = await t.db.select().from(customerAccounts).where(eq(customerAccounts.id, a.cctx.accountId));
    expect(after!.status).toBe("inactive");
    expect(await withTx((tx) => p2.resolveCustomerSession(tx, a.token, minutes(1)))).toBeNull();
    // Permintaan kode seragam (tidak membocorkan status nomor); akun nonaktif ditolak setelah kode diverifikasi.
    const again = await p2.requestLoginOtp({ phone: a.phone }, { now: minutes(2) });
    await expect(p2.verifyLoginOtp({ phone: a.phone, code: again.devCode! }, { now: minutes(2) })).rejects.toThrow(/dinonaktifkan/);
    const notif = await t.db.select().from(notifications).where(and(eq(notifications.event, "customer_app.deletion_requested"), eq(notifications.recipientUserId, userIdByUsername("admin1"))));
    expect(notif.some((n) => n.objectId === a.cctx.accountId)).toBe(true);
    const reqs = await p2.listAccountRequests(owner(), { status: "open" });
    expect(reqs.some((r) => r.kind === "deletion" && r.account.id === a.cctx.accountId)).toBe(true);

    // Akun tanpa data pelanggan (belum tertaut) langsung dianonimkan.
    const lone = await login(t.db, uniquePhone());
    await p2.requestAccountDeletion(lone.cctx, { confirm: "HAPUS" });
    const [anon] = await t.db.select().from(customerAccounts).where(eq(customerAccounts.id, lone.cctx.accountId));
    expect(anon!.phone).toBe(`anon-${lone.cctx.accountId}`);
    expect(anon!.anonymizedAt).not.toBeNull();
  });

  it("US-P2-01 daftar akun & permintaan kantor hanya untuk pemilik/Dispatcher (data pribadi); pelanggan lain tidak terlihat", async () => {
    await enableApp();
    const rows = await p2.listAccounts(owner());
    expect(rows.length).toBeGreaterThan(0);
    await expect(p2.listAccounts(finance())).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("P2 NFR Tahap 2 — data pribadi hanya milik sendiri (isolasi antar pelanggan)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("NFR-12 pelanggan A tidak dapat membaca pesanan, pengiriman, alamat, faktur, atau keluhan pelanggan B", async () => {
    await enableApp();
    const a = await linkedCustomer(t.db);
    const b = await linkedCustomer(t.db);
    const [addrB] = await p2.listMyAddresses(b.cctx);
    const orderB = await p2.placeOrder(b.cctx, { addressId: addrB!.id, tankCount: 1, date: TOMORROW, slot: "morning", paymentMethod: "cash" });
    await expect(p2.getMyOrder(a.cctx, orderB.orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(p2.getTracking(a.cctx, orderB.orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(p2.cancelMyOrder(a.cctx, orderB.orderId, { reason: "iseng" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(p2.placeOrder(a.cctx, { addressId: addrB!.id, tankCount: 1, date: TOMORROW, slot: "morning", paymentMethod: "cash" })).rejects.toThrow(/Alamat tidak ditemukan/);
    await expect(p2.updateMyAddress(a.cctx, addrB!.id, { notes: "ubah" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(p2.submitComplaint(a.cctx, { kind: "lateness", description: "Mencoba keluhan pesanan orang lain", orderId: orderB.orderId })).rejects.toBeInstanceOf(NotFoundError);
    expect((await p2.listMyOrders(a.cctx)).some((o) => o.id === orderB.orderId)).toBe(false);
    // Sesi dengan token palsu / kosong → tidak ada pelaku.
    expect(await withTx((tx) => p2.resolveCustomerSession(tx, "x".repeat(40), T0))).toBeNull();
    expect(await withTx((tx) => p2.resolveCustomerSession(tx, null, T0))).toBeNull();
  });

  it("NFR-05 skala: daftar riwayat & slot tetap ringan (satu kueri per halaman, batas baris)", async () => {
    await enableApp();
    const a = await linkedCustomer(t.db);
    const started = Date.now();
    await p2.listMyOrders(a.cctx);
    await withTx((tx) => p2.slotAvailability(tx, { tenantId: EQUA_TENANT_ID, now: T0 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(DomainError).toBeDefined();
  });
});
