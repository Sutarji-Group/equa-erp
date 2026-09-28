/**
 * M12 — handler jenis persetujuan milik modul ini (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * M12 TIDAK memiliki jenis persetujuan 6.2a: tinjauan penyimpangan lokasi (BR-23) dan keterangan perjalanan (BR-25)
 * adalah 6.2c (pengesampingan beralasan oleh pelaku, ditinjau pemilik setelahnya — `reviewFleetEvent`), perubahan
 * parameter deteksi adalah 6.2b (keputusan langsung pemilik lewat `params.set`, berjejak), dan perubahan zona hasil
 * pemeriksaan zona hanya lewat persetujuan M1 (`price_change` / tabel zona, US-M1-05). Fungsi ini sengaja kosong.
 */
import "server-only";

export function registerApprovals(): void {
  // Tidak ada jenis persetujuan milik M12 (lihat keterangan berkas).
}
