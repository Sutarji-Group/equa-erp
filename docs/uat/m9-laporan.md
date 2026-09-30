# UAT M9 — Laporan & Dashboard Pemilik

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Pemilik |
| Skenario BRD | P-06 langkah 4; katalog laporan PRD 7.9.4 |
| User story diuji (PRD 11.3) | US-M9-01 s.d. US-M9-03 (M); US-M9-04, US-M9-05 (S); US-M9-06, US-M9-07 (S, RL-6) |
| Data uji | H+0 dari hari pilot; laporan bulanan sementara; lembar pencocokan periode paralel |
| Akun uji | Pemilik (`pemilik`) di ponsel & laptop; Admin Keuangan; akuntan; Dispatcher |
| Panduan pengguna | `docs/guides/m9-reports.md` |
| Jumlah | 7 user story · 31 KP |

## Persiapan

- [ ] Minimal satu hari kas ditutup (UAT M4) dan satu bulan data uji untuk laporan bulanan sementara.
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M9-01 Dashboard H+0 — M

**Layar:** Laporan › Hari ini (H+0) (`/laporan/hari-ini`), Beranda  
**Rujukan PRD:** baris 1377

**Langkah uji:**
1. Sebelum tutup kas: *Belum ditutup — angka dapat berubah*; setelah tutup kas: *H+0 terbit* terkunci dengan cap waktu ≤ 30 menit + notifikasi.
2. Ketuk angka → rincian; *Setujui/Tolak* selisih dari blok Pengecualian; transaksi terlambat sinkron tampil sebagai catatan tambahan (angka terbit tidak berubah).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Satu layar "Hari ini" dengan enam blok: omzet per lini (L2 truk, L3 depot, L4 toko; transfer internal L2→L3 ditampilkan terpisah dan tidak dihitung sebagai omzet luar, BR-33); kas seharusnya vs diterima vs selisih; piutang (saldo, terbentuk hari ini, dilunasi, lewat tempo, % KPI-04); rit per truk (terjadwal/selesai/gagal); galon per depot; pengecualian yang menunggu keputusan. | ☐ | ☐ |  |
| 2 | Sebelum tutup kas, layar menampilkan angka berjalan berlabel "belum ditutup — angka dapat berubah"; setelah kas ditutup, versi "H+0 terbit" terkunci dengan cap waktu, terbit ≤ 30 menit setelah tutup kas (NFR-04, KPI-08), dan pemilik diberi notifikasi (PTB-05). | ☐ | ☐ |  |
| 3 | Setiap angka dapat diketuk untuk turun ke rinciannya (truk → rit; depot → shift; selisih → setoran; piutang → pelanggan) tanpa berpindah modul. | ☐ | ☐ |  |
| 4 | Penjelasan selisih disetujui atau ditolak langsung dari layar ini (satu ketuk; alasan wajib bila menolak) — sama dengan US-M4-06 KP-6. | ☐ | ☐ |  |
| 5 | Terbaca di ponsel tanpa gulir mendatar; muat ≤ 2 detik (NFR-03). | ☐ | ☐ |  |
| 6 | Riwayat H+0 per tanggal tersimpan dan tidak berubah setelah terbit; transaksi terlambat sinkron dan koreksi tampil sebagai catatan tambahan bertanda pada tanggal masing-masing, bukan mengubah angka yang sudah terbit (Bab 5.3). | ☐ | ☐ |  |
| 7 | Rentang tampilan: hari ini, kemarin, 7 hari, bulan berjalan — dengan definisi angka yang sama. | ☐ | ☐ |  |

### US-M9-02 Laporan bulanan laba kotor per lini dan konsolidasi — M

**Layar:** Laporan › Laba kotor bulanan (`/laporan/bulanan`)  
**Rujukan PRD:** baris 1389

**Langkah uji:**
1. Per lini L1–L5 + eliminasi + konsolidasi; status Sementara → Final setelah periode dikunci; ketuk lini → akun → jurnal → transaksi sumber; unduh Final identik.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Per lini L1–L5 (L5 kosong sampai Tahap 3): omzet, harga pokok/biaya langsung, laba kotor, marjin; konsolidasi mengeliminasi transfer internal (BR-33) sehingga laba gabungan tidak dihitung ganda. | ☐ | ☐ |  |
| 2 | Bersumber dari jurnal M11; berlabel "Sementara" sampai periode Ditutup/Dikunci (BR-32), lalu "Final"; tersedia paling lambat tanggal 10 (KPI-09). | ☐ | ☐ |  |
| 3 | Perbandingan dengan bulan sebelumnya dan bulan yang sama tahun lalu (setelah datanya ada). | ☐ | ☐ |  |
| 4 | Setiap angka dapat diturunkan ke akun dan ke transaksi sumbernya (rit, shift, penjualan toko, jurnal manual). | ☐ | ☐ |  |
| 5 | Selama M11 belum aktif (R04: akuntansi menyusul maksimal 2 bulan setelah go-live operasional), laporan menampilkan omzet per lini dan biaya yang sudah tercatat (pengeluaran rit, pembelian toko) berlabel "belum lengkap — M11 belum aktif" [USULAN]. | ☐ | ☐ |  |
| 6 | Karena L1 diperlakukan sebagai pusat biaya (PTB-39, CR-09), laporan bulanan menampilkan biaya produksi air per liter (total biaya L1 ÷ liter pengisian, per sumber dan gabungan) sebagai dasar keputusan kapasitas (K22) dan harga mitra (BRD 9.6–9.7). | ☐ | ☐ |  |

