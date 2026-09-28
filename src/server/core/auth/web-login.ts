/**
 * Alur masuk web kantor (US-M10-02 KP-4; PTB-35; NFR-09):
 *
 * 1. `loginWithPassword({ username, password })` — argon2; pesan gagal seragam (tanpa membocorkan nama pengguna —
 *    nama tak dikenal juga "terkunci" setelah PAR-36 percobaan, lihat `phantomFailure`); penguncian setelah percobaan
 *    gagal berulang (PAR-36: jumlah & menit, hitungan dinaikkan ATOMIK di DB); batas percobaan gagal per IP;
 *    akun non-aktif / menunggu persetujuan / lewat tanggal keluar ditolak; hanya peran berantarmuka `web`
 *    (`ROLE_CATALOG.interfaces`) — akun lapangan/Kasir ke aplikasi lapangan/POS, pemilik mitra ke portal.
 * 2. Peran wajib 2FA (pemilik, Admin Keuangan, admin sistem — `ROLE_CATALOG.requires2fa`): sesi dibuat "menunggu 2FA"
 *    → `verifyTotpLogin(token, code)`, atau bila belum pernah terdaftar → `startTotpEnrollment` +
 *    `confirmTotpEnrollment`. Hitungan gagal kata sandi TIDAK direset sebelum 2FA berhasil; kode 2FA salah memakai
 *    penghitung terpisah (`users.totp_failed_count`, tidak direset login kata sandi) → PAR-36 mengunci akun; satu sesi
 *    menunggu 2FA hanya boleh `TOTP_SESSION_MAX_ATTEMPTS` kali salah lalu dicabut. Rahasia 2FA terdaftar yang tidak
 *    terbaca (kunci berganti) → login DITOLAK sampai admin sistem mereset 2FA (`resetTotp`, berjejak) — tidak pernah
 *    mendaftar ulang hanya dengan kata sandi.
 * 3. `logout(token)`.
 *
 * Semua kejadian dicatat di `access_logs` (login berhasil/gagal, kode 2FA salah, keluar).
 */
import "server-only";

import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";

import { accessLogs, employees, users } from "@/db/schema";
import type { RoleCode } from "@/lib/labels";
import { formatJam, toBusinessDate } from "@/lib/time";

import { logAccess } from "../access-log";
import { buildActorContext } from "../actor";
import { record as auditRecord } from "../audit";
import type { ActorContext } from "../context";
import { getDb, withTx, type Tx } from "../db";
import { get as getParam } from "../params-read";
import { ROLE_CATALOG, rolesAllowInterface } from "../rbac/roles";
import { NotFoundError, ValidationError } from "../errors";
import { notify } from "../notifications/service";
import { authorize, runService } from "../rbac/authorize";
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

/** Percobaan gagal (kata sandi / 2FA) maksimal per IP per 15 menit — menahan tebakan massal lintas akun. */
export const WEB_LOGIN_MAX_FAILURES_PER_IP_15_MIN = 30;
/** Kode 2FA salah maksimal per sesi menunggu 2FA; setelahnya sesi dicabut (wajib kata sandi lagi). */
export const TOTP_SESSION_MAX_ATTEMPTS = 3;

type FailureCounter = "password" | "totp";

/**
 * Catat kegagalan & kunci akun bila mencapai batas PAR-36. Hitungan dinaikkan ATOMIK di DB (`count = count + 1
 * RETURNING`) sehingga permintaan paralel tidak saling menimpa. Mengembalikan waktu kunci bila terkunci.
 */
