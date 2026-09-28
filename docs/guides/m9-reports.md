# Panduan M9 — Laporan & Dashboard Pemilik

M9 **tidak meminta Anda mengetik apa pun** (kecuali KPI-10 dan lembar pencocokan periode paralel): semua angka diambil
dari data sopir, depot, toko, kas, piutang, produksi, GPS, dan akuntansi yang sudah tercatat — dengan **satu definisi**
yang sama di H+0, laporan bulanan, tren, kinerja, dan KPI. Menu **Laporan**: Hari ini (H+0) · Laba kotor bulanan ·
Katalog laporan · Kinerja sopir & depot · Tren · KPI program · Periode paralel; plus **Kotak masuk** di menu utama.
Semua layar terbaca di ponsel (tabel lebar bergulir di dalam kartunya, bukan halamannya).

---

## Pemilik

### Hari ini (H+0) — setiap malam
Buka **Laporan → Hari ini (H+0)** (atau ubin **Omzet luar hari ini** di Beranda). Enam blok:

1. **Omzet per lini** — L2 air truk (rit pelanggan Selesai), L3 depot, L4 toko, dan **omzet luar**. Pasokan air truk
   ke depot (transfer internal) tampil **terpisah** dan tidak dihitung sebagai omzet luar.
2. **Kas seharusnya vs diterima vs selisih** per sumber (sopir, depot, toko, kas kantor) + transfer belum dicocokkan.
3. **Piutang** — saldo, terbentuk hari ini, dilunasi, **% lewat tempo (KPI-04)** terhadap sasaran.
4. **Rit per truk** — terjadwal, Selesai, Gagal, berjalan; rit internal dipisah.
5. **Galon per depot** — galon, liter, transaksi, penjualan.
6. **Pengecualian** — selisih yang menunggu Anda (tombol **Setujui** / **Tolak** — alasan wajib bila menolak),
   persetujuan menunggu, rit gagal, kejadian GPS, susut air.

**Status di atas halaman:**
- *Belum ditutup — angka dapat berubah* (garis putus-putus): kas hari itu belum ditutup Admin Keuangan.
- *H+0 terbit* dengan cap waktu **Kas ditutup … · H+0 terbit … (N menit)** — versi terbit **terkunci** dan Anda
  mendapat notifikasi (≤ 30 menit setelah tutup kas). Bila tutup kas terlambat, H+0 tetap terbit dengan penanda
  **Terbit terlambat** — tidak ada H+0 manual.
- **Tandai sudah ditinjau** setelah Anda membacanya.

**Ketuk angka untuk rinciannya** tanpa pindah menu: nomor truk → daftar rit; kode depot → shift; *Rincian setoran* →
setoran & selisih; *Per pelanggan* → piutang per pelanggan. **Tutup rincian** untuk kembali.

**Rentang:** Hari ini · Kemarin · 7 hari · Bulan berjalan, atau pilih **Riwayat per tanggal**. Definisi angkanya sama.

**Catatan tambahan setelah terbit:** transaksi yang terlambat sinkron atau dikoreksi setelah H+0 terbit **tidak mengubah
angka yang sudah terbit** — tampil sebagai catatan bertanda *Terlambat sinkron* / *Koreksi* pada tanggal asalnya, dan
koreksi yang dicatat hari ini atas hari lain tampil dengan tautan ke H+0 hari asal.

### Kotak masuk
**Kotak masuk** mengumpulkan semua yang menunggu keputusan Anda, dikelompokkan: **Persetujuan menunggu**, **Selisih
setoran ≥ ambang**, **Rit gagal**, **Anomali GPS**, **Susut air**. Tindakan langsung dari daftar:
**Setujui** · **Tolak** (alasan wajib) · **Minta keterangan** (penerima mendapat notifikasi berisi pertanyaan Anda).
Butir **lewat tenggat** naik ke atas dan bertanda merah; selisih yang lewat 24 jam dihitung **KPI-03**. Bagian **Info**
berisi notifikasi lain — **Tandai selesai** (notifikasi tidak dapat dihapus).
Atur jenis notifikasi (seketika / ringkasan harian / mati; peristiwa kritis selalu seketika) dan jam tenang di
**Pengaturan notifikasi**.

### Laba kotor bulanan
Pilih **Bulan** (bawaan: bulan lalu). Per lini **L1–L5** (L5 kosong sampai Tahap 3): omzet, biaya langsung, laba kotor,
marjin; baris **Eliminasi transfer internal** dan **Konsolidasi** (laba gabungan tidak dihitung ganda).
- Status **Sementara** sampai periode akuntansi **Dikunci**, lalu **Final** (Anda diberi notifikasi). Tenggat tampil
  "Tersedia paling lambat tanggal 10" (KPI-09). Setelah Final, perubahan hanya lewat jurnal periode berikutnya; versi
  Final lama tetap tersimpan (revisi baru bila periode dibuka & dikunci ulang).
