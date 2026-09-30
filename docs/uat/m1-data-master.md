# UAT M1 — Master Data

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Pemilik |
| Skenario BRD | P-01 langkah 1; migrasi BRD 10.3 |
| User story diuji (PRD 11.3) | US-M1-01 s.d. US-M1-06 (semua M) |
| Data uji | 300 pelanggan hasil impor uji (template Master > Impor, data disamarkan — NFR-27); zona tarif & harga nyata dari pemilik (K23) |
| Akun uji | Dispatcher (`dispatcher1`), Admin Keuangan (`keuangan1`), pemilik (`pemilik`), admin sistem (`admin1`) |
| Panduan pengguna | `docs/guides/m1-master.md` |
| Jumlah | 6 user story · 36 KP |

## Persiapan

- [ ] Lingkungan uji (Preview + branch Neon) dengan `pnpm db:migrate && pnpm db:seed:prod`, atau gladi dengan data demo `pnpm db:seed`.
- [ ] Berkas impor uji 300 pelanggan (beberapa duplikat & baris salah disengaja) dan daftar tarif zona dari pemilik.
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M1-01 Mengelola pelanggan dan alamat kirim — M

**Layar:** Data master › Pelanggan (`/master/pelanggan`, `/master/pelanggan/[id]`)  
**Rujukan PRD:** baris 491

**Langkah uji:**
1. Dispatcher: *Pelanggan baru* — isi nama, segmen, WA, satu alamat dengan koordinat (klik peta) dan satu tanpa koordinat.
2. Simpan pelanggan kedua dengan WA sama → kandidat duplikat tampil, tidak memblokir.
3. Coba *Ajukan Tempo* pada pelanggan baru (tidak aktif) dan pada pelanggan memenuhi PAR-11; ajukan harga khusus → pemilik memutuskan di Persetujuan.
4. Coba nonaktifkan pelanggan berpiutang (ditolak) lalu yang bersih (berhasil, beralasan); periksa Jejak audit.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Bidang wajib: nama, segmen (depot pihak ketiga, rumah tangga, perumahan, industri, proyek konstruksi, hotel, kolam renang — BRD 1.1), nomor WA (validasi format Indonesia), minimal satu alamat kirim. Bidang lain: nama kontak, catatan khusus (akses lokasi, jam terima tetap), penanda "tagihan bulanan" (BR-05; hanya bila perjanjian tertulis terlampir). | ☐ | ☐ |  |
| 2 | Alamat kirim memuat label, teks alamat, koordinat, dan catatan. Koordinat dapat diisi dari peta atau dibiarkan kosong dengan status "Belum dikunci"; sistem menawarkan kunci koordinat dari lokasi "Selesai" rit pertama, yang dikonfirmasi Dispatcher (BRD 10.2). Alamat berkoordinat otomatis dipetakan ke satu zona (US-M1-05); tanpa koordinat, Dispatcher memilih zona manual dan alamat ditandai "Zona manual" sampai dikunci. | ☐ | ☐ |  |
| 3 | Status kredit pelanggan baru = Tunai (BR-01) dan tidak dapat diubah Dispatcher. Tombol "Ajukan Tempo" hanya aktif bila pelanggan memenuhi PAR-11 (≥ 3 bulan sejak pesanan Selesai pertama **atau** ≥ 10 pesanan Selesai) **dan** syarat "tanpa masalah" PAR-82 (dalam periode itu: tidak ada kurang bayar lewat 7 hari, tidak ada transfer "Tidak ditemukan", tidak ada sengketa yang ditolak, dan paling banyak 1 rit gagal karena pelanggan menolak); persetujuan pemilik tetap wajib (6.2a). Tidak ada pengesampingan syarat selain status "Tempo migrasi" (US-M1-06 KP-6); bila pemilik menginginkan pengecualian lain, jalurnya CR atas BR-01 (CR-12). | ☐ | ☐ |  |
| 4 | Batas kredit terisi otomatis dari segmen (BR-04) dan hanya dapat diubah pemilik dengan alasan; rumah tangga tetap tunai tanpa pengecualian ("tunai saja", BR-04; ditegaskan di CR-12); tempo standar 14 hari (BR-02) dengan pengecualian per pelanggan oleh pemilik. | ☐ | ☐ |  |
| 5 | Harga khusus: per pelanggan per produk, dengan alasan, tanggal mulai, dan tanggal tinjauan otomatis 6 bulan (BR-16); berlaku hanya setelah persetujuan pemilik; harga khusus yang lewat tanggal tinjauan tetap berlaku tetapi tampil pada daftar tinjauan pemilik. | ☐ | ☐ |  |
| 6 | Penanda "mitra toko" (BR-18) terpasang otomatis untuk segmen depot pihak ketiga yang aktif (minimal satu pesanan Selesai dalam 90 hari terakhir [USULAN]) dan manual untuk mitra depot EQUA; penanda ini dipakai M7. | ☐ | ☐ |  |
| 7 | Saat menyimpan, sistem memeriksa duplikat: nomor WA sama, atau nama dan alamat mirip; menampilkan kandidat dan meminta konfirmasi, tidak memblokir. | ☐ | ☐ |  |
| 8 | Pelanggan tidak dapat dihapus; dinonaktifkan dengan alasan; tidak dapat dinonaktifkan bila masih ada piutang terbuka atau pesanan aktif. | ☐ | ☐ |  |
| 9 | Layar pelanggan menampilkan ringkasan: piutang terbuka, batas tersisa (BR-06), 10 pesanan terakhir, rata-rata jarak antar pesanan, catatan khusus (FR-M2-08). | ☐ | ☐ |  |
| 10 | Semua perubahan berjejak audit (Bab 6.7). | ☐ | ☐ |  |

