/**
 * Basis data peramban aplikasi lapangan (Dexie/IndexedDB `equa-field`; docs/ARCHITECTURE.md §7, Bab 6.5).
 *
 * Tabel:
 * - `outbox`       — perintah menunggu kirim, PER `userId` (pergantian pengguna tidak menghapus antrean pengguna lain).
 * - `attachments`  — lampiran (Blob foto/tanda tangan) yang diunggah sebelum perintahnya dikirim.
 * - `refs`         — data referensi offline per `[userId+key]` (hasil pull penyedia server).
 * - `credentials`  — per pengguna: verifier PIN offline (PBKDF2, bukan PIN), sesi lapangan, hitungan salah/kunci.
 * - `device`       — satu baris `key = "device"`: ID perangkat + kunci HMAC non-extractable (WebCrypto) atau, bila
 *                    peramban tidak dapat menyimpan CryptoKey, secret mentah (ditandai `secretRaw`).
 * - `meta`         — pengguna aktif, status kunci layar, status sinkron, kursor pull, dll.
 *
 * Hanya peramban. Perintah hapus jarak jauh → `wipeLocalData()` menghapus seluruh basis data.
 */
import Dexie, { type Table } from "dexie";

import type { OfflineParams, PinPolicy, PinVerifier, PublicDevice } from "./types";

export type OutboxStatus = "queued" | "sending" | "needs_login" | "sent" | "rejected" | "conflict";

/** Status yang masih harus dikirim (dihitung sebagai "tersimpan di ponsel"). */
export const PENDING_STATUSES: readonly OutboxStatus[] = ["queued", "sending", "needs_login"];

export type OutboxItem = {
  /** UUID v7 dibuat di perangkat = kunci idempotensi server. */
  id: string;
  userId: string;
  type: string;
  payload: unknown;
  /** Waktu perangkat (ISO) saat dicatat. */
  deviceTime: string;
  /** Tanggal bisnis WIB saat dicatat (Bab 5.3). */
  businessDate: string;
  attachmentIds: string[];
  /** Label tampilan antrean, mis. "Selesai rit P-26-000123". */
  label?: string | null;
  status: OutboxStatus;
  createdAt: number;
  attempts: number;
  nextAttemptAt?: number | null;
  lastAttemptAt?: number | null;
  sentAt?: number | null;
  code?: string | null;
  message?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  result?: unknown;
};

export type AttachmentItem = {
  id: string;
  userId: string;
  commandId?: string | null;
  kind: string;
  blob: Blob;
  contentType: string;
  capturedAt: string;
  lat?: number | null;
  lng?: number | null;
  status: "pending" | "uploaded" | "failed";
  attempts: number;
  uploadedAt?: number | null;
  message?: string | null;
};

export type RefItem = { userId: string; key: string; data: unknown; updatedAt: number };

export type CredentialItem = {
  userId: string;
  name: string;
  roleLabel: string;
  roles: string[];
  employeeId: string;
  verifier: PinVerifier;
  sessionId: string;
  sessionExpiresAt: string;
  policy: PinPolicy;
  failedCount: number;
  lockedUntil: number | null;
  lastLoginAt: number;
};

export type DeviceItem = {
  key: "device";
  deviceId: string;
  /** Kunci HMAC-SHA256 non-extractable untuk menandatangani token perangkat. */
  secretKey: CryptoKey | null;
  /** Cadangan bila CryptoKey tidak dapat disimpan di IndexedDB. */
  secretRaw: string | null;
  device: PublicDevice;
  activatedAt: number;
  /** Selisih jam server − jam perangkat (ms) untuk `iat/exp` token. */
  serverOffsetMs: number;
  params?: OfflineParams | null;
  minVersion?: string | null;
  updateRequired?: boolean;
};

export type MetaItem = { key: string; value: unknown };

export class FieldDb extends Dexie {
  outbox!: Table<OutboxItem, string>;
  attachments!: Table<AttachmentItem, string>;
  refs!: Table<RefItem, [string, string]>;
  credentials!: Table<CredentialItem, string>;
  device!: Table<DeviceItem, string>;
  meta!: Table<MetaItem, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      outbox: "id, userId, status, [userId+status], createdAt",
      attachments: "id, userId, commandId, status",
      refs: "[userId+key], userId",
      credentials: "userId",
      device: "key",
      meta: "key",
    });
  }
}

export const FIELD_DB_NAME = "equa-field";

let dbName = FIELD_DB_NAME;
let instance: FieldDb | null = null;

/** Instans Dexie tunggal per tab. */
export function fieldDb(): FieldDb {
  instance ??= new FieldDb(dbName);
  return instance;
}

/** Ganti nama DB (uji dengan fake-indexeddb). */
export function setFieldDbNameForTests(name: string): void {
  instance?.close();
  instance = null;
  dbName = name;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await fieldDb().meta.get(key))?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await fieldDb().meta.put({ key, value });
}

/**
 * Hapus SELURUH data lapangan di perangkat (perintah hapus jarak jauh admin sistem, US-M10-02 KP-6): IndexedDB,
 * sessionStorage, dan cache service worker milik aplikasi.
 */
export async function wipeLocalData(): Promise<void> {
  const name = dbName;
  instance?.close();
  instance = null;
  await Dexie.delete(name);
  try {
    globalThis.sessionStorage?.clear();
  } catch {
    // abaikan
  }
  try {
    if (typeof caches !== "undefined") {
      for (const key of await caches.keys()) await caches.delete(key);
    }
  } catch {
    // abaikan
  }
}
