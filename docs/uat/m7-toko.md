# UAT M7 — Penjualan Toko & Stok

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Kasir |
| Skenario BRD | P-03 |
| User story diuji (PRD 11.3) | US-M7-01 s.d. US-M7-06, US-M7-09 (M); US-M7-08 (S); US-M7-07 (S, RL-6) |
| Data uji | Opname fisik cut-over toko; nota pemasok nyata; pelanggan mitra toko tempo |
| Akun uji | Kasir (`kasir`) di tablet POS toko TK1; Admin Keuangan; pemilik |
| Panduan pengguna | `docs/guides/lapangan/kasir-toko.md (1 halaman) · docs/guides/m7-store.md` |
| Jumlah | 9 user story · 37 KP |

## Persiapan

- [ ] Tablet toko diaktifkan (mode toko otomatis); barang, harga umum & mitra, stok minimum, pemasok terisi; stok awal cut-over ditandatangani.
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M7-01 POS toko dengan harga mitra dan umum — M

**Layar:** POS toko `/pos` › Jual  
**Rujukan PRD:** baris 1150

**Langkah uji:**
1. Pelanggan umum vs mitra toko (harga mitra otomatis); cari/pindai barang; diskon > batas → menunggu pemilik (barang belum diserahkan).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Transaksi memilih pelanggan (wajib untuk harga mitra dan tempo; opsional "umum" untuk tunai): pelanggan bertanda "mitra toko" (US-M1-01 KP-6; BR-18) otomatis memakai harga mitra, selain itu harga umum; kasir tidak dapat memilih harga secara manual (BR-15). | ☐ | ☐ |  |
| 2 | Pencarian barang dengan nama/kode; pemindaian barcode kamera opsional [USULAN]; jumlah, satuan, total otomatis; cara bayar tunai, QRIS statis (PTB-04), atau tempo mitra (US-M7-04). | ☐ | ☐ |  |
| 3 | Diskon per transaksi maksimal 5% oleh kasir dengan alasan (BR-17); di atas itu transaksi berstatus "menunggu persetujuan pemilik" dan tidak dapat diselesaikan sampai disetujui (US-M10-04); diskon tercatat per transaksi dan dilaporkan bulanan. | ☐ | ☐ |  |
| 4 | Stok berkurang saat transaksi tersimpan; barang berstatus stok 0 tidak dapat dijual (BR-28: barang tanpa nota tidak masuk stok, karena itu tidak dapat dijual). | ☐ | ☐ |  |
| 5 | Void mengikuti aturan M6 (US-M6-03) termasuk BR-13; retur barang oleh pelanggan pada hari yang sama dilakukan lewat void; setelah itu lewat nota kredit oleh Admin Keuangan (PTB-46). | ☐ | ☐ |  |
| 6 | Struk tersedia (cetak bila printer; PDF/WA bila diminta); untuk tempo, struk menyebut nomor faktur M5. | ☐ | ☐ |  |

### US-M7-02 Penerimaan barang dari pemasok dan kartu stok — M

**Layar:** POS › Terima barang; kantor: Toko › Penerimaan barang  
**Rujukan PRD:** baris 1161

**Langkah uji:**
1. Nota pemasok (foto wajib, total = nota) → stok & utang bertambah; nota ganda ditolak; nota pengganti menunggu Admin Keuangan; kartu stok per barang.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Penerimaan wajib merujuk nota pemasok: pemasok (master), nomor dan tanggal nota, foto nota, baris barang (jumlah, harga beli satuan), total; tanpa nota barang tidak dapat diterima (BR-28). | ☐ | ☐ |  |
| 2 | Barang baru dibuat kasir dengan nama, kode, satuan, kategori, harga umum, harga mitra, stok minimum, dan berlaku setelah disetujui Admin Keuangan (BRD 10.2); perubahan harga jual mengikuti BR-15 (persetujuan, tanggal berlaku, riwayat). | ☐ | ☐ |  |
| 3 | Kartu stok per barang: masuk (nota), keluar (penjualan, transfer internal ke depot), penyesuaian (opname), saldo berjalan, dan harga pokok rata-rata bergerak yang diperbarui setiap penerimaan (PTB-38; metode dapat diubah akuntan, K9). | ☐ | ☐ |  |
| 4 | Nota yang belum dibayar membentuk utang pemasok (US-M7-08, S) — bila S belum dibangun, nota tetap tercatat sebagai pembelian tunai/transfer dengan tanggal bayar. | ☐ | ☐ |  |
| 5 | Stok awal pada cut-over diimpor dari opname fisik yang ditandatangani (BRD 10.3, NFR-34) dengan harga beli terakhir sebagai harga pokok awal. | ☐ | ☐ |  |
| 6 | Penerimaan tidak dapat dihapus; koreksi lewat nota retur pemasok/pembalik beralasan (BR-38). | ☐ | ☐ |  |

### US-M7-03 Stok minimum dan daftar pesan ulang — M

**Layar:** POS › Stok & opname › Pesan ulang; kantor: Toko › Pesan ulang  
**Rujukan PRD:** baris 1172

