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
 * - `meta`         — pengguna aktif, status kunci layar, status sinkron, kursor pull, urutan nomor perangkat
 *                    (`deviceSeq:<scope>`), kunci perintah pengguna aktif (`commandKey`), dll.
 * - `moduleStore`  — (v2) penyimpanan lokal GENERIK untuk modul (keranjang POS, shift, stok, status rit optimistis…):
 *                    `[module+key]`. Modul TIDAK menambah tabel/versi Dexie sendiri — hanya core yang menaikkan versi
 *                    (registri versi di bawah), agar upgrade IndexedDB tidak rusak oleh dua agen.
 *
 * Hanya peramban. Perintah hapus jarak jauh → `wipeLocalData()` menghapus seluruh basis data.
 *
 * REGISTRI VERSI (hanya core yang menambah; jangan ubah versi lama):
 * - v1: outbox, attachments, refs, credentials, device, meta (F3c)
 * - v2: moduleStore (tinjauan pasca-F3c)
 * - v3: indeks outbox `[userId+createdAt]` (daftar antrean terbaru & pemangkasan tanpa memuat seluruh riwayat — S5B)
 */
import Dexie, { type Table } from "dexie";

import type { WrappedCommandKey } from "./crypto";
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
  /** Tanggal bisnis WIB saat dicatat (Bab 5.3) — server menolak bila ≠ tanggal WIB `deviceTime`. */
  businessDate: string;
  attachmentIds: string[];
  /** SHA-256 hex isi lampiran (sejajar `attachmentIds`), ikut ditandatangani. */
  attachmentHashes?: string[];
  /** Sesi PIN pemilik saat perintah dicatat / diikat ulang (`src/lib/sync-signature.ts`). */
  sessionId?: string | null;
  /** Sesi asal bila diikat ulang ke sesi baru setelah login ulang. */
  reboundFrom?: string | null;
  /** Tanda tangan HMAC kunci perintah sesi. */
  sig?: string | null;
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
  /** Item DITOLAK sudah dibaca pengguna (tidak lagi dihitung di pita merah "data ditolak"). */
  reviewedAt?: number | null;
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
  /** Galat sementara (server/perangkat) → coba lagi setelah waktu ini (backoff). */
  nextAttemptAt?: number | null;
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
  /** Kunci perintah sesi, terbungkus kunci turunan PIN (dibuka saat login PIN daring/offline). */
  commandKeyWrap?: WrappedCommandKey | null;
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

/** Baris penyimpanan lokal modul (v2). `userId` diisi untuk data per pengguna (antrean/keranjang pengguna itu). */
export type ModuleStoreItem = { module: string; key: string; userId?: string | null; data: unknown; updatedAt: number };

export class FieldDb extends Dexie {
  outbox!: Table<OutboxItem, string>;
  attachments!: Table<AttachmentItem, string>;
  refs!: Table<RefItem, [string, string]>;
  credentials!: Table<CredentialItem, string>;
  device!: Table<DeviceItem, string>;
  meta!: Table<MetaItem, string>;
  moduleStore!: Table<ModuleStoreItem, [string, string]>;

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
    this.version(2).stores({
      moduleStore: "[module+key], module, [module+userId]",
    });
    this.version(3).stores({
      outbox: "id, userId, status, [userId+status], createdAt, [userId+createdAt]",
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
