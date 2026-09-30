# UAT M12 — Pelacakan Armada / GPS

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Dispatcher |
| Skenario BRD | P-01 langkah 5–8; BR-23, BR-25 |
| User story diuji (PRD 11.3) | US-M12-01 s.d. US-M12-05, US-M12-08 KP-1–2 (M); US-M12-06, US-M12-08 KP-3–4 (S); US-M12-07 (S, RL-6) |
| Data uji | Truk pilot dengan perangkat GPS nyata; skenario perjalanan di luar jadwal dan perangkat dicabut |
| Akun uji | Dispatcher (`dispatcher1`), pemilik, admin sistem, sopir truk pilot |
| Panduan pengguna | `docs/guides/m12-fleet.md` |
| Jumlah | 8 user story · 36 KP |

## Persiapan

- [ ] Perangkat GPS terpasang & terdaftar (IMEI) di truk pilot; vendor mengirim ke `/api/gps/ingest/<vendor>` dengan `GPS_INGEST_TOKEN`.
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M12-01 Menerima posisi dari perangkat GPS truk dan cadangan ponsel — M

**Layar:** Armada › Perangkat GPS (`/armada/perangkat`)  
**Rujukan PRD:** baris 1725

**Langkah uji:**
1. Posisi masuk ≤ 1 menit (PAR-26); pengiriman ulang vendor tidak dobel; GPS mati → aplikasi sopir mengirim GPS ponsel selama rit (penanda *GPS ponsel aktif*).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Penghubung vendor menerima posisi (waktu perangkat, lintang/bujur, kecepatan, arah, status kontak/daya bila tersedia) dari 7 + 1 perangkat terpasang; posisi disimpan mentah dengan waktu server dan penanda kualitas (akurasi, valid/tidak); minimal 1 posisi per menit saat bergerak (FR-M12-01). | ☐ | ☐ |  |
| 2 | Perangkat dipetakan ke truk lewat master armada (US-M1-03); pergantian ke perangkat cadangan tidak memutus riwayat truk. | ☐ | ☐ |  |
| 3 | Penggantian vendor hanya mengubah modul penghubung; format posisi internal tetap (NFR-21). Uji 1 unit pada bulan 3 sebelum pembelian penuh (R05) dicatat hasilnya. | ☐ | ☐ |  |
| 4 | Sumber cadangan: titik status dari M3 (Berangkat/Tiba/Selesai) selalu disimpan; jejak berkelanjutan GPS ponsel aktif otomatis untuk truk yang perangkatnya Mati/Dicabut (US-M12-08) dan berhenti saat perangkat aktif kembali; sumber setiap posisi ditandai. | ☐ | ☐ |  |
| 5 | Waktu perangkat yang menyimpang > 10 menit dari server ditandai (PAR-42); posisi berakurasi buruk tidak dipakai untuk mendeteksi kejadian tetapi tetap disimpan. | ☐ | ☐ |  |
| 6 | Posisi mentah disimpan 12 bulan; ringkasan per rit/hari disimpan bersama rit (PTB-33, PAR-52). | ☐ | ☐ |  |

### US-M12-02 Peta posisi truk real-time — M

**Layar:** Armada › Peta truk (`/armada/peta`), peta di Papan jadwal  
**Rujukan PRD:** baris 1736

**Langkah uji:**
1. Status per truk, umur posisi (basi > PAR-48), klik truk → rit, perkiraan tiba, telepon/WA sopir; lapisan alamat/sumber/depot/zona.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Peta 7 truk untuk Dispatcher (web) dan pemilik (web/ponsel): ikon per truk dengan nomor, status (rit aktif ke pelanggan X / menuju sumber / di sumber / di depot / berhenti / di luar jadwal), sopir hari itu, kecepatan, umur posisi terakhir; pembaruan ≤ 1 menit; posisi lebih tua dari 5 menit ditandai "basi" (PAR-48). | ☐ | ☐ |  |
| 2 | Klik truk → rit hari ini dan statusnya, rit berikutnya, perkiraan jarak dan waktu ke tujuan (peta komersial, NFR-24), kontak sopir, tautan ke riwayat. | ☐ | ☐ |  |
| 3 | Lapisan peta: alamat rit hari ini, sumber air, depot, pool (PTB-34), zona tarif (opsional). | ☐ | ☐ |  |
| 4 | Tampilan yang sama tersemat atau berdampingan pada papan jadwal (US-M2-03 KP-6); tidak ada data posisi untuk peran lain (sopir tidak melihat truk lain). | ☐ | ☐ |  |
| 5 | Putar ulang 24 jam terakhir dari peta. | ☐ | ☐ |  |

### US-M12-03 Riwayat perjalanan per rit dan per hari — M

**Layar:** Armada › Riwayat perjalanan (`/armada/riwayat`)  
**Rujukan PRD:** baris 1746

