/**
 * Parameter Lampiran B PRD v1.1 (PAR-01..PAR-89) — nilai bawaan terstruktur (jsonb), satuan, rujukan — ditambah
 * pengaturan non-PAR (`company.identity`, dll.) dan feature flag bawaan (D-02, D-03).
 *
 * Konvensi kunci nilai: `amount` (Rp), `amount_gt` (Rp, ambang "lebih dari"), `amount_gte` (≥), `days`, `minutes`,
 * `hours`, `percent`, `time` ('HH:mm' WIB), `start`/`end` ('HH:mm'), `count`. Nilai "ditetapkan pemilik (tanpa bawaan)"
 * disimpan `null` dengan `configured: false`.
 */
import { SEED_EFFECTIVE_FROM } from "./constants";

export type ParameterSeed = {
  key: string;
  name: string;
  value: Record<string, unknown>;
  unit: string | null;
  reference: string;
  description?: string;
};

export const LAMPIRAN_B_PARAMETERS: ParameterSeed[] = [
  { key: "PAR-01", name: "Ambang selisih setoran → notifikasi pemilik", value: { amount: 50_000 }, unit: "Rp per sopir/outlet per hari", reference: "BR-09, K12", description: "Selisih ≥ nilai ini diteruskan ke pemilik (≤ 24 jam). Evaluasi setelah 3 bulan." },
  { key: "PAR-02", name: "Kas maksimal di outlet depot", value: { amount: 2_000_000 }, unit: "Rp", reference: "BR-08, K21" },
  { key: "PAR-03", name: "Void per hari per outlet → notifikasi", value: { count: 3 }, unit: "kejadian", reference: "BR-13", description: "Lebih dari nilai ini per hari per outlet → notifikasi Admin Keuangan." },
  { key: "PAR-04", name: "Void yang perlu persetujuan", value: { amount_gt: 100_000 }, unit: "Rp", reference: "BR-13" },
  { key: "PAR-05", name: "Batas pesanan H+0", value: { time: "15:00" }, unit: "WIB", reference: "BR-20" },
  { key: "PAR-06", name: "Batas tutup kas harian", value: { time: "22:00" }, unit: "WIB", reference: "BR-14, K21" },
  { key: "PAR-07", name: "Jam layanan", value: { start: "05:00", end: "22:00" }, unit: "WIB, setiap hari", reference: "NFR-01" },
  { key: "PAR-08", name: "Tempo standar", value: { days: 14 }, unit: "hari sejak pengiriman", reference: "BR-02" },
  { key: "PAR-09", name: "Toleransi lewat tempo sebelum Ditahan", value: { days: 7 }, unit: "hari", reference: "BR-03" },
  {
    key: "PAR-10",
    name: "Batas kredit per segmen",
    value: {
      cash_only_segments: ["household"],
      limits: {
        third_party_depot: 3_000_000,
        housing: 3_000_000,
        industry: 10_000_000,
        construction: 10_000_000,
        hotel: 10_000_000,
        swimming_pool: 10_000_000,
      },
    },
    unit: "Rp",
    reference: "BR-04, K16",
    description: "Rumah tangga: tunai saja.",
  },
  {
    key: "PAR-11",
    name: "Syarat pemberian Tempo (lama/volume)",
    value: { min_months_since_first_completed: 3, min_completed_orders: 10, combine: "or", also_requires: "PAR-82" },
    unit: null,
    reference: "BR-01",
  },
  {
    key: "PAR-12",
    name: "Faktur bulanan: tanggal terbit / jatuh tempo",
    value: { issue_day: 1, issue_month_offset: 1, due_day: 15, due_month_offset: 1 },
    unit: "tanggal",
    reference: "BR-05, PTB-26, CR-07",
    description: "Layanan bulan M: terbit tanggal 1 bulan M+1, jatuh tempo tanggal 15 bulan M+1.",
  },
  { key: "PAR-13", name: "Pengingat piutang", value: { days_before_due: 3, days_after_due: 1 }, unit: "hari", reference: "FR-M5-05" },
  { key: "PAR-14", name: "Diskon kasir toko tanpa persetujuan", value: { max_percent: 5 }, unit: "%", reference: "BR-17" },
  { key: "PAR-15", name: "Volume standar rit", value: { liters: 5_000 }, unit: "L", reference: "BR-22" },
  {
    key: "PAR-16",
    name: "Penyimpangan lokasi Selesai: wajib alasan / tinjauan pemilik",
    value: { reason_required_gt_m: 200, owner_review_gt_m: 1_000 },
    unit: "m",
    reference: "BR-23",
  },
  { key: "PAR-17", name: "Rit gagal berturut → konfirmasi ulang", value: { count: 2 }, unit: "kejadian", reference: "BR-24" },
  { key: "PAR-18", name: "Susut air maksimal", value: { max_percent: 5 }, unit: "% per sumber per hari", reference: "BR-26" },
  { key: "PAR-19", name: "Peringatan utilisasi sumber (penanda harian di dashboard)", value: { percent_gt: 90 }, unit: "%", reference: "FR-M8-04, P-04 langkah 5" },
  {
    key: "PAR-20",
    name: "Jurnal manual yang perlu persetujuan sebelum posting",
    value: { amount_gt: 5_000_000 },
    unit: "Rp",
    reference: "BR-35, PTB-12",
    description: "≤ nilai ini: terposting dan masuk tinjauan wajib pemilik saat tutup buku.",
  },
  { key: "PAR-21", name: "Koreksi yang perlu persetujuan", value: { amount_gt: 500_000 }, unit: "Rp", reference: "BR-38" },
  {
    key: "PAR-22",
    name: "Batas omzet PKP dan peringatan",
    value: { threshold: 4_800_000_000, warn_percents: [80, 90], window_months: 12 },
    unit: "Rp, 12 bulan berjalan",
    reference: "BR-29",
  },
  { key: "PAR-23", name: "Tutup buku paling lambat", value: { day_of_next_month: 10 }, unit: "tanggal bulan berikutnya", reference: "BR-32" },
  { key: "PAR-24", name: "Tinjauan harga khusus", value: { months: 6 }, unit: "bulan", reference: "BR-16" },
  { key: "PAR-25", name: "Perangkat GPS mati → peringatan", value: { minutes: 15 }, unit: "menit, pada jam layanan", reference: "FR-M12-08" },
  { key: "PAR-26", name: "Pembaruan posisi GPS", value: { max_interval_minutes: 1 }, unit: "menit", reference: "FR-M12-01" },
  { key: "PAR-27", name: "Setoran depot dianggap terlambat", value: { days_gt: 1 }, unit: "hari sejak tutup shift", reference: "P-02" },
  { key: "PAR-28", name: "Periode paralel nota kertas", value: { max_weeks: 2 }, unit: "minggu per unit", reference: "NFR-35" },
  {
    key: "PAR-29",
    name: "Retensi: akuntansi / foto / log akses",
    value: { accounting_years: 10, photo_years: 2, access_log_years: 1 },
    unit: "tahun",
    reference: "BR-31, BRD 10.6",
  },
  { key: "PAR-30", name: "Offline: antrean minimal / sinkron", value: { min_queue_days: 1, sync_max_minutes: 5 }, unit: null, reference: "NFR-06, NFR-07" },
  { key: "PAR-31", name: "Kuota data per sopir", value: { max_mb_per_month: 50 }, unit: "MB/bulan", reference: "NFR-17" },
  { key: "PAR-32", name: "Stok opname", value: { depot: "weekly", store: "monthly" }, unit: null, reference: "BR-27" },
  {
    key: "PAR-33",
    name: "Kapasitas rit per truk per hari (papan jadwal dan slot Tahap 2)",
    value: { trips: 3 },
    unit: "rit (pelanggan + internal)",
    reference: "FR-M2-10, PTB-01",
    description: "Dapat diatur per truk (trucks.daily_trip_capacity); dikalibrasi dari baseline KPI-07 sebelum Tahap 2.",
  },
  { key: "PAR-34", name: "Pembuatan otomatis pesanan langganan", value: { days_before: 2 }, unit: "hari sebelum tanggal kirim", reference: "US-M2-06" },
  {
    key: "PAR-35",
    name: "Kemitraan (Tahap 3): langganan sistem / royalti / radius eksklusif / diskon air Opsi A",
    value: {
      subscription_per_outlet: 150_000,
      royalty_percent_min: 3,
      royalty_percent_max: 5,
      exclusive_radius_m_option_b: 1_000,
      exclusive_radius_m_option_a_min: 1_000,
      exclusive_radius_m_option_a_max: 2_000,
      water_discount_percent_min: 5,
      water_discount_percent_max: 10,
    },
    unit: null,
    reference: "BRD 9.6, K18",
  },
  { key: "PAR-36", name: "PIN salah berturut → kunci sementara", value: { max_attempts: 5, lock_minutes: 15 }, unit: null, reference: "US-M3-10" },
  { key: "PAR-37", name: "Kunci layar aplikasi lapangan saat tidak aktif", value: { idle_minutes: 10 }, unit: "menit", reference: "US-M3-10" },
  {
    key: "PAR-38",
    name: "Ukuran foto setelah kompresi di perangkat",
    value: { max_kb: 150 },
    unit: "KB per foto",
    reference: "US-M3-03, NFR-17",
    description: "Bawaan 150 KB dengan sisi panjang foto 1.280 px (D-14 butir 2; batas PRD ≤ 300 KB). Aplikasi lapangan & formulir kas membaca nilai ini dari server.",
  },
  { key: "PAR-39", name: "Transfer tanpa mutasi → \"Tidak ditemukan\"", value: { days_gt: 2 }, unit: "hari", reference: "US-M4-04" },
  { key: "PAR-40", name: "Ringkasan umur piutang mingguan ke pemilik", value: { iso_weekday: 1, time: "07:00" }, unit: "Senin pagi", reference: "US-M5-04" },
  {
    key: "PAR-41",
    name: "Masa transisi penundaan penahanan kredit",
    value: { max_months_since_go_live: 2, go_live_date: null },
    unit: "bulan sejak go-live (R07)",
    reference: "US-M5-03",
  },
  { key: "PAR-42", name: "Selisih jam perangkat vs server yang ditandai", value: { minutes_gt: 10 }, unit: "menit", reference: "Bab 6.4" },
  { key: "PAR-43", name: "Kas kecil: pengisian/pengeluaran yang perlu persetujuan pemilik", value: { amount_gt: 500_000 }, unit: "Rp", reference: "US-M4-05" },
  { key: "PAR-44", name: "Setoran sopir belum diajukan setelah rit terakhir Selesai", value: { hours_gt: 1 }, unit: "jam", reference: "US-M4-01" },
  { key: "PAR-45", name: "Faktur bersengketa: penundaan pengingat/penahanan", value: { max_days: 7 }, unit: "hari", reference: "7.5.6" },
  { key: "PAR-46", name: "Sesi web kantor: kedaluwarsa tidak aktif / maksimal", value: { idle_minutes: 30, max_hours: 12 }, unit: null, reference: "US-M10-02" },
  { key: "PAR-47", name: "Tinjauan hak akses oleh pemilik", value: { frequency: "quarterly" }, unit: "tiap kuartal", reference: "US-M10-01, R09" },
  { key: "PAR-48", name: "Posisi truk dianggap basi di peta", value: { minutes_gt: 5 }, unit: "menit", reference: "US-M12-02" },
  { key: "PAR-49", name: "Titik berhenti pada riwayat perjalanan", value: { min_minutes: 5 }, unit: "menit tanpa gerak", reference: "US-M12-03" },
  {
    key: "PAR-50",
    name: "Perjalanan di luar jadwal: ambang gerak tanpa rit aktif",
    value: { distance_m_gt: 500, minutes_gt: 10 },
    unit: "> 500 m atau > 10 menit",
    reference: "US-M12-05",
  },
  { key: "PAR-51", name: "Berhenti tidak dikenal saat rit aktif", value: { minutes_gt: 15 }, unit: "menit di luar lokasi sah", reference: "US-M12-05" },
  { key: "PAR-52", name: "Retensi posisi GPS mentah", value: { months: 12 }, unit: "bulan", reference: "PTB-33" },
  {
    key: "PAR-53",
    name: "Konsumsi BBM standar (L/km) dan harga BBM per liter untuk estimasi biaya rit",
    value: { consumption_l_per_km: null, fuel_price_per_l: null, configured: false },
    unit: "L/km; Rp/L",
    reference: "US-M12-07",
    description: "Ditetapkan pemilik (tidak ada bawaan di BRD).",
  },
  { key: "PAR-54", name: "Radius geofence sumber air / depot / pool", value: { water_source_m: 100, outlet_m: 100, pool_m: 100 }, unit: "m", reference: "US-M12-06" },
  { key: "PAR-55", name: "Ringkasan e-mail harian ke pemilik", value: { time: "22:30" }, unit: "WIB (setelah tutup kas)", reference: "US-M9-04, PTB-05" },
  { key: "PAR-56", name: "Jam tenang notifikasi non-kritis", value: { start: "22:00", end: "05:00" }, unit: "WIB", reference: "US-M9-04" },
  { key: "PAR-57", name: "Kas awal tetap per outlet depot/toko", value: { amount: 200_000 }, unit: "Rp", reference: "US-M6-02, PTB-40" },
  {
    key: "PAR-58",
    name: "Toleransi selisih stok harian bahan habis pakai depot sebelum alasan wajib",
    value: { units_per_material: 0 },
    unit: "buah per bahan",
    reference: "US-M6-04",
    description: "0 selama pilot (P-02 langkah 5); dapat dinaikkan pemilik setelah ada data pilot.",
  },
  { key: "PAR-59", name: "Toleransi neraca air outlet depot (mingguan)", value: { percent: 5 }, unit: "%", reference: "US-M6-05" },
  { key: "PAR-60", name: "Batas waktu void pada shift", value: { rule: "open_shift_only" }, unit: "hanya shift yang masih terbuka", reference: "US-M6-03" },
  { key: "PAR-61", name: "Batas konfirmasi penerimaan pasokan depot oleh operator", value: { rule: "until_next_shift_close" }, unit: "sampai tutup shift berikutnya", reference: "US-M6-05" },
  { key: "PAR-62", name: "Penyesuaian saldo awal diizinkan", value: { max_months_after_cutover: 3 }, unit: "bulan setelah cut-over", reference: "PTB-44" },
  {
    key: "PAR-63",
    name: "Metode penyusutan dan umur ekonomis",
    value: { method: "straight_line", useful_life_months_by_category: null },
    unit: null,
    reference: "BR-34, US-M11-05",
    description: "Garis lurus; umur ditetapkan akuntan.",
  },
  { key: "PAR-64", name: "Tarif PPh final UMKM (bila skema dipilih konsultan)", value: { percent: 0.5 }, unit: "% omzet bruto", reference: "BR-30" },
  { key: "PAR-65", name: "Kunci alokasi biaya L1 ke L2/L3", value: { basis: "fill_volume_monthly" }, unit: "proporsi volume pengisian bulanan", reference: "PTB-39" },
  { key: "PAR-66", name: "Barang toko \"mati\"", value: { days_without_sale: 90 }, unit: "hari tanpa penjualan", reference: "US-M7-07" },
  { key: "PAR-67", name: "Jatuh tempo utang pemasok bila nota tidak menyebut", value: { days: 30 }, unit: "hari", reference: "US-M7-08" },
  { key: "PAR-68", name: "Produksi harian menyimpang dari rata-rata 7 hari → verifikasi", value: { percent_gt: 20, window_days: 7 }, unit: "%", reference: "US-M8-01" },
  { key: "PAR-69", name: "Toleransi selisih pasokan depot (diisi vs diterima)", value: { percent: 2 }, unit: "%", reference: "US-M8-03" },
  {
    key: "PAR-70",
    name: "Frekuensi uji laboratorium mutu air",
    value: { frequency_days: null, configured: false },
    unit: "hari",
    reference: "US-M8-06",
    description: "Ditetapkan pemilik/konsultan (tidak ada bawaan di BRD).",
  },
  { key: "PAR-71", name: "Pengingat tutup periode", value: { days_of_next_month: [5, 8] }, unit: "tanggal bulan berikutnya", reference: "US-M11-10" },
  { key: "PAR-72", name: "Batas pembatalan pesanan mandiri oleh pelanggan (Tahap 2)", value: { rule: "until_trip_departed" }, unit: "sampai rit Berangkat", reference: "US-P2-02" },
  {
    key: "PAR-73",
    name: "Slot pengiriman Tahap 2",
    value: {
      slots: [
        { key: "morning", start: "06:00", end: "10:00" },
        { key: "midday", start: "10:00", end: "14:00" },
        { key: "afternoon", start: "14:00", end: "18:00" },
      ],
    },
    unit: "WIB",
    reference: "PTB-51",
  },
  { key: "PAR-74", name: "OTP WhatsApp", value: { digits: 6, valid_minutes: 5, max_attempts: 3 }, unit: null, reference: "US-P2-01" },
  {
    key: "PAR-75",
    name: "Tenggat konfirmasi pesanan aplikasi dan tanggapan keluhan",
    value: { order_confirm_hours: 2, complaint_response_hours: 24, service_hours_only: true },
    unit: "jam layanan",
    reference: "US-P2-02, US-P2-06",
  },
  { key: "PAR-76", name: "SLA kepada mitra: pengiriman air / dukungan teknis", value: { water_delivery_hours: 24, support_response_hours: 48 }, unit: "jam dari pesanan / permintaan", reference: "BRD 9.8" },
  { key: "PAR-77", name: "Evaluasi mitra", value: { months: 3 }, unit: "tiap 3 bulan", reference: "BRD 9.4" },
  { key: "PAR-78", name: "Jangka kontrak mitra", value: { option_b_years: 2, option_a_years: 5 }, unit: "tahun", reference: "BRD 9.6" },
  { key: "PAR-79", name: "Toleransi neraca air mitra (galon terjual × 19 L vs air dibeli EQUA)", value: { percent: 10 }, unit: "% per bulan", reference: "US-P3-06" },
  { key: "PAR-80", name: "Skor mutu minimum sebelum teguran", value: { percent: 80 }, unit: "%", reference: "US-P3-05" },
  { key: "PAR-81", name: "Mitra maksimal Fase 1 sampai kapasitas bertambah", value: { count: 5 }, unit: "mitra", reference: "BRD 9.2, K22" },
  {
    key: "PAR-82",
    name: "Syarat \"tanpa masalah\" untuk pemberian Tempo (dalam periode PAR-11)",
    value: {
      max_underpayments_overdue_7d: 0,
      max_transfers_not_found: 0,
      max_rejected_disputes: 0,
      max_failed_trips_customer_refused: 1,
    },
    unit: null,
    reference: "BR-01, US-M1-01",
  },
  {
    key: "PAR-83",
    name: "Kunci rit karena selisih kurang besar yang belum diputuskan pemilik",
    value: { enabled: false, amount_gte: 500_000 },
    unit: "Rp",
    reference: "US-M4-02, PTB-62",
    description: "Bawaan nonaktif; bila diaktifkan: selisih kurang ≥ nilai ini mengunci rit sopir.",
  },
  {
    key: "PAR-84",
    name: "Tarik nota kertas unit perluasan sebelum atau pada hari ke-14",
    value: { last_operating_days: 5, recorded_at_source_percent: 100, max_unexplained_discrepancies: 0, deadline_day: 14 },
    unit: "hari",
    reference: "NFR-35, 11.5",
  },
  { key: "PAR-85", name: "Notifikasi push utilisasi sumber", value: { consecutive_days: 3, threshold_parameter: "PAR-19" }, unit: "hari", reference: "US-M8-05" },
  { key: "PAR-86", name: "Jendela pemeliharaan sistem", value: { start: "23:30", end: "04:30" }, unit: "WIB", reference: "NFR-01, NFR-32" },
  { key: "PAR-87", name: "Tenggat jawaban masukan lapangan", value: { max_weeks: 1 }, unit: "minggu", reference: "BRD 12.5, US-M10-07" },
  { key: "PAR-88", name: "Perpanjangan periode paralel (pengecualian keputusan komite pengarah)", value: { max_weeks: 1 }, unit: "minggu per unit", reference: "NFR-35, 11.5 (CR-17)" },
  { key: "PAR-89", name: "Setoran tertunda yang diizinkan saat tutup kas (per kejadian, persetujuan pemilik)", value: { max_days: 1 }, unit: "hari", reference: "FR-M4-06, PTB-21 (CR-06)" },
];

