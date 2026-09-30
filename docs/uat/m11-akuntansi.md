# UAT M11 — Akuntansi & Pajak

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Admin Keuangan (bersama akuntan) |
| Skenario BRD | P-07 |
| User story diuji (PRD 11.3) | US-M11-01 s.d. US-M11-06, US-M11-08 s.d. US-M11-10 (M); US-M11-07 (S) |
| Data uji | Jurnal otomatis dari data pilot; saldo awal draf; tutup periode uji; daftar aset dari akuntan & notaris |
| Akun uji | Admin Keuangan (`keuangan1`), pemilik (`pemilik`), akuntan (`akuntan`, baca-saja) |
| Panduan pengguna | `docs/guides/m11-accounting.md` |
| Jumlah | 10 user story · 47 KP |

## Persiapan

- [ ] Bagan akun & pemetaan bawaan (seed produksi) ditinjau akuntan; pemilik menekan *Aktifkan M11* setelah tinjauan (B-84).
- [ ] Periode uji terbuka; tanggal cut-over ditetapkan pemilik (tanggal 1).
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M11-01 Bagan akun dan pusat laba — M

**Layar:** Akuntansi › Bagan akun (`/akuntansi/akun`), Pemetaan jurnal otomatis (`/akuntansi/pemetaan`)  
**Rujukan PRD:** baris 1599

**Langkah uji:**
1. Tinjau akun per pusat laba L1–L5/Umum; lengkapi pemetaan wajib; *Aktifkan M11* ditolak bila ada yang belum lengkap.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Bagan akun diimpor dari template akuntan (K9) dengan kode, nama, jenis, dan pusat laba (L1 produksi air, L2 air truk, L3 depot per outlet, L4 toko, L5 kemitraan; umum/kantor sebagai pusat biaya bersama); akun dinonaktifkan, tidak dihapus; perubahan berjejak. | ☐ | ☐ |  |
| 2 | Pemetaan peristiwa → akun (7.11.4) dikelola di dalam sistem oleh Admin Keuangan dengan tinjauan akuntan; setiap peristiwa wajib terpetakan sebelum M11 diaktifkan; peristiwa tanpa pemetaan ditolak posting dan masuk daftar tunggu, bukan hilang. | ☐ | ☐ |  |
| 3 | Pusat laba L1 diperlakukan sebagai pusat biaya yang dialokasikan ke L2 dan L3 setiap akhir bulan menurut proporsi volume pengisian (PAR-65; PTB-39 [KEPUTUSAN]); alokasi tampil terpisah pada laba rugi per lini. | ☐ | ☐ |  |
| 4 | Transfer internal (BR-33, PTB-37) memakai akun pendapatan/beban internal berpasangan sehingga konsolidasi mengeliminasinya otomatis. | ☐ | ☐ |  |
| 5 | Biaya bersama (kantor, Admin Keuangan, IT) dapat dialokasikan ke lini menurut kunci yang ditetapkan pemilik (omzet atau tetap) atau dibiarkan di pusat biaya bersama [USULAN]. | ☐ | ☐ |  |

### US-M11-02 Jurnal otomatis dari seluruh transaksi operasional — M

**Layar:** Akuntansi › Jurnal (`/akuntansi/jurnal`, *Daftar tunggu*, *Rekonsiliasi harian*)  
**Rujukan PRD:** baris 1609

