# Panduan M6 — Penjualan Depot (POS)

> **Kartu 1 halaman untuk dicetak (operator depot, NFR-16):** [`lapangan/operator-depot.md`](lapangan/operator-depot.md). Indeks semua panduan: [`README.md`](README.md).

POS depot berjalan di tablet depot (aplikasi **/pos**) dan **tetap bekerja tanpa sinyal**. Data tersimpan di tablet
lalu terkirim otomatis saat sinyal kembali. Di kantor, menu **Pemantauan outlet** dan **Laporan outlet**.

---

## Operator depot (tablet POS) — 1 halaman

**Masuk.** Pilih nama Anda, ketik PIN. Tombol **Ganti operator** di bawah layar untuk bergantian; data tetap tersimpan.
Status di atas layar: **Semua terkirim** atau **Tersimpan di ponsel: n** (belum terkirim — tidak apa-apa, lanjut kerja).

**1. Buka shift (awal jaga).** Hitung uang di laci. Kas awal tetap ditampilkan sistem; bila hitungan berbeda, tulis
keterangannya. Periksa stok awal bahan lalu tekan **Buka shift**. Shift kemarin yang belum ditutup harus ditutup dulu.

**2. Jual.** Ketuk produk (harga otomatis dari kantor, tidak diketik), atur jumlah dengan **+/−**.
- **Tunai**: isi uang diterima (atau **Uang pas**) → kembalian dihitung → **Simpan · Tunai**.
- **QRIS**: tunjukkan QRIS, periksa dana masuk, isi referensi bila ada → **QRIS diterima · Simpan**.
Struk tampil di layar; **Cetak struk** bila printer tersedia. Tanpa sinyal, nomor struk sementara (nomor lokal);
nomor resmi terbit saat terkirim.

**3. Kas terlalu banyak.** Bila muncul peringatan **Kas di laci melebihi batas**, setor ke bank: menu **Shift & void →
Setor sebagian**, isi jumlah dan **foto slip** setor.

**4. Salah transaksi (void).** Menu **Shift & void** → pilih transaksi → **Void…** → pilih alasan (Lainnya = wajib
keterangan) → **Void transaksi ini**. Nilai besar perlu persetujuan pemilik: statusnya **Void menunggu persetujuan**
dan transaksi tetap dihitung sampai disetujui. Setelah void, **Buat transaksi pengganti** bila pelanggan tetap membeli.

**5. Pasokan air datang.** Menu **Pasokan air** menampilkan truk yang **Tiba**. Periksa meter/tandon:
**Sesuai, terima** bila sama, atau **Volume berbeda** → isi volume diterima dan alasannya → **Simpan penerimaan**. Tidak dikonfirmasi sampai tutup shift =
diterima sesuai catatan sopir. Air darurat dari sumber lain: **Pasokan darurat dari sumber lain** (alasan wajib) → **Catat pasokan sumber lain**.

**6. Bahan (tutup, tisu, galon kosong).** Menu **Stok bahan**: terima **transfer dari toko** (isi jumlah diterima;
beda = alasan) atau bahan dari **pemasok lain** (nama pemasok, nomor nota, **foto nota** wajib).
**Opname mingguan** (paling lambat Minggu): hitung fisik setiap bahan, pilih alasan bila berbeda → **Kirim opname**.

**7. Tutup shift.** Menu **Shift & void → Tutup shift**. Sistem menampilkan penjualan tunai, QRIS, void, dan
**Tunai seharusnya di laci**. Hitung uang, isi **Kas fisik**; berbeda → alasan wajib. Isi **stok fisik** setiap bahan
(berbeda di luar toleransi → alasan). Tekan **Tutup shift** — boleh tanpa sinyal.

**8. Setor.** Menu **Riwayat → Setoran shift terakhir**: pilih **Serah fisik** atau **Setor bank (foto slip)** →
**Tandai sudah disetor**. Riwayat shift 90 hari menampilkan selisih kas/stok dan status setoran (**Diterima** setelah
dihitung Admin Keuangan). Data ditolak server tampil di **Antrean data** beserta alasannya.

---

## Admin Keuangan

- **Pemantauan outlet** (`/outlet`): per depot hari ini — shift berjalan, kas berjalan (merah bila > batas),
  penjualan, galon, QRIS (bukan kas fisik), void, pasokan menunggu, stok air, opname minggu ini.
- **Konflik shift** (shift dibuka di perangkat cadangan saat shift lain terbuka): cocokkan datanya, isi catatan →
  **Tandai sudah ditinjau**. Data lapangan tetap sah.
- **Void disetujui setelah shift ditutup** (notifikasi): buka outlet → tab **Transaksi** → **Buat transaksi pembalik**.
  Pembalik dicatat pada tanggal koreksi; transaksi asal tidak diubah. Koreksi tanpa persetujuan hanya sampai PAR-21.
- **Rincian shift**: bila tampil **Menunggu sinkron**, jangan terima setoran dulu — ada transaksi yang belum terkirim.
- Notifikasi: void QRIS (kembalikan dana di luar sistem), void berlebihan (> PAR-03/hari), kas melebihi batas,
  opname terlambat, setoran depot terlambat.

## Pemilik

- **Persetujuan**: void di atas PAR-04 (sampai akhir hari shift; lewat tenggat = ditolak, transaksi tetap dihitung) dan
  penyesuaian stok hasil opname.
- **Rincian outlet → Pengaturan**: kas awal tetap, QRIS, printer; **Ambang khusus outlet** (PAR-02/03/04/57/58/59)
  dengan tanggal berlaku dan alasan.
- **Laporan outlet**: ringkasan harian, void per outlet per hari, **pemakaian bahan vs penjualan** (rasio per galon —
  bandingkan antar depot), **neraca air** (galon terjual tidak boleh melebihi air diterima; kelebihan > PAR-59 dikirim
  sebagai notifikasi), pasokan air, shift, opname. Semua dapat diekspor Excel/PDF.

## Admin sistem

- **Tenant & paket POS** (`/outlet/tenant`): buat tenant mitra (kode, nama usaha, depot pertama) dan salin katalog
  standar EQUA (produk depot, harga standar, resep). Data tiap tenant terpisah penuh.
- Tablet POS & akun operator: menu **Akses & perangkat** (kode aktivasi tablet, PIN operator).
