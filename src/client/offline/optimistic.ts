/**
 * Pembaruan OPTIMISTIS data referensi (tinjauan pasca-F3c): perubahan dari perintah yang MASIH di antrean diterapkan
 * ulang di atas data hasil pull setiap kali dibaca, sehingga pull yang menimpa `refs` tidak "menghilangkan" aksi
 * lapangan yang belum terkirim (mis. rit sudah "Berangkat" di ponsel tetapi server belum menerima).
 *
 * ```ts
 * registerOptimistic("m3.trip.depart", {
 *   refKey: "m3.trips_today",
 *   apply: (data, payload) => ({ ...data, trips: data.trips.map((t) => t.id === payload.tripId ? { ...t, status: "departed" } : t) }),
 * });
 * // useReference("m3.trips_today", userId) otomatis menerapkan perintah m3.trip.depart yang masih PENDING.
 * ```
 */
import { PENDING_STATUSES, type OutboxItem } from "./db";

export type OptimisticReducer<T = unknown, P = unknown> = {
  /** Kunci data referensi (penyedia pull) yang diubah. */
  refKey: string;
  apply: (data: T, payload: P, item: OutboxItem) => T;
};

const reducers = new Map<string, OptimisticReducer[]>();

/** Daftarkan reducer optimistis untuk jenis perintah (panggil sekali di modul klien). Mengembalikan pelepas. */
export function registerOptimistic<T, P>(commandType: string, reducer: OptimisticReducer<T, P>): () => void {
  const list = reducers.get(commandType) ?? [];
  const r = reducer as unknown as OptimisticReducer;
  list.push(r);
  reducers.set(commandType, list);
  return () => {
    const cur = reducers.get(commandType) ?? [];
    const idx = cur.indexOf(r);
    if (idx >= 0) cur.splice(idx, 1);
  };
}

/** Terapkan perintah yang masih PENDING (urut dibuat) ke data referensi `refKey` (murni). */
export function withOptimistic<T>(refKey: string, data: T | undefined, items: readonly OutboxItem[]): T | undefined {
  if (data === undefined) return data;
  let out: T = data;
  const pending = items.filter((i) => (PENDING_STATUSES as readonly string[]).includes(i.status)).sort((a, b) => a.createdAt - b.createdAt);
  for (const item of pending) {
    for (const r of reducers.get(item.type) ?? []) {
      if (r.refKey === refKey) out = (r as unknown as OptimisticReducer<T>).apply(out, item.payload, item);
    }
  }
  return out;
}

/** Benar bila ada reducer untuk kunci referensi ini (hindari kueri antrean bila tidak perlu). */
export function hasOptimisticFor(refKey: string): boolean {
  for (const list of reducers.values()) if (list.some((r) => r.refKey === refKey)) return true;
  return false;
}
