/**
 * Login lapangan dengan PIN di perangkat terdaftar (US-M10-02 KP-2/KP-3/KP-5; US-M3-10 KP-1; PAR-36).
 *
 * - Aktivasi akun di perangkat: admin sistem membuat kode sekali pakai (`issuePinEnrollment`, "di hadapan admin
 *   sistem", juga untuk reset PIN) → pengguna memasukkan kode di perangkat lalu menetapkan PIN sendiri (`enrollPin`).
 * - `pinLogin` daring: verifikasi hash argon2; 5 salah (PAR-36) → kunci 15 menit + notifikasi admin sistem.
 * - Keduanya membuat sesi lapangan (`sessions.kind = 'device'`, terikat perangkat) dan mengembalikan VERIFIER PIN
 *   (PBKDF2-SHA256 + salt, bukan PIN) agar perangkat dapat memverifikasi login PIN OFFLINE (NFR-10).
 * - Pengguna yang boleh memakai perangkat: pemegang terdaftar; lingkup truk/outlet/sumber air perangkat; jadwal kru
 *   hari itu (truk); perangkat cadangan → semua pengguna lapangan.
 */
import "server-only";

import { and, count, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { accessLogs, crewAssignments, crewRosters, devices, employees, pinEnrollments, userRoles, users, userScopes } from "@/db/schema";
import { label, type RoleCode } from "@/lib/labels";
import { formatJam, toBusinessDate } from "@/lib/time";

import { logAccess } from "../access-log";
import { buildActorContext } from "../actor";
import { record as auditRecord } from "../audit";
import type { ActorContext } from "../context";
import { withTx, type Tx } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import { notify } from "../notifications/service";
import { get as getParam } from "../params-read";
import { authorize, runService } from "../rbac/authorize";
import { ROLE_CATALOG } from "../rbac/roles";
import { computePinVerifier, fieldCommandKey, formatCode, hashCode, normalizeCode, randomCode, type PinVerifier } from "./crypto";
import type { DeviceAuth } from "./device-auth";
import { deviceSource, logDeviceUsage, type DeviceRow } from "./devices";
import { AuthError } from "./errors";
import { applyCrewScope } from "./field-scope";
import { hashPin, isPinFormat, verifySecretHash } from "./password";
import { createSession, isUserUsable, revokeAllSessions } from "./session";

/** Masa berlaku kode aktivasi akun lapangan. */
export const PIN_ENROLLMENT_TTL_HOURS = 24;
/** Batas percobaan kode aktivasi akun gagal per perangkat per 15 menit. */
export const PIN_ENROLLMENT_MAX_FAILURES_PER_15_MIN = 10;
/**
 * Batas PIN salah daring per perangkat per 15 menit (semua pengguna) — menahan tebakan bergilir antar-akun, terutama
 * di perangkat cadangan yang boleh dipakai semua pengguna lapangan tenant (PAR-36 berlaku per akun).
 */
export const PIN_LOGIN_MAX_FAILURES_PER_DEVICE_15_MIN = 20;

export const FIELD_ROLES: readonly RoleCode[] = ["driver", "helper", "depot_operator", "store_cashier", "production_operator"];

export type FieldUserInfo = {
  id: string;
  username: string;
  name: string;
  employeeId: string;
  roles: RoleCode[];
  roleLabel: string;
};

export type DeviceUserInfo = { id: string; name: string; roleLabel: string; hasPin: boolean };

export type FieldLoginResult = {
  sessionId: string;
  expiresAt: string;
  user: FieldUserInfo;
  verifier: PinVerifier;
  /**
   * Kunci perintah sesi (base64url 32 byte) untuk menandatangani perintah outbox pengguna ini
   * (`src/lib/sync-signature.ts`). Perangkat menyimpannya TERBUNGKUS kunci turunan PIN — bukan teks biasa.
   */
  commandKey: string;
  /** Kebijakan kunci untuk klien (PAR-36 & PAR-37) — dipakai juga saat offline. */
  policy: { maxAttempts: number; lockMinutes: number; idleMinutes: number };
  serverTime: string;
};

type Candidate = { id: string; username: string; fullName: string; nickname: string | null; employeeId: string; status: string; exitDate: string | null };

function displayName(c: Pick<Candidate, "fullName" | "nickname">): string {
  return c.fullName;
}

async function activeRoles(tx: Tx, userIds: string[], today: string): Promise<Map<string, RoleCode[]>> {
  const out = new Map<string, RoleCode[]>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select({ userId: userRoles.userId, role: userRoles.role })
    .from(userRoles)
    .where(
      and(
        inArray(userRoles.userId, userIds),
        eq(userRoles.status, "active"),
        or(isNull(userRoles.validFrom), lte(userRoles.validFrom, today)),
        or(isNull(userRoles.validUntil), gte(userRoles.validUntil, today)),
      ),
    );
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.role as RoleCode]);
  return out;
}

