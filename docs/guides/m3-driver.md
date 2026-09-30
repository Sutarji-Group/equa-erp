# Panduan Aplikasi Sopir (M3)

> **Kartu 1 halaman untuk dicetak (sopir & kernet, NFR-16):** [`lapangan/sopir-kernet.md`](lapangan/sopir-kernet.md). Indeks semua panduan: [`README.md`](README.md).

Aplikasi sopir dibuka dari ponsel truk (alamat **/sopir**, terpasang seperti aplikasi). Web kantor memakai menu
**Pesanan & jadwal → Dicatat kantor / Kendala sopir / Laporan sopir**. Semua angka (harga, kas, setoran) dihitung sistem.

## Sopir & kernet

**Masuk.** Pilih nama Anda → ketik PIN 6 angka. Ponsel terkunci sendiri bila tidak dipakai; ganti orang lewat
**Ganti pengguna**. Jangan meminjamkan PIN.

**Daftar rit (layar utama).** Rit hari ini urut rencana Dispatcher; rit berikutnya ditonjolkan, Selesai/Gagal turun ke
bawah. Ketuk rit untuk rincian: catatan khusus, telepon/WA pelanggan, **harga pesanan** (satu-satunya harga), faktur
terbuka, tombol **Navigasi** (membuka peta ponsel). Penanda **Diperbarui** = Dispatcher mengubah jadwal.

**Satu rit, 3 tombol:**

1. **Berangkat** — ketuk saat truk jalan. Waktu & lokasi tercatat sendiri. Hanya satu rit berjalan per truk.
2. **Tiba** — ketuk sesampai di lokasi pelanggan.
3. **Selesai & bayar** — 3 langkah:
   - *Bukti kirim*: foto dari kamera aplikasi (wajib), nama penerima, tanda tangan penerima (tidak bisa? pilih
     alasannya), volume (bawaan 5.000 L; beda → pilih alasan).
   - *Pembayaran* (tidak bisa dilewati): **Tunai** — isi uang yang benar-benar diterima (kurang → pilih alasan, jadi
     tagihan pelanggan); **Transfer** — foto bukti + jumlah; **Tempo** — hanya pesanan tempo atau tempo yang sudah
     disetujui Dispatcher (tombol **Pelanggan minta tempo?** saat Tiba).
   - *Simpan*: lokasi diambil otomatis. Jauh dari alamat → pilih alasan.
   Lalu **Kirim struk WA** ke pelanggan, atau lewati dengan alasan.

**Tidak jadi kirim?** Buka rit → **Rit gagal** → alasan + foto bila bisa + air yang sudah dimuat (dibawa ke rit
berikutnya / kembali ke sumber / dibongkar di depot). **Kendala** (truk rusak, jalan ditutup, kecelakaan) → pilih
jenis + keterangan; Dispatcher langsung diberi tahu.

**Pelunasan piutang.** Di rincian rit → **Terima pelunasan** → centang faktur (bawaan yang tertua) → tunai/transfer →
jumlah → simpan → kirim bukti pelunasan WA. Uang pelunasan tunai masuk kas di tangan.

**Pengeluaran (BBM, tol, parkir).** Menu **Setor → Catat pengeluaran** → jenis, jumlah, **foto nota (wajib)**, sumber
dana (kas di tangan / uang pribadi). Menunggu verifikasi Admin Keuangan.

**Keterangan perjalanan.** Menu **Keterangan**: bila sistem GPS meminta keterangan (berhenti lama, keluar rute), isi
singkat hari itu juga.

**Tanpa sinyal? Tetap bekerja.** Semua tombol tetap jalan. Data tersimpan di ponsel ("Tersimpan di ponsel: N") dan
terkirim sendiri saat sinyal kembali. Jangan hapus aplikasi/data browser sebelum semua terkirim ("Semua terkirim").

**Setor akhir hari.** Menu **Setor**: lihat **Kas di tangan** = tunai rit + pelunasan tunai − pengeluaran dari kas.
Pastikan semua rit Selesai/Gagal → **Setor Rp …** → serahkan uang ke Admin Keuangan sebelum batas tutup kas (bawaan
17.00). Setelah Setor, ringkasan terkunci. Bila ada selisih, lihat **Riwayat** dan tambahkan keterangan Anda.

**Tombol Berangkat terkunci?** "Setoran kemarin belum ditutup Admin Keuangan" → hubungi Admin Keuangan (tombol di layar).
Kunci terbuka sendiri setelah setoran ditutup.

**Kernet:** hanya melihat daftar rit, kecuali Dispatcher menetapkan Anda sebagai pengemudi pengganti hari itu — tombol
sama dengan sopir dan semua catatan atas nama Anda (setor sendiri).

**HP rusak/hilang/dicuri:** telepon Admin Keuangan segera. Kantor mencatat rit atas nama Anda ("dicatat kantor") dan
Admin Sistem memblokir ponsel.

## Admin Keuangan — dicatat kantor

Menu **Dicatat kantor** (hanya bila ponsel truk rusak/hilang, Bab 6.1):

1. Pilih tanggal → buka rit yang belum selesai.
2. **Catat Selesai**: alasan (wajib, min. 10 huruf), jam kejadian WIB, penerima, volume, cara bayar + jumlah, bukti
   (opsional). Atau **Catat Gagal**: alasan, jam, alasan gagal, tindak lanjut air.
3. Catatan ditandai **Dicatat kantor**, atas nama sopir yang bertugas, dan pemilik diberi tahu. Tunai masuk setoran sopir.

Tabel **Perangkat truk** menunjukkan antrean yang belum terkirim; **Status sinkron setoran** menunjukkan apakah data
hari itu lengkap (setoran hanya ditutup bila lengkap). Membuka kembali setoran yang sudah Diajukan: layar Kas & setoran (M4).

## Dispatcher — kendala sopir

Menu **Kendala sopir**: kendala & rit gagal 7 hari terakhir. **Konfirmasi** setelah menghubungi sopir (catatan wajib).
Untuk **Truk rusak**, centang **Ubah status truk menjadi Perbaikan** agar truk tidak dijadwalkan. Permintaan tempo dari
lapangan masuk ke **Persetujuan** — putuskan selagi sopir di lokasi (batas bawaan 30 menit); lewat itu tercatat kurang bayar.

## Pemilik & Admin Keuangan — laporan

Menu **Laporan sopir**: daftar **Dicatat kantor** (KPI-01 "tidak dicatat di sumber") dan **Setoran sopir**, plus unduhan
Excel/PDF: rit & bukti kirim, pembayaran rit, pelunasan lewat sopir, pengeluaran rit, setoran sopir, dicatat kantor.
