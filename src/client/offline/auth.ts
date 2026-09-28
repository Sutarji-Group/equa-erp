/**
 * Login lapangan di perangkat (US-M10-02 KP-2/KP-3/KP-5; US-M3-09 KP-4; US-M3-10 KP-1; Bab 6.5):
 *
 * - `loginWithPin(userId, pin)`: saat daring → server (sesi lapangan + verifier PIN baru); tanpa sinyal → verifikasi
 *   OFFLINE terhadap verifier PBKDF2 tersimpan (hanya setelah pernah login daring di perangkat ini).
 * - 5 salah (PAR-36) → terkunci 15 menit juga saat offline; kejadian dilaporkan ke server pada sinkron berikutnya
 *   (admin sistem diberi tahu).
 * - `enrollWithCode(code, pin)`: aktivasi akun dengan kode sekali pakai dari admin sistem + PIN baru.
 * - `lockScreen()` / `unlockScreen(pin)` (PAR-37) & `switchUser()` — TIDAK menghapus antrean siapa pun.
 */
import { fieldDb, getMeta, setMeta, type CredentialItem } from "./db";
import { deviceFetch, FieldApiError, isOnline } from "./api";
import { verifyPinOffline } from "./crypto";
import type { DeviceUserInfo, FieldLoginResponse, PinPolicy } from "./types";

export const DEFAULT_POLICY: PinPolicy = { maxAttempts: 5, lockMinutes: 15, idleMinutes: 10 };

export type OfflineAuthEvent = {
  type: "pin_failed" | "pin_locked" | "offline_login";
  userId: string;
  at: string;
  lockedUntil?: string;
};

const META_ACTIVE = "activeUserId";
const META_LOCKED = "screenLocked";
const META_ACTIVITY = "lastActivityAt";
const META_EVENTS = "pendingAuthEvents";
const META_DEVICE_USERS = "deviceUsers";

export async function getActiveUserId(): Promise<string | null> {
  return (await getMeta<string | null>(META_ACTIVE)) ?? null;
}

export async function getCredential(userId: string): Promise<CredentialItem | undefined> {
  return fieldDb().credentials.get(userId);
}

/** Sesi lapangan pengguna aktif (untuk pull), bila masih berlaku menurut jam perangkat. */
export async function activeSession(now = Date.now()): Promise<{ userId: string; sessionId: string } | null> {
  const userId = await getActiveUserId();
  if (!userId) return null;
  const cred = await getCredential(userId);
  if (!cred || Date.parse(cred.sessionExpiresAt) <= now) return null;
  return { userId, sessionId: cred.sessionId };
}

async function pushEvent(ev: OfflineAuthEvent): Promise<void> {
  const list = (await getMeta<OfflineAuthEvent[]>(META_EVENTS)) ?? [];
  list.push(ev);
  await setMeta(META_EVENTS, list.slice(-100));
}

/** Kejadian login offline yang belum dilaporkan (dikirim bersama laporan kesehatan). */
export async function takeAuthEvents(): Promise<OfflineAuthEvent[]> {
  return (await getMeta<OfflineAuthEvent[]>(META_EVENTS)) ?? [];
}

export async function clearAuthEvents(count: number): Promise<void> {
  const list = (await getMeta<OfflineAuthEvent[]>(META_EVENTS)) ?? [];
  await setMeta(META_EVENTS, list.slice(count));
}

/** Peristiwa peramban: minta worker sinkron berjalan (mis. setelah login → unduh data referensi). */
export const SYNC_REQUEST_EVENT = "equa:sync-request";

async function activate(userId: string, now: number): Promise<void> {
  await setMeta(META_ACTIVE, userId);
  await setMeta(META_LOCKED, false);
  await setMeta(META_ACTIVITY, now);
  // Perintah pengguna ini yang menunggu login kembali ke antrean kirim.
  await fieldDb()
    .outbox.where("[userId+status]")
    .equals([userId, "needs_login"])
    .modify({ status: "queued", nextAttemptAt: null });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SYNC_REQUEST_EVENT));
}

async function saveCredential(res: FieldLoginResponse, now: number): Promise<CredentialItem> {
  const cred: CredentialItem = {
    userId: res.user.id,
    name: res.user.name,
    roleLabel: res.user.roleLabel,
    roles: res.user.roles,
    employeeId: res.user.employeeId,
    verifier: res.verifier,
    sessionId: res.sessionId,
    sessionExpiresAt: res.expiresAt,
    policy: res.policy,
    failedCount: 0,
    lockedUntil: null,
    lastLoginAt: now,
  };
  await fieldDb().credentials.put(cred);
  return cred;
}

function lockedMessage(until: number): string {
  const d = new Date(until);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `Terlalu banyak PIN salah. Coba lagi pukul ${hh}.${mm} atau hubungi admin sistem.`;
}

export type LoginOptions = { online?: boolean; now?: number; activateUser?: boolean };

