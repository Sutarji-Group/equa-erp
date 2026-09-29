/**
 * P2 — jenis persetujuan milik modul ini (PRD 6.2a).
 *
 * Tabel 6.2a TIDAK memuat jenis persetujuan Tahap 2: pesanan aplikasi dikonfirmasi/ditolak Dispatcher dalam tenggat
 * PAR-75 (bukan persetujuan; lewat tenggat → notifikasi `customer_app.order_confirm_overdue`, job
 * `p2.app_orders.overdue`), pesanan tempo di luar kontrol kredit dari aplikasi DITOLAK dengan alasan singkat
 * (US-P2-02 KP-3 — pelanggan tidak mengajukan persetujuan pemilik; Dispatcher tetap dapat memakai `credit_order` M2),
 * dan hapus akun memakai `anonymization` milik M10 (US-M10-06 KP-2). Karena itu tidak ada `registerApprovalHandler`.
 */
import "server-only";

export function registerApprovals(): void {
  // Sengaja kosong — lihat keterangan berkas.
}
