/**
 * Pull bersyarat di klien (D-14 butir 3, protokol `src/lib/pull-delta.ts`): kirim kursor sidik-isi per penyedia yang
 * datanya tersimpan, lalu terapkan respons dalam SATU transaksi Dexie — data penuh (`data`), "tidak berubah"
 * (`unchanged`: hanya `generatedAt` disegarkan), atau delta (`patches`). Delta yang tidak cocok dengan data lokal
 * (`PullPatchError`) → kursor kunci itu dibuang dan kunci itu ditarik penuh (pemanggil, `sync.ts`).
 *
 * Kompatibel dengan server lama: respons tanpa `protocol` diperlakukan sebagai data penuh tanpa kursor.
 */
import { applyPullPatch, PullPatchError, pullCursorQuery, touchVolatile } from "@/lib/pull-delta";

import { fieldDb, type RefItem } from "./db";
import type { PullResponse } from "./types";

/**
 * Query string pull: `v=2` + kursor data tersimpan (`c.<kunci>=…`). `keys` → hanya kunci itu (tanpa kursor = penuh),
 * dipakai untuk tarik ulang penuh setelah delta gagal.
 */
export function pullQueryString(stored: readonly Pick<RefItem, "key" | "cursor">[], keys?: readonly string[]): string {
  const entries: [string, string][] = [];
  for (const row of stored) {
    if (typeof row.cursor !== "string" || !row.cursor) continue;
    if (keys && !keys.includes(row.key)) continue;
    entries.push([row.key, row.cursor]);
  }
  const query = pullCursorQuery(entries);
  return keys?.length ? `${query}&keys=${keys.map(encodeURIComponent).join(",")}` : query;
}

export type ApplyPullResult = {
  /** Kunci yang diganti penuh. */
  replaced: string[];
  /** Kunci "tidak berubah". */
  unchanged: string[];
  /** Kunci yang diterapkan sebagai delta. */
  patched: string[];
  /** Kunci yang delta-nya tidak dapat diterapkan (perlu tarik penuh). */
  failed: string[];
};

/** Terapkan respons pull ke `refs` pengguna + parameter perangkat (satu transaksi). */
export async function applyPullResponse(userId: string, res: PullResponse, now = Date.now()): Promise<ApplyPullResult> {
  const db = fieldDb();
  const out: ApplyPullResult = { replaced: [], unchanged: [], patched: [], failed: [] };
  await db.transaction("rw", db.refs, db.device, async () => {
    for (const [key, data] of Object.entries(res.data)) {
      await db.refs.put({ userId, key, data, updatedAt: now, cursor: res.cursors?.[key] ?? null });
      out.replaced.push(key);
    }
    for (const key of res.unchanged ?? []) {
      const row = await db.refs.get([userId, key]);
      if (!row) {
        out.failed.push(key);
        continue;
      }
      await db.refs.put({ ...row, data: touchVolatile(row.data, res.serverTime), updatedAt: now });
      out.unchanged.push(key);
    }
    for (const [key, patch] of Object.entries(res.patches ?? {})) {
      const row = await db.refs.get([userId, key]);
      try {
        if (!row) throw new PullPatchError(`Data ${key} belum tersimpan di perangkat.`);
        const data = applyPullPatch(row.data, patch, res.serverTime);
        await db.refs.put({ userId, key, data, updatedAt: now, cursor: res.cursors?.[key] ?? null });
        out.patched.push(key);
      } catch (error) {
        if (!(error instanceof PullPatchError)) throw error;
        if (row) await db.refs.put({ ...row, cursor: null });
        out.failed.push(key);
      }
    }
    await db.device.update("device", { device: res.device, params: res.params, minVersion: res.minVersion, updateRequired: res.updateRequired });
  });
  return out;
}
