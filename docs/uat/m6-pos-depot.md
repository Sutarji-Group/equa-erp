# UAT M6 — Penjualan Depot (POS)

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Operator depot senior |
| Skenario BRD | P-02 |
| User story diuji (PRD 11.3) | US-M6-01 s.d. US-M6-07 |
| Data uji | Satu shift nyata di depot ramai dan depot sepi; tenant uji untuk isolasi (US-M6-07 KP-6) |
| Akun uji | Operator depot (`depot01`) di tablet POS D01; Admin Keuangan; pemilik; admin sistem (tenant) |
| Panduan pengguna | `docs/guides/lapangan/operator-depot.md (1 halaman) · docs/guides/m6-pos.md` |
| Jumlah | 7 user story · 42 KP |

## Persiapan

- [ ] Tablet POS depot diaktifkan; produk, harga, resep bahan, kas awal tetap outlet terisi; stok awal bahan & air depot ditandatangani.
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M6-01 Transaksi cepat di POS depot — M

**Layar:** POS `/pos` › Jual  
**Rujukan PRD:** baris 1044

**Langkah uji:**
1. Ketuk produk, atur jumlah, tunai (uang pas/kembalian) dan QRIS → struk tampil/cetak; harga dari kantor tidak dapat diketik.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Layar utama: kisi produk tenant (isi ulang, galon baru, tutup, tisu, cuci galon, dan lainnya dari master M1; maksimal 12 tombol besar), pengubah jumlah (+/−, bawaan 1), total otomatis; harga hanya dari master yang berlaku hari itu (BR-15) dan tidak dapat diubah operator; tidak ada diskon di POS depot (PTB-48). | ☐ | ☐ |  |
| 2 | Pembayaran: **tunai** (uang diterima → kembalian dihitung; bawaan pas) atau **QRIS statis** (operator menandai QRIS; opsional referensi) — QRIS tidak menambah kas fisik dan masuk daftar pencocokan M4 (PTB-04). Cara bayar lain tidak tersedia di Tahap 1 (BRD 3.3). | ☐ | ☐ |  |
| 3 | Dari ketuk produk sampai transaksi tersimpan ≤ 10 detik untuk transaksi 1–2 baris (FR-M6-01) dan setiap aksi ≤ 1 detik di perangkat (NFR-03); diukur pada UAT dengan 20 transaksi berturut. | ☐ | ☐ |  |
| 4 | Struk opsional: cetak bila printer bluetooth terpasang (NFR-25, C) atau tampilkan ringkasan di layar; nomor transaksi tetap terbentuk tanpa struk. | ☐ | ☐ |  |
| 5 | Setiap transaksi mencatat outlet, shift, operator, waktu perangkat, baris produk, jumlah, harga, cara bayar; ID dibuat di perangkat (Bab 6.4); transaksi tersimpan tidak dapat diubah — hanya void (US-M6-03). | ☐ | ☐ |  |
| 6 | Pelanggan tidak dicatat per transaksi (FR-M6-08 berprioritas C, tidak dibangun); kolom pelanggan opsional disiapkan kosong untuk Tahap 2 tanpa tampilan di POS. | ☐ | ☐ |  |
| 7 | Penjualan bertanda "internal" (misalnya galon untuk kebutuhan sendiri) tidak ada; semua keluar barang di luar penjualan dicatat lewat pemakaian/opname (US-M6-04). | ☐ | ☐ |  |

### US-M6-02 Buka dan tutup shift dengan kas dan stok fisik; setoran outlet — M

**Layar:** POS › Buka shift / Shift & void › Tutup shift / Riwayat › Setoran shift  
**Rujukan PRD:** baris 1056

