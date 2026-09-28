import { pbkdf2Sync } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accessLogs, crewAssignments, crewRosters, devices, incidents, notifications, sessions, users } from "@/db/schema";
import { deviceId, EQUA_TENANT_ID, employeeId, EMPLOYEE_SEEDS, SEED_DEMO_PIN, truckId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import {
  activateDevice,
  applyCrewScope,
  AuthError,
  authenticateDevice,
  blockDevice,
  buildFieldActorContext,
  enrollPin,
  issueActivationCode,
  issuePinEnrollment,
  isActingDriver,
  listDeviceUsage,
  listDeviceUsers,
  pinLogin,
  PIN_VERIFIER_ITERATIONS,
  registerDevice,
  requestWipe,
  signDeviceToken,
} from "@/server/core/auth";
import { ValidationError } from "@/server/core/errors";
import { recordHealth } from "@/server/core/sync";

import { seededContext } from "../helpers/context";
import { useTestDb as withTestDb } from "../helpers/db";

const t = withTestDb({ seed: true });

async function expectAuthError(p: Promise<unknown>, code: string): Promise<AuthError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `diharapkan AuthError ${code}`).toBeInstanceOf(AuthError);
  expect((err as AuthError).code).toBe(code);
  return err as AuthError;
}

function deviceRequest(token: string): Request {
  return new Request("http://localhost/api/sync/pull", { headers: { authorization: `Bearer ${token}`, "user-agent": "vitest" } });
}

/** Terbitkan kode untuk perangkat seed lalu aktifkan. */
async function activateSeedDevice(code: string) {
  const admin = seededContext("admin1");
  const issued = await issueActivationCode(admin, deviceId(code));
  const act = await activateDevice(issued.code, { ip: "10.0.0.1" });
  const auth = async (claims: { userId?: string; sessionId?: string } = {}, now?: Date) =>
    authenticateDevice(deviceRequest(await signDeviceToken(act.deviceSecret, { deviceId: act.deviceId, ...claims }, { now })), { now });
  return { ...act, auth };
}

