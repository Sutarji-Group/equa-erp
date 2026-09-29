/**
 * Sesi login (docs/ARCHITECTURE.md §6; US-M10-02 KP-4; NFR-09).
 *
 * - Token acak 32 byte (base64url) → cookie `equa_session` (web) atau dikirim ke perangkat (lapangan). Tabel
 *   `sessions` hanya menyimpan `sha256(token)`.
 * - Web: kedaluwarsa tidak aktif & maksimal dari PAR-46 (`idle_minutes`, `max_hours`). Sesi peran wajib 2FA dibuat
 *   "menunggu 2FA" (berlaku 10 menit) sampai kode TOTP benar.
 * - Lapangan (`kind = 'device'`): terikat perangkat; berlaku `FIELD_SESSION_MAX_HOURS` sejak login PIN daring (tanpa
 *   batas tidak aktif di server — kunci layar PAR-37 ditangani klien). Perintah offline pengguna diterima selama
 *   dibuat dalam masa berlaku sesi itu.
 * - `last_active_at` disentuh paling sering 1×/menit.
 * - Akun nonaktif / tanggal keluar lewat / perangkat diblokir → sesi dicabut (BR-37). `revokeAllSessions(userId)`
 *   dipanggil M10 saat menonaktifkan pengguna.
 */
import "server-only";

import { and, eq, gt, isNull, lte, ne, or, type SQL } from "drizzle-orm";

import { employees, sessions, users } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";

