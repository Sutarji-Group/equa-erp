import { and, eq } from "drizzle-orm";
import { generate } from "otplib";
import { describe, expect, it } from "vitest";

import { accessLogs, employees, sessions, users } from "@/db/schema";
import type { RoleCode } from "@/lib/labels";
import { SEED_DEMO_PASSWORD, SEED_TOTP_SECRETS, userIdByUsername } from "@/db/seed";
import { getActorContext } from "@/server/core/actor";
import {
  AuthError,
  confirmTotpEnrollment,
  hashPassword,
  loginWithPassword,
  logout,
  revokeAllSessions,
  startTotpEnrollment,
  validateSession,
  verifyTotpLogin,
  webActorFromToken,
} from "@/server/core/auth";
import { ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";

import { seededContext } from "../helpers/context";
import { useTestDb as withTestDb } from "../helpers/db";
import { createTestUser, type CreateTestUserOptions } from "../helpers/factories";

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

async function userWithPassword(role: RoleCode, password = "kata-sandi-uji-123", extra: CreateTestUserOptions = {}) {
  const u = await createTestUser(t.db, { role, ...extra });
  await t.db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, u.userId));
  return { ...u, password };
}

describe("Login web kantor & 2FA (US-M10-02 KP-4)", () => {
  it("US-M10-02 KP-4 pemilik wajib TOTP: kata sandi benar → menunggu 2FA; kode benar → sesi aktif", async () => {
    const res = await loginWithPassword({ username: "Pemilik", password: SEED_DEMO_PASSWORD });
    expect(res.next).toBe("totp");
    // Sebelum 2FA, sesi tidak menghasilkan pelaku (route membalas 401).
    expect(await webActorFromToken(res.token)).toBeNull();

    const code = await generate({ secret: SEED_TOTP_SECRETS.pemilik });
    await verifyTotpLogin(res.token, code);
    const ctx = await webActorFromToken(res.token);
    expect(ctx?.roles).toEqual(["owner"]);

    // Rahasia seed `plain:` dienkripsi ulang (v1:…) saat dipakai.
    const [row] = await t.db.select({ enc: users.totpSecretEnc, last: users.lastLoginAt }).from(users).where(eq(users.id, userIdByUsername("pemilik")));
    expect(row!.enc).toMatch(/^v1:/);
    expect(row!.last).not.toBeNull();

    // Kode yang sama tidak dapat dipakai ulang (replay) untuk login berikutnya.
    const again = await loginWithPassword({ username: "pemilik", password: SEED_DEMO_PASSWORD });
    await expectAuthError(verifyTotpLogin(again.token, code), "TOTP_INVALID");
  });

  it("US-M10-02 KP-4 Admin Keuangan & admin sistem juga wajib 2FA; dispatcher langsung masuk", async () => {
    expect((await loginWithPassword({ username: "keuangan1", password: SEED_DEMO_PASSWORD })).next).toBe("totp");
    expect((await loginWithPassword({ username: "admin1", password: SEED_DEMO_PASSWORD })).next).toBe("totp");
    const d = await loginWithPassword({ username: "dispatcher1", password: SEED_DEMO_PASSWORD });
    expect(d.next).toBe("done");
    expect((await webActorFromToken(d.token))?.roles).toEqual(["dispatcher"]);
  });

  it("US-M10-02 KP-4 kode 2FA salah ditolak dan dicatat di log akses", async () => {
    const res = await loginWithPassword({ username: "keuangan2", password: SEED_DEMO_PASSWORD });
    await expectAuthError(verifyTotpLogin(res.token, "000000"), "TOTP_INVALID");
    const logs = await t.db
      .select()
      .from(accessLogs)
      .where(and(eq(accessLogs.userId, userIdByUsername("keuangan2")), eq(accessLogs.event, "totp_failed")));
    expect(logs.length).toBe(1);
    expect(await webActorFromToken(res.token)).toBeNull();
  });

  it("US-M10-02 KP-4 peran 2FA tanpa TOTP diarahkan ke pendaftaran (QR) lalu aktif", async () => {
    const u = await userWithPassword("finance_admin");
    const res = await loginWithPassword({ username: u.username, password: u.password });
    expect(res.next).toBe("totp_enroll");
    const enrollment = await startTotpEnrollment(res.token);
    expect(enrollment.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(enrollment.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    // Muat ulang halaman → rahasia yang sama (tidak membingungkan pengguna yang sudah memindai).
    expect((await startTotpEnrollment(res.token)).secret).toBe(enrollment.secret);
    const [pending] = await t.db.select().from(users).where(eq(users.id, u.userId));
    expect(pending!.totpEnabled).toBe(false);
    expect(pending!.totpSecretEnc).toMatch(/^v1:/);
    expect(pending!.totpSecretEnc).not.toContain(enrollment.secret);

    await confirmTotpEnrollment(res.token, await generate({ secret: enrollment.secret }));
    const [after] = await t.db.select().from(users).where(eq(users.id, u.userId));
    expect(after!.totpEnabled).toBe(true);
    expect((await webActorFromToken(res.token))?.roles).toEqual(["finance_admin"]);
  });

  it("US-M10-02 KP-4 kata sandi minimal 10 karakter", async () => {
    await expect(hashPassword("pendek123")).rejects.toBeInstanceOf(ValidationError);
    await expect(hashPassword("cukup-panjang")).resolves.toMatch(/^\$argon2/);
  });

  it("NFR-09 pesan gagal seragam; 5 kali salah → akun terkunci sementara (PAR-36) dan tercatat", async () => {
    const u = await userWithPassword("dispatcher");
    const unknown = await expectAuthError(loginWithPassword({ username: "tidak-ada-orangnya", password: "apa-saja-123" }), "AUTH_FAILED");
    const wrong = await expectAuthError(loginWithPassword({ username: u.username, password: "salah-sekali-1" }), "AUTH_FAILED");
    expect(wrong.message).toBe(unknown.message);
    for (let i = 0; i < 3; i++) await expectAuthError(loginWithPassword({ username: u.username, password: "salah-sekali-1" }), "AUTH_FAILED");
    await expectAuthError(loginWithPassword({ username: u.username, password: "salah-sekali-1" }), "ACCOUNT_LOCKED");
    // Kata sandi benar pun ditolak selama terkunci.
    await expectAuthError(loginWithPassword({ username: u.username, password: u.password }), "ACCOUNT_LOCKED");
    // Setelah 15 menit dapat masuk lagi.
    const later = new Date(Date.now() + 16 * 60_000);
    expect((await loginWithPassword({ username: u.username, password: u.password }, { now: later })).next).toBe("done");
    const failed = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, u.userId), eq(accessLogs.event, "login_failed")));
    expect(failed.length).toBeGreaterThanOrEqual(6);
  });

  it("US-M10-01 KP-8 akun menunggu persetujuan / nonaktif ditolak; akun lapangan diarahkan ke aplikasi lapangan", async () => {
    const pending = await userWithPassword("dispatcher", "kata-sandi-uji-123", { status: "pending_approval" });
    const e1 = await expectAuthError(loginWithPassword({ username: pending.username, password: pending.password }), "ACCOUNT_INACTIVE");
    expect(e1.message).toMatch(/menunggu persetujuan/);
    const inactive = await userWithPassword("dispatcher", "kata-sandi-uji-123", { status: "inactive" });
    await expectAuthError(loginWithPassword({ username: inactive.username, password: inactive.password }), "ACCOUNT_INACTIVE");
    await expectAuthError(loginWithPassword({ username: "sopir1", password: SEED_DEMO_PASSWORD }), "FIELD_ACCOUNT");
  });
});

