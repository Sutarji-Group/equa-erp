# Catatan Rilis EQUA ERP versi 1.0

**Tanggal rilis:** 30 September 2026 (versi 1.0.0 dan pembaruan 1.0.1) · **Untuk:** pemilik, Admin Keuangan,
Dispatcher, sopir & kernet, operator depot, kasir toko, operator produksi, akuntan, admin sistem, dan mitra depot.

Mulai versi ini, seluruh usaha EQUA — air truk, 10 depot isi ulang, toko, dan dua sumber air — dicatat di **satu
sistem**. Setiap transaksi dicatat sekali oleh orang yang mengerjakannya, di tempat kejadian, lalu otomatis masuk ke kas,
piutang, laporan, dan pembukuan. Pemilik dapat melihat ringkasan hari itu (**H+0**) paling lambat 30 menit setelah kas
ditutup, dari ponsel.

---

## Pembaruan 1.0.1 (30 September 2026)

Pembaruan kecil setelah uji beban dengan volume tiga kali lipat. **Cara kerja tidak berubah** dan tidak ada data yang
perlu diisi ulang. Aplikasi di ponsel dan tablet memperbarui dirinya sendiri saat dibuka dan terhubung internet.

### Sopir & kernet, operator produksi, operator depot, kasir toko
- **Lebih hemat kuota data.** Foto bukti kirim dan foto nota kini diperkecil sampai paling besar 150 KB — tetap jelas
  terbaca. Perkiraan pemakaian data ponsel truk turun dari ±81 MB menjadi ±40 MB per bulan, tablet POS dari ±140 MB
  menjadi ±13 MB per bulan. Angka nyata diukur selama pilot.
- Saat tidak ada yang perlu dikirim, aplikasi memeriksa data baru **tiap 5 menit**, dan langsung saat aplikasi dibuka
  kembali, setelah masuk dengan PIN, atau saat sinyal kembali. Transaksi baru tetap **langsung dikirim**; tombol
  **Kirim sekarang** tetap ada.
- Hanya data yang berubah yang diunduh. Koreksi dari kantor atas rit atau transaksi Anda tetap sampai ke aplikasi.

### Pemilik
- Batas ukuran foto (**PAR-38**) kini bawaannya **150 KB** dan dapat diubah di **Pengaturan › Parameter** tanpa
  menunggu tim IT. Bila di pilot pemakaian data sopir masih di atas 40 MB per bulan, batas ini dapat diturunkan
  (mis. 120 KB).
- **Laporan H+0 untuk rentang sebulan** tampil sekitar dua kali lebih cepat. Isi laporan tidak berubah.

### Admin Keuangan & akuntan
- **Nomor jurnal kini 6 angka** di belakang (contoh `J-2610-001235`), cukup untuk 999.999 jurnal per bulan. Nomor
  lama tidak berubah; di bulan peralihan buku besar dan daftar jurnal tetap urut sesuai urutan terbit (nomor
  `J-2610-01234` diikuti `J-2610-001235`).

### Admin sistem (tim IT)
- Tidak ada perubahan basis data. Setelah deploy, jalankan sekali `pnpm db:seed:prod -- --no-accounts` agar batas foto
  150 KB berlaku (nilai yang sudah diubah pemilik tidak disentuh) — rincian di [`CHANGELOG.md`](../CHANGELOG.md).
- Ponsel dan tablet versi 1.0.0 tetap dapat sinkron; versi minimal aplikasi tidak perlu dinaikkan. Pantau kolom
  **Versi** di **Akses › Perangkat & sinkron** sampai semua perangkat memakai 1.0.1.

---

## Yang berubah untuk Anda

### Pemilik
- **Laporan H+0** setiap malam: penjualan per lini, rit, kas, setoran, selisih, piutang jatuh tempo — dapat dibuka
  di ponsel.
- **Kotak masuk**: semua yang perlu keputusan Anda di satu tempat — persetujuan pesanan tempo, void besar, selisih
  setoran Rp 50.000 atau lebih, jurnal manual besar, permintaan akses.