import { logAccess } from "../access-log";
import { getDb, isTransaction, runInTx, withTx, type Db, type Tx } from "../db";
import { get as getParam } from "../params-read";
import { randomToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "equa_session";
/** Sesi web yang belum melewati 2FA berlaku singkat. */
export const PENDING_2FA_MINUTES = 10;
/**
 * Masa berlaku sesi lapangan sejak login PIN daring. Menjamin antrean offline ≥ 1 hari penuh (PAR-30) tetap diterima
 * server; di luar itu pengguna diminta login PIN sekali saat ada sinyal. (Pengaturan keamanan teknis, bukan ambang
 * bisnis Lampiran B.)
 */
export const FIELD_SESSION_MAX_HOURS = 72;
/**
 * Perintah outbox yang dibuat selama masa berlaku sesi lapangan tetap diterima sampai sekian hari SETELAH sesi habis
 * (antrean offline, PAR-30); setelah itu sesi dicabut job `core.auth.session_hygiene` dan perintahnya wajib diikat
 * ulang lewat login PIN pemiliknya (klien `rebindOutbox`).
 */
export const FIELD_SESSION_SYNC_GRACE_DAYS = 7;
/** Interval minimum pembaruan `last_active_at`. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

export type SessionRow = typeof sessions.$inferSelect;
export type SessionKind = "web" | "device";

export type RevokeReason =
  | "logout"
  | "idle"
  | "max_age"
  | "user_inactive"
  | "exit_date"
  | "device_blocked"
  | "device_wipe"
  | "pin_reset"
  | "admin"
  | "totp_locked"
  | "totp_attempts"
  | "totp_reset"
  | "replaced";

export type SessionPolicy = { idleMinutes: number; maxHours: number };

/** Kebijakan sesi web kantor dari PAR-46 (berlaku pada tanggal bisnis `now`). */
export async function webSessionPolicy(tx: Tx, now: Date): Promise<SessionPolicy> {
  const value = await getParam(tx, "PAR-46", toBusinessDate(now));
  return { idleMinutes: value.idle_minutes, maxHours: value.max_hours };
}

export function hashSessionToken(token: string): string {
  return sha256Hex(token);
}

export type CreateSessionInput = {
  userId: string;
  kind: SessionKind;
  deviceId?: string | null;
  now?: Date;
  ip?: string | null;
  userAgent?: string | null;
  /** Sesi web yang masih menunggu 2FA (berlaku `PENDING_2FA_MINUTES`). */
  pending2fa?: boolean;
};

/** Buat sesi baru; mengembalikan token mentah (hanya sekali) dan barisnya. */
export async function createSession(tx: Tx, input: CreateSessionInput): Promise<{ token: string; session: SessionRow }> {
  const now = input.now ?? new Date();
  const token = randomToken(32);
  let expiresAt: Date;
  if (input.kind === "device") {
    expiresAt = new Date(now.getTime() + FIELD_SESSION_MAX_HOURS * 3_600_000);
  } else if (input.pending2fa) {
    expiresAt = new Date(now.getTime() + PENDING_2FA_MINUTES * 60_000);
  } else {
    const policy = await webSessionPolicy(tx, now);
    expiresAt = new Date(now.getTime() + policy.maxHours * 3_600_000);
  }
  const [session] = await tx
    .insert(sessions)
    .values({
      userId: input.userId,
      kind: input.kind,
      tokenHash: hashSessionToken(token),
      deviceId: input.deviceId ?? null,
      lastActiveAt: now,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
      createdAt: now,
    })
    .returning();
  return { token, session: session! };
}

/** Tandai 2FA terverifikasi; masa berlaku menjadi `created_at + max_hours` (PAR-46). */
export async function markSessionTotpVerified(tx: Tx, session: SessionRow, now: Date): Promise<SessionRow> {
  const policy = await webSessionPolicy(tx, now);
  const [row] = await tx
    .update(sessions)
    .set({
      totpVerifiedAt: now,
      lastActiveAt: now,
      expiresAt: new Date(session.createdAt.getTime() + policy.maxHours * 3_600_000),
    })
    .where(eq(sessions.id, session.id))
    .returning();
  return row!;
}

export type SessionUser = {
  id: string;
  tenantId: string;
  employeeId: string;
  username: string;
  status: string;
  exitDate: string | null;
};

export type SessionInvalidReason = "missing" | "unknown" | "revoked" | "expired_idle" | "expired_max" | "user_inactive" | "wrong_kind";

export type SessionValidation =
  | { ok: true; session: SessionRow; user: SessionUser }
  | { ok: false; reason: SessionInvalidReason; session?: SessionRow };

export type ValidateSessionOptions = {
  now?: Date;
  kind?: SessionKind;
  /** Perbarui `last_active_at` (bawaan true). */
  touch?: boolean;
  ip?: string | null;
};

/** Pengguna aktif dan belum melewati tanggal keluar (BR-37). */
export function isUserUsable(user: Pick<SessionUser, "status" | "exitDate">, now: Date): boolean {
  if (user.status !== "active") return false;
  if (user.exitDate && user.exitDate <= toBusinessDate(now)) return false;
  return true;
}

async function loadSessionUser(tx: Tx, userId: string): Promise<SessionUser | null> {
  const rows = await tx
    .select({
      id: users.id,
      tenantId: users.tenantId,
      employeeId: users.employeeId,
      username: users.username,
      status: users.status,
      exitDate: employees.exitDate,
    })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Validasi token sesi. Sesi kedaluwarsa (tidak aktif / maksimal) atau milik akun nonaktif dicabut dan dicatat di log
 * akses. Sesi web yang menunggu 2FA tetap `ok` — pemanggil memeriksa `session.totpVerifiedAt` terhadap peran.
 */
export async function validateSession(tx: Tx, token: string | null | undefined, options: ValidateSessionOptions = {}): Promise<SessionValidation> {
  if (!token) return { ok: false, reason: "missing" };
  const now = options.now ?? new Date();
  const rows = await tx.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(token))).limit(1);
  const session = rows[0];
  if (!session) return { ok: false, reason: "unknown" };
  if (options.kind && session.kind !== options.kind) return { ok: false, reason: "wrong_kind", session };
  if (session.revokedAt) return { ok: false, reason: "revoked", session };

  if (now.getTime() >= session.expiresAt.getTime()) {
    await expireSession(tx, session, "max_age", now);
    return { ok: false, reason: "expired_max", session };
  }
  if (session.kind === "web") {
    const policy = await webSessionPolicy(tx, now);
    if (now.getTime() - session.lastActiveAt.getTime() > policy.idleMinutes * 60_000) {
      await expireSession(tx, session, "idle", now);
      return { ok: false, reason: "expired_idle", session };
    }
  }

  const user = await loadSessionUser(tx, session.userId);
  if (!user || !isUserUsable(user, now)) {
    await revokeAllSessions(session.userId, user?.exitDate && user.status === "active" ? "exit_date" : "user_inactive", { tx, now });
    return { ok: false, reason: "user_inactive", session };
  }

  if (options.touch !== false && now.getTime() - session.lastActiveAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    await tx.update(sessions).set({ lastActiveAt: now }).where(eq(sessions.id, session.id));
    session.lastActiveAt = now;
  }
  return { ok: true, session, user };
}

