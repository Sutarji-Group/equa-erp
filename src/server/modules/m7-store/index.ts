/**
 * M7 — Penjualan Toko & Stok: API PUBLIK modul. POS toko, penerimaan barang, stok, opname, transfer internal, utang pemasok (PRD 7.7).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "m7-store" as const;
export const MODULE_NAME = "Penjualan Toko & Stok" as const;
