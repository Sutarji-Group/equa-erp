/**
 * Tanda tangan perintah outbox per pengguna (src/lib/sync-signature.ts; tinjauan keamanan pasca-F3c).
 *
 * - Kunci perintah pengguna AKTIF (layar tidak terkunci) disimpan di `meta.commandKey` sebagai CryptoKey HMAC
 *   non-extractable; dihapus saat kunci layar / ganti pengguna. Salinan permanennya di `credentials.commandKeyWrap`
 *   terbungkus kunci turunan PIN — pengguna lain di perangkat yang sama tidak dapat menandatangani atas namanya.
 * - `signOutboxItem` dipanggil `enqueue`; `rebindOutbox` dipanggil saat pemilik antrean login PIN daring: perintah
 *   yang belum terkirim diikat ke sesi barunya (`reboundFrom` = sesi asal) agar diterima server walau sesi lama habis
 *   atau dicabut (reset PIN, aktivasi ulang perangkat).
 */
import { commandSigningString } from "@/lib/sync-signature";

import { signCommandString } from "./crypto";
import { fieldDb, getMeta, setMeta, type OutboxItem } from "./db";

const META_COMMAND_KEY = "commandKey";

type ActiveCommandKey = { userId: string; sessionId: string; key: CryptoKey };

/** Simpan kunci perintah pengguna aktif (non-extractable). */
export async function setActiveCommandKey(userId: string, sessionId: string, key: CryptoKey): Promise<void> {
  await setMeta(META_COMMAND_KEY, { userId, sessionId, key } satisfies ActiveCommandKey);
}

/** Hapus kunci perintah aktif (kunci layar / ganti pengguna / hapus data). */
export async function clearActiveCommandKey(): Promise<void> {
  await fieldDb().meta.delete(META_COMMAND_KEY);
}

/** Kunci perintah pengguna ini bila ia pengguna aktif dan layar tidak terkunci. */
export async function getActiveCommandKey(userId: string): Promise<ActiveCommandKey | null> {
  const value = await getMeta<ActiveCommandKey>(META_COMMAND_KEY);
  return value && value.userId === userId && value.key ? value : null;
}

/** Hitung tanda tangan item outbox untuk sesi `sessionId`. */
export async function signOutboxItem(
  item: Pick<OutboxItem, "id" | "type" | "userId" | "deviceTime" | "businessDate" | "payload" | "attachmentIds" | "attachmentHashes" | "reboundFrom">,
  sessionId: string,
  key: CryptoKey,
): Promise<string> {
  return signCommandString(
    key,
    commandSigningString({
      id: item.id,
      type: item.type,
      userId: item.userId,
      sessionId,
      deviceTime: item.deviceTime,
      businessDate: item.businessDate,
      reboundFrom: item.reboundFrom ?? null,
      payload: item.payload,
      attachmentIds: item.attachmentIds,
      attachmentHashes: item.attachmentHashes ?? [],
    }),
  );
}

/**
 * Ikat ulang antrean belum terkirim milik `userId` ke sesi baru (dipanggil setelah login PIN daring pemiliknya).
 * Mengembalikan jumlah item yang diikat ulang.
 */
export async function rebindOutbox(userId: string, sessionId: string, key: CryptoKey): Promise<number> {
  const db = fieldDb();
  const items = (await db.outbox.where("userId").equals(userId).toArray()).filter(
    (i) => (i.status === "queued" || i.status === "needs_login") && i.sessionId !== sessionId,
  );
  for (const item of items) {
    const reboundFrom = item.reboundFrom ?? item.sessionId ?? null;
    const sig = await signOutboxItem({ ...item, reboundFrom }, sessionId, key);
    await db.outbox.update(item.id, { sessionId, reboundFrom, sig });
  }
  return items.length;
}
