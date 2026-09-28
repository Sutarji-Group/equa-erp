/**
 * Autentikasi permintaan API lapangan (docs/ARCHITECTURE.md §6): header `Authorization: Bearer <JWT>` — JWT HS256
 * ditandatangani secret perangkat, klaim `{ deviceId, userId?, sessionId? }`, `iat`/`exp` (maks. 10 menit; klien
 * memakai jam server yang dikoreksi selisih). Server memulihkan secret dari rekaman `devices.secret_hash`
 * (`./crypto.ts`) lalu memverifikasi tanda tangan.
 *
 * Status perangkat:
 * - tidak dikenal / GPS → `DEVICE_UNKNOWN` (dicatat `device_rejected`);
 * - `blocked` → `DEVICE_BLOCKED` (dicatat);
 * - `wipe_pending` → status menjadi `wiped`, antrean yang dilaporkan hilang → insiden + notifikasi pemilik, lalu
 *   `DEVICE_WIPE` (HTTP 410) yang memerintahkan klien menghapus IndexedDB; `wiped` → `DEVICE_WIPE` lagi;
 * - `registered` (kode baru diterbitkan) → `DEVICE_NOT_ACTIVE`.
 */
import "server-only";

import { and, eq } from "drizzle-orm";
import { decodeJwt, jwtVerify, SignJWT } from "jose";

import { devices, employees, incidents, sessions, users } from "@/db/schema";
import { isUuid } from "@/lib/ids";

import { logAccess } from "../access-log";
import { record as auditRecord } from "../audit";
import { getDb, withTx, type Tx } from "../db";
import { notify } from "../notifications/service";
import { deviceSecretFromRecord, deviceSecretKeyBytes } from "./crypto";
import { deviceActorContext, logDeviceUsage, type DeviceRow } from "./devices";
import { AuthError } from "./errors";
import { isUserUsable, type SessionRow, type SessionUser } from "./session";

/** Toleransi jam untuk `iat`/`exp` JWT perangkat (detik). */
export const DEVICE_TOKEN_CLOCK_TOLERANCE_S = 300;
/** Umur maksimal token perangkat (detik). */
export const DEVICE_TOKEN_MAX_AGE_S = 600;

export type DeviceTokenClaims = { deviceId: string; userId?: string | null; sessionId?: string | null };

export type DeviceAuth = {
  device: DeviceRow;
  /** Sesi lapangan dari klaim `sessionId` (null bila tidak ada / tidak berlaku dan tidak diwajibkan). */
  session: SessionRow | null;
  user: SessionUser | null;
  claims: DeviceTokenClaims;
  now: Date;
  ip: string | null;
  userAgent: string | null;
  appVersion: string | null;
};

export type DeviceRequestLike = Request | { headers: Headers };

export type AuthenticateDeviceOptions = {
  /** Wajib ada sesi lapangan yang berlaku (mis. pull data referensi). */
  requireSession?: boolean;
  now?: Date;
};

export function requestIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim().slice(0, 64) || null;
  return headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

/** Tanda tangani token perangkat (dipakai uji & alat; klien peramban memakai jose/WebCrypto dengan kunci yang sama). */
export async function signDeviceToken(secret: string, claims: DeviceTokenClaims, options: { now?: Date; ttlSeconds?: number } = {}): Promise<string> {
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload: Record<string, string> = { deviceId: claims.deviceId };
  if (claims.userId) payload.userId = claims.userId;
  if (claims.sessionId) payload.sessionId = claims.sessionId;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(iat)
    .setExpirationTime(iat + (options.ttlSeconds ?? 300))
    .sign(deviceSecretKeyBytes(secret));
}

function bearer(headers: Headers): string | null {
  const auth = headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]!.trim() : null;
}