### US-M9-03 Ekspor Excel/PDF — M

**Layar:** Laporan › Katalog laporan (`/laporan/katalog`)  
**Rujukan PRD:** baris 1400

**Langkah uji:**
1. Ekspor setiap laporan katalog ke Excel & PDF; laporan berdata pribadi meminta *Tujuan ekspor* dan tercatat (BR-39); Dispatcher tanpa WA/alamat lengkap.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Setiap laporan pada katalog 7.9.4 memiliki ekspor Excel (data mentah dan ringkasan) dan PDF (siap cetak; identitas PT; cap waktu; pembuat; filter yang dipakai); ekspor satu bulan data selesai ≤ 30 detik [USULAN]. | ☐ | ☐ |  |
| 2 | Setiap ekspor tercatat (siapa, kapan, laporan, filter). Ekspor yang memuat data pribadi pelanggan/mitra hanya untuk pemilik dan Admin Keuangan dengan tujuan tercatat (BR-39); peran lain menerima versi tanpa nomor WA dan alamat lengkap [USULAN]. | ☐ | ☐ |  |
| 3 | Ekspor jurnal ke format konsultan pajak (NFR-23) berada di M11 dengan mekanisme dan log yang sama. | ☐ | ☐ |  |
| 4 | Laporan berstatus Final menghasilkan berkas yang identik saat diekspor ulang. | ☐ | ☐ |  |

### US-M9-04 Kotak masuk pengecualian dan pengaturan notifikasi pemilik — S (kotak masuk) / M (infrastruktur notifikasi)

**Layar:** Kotak masuk (`/kotak-masuk`), Pengaturan notifikasi  
**Rujukan PRD:** baris 1409

**Langkah uji:**
1. Setujui/Tolak/Minta keterangan langsung dari daftar; butir lewat tenggat di atas; atur seketika/ringkasan/mati & jam tenang (kritis tetap seketika); ringkasan e-mail 22.30.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Infrastruktur notifikasi (M, PTB-05): pusat notifikasi dalam web/aplikasi dan push Android; setiap peristiwa Bab 6.3 memuat objek, nilai, penerima, tenggat, dan tautan tindakan; status Baru → Dibaca → Ditindaklanjuti; tidak dapat dihapus. Peristiwa berprioritas M (selisih ≥ ambang, setoran belum diterima, Ditahan, kurang bayar, transfer tidak ditemukan, perangkat GPS mati, sinkron gagal massal) dibangun bersama modul asalnya. | ☐ | ☐ |  |
| 2 | Kotak masuk pemilik (S, FR-M9-04): daftar "Perlu tindakan" (persetujuan menunggu, selisih ≥ ambang, rit gagal, anomali GPS, susut air) dan "Info"; pengelompokan per jenis; tindakan langsung dari daftar (setujui / tolak / minta keterangan). | ☐ | ☐ |  |
| 3 | Pengaturan per jenis: seketika / ringkasan harian / mati (peristiwa kritis tidak dapat dimatikan); jam tenang untuk non-kritis (PAR-56); ringkasan e-mail harian setelah tutup kas (PAR-55). | ☐ | ☐ |  |
| 4 | Permintaan yang melewati tenggat (Bab 6.2) naik ke puncak daftar dan diberi penanda; selisih yang lewat 24 jam dihitung KPI-03. | ☐ | ☐ |  |

### US-M9-05 Kinerja per sopir/truk dan per depot/operator — S

**Layar:** Laporan › Kinerja sopir & depot (`/laporan/kinerja`)  
**Rujukan PRD:** baris 1418

