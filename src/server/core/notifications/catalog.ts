/**
 * Katalog peristiwa notifikasi (PRD Bab 6.3 + peristiwa platform US-M9-04, US-M10-0x). Kode = kolom
 * `notifications.event`; `severity` critical tidak dapat dimatikan (US-M9-04 KP-3).
 *
 * BERKAS BERSAMA — modul MENAMBAH kode baru (append). Modul memanggil `notify(tx, { event: "<kode>", … })`; penerima
 * bawaan = `defaultRoles` bila `recipients` tidak diberikan.
 */
import type { NotificationSeverity, RoleCode } from "@/lib/labels";

export type NotificationEventDef = {
  code: string;
  label: string;
  severity: NotificationSeverity;
  defaultRoles: readonly RoleCode[];
  /** Tenggat tindak lanjut (jam) untuk `deadline_at`; kosong = tanpa tenggat. */
  deadlineHours?: number;
  /** Tenggat 6.3 selain jam: hari kerja (lewati Sabtu/Minggu, berakhir 23.59 WIB) atau menit. Mengalahkan `deadlineHours`. */
  deadlineRule?: { kind: "business_days"; days: number } | { kind: "minutes"; minutes: number };
  /**
   * Kode berlingkup unit: `notify()` tanpa `recipients.scope` untuk unit ini DITOLAK (galat program) agar operator
   * outlet lain tidak ikut menerima.
   */
  defaultScope?: "outlet" | "truck" | "source";
  /** Tindak lanjut (Bab 6.3 kolom "Tindak lanjut & tenggat"). */
  followUp: string;
  ref: string;
};

function e(
  code: string,
  label: string,
  severity: NotificationSeverity,
  defaultRoles: readonly RoleCode[],
  followUp: string,
  ref: string,
  deadlineHours?: number,
): NotificationEventDef {
  return { code, label, severity, defaultRoles, followUp, ref, deadlineHours };
}

