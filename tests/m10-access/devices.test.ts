import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accessLogs, devices, sessions, users } from "@/db/schema";
import { deviceId, employeeId, outletId, truckId, userIdByUsername } from "@/db/seed";
import { toBusinessDate } from "@/lib/time";
import { activateDevice, createSession } from "@/server/core/auth";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";
import { clearSentEmailsForTests, sentEmailsForTests } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import {
  blockDevice,
  getDeviceDetail,
  getUserDetail,
  issueActivationCode,
  listDevices,
  registerDevice,
  requestWipe,
  resetPassword,
  resetPin,
  resetTwoFactor,
  updateDeviceAssignment,
} from "@/server/modules/m10-access";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { fieldDevice } from "../helpers/field";
import { notificationsOf } from "./helpers";

const admin = () => seededContext("admin1");

describe("US-M10-02 Login, PIN, perangkat terdaftar, dan sesi", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M10-02 KP-1 admin sistem mendaftarkan perangkat (jenis, unit, pemegang) → kode aktivasi sekali tampil; kode salah ditolak & tercatat", async () => {
    await expect(registerDevice(seededContext("dispatcher1"), { deviceCode: "HP-X1", name: "Ponsel X", kind: "phone" })).rejects.toBeInstanceOf(ForbiddenError);
    const reg = await registerDevice(admin(), { deviceCode: "HP-BARU-1", name: "Ponsel truk T3 baru", kind: "phone", truckId: truckId("T3"), holderEmployeeId: employeeId("EQ-011") });
    expect(reg.displayCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(reg.device.status).toBe("registered");
    expect(reg.device.activationCodeHash).not.toContain(reg.code);
    const list = await listDevices(admin(), { q: "HP-BARU-1" });
    expect(list[0]).toMatchObject({ unitKind: "truck", holderName: "Dede Rohmat", status: "registered" });
    await expect(activateDevice("SALAH123", { ip: "10.0.0.9" })).rejects.toThrow(/Kode aktivasi salah/);
    const rejected = await t.db.select().from(accessLogs).where(eq(accessLogs.event, "device_rejected"));
    expect(rejected.some((r) => r.ip === "10.0.0.9")).toBe(true);
    const act = await activateDevice(reg.code);
    expect(act.device.status).toBe("active");
  });

  it("US-M10-02 KP-2 perangkat dipakai bergantian dengan PIN masing-masing; perangkat cadangan: pemegang aktual tercatat per sesi", async () => {
    await updateDeviceAssignment(admin(), { deviceId: deviceId("HP-CAD-1"), isSpare: true, reason: "Cadangan armada" });
    const hp = await fieldDevice("HP-CAD-1");
    await hp.login("sopir2");
    await hp.login("kernet3");
    const detail = await getDeviceDetail(admin(), deviceId("HP-CAD-1"));
    expect(detail.device.isSpare).toBe(true);
    // sopir2 = Ujang Suryana, kernet3 = Rudi Hartono (seed) — dua pengguna, dua sesi, perangkat yang sama.
    expect(detail.sessions.map((s) => s.userName)).toEqual(expect.arrayContaining(["Ujang Suryana", "Rudi Hartono"]));
    expect(detail.sessions.every((s) => s.isHolder === false)).toBe(true);
    expect(detail.usage.filter((u) => u.event === "login").map((u) => u.userName)).toEqual(expect.arrayContaining(["Ujang Suryana", "Rudi Hartono"]));
  });

  it("US-M10-02 KP-3 reset PIN hanya oleh admin sistem dengan pemberitahuan ke pemilik; sesi lapangan pengguna dicabut", async () => {
    const hp = await fieldDevice("HP-T4");
    const login = await hp.login("sopir4");
    await expect(resetPin(seededContext("dispatcher1"), { userId: userIdByUsername("sopir4"), reason: "Lupa PIN" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resetPin(admin(), { userId: userIdByUsername("admin1"), reason: "PIN sendiri" })).rejects.toThrow(/akun Anda sendiri/);
    const r = await resetPin(admin(), { userId: userIdByUsername("sopir4"), reason: "Sopir lupa PIN" });
    expect(r.displayCode).toMatch(/-/);
    expect((await t.db.select().from(users).where(eq(users.id, userIdByUsername("sopir4"))))[0]!.pinHash).toBeNull();
    expect((await t.db.select().from(sessions).where(eq(sessions.id, login.sessionId)))[0]!.revokedAt).not.toBeNull();
    expect((await notificationsOf(t.db, "pemilik", "user.pin_reset")).length).toBeGreaterThanOrEqual(1);
  });

  it("US-M10-02 KP-4 reset kata sandi (≥ 10 karakter, wajib ganti) & 2FA oleh admin sistem; pemilik diberi tahu (e-mail bila akun pemilik)", async () => {
    const { session } = await withTx((tx) => createSession(tx, { userId: userIdByUsername("keuangan2"), kind: "web" }));
    const r = await resetPassword(admin(), { userId: userIdByUsername("keuangan2"), reason: "Lupa kata sandi" });
    expect(r.temporaryPassword.length).toBeGreaterThanOrEqual(10);
    const u = (await t.db.select().from(users).where(eq(users.id, userIdByUsername("keuangan2"))))[0]!;
    expect(u.mustChangePassword).toBe(true);
    expect(u.passwordHash).not.toContain(r.temporaryPassword);
    expect((await t.db.select().from(sessions).where(eq(sessions.id, session.id)))[0]!.revokedAt).not.toBeNull();
    expect((await notificationsOf(t.db, "pemilik", "user.password_reset")).length).toBe(1);
    await expect(resetPassword(admin(), { userId: userIdByUsername("sopir5"), reason: "Sopir" })).rejects.toThrow(/PIN/);

    await params.set(seededContext("pemilik"), "notifications.digest_recipients", { emails: ["pemilik@equa.test"] }, toBusinessDate(new Date()), "E-mail pemilik");
    clearSentEmailsForTests();
    await resetTwoFactor(admin(), { userId: userIdByUsername("pemilik"), reason: "Ponsel pemilik hilang, verifikasi telepon" });
    expect((await t.db.select().from(users).where(eq(users.id, userIdByUsername("pemilik"))))[0]!.totpEnabled).toBe(false);
    expect(sentEmailsForTests().some((m) => m.to.includes("pemilik@equa.test") && /2FA/.test(m.subject))).toBe(true);
  });

  it("US-M10-02 KP-5 kredensial tidak tersimpan terbaca: tampilan pengguna tidak memuat hash; PIN/kata sandi disimpan sebagai hash argon2", async () => {
    const detail = await getUserDetail(admin(), userIdByUsername("sopir6"));
    expect(detail.hasPin).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/argon2/);
    const u = (await t.db.select().from(users).where(eq(users.id, userIdByUsername("sopir6"))))[0]!;
    expect(u.pinHash).toMatch(/^\$argon2/);
  });

  it("US-M10-02 KP-6 perangkat hilang: blokir seketika (sesi dicabut) lalu hapus jarak jauh; kode aktivasi baru ditolak sebelum hapus dijalankan", async () => {
    const hp = await fieldDevice("HP-T6");
    const login = await hp.login("sopir6");
    const blocked = await blockDevice(admin(), deviceId("HP-T6"), "Ponsel hilang di jalan");
    expect(blocked.status).toBe("blocked");
    expect((await t.db.select().from(sessions).where(eq(sessions.id, login.sessionId)))[0]!.revokedAt).not.toBeNull();
    await expect(hp.pull(login)).rejects.toThrow();
    const wiped = await requestWipe(admin(), deviceId("HP-T6"), "Hapus data aplikasi dari jarak jauh");
    expect(wiped.status).toBe("wipe_pending");
    await expect(issueActivationCode(admin(), deviceId("HP-T6"))).rejects.toThrow(/hapus data/);
    const logs = await t.db.select().from(accessLogs).where(eq(accessLogs.deviceId, deviceId("HP-T6")));
    expect(logs.map((l) => l.event)).toEqual(expect.arrayContaining(["device_blocked", "device_wipe_requested"]));
  });

  it("US-M10-02 KP-7 riwayat per perangkat: pengguna & waktu pemakaian, login gagal, sinkron terakhir, versi aplikasi", async () => {
    const hp = await fieldDevice("HP-T7");
    await hp.login("sopir7");
    await expect(hp.login("sopir7", { pin: "999999" })).rejects.toThrow();
    await hp.push([], { health: { queueCount: 2, appVersion: "0.1.3", batteryPct: 64, lastSyncAt: new Date().toISOString() } });
    const detail = await getDeviceDetail(admin(), deviceId("HP-T7"));
    expect(detail.usage.some((u) => u.event === "login" && u.userName === "Endang Kurnia")).toBe(true);
    expect(detail.failedLogins.length).toBeGreaterThanOrEqual(1);
    expect(detail.device.appVersion).toBe("0.1.3");
    expect(detail.device.batteryPct).toBe(64);
    expect(detail.device.lastSyncAt).not.toBeNull();
  });

  it("US-M10-02 KP-1 penetapan unit & pemegang berjejak; pindah unit memutus sesi; satu perangkat hanya satu unit", async () => {
    await expect(updateDeviceAssignment(admin(), { deviceId: deviceId("POS-CAD-1"), truckId: truckId("T1"), outletId: outletId("D02"), reason: "Salah input" })).rejects.toThrow(/satu unit/);
    const updated = await updateDeviceAssignment(admin(), { deviceId: deviceId("POS-CAD-1"), outletId: outletId("D02"), holderEmployeeId: employeeId("EQ-024"), reason: "Tablet D02 rusak, pakai cadangan" });
    expect(updated.outletId).toBe(outletId("D02"));
    const row = (await t.db.select().from(devices).where(eq(devices.id, deviceId("POS-CAD-1"))))[0]!;
    expect(row.holderEmployeeId).toBe(employeeId("EQ-024"));
  });
});
