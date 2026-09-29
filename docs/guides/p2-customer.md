# Panduan P2 — Aplikasi Pelanggan (Tahap 2)

Aplikasi pelanggan adalah **PWA** di alamat `/app` (dibuka di browser ponsel, bisa "Tambahkan ke layar utama"). Bawaan
**mati** (flag `phase2.customer_app`, D-02): selama mati, pelanggan yang membuka `/app` melihat arahan memesan lewat
telepon/WhatsApp kantor seperti biasa. Semua aturan Tahap 1 tetap berlaku untuk pesanan dari aplikasi: **harga dari
master** (zona + BBM / harga khusus), **kontrol kredit**, **cek dobel**, batas pesan hari ini **pukul 15.00** (PAR-05).
Layar kantor ada di menu **Aplikasi pelanggan** (`/keluhan/*`: Kotak keluhan, Pesanan aplikasi, Penilaian layanan,
Pembayaran digital & WA, Laporan aplikasi, Akun pelanggan).

---

## Pelanggan (di ponsel)

**Masuk / daftar.** Isi **nomor WhatsApp** → **Kirim kode lewat WhatsApp** → ketik kode 6 angka → **Masuk**. Tidak ada
kata sandi. Kode berlaku 5 menit, 3 kali coba. Sesi bertahan 30 hari.
- Nomor sudah dikenal kantor → isi **nama sesuai data pelanggan** + centang **persetujuan data pribadi (UU PDP)**. Nama
  cocok → langsung terhubung; tidak cocok → "Menunggu verifikasi", kantor menelepon Anda.
- Nomor baru → isi nama, **ketuk peta** (atau **Pakai lokasi saya**) tepat di lokasi tandon, alamat lengkap, catatan
  akses → **Simpan & mulai pesan**. Anda tercatat pelanggan baru bayar Tunai.

**Pesan air (4 langkah).** **Pesan air** → pilih alamat → jumlah tangki → tanggal & **slot** (Pagi/Siang/Sore; slot
penuh tidak bisa dipilih) → ringkasan harga → pilih **cara bayar** → **Kirim pesanan**. Simpan nomor pesanan (P-…).
Kantor mengonfirmasi paling lambat 2 jam layanan. **Pesan ulang** mengulang pesanan terakhir dengan satu ketukan.
**Batalkan pesanan** (alasan wajib) bisa selama truk belum berangkat; setelah itu telepon kantor.

**Lacak.** Rincian pesanan menunjukkan **garis waktu** (Diajukan → Dikonfirmasi → Dalam perjalanan → Selesai), nomor
truk & nama depan sopir, dan **peta posisi truk** saat truk berangkat. Pemberitahuan masuk ke **Notifikasi** dan
WhatsApp.

**Bayar & tagihan.** **Tagihan** menampilkan faktur terbuka dan sisa tagihan; unduh faktur/riwayat PDF. **Bayar**
lewat **QRIS** atau **virtual account** — untuk keamanan, pembayaran meminta **kode OTP ulang** bila Anda masuk lebih dari
15 menit lalu. Status **Pembayaran berhasil** muncul otomatis. Pesanan dengan cara bayar **Bayar sekarang** dilunasi
di muka — sopir tidak menagih lagi. **Struk digital** tersedia di setiap pengiriman Selesai.

**Langganan & pengingat.** **Langganan** → jadwal rutin (hari/tanggal, slot, jumlah tangki) → jeda/lanjut/akhiri
sendiri. **Pengingat isi ulang** (Akun) mengirim WA H-2 dari perkiraan pesanan berikutnya.

**Penilaian & keluhan.** Beri **bintang 1–5** + komentar untuk tiap pengiriman Selesai. **Keluhan** → jenis
(keterlambatan, volume, sikap, tagihan, lainnya) → uraian + foto → dikirim; tanggapan pertama paling lambat
24 jam layanan dan tampil di aplikasi & WhatsApp.

**Akun.** Kelola alamat (titik dikunci kantor setelah pengiriman pertama), **Ganti nomor WA** (kode ke nomor lama lalu
nomor baru; nomor lama hilang → hubungi kantor), **Hapus akun** (data dianonimkan sesuai UU PDP setelah disetujui kantor).

---

## Dispatcher

