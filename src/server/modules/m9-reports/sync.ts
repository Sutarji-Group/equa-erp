/**
 * M9 — sinkron lapangan. M9 (Laporan & Dashboard) TIDAK memiliki aksi lapangan maupun data referensi offline: semua
 * layar M9 adalah web kantor daring (PRD 7.9.2). Sopir/operator melihat kinerjanya sendiri di aplikasinya lewat pull
 * modul pemiliknya (US-M3-07 KP-6 `m3.deposits`, US-M6-06 riwayat shift `m6.pos`). Fungsi ini sengaja kosong.
 */
import "server-only";

export function registerSync(): void {
  // Tidak ada perintah sinkron atau penyedia pull untuk M9.
}
