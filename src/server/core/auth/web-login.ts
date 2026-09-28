/**
 * Alur masuk web kantor (US-M10-02 KP-4; PTB-35; NFR-09):
 *
 * 1. `loginWithPassword({ username, password })` — argon2; pesan gagal seragam (tanpa membocorkan nama pengguna);
 *    penguncian setelah percobaan gagal berulang (PAR-36: jumlah & menit); akun non-aktif / menunggu persetujuan /
 *    lewat tanggal keluar ditolak; akun khusus lapangan diarahkan ke aplikasi lapangan.
 * 2. Peran wajib 2FA (pemilik, Admin Keuangan, admin sistem — `ROLE_CATALOG.requires2fa`): sesi dibuat "menunggu 2FA"
 *    → `verifyTotpLogin(token, code)`, atau bila belum terdaftar → `startTotpEnrollment` + `confirmTotpEnrollment`.
 * 3. `logout(token)`.
 *
 * Semua kejadian dicatat di `access_logs` (login berhasil/gagal, kode 2FA salah, keluar).
 */
import "server-only";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import QRCode from "qrcode";

import { accessLogs, employees, users } from "@/db/schema";
import { formatJam, toBusinessDate } from "@/lib/time";

import { logAccess } from "../access-log";
import { buildActorContext } from "../actor";
import { record as auditRecord } from "../audit";
import type { ActorContext } from "../context";
import { getDb, withTx, type Tx } from "../db";
import { get as getParam } from "../params-read";
import { ROLE_CATALOG } from "../rbac/roles";
import { AuthError } from "./errors";
import { burnVerify, verifySecretHash } from "./password";
import { createSession, markSessionTotpVerified, revokeAllSessions, revokeSession, validateSession, type SessionRow } from "./session";
import { buildOtpAuthUrl, generateTotpSecret, readTotpSecret, sealTotpSecret, verifyTotpCode } from "./totp";

export type RequestMeta = { ip?: string | null; userAgent?: string | null; now?: Date };

export type LoginStep = "done" | "totp" | "totp_enroll";

export type LoginResult = { token: string; sessionId: string; userId: string; next: LoginStep };

const INVALID_CREDENTIALS = "Nama pengguna atau kata sandi salah. Periksa lalu coba lagi.";

type UserRow = typeof users.$inferSelect & { exitDate: string | null; fullName: string };

async function findUserByUsername(tx: Tx, username: string): Promise<UserRow | null> {
  const rows = await tx
    .select({ user: users, exitDate: employees.exitDate, fullName: employees.fullName })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(sql`lower(${users.username}) = ${username.trim().toLowerCase()}`)
    .limit(1);
  const row = rows[0];
  return row ? { ...row.user, exitDate: row.exitDate, fullName: row.fullName } : null;
}

async function loadUser(tx: Tx, userId: string): Promise<UserRow | null> {
  const rows = await tx
    .select({ user: users, exitDate: employees.exitDate, fullName: employees.fullName })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  return row ? { ...row.user, exitDate: row.exitDate, fullName: row.fullName } : null;
}

function lockedMessage(until: Date): string {
  return `Akun terkunci sementara karena terlalu banyak percobaan gagal. Coba lagi pukul ${formatJam(until)} atau hubungi admin sistem.`;
}

/** Catat kegagalan & kunci akun bila mencapai batas PAR-36. Mengembalikan waktu kunci bila terkunci. */
async function registerFailure(tx: Tx, user: UserRow, now: Date): Promise<Date | null> {
  const { max_attempts, lock_minutes } = await getParam(tx, "PAR-36", toBusinessDate(now));
  const count = user.failedLoginCount + 1;
  const lockedUntil = count >= max_attempts ? new Date(now.getTime() + lock_minutes * 60_000) : null;
  await tx
    .update(users)
    .set({ failedLoginCount: lockedUntil ? 0 : count, lockedUntil: lockedUntil ?? user.lockedUntil, updatedAt: now })
    .where(eq(users.id, user.id));
  return lockedUntil;
}

function requires2fa(ctx: ActorContext): boolean {
  return ctx.roles.some((r) => ROLE_CATALOG[r]?.requires2fa);
}

