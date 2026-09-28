/**
 * M11 — Akuntansi & Pajak: API PUBLIK modul. Bagan akun, jurnal otomatis/manual, buku besar, aset, rekonsiliasi, periode, pajak (PRD 7.11).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "m11-accounting" as const;
export const MODULE_NAME = "Akuntansi & Pajak" as const;