**Langkah uji:**
1. Transaksi pilot (rit, POS, setoran, pembelian) → jurnal otomatis tertaut sumber (*Lihat jurnal* dari rincian transaksi); daftar tunggu kosong; rekonsiliasi harian = H+0.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Setiap peristiwa 7.11.4 menghasilkan jurnal saat peristiwanya sah (tersinkron dan, bila perlu, disetujui), dengan rujukan ke objek sumber (nomor rit, shift, nota, faktur) dan pusat laba; jurnal otomatis tidak dapat diubah manual (P-07 langkah 1) — hanya dibalik lewat koreksi berjejak sumbernya (BR-38). | ☐ | ☐ |  |
| 2 | Tanggal jurnal = tanggal bisnis peristiwa (Bab 5.3); peristiwa terlambat sinkron yang masuk periode Ditutup/Dikunci diposting ke periode terbuka pertama dengan penanda "asal periode …" (FR-M11-10). | ☐ | ☐ |  |
| 3 | Kesetimbangan debit–kredit diperiksa setiap posting; jurnal yang gagal terposting (pemetaan hilang, akun nonaktif) masuk daftar tunggu dengan alasan dan notifikasi Admin Keuangan; tidak ada peristiwa yang terlewat diam-diam. | ☐ | ☐ |  |
| 4 | Bila M11 diaktifkan setelah modul operasional berjalan (R04, maksimal 2 bulan), jurnal untuk seluruh peristiwa sejak tanggal cut-over dibangkitkan retroaktif dari data operasional dan diverifikasi akuntan sebelum periode pertama ditutup (PTB-47). | ☐ | ☐ |  |
| 5 | Akuntan (baca-saja) dapat menelusuri setiap jurnal ke transaksi sumbernya dan sebaliknya; jurnal per hari per modul dapat direkonsiliasi dengan ringkasan H+0 (jumlah dan nilai sama). | ☐ | ☐ |  |

### US-M11-03 Jurnal manual dengan lampiran dan persetujuan — M

**Layar:** Akuntansi › Jurnal › Jurnal manual baru  
**Rujukan PRD:** baris 1619

**Langkah uji:**
1. Jurnal ≤ Rp 5 juta berlampiran → terposting + daftar tinjauan pemilik; > Rp 5 juta → persetujuan; akrual dibalik otomatis; *Balik jurnal* beralasan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Jurnal manual: tanggal, akun debit/kredit, pusat laba, jumlah, keterangan, lampiran wajib (foto/PDF bukti); template untuk jenis berulang (gaji, sewa, listrik, BBM, pemeliharaan, biaya bank) [USULAN]. | ☐ | ☐ |  |
| 2 | Jurnal > Rp 5 juta (PAR-20; BR-35 "di atas Rp 5 juta") diajukan ke pemilik lewat alur persetujuan (US-M10-04) sebelum terposting; jurnal ≤ Rp 5 juta terposting oleh Admin Keuangan dan masuk daftar tinjauan wajib pemilik — periode tidak dapat ditutup sebelum pemilik menandai daftar itu "ditinjau" (PTB-12, CR-04). | ☐ | ☐ |  |
| 3 | Jurnal manual terposting tidak dapat diubah; koreksi lewat jurnal pembalik beralasan; > Rp 500.000 dengan persetujuan pemilik (BR-38). | ☐ | ☐ |  |
| 4 | Jurnal berulang (sewa, penyusutan bukan — otomatis) dapat dijadwalkan bulanan sebagai draf yang tetap memerlukan lampiran dan persetujuan sesuai ambang. | ☐ | ☐ |  |
| 5 | Gaji dicatat sebagai jurnal manual total per bulan dari rekap penggajian di luar sistem; potongan ganti rugi dari rekap dicatat sebagai pelunasan piutang karyawan (PTB-22). | ☐ | ☐ |  |
| 6 | Jurnal akrual (P-07 langkah 3): jurnal manual bertanda "akrual" (misalnya listrik, sewa, atau gaji yang belum dibayar pada akhir bulan) dibalik otomatis pada tanggal 1 periode berikutnya; mengikuti ambang dan lampiran KP-2; daftar jenis akrual dan metodenya ditetapkan konsultan akuntan (K9). | ☐ | ☐ |  |

### US-M11-04 Buku besar dan laporan keuangan — M

**Layar:** Akuntansi › Buku besar, Laporan keuangan (`/akuntansi/laporan`)  
**Rujukan PRD:** baris 1630