function isFieldOnly(ctx: ActorContext): boolean {
  return ctx.roles.length > 0 && ctx.roles.every((r) => ROLE_CATALOG[r]?.isFieldRole);
}

/** Pesan status akun yang tidak dapat masuk (hanya ditampilkan setelah kata sandi benar). */
function inactiveMessage(user: UserRow, now: Date): string {
  if (user.status === "pending_approval") return "Akun Anda belum aktif karena masih menunggu persetujuan pemilik. Hubungi admin sistem.";
  if (user.exitDate && user.exitDate <= toBusinessDate(now)) return "Akun Anda sudah dinonaktifkan (tanggal keluar). Hubungi admin sistem bila ini keliru.";
  return "Akun Anda tidak aktif. Hubungi admin sistem.";
}

/** Langkah 1: nama pengguna + kata sandi. */
export async function loginWithPassword(input: { username: string; password: string }, meta: RequestMeta = {}): Promise<LoginResult> {
  const now = meta.now ?? new Date();
  const username = String(input.username ?? "").trim();
  const password = String(input.password ?? "");
  const db = getDb();
  const base = { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, occurredAt: now };

  const user = username ? await findUserByUsername(db, username) : null;
  if (!user) {
    await burnVerify(password);
    await logAccess(db, { ...base, event: "login_failed", success: false, usernameAttempted: username.slice(0, 100), reason: "Nama pengguna tidak dikenal" });
    throw new AuthError("AUTH_FAILED", INVALID_CREDENTIALS);
  }
  const logBase = { ...base, tenantId: user.tenantId, userId: user.id, usernameAttempted: username.slice(0, 100) };

  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    await burnVerify(password);
    await logAccess(db, { ...logBase, event: "login_failed", success: false, reason: "Akun terkunci sementara" });
    throw new AuthError("ACCOUNT_LOCKED", lockedMessage(user.lockedUntil), { lockedUntil: user.lockedUntil.toISOString() });
  }

  if (!user.passwordHash) await burnVerify(password);
  const passwordOk = await verifySecretHash(user.passwordHash, password);
  if (!passwordOk) {
    const lockedUntil = await withTx(async (tx) => {
      const until = await registerFailure(tx, user, now);
      await logAccess(tx, { ...logBase, event: "login_failed", success: false, reason: until ? "Kata sandi salah — akun dikunci (PAR-36)" : "Kata sandi salah" });
      return until;
    });
    if (lockedUntil) throw new AuthError("ACCOUNT_LOCKED", lockedMessage(lockedUntil), { lockedUntil: lockedUntil.toISOString() });
    throw new AuthError("AUTH_FAILED", INVALID_CREDENTIALS);
  }

  if (user.status !== "active" || (user.exitDate && user.exitDate <= toBusinessDate(now))) {
    await logAccess(db, { ...logBase, event: "login_failed", success: false, reason: `Status akun: ${user.status}` });
    throw new AuthError("ACCOUNT_INACTIVE", inactiveMessage(user, now));
  }

  const ctx = await buildActorContext(db, user.id, { source: "web", now });
  if (ctx.roles.length === 0) {
    await logAccess(db, { ...logBase, event: "login_failed", success: false, reason: "Tidak ada peran aktif" });
    throw new AuthError("NO_ACTIVE_ROLE", "Akun Anda belum memiliki peran aktif. Hubungi admin sistem.");
  }
  if (isFieldOnly(ctx)) {
    await logAccess(db, { ...logBase, event: "login_failed", success: false, reason: "Akun lapangan mencoba web kantor" });
    throw new AuthError(
      "FIELD_ACCOUNT",
      "Akun lapangan masuk lewat aplikasi lapangan dengan PIN di perangkat terdaftar, bukan lewat web kantor.",
    );
  }

  const need2fa = requires2fa(ctx);
  const stored = need2fa && user.totpEnabled ? readTotpSecret(user.totpSecretEnc) : null;
  const next: LoginStep = !need2fa ? "done" : stored ? "totp" : "totp_enroll";

  return withTx(async (tx) => {
    await tx
      .update(users)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        ...(stored?.reencrypted ? { totpSecretEnc: stored.reencrypted } : {}),
        ...(next === "done" ? { lastLoginAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(users.id, user.id));
    const { token, session } = await createSession(tx, {
      userId: user.id,
      kind: "web",
      now,
      ip: meta.ip,
      userAgent: meta.userAgent,
      pending2fa: need2fa,
    });
    if (next === "done") {
      await logAccess(tx, { ...logBase, event: "login_success", details: { method: "password", sessionId: session.id } });
    }
    return { token, sessionId: session.id, userId: user.id, next };
  });
}