describe("Perangkat terdaftar (US-M10-02 KP-1/KP-6/KP-7)", () => {
  it("US-M10-02 KP-1 aktivasi dengan kode 8 karakter: secret dikirim sekali, server hanya menyimpan rekaman turunan", async () => {
    const admin = seededContext("admin1");
    const reg = await registerDevice(admin, { deviceCode: "HP-UJI-1", name: "Ponsel uji", kind: "phone", truckId: truckId("T2") });
    expect(reg.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(reg.device.status).toBe("registered");
    expect(reg.device.activationCodeHash).not.toContain(reg.code);

    const act = await activateDevice(reg.displayCode.toLowerCase(), { ip: "10.0.0.2" });
    expect(act.deviceId).toBe(reg.device.id);
    expect(act.device.home).toBe("/sopir");
    const [row] = await t.db.select().from(devices).where(eq(devices.id, act.deviceId));
    expect(row!.status).toBe("active");
    expect(row!.secretHash).toMatch(/^d1:/);
    expect(row!.secretHash).not.toContain(act.deviceSecret);
    expect(row!.activationCodeHash).toBeNull();

    // Kode sekali pakai.
    await expectAuthError(activateDevice(reg.code, { ip: "10.0.0.2" }), "ACTIVATION_INVALID");
    // Token perangkat JWT ditandatangani secret → diterima.
    const token = await signDeviceToken(act.deviceSecret, { deviceId: act.deviceId });
    const auth = await authenticateDevice(deviceRequest(token));
    expect(auth.device.id).toBe(act.deviceId);
    expect(auth.session).toBeNull();
  });

  it("US-M10-02 KP-1 kode aktivasi kedaluwarsa setelah 24 jam; hanya admin sistem yang dapat mendaftarkan", async () => {
    const admin = seededContext("admin1");
    const reg = await registerDevice(admin, { deviceCode: "HP-UJI-2", name: "Ponsel uji 2", kind: "phone" });
    await expectAuthError(activateDevice(reg.code, { now: new Date(Date.now() + 25 * 3_600_000) }), "ACTIVATION_INVALID");
    await expect(registerDevice(seededContext("dispatcher1"), { deviceCode: "HP-UJI-3", name: "x", kind: "phone" })).rejects.toThrow(/tidak diizinkan/);
  });

  it("US-M10-02 KP-1 perangkat tidak terdaftar / token palsu ditolak dan dicatat di log akses", async () => {
    const fake = await signDeviceToken("A".repeat(43), { deviceId: newId() });
    await expectAuthError(authenticateDevice(deviceRequest(fake)), "DEVICE_UNKNOWN");
    const { deviceId: id } = await activateSeedDevice("HP-CAD-2");
    const forged = await signDeviceToken("B".repeat(43), { deviceId: id });
    await expectAuthError(authenticateDevice(deviceRequest(forged)), "DEVICE_TOKEN_INVALID");
    await expectAuthError(authenticateDevice(new Request("http://localhost/x")), "DEVICE_UNKNOWN");
    const rejected = await t.db.select().from(accessLogs).where(eq(accessLogs.event, "device_rejected"));
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    expect(rejected.some((r) => r.deviceId === id)).toBe(true);
  });

  it("US-M10-02 KP-6 perangkat diblokir → semua permintaan ditolak & sesi lapangan dicabut", async () => {
    const dev = await activateSeedDevice("HP-T3");
    const login = await pinLogin(await dev.auth(), { userId: userIdByUsername("sopir3"), pin: SEED_DEMO_PIN });
    await blockDevice(seededContext("admin1"), dev.deviceId, "Ponsel hilang di jalan");
    await expectAuthError(dev.auth({ userId: userIdByUsername("sopir3"), sessionId: login.sessionId }), "DEVICE_BLOCKED");
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, login.sessionId));
    expect(s!.revokeReason).toBe("device_blocked");
    const logs = await t.db.select().from(accessLogs).where(and(eq(accessLogs.deviceId, dev.deviceId), eq(accessLogs.event, "device_blocked")));
    expect(logs.length).toBe(1);
  });

  it("US-M10-02 KP-6 hapus jarak jauh: kontak berikutnya memerintahkan hapus data, status wiped, antrean hilang → insiden + pemilik diberi tahu", async () => {
    const dev = await activateSeedDevice("HP-T4");
    const auth = await dev.auth();
    await recordHealth(auth, { queueCount: 3, appVersion: "0.1.0", batteryPct: 40 });
    await requestWipe(seededContext("admin1"), dev.deviceId, "Ponsel dicuri, hapus data");
    const err = await expectAuthError(dev.auth(), "DEVICE_WIPE");
    expect(err.status).toBe(410);
    const [row] = await t.db.select().from(devices).where(eq(devices.id, dev.deviceId));
    expect(row!.status).toBe("wiped");
    expect(row!.wipedAt).not.toBeNull();
    const inc = await t.db.select().from(incidents).where(eq(incidents.objectId, dev.deviceId));
    expect(inc).toHaveLength(1);
    expect(inc[0]!.kind).toBe("lost_device_queue");
    const notes = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "device.lost_queue"), eq(notifications.recipientUserId, userIdByUsername("pemilik"))));
    expect(notes).toHaveLength(1);
    // Kontak berikutnya tetap diperintahkan menghapus.
    await expectAuthError(dev.auth(), "DEVICE_WIPE");
  });

  it("US-M10-02 KP-7 riwayat pemakaian perangkat: aktivasi, login, PIN salah", async () => {
    const dev = await activateSeedDevice("HP-T5");
    await expectAuthError(pinLogin(await dev.auth(), { userId: userIdByUsername("sopir5"), pin: "999999" }), "PIN_INVALID");
    await pinLogin(await dev.auth(), { userId: userIdByUsername("sopir5"), pin: SEED_DEMO_PIN });
    const usage = await listDeviceUsage(seededContext("admin1"), dev.deviceId);
    const events = usage.map((u) => u.event);
    expect(events).toEqual(expect.arrayContaining(["activated", "pin_failed", "login"]));
    await expect(listDeviceUsage(seededContext("sopir1"), dev.deviceId)).rejects.toThrow();
  });
});