- **Laporan bulanan** laba kotor per lini (air truk, depot, toko) dan gabungan, KPI program, tren, kinerja sopir/truk/
  depot, neraca air. Semua dapat diunduh Excel atau PDF.
- **Peta truk** real-time dan riwayat perjalanan setiap rit.
- **Pengaturan › Parameter**: ambang dan aturan (batas selisih, batas void, jam tutup kas, dan lain-lain) diubah tanpa
  menunggu tim IT, dengan tanggal berlaku dan alasan. Bagian **Fitur bertahap** untuk menyalakan fitur tahap
  berikutnya bila sudah siap.
- Masuk web kantor memakai kata sandi **dan kode 2FA** dari aplikasi authenticator di ponsel.

### Admin Keuangan
- **Terima setoran** sopir, depot, dan toko dengan hitungan seharusnya dari sistem; selisih tercatat beralasan.
- **Transfer masuk**: catat dan cocokkan dengan mutasi bank (bisa unggah berkas mutasi).
- **Tutup kas** paling lambat pukul 22.00 → ringkasan H+0 terbit otomatis.
- **Piutang**: faktur terbentuk sendiri dari rit dan penjualan tempo, pelunasan dan alokasi, umur piutang, faktur
  bulanan (terbit tanggal 1, jatuh tempo tanggal 15), pengingat lewat WA, faktur dan pernyataan lewat e-mail.
- **Akuntansi**: jurnal otomatis dari semua transaksi, jurnal manual berlampiran, laporan keuangan, aset tetap,
  rekonsiliasi bank, pajak.

### Dispatcher
- **Pesanan baru di bawah 60 detik**: cari pelanggan, alamat, zona dan harga otomatis; peringatan pesanan dobel dan
  batas kredit.
- **Papan jadwal rit** harian dengan truk dan kru, pengemudi pengganti, peta posisi truk, dan kendala dari sopir.
- Konfirmasi pesanan ke pelanggan lewat WA dengan satu ketuk.

### Sopir & kernet — aplikasi di ponsel truk
- Daftar rit hari ini, tombol **Berangkat → Tiba → Selesai** (waktu dan lokasi tercatat sendiri), foto bukti kirim,
  catat pembayaran, kirim struk lewat WA, pelunasan piutang, rit gagal, pengeluaran rit, dan **Setor** di akhir hari.
- **Tetap bekerja tanpa sinyal.** Data tersimpan di ponsel dan terkirim sendiri saat sinyal kembali.
- Masuk dengan **PIN 6 angka** di ponsel perusahaan yang sudah didaftarkan.
- Kartu panduan 1 halaman: [`guides/lapangan/sopir-kernet.md`](guides/lapangan/sopir-kernet.md).

### Operator depot — POS di tablet depot
- Buka shift, jual (tunai/QRIS), struk, void beralasan, terima pasokan air, stok bahan dan opname mingguan, tutup
  shift, setor. **Tetap bekerja tanpa sinyal.**
- Kartu panduan: [`guides/lapangan/operator-depot.md`](guides/lapangan/operator-depot.md).

### Kasir toko — POS di tablet toko
- Harga mitra dan umum otomatis, pindai barcode, penjualan tempo untuk mitra terdaftar, penerimaan barang dari
  pemasok, opname, transfer bahan ke depot, tutup shift dan setor.
- Kartu panduan: [`guides/lapangan/kasir-toko.md`](guides/lapangan/kasir-toko.md).

### Operator produksi — aplikasi di ponsel sumber air
- Catat angka meter pagi dan malam dengan foto, pengisian truk per rit, penjelasan susut, level tandon, hasil uji mutu.
  **Tetap bekerja tanpa sinyal.**
- Kartu panduan: [`guides/lapangan/operator-produksi.md`](guides/lapangan/operator-produksi.md).

### Akuntan
- Akses **baca-saja** ke akuntansi, laporan keuangan, dan jejak audit keuangan selama pendampingan.