type PendingSession = { session: SessionRow; user: UserRow; ctx: ActorContext };

/** Sesi web yang sedang menunggu 2FA (peran wajib 2FA, belum terverifikasi). */
async function requirePendingSession(tx: Tx, token: string | null | undefined, now: Date): Promise<PendingSession> {
  const v = await validateSession(tx, token, { kind: "web", now });
  if (!v.ok) throw new AuthError("SESSION_EXPIRED", "Waktu verifikasi habis. Silakan masuk lagi dengan kata sandi.");
  const user = await loadUser(tx, v.session.userId);
  if (!user) throw new AuthError("SESSION_EXPIRED", "Silakan masuk lagi.");
  const ctx = await buildActorContext(tx, user.id, { source: "web", now });
  if (!requires2fa(ctx) || v.session.totpVerifiedAt) {
    throw new AuthError("SESSION_REQUIRED", "Verifikasi 2 langkah tidak diperlukan untuk sesi ini.");
  }
  return { session: v.session, user, ctx };
}

/** Langkah 2FA terakhir yang berhasil (pencegah pemakaian ulang kode). */
async function lastTotpTimeStep(tx: Tx, userId: string): Promise<number | null> {
  const rows = await tx
    .select({ details: accessLogs.details })
    .from(accessLogs)
    .where(and(eq(accessLogs.userId, userId), eq(accessLogs.event, "login_success"), isNotNull(accessLogs.details)))
    .orderBy(desc(accessLogs.occurredAt))
    .limit(5);
  for (const row of rows) {
    const step = row.details?.totpTimeStep;
    if (typeof step === "number") return step;
  }
  return null;
}

async function totpFailure(tx: Tx, pending: PendingSession, now: Date, meta: RequestMeta): Promise<never> {
  const lockedUntil = await registerFailure(tx, pending.user, now);
  await logAccess(tx, {
    event: "totp_failed",
    success: false,
    tenantId: pending.user.tenantId,
    userId: pending.user.id,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    reason: lockedUntil ? "Kode 2FA salah — akun dikunci (PAR-36)" : "Kode 2FA salah",
    details: { sessionId: pending.session.id },
    occurredAt: now,
  });
  if (lockedUntil) {
    await revokeAllSessions(pending.user.id, "totp_locked", { tx, now, kind: "web" });
    throw new AuthError("ACCOUNT_LOCKED", lockedMessage(lockedUntil));
  }
  throw new AuthError("TOTP_INVALID", "Kode verifikasi salah atau sudah kedaluwarsa. Periksa jam ponsel lalu masukkan kode terbaru.");
}

/**
 * Verifikasi kode TOTP untuk sesi menunggu 2FA. Galat 2FA/penguncian di-commit (bukan rollback) agar hitungan gagal
 * tersimpan.
 */
export async function verifyTotpLogin(token: string, code: string, meta: RequestMeta = {}): Promise<{ sessionId: string; userId: string }> {
  const now = meta.now ?? new Date();
  const outcome = await withTx(async (tx) => {
    const pending = await requirePendingSession(tx, token, now);
    const stored = pending.user.totpEnabled ? readTotpSecret(pending.user.totpSecretEnc) : null;
    if (!stored) throw new AuthError("TOTP_NOT_ENROLLED", "Verifikasi 2 langkah belum diaktifkan. Aktifkan terlebih dahulu.");
    const check = await verifyTotpCode(stored.secret, code, { now, afterTimeStep: await lastTotpTimeStep(tx, pending.user.id) });
    if (!check.valid) {
      try {
        await totpFailure(tx, pending, now, meta);
      } catch (error) {
        return { error };
      }
    }
    const step = check.valid ? check.timeStep : null;
    await markSessionTotpVerified(tx, pending.session, now);
    await tx
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now, ...(stored.reencrypted ? { totpSecretEnc: stored.reencrypted } : {}) })
      .where(eq(users.id, pending.user.id));
    await logAccess(tx, {
      event: "login_success",
      tenantId: pending.user.tenantId,
      userId: pending.user.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      details: { method: "password+totp", sessionId: pending.session.id, totpTimeStep: step },
      occurredAt: now,
    });
    return { sessionId: pending.session.id, userId: pending.user.id };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome;
}

