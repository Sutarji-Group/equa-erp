"use client";

/**
 * Hook React aplikasi lapangan (hanya peramban):
 * - `useSyncStatus(userId?)` → jumlah antrean belum terkirim (pengguna aktif), ditolak, perlu login, status daring,
 *   sedang mengirim, terakhir sinkron, `syncNow()` ("Kirim sekarang").
 * - `useReference<T>(key)` → data referensi offline hasil pull untuk pengguna aktif (mis. `"m3.trips_today"`).
 * - `useOutbox(userId)` → daftar item antrean dengan status per item (NFR-08).
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useSyncExternalStore } from "react";

import { fieldDb, PENDING_STATUSES, type MetaItem, type OutboxItem } from "./db";
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
      const db = fieldDb();
      const rows = userId ? await db.outbox.where("userId").equals(userId).toArray() : await db.outbox.toArray();
      let pending = 0;
      let rejected = 0;
      let needsLogin = 0;
      for (const r of rows) {
        if ((PENDING_STATUSES as readonly string[]).includes(r.status)) pending++;
        if (r.status === "rejected") rejected++;
        if (r.status === "needs_login") needsLogin++;
      }
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
      return (await fieldDb().refs.get([userId, key]))?.data as T | undefined;
    },
    [key, userId],
    undefined,
  );
}

/** Antrean pengguna (terbaru dulu). */
export function useOutbox(userId: string | null | undefined, limit = 20): OutboxItem[] {
  return useLiveQuery(
    async () => {
      if (!userId) return [];
      const rows = await fieldDb().outbox.where("userId").equals(userId).toArray();
      return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
    [userId, limit],
    [] as OutboxItem[],
  );
}
