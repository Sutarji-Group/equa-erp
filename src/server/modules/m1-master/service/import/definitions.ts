/**
 * M1 — definisi template impor data awal (US-M1-06 KP-1): kolom per jenis, penanda wajib, keterangan, dan contoh
 * terisi. Satu sumber untuk template Excel, pembaca berkas, dan laporan validasi.
 */
export type ImportKindM1 = "customers" | "customer_prices" | "trucks" | "crew" | "employees" | "outlets" | "water_sources";

export const IMPORT_KINDS_M1: readonly ImportKindM1[] = ["customers", "customer_prices", "trucks", "crew", "employees", "outlets", "water_sources"];

export type ImportColumn = {
  key: string;
  header: string;
  required?: boolean;
  width?: number;
  note: string;
};

export type ImportKindDef = {
  kind: ImportKindM1;
  title: string;
  description: string;
  /** Kelompok tanda tangan data awal (NFR-34). */
  signoffGroup: "customers" | "tariffs_prices" | "fleet_people" | "outlets_sources";
  /** Memuat data keuangan (harga/batas/Tempo) → izin `m1.import.commit_pricing`. */
  pricing: boolean;
  columns: ImportColumn[];
  example: Record<string, string | number | null>[];
};

const SEGMENTS = "Depot pihak ketiga, Rumah tangga, Perumahan, Industri, Proyek konstruksi, Hotel, Kolam renang";