### US-M1-02 Mengelola produk dan harga tiga lini — M

**Layar:** Data master › Produk & harga (`/master/produk`)  
**Rujukan PRD:** baris 506

**Langkah uji:**
1. Admin Keuangan menginput harga baru bertanggal berlaku besok → pemilik menyetujui; pemilik menginput harga sendiri (keputusan langsung, alasan wajib).
2. Buat pesanan untuk tanggal sebelum & sesudah tanggal berlaku → harga mengikuti tanggal; ubah harga saat pesanan sudah terkunci → Dispatcher diberi peringatan.
3. Nonaktifkan satu produk → hilang dari POS/pesanan, tetap di riwayat.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Tiga kelompok produk dengan atribut berbeda: **air truk** (harga per rit = tarif zona alamat kirim + komponen BBM); **produk depot** (isi ulang, galon baru, tutup, tisu, cuci galon, dan lainnya; harga tunggal per tenant); **barang toko** (harga umum dan harga mitra, satuan, stok minimum — dikelola di M7 dengan aturan persetujuan yang sama). | ☐ | ☐ |  |
| 2 | Komponen BBM adalah satu nilai rupiah per rit yang ditetapkan pemilik dengan tanggal berlaku dan berlaku untuk seluruh zona [ASUMSI-PRD PTB-03]. | ☐ | ☐ |  |
| 3 | Setiap harga memiliki tanggal mulai berlaku. Jalur baku: Admin Keuangan menginput harga baru dan harga aktif setelah disetujui pemilik (6.2a, BR-15). Bila pemilik menginput sendiri, perubahan tercatat sebagai keputusan langsung pemilik (6.2b) tanpa langkah persetujuan, dengan alasan dan tanggal berlaku wajib, serta diberitahukan ke Admin Keuangan dan Dispatcher. Riwayat harga dapat dilihat dan tidak dapat dihapus. | ☐ | ☐ |  |
| 4 | Transaksi mengambil harga yang berlaku pada tanggal transaksi. Untuk pesanan truk, harga dikunci saat pesanan dibuat; bila harga berubah sebelum tanggal kirim, Dispatcher diberi peringatan dan dapat memperbarui harga dengan konfirmasi ke pelanggan [USULAN PTB-13]. | ☐ | ☐ |  |
| 5 | Produk "air truk — transfer internal" untuk pasokan ke depot sendiri memakai tarif zona alamat depot pada segmen depot pihak ketiga (BR-33, K20), tanpa pembayaran. | ☐ | ☐ |  |
| 6 | Produk dinonaktifkan, bukan dihapus; produk nonaktif tidak muncul di POS/pesanan tetapi tetap tampil di riwayat. | ☐ | ☐ |  |

### US-M1-03 Mengelola armada, kru, dan perangkat — M