**Langkah uji:**
1. Tab sopir & truk (tepat waktu, penyimpangan lokasi, selisih, hari tanpa selisih) dan depot/operator; peringkat antar peran sebanding.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Sopir/truk per bulan: rit terjadwal, selesai, gagal (per alasan); rit tepat waktu (Selesai dalam ± 60 menit dari jam diminta bila ada [USULAN]); volume parsial; penyimpangan lokasi > 200 m / > 1 km; kejadian BR-25 dan keterangannya; selisih setoran (jumlah, nilai); setoran terlambat; jarak tempuh (M12); pengeluaran rit (bila S dibangun). | ☐ | ☐ |  |
| 2 | Depot/operator per bulan: galon per hari, transaksi, void (jumlah, nilai), selisih kas dan stok, setoran terlambat, kas melebihi batas, pasokan diterima vs susut outlet. | ☐ | ☐ |  |
| 3 | Deret hari tanpa selisih per orang sebagai dasar insentif nihil selisih (BR-12); peringkat hanya antar peran yang sebanding dan menampilkan zona/rute agar adil. | ☐ | ☐ |  |
| 4 | Hanya pemilik; sopir/operator melihat kinerjanya sendiri di aplikasinya (US-M3-07 KP-6). | ☐ | ☐ |  |

### US-M9-06 Tren mingguan/bulanan — S, dijadwalkan RL-6 (kompensasi, Bab 2.4)

**Layar:** Laporan › Tren (`/laporan/tren`)  
**Rujukan PRD:** baris 1427

**Langkah uji:**
1. Mingguan & bulanan 13 periode: omzet per lini, rit, galon, piutang; ekspor (RL-6).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Grafik dan tabel per minggu dan per bulan untuk 13 periode terakhir: omzet per lini, rit per truk, galon per depot, piutang (saldo, % lewat tempo); perbandingan dengan periode sebelumnya. | ☐ | ☐ |  |
| 2 | Definisi tiap ukuran sama dengan H+0 dan laporan bulanan (satu definisi omzet di seluruh sistem). | ☐ | ☐ |  |
| 3 | Ekspor sesuai US-M9-03. | ☐ | ☐ |  |

### US-M9-07 Laporan KPI program (KPI-01–KPI-11) — S [USULAN, PTB-30], dibangun di RL-6

**Layar:** Laporan › KPI program (`/laporan/kpi`), Periode paralel (`/laporan/periode-paralel`)  
**Rujukan PRD:** baris 1435

**Langkah uji:**
1. KPI-01–KPI-11 dengan status & riwayat; isi KPI-10 jam/minggu; PDF komite pengarah (RL-6).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Satu halaman KPI: definisi dan rumus sesuai Bab 1.3, nilai bulan berjalan, target BRD 2.3, status; riwayat bulanan sejak pilot. | ☐ | ☐ |  |
| 2 | KPI-10 (jam pemilik per minggu) diinput manual pemilik dari catatannya; KPI-11 dihitung dari pengguna aktif (M10) dan tanggal nota kertas ditarik per unit yang dicatat manajer proyek. | ☐ | ☐ |  |
| 3 | Ekspor PDF untuk rapat komite pengarah (12.8). | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| NFR-19 | Pemilik membaca H+0 dan menyetujui satu selisih dari ponsel (lebar layar ponsel, tanpa geser horizontal). | ☐ | ☐ |  |
| NFR-23 | Setiap laporan di katalog 7.9.4 berhasil diekspor Excel & PDF (centang per laporan). | ☐ | ☐ |  |
| NFR-04 / KPI-08 | Pilot: 14 dari 14 hari H+0 terbit ≤ 30 menit setelah tutup kas (lihat docs/uat/pilot.md). | ☐ | ☐ |  |

## Catatan cacat

| No | US / KP | Uraian & langkah mereproduksi | Kelas | Penanggung jawab | Tenggat | Status |
|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |

## Kelas cacat (PRD 11.2)

| Kelas | Definisi | Konsekuensi |
|---|---|---|
| **Kritis** | Transaksi tidak dapat dicatat, hilang, dobel, atau dapat diubah tanpa jejak; kebocoran data lintas peran/tenant; salah hitung uang | Menahan rilis; ditanggapi ≤ 30 menit setelah go-live (NFR-31) |
| **Mayor** | Fungsi M tidak bekerja sesuai KP tetapi ada jalan lain berjejak | Menahan rilis kecuali komite pengarah menerima dengan tenggat perbaikan |
| **Minor** | Ketidaknyamanan, teks, tampilan | Masuk backlog; tidak menahan rilis |

User story **lulus** bila seluruh KP dijawab "lulus" oleh pemilik modul pada UAT dengan data nyata dan cacat tersisa bukan
Kritis/Mayor. User story prioritas M yang tidak lulus menahan rilis (PRD 11.2).

## Berita acara (PRD 11.3)

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M9 Laporan & Dashboard Pemilik**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Pemilik — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-06 langkah 4; katalog laporan PRD 7.9.4 |
| Data uji | H+0 dari hari pilot; laporan bulanan sementara; lembar pencocokan periode paralel |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M9-01 |  | __ / __ |  |
| US-M9-02 |  | __ / __ |  |
| US-M9-03 |  | __ / __ |  |
| US-M9-04 |  | __ / __ |  |
| US-M9-05 |  | __ / __ |  |
| US-M9-06 |  | __ / __ |  |
| US-M9-07 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