function fieldRoleLabel(roles: RoleCode[]): string {
  const field = roles.filter((r) => FIELD_ROLES.includes(r));
  return (field.length ? field : roles).map((r) => label("role", r)).join(", ");
}

/**
 * Pengguna yang boleh login di perangkat ini (hari bisnis `today`). Mengembalikan kandidat + perannya.
 */
async function eligibleUsers(tx: Tx, device: DeviceRow, today: string): Promise<{ candidate: Candidate; roles: RoleCode[] }[]> {
  const ids = new Set<string>();
  const scopeRef = device.truckId
    ? { type: "truck" as const, id: device.truckId }
    : device.outletId
      ? { type: "outlet" as const, id: device.outletId }
      : device.waterSourceId
        ? { type: "water_source" as const, id: device.waterSourceId }
        : null;
  if (scopeRef) {
    const rows = await tx
      .select({ userId: userScopes.userId })
      .from(userScopes)
      .where(
        and(
          eq(userScopes.scopeType, scopeRef.type),
          eq(userScopes.refId, scopeRef.id),
          eq(userScopes.status, "active"),
          or(isNull(userScopes.validFrom), lte(userScopes.validFrom, today)),
          or(isNull(userScopes.validUntil), gte(userScopes.validUntil, today)),
        ),
      );
    rows.forEach((r) => ids.add(r.userId));
  }
  const employeeIds = new Set<string>();
  if (device.holderEmployeeId) employeeIds.add(device.holderEmployeeId);
  if (device.truckId) {
    const assigned = await tx
      .select({ employeeId: crewAssignments.driverEmployeeId })
      .from(crewAssignments)
      .where(and(eq(crewAssignments.truckId, device.truckId), eq(crewAssignments.businessDate, today), isNull(crewAssignments.supersededAt)));
    assigned.forEach((a) => employeeIds.add(a.employeeId));
    const rostered = await tx
      .select({ employeeId: crewRosters.employeeId })
      .from(crewRosters)
      .where(and(eq(crewRosters.truckId, device.truckId), eq(crewRosters.businessDate, today), eq(crewRosters.status, "on_duty")));
    rostered.forEach((r) => employeeIds.add(r.employeeId));
  }
  const where = [eq(users.tenantId, device.tenantId)];
  const idFilters = [];
  if (ids.size) idFilters.push(inArray(users.id, [...ids]));
  if (employeeIds.size) idFilters.push(inArray(users.employeeId, [...employeeIds]));
  if (!device.isSpare && idFilters.length === 0) return [];
  const candidates = await tx
    .select({
      id: users.id,
      username: users.username,
      fullName: employees.fullName,
      nickname: employees.nickname,
      employeeId: users.employeeId,
      status: users.status,
      exitDate: employees.exitDate,
    })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(and(...where, ...(device.isSpare ? [] : [or(...idFilters)!])));
  const roles = await activeRoles(
    tx,
    candidates.map((c) => c.id),
    today,
  );
  return candidates
    .map((candidate) => ({ candidate, roles: roles.get(candidate.id) ?? [] }))
    .filter(({ candidate, roles: r }) => candidate.status === "active" && (!candidate.exitDate || candidate.exitDate > today) && r.some((x) => FIELD_ROLES.includes(x)));
}