**Layar:** Data master › Armada & kru (`/master/armada`)  
**Rujukan PRD:** baris 517

**Langkah uji:**
1. Tambah/ubah truk (nopol, kapasitas, pool, perangkat GPS & ponsel, sopir & kernet default).
2. Coba jadikan satu sopir kru default dua truk (ditolak); ubah status truk ke Perbaikan → rit terjadwal ditandai perlu dipindah + notifikasi Dispatcher.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Truk: nopol, kapasitas (bawaan 5.000 L), status (Aktif/Perbaikan/Nonaktif), sopir dan kernet default, ID perangkat GPS terpasang, ID ponsel lapangan. | ☐ | ☐ |  |
| 2 | Truk berstatus Perbaikan/Nonaktif tidak dapat menerima rit; rit yang sudah ditugaskan ke truk yang berubah status ditandai untuk dipindahkan. | ☐ | ☐ |  |
| 3 | Kru: karyawan dengan peran Sopir/Kernet dan truk default; satu karyawan hanya satu truk default; pengecualian harian diatur di jadwal kru (US-M2-10). | ☐ | ☐ |  |
| 4 | Perangkat (ponsel, tablet, GPS) didaftarkan dengan pengenal unik, jenis, pemegang, dan status (Bab 5.2); pendaftaran dan pemblokiran oleh admin sistem (M10). | ☐ | ☐ |  |

### US-M1-04 Mengelola depot, sumber air, dan karyawan — M

**Layar:** Data master › Depot & toko, Sumber air, Pool/garasi, Karyawan  
**Rujukan PRD:** baris 526

**Langkah uji:**
1. Tambah depot (kode, koordinat, radius geofence, kapasitas, kas awal tetap) dan sumber air + meter dengan foto angka awal.
2. Tambah karyawan dengan tanggal keluar hari ini → akun nonaktif otomatis (cek Akses › Pengguna).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Depot: kode, nama, tenant (EQUA pada Tahap 1), koordinat dan radius geofence, operator default, kapasitas simpan (L), status. | ☐ | ☐ |  |
| 2 | Sumber air: nama, lokasi, kapasitas harian (50.000 L), koordinat dan radius geofence, daftar meter (pengenal, satuan, angka awal saat cut-over, foto). | ☐ | ☐ |  |
| 3 | Karyawan: nama, jabatan, lokasi tugas, peran sistem (BRD 4.2), tanggal masuk/keluar; pengaitan ke akun dilakukan di M10; tanggal keluar mencabut akses hari itu (BR-37). | ☐ | ☐ |  |
| 4 | Semua entitas dinonaktifkan, bukan dihapus. | ☐ | ☐ |  |

### US-M1-05 Mengelola zona tarif dan pemetaan alamat — M

**Layar:** Data master › Zona tarif (`/master/zona`)  
**Rujukan PRD:** baris 535

**Langkah uji:**
1. Isi tarif per zona & komponen BBM; jalankan *Simulasi* perubahan tarif sebelum disetujui pemilik.
2. Alamat berkoordinat terpetakan ke zona otomatis; alamat tanpa koordinat → zona manual beralasan; bandingkan jarak rit dengan zona (pemeriksaan zona).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Tabel zona: nama, batas jarak (km dari–sampai, tidak tumpang tindih, tanpa celah), tarif per rit, tanggal berlaku; tarif dapat dibedakan per segmen bila pemilik menetapkan, jika tidak berlaku satu tarif per zona [USULAN]. | ☐ | ☐ |  |
| 2 | Jarak dihitung dari **sumber air acuan** alamat tersebut; sumber acuan bawaan = sumber terdekat, dapat diubah Dispatcher dengan alasan [KEPUTUSAN PTB-02]. Basis jarak = jarak rute layanan peta (NFR-24), dengan garis lurus × 1,3 sebagai cadangan bila peta tidak tersedia [USULAN]. | ☐ | ☐ |  |
| 3 | Pemetaan alamat → zona otomatis saat koordinat tersedia; Dispatcher dapat menetapkan zona lain dengan alasan (alamat di batas zona), tercatat sebagai "Zona manual". | ☐ | ☐ |  |
| 4 | Perubahan tabel zona atau tarif tidak mengubah harga pesanan yang sudah dibuat (US-M1-02 KP-4); sistem menampilkan daftar alamat yang berpindah zona akibat perubahan batas untuk ditinjau pemilik. | ☐ | ☐ |  |
| 5 | Pada penerapan awal, sistem menampilkan simulasi harga zona baru vs harga yang berlaku saat ini per pelanggan (dari impor US-M1-06), agar zona benar-benar "diturunkan dari harga yang berlaku hari ini" (K23) dan R14 termitigasi. | ☐ | ☐ |  |
| 6 | Bila FR-M12-07 (S) tersedia, jarak GPS aktual per rit dibandingkan dengan zona alamat; penyimpangan ditampilkan ke pemilik, tidak mengubah harga otomatis. | ☐ | ☐ |  |

