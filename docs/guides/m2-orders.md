# Panduan Pesanan & Penjadwalan Rit (M2)

Menu **Pesanan & jadwal** di web kantor: Pesanan, Pesanan baru, Papan jadwal, Jadwal kru, Pesanan berulang. Menu yang
tampil mengikuti peran Anda.

Aturan umum:

- Setiap pesanan bernomor **P-YY-NNNNNN**; nomor rit = nomor pesanan + urutan tangki (**P-26-000123/2**). 1 tangki = 1 rit.
- Pesanan **tidak pernah dihapus**. Yang tidak jadi dibatalkan dengan alasan dari daftar; riwayat tetap ada.
- Harga per rit terisi otomatis (tarif zona + BBM, atau harga khusus). Tidak ada pengetikan harga.
- Status pesanan: **Baru → (Menunggu persetujuan) → Terjadwal → Dalam pengiriman → Selesai**, atau **Dibatalkan**.
  Terjadwal/Dalam pengiriman/Selesai mengikuti rit (terbit, berangkat, selesai di aplikasi sopir).

## Dispatcher

### Mencatat pesanan telepon/WA (US-M2-01) — satu layar

1. **Pesanan baru** (atau tombol **Pesanan baru** di daftar pesanan).
2. **Pelanggan**: ketik minimal 2 huruf nama, nomor WA, atau alamat. Alamat terakhir dan jam terima tetap terisi
   otomatis; panel kanan menampilkan riwayat, piutang, catatan khusus, dan harga khusus. Belum terdaftar? **Pelanggan baru**
   (nama, WA, segmen, alamat) → status Tunai.
3. Isi **jumlah tangki**, **tanggal** (bawaan: hari ini sebelum pukul 15.00, sesudahnya besok — PAR-05), jam, **cara
   bayar**, catatan untuk sopir. Harga & total tampil otomatis.
4. **Simpan pesanan** (atau Enter). Nomor pesanan tampil besar untuk dibacakan ke pelanggan. Tekan **Kirim konfirmasi WA**
   untuk membuka WhatsApp berisi pesan yang sudah terisi.

Kondisi khusus saat menyimpan:

- **Kemungkinan dobel** (pelanggan & tanggal sama dengan pesanan aktif): pilih **Pesanan tambahan** (alasan wajib) atau
  **Batalkan yang ini** (tercatat Dibatalkan alasan *Dobel* untuk KPI-06).
- **Tempo ditolak** (status Tunai/Ditahan atau melampaui batas): ubah ke tunai, atau **Ajukan ke pemilik** dengan alasan.
  Pesanan menunggu persetujuan dan belum dapat dijadwalkan.
- **Setelah pukul 15.00 untuk hari ini**: tanggal pindah ke besok; untuk tetap kirim hari ini isi alasan paksa.
- **Kurang bayar kedua** belum lunas: pesanan perlu pelunasan atau persetujuan pemilik sebelum dijadwalkan.
- **Pasokan depot (internal)**: pilih depot tujuan; harga transfer internal, tanpa uang.

### Papan jadwal (US-M2-03)

1. **Papan jadwal** → pilih tanggal. Kolom **Belum terjadwal** berisi semua rit tanggal itu dan rit lewat tanggal
   (merah, paling atas).
2. Seret kartu rit ke jalur truk, atau pilih truk di kartu lalu **Tugaskan**. Urutan: **Naikkan/Turunkan**, atau
   **Urutan BR-21** (jam diminta → jam terima tetap → pesanan lebih awal). Kapasitas melebihi batas hanya diperingatkan.
3. **Terbitkan** per truk (atau **Terbitkan semua**) → rit terkirim ke aplikasi sopir. Perubahan setelah terbit (tarik,
   pindah truk, urutan) dicatat dan perlu **diterbitkan ulang**.
4. Kartu bertanda: *Lewat tanggal*, *Perlu jadwal ulang*, *Kemungkinan dobel*, *Konfirmasi ulang*, *Tagih kurang bayar*,
   *Harga sementara*, *Pelanggan Ditahan*, *Konflik*. Rit terkunci (BR-10) tampil di jalur dengan pesan setoran.
