# Pilot (RL-3) — kriteria & cara mengukur di sistem (PRD 11.4)

Pilot berjalan **14 hari berturut-turut** di unit yang mewakili ekstrem: **2 truk** (rute dekat & rute jauh — zona tarif
dan jarak GPS), **2 depot** (ramai & sepi — antrean POS dan selisih), dan **toko**. Admin Keuangan menutup kas di sistem
setiap hari. Kriteria masuk: RL-2 lulus (UAT per modul, `docs/uat/`), pelatihan unit pilot selesai, perangkat
terdaftar, juara lapangan siap. Kriteria keluar: semua baris tabel di bawah **terpenuhi 14 hari berturut** dan evaluasi
pilot ditandatangani pemilik.

## Kriteria & sumber angka

| # | Kriteria BRD 12.3 | Ukuran di produk | Di mana melihatnya | Target |
|---|---|---|---|---|
| 1 | 14 hari berturut 100% transaksi unit pilot tercatat | **KPI-01** per unit pilot (transaksi dicatat di perangkat sumber & tersinkron hari itu; tanpa "dicatat kantor") **dan** lembar pencocokan nota kertas vs sistem nol selisih (NFR-35) | Laporan › **KPI program** (KPI-01, per bulan); Pesanan & jadwal › **Laporan sopir** (daftar *Dicatat kantor*); Laporan › **Periode paralel** (lembar harian per unit) | KPI-01 = 100%; 0 selisih nota |
| 2 | Semua selisih terjelaskan dalam 24 jam | **KPI-03** = 0 pada unit pilot | Kas › **Selisih** (tab *Terbuka*, umur; lewat 24 jam paling atas); KPI program (KPI-03) | 0 |
| 3 | Sopir & operator bekerja tanpa pendampingan pada minggu kedua | Catatan juara lapangan/manajer proyek: tidak ada intervensi pendamping hari 8–14; NFR-16 | Lembar harian di bawah (di luar sistem); tiket Bantuan dari unit pilot (Akses › Bantuan) sebagai pembanding | 0 intervensi hari 8–14 |
| 4 | Sinkronisasi offline tanpa kehilangan data | Jumlah & nilai transaksi perangkat = server setiap hari (NFR-07) | Akses › **Perangkat & sinkron** (antrean 0 di akhir hari, 0 konflik tak tertangani); aplikasi sopir *Semua terkirim*; POS › Riwayat vs Depot & toko › **Pemantauan outlet** (jumlah & nilai per shift); Kas › Setoran (*Menunggu sinkron* = 0) | 0 selisih jumlah/nilai |
| 5 | Laporan H+0 terbit otomatis | 14 dari 14 hari H+0 terbit ≤ 30 menit setelah tutup kas (**KPI-08**, NFR-04) | Laporan › **Hari ini (H+0)** → *Riwayat per tanggal* (cap waktu *Kas ditutup … · H+0 terbit … (N menit)*); KPI program (KPI-08) | 14/14 ≤ 30 menit |
| 6 | Tidak ada cacat kritis terbuka | Daftar cacat kelas **Kritis** = 0 pada akhir pilot (PRD 11.2) | Tabel *Catatan cacat* di dokumen UAT modul; Akses › Perangkat & sinkron → insiden **kritis** terbuka = 0 | 0 |

Ukuran pendukung selama pilot:

| Ukuran | Cara | Target |
|---|---|---|
| NFR-17 kuota & baterai | Pengaturan ponsel truk pilot (pemakaian data aplikasi/peramban, baterai) dicatat hari 1 & 14 pada 2 truk | ≤ 50 MB/bulan/sopir (PAR-31) |
| NFR-03 waktu respons | 20 aksi lapangan di perangkat menengah-bawah & 20 layar web (stopwatch) | ≤ 1 dtk lapangan, ≤ 2 dtk web |
| KPI-02 rekonsiliasi harian | Laporan › KPI program (KPI-02, dari log setoran diterima → kas ditutup) | baseline |
| KPI-07 rit terealisasi | Laporan › KPI program / Katalog laporan `m9.trip_realization` | baseline (kalibrasi PAR-33) |
| NFR-02 ketersediaan | Akses › Perangkat & sinkron → *Uptime bulan ini* | ≥ 99,5% jam layanan |

## Rutinitas harian pilot

| Waktu | Siapa | Tindakan |
|---|---|---|
| 05.00–07.00 | Juara lapangan | Pastikan ponsel/tablet unit pilot login & *Semua terkirim* dari kemarin; catat intervensi |
| Siang | Dispatcher | Papan jadwal, peta truk pilot, kendala sopir; Persetujuan tunai → tempo ≤ 30 menit |
| Sore | Admin Keuangan | Terima setoran (tanpa *Menunggu sinkron*), jelaskan selisih, cocokkan transfer |
| ≤ 22.00 | Admin Keuangan | **Tutup kas** → H+0 terbit; isi **lembar pencocokan** nota kertas vs sistem per unit (Laporan › Periode paralel) |
| Malam | Pemilik | Baca H+0 (ponsel), putuskan selisih ≥ PAR-01 di Kotak masuk (≤ 24 jam) |
| Pagi berikut | Admin sistem | Akses › Perangkat & sinkron: insiden, antrean, uptime; catat cadangan harian |

## Lembar harian pilot (salin per hari)

| Tanggal | Hari ke- | KPI-01 unit pilot (%) | Selisih nota (jumlah/nilai) | Selisih > 24 jam | Antrean perangkat akhir hari | H+0 (menit setelah tutup kas) | Intervensi pendamping (unit, uraian) | Cacat baru (kelas) | Paraf Admin Keuangan / juara lapangan |
|---|:-:|:-:|---|:-:|:-:|:-:|---|---|---|
|  | 1 |  |  |  |  |  |  |  |  |
|  | … |  |  |  |  |  |  |  |  |
|  | 14 |  |  |  |  |  |  |  |  |

Hari yang gagal kriteria **mengulang hitungan 14 hari berturut** (setelah penyebab diperbaiki dan dicatat).

## Evaluasi pilot (ditandatangani pemilik)

| Kriteria | Hasil 14 hari | Terpenuhi (Ya/Tidak) | Catatan |
|---|---|:-:|---|
| 1. 100% transaksi tercatat (KPI-01 + lembar nota) |  |  |  |
| 2. Selisih terjelaskan ≤ 24 jam (KPI-03 = 0) |  |  |  |
| 3. Tanpa pendampingan minggu kedua |  |  |  |
| 4. Sinkron offline tanpa kehilangan data |  |  |  |
| 5. H+0 14/14 ≤ 30 menit |  |  |  |
| 6. 0 cacat Kritis terbuka |  |  |  |

Keputusan: ☐ Pilot **lulus** → RL-4 perluasan (`docs/uat/paralel.md`) ☐ Diperpanjang sampai ______ (alasan: ______)

| Pemilik | Manajer proyek IT | Admin Keuangan |
|---|---|---|
| <br><br>(__________________) | <br><br>(__________________) | <br><br>(__________________) |
