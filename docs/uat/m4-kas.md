# UAT M4 — Kas & Setoran

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Admin Keuangan |
| Skenario BRD | P-06; P-01 langkah 9; P-02 langkah 6 |
| User story diuji (PRD 11.3) | US-M4-01 s.d. US-M4-06 |
| Data uji | 18 sumber kas satu hari (7 sopir, 10 depot, toko); skenario selisih ≥ dan < ambang PAR-01 |
| Akun uji | Admin Keuangan (`keuangan1`), pemilik (`pemilik`), sopir/operator/kasir yang menyetor |
| Panduan pengguna | `docs/guides/m4-cash.md` |
| Jumlah | 6 user story · 36 KP |

## Persiapan

- [ ] Satu hari operasi uji selesai (rit, shift depot & toko ditutup); rekening bank PT tercatat dengan akun buku sendiri.
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M4-01 Melihat posisi kas harian per sumber — M

**Layar:** Kas & setoran › Kas hari ini (`/kas`)  
**Rujukan PRD:** baris 853

**Langkah uji:**
1. Periksa satu baris per sumber (seharusnya, status, diterima, selisih); QRIS/transfer terpisah; sorotan sopir belum setor > 1 jam, kas outlet > PAR-02.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Layar "Kas hari ini": satu baris per sumber (7 sopir, 10 depot, 1 toko, kas kantor): seharusnya (dari M3/M6/M7, diperbarui saat sinkron), status setoran, diterima, selisih, alasan; total per lini dan keseluruhan. | ☐ | ☐ |  |
| 2 | Kolom terpisah untuk transfer belum dicocokkan dan QRIS (PTB-04) agar tidak tercampur dengan kas fisik. | ☐ | ☐ |  |
| 3 | Kas kantor: saldo awal + setoran diterima − setor ke bank − pengeluaran kas kecil (bila S) − penggantian pengeluaran rit; saldo sistem dibandingkan dengan hitung fisik saat tutup kas (US-M4-06). | ☐ | ☐ |  |
| 4 | Sumber yang belum menyetor lewat waktu ditonjolkan: setoran sopir belum Diajukan > 1 jam setelah rit terakhir Selesai (PAR-44 [USULAN]); setoran depot > 1 hari (PAR-27); kas outlet depot > PAR-02 ditandai (BR-08). | ☐ | ☐ |  |
| 5 | Riwayat per tanggal dan ekspor Excel (NFR-23). | ☐ | ☐ |  |

### US-M4-02 Menerima setoran dan menghitung selisih — M

**Layar:** Kas › Setoran (`/kas/setoran/[id]`)  
**Rujukan PRD:** baris 863