/** Login PIN (daring bila ada sinyal, offline dengan verifier bila tidak). */
export async function loginWithPin(userId: string, pin: string, opts: LoginOptions = {}): Promise<CredentialItem> {
  const now = opts.now ?? Date.now();
  const online = opts.online ?? isOnline();
  const cred = await getCredential(userId);
  if (cred?.lockedUntil && cred.lockedUntil > now) {
    throw new FieldApiError(lockedMessage(cred.lockedUntil), { code: "PIN_LOCKED", lockedUntil: new Date(cred.lockedUntil).toISOString() });
  }
  if (online) {
    try {
      const res = await deviceFetch<FieldLoginResponse>("/api/device/pin-login", { json: { userId, pin } });
      const saved = await saveCredential(res, now);
      if (opts.activateUser !== false) await activate(userId, now);
      return saved;
    } catch (error) {
      if (!(error instanceof FieldApiError) || !error.network) {
        if (error instanceof FieldApiError && cred && error.code === "PIN_LOCKED" && error.lockedUntil) {
          await fieldDb().credentials.update(userId, { lockedUntil: Date.parse(error.lockedUntil), failedCount: 0 });
        }
        throw error;
      }
      // Tanpa sinyal → lanjut verifikasi offline.
    }
  }
  if (!cred) {
    throw new FieldApiError("Masuk pertama kali di perangkat ini harus saat ada sinyal. Cari sinyal lalu coba lagi.", { code: "OFFLINE_FIRST_LOGIN" });
  }
  const ok = await verifyPinOffline(pin, cred.verifier);
  const policy = cred.policy ?? DEFAULT_POLICY;
  if (!ok) {
    const failed = cred.failedCount + 1;
    if (failed >= policy.maxAttempts) {
      const until = now + policy.lockMinutes * 60_000;
      await fieldDb().credentials.update(userId, { failedCount: 0, lockedUntil: until });
      await pushEvent({ type: "pin_locked", userId, at: new Date(now).toISOString(), lockedUntil: new Date(until).toISOString() });
      throw new FieldApiError(lockedMessage(until), { code: "PIN_LOCKED", lockedUntil: new Date(until).toISOString() });
    }
    await fieldDb().credentials.update(userId, { failedCount: failed });
    await pushEvent({ type: "pin_failed", userId, at: new Date(now).toISOString() });
    throw new FieldApiError(`PIN salah. Sisa ${policy.maxAttempts - failed} kali percobaan sebelum terkunci.`, {
      code: "PIN_INVALID",
      attemptsLeft: policy.maxAttempts - failed,
    });
  }
  await fieldDb().credentials.update(userId, { failedCount: 0, lockedUntil: null, lastLoginAt: now });
  await pushEvent({ type: "offline_login", userId, at: new Date(now).toISOString() });
  if (opts.activateUser !== false) await activate(userId, now);
  return (await getCredential(userId))!;
}

/** Aktivasi akun lapangan dengan kode admin sistem + PIN baru (wajib daring). */
export async function enrollWithCode(code: string, pin: string, now = Date.now()): Promise<CredentialItem> {
  const res = await deviceFetch<FieldLoginResponse>("/api/device/pin-enroll", { json: { code, pin } });
  const saved = await saveCredential(res, now);
  await activate(res.user.id, now);
  return saved;
}

export async function isScreenLocked(): Promise<boolean> {
  return (await getMeta<boolean>(META_LOCKED)) === true;
}

/** Kunci layar (PAR-37 / tombol "Kunci") — data & antrean tetap utuh. */
export async function lockScreen(): Promise<void> {
  await setMeta(META_LOCKED, true);
}

/** Buka kunci dengan PIN pengguna aktif (offline memakai verifier). */
export async function unlockScreen(pin: string, opts: LoginOptions = {}): Promise<void> {
  const userId = await getActiveUserId();
  if (!userId) throw new FieldApiError("Pilih pengguna terlebih dahulu.", { code: "NO_USER" });
  await loginWithPin(userId, pin, opts);
}

/** Ganti pengguna: hanya melepas pengguna aktif; antrean semua pengguna tetap tersimpan (Bab 6.5). */
export async function switchUser(): Promise<void> {
  await setMeta(META_ACTIVE, null);
  await setMeta(META_LOCKED, false);
}

/** Catat aktivitas (untuk kunci layar otomatis PAR-37). */
export async function touchActivity(now = Date.now()): Promise<void> {
  await setMeta(META_ACTIVITY, now);
}

export async function lastActivityAt(): Promise<number | null> {
  return (await getMeta<number>(META_ACTIVITY)) ?? null;
}

/** Perbarui daftar pengguna yang boleh memakai perangkat (daring) dan simpan untuk layar offline. */
export async function refreshDeviceUsers(): Promise<DeviceUserInfo[]> {
  const res = await deviceFetch<{ users: DeviceUserInfo[] }>("/api/device/users");
  await setMeta(META_DEVICE_USERS, res.users);
  return res.users;
}

export type KnownUser = { id: string; name: string; roleLabel: string; canLoginOffline: boolean };

/** Pengguna yang ditampilkan di layar PIN: daftar server tersimpan + pengguna yang pernah login di perangkat. */
export async function knownUsers(): Promise<KnownUser[]> {
  const creds = await fieldDb().credentials.toArray();
  const server = (await getMeta<DeviceUserInfo[]>(META_DEVICE_USERS)) ?? [];
  const map = new Map<string, KnownUser>();
  for (const u of server) map.set(u.id, { id: u.id, name: u.name, roleLabel: u.roleLabel, canLoginOffline: false });
  for (const c of creds) map.set(c.userId, { id: c.userId, name: c.name, roleLabel: c.roleLabel, canLoginOffline: true });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "id"));
}
