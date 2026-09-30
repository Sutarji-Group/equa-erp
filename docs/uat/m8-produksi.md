# UAT M8 — Produksi & Stok Air

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Operator produksi |
| Skenario BRD | P-04 |
| User story diuji (PRD 11.3) | US-M8-01 s.d. US-M8-04, US-M8-07 (M); US-M8-05, US-M8-06 (S) |
| Data uji | Dua sumber air, satu hari penuh angka meter & pengisian truk (termasuk pasokan depot) |
| Akun uji | Operator produksi (`produksi1` SA1, `produksi4` SA2) di ponsel sumber; pemilik; Admin Keuangan |
| Panduan pengguna | `docs/guides/lapangan/operator-produksi.md (1 halaman) · docs/guides/m8-production.md` |
| Jumlah | 7 user story · 29 KP |

## Persiapan

- [ ] Ponsel sumber diaktifkan; meter dengan angka awal berfoto (M1); jadwal pengisian truk hari itu terbit.
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M8-01 Mencatat produksi harian dari angka meter dengan foto — M

**Layar:** Aplikasi produksi `/produksi` › Catat meter  
**Rujukan PRD:** baris 1261

**Langkah uji:**
1. Angka meter pagi & malam + foto wajib; angka lebih kecil ditolak; lewat 08.00/23.00 → alasan terlambat; koreksi berfoto oleh Admin Keuangan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Setiap sumber memiliki satu atau lebih meter (master M1: pengenal, satuan, angka awal cut-over); pembacaan pagi (awal) dan malam (akhir) per meter: angka, foto meter (kamera aplikasi, terkompresi PAR-38), waktu perangkat; produksi harian = Σ (akhir − awal) per sumber. | ☐ | ☐ |  |
| 2 | Angka yang lebih kecil dari pembacaan sebelumnya ditolak dengan pesan; putaran meter (rollover) atau penggantian meter dicatat admin sistem/Admin Keuangan dengan alasan sehingga hitungan tetap benar [USULAN]. | ☐ | ☐ |  |
| 3 | Pembacaan yang belum ada pada 08.00 (pagi) atau 23.00 (malam) [USULAN jam] → pengingat ke operator dan notifikasi ke pemilik pada H+0 sebagai "produksi belum tercatat"; produksi hari itu berstatus "belum lengkap" sampai dilengkapi dengan alasan. | ☐ | ☐ |  |
| 4 | Produksi harian yang menyimpang > 20% dari rata-rata 7 hari ditandai untuk verifikasi (foto meter dibandingkan) [USULAN ambang, PAR-68]. | ☐ | ☐ |  |
| 5 | Pembacaan tidak dapat diubah setelah tersinkron; koreksi oleh Admin Keuangan dengan alasan dan foto pembanding (BR-38). | ☐ | ☐ |  |

### US-M8-02 Mencatat pengisian truk per rit — M

**Layar:** `/produksi` › Isi truk  
**Rujukan PRD:** baris 1271

**Langkah uji:**
1. Truk terjadwal paling atas → volume (beda → alasan, *Sisa muatan*) → rit tujuan; truk lain / tanpa rit ditandai ke kantor; geofence armada memverifikasi.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Pengisian: truk (pilih dari daftar truk yang dijadwalkan mengisi di sumber ini hari itu; truk lain dapat dipilih dengan konfirmasi), volume (bawaan 5.000 L, ubah dengan alasan), waktu perangkat, rit tujuan yang disarankan dari papan jadwal M2 (rit berikutnya truk itu yang belum Berangkat), foto opsional. | ☐ | ☐ |  |
| 2 | Satu pengisian terkait satu rit (PTB-09); pengisian tanpa rit terjadwal dicatat sebagai "pengisian tanpa rit" dan ditandai ke Dispatcher dan pemilik (indikasi rit tanpa pesanan, P-01 langkah 8). | ☐ | ☐ |  |
| 3 | Pengisian untuk rit internal pasokan depot ditandai otomatis sebagai pasokan (US-M8-03). | ☐ | ☐ |  |
| 4 | Bila FR-M12-05 tersedia, pengisian dicocokkan dengan masuk/keluar geofence sumber (US-M12-06); ketidaksesuaian ditandai, tidak memblokir pencatatan. | ☐ | ☐ |  |
| 5 | Operator hanya melihat dan mencatat sumber air yang ditugaskan; pergantian operator antar sumber diatur lingkup (US-M10-01 KP-3). | ☐ | ☐ |  |
| 6 | Pengisian tersimpan tidak dapat diubah operator; koreksi oleh Admin Keuangan lewat pembalik (BR-38); volume terkirim ke pelanggan (M3) yang lebih kecil dari volume pengisian ditampilkan sebagai selisih rit untuk neraca air. | ☐ | ☐ |  |