**Langkah uji:**
1. Laba rugi per lini (alokasi L1 & biaya bersama terpisah, eliminasi internal), neraca, arus kas; telusur akun → jurnal → transaksi; ekspor.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Buku besar per akun dan pusat laba; neraca saldo; laba rugi per lini (L1–L5, dengan alokasi L1 dan biaya bersama terpisah) dan konsolidasi (eliminasi transfer internal); neraca; arus kas metode langsung dari akun kas/bank (PTB-45 [USULAN]); semua per periode dan kumulatif tahun berjalan. | ☐ | ☐ |  |
| 2 | Laporan berlabel "Sementara" pada periode terbuka dan "Final" setelah dikunci; versi Final tersimpan dan identik saat dibuka ulang (US-M9-03 KP-4). | ☐ | ☐ |  |
| 3 | Setiap angka laporan dapat diturunkan ke jurnal dan ke transaksi sumber (ketertelusuran dua arah). | ☐ | ☐ |  |
| 4 | Ekspor Excel/PDF (US-M9-03) dan ekspor jurnal ke format konsultan (US-M11-08). | ☐ | ☐ |  |
| 5 | Laporan bulan pertama setelah cut-over ditinjau akuntan sebagai bukti TG-8 (BRD 12.2); catatan tinjauan disimpan di periode. | ☐ | ☐ |  |

### US-M11-05 Aset tetap dan penyusutan otomatis — M

**Layar:** Akuntansi › Aset tetap (`/akuntansi/aset`)  
**Rujukan PRD:** baris 1640

**Langkah uji:**
1. Impor daftar aset → pemilik menandatangani → penyusutan otomatis tgl 1; ubah umur → jurnal penyesuaian; lepas aset → laba/rugi pelepasan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Daftar aset: kategori (truk, instalasi sumber air, peralatan depot, bangunan, lainnya), tanggal perolehan, nilai (ditetapkan akuntan dan notaris, K15), umur ekonomis dan metode (ditetapkan akuntan; bawaan garis lurus, PAR-63), pusat laba pemakai (truk → L2; instalasi → L1; peralatan depot → L3 per outlet; bangunan → sesuai pemakaian), nilai sisa; impor dari template pada bulan 6–8 dan ditandatangani pemilik (NFR-34). | ☐ | ☐ |  |
| 2 | Penyusutan bulanan diposting otomatis pada hari pertama tutup periode; dapat dihitung ulang bila umur/nilai diubah akuntan dengan jurnal penyesuaian berjejak. | ☐ | ☐ |  |
| 3 | Aset yang tidak masuk PT dan disewakan ke PT (K15) tidak masuk daftar aset; sewanya dicatat sebagai jurnal manual berulang (US-M11-03 KP-4). | ☐ | ☐ |  |
| 4 | Penambahan aset baru dari pembelian (nota) atau jurnal manual; pelepasan/penjualan aset dengan laba-rugi pelepasan otomatis; riwayat per aset. | ☐ | ☐ |  |
| 5 | Laporan daftar aset dan akumulasi penyusutan per periode untuk akuntan dan pajak. | ☐ | ☐ |  |

### US-M11-06 Rekonsiliasi bank dan kas — M

**Layar:** Akuntansi › Rekonsiliasi bank & kas (`/akuntansi/rekonsiliasi`)  
**Rujukan PRD:** baris 1650

**Langkah uji:**
1. Isi saldo rekening koran per rekening (akun buku sendiri per rekening); item pencocokan terisi otomatis; selisih kas beralasan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Rekonsiliasi bank per rekening per periode: saldo rekening (input dari rekening koran atau impor berkas, FR-M4-04 S) vs saldo buku; item penyesuai: transfer belum dicocokkan, setoran dalam perjalanan, biaya/bunga bank (jurnal manual), transfer tidak ditemukan (US-M4-04 KP-4); selisih harus nol untuk menutup periode. | ☐ | ☐ |  |
| 2 | Rekonsiliasi kas: kas kantor (hitung fisik harian dari US-M4-06), kas awal tetap outlet, kas di tangan sopir (harus nol setelah setoran diterima), kas kecil (S) vs buku; selisih beralasan mengikuti alur selisih M4. | ☐ | ☐ |  |
| 3 | Hasil rekonsiliasi (nol selisih, siapa, kapan, item penyesuai) disimpan per periode dan tampil bagi akuntan. | ☐ | ☐ |  |
| 4 | Pencocokan harian di M4 mengisi rekonsiliasi bulanan secara otomatis; hanya item tersisa yang dikerjakan saat tutup buku. | ☐ | ☐ |  |

### US-M11-07 Utang usaha kepada pemasok — S