async function reject(
  tx: Tx,
  code: "DEVICE_UNKNOWN" | "DEVICE_BLOCKED" | "DEVICE_NOT_ACTIVE" | "DEVICE_TOKEN_INVALID",
  info: { device?: DeviceRow | null; reason: string; ip: string | null; userAgent: string | null; now: Date },
): Promise<never> {
  await logAccess(tx, {
    event: "device_rejected",
    success: false,
    tenantId: info.device?.tenantId ?? null,
    deviceId: info.device?.id ?? null,
    ip: info.ip,
    userAgent: info.userAgent,
    reason: info.reason,
    occurredAt: info.now,
  });
  const messages = {
    DEVICE_UNKNOWN: "Perangkat ini belum terdaftar. Aktifkan perangkat dengan kode dari admin sistem.",
    DEVICE_BLOCKED: "Perangkat ini diblokir admin sistem dan tidak dapat dipakai. Hubungi admin sistem.",
    DEVICE_NOT_ACTIVE: "Perangkat perlu diaktifkan ulang. Minta kode aktivasi baru ke admin sistem.",
    DEVICE_TOKEN_INVALID: "Perangkat tidak dapat diverifikasi. Periksa jam ponsel, atau aktifkan ulang perangkat.",
  } as const;
  throw new AuthError(code, messages[code]);
}

/** Jalankan perintah hapus jarak jauh: tandai `wiped`, catat, laporkan antrean yang hilang. */
async function executeWipe(device: DeviceRow, meta: { ip: string | null; userAgent: string | null; now: Date }): Promise<void> {
  await withTx(async (tx) => {
    const lostQueue = device.reportedQueueCount ?? 0;
    await tx.update(devices).set({ status: "wiped", wipedAt: meta.now, secretHash: null, updatedAt: meta.now }).where(eq(devices.id, device.id));
    await logAccess(tx, {
      event: "device_wiped",
      tenantId: device.tenantId,
      deviceId: device.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { reportedQueueCount: lostQueue },
      occurredAt: meta.now,
    });
    await logDeviceUsage(tx, { tenantId: device.tenantId, deviceId: device.id, userId: device.lastUserId, event: "wiped", occurredAt: meta.now, queueCount: lostQueue });
    await auditRecord(tx, {
      ctx: deviceActorContext(device, meta.now),
      objectType: "device",
      objectId: device.id,
      action: "update",
      before: { status: "wipe_pending" },
      after: { status: "wiped" },
      reason: "Perintah hapus data jarak jauh dijalankan pada kontak berikutnya",
    });
    if (lostQueue > 0) {
      const [incident] = await tx
        .insert(incidents)
        .values({
          tenantId: device.tenantId,
          kind: "lost_device_queue",
          severity: "major",
          title: `Antrean ${lostQueue} data hilang bersama perangkat ${device.deviceCode}`,
          description:
            "Perangkat dihapus jarak jauh sebelum seluruh antrean terkirim. Catat ulang transaksi berdasarkan bukti dengan penanda \"dicatat kantor\" (US-M3-09 KP-5).",
          objectType: "device",
          objectId: device.id,
          detectedAt: meta.now,
        })
        .returning({ id: incidents.id });
      await notify(tx, {
        event: "device.lost_queue",
        tenantId: device.tenantId,
        title: `Antrean perangkat ${device.deviceCode} hilang (${lostQueue} data)`,
        body: "Perangkat dihapus jarak jauh sebelum semua data terkirim. Tinjau pencatatan \"dicatat kantor\".",
        objectType: "incident",
        objectId: incident!.id,
        valueText: `${lostQueue} data`,
        link: "/akses/perangkat",
        now: meta.now,
      });
    }
  });
}

async function loadSessionFor(tx: Tx, device: DeviceRow, claims: DeviceTokenClaims, now: Date): Promise<{ session: SessionRow; user: SessionUser } | null> {
  if (!claims.sessionId || !isUuid(claims.sessionId)) return null;
  const rows = await tx.select().from(sessions).where(eq(sessions.id, claims.sessionId)).limit(1);
  const session = rows[0];
  if (!session || session.kind !== "device" || session.deviceId !== device.id || session.revokedAt) return null;
  if (claims.userId && claims.userId !== session.userId) return null;
  if (session.expiresAt.getTime() <= now.getTime()) return null;
  const u = await tx
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
    .where(eq(users.id, session.userId))
    .limit(1);
  const user = u[0];
  if (!user || !isUserUsable(user, now)) return null;
  return { session, user };
}

