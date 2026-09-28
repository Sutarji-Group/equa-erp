/**
 * M4 — Kas & Setoran: API PUBLIK modul. Posisi kas, setoran, selisih, transfer masuk, kas kantor, kas kecil, tutup kas (PRD 7.4).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "m4-cash" as const;
export const MODULE_NAME = "Kas & Setoran" as const;