export type TotpEnrollment = { secret: string; otpauthUrl: string; qrDataUrl: string; username: string };

/**
 * Mulai pendaftaran 2FA untuk sesi menunggu 2FA yang belum punya TOTP. Rahasia tertunda disimpan terenkripsi
 * (`totp_enabled = false`) dan dipakai ulang bila halaman dimuat ulang.
 */
export async function startTotpEnrollment(token: string, meta: RequestMeta = {}): Promise<TotpEnrollment> {
  const now = meta.now ?? new Date();
  return withTx(async (tx) => {
    const pending = await requirePendingSession(tx, token, now);
    if (pending.user.totpEnabled && readTotpSecret(pending.user.totpSecretEnc)) {
      throw new AuthError("TOTP_REQUIRED", "Verifikasi 2 langkah sudah aktif. Masukkan kode dari aplikasi autentikator.");
    }
    let secret = readTotpSecret(pending.user.totpSecretEnc)?.secret ?? null;
    if (!secret) {
      secret = generateTotpSecret();
      await tx.update(users).set({ totpSecretEnc: sealTotpSecret(secret), totpEnabled: false, updatedAt: now }).where(eq(users.id, pending.user.id));
    }
    const otpauthUrl = buildOtpAuthUrl(secret, pending.user.username);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 224, errorCorrectionLevel: "M" });
    return { secret, otpauthUrl, qrDataUrl, username: pending.user.username };
  });
}

/** Selesaikan pendaftaran 2FA dengan kode pertama; sesi langsung terverifikasi. */
export async function confirmTotpEnrollment(token: string, code: string, meta: RequestMeta = {}): Promise<{ sessionId: string; userId: string }> {
  const now = meta.now ?? new Date();
  const outcome = await withTx(async (tx) => {
    const pending = await requirePendingSession(tx, token, now);
    const stored = readTotpSecret(pending.user.totpSecretEnc);
    if (!stored) throw new AuthError("TOTP_NOT_ENROLLED", "Kode QR kedaluwarsa. Muat ulang halaman untuk memulai lagi.");
    const check = await verifyTotpCode(stored.secret, code, { now });
    if (!check.valid) {
      try {
        await totpFailure(tx, pending, now, meta);
      } catch (error) {
        return { error };
      }
    }
    await tx
      .update(users)
      .set({
        totpSecretEnc: stored.reencrypted ?? pending.user.totpSecretEnc,
        totpEnabled: true,
        totpConfirmedAt: now,
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, pending.user.id));
    await markSessionTotpVerified(tx, pending.session, now);
    await auditRecord(tx, {
      ctx: { ...pending.ctx, now },
      objectType: "user",
      objectId: pending.user.id,
      action: "update",
      before: { totpEnabled: false },
      after: { totpEnabled: true },
      reason: "Pendaftaran verifikasi 2 langkah oleh pengguna (PTB-35)",
    });
    await logAccess(tx, {
      event: "login_success",
      tenantId: pending.user.tenantId,
      userId: pending.user.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      details: { method: "password+totp_enroll", sessionId: pending.session.id, totpTimeStep: check.valid ? check.timeStep : null },
      occurredAt: now,
    });
    return { sessionId: pending.session.id, userId: pending.user.id };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome;
}

/** Keluar: cabut sesi web & catat. Aman dipanggil dengan token kosong/kedaluwarsa. */
export async function logout(token: string | null | undefined, meta: RequestMeta = {}): Promise<void> {
  if (!token) return;
  const now = meta.now ?? new Date();
  await withTx(async (tx) => {
    const v = await validateSession(tx, token, { now, touch: false });
    if (!v.ok) return;
    const session = v.session;
    await revokeSession(tx, session.id, "logout", now);
    await logAccess(tx, {
      event: "logout",
      userId: session.userId,
      deviceId: session.deviceId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      details: { sessionId: session.id, kind: session.kind },
      occurredAt: now,
    });
  });
}