### US-M1-06 Mengimpor data awal dan membersihkan duplikat — M

**Layar:** Data master › Impor data awal (`/master/impor`), Tanda tangan data awal (`/master/tanda-tangan`)  
**Rujukan PRD:** baris 546

**Langkah uji:**
1. Unduh template, unggah 300 pelanggan mode **Uji** → laporan validasi (baris salah, duplikat); perbaiki/kecualikan/gabungkan.
2. Ulangi mode **Produksi** → *Masukkan data*; pelanggan tempo migrasi berstatus *Tempo migrasi*.
3. Pemilik menandatangani kelompok data *Pelanggan* (penyusun ≠ penanda tangan).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Template Excel untuk pelanggan (dengan banyak alamat), harga saat ini per pelanggan, armada, kru, karyawan, depot, sumber air; sistem menyediakan template dan contoh terisi. | ☐ | ☐ |  |
| 2 | Impor menghasilkan laporan validasi per baris: wajib kosong, format WA salah, segmen tidak dikenal, duplikat (WA sama / nama+alamat mirip) dengan usulan penggabungan; tidak ada baris masuk sebelum semua kesalahan diselesaikan atau dikecualikan dengan alasan. | ☐ | ☐ |  |
| 3 | Impor dapat dijalankan berulang di lingkungan uji, dan sekali di produksi dengan penandaan "data awal" yang tidak dapat diubah kecuali lewat koreksi berjejak. | ☐ | ☐ |  |
| 4 | Ringkasan hasil impor (jumlah per segmen, per zona, pelanggan tempo dan batasnya) ditandatangani pemilik di sistem sebelum go-live (NFR-34). | ☐ | ☐ |  |
| 5 | Koordinat yang kosong dilengkapi dari GPS sopir dalam 30 hari pertama (BRD 10.3); sistem menampilkan kemajuan (% alamat terkunci). | ☐ | ☐ |  |
| 6 | Pelanggan yang sudah bertempo sebelum cut-over (15–30 pelanggan, BRD 10.3) diimpor dengan status "Tempo migrasi" beserta batas dan tempo yang disepakati; daftar ini ikut ditandatangani pemilik dalam ringkasan data awal (KP-4, NFR-34) dan menjadi satu-satunya pengecualian syarat BR-01 (US-M1-01 KP-3; CR-12). Masa transisi PAR-41 berlaku bagi mereka. | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| B-14 | Cari pelanggan ≤ 1 detik pada volume nyata (300+ pelanggan) — ukur 10 pencarian nama/WA/alamat dengan stopwatch. | ☐ | ☐ |  |
| NFR-27 | Impor data awal diuji di lingkungan uji dengan data tersamar (`pnpm db:mask`) sebelum impor produksi (US-M1-06 KP-3). | ☐ | ☐ |  |
| NFR-34 | Kelompok data pelanggan, tarif & harga, armada & kru, depot & sumber air berstatus *Ditandatangani* sebelum TG-7. | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M1 Master Data**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Pemilik — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-01 langkah 1; migrasi BRD 10.3 |
| Data uji | 300 pelanggan hasil impor uji (template Master > Impor, data disamarkan — NFR-27); zona tarif & harga nyata dari pemilik (K23) |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M1-01 |  | __ / __ |  |
| US-M1-02 |  | __ / __ |  |
| US-M1-03 |  | __ / __ |  |
| US-M1-04 |  | __ / __ |  |
| US-M1-05 |  | __ / __ |  |
| US-M1-06 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
