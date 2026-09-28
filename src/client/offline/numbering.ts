/**
 * Urutan nomor dokumen PER PERANGKAT (bukan per pengguna) untuk nomor lokal (`formatLocalNumber`, @/lib/local-number).
 *
 * - `nextDeviceSeq(scope)` — atomik di transaksi Dexie `meta` (`deviceSeq:<scope>`); nilai = max(urutan lokal,
 *   batas bawah dari server) + 1. Tidak pernah direset.
 * - `seedDeviceSeqFloors(floors)` — batas bawah dari server (`deviceSeq` di respons aktivasi & pull = urutan terbesar
 *   yang sudah tercatat server untuk perangkat ini). Setelah hapus data + aktivasi ulang, urutan melanjutkan dari
 *   server sehingga nomor lokal tidak bentrok (bentrok unik = `DUPLICATE_DATA` rejected final).
 */
import { fieldDb } from "./db";

const SEQ = (scope: string) => `deviceSeq:${scope}`;
const FLOOR = (scope: string) => `deviceSeqFloor:${scope}`;

/** Ambil nomor urut berikutnya untuk lingkup (atomik antar tab — satu transaksi IndexedDB). */
export async function nextDeviceSeq(scope: string): Promise<number> {
  const db = fieldDb();
  return db.transaction("rw", db.meta, async () => {
    const current = Number((await db.meta.get(SEQ(scope)))?.value ?? 0);
    const floor = Number((await db.meta.get(FLOOR(scope)))?.value ?? 0);
    const next = Math.max(current, floor) + 1;
    await db.meta.put({ key: SEQ(scope), value: next });
    return next;
  });
}

/** Terapkan batas bawah urutan dari server (hanya menaikkan). */
export async function seedDeviceSeqFloors(floors: Record<string, number> | null | undefined): Promise<void> {
  if (!floors) return;
  const db = fieldDb();
  await db.transaction("rw", db.meta, async () => {
    for (const [scope, value] of Object.entries(floors)) {
      if (!Number.isFinite(value)) continue;
      const prev = Number((await db.meta.get(FLOOR(scope)))?.value ?? 0);
      if (value > prev) await db.meta.put({ key: FLOOR(scope), value });
    }
  });
}
