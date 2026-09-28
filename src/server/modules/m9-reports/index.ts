/**
 * M9 — Laporan & Dashboard: API PUBLIK modul. Ringkasan H+0, laporan bulanan, katalog laporan, kinerja, tren, KPI, kotak masuk (PRD 7.9).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "m9-reports" as const;
export const MODULE_NAME = "Laporan & Dashboard" as const;