/** Verifikasi permintaan perangkat. Melempar `AuthError` (lihat keterangan berkas). */
export async function authenticateDevice(request: DeviceRequestLike, options: AuthenticateDeviceOptions = {}): Promise<DeviceAuth> {
  const now = options.now ?? new Date();
  const headers = request.headers;
  const ip = requestIp(headers);
  const userAgent = headers.get("user-agent")?.slice(0, 500) ?? null;
  const appVersion = headers.get("x-app-version")?.slice(0, 40) ?? null;
  const db = getDb();
  const meta = { ip, userAgent, now };

  const token = bearer(headers);
  if (!token) throw new AuthError("DEVICE_UNKNOWN", "Perangkat belum diaktifkan. Buka halaman aktivasi perangkat.");
  let unverified: Record<string, unknown>;
  try {
    unverified = decodeJwt(token) as Record<string, unknown>;
  } catch {
    return reject(db, "DEVICE_TOKEN_INVALID", { reason: "Token perangkat tidak terbaca", ...meta });
  }
  const deviceId = typeof unverified.deviceId === "string" ? unverified.deviceId : "";
  if (!isUuid(deviceId)) return reject(db, "DEVICE_UNKNOWN", { reason: "ID perangkat tidak valid", ...meta });

  const rows = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  const device = rows[0];
  if (!device || device.kind === "gps") return reject(db, "DEVICE_UNKNOWN", { device, reason: "Perangkat tidak terdaftar", ...meta });

  // Tanda tangan diverifikasi SEBELUM menjalankan perintah status apa pun (termasuk hapus jarak jauh).
  const secret = deviceSecretFromRecord(device.id, device.secretHash);
  if (!secret) {
    if (device.status === "blocked") return reject(db, "DEVICE_BLOCKED", { device, reason: "Perangkat diblokir", ...meta });
    if (device.status === "wiped") throw new AuthError("DEVICE_WIPE", "Data aplikasi di perangkat ini telah dihapus atas perintah admin sistem.", { wipe: true });
    return reject(db, "DEVICE_NOT_ACTIVE", { device, reason: "Secret perangkat tidak berlaku (perlu aktivasi ulang)", ...meta });
  }
  let claims: DeviceTokenClaims;
  try {
    const { payload } = await jwtVerify(token, deviceSecretKeyBytes(secret), {
      algorithms: ["HS256"],
      clockTolerance: DEVICE_TOKEN_CLOCK_TOLERANCE_S,
      currentDate: now,
      requiredClaims: ["iat", "exp"],
    });
    if (typeof payload.exp === "number" && typeof payload.iat === "number" && payload.exp - payload.iat > DEVICE_TOKEN_MAX_AGE_S) {
      throw new Error("masa token terlalu panjang");
    }
    claims = {
      deviceId: String(payload.deviceId),
      userId: typeof payload.userId === "string" ? payload.userId : null,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null,
    };
  } catch {
    return reject(db, "DEVICE_TOKEN_INVALID", { device, reason: "Tanda tangan/masa berlaku token perangkat tidak valid", ...meta });
  }
  if (claims.deviceId !== device.id) return reject(db, "DEVICE_TOKEN_INVALID", { device, reason: "Klaim perangkat tidak cocok", ...meta });

  if (device.status === "blocked") return reject(db, "DEVICE_BLOCKED", { device, reason: "Perangkat diblokir", ...meta });
  if (device.status === "wipe_pending") {
    await executeWipe(device, meta);
    throw new AuthError("DEVICE_WIPE", "Data aplikasi di perangkat ini dihapus atas perintah admin sistem.", { wipe: true });
  }
  if (device.status === "wiped") throw new AuthError("DEVICE_WIPE", "Data aplikasi di perangkat ini telah dihapus atas perintah admin sistem.", { wipe: true });
  if (device.status !== "active") return reject(db, "DEVICE_NOT_ACTIVE", { device, reason: `Status perangkat: ${device.status}`, ...meta });

  const found = await loadSessionFor(db, device, claims, now);
  if (!found && options.requireSession) {
    throw new AuthError("SESSION_EXPIRED", "Sesi Anda di perangkat ini berakhir. Masukkan PIN saat ada sinyal untuk melanjutkan.");
  }

  if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() >= 60_000 || (appVersion && appVersion !== device.appVersion)) {
    await db
      .update(devices)
      .set({ lastSeenAt: now, ...(appVersion ? { appVersion } : {}) })
      .where(and(eq(devices.id, device.id)));
  }

  return { device, session: found?.session ?? null, user: found?.user ?? null, claims, now, ip, userAgent, appVersion };
}