**Langkah uji:**
1. Buka shift dengan hitung kas awal & stok awal; tutup shift: kas fisik & stok fisik (beda → alasan).
2. *Tandai sudah disetor* (serah fisik / setor bank + foto slip) → Admin Keuangan menerima (status Diterima).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Buka shift: kas awal tetap per outlet (PAR-57, PTB-40) tampil dari sistem dan dikonfirmasi operator dengan hitung fisik; stok awal bahan habis pakai = stok sistem setelah shift sebelumnya (tampil, tidak diketik). Hanya satu shift terbuka per outlet; shift kemarin yang belum ditutup harus ditutup dulu. | ☐ | ☐ |  |
| 2 | Selama shift: kas berjalan = kas awal + tunai − kembalian − void tunai; melebihi PAR-02 (Rp 2 juta) → peringatan ke operator dan Admin Keuangan (BR-08) dengan tindakan "setor sebagian" (setor bank dengan foto slip, PTB-23). | ☐ | ☐ |  |
| 3 | Tutup shift: sistem menampilkan penjualan per produk, tunai seharusnya, QRIS, void, pemakaian bahan yang seharusnya (US-M6-04 KP-2); operator memasukkan kas fisik dan stok fisik tiga bahan utama (tutup, tisu, galon kosong); selisih kas dan selisih stok dihitung sistem; selisih kas ≠ 0 dan selisih stok di luar toleransi PAR-58 wajib alasan (P-02 langkah 5; bawaan PAR-58 = 0 selama pilot, dapat dinaikkan pemilik setelah ada data pilot). | ☐ | ☐ |  |
| 4 | Setelah ditutup, shift terkunci; transaksi baru masuk shift berikutnya; koreksi hanya oleh Admin Keuangan lewat pembalik (BR-38). | ☐ | ☐ |  |
| 5 | Setoran: tunai seharusnya − kas awal tetap = jumlah disetor (fisik ke Admin Keuangan atau setor bank dengan foto slip, PTB-23); status setoran mengikuti Bab 5.2; setoran belum diterima > 1 hari ditandai (PAR-27); hasil penerimaan (diterima, selisih, keputusan) tampil ke operator. | ☐ | ☐ |  |
| 6 | Operator melihat riwayat shift, selisih, dan galon/hari miliknya 90 hari terakhir; tidak melihat outlet lain [USULAN, paralel US-M3-07 KP-6]. | ☐ | ☐ |  |
| 7 | Selisih kas ≥ PAR-01 mengikuti alur pemilik (US-M4-02/03); ganti rugi mengikuti PTB-22. | ☐ | ☐ |  |

### US-M6-03 Void dengan alasan — M

**Layar:** POS › Shift & void › *Void…*; kantor: Persetujuan  
**Rujukan PRD:** baris 1068

**Langkah uji:**
1. Void beralasan; void > PAR-04 menunggu pemilik (transaksi tetap dihitung); > PAR-03 void/hari → notifikasi Admin Keuangan; *Buat transaksi pengganti*.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Void hanya untuk transaksi pada shift yang masih terbuka; alasan wajib dari daftar (salah produk, salah jumlah, pelanggan batal, salah cara bayar, lainnya + teks); transaksi asli tetap tampil bertanda "di-void" dengan transaksi pengganti bila ada. | ☐ | ☐ |  |
| 2 | Void > Rp 100.000 memerlukan persetujuan pemilik (BR-13, US-M10-04); bila perangkat offline, void berstatus "menunggu persetujuan" dan transaksi tetap dihitung sebagai penjualan pada tutup shift sampai disetujui (PTB-43); persetujuan yang datang setelah shift ditutup diproses sebagai pembalik oleh Admin Keuangan. | ☐ | ☐ |  |
| 3 | Lebih dari 3 void per hari per outlet → notifikasi Admin Keuangan (BR-13); nilai dan jumlah void per outlet per hari tampil di M4 dan laporan outlet. | ☐ | ☐ |  |
| 4 | Void QRIS: transaksi ditandai; pengembalian dana di luar sistem dicatat Admin Keuangan sebagai pengeluaran dengan rujukan [USULAN]. | ☐ | ☐ |  |
| 5 | Tidak ada tombol hapus; tidak ada void massal. | ☐ | ☐ |  |

### US-M6-04 Stok bahan habis pakai dan opname mingguan — M (PTB-07 disetujui)

**Layar:** POS › Stok bahan; kantor: Pemantauan outlet  
**Rujukan PRD:** baris 1078