- **Pesanan aplikasi** (`/keluhan/pesanan-aplikasi`): setiap pesanan baru masuk berstatus **Baru** bertanda "dari
  aplikasi" dan tampil juga di papan jadwal. **Konfirmasi** (atau jadwalkan truk di papan — dihitung konfirmasi) atau
  **Tolak** dengan alasan (tampil ke pelanggan) paling lambat **2 jam layanan** (PAR-75). Lewat tenggat → tanda merah +
  notifikasi ke Dispatcher & pemilik. Tanda **Kemungkinan dobel** → cek dulu di Pesanan.
- **Akun pelanggan** (`/keluhan/akun`): **Permintaan menunggu** — nama tidak cocok (nomor berganti pemilik): telepon
  pelanggan lalu **Tautkan ke pelanggan ini**, **Buat pelanggan baru (Tunai)**, atau **Tolak akun**. **Ganti nomor**
  untuk pelanggan yang kehilangan nomor lama (setelah verifikasi telepon; sesi lama dicabut).
- **Kotak keluhan** (`/keluhan`, kotak **Operasional**): keterlambatan, volume, sikap, lainnya. Buka keluhan → **Kirim
  tanggapan** (≤ 24 jam layanan) → **Tutup dengan penyelesaian**. Keluhan tagihan → **Pindahkan** ke kotak Admin
  Keuangan. Keluhan tidak bisa dihapus.
- **Penilaian layanan**: rata-rata bintang per truk/sopir dan komentar terbaru.

## Admin Keuangan

- **Kotak keluhan** (kotak **Tagihan**): tanggapi & tutup keluhan tagihan. Bila faktur memang dibantah → **Tandai faktur
  bersengketa** (masuk alur sengketa M5; pengingat & penahanan faktur itu ditunda, keputusan di pemilik).
- **Pembayaran digital & WA** (`/keluhan/pembayaran`): daftar pembayaran QRIS/VA. Pembayaran **Berhasil** otomatis menjadi
  **pelunasan** (faktur tertua dulu; kelebihan → uang muka) dan **transfer masuk** di Kas yang harus **dicocokkan** dengan
  settlement bank seperti transfer lain (status berubah **Dicocokkan**). Biaya gerbang dicatat sebagai beban.
  **Biaya pesan WhatsApp** per bulan per kategori (untuk laporan biaya bulanan).

## Pemilik

- **Mengaktifkan aplikasi** (`/keluhan/akun` → **Aktifkan aplikasi pelanggan**, alasan/rujukan TG-9 wajib) hanya
  setelah prasyarat Tahap 2 terpenuhi: Tahap 1 stabil, titik alamat pelanggan terkunci, WhatsApp Business API & gerbang
  pembayaran aktif, kapasitas rit cukup. **Nonaktifkan aplikasi** kapan saja (pelanggan kembali diarahkan ke telepon).
- **Laporan aplikasi** (`/keluhan/laporan`): adopsi (akun terhubung, % pesanan dari aplikasi, konfirmasi tepat waktu, pembayaran
  digital), rata-rata penilaian, keluhan per jenis & per truk per bulan; ekspor Excel/PDF.
- Notifikasi: pesanan aplikasi & keluhan yang lewat tenggat.

## Admin sistem

- **Hapus akun** dari pelanggan masuk ke notifikasi: catat permintaan anonimisasi di **Akses > Data pribadi**; pemilik
  menyetujui (US-M10-06). Akun aplikasi sudah dinonaktifkan dan nomornya dikosongkan saat pelanggan menekan Hapus akun.
- Konfigurasi produksi (variabel lingkungan): WhatsApp Cloud API (`WA_*`, termasuk `WA_WEBHOOK_VERIFY_TOKEN` &
  `WA_APP_SECRET` untuk webhook status `/api/customer/webhook/wa`), gerbang pembayaran (`PAYMENT_GATEWAY=midtrans`,
  `MIDTRANS_SERVER_KEY`, webhook `/api/customer/webhook/pembayaran`). Tanpa konfigurasi ini, OTP & pembayaran tidak dapat
  dipakai di produksi (mode uji hanya dengan `ALLOW_DEV_SECRETS=1`).
- Parameter: `p2.customer_app_rules` (sesi, OTP, horizon pesan, nomor kantor), `p2.payment_rules`, `p2.wa_pricing`,
  PAR-72..75.