/** Pengaturan non-PAR yang disimpan di tabel `parameters` (D-04 dan kebutuhan modul). */
export const EXTRA_SETTINGS: ParameterSeed[] = [
  {
    key: "company.identity",
    name: "Identitas usaha pada struk/faktur",
    value: { name: "EQUA", legal_name: null, address: "Kabupaten Cianjur, Jawa Barat", phone: null, npwp: null },
    unit: null,
    reference: "D-04, Bab 2.3",
    description: "Bawaan nama usaha \"EQUA\"; diganti identitas PT setelah PT berdiri.",
  },
  {
    key: "accounting.cutover_date",
    name: "Tanggal cut-over akuntansi",
    value: { date: null },
    unit: "tanggal 1",
    reference: "NFR-36, US-M11-09",
    description: "Hanya boleh tanggal 1; transaksi sebelum tanggal ini tidak dimigrasi.",
  },
  {
    key: "app.min_supported_version",
    name: "Versi minimal aplikasi lapangan/POS",
    value: { version: "0.1.0" },
    unit: null,
    reference: "US-M10-07 KP-4, NFR-32",
  },
];

/** Feature flag bawaan (D-02, D-03). */
export const DEFAULT_FEATURE_FLAGS: { key: string; enabled: boolean; description: string }[] = [
  { key: "phase2.customer_app", enabled: false, description: "Aplikasi pelanggan Tahap 2 (PRD Bab 8; gerbang TG-9)." },
  { key: "phase3.partner_portal", enabled: false, description: "Portal kemitraan lengkap Tahap 3 (PRD Bab 9)." },
  { key: "approvals.delegation", enabled: false, description: "Pendelegasian persetujuan (PTB-32; bawaan tanpa delegasi)." },
  { key: "partner.franchise_terms", enabled: false, description: "Istilah \"waralaba\" di antarmuka (PTB-57; bawaan \"Mitra Depot EQUA\")." },
  { key: "cash.restitution_active", enabled: false, description: "Ganti rugi karyawan aktif setelah Peraturan Perusahaan berlaku (BR-11, PTB-22)." },
];

export const PARAMETER_EFFECTIVE_FROM = SEED_EFFECTIVE_FROM;

/**
 * Bawaan Lampiran B yang BERUBAH setelah rilis (hanya tambah). DB yang sudah di-seed versi sebelumnya dimutakhirkan
 * `upgradeChangedDefaults` (dipanggil `seedBaseSettings`, jadi juga `pnpm db:seed:prod`): bila nilai global yang berlaku
 * masih baris seed dengan nilai lama (`previous`) — artinya pemilik belum pernah mengubahnya — ditambahkan versi baru
 * berlaku hari itu (riwayat tidak diubah, tidak berlaku surut). Nilai yang sudah ditetapkan pemilik tidak disentuh.
 */
export const CHANGED_DEFAULTS: readonly { key: string; previous: Record<string, unknown>; release: string; reason: string }[] = [
  {
    key: "PAR-38",
    previous: { max_kb: 300 },
    release: "v1.0.1",
    reason: "Bawaan baru v1.0.1: PAR-38 150 KB, sisi panjang foto 1.280 px (D-14 butir 2, kuota sopir NFR-17).",
  },
];
