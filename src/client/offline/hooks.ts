"use client";

/**
 * Hook React aplikasi lapangan (hanya peramban):
 * - `useSyncStatus(userId?)` → jumlah antrean belum terkirim (pengguna aktif), ditolak & belum dibaca, perlu login, status daring,
 *   sedang mengirim, terakhir sinkron, `syncNow()` ("Kirim sekarang").
 * - `useReference<T>(key)` → data referensi offline hasil pull untuk pengguna aktif (mis. `"m3.trips_today"`), dengan
 *   perintah yang masih di antrean diterapkan ulang secara optimistis (`registerOptimistic`, ./optimistic.ts).
 * - `useOutbox(userId)` → daftar item antrean dengan status per item (NFR-08).
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useSyncExternalStore } from "react";

import { fieldDb, PENDING_STATUSES, type MetaItem, type OutboxItem, type OutboxStatus } from "./db";
import { hasOptimisticFor, withOptimistic } from "./optimistic";
import { listOutbox } from "./outbox";
import { syncNow, type SyncState } from "./sync";

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

export type SyncStatus = {
  /** Item belum terkirim milik pengguna (atau semua pengguna bila `userId` kosong). */
  pendingCount: number;
  rejectedCount: number;
  needsLoginCount: number;
  online: boolean;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  syncNow: () => void;
};

/** Status sinkron untuk pil status & layar utama (US-M3-09 KP-2, US-M6-06 KP-2). */
export function useSyncStatus(userId?: string | null): SyncStatus {
  const online = useOnline();
  const counts = useLiveQuery(
    async () => {
      // NFR-17: hitung lewat indeks status (tidak memuat seluruh riwayat antrean setiap perubahan).
      const db = fieldDb();
      const count = (status: OutboxStatus) => (userId ? db.outbox.where("[userId+status]").equals([userId, status]) : db.outbox.where("status").equals(status));
      let pending = 0;
      for (const status of PENDING_STATUSES) pending += await count(status).count();
      const needsLogin = await count("needs_login").count();
      // Item ditolak yang sudah dibaca (`markRejectedReviewed`) tidak lagi menyalakan pita merah.
      const rejected = await count("rejected")
        .filter((r) => !r.reviewedAt)
        .count();
      return { pending, rejected, needsLogin };
    },
    [userId],
    { pending: 0, rejected: 0, needsLogin: 0 },
  );
  const state = useLiveQuery(async () => ((await fieldDb().meta.get("syncState")) as MetaItem | undefined)?.value as SyncState | undefined, [], undefined);
  const trigger = useCallback(() => void syncNow({ force: true }), []);
  return {
    pendingCount: counts.pending,
    rejectedCount: counts.rejected,
    needsLoginCount: counts.needsLogin,
    online,
    syncing: !!state?.syncing,
    lastSyncAt: state?.lastSyncAt ?? null,
    lastError: state?.lastError ?? null,
    syncNow: trigger,
  };
}

/** Data referensi offline untuk pengguna (bawaan pengguna aktif — lewat argumen). `undefined` = belum diunduh. */
export function useReference<T>(key: string, userId: string | null | undefined): T | undefined {
  return useLiveQuery(
    async () => {
      if (!userId) return undefined;
      const db = fieldDb();
      const data = (await db.refs.get([userId, key]))?.data as T | undefined;
      if (!hasOptimisticFor(key)) return data;
      // Perintah pengguna yang belum terkirim diterapkan ulang di atas hasil pull terakhir (hanya status PENDING, via indeks).
      const pending = await db.outbox
        .where("[userId+status]")
        .anyOf(PENDING_STATUSES.map((s) => [userId, s]))
        .toArray();
      return withOptimistic(key, data, pending);
    },
    [key, userId],
    undefined,
  );
}

/** Antrean pengguna (terbaru dulu; indeks `[userId+createdAt]` + batas — tidak memuat seluruh riwayat). */
export function useOutbox(userId: string | null | undefined, limit = 20): OutboxItem[] {
  return useLiveQuery(
    async () => {
      if (!userId) return [];
      return listOutbox(userId, limit);
    },
    [userId, limit],
    [] as OutboxItem[],
  );
}
