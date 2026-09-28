# Panduan M4 — Kas & Setoran

Semua uang tunai dari sopir, depot, dan toko **disetor ke kantor**, dihitung Admin Keuangan, lalu **kas ditutup setiap
hari** (batas 22.00 WIB). Angka **seharusnya** dihitung sistem dari data lapangan yang sudah tersinkron — tidak diketik
dan tidak dapat diubah. Di kantor, menu **Kas & setoran**: Kas hari ini · Setoran · Selisih · Transfer masuk · Kas
kantor & setor bank · Kas kecil · Tutup kas · Ganti rugi. Angka ambang di bawah adalah nilai bawaan parameter (dapat
diubah pemilik).

---

## Sopir, operator depot, kasir toko (lapangan) — 1 halaman

- **Setor.** Sopir: menu **Setor** di aplikasi sopir setelah rit terakhir. Depot/toko: **Tutup shift** lalu serahkan
  uang ke kantor (atau **setor bank dengan slip** — foto slip wajib). Pengeluaran rit (BBM, tol, parkir) dicatat dengan
  **foto nota**; Admin Keuangan menerima atau menolaknya satu per satu.
- **Hasil setoran** dikirim ke aplikasi Anda (notifikasi & riwayat setoran) setelah diterima kantor: jumlah diterima,
  **selisih**, alasannya, dan keputusan pemilik bila ada. Selisih lebih disetor penuh — tidak ada pengembalian.
- **Rit besok terkunci** sampai setoran hari ini **Ditutup** kantor. Selisih kurang yang sangat besar dapat mengunci
  rit sampai pemilik memutuskan (bila aturan itu diaktifkan pemilik). Bila kantor meminta, sopir dapat melanjutkan rit
  setelah setoran **dibuka kembali**, lalu **Setor** lagi.
- **Ganti rugi.** Bila pemilik menolak penjelasan selisih kurang dan ganti rugi sudah diberlakukan, jumlahnya
  tercatat per kejadian. Saldo Anda terlihat di aplikasi (kartu **Setoran & ganti rugi saya**). Pelunasan: setor
  tunai ke Admin Keuangan atau potongan gaji — **sistem tidak memotong gaji**, penggajian yang memutuskan.
- Setoran Anda **tidak dapat diterima oleh Anda sendiri**. Antrean data yang belum terkirim menahan penerimaan —
  pastikan status aplikasi **Semua terkirim** sebelum setor.

---

## Admin Keuangan (kantor)

**Kas hari ini** — satu baris per sumber (sopir bertugas, 10 depot, toko, kas kantor): seharusnya, status setoran,
diterima, selisih, alasan. Transfer belum dicocokkan & QRIS di kolom terpisah (bukan kas fisik). **Sorotan**: sopir
belum setor > 1 jam setelah rit terakhir Selesai, setoran depot/toko > 1 hari sejak tutup shift, kas outlet > Rp 2
juta. Pilih **Tanggal (riwayat)** untuk hari lain; **Excel/PDF** untuk ekspor.

**Setoran** → **Menunggu diterima** → klik nomor setoran:
1. Periksa **Seharusnya per rit & pelunasan tunai** (sopir) atau ringkasan shift (depot/toko).
2. **Verifikasi pengeluaran rit**: pilih **Terima** / **Tolak** (alasan wajib) untuk setiap pengeluaran. Pengeluaran
   dari kas yang diterima mengurangi seharusnya; uang pribadi yang diterima **diganti dari kas kantor**.
3. Hitung uang, isi **Jumlah fisik diterima** (atau centang **Isi rincian pecahan**). Kotak hitung menampilkan
   **Selisih = diterima − (seharusnya − pengeluaran diterima)**.
4. Selisih ≠ 0 → **Alasan selisih** dari daftar (**Lainnya** wajib keterangan; foto uang rusak/palsu opsional).
   Selisih **≥ Rp 50.000** otomatis **diteruskan ke pemilik** (keputusan ≤ 24 jam) — setoran **tetap Ditutup**, tidak
   menunggu keputusan. Di bawah ambang: Anda yang menutup dengan alasan (pemilik dapat membukanya kembali ≤ 7 hari).
5. Diterima setelah 22.00 atau hari berikutnya → **Alasan terlambat** wajib.
6. **Terima setoran** (biarkan **Tutup setoran sekaligus** tercentang agar rit sopir besok terbuka).

Tidak dapat menerima bila: perangkat penyetor masih punya data belum terkirim (**Menunggu sinkron**), pengeluaran
belum diputuskan, atau setoran itu milik Anda sendiri. **Setor bank dengan slip** (depot/toko) diterima otomatis
setelah mutasi bank cocok di **Transfer masuk**. Sopir yang belum selesai → **Buka kembali** (alasan wajib).

**Selisih** — tab **Terbuka**: umur tiap selisih; lewat 24 jam tampil paling atas (KPI-03). **Jelaskan selisih** /
**Perbarui penjelasan** (alasan + penjelasan). Selisih yang **ditolak pemilik** dikembalikan ke Anda → bicarakan
dengan karyawan → **Selesaikan tindak lanjut** (catatan). Tab **Riwayat per karyawan**: kejadian, kurang/lebih,
alasan per bulan, deret hari tanpa selisih.

