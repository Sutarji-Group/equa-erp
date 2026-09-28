/**
 * M6 — Penjualan Depot (POS): API PUBLIK modul. POS depot, shift, void, bahan habis pakai, pasokan air, multi-tenant (PRD 7.6).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "m6-pos" as const;
export const MODULE_NAME = "Penjualan Depot (POS)" as const;
