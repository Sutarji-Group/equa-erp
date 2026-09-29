# Panduan M5 — Piutang & Penagihan

Menu kantor **Piutang**: Ringkasan piutang · Faktur · Pelunasan · Umur piutang · Pengingat jatuh tempo · Faktur bulanan ·
Saldo awal piutang · Status kredit. Faktur **terbit otomatis** — tidak ada yang mengetik faktur:
- rit **tempo** Selesai → faktur kirim (jatuh tempo = tempo pelanggan); pelanggan **tagihan bulanan** → rit masuk
  "belum ditagih", difakturkan tanggal 1 (PAR-12);
- rit **tunai kurang bayar** → faktur kurang bayar jatuh tempo hari itu juga (H+0);
- penjualan **tempo toko** → faktur per transaksi saat shift toko ditutup (retur/void setelah tutup shift → nota kredit).

Semua angka: rupiah bulat, **tanpa PPN** (dokumen bukan faktur pajak). Data tidak pernah dihapus — salah input
diperbaiki dengan **nota kredit** atau **pembalik** beralasan; nilai di atas batas koreksi (PAR-21) menunggu pemilik.

---

## Admin Keuangan

**Setiap pagi — Ringkasan piutang.** Tiga daftar tindakan: **Perlu diingatkan hari ini**, **Akan Ditahan** (tagih
sebelum tanggal Ditahan), **Sudah Ditahan**. Tombol **Hitung ulang Ditahan** menjalankan evaluasi malam sekarang.

**Pengingat jatuh tempo.** Daftar H-3 sebelum dan H+1 sesudah jatuh tempo (PAR-13), satu baris per pelanggan dengan
total sisa. **Buka WhatsApp** → pesan terisi (nomor faktur, jumlah, jatuh tempo, rekening PT) → kirim dari WhatsApp;
status berubah **Dibuka**. Faktur bersengketa **Ditunda**. Pelanggan tagihan bulanan diingatkan atas faktur bulanannya.

**Pelunasan kantor.** **Pelunasan** → pilih pelanggan → isi tanggal, jumlah, cara bayar:
- **Tunai kantor** (masuk kas kantor) atau **Transfer bank** + **bukti transfer** (wajib; JPEG/PNG/PDF maks. 4 MB; foto dikompres otomatis).
- Alokasi per faktur boleh dikosongkan → otomatis ke **faktur tertua dulu**. Kelebihan bayar → **uang muka** pelanggan,
  otomatis memotong faktur berikutnya (atau **Ajukan pengembalian** — diputuskan pemilik).
- Pelunasan lewat sopir masuk sendiri dari aplikasi sopir (jangan dicatat ulang).
- Salah catat: buka pelunasan → **Balik pelunasan** (alasan wajib) atau ubah alokasi per faktur → **Simpan alokasi**.
  Kirim bukti bayar lewat **Kirim bukti WA** / **Unduh PDF**.
- **Tunai rit yang sebenarnya pelunasan** (bagian bawah halaman Pelunasan): **Alihkan** → faktur lama pelanggan lunas,
  rit tetap tercatat tunai (tanpa uang berpindah).

**Faktur.** Saring per status/jenis/pelanggan/lewat tempo. Di rincian faktur: **Unduh PDF**, **Kirim WA**, **Kirim
e-mail**; **Terbitkan nota kredit** (alasan wajib); **Tandai bersengketa** bila pelanggan membantah volume/harga (pengingat &
penahanan faktur itu ditunda maks. PAR-45 hari sampai pemilik memutuskan); faktur kurang bayar yang disetujui menjadi
tempo → **Konversi ke tempo**.

**Umur piutang & kartu piutang.** Umur per pelanggan (belum jatuh tempo, 1–7, 8–30, > 30 hari), per segmen dan per lini,
plus **% lewat tempo (KPI-04)** dibanding sasaran. Klik pelanggan → **kartu piutang** (faktur, pelunasan, nota kredit,
uang muka; saldo berjalan) → **Kirim pernyataan piutang (WA)**. Ekspor Excel/PDF berisi data pelanggan: isi **Tujuan
ekspor** terlebih dulu (tercatat).

**Faktur bulanan.** Tanggal 1: faktur bulan lalu terbit otomatis → daftar **Siap kirim** → **WA** / **E-mail** hari
itu juga. **Belum ditagih** = rit bulan berjalan. Pelanggan baru tagihan bulanan: unggah perjanjian tertulis → **Ajukan ke
pemilik**.

**Saldo awal piutang (sebelum go-live).** Input per faktur kertas yang **dikonfirmasi pelanggan** + lampiran
konfirmasi. Salah entri → **Batalkan entri saldo awal** (nota kredit berjejak). Setelah pemilik menandatangani,
perubahan hanya lewat **Ajukan koreksi**.

**Status kredit.** Cek eksposur pelanggan (saldo + pesanan tempo berjalan + tempo toko) terhadap batas; **Ajukan
pembukaan** Ditahan ke pemilik; daftar **Layak diajukan Tempo**.

---

## Pemilik

- **Persetujuan**: nota kredit/pembalik/realokasi di atas PAR-21, pengembalian uang muka, tagihan bulanan, pembukaan
  Ditahan, koreksi saldo awal. Putusan **sengketa** di rincian faktur: **Koreksi lewat nota kredit** atau **Tolak**.
- **Status kredit → Buka Ditahan** (alasan wajib): berlaku sampai keterlambatan berikutnya. Di kartu piutang:
  **Masa transisi** (tunda penahanan otomatis sampai tanggal tertentu, maks. PAR-41 bulan sejak go-live).
- **Saldo awal piutang → Tanda tangani** total (NFR-34): sejak itu faktur saldo awal ikut umur, pengingat, dan penahanan.
- **Pengingat jatuh tempo → Template pesan**: ubah isi (versi baru berjejak; variabel wajib tetap ada).
- Ringkasan umur piutang terkirim otomatis setiap minggu (PAR-40), memuat sasaran KPI-04.

## Dispatcher

**Status kredit**: siapa **Ditahan** dan **Akan Ditahan**; pilih pelanggan → **Lihat** saldo, eksposur, sisa batas —
dipakai saat pesanan tempo ditolak. **Ajukan pembukaan** Ditahan atau **Ajukan penanda tagihan bulanan** ke pemilik.
Faktur & pelunasan tidak dapat dibuka Dispatcher.

## Akuntan

Baca saja: **Faktur**, **Umur piutang**, kartu piutang, **Saldo awal piutang**. Faktur saldo awal tidak dijurnal sebagai
penjualan (masuk neraca awal); nota kredit "konversi kurang bayar" dan "transfer ternyata diterima" hanya reklasifikasi.

## Sopir & kernet (aplikasi sopir)

Tidak ada layar piutang terpisah. Di rincian rit tampil **faktur terbuka** pelanggan → **Terima pelunasan** (tunai/
transfer + bukti) — faktur otomatis berkurang di kantor, tidak dicatat ulang. Rit tunai yang **kurang bayar** menjadi
faktur kurang bayar hari itu; tagih di kunjungan berikutnya (spanduk "Tagih kurang bayar sebelumnya").