**Langkah uji:**
1. Barang ≤ stok minimum masuk daftar pesan ulang → *Sudah dipesan* → selesai sendiri saat barang diterima.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Stok minimum per barang (master); saat saldo ≤ minimum, barang masuk daftar pesan ulang dengan saldo, rata-rata penjualan 30 hari, dan pemasok terakhir; notifikasi ke kasir (Bab 6.3). | ☐ | ☐ |  |
| 2 | Daftar dapat ditandai "sudah dipesan" (tanggal, pemasok) dan hilang otomatis saat penerimaan nota masuk. | ☐ | ☐ |  |
| 3 | Ekspor daftar (Excel/PDF) untuk pemesanan ke pemasok. | ☐ | ☐ |  |

### US-M7-04 Penjualan tempo untuk mitra terdaftar — M

**Layar:** POS › Jual › Tempo mitra  
**Rujukan PRD:** baris 1180

**Langkah uji:**
1. Mitra berstatus Tempo dalam batas → tempo; melewati batas/Ditahan → tunai/QRIS atau ajukan persetujuan pemilik; faktur M5 terbit.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Cara bayar tempo hanya tersedia bila pelanggan bertanda mitra toko dan berstatus kredit Tempo (US-M1-01 KP-3); pelanggan Ditahan atau Tunai ditolak dengan keterangan, dengan pilihan mengajukan persetujuan pemilik (US-M2-05 KP-3 berlaku sama). | ☐ | ☐ |  |
| 2 | Kontrol batas memakai satu batas kredit per pelanggan lintas lini (PTB-25): eksposur = piutang air truk + piutang toko + pesanan tempo belum dikirim + transaksi ini (BR-06); melebihi batas → ditolak. | ☐ | ☐ |  |
| 3 | Transaksi tempo membentuk faktur per transaksi di M5 (US-M5-01) dengan tempo pelanggan (bawaan 14 hari); pelunasan, pengingat, dan penahanan mengikuti M5. | ☐ | ☐ |  |
| 4 | Toko diasumsikan daring (PTB-42); bila offline, tempo hanya dengan data eksposur sinkron terakhir dan berpenanda untuk tinjauan Admin Keuangan (seperti PTB-19). | ☐ | ☐ |  |
| 5 | Mitra depot EQUA (Tahap 3) memakai jalur yang sama dengan batas kredit yang ditetapkan pada perjanjian mitra. | ☐ | ☐ |  |

### US-M7-05 Stok opname dan penyesuaian — M

**Layar:** POS › Stok & opname › Opname; kantor: Toko › Opname  
**Rujukan PRD:** baris 1190

**Langkah uji:**
1. Opname bulanan bersama Admin Keuangan (jumlah sistem tersembunyi) → alasan selisih → diajukan → pemilik menyetujui penyesuaian.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Opname bulanan (PAR-32) dilakukan kasir bersama Admin Keuangan: lembar hitung per barang (sistem menampilkan saldo hanya setelah jumlah fisik dimasukkan [USULAN, mencegah "menyamakan angka"]); selisih dihitung sistem per barang dalam jumlah dan nilai (harga pokok). | ☐ | ☐ |  |
| 2 | Selisih → usulan penyesuaian beralasan (rusak, hilang, salah catat, lainnya) → persetujuan pemilik (US-M10-04) → saldo disesuaikan, kartu stok mencatat penyesuaian, jurnal M11 terbentuk (beban selisih stok L4). | ☐ | ☐ |  |
| 3 | Selama opname berjalan, penjualan tetap boleh; sistem menghitung selisih berdasarkan saldo pada waktu hitung per barang. | ☐ | ☐ |  |
| 4 | Opname yang belum dilakukan sampai tanggal 5 bulan berikutnya ditandai ke pemilik [USULAN]. | ☐ | ☐ |  |
| 5 | Riwayat opname dan selisih per barang per bulan tersedia (masukan laporan margin US-M7-07). | ☐ | ☐ |  |

### US-M7-06 Transfer internal bahan ke depot sendiri — M (tambahan, PTB-37 disetujui; tukar CR-14, Bab 2.4)

**Layar:** POS › Stok & opname › Transfer ke depot; POS depot › Stok bahan  
**Rujukan PRD:** baris 1200

**Langkah uji:**
1. Kirim tutup/tisu/galon ke depot EQUA (bukan penjualan) → depot menerima (beda → alasan); jurnal harga mitra, markup dieliminasi pada konsolidasi.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Transfer internal memilih outlet depot tujuan dan baris barang; stok toko berkurang saat dikirim; stok depot bertambah saat operator mengonfirmasi penerimaan di POS depot (US-M6-04 KP-5); selisih kirim–terima ditandai. | ☐ | ☐ |  |
| 2 | Nilai transfer memakai harga mitra (PTB-37) dan dicatat sebagai pendapatan transfer internal L4 dan beban bahan L3, dieliminasi pada konsolidasi (M11) — tidak ada kas, tidak ada piutang. | ☐ | ☐ |  |
| 3 | Transfer tidak memerlukan persetujuan tetapi dilaporkan bulanan per depot; transfer ke outlet mitra (Tahap 3) bukan transfer internal melainkan penjualan mitra (US-M7-01). | ☐ | ☐ |  |

