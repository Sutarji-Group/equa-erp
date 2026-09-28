# Panduan M10 — Pengguna, Hak Akses & Jejak Audit

Panduan singkat per peran. Semua perubahan akses tercatat di **Jejak audit** dan tidak dapat dihapus siapa pun.

---

## Pengguna lapangan (Sopir, Kernet, Operator depot, Kasir, Operator produksi) — 1 halaman

1. **Satu orang satu akun, PIN milik sendiri.** Jangan memberi tahu PIN ke siapa pun. PIN 6 angka Anda tetapkan
   sendiri saat aktivasi pertama di depan admin sistem.
2. **Hanya di ponsel/tablet perusahaan yang terdaftar.** Ponsel lain ditolak. Ponsel truk dipakai bergantian sopir &
   kernet — masing-masing masuk dengan PIN sendiri; data teman tidak terlihat dan tidak terhapus.
3. **Salah PIN 5 kali** → terkunci 15 menit. Layar terkunci sendiri setelah 10 menit tidak dipakai; data tidak hilang.
4. **Lupa PIN** → minta admin sistem mereset. Anda menerima kode baru lalu menetapkan PIN baru sendiri.
5. **Ponsel hilang/rusak** → segera lapor admin sistem atau Dispatcher. Ponsel akan diblokir dan datanya dihapus dari
   jarak jauh.
6. **Kendala aplikasi** → menu **Bantuan → Laporkan kendala**. Versi aplikasi & status sinkron terkirim otomatis.
   Status laporan tampil di ponsel: **Diterima → Dijawab → Selesai**. Tekan **Tandai selesai** bila sudah beres.
   Tim IT menjawab paling lambat 1 minggu.
7. **"Perbarui aplikasi"** muncul → versi Anda di bawah versi minimal; perbarui dulu sebelum melanjutkan.

---

## Admin sistem (tim IT)

**Menu Akses & pengaturan.** Tidak menyentuh transaksi keuangan.

| Tugas | Di mana | Catatan |
|---|---|---|
| Buat akun | Akses → **Pengguna** → *Buat akun dari karyawan* | Pilih karyawan dari master M1 (tanpa karyawan tidak bisa; satu karyawan satu akun), **satu peran**, lingkup unit (Sopir/Kernet → truk, Operator depot → depot, Kasir → toko, Operator produksi → sumber air; peran kantor otomatis seluruh EQUA). Akun **aktif setelah pemilik menyetujui**. |
| Akun awal go-live | Pengguna → centang *Akun awal go-live* → *Susun daftar untuk ditandatangani* | Pemilik menyetujui sekaligus. Setelah ditandatangani, akun baru kembali lewat persetujuan satu per satu. |
| Pindah peran / peran tambahan | Rincian pengguna → *Ajukan pindah peran / peran tambahan* | Pindah peran: akun tetap, peran lama dicabut saat disetujui. Peran tambahan wajib **alasan + masa berlaku**. Kombinasi terlarang (mis. Admin Keuangan + Dispatcher) **tidak dapat diajukan**. |
| Perluasan lingkup | Rincian pengguna → *Ajukan perluasan lingkup* | Aktif setelah disetujui pemilik. |
| Cabut peran / kurangi lingkup / nonaktifkan | Rincian pengguna | **Seketika tanpa persetujuan.** Nonaktif memutus semua sesi dan memblokir perangkat yang dipegangnya. Tanggal keluar di master karyawan menonaktifkan akun otomatis pada hari itu. |
| Reset PIN / kata sandi / 2FA | Rincian pengguna | Verifikasi orangnya di luar sistem dulu. Kode/kata sandi sementara **tampil sekali**. Pemilik otomatis diberi tahu (akun pemilik juga lewat e-mail). Anda tidak dapat mereset akun sendiri — minta admin sistem lain. |
| Daftarkan perangkat | Akses → **Perangkat** | Kode aktivasi 8 karakter berlaku 24 jam, **tampil sekali**. Tetapkan unit, pemegang, atau tandai **cadangan**. |
| Perangkat hilang | Rincian perangkat → *Blokir* lalu *Hapus data jarak jauh* | Antrean yang ikut hilang tercatat sebagai insiden. |
| Pantau sinkron & insiden | Akses → **Perangkat & sinkron** | Tanggapi insiden ≤ 30 menit, catat pulih ≤ 4 jam. Atur **versi minimal aplikasi**. |
| Helpdesk | **Bantuan** → *Kotak helpdesk tim IT* | Jawab ≤ 1 minggu; yang terlambat diingatkan otomatis. |
| Data pribadi | Akses → **Data pribadi** | Catat permintaan anonimisasi (pemilik menyetujui). Catat hasil cadangan harian/bulanan & uji pemulihan (RPO/RTO). |

## Pemilik

- **Persetujuan** (ponsel/web): permintaan akun, peran, lingkup, multi-peran, anonimisasi. Tautan notifikasi membuka
  permintaannya paling atas — **Setujui** satu ketuk; **Tolak** wajib alasan. Permintaan akses yang lewat 2 hari kerja
  **tetap terbuka** dan ditandai terlambat — akses tidak pernah aktif tanpa keputusan Anda.
- **Tabel "Aturan persetujuan (Bab 6.2a)"** di halaman Persetujuan menampilkan pemohon, penyetuju, ambang (nilai
  parameter saat ini), tenggat, dan perlakuan bila lewat tenggat. Ambang diubah di Pengaturan → Parameter.
- **Tinjauan hak akses** tiap kuartal: Akses → **Tinjauan hak akses** → periksa penanda (tanpa login > 60 hari,
  multi-peran lewat masa berlaku) → *Tandai ditinjau*.
- **Peran & matriks**: lihat & ekspor Excel/PDF matriks peran × tindakan untuk audit; lihat percobaan tindakan yang
  ditolak (lebih dari 3 sehari oleh orang yang sama Anda terima notifikasinya).
- **Jejak audit**: cari per objek/pengguna/tanggal/tindakan; tab **Log akses** untuk masuk/keluar, login gagal,
  perangkat, ekspor. Ekspor keduanya (Excel/PDF). Tombol *Verifikasi keutuhan* memeriksa rantai hash.
- **Ringkasan harian**: notifikasi "Perubahan akses hari ini" (ikut e-mail ringkasan malam).
- **Akun awal go-live**: Akses → Pengguna → *Tanda tangani & aktifkan semua*.

## Dispatcher & Admin Keuangan

- **Perangkat & sinkron**: Dispatcher melihat perangkat truk; Admin Keuangan melihat semua perangkat — periksa
  "belum terkirim" sebelum menerima setoran. Konflik sinkron (data lapangan yang bertabrakan dengan kantor) tampil di
  halaman yang sama.
- Dispatcher memutuskan permintaan **tunai → tempo di lapangan** dari Persetujuan.

## Akuntan (baca-saja)

- **Jejak audit** hanya objek keuangan (setoran, faktur, jurnal, periode, …). Tidak dapat mengubah apa pun.