**Transfer masuk** — transfer yang dicatat lapangan (pembayaran rit, pelunasan lewat sopir, QRIS per shift, setor
bank slip, pelunasan kantor). **Cocokkan manual**: tanggal, jumlah, keterangan mutasi internet banking → **Cocok**.
Tab **Impor & mutasi bank**: pilih rekening, unggah **CSV/Excel** mutasi → **Usulan pasangan** (jumlah sama, tanggal ±
1 hari) → centang → **Konfirmasi pasangan terpilih**. Impor ulang berkas yang sama tidak menggandakan baris. **Mutasi
tanpa pasangan** → **Tandai** (tindak lanjut/abaikan + catatan). Transfer tanpa mutasi > 2 hari → **Tidak ditemukan**
(pemilik & Anda diberi tahu) → tindak lanjuti ke pelanggan/penyetor.

**Kas kantor & setor bank** — saldo awal + setoran diterima − setor ke bank − kas kecil − penggantian pengeluaran rit
± lainnya. **Setor ke bank**: rekening PT, jumlah, tanggal, **foto slip** → **Catat setor ke bank** (dicocokkan dengan
mutasi). Salah catat → **Balik** (alasan; > Rp 500.000 perlu persetujuan pemilik). **Rekening bank PT**: tambah /
**Nonaktifkan** (tidak dihapus). **Saldo awal** kas kantor sekali saat mulai memakai sistem.

**Kas kecil** — **Pengisian** (mengurangi kas kantor) atau **Pengeluaran** (kategori, pusat laba, foto bukti). Di atas
**Rp 500.000** menunggu persetujuan pemilik (belum berlaku sebelum disetujui). **Hitung fisik** mingguan: isi uang
fisik; beda → alasan → masuk alur Selisih dan saldo disesuaikan.

**Tutup kas** (sebelum 22.00):
1. **Mulai tutup kas** — waktu tercatat; penyetor yang belum setor diberi tahu.
2. Selesaikan **Penghalang**: setoran sopir/shift belum diterima (tombol **Telepon/WhatsApp**), shift belum ditutup,
   rit masih berjalan, hari sebelumnya belum ditutup. Setoran yang memang tertunda (mis. sopir sakit) → **Ajukan
   pengecualian** (pemilik memutuskan, per kejadian, maks. 1 hari); uangnya wajib diterima ≤ 24 jam — lewat itu
   otomatis menjadi selisih.
3. Periksa **Selisih hari ini** & **Transfer belum dicocokkan**.
4. **Hitung fisik kas kantor** → beda dari sistem → alasan → **Tutup kas**. Ringkasan H+0 terbit untuk pemilik.

Hari yang ditutup **terkunci**: kas kantor, setor bank, dan kas kecil tanggal itu tidak dapat diubah. Uang yang datang
setelah kas ditutup (setoran tertunda, transaksi terlambat sinkron) masuk **kas hari berikutnya** dan ditandai.

**Ganti rugi** — daftar per kejadian (karyawan, tanggal, jumlah, setoran/rit, alasan). **Catat pelunasan**: **Setor
tunai** (kas kantor bertambah) atau **Potongan penggajian** (konfirmasi). Salah catat → **Balik** (alasan). Tab
**Rekap bulanan (penggajian)** → Excel/PDF untuk bagian penggajian.

## Pemilik

- **Selisih ≥ ambang**: dari kotak **Persetujuan** atau menu **Selisih** → **Setujui** (satu ketuk; dibebankan ke
  pusat laba sumbernya) atau **Tolak** (alasan wajib; dikembalikan ke Admin Keuangan, dan bila ganti rugi aktif →
  ganti rugi karyawan). Tenggat 24 jam; lewat tenggat tetap terbuka dan dihitung KPI-03.
- **Buka kembali** selisih kecil yang ditutup Admin Keuangan (≤ 7 hari), lalu putuskan.
- Setujui **kas kecil** > Rp 500.000, **pengecualian tutup kas** (setoran tertunda), dan **koreksi** setor bank /
  pelunasan ganti rugi > Rp 500.000.
- **Ganti rugi aktif**: di menu **Ganti rugi**, aktifkan setelah Peraturan Perusahaan berlaku (alasan wajib, tercatat
  di jejak audit; Admin Keuangan diberi tahu). Sebelum aktif, selisih yang ditolak tercatat tanpa beban ganti rugi.
- Semua layar kas dapat dibuka dan diekspor (Excel/PDF); pemilik **tidak** menerima setoran (pemisahan tugas).

## Akuntan

Baca & ekspor: kas hari ini, setoran, selisih, transfer & hasil pencocokan harian (masukan rekonsiliasi bank bulanan),
kas kantor, setor bank, kas kecil, riwayat tutup kas, rekap ganti rugi.
