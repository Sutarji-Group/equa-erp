/**
 * M5 — Piutang & Penagihan: API PUBLIK modul. Faktur, pelunasan, umur piutang, Ditahan, pengingat, faktur bulanan (PRD 7.5).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "m5-receivables" as const;
export const MODULE_NAME = "Piutang & Penagihan" as const;
