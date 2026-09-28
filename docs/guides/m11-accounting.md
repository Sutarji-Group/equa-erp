# Panduan M11 — Akuntansi & Pajak

Menu **Akuntansi** di web kantor. Jurnal dibuat otomatis dari setiap transaksi lapangan (rit, POS, setoran, pembelian,
dsb.) — tutup buku hanya soal memeriksa, bukan mencatat. Semua angka dapat ditelusuri: laporan → buku besar → jurnal →
transaksi sumber, dan sebaliknya.

| Peran | Yang dikerjakan |
| --- | --- |
| Admin Keuangan | Bagan akun & pemetaan, jurnal manual berlampiran, daftar tunggu, rekonsiliasi, aset & penyusutan, alokasi biaya, saldo awal, tutup periode, pajak & ekspor konsultan |
| Pemilik | Menyetujui jurnal > Rp 5 juta dan pembalik > Rp 500.000, menandai daftar tinjauan jurnal manual, mengunci/membuka periode, menetapkan cut-over & kunci alokasi biaya bersama, menandatangani saldo awal & daftar aset, mengaktifkan jurnal otomatis |
| Akuntan (baca-saja) | Meninjau semua laporan & jurnal, memverifikasi jurnal retroaktif, mengesahkan saldo awal, mencatat tinjauan periode (bukti TG-8) |

## Admin Keuangan

### Setiap hari
1. **Akuntansi > Jurnal > Daftar tunggu**: harus kosong. Baris di sini = peristiwa yang belum bisa dijurnal (pemetaan
   belum ada / akun nonaktif). Perbaiki di **Pemetaan jurnal otomatis** — antrean peristiwa itu diproses ulang otomatis —
   atau tekan **Proses ulang**. Tidak ada peristiwa yang hilang.
2. **Jurnal > Rekonsiliasi harian**: jumlah & nilai jurnal rit, POS depot, toko, dan setoran per hari harus sama dengan
   ringkasan H+0. Baris "Selisih" menunjukkan peristiwa yang masih di daftar tunggu.

### Jurnal manual (gaji, sewa, listrik, BBM, pemeliharaan, biaya bank)
1. **Jurnal > Jurnal manual baru**, pilih template (akun terisi otomatis, dapat diubah).
2. Isi tanggal, keterangan, baris debit/kredit per pusat laba (L1 produksi air, L2 air truk, L3 depot per outlet,
   L4 toko, L5 kemitraan, Umum/kantor). Debit harus sama dengan kredit.
3. **Lampiran bukti (foto/PDF) wajib.** Centang **Ajukan/posting sekarang**:
   - ≤ Rp 5.000.000 → langsung terposting dan masuk **daftar tinjauan pemilik**.
   - > Rp 5.000.000 → diajukan ke pemilik (Persetujuan); terposting setelah disetujui.
4. **Gaji**: satu jurnal total per bulan dari rekap penggajian. Potongan ganti rugi dikredit ke *Utang gaji*; pelunasan
   ganti ruginya dicatat di Kas & Setoran > Ganti rugi (potongan penggajian).
5. **Akrual** (mis. listrik belum ditagih): centang *Jurnal akrual* — dibalik otomatis tanggal 1 bulan berikutnya.
6. **Utang manual**: isi *Utang kepada* & jatuh tempo (akun kredit harus akun utang). Pembayarannya: jurnal baru dengan
   *Jurnal ini membayar utang*.
7. Jurnal terposting tidak dapat diubah. Salah catat → buka jurnalnya → **Balik jurnal** + alasan (> Rp 500.000 lewat
   persetujuan pemilik). Jurnal otomatis tidak dapat dibalik dari sini — koreksi di modul sumbernya.
8. **Jurnal berulang** (Jurnal > Jurnal berulang): sewa (termasuk aset pribadi yang disewakan ke PT), listrik, dsb. Draf
   dibuat tiap bulan (tombol *Buat draf bulan ini* atau otomatis) dan tetap perlu lampiran & persetujuan.

### Aset tetap
- **Impor** daftar aset dari akuntan & notaris (CSV/Excel) → *Pratinjau* → *Simpan impor* → pemilik menandatangani.
  Aset baru disusutkan setelah ditandatangani.