export const IMPORT_DEFS: Record<ImportKindM1, ImportKindDef> = {
  customers: {
    kind: "customers",
    title: "Pelanggan & alamat kirim",
    description: "Satu baris per alamat kirim. Pelanggan dengan beberapa alamat ditulis beberapa baris dengan kode pelanggan yang sama.",
    signoffGroup: "customers",
    pricing: true,
    columns: [
      { key: "kode_pelanggan", header: "Kode pelanggan", required: true, width: 14, note: "Kode unik pelanggan (mis. PLG-0101). Baris dengan kode sama = alamat tambahan pelanggan itu." },
      { key: "nama", header: "Nama pelanggan", required: true, width: 32, note: "Nama pelanggan / usaha." },
      { key: "segmen", header: "Segmen", required: true, width: 20, note: `Salah satu: ${SEGMENTS}.` },
      { key: "nomor_wa", header: "Nomor WA", required: true, width: 16, note: "Format Indonesia, mis. 0812-3456-7890." },
      { key: "nama_kontak", header: "Nama kontak", width: 20, note: "Opsional." },
      { key: "catatan", header: "Catatan khusus", width: 30, note: "Akses lokasi, patokan (opsional; ikut ke aplikasi sopir)." },
      { key: "jam_terima", header: "Jam terima tetap", width: 12, note: "HH:mm, mis. 07:00 (opsional)." },
      { key: "label_alamat", header: "Label alamat", required: true, width: 16, note: "Mis. Utama, Gudang 2." },
      { key: "alamat", header: "Alamat", required: true, width: 40, note: "Teks alamat lengkap." },
      { key: "lat", header: "Lintang", width: 12, note: "Koordinat lintang (mis. -6.8201). Kosong = Belum dikunci (dilengkapi dari GPS sopir)." },
      { key: "lng", header: "Bujur", width: 12, note: "Koordinat bujur (mis. 107.1402)." },
      { key: "zona_manual", header: "Kode zona manual", width: 12, note: "Kode zona (mis. Z2) bila koordinat kosong — alamat ditandai Zona manual." },
      { key: "alasan_zona", header: "Alasan zona manual", width: 24, note: "Opsional; bawaan: koordinat belum tersedia." },
      { key: "status_kredit", header: "Status kredit", width: 14, note: "Tunai (bawaan) atau Tempo migrasi (pelanggan tempo sebelum cut-over, US-M1-06 KP-6). Rumah tangga hanya Tunai." },
      { key: "batas_kredit", header: "Batas kredit (Rp)", width: 14, note: "Wajib untuk Tempo migrasi — batas yang disepakati." },
      { key: "tempo_hari", header: "Tempo (hari)", width: 10, note: "Wajib untuk Tempo migrasi — tempo yang disepakati." },
    ],
    example: [
      { kode_pelanggan: "PLG-0101", nama: "Hotel Contoh Cipanas", segmen: "Hotel", nomor_wa: "0812-1111-0101", nama_kontak: "Bu Rina", catatan: "Masuk lewat gerbang belakang", jam_terima: "08:00", label_alamat: "Utama", alamat: "Jl. Raya Cipanas No. 1, Cipanas", lat: -6.735, lng: 107.041, zona_manual: null, alasan_zona: null, status_kredit: "Tempo migrasi", batas_kredit: 10_000_000, tempo_hari: 14 },
      { kode_pelanggan: "PLG-0101", nama: "Hotel Contoh Cipanas", segmen: "Hotel", nomor_wa: "0812-1111-0101", nama_kontak: "Bu Rina", catatan: null, jam_terima: "08:00", label_alamat: "Villa 2", alamat: "Jl. Raya Cipanas No. 9, Cipanas", lat: -6.737, lng: 107.045, zona_manual: null, alasan_zona: null, status_kredit: "Tempo migrasi", batas_kredit: 10_000_000, tempo_hari: 14 },
      { kode_pelanggan: "PLG-0102", nama: "Ibu Contoh Rumah Tangga", segmen: "Rumah tangga", nomor_wa: "0813-2222-0102", nama_kontak: null, catatan: "Gang sempit", jam_terima: null, label_alamat: "Utama", alamat: "Kp. Contoh RT 01/02, Cilaku", lat: null, lng: null, zona_manual: "Z2", alasan_zona: null, status_kredit: "Tunai", batas_kredit: null, tempo_hari: null },
    ],
  },
  customer_prices: {
    kind: "customer_prices",
    title: "Harga saat ini per pelanggan",
    description: "Harga air truk per rit yang berlaku hari ini per pelanggan (sebelum sistem) — dasar simulasi zona (US-M1-05 KP-5). Impor pelanggan lebih dulu.",
    signoffGroup: "tariffs_prices",
    pricing: true,
    columns: [
      { key: "kode_pelanggan", header: "Kode pelanggan", required: true, width: 14, note: "Kode pelanggan yang sudah ada di sistem." },
      { key: "label_alamat", header: "Label alamat", width: 16, note: "Opsional — kosong = berlaku untuk semua alamat pelanggan." },
      { key: "harga_per_rit", header: "Harga per rit (Rp)", required: true, width: 16, note: "Rupiah bulat, mis. 250000." },
      { key: "catatan", header: "Catatan", width: 30, note: "Opsional." },
    ],
    example: [
      { kode_pelanggan: "PLG-0101", label_alamat: "Utama", harga_per_rit: 260_000, catatan: "Harga kesepakatan 2025" },
      { kode_pelanggan: "PLG-0102", label_alamat: null, harga_per_rit: 200_000, catatan: null },
    ],
  },
  trucks: {
    kind: "trucks",
    title: "Armada",
    description: "Satu baris per truk.",
    signoffGroup: "fleet_people",
    pricing: false,
    columns: [
      { key: "kode", header: "Kode truk", required: true, width: 10, note: "Kode singkat papan jadwal, mis. T8." },
      { key: "nopol", header: "Nomor polisi", required: true, width: 14, note: "Mis. F 8208 NH." },
      { key: "kapasitas_l", header: "Kapasitas (L)", width: 12, note: "Bawaan 5000." },
      { key: "kapasitas_rit", header: "Kapasitas rit/hari", width: 12, note: "Kosong = PAR-33." },
      { key: "kode_pool", header: "Kode pool", width: 10, note: "Opsional, mis. PL1." },
    ],
    example: [{ kode: "T8", nopol: "F 8208 NH", kapasitas_l: 5000, kapasitas_rit: 3, kode_pool: "PL1" }],
  },
  crew: {
    kind: "crew",
    title: "Kru default truk",
    description: "Sopir & kernet default per truk (satu karyawan hanya satu truk default). Impor armada & karyawan lebih dulu.",
    signoffGroup: "fleet_people",
    pricing: false,
    columns: [
      { key: "kode_truk", header: "Kode truk", required: true, width: 10, note: "Kode truk yang sudah ada." },
      { key: "no_sopir", header: "No. karyawan sopir", width: 16, note: "Nomor karyawan berperan Sopir." },
      { key: "no_kernet", header: "No. karyawan kernet", width: 16, note: "Nomor karyawan berperan Kernet." },
    ],
    example: [{ kode_truk: "T8", no_sopir: "EQ-050", no_kernet: "EQ-051" }],
  },
  employees: {
    kind: "employees",
    title: "Karyawan",
    description: "Satu baris per karyawan. Akun & PIN dibuat di Akses > Pengguna (M10).",
    signoffGroup: "fleet_people",
    pricing: false,
    columns: [
      { key: "no_karyawan", header: "No. karyawan", required: true, width: 12, note: "Unik, mis. EQ-050." },
      { key: "nama", header: "Nama lengkap", required: true, width: 26, note: "" },
      { key: "panggilan", header: "Nama panggilan", width: 14, note: "Opsional." },
      { key: "jabatan", header: "Jabatan", required: true, width: 18, note: "Mis. Sopir, Operator Depot." },
      { key: "telepon", header: "Telepon", width: 16, note: "Opsional, format Indonesia." },
      { key: "lokasi_tugas", header: "Lokasi tugas", width: 20, note: "Opsional." },
      { key: "kode_outlet", header: "Kode outlet utama", width: 12, note: "Opsional, mis. D01." },
      { key: "peran", header: "Peran sistem", width: 20, note: "Dipisah koma: Sopir, Kernet, Operator depot, Kasir toko, Operator produksi, Dispatcher, Admin Keuangan, Admin sistem, Akuntan." },
      { key: "tanggal_masuk", header: "Tanggal masuk", width: 12, note: "YYYY-MM-DD." },
      { key: "tanggal_keluar", header: "Tanggal keluar", width: 12, note: "Kosong bila masih bekerja." },
    ],
    example: [
      { no_karyawan: "EQ-050", nama: "Contoh Sopir Baru", panggilan: "Ujang", jabatan: "Sopir", telepon: "0812-3000-0050", lokasi_tugas: "Pool Karangtengah", kode_outlet: null, peran: "Sopir", tanggal_masuk: "2026-09-01", tanggal_keluar: null },
      { no_karyawan: "EQ-051", nama: "Contoh Kernet Baru", panggilan: "Dede", jabatan: "Kernet", telepon: null, lokasi_tugas: "Pool Karangtengah", kode_outlet: null, peran: "Kernet", tanggal_masuk: "2026-09-01", tanggal_keluar: null },
    ],
  },
  outlets: {
    kind: "outlets",
    title: "Depot & toko",
    description: "Satu baris per outlet (tenant EQUA).",
    signoffGroup: "outlets_sources",
    pricing: false,
    columns: [
      { key: "kode", header: "Kode outlet", required: true, width: 10, note: "Mis. D11 (dipakai nomor transaksi POS)." },
      { key: "nama", header: "Nama outlet", required: true, width: 28, note: "" },
      { key: "jenis", header: "Jenis", required: true, width: 10, note: "Depot atau Toko." },
      { key: "alamat", header: "Alamat", width: 36, note: "" },
      { key: "lat", header: "Lintang", width: 12, note: "" },
      { key: "lng", header: "Bujur", width: 12, note: "" },
      { key: "radius_geofence_m", header: "Radius geofence (m)", width: 12, note: "Kosong = PAR-54." },
      { key: "kapasitas_simpan_l", header: "Kapasitas simpan (L)", width: 14, note: "Depot." },
      { key: "no_operator", header: "No. karyawan operator default", width: 16, note: "Opsional." },
    ],
    example: [{ kode: "D11", nama: "Depot EQUA Contoh", jenis: "Depot", alamat: "Jl. Raya Contoh, Cianjur", lat: -6.83, lng: 107.15, radius_geofence_m: 100, kapasitas_simpan_l: 5000, no_operator: null }],
  },
  water_sources: {
    kind: "water_sources",
    title: "Sumber air & meter",
    description: "Satu baris per sumber air (dengan satu meter; meter lain ditambah di layar Sumber air).",
    signoffGroup: "outlets_sources",
    pricing: false,
    columns: [
      { key: "kode", header: "Kode sumber", required: true, width: 10, note: "Mis. SA3." },
      { key: "nama", header: "Nama sumber", required: true, width: 26, note: "" },
      { key: "alamat", header: "Alamat", width: 30, note: "" },
      { key: "lat", header: "Lintang", required: true, width: 12, note: "" },
      { key: "lng", header: "Bujur", required: true, width: 12, note: "" },
      { key: "kapasitas_harian_l", header: "Kapasitas harian (L)", width: 14, note: "Bawaan 50000." },
      { key: "radius_geofence_m", header: "Radius geofence (m)", width: 12, note: "Kosong = PAR-54." },
      { key: "kode_meter", header: "Pengenal meter", width: 14, note: "Opsional." },
      { key: "satuan_meter", header: "Satuan meter", width: 12, note: "Liter atau Meter kubik." },
      { key: "angka_awal_l", header: "Angka awal meter (L)", width: 14, note: "Angka saat cut-over; wajib bila pengenal meter diisi." },
    ],
    example: [{ kode: "SA3", nama: "Sumber Air Contoh", alamat: "Kp. Contoh, Cugenang", lat: -6.77, lng: 107.09, kapasitas_harian_l: 50000, radius_geofence_m: 100, kode_meter: "MTR-SA3-01", satuan_meter: "Liter", angka_awal_l: 1_000_000 }],
  },
};

export function isImportKindM1(value: string): value is ImportKindM1 {
  return (IMPORT_KINDS_M1 as readonly string[]).includes(value);
}
