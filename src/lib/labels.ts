/**
 * Label Bahasa Indonesia untuk enum & kode peran (docs/ARCHITECTURE.md §4).
 * Kode = bahasa Inggris; UI = istilah PRD. Berkas BERSAMA: hanya boleh DITAMBAH (append), jangan ubah/rename entri.
 *
 * Pakai: `label("order_status", order.status)` → `"Menunggu persetujuan"`.
 * Nilai enum untuk `pgEnum`/Zod: `enumValues("order_status")` → `["new", "awaiting_approval", …]`.
 */

export const LABELS = {
  /** Kode peran (`RoleCode`). */
  role: {
    owner: "Pemilik",
    finance_admin: "Admin Keuangan",
    dispatcher: "Dispatcher",
    driver: "Sopir",
    helper: "Kernet",
    depot_operator: "Operator depot",
    store_cashier: "Kasir toko",
    production_operator: "Operator produksi",
    system_admin: "Admin sistem",
    accountant: "Akuntan",
    partner_owner: "Pemilik mitra",
    regional_coach: "Pembina wilayah",
  },
  /** Status pesanan. */
  order_status: {
    new: "Baru",
    awaiting_approval: "Menunggu persetujuan",
    scheduled: "Terjadwal",
    in_delivery: "Dalam pengiriman",
    completed: "Selesai",
    cancelled: "Dibatalkan",
  },
  /** Status rit. */
  trip_status: {
    assigned: "Ditugaskan",
    departed: "Berangkat",
    arrived: "Tiba",
    completed: "Selesai",
    failed: "Gagal",
  },
  /** Status setoran (sopir/depot/toko). */
  deposit_status: {
    running: "Berjalan",
    submitted: "Diajukan",
    received: "Diterima",
    closed: "Ditutup",
  },
  /** Sumber setoran. */
  deposit_source_type: {
    driver: "Sopir",
    depot_shift: "Shift depot",
    store_shift: "Shift toko",
  },
  /** Status selisih. */
  discrepancy_status: {
    formed: "Terbentuk",
    explained: "Dijelaskan",
    approved: "Disetujui",
    rejected: "Ditolak",
    followed_up: "Ditindaklanjuti",
    done: "Selesai",
  },
  /** Status shift depot/toko. */
  shift_status: {
    open: "Terbuka",
    closed: "Ditutup",
  },
  /** Status setoran shift. */
  shift_deposit_status: {
    not_deposited: "Belum disetor",
    deposited: "Disetor",
    received: "Diterima",
  },
  /** Status faktur. */
  invoice_status: {
    open: "Terbuka",
    partial: "Sebagian dibayar",
    paid: "Lunas",
  },
  /** Jenis faktur (F2 boleh menambah jenis lain). */
  invoice_kind: {
    underpayment: "Kurang bayar",
    // Tambahan F2 (model data):
    delivery: "Faktur kirim",
    store_sale: "Penjualan toko",
    monthly: "Faktur bulanan",
    opening_balance: "Saldo awal",
    partner_subscription: "Langganan sistem mitra",
  },
  /** Status periode akuntansi. */
  period_status: {
    open: "Terbuka",
    closed: "Ditutup",
    locked: "Dikunci",
    reopened: "Dibuka kembali",
  },
  /** Status permintaan persetujuan. */
  approval_status: {
    submitted: "Diajukan",
    approved: "Disetujui",
    rejected: "Ditolak",
    expired: "Lewat tenggat",
    cancelled: "Dibatalkan",
  },
  /** Status perangkat lapangan/POS. */
  device_status: {
    registered: "Terdaftar",
    active: "Aktif",
    blocked: "Diblokir",
    wipe_pending: "Menunggu hapus data",
    wiped: "Data terhapus",
  },
  /** Status transfer masuk. */
  incoming_transfer_status: {
    unmatched: "Belum dicocokkan",
    matched: "Cocok",
    not_found: "Tidak ditemukan",
    // Tambahan M4: transaksi sumber dibalik (pembayaran rit/setor bank dikoreksi) sebelum dicocokkan.
    cancelled: "Dibatalkan",
  },
  /** Status notifikasi. */
  notification_status: {
    new: "Baru",
    read: "Dibaca",
    actioned: "Ditindaklanjuti",
    done: "Selesai",
  },
  /** Status kredit pelanggan. */
  credit_status: {
    cash: "Tunai",
    credit: "Tempo",
    credit_migrated: "Tempo migrasi",
    on_hold: "Ditahan",
  },
  /** Jenis outlet. */
  outlet_kind: {
    depot: "Depot",
    store: "Toko",
  },
  /** Pusat laba (PRD M11: L1 produksi air, L2 air truk, L3 depot, L4 toko, L5 kemitraan; umum = pusat biaya bersama). */
  profit_center: {
    L1: "L1 Produksi air",
    L2: "L2 Air truk",
    L3: "L3 Depot",
    L4: "L4 Toko",
    L5: "L5 Kemitraan",
    SHARED: "Umum/kantor (bersama)",
  },
  /** Sumber aksi (`ActorContext.source`). */
  actor_source: {
    web: "Web kantor",
    field: "Aplikasi lapangan",
    pos: "POS",
    system: "Sistem",
    customer_app: "Aplikasi pelanggan",
    partner_portal: "Portal mitra",
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Tambahan F2 (model data, src/db/schema/**). Nilai = nilai pgEnum di basis data; urutan = urutan enum.
  // ---------------------------------------------------------------------------------------------------------------

  // --- Platform inti (core) ---
  /** Status akun pengguna (US-M10-01 KP-8: akun baru aktif setelah disetujui pemilik). */
  user_status: {
    pending_approval: "Menunggu persetujuan",
    active: "Aktif",
    inactive: "Nonaktif",
    locked: "Terkunci sementara",
  },
  /** Status pemberian peran/lingkup (US-M10-01 KP-4/KP-8). */
  grant_status: {
    pending: "Menunggu persetujuan",
    active: "Aktif",
    revoked: "Dicabut",
    rejected: "Ditolak",
  },
  /** Jenis lingkup akses pengguna. */
  scope_type: {
    truck: "Truk",
    outlet: "Outlet",
    water_source: "Sumber air",
    tenant: "Tenant",
  },
  /** Jenis tenant (Bab 4.3). */
  tenant_kind: {
    owner: "EQUA",
    partner: "Mitra",
  },
  /** Jenis perangkat terdaftar. */
  device_kind: {
    phone: "Ponsel",
    tablet: "Tablet",
    gps: "Perangkat GPS",
  },
  /** Status perangkat GPS truk (US-M12-08). */
  gps_state: {
    active: "Aktif",
    dead: "Mati",
    unplugged: "Dicabut",
  },
  /** Jenis sesi login. */
  session_kind: {
    web: "Web kantor",
    device: "Perangkat lapangan",
  },
  /** Jenis kejadian log akses (US-M10-05 KP-4). */
  access_event: {
    login_success: "Login berhasil",
    login_failed: "Login gagal",
    logout: "Logout",
    totp_failed: "Kode 2FA salah",
    pin_failed: "PIN salah",
    pin_locked: "PIN terkunci",
    session_expired: "Sesi kedaluwarsa",
    session_revoked: "Sesi dicabut",
    device_registered: "Perangkat didaftarkan",
    device_activated: "Perangkat diaktifkan",
    device_rejected: "Perangkat tidak terdaftar ditolak",
    device_blocked: "Perangkat diblokir",
    device_wipe_requested: "Perintah hapus data perangkat",
    device_wiped: "Data perangkat terhapus",
    export: "Ekspor data",
    action_denied: "Tindakan ditolak",
    password_changed: "Kata sandi diubah",
    pin_reset: "PIN direset",
    totp_reset: "2FA direset",
  },
  /** Tingkat notifikasi (kritis tidak dapat dimatikan, US-M9-04 KP-3). */
  notification_severity: {
    critical: "Kritis",
    high: "Tinggi",
    normal: "Normal",
    info: "Info",
  },
  /** Preferensi kanal notifikasi per jenis. */
  notification_mode: {
    immediate: "Seketika",
    daily_digest: "Ringkasan harian",
    off: "Mati",
  },
  /** Hasil pemrosesan perintah sinkron lapangan. */
  sync_command_status: {
    applied: "Diterapkan",
    rejected: "Ditolak",
    conflict: "Konflik",
  },
  /** Lingkup feature flag. */
  feature_flag_scope: {
    global: "Global",
    tenant: "Tenant",
    outlet: "Outlet",
    truck: "Truk",
  },
  /** Kelompok tanda tangan data awal (NFR-34, Bab 11.6). */
  data_signoff_group: {
    customers: "Pelanggan & alamat",
    tariffs_prices: "Zona tarif & daftar harga",
    fleet_people: "Armada, kru, karyawan, peran, perangkat",
    outlets_sources: "Depot & sumber air",
    stock_opening: "Stok toko & bahan depot",
    fixed_assets: "Aset tetap",
    opening_cash_bank: "Saldo awal kas & bank",
    opening_receivables: "Piutang berjalan",
    opening_payables: "Utang pemasok",
    chart_of_accounts: "Bagan akun & pemetaan jurnal",
    initial_accounts: "Akun pengguna awal",
    /** Tambahan M11: kelompok ekuitas saldo awal (US-M11-09 KP-2). */
    opening_equity: "Ekuitas saldo awal",
  },
  /** Status tanda tangan data awal. */
  signoff_status: {
    draft: "Draf",
    signed: "Ditandatangani",
    superseded: "Digantikan",
  },
  /** Kategori laporan kendala/masukan lapangan (US-M10-07 KP-3). */
  ticket_category: {
    app_issue: "Kendala aplikasi",
    feedback: "Masukan lapangan",
  },
  /** Status laporan kendala/masukan lapangan. */
  ticket_status: {
    received: "Diterima",
    answered: "Dijawab",
    done: "Selesai",
  },
  /** Jenis insiden (NFR-28, NFR-31). */
  incident_kind: {
    service_down: "Layanan tidak dapat diakses",
    mass_sync_failure: "Sinkron gagal massal",
    gps_device_dead: "Perangkat GPS mati",
    lost_device_queue: "Antrean perangkat hilang",
    security: "Keamanan",
    other: "Lainnya",
  },
  incident_severity: {
    critical: "Kritis",
    major: "Mayor",
    minor: "Minor",
  },
  incident_status: {
    open: "Terbuka",
    acknowledged: "Ditanggapi",
    resolved: "Pulih",
  },
  /** Status tinjauan hak akses kuartalan (US-M10-01 KP-6). */
  access_review_status: {
    draft: "Draf",
    reviewed: "Ditinjau",
  },
  /** Subjek permintaan anonimisasi (US-M10-06 KP-2). */
  anonymization_subject: {
    customer: "Pelanggan",
    employee: "Karyawan",
    customer_account: "Akun pelanggan",
  },
  anonymization_status: {
    submitted: "Diajukan",
    approved: "Disetujui",
    rejected: "Ditolak",
    executed: "Dijalankan",
    deferred: "Ditunda (piutang terbuka)",
  },
  backup_kind: {
    daily: "Harian",
    monthly: "Bulanan",
    restore_test: "Uji pemulihan",
  },
  backup_status: {
    success: "Berhasil",
    failed: "Gagal",
  },
  job_run_status: {
    running: "Berjalan",
    succeeded: "Berhasil",
    failed: "Gagal",
  },
  /** Jenis pesan/template WhatsApp (NFR-20). */
  wa_message_kind: {
    order_confirmation: "Konfirmasi pesanan",
    trip_receipt: "Struk rit",
    payment_receipt: "Bukti pelunasan",
    reminder_before_due: "Pengingat sebelum jatuh tempo",
    reminder_after_due: "Pengingat setelah jatuh tempo",
    monthly_invoice: "Faktur bulanan",
    statement: "Pernyataan piutang",
    otp: "Kode OTP",
    order_status: "Status pesanan",
    partner_report: "Laporan bulanan mitra",
    // Tambahan M5 (hanya tambah): kirim faktur per rit/toko (US-M5-01 KP-5).
    invoice: "Faktur",
  },
  /** Status pesan WhatsApp — tautan hanya mencatat "dibuka" (K21). */
  wa_message_status: {
    link_opened: "Tautan dibuka",
    sent: "Terkirim",
    delivered: "Sampai",
    read: "Dibaca",
    failed: "Gagal",
  },
  wa_provider: {
    link: "Tautan wa.me",
    cloud_api: "WhatsApp Cloud API",
  },
  export_format: {
    xlsx: "Excel",
    pdf: "PDF",
    csv: "CSV",
  },
  /** Jenis permintaan persetujuan (Bab 6.2a). Kolom `approval_requests.type` bertipe teks; daftar ini untuk UI. */
  approval_type: {
    cash_discrepancy: "Selisih setoran",
    credit_order: "Pesanan tempo di luar kontrol kredit",
    credit_grant: "Pemberian status Tempo",
    credit_terms_change: "Ubah batas/tempo pelanggan",
    credit_hold_release: "Pembukaan status Ditahan",
    price_change: "Perubahan harga master/zona/BBM",
    special_price: "Harga khusus pelanggan",
    store_discount: "Diskon kasir toko",
    pos_void: "Void POS",
    stock_adjustment: "Penyesuaian stok",
    manual_journal: "Jurnal manual",
    correction: "Koreksi/transaksi pembalik",
    petty_cash: "Kas kecil",
    cash_close_exception: "Tutup kas dengan setoran tertunda",
    second_underpayment_order: "Pesanan saat kurang bayar kedua",
    field_payment_to_credit: "Ubah tunai menjadi tempo di lapangan",
    period_lock: "Tutup buku dan kunci periode",
    account_create: "Akun pengguna baru",
    role_grant: "Pemberian/perubahan peran",
    scope_extension: "Perluasan lingkup",
    multi_role: "Satu orang lebih dari satu peran",
    monthly_billing: "Penanda tagihan bulanan",
    store_product: "Barang toko baru/perubahan harga toko",
    supplier: "Pemasok baru",
    customer_refund: "Pengembalian uang muka",
    anonymization: "Anonimisasi data pribadi",
    opening_balance_adjustment: "Penyesuaian saldo awal",
    partner_prospect: "Persetujuan calon mitra",
    partner_contract: "Kontrak mitra",
    partner_sanction: "Sanksi mitra",
    // --- Tambahan modul M7 (hanya tambah) ---
    store_credit_sale: "Penjualan tempo toko di luar kontrol kredit",
  },

  // --- M1 Master data ---
  /** Segmen pelanggan (BRD 1.1). */
  customer_segment: {
    third_party_depot: "Depot pihak ketiga",
    household: "Rumah tangga",
    housing: "Perumahan",
    industry: "Industri",
    construction: "Proyek konstruksi",
    hotel: "Hotel",
    swimming_pool: "Kolam renang",
  },
  /** Status koordinat alamat kirim (US-M1-01 KP-2). */
  coordinate_status: {
    unlocked: "Belum dikunci",
    locked: "Dikunci",
  },
  /** Asal koordinat alamat. */
  coordinate_source: {
    map: "Peta",
    first_delivery: "Lokasi Selesai rit pertama",
    customer_app: "Aplikasi pelanggan",
    import: "Impor data awal",
  },
  /** Pemetaan zona alamat (US-M1-05 KP-3). */
  zone_assignment: {
    auto: "Otomatis",
    manual: "Zona manual",
  },
  /** Metode perhitungan jarak (US-M1-05 KP-2). */
  distance_method: {
    route: "Jarak rute peta",
    straight_line_x1_3: "Garis lurus × 1,3",
  },
  /** Asal penanda mitra toko (BR-18). */
  store_partner_source: {
    auto: "Otomatis",
    manual: "Manual",
  },
  /** Status truk (US-M1-03). */
  truck_status: {
    active: "Aktif",
    maintenance: "Perbaikan",
    inactive: "Nonaktif",
  },
  /** Lini produk (US-M1-02). */
  product_line: {
    truck_water: "Air truk",
    depot: "Produk depot",
    store: "Barang toko",
  },
  product_status: {
    pending_approval: "Menunggu persetujuan",
    active: "Aktif",
    inactive: "Nonaktif",
  },
  /** Jenis harga produk: standar (depot), umum & mitra (toko). */
  price_kind: {
    standard: "Harga standar",
    general: "Harga umum",
    partner: "Harga mitra",
  },
  /** Status harga/tarif berlaku per tanggal (BR-15). */
  price_status: {
    pending: "Menunggu persetujuan",
    active: "Berlaku",
    rejected: "Ditolak",
    cancelled: "Dibatalkan",
  },
  meter_unit: {
    liter: "Liter",
    cubic_meter: "Meter kubik",
  },
  meter_status: {
    active: "Aktif",
    replaced: "Diganti",
    inactive: "Nonaktif",
  },
  /** Jenis impor data awal (US-M1-06). */
  import_kind: {
    customers: "Pelanggan & alamat",
    customer_prices: "Harga per pelanggan",
    trucks: "Armada",
    crew: "Kru",
    employees: "Karyawan",
    outlets: "Depot",
    water_sources: "Sumber air",
    opening_stock: "Stok awal",
    fixed_assets: "Aset tetap",
    opening_receivables: "Saldo awal piutang",
    opening_payables: "Saldo awal utang",
    chart_of_accounts: "Bagan akun",
  },
  import_status: {
    uploaded: "Diunggah",
    validated: "Tervalidasi",
    has_errors: "Ada kesalahan",
    committed: "Diimpor",
    cancelled: "Dibatalkan",
  },
  import_row_status: {
    valid: "Valid",
    error: "Salah",
    duplicate: "Duplikat",
    excluded: "Dikecualikan",
    committed: "Diimpor",
  },

  // --- M2 Pesanan & jadwal ---
  /** Cara bayar (pesanan, rit, POS). */
  payment_method: {
    cash: "Tunai",
    transfer: "Transfer",
    credit: "Tempo",
    qris: "QRIS",
    internal: "Internal",
    digital: "Pembayaran digital",
  },
  /** Asal pesanan. */
  order_source: {
    office: "Kantor",
    recurring: "Langganan",
    customer_app: "Aplikasi pelanggan",
    partner_portal: "Portal mitra",
  },
  /** Asal harga pesanan truk (BR-19). */
  order_price_source: {
    zone: "Tarif zona + komponen BBM",
    special: "Harga khusus",
    internal_transfer: "Harga transfer internal",
  },
  /** Alasan pembatalan pesanan (US-M2-02 KP-3). */
  order_cancel_reason: {
    customer_cancelled: "Pelanggan batal",
    duplicate: "Dobel",
    no_truck: "Tidak ada truk",
    price: "Harga",
    rejected_by_dispatcher: "Ditolak Dispatcher",
    other: "Lainnya",
  },
  /** Slot pengiriman Tahap 2 (PAR-73). */
  delivery_slot: {
    morning: "Pagi",
    midday: "Siang",
    afternoon: "Sore",
  },
  /** Alasan rit gagal (US-M3-06 KP-1). */
  trip_fail_reason: {
    customer_absent: "Pelanggan tidak ada",
    customer_refused: "Pelanggan menolak",
    location_inaccessible: "Lokasi tidak dapat diakses",
    truck_broken: "Truk rusak",
    other: "Lainnya",
  },
  /** Alasan volume parsial (US-M3-03 KP-2). */
  partial_volume_reason: {
    customer_tank_full: "Tangki pelanggan penuh",
    leakage: "Kebocoran",
    customer_request: "Permintaan pelanggan",
    other: "Lainnya",
  },
  /** Alasan lokasi Selesai menyimpang (US-M3-03 KP-3). */
  location_reason: {
    wrong_master_address: "Alamat di master salah",
    customer_other_point: "Pelanggan minta titik lain",
    gps_inaccurate: "GPS tidak akurat",
    other: "Lainnya",
  },
  /** Tingkat penyimpangan lokasi Selesai (BR-23; ambang PAR-16). */
  location_deviation: {
    none: "Sesuai",
    level1: "Penyimpangan tingkat 1",
    level2: "Penyimpangan tingkat 2",
  },
  /** Tindak lanjut air termuat pada rit gagal (US-M3-06 KP-2). */
  loaded_water_disposition: {
    carried_to_next: "Dibawa ke rit berikutnya",
    returned_to_source: "Kembali ke sumber",
    unloaded_at_depot: "Dibongkar di depot",
  },
  /** Status jadwal harian per truk. */
  schedule_status: {
    draft: "Draf",
    published: "Terbit",
  },
  schedule_change_type: {
    added: "Ditambah",
    moved: "Digeser",
    withdrawn: "Ditarik",
    reordered: "Urutan diubah",
    truck_changed: "Pindah truk",
  },
  /** Status pesanan berulang (US-M2-06). */
  recurring_status: {
    active: "Aktif",
    paused: "Jeda",
    ended: "Berakhir",
  },
  recurring_pattern: {
    weekly: "Hari tertentu setiap minggu",
    interval: "Setiap sekian hari",
  },
  recurring_failure_reason: {
    credit_on_hold: "Kredit ditahan",
    credit_limit: "Melampaui batas kredit",
    underpayment: "Kurang bayar belum lunas",
    inactive_customer: "Pelanggan nonaktif",
    other: "Lainnya",
  },
  /** Asal penetapan pengemudi harian (US-M2-11). */
  crew_assignment_source: {
    default_driver: "Sopir default",
    helper: "Kernet truk",
    other_driver: "Sopir lain",
  },
  crew_role: {
    driver: "Sopir",
    helper: "Kernet",
  },
  crew_roster_status: {
    on_duty: "Bertugas",
    off: "Libur",
  },
  /** Status truk per hari (US-M2-10). */
  truck_day_status: {
    operating: "Operasi",
    maintenance: "Perbaikan",
  },
  /** Jenis kejadian rit/kendala (US-M3-06). */
  trip_incident_kind: {
    trip_failed: "Rit gagal",
    truck_broken: "Truk rusak",
    road_blocked: "Jalan ditutup",
    accident: "Kecelakaan",
    other: "Lainnya",
  },

  // --- M3 Aplikasi sopir ---
  trip_expense_kind: {
    fuel: "BBM",
    toll: "Tol",
    parking: "Parkir",
    other: "Lainnya",
  },
  /** Sumber dana pengeluaran rit (PTB-20). */
  expense_funding_source: {
    cash_on_hand: "Kas di tangan",
    personal: "Uang pribadi",
  },
  expense_status: {
    pending_verification: "Menunggu verifikasi",
    accepted: "Diterima",
    rejected: "Ditolak",
  },

  // --- M4 Kas & setoran ---
  /** Cara setor (PTB-23). */
  deposit_method: {
    physical: "Serah fisik",
    bank_slip: "Setor bank dengan slip",
  },
  /** Sumber selisih. */
  discrepancy_source: {
    driver: "Sopir",
    depot_shift: "Shift depot",
    store_shift: "Shift toko",
    office_cash: "Kas kantor",
    petty_cash: "Kas kecil",
    pending_deposit: "Setoran tertunda",
  },
  /** Alasan selisih (US-M4-02 KP-3). */
  discrepancy_reason: {
    wrong_change: "Salah kembalian",
    damaged_or_counterfeit: "Uang rusak/palsu",
    expense_rejected: "Nota pengeluaran ditolak",
    unrecorded_underpayment: "Kurang bayar pelanggan belum tercatat",
    other: "Lainnya",
  },
  /** Asal transfer tercatat (US-M4-04 KP-1). */
  transfer_source_kind: {
    trip_payment: "Pembayaran rit",
    collection: "Pelunasan lewat sopir",
    qris_shift: "QRIS shift",
    bank_deposit_slip: "Setor bank (slip)",
    store_collection: "Pelunasan mitra toko",
    digital_payment: "Pembayaran digital",
    office_payment: "Pelunasan kantor",
  },
  bank_statement_line_status: {
    unmatched: "Belum dicocokkan",
    matched: "Cocok",
    ignored: "Diabaikan",
    follow_up: "Tindak lanjut",
  },
  bank_deposit_status: {
    recorded: "Tercatat",
    matched: "Cocok",
  },
  /** Jenis mutasi kas kantor. */
  office_cash_kind: {
    opening_balance: "Saldo awal",
    deposit_received: "Setoran diterima",
    bank_deposit: "Setor ke bank",
    petty_cash_topup: "Pengisian kas kecil",
    expense_reimbursement: "Penggantian pengeluaran rit",
    customer_payment: "Pelunasan tunai kantor",
    supplier_payment: "Pembayaran pemasok",
    restitution_payment: "Pelunasan ganti rugi",
    advance_refund: "Pengembalian uang muka",
    qris_refund: "Pengembalian dana QRIS",
    adjustment: "Koreksi",
  },
  cash_direction: {
    in: "Masuk",
    out: "Keluar",
  },
  petty_cash_kind: {
    topup: "Pengisian",
    expense: "Pengeluaran",
  },
  petty_cash_status: {
    pending_approval: "Menunggu persetujuan",
    approved: "Berlaku",
    rejected: "Ditolak",
  },
  cash_day_status: {
    open: "Terbuka",
    closed: "Ditutup",
  },
  /** Pengecualian tutup kas dengan setoran tertunda (PTB-21). */
  cash_close_exception_status: {
    submitted: "Diajukan",
    approved: "Disetujui",
    rejected: "Ditolak",
    resolved: "Kas diterima",
    expired: "Lewat batas",
  },
  /** Ganti rugi karyawan (Tercatat → Dilunasi). */
  restitution_status: {
    recorded: "Tercatat",
    partially_settled: "Sebagian dilunasi",
    settled: "Dilunasi",
  },
  restitution_settlement_method: {
    cash: "Setor tunai",
    payroll_deduction: "Potongan penggajian",
  },

  // --- M5 Piutang ---
  /** Status sengketa faktur (7.5.6). */
  dispute_status: {
    none: "Tidak bersengketa",
    disputed: "Bersengketa",
    resolved: "Diselesaikan dengan nota kredit",
    rejected: "Sengketa ditolak",
  },
  /** Kanal pelunasan. */
  payment_channel: {
    office: "Kantor",
    driver: "Lewat sopir",
    store: "Kasir toko",
    digital: "Pembayaran digital",
  },
  unbilled_status: {
    unbilled: "Belum ditagih",
    billed: "Sudah ditagih",
  },
  advance_status: {
    open: "Tersedia",
    applied: "Terpakai",
    refunded: "Dikembalikan",
  },
  credit_note_status: {
    issued: "Terbit",
    cancelled: "Dibatalkan",
  },
  invoice_line_component: {
    trip: "Rit",
    store_item: "Barang toko",
    underpayment: "Kurang bayar",
    opening_balance: "Saldo awal",
    subscription: "Langganan sistem",
    royalty: "Royalti",
    water: "Air",
    spare_part: "Spare part",
    other: "Lainnya",
  },
  reminder_kind: {
    before_due: "Sebelum jatuh tempo",
    after_due: "Setelah jatuh tempo",
    monthly: "Faktur bulanan",
  },
  reminder_status: {
    scheduled: "Dijadwalkan",
    opened: "Dibuka",
    skipped: "Dilewati",
  },

  // --- M6/M7 POS, toko, stok ---
  pos_sale_status: {
    pending_approval: "Menunggu persetujuan",
    valid: "Sah",
    void_pending: "Void menunggu persetujuan",
    voided: "Di-void",
    rejected: "Ditolak",
  },
  /** Alasan void (US-M6-03 KP-1). */
  void_reason: {
    wrong_product: "Salah produk",
    wrong_quantity: "Salah jumlah",
    customer_cancelled: "Pelanggan batal",
    wrong_payment_method: "Salah cara bayar",
    other: "Lainnya",
  },
  stock_movement_kind: {
    opening: "Stok awal",
    receipt: "Penerimaan",
    sale: "Penjualan",
    sale_void: "Void penjualan",
    consumption: "Pemakaian bahan",
    consumption_reversal: "Pembalik pemakaian",
    adjustment: "Penyesuaian opname",
    transfer_out: "Transfer keluar",
    transfer_in: "Transfer masuk",
    supplier_return: "Retur pemasok",
    correction: "Koreksi",
  },
  stock_count_kind: {
    weekly_depot: "Opname mingguan depot",
    monthly_store: "Opname bulanan toko",
    cutover: "Opname cut-over",
  },
  stock_count_status: {
    counting: "Dihitung",
    submitted: "Penyesuaian diajukan",
    approved: "Disetujui",
    rejected: "Ditolak",
  },
  stock_adjust_reason: {
    damaged: "Rusak",
    lost: "Hilang",
    miscount: "Salah catat",
    other: "Lainnya",
  },
  shift_stock_phase: {
    opening: "Awal shift",
    closing: "Tutup shift",
  },
  consumable_source: {
    internal_transfer: "Transfer internal toko",
    supplier: "Pemasok",
    other: "Lainnya",
  },
  /** Penerimaan pasokan air depot (US-M6-05). */
  water_supply_status: {
    arrived: "Tiba",
    confirmed: "Dikonfirmasi",
    discrepancy: "Selisih",
    auto_accepted: "Tanpa konfirmasi operator",
  },
  water_supply_source: {
    equa_truck: "Truk EQUA",
    other: "Sumber lain",
  },
  outlet_water_kind: {
    opening: "Stok awal",
    supply_in: "Pasokan masuk",
    sales_out: "Penjualan galon",
    adjustment: "Penyesuaian",
  },
  supplier_status: {
    pending_approval: "Menunggu persetujuan",
    active: "Aktif",
    inactive: "Nonaktif",
  },
  purchase_receipt_status: {
    pending_acceptance: "Nota pengganti menunggu",
    received: "Diterima",
    reversed: "Dibalik",
  },
  payable_status: {
    unpaid: "Belum dibayar",
    partial: "Sebagian dibayar",
    paid: "Lunas",
  },
  reorder_status: {
    open: "Perlu dipesan",
    ordered: "Sudah dipesan",
    closed: "Selesai",
  },
  internal_transfer_status: {
    sent: "Dikirim",
    received: "Diterima",
  },

  // --- M8 Produksi ---
  meter_phase: {
    morning: "Pagi (awal)",
    evening: "Malam (akhir)",
  },
  meter_reading_status: {
    recorded: "Tercatat",
    flagged: "Anomali",
    verified: "Diverifikasi",
    superseded: "Dikoreksi",
  },
  meter_adjustment_kind: {
    rollover: "Putaran meter",
    replacement: "Penggantian meter",
  },
  production_status: {
    incomplete: "Belum lengkap",
    complete: "Lengkap",
    combined: "Gabungan",
    estimated: "Estimasi",
  },
  truck_fill_status: {
    recorded: "Dicatat",
    linked: "Terkait rit",
    unlinked: "Tanpa rit",
    geofence_verified: "Terverifikasi geofence",
    geofence_mismatch: "Tidak cocok geofence",
  },
  water_balance_status: {
    formed: "Terbentuk",
    normal: "Susut normal",
    over_threshold: "Susut di atas ambang",
    investigating: "Investigasi",
    done: "Selesai",
    negative_anomaly: "Susut negatif",
  },
  loss_reason: {
    leakage: "Kebocoran",
    washing_disposal: "Pencucian/pembuangan",
    meter_problem: "Meter bermasalah",
    unrecorded_fill: "Pengisian belum tercatat",
    other: "Lainnya",
  },
  quality_location_type: {
    water_source: "Sumber air",
    outlet: "Outlet",
  },
  check_result: {
    pass: "Lulus",
    fail: "Tidak lulus",
  },

  // --- M9 Laporan ---
  daily_summary_status: {
    running: "Belum ditutup",
    published: "Terbit",
    reviewed: "Ditinjau pemilik",
  },
  summary_addendum_kind: {
    late_sync: "Terlambat sinkron",
    correction: "Koreksi",
  },
  report_status: {
    provisional: "Sementara",
    final: "Final",
  },
  unit_type: {
    truck: "Truk",
    outlet: "Outlet",
  },

  // --- M11 Akuntansi ---
  account_type: {
    asset: "Aset",
    liability: "Liabilitas",
    equity: "Ekuitas",
    revenue: "Pendapatan",
    expense: "Beban",
  },
  normal_balance: {
    debit: "Debit",
    credit: "Kredit",
  },
  journal_kind: {
    auto: "Otomatis",
    manual: "Manual",
    opening_balance: "Saldo awal",
    opening_adjustment: "Penyesuaian saldo awal",
    accrual: "Akrual",
    accrual_reversal: "Pembalik akrual",
    depreciation: "Penyusutan",
    allocation: "Alokasi biaya",
    reversal: "Pembalik",
    reclassification: "Reklasifikasi",
  },
  journal_status: {
    draft: "Draf",
    submitted: "Diajukan",
    approved: "Disetujui",
    posted: "Terposting",
    rejected: "Ditolak",
  },
  journal_queue_status: {
    pending: "Menunggu",
    resolved: "Terposting",
    failed: "Gagal",
  },
  journal_queue_reason: {
    mapping_missing: "Pemetaan akun belum ada",
    account_inactive: "Akun nonaktif",
    unbalanced: "Debit dan kredit tidak seimbang",
    period_unavailable: "Periode tidak tersedia",
    other: "Lainnya",
  },
  asset_category: {
    truck: "Truk",
    water_installation: "Instalasi sumber air",
    depot_equipment: "Peralatan depot",
    building: "Bangunan",
    other: "Lainnya",
  },
  asset_status: {
    active: "Aktif",
    disposed: "Dilepas",
  },
  depreciation_method: {
    straight_line: "Garis lurus",
    declining_balance: "Saldo menurun",
  },
  reconciliation_status: {
    in_progress: "Berjalan",
    zero_difference: "Nol selisih",
  },
  cash_reconciliation_kind: {
    office_cash: "Kas kantor",
    outlet_fixed_cash: "Kas awal tetap outlet",
    driver_cash: "Kas di tangan sopir",
    petty_cash: "Kas kecil",
  },
  tax_scheme: {
    non_pkp_final: "Non-PKP — PPh final UMKM",
    non_pkp_other: "Non-PKP — skema lain",
    pkp: "PKP",
  },
  opening_batch_group: {
    cash_bank: "Kas & bank",
    receivables: "Piutang",
    payables: "Utang pemasok",
    inventory: "Persediaan",
    fixed_assets: "Aset tetap",
    equity: "Ekuitas",
  },
  opening_batch_status: {
    draft: "Draf",
    signed: "Ditandatangani",
    posted: "Terposting",
  },
  allocation_kind: {
    l1_allocation: "Alokasi L1 ke L2/L3",
    shared_costs: "Alokasi biaya bersama",
  },
  allocation_status: {
    draft: "Draf",
    posted: "Terposting",
  },

  // --- M12 Armada/GPS ---
  position_source: {
    gps_device: "Perangkat GPS",
    phone: "GPS ponsel",
    status_point: "Titik status rit",
  },
  fleet_event_kind: {
    location_deviation_l1: "Penyimpangan lokasi tingkat 1",
    location_deviation_l2: "Penyimpangan lokasi tingkat 2",
    off_schedule_trip: "Perjalanan di luar jadwal",
    off_hours_trip: "Perjalanan di luar jam layanan",
    unknown_stop: "Berhenti tidak dikenal",
    device_offline: "Perangkat GPS mati",
    device_unplugged: "Perangkat GPS dicabut",
    geofence_enter: "Masuk geofence",
    geofence_exit: "Keluar geofence",
    location_source_inconsistent: "Sumber lokasi tidak konsisten",
    fill_without_geofence: "Pengisian tanpa masuk geofence sumber",
    geofence_without_fill: "Di sumber tanpa pengisian tercatat",
    supply_without_geofence: "Pasokan tanpa masuk geofence depot",
    no_location: "Tanpa lokasi",
    clock_skew: "Jam perangkat menyimpang",
    maintenance_trip: "Perjalanan perbaikan",
  },
  fleet_event_status: {
    detected: "Terdeteksi",
    explained: "Keterangan sopir",
    reviewed: "Ditinjau pemilik",
    done: "Selesai",
  },
  fleet_review_decision: {
    accepted: "Alasan diterima",
    request_explanation: "Minta keterangan",
    follow_up: "Tindak lanjut",
  },
  geofence_location_type: {
    water_source: "Sumber air",
    outlet: "Depot/toko",
    pool: "Pool",
  },
  phone_tracking_reason: {
    device_dead: "Perangkat GPS mati",
    admin_forced: "Diaktifkan admin sistem",
  },

  // --- Tahap 2: Aplikasi pelanggan ---
  customer_account_status: {
    registered: "Terdaftar",
    verified: "Terverifikasi WA",
    linked: "Terhubung ke pelanggan",
    pending_review: "Menunggu verifikasi Dispatcher",
    inactive: "Nonaktif",
  },
  otp_purpose: {
    register: "Pendaftaran",
    login: "Masuk",
    change_phone: "Ganti nomor",
    payment: "Verifikasi pembayaran",
  },
  complaint_kind: {
    volume: "Volume",
    lateness: "Keterlambatan",
    attitude: "Sikap",
    billing: "Tagihan",
    other: "Lainnya",
  },
  complaint_status: {
    submitted: "Diajukan",
    responded: "Ditanggapi",
    done: "Selesai",
  },
  payment_intent_status: {
    pending: "Menunggu",
    succeeded: "Berhasil",
    matched: "Dicocokkan",
    failed: "Gagal",
    expired: "Kedaluwarsa",
  },
  payment_intent_method: {
    qris_dynamic: "QRIS dinamis",
    virtual_account: "Virtual account",
  },

  // --- Tahap 3 / RL-7: Kemitraan ---
  prospect_status: {
    prospect: "Prospek",
    surveyed: "Survei",
    feasible: "Layak",
    infeasible: "Tidak layak",
    approved: "Disetujui pemilik",
    contracted: "Kontrak",
    onboarding: "Onboarding",
    active: "Aktif",
    rejected: "Ditolak",
    waitlisted: "Daftar tunggu kapasitas",
  },
  partner_option: {
    option_b: "Opsi B — Kemitraan",
    option_a: "Opsi A — Waralaba",
  },
  partner_contract_status: {
    draft: "Draf",
    active: "Aktif",
    extended: "Diperpanjang",
    ended: "Berakhir",
    terminated: "Diputus",
  },
  onboarding_item: {
    training: "Pelatihan operator",
    sop_signed: "SOP diterima",
    equipment_order: "Pesanan peralatan awal",
    first_water_order: "Pesanan air pertama",
    pos_device_registered: "Perangkat POS terdaftar",
    initial_water_test: "Uji air awal",
  },
  royalty_status: {
    provisional: "Sementara",
    invoiced: "Ditagih",
  },
  partner_audit_status: {
    scheduled: "Dijadwalkan",
    conducted: "Dilaksanakan",
    findings: "Temuan",
    follow_up: "Tindak lanjut",
    closed: "Selesai",
  },
  sanction_level: {
    warning: "Teguran",
    supply_suspension: "Penghentian pasokan sementara",
    termination: "Pemutusan",
  },
  sanction_status: {
    triggered: "Pemicu tercatat",
    active: "Berlaku",
    lifted: "Dicabut",
    dismissed: "Tidak dilanjutkan",
  },
  sanction_trigger: {
    overdue: "Tunggakan lewat tempo",
    water_balance: "Neraca air di luar toleransi",
    low_score: "Skor mutu rendah",
    audit_overdue: "Temuan audit lewat tenggat",
    pos_unused: "POS tidak dipakai",
    test_failed: "Uji air tidak lulus",
    other: "Lainnya",
  },
  support_request_kind: {
    equipment: "Peralatan",
    spare_part: "Spare part",
    system: "Sistem",
    water_quality: "Mutu air",
  },
  support_request_status: {
    submitted: "Diajukan",
    responded: "Ditanggapi",
    done: "Selesai",
  },

  // --- Tambahan modul M3 (Aplikasi Sopir) — hanya tambah; daftar alasan lapangan (bukan pgEnum) ---
  /** Alasan kurang bayar tunai/transfer di lapangan (US-M3-04 KP-2, PTB-18). */
  underpayment_reason: {
    customer_short: "Uang pelanggan kurang",
    customer_disputes: "Pelanggan keberatan / minta ditagih nanti",
    credit_not_approved: "Tempo tidak disetujui / tanpa sinyal",
    other: "Lainnya",
  },
  /** Tanda tangan penerima dilewati (US-M3-03 KP-1). */
  signature_skip_reason: {
    recipient_refused: "Penerima tidak bersedia",
    recipient_absent: "Penerima tidak ada",
  },
  /** Struk WA dilewati (US-M3-03 KP-7). */
  receipt_skip_reason: {
    no_whatsapp: "Pelanggan tidak memakai WA",
    declined: "Pelanggan tidak minta struk",
    other: "Lainnya",
  },
  /** Jenis kunci tombol Berangkat di aplikasi sopir (BR-10, PTB-62/PAR-83, US-M3-07 KP-2). */
  driver_deposit_lock: {
    br10: "Setoran kemarin belum ditutup",
    par83: "Menunggu keputusan pemilik atas selisih besar",
    submitted: "Setoran hari ini sudah diajukan",
  },
  /** Peran pelaksana di aplikasi sopir (US-M3-01 KP-6, US-M2-11). */
  driver_acting_role: {
    driver: "Sopir",
    substitute: "Kernet pengganti",
    readonly: "Baca saja",
  },

  // --- Tambahan modul M4 (Kas & Setoran) — hanya tambah ---
  /** Keputusan pemilik atas selisih (US-M4-03 KP-2; pgEnum `discrepancy_decision`). */
  discrepancy_decision: {
    approved: "Disetujui",
    rejected: "Ditolak",
  },
  /** Kategori pengeluaran kas kecil (US-M4-05 KP-2; teks bebas terstandar, bukan pgEnum). */
  petty_cash_category: {
    office_supplies: "Alat tulis & perlengkapan kantor",
    consumption: "Konsumsi",
    cleaning: "Kebersihan",
    transport: "Transportasi & kurir",
    minor_repair: "Perbaikan kecil",
    utilities: "Listrik/air/pulsa",
    other: "Lainnya",
  },
  /** Penghalang tutup kas (US-M4-06 KP-1). */
  cash_close_blocker: {
    driver_deposit: "Setoran sopir belum diterima",
    shift_open: "Shift belum ditutup",
    shift_deposit: "Setoran shift belum diterima",
    trip_active: "Rit masih Berangkat/Tiba",
    previous_day: "Hari sebelumnya belum ditutup",
    exception_pending: "Pengecualian menunggu keputusan pemilik",
  },
  /** Status hitung kas kantor/kas kecil (tampilan). */
  cash_count_result: {
    match: "Cocok",
    short: "Kurang",
    over: "Lebih",
  },

  // --- Tambahan modul M5 (Piutang & Penagihan) — hanya tambah; daftar tampilan (bukan pgEnum) ---
  /** Kelompok umur piutang (FR-M5-04). */
  aging_bucket: {
    not_due: "Belum jatuh tempo",
    d1_7: "1–7 hari",
    d8_30: "8–30 hari",
    over_30: "> 30 hari",
  },
  /** Lini piutang (US-M5-04 KP-1; satu batas lintas lini PTB-25). */
  receivable_line: {
    truck: "Air truk",
    store: "Toko",
    partner: "Kemitraan",
  },
  /** Baris kartu piutang (US-M5-04 KP-2). */
  statement_entry: {
    opening: "Saldo sebelumnya",
    invoice: "Faktur",
    payment: "Pelunasan",
    payment_reversal: "Pembalik pelunasan",
    credit_note: "Nota kredit",
    write_off: "Penghapusan piutang",
    advance: "Uang muka",
    advance_refund: "Pengembalian uang muka",
  },
  /** Keputusan sengketa faktur oleh pemilik (7.5.6). */
  dispute_decision: {
    credit_note: "Koreksi lewat nota kredit",
    reject: "Sengketa ditolak",
  },

  // --- Tambahan modul M12 (Pelacakan Armada / GPS) — hanya tambah ---
  /** Status truk di peta real-time (US-M12-02 KP-1). Bukan enum DB — diturunkan dari rit, posisi & geofence. */
  fleet_live_status: {
    active_trip: "Rit aktif",
    arrived: "Tiba di pelanggan",
    heading_to_source: "Menuju sumber",
    at_source: "Di sumber",
    at_depot: "Di depot",
    at_pool: "Di pool",
    returning_to_pool: "Kembali ke pool",
    stopped: "Berhenti",
    off_schedule: "Di luar jadwal",
    maintenance: "Perbaikan",
    no_data: "Tanpa posisi",
  },
  /** Kelompok daftar kejadian armada di layar kantor (US-M12-04 KP-3, US-M12-05, US-M12-06, US-M12-08). */
  fleet_event_group: {
    location: "Lokasi Selesai",
    travel: "Perjalanan & berhenti",
    geofence: "Geofence & pengisian",
    device: "Perangkat GPS",
  },

  // --- Tambahan modul M11 (Akuntansi & Pajak) — hanya tambah ---
  /** Jenis jurnal berulang/template (US-M11-03 KP-1/KP-4). */
  recurring_journal_template: {
    salary: "Gaji",
    rent: "Sewa",
    electricity: "Listrik",
    fuel: "BBM",
    maintenance: "Pemeliharaan",
    bank_fee: "Biaya bank",
    other: "Lainnya",
  },
  /** Status utang dari jurnal manual bertanda utang (US-M11-07). */
  journal_payable_status: {
    open: "Belum dibayar",
    partial: "Sebagian dibayar",
    paid: "Lunas",
  },
  /** Jenis catatan akuntan per periode (US-M11-04 KP-5, US-M11-02 KP-4, US-M11-10 KP-5). */
  period_review_kind: {
    review: "Catatan tinjauan",
    retroactive_verification: "Verifikasi jurnal retroaktif",
    tg8: "Bukti TG-8 (tutup buku pertama)",
  },
  /** Kelompok prasyarat tutup periode (US-M11-10 KP-1) — daftar tampilan (bukan pgEnum). */
  period_prerequisite: {
    cash_days_closed: "Semua hari kas Ditutup",
    bank_reconciled: "Rekonsiliasi bank nol selisih",
    cash_reconciled: "Rekonsiliasi kas nol selisih / beralasan",
    queue_empty: "Tidak ada jurnal di daftar tunggu",
    depreciation_posted: "Penyusutan terposting",
    manual_decided: "Jurnal manual > ambang diputuskan",
    manual_reviewed: "Daftar tinjauan jurnal manual ditandai pemilik",
    store_count_done: "Opname toko bulan ini selesai",
    allocations_posted: "Alokasi L1 & biaya bersama terposting",
    opening_posted: "Saldo awal terposting",
    retroactive_verified: "Jurnal retroaktif diverifikasi akuntan",
    accountant_note: "Catatan tinjauan akuntan (tutup buku pertama)",
  },
  /** Kunci alokasi biaya bersama (US-M11-01 KP-5) — daftar tampilan (bukan pgEnum). */
  shared_cost_basis: {
    none: "Dibiarkan di pusat biaya bersama",
    revenue: "Proporsi omzet",
    fixed: "Persentase tetap",
  },
} as const satisfies Record<string, Record<string, string>>;

export type EnumName = keyof typeof LABELS;
export type EnumValue<E extends EnumName> = keyof (typeof LABELS)[E] & string;

export type RoleCode = EnumValue<"role">;
export type OrderStatus = EnumValue<"order_status">;
export type TripStatus = EnumValue<"trip_status">;
export type DepositStatus = EnumValue<"deposit_status">;
export type DepositSourceType = EnumValue<"deposit_source_type">;
export type DiscrepancyStatus = EnumValue<"discrepancy_status">;
export type ShiftStatus = EnumValue<"shift_status">;
export type ShiftDepositStatus = EnumValue<"shift_deposit_status">;
export type InvoiceStatus = EnumValue<"invoice_status">;
export type PeriodStatus = EnumValue<"period_status">;
export type ApprovalStatus = EnumValue<"approval_status">;
export type DeviceStatus = EnumValue<"device_status">;
export type IncomingTransferStatus = EnumValue<"incoming_transfer_status">;
export type NotificationStatus = EnumValue<"notification_status">;
export type CreditStatus = EnumValue<"credit_status">;
export type OutletKind = EnumValue<"outlet_kind">;
export type ProfitCenter = EnumValue<"profit_center">;
export type ActorSource = EnumValue<"actor_source">;
// Tambahan F2 (model data):
export type InvoiceKind = EnumValue<"invoice_kind">;
export type UserStatus = EnumValue<"user_status">;
export type GrantStatus = EnumValue<"grant_status">;
export type ScopeType = EnumValue<"scope_type">;
export type DeviceKind = EnumValue<"device_kind">;
export type AccessEvent = EnumValue<"access_event">;
export type NotificationSeverity = EnumValue<"notification_severity">;
export type ApprovalType = EnumValue<"approval_type">;
export type CustomerSegment = EnumValue<"customer_segment">;
export type TruckStatus = EnumValue<"truck_status">;
export type ProductLine = EnumValue<"product_line">;
export type PriceKind = EnumValue<"price_kind">;
export type PriceStatus = EnumValue<"price_status">;
export type PaymentMethod = EnumValue<"payment_method">;
export type OrderSource = EnumValue<"order_source">;
export type TripFailReason = EnumValue<"trip_fail_reason">;
export type PosSaleStatus = EnumValue<"pos_sale_status">;
export type StockMovementKind = EnumValue<"stock_movement_kind">;
export type JournalKind = EnumValue<"journal_kind">;
export type JournalStatus = EnumValue<"journal_status">;
export type AccountType = EnumValue<"account_type">;
export type FleetEventKind = EnumValue<"fleet_event_kind">;
export type FleetEventStatus = EnumValue<"fleet_event_status">;
export type WaMessageKind = EnumValue<"wa_message_kind">;
export type DataSignoffGroup = EnumValue<"data_signoff_group">;

/** Label Indonesia untuk nilai enum. Nilai tak dikenal dikembalikan apa adanya; kosong → `"—"`. */
export function label<E extends EnumName>(enumName: E, value: EnumValue<E> | (string & {}) | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const map = LABELS[enumName] as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value]! : value;
}

/** Nilai enum (urutan sesuai deklarasi) sebagai tuple non-kosong — cocok untuk `pgEnum` & `z.enum`. */
export function enumValues<E extends EnumName>(enumName: E): [EnumValue<E>, ...EnumValue<E>[]] {
  return Object.keys(LABELS[enumName]) as [EnumValue<E>, ...EnumValue<E>[]];
}

/** Pilihan `{ value, label }` untuk komponen Select. */
export function enumOptions<E extends EnumName>(enumName: E): { value: EnumValue<E>; label: string }[] {
  return enumValues(enumName).map((value) => ({ value, label: label(enumName, value) }));
}

/** Benar bila `value` adalah nilai sah untuk enum tersebut. */
export function isEnumValue<E extends EnumName>(enumName: E, value: unknown): value is EnumValue<E> {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LABELS[enumName], value);
}

/** Semua kode peran. */
export const ROLE_CODES = enumValues("role");