**Langkah uji:**
1. Pemakaian bahan otomatis per resep; terima transfer dari toko & bahan pemasok lain (foto nota); *Opname mingguan* → selisih diajukan ke pemilik.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Kartu stok per bahan per outlet: masuk (penerimaan dari toko EQUA lewat transfer internal US-M7-06 atau dari pemasok lain dengan nota), keluar (pemakaian seharusnya), penyesuaian opname; saldo berjalan. | ☐ | ☐ |  |
| 2 | Pemakaian seharusnya dihitung dari resep per produk yang ditetapkan pemilik (misalnya 1 isi ulang = 1 tutup + 1 tisu; 1 galon baru = 1 galon kosong + 1 tutup) — resep dikelola per tenant di master. | ☐ | ☐ |  |
| 3 | Tutup shift mencatat stok fisik tiga bahan utama (US-M6-02 KP-3); selisih harian dicatat sebagai informasi dan tidak mengubah saldo; selisih di luar toleransi PAR-58 wajib alasan. | ☐ | ☐ |  |
| 4 | Opname mingguan (BR-27, PAR-32): operator menghitung seluruh bahan; selisih terhadap sistem → usulan penyesuaian beralasan → persetujuan pemilik (US-M10-04) → saldo disesuaikan dan jurnal M11 terbentuk; opname yang belum dilakukan pada minggu berjalan ditandai ke Admin Keuangan. | ☐ | ☐ |  |
| 5 | Penerimaan bahan dicatat operator saat barang tiba (jumlah per bahan, sumber, foto nota untuk pemasok luar); tanpa pencatatan, stok tidak bertambah. | ☐ | ☐ |  |
| 6 | Laporan pemakaian vs penjualan per outlet per minggu/bulan (M9) dengan rasio bahan per galon. | ☐ | ☐ |  |

### US-M6-05 Menerima pasokan air dan neraca air outlet — M

**Layar:** POS › Pasokan air; kantor: Laporan outlet › neraca air  
**Rujukan PRD:** baris 1089

**Langkah uji:**
1. Truk internal Tiba → *Sesuai, terima* / *Volume berbeda* (alasan); pasokan darurat sumber lain; neraca air mingguan (galon × ukuran vs air diterima, toleransi PAR-59).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Rit internal yang Selesai di M3 muncul di POS outlet tujuan sebagai "pasokan tiba" dengan volume diserahkan sopir; operator mengonfirmasi (bawaan volume sama) atau memasukkan volume diterima yang berbeda dengan alasan; selisih kirim–terima ditandai ke M8 dan Dispatcher (P-04 langkah 3). | ☐ | ☐ |  |
| 2 | Pasokan yang belum dikonfirmasi sampai tutup shift berikutnya (PAR-61) dianggap diterima sesuai catatan sopir dengan penanda "tanpa konfirmasi operator" dan dilaporkan ke Admin Keuangan. | ☐ | ☐ |  |
| 3 | Stok air outlet (liter) = stok awal + volume diterima − galon terjual × 19 L (A9; ukuran galon per produk di master); kapasitas simpan dari master M1; stok yang melampaui kapasitas ditandai. | ☐ | ☐ |  |
| 4 | Neraca air outlet mingguan dan bulanan: galon terjual × 19 L vs air diterima ± perubahan stok; galon terjual melebihi air yang tersedia lebih dari PAR-59 → ditandai ke pemilik (indikasi air dari sumber lain atau pencatatan pasokan kurang; BRD 9.9). | ☐ | ☐ |  |
| 5 | Volume diterima menjadi dasar harga transfer internal (BR-33, K20) untuk jurnal M11; tidak ada uang di depot untuk pasokan. | ☐ | ☐ |  |
| 6 | Pasokan dari sumber selain truk EQUA (darurat) dicatat dengan sumber "lain" dan alasan; tampil di neraca air dan laporan pemilik [USULAN]. | ☐ | ☐ |  |

### US-M6-06 Bekerja tanpa sinyal — M

**Layar:** POS (mode pesawat)  
**Rujukan PRD:** baris 1100

