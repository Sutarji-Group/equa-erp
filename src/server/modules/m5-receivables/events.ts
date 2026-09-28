/**
 * M5 — handler event domain milik modul ini.
 *
 * Daftarkan HANYA di dalam `registerEvents()` (bukan di top-level berkas) agar impor melingkar core ↔ modul aman:
 * ```ts
 * import { on } from "@/server/core/events";
 * export function registerEvents(): void {
 *   on("trip.completed", async (event, tx) => { … }, { name: "m5-receivables:contoh" });
 * }
 * ```
 * Handler berjalan di transaksi yang sama dengan `emit`, di SAVEPOINT (bawaan `isolate: true`): galat handler hanya
 * membatalkan tulisan handler itu dan dicatat sebagai insiden — transaksi sumber (mis. perintah lapangan) tetap commit
 * (R04, Bab 6.4 butir 3). Pakai `{ isolate: false }` hanya untuk efek yang wajib atomik dengan sumbernya. `name` wajib
 * unik (registrasi ulang bernama sama mengganti yang lama). Isi `tenantId` jurnal/notifikasi dari `event.tenantId`.
 */
import "server-only";

export function registerEvents(): void {
  // Belum ada handler — diisi agen modul M5.
}