- Selama akuntansi (M11) belum aktif: omzet per lini + biaya yang sudah tercatat (pengeluaran rit, pembelian toko)
  berlabel **Belum lengkap — M11 belum aktif**.
- Ketuk lini → akun → jurnal & **transaksi sumber** (rit, shift, nota pembelian, jurnal manual).
- **Pembanding** bulan lalu & bulan yang sama tahun lalu; **Biaya produksi air per liter** (per sumber & gabungan,
  tren); **Omzet bruto & pemantauan PKP** (12 bulan berjalan vs batas PKP, peringatan 80%/90%).
- **Excel/PDF**: laporan **Final** menghasilkan berkas **identik** setiap kali diunduh ulang.

### Kinerja sopir & depot (hanya pemilik)
Tab **Sopir & truk**: rit terjadwal/Selesai/Gagal per alasan, **tepat waktu** (Selesai ± 60 menit dari jam diminta),
volume parsial, lokasi > 200 m / > 1 km, kejadian BR-25 & keterangannya, selisih setoran, setoran terlambat, jarak
tempuh, pengeluaran rit, **hari tanpa selisih** (dasar insentif nihil selisih). Tab **Depot/toko & operator**: galon per
hari, transaksi, void, selisih kas & stok, setoran terlambat, kas melebihi batas, pasokan diterima. Peringkat hanya
**antar peran yang sebanding** dan menampilkan zona/rute.

### Tren
**Mingguan** atau **Bulanan**, 13 periode terakhir: grafik & tabel omzet per lini, rit, galon, piutang (saldo & %
lewat tempo) dengan perubahan terhadap periode sebelumnya; rit per truk & galon per depot. Excel/PDF tersedia.

### KPI program
Sebelas KPI (KPI-01–KPI-11): cara ukur, nilai bulan, target, status (**Tercapai / Belum tercapai / Baseline /
Menunggu / Belum ada data**) dan riwayat bulanan sejak pilot. **KPI-10**: isi **jam per minggu** dari catatan Anda
(mis. `6,5`) lalu **Simpan jam** — dapat diperbaiki kemudian. **PDF** untuk rapat komite pengarah.

### Periode paralel — persetujuan
Pengajuan **tarik nota kertas lebih awal** (sebelum hari ke-14) masuk **Kotak masuk → Persetujuan menunggu** setelah
syarat PAR-84 terpenuhi (5 hari operasi terakhir 100% tercatat di sumber, 0 selisih tak terjelaskan). Setujui → nota
kertas unit itu ditarik pada tanggal yang diajukan.

---

## Admin Keuangan
- **Hari ini (H+0)** dan **Kotak masuk** dapat dibuka (tanpa tombol keputusan selisih — keputusan milik pemilik).
- **Laba kotor bulanan** dan **Katalog laporan**: unduh Excel/PDF. Laporan berisi data pribadi pelanggan (mis. daftar
  pesanan) meminta **Tujuan ekspor** — tercatat di log ekspor (BR-39).
- **Periode paralel**: setiap hari isi **Lembar pencocokan harian** per unit (jumlah & nilai nota kertas; angka sistem
  dihitung otomatis). Bila berbeda: pilih **Terjelaskan / Tak terjelaskan** dan tulis **penyebab** (wajib). Koreksi
  lembar menimpa baris hari itu dan tercatat di jejak audit. **Mulai periode paralel unit** saat unit baru mulai memakai
  sistem. Di **Tarik nota kertas / perpanjang**: catat tanggal nota kertas ditarik (hari ke-14 atau sesudahnya langsung
  tercatat; lebih awal = diajukan ke pemilik) atau **Perpanjang** (hanya atas keputusan komite pengarah, maks 1 minggu).

## Akuntan
**Laba kotor bulanan** (baca-saja) dan unduhannya; versi Final identik saat diunduh ulang. Ekspor jurnal format
konsultan ada di menu Akuntansi (M11) dengan log ekspor yang sama.

## Dispatcher
**Katalog laporan** untuk laporan operasional (pesanan, rit terealisasi vs terjadwal, GPS). Unduhan laporan berisi
data pribadi pelanggan untuk Dispatcher otomatis **tanpa nomor WA & alamat lengkap**.

## Admin sistem (manajer proyek)
**Periode paralel** sama seperti Admin Keuangan; KPI-11 (adopsi lapangan) dihitung otomatis dari pengguna aktif per
peran dan tanggal nota kertas ditarik per unit.