async function expireSession(tx: Tx, session: SessionRow, reason: "idle" | "max_age", now: Date): Promise<void> {
  await tx
    .update(sessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(and(eq(sessions.id, session.id), isNull(sessions.revokedAt)));
  await logAccess(tx, {
    event: "session_expired",
    userId: session.userId,
    deviceId: session.deviceId,
    reason: reason === "idle" ? "Tidak aktif melewati batas (PAR-46)" : "Melewati masa berlaku maksimal",
    details: { sessionId: session.id, kind: session.kind },
    occurredAt: now,
  });
}

/** Cabut satu sesi (mis. keluar). */
export async function revokeSession(tx: Tx, sessionId: string, reason: RevokeReason, now: Date = new Date()): Promise<boolean> {
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export type RevokeAllOptions = {
  tx?: Tx;
  now?: Date;
  kind?: SessionKind;
  deviceId?: string;
  exceptSessionId?: string;
  /** Pelaku pencabutan (admin) untuk log akses. */
  actorUserId?: string | null;
};

/**
 * Cabut SEMUA sesi aktif pengguna (BR-37: nonaktif/keluar → sesi diputus seketika). Dipanggil M10 saat menonaktifkan
 * akun, reset PIN/2FA, dsb. Mengembalikan jumlah sesi yang dicabut.
 */
export async function revokeAllSessions(userId: string, reason: RevokeReason, options: RevokeAllOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  return runInTx(options.tx, async (tx) => {
    const where: SQL[] = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
    if (options.kind) where.push(eq(sessions.kind, options.kind));
    if (options.deviceId) where.push(eq(sessions.deviceId, options.deviceId));
    if (options.exceptSessionId) where.push(ne(sessions.id, options.exceptSessionId));
    const rows = await tx
      .update(sessions)
      .set({ revokedAt: now, revokeReason: reason })
      .where(and(...where))
      .returning({ id: sessions.id });
    if (rows.length > 0) {
      await logAccess(tx, {
        event: "session_revoked",
        userId,
        deviceId: options.deviceId ?? null,
        reason,
        details: { count: rows.length, by: options.actorUserId ?? null },
        occurredAt: now,
      });
    }
    return rows.length;
  });
}

/** Cabut semua sesi yang terikat perangkat (perangkat diblokir / hapus jarak jauh). */
export async function revokeDeviceSessions(tx: Tx, deviceId: string, reason: RevokeReason, now: Date = new Date()): Promise<number> {
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id, userId: sessions.userId });
  return rows.length;
}

/** Baris sesi menurut ID (null bila tidak ada / bukan UUID). */
export async function loadSessionById(tx: Tx, sessionId: string | null | undefined): Promise<SessionRow | null> {
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const rows = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Pengguna pernah masuk PIN di perangkat ini dan sesinya belum dicabut serta belum lewat masa tenggang sinkron
 * (`FIELD_SESSION_SYNC_GRACE_DAYS`). Dipakai unggah lampiran — keaslian lampiran dijamin tanda tangan perintah yang
 * merujuknya (hash SHA-256 lampiran ikut ditandatangani, `src/lib/sync-signature.ts`).
 */
export async function hasFieldSessionOnDevice(tx: Tx, userId: string, deviceId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.deviceId, deviceId),
        eq(sessions.kind, "device"),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date(now.getTime() - FIELD_SESSION_SYNC_GRACE_DAYS * 86_400_000)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * @deprecated Sejak tinjauan pasca-F3c perintah sinkron diikat ke sesinya sendiri (`sessionId` + tanda tangan);
 * fungsi ini hanya dipertahankan untuk kompatibilitas. Sesi lapangan (belum dicabut) pengguna di perangkat ini yang
 * masih berlaku pada waktu `at`.
 */
export async function findFieldSessionCovering(tx: Tx, userId: string, deviceId: string, at: Date): Promise<SessionRow | null> {
  const rows = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.deviceId, deviceId),
        eq(sessions.kind, "device"),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, at),
        lte(sessions.createdAt, at),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Kebersihan sesi (job harian `core.auth.session_hygiene`, BR-37):
 * - sesi karyawan yang tanggal keluarnya sudah tiba / akun nonaktif → dicabut (`exit_date` / `user_inactive`);
 * - sesi lapangan yang habis lebih dari `FIELD_SESSION_SYNC_GRACE_DAYS` hari → dicabut (`max_age`).
 */
export async function sessionHygiene(now: Date = new Date(), db: Tx = getDb()): Promise<{ exited: number; expired: number }> {
  const today = toBusinessDate(now);
  const candidates = await db
    .selectDistinct({ userId: sessions.userId, status: users.status, exitDate: employees.exitDate })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(and(isNull(sessions.revokedAt), or(ne(users.status, "active"), lte(employees.exitDate, today))));
  let exited = 0;
  for (const c of candidates) {
    const reason = c.status === "active" ? "exit_date" : "user_inactive";
    // D-12 butir 8: cabut sesi + log akses per pengguna dalam SATU transaksi (runner memberi koneksi biasa).
    exited += isTransaction(db) ? await revokeAllSessions(c.userId, reason, { tx: db, now }) : await withTx((tx) => revokeAllSessions(c.userId, reason, { tx, now }), { db: db as Db });
  }
  const cutoff = new Date(now.getTime() - FIELD_SESSION_SYNC_GRACE_DAYS * 86_400_000);
  const expired = await db
    .update(sessions)
    .set({ revokedAt: now, revokeReason: "max_age" })
    .where(and(eq(sessions.kind, "device"), isNull(sessions.revokedAt), lte(sessions.expiresAt, cutoff)))
    .returning({ id: sessions.id });
  return { exited, expired: expired.length };
}

/** Hapus baris sesi lama (tabel teknis) — dipakai job harian. */
export async function purgeOldSessions(now: Date = new Date(), db: Tx = getDb(), keepDays = 30): Promise<number> {
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000);
  const rows = await db.delete(sessions).where(lte(sessions.expiresAt, cutoff)).returning({ id: sessions.id });
  return rows.length;
}