### US-M8-03 Pasokan air ke depot sendiri — M

**Layar:** `/produksi` › Isi truk (rit internal); kantor: Produksi › Pengisian & pasokan  
**Rujukan PRD:** baris 1282

**Langkah uji:**
1. Pengisian untuk pasokan depot → depot mengonfirmasi di POS; selisih > PAR-69 ditandai; stok awal air depot (cut-over) di tab *Stok awal depot*.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Rit internal (US-M2-01 KP-6) mengalir: pengisian di sumber (US-M8-02) → Selesai di depot oleh sopir dengan volume diserahkan (US-M3-03 KP-5) → konfirmasi volume diterima oleh operator depot (US-M6-05). | ☐ | ☐ |  |
| 2 | Sistem menampilkan tiga angka per pasokan (diisi, diserahkan, diterima); selisih di luar toleransi (PAR-69 [USULAN], bawaan 2%) ditandai ke Dispatcher dan pemilik dan masuk perhitungan susut (US-M8-04). | ☐ | ☐ |  |
| 3 | Nilai pasokan untuk jurnal M11 = volume diterima × harga transfer (tarif zona alamat depot, segmen depot pihak ketiga; K20). | ☐ | ☐ |  |
| 4 | Ringkasan pasokan per depot per hari/bulan (liter, jumlah rit) tersedia untuk neraca air outlet (US-M6-05 KP-4) dan Bab 9 (mitra). | ☐ | ☐ |  |

### US-M8-04 Neraca air harian per sumber dan susut — M

**Layar:** Produksi air › Neraca air (`/produksi/neraca-air`, rincian)  
**Rujukan PRD:** baris 1291

**Langkah uji:**
1. Neraca per sumber per hari (produksi vs pengisian vs pasokan vs kembali); susut > batas → operator mengisi penjelasan + foto → pemilik *Terima* / *Kembalikan*.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Neraca harian per sumber sesuai BRD: produksi − Σ pengisian (termasuk pasokan depot) = susut; susut dalam liter dan persen produksi; dihitung otomatis setelah pembacaan malam. | ☐ | ☐ |  |
| 2 | Susut > 5% (PAR-18, BR-26) → tugas investigasi ke operator (alasan dari daftar: kebocoran, pencucian/pembuangan, meter bermasalah, pengisian belum tercatat, lainnya + foto) dan laporan ke pemilik pada H+0 (Bab 6.3); status Investigasi → Selesai setelah pemilik menerima penjelasan. | ☐ | ☐ |  |
| 3 | Sebagai informasi tambahan (PTB-41): rata-rata susut 7 hari dan pembacaan level tandon opsional (bila operator memasukkannya) untuk menjelaskan pergeseran stok antar hari; peringatan BR-26 tetap memakai angka harian. | ☐ | ☐ |  |
| 4 | Neraca bulanan per sumber: produksi, pengisian pelanggan, pasokan depot, susut, rata-rata per hari; ekspor (M9). | ☐ | ☐ |  |
| 5 | Susut negatif (pengisian melebihi produksi) ditandai sebagai anomali pencatatan (meter atau pengisian ganda) dan wajib verifikasi Admin Keuangan. | ☐ | ☐ |  |

### US-M8-05 Utilisasi kapasitas dan peringatan — S

**Layar:** Produksi air › Utilisasi kapasitas (`/produksi/utilisasi`)  
**Rujukan PRD:** baris 1301

