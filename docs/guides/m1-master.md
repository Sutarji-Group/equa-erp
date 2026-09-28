# Panduan Data master (M1)

Menu **Data master** di web kantor: Pelanggan, Produk & harga, Zona tarif, Armada & kru, Depot & toko, Sumber air,
Pool/garasi, Karyawan, Impor data awal, Tanda tangan data awal. Menu yang tampil mengikuti peran Anda.

Aturan umum:

- Data master **tidak pernah dihapus**. Yang tidak dipakai lagi dinonaktifkan dengan alasan; riwayat tetap ada.
- Setiap perubahan tercatat di jejak audit (siapa, kapan, sebelum/sesudah, alasan).
- Harga air truk = **tarif zona + komponen BBM** (atau harga khusus yang disetujui pemilik). Sopir dan dispatcher tidak
  mengetik harga.

## Dispatcher

### Menambah pelanggan (US-M1-01)

1. **Data master › Pelanggan › Pelanggan baru**.
2. Isi nama, segmen, nomor WA, dan minimal satu alamat kirim. Status kredit otomatis **Tunai**.
3. Koordinat: ketik lintang/bujur atau klik **Pilih titik di peta**. Zona dihitung otomatis dari jarak ke sumber air
   terdekat. Tanpa koordinat, alamat berstatus **Belum dikunci**; pilih zona manual dengan alasan bila perlu.
4. Bila muncul **Kandidat duplikat** (nomor WA sama atau nama & alamat mirip), buka kandidatnya. Jika memang pelanggan
   berbeda, centang konfirmasi lalu simpan lagi. Jika sama, pakai pelanggan yang sudah ada.

Di halaman pelanggan Anda dapat menambah alamat, mengunci koordinat, memilih sumber air acuan lain, dan mengajukan:

- **Status Tempo** (hanya bila syarat PAR-11 terpenuhi; rumah tangga selalu tunai) → diputuskan pemilik.
- **Perubahan batas/tempo** → diputuskan pemilik.
- **Harga khusus** (produk, harga, tanggal mulai) → diputuskan pemilik; ditinjau ulang tiap 6 bulan.

### Usulan koordinat dari sopir

Saat rit ke alamat Belum dikunci diselesaikan, lokasi Selesai menjadi **usulan koordinat**. Konfirmasi atau tolak di
**Pelanggan › Usulan koordinat menunggu**. Setelah dikonfirmasi alamat berstatus terkunci dan zonanya dihitung ulang.

### Menonaktifkan pelanggan

Ditolak bila masih ada piutang atau pesanan berjalan. Selesaikan dulu, lalu nonaktifkan dengan alasan.

### Armada & kru (US-M1-03)

- Truk: kode, nomor polisi, kapasitas, pool, perangkat GPS & ponsel lapangan, sopir & kernet default.
- Satu karyawan hanya menjadi kru default satu truk; sopir/kernet harus berperan sesuai.
- Status **Perbaikan** atau **Nonaktif**: rit terjadwal truk itu ditandai **perlu dipindah** dan Anda menerima
  notifikasi. Truk tersebut tidak dapat menerima rit baru.

### Impor data awal (US-M1-06)

1. **Data master › Impor data awal** › unduh **Template** (atau **Contoh** yang sudah terisi).
2. Isi lembar *Data* mulai baris 2. Pelanggan dengan beberapa alamat = beberapa baris dengan kode pelanggan sama.
3. Unggah berkas, pilih mode **Uji** (dapat diulang) atau **Produksi** (sekali per jenis; menandai "data awal").
4. Buka laporan validasi. Setiap baris **Salah** diperbaiki (**Perbaiki isi baris**) atau **dikecualikan** dengan alasan.
   Baris **Duplikat** diputuskan: **Gabungkan ke sini** (jadi alamat pelanggan yang ada) atau **Buat pelanggan baru**
   dengan alasan. Unduh laporan validasi (Excel) bila perlu dibagikan.
5. **Masukkan data** baru bisa ditekan bila tidak ada baris Salah/duplikat yang tersisa. Data keuangan (pelanggan dengan
   status/batas, harga per pelanggan) dimasukkan oleh Admin Keuangan; data non-keuangan (armada, kru, karyawan, depot,
   sumber air) oleh dispatcher/admin sistem.

## Admin Keuangan

- **Produk & harga / Zona tarif**: ajukan perubahan tarif zona per segmen, komponen BBM, atau harga produk dengan tanggal
  berlaku (paling cepat besok) dan alasan. Pemilik memutuskan; bila lewat tenggat, harga lama tetap berlaku.
- **Harga air truk tidak diubah di layar produk** — hanya lewat tarif zona + BBM.
- **Impor**: memasukkan batch pelanggan (status & batas kredit) dan harga saat ini per pelanggan.
- Anda menerima notifikasi bila pemilik menetapkan harga langsung atau menetapkan **Tempo migrasi** saat tanda tangan.

## Pemilik

- **Persetujuan**: status Tempo, batas/tempo, harga khusus, perubahan harga/zona (menu Persetujuan).
- **Zona tarif**: ubah batas zona (tabel) langsung atau tinjau usulan. Sebelum memutuskan, lihat **Alamat berpindah
  zona** dan **Simulasi harga zona vs harga berlaku per pelanggan** (memakai harga saat ini hasil impor). Keduanya dapat
  diunduh Excel/PDF. Perubahan berlaku pada tanggal berlaku (dini hari); Anda menerima daftar alamat yang berpindah.
- **Tinjauan harga khusus**: di halaman Pelanggan muncul daftar harga khusus yang lewat tanggal tinjauan — pilih
  **Pertahankan** (tinjau lagi 6 bulan) atau **Akhiri**.
- **Tanda tangan data awal**: tinjau ringkasan tiap kelompok (jumlah per segmen & zona, alamat terkunci, daftar Tempo
  migrasi & total batas, armada/karyawan, depot/sumber air) lalu **Tanda tangani ringkasan**. Untuk kelompok Pelanggan,
  tanda tangan menetapkan status **Tempo migrasi** pelanggan lama pada daftar. Kemajuan kunci koordinat 30 hari pertama
  ditampilkan di layar yang sama.

## Admin Sistem

- **Depot & toko**, **Sumber air** (meter + foto angka awal), **Pool/garasi**, **Karyawan** (nomor, jabatan, lokasi,
  peran rencana, tanggal masuk/keluar). Akun, PIN, dan peran efektif diatur di **Akses › Pengguna**.
- Tanggal keluar karyawan: pada tanggal itu karyawan dinonaktifkan otomatis, kru default truknya dilepas, dan akses
  dicabut (BR-37).
- Sumber air terakhir yang aktif tidak dapat dinonaktifkan (zona dihitung dari sumber air).

## Pertanyaan umum

- *Mengapa harga pesanan ditandai "sementara"?* Alamat belum memiliki zona (koordinat belum ada dan zona manual belum
  dipilih). Lengkapi koordinat atau pilih zona manual.
- *Pelanggan hasil impor tidak bisa diubah?* Bisa, tetapi sebagai **koreksi** dengan alasan (data awal berjejak).
- *Template ditolak "kolom wajib tidak ada"?* Jangan ubah judul kolom baris 1; unduh ulang template.
