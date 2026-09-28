/**
 * P3 — Kemitraan (RL-7 & Tahap 3): API PUBLIK modul. Mitra depot, kontrak, pasokan mitra, tagihan langganan, dukungan, mutu (PRD Bab 9).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "p3-partner" as const;
export const MODULE_NAME = "Kemitraan (RL-7 & Tahap 3)" as const;