**Layar:** Akuntansi › Utang usaha (`/akuntansi/utang`)  
**Rujukan PRD:** baris 1659

**Langkah uji:**
1. Utang pemasok toko (M7) & utang manual; jatuh tempo; pembayaran jurnal *membayar utang*.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Utang terbentuk dari nota pembelian M7 dan jurnal manual bertanda utang; umur utang; jadwal pembayaran; pembayaran dari M4 mengurangi utang. | ☐ | ☐ |  |
| 2 | Saldo awal utang saat cut-over dari nota (BRD 10.3) ditandatangani pemilik. | ☐ | ☐ |  |
| 3 | Laporan utang per pemasok dan jatuh tempo; pengingat (Bab 6.3). | ☐ | ☐ |  |

### US-M11-08 Pelaporan pajak PT non-PKP dan pemantauan batas PKP — M

**Layar:** Akuntansi › Pajak (`/akuntansi/pajak`)  
**Rujukan PRD:** baris 1667

**Langkah uji:**
1. Omzet bruto bulanan per lini (internal dikecualikan), estimasi PPh final, pemantauan PKP 12 bulan (sama dengan dasbor M9); ekspor format konsultan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Sistem tidak memungut PPN dan tidak menerbitkan faktur pajak (BR-29); faktur dan struk bertuliskan identitas PT tanpa komponen PPN. | ☐ | ☐ |  |
| 2 | Omzet bruto bulanan per lini (pendapatan luar; transfer internal dikecualikan) tersedia sebagai laporan dan ekspor; bila konsultan menetapkan PPh final UMKM 0,5% (BR-30), sistem menampilkan estimasi PPh final bulanan sebagai informasi (PAR-64); skema lain diinput sebagai parameter oleh Admin Keuangan. | ☐ | ☐ |  |
| 3 | Ekspor jurnal, buku besar, dan omzet ke format yang disepakati konsultan pajak pada bulan 1 (NFR-23); format dapat diubah tanpa rilis aplikasi [USULAN: template ekspor terkonfigurasi]. | ☐ | ☐ |  |
| 4 | Pemantauan PKP (FR-M11-12): omzet bruto 12 bulan berjalan (seluruh lini, pendapatan luar) dibandingkan dengan Rp 4,8 miliar (PAR-22); peringatan ke pemilik dan Admin Keuangan pada 80% dan 90% (BR-29), tampil di dashboard M9; proyeksi sederhana bulan tercapainya batas berdasarkan rata-rata 3 bulan [USULAN]. | ☐ | ☐ |  |
| 5 | Retensi: pembukuan dan bukti transaksi digital tersimpan ≥ 10 tahun (BR-31; PAR-29) dengan salinan bulanan (NFR-13). | ☐ | ☐ |  |

### US-M11-09 Saldo awal dan cut-over akuntansi — M

**Layar:** Akuntansi › Saldo awal (`/akuntansi/saldo-awal`)  
**Rujukan PRD:** baris 1677

**Langkah uji:**
1. Tetapkan cut-over (tanggal 1); isi tiap kelompok → pemilik menandatangani → akuntan mengesahkan → posting; jurnal sebelum cut-over ditolak (EQ006) kecuali saldo awal.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Cut-over hanya dapat ditetapkan pada tanggal 1 (NFR-36); transaksi operasional sebelum tanggal itu tidak dimigrasi (BRD 10.3); sistem menolak jurnal bertanggal sebelum cut-over kecuali jurnal saldo awal. | ☐ | ☐ |  |
| 2 | Jurnal saldo awal memuat kas dan bank (hitung fisik dan saldo rekening), piutang per faktur (US-M5-07), utang pemasok per nota, persediaan toko dan bahan depot (opname cut-over), aset tetap (US-M11-05), dan ekuitas penyeimbang; setiap kelompok ditandatangani pemilik (NFR-34) dan seluruhnya disahkan akuntan sebelum terposting. | ☐ | ☐ |  |
| 3 | Penyesuaian saldo awal setelah cut-over hanya lewat jurnal "penyesuaian saldo awal" dengan persetujuan pemilik dan catatan akuntan, paling lama 3 bulan setelah cut-over (PAR-62, PTB-44); setelah itu koreksi mengikuti jurnal biasa. | ☐ | ☐ |  |
| 4 | Bila modul operasional go-live lebih dulu dan M11 menyusul (R04), tanggal cut-over akuntansi tetap tanggal 1 bulan go-live operasional dan jurnal dibangkitkan retroaktif (PTB-47); laporan bulan-bulan itu berlabel "dibangkitkan retroaktif, diverifikasi akuntan". | ☐ | ☐ |  |

