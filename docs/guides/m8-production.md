# Panduan Produksi & Stok Air (M8)

Aplikasi operator produksi dibuka dari **ponsel sumber air** (alamat **/produksi**, terpasang seperti aplikasi). Web
kantor memakai menu **Produksi air → Neraca air / Utilisasi kapasitas / Mutu air / Pengisian & pasokan / Meter sumber
air**. Operator hanya memasukkan kenyataan (angka meter, volume, alasan); produksi, susut, dan utilisasi dihitung sistem.

## Operator produksi (satu halaman)

**Masuk.** Pilih nama Anda → PIN 6 angka. Ponsel hanya untuk sumber air tempat Anda ditugaskan; ganti orang lewat
**Ganti pengguna**. Layar utama **Hari ini** menunjukkan meter pagi/malam, pengisian, dan tugas.

**Angka meter pagi & malam (3 langkah).** **Catat meter** →
1. *Meter* — pagi (awal) atau malam (akhir) sudah dipilihkan.
2. *Angka* — ketik angka pada meter (liter). Lebih kecil dari angka sebelumnya → ditolak; periksa lagi. Bila meter
   berputar ke nol atau diganti, hubungi Admin Keuangan/admin sistem dulu.
3. *Foto & simpan* — **foto meter wajib** dari kamera aplikasi. Lewat jam **08.00** (pagi) atau **23.00** (malam) →
   tulis alasan terlambat.
Angka yang sudah tersimpan tidak bisa diubah dari ponsel; salah angka → lapor Admin Keuangan (koreksi berfoto).

**Isi truk (3 langkah).** **Isi truk** →
1. *Truk* — truk yang dijadwalkan mengisi di sumber ini tampil paling atas. Truk lain → **Truk lain…** lalu centang
   konfirmasi (Dispatcher diberi tahu).
2. *Volume & rit* — bawaan 5.000 L. Beda → pilih alasan (mis. **Sisa muatan** bila truk masih membawa air rit gagal).
   Rit tujuan sudah disarankan (rit berikutnya truk itu). Tidak ada rit → **Tanpa rit** (ditandai ke kantor).
3. *Simpan* — foto boleh ditambah (tidak wajib).

**Susut di atas batas (5%).** Muncul kotak merah **Isi penjelasan susut** → pilih alasan (kebocoran, pencucian/
pembuangan, meter bermasalah, pengisian belum tercatat, lainnya + keterangan) + **foto** → kirim. Pemilik menerima atau
mengembalikan (catatannya tampil di kotak yang sama).

**Lainnya.** **Level tandon** (boleh, untuk menjelaskan stok antar hari) · **Hasil uji mutu** (tanggal, laboratorium,
nilai per parameter, foto sertifikat; tidak lulus → isi tindakan, penanggung jawab, tenggat) · **Riwayat** (pengisian
hari ini + beberapa hari terakhir).

**Tanpa sinyal? Tetap bekerja.** Semua tombol jalan. Setiap data bertanda **Tersimpan di ponsel** lalu **Terkirim**
sendiri saat sinyal kembali ("Semua terkirim"). Jangan hapus aplikasi/data browser sebelum semua terkirim. Kendala
aplikasi → **Bantuan → Laporkan kendala aplikasi**; di sana juga daftar data di ponsel + **Kirim sekarang**.

## Pemilik

- **Neraca air**: per sumber per hari — produksi, pengisian pelanggan, pasokan depot, air rit gagal kembali, susut L/%,
  rata-rata 7 hari (informasi), utilisasi, status. Daftar kerja di atas. Buka **rincian** → baca penjelasan operator +
  foto → **Terima penjelasan** (Selesai) atau **Kembalikan ke operator** dengan catatan. Tab **Bulanan**: per sumber &
  gabungan + ekspor Excel/PDF.
- **Utilisasi kapasitas**: rata-rata, tertinggi, hari > 90% (PAR-19), ruang tumbuh (liter & setara rit). Notifikasi
  push bila > 90% tiga hari berturut (PAR-85). Tombol Excel = data harian 6 bulan per sumber & gabungan (studi kapasitas).
- **Mutu air**: tambah/ubah/nonaktifkan **jadwal uji** per sumber/depot (frekuensi dari Anda/konsultan; PAR-70 bila
  ditetapkan). Pengingat H-7 ke Anda & operator lokasi. Hasil tidak lulus → notifikasi + tindakan wajib.

## Admin Keuangan

- **Rincian neraca** (dari Neraca air): **Verifikasi produksi** yang menyimpang > 20% dari rata-rata 7 hari (bandingkan
  foto meter); **Koreksi** pembacaan (angka benar + alasan + foto pembanding — baris lama tetap, berstatus Dikoreksi);
  **Balik pengisian** (pengisian ganda/salah, beralasan) atau **Tautkan ke rit** (pengisian tanpa rit);
  **Verifikasi susut negatif** (pengisian melebihi produksi).
- **Pengisian & pasokan**: pengisian vs jadwal rit, semua pengisian (penanda tanpa rit, di luar rencana, ponsel
  cadangan, geofence), **pasokan depot** tiga angka (diisi · diserahkan · diterima; selisih > 2% PAR-69 ditandai) +
  ringkasan per depot per hari/bulan, dan **Stok air awal depot** (sekali per depot saat mulai memakai sistem).
- **Mutu air**: **Catat hasil uji** (baris `parameter; nilai; satuan; batas; lulus/tidak`, sertifikat foto/PDF) dan
  **Tandai selesai** tindakan hasil tidak lulus.

## Admin sistem

**Meter sumber air**: **Catat putaran meter** (angka maksimum sebelum kembali ke nol + alasan) — pembacaan berikutnya
yang lebih kecil diterima sekali; **Catat penggantian meter** (angka akhir meter lama, pengenal & angka awal meter
baru, alasan) — produksi hari itu diestimasi dari rata-rata 7 hari dan ditandai. Tambah/nonaktifkan meter: Data master
→ Sumber air. Daftarkan ponsel sumber air di Akses → Perangkat (unit = sumber air).

## Dispatcher

Menu **Pengisian & pasokan → Pengisian vs jadwal**: rit terjadwal per truk dan pengisiannya; notifikasi **pengisian
tanpa rit** (indikasi rit tanpa pesanan), **truk di luar rencana**, dan **selisih pasokan depot**.
