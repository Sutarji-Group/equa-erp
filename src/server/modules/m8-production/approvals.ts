/**
 * M8 — handler jenis persetujuan milik modul ini (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * M8 TIDAK memiliki jenis persetujuan 6.2a:
 * - Koreksi pembacaan meter & pembalik pengisian (BR-38) adalah koreksi VOLUME tanpa nilai rupiah — ambang koreksi
 *   PAR-21 (> Rp 500.000) tidak berlaku; koreksi langsung oleh Admin Keuangan dengan alasan (+ foto pembanding) dan
 *   berjejak audit, pencatatnya tidak dapat mengoreksi catatannya sendiri (SOD-01).
 * - Putaran/penggantian meter oleh admin sistem/Admin Keuangan beralasan (US-M8-01 KP-2) — bukan persetujuan.
 * - Penjelasan susut diputuskan pemilik (terima/kembalikan) sebagai langkah alur neraca (US-M8-04 KP-2), dan susut negatif
 *   diverifikasi Admin Keuangan (KP-5) — keduanya tindakan langsung berjejak, bukan permintaan persetujuan.
 * - Jadwal uji mutu ditetapkan pemilik (keputusan langsung, 6.2b).
 * Nilai pasokan depot (transfer internal BR-33) mengikuti volume diterima M6 — koreksinya milik M6.
 */
import "server-only";

export function registerApprovals(): void {
  // Tidak ada jenis persetujuan M8 (lihat keterangan berkas).
}
