/**
 * M8 — Produksi & Stok Air: API PUBLIK modul. Meter, pengisian truk, pasokan depot, neraca air, utilisasi, mutu (PRD 7.8).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "m8-production" as const;
export const MODULE_NAME = "Produksi & Stok Air" as const;