**Langkah uji:**
1. Per truk per hari (jarak, berhenti ≥ PAR-49, KPI-07) dan per rit (jejak, bukti kirim); putar ulang 24 jam; ekspor ringkasan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Per rit: jejak dari Berangkat sampai Selesai/Gagal, jarak (km), durasi, titik berhenti ≥ 5 menit (PAR-49) dengan lokasi dan lama, lama di lokasi pelanggan; ditautkan ke bukti kirim (M3) dan pengisian (M8). | ☐ | ☐ |  |
| 2 | Per truk per hari: jarak total, waktu bergerak, waktu berhenti, gerakan pertama dan terakhir, jumlah rit, jarak antar-rit (kembali ke sumber) — berdampingan dengan rit terjadwal vs selesai (KPI-07). | ☐ | ☐ |  |
| 3 | Jejak dapat diputar ulang dan diekspor (PDF ringkasan; Excel titik berhenti); posisi mentah tidak diekspor [USULAN]. | ☐ | ☐ |  |
| 4 | Jarak dihitung dari jejak perangkat; bila hanya titik status ponsel yang tersedia, jarak diestimasi dari rute peta dan ditandai "estimasi". | ☐ | ☐ |  |

### US-M12-04 Pencocokan lokasi Selesai dengan alamat pelanggan — M

**Layar:** Armada › Kejadian armada (`/armada/kejadian`)  
**Rujukan PRD:** baris 1755

**Langkah uji:**
1. Selesai > 200 m / > 1 km dari alamat → tingkat penyimpangan; titik ponsel vs GPS truk tidak konsisten; pemilik *Terima alasan* / *Minta keterangan sopir*.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Saat rit Selesai tersinkron, server menghitung jarak titik Selesai (M3) ke koordinat alamat kirim: > 200 m → penyimpangan tingkat 1 (alasan sopir sudah tercatat); > 1 km → tingkat 2 untuk tinjauan pemilik (BR-23). Hitungan server menggantikan hitungan lokal aplikasi. | ☐ | ☐ |  |
| 2 | Pembandingan tambahan: posisi perangkat GPS truk pada waktu Selesai vs titik Selesai dari ponsel; beda > 200 m → "sumber lokasi tidak konsisten" [USULAN] (indikasi Selesai ditekan bukan di lokasi truk). | ☐ | ☐ |  |
| 3 | Daftar tinjauan pemilik: rit, pelanggan, jarak, alasan sopir, peta kecil; tindakan: terima alasan / minta keterangan (tugas ke M3) / tandai tindak lanjut; keputusan berjejak; pola berulang per sopir atau pelanggan masuk US-M9-05. | ☐ | ☐ |  |
| 4 | Alamat Belum dikunci: tidak ada penyimpangan; titik Selesai (atau posisi perangkat saat itu) diusulkan sebagai koordinat alamat (US-M1-01 KP-2). | ☐ | ☐ |  |
| 5 | Rit internal: tujuan pembanding = koordinat depot. | ☐ | ☐ |  |

### US-M12-05 Perjalanan di luar jadwal atau jam operasional — M

**Layar:** Armada › Kejadian armada; aplikasi sopir › Keterangan  
**Rujukan PRD:** baris 1765

**Langkah uji:**
1. Gerak tanpa rit Berangkat / di luar jam PAR-07 / berhenti tidak dikenal > PAR-51 → kejadian + tugas keterangan sopir (BR-25); tanpa keterangan saat tutup kas → kotak masuk pemilik.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Deteksi otomatis: truk bergerak > 500 m atau > 10 menit (PAR-50) tanpa rit Berangkat/Tiba pada truk itu, atau bergerak di luar 05.00–22.00 (PAR-07) — kecuali perjalanan yang diharapkan menuju/dari lokasi sah (ke sumber sebelum rit pertama; kembali ke pool setelah rit terakhir), dengan lokasi sah dari master (PTB-34). | ☐ | ☐ |  |
| 2 | Berhenti > 15 menit (PAR-51) di luar alamat rit, sumber, depot, atau pool selama rit aktif ditandai "berhenti tidak dikenal" (indikasi rit tanpa pesanan, P-01 langkah 8). | ☐ | ☐ |  |
| 3 | Setiap kejadian memuat waktu, lokasi, jarak/durasi, truk, pengguna aktif pada perangkat bila ada, dan peta; dikirim ke Dispatcher dan pemilik (Bab 6.3); sopir mendapat tugas keterangan pada hari yang sama di M3 (BR-25). | ☐ | ☐ |  |
| 4 | Alur: Terdeteksi → Keterangan sopir → Ditinjau pemilik (terima / tindak lanjut di luar sistem) → Selesai; kejadian tanpa keterangan hingga tutup kas tampil di H+0 dan kotak masuk pemilik. | ☐ | ☐ |  |
| 5 | Parameter deteksi dapat diubah pemilik (Lampiran B); perubahan berjejak. | ☐ | ☐ |  |

### US-M12-06 Geofence sumber air dan depot — S

**Layar:** Produksi air › Neraca air (rincian), Armada › Kejadian  
**Rujukan PRD:** baris 1775

