# Gerbang aktivasi Tahap 2 & Tahap 3 (PRD Bab 8.1, 9.1, 9.10; D-02, D-11, D-12)

Tahap 2 (Aplikasi Pelanggan, US-P2-01..08) dan portal kemitraan lengkap Tahap 3 (US-P3-01..07) **sudah dibangun dan
teruji otomatis** di v1.0, tetapi **mati secara bawaan** di balik feature flag (D-02):

| Flag | Membuka | Bawaan | Lingkup | Penyetel |
|---|---|---|---|---|
| `phase2.customer_app` | Aplikasi pelanggan PWA `/app`, OTP WA, pesanan & slot, lacak truk, tagihan & pembayaran digital, langganan, penilaian & keluhan; layar kantor *Aplikasi pelanggan* (`/keluhan/*`) | **mati** | global / per tenant | pemilik |
| `phase3.partner_portal` | Portal kemitraan lengkap: calon mitra & pendaftaran publik `/mitra/daftar`, onboarding, pesanan air & spare part dari portal, pengaturan POS mitra, mutu & audit, royalti Opsi A, sanksi, dashboard kemitraan | **mati** | global / per tenant | pemilik |

Paket Minimum Mitra Fase 1 (RL-7, US-P3-08..11) **tidak** memerlukan flag — lihat [`rl7-mitra.md`](rl7-mitra.md).
US-P2-07 (galon antar dari depot, kelas C/EP-2-07) **tidak dibangun** (PTB-53).

---

## 1. Gerbang Tahap 2 — TG-9 (PRD 8.1)

Diperiksa pada **TG-9** (bulan 12, BRD 12.8) oleh komite pengarah. Semua butir wajib **Ya** sebelum flag dinyalakan.

| # | Prasyarat | Ukuran | Cara memeriksa di sistem | Ya/Tidak |
|---|---|---|---|:-:|
| 1 | Tahap 1 stabil | ≥ 3 bulan setelah go-live penuh; KPI-05 = 100%, KPI-06 = 0/bulan, KPI-07 baseline tersedia | Laporan › **KPI program** (riwayat 3 bulan) | ☐ |
| 2 | Koordinat alamat terkunci | ≥ 95% alamat aktif berkoordinat (US-M1-06 KP-5) | Data master › Pelanggan (filter *Belum dikunci* / *Zona manual*); laporan kualitas data impor | ☐ |
| 3 | Kanal pesan otomatis | WhatsApp Business API aktif (NFR-20, PTB-60) | env `WA_PROVIDER=cloud_api` + `WA_CLOUD_TOKEN`, `WA_CLOUD_PHONE_ID`, `WA_WEBHOOK_VERIFY_TOKEN`, `WA_APP_SECRET`; webhook Meta → `/api/customer/webhook/wa` terverifikasi; template disetujui Meta; uji OTP ke nomor nyata | ☐ |
| 4 | Keputusan gerbang pembayaran | Penyedia, biaya, rekonsiliasi (PTB-50: Midtrans QRIS dinamis + VA) | env `PAYMENT_GATEWAY=midtrans`, `MIDTRANS_SERVER_KEY/CLIENT_KEY`, `MIDTRANS_IS_PRODUCTION=true`; webhook → `/api/customer/webhook/pembayaran`; uji bayar nyata → transfer masuk M4 neto (bruto − biaya gerbang, B-63) & jurnal M11 | ☐ |
| 5 | Kapasitas rit terlihat | US-M2-10 terbangun; PAR-33 dikalibrasi dari baseline KPI-07 tiga bulan (slot = kapasitas nyata) | Pengaturan › Parameter › **PAR-33** (tanggal berlaku setelah kalibrasi); Jadwal kru | ☐ |
| 6 | Platform aplikasi diputuskan | PTB-49 = PWA (D-03) | — (diputuskan) | ☑ |
| 7 | **TG-9 pengaburan wajah foto bukti kirim** (D-11 butir 3, D-12 butir 5, B-75/B-80) | Foto bukti kirim yang tampil di aplikasi pelanggan **dikaburkan wajahnya** (orang di lokasi selain penerima tidak dapat dikenali), ATAU komite pengarah memutuskan foto bukti kirim tidak ditampilkan di aplikasi pelanggan | **Belum dibangun di v1.0**: v1.0 menampilkan foto bukti kirim HANYA ke akun pemilik pesanan itu sendiri. Wajib dibangun (atau foto disembunyikan) & diuji sebelum flag dinyalakan; catat keputusan komite | ☐ |
| 8 | UAT & kinerja Tahap 2 (B-74) | Layar aplikasi pelanggan ≤ 2 detik di 4G; pemesanan penuh ≤ 60 detik (8.6, NFR-03) | Uji manual ponsel pelanggan uji di jaringan 4G Cianjur (stopwatch 10 pesanan) | ☐ |
| 9 | Privasi & data | Posisi truk hanya saat rit Berangkat menuju pelanggan itu (PTB-54); anonimisasi & retensi OTP berjalan | Uji pelacakan `/app` sebelum/sesudah Berangkat; Akses › Data pribadi | ☐ |
| 10 | UAT US-P2-01..06, 08 | Checklist KP (teks PRD Bab 8.5) lulus di lingkungan uji dengan flag menyala untuk tenant uji | berita acara UAT Tahap 2 | ☐ |