**Langkah uji:**
1. Terima setoran sopir: verifikasi pengeluaran, isi jumlah fisik (atau pecahan), selisih < ambang → alasan & tutup; selisih ≥ PAR-01 → diteruskan ke pemilik, setoran tetap Ditutup.
2. Coba menerima setoran saat perangkat penyetor *Menunggu sinkron* atau setoran milik sendiri → ditolak.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Daftar setoran Diajukan (sopir) dan tutup shift belum disetor (depot/toko); memilih satu menampilkan ringkasan seharusnya per rit/transaksi, pelunasan, dan pengeluaran menunggu verifikasi (US-M3-08); angka seharusnya tidak dapat diubah. | ☐ | ☐ |  |
| 2 | Admin Keuangan memasukkan jumlah fisik diterima (rincian pecahan opsional [USULAN]) dan memverifikasi pengeluaran rit satu per satu (terima/tolak, PTB-20); sistem menghitung selisih = diterima − (seharusnya − pengeluaran diterima). | ☐ | ☐ |  |
| 3 | Selisih ≠ 0 → alasan wajib dari daftar (salah kembalian, uang rusak/palsu, nota pengeluaran ditolak, kurang bayar pelanggan belum tercatat, lainnya + teks) dan objek Selisih terbentuk (Bab 5.2). | ☐ | ☐ |  |
| 4 | \|Selisih\| ≥ PAR-01 → objek Selisih dikirim ke pemilik seketika dengan tenggat tindak lanjut 24 jam (BR-09, 6.2a). Setoran tetap Ditutup oleh Admin Keuangan setelah selisih diberi alasan, berapa pun besarnya; keputusan pemilik berjalan di alur Selisih (US-M4-03) dan tidak menahan penutupan (BR-10 mengacu pada penutupan oleh Admin Keuangan). Di bawah ambang: Admin Keuangan menutup dengan alasan; pemilik melihatnya di H+0. | ☐ | ☐ |  |
| 5 | Selisih lebih dicatat dan disetor penuh; tidak ada pengembalian ke penyetor (BR-12). | ☐ | ☐ |  |
| 6 | Penerimaan mencatat waktu; setoran diterima setelah PAR-06 atau pada hari berikutnya ditandai "terlambat" dengan alasan (BR-08). | ☐ | ☐ |  |
| 7 | Setoran depot/toko diterima secara fisik atau lewat setor bank dengan slip (PTB-23) yang dicocokkan di US-M4-04; tutup shift depot yang belum disetor > 1 hari ditandai (PAR-27). | ☐ | ☐ |  |
| 8 | Setoran Ditutup membuka kunci rit sopir hari berikutnya secara otomatis (BR-10) dan hasilnya tampil di aplikasi sopir/POS. | ☐ | ☐ |  |
| 9 | Pemisahan tugas: penerima setoran tidak dapat mengubah transaksi lapangan; peran Admin Keuangan dapat dipegang dua orang (utama dan cadangan, R13) [ASUMSI-PRD]; pemilik tidak menerima setoran. | ☐ | ☐ |  |
| 10 | Opsional (PTB-62, PAR-83, bawaan nonaktif): bila pemilik mengaktifkan PAR-83, selisih kurang ≥ ambang PAR-83 yang belum diputuskan tetap mengunci rit sopir tersebut sampai pemilik memutuskan; kejadian ini tampil sebagai notifikasi kritis ke pemilik dan Dispatcher (6.3). | ☐ | ☐ |  |

### US-M4-03 Menindaklanjuti selisih dan mencatat ganti rugi — M

**Layar:** Kas › Selisih (`/kas/selisih`), Kas › Ganti rugi  
**Rujukan PRD:** baris 878

