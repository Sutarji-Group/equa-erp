/**
 * M1 — Master Data: API PUBLIK modul. Pelanggan, alamat, produk & harga, zona tarif, armada, depot, sumber air, karyawan, impor data awal (PRD 7.1).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "m1-master" as const;
export const MODULE_NAME = "Master Data" as const;