async function registerFailure(tx: Tx, userId: string, now: Date, counter: FailureCounter = "password"): Promise<Date | null> {
  const { max_attempts, lock_minutes } = await getParam(tx, "PAR-36", toBusinessDate(now));
  const column = counter === "password" ? users.failedLoginCount : users.totpFailedCount;
  const key = counter === "password" ? "failedLoginCount" : "totpFailedCount";
  const [row] = await tx
    .update(users)
    .set({ [key]: sql`${column} + 1`, updatedAt: now })
    .where(eq(users.id, userId))
    .returning({ count: column });
  const failures = Number(row?.count ?? 0);
  if (failures < max_attempts) return null;
  const lockedUntil = new Date(now.getTime() + lock_minutes * 60_000);
  await tx
    .update(users)
    .set({ [key]: 0, lockedUntil, updatedAt: now })
    .where(eq(users.id, userId));
  return lockedUntil;
}

/** Jumlah percobaan gagal dari IP ini dalam 15 menit terakhir. */
async function recentIpFailures(tx: Tx, ip: string | null | undefined, now: Date): Promise<number> {
  if (!ip) return 0;
  const rows = await tx
    .select({ n: count() })
    .from(accessLogs)
    .where(
      and(
        inArray(accessLogs.event, ["login_failed", "totp_failed"]),
        eq(accessLogs.success, false),
        eq(accessLogs.ip, ip),
        gte(accessLogs.occurredAt, new Date(now.getTime() - 15 * 60_000)),
        lte(accessLogs.occurredAt, now),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

async function assertIpNotThrottled(tx: Tx, ip: string | null | undefined, now: Date): Promise<void> {
  if ((await recentIpFailures(tx, ip, now)) >= WEB_LOGIN_MAX_FAILURES_PER_IP_15_MIN) {
    throw new AuthError("LOGIN_RATE_LIMITED", "Terlalu banyak percobaan masuk yang gagal dari jaringan ini. Tunggu 15 menit lalu coba lagi.");
  }
}

/**
 * Nama pengguna TIDAK dikenal diperlakukan sama dengan akun nyata (NFR-09): kegagalan dihitung per string nama
 * (dari `access_logs`) dan setelah PAR-36 kali dibalas "terkunci" dengan jam buka yang sama polanya — nama pengguna
 * tidak dapat dienumerasi lewat pesan kunci.
 */
async function phantomFailure(
  tx: Tx,
  username: string,
  now: Date,
  base: { ip: string | null; userAgent: string | null; occurredAt: Date },
): Promise<AuthError> {
  const { max_attempts, lock_minutes } = await getParam(tx, "PAR-36", toBusinessDate(now));
  const attempted = username.slice(0, 100);
  const rows = await tx
    .select({ details: accessLogs.details })
    .from(accessLogs)
    .where(
      and(
        eq(accessLogs.event, "login_failed"),
        isNull(accessLogs.userId),
        sql`lower(${accessLogs.usernameAttempted}) = ${attempted.toLowerCase()}`,
        gte(accessLogs.occurredAt, new Date(now.getTime() - 86_400_000)),
      ),
    )
    .orderBy(desc(accessLogs.occurredAt))
    .limit(50);
  let failures = 0;
  for (const row of rows) {
    const d = (row.details ?? {}) as { lockedUntil?: string; duringLock?: boolean };
    if (d.lockedUntil) {
      const until = new Date(d.lockedUntil);
      if (until.getTime() > now.getTime()) {
        await logAccess(tx, { ...base, event: "login_failed", success: false, usernameAttempted: attempted, reason: "Akun terkunci sementara", details: { duringLock: true } });
        return new AuthError("ACCOUNT_LOCKED", lockedMessage(until), { lockedUntil: until.toISOString() });
      }
      break;
    }
    if (!d.duringLock) failures++;
  }
  if (failures + 1 >= max_attempts) {
    const until = new Date(now.getTime() + lock_minutes * 60_000);
    await logAccess(tx, {
      ...base,
      event: "login_failed",
      success: false,
      usernameAttempted: attempted,
      reason: "Nama pengguna tidak dikenal — dikunci (PAR-36)",
      details: { lockedUntil: until.toISOString() },
    });
    return new AuthError("ACCOUNT_LOCKED", lockedMessage(until), { lockedUntil: until.toISOString() });
  }
  await logAccess(tx, { ...base, event: "login_failed", success: false, usernameAttempted: attempted, reason: "Nama pengguna tidak dikenal" });
  return new AuthError("AUTH_FAILED", INVALID_CREDENTIALS);
}

function requires2fa(ctx: ActorContext): boolean {
  return ctx.roles.some((r) => ROLE_CATALOG[r]?.requires2fa);
}

/** Antarmuka login (`ROLE_CATALOG.interfaces`): web kantor (bawaan) atau portal pemilik mitra (RL-7, Tahap 3). */
export type LoginInterface = "web" | "portal";
export { rolesAllowInterface };

/** Pesan untuk akun yang tidak memakai antarmuka ini (Kasir → POS, lapangan → aplikasi lapangan, mitra → portal). */
function wrongInterface(roles: readonly RoleCode[], iface: LoginInterface): AuthError {
  if (rolesAllowInterface(roles, "portal") && iface !== "portal") {
    return new AuthError("PORTAL_ACCOUNT", "Akun pemilik mitra masuk lewat portal mitra, bukan web kantor.");
  }
  if (roles.some((r) => ROLE_CATALOG[r]?.isFieldRole)) {
    return new AuthError(
      "FIELD_ACCOUNT",
      "Akun lapangan & Kasir masuk lewat aplikasi lapangan/POS dengan PIN di perangkat terdaftar, bukan lewat web kantor.",
    );
  }
  return new AuthError("NO_WEB_ACCESS", "Akun Anda tidak memiliki akses ke antarmuka ini. Hubungi admin sistem.");
}

/** Pesan status akun yang tidak dapat masuk (hanya ditampilkan setelah kata sandi benar). */
function inactiveMessage(user: UserRow, now: Date): string {
  if (user.status === "pending_approval") return "Akun Anda belum aktif karena masih menunggu persetujuan pemilik. Hubungi admin sistem.";
  if (user.exitDate && user.exitDate <= toBusinessDate(now)) return "Akun Anda sudah dinonaktifkan (tanggal keluar). Hubungi admin sistem bila ini keliru.";
  return "Akun Anda tidak aktif. Hubungi admin sistem.";
}

/** Langkah 1: nama pengguna + kata sandi. `options.interface` = antarmuka tujuan (bawaan web kantor). */
export async function loginWithPassword(
  input: { username: string; password: string },
  meta: RequestMeta = {},
  options: { interface?: LoginInterface } = {},
): Promise<LoginResult> {
  const now = meta.now ?? new Date();
  const username = String(input.username ?? "").trim();
  const password = String(input.password ?? "");
  const iface = options.interface ?? "web";
  const db = getDb();
  const base = { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, occurredAt: now };

  await assertIpNotThrottled(db, meta.ip, now);

  const user = username ? await findUserByUsername(db, username) : null;
  if (!user) {
    await burnVerify(password);
    throw await withTx((tx) => phantomFailure(tx, username, now, base));
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
      const until = await registerFailure(tx, user.id, now, "password");
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
  if (!rolesAllowInterface(ctx.roles, iface)) {
    const error = wrongInterface(ctx.roles, iface);
    await logAccess(db, { ...logBase, event: "login_failed", success: false, reason: `Peran tanpa antarmuka ${iface} (${error.code})` });
    throw error;
  }

  const need2fa = requires2fa(ctx);
  // Terdaftar = pernah dikonfirmasi. Rahasia terdaftar yang TIDAK terbaca (SESSION_SECRET dirotasi, `plain:` di
  // produksi, kunci deploy lain) tidak boleh berujung pendaftaran ulang hanya dengan kata sandi (PTB-35).
  const totpRegistered = user.totpEnabled || !!user.totpConfirmedAt;
  const stored = need2fa && totpRegistered ? readTotpSecret(user.totpSecretEnc) : null;
  if (need2fa && totpRegistered && !stored) {
    await withTx(async (tx) => {
      await logAccess(tx, { ...logBase, event: "login_failed", success: false, reason: "Rahasia 2FA terdaftar tidak terbaca — perlu reset admin sistem" });
      await notify(tx, {
        event: "auth.totp_unreadable",
        tenantId: user.tenantId,
        title: `2FA ${user.fullName} perlu direset`,
        body: "Rahasia verifikasi 2 langkah tidak dapat dibaca server (kunci berganti). Login ditolak sampai admin sistem mereset 2FA.",
        objectType: "user",
        objectId: user.id,
        link: "/akses/pengguna",
        groupKey: `totp_unreadable:${user.id}`,
        now,
      });
    });
    throw new AuthError("TOTP_RESET_REQUIRED", "Verifikasi 2 langkah perlu direset admin sistem. Hubungi admin sistem atau pemilik.");
  }
  const next: LoginStep = !need2fa ? "done" : stored ? "totp" : "totp_enroll";

  return withTx(async (tx) => {
    await tx
      .update(users)
      .set({
        // Hitungan gagal & kunci hanya direset setelah login SELESAI (tanpa 2FA di sini; dengan 2FA saat kodenya benar).
        ...(next === "done" ? { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } : {}),
        ...(stored?.reencrypted ? { totpSecretEnc: stored.reencrypted } : {}),
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

/** Kode 2FA salah yang sudah tercatat untuk satu sesi menunggu 2FA. */
async function sessionTotpFailures(tx: Tx, sessionId: string): Promise<number> {
  const rows = await tx
    .select({ n: count() })
    .from(accessLogs)
    .where(and(eq(accessLogs.event, "totp_failed"), sql`${accessLogs.details} ->> 'sessionId' = ${sessionId}`));
  return Number(rows[0]?.n ?? 0);
}

async function totpFailure(tx: Tx, pending: PendingSession, now: Date, meta: RequestMeta): Promise<never> {
  // Penghitung 2FA terpisah (tidak direset login kata sandi) → PAR-36 mengunci akun.
  const lockedUntil = await registerFailure(tx, pending.user.id, now, "totp");
  const sessionFailures = (await sessionTotpFailures(tx, pending.session.id)) + 1;
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
    throw new AuthError("ACCOUNT_LOCKED", lockedMessage(lockedUntil), { lockedUntil: lockedUntil.toISOString() });
  }
  if (sessionFailures >= TOTP_SESSION_MAX_ATTEMPTS) {
    await revokeSession(tx, pending.session.id, "totp_attempts", now);
    throw new AuthError("TOTP_ATTEMPTS_EXCEEDED", "Terlalu banyak kode verifikasi salah. Silakan masuk lagi dengan kata sandi.");
  }
  throw new AuthError("TOTP_INVALID", "Kode verifikasi salah atau sudah kedaluwarsa. Periksa jam ponsel lalu masukkan kode terbaru.");
}

/**
 * Verifikasi kode TOTP untuk sesi menunggu 2FA. Galat 2FA/penguncian di-commit (bukan rollback) agar hitungan gagal
 * tersimpan.
 */
export async function verifyTotpLogin(token: string, code: string, meta: RequestMeta = {}): Promise<{ sessionId: string; userId: string }> {
  const now = meta.now ?? new Date();
  await assertIpNotThrottled(getDb(), meta.ip, now);
  const outcome = await withTx(async (tx) => {
    const pending = await requirePendingSession(tx, token, now);
    if (pending.user.lockedUntil && pending.user.lockedUntil.getTime() > now.getTime()) {
      await revokeSession(tx, pending.session.id, "totp_locked", now);
      return { error: new AuthError("ACCOUNT_LOCKED", lockedMessage(pending.user.lockedUntil), { lockedUntil: pending.user.lockedUntil.toISOString() }) };
    }
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
      .set({
        failedLoginCount: 0,
        totpFailedCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
        updatedAt: now,
        ...(stored.reencrypted ? { totpSecretEnc: stored.reencrypted } : {}),
      })
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

/** Pendaftaran hanya untuk akun yang belum pernah mendaftarkan 2FA (atau sudah direset admin sistem). */
function assertEnrollmentAllowed(user: UserRow): void {
  if (!user.totpEnabled && !user.totpConfirmedAt) return;
  if (readTotpSecret(user.totpSecretEnc)) {
    throw new AuthError("TOTP_REQUIRED", "Verifikasi 2 langkah sudah aktif. Masukkan kode dari aplikasi autentikator.");
  }
  throw new AuthError("TOTP_RESET_REQUIRED", "Verifikasi 2 langkah perlu direset admin sistem. Hubungi admin sistem atau pemilik.");
}

/**
 * Mulai pendaftaran 2FA untuk sesi menunggu 2FA yang BELUM PERNAH terdaftar (`totp_enabled = false` dan
 * `totp_confirmed_at` kosong). Rahasia tertunda disimpan terenkripsi (`totp_enabled = false`) dan dipakai ulang bila
 * halaman dimuat ulang. Akun yang sudah terdaftar (termasuk rahasianya tidak terbaca) hanya dapat didaftarkan ulang
 * setelah `resetTotp` oleh admin sistem.
 */
export async function startTotpEnrollment(token: string, meta: RequestMeta = {}): Promise<TotpEnrollment> {
  const now = meta.now ?? new Date();
  return withTx(async (tx) => {
    const pending = await requirePendingSession(tx, token, now);
    assertEnrollmentAllowed(pending.user);
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
    assertEnrollmentAllowed(pending.user);
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
        totpFailedCount: 0,
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

const resetReasonSchema = z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }).max(500);

/**
 * Reset 2FA pengguna oleh admin sistem (izin `m10.user.reset_totp`; 7.10.6, PTB-35): rahasia & status terdaftar
 * dihapus, SEMUA sesi pengguna dicabut, dicatat di audit + log akses, pemilik diberi tahu. Login berikutnya meminta
 * pendaftaran 2FA baru. M10 memanggilnya dari halaman pengguna (setelah persetujuan pemilik bila diwajibkan modul).
 */
export async function resetTotp(ctx: ActorContext, userId: string, reason: string, opts: { tx?: Tx } = {}): Promise<void> {
  await authorize(ctx, "m10.user.reset_totp", { tx: opts.tx, objectType: "user", objectId: userId });
  const why = parseResetReason(reason);
  await runService(ctx, opts, async (tx) => {
    const user = await loadUser(tx, userId);
    if (!user || user.tenantId !== ctx.tenantId) throw new NotFoundError("Pengguna tidak ditemukan.");
    await tx
      .update(users)
      .set({ totpSecretEnc: null, totpEnabled: false, totpConfirmedAt: null, totpFailedCount: 0, updatedAt: ctx.now })
      .where(eq(users.id, userId));
    await revokeAllSessions(userId, "totp_reset", { tx, now: ctx.now, actorUserId: ctx.userId });
    await auditRecord(tx, {
      ctx,
      objectType: "user",
      objectId: userId,
      action: "update",
      before: { totpEnabled: user.totpEnabled },
      after: { totpEnabled: false },
      reason: why,
    });
    await logAccess(tx, { event: "totp_reset", tenantId: ctx.tenantId, userId, reason: why, details: { by: ctx.userId }, occurredAt: ctx.now });
    await notify(tx, {
      event: "user.totp_reset",
      tenantId: ctx.tenantId,
      title: `2FA ${user.fullName} direset admin sistem`,
      body: `Alasan: ${why}`,
      objectType: "user",
      objectId: userId,
      link: "/akses/pengguna",
      now: ctx.now,
    });
  });
}

function parseResetReason(reason: string): string {
  const parsed = resetReasonSchema.safeParse(reason);
  if (!parsed.success) throw ValidationError.field("reason", parsed.error.issues[0]?.message ?? "Alasan wajib diisi.");
  return parsed.data;
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
