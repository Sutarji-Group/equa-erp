/**
 * Penyimpanan lokal GENERIK untuk modul lapangan (Dexie `moduleStore`, v2) — keranjang POS, shift, stok, status rit
 * optimistis, draf formulir. Modul TIDAK menambah tabel/versi Dexie sendiri (hanya core; registri versi di db.ts).
 *
 * ```ts
 * const cart = moduleStore<CartState>("m6-pos");
 * await cart.put("cart", { lines }, { userId });
 * const saved = await cart.get("cart");
 * ```
 * Data dihapus bersama seluruh basis data saat perintah hapus jarak jauh (`wipeLocalData`).
 */
import { fieldDb, type ModuleStoreItem } from "./db";

export type ModuleStore<T> = {
  get: (key: string) => Promise<T | undefined>;
  put: (key: string, data: T, opts?: { userId?: string | null }) => Promise<void>;
  remove: (key: string) => Promise<void>;
  /** Semua baris modul (opsional hanya milik pengguna). */
  list: (opts?: { userId?: string | null }) => Promise<(ModuleStoreItem & { data: T })[]>;
};

export function moduleStore<T = unknown>(module: string): ModuleStore<T> {
  if (!/^[a-z0-9-]+$/.test(module)) throw new Error(`Nama modul tidak valid: ${module}`);
  const table = () => fieldDb().moduleStore;
  return {
    get: async (key) => (await table().get([module, key]))?.data as T | undefined,
    put: async (key, data, opts = {}) => {
      await table().put({ module, key, userId: opts.userId ?? null, data, updatedAt: Date.now() });
    },
    remove: async (key) => {
      await table().delete([module, key]);
    },
    list: async (opts = {}) => {
      const rows = opts.userId
        ? await table().where("[module+userId]").equals([module, opts.userId]).toArray()
        : await table().where("module").equals(module).toArray();
      return rows as (ModuleStoreItem & { data: T })[];
    },
  };
}