- **Tambah aset** dari nota/jurnal manual. Aset milik pribadi yang disewakan ke PT **ditolak** — catat sewanya.
- Penyusutan diposting otomatis (tanggal 1 & saat tutup periode). Ubah umur/nilai atas keputusan akuntan di rincian aset
  → jurnal penyesuaian otomatis. **Lepas aset** menghitung laba/rugi pelepasan.

### Tutup buku bulanan (paling lambat tanggal 10)
1. **Rekonsiliasi bank & kas**: isi saldo rekening koran per rekening; item otomatis dari pencocokan harian (transfer
   belum dicocokkan, setoran dalam perjalanan) sudah terisi; tambahkan biaya/bunga bank (catat juga jurnal manualnya).
   Transfer "tidak ditemukan" harus diselesaikan dulu. Kas: isi saldo fisik; selisih wajib beralasan.
2. **Periode > [bulan]**: periksa prasyarat — setiap yang belum terpenuhi punya tautan **Kerjakan**:
   hari kas ditutup, rekonsiliasi nol, daftar tunggu kosong, penyusutan, jurnal > Rp 5 juta diputuskan, daftar tinjauan
   ditandai pemilik, opname toko, alokasi L1 & biaya bersama (tombol *Posting alokasi*).
3. **Tutup periode** → permintaan kunci terkirim ke pemilik. Tutup setelah tanggal 10 ditandai *Terlambat*.

### Pajak
- **Pajak**: omzet bruto bulanan per lini (transfer internal dikecualikan), estimasi PPh final (informasi), pemantauan
  batas PKP 12 bulan berjalan dengan proyeksi. Sistem tidak memungut PPN.
- **Ekspor konsultan**: unduh jurnal/buku besar/omzet memakai template. Format dapat diubah di *Ubah / tambah template
  ekspor* (kolom per baris `Judul=kolom`) tanpa rilis aplikasi.

### Saldo awal (sekali, saat cut-over)
Isi tiap kelompok (kas & bank, piutang, utang, persediaan, aset tetap, ekuitas) — usulan terisi dari data modul →
*Simpan draf* → pemilik menandatangani → akuntan mengesahkan → **Posting jurnal saldo awal**. Penyesuaian ≤ 3 bulan
setelah cut-over: *Ajukan penyesuaian* (catatan akuntan wajib, persetujuan pemilik).

## Pemilik
- **Persetujuan**: jurnal manual > Rp 5 juta, pembalik > Rp 500.000, kunci periode, penyesuaian saldo awal.
- **Jurnal > Tinjauan pemilik**: periksa jurnal ≤ Rp 5 juta lalu **Tandai ditinjau** — syarat tutup periode.
- **Periode**: **Kunci periode** setelah Admin Keuangan menutup (laporan *Final* tersimpan). **Buka kembali** hanya
  dengan alasan; akuntan diberi tahu; versi Final lama tetap tersimpan, versi baru bernomor revisi.
- **Pemetaan jurnal otomatis**: *Aktifkan M11* (ditolak bila masih ada pemetaan yang belum lengkap).
- **Saldo awal**: tetapkan tanggal cut-over (hanya tanggal 1) dan tandatangani tiap kelompok; **Aset tetap**:
  tandatangani daftar aset impor; **Periode > Kunci alokasi biaya bersama**: omzet / persentase tetap / tetap di bersama.

## Akuntan (baca-saja)
- **Laporan keuangan**: laba rugi per lini (alokasi L1 & biaya bersama terpisah, eliminasi transfer internal), neraca
  saldo, neraca, arus kas — per periode & kumulatif; ekspor Excel/PDF. Label *Sementara/Final/revisi/retroaktif*.
- Klik kode akun → buku besar → nomor jurnal → transaksi sumber.
- **Jurnal > Retroaktif**: *Verifikasi* jurnal yang dibangkitkan retroaktif sebelum periode pertama ditutup.
- **Saldo awal**: *Sahkan saldo awal* setelah semua kelompok ditandatangani pemilik.
- **Periode > [bulan] > Tinjauan akuntan**: simpan catatan tinjauan (bulan pertama setelah cut-over = bukti TG-8).