**Langkah uji:**
1. Utilisasi harian, hari > PAR-19, ruang tumbuh; notifikasi push setelah PAR-85 hari berturut.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Utilisasi harian = Σ pengisian ÷ kapasitas harian sumber (master; K1); utilisasi bulanan = rata-rata harian dan hari di atas 90%; tampil per sumber dan gabungan. | ☐ | ☐ |  |
| 2 | Dua tingkat dengan satu definisi: utilisasi harian > 90% (PAR-19) langsung ditandai di dashboard dan H+0 (P-04 langkah 5); > 90% selama 3 hari berturut (PAR-85 [USULAN]) → notifikasi push ke pemilik (mencegah notifikasi berlebih, RP-10); ruang tumbuh (liter/hari dan setara rit) ditampilkan. | ☐ | ☐ |  |
| 3 | Ekspor data harian 6 bulan untuk studi kelayakan kapasitas (K22) dalam satu berkas. | ☐ | ☐ |  |

### US-M8-06 Catatan mutu air — S

**Layar:** `/produksi` › Hasil uji mutu; kantor: Produksi air › Mutu air  
**Rujukan PRD:** baris 1309

**Langkah uji:**
1. Catat hasil lab + foto sertifikat; tidak lulus → tindakan, penanggung jawab, tenggat; pengingat jadwal uji.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Jadwal uji per lokasi (sumber, depot) dengan frekuensi yang ditetapkan pemilik/konsultan (tidak ada bawaan di BRD; PAR-70); pengingat H-7 ke pemilik dan operator. | ☐ | ☐ |  |
| 2 | Hasil uji: tanggal, laboratorium, parameter dan nilai, lulus/tidak, lampiran foto/PDF sertifikat; hasil tidak lulus → tindakan wajib (deskripsi, penanggung jawab, tenggat) dan notifikasi pemilik. | ☐ | ☐ |  |
| 3 | Riwayat per lokasi untuk audit dan prospektus kemitraan (Bab 9); daftar periksa mutu harian depot dirinci pada Tahap 3 (EP-3-05), tidak dibangun di Tahap 1. | ☐ | ☐ |  |

### US-M8-07 Bekerja tanpa sinyal di sumber air — M

**Layar:** `/produksi` (mode pesawat)  
**Rujukan PRD:** baris 1317

**Langkah uji:**
1. Satu hari meter & pengisian tanpa sinyal → terkirim saat sinyal kembali tanpa dobel; *Bantuan → Kirim sekarang*.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Pembacaan meter, pengisian, pasokan, dan investigasi susut berfungsi offline minimal satu hari; jadwal rit hari ini (daftar truk yang akan mengisi) diunduh saat login dan diperbarui di latar. | ☐ | ☐ |  |
| 2 | Status per item dan sinkron otomatis ≤ 5 menit (Bab 6.4); foto terkompresi (PAR-38); login PIN pada perangkat terdaftar (US-M10-02). | ☐ | ☐ |  |
| 3 | Antarmuka ≤ 3 langkah, teks ≥ 16 pt, istilah lapangan (NFR-15 s.d. NFR-18); pelatihan ≤ 2 jam (NFR-16). | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| B-19 | Foto meter dengan kamera ponsel sumber nyata terbaca (angka jelas) setelah kompresi. | ☐ | ☐ |  |
| NFR-06 | Sumber air tanpa sinyal satu hari penuh; data terkirim utuh. | ☐ | ☐ |  |
| B-45 | Penanda geofence armada (pengisian tanpa truk di sumber, truk di sumber tanpa pengisian) tampil di rincian neraca dengan truk GPS nyata. | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M8 Produksi & Stok Air**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Operator produksi — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-04 |
| Data uji | Dua sumber air, satu hari penuh angka meter & pengisian truk (termasuk pasokan depot) |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M8-01 |  | __ / __ |  |
| US-M8-02 |  | __ / __ |  |
| US-M8-03 |  | __ / __ |  |
| US-M8-04 |  | __ / __ |  |
| US-M8-05 |  | __ / __ |  |
| US-M8-06 |  | __ / __ |  |
| US-M8-07 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