**Langkah uji:**
1. Jelaskan selisih; pemilik *Setujui*/*Tolak* dari Kotak masuk (≤ 24 jam, KPI-03); selisih ditolak + ganti rugi aktif → ganti rugi karyawan tercatat.
2. Catat pelunasan ganti rugi (setor tunai / potongan penggajian) dan unduh rekap bulanan penggajian.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Daftar selisih terbuka dengan umur; selisih yang belum Selesai > 24 jam ditonjolkan dan dihitung pada KPI-03. | ☐ | ☐ |  |
| 2 | Pemilik memutuskan: **Disetujui** (alasan diterima; selisih dibebankan ke akun beban selisih kas pada pusat laba sumbernya, M11) atau **Ditolak** → Ditindaklanjuti: sistem mencatat "beban ganti rugi karyawan" per kejadian (karyawan, tanggal, jumlah, rit/shift, alasan) — sistem tidak memotong gaji (BR-11c). | ☐ | ☐ |  |
| 3 | Rekap bulanan ganti rugi per karyawan diekspor (Excel/PDF) ke penggajian; pelunasan ganti rugi dicatat Admin Keuangan (setor tunai karyawan atau konfirmasi potongan dari penggajian, PTB-22); saldo ganti rugi per karyawan terlihat pemilik dan karyawan bersangkutan. | ☐ | ☐ |  |
| 4 | Parameter "ganti rugi aktif" diatur pemilik setelah Peraturan Perusahaan berlaku (BR-11a/b, R08); sebelum aktif, selisih Ditolak tetap tercatat tanpa beban ganti rugi (PTB-22). | ☐ | ☐ |  |
| 5 | Selisih di bawah ambang yang ditutup Admin Keuangan dapat dibuka kembali pemilik dalam 7 hari [USULAN]. | ☐ | ☐ |  |
| 6 | Riwayat selisih per sopir/operator (S, FR-M4-07): jumlah kejadian, nilai kurang/lebih, alasan per bulan, dan deret hari tanpa selisih sebagai dasar insentif nihil selisih 3 bulan (BR-12, usulan BRD). | ☐ | ☐ |  |

### US-M4-04 Mencatat dan mencocokkan transfer masuk — M (pencocokan manual) / S (impor berkas)

**Layar:** Kas › Transfer masuk (`/kas/transfer`)  
**Rujukan PRD:** baris 889

**Langkah uji:**
1. Cocokkan manual satu transfer dengan mutasi internet banking; impor CSV/Excel mutasi → usulan pasangan → konfirmasi; impor ulang tidak menggandakan.
2. Transfer tanpa mutasi > PAR-39 → *Tidak ditemukan* + piutang sementara M5.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Daftar transfer tercatat: pembayaran rit (M3), pelunasan transfer (M3/M5), QRIS per shift depot (M6, PTB-04), setor bank sopir/outlet (PTB-23), pelunasan mitra toko (M7) — dengan jumlah, foto bukti, sumber, tanggal, status. | ☐ | ☐ |  |
| 2 | Pencocokan manual (M): Admin Keuangan menandai Cocok dengan mencatat referensi mutasi (tanggal, jumlah, keterangan) dari internet banking. | ☐ | ☐ |  |
| 3 | Impor berkas mutasi (S): unggah CSV/Excel; sistem mengusulkan pasangan (jumlah sama, tanggal ± 1 hari); Admin Keuangan mengonfirmasi; mutasi tanpa pasangan masuk daftar tindak lanjut. | ☐ | ☐ |  |
| 4 | Transfer tanpa mutasi > 2 hari (PAR-39 [USULAN]) → status Tidak ditemukan dan notifikasi pemilik; untuk pembayaran rit, piutang sementara terbentuk pada pelanggan dengan penanda "transfer belum diterima" sampai terselesaikan [USULAN]. | ☐ | ☐ |  |
| 5 | Hasil pencocokan harian menjadi masukan rekonsiliasi bank bulanan M11 (FR-M11-06). | ☐ | ☐ |  |

### US-M4-05 Kas kantor, setor ke bank, dan kas kecil — M (setor ke bank [USULAN]) / S (kas kecil)

**Layar:** Kas › Kas kantor & setor bank (`/kas/kantor`), Kas kecil (`/kas/kas-kecil`)  
**Rujukan PRD:** baris 899

**Langkah uji:**
1. Setor ke bank dengan foto slip; balik setor bank beralasan (> PAR-21 persetujuan pemilik).
2. Kas kecil pengisian & pengeluaran (> PAR-43 menunggu pemilik); hitung fisik mingguan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Setor ke bank: jumlah, tanggal, rekening PT, foto slip; mengurangi kas kantor; dicocokkan dengan mutasi (US-M4-04). Diperlukan agar rekonsiliasi kas–bank M11 nol selisih [USULAN]. | ☐ | ☐ |  |
| 2 | Kas kecil (S): pengisian dari kas kantor; pengeluaran dengan kategori, pusat laba, foto bukti; pengisian atau pengeluaran > Rp 500.000 perlu persetujuan pemilik (PAR-43 [USULAN], sejalan BR-38 "di atas Rp 500.000"); rekonsiliasi fisik mingguan dengan selisih beralasan. | ☐ | ☐ |  |
| 3 | Semua mutasi kas kantor dan kas kecil menghasilkan jurnal otomatis M11 dengan pusat laba (FR-M11-02). | ☐ | ☐ |  |

### US-M4-06 Menutup kas harian dan menerbitkan ringkasan H+0 — M

**Layar:** Kas › Tutup kas (`/kas/tutup`)  
**Rujukan PRD:** baris 907

**Langkah uji:**
1. *Mulai tutup kas* → selesaikan penghalang (setoran belum diterima, shift terbuka, rit berjalan); ajukan pengecualian setoran tertunda (PAR-89).
2. Hitung fisik kas kantor → *Tutup kas* sebelum 22.00 → H+0 terbit ≤ 30 menit (cap waktu di Laporan › Hari ini).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | "Tutup kas" hanya aktif bila: semua setoran sopir hari itu Diterima/Ditutup, semua shift depot dan toko Ditutup dan setorannya Diterima atau tercatat setor bank, tidak ada rit Berangkat/Tiba, dan hari sebelumnya sudah ditutup [USULAN]. Sumber yang menghalangi ditampilkan dengan tombol hubungi. | ☐ | ☐ |  |
| 2 | Pengecualian (PTB-21, CR-06): pemilik dapat mengizinkan tutup kas dengan setoran tertunda **per kejadian** (bukan izin tetap) untuk sumber yang berhalangan, dengan alasan (6.2a); setoran tertunda maksimal 1 hari (PAR-89), tercatat sebagai pengecualian di H+0, tetap memblokir rit sopir tersebut (BR-10), dan kasnya harus diterima ≤ 24 jam — lewat itu menjadi selisih yang mengikuti US-M4-03. | ☐ | ☐ |  |
| 3 | Layar tutup kas menampilkan seluruh selisih hari itu (alasan, status), transfer belum dicocokkan, dan kas kantor sistem vs hitung fisik; selisih kas kantor wajib alasan dan mengikuti alur selisih. | ☐ | ☐ |  |
| 4 | Waktu setoran terakhir hari itu Diterima, "mulai tutup kas", dan "kas ditutup" tercatat; KPI-02 = setoran terakhir Diterima → kas ditutup (Bab 1.3); tutup setelah PAR-06 ditandai terlambat. | ☐ | ☐ |  |
| 5 | Setelah ditutup, ringkasan H+0 terbit otomatis ≤ 30 menit (NFR-04) ke pemilik (notifikasi + dashboard M9): omzet per lini, kas seharusnya vs diterima, selisih dan alasan, piutang terbentuk/dilunasi/lewat tempo, rit terjadwal vs selesai per truk, galon per depot, transfer belum dicocokkan, pengecualian hari itu. | ☐ | ☐ |  |
| 6 | Pemilik menyetujui atau menolak penjelasan selisih langsung dari ringkasan (satu ketuk per selisih); penolakan mengembalikan selisih ke Admin Keuangan (US-M4-03). | ☐ | ☐ |  |
| 7 | Hari yang ditutup terkunci; transaksi terlambat sinkron masuk hari itu dengan penanda dan kasnya ke setoran hari berikutnya (Bab 5.3); koreksi hanya lewat transaksi pembalik (BR-38). | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| NFR-22 | Impor berkas mutasi dari bank yang dipakai PT (format asli CSV/Excel) berhasil dan usulan pasangan benar. | ☐ | ☐ |  |
| D-12 butir 4 / B-79 | Setiap rekening bank punya akun buku sendiri (tidak ada penanda *Akun buku dipakai bersama* di Kas kantor). | ☐ | ☐ |  |
| NFR-04 | Pada hari uji, selisih waktu tutup kas → H+0 terbit ≤ 30 menit. | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M4 Kas & Setoran**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Admin Keuangan — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-06; P-01 langkah 9; P-02 langkah 6 |
| Data uji | 18 sumber kas satu hari (7 sopir, 10 depot, toko); skenario selisih ≥ dan < ambang PAR-01 |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M4-01 |  | __ / __ |  |
| US-M4-02 |  | __ / __ |  |
| US-M4-03 |  | __ / __ |  |
| US-M4-04 |  | __ / __ |  |
| US-M4-05 |  | __ / __ |  |
| US-M4-06 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