describe("Sesi web (PAR-46, NFR-09, BR-37)", () => {
  it("PAR-46 sesi kedaluwarsa setelah 30 menit tidak aktif", async () => {
    const t0 = new Date();
    const res = await loginWithPassword({ username: "dispatcher2", password: SEED_DEMO_PASSWORD }, { now: t0 });
    expect((await validateSession(t.db, res.token, { now: new Date(t0.getTime() + 29 * 60_000) })).ok).toBe(true);
    // Aktivitas di menit ke-29 memperpanjang; 31 menit setelah aktivitas terakhir → habis.
    const v = await validateSession(t.db, res.token, { now: new Date(t0.getTime() + 61 * 60_000) });
    expect(v).toMatchObject({ ok: false, reason: "expired_idle" });
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, res.sessionId));
    expect(s!.revokedAt).not.toBeNull();
    const logs = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, res.userId), eq(accessLogs.event, "session_expired")));
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("PAR-46 sesi berakhir pada batas maksimal 12 jam walau terus aktif", async () => {
    const u = await userWithPassword("dispatcher");
    const t0 = new Date();
    const res = await loginWithPassword({ username: u.username, password: u.password }, { now: t0 });
    let at = t0.getTime();
    for (let i = 0; i < 24; i++) {
      at += 25 * 60_000; // aktif tiap 25 menit (di bawah batas tidak aktif)
      const v = await validateSession(t.db, res.token, { now: new Date(at) });
      if (at - t0.getTime() < 12 * 3_600_000) expect(v.ok).toBe(true);
    }
    const v = await validateSession(t.db, res.token, { now: new Date(t0.getTime() + 12 * 3_600_000 + 60_000) });
    expect(v).toMatchObject({ ok: false });
    expect(["expired_max", "revoked"]).toContain((v as { reason: string }).reason);
  });

  it("PAR-46 batas tidak aktif diambil dari parameter (pemilik mengubah menjadi 60 menit)", async () => {
    const owner = seededContext("pemilik");
    const today = new Date().toISOString().slice(0, 10);
    const wib = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    await params.set(owner, "PAR-46", { idle_minutes: 60, max_hours: 12 }, wib > today ? wib : today, "Uji: sesi kantor 60 menit");
    const u = await userWithPassword("dispatcher");
    const t0 = new Date();
    const res = await loginWithPassword({ username: u.username, password: u.password }, { now: t0 });
    expect((await validateSession(t.db, res.token, { now: new Date(t0.getTime() + 45 * 60_000) })).ok).toBe(true);
    await params.set(owner, "PAR-46", { idle_minutes: 30, max_hours: 12 }, wib > today ? wib : today, "Uji: kembali ke bawaan");
  });

  it("US-M10-01 KP-5 akun dinonaktifkan → semua sesi dicabut seketika (revokeAllSessions)", async () => {
    const u = await userWithPassword("dispatcher");
    const a = await loginWithPassword({ username: u.username, password: u.password });
    const b = await loginWithPassword({ username: u.username, password: u.password });
    await t.db.update(users).set({ status: "inactive" }).where(eq(users.id, u.userId));
    expect(await revokeAllSessions(u.userId, "user_inactive")).toBe(2);
    expect(await validateSession(t.db, a.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(await validateSession(t.db, b.token)).toMatchObject({ ok: false, reason: "revoked" });
    const logs = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, u.userId), eq(accessLogs.event, "session_revoked")));
    expect(logs.length).toBe(1);
  });

  it("US-M10-01 KP-5 akun nonaktif / tanggal keluar hari ini → sesi ditolak & dicabut walau belum dicabut manual", async () => {
    const u = await userWithPassword("dispatcher");
    const res = await loginWithPassword({ username: u.username, password: u.password });
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    await t.db.update(employees).set({ exitDate: today }).where(eq(employees.id, u.employeeId));
    expect(await validateSession(t.db, res.token)).toMatchObject({ ok: false, reason: "user_inactive" });
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, res.sessionId));
    expect(s!.revokeReason).toBe("exit_date");
    await expectAuthError(loginWithPassword({ username: u.username, password: u.password }), "ACCOUNT_INACTIVE");
  });

  it("resolver getActorContext(request) membaca cookie equa_session; keluar mencabut sesi", async () => {
    const res = await loginWithPassword({ username: "dispatcher1", password: SEED_DEMO_PASSWORD });
    const request = new Request("http://localhost/api/export/core.rbac_matrix", { headers: { cookie: `lain=1; equa_session=${res.token}` } });
    expect((await getActorContext(request))?.userId).toBe(userIdByUsername("dispatcher1"));
    expect(await getActorContext(new Request("http://localhost/x"))).toBeNull();
    await logout(res.token);
    expect(await getActorContext(request)).toBeNull();
    const logs = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, res.userId), eq(accessLogs.event, "logout")));
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});