### US-M11-10 Tutup dan kunci periode — M

**Layar:** Akuntansi › Periode (`/akuntansi/periode/[id]`)  
**Rujukan PRD:** baris 1686

**Langkah uji:**
1. Prasyarat tutup (hari kas ditutup, rekonsiliasi, daftar tunggu, penyusutan, tinjauan) → *Tutup periode* → pemilik *Kunci*; posting ke periode terkunci ditolak; buka kembali beralasan → revisi.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Prasyarat tutup periode (diperiksa sistem): semua hari kas periode itu Ditutup (M4); rekonsiliasi bank dan kas nol selisih (US-M11-06); tidak ada jurnal di daftar tunggu; penyusutan terposting; jurnal manual > Rp 5 juta periode itu disetujui atau ditolak dan daftar tinjauan jurnal ≤ Rp 5 juta ditandai pemilik (US-M11-03 KP-2); opname toko bulan itu selesai (US-M7-05); alokasi L1 dan biaya bersama terposting. Prasyarat yang belum terpenuhi ditampilkan dengan tautan ke tindakannya. | ☐ | ☐ |  |
| 2 | Admin Keuangan menutup periode; pemilik mengunci; pengingat pada tanggal 5 dan 8 bila belum ditutup [USULAN, PAR-71]; tutup setelah tanggal 10 ditandai terlambat (BR-32). | ☐ | ☐ |  |
| 3 | Periode Dikunci menolak semua posting; koreksi hanya lewat jurnal periode berikutnya dengan rujukan ke periode asal (FR-M11-10). | ☐ | ☐ |  |
| 4 | Pemilik dapat membuka periode terkunci dengan alasan (BR-32); pembukaan dan seluruh tindakan sesudahnya berjejak dan diberitahukan ke akuntan; laporan Final periode itu tersimpan sebagai versi sebelumnya dan versi baru diberi nomor revisi. | ☐ | ☐ |  |
| 5 | Tutup buku bulan pertama setelah cut-over menjadi bukti TG-8 (BRD 12.2) dengan catatan tinjauan akuntan. | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| B-57 | Akuntan meninjau kategori arus kas metode langsung (heuristik nama/induk akun lawan) terhadap bagan akun final. | ☐ | ☐ |  |
| B-76 | Akuntan meninjau alokasi biaya L1 → L3 per outlet (volume pasokan) dan eliminasi markup transfer internal toko → depot (rata-rata tertimbang). | ☐ | ☐ |  |
| NFR-23 | Konsultan pajak memvalidasi format ekspor jurnal/buku besar (template dapat diubah tanpa rilis). | ☐ | ☐ |  |
| B-84 / D-13 butir 3 | Berita acara tinjauan pemetaan oleh akuntan ditandatangani sebelum pemilik menekan *Aktifkan M11*. | ☐ | ☐ |  |
| NFR-36 | Transaksi bertanggal sebelum cut-over ditolak; jurnal saldo awal diterima. | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M11 Akuntansi & Pajak**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Admin Keuangan (bersama akuntan) — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-07 |
| Data uji | Jurnal otomatis dari data pilot; saldo awal draf; tutup periode uji; daftar aset dari akuntan & notaris |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M11-01 |  | __ / __ |  |
| US-M11-02 |  | __ / __ |  |
| US-M11-03 |  | __ / __ |  |
| US-M11-04 |  | __ / __ |  |
| US-M11-05 |  | __ / __ |  |
| US-M11-06 |  | __ / __ |  |
| US-M11-07 |  | __ / __ |  |
| US-M11-08 |  | __ / __ |  |
| US-M11-09 |  | __ / __ |  |
| US-M11-10 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
