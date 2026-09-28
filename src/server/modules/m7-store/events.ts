/**
 * M7 — handler event domain milik modul ini.
 *
 * Daftarkan HANYA di dalam `registerEvents()` (bukan di top-level berkas) agar impor melingkar core ↔ modul aman:
 * ```ts
 * import { on } from "@/server/core/events";
 * export function registerEvents(): void {
 *   on("trip.completed", async (event, tx) => { … }, { name: "m7-store:contoh" });
 * }
 * ```
 * Handler berjalan di transaksi yang sama dengan `emit`; galat membatalkan seluruh transaksi.
 */
import "server-only";

export function registerEvents(): void {
  // Belum ada handler — diisi agen modul M7.
}