### US-M7-07 Laporan barang laris/mati dan margin per barang — S, dijadwalkan RL-6 (kompensasi, Bab 2.4)

**Layar:** Toko › Laporan toko (`/toko/laporan`)  
**Rujukan PRD:** baris 1208

**Langkah uji:**
1. Barang laris/mati (PAR-66) & margin per barang per bulan; ekspor Excel/PDF (RL-6).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Per barang per bulan: jumlah terjual, omzet, harga pokok (rata-rata bergerak), margin kotor, hari tanpa penjualan, saldo stok dan nilainya; kelompok "laris" (30% teratas) dan "mati" (tanpa penjualan ≥ 90 hari [USULAN]). | ☐ | ☐ |  |
| 2 | Per pelanggan mitra: pembelian bulanan (untuk paket mitra Bab 9). | ☐ | ☐ |  |
| 3 | Ekspor sesuai US-M9-03. | ☐ | ☐ |  |

### US-M7-08 Utang pemasok dan jadwal pembayaran — S

**Layar:** Toko › Utang pemasok (`/toko/utang`)  
**Rujukan PRD:** baris 1216

**Langkah uji:**
1. Umur utang per pemasok; *Catat pembayaran* (kas kantor/transfer + bukti) teralokasi per nota; *Balik pembayaran* beralasan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Nota pembelian yang belum dibayar membentuk utang dengan jatuh tempo (dari nota; bila kosong 30 hari, PAR-67); daftar utang per pemasok dan umur; pengingat jatuh tempo ke Admin Keuangan (Bab 6.3). | ☐ | ☐ |  |
| 2 | Pembayaran (kas kantor atau transfer) dicatat di M4 dan dialokasikan ke nota; sebagian/penuh; bukti wajib untuk transfer. | ☐ | ☐ |  |
| 3 | Terintegrasi ke M11 sebagai utang usaha (US-M11-07); saldo awal utang pemasok saat cut-over diinput dari nota (BRD 10.3). | ☐ | ☐ |  |

### US-M7-09 Kas toko harian dan setoran — M

**Layar:** POS › Shift & kas; kantor: Kas › Tutup kas  
**Rujukan PRD:** baris 1224

**Langkah uji:**
1. Tutup shift toko (QRIS & tempo tidak masuk laci) → setor → Admin Keuangan menerima; kas kantor tidak dapat ditutup sebelum shift toko ditutup.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Shift/kas toko mengikuti US-M6-02: kas awal tetap, kas fisik saat tutup, selisih otomatis beralasan, setoran fisik atau setor bank (PTB-23), hasil penerimaan tampil ke kasir. | ☐ | ☐ |  |
| 2 | Penjualan tempo dan QRIS tidak masuk kas fisik; tercatat di piutang (M5) dan daftar pencocokan (M4). | ☐ | ☐ |  |
| 3 | Tutup kas Admin Keuangan (US-M4-06) mensyaratkan shift toko ditutup. | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| UAT | Pindai barcode dengan kamera tablet toko nyata (tombol *Pindai*). | ☐ | ☐ |  |
| B-14 | Transaksi toko 5 barang ≤ 30 detik di jam ramai (catat waktu). | ☐ | ☐ |  |
| BR-27 | Opname fisik cut-over menghitung seluruh barang toko (tidak hanya sampel). | ☐ | ☐ |  |

## Catatan cacat

| No | US / KP | Uraian & langkah mereproduksi | Kelas | Penanggung jawab | Tenggat | Status |
|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |

## Kelas cacat (PRD 11.2)

| Kelas | Definisi | Konsekuensi |
|---|---|---|
| **Kritis** | Transaksi tidak dapat dicatat, hilang, dobel, atau dapat diubah tanpa jejak; kebocoran data lintas peran/tenant; salah hitung uang | Menahan rilis; ditanggapi ≤ 30 menit setelah go-live (NFR-31) |
| **Mayor** | Fungsi M tidak bekerja sesuai KP tetapi ada jalan lain berjejak | Menahan rilis kecuali komite pengarah menerima dengan tenggat perbaikan |
| **Minor** | Ketidaknyamanan, teks, tampilan | Masuk backlog; tidak menahan rilis |

User story **lulus** bila seluruh KP dijawab "lulus" oleh pemilik modul pada UAT dengan data nyata dan cacat tersisa bukan
Kritis/Mayor. User story prioritas M yang tidak lulus menahan rilis (PRD 11.2).

## Berita acara (PRD 11.3)

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M7 Penjualan Toko & Stok**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Kasir — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-03 |
| Data uji | Opname fisik cut-over toko; nota pemasok nyata; pelanggan mitra toko tempo |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M7-01 |  | __ / __ |  |
| US-M7-02 |  | __ / __ |  |
| US-M7-03 |  | __ / __ |  |
| US-M7-04 |  | __ / __ |  |
| US-M7-05 |  | __ / __ |  |
| US-M7-06 |  | __ / __ |  |
| US-M7-07 |  | __ / __ |  |
| US-M7-08 |  | __ / __ |  |
| US-M7-09 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