describe("PIN lapangan (US-M10-02 KP-2/KP-3/KP-5, US-M3-10 KP-1, NFR-10)", () => {
  it("PAR-36 PIN salah 5 kali → terkunci 15 menit + notifikasi admin sistem", async () => {
    const dev = await activateSeedDevice("HP-T6");
    const userId = userIdByUsername("sopir6");
    for (let i = 1; i <= 4; i++) {
      const e = await expectAuthError(pinLogin(await dev.auth(), { userId, pin: "000111" }), "PIN_INVALID");
      expect(e.message).toContain(`Sisa ${5 - i} kali`);
    }
    await expectAuthError(pinLogin(await dev.auth(), { userId, pin: "000111" }), "PIN_LOCKED");
    // PIN benar pun ditolak selama terkunci.
    await expectAuthError(pinLogin(await dev.auth(), { userId, pin: SEED_DEMO_PIN }), "PIN_LOCKED");
    const admins = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "device.pin_locked"), eq(notifications.objectId, userId)));
    expect(admins.map((n) => n.recipientUserId).sort()).toEqual([userIdByUsername("admin1"), userIdByUsername("admin2")].sort());
    const locked = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, userId), eq(accessLogs.event, "pin_locked")));
    expect(locked).toHaveLength(1);
    // 16 menit kemudian dapat masuk.
    const later = new Date(Date.now() + 16 * 60_000);
    const ok = await pinLogin(await dev.auth({}, later), { userId, pin: SEED_DEMO_PIN });
    expect(ok.user.id).toBe(userId);
    expect(ok.policy).toEqual({ maxAttempts: 5, lockMinutes: 15, idleMinutes: 10 });
  });

  it("NFR-10 verifier PIN offline (PBKDF2-SHA256 ≥ 100.000 iterasi + salt) tidak membocorkan PIN", async () => {
    const dev = await activateSeedDevice("HP-T7");
    const a = await pinLogin(await dev.auth(), { userId: userIdByUsername("sopir7"), pin: SEED_DEMO_PIN });
    const b = await pinLogin(await dev.auth(), { userId: userIdByUsername("sopir7"), pin: SEED_DEMO_PIN });
    expect(a.verifier.algorithm).toBe("PBKDF2-SHA256");
    expect(a.verifier.iterations).toBeGreaterThanOrEqual(100_000);
    expect(PIN_VERIFIER_ITERATIONS).toBeGreaterThanOrEqual(100_000);
    const serialized = JSON.stringify(a);
    expect(serialized).not.toContain(SEED_DEMO_PIN);
    // Salt acak per login → verifier berbeda untuk PIN yang sama.
    expect(a.verifier.salt).not.toBe(b.verifier.salt);
    expect(a.verifier.verifier).not.toBe(b.verifier.verifier);
    // Perangkat dapat memverifikasi PIN secara offline; PIN lain tidak cocok.
    const derive = (pin: string) => pbkdf2Sync(pin, Buffer.from(a.verifier.salt, "base64url"), a.verifier.iterations, 32, "sha256").toString("base64url");
    expect(derive(SEED_DEMO_PIN)).toBe(a.verifier.verifier);
    expect(derive("123457")).not.toBe(a.verifier.verifier);
    // Hash PIN di server = argon2, bukan PIN.
    const [u] = await t.db.select({ pinHash: users.pinHash }).from(users).where(eq(users.id, userIdByUsername("sopir7")));
    expect(u!.pinHash).toMatch(/^\$argon2/);
  });

  it("US-M10-02 KP-3 reset PIN oleh admin sistem (pemilik diberi tahu) → kode aktivasi akun sekali pakai + PIN baru pilihan pengguna", async () => {
    const dev = await activateSeedDevice("HP-CAD-1");
    const userId = userIdByUsername("kernet2");
    const before = await pinLogin(await dev.auth(), { userId, pin: SEED_DEMO_PIN });
    const issued = await issuePinEnrollment(seededContext("admin1"), userId, { purpose: "reset", reason: "Lupa PIN" });
    expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    // PIN lama tidak berlaku, sesi lapangan dicabut, pemilik diberi tahu.
    await expectAuthError(pinLogin(await dev.auth(), { userId, pin: SEED_DEMO_PIN }), "PIN_NOT_SET");
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, before.sessionId));
    expect(s!.revokeReason).toBe("pin_reset");
    const owner = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "user.pin_reset"), eq(notifications.recipientUserId, userIdByUsername("pemilik"))));
    expect(owner).toHaveLength(1);
    // PIN lemah ditolak; kode tetap berlaku.
    await expect(enrollPin(await dev.auth(), { code: issued.code, pin: "111111" })).rejects.toBeInstanceOf(ValidationError);
    const enrolled = await enrollPin(await dev.auth(), { code: issued.displayCode, pin: "482915" });
    expect(enrolled.user.id).toBe(userId);
    expect((await pinLogin(await dev.auth(), { userId, pin: "482915" })).user.id).toBe(userId);
    // Kode sekali pakai.
    await expectAuthError(enrollPin(await dev.auth(), { code: issued.code, pin: "730591" }), "PIN_ENROLLMENT_INVALID");
    // Hanya admin sistem.
    await expect(issuePinEnrollment(seededContext("dispatcher1"), userId)).rejects.toThrow(/tidak diizinkan/);
  });

  it("US-M10-02 KP-2 perangkat truk dipakai sopir & kernet truk itu; sopir truk lain ditolak", async () => {
    const dev = await activateSeedDevice("HP-T1");
    const auth = await dev.auth();
    const list = await listDeviceUsers(t.db, auth.device);
    expect(list.map((u) => u.id).sort()).toEqual([userIdByUsername("sopir1"), userIdByUsername("kernet1")].sort());
    expect(list.every((u) => u.hasPin)).toBe(true);
    await expectAuthError(pinLogin(auth, { userId: userIdByUsername("sopir2"), pin: SEED_DEMO_PIN }), "USER_NOT_ALLOWED_ON_DEVICE");
    // Sopir pengganti yang dijadwalkan Dispatcher hari ini boleh memakai perangkat truk.
    const today = toBusinessDate(new Date());
    await t.db.insert(crewAssignments).values({
      tenantId: EQUA_TENANT_ID,
      truckId: truckId("T1"),
      businessDate: today,
      driverEmployeeId: employeeId(EMPLOYEE_SEEDS.find((e) => e.username === "sopir2")!.no),
      source: "other_driver",
      reason: "Sopir 1 sakit",
    });
    const ok = await pinLogin(auth, { userId: userIdByUsername("sopir2"), pin: SEED_DEMO_PIN });
    expect(ok.user.roleLabel).toBe("Sopir");
    // Token dengan sesi → pelaku lapangan berlingkup truk hari itu.
    const withSession = await dev.auth({ userId: ok.user.id, sessionId: ok.sessionId });
    expect(withSession.user?.id).toBe(ok.user.id);
    const ctx = await buildFieldActorContext(t.db, withSession.device, ok.user.id);
    expect(ctx.source).toBe("field");
    expect(ctx.scope.truckIds).toEqual([truckId("T1")]);
  });

  it("US-M2-11 kernet hanya pengemudi bila ditetapkan pengganti; lingkup truk mengikuti jadwal kru hari itu", async () => {
    const date = "2026-10-05";
    const kernet3 = seededContext("kernet3", { businessDate: date });
    const sopir4 = seededContext("sopir4", { businessDate: date });
    expect(await isActingDriver(t.db, kernet3, truckId("T3"), date)).toBe(false);
    expect(await isActingDriver(t.db, seededContext("sopir3"), truckId("T3"), date)).toBe(true);
    await t.db.insert(crewAssignments).values({
      tenantId: EQUA_TENANT_ID,
      truckId: truckId("T3"),
      businessDate: date,
      driverEmployeeId: kernet3.employeeId!,
      source: "helper",
      reason: "Sopir 3 cuti",
    });
    expect(await isActingDriver(t.db, kernet3, truckId("T3"), date)).toBe(true);
    expect(await isActingDriver(t.db, seededContext("sopir3"), truckId("T3"), date)).toBe(false);
    // Sopir 4 dijadwalkan di truk T6 hari itu → lingkupnya T6 saja; libur → tanpa truk.
    await t.db.insert(crewRosters).values({ tenantId: EQUA_TENANT_ID, employeeId: sopir4.employeeId!, businessDate: date, status: "on_duty", truckId: truckId("T6"), role: "driver" });
    expect((await applyCrewScope(t.db, sopir4, date)).scope.truckIds).toEqual([truckId("T6")]);
    const sopir5 = seededContext("sopir5");
    await t.db.insert(crewRosters).values({ tenantId: EQUA_TENANT_ID, employeeId: sopir5.employeeId!, businessDate: date, status: "off" });
    expect((await applyCrewScope(t.db, sopir5, date)).scope.truckIds).toEqual([]);
    // Tanpa jadwal → lingkup user_scopes.
    expect((await applyCrewScope(t.db, seededContext("sopir6"), date)).scope.truckIds).toEqual([truckId("T6")]);
  });
});
