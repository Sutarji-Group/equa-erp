/**
 * M12 — Pelacakan Armada / GPS: API PUBLIK modul. Posisi GPS, peta, riwayat perjalanan, kejadian armada, geofence (PRD 7.12).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "m12-fleet" as const;
export const MODULE_NAME = "Pelacakan Armada / GPS" as const;