**Langkah uji:**
1. Pengisian dengan truk di geofence sumber → *Terverifikasi geofence*; pengisian tanpa geofence / truk lama di sumber tanpa pengisian / pasokan depot tanpa masuk depot → penanda.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Geofence radius per lokasi (bawaan 100 m, PAR-54; dari master M1); kejadian masuk/keluar per truk dengan waktu dan lama. | ☐ | ☐ |  |
| 2 | Pencocokan dengan pengisian (M8): pengisian tercatat tanpa kejadian masuk geofence sumber dalam ± 30 menit → ditandai; truk di geofence sumber > 10 menit tanpa pengisian tercatat → ditandai [USULAN ambang]. | ☐ | ☐ |  |
| 3 | Pencocokan dengan pasokan depot (M6/M8): rit internal Selesai tanpa masuk geofence depot → ditandai. | ☐ | ☐ |  |
| 4 | Kejadian bertanda masuk daftar tinjauan pemilik dan pertimbangan neraca air (M8). | ☐ | ☐ |  |

### US-M12-07 Jarak per rit untuk biaya BBM dan pemeriksaan zona — S, dijadwalkan RL-6 (kompensasi, Bab 2.4)

**Layar:** Armada › BBM & zona (`/armada/bbm`)  
**Rujukan PRD:** baris 1784

**Langkah uji:**
1. Isi PAR-53 → estimasi BBM per rit vs BBM nyata bulanan; pemeriksaan zona dari jarak GPS 3 rit terakhir (RL-6).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Jarak rit (US-M12-03) × konsumsi BBM standar per km × harga BBM per liter (PAR-53, ditetapkan pemilik) = estimasi biaya BBM per rit; dikirim ke M11 sebagai biaya per rit lini L2 dan dibandingkan bulanan dengan pembelian BBM nyata (US-M3-08, jurnal M11); selisihnya ditampilkan, tidak menyesuaikan otomatis. | ☐ | ☐ |  |
| 2 | Pemeriksaan zona: jarak rute sumber acuan → alamat (US-M1-05) dan rata-rata jarak GPS aktual 3 rit terakhir dibandingkan dengan batas zona; alamat yang jarak aktualnya masuk zona lain ditampilkan ke pemilik dengan selisih tarifnya; perubahan zona hanya lewat US-M1-05 (persetujuan pemilik), tidak otomatis. | ☐ | ☐ |  |
| 3 | Laporan bulanan biaya BBM per rit per truk dan per zona (M9). | ☐ | ☐ |  |

### US-M12-08 Peringatan perangkat mati atau dicabut — M (KP-1–2: deteksi, peringatan, aktivasi GPS ponsel — turunan NFR-28 dan FR-M12-06, CR-13) / S (KP-3–4)

**Layar:** Armada › Perangkat GPS, Akses › Perangkat › rincian (kartu GPS)  
**Rujukan PRD:** baris 1792

**Langkah uji:**
1. Cabut perangkat → status *Dicabut*, tim IT & Dispatcher diberi tahu ≤ PAR-25; mati > 15 menit di jam layanan → insiden; pola per truk 30 hari.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Tidak ada posisi dari perangkat > 15 menit (PAR-25) pada jam layanan, atau sinyal daya terputus dari perangkat → status Mati/Dicabut; peringatan ke tim IT dan Dispatcher (Bab 6.3); tercatat sebagai kejadian per truk. | ☐ | ☐ |  |
| 2 | Selama Mati/Dicabut: jejak GPS ponsel diaktifkan (US-M12-01 KP-4); rit tetap dapat berjalan; kejadian yang lebih dari 2 jam dalam sehari tampil di H+0 [USULAN]. | ☐ | ☐ |  |
| 3 | Perangkat aktif kembali → kejadian ditutup dengan lama mati; pola berulang per truk dilaporkan ke pemilik (indikasi pencabutan disengaja). | ☐ | ☐ |  |
| 4 | Kesehatan perangkat GPS (terakhir terlihat, daya, versi) tampil pada halaman perangkat US-M10-07. | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| B-47 | Uji 1 unit perangkat GPS nyata (R05, US-M12-01 KP-3): posisi, daya, versi, IMEI dikenali. | ☐ | ☐ |  |
| B-47 | Skenario perangkat dicabut di truk pilot: peringatan terkirim, GPS ponsel cadangan aktif, kejadian berulang dilaporkan ke pemilik. | ☐ | ☐ |  |
| NFR-24 | Cadangan tanpa peta komersial: garis lurus × 1,3 dipakai untuk jarak/zona (D-10 butir 4), biaya peta = 0. | ☐ | ☐ |  |
| NFR-21 | Simulasi penghubung vendor kedua (format OsmAnd/Traccar) dengan format internal tetap. | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M12 Pelacakan Armada / GPS**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Dispatcher — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-01 langkah 5–8; BR-23, BR-25 |
| Data uji | Truk pilot dengan perangkat GPS nyata; skenario perjalanan di luar jadwal dan perangkat dicabut |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M12-01 |  | __ / __ |  |
| US-M12-02 |  | __ / __ |  |
| US-M12-03 |  | __ / __ |  |
| US-M12-04 |  | __ / __ |  |
| US-M12-05 |  | __ / __ |  |
| US-M12-06 |  | __ / __ |  |
| US-M12-07 |  | __ / __ |  |
| US-M12-08 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