export const NOTIFICATION_EVENTS: readonly NotificationEventDef[] = [
  // --- Bab 6.3 ---
  e("discrepancy.over_threshold", "Selisih setoran ≥ ambang", "critical", ["owner", "finance_admin"], "Alasan dan keputusan ≤ 24 jam", "BR-09", 24),
  e("deposit.not_received_at_close", "Setoran belum diterima saat tutup kas", "high", ["finance_admin"], "Tidak dapat menutup kas (FR-M4-06)", "P-06"),
  e("deposit.depot_late", "Setoran depot terlambat", "normal", ["finance_admin"], "Tagih setoran", "P-02 langkah 6, PAR-27"),
  e("trip.underpayment", "Kurang bayar di lapangan", "critical", ["finance_admin", "dispatcher"], "Faktur jatuh tempo H+0; pesanan berikutnya bertanda \"tagih kurang bayar\"", "PTB-18"),
  e("transfer.not_found", "Transfer tidak ditemukan", "critical", ["owner", "finance_admin"], "Tindak lanjut ke pelanggan/penyetor", "US-M4-04, PAR-39"),
  e("travel_explanation.missing", "Keterangan perjalanan belum diisi", "normal", ["owner"], "Tinjau; minta keterangan", "BR-25, US-M3-06"),
  e("outlet_cash.over_limit", "Kas outlet melebihi batas", "high", ["depot_operator", "finance_admin"], "Setor sebagian", "BR-08, PAR-02"),
  e("pos.excessive_voids", "Void berlebih", "normal", ["finance_admin"], "Tinjau", "BR-13, PAR-03"),
  e("order.duplicate", "Pesanan dobel", "normal", ["dispatcher"], "Konfirmasi atau batalkan", "FR-M2-04"),
  e("order.unscheduled", "Pesanan belum terjadwal", "high", ["dispatcher"], "Jadwalkan", "FR-M2-03"),
  e("trip.failed", "Rit gagal / dua gagal berturut", "high", ["dispatcher"], "Jadwal ulang; konfirmasi ulang", "FR-M2-09, BR-24"),
  e("trip.location_deviation", "Penyimpangan lokasi > 1 km", "normal", ["owner"], "Tinjau H+0", "BR-23, FR-M12-03"),
  e("fleet.off_schedule", "Perjalanan di luar jadwal/jam", "high", ["owner", "dispatcher"], "Keterangan sopir hari yang sama", "BR-25, FR-M12-04"),
  e("gps.device_dead", "Perangkat GPS mati/dicabut", "critical", ["system_admin", "dispatcher"], "Periksa perangkat", "FR-M12-08, NFR-28, PAR-25"),
  e("fleet.unknown_stop", "Berhenti tidak dikenal saat rit aktif", "high", ["dispatcher", "owner"], "Keterangan sopir hari yang sama", "US-M12-05, PAR-51"),
  e("fleet.location_inconsistent", "Sumber lokasi tidak konsisten", "normal", ["owner"], "Tinjau H+0", "US-M12-04"),
  e("approval.overdue", "Permintaan persetujuan lewat tenggat", "high", ["owner"], "Putuskan; naik ke puncak kotak masuk", "US-M10-04"),
  e("outlet.water_balance_exceeded", "Neraca air outlet melebihi toleransi", "normal", ["owner"], "Periksa pasokan/pencatatan outlet", "US-M6-05, PAR-59"),
  e("water_supply.unconfirmed", "Pasokan depot belum dikonfirmasi", "normal", ["finance_admin"], "Konfirmasi operator", "US-M6-05, PAR-61"),
  e("production.missing_or_negative", "Produksi belum tercatat / susut negatif", "high", ["owner", "finance_admin"], "Lengkapi/verifikasi", "US-M8-01, US-M8-04"),
  e("period.not_closed", "Periode belum ditutup", "high", ["finance_admin", "owner"], "Tutup ≤ tanggal 10 (BR-32)", "US-M11-10, PAR-71"),
  e("water.loss_over_threshold", "Susut air di atas ambang", "high", ["owner", "production_operator"], "Investigasi", "BR-26, PAR-18"),
  e("source.utilization_high", "Utilisasi sumber tinggi berturut", "normal", ["owner"], "Rencana kapasitas", "FR-M8-04, PAR-19, PAR-85"),
  e("receivable.reminder_due", "Piutang H-3 / H+1", "info", ["finance_admin"], "Kirim pengingat", "FR-M5-05, PAR-13"),
  e("credit.on_hold", "Status kredit Ditahan", "critical", ["dispatcher", "finance_admin", "owner"], "Tagih; terbuka otomatis saat lunas", "BR-03, PAR-09"),
  e("tax.pkp_threshold", "Omzet 12 bulan mendekati batas PKP", "high", ["owner", "finance_admin"], "Siapkan pengukuhan PKP", "BR-29, PAR-22"),
  e("store.stock_minimum", "Stok minimum toko", "normal", ["store_cashier"], "Daftar pesan ulang", "FR-M7-02"),
  e("special_price.review_due", "Harga khusus lewat 6 bulan", "info", ["owner"], "Tinjau", "BR-16, PAR-24"),
  e("sync.mass_failure", "Sinkron gagal massal / layanan mati", "critical", ["system_admin"], "Insiden kritis ≤ 30 menit", "NFR-28, NFR-31"),
  e("access.request_pending", "Permintaan akses menunggu", "normal", ["owner"], "Putuskan ≤ 2 hari kerja", "US-M10-01 KP-8", 48),
  e("discrepancy.trip_lock", "Selisih besar mengunci rit", "critical", ["owner", "dispatcher"], "Putuskan sebelum rit pertama esok hari", "PTB-62, PAR-83"),
  e("partner.water_order_sla", "Pesanan air mitra lewat SLA", "high", ["dispatcher", "owner"], "Jadwalkan segera", "US-P3-08, PAR-76"),
  e("partner.support_sla", "Permintaan dukungan mitra lewat SLA", "normal", ["owner"], "Tindak lanjut", "US-P3-11, PAR-76"),
  e("support.feedback_unanswered", "Masukan lapangan belum dijawab", "normal", ["system_admin"], "Jawab", "US-M10-07 KP-3, PAR-87"),

  // --- Platform & turunan user story ---
  e("approval.requested", "Permintaan persetujuan baru", "normal", ["owner"], "Putuskan dari kotak persetujuan", "US-M10-04"),
  e("approval.decided", "Permintaan Anda diputuskan", "normal", [], "Lihat keputusan", "US-M10-04 KP-3"),
  e("approval.delegated_decision", "Keputusan lewat delegasi", "info", ["owner"], "Tinjau keputusan delegasi", "US-M10-04 KP-5"),
  e("parameter.changed", "Parameter diubah pemilik", "info", ["finance_admin"], "Perhatikan nilai baru", "6.2b, US-M10-04 KP-6"),
  e("price.changed_by_owner", "Harga diubah langsung oleh pemilik", "normal", ["finance_admin", "dispatcher"], "Perhatikan harga baru", "BR-15, 6.2b"),
  e("period.reopened", "Periode terkunci dibuka kembali", "high", ["finance_admin", "accountant"], "Tinjau perubahan periode", "BR-32, 6.2b"),
  e("credit.hold_deferred", "Penahanan kredit ditunda pemilik", "info", ["dispatcher", "finance_admin"], "Perhatikan masa transisi", "PAR-41, 6.2b"),
  e("access.repeated_denial", "Percobaan tindakan terlarang berulang", "high", ["owner"], "Tinjau log akses pengguna", "US-M10-03 KP-2"),
  e("journal.queued", "Jurnal masuk antrean (belum terposting)", "high", ["finance_admin"], "Lengkapi pemetaan/akun lalu proses ulang", "US-M11-02 KP-3"),
  e("daily_summary.published", "Ringkasan H+0 terbit", "normal", ["owner"], "Baca ringkasan hari ini", "US-M9-01 KP-2"),
  e("device.pin_locked", "PIN pengguna terkunci", "normal", ["system_admin"], "Bantu pengguna bila perlu", "US-M3-10 KP-1, PAR-36"),
  e("user.pin_reset", "PIN pengguna direset", "info", ["owner"], "Informasi", "US-M10-02 KP-3"),
  e("device.lost_queue", "Antrean perangkat hilang", "high", ["owner"], "Tinjau pencatatan \"dicatat kantor\"", "US-M10-02 KP-6, US-M3-09 KP-5"),
  e("deposit.not_submitted", "Setoran sopir belum diajukan", "normal", ["finance_admin"], "Ingatkan sopir", "US-M3-07 KP-5, PAR-44"),
  e("supplier_payable.due", "Utang pemasok jatuh tempo", "normal", ["finance_admin"], "Jadwalkan pembayaran", "US-M7-08"),
  e("quality_test.failed", "Uji mutu air tidak lulus", "high", ["owner"], "Tindakan wajib", "US-M8-06 KP-2"),
  e("quality_test.due", "Jadwal uji mutu mendekat", "info", ["owner", "production_operator"], "Siapkan uji", "US-M8-06 KP-1"),
  e("stock_count.overdue", "Opname belum dilakukan", "normal", ["finance_admin"], "Lakukan opname", "US-M6-04 KP-4, US-M7-05 KP-4"),
  e("receivable.weekly_aging", "Ringkasan umur piutang mingguan", "info", ["owner"], "Baca ringkasan", "US-M5-04, PAR-40"),
  e("incident.opened", "Insiden baru", "critical", ["system_admin"], "Tanggapi ≤ 30 menit", "NFR-31"),

  // --- Tambahan tinjauan pasca-F3c ---
  e("auth.totp_unreadable", "Rahasia 2FA pengguna tidak terbaca", "high", ["owner", "system_admin"], "Reset 2FA lewat Akses > Pengguna (berjejak)", "PTB-35"),
  e("user.totp_reset", "2FA pengguna direset", "info", ["owner"], "Informasi", "PTB-35, 7.10.6"),
  e("pos.void_requested", "Permintaan void POS", "info", ["finance_admin"], "Pantau; keputusan oleh pemilik", "6.2a, BR-13"),

  // --- M1 master data (tambahan agen M1) ---
  e("address.coordinate_proposed", "Usulan kunci koordinat alamat dari rit Selesai", "normal", ["dispatcher"], "Konfirmasi atau tolak koordinat di Data master > Pelanggan", "US-M1-01 KP-2, BRD 10.2"),
  e("truck.trips_need_reassignment", "Rit perlu dipindahkan: truk Perbaikan/Nonaktif", "high", ["dispatcher"], "Pindahkan rit ke truk lain", "US-M1-03 KP-2"),
  e("zone.addresses_moved", "Alamat berpindah zona akibat perubahan batas", "normal", ["owner"], "Tinjau daftar alamat di Data master > Zona tarif", "US-M1-05 KP-4"),
  e("initial_data.signoff_pending", "Ringkasan data awal menunggu tanda tangan", "normal", ["owner"], "Tinjau & tanda tangani sebelum go-live", "US-M1-06 KP-4, NFR-34"),
  e("credit.migrated_set", "Tempo migrasi ditetapkan pemilik (tanda tangan data awal)", "info", ["finance_admin"], "Perhatikan batas & tempo pelanggan lama", "US-M1-06 KP-6, 6.2b"),
  // --- Tambahan modul M10 (hanya tambah) ---
  e("access.daily_summary", "Ringkasan perubahan akses hari ini", "info", ["owner"], "Baca ringkasan; tinjau bila ada yang tidak dikenal", "US-M10-01 KP-7"),
  e("user.password_reset", "Kata sandi pengguna direset", "info", ["owner"], "Informasi", "US-M10-02 KP-4, 7.10.6"),
  e("user.deactivated", "Akun pengguna dinonaktifkan", "info", ["owner"], "Informasi", "US-M10-01 KP-5, BR-37"),
  e("access_review.due", "Tinjauan hak akses kuartalan belum dilakukan", "normal", ["owner"], "Tinjau daftar pengguna & tandai ditinjau", "US-M10-01 KP-6, PAR-47"),
  e("anonymization.deferred", "Anonimisasi ditunda (piutang terbuka)", "normal", ["system_admin"], "Beri tahu pemohon; ajukan ulang setelah lunas", "US-M10-06 KP-2, PTB-36"),
  e("anonymization.executed", "Anonimisasi data pribadi dijalankan", "info", ["owner", "system_admin"], "Informasi", "US-M10-06 KP-2"),
  e("backup.failed", "Pencadangan gagal", "high", ["system_admin", "owner"], "Ulangi pencadangan & catat hasilnya", "US-M10-06 KP-4, NFR-13"),
  e("support.ticket_answered", "Laporan kendala Anda dijawab", "normal", [], "Baca jawaban; tandai selesai bila sudah beres", "US-M10-07 KP-3"),
  // --- Tambahan modul M6 (Penjualan Depot / kerangka POS) — hanya tambah ---
  e("pos.qris_voided", "Transaksi QRIS di-void", "normal", ["finance_admin"], "Catat pengembalian dana di luar sistem sebagai pengeluaran dengan rujukan", "US-M6-03 KP-4"),
  e("pos.void_reversal_needed", "Void disetujui setelah shift ditutup", "high", ["finance_admin"], "Buat transaksi pembalik di Pemantauan outlet", "US-M6-03 KP-2, PTB-43"),
  e("water_supply.discrepancy", "Selisih pasokan air depot (kirim vs terima)", "normal", ["dispatcher"], "Periksa catatan sopir & operator; masukan neraca air M8", "US-M6-05 KP-1, P-04 langkah 3"),
  e("pos.shift_conflict", "Konflik shift POS (dua shift terbuka)", "high", ["finance_admin"], "Tinjau shift dari perangkat cadangan; tandai selesai setelah dicocokkan", "7.6.6, Bab 6.4 butir 3"),
  e("tenant.created", "Tenant mitra baru dibuat", "info", ["owner"], "Informasi; lengkapi pengaturan outlet mitra", "US-M6-07 KP-1"),
];