**Langkah uji:**
1. Satu shift penuh tanpa sinyal: jual, void, tutup shift → nomor lokal; sambung → nomor resmi `{kode}-YYMMDD-NNNN`, *Semua terkirim*, tanpa dobel.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Transaksi, void (kecuali yang perlu persetujuan), buka/tutup shift, penerimaan pasokan, dan opname berjalan tanpa sinyal minimal satu hari penuh; katalog produk, harga, resep bahan, dan stok diunduh saat login. | ☐ | ☐ |  |
| 2 | Status "tersimpan di perangkat"/"terkirim" per transaksi dan ringkasan antrean; sinkron ≤ 5 menit setelah sinyal kembali; tidak ada transaksi hilang atau dobel (Bab 6.4). | ☐ | ☐ |  |
| 3 | Tutup shift offline tetap sah; Admin Keuangan melihat status "menunggu sinkron" dan tidak dapat menerima setoran sebelum seluruh transaksi shift tersinkron (paralel US-M3-09 KP-3). | ☐ | ☐ |  |
| 4 | Perubahan harga master yang berlaku hari ini diterapkan saat sinkron berikutnya; transaksi yang sudah terjadi memakai harga yang ada di perangkat saat itu dan ditandai bila berbeda [USULAN]. | ☐ | ☐ |  |
| 5 | Login PIN offline; perangkat terdaftar (US-M10-02). | ☐ | ☐ |  |

### US-M6-07 Paket standar multi-tenant — M

**Layar:** Depot & toko › Tenant & paket POS (`/outlet/tenant`)  
**Rujukan PRD:** baris 1110

**Langkah uji:**
1. Admin sistem membuat tenant uji + depot pertama (katalog standar tersalin); tablet & akun operator tenant uji.
2. Operator tenant uji tidak melihat data EQUA dan sebaliknya (KP-6); laporan tenant terpisah.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Setiap outlet berada di bawah satu tenant; tenant EQUA memuat 10 depot sendiri; tenant baru (mitra) dapat dibuat admin sistem dengan katalog standar EQUA disalin sebagai bawaan (Bab 4.3) dan diaktifkan dalam ≤ 1 jam kerja tanpa rilis aplikasi [USULAN ukuran]. | ☐ | ☐ |  |
| 2 | Data transaksi, shift, stok, dan pengguna terpisah per tenant; tidak ada tampilan, pencarian, atau ekspor lintas tenant dari POS; agregasi hanya di web EQUA dengan hak baca sesuai perjanjian (NFR-30, BRD 10.6). | ☐ | ☐ |  |
| 3 | Pengaturan per tenant/outlet tanpa kode: produk dan harga, resep bahan, kas awal tetap, ambang void dan kas, printer, QRIS aktif/tidak, bahasa istilah tetap Indonesia. | ☐ | ☐ |  |
| 4 | Seluruh aturan kontrol (shift, void beralasan, selisih otomatis, penerimaan pasokan, neraca air) berlaku sama untuk tenant mitra; tidak ada logika khusus EQUA yang tertanam. | ☐ | ☐ |  |
| 5 | Laporan per outlet yang sama tersedia untuk pemilik tenant; laporan yang dipakai EQUA untuk royalti/neraca air mitra (BRD 9.9) bersumber dari data yang sama (dirinci Bab 9). | ☐ | ☐ |  |
| 6 | Uji penerimaan: satu tenant uji fiktif dibuat pada UAT dan tidak dapat melihat data EQUA, dan sebaliknya. | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| B-14 | Transaksi POS ≤ 10 detik (US-M6-01 KP-3): stopwatch 20 transaksi di depot ramai oleh operator senior. | ☐ | ☐ |  |
| B-19 / NFR-06 | POS depot tanpa sinyal satu hari penuh di depot nyata; semua data terkirim saat sinyal kembali. | ☐ | ☐ |  |
| NFR-03 | Aksi POS ≤ 1 detik di tablet kelas menengah-bawah (20 aksi). | ☐ | ☐ |  |
| NFR-25 (C) | Printer bluetooth tidak dibangun (D-02); struk dicetak lewat dialog cetak peramban bila printer tersedia. | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M6 Penjualan Depot (POS)**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Operator depot senior — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-02 |
| Data uji | Satu shift nyata di depot ramai dan depot sepi; tenant uji untuk isolasi (US-M6-07 KP-6) |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M6-01 |  | __ / __ |  |
| US-M6-02 |  | __ / __ |  |
| US-M6-03 |  | __ / __ |  |
| US-M6-04 |  | __ / __ |  |
| US-M6-05 |  | __ / __ |  |
| US-M6-06 |  | __ / __ |  |
| US-M6-07 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
