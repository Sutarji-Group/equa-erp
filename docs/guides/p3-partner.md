# Panduan P3 — Kemitraan Depot EQUA

Program **Mitra Depot EQUA** (istilah "waralaba" hanya muncul bila pemilik mengaktifkan pengaturan STPW). Mitra memakai
**POS yang sama** dengan depot EQUA di tabletnya, membeli air dari truk EQUA, dan membayar **langganan sistem** tiap
bulan. EQUA hanya melihat data yang tercantum di perjanjian (penjualan, pasokan, neraca air, mutu) — tidak melihat
pengguna atau kas kecil mitra.

- **Paket Minimum Mitra Fase 1** (selalu aktif): pasokan & neraca air mitra, tagihan langganan, portal baca-saja
  pemilik mitra, laporan bulanan, dukungan teknis.
- **Portal kemitraan lengkap (Tahap 3)** hanya tampil setelah pemilik mengaktifkan **"Portal kemitraan lengkap"**:
  calon mitra, onboarding, pesan air & spare part dari portal, mutu & audit, sanksi, dashboard.

---

## Pemilik mitra (portal /mitra) — 1 halaman

**Masuk.** Buka **/mitra**, isi nama pengguna & kata sandi dari admin sistem EQUA. Akun mitra **tidak** bisa membuka
web kantor EQUA; akun EQUA tidak bisa membuka portal.

- **Beranda**: penjualan, galon, selisih kas shift, sisa tagihan bulan ini; **neraca air** (galon × 19 L dibanding air
  dari truk EQUA — merah bila melewati toleransi); kontrak; **hak baca EQUA** atas data Anda; pemberitahuan.
- **Penjualan**: per hari per outlet (transaksi, galon, void, selisih shift) — angka yang sama dengan laporan EQUA.
  Unduh Excel/PDF. Setoran & selisih kas outlet Anda **dikelola sendiri**, tidak masuk kas EQUA.
- **Pasokan & neraca air**: setiap truk EQUA yang **Tiba/Dikonfirmasi** di POS, volume kirim vs terima, riwayat pembelian
  air & spare part per bulan. Operator Anda mengonfirmasi pasokan di tablet POS (menu **Pasokan air**).
- **Tagihan**: faktur langganan sistem (terbit tanggal 1, jatuh tempo tanggal 15), rincian komponen & pembayaran.
  Bayar transfer ke rekening EQUA (kirim bukti ke Admin Keuangan) atau tunai ke Admin Keuangan. Tunggakan lama dapat
  berujung **teguran** lalu **mode baca-saja** (shift POS baru tidak dapat dibuka sampai lunas).
- **Laporan bulanan**: terbit otomatis **tanggal 5** untuk bulan lalu; unduh **PDF**. Isinya tidak berubah setelah terbit.
- **Dukungan teknis**: pilih outlet & jenis (peralatan, spare part, sistem, mutu air), tulis uraian, lampirkan foto
  (≤ 4 MB) → **Kirim permintaan**. EQUA menanggapi ≤ **48 jam**; status Diajukan → Ditanggapi → Selesai lengkap
  dengan jam. Kepatuhan waktu tanggap masuk laporan bulanan.
- **Tahap 3** (bila aktif): **Pesan air & spare part** (tanggal kirim, cara bayar tunai/transfer/tempo dalam batas
  kontrak; status rit, volume, bukti kirim), **Mutu** (skor bulanan, audit & temuan, uji air, **tanda tangan SOP**),
  **Pengaturan POS** (harga jual dalam rentang harga anjuran EQUA, kas awal tetap, ambang void — berlaku besok),
  **Sanksi** (teguran, penghentian pasokan dengan **syarat pemulihan**, pemutusan & ekspor data), **sengketa tagihan**
  ≤ 7 hari dari faktur terbit.

**Keluar**: tombol **Keluar** di kanan atas.

## Operator depot mitra (tablet POS) — 1 halaman

Sama dengan panduan POS depot (M6): buka shift, jual, void, **Pasokan air** (konfirmasi truk EQUA yang Tiba: sesuai →
**Sesuai, terima**; beda → isi volume & alasan — selisih dikirim ke Dispatcher EQUA), tutup shift. Tanpa sinyal tetap
bisa; data terkirim saat sinyal kembali.
- **Daftar periksa mutu harian** (Tahap 3, saat buka shift): setiap butir **Lulus/Tidak lulus**; tidak lulus = tulis
  tindakan; butir bertanda kamera wajib foto → **Simpan daftar periksa**. Sekali per outlet per hari.
- Bila muncul **Mode baca-saja**, shift baru tidak dapat dibuka — minta pemilik mitra melunasi tagihan EQUA.

## Pembina wilayah EQUA (web kantor /kemitraan)

- **Dukungan teknis**: daftar permintaan dengan batas SLA; buka → **Kirim tanggapan** (≤ 48 jam) → setelah beres
  **Selesai**. Spare part yang dibutuhkan dijual lewat POS toko **harga mitra** lalu **Rujuk** dari permintaan.
- **Pasokan & neraca mitra**: pasokan menunggu konfirmasi, selisih, neraca air per mitra per bulan, pesanan air mitra
  lewat 24 jam.
- **Tahap 3**: **Calon mitra** (catat, survei + foto, penilaian otomatis zona/jarak/radius/kapasitas, ajukan ke pemilik,
  buat kontrak dari calon), **Onboarding** (centang butir: pelatihan 2 hari, SOP, peralatan, air pertama, perangkat
  POS, uji air — outlet Aktif setelah semua butir wajib), **Mutu & audit** (jadwal & lembar audit, uji air lab, skor),
  **Sanksi** (ajukan usulan dari pemicu), **Dashboard kemitraan** (portofolio & peringkat risiko).

## Admin Keuangan

- **Kontrak mitra**: input kontrak (opsi B/A, langganan per outlet, tanggal mulai, batas kredit, tagihan bulanan,
  dokumen perjanjian) → **menunggu persetujuan pemilik**; perubahan parameter berlaku **bulan berikutnya**.
- **Tagihan langganan**: terbit otomatis tanggal 1 (outlet aktif × tarif). Bila job belum berjalan: **Terbitkan
  tagihan bulan lalu**. Pelunasan, pengingat, umur piutang, penahanan dan nota kredit di menu **Piutang** seperti
  pelanggan biasa. Laporan bulanan mitra dapat diterbitkan lebih awal dengan **Terbitkan laporan**.

## Admin sistem

- **Mitra depot → rincian mitra**: buat akun **Operator depot (POS)** atau **Pemilik mitra (portal)** untuk tenant
  mitra (aktif setelah pemilik menyetujui di Persetujuan), terbitkan **kode PIN**, daftarkan **tablet POS** (kode
  aktivasi sekali tampil, berlaku 24 jam). Tautkan pelanggan mitra (depot pihak ketiga) ke tenant & outlet mitra.

## Pemilik EQUA

- **Persetujuan**: kontrak mitra, perubahan parameter, akun mitra, calon mitra, **sanksi** (setiap tahap diputuskan
  pemilik dengan alasan). **Sanksi mitra → Cabut** (beralasan). Pemutusan: serahkan **ekspor data** ≤ 30 hari lalu
  **Tandai sudah diserahkan**.
- **Dashboard kemitraan** (Tahap 3): omzet, air dibeli, neraca air, tagihan, skor, sanksi per mitra; ekonomi kemitraan
  (pendapatan EQUA vs ilustrasi, komitmen kapasitas air). Notifikasi: neraca air mitra merah, pesanan air mitra lewat
  24 jam, dukungan lewat 48 jam.
