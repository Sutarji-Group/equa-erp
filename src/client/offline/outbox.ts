/**
 * Outbox lapangan (docs/ARCHITECTURE.md §7; US-M3-09 KP-2; NFR-06..08). Setiap aksi lapangan dicatat LOKAL lebih dulu
 * (≤ 1 detik, tanpa jaringan) lalu dikirim worker sinkron. ID perintah UUID v7 dibuat di perangkat → pengiriman ulang
 * tidak menggandakan data di server.
 *
 * ```ts
 * import { enqueue } from "@/client/offline";
 * await enqueue(
 *   { type: "m3.trip.complete", payload: { tripId, volumeL: 5000 }, label: `Selesai rit ${trip.number}` },
 *   [{ kind: "delivery_photo", blob: photo.blob, capturedAt: photo.capturedAt }],   // dari <PhotoCapture onCapture>
 * );
 * ```
 * Lampiran mendapat ID sendiri (dikirim sebagai `attachmentIds`); handler server membacanya di `meta.attachments`.
 * Setiap perintah diikat ke sesi PIN pemiliknya dan ditandatangani kunci perintahnya (termasuk hash SHA-256 lampiran;
 * `src/lib/sync-signature.ts`) — hanya pengguna AKTIF dengan layar tidak terkunci yang dapat mencatat.
 *
 * `businessDate` HARUS tanggal WIB saat dicatat (bawaan); server menolak tanggal lain (Bab 5.3, toleransi ±PAR-42 di
 * tengah malam). Jangan memakai tanggal shift/rit sebagai tanggal bisnis perintah.
 */
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";

import { FieldApiError } from "./api";
import { getActiveUserId, lockScreen } from "./auth";
import { sha256HexOfBlob } from "./crypto";
import { fieldDb, PENDING_STATUSES, type AttachmentItem, type OutboxItem } from "./db";
import { getActiveCommandKey, signOutboxItem } from "./signing";

export type EnqueueCommand = {
  /** Jenis perintah terdaftar di server (`registerSyncHandler`), mis. `m3.trip.depart`. */
  type: string;
  payload: unknown;
  /** Label untuk daftar antrean ("tersimpan di ponsel"/"terkirim"). */
  label?: string;
  /**
   * @deprecated Tanggal bisnis = tanggal WIB perangkat saat dicatat (bawaan) — server menolak nilai lain (Bab 5.3).
   */
  businessDate?: string;
};

export type EnqueueAttachment = {
  kind: string;
  blob: Blob;
  contentType?: string;
  capturedAt?: Date;
  lat?: number | null;
  lng?: number | null;
};

export type EnqueueOptions = { userId?: string; now?: Date };

export const OUTBOX_CHANGED_EVENT = "equa:outbox-changed";

function notifyChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OUTBOX_CHANGED_EVENT));
}

/** Catat aksi lapangan ke antrean pengguna aktif. Mengembalikan ID perintah & ID lampiran. */
export async function enqueue(
  command: EnqueueCommand,
  attachments: readonly EnqueueAttachment[] = [],
  opts: EnqueueOptions = {},
): Promise<{ id: string; attachmentIds: string[] }> {
  const activeUserId = await getActiveUserId();
  const userId = opts.userId ?? activeUserId;
  if (!userId) throw new Error("Masuk dengan PIN terlebih dahulu.");
  if (!command.type) throw new Error("Jenis data wajib diisi.");
  const signer = await getActiveCommandKey(userId);
  if (!signer) {
    // Kunci perintah hanya ada selama pengguna itu aktif & layar terbuka → minta PIN (kunci layar pengguna aktif).
    if (userId === activeUserId) await lockScreen();
    throw new FieldApiError("Masukkan PIN Anda lagi untuk mencatat data.", { code: "PIN_REQUIRED" });
  }
  const now = opts.now ?? new Date();
  const id = newId();
  const attachmentRows: AttachmentItem[] = attachments.map((a) => ({
    id: newId(),
    userId,
    commandId: id,
    kind: a.kind,
    blob: a.blob,
    contentType: a.contentType ?? a.blob.type ?? "image/jpeg",
    capturedAt: (a.capturedAt ?? now).toISOString(),
    lat: a.lat ?? null,
    lng: a.lng ?? null,
    status: "pending",
    attempts: 0,
  }));
  const attachmentHashes = await Promise.all(attachmentRows.map((a) => sha256HexOfBlob(a.blob)));
  const item: OutboxItem = {
    id,
    userId,
    type: command.type,
    payload: command.payload ?? {},
    deviceTime: now.toISOString(),
    businessDate: command.businessDate ?? toBusinessDate(now),
    attachmentIds: attachmentRows.map((a) => a.id),
    attachmentHashes,
    sessionId: signer.sessionId,
    reboundFrom: null,
    sig: null,
    label: command.label ?? null,
    status: "queued",
    createdAt: now.getTime(),
    attempts: 0,
  };
  item.sig = await signOutboxItem(item, signer.sessionId, signer.key);
  const db = fieldDb();
  await db.transaction("rw", db.outbox, db.attachments, async () => {
    if (attachmentRows.length) await db.attachments.bulkAdd(attachmentRows);
    await db.outbox.add(item);
  });
  notifyChanged();
  return { id, attachmentIds: item.attachmentIds };
}

/** Jumlah item belum terkirim (pengguna tertentu, atau semua pengguna di perangkat). */
export async function pendingCount(userId?: string): Promise<number> {
  const db = fieldDb();
  if (userId) {
    let n = 0;
    for (const status of PENDING_STATUSES) n += await db.outbox.where("[userId+status]").equals([userId, status]).count();
    return n;
  }
  return db.outbox.where("status").anyOf([...PENDING_STATUSES]).count();
}

/** Antrean per pengguna (untuk laporan kesehatan "menunggu sinkron" per sopir). */
export async function pendingByUser(): Promise<Record<string, number>> {
  const rows = await fieldDb().outbox.where("status").anyOf([...PENDING_STATUSES]).toArray();
  const out: Record<string, number> = {};
  for (const r of rows) out[r.userId] = (out[r.userId] ?? 0) + 1;
  return out;
}

/** Item antrean pengguna (terbaru dulu). Data pengguna lain tidak ditampilkan (US-M10-02 KP-2). */
export async function listOutbox(userId: string, limit = 50): Promise<OutboxItem[]> {
  const rows = await fieldDb().outbox.where("userId").equals(userId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** Teks status per item (NFR-08). */
export function outboxStatusText(item: Pick<OutboxItem, "status" | "message">): string {
  switch (item.status) {
    case "sent":
      return "Terkirim";
    case "conflict":
      return "Terkirim (ditandai untuk diperiksa kantor)";
    case "rejected":
      return item.message ? `Ditolak: ${item.message}` : "Ditolak";
    case "needs_login":
      return "Tersimpan di ponsel — masuk dengan PIN saat ada sinyal";
    case "sending":
      return "Mengirim…";
    default:
      return "Tersimpan di ponsel";
  }
}