/** Aturan tambahan per kode (tenggat 6.3 & lingkup unit) — dipisah agar daftar di atas tetap ringkas. */
const EXTRA: Record<string, Pick<NotificationEventDef, "deadlineRule" | "defaultScope">> = {
  "access.request_pending": { deadlineRule: { kind: "business_days", days: 2 } },
  "sync.mass_failure": { deadlineRule: { kind: "minutes", minutes: 30 } },
  "incident.opened": { deadlineRule: { kind: "minutes", minutes: 30 } },
  "outlet_cash.over_limit": { defaultScope: "outlet" },
  "store.stock_minimum": { defaultScope: "outlet" },
};
for (const ev of NOTIFICATION_EVENTS) Object.assign(ev, EXTRA[ev.code] ?? {});

const BY_CODE = new Map(NOTIFICATION_EVENTS.map((ev) => [ev.code, ev]));

export function getNotificationEvent(code: string): NotificationEventDef | undefined {
  return BY_CODE.get(code);
}

export function isNotificationEvent(code: string): boolean {
  return BY_CODE.has(code);
}

/** Benar bila jenis notifikasi dapat dimatikan pengguna (bukan kritis). */
export function canDisable(code: string): boolean {
  return (BY_CODE.get(code)?.severity ?? "normal") !== "critical";
}
