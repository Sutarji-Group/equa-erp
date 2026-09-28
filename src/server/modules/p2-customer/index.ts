/**
 * P2 — Aplikasi Pelanggan (Tahap 2): API PUBLIK modul. Akun pelanggan, pesanan mandiri, pembayaran digital, keluhan (PRD Bab 8; flag phase2.customer_app).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 */
import "server-only";

export const MODULE_KEY = "p2-customer" as const;
export const MODULE_NAME = "Aplikasi Pelanggan (Tahap 2)" as const;