5. **Konflik lapangan**: rit yang sudah dikerjakan offline saat ditarik kantor tetap sah; tandai ditindaklanjuti.

Papan diperbarui otomatis tiap 20 detik; peta menampilkan posisi truk terakhir dan alamat rit.

### Jadwal kru (US-M2-10, US-M2-11)

- **Pengemudi hari itu**: sopir default, kernet truk itu, atau sopir lain yang tidak bertugas. Pengganti wajib beralasan
  dan berlaku sampai akhir hari. Sopir yang setorannya kemarin belum Ditutup tidak dapat ditetapkan (BR-10).
- **Jadwal mingguan**: tandai sopir/kernet libur atau bertugas di truk lain; ubah kapasitas rit per truk per hari.
- **Status truk per hari**: *Perbaikan* (alasan wajib) → rit truk itu ditandai perlu dipindah.

### Mengelola pesanan (US-M2-02, US-M2-08, US-M2-09)

Di rincian pesanan: **Jadwal ulang** (tanggal baru + alasan), **Cara bayar**, **Konfirmasi ulang** (wajib setelah 2 rit
gagal berturut — PAR-17), **Catatan untuk sopir**, **Perbarui harga** (bila harga berubah sejak dipesan), **Batalkan
pesanan** (alasan dari daftar; tidak bisa bila sudah Dalam pengiriman). Rit gagal otomatis membuat pesanan *Perlu jadwal
ulang* dan rit pengganti di kolom Belum terjadwal.

### Pesanan berulang (US-M2-06)

**Pesanan berulang** → **Pola langganan baru**: pelanggan, alamat, hari (mis. Senin & Kamis) atau setiap N hari,
tangki, jam, cara bayar, mulai/berakhir. Pesanan dibuat otomatis 2 hari sebelum tanggal kirim (PAR-34) bertanda
*Langganan*, dengan kontrol kredit. Yang gagal dibuat (mis. kredit Ditahan) muncul di **Gagal dibuat** + notifikasi;
tindak lanjuti lalu **Tandai ditindaklanjuti**. Pola dapat **Jeda**, **Aktifkan**, atau **Akhiri**.

## Pemilik

- **Persetujuan**: *Pesanan tempo di luar kontrol kredit* dan *Pesanan saat kurang bayar kedua*. Tampil eksposur kredit
  saat itu. Lewat tenggat (awal jam layanan tanggal kirim) → pesanan otomatis menjadi tunai dan dispatcher diberi tahu.
- **Pesanan › Template WA**: ubah teks konfirmasi (variabel `{{nomor_pesanan}}`, `{{tanggal_kirim}}`, `{{total}}`, …);
  versi lama tersimpan.
- **Pesanan › Laporan bulanan**: pembatalan & rit gagal per pelanggan/truk, KPI-06 (dobel dibatalkan, lewat tanggal tanpa
  jadwal ulang), dan pengesampingan beralasan (H+0 dipaksa, pesanan tambahan walau dobel). Semua dapat diekspor Excel/PDF.

## Admin Keuangan

Melihat daftar pesanan, papan jadwal, jadwal kru, dan pesanan berulang (baca-saja). Pemisahan tugas: tidak dapat membuat,
mengubah, atau membatalkan pesanan.

## Sopir & kernet (aplikasi sopir)

- Rit muncul setelah dispatcher **menerbitkan** jadwal, urut sesuai rencana, lengkap dengan catatan khusus (akses lokasi,
  jam terima) dan tanda *Tagih kurang bayar*.
- Bila setoran kemarin belum Ditutup, rit tampil tetapi **terkunci** — selesaikan setoran di kantor dulu.
- Kernet yang ditetapkan sebagai pengemudi pengganti hari itu mendapat hak sopir untuk truknya sampai akhir hari.
- Rit yang ditarik kantor hilang dari daftar pada sinkron berikutnya.