**Menyalakan Tahap 2 (setelah semua butir Ya & berita acara ditandatangani):**
1. Pemilik: **Pengaturan › Parameter → bagian "Fitur bertahap"** → Fitur *Aplikasi pelanggan (Tahap 2)* → Berlaku untuk
   **Tenant EQUA** → *Nyalakan* → alasan (rujukan TG-9 & nomor berita acara) → *Simpan*. Alternatif setara:
   **Aplikasi pelanggan › Akun pelanggan** (`/keluhan/akun`) → *Aktifkan aplikasi pelanggan*.
2. Pelanggan kini dapat mendaftar di `/app` (OTP WA). Menu kantor *Aplikasi pelanggan* tampil.
3. Mematikan kembali kapan saja dengan cara yang sama (pelanggan diarahkan ke telepon/WA kantor; data tetap).
   Setiap perubahan berjejak di Jejak audit (objek `feature_flag`).

## 2. Gerbang Tahap 3 — portal kemitraan lengkap (PRD 9.1)

| # | Prasyarat | Ukuran | Bukti | Ya/Tidak |
|---|---|---|---|:-:|
| 1 | PT berdiri; merek diajukan/terdaftar | Akta, NIB, NPWP; tanda terima DJKI | dokumen legal | ☐ |
| 2 | Bukti sistem di depot sendiri | 3 bulan data M6 dan M11 dari 10 depot; SOP & standar mutu tertulis | Laporan outlet, Akuntansi › Laporan (3 periode Final) | ☐ |
| 3 | Kapasitas air | Studi K22 selesai; ruang kapasitas mitra Fase 1 (maks 5, PAR-81) | Produksi air › Utilisasi; PAR-81 | ☐ |
| 4 | Angka biaya ditinjau | Struktur 9.6 ditinjau setelah 3 bulan data (K18); parameter kontrak diisi | `p3.economics_illustration`, PAR-35/77–81 | ☐ |
| 5 | Dokumen legal | Perjanjian kemitraan (Opsi B); prospektus & STPW hanya Fase 2 (Opsi A) | dokumen legal | ☐ |
| 6 | M6 multi-tenant teruji | US-M6-07 KP-6 lulus dengan tenant uji | berita acara UAT M6 | ☐ |
| 7 | Isolasi tenant | Uji penetrasi lintas tenant manual lulus (B-74, PRD 9.6) | laporan uji penetrasi | ☐ |
| 8 | UAT US-P3-01..07 | Checklist KP (PRD Bab 9.5) lulus pada tenant uji dengan flag menyala per tenant | berita acara UAT Tahap 3 | ☐ |

Catatan: istilah "waralaba" tetap terkunci (flag `partner.franchise_terms`, PTB-57) sampai STPW terbit; Opsi A (royalti)
hanya dapat dipilih pada tenant yang portal lengkapnya aktif.

**Menyalakan Tahap 3:**
- **Uji coba per mitra (disarankan):** Pengaturan › Parameter → *Fitur bertahap* → *Portal kemitraan lengkap
  (Tahap 3)* → Berlaku untuk **Tenant <nama mitra> (mitra)** → *Nyalakan* (alasan). Ulangi untuk **Tenant EQUA** agar
  menu & layar kantor Tahap 3 (onboarding, mutu & audit, sanksi, dashboard) tampil bagi tim EQUA. Global tetap mati:
  mitra lain tetap RL-7, dan **calon mitra/pendaftaran publik `/mitra/daftar` tetap tertutup** (fitur itu hanya
  membaca nilai global).
- **Peluncuran penuh:** nyalakan **Semua tenant (global)** → pipeline calon mitra & pendaftaran publik terbuka; mitra yang
  belum siap dapat dikecualikan dengan pengaturan per tenant *Matikan* (per tenant mengalahkan global).
- Mematikan kembali: tindakan portal Tahap 3 ditolak & tercatat, data tetap; RL-7 berjalan terus.

## 3. Pemeriksaan setelah menyalakan flag

- [ ] Jejak audit memuat perubahan flag (pelaku = pemilik, alasan, lingkup).
- [ ] Menu yang sesuai tampil (web kantor) dan layar yang dimatikan menampilkan pesan "belum diaktifkan" untuk tenant
      lain.
- [ ] Uji asap satu alur ujung ke ujung (Tahap 2: daftar → pesan → lacak → bayar; Tahap 3: pesan air dari portal →
      rit → tagihan).
- [ ] Pemantauan insiden 7 hari pertama (Akses › Perangkat & sinkron); keluhan pelanggan/mitra ditinjau harian.

| Keputusan | Tanggal | Rujukan komite / berita acara | Pemilik (tanda tangan) |
|---|---|---|---|
| Tahap 2 dinyalakan untuk ______ |  |  |  |
| Tahap 3 dinyalakan untuk ______ |  |  |  |