/** Daftar pengguna lapangan yang boleh memakai perangkat (untuk layar "Siapa yang memakai ponsel ini?"). */
export async function listDeviceUsers(tx: Tx, device: DeviceRow, now: Date = new Date()): Promise<DeviceUserInfo[]> {
  const today = toBusinessDate(now);
  const list = await eligibleUsers(tx, device, today);
  const withPin = new Set(
    list.length
      ? (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(and(inArray(users.id, list.map((l) => l.candidate.id)), sql`${users.pinHash} is not null`))
        ).map((r) => r.id)
      : [],
  );
  return list
    .map(({ candidate, roles }) => ({ id: candidate.id, name: displayName(candidate), roleLabel: fieldRoleLabel(roles), hasPin: withPin.has(candidate.id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "id"));
}

async function assertAllowedOnDevice(tx: Tx, device: DeviceRow, userId: string, now: Date): Promise<{ candidate: Candidate; roles: RoleCode[] }> {
  const list = await eligibleUsers(tx, device, toBusinessDate(now));
  const found = list.find((l) => l.candidate.id === userId);
  if (!found) {
    throw new AuthError("USER_NOT_ALLOWED_ON_DEVICE", "Akun Anda tidak terdaftar untuk perangkat ini. Hubungi admin sistem atau Dispatcher.");
  }
  return found;
}

/** Konteks pelaku lapangan untuk pengguna di perangkat (sumber field/pos, lingkup truk harian untuk sopir/kernet). */
export async function buildFieldActorContext(
  tx: Tx,
  device: DeviceRow,
  userId: string,
  options: { now?: Date; deviceTime?: Date; businessDate?: string } = {},
): Promise<ActorContext> {
  const now = options.now ?? new Date();
  const ctx = await buildActorContext(tx, userId, {
    source: deviceSource(device),
    deviceId: device.id,
    now,
    deviceTime: options.deviceTime,
    businessDate: options.businessDate,
  });
  return applyCrewScope(tx, ctx, options.businessDate ?? toBusinessDate(options.deviceTime ?? now));
}

async function pinPolicy(tx: Tx, now: Date): Promise<FieldLoginResult["policy"]> {
  const day = toBusinessDate(now);
  const lock = await getParam(tx, "PAR-36", day);
  const idle = await getParam(tx, "PAR-37", day);
  return { maxAttempts: lock.max_attempts, lockMinutes: lock.lock_minutes, idleMinutes: idle.idle_minutes };
}

function pinLockedMessage(until: Date): string {
  return `PIN terkunci karena terlalu banyak salah. Coba lagi pukul ${formatJam(until)} atau hubungi admin sistem.`;
}

async function completeFieldLogin(
  tx: Tx,
  auth: DeviceAuth,
  found: { candidate: Candidate; roles: RoleCode[] },
  pin: string,
  method: "pin" | "pin_enroll",
): Promise<FieldLoginResult> {
  const { device, now } = auth;
  const { session } = await createSession(tx, { userId: found.candidate.id, kind: "device", deviceId: device.id, now, ip: auth.ip, userAgent: auth.userAgent });
  await tx
    .update(users)
    .set({ pinFailedCount: 0, pinLockedUntil: null, lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, found.candidate.id));
  await tx.update(devices).set({ lastUserId: found.candidate.id, lastSeenAt: now }).where(eq(devices.id, device.id));
  await logAccess(tx, {
    event: "login_success",
    tenantId: device.tenantId,
    userId: found.candidate.id,
    deviceId: device.id,
    ip: auth.ip,
    userAgent: auth.userAgent,
    details: { method, sessionId: session.id },
    occurredAt: now,
  });
  await logDeviceUsage(tx, { tenantId: device.tenantId, deviceId: device.id, userId: found.candidate.id, event: "login", occurredAt: now, appVersion: auth.appVersion, details: { method } });
  return {
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
    user: {
      id: found.candidate.id,
      username: found.candidate.username,
      name: displayName(found.candidate),
      employeeId: found.candidate.employeeId,
      roles: found.roles,
      roleLabel: fieldRoleLabel(found.roles),
    },
    verifier: await computePinVerifier(pin),
    commandKey: fieldCommandKey(session.id),
    policy: await pinPolicy(tx, now),
    serverTime: now.toISOString(),
  };
}

async function recentDevicePinFailures(tx: Tx, deviceId: string, now: Date): Promise<number> {
  const rows = await tx
    .select({ n: count() })
    .from(accessLogs)
    .where(
      and(
        eq(accessLogs.deviceId, deviceId),
        inArray(accessLogs.event, ["pin_failed", "pin_locked"]),
        isNull(accessLogs.objectType),
        gte(accessLogs.occurredAt, new Date(now.getTime() - 15 * 60_000)),
        lte(accessLogs.occurredAt, now),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Login PIN daring di perangkat terdaftar. Hitungan salah & kunci di-commit walau login gagal. Hitungan dinaikkan
 * ATOMIK (`pin_failed_count = pin_failed_count + 1 RETURNING`) sehingga tebakan paralel tidak melewati PAR-36.
 */
export async function pinLogin(auth: DeviceAuth, input: { userId: string; pin: string }): Promise<FieldLoginResult> {
  const { device, now } = auth;
  const outcome = await withTx(async (tx) => {
    if ((await recentDevicePinFailures(tx, device.id, now)) >= PIN_LOGIN_MAX_FAILURES_PER_DEVICE_15_MIN) {
      throw new AuthError("PIN_RATE_LIMITED", "Terlalu banyak PIN salah di perangkat ini. Tunggu 15 menit atau hubungi admin sistem.");
    }
    const userRows = await tx.select().from(users).where(eq(users.id, String(input.userId ?? ""))).limit(1);
    const user = userRows[0];
    if (!user || user.tenantId !== device.tenantId) throw new AuthError("PIN_INVALID", "Pengguna tidak dikenal di perangkat ini.");
    const found = await assertAllowedOnDevice(tx, device, user.id, now);
    if (user.pinLockedUntil && user.pinLockedUntil.getTime() > now.getTime()) {
      throw new AuthError("PIN_LOCKED", pinLockedMessage(user.pinLockedUntil), { lockedUntil: user.pinLockedUntil.toISOString() });
    }
    if (!user.pinHash) throw new AuthError("PIN_NOT_SET", "PIN belum dibuat. Minta kode aktivasi akun ke admin sistem.");
    const ok = isPinFormat(input.pin) && (await verifySecretHash(user.pinHash, input.pin));
    if (!ok) {
      const policy = await pinPolicy(tx, now);
      const [counted] = await tx
        .update(users)
        .set({ pinFailedCount: sql`${users.pinFailedCount} + 1`, updatedAt: now })
        .where(eq(users.id, user.id))
        .returning({ failed: users.pinFailedCount });
      const failed = Number(counted?.failed ?? 0);
      const lockedUntil = failed >= policy.maxAttempts ? new Date(now.getTime() + policy.lockMinutes * 60_000) : null;
      if (lockedUntil) {
        await tx.update(users).set({ pinFailedCount: 0, pinLockedUntil: lockedUntil, updatedAt: now }).where(eq(users.id, user.id));
      }
      await logAccess(tx, {
        event: lockedUntil ? "pin_locked" : "pin_failed",
        success: false,
        tenantId: device.tenantId,
        userId: user.id,
        deviceId: device.id,
        ip: auth.ip,
        userAgent: auth.userAgent,
        reason: lockedUntil ? "PIN salah berturut — dikunci (PAR-36)" : "PIN salah",
        occurredAt: now,
      });
      await logDeviceUsage(tx, { tenantId: device.tenantId, deviceId: device.id, userId: user.id, event: lockedUntil ? "pin_locked" : "pin_failed", occurredAt: now });
      if (lockedUntil) {
        await notify(tx, {
          event: "device.pin_locked",
          tenantId: device.tenantId,
          title: `PIN ${found.candidate.fullName} terkunci`,
          body: `${policy.maxAttempts} kali PIN salah di perangkat ${device.deviceCode}. Terkunci sampai pukul ${formatJam(lockedUntil)}.`,
          objectType: "user",
          objectId: user.id,
          link: "/akses/pengguna",
          now,
        });
        return { error: new AuthError("PIN_LOCKED", pinLockedMessage(lockedUntil), { lockedUntil: lockedUntil.toISOString() }) };
      }
      const left = Math.max(0, policy.maxAttempts - failed);
      return { error: new AuthError("PIN_INVALID", `PIN salah. Sisa ${left} kali percobaan sebelum terkunci.`, { attemptsLeft: left }) };
    }
    return { result: await completeFieldLogin(tx, auth, found, input.pin, "pin") };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

async function recentEnrollmentFailures(tx: Tx, deviceId: string, now: Date): Promise<number> {
  const rows = await tx
    .select({ n: count() })
    .from(accessLogs)
    .where(
      and(
        eq(accessLogs.deviceId, deviceId),
        eq(accessLogs.event, "pin_failed"),
        eq(accessLogs.objectType, "pin_enrollment"),
        gte(accessLogs.occurredAt, new Date(now.getTime() - 15 * 60_000)),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Aktivasi akun lapangan di perangkat: kode sekali pakai dari admin sistem + PIN baru pilihan pengguna → sesi
 * lapangan + verifier offline.
 */
export async function enrollPin(auth: DeviceAuth, input: { code: string; pin: string }): Promise<FieldLoginResult> {
  const { device, now } = auth;
  const outcome = await withTx(async (tx) => {
    if ((await recentEnrollmentFailures(tx, device.id, now)) >= PIN_ENROLLMENT_MAX_FAILURES_PER_15_MIN) {
      throw new AuthError("ACTIVATION_RATE_LIMITED", "Terlalu banyak percobaan kode. Tunggu 15 menit atau hubungi admin sistem.");
    }
    const code = normalizeCode(String(input.code ?? ""));
    const rows =
      code.length === 8
        ? await tx
            .select()
            .from(pinEnrollments)
            .where(and(eq(pinEnrollments.codeHash, hashCode("pin-enrollment", code)), isNull(pinEnrollments.usedAt), isNull(pinEnrollments.revokedAt)))
            .limit(1)
        : [];
    const enrollment = rows[0];
    if (!enrollment || enrollment.expiresAt.getTime() <= now.getTime() || enrollment.tenantId !== device.tenantId) {
      await logAccess(tx, {
        event: "pin_failed",
        success: false,
        tenantId: device.tenantId,
        deviceId: device.id,
        ip: auth.ip,
        userAgent: auth.userAgent,
        objectType: "pin_enrollment",
        reason: "Kode aktivasi akun salah/kedaluwarsa",
        occurredAt: now,
      });
      return { error: new AuthError("PIN_ENROLLMENT_INVALID", "Kode aktivasi akun salah atau kedaluwarsa. Minta kode baru ke admin sistem.") };
    }
    const found = await assertAllowedOnDevice(tx, device, enrollment.userId, now);
    const pinHash = await hashPin(input.pin);
    await tx.update(users).set({ pinHash, pinSetAt: now, pinFailedCount: 0, pinLockedUntil: null, updatedAt: now }).where(eq(users.id, enrollment.userId));
    await tx.update(pinEnrollments).set({ usedAt: now, usedDeviceId: device.id }).where(eq(pinEnrollments.id, enrollment.id));
    const ctx = await buildFieldActorContext(tx, device, enrollment.userId, { now });
    await auditRecord(tx, {
      ctx,
      objectType: "user",
      objectId: enrollment.userId,
      action: "update",
      after: { pinSet: true, device: device.deviceCode },
      reason: enrollment.purpose === "reset" ? "PIN baru setelah reset admin sistem" : "Aktivasi akun lapangan di hadapan admin sistem",
    });
    await logDeviceUsage(tx, { tenantId: device.tenantId, deviceId: device.id, userId: enrollment.userId, event: "pin_enrolled", occurredAt: now });
    return { result: await completeFieldLogin(tx, auth, found, input.pin, "pin_enroll") };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

export type PinEnrollmentIssued = { code: string; displayCode: string; expiresAt: Date; userName: string };

/**
 * Admin sistem membuat kode aktivasi akun lapangan (penetapan PIN pertama, atau reset PIN). Reset: PIN lama tidak
 * berlaku seketika, sesi lapangan pengguna dicabut, pemilik diberi tahu (US-M10-02 KP-3).
 */
export async function issuePinEnrollment(
  ctx: ActorContext,
  userId: string,
  input: { purpose?: "initial" | "reset"; reason?: string } = {},
  opts: { tx?: Tx } = {},
): Promise<PinEnrollmentIssued> {
  await authorize(ctx, "m10.user.reset_pin", { tx: opts.tx, objectType: "user", objectId: userId });
  const purpose = input.purpose ?? "initial";
  return runService(ctx, opts, async (tx) => {
    const rows = await tx
      .select({ user: users, fullName: employees.fullName, exitDate: employees.exitDate })
      .from(users)
      .innerJoin(employees, eq(employees.id, users.employeeId))
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row || row.user.tenantId !== ctx.tenantId) throw new NotFoundError("Pengguna tidak ditemukan.");
    if (!isUserUsable({ status: row.user.status, exitDate: row.exitDate }, ctx.now)) {
      throw ValidationError.field("userId", "Akun tidak aktif. Aktifkan akun terlebih dahulu.");
    }
    const roles = (await activeRoles(tx, [userId], toBusinessDate(ctx.now))).get(userId) ?? [];
    if (!roles.some((r) => ROLE_CATALOG[r]?.isFieldRole)) {
      throw ValidationError.field("userId", "PIN hanya untuk pengguna lapangan (sopir, kernet, operator, kasir).");
    }
    await tx.update(pinEnrollments).set({ revokedAt: ctx.now }).where(and(eq(pinEnrollments.userId, userId), isNull(pinEnrollments.usedAt), isNull(pinEnrollments.revokedAt)));
    const code = randomCode();
    const expiresAt = new Date(ctx.now.getTime() + PIN_ENROLLMENT_TTL_HOURS * 3_600_000);
    await tx.insert(pinEnrollments).values({
      tenantId: ctx.tenantId,
      userId,
      purpose,
      codeHash: hashCode("pin-enrollment", code),
      expiresAt,
      createdBy: ctx.userId,
      createdAt: ctx.now,
    });
    if (purpose === "reset") {
      await tx.update(users).set({ pinHash: null, pinSetAt: null, pinFailedCount: 0, pinLockedUntil: null, updatedAt: ctx.now }).where(eq(users.id, userId));
      await revokeAllSessions(userId, "pin_reset", { tx, now: ctx.now, kind: "device", actorUserId: ctx.userId });
      await logAccess(tx, {
        event: "pin_reset",
        tenantId: ctx.tenantId,
        userId,
        reason: input.reason ?? null,
        details: { by: ctx.userId },
        occurredAt: ctx.now,
      });
      await notify(tx, {
        event: "user.pin_reset",
        tenantId: ctx.tenantId,
        title: `PIN ${row.fullName} direset admin sistem`,
        body: input.reason ? `Alasan: ${input.reason}` : null,
        objectType: "user",
        objectId: userId,
        link: "/akses/pengguna",
        now: ctx.now,
      });
    }
    await auditRecord(tx, {
      ctx,
      objectType: "user",
      objectId: userId,
      action: purpose === "reset" ? "update" : "create",
      after: { pinEnrollment: purpose, expiresAt: expiresAt.toISOString() },
      reason: input.reason ?? (purpose === "reset" ? "Reset PIN" : "Kode aktivasi akun lapangan"),
    });
    return { code, displayCode: formatCode(code), expiresAt, userName: row.fullName };
  });
}
