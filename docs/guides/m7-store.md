# Panduan M7 — Penjualan Toko & Stok

Toko memakai **aplikasi POS yang sama dengan depot** (tablet toko, **/pos**). Tablet yang terdaftar di toko otomatis
menampilkan **mode toko**. Aplikasi **tetap bekerja tanpa sinyal**; data terkirim otomatis saat sinyal kembali.
Di kantor, menu **Toko**: Barang & stok, Pemasok, Nota pembelian, Opname, Pesan ulang, Utang pemasok, Laporan toko.

---

## Kasir toko (tablet POS) — 1 halaman

**Masuk.** Pilih nama Anda, ketik PIN. Status di atas: **Semua terkirim** atau **Tersimpan di ponsel: n** (lanjut
kerja saja). Menu: **Jual · Shift & kas · Terima barang · Stok & opname · Usulan · Riwayat**.

**1. Buka shift.** Hitung uang di laci (kas awal tetap tampil); beda → tulis keterangan → **Buka shift**.

**2. Jual.** Pilih **Pelanggan**: *Umum* = harga umum; pelanggan **mitra toko** = **harga mitra otomatis** (tidak
diketik). Cari barang (nama/kode/barcode; **Pindai** bila kamera mendukung) → ketuk untuk menambah, atur **+/−**.
Stok habis tidak dapat dijual.
- **Diskon**: isi rupiah + **alasan**. Di atas batas (5%) → transaksi **menunggu persetujuan pemilik**; barang
  **jangan diserahkan** sebelum disetujui. Belum diputuskan sampai tutup shift = batal.
- **Bayar**: **Tunai** (isi uang diterima; kosong = uang pas), **QRIS** (periksa dana masuk), atau **Tempo mitra**
  (khusus mitra berstatus Tempo). Tempo melewati batas/ditahan → pilih tunai/QRIS atau centang **Ajukan persetujuan
  pemilik**. Tanpa sinyal, tempo tetap tersimpan dan ditinjau Admin Keuangan.
- Struk: **Cetak / PDF** atau **Kirim WA**. Tempo: nomor faktur tampil setelah terkirim.

**3. Retur / salah transaksi hari ini.** **Shift & kas** → transaksi → **Void…** (alasan wajib) → stok kembali.
Retur setelah shift ditutup dicatat Admin Keuangan di kantor.

**4. Terima barang.** **Terima barang** → **Ada nota pemasok** (pemasok, nomor & tanggal nota, **foto nota** wajib,
barang + jumlah + harga beli, **Total tertulis di nota** harus sama) → **Simpan penerimaan**: stok bertambah, utang
tercatat. Nota hilang → **Nota pengganti** (foto barang + keterangan): stok baru bertambah setelah Admin Keuangan
menerimanya. Nota yang sama tidak dapat dicatat dua kali.

**5. Stok & opname.** Tab **Stok** (saldo tiap barang), **Pesan ulang** (barang ≤ stok minimum: pilih pemasok →
**Sudah dipesan**; baris selesai sendiri saat barang diterima), **Opname** bulanan bersama Admin Keuangan (jumlah
sistem tidak ditampilkan — hitung fisik apa adanya, alasan bila beda → **Simpan hitungan**), **Transfer ke depot**
(tutup, tisu, galon kosong ke depot EQUA → **Kirim ke depot**; bukan penjualan).

**6. Usulan.** Barang baru, perubahan harga jual (tanggal berlaku), pemasok baru → **Kirim usulan**. Berlaku setelah
disetujui Admin Keuangan; status tampil di daftar usulan.

**7. Tutup shift.** **Shift & kas → Tutup shift**: tunai seharusnya di laci (QRIS & tempo tidak masuk laci). Hitung,
isi **Kas fisik**; beda → alasan → **Tutup shift**. **Riwayat → Setoran shift terakhir** → **Tandai sudah disetor**.
Kas kantor tidak dapat ditutup sebelum shift toko hari itu ditutup.

---

## Admin Keuangan (kantor)

- **Nota pembelian**: filter **Nota pengganti menunggu** → buka → **Terima sebagai nota** (bukan penerima barangnya).
  **Koreksi nota**: retur sebagian ke pemasok atau pembalik penuh (alasan wajib; > PAR-21 perlu persetujuan pemilik).
  **Saldo awal utang** (cut-over) di bagian bawah halaman.
- **Utang pemasok**: umur utang per pemasok, jatuh tempo per nota, pengingat otomatis. Klik pemasok → **Catat
  pembayaran** (kas kantor/transfer + **bukti transfer**), alokasi per nota atau otomatis ke nota tertua. Salah bayar →
  **Balik pembayaran** beralasan.
- **Pemasok**: ubah kontak & tempo; **Nonaktifkan** beralasan (tidak dihapus). Usulan kasir diputuskan di **Persetujuan**.
- **Opname**: buka opname bulan ini → pilih alasan setiap selisih → **Ajukan ke pemilik**. **Stok awal cut-over**:
  isi jumlah fisik & harga beli terakhir → pemilik menandatangani.
- **Laporan toko → Retur pelanggan**: cari transaksi → **Catat retur** (stok kembali; nota kredit/pengembalian dana
  diteruskan ke piutang).

## Pemilik

- Setujui diskon di atas batas & tempo di luar kontrol kredit (kotak **Persetujuan**, sebelum shift ditutup),
  penyesuaian opname, koreksi di atas PAR-21; tandatangani stok awal (**Opname → rincian**).
- **Laporan toko**: barang **laris/mati** & **margin per barang per bulan**, pembelian mitra, diskon, transfer
  internal per depot, riwayat selisih opname — semua dapat diekspor Excel/PDF.