### Admin sistem (tim IT)
- Kelola pengguna, peran, perangkat, PIN, dan kode aktivasi; pantau sinkron dan kesehatan perangkat; blokir dan hapus
  data perangkat hilang; jawab laporan kendala dari menu **Bantuan**.
- Panduan kerja: [`ops/runbook.md`](ops/runbook.md).

### Mitra depot (Paket Minimum Mitra)
- **Pemilik mitra** membuka portal `/mitra` (baca-saja): penjualan, pasokan air, tagihan, laporan bulanan.
- **Operator depot mitra** memakai POS yang sama dengan depot EQUA; data tiap mitra terpisah penuh.
- Tagihan langganan sistem bulanan dan permintaan dukungan teknis (dijawab ≤ 48 jam).

Daftar semua panduan per peran: [`guides/README.md`](guides/README.md).

---

## Aturan kerja yang perlu diingat

- **Tidak ada data yang dihapus.** Salah catat diperbaiki dengan transaksi koreksi yang beralasan; data lama tetap
  terlihat di jejak audit.
- **Sistem menolak** tindakan yang melanggar pemisahan tugas (misalnya orang yang menerima kas tidak boleh menyetujui
  selisihnya sendiri) — bukan hanya memberi peringatan.
- **Tutup kas paling lambat pukul 22.00.** Setoran diserahkan di hari yang sama.
- **Void di atas Rp 100.000** dan selisih setoran **Rp 50.000 atau lebih** masuk ke pemilik untuk diputuskan.
- Selama **periode paralel** (sampai 14 hari per unit), nota kertas tetap dipakai berdampingan dan dicocokkan setiap
  hari; nota kertas ditarik setelah 5 hari terakhir tercatat 100% tanpa selisih.
- Jam layanan sistem 05.00–22.00 WIB setiap hari. Pemeliharaan hanya pukul 23.30–04.30 WIB.

## Sebelum mulai (disiapkan bersama tim IT)

1. Ponsel perusahaan untuk setiap truk dan sumber air, tablet untuk setiap depot dan toko — didaftarkan dengan kode
   aktivasi.
2. Akun dan PIN setiap karyawan; pemilik, Admin Keuangan, dan admin sistem memasang aplikasi authenticator (2FA).
3. Pelatihan maksimal 2 jam per peran dengan kartu panduan 1 halaman.
4. Data awal (pelanggan, harga, armada, saldo piutang, stok, saldo akun) diimpor dan ditandatangani pemilik sebelum
   cut-over; akuntan meninjau pemetaan jurnal sebelum pemilik menekan **Aktifkan M11**.

## Yang belum aktif di versi ini

- **Aplikasi pelanggan** (pesan air lewat ponsel, pantau truk, bayar digital) sudah dibuat tetapi **belum dinyalakan**.
  Akan diaktifkan pemilik setelah syarat Tahap 2 terpenuhi, termasuk pengaburan wajah pada foto bukti kirim yang
  belum tersedia.
- **Portal kemitraan lengkap** (pendaftaran calon mitra, kontrak dan onboarding lengkap, pesanan dari portal, royalti,
  standar mutu, sanksi) sudah dibuat tetapi **belum dinyalakan**; dinyalakan per mitra setelah syarat Tahap 3
  terpenuhi.
- **Pesan galon antar** dari aplikasi pelanggan dan **printer struk bluetooth** tidak termasuk versi ini. Struk tetap
  dapat dicetak lewat menu cetak di tablet bila printer tersedia.
- Mitra dengan dua outlet dicatat sebagai dua kontrak (satu per outlet) dengan tagihan masing-masing; batas kredit
  gabungan antar-outlet belum tersedia.

## Butuh bantuan?

- Menu **Bantuan → Laporkan kendala** di web kantor dan di semua aplikasi lapangan (dijawab paling lambat 1 minggu;
  kendala yang menghentikan kerja ditangani segera).
- Lupa PIN atau PIN terkunci: hubungi admin sistem. Ponsel/tablet hilang: segera lapor ke admin sistem agar diblokir.
- Juara lapangan di unit Anda siap membantu selama pilot dan periode paralel.
