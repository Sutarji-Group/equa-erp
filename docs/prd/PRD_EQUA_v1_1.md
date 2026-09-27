# Product Requirements Document (PRD)
# Program Digitalisasi Terpadu EQUA

**Versi 1.1 — Draf penyelarasan dengan BRD, diajukan untuk persetujuan bersama BRD v1.1**
Tanggal: 27 September 2026

| Item | Keterangan |
|---|---|
| Dokumen induk | BRD Program Digitalisasi Terpadu EQUA v1.0 (8 September 2026, belum ditandatangani) — baseline cakupan, tujuan, ukuran keberhasilan, dan aturan bisnis. Perubahan yang diusulkan untuk BRD v1.1 dirangkum di Lampiran D; BRD v1.1 dan PRD v1.1 ditandatangani dalam sesi yang sama |
| Sponsor | Pemilik EQUA |
| Penyusun | Product Manager |
| Pembaca utama | Tim IT internal (manajer proyek, arsitek/analis, pengembang, QA, dukungan lapangan), pemilik modul (BRD 12.1), komite pengarah |
| Status | v1.1 — draf penyelarasan hasil tinjauan PRD ↔ BRD (27 Sep 2026); diajukan untuk persetujuan pemilik modul dan komite pengarah bersama BRD v1.1 (Bab 14). Tahap 1 rinci hingga kriteria penerimaan (95 user story); Tahap 2 untuk estimasi (8 user story); Tahap 3 untuk estimasi (7 user story) kecuali Paket Minimum Mitra Fase 1 yang untuk dibangun (4 user story); 62 PTB: 15 diputuskan, 47 terbuka — hanya kelas C yang berlaku sebagai bawaan (Bab 13); 18 usulan perubahan BRD (Lampiran D) |
| Penanda | **[ASUMSI-PRD]** = asumsi penyusun PRD, belum dikonfirmasi · **[USULAN]** = rincian yang tidak tertulis di BRD dan diusulkan PRD; dapat ditolak tanpa mengubah BRD · **[KEPUTUSAN]** = memerlukan keputusan pemilik atau komite pengarah · **CR-nn** = usulan perubahan BRD v1.1 (Lampiran D) · **Kelas A/B/C** pada PTB = mengubah BRD / menambah perilaku di luar BRD / merinci BRD (Bab 13) |
| Konvensi ID | `US-Mx-nn` user story Tahap 1 per modul · `US-P2-nn` Tahap 2 · `US-P3-nn` Tahap 3 · `KP-n` kriteria penerimaan di dalam satu user story · `PTB-nn` pertanyaan terbuka (Bab 13; v1.0: `PT-nn`) · `PAR-nn` parameter terkonfigurasi (Lampiran B) · `RL-n` rilis produk (Bab 11; v1.0: `R0`–`R6`) · `CR-nn` usulan perubahan BRD (Lampiran D). ID BRD (P, T, K, FR, NFR, BR, B, R, A, EP) dipakai sebagai rujukan dengan penamaan BRD v1.1: `KPI-nn` ukuran keberhasilan (BRD v1.0: `K01`–`K11`) dan `TG-n` tonggak (BRD v1.0: `T0`–`T9`), agar tidak bertabrakan dengan keputusan `K1`–`K25` dan tujuan `T1`–`T6` (CR-10; pemetaan di Bab 0.5) |

### Riwayat Versi

| Versi | Tanggal | Perubahan |
|---|---|---|
| 0.1 | 9 Sep 2026 | Bagian A (Bab 0–6), Bab 7.1 M1, Bab 7.2 M2, Bab 13 register awal, Lampiran B |
| 0.2 | 10 Sep 2026 | Bab 7.3 M3, 7.4 M4, 7.5 M5; PTB-01, PTB-02, PTB-05 disetujui; PTB-18 s.d. PTB-29 dan PAR-36 s.d. PAR-45 ditambahkan; Bab 6.3 tiga peristiwa baru |
| 0.3 | 10 Sep 2026 | Bab 7.9 M9, 7.10 M10, 7.12 M12; PTB-06, PTB-10, PTB-11 disetujui; PTB-30 s.d. PTB-36 dan PAR-46 s.d. PAR-56 ditambahkan; Bab 6.3 tiga peristiwa baru |
| 0.4 | 10 Sep 2026 | Bab 7.6 M6, 7.7 M7, 7.8 M8, 7.11 M11 — Tahap 1 lengkap; PTB-07, PTB-20, PTB-22, PTB-24, PTB-25, PTB-28 disetujui; PTB-37 s.d. PTB-48 dan PAR-57 s.d. PAR-71 ditambahkan; Bab 6.3 empat peristiwa baru; Bab 2.2 hitungan prioritas efektif |
| 0.5 | 10 Sep 2026 | Bab 8 (Tahap 2, 8 user story), Bab 9 (Tahap 3, 7 user story), Bab 10 (36 NFR → verifikasi); PTB-17, PTB-37, PTB-39 disetujui; PTB-49 s.d. PTB-60 dan PAR-72 s.d. PAR-81 ditambahkan |
| 1.0 | 10 Sep 2026 | Bab 11 (rilis, UAT, pilot, cut-over, pengendalian perubahan), Bab 12 (risiko dan ketergantungan produk), Bab 14 (persetujuan), Lampiran A (matriks ketertelusuran, dibangkitkan dari dokumen), Lampiran C (glosarium tambahan); konsolidasi untuk persetujuan |
| 1.1 | 27 Sep 2026 | Penyelarasan dengan BRD v1.0 hasil tinjauan PRD ↔ BRD: (1) kunci rit BR-10 dipisahkan dari keputusan pemilik atas selisih (5.2, US-M4-02; PTB-62); (2) PTB diberi kelas A/B/C, hanya kelas C berlaku sebagai bawaan (0.2, 11.7, 13, 14), daftar usulan perubahan BRD v1.1 (Lampiran D); (3) Lampiran A dibangkitkan ulang dengan `tools/trace_check.py` dan penggantian ID KPI/TG/RL/PTB (0.5); (4) Paket Minimum Mitra Fase 1 sesuai K17 (9.10, RL-7, PTB-61); (5) PAR-33 kapasitas 3 rit/truk termasuk rit internal; (6) BR-01 ditegakkan penuh dengan status "Tempo migrasi" (US-M1-01, US-M1-06, PAR-82); (7) US-M2-11 baru (M) dan US-M12-08 KP-1–2 menjadi M (0.2 butir 6); (8) matriks persetujuan dipecah 6.2a/6.2b/6.2c dengan perilaku bila lewat tenggat; (9) kriteria tarik nota kertas unit perluasan (11.5, PAR-84, PAR-88); (10) definisi KPI-01 dan KPI-02 (1.3); (11) persetujuan pemilik untuk akun/peran (US-M10-01 KP-8); minor: ambang "> Rp 5 juta", jurnal akrual (US-M11-03 KP-6), utilisasi dua tingkat, syarat masuk RL-1, PAR-58 = 0 selama pilot, jendela pemeliharaan (PAR-86), POS toko tablet Android, tenggat jawaban masukan lapangan (PAR-87); daftar tambahan prioritas M (2.4) |

---

# Bab 0 — Hubungan dengan BRD & Cara Membaca

## 0.1 Posisi dokumen

| Dokumen | Menjawab | Pemilik | Status |
|---|---|---|---|
| BRD v1.0 → v1.1 | *Mengapa* dan *apa* dari sisi bisnis: masalah, tujuan, cakupan, aturan bisnis, keputusan pemilik | Pemilik EQUA | v1.0 belum ditandatangani; menjadi v1.1 setelah CR di Lampiran D diputuskan, lalu ditandatangani bersama PRD v1.1 |
| **PRD (dokumen ini)** | *Apa yang harus dilakukan produk* agar BRD terpenuhi: perilaku per peran, kriteria penerimaan yang dapat diuji, siklus status objek, pengecualian, parameter | Product Manager; disetujui pemilik modul | v1.1 draf; disetujui bersama BRD v1.1 (Bab 14) |
| Desain fungsional & teknis | *Bagaimana* membangunnya: rancangan layar, model data fisik, API, arsitektur, rencana uji | Tim IT | Setelah PRD per modul disetujui |

## 0.2 Aturan penyusunan PRD

1. **Tidak menambah cakupan.** Setiap user story merujuk minimal satu ID BRD. Rincian yang tidak tertulis di BRD diberi [USULAN] atau [KEPUTUSAN] dan dicatat di Bab 13; penerimaannya mengikuti pengendalian perubahan BRD Bab 12.4.
2. **Prioritas diwarisi.** User story mewarisi MoSCoW dari FR rujukannya. Bila satu user story menurunkan beberapa FR dengan prioritas berbeda, kriteria penerimaannya ditandai per prioritas.
3. **Dapat diuji.** Setiap kriteria penerimaan ditulis agar QA dan pemilik modul dapat menjawab lulus/gagal pada UAT (BRD 12.6) dengan skenario BRD Bab 5 (P-01 s.d. P-07).
4. **Istilah lapangan.** Memakai istilah BRD (rit, setor, galon, tutup kas, tutup shift), bukan istilah teknis (NFR-15).
5. **Tahap 2 dan 3 dirinci dengan pola yang sama**, diturunkan dari EP-2-xx, EP-3-xx, BRD 3.4, 3.5, dan Bab 9. Karena BRD menetapkan rinciannya baru dikunci setelah Bab 9 disetujui dan Tahap 1 stabil, seluruh rincian Tahap 2–3 yang melampaui teks BRD berpenanda [USULAN] dan berstatus "untuk estimasi", bukan "untuk dibangun" (PTB-17). Pengecualian: Paket Minimum Mitra Fase 1 (Bab 9.10) berstatus "untuk dibangun" sesuai K17 (PTB-61, CR-15).
6. **Kebutuhan M tidak boleh bergantung pada fitur S/C.** Bila kriteria penerimaan ber-prioritas M membutuhkan sebagian fitur S/C, bagian minimal fitur itu dinaikkan ke M secara eksplisit dan dicatat di Bab 2.4, atau kriteria tersebut memiliki jalur cadangan yang tertulis.
7. **Usulan hanya berlaku sesuai kelasnya.** Setiap PTB diberi kelas A (mengubah BRD), B (menambah perilaku di luar BRD), atau C (merinci BRD). Hanya kelas C yang berlaku sebagai bawaan setelah PRD disetujui; kelas A melalui CR BRD (Lampiran D, BRD 12.4) dan kelas B melalui keputusan komite pengarah (Bab 13, 11.7). Tag [USULAN] di dalam kriteria penerimaan mengikuti aturan yang sama: yang memblokir transaksi atau pengguna, menambah langkah wajib pengguna lapangan, membuat objek atau aturan keuangan baru, ber-prioritas M, atau langsung dirasakan pelanggan/mitra diperlakukan sebagai kelas B.
8. **Ketertelusuran dibangkitkan, bukan ditulis tangan.** Lampiran A dibangkitkan ulang dengan `tools/trace_check.py` pada setiap versi PRD; rujukan palsu harus 0 (syarat keluar RL-0).

## 0.3 Struktur dokumen (rencana lengkap)

| Bagian | Bab | Isi | Status v1.1 |
|---|---|---|---|
| A — Fondasi produk | 0–6 | Kontrol dokumen; ringkasan & instrumentasi KPI; prinsip & batasan; pengguna & persona; arsitektur produk; objek & siklus status; aturan lintas modul | Lengkap |
| B — Tahap 1 | 7.1–7.12 | Kebutuhan produk per modul M1–M12 | Lengkap |
| C — Tahap 2 | 8 | Aplikasi Pelanggan (EP-2-01 s.d. EP-2-07) | Lengkap, untuk estimasi (PTB-17) |
| D — Tahap 3 | 9 | Portal Kemitraan/Frenchise (EP-3-01 s.d. EP-3-06, BRD Bab 9) | Lengkap, untuk estimasi (PTB-17); Paket Minimum Mitra Fase 1 untuk dibangun (9.10) |
| E — Kualitas & rilis | 10–14 | NFR produk; rilis, pilot & penerimaan; risiko & ketergantungan produk; register pertanyaan & keputusan; persetujuan PRD | Lengkap |
| Lampiran | A–D | Matriks ketertelusuran FR/NFR/BR → US (dibangkitkan skrip); parameter terkonfigurasi; glosarium tambahan; usulan perubahan BRD v1.1 | Lengkap |

Riwayat penyusunan: v0.1 Bagian A, M1, M2; v0.2 M3–M5; v0.3 M9, M10, M12; v0.4 M6–M8, M11; v0.5 Bab 8–10; v1.0 Bab 11–12, 14, Lampiran A dan C; v1.1 penyelarasan dengan BRD (Riwayat Versi) dan Lampiran D. Perubahan setelah persetujuan mengikuti Bab 11.7.

## 0.4 Pola penulisan satu modul

Setiap modul di Bagian B ditulis dengan pola tetap: (1) tujuan dan hasil bisnis yang dijawab; (2) peran dan antarmuka; (3) objek dan status yang dikelola; (4) user story dengan kriteria penerimaan; (5) aturan bisnis yang dipaksakan sistem; (6) pengecualian, offline, dan kegagalan; (7) di luar cakupan modul; (8) hal terbuka.

## 0.5 Pemetaan ID lama → baru (v1.1)

| Kelompok | BRD v1.0 / PRD v1.0 | BRD v1.1 / PRD v1.1 | Alasan |
|---|---|---|---|
| Ukuran keberhasilan (KPI) | K01–K11 | KPI-01–KPI-11 | K10/K11 identik dengan keputusan K10 (badan usaha) dan K11 (sumber data GPS) |
| Tonggak proyek | T0–T9 | TG-0–TG-9 | Bentrok dengan tujuan bisnis T1–T6 |
| Rilis produk | R0–R6 | RL-0–RL-6 (ditambah RL-7) | Mirip ID risiko R01–R14 (R4 vs R04) |
| Pertanyaan terbuka | PT-01–PT-60 | PTB-01–PTB-62 | Rancu dengan "PT" (badan usaha perseroan terbatas) |

Keputusan K1–K25, tujuan T1–T6, risiko R01–R14, dan ID BRD lain tidak berubah. Penggantian ID di BRD diusulkan sebagai CR-10.

---

# Bab 1 — Ringkasan Produk & Instrumentasi KPI

## 1.1 Produk

Satu platform di atas satu basis data (Google Cloud, region Jakarta; K5) dengan empat antarmuka: **web kantor** (pemilik, Admin Keuangan, Dispatcher, admin sistem), **aplikasi lapangan Android** (sopir/kernet, operator produksi), **POS multi-tenant** (depot dan toko; kelak mitra), dan — pada tahap berikutnya — **aplikasi pelanggan** (Tahap 2) serta **portal mitra** (Tahap 3). Pelanggan, harga, produk, dan kas dicatat sekali dan dipakai semua modul (BRD 3.1 prinsip 1).

Nilai inti produk Tahap 1: **setiap rupiah dan setiap rit tercatat di sumbernya oleh orang yang melakukannya; sistem menghitung angka "seharusnya"; manusia hanya memasukkan angka "kenyataan" dan menjelaskan selisihnya** (BRD Bab 5).

## 1.2 Dari masalah ke kemampuan produk

| Masalah (BRD 2.1) | Tujuan (BRD 2.2) | Kemampuan produk yang menjawabnya | Modul |
|---|---|---|---|
| P1 Kas di 18 titik tanpa rekonsiliasi | T1 | Pencatatan pembayaran per rit/transaksi di perangkat lapangan; saldo kas "seharusnya" per sumber berjalan otomatis; setoran dengan selisih dihitung sistem, wajib alasan, alur tindak lanjut; tutup kas harian yang tidak dapat ditutup bila ada setoran belum diterima | M3, M6, M7, M4, M10 |
| P2 Piutang informal | T2 | Piutang terbentuk otomatis dari pengiriman/penjualan tempo; jatuh tempo dan batas kredit per pelanggan; blokir pesanan tempo otomatis; pengingat; umur piutang; faktur bulanan | M5, M2, M1 |
| P3 Pengiriman lewat telepon dan ingatan | T3 (T6 pada Tahap 2) | Nomor dan status pesanan; papan jadwal per truk; aplikasi sopir dengan bukti kirim; pencocokan lokasi GPS; konfirmasi dan struk WA | M2, M3, M12 |
| P4 Laba per lini tidak diketahui | T4 | Dashboard H+0; jurnal otomatis per pusat laba; laba kotor per lini; neraca air; jejak audit | M9, M11, M8, M10 |
| P5 Belum ada standar untuk mitra | T5 | POS depot yang sama untuk banyak outlet dan banyak pemilik sejak hari pertama; neraca air per outlet; catatan mutu | M6, M8 |

## 1.3 Instrumentasi KPI

BRD 2.3 menetapkan 11 KPI (KPI-01–KPI-11; BRD v1.0: K01–K11, CR-10); produk harus menghasilkan datanya tanpa pencatatan tambahan oleh pemilik.

| KPI | Cara produk mengukur | Sumber | Catatan |
|---|---|---|---|
| KPI-01 Transaksi tercatat hari yang sama | Transaksi lapangan (rit Selesai, transaksi POS depot/toko, pembacaan meter, pengisian) yang (a) dicatat di perangkat sumber oleh pelakunya **dan** (b) tersinkron sebelum hari kasnya ditutup ÷ seluruh transaksi lapangan hari itu. Transaksi "dicatat kantor" (Bab 6.1) dan "terlambat sinkron" (Bab 5.3) dihitung tidak memenuhi | M3, M6, M7, M8, M4 | Tersedia sejak pilot; target 100% |
| KPI-02 Waktu rekonsiliasi harian | Durasi dari setoran terakhir hari itu berstatus Diterima sampai "kas ditutup" oleh Admin Keuangan (P-06 langkah 1–3), dihitung otomatis dari log. Ukuran pendukung (baseline, tanpa target): total waktu aktif Admin Keuangan di layar pencocokan transfer, selisih, dan tutup kas per hari | M4, M10 | Target ≤ 15 menit |
| KPI-03 Selisih tak terjelaskan > 24 jam | Jumlah selisih yang belum berstatus Selesai lebih dari 24 jam sejak terbentuk | M4 | Target 0/bulan |
| KPI-04 Piutang lewat tempo | Nilai faktur lewat jatuh tempo ÷ total piutang terbuka, per akhir hari | M5 | Target < 5% |
| KPI-05 Pesanan bernomor & berstatus | 100% menurut rancangan (US-M2-02); diverifikasi selama pilot dan periode paralel: setiap nota kertas dan setiap rit yang terdeteksi GPS harus punya nomor pesanan di sistem (lembar pencocokan NFR-35; US-M12-05) | M2, M12 | Target 100% |
| KPI-06 Pesanan terlewat/dobel | Pesanan lewat tanggal diminta tanpa penjadwalan ulang beralasan + pesanan dibatalkan dengan alasan "dobel" | M2 | Target 0/bulan |
| KPI-07 Rit terealisasi vs terjadwal | Rit Selesai ÷ rit terjadwal, per truk per hari; rit pelanggan dan rit internal (pasokan depot) dilaporkan terpisah dan gabungan; baseline dipakai mengalibrasi PAR-33 | M2, M3 | Baseline 3 bulan |
| KPI-08 Laporan H+0 | Waktu terbit dashboard ≤ 30 menit setelah tutup kas (NFR-04) | M9 | Otomatis |
| KPI-09 Laba kotor per lini | Laporan bulanan tersedia paling lambat tanggal 10 (BR-32) | M11 | — |
| KPI-10 Waktu pemilik untuk pencatatan | Diukur lewat catatan pemilik (di luar produk) dan diinput di halaman KPI (US-M9-07); produk menyediakan total durasi sesi pemilik per bulan sebagai pembanding [USULAN] | M9, M10 | Baseline diukur sebelum go-live |
| KPI-11 Adopsi lapangan | Pengguna aktif per peran per hari ÷ jumlah karyawan pada peran itu (US-M10-01); tanggal nota kertas ditarik per unit dicatat (11.5, US-M9-07) | M10, M9 | Target 100% |

---

# Bab 2 — Prinsip & Batasan Produk

## 2.1 Prinsip desain produk (turunan BRD 3.1)

| Prinsip BRD | Konsekuensi konkret pada produk |
|---|---|
| Satu platform, satu data | Tidak ada modul yang menyimpan salinan pelanggan, harga, atau produk sendiri; setiap transaksi merujuk ID master. Harga di transaksi diambil dari master pada saat transaksi dan dikunci bersama transaksinya |
| Kas dulu, fitur belakangan | Versi pilot memuat seluruh kebutuhan M; kebutuhan S dikerjakan setelah M lulus uji internal dan dibekukan 4 minggu sebelum pilot (BRD 12.4). Kebutuhan C tidak dibangun di Tahap 1. Tiga kebutuhan S analitik (FR-M7-05, FR-M9-06, FR-M12-07) dijadwalkan ke RL-6 sebagai kompensasi tambahan M (Bab 2.4) |
| Dirancang untuk lapangan | Aplikasi sopir dan POS: Bahasa Indonesia, maksimal 3 langkah per tindakan, tombol besar, teks ≥ 16 pt, offline minimal 1 hari, hemat baterai dan kuota (FR-M3-09, NFR-15 s.d. NFR-18) |
| Bangun sekali untuk depot sendiri, bawa ke mitra | M6 multi-tenant sejak hari pertama (FR-M6-07, NFR-30); tidak ada logika "khusus EQUA" yang tertanam di POS |
| Bertahap dengan pilot | Setiap unit (truk, depot) dapat diaktifkan satu per satu; nota kertas paralel maksimal 2 minggu per unit (NFR-35); fitur dapat dimatikan per unit tanpa rilis ulang [USULAN] |

## 2.2 Cakupan produk per tahap

| Tahap | Produk | Cakupan di PRD ini |
|---|---|---|
| 1 | Sistem Inti Operasional: M1–M12 | Bab 7, rinci hingga kriteria penerimaan; 66 M, 22 S, 2 C menurut BRD v1.0 — efektif 68 M, 20 S, 2 C setelah PTB-06 (FR-M10-05) dan PTB-07 (FR-M6-04) naik ke M; ditambah bagian M pada empat FR ber-prioritas S dan tiga FR S yang dijadwalkan ke RL-6 (Bab 2.4) |
| 2 | Aplikasi Pelanggan: EP-2-01 s.d. EP-2-07 | Bab 8, pola yang sama; [USULAN] untuk rincian di luar BRD |
| 3 | Portal Kemitraan/Frenchise: EP-3-01 s.d. EP-3-06 + kontrol BRD 9.9 | Bab 9, pola yang sama; bergantung pada skema BRD Bab 9 (K17–K19); Paket Minimum Mitra Fase 1 untuk dibangun (Bab 9.10, RL-7) sesuai K17 |

**Di luar cakupan produk** (BRD 3.3, 3.6): integrasi gerbang pembayaran digital pada Tahap 1 (pencatatan transfer/QRIS manual tetap masuk), manajemen pemeliharaan armada, penggajian dan HR (sistem hanya mengirim rekap ganti rugi, BR-11), sensor/IoT sumber air, ekspansi ke luar Kabupaten Cianjur.

## 2.3 Batasan yang membentuk produk (turunan BRD 3.7)

| Batasan | Dampak pada produk |
|---|---|
| B1 Tim IT 15 orang | Produk dibangun berdasarkan PRD ini; permintaan di luar PRD masuk daftar tunggu (BRD 12.4) |
| B2 Google Cloud, daring sejak awal | Kantor bekerja daring; hanya aplikasi lapangan dan POS yang offline-first |
| B6 Pengguna lapangan belum pernah memakai sistem | Alur ≤ 3 langkah; tidak ada istilah teknis; kesalahan ditangani dengan pesan tindakan, bukan kode |
| B7 Akuntansi lengkap, neraca awal oleh konsultan | Semua transaksi operasional membawa dimensi pusat laba (L1–L5) sejak awal, meski M11 dibangun belakangan; saldo awal per tanggal cut-over tanggal 1 (NFR-36) |
| B8 GPS terpasang sebelum pilot | M12 memakai penghubung vendor yang dapat diganti (NFR-21); GPS ponsel hanya cadangan |
| B9 PT non-PKP | Struk, faktur, dan laporan memakai identitas PT setelah PT berdiri; sebelum itu memakai nama usaha "EQUA" [USULAN]; tidak ada PPN dan faktur pajak; pemantauan omzet 12 bulan terhadap batas PKP (FR-M11-12) |

## 2.4 Daftar tambahan prioritas M terhadap BRD v1.0 (v1.1)

Mengikuti Bab 0.2 butir 6–7, setiap kenaikan ke M dicatat di sini. **Koreksi konsistensi** = BRD sendiri mewajibkannya lewat kebutuhan M lain; cukup dicatat di BRD v1.1. **Tambahan** = cakupan baru yang mengikuti aturan tukar BRD 12.4.

| Item | Jenis | Dasar | Status |
|---|---|---|---|
| FR-M10-05 login PIN + perangkat terdaftar (S → M) | Koreksi konsistensi | NFR-09 (M), K24 | Disetujui (PTB-06); CR-01 |
| FR-M6-04 stok bahan habis pakai depot (S → M) | Koreksi konsistensi | BR-27; P-02 langkah 1 dan 5 | Disetujui (PTB-07); CR-02 |
| FR-M4-04 bagian pencatatan dan pencocokan manual transfer | Koreksi konsistensi | FR-M11-06 (M); P-06 langkah 2 | PTB-16; CR-05 |
| FR-M9-04 bagian infrastruktur notifikasi | Koreksi konsistensi | BR-09; FR-M4-03 (M) | Disetujui (PTB-05); CR-13 |
| FR-M2-10 bagian penetapan pengemudi pengganti harian (US-M2-11) | Koreksi konsistensi | FR-M3-09 (M); BR-36 | CR-13 |
| FR-M12-08 bagian deteksi perangkat mati, peringatan, dan aktivasi GPS ponsel (US-M12-08 KP-1–2) | Koreksi konsistensi | NFR-28 (M); FR-M12-06 (M) | CR-13 |
| Setor ke bank oleh Admin Keuangan (US-M4-05 KP-1) | Koreksi konsistensi | FR-M11-06 (M): rekonsiliasi kas–bank nol selisih | Dicatat |
| Struk digital WA versi tautan (US-M3-03 KP-7) | Koreksi konsistensi | P-01 langkah 7 sebagai skenario UAT (BRD 12.6) | PTB-29; CR-08 |
| Laporan biaya produksi air per liter L1 (US-M9-02 KP-6) | Koreksi konsistensi | Menjaga maksud FR-M11-01 setelah L1 menjadi pusat biaya | PTB-39; CR-09 |
| Transfer internal bahan toko → depot (US-M7-06) | Tambahan | Integritas kartu stok FR-M7-02 dan FR-M6-04 | Disetujui (PTB-37); tukar CR-14 |
| Autentikasi dua faktor pemilik, Admin Keuangan, admin sistem (US-M10-02 KP-4) | Tambahan | R09 (dampak tinggi) | PTB-35; tukar CR-14 |
| Lokasi pool/garasi di master (US-M12-05) | Tambahan | Mencegah alarm palsu BR-25 | PTB-34; tukar CR-14 |

**Kompensasi (aturan tukar, CR-14).** FR-M7-05 (barang laris/mati), FR-M9-06 (tren), dan FR-M12-07 (biaya BBM per rit) — ketiganya S — dikeluarkan dari versi pilot dan dijadwalkan ke RL-6 (stabilisasi bulan 11–12, "penyempurnaan laporan" BRD 3.8). Selama itu kebutuhan analitik dilayani ekspor Excel (FR-M9-03, M). Kesetaraan tukar dikonfirmasi manajer proyek IT dengan estimasi (≤ 5 hari kerja, BRD 12.4 langkah 2) sebelum sesi keputusan.

---
# Bab 3 — Pengguna & Persona

## 3.1 Persona pengguna sistem

| Persona | Jumlah | Perangkat & tempat | Situasi kerja | Tujuan utama | Yang harus dihindari produk | Modul |
|---|---|---|---|---|---|---|
| **Sopir** | 7 | Ponsel Android milik perusahaan, di kabin truk, sinyal tidak menentu, sinar matahari | Mengemudi, memikul selang, menerima uang, dikejar rit berikutnya | Tahu rit berikutnya, selesai cepat, setoran jelas dan tidak dicurigai tanpa dasar | Ketik panjang, menu bertingkat, sinkron yang menghilangkan data, harga yang harus dihitung sendiri | M3, M12 |
| **Kernet** | 7 | Perangkat truk yang sama | Membantu sopir; sesekali menggantikan sopir (FR-M3-09) | Bisa melanjutkan rit bila sopir berhalangan | Berbagi PIN sopir (BR-36) | M3 |
| **Dispatcher** | 1–2 | Laptop/PC kantor, telepon dan WA terus berbunyi | Menerima pesanan sambil menyusun jadwal; sore H-1 dan pagi H paling sibuk | Input pesanan < 60 detik; tidak ada pesanan terlewat/dobel; beban truk merata; tahu posisi truk | Layar yang memaksa pindah halaman; kontrol kredit yang tidak jelas alasannya | M1, M2, M12 |
| **Admin Keuangan** (peran baru, K6) | 1 (+1 cadangan, R13) | Laptop kantor; puncak kerja sore–malam saat setoran masuk | Menerima 18 setoran, mencocokkan transfer, menutup kas ≤ 22.00, menjaga piutang, jurnal | Tutup kas ≤ 15 menit; setiap selisih terlacak ke rit/shift; tutup buku tepat waktu | Mengetik ulang angka lapangan; selisih tanpa jejak; kewenangan yang tumpang tindih dengan pesanan | M4, M5, M11, M9 |
| **Operator depot** | 10 | Ponsel/tablet Android di meja kasir; antrean pagi dan sore | ±100 transaksi kecil/hari, sering sendirian, memegang kas ≤ Rp 2 juta | Transaksi ≤ 10 detik; buka/tutup shift sederhana; setoran jelas | Konfirmasi berlapis; input stok panjang di jam ramai | M6 |
| **Kasir toko** | 1 | Tablet/PC di toko | Melayani mitra depot dan umum; menerima barang pemasok; opname | Harga mitra otomatis; stok akurat; tahu barang laris/mati | Diskon bebas; barang tanpa nota | M7, M5 (mitra) |
| **Operator produksi** | ±6 (2 lokasi) | Ponsel Android di sumber air | Mencatat meter pagi/malam, mengisi truk, memasok depot | Input sederhana di lokasi; foto meter sekali klik | Formulir panjang; harus daring | M8 |
| **Pemilik** | 1 | Web di laptop dan ponsel; kapan saja, sering di luar kantor | Membaca ringkasan H+0, menyetujui pengecualian, memutuskan | Satu layar "hari ini": omzet, kas, selisih, piutang, rit, galon; persetujuan sekali ketuk | Menginput transaksi harian; notifikasi yang terlalu banyak | M9, persetujuan lintas modul, M1 (harga) |
| **Admin sistem (IT)** | 2–3 | Web | Mengelola pengguna, peran, perangkat, pemantauan | Onboarding/offboarding cepat; perangkat terkendali | Mengubah transaksi keuangan (dilarang) | M10 |
| **Akuntan/konsultan** [USULAN] | 1 | Web, baca-saja | Meninjau jurnal, tutup buku, ekspor pajak selama 3 bulan pendampingan (K9) | Melihat jurnal dan laporan tanpa meminta ekspor manual | Hak tulis | M11 (baca), ekspor |
| **Pelanggan truk** (Tahap 2) | 300 | Ponsel pribadi | Memesan, menunggu, membayar | Kepastian jadwal, bukti volume, tagihan jelas | Proses yang belum disiplin terlihat ke pelanggan (BRD 3.4) | Aplikasi pelanggan |
| **Mitra depot & operatornya** (Tahap 3) | 3–5, lalu hingga 10/tahun | POS yang sama; portal mitra | Menjalankan depot dengan pasokan EQUA | Sistem siap pakai, adil, transparan; hanya melihat outletnya | Data mitra lain terlihat (NFR-30) | M6, portal |
| **Pembina wilayah EQUA** (Tahap 3) | 1–2 | Web | Mengaudit dan membina mitra | Skor mutu, neraca air per mitra, royalti | — | Portal |

## 3.2 Hak akses per peran

Mengikuti BRD 4.2 tanpa perubahan. Tambahan yang diusulkan PRD:

| # | Usulan | Alasan | Penanda |
|---|---|---|---|
| 1 | Kernet memiliki akun sendiri dengan peran "Kernet": membaca daftar rit truknya; dapat melakukan tindakan sopir (status, bukti kirim, pembayaran, setor) hanya pada hari Dispatcher menetapkannya sebagai pengemudi pengganti (US-M2-11, M) | Memenuhi FR-M3-09 tanpa melanggar BR-36 (satu orang satu akun) dan menjaga akuntabilitas kas | [USULAN] PTB-10 — disetujui 10 Sep 2026 |
| 2 | Peran "Akuntan" baca-saja pada M11 dan laporan, berlaku selama masa pendampingan dan dapat dinonaktifkan pemilik | P-07 langkah 5–6 mensyaratkan tinjauan akuntan | [USULAN] PTB-11 — disetujui 10 Sep 2026 |
| 3 | Login PIN + perangkat terdaftar (FR-M10-05) diperlakukan sebagai M | NFR-09 berprioritas M dan K24 mewajibkannya | [USULAN] PTB-06 — disetujui 10 Sep 2026 |
| 4 | Autentikasi dua faktor pada web kantor untuk pemilik, Admin Keuangan, dan admin sistem | Ketiganya memegang persetujuan uang, kas, atau hak akses (R09) | [USULAN] PTB-35 — rekomendasi v1.1; tambahan (Bab 2.4) |
| 5 | Pembuatan akun, pemberian/perubahan peran, dan perluasan lingkup aktif setelah disetujui pemilik; pencabutan berlaku seketika | BRD 10.2 ("atas persetujuan pemilik"), BR-37 | Penyelarasan ke BRD (US-M10-01 KP-8) |
| 6 | Peran "Pemilik mitra" (baca-saja, lingkup tenant sendiri) untuk Mitra Fase 1 | BRD 9.5 dan 9.8 (akses laporan sendiri) | [USULAN] PTB-61 (US-P3-10) |

---

# Bab 4 — Arsitektur Produk (tingkat produk)

## 4.1 Antarmuka

| Antarmuka | Pengguna | Modul | Sifat | Tahap |
|---|---|---|---|---|
| Web kantor (responsif, NFR-19) | Pemilik, Admin Keuangan, Dispatcher, admin sistem, akuntan (baca) | M1, M2, M4, M5, M9, M10, M11, M12 (pantau), persetujuan | Daring; sesi kedaluwarsa otomatis | 1 |
| Aplikasi lapangan Android | Sopir, kernet, operator produksi | M3, M8, pelaporan kendala (FR-M3-10) | Offline-first; PIN + perangkat terdaftar; unduhan kecil (NFR-17) | 1 |
| POS (tablet/ponsel Android; multi-tenant) | Operator depot, kasir toko; mitra dan operatornya pada Tahap 3 | M6, M7 | Offline-first; satu aplikasi untuk semua outlet/tenant, termasuk toko (tablet Android menggantikan opsi PC di BRD 10.5, CR-16); printer bluetooth opsional (NFR-25, C) | 1 |
| Penghubung perangkat GPS | Sistem | M12 | Menerima posisi dari perangkat vendor; modul terpisah agar vendor dapat diganti (NFR-21) | 1 |
| Layanan pesan WA | Sistem → pelanggan | M2, M3, M5 | Semi-otomatis lewat tautan (K21); dapat ditingkatkan ke WhatsApp Business API (NFR-20) | 1 → 2 |
| Aplikasi pelanggan | Pelanggan truk dan depot | Bab 8 | Mulai setelah Tahap 1 stabil ≥ 3 bulan | 2 |
| Portal mitra | Mitra, pembina wilayah | Bab 9 | Paket Minimum Mitra Fase 1 (Bab 9.10) pada RL-7; portal lengkap setelah skema BRD Bab 9 dan legal siap | 3 |

## 4.2 Integrasi & perilaku cadangan

| Integrasi | Dipakai untuk | Perilaku produk bila tidak tersedia | Rujukan |
|---|---|---|---|
| Peta komersial | Koordinat alamat, jarak zona, navigasi sopir | Koordinat diambil dari GPS sopir pada pengiriman pertama; navigasi dibuka di aplikasi peta ponsel | NFR-24, BRD 10.2 |
| Perangkat GPS vendor | Posisi real-time, jejak, geofence | GPS ponsel sopir sebagai cadangan (hanya saat rit aktif, hemat baterai); peringatan perangkat mati > 15 menit | K11, FR-M12-06, FR-M12-08 |
| WhatsApp (tautan) | Konfirmasi pesanan, struk, pengingat | Pengguna membuka tautan; sistem mencatat "dibuka" saat tautan diklik; tidak ada bukti terkirim/terbaca | K21, NFR-20 |
| Impor mutasi bank (berkas) | Pencocokan transfer masuk | Pencocokan manual oleh Admin Keuangan tetap dimungkinkan (M) | FR-M4-04 (S), FR-M11-06 (M), PTB-16 |
| Ekspor Excel/PDF; format konsultan pajak | Semua laporan; jurnal | — | NFR-23, FR-M9-03 |
| Printer struk bluetooth | Struk depot/toko | Struk digital via WA atau tanpa struk (struk opsional, P-02) | NFR-25 (C) |

## 4.3 Model multi-tenant (NFR-30, FR-M6-07)

- **Tenant** = satu pemilik usaha: EQUA sendiri adalah tenant pertama; setiap mitra depot (Tahap 3) adalah tenant terpisah.
- **Outlet** = satu depot atau toko di bawah satu tenant; pengguna outlet hanya melihat outletnya.
- **Pembina EQUA** memiliki hak baca lintas tenant hanya untuk data yang diperjanjikan (penjualan, neraca air, mutu), bukan seluruh data tenant [USULAN, mengikuti BRD 9.9 dan 10.6].
- Katalog produk depot dan harga dikelola per tenant; katalog standar EQUA menjadi bawaan yang disalin ke tenant baru [USULAN].
- Tidak ada laporan lintas tenant di POS; agregasi hanya di web EQUA.

---
# Bab 5 — Objek Produk & Siklus Status

## 5.1 Kamus objek

| Objek | Definisi | Pemilik data (BRD 10.2) | Modul utama |
|---|---|---|---|
| Pelanggan | Pihak yang membeli air truk atau barang toko; punya segmen, status kredit, batas, tempo, harga khusus; dapat ditandai "mitra toko" (BR-18) | Dispatcher | M1 |
| Alamat kirim | Satu titik kirim milik pelanggan dengan koordinat dan satu zona tarif; pelanggan dapat memiliki banyak alamat | Dispatcher | M1 |
| Zona tarif | Rentang jarak dari sumber air acuan dengan tarif per rit | Pemilik | M1 |
| Produk & harga | Katalog tiga lini: air truk (zona + komponen BBM), produk depot, barang toko (harga mitra dan umum); berlaku per tanggal | Pemilik (toko: kasir, disetujui Admin Keuangan) | M1, M7 |
| Pesanan | Permintaan pelanggan (atau permintaan internal pasokan depot, PTB-01) untuk sejumlah tangki pada tanggal tertentu; bernomor dan berstatus | Sistem, dari Dispatcher | M2 |
| Rit | Satu perjalanan truk 5.000 L untuk satu alamat kirim (PTB-09); pesanan dengan n tangki menghasilkan n rit | Sistem | M2, M3 |
| Bukti kirim | Foto, nama dan tanda tangan penerima, volume terkirim, waktu dan lokasi "Selesai" | Sopir | M3 |
| Pembayaran rit | Tunai (jumlah), transfer (foto bukti), atau tempo (membentuk piutang) | Sopir | M3, M5 |
| Setoran sopir | Ringkasan kas seharusnya satu sopir satu hari dan jumlah fisik yang diterima Admin Keuangan | Sopir → Admin Keuangan | M4 |
| Selisih | Perbedaan seharusnya vs diterima per sumber per hari, dengan alasan, status tindak lanjut, dan keputusan pemilik | Admin Keuangan / Pemilik | M4 |
| Shift depot | Periode kerja satu operator di satu outlet: kas awal, transaksi, kas akhir fisik, stok fisik, selisih | Operator | M6 |
| Transaksi POS | Penjualan depot/toko: baris produk, jumlah, harga, cara bayar; dapat di-void dengan alasan, tidak dapat dihapus | Operator/kasir | M6, M7 |
| Stok | Kartu stok per barang toko dan bahan habis pakai per outlet depot; penerimaan, penjualan, opname, penyesuaian | Kasir; operator | M7, M6 |
| Faktur / piutang | Tagihan tempo per pengiriman atau penjualan toko, atau faktur bulanan gabungan; jatuh tempo; alokasi pelunasan | Sistem | M5 |
| Sumber air & catatan produksi | Angka meter awal/akhir per hari per sumber dengan foto; pengisian truk; pasokan depot; neraca air | Operator produksi | M8 |
| Armada, perangkat, kru, jadwal kru | Truk dengan kapasitas, GPS, kru default; perangkat ponsel terdaftar; jadwal kerja dan libur | Dispatcher; admin sistem | M1, M2, M10 |
| Pengguna & peran | Satu orang satu akun; peran sesuai BRD 4.2; PIN; perangkat | Admin sistem atas persetujuan pemilik | M10 |
| Persetujuan | Permintaan tindakan yang memerlukan penyetuju (Bab 6.2): pemohon, objek, alasan, keputusan, waktu | Sistem | M10 |
| Notifikasi & pengecualian | Peristiwa yang harus ditindaklanjuti seseorang dalam tenggat (Bab 6.3) | Sistem | M9, M10 |
| Jejak audit | Siapa mengubah apa, kapan, nilai lama, nilai baru; tidak dapat diubah | Sistem | M10 |
| Akun, jurnal, periode | Bagan akun per pusat laba; jurnal otomatis dan manual; periode bulanan terbuka/ditutup/dikunci | Admin Keuangan; akuntan | M11 |
| Aset tetap | Daftar aset PT dengan nilai, umur, penyusutan otomatis | Admin Keuangan; akuntan | M11 |
| Tenant & outlet | Lihat Bab 4.3 | Pemilik | M6, M10 |

## 5.2 Siklus status

### Pesanan (FR-M2-02)

| Status | Masuk ketika | Keluar ke | Pelaku | Catatan |
|---|---|---|---|---|
| Baru | Pesanan disimpan | Terjadwal; Dibatalkan; Menunggu persetujuan | Dispatcher | Sub-status "Menunggu persetujuan" bila tempo melampaui kontrol kredit (FR-M2-05) |
| Terjadwal | Semua rit pesanan ditugaskan ke truk dan diterbitkan ke aplikasi sopir | Dalam pengiriman; Baru (ditarik dari jadwal); Dibatalkan | Dispatcher | Pesanan berulang masuk sebagai Baru dengan tanda "langganan" |
| Dalam pengiriman | Rit pertama berstatus Berangkat | Selesai; Baru (rit gagal, perlu jadwal ulang) | Sistem, dari sopir | Tidak dapat dibatalkan dari kantor; rit gagal dicatat sebagai kejadian (FR-M2-09) |
| Selesai | Semua rit Selesai dengan bukti kirim | — | Sistem | Terkunci; koreksi hanya lewat transaksi pembalik (BR-38) |
| Dibatalkan | Dibatalkan dengan alasan | — | Dispatcher | Alasan dari daftar + teks; alasan "dobel" dihitung pada KPI-06 |

### Rit

| Status | Masuk ketika | Pelaku | Syarat |
|---|---|---|---|
| Ditugaskan | Ditempatkan pada truk dan urutan, lalu diterbitkan | Dispatcher | Truk aktif; kru tersedia; setoran sopir hari sebelumnya Ditutup (BR-10) — bila belum, rit tampil di aplikasi tetapi terkunci |
| Berangkat | Sopir menekan Berangkat | Sopir / kernet pengganti | Waktu dan posisi otomatis |
| Tiba | Sopir menekan Tiba | Sopir | Waktu dan posisi otomatis |
| Selesai | Bukti kirim lengkap dan pembayaran dicatat | Sopir | Foto + nama penerima wajib (BR-22); volume ≠ 5.000 L wajib alasan; lokasi > 200 m wajib alasan, > 1 km ditandai (BR-23) |
| Gagal | Pelanggan tidak ada/menolak/jalan ditutup/truk rusak | Sopir | Alasan + foto opsional; pesanan kembali ke Baru; dua gagal berturut → konfirmasi ulang (BR-24) |

### Setoran sopir (harian, per sopir)

| Status | Masuk ketika | Pelaku |
|---|---|---|
| Berjalan | Rit pertama Selesai dengan tunai atau pelunasan diterima | Sistem |
| Diajukan | Sopir menekan "Setor" (ringkasan seharusnya terkunci) | Sopir |
| Diterima | Admin Keuangan menginput jumlah fisik; selisih dihitung sistem | Admin Keuangan |
| Ditutup | Admin Keuangan menutup setelah jumlah fisik diinput dan setiap selisih diberi alasan, berapa pun besarnya; selisih ≥ ambang diteruskan sebagai objek Selisih ke pemilik dan **tidak** menahan penutupan (BR-10 mengacu pada penutupan oleh Admin Keuangan). Pengecualian hanya bila PAR-83 diaktifkan pemilik (PTB-62) | Admin Keuangan |

Setoran depot dan toko mengikuti pola yang sama, dimulai dari "tutup shift" (M6/M7).

### Selisih (BR-09, BR-11, BR-12)

Terbentuk → Dijelaskan (alasan oleh penyetor/Admin Keuangan) → Disetujui / Ditolak (pemilik; wajib bila ≥ Rp 50.000) → Ditindaklanjuti (selisih kurang tak terjelaskan dicatat sebagai beban ganti rugi per kejadian dan masuk rekap penggajian; selisih lebih disetor penuh) → Selesai. Selisih yang belum Selesai > 24 jam dihitung pada KPI-03. Alur Selisih berjalan terpisah dari status setoran dan tidak mengunci rit sopir, kecuali PAR-83 aktif (PTB-62).

### Shift depot (M6)

Dibuka (kas awal, stok awal) → Berjalan → Ditutup (kas fisik, stok fisik, selisih otomatis, alasan) → Setoran: Belum disetor → Disetor → Diterima Admin Keuangan. Setoran > 1 hari ditandai.

### Status kredit pelanggan (BR-01, BR-03)

Tunai (bawaan) → Tempo (persetujuan pemilik; syarat ≥ 3 bulan atau ≥ 10 pesanan diperingatkan bila belum terpenuhi) → Ditahan (otomatis, lewat jatuh tempo > 7 hari) → Tempo (otomatis saat seluruh faktur lewat tempo lunas; pembukaan sebelum lunas hanya oleh pemilik dengan alasan).

### Faktur (M5)

Terbuka → Sebagian dibayar → Lunas; dimensi umur: belum jatuh tempo / 1–7 / 8–30 / > 30 hari (FR-M5-04).

### Periode akuntansi (BR-32, FR-M11-10)

Terbuka → Ditutup (Admin Keuangan; syarat rekonsiliasi bank dan kas nol selisih) → Dikunci (pemilik) → Dibuka kembali (pemilik, alasan tercatat, seluruh tindakan berjejak).

### Persetujuan (FR-M10-04)

Diajukan → Disetujui / Ditolak (dengan alasan) → Kedaluwarsa bila melewati tenggat per jenis (Bab 6.2). Pemohon tidak dapat menyetujui permintaannya sendiri (FR-M10-03).

### Perangkat lapangan (K24)

Terdaftar → Aktif (terikat pengguna) → Diblokir / Dihapus jarak jauh (BR-37).

## 5.3 Hari operasional & tanggal bisnis [USULAN]

- Jam layanan 05.00–22.00 WIB setiap hari (NFR-01). **Tanggal bisnis** sebuah transaksi = tanggal kalender WIB saat dicatat di perangkat (bukan saat tersinkron), agar transaksi offline tetap masuk hari yang benar.
- **Hari kas** ditutup Admin Keuangan paling lambat 22.00 (BR-14, K21). Transaksi lapangan yang tersinkron setelah hari kasnya ditutup tetap masuk laporan hari itu dengan penanda "terlambat sinkron" (dihitung pada KPI-01); uangnya masuk setoran hari berikutnya dengan penanda.
- Nilai uang dalam rupiah bulat; volume dalam liter bulat; galon sebagai satuan produk depot (1 galon = 19 L untuk neraca air, A9).

---

# Bab 6 — Aturan Lintas Modul

## 6.1 Tiga aturan dasar (BRD Bab 5) sebagai perilaku produk

| Aturan | Perilaku produk |
|---|---|
| Dicatat di sumber, saat terjadi, oleh pelakunya | Transaksi lapangan hanya dapat dibuat dari perangkat dan akun peran lapangan; kantor tidak memiliki layar "input rit/transaksi atas nama sopir/operator". Pengecualian darurat (perangkat rusak) hanya oleh Admin Keuangan dengan alasan dan penanda "dicatat kantor", yang masuk KPI-01 sebagai tidak-di-sumber |
| Sistem menghitung "seharusnya", manusia memasukkan "kenyataan" | Sopir dan operator tidak pernah mengetik total, harga, atau saldo; mereka memasukkan jumlah uang fisik, stok fisik, angka meter, dan volume. Selisih selalu dihitung sistem dan ditampilkan bersama alasannya |
| Tidak ada penghapusan | Tidak ada tombol hapus pada transaksi, master aktif, atau jejak audit. Koreksi = transaksi pembalik beralasan; master dinonaktifkan, bukan dihapus |

## 6.2 Pemisahan tugas & matriks persetujuan

Prinsip: pembuat transaksi bukan penerima uangnya dan bukan penyetuju koreksinya (BRD 4.2, FR-M10-03). Sistem menolak, bukan sekadar memperingatkan. Sejak v1.1 tindakan dibagi tiga jenis: **6.2a persetujuan** (pembuat ≠ penyetuju), **6.2b keputusan langsung pemilik** (tanpa langkah persetujuan, berjejak, diberitahukan), dan **6.2c pengesampingan beralasan oleh pelaku** (ditinjau setelahnya). Hanya 6.2a yang melalui alur persetujuan US-M10-04. Setiap jenis 6.2a punya perilaku bila lewat tenggat (PTB-32) sehingga operasi harian tidak menunggu pemilik.

### 6.2a Persetujuan

| Tindakan | Pemohon | Penyetuju | Ambang / syarat | Tenggat [USULAN] | Bila lewat tenggat | Rujukan |
|---|---|---|---|---|---|---|
| Selisih setoran (keputusan atas penjelasan) | Admin Keuangan (atas nama sopir/outlet) | Pemilik | ≥ Rp 50.000 per sopir/outlet per hari; di bawah itu ditutup Admin Keuangan dengan alasan. Tidak menahan penutupan setoran dan rit, kecuali PAR-83 aktif | ≤ 24 jam | Tetap terbuka, naik ke puncak kotak masuk, dihitung KPI-03 | BR-09, FR-M4-03 |
| Pesanan tempo di luar kontrol kredit | Dispatcher | Pemilik | Status Ditahan atau melampaui batas (BR-06) | Sebelum jadwal terbit | Pesanan tetap tunai atau digeser ke H+1 dengan pemberitahuan ke pelanggan | FR-M2-05 |
| Pemberian status Tempo; ubah batas/tempo per pelanggan | Dispatcher | Pemilik | Hanya bila PAR-11 dan PAR-82 terpenuhi (BR-01); rumah tangga tidak dapat Tempo (BR-04) | — | Status tetap Tunai | BR-01, BR-04 |
| Pembukaan status Ditahan sebelum lunas | Dispatcher / Admin Keuangan | Pemilik | Alasan tercatat | — | Tetap Ditahan | BR-03, FR-M5-06 |
| Perubahan harga master, zona, komponen BBM (jalur baku) | Admin Keuangan | Pemilik | Tanggal berlaku wajib | Sebelum tanggal berlaku | Harga lama tetap berlaku | BR-15, BR-19 |
| Harga khusus per pelanggan | Dispatcher | Pemilik | Alasan + tanggal berlaku; tinjauan 6 bulan | — | Harga master berlaku | BR-16 |
| Diskon kasir toko | Kasir | Pemilik | > 5% | Saat transaksi | Dianggap ditolak di akhir shift | BR-17 |
| Void POS | Operator / kasir | Pemilik (Admin Keuangan menerima notifikasi) | Void > Rp 100.000 → persetujuan; > 3 void/hari/outlet → notifikasi Admin Keuangan | Saat transaksi | Dianggap ditolak di akhir shift; transaksi tetap dihitung | BR-13 |
| Penyesuaian stok (opname) | Kasir/operator + Admin Keuangan | Pemilik | Semua penyesuaian | ≤ 3 hari | Saldo tidak berubah; tetap di daftar | BR-27, FR-M7-04 |
| Jurnal manual | Admin Keuangan | Pemilik | > Rp 5 juta: persetujuan sebelum posting; ≤ Rp 5 juta: terposting dan masuk daftar tinjauan wajib pemilik saat tutup buku; semua wajib lampiran (PTB-12) | Sebelum tutup buku | Tidak terposting; periode tidak dapat ditutup | BR-35, FR-M11-03 |
| Koreksi / transaksi pembalik | Admin Keuangan | Pemilik | > Rp 500.000 | — | Koreksi tidak berlaku | BR-38 |
| Pengisian/pengeluaran kas kecil | Admin Keuangan | Pemilik | > Rp 500.000 (PAR-43) | — | Tidak berlaku | US-M4-05 |
| Tutup kas dengan setoran tertunda | Admin Keuangan | Pemilik | Per kejadian untuk sumber berhalangan, maks. 1 hari (PAR-89); rit sopir tetap terkunci (PTB-21) | Sebelum tutup kas | Kas tidak dapat ditutup | FR-M4-06 (CR-06) |
| Pesanan baru saat kurang bayar kedua belum lunas | Dispatcher | Pemilik | Kurang bayar kedua saat yang pertama belum lunas (PTB-18) | Sebelum jadwal terbit | Pesanan tidak dapat dijadwalkan | PTB-18 |
| Ubah cara bayar tunai → tempo di lapangan | Sopir | Dispatcher | Hanya saat daring; pelanggan Tempo dan dalam batas (PTB-19) | Saat di lokasi | Dicatat sebagai kurang bayar (US-M3-04 KP-2) | FR-M2-05 |
| Tutup buku → kunci periode | Admin Keuangan | Pemilik | Rekonsiliasi nol selisih; daftar tinjauan jurnal manual ≤ Rp 5 juta ditandai | ≤ tanggal 10 | Ditandai terlambat | BR-32 |
| Akun baru; pemberian/perubahan peran; perluasan lingkup | Admin sistem | Pemilik | Semua; pencabutan akses tidak memerlukan persetujuan (BR-37) | ≤ 2 hari kerja | Akun/peran tidak aktif | BRD 10.2, FR-M10-01 |
| Satu orang lebih dari satu peran | Admin sistem | Pemilik | Alasan + masa berlaku; kombinasi terlarang PTB-31 tidak dapat diajukan | — | Tidak aktif | FR-M10-01 |

### 6.2b Keputusan langsung pemilik

| Tindakan | Syarat | Diberitahukan ke | Rujukan |
|---|---|---|---|
| Perubahan harga master, zona, komponen BBM yang diinput pemilik sendiri | Alasan dan tanggal berlaku wajib | Admin Keuangan, Dispatcher | BR-15, BR-19 |
| Perubahan parameter Lampiran B | Tanggal berlaku; berjejak | Admin Keuangan; peran terdampak | US-M10-04 KP-6 |
| Buka periode terkunci | Alasan wajib | Admin Keuangan, akuntan | BR-32 |
| Penundaan penahanan otomatis dalam masa transisi | Per pelanggan, maks. 2 bulan sejak go-live (PAR-41) | Dispatcher, Admin Keuangan | R07 |
| Status "Tempo migrasi" pelanggan tempo lama | Bagian tanda tangan data awal (NFR-34) | Admin Keuangan | BR-01 (CR-12) |

### 6.2c Pengesampingan beralasan oleh pelaku

| Tindakan | Pelaku | Syarat | Ditinjau oleh | Rujukan |
|---|---|---|---|---|
| Pesanan H+0 setelah 15.00 | Dispatcher | Alasan wajib | Pemilik (laporan bulanan) | BR-20 |
| Pesanan tambahan walau terdeteksi dobel | Dispatcher | Alasan wajib | Laporan KPI-06 | FR-M2-04 |
| Volume parsial | Sopir | Alasan dari daftar | Dispatcher, Admin Keuangan | BR-22 |
| Lokasi Selesai > 200 m | Sopir | Alasan wajib; > 1 km masuk daftar tinjauan pemilik | Pemilik | BR-23 |
| Keterangan perjalanan di luar jadwal/jam | Sopir | Hari yang sama | Pemilik | BR-25 |
| Ekspor data pelanggan/mitra | Pemilik / Admin Keuangan | Tujuan tercatat | Log akses | BR-39 |

Pemohon tidak pernah dapat menyetujui permintaannya sendiri (FR-M10-03). Tindakan 6.2b dan 6.2c bukan permintaan persetujuan, tetapi tetap berjejak (US-M10-04 KP-2, US-M10-05).

## 6.3 Katalog pengecualian & notifikasi

Kanal notifikasi otomatis tidak ditetapkan BRD. **[KEPUTUSAN PTB-05]** PRD mengasumsikan: pusat notifikasi di dalam web/aplikasi + push notification Android sebagai kanal utama; e-mail ringkasan harian ke pemilik sebagai cadangan; WA hanya untuk pelanggan (semi-otomatis, K21).

| Peristiwa | Pemicu | Penerima | Tindak lanjut & tenggat | Rujukan |
|---|---|---|---|---|
| Selisih setoran ≥ ambang | Setoran Diterima dengan selisih ≥ Rp 50.000 | Pemilik, Admin Keuangan | Alasan dan keputusan ≤ 24 jam | BR-09 |
| Setoran belum diterima saat tutup kas | Admin Keuangan memulai tutup kas | Admin Keuangan | Tidak dapat menutup (FR-M4-06) | P-06 |
| Setoran depot terlambat | > 1 hari sejak tutup shift | Admin Keuangan | Tagih setoran | P-02 langkah 6 |
| Kurang bayar di lapangan | Tunai diterima < harga pesanan (US-M3-04) | Admin Keuangan, Dispatcher | Faktur jatuh tempo H+0; pesanan berikutnya bertanda "tagih kurang bayar"; kurang bayar kedua saat yang pertama belum lunas → pesanan baru perlu persetujuan pemilik (6.2a) | PTB-18 |
| Transfer tidak ditemukan | > 2 hari tanpa mutasi bank (PAR-39) | Pemilik, Admin Keuangan | Tindak lanjut ke pelanggan/penyetor | US-M4-04 |
| Keterangan perjalanan belum diisi | Tugas BR-25 masih terbuka saat tutup kas | Pemilik | Tinjau; minta keterangan | BR-25, US-M3-06 |
| Kas outlet melebihi batas | Kas berjalan > Rp 2 juta | Operator, Admin Keuangan | Setor sebagian | BR-08 |
| Void berlebih | > 3 void/hari/outlet | Admin Keuangan | Tinjau | BR-13 |
| Pesanan dobel | Pelanggan + alamat + hari sama | Dispatcher | Konfirmasi atau batalkan | FR-M2-04 |
| Pesanan belum terjadwal | Pesanan untuk hari ini tanpa truk pada pagi H | Dispatcher | Jadwalkan | FR-M2-03 |
| Rit gagal; dua gagal berturut | Sopir menandai Gagal | Dispatcher | Jadwal ulang; konfirmasi ulang | FR-M2-09, BR-24 |
| Penyimpangan lokasi > 1 km | Rit Selesai | Pemilik | Tinjau H+0 | BR-23, FR-M12-03 |
| Perjalanan di luar jadwal/jam | Truk bergerak tanpa rit aktif atau di luar 05.00–22.00 | Pemilik, Dispatcher | Keterangan sopir hari yang sama | BR-25, FR-M12-04 |
| Perangkat GPS mati/dicabut | > 15 menit tanpa sinyal pada jam layanan | Tim IT, Dispatcher | Periksa | FR-M12-08, NFR-28 |
| Berhenti tidak dikenal saat rit aktif | > 15 menit di luar alamat rit, sumber, depot, pool (PAR-51) | Dispatcher, Pemilik | Keterangan sopir hari yang sama | US-M12-05 |
| Sumber lokasi tidak konsisten | Titik Selesai ponsel vs posisi perangkat GPS beda > 200 m | Pemilik | Tinjau H+0 | US-M12-04 |
| Permintaan persetujuan lewat tenggat | Tenggat Bab 6.2 terlampaui | Pemilik | Putuskan; naik ke puncak kotak masuk | US-M10-04 |
| Neraca air outlet melebihi toleransi | Galon terjual × 19 L > air tersedia + PAR-59 (mingguan) | Pemilik | Periksa pasokan/pencatatan outlet | US-M6-05 |
| Pasokan depot belum dikonfirmasi | Lewat tutup shift berikutnya (PAR-61) | Admin Keuangan | Konfirmasi operator | US-M6-05 |
| Produksi belum tercatat / susut negatif | Pembacaan meter terlewat; pengisian > produksi | Pemilik, Admin Keuangan | Lengkapi/verifikasi | US-M8-01, US-M8-04 |
| Periode belum ditutup | Tanggal 5 dan 8 bulan berikutnya (PAR-71) | Admin Keuangan, Pemilik | Tutup ≤ tanggal 10 (BR-32) | US-M11-10 |
| Susut air di atas ambang | Neraca air harian: susut > 5% | Pemilik, operator produksi | Investigasi | BR-26 |
| Utilisasi sumber > 90% | Harian: penanda di dashboard dan H+0; > 90% selama 3 hari berturut (PAR-85): notifikasi push | Pemilik | Rencana kapasitas | FR-M8-04 (S), P-04 langkah 5 |
| Piutang H-3 / H+1 | Jadwal | Pelanggan (WA), Admin Keuangan | Pengingat | FR-M5-05 (S) |
| Status kredit Ditahan | Lewat tempo > 7 hari | Dispatcher, Admin Keuangan, Pemilik | Tagih; terbuka otomatis saat lunas | BR-03 |
| Omzet 12 bulan mendekati batas PKP | ≥ 80% dan ≥ 90% dari Rp 4,8 miliar | Pemilik, Admin Keuangan | Siapkan pengukuhan PKP | BR-29, FR-M11-12 |
| Stok minimum toko | Stok ≤ minimum | Kasir | Daftar pesan ulang | FR-M7-02 |
| Harga khusus lewat 6 bulan | Bulanan | Pemilik | Tinjau | BR-16 |
| Sinkron gagal massal; layanan mati | Pemantauan | Tim IT | Insiden kritis ≤ 30 menit | NFR-28, NFR-31 |
| Permintaan akses menunggu | Akun, peran, atau lingkup diajukan admin sistem | Pemilik | Putuskan ≤ 2 hari kerja | US-M10-01 KP-8 |
| Selisih besar mengunci rit | PAR-83 aktif dan selisih kurang ≥ ambang belum diputuskan | Pemilik, Dispatcher | Putuskan sebelum rit pertama esok hari | PTB-62 |
| Pesanan air mitra lewat SLA | Belum Selesai > 24 jam sejak dibuat (PAR-76) | Dispatcher, Pemilik | Jadwalkan segera | US-P3-08 |
| Permintaan dukungan mitra lewat SLA | Belum ditanggapi > 48 jam (PAR-76) | Pemilik | Tindak lanjut | US-P3-11 |
| Masukan lapangan belum dijawab | > 1 minggu (PAR-87) | Manajer proyek IT | Jawab | US-M10-07 KP-3, BRD 12.5 |

Setiap notifikasi memuat objek, nilai, dan tautan ke tindakan; notifikasi yang telah ditindaklanjuti berubah status, tidak dihapus. Pemilik dapat mengatur jam tenang untuk notifikasi non-kritis [USULAN].

## 6.4 Offline-first (NFR-06 s.d. NFR-08)

1. Aplikasi sopir dan POS menyimpan transaksi di perangkat minimal 1 hari penuh; antrean terlihat pengguna dengan status "tersimpan di ponsel" / "terkirim".
2. Sinkron otomatis ≤ 5 menit setelah sinyal kembali; setiap transaksi punya ID unik yang dibuat di perangkat sehingga pengiriman ulang tidak menggandakan.
3. Data yang dibuat di lapangan tidak pernah ditimpa kantor. Perubahan kantor terhadap objek yang sama menghasilkan versi baru dengan jejak audit; konflik ditampilkan ke Admin Keuangan, bukan diselesaikan diam-diam.
4. Data referensi yang diperlukan offline (rit hari ini, harga, katalog produk) diunduh saat login dan diperbarui di latar; ukurannya dijaga tim IT agar kuota ≤ 50 MB/bulan per sopir (NFR-17).
5. Tindakan yang mustahil offline (persetujuan pemilik, kontrol kredit untuk pesanan baru) tidak diberikan ke peran lapangan.
6. Jam perangkat: transaksi memakai waktu perangkat dan mencatat selisih terhadap waktu server saat sinkron; selisih > 10 menit ditandai [USULAN].

## 6.5 Identitas, perangkat & sesi

- Satu orang satu akun (BR-36); login lapangan dengan PIN pada perangkat milik perusahaan yang terdaftar (K24; FR-M10-05 diperlakukan M, PTB-06); akun dinonaktifkan seketika saat karyawan keluar dan perangkat dapat dihapus jarak jauh (BR-37).
- Web kantor: kata sandi + sesi kedaluwarsa otomatis (NFR-09); autentikasi dua faktor untuk pemilik, Admin Keuangan, dan admin sistem (PTB-35); akses konsol cloud di luar produk (BRD 10.4).
- Perangkat truk dipakai bergantian oleh sopir dan kernet dengan PIN masing-masing; pergantian pengguna tidak menghapus antrean offline.

## 6.6 Uang, satuan, waktu, bahasa

Rupiah bulat tanpa desimal; liter dan galon; waktu WIB; tanggal bisnis Bab 5.3; seluruh teks Bahasa Indonesia dengan istilah Lampiran A BRD; format nomor dokumen ditetapkan di modul masing-masing [USULAN]. **Konvensi ambang (v1.1):** "di atas X" atau "lebih dari X" berarti > X; "paling sedikit X" atau "X atau lebih" berarti ≥ X; setiap ambang di PRD mengikuti kata di BRD.

## 6.7 Jejak audit & koreksi (FR-M10-02, BR-38, NFR-11)

Semua objek Bab 5.1 berjejak: pelaku, waktu perangkat dan server, nilai lama, nilai baru, alasan bila diwajibkan. Jejak tidak dapat diubah siapa pun termasuk admin sistem. Koreksi transaksi keuangan hanya lewat transaksi pembalik yang merujuk transaksi asal; keduanya tetap tampil.

## 6.8 Ekspor & privasi (BR-39, NFR-12)

Ekspor laporan tersedia untuk peran yang berhak; ekspor yang memuat data pribadi pelanggan/mitra hanya oleh pemilik atau Admin Keuangan dengan tujuan tercatat. Permintaan penghapusan data pribadi dilayani dengan anonimisasi tanpa menghapus catatan keuangan (BRD 10.6).

---
# Bab 7 — Kebutuhan Produk Tahap 1

Urutan penulisan mengikuti urutan bangun BRD 3.8: M1–M5, M9, M10, M12 (bulan 3–5), lalu M6–M8, M11 (bulan 5–7). Prioritas di judul user story adalah prioritas tertinggi dari FR yang dirujuknya.

## 7.1 M1 — Master Data

### 7.1.1 Tujuan
Satu sumber kebenaran untuk pelanggan, harga, armada, kru, depot, sumber air, dan karyawan, sehingga pesanan dibuat < 60 detik dengan harga otomatis, kontrol kredit berjalan tanpa campur tangan, dan setiap modul merujuk data yang sama. Menjawab FR-M1-01 s.d. FR-M1-06; mendukung T1–T5.

### 7.1.2 Peran & antarmuka
Web kantor. Dispatcher (pelanggan, alamat, armada, kru); Pemilik (harga, zona, komponen BBM, depot, sumber air, persetujuan); Admin sistem (karyawan dan peran, bersama M10); Kasir toko (produk toko, disetujui Admin Keuangan — dirinci di M7).

### 7.1.3 Objek & status
Pelanggan (Aktif/Nonaktif; status kredit Tunai/Tempo/Ditahan), Alamat kirim (koordinat Belum dikunci/Dikunci; zona Otomatis/Manual), Zona tarif, Produk & harga (berlaku per tanggal), Armada (Aktif/Perbaikan/Nonaktif), Kru, Depot, Sumber air, Karyawan.

### 7.1.4 User story

**US-M1-01 Mengelola pelanggan dan alamat kirim** — M — FR-M1-01, FR-M2-08, BR-01, BR-02, BR-04, BR-16, BR-18
Sebagai Dispatcher, saya ingin mencatat pelanggan dengan segmen, kontak, lebih dari satu alamat kirim berkoordinat, dan ketentuan kreditnya, agar pesanan dapat dibuat cepat dan kontrol kredit berjalan otomatis.

Kriteria penerimaan:
1. Bidang wajib: nama, segmen (depot pihak ketiga, rumah tangga, perumahan, industri, proyek konstruksi, hotel, kolam renang — BRD 1.1), nomor WA (validasi format Indonesia), minimal satu alamat kirim. Bidang lain: nama kontak, catatan khusus (akses lokasi, jam terima tetap), penanda "tagihan bulanan" (BR-05; hanya bila perjanjian tertulis terlampir).
2. Alamat kirim memuat label, teks alamat, koordinat, dan catatan. Koordinat dapat diisi dari peta atau dibiarkan kosong dengan status "Belum dikunci"; sistem menawarkan kunci koordinat dari lokasi "Selesai" rit pertama, yang dikonfirmasi Dispatcher (BRD 10.2). Alamat berkoordinat otomatis dipetakan ke satu zona (US-M1-05); tanpa koordinat, Dispatcher memilih zona manual dan alamat ditandai "Zona manual" sampai dikunci.
3. Status kredit pelanggan baru = Tunai (BR-01) dan tidak dapat diubah Dispatcher. Tombol "Ajukan Tempo" hanya aktif bila pelanggan memenuhi PAR-11 (≥ 3 bulan sejak pesanan Selesai pertama **atau** ≥ 10 pesanan Selesai) **dan** syarat "tanpa masalah" PAR-82 (dalam periode itu: tidak ada kurang bayar lewat 7 hari, tidak ada transfer "Tidak ditemukan", tidak ada sengketa yang ditolak, dan paling banyak 1 rit gagal karena pelanggan menolak); persetujuan pemilik tetap wajib (6.2a). Tidak ada pengesampingan syarat selain status "Tempo migrasi" (US-M1-06 KP-6); bila pemilik menginginkan pengecualian lain, jalurnya CR atas BR-01 (CR-12).
4. Batas kredit terisi otomatis dari segmen (BR-04) dan hanya dapat diubah pemilik dengan alasan; rumah tangga tetap tunai tanpa pengecualian ("tunai saja", BR-04; ditegaskan di CR-12); tempo standar 14 hari (BR-02) dengan pengecualian per pelanggan oleh pemilik.
5. Harga khusus: per pelanggan per produk, dengan alasan, tanggal mulai, dan tanggal tinjauan otomatis 6 bulan (BR-16); berlaku hanya setelah persetujuan pemilik; harga khusus yang lewat tanggal tinjauan tetap berlaku tetapi tampil pada daftar tinjauan pemilik.
6. Penanda "mitra toko" (BR-18) terpasang otomatis untuk segmen depot pihak ketiga yang aktif (minimal satu pesanan Selesai dalam 90 hari terakhir [USULAN]) dan manual untuk mitra depot EQUA; penanda ini dipakai M7.
7. Saat menyimpan, sistem memeriksa duplikat: nomor WA sama, atau nama dan alamat mirip; menampilkan kandidat dan meminta konfirmasi, tidak memblokir.
8. Pelanggan tidak dapat dihapus; dinonaktifkan dengan alasan; tidak dapat dinonaktifkan bila masih ada piutang terbuka atau pesanan aktif.
9. Layar pelanggan menampilkan ringkasan: piutang terbuka, batas tersisa (BR-06), 10 pesanan terakhir, rata-rata jarak antar pesanan, catatan khusus (FR-M2-08).
10. Semua perubahan berjejak audit (Bab 6.7).

**US-M1-02 Mengelola produk dan harga tiga lini** — M — FR-M1-02, BR-15, BR-19, BR-33, K23
Sebagai Pemilik, saya ingin satu daftar produk dan harga untuk air truk, produk depot, dan barang toko yang berlaku per tanggal dan tersimpan riwayatnya, agar harga hanya berasal dari master dan tidak dinegosiasi di lapangan.

Kriteria penerimaan:
1. Tiga kelompok produk dengan atribut berbeda: **air truk** (harga per rit = tarif zona alamat kirim + komponen BBM); **produk depot** (isi ulang, galon baru, tutup, tisu, cuci galon, dan lainnya; harga tunggal per tenant); **barang toko** (harga umum dan harga mitra, satuan, stok minimum — dikelola di M7 dengan aturan persetujuan yang sama).
2. Komponen BBM adalah satu nilai rupiah per rit yang ditetapkan pemilik dengan tanggal berlaku dan berlaku untuk seluruh zona [ASUMSI-PRD PTB-03].
3. Setiap harga memiliki tanggal mulai berlaku. Jalur baku: Admin Keuangan menginput harga baru dan harga aktif setelah disetujui pemilik (6.2a, BR-15). Bila pemilik menginput sendiri, perubahan tercatat sebagai keputusan langsung pemilik (6.2b) tanpa langkah persetujuan, dengan alasan dan tanggal berlaku wajib, serta diberitahukan ke Admin Keuangan dan Dispatcher. Riwayat harga dapat dilihat dan tidak dapat dihapus.
4. Transaksi mengambil harga yang berlaku pada tanggal transaksi. Untuk pesanan truk, harga dikunci saat pesanan dibuat; bila harga berubah sebelum tanggal kirim, Dispatcher diberi peringatan dan dapat memperbarui harga dengan konfirmasi ke pelanggan [USULAN PTB-13].
5. Produk "air truk — transfer internal" untuk pasokan ke depot sendiri memakai tarif zona alamat depot pada segmen depot pihak ketiga (BR-33, K20), tanpa pembayaran.
6. Produk dinonaktifkan, bukan dihapus; produk nonaktif tidak muncul di POS/pesanan tetapi tetap tampil di riwayat.

**US-M1-03 Mengelola armada, kru, dan perangkat** — M — FR-M1-03, FR-M12-06, K24
Sebagai Dispatcher, saya ingin mencatat truk, kapasitas, kru default, perangkat GPS, dan ponsel lapangannya, agar penjadwalan dan pelacakan merujuk data yang sama.

Kriteria penerimaan:
1. Truk: nopol, kapasitas (bawaan 5.000 L), status (Aktif/Perbaikan/Nonaktif), sopir dan kernet default, ID perangkat GPS terpasang, ID ponsel lapangan.
2. Truk berstatus Perbaikan/Nonaktif tidak dapat menerima rit; rit yang sudah ditugaskan ke truk yang berubah status ditandai untuk dipindahkan.
3. Kru: karyawan dengan peran Sopir/Kernet dan truk default; satu karyawan hanya satu truk default; pengecualian harian diatur di jadwal kru (US-M2-10).
4. Perangkat (ponsel, tablet, GPS) didaftarkan dengan pengenal unik, jenis, pemegang, dan status (Bab 5.2); pendaftaran dan pemblokiran oleh admin sistem (M10).

**US-M1-04 Mengelola depot, sumber air, dan karyawan** — M — FR-M1-03, FR-M1-04
Sebagai Pemilik dan Admin sistem, saya ingin data depot, sumber air, dan karyawan tercatat sekali, agar POS, produksi, dan hak akses merujuk data yang sama.

Kriteria penerimaan:
1. Depot: kode, nama, tenant (EQUA pada Tahap 1), koordinat dan radius geofence, operator default, kapasitas simpan (L), status.
2. Sumber air: nama, lokasi, kapasitas harian (50.000 L), koordinat dan radius geofence, daftar meter (pengenal, satuan, angka awal saat cut-over, foto).
3. Karyawan: nama, jabatan, lokasi tugas, peran sistem (BRD 4.2), tanggal masuk/keluar; pengaitan ke akun dilakukan di M10; tanggal keluar mencabut akses hari itu (BR-37).
4. Semua entitas dinonaktifkan, bukan dihapus.

**US-M1-05 Mengelola zona tarif dan pemetaan alamat** — M — FR-M1-05, BR-19, K23, A13
Sebagai Pemilik, saya ingin menetapkan 3–4 zona jarak dengan tarif per zona dan melihat setiap alamat kirim terpetakan ke satu zona, agar harga air truk konsisten dan tidak dinegosiasi per rit.

Kriteria penerimaan:
1. Tabel zona: nama, batas jarak (km dari–sampai, tidak tumpang tindih, tanpa celah), tarif per rit, tanggal berlaku; tarif dapat dibedakan per segmen bila pemilik menetapkan, jika tidak berlaku satu tarif per zona [USULAN].
2. Jarak dihitung dari **sumber air acuan** alamat tersebut; sumber acuan bawaan = sumber terdekat, dapat diubah Dispatcher dengan alasan [KEPUTUSAN PTB-02]. Basis jarak = jarak rute layanan peta (NFR-24), dengan garis lurus × 1,3 sebagai cadangan bila peta tidak tersedia [USULAN].
3. Pemetaan alamat → zona otomatis saat koordinat tersedia; Dispatcher dapat menetapkan zona lain dengan alasan (alamat di batas zona), tercatat sebagai "Zona manual".
4. Perubahan tabel zona atau tarif tidak mengubah harga pesanan yang sudah dibuat (US-M1-02 KP-4); sistem menampilkan daftar alamat yang berpindah zona akibat perubahan batas untuk ditinjau pemilik.
5. Pada penerapan awal, sistem menampilkan simulasi harga zona baru vs harga yang berlaku saat ini per pelanggan (dari impor US-M1-06), agar zona benar-benar "diturunkan dari harga yang berlaku hari ini" (K23) dan R14 termitigasi.
6. Bila FR-M12-07 (S) tersedia, jarak GPS aktual per rit dibandingkan dengan zona alamat; penyimpangan ditampilkan ke pemilik, tidak mengubah harga otomatis.

**US-M1-06 Mengimpor data awal dan membersihkan duplikat** — M — FR-M1-06, NFR-34, BRD 10.3, BR-01
Sebagai Dispatcher, saya ingin mengimpor 300 pelanggan dan daftar harga dari template, memeriksa duplikat, dan mendapat tanda tangan pemilik, agar sistem mulai dengan data bersih.

Kriteria penerimaan:
1. Template Excel untuk pelanggan (dengan banyak alamat), harga saat ini per pelanggan, armada, kru, karyawan, depot, sumber air; sistem menyediakan template dan contoh terisi.
2. Impor menghasilkan laporan validasi per baris: wajib kosong, format WA salah, segmen tidak dikenal, duplikat (WA sama / nama+alamat mirip) dengan usulan penggabungan; tidak ada baris masuk sebelum semua kesalahan diselesaikan atau dikecualikan dengan alasan.
3. Impor dapat dijalankan berulang di lingkungan uji, dan sekali di produksi dengan penandaan "data awal" yang tidak dapat diubah kecuali lewat koreksi berjejak.
4. Ringkasan hasil impor (jumlah per segmen, per zona, pelanggan tempo dan batasnya) ditandatangani pemilik di sistem sebelum go-live (NFR-34).
5. Koordinat yang kosong dilengkapi dari GPS sopir dalam 30 hari pertama (BRD 10.3); sistem menampilkan kemajuan (% alamat terkunci).
6. Pelanggan yang sudah bertempo sebelum cut-over (15–30 pelanggan, BRD 10.3) diimpor dengan status "Tempo migrasi" beserta batas dan tempo yang disepakati; daftar ini ikut ditandatangani pemilik dalam ringkasan data awal (KP-4, NFR-34) dan menjadi satu-satunya pengecualian syarat BR-01 (US-M1-01 KP-3; CR-12). Masa transisi PAR-41 berlaku bagi mereka.

### 7.1.5 Aturan bisnis yang dipaksakan
BR-01, BR-02, BR-04, BR-15, BR-16, BR-18, BR-19, BR-33 (lihat kriteria penerimaan di atas); BR-36/BR-37 lewat M10.

### 7.1.6 Pengecualian & kegagalan
- Alamat tanpa koordinat dan tanpa zona manual: pesanan dapat dibuat tetapi ditandai "harga sementara" dan tidak dapat diterbitkan ke sopir sebelum zona ditetapkan [USULAN].
- Pelanggan dengan dua alamat pada zona berbeda: harga mengikuti alamat kirim pesanan, bukan pelanggan.
- Layanan peta tidak tersedia: koordinat tetap dapat disimpan; jarak dihitung cadangan (US-M1-05 KP-2) dan ditandai untuk hitung ulang.

### 7.1.7 Di luar cakupan M1
Produk toko dan stok (M7); pengguna dan PIN (M10); bagan akun dan aset tetap (M11); pelanggan aplikasi (Tahap 2); tenant mitra (Tahap 3; hanya struktur datanya disiapkan).

### 7.1.8 Hal terbuka
PTB-02, PTB-03, PTB-13.

## 7.2 M2 — Pesanan & Penjadwalan Rit

### 7.2.1 Tujuan
Setiap pesanan bernomor, berstatus, terjadwal ke truk tertentu dalam urutan rit harian, dan tidak pernah terlewat atau dobel; Dispatcher melihat beban dan kapasitas rit nyata. Menjawab P3, T3, KPI-05–KPI-07; FR-M2-01 s.d. FR-M2-10; BR-20 s.d. BR-24.

### 7.2.2 Peran & antarmuka
Web kantor. Dispatcher (semua); Pemilik (persetujuan kredit, pantau); Admin Keuangan (baca); Sopir menerima hasilnya di M3.

### 7.2.3 Objek & status
Pesanan dan Rit (Bab 5.2); Jadwal harian per truk (Draf/Terbit); Pesanan berulang (Aktif/Jeda/Berakhir); Jadwal kru (per hari per truk).

### 7.2.4 User story

**US-M2-01 Membuat pesanan dalam kurang dari 60 detik** — M — FR-M2-01, FR-M2-05, BR-19, BR-20, P-01 langkah 1
Sebagai Dispatcher, saya ingin membuat pesanan sambil menelepon dengan pelanggan, agar tidak ada pesanan yang lupa dicatat.

Kriteria penerimaan:
1. Satu layar tanpa pindah halaman: cari pelanggan (nama/WA/alamat; hasil tampil setelah 2 karakter dalam ≤ 1 detik), pilih alamat kirim (bawaan: alamat terakhir dipakai), jumlah tangki (bawaan 1), tanggal diminta (bawaan hari ini bila sebelum 15.00, bila tidak H+1 — BR-20), jam diminta (opsional; jam terima tetap pelanggan terisi otomatis), cara bayar (bawaan tunai; transfer; tempo hanya bila status Tempo dan dalam batas), catatan.
2. Harga per rit tampil otomatis dari zona alamat + komponen BBM atau harga khusus (US-M1-02, US-M1-05); total = harga × jumlah tangki; Dispatcher tidak dapat mengubah harga (BR-19).
3. Pelanggan baru dapat dibuat di layar yang sama dengan bidang minimal (nama, WA, alamat, segmen) dan otomatis Tunai (BR-01); kelengkapan lain dilengkapi kemudian.
4. Pesanan H+0 setelah 15.00: sistem mengusulkan H+1; Dispatcher dapat memaksa H+0 dengan alasan tercatat (BR-20).
5. Pesanan dengan n tangki menghasilkan n rit yang dapat dijadwalkan ke truk dan hari yang berbeda [ASUMSI-PRD PTB-09].
6. Pesanan internal pasokan depot: pelanggan = depot sendiri, produk transfer internal, cara bayar "internal"; muncul di papan jadwal dan aplikasi sopir seperti rit biasa, tanpa pencatatan uang [KEPUTUSAN PTB-01].
7. Waktu dari klik "Pesanan baru" hingga tersimpan ≤ 60 detik untuk pelanggan yang sudah ada, diukur pada UAT dengan 10 pesanan berturut oleh Dispatcher yang sudah dilatih.
8. Setelah tersimpan: nomor pesanan tampil besar dan tombol "Kirim konfirmasi WA" (US-M2-07).

**US-M2-02 Nomor dan status pesanan** — M — FR-M2-02, BR-38, KPI-05
Sebagai Dispatcher, saya ingin setiap pesanan bernomor unik dan berstatus, agar dapat dirujuk oleh pelanggan, sopir, dan keuangan.

Kriteria penerimaan:
1. Nomor pesanan otomatis, unik, tidak dapat diubah, berurutan per tahun dengan format `P-YY-NNNNNN` (contoh P-27-000123) [USULAN PTB-14]; nomor rit = nomor pesanan + urutan tangki (P-27-000123/2).
2. Siklus status sesuai Bab 5.2 (Pesanan); setiap transisi mencatat waktu dan pelaku; status Selesai/Dibatalkan terkunci.
3. Pembatalan wajib alasan dari daftar (pelanggan batal, dobel, tidak ada truk, harga, lainnya + teks); pembatalan pesanan yang sudah Dalam pengiriman tidak dimungkinkan dari kantor.
4. Pencarian dan filter pesanan: nomor, pelanggan, tanggal, status, truk, cara bayar; ekspor Excel (NFR-23).

**US-M2-03 Papan jadwal rit harian** — M — FR-M2-03, BR-21, P-01 langkah 3
Sebagai Dispatcher, saya ingin menugaskan pesanan ke truk dan urutan rit dalam satu papan, agar beban per truk terlihat dan tidak ada pesanan tanpa truk.

Kriteria penerimaan:
1. Papan per tanggal: satu jalur per truk aktif dengan kru hari itu (dari US-M2-10); kolom "Belum terjadwal" menampilkan semua rit tanggal itu (dan tanggal lewat yang belum selesai) dengan penonjolan warna dan hitungan.
2. Menugaskan rit ke truk dan urutan dengan seret-lepas atau pilih; urutan diberi nomor; sistem menampilkan jumlah rit (pelanggan dan internal, terpisah dan gabungan) dan volume per truk vs kapasitas rit harian (PAR-33, bawaan 3 rit/truk, dapat diatur per truk; kapasitas nyata dari US-M2-10 bila tersedia).
3. Urutan usulan otomatis mengikuti BR-21: rit langganan dan pelanggan berjam-terima-tetap lebih dulu, sisanya berdasarkan waktu pesanan masuk; Dispatcher dapat mengubah urutan.
4. Rit tidak dapat ditugaskan ke truk Perbaikan/Nonaktif atau tanpa sopir hari itu; sistem menolak dengan pesan.
5. Tombol "Terbitkan" mengirim jadwal ke aplikasi sopir; perubahan setelah terbit (tambah/geser/tarik rit) mengirim pembaruan dan tercatat; rit yang sudah Berangkat tidak dapat dipindahkan.
6. Papan menampilkan status rit real-time dari M3 (Ditugaskan/Berangkat/Tiba/Selesai/Gagal) dan posisi truk dari M12 (FR-M12-01) pada peta yang sama atau berdampingan.
7. Rit yang sopirnya terkunci karena setoran belum ditutup (BR-10) ditandai pada papan agar Dispatcher dapat menghubungi Admin Keuangan.

**US-M2-04 Peringatan pesanan dobel** — M — FR-M2-04, KPI-06
Sebagai Dispatcher, saya ingin diperingatkan bila pesanan yang sama sudah ada, agar tidak mengirim dua kali.

Kriteria penerimaan:
1. Saat menyimpan pesanan dengan pelanggan, alamat kirim, dan tanggal diminta yang sama dengan pesanan berstatus Baru/Terjadwal/Dalam pengiriman, sistem menampilkan pesanan yang ada (nomor, jumlah, status, pembuat) dan pilihan: "Ini pesanan tambahan" (lanjut, alasan tercatat) atau "Batalkan yang ini".
2. Pesanan yang dilanjutkan tetap ditandai "kemungkinan dobel" pada papan hingga salah satunya Selesai/Dibatalkan.
3. Jumlah pesanan dibatalkan dengan alasan "dobel" dan pesanan lewat tanggal tanpa jadwal ulang dilaporkan bulanan (KPI-06, M9).

**US-M2-05 Kontrol kredit pada pesanan tempo** — M — FR-M2-05, BR-03, BR-04, BR-06, P-01 langkah 1
Sebagai Dispatcher, saya ingin sistem menolak pesanan tempo yang melampaui ketentuan, agar piutang tidak tumbuh tanpa kendali.

Kriteria penerimaan:
1. Cara bayar "tempo" hanya dapat dipilih bila status kredit pelanggan = Tempo; bila Tunai, pilihan tidak tersedia dengan keterangan; bila Ditahan, ditolak dengan keterangan piutang lewat tempo dan tombol "Ajukan persetujuan pemilik".
2. Sistem menghitung eksposur = piutang belum lunas + nilai pesanan tempo berstatus Baru/Terjadwal/Dalam pengiriman + nilai pesanan ini (BR-06); bila > batas kredit, ditolak dengan angka eksposur dan batas, serta tombol "Ajukan persetujuan pemilik".
3. Pengajuan membuat permintaan persetujuan (Bab 6.2) dengan status pesanan "Menunggu persetujuan"; pesanan tidak dapat dijadwalkan sampai disetujui; pemilik menyetujui/menolak dengan alasan dari web/ponsel; Dispatcher dapat mengubah cara bayar ke tunai kapan saja.
4. Persetujuan berlaku untuk pesanan itu saja, bukan mengubah batas pelanggan.
5. Keputusan dan eksposur saat keputusan tercatat pada pesanan.
6. Pelanggan dengan faktur kurang bayar terbuka (PTB-18): pesanan baru bertanda "tagih kurang bayar" dan sisanya ditagih sopir saat pengiriman (US-M3-05); bila terjadi kurang bayar kedua saat yang pertama belum lunas, pesanan baru hanya dapat dijadwalkan setelah lunas atau disetujui pemilik (6.2a).

**US-M2-06 Pesanan berulang / langganan** — S — FR-M2-06, BR-21
Sebagai Dispatcher, saya ingin pola langganan (misalnya hotel setiap Senin dan Kamis) menghasilkan pesanan otomatis, agar pelanggan tetap tidak pernah terlewat.

Kriteria penerimaan:
1. Pola: pelanggan, alamat, hari dalam minggu atau interval hari, jumlah tangki, jam diminta, cara bayar, tanggal mulai/berakhir; status Aktif/Jeda/Berakhir.
2. Sistem membuat pesanan berstatus Baru dengan tanda "langganan" pada H-2 [USULAN, PAR-34]; pesanan mengikuti kontrol kredit US-M2-05 dan diprioritaskan pada urutan BR-21.
3. Pola yang dijeda tidak menghasilkan pesanan; pesanan yang sudah dibuat dari pola tidak berubah bila pola diubah.
4. Daftar "pesanan langganan yang gagal dibuat" (misalnya kredit ditahan) tampil ke Dispatcher.

**US-M2-07 Konfirmasi pesanan ke pelanggan lewat WA** — S — FR-M2-07, NFR-20, K21
Sebagai Dispatcher, saya ingin mengirim konfirmasi pesanan dari template dalam satu klik, agar pelanggan mendapat kepastian jadwal.

Kriteria penerimaan:
1. Template (dikelola pemilik) memuat nomor pesanan, tanggal/jam, jumlah tangki, harga, cara bayar, kontak EQUA; tombol membuka WhatsApp dengan pesan terisi ke nomor pelanggan.
2. Sistem mencatat "konfirmasi dibuka" (waktu, pelaku); tidak mengklaim terkirim/terbaca.
3. Bila WhatsApp Business API diaktifkan kemudian, pengiriman menjadi otomatis tanpa mengubah alur Dispatcher.

**US-M2-08 Riwayat dan catatan khusus pelanggan** — M — FR-M2-08
Sebagai Dispatcher, saya ingin melihat riwayat pesanan dan catatan khusus pelanggan saat membuat pesanan, agar pesanan sesuai kebiasaan pelanggan.

Kriteria penerimaan:
1. Panel pelanggan pada layar pesanan: 10 pesanan terakhir (tanggal, jumlah, status, truk), piutang terbuka dan batas tersisa, catatan khusus (akses lokasi, jam terima), harga khusus yang berlaku.
2. Catatan khusus ikut terkirim ke aplikasi sopir pada rit terkait.
3. Riwayat lengkap dapat diekspor per pelanggan.

**US-M2-09 Pembatalan, penjadwalan ulang, dan rit gagal** — M — FR-M2-09, BR-24
Sebagai Dispatcher, saya ingin setiap pembatalan, penjadwalan ulang, dan rit gagal tercatat beralasan, agar penyebabnya dapat dianalisis.

Kriteria penerimaan:
1. Penjadwalan ulang mengubah tanggal diminta dengan alasan; riwayat tanggal tersimpan.
2. Rit Gagal dari M3 (pelanggan tidak ada/menolak/jalan ditutup/truk rusak) membuat kejadian dengan alasan, foto, waktu, lokasi; pesanan kembali ke Baru dengan penanda "perlu jadwal ulang" dan muncul di kolom belum terjadwal.
3. Dua rit gagal berturut-turut untuk pelanggan yang sama: pesanan berikutnya wajib dicentang "sudah dikonfirmasi ulang" (dengan waktu dan cara) sebelum dapat dijadwalkan (BR-24).
4. Laporan bulanan alasan pembatalan dan kegagalan per pelanggan dan per truk (M9).

**US-M2-10 Jadwal kerja kru dan ketersediaan truk** — S — FR-M2-10, A2
Sebagai Dispatcher, saya ingin mencatat libur bergantian kru dan truk yang tidak beroperasi, agar kapasitas rit harian yang nyata terlihat di papan jadwal.

Kriteria penerimaan:
1. Jadwal mingguan per truk per hari: sopir, kernet, libur; penetapan pengemudi pengganti harian memakai US-M2-11 (M) dan tetap berfungsi walau jadwal mingguan ini belum dibangun.
2. Status truk per hari (operasi/perbaikan) memengaruhi kapasitas; kapasitas rit harian = Σ kapasitas rit truk yang beroperasi (PAR-33, bawaan 3 per truk, dapat diatur per truk); beban = rit pelanggan + rit internal pasokan depot (PTB-01). PAR-33 dikalibrasi ulang dari baseline KPI-07 tiga bulan sebelum Tahap 2 (Bab 8.1).
3. Papan jadwal menampilkan kapasitas vs terjadwal; melebihi kapasitas diperingatkan, tidak diblokir.
4. Tanpa fitur ini (bila S ditunda), papan memakai kru default (US-M1-03), penetapan pengemudi pengganti harian (US-M2-11), dan kapasitas PAR-33.

**US-M2-11 Penetapan pengemudi pengganti harian** — M — FR-M3-09, FR-M2-10 (bagian minimal, CR-13), BR-36, BR-10, PTB-10
Sebagai Dispatcher, saya ingin menetapkan siapa yang mengemudikan truk hari ini bila sopir default berhalangan, agar rit tetap berjalan dan setiap transaksi tercatat atas nama orang yang benar.

Kriteria penerimaan:
1. Per truk per tanggal, Dispatcher menetapkan pengemudi hari itu: sopir default (bawaan dari US-M1-03), kernet truk itu, atau sopir lain yang tidak bertugas; penetapan berlaku sampai akhir hari kas dan dapat diubah dengan alasan.
2. Pengemudi pengganti mendapat hak tindakan sopir di aplikasi (US-M3-01 KP-6) hanya untuk truk dan tanggal itu; kernet yang tidak ditetapkan tetap hanya membaca.
3. Ganti pengemudi di tengah hari: setoran dipisah per pengguna — masing-masing menyetor kas yang diterimanya (7.3.6); rit yang sudah Berangkat tetap atas nama pelaksananya.
4. Pengemudi yang setoran hari sebelumnya belum Ditutup tidak dapat ditetapkan (BR-10); sistem menampilkan alasannya.
5. Setiap penetapan berjejak (pelaku, waktu, alasan) dan tampil di papan jadwal (US-M2-03) serta laporan kinerja (US-M9-05).

### 7.2.5 Aturan bisnis yang dipaksakan
BR-19 (harga hanya dari master; Dispatcher tidak mengubah), BR-20 (batas 15.00), BR-21 (urutan), BR-24 (konfirmasi ulang), BR-03/BR-04/BR-06 (kredit), BR-10 (rit terkunci bila setoran belum ditutup — ditampilkan di papan), BR-38 (tanpa hapus).

### 7.2.6 Pengecualian & kegagalan
- Truk rusak di tengah hari: Dispatcher memindahkan rit yang belum Berangkat ke truk lain; rit yang sedang berjalan ditandai Gagal dengan alasan "truk rusak" (FR-M3-10) dan dijadwalkan ulang.
- Pelanggan meminta tambahan tangki saat sopir di lokasi: sopir tidak dapat menambah rit; Dispatcher membuat pesanan baru (kontrol kredit tetap berlaku) [USULAN].
- Koneksi kantor putus: M2 tidak bekerja offline; jadwal yang sudah terbit tetap ada di aplikasi sopir.
- Perubahan jadwal setelah terbit saat sopir offline: pembaruan diterima saat sinkron; rit yang ditarik dari jadwal tetapi sudah dikerjakan sopir secara offline tetap sah dan ditampilkan ke Dispatcher sebagai konflik (Bab 6.4).

### 7.2.7 Di luar cakupan M2
Pemesanan mandiri pelanggan (Tahap 2); optimasi rute otomatis; manajemen pemeliharaan armada.

### 7.2.8 Hal terbuka
PTB-01, PTB-09, PTB-13, PTB-14, PTB-15.

## 7.3 M3 — Aplikasi Sopir

### 7.3.1 Tujuan
Sopir menjalankan rit hari ini dari ponsel: mengetahui urutan rit, mencatat status dan bukti kirim, mencatat pembayaran tanpa menghitung apa pun, dan menyetor dengan angka yang sudah dihitung sistem — tetap bekerja tanpa sinyal. Menjawab P1, P3, T1, T3, KPI-01, KPI-07, KPI-11; FR-M3-01 s.d. FR-M3-10; BR-07, BR-08, BR-10, BR-19, BR-22 s.d. BR-25.

### 7.3.2 Peran & antarmuka
Aplikasi lapangan Android pada ponsel milik perusahaan, satu per truk (7 + 2 cadangan; BRD 10.5, K24). Sopir: semua tindakan. Kernet: membaca daftar rit; tindakan sopir hanya bila ditetapkan sebagai pengemudi pengganti lewat penetapan harian (US-M2-11; PTB-10). Hasilnya dipakai Dispatcher (M2), Admin Keuangan (M4, M5), M12 (posisi), dan pelanggan (struk WA, S).

### 7.3.3 Objek & status
Rit (Ditugaskan → Berangkat → Tiba → Selesai / Gagal), Bukti kirim, Pembayaran rit, Pelunasan lewat sopir, Pengeluaran rit (S), Kejadian kendala (S), Keterangan perjalanan di luar jadwal (BR-25), Setoran sopir (Berjalan → Diajukan), status sinkron per item (Tersimpan di ponsel / Terkirim).

### 7.3.4 User story

**US-M3-01 Melihat daftar rit hari ini dan menuju lokasi** — M — FR-M3-01, FR-M3-09, FR-M2-08, BR-10, BR-19, NFR-15, NFR-18
Sebagai Sopir, saya ingin melihat rit hari ini berurutan dengan alamat, catatan, dan tombol navigasi, agar saya tahu ke mana harus pergi tanpa menelepon kantor.

Kriteria penerimaan:
1. Setelah login PIN, layar utama adalah daftar rit hari ini untuk truk yang ditugaskan: nomor urut, nomor rit, nama pelanggan, alamat singkat, jumlah tangki/volume, jam diminta, cara bayar, penanda catatan khusus, status. Rit berikutnya ditonjolkan; rit Selesai/Gagal turun ke bawah.
2. Detail rit menampilkan catatan khusus pelanggan (akses lokasi, jam terima), tombol telepon/WA ke pelanggan, harga pesanan ini (satu-satunya harga yang terlihat sopir, BR-19), daftar faktur terbuka pelanggan (untuk US-M3-05), dan penanda "Internal — Depot X" untuk rit pasokan depot (PTB-01).
3. Tombol navigasi membuka aplikasi peta ponsel dengan koordinat alamat; bila koordinat Belum dikunci, memakai teks alamat dan menampilkan "titik alamat akan dikunci saat Selesai".
4. Pembaruan jadwal dari Dispatcher (tambah, geser, tarik) tampil dengan penanda "diperbarui" dan ringkasan perubahan; rit yang sudah Berangkat tidak berubah.
5. Bila setoran hari sebelumnya belum Ditutup (BR-10), daftar tetap tampil tetapi tombol Berangkat terkunci dengan pesan "Setoran kemarin belum ditutup Admin Keuangan" dan tombol hubungi Admin Keuangan; kunci terbuka otomatis saat setoran Ditutup oleh Admin Keuangan (M4). Keputusan pemilik atas selisih tidak memengaruhi kunci ini, kecuali PAR-83 aktif (PTB-62) — dengan pesan "Menunggu keputusan pemilik atas selisih besar".
6. Kernet yang tidak ditetapkan sebagai pengemudi pengganti melihat daftar yang sama tanpa tombol tindakan; kernet pengganti mendapat tombol yang sama dengan sopir dan seluruh transaksinya tercatat atas namanya (US-M2-11; PTB-10).
7. Setiap tindakan dapat dicapai ≤ 3 ketukan dari daftar rit; teks ≥ 16 pt dan kontras tinggi (NFR-18, S); Bahasa Indonesia dengan istilah rit/setor/tempo (NFR-15).

**US-M3-02 Mencatat Berangkat dan Tiba dengan waktu dan lokasi otomatis** — M — FR-M3-02, FR-M12-06, P-01 langkah 5–6
Sebagai Sopir, saya ingin menekan satu tombol saat berangkat dan tiba, agar waktu dan lokasi tercatat tanpa saya mengetik.

Kriteria penerimaan:
1. Berangkat dan Tiba masing-masing satu ketukan; mencatat waktu perangkat, posisi GPS ponsel, dan akurasinya; hanya satu rit berstatus Berangkat/Tiba per truk pada satu waktu [USULAN].
2. Memulai rit di luar urutan (misalnya rit ke-3 sebelum ke-2) dimungkinkan dengan konfirmasi; urutan aktual tercatat dan tampil ke Dispatcher (US-M2-03).
3. Tiba menghitung jarak posisi ke koordinat alamat secara lokal (tanpa sinyal) agar aturan BR-23 dapat dipaksakan pada langkah Selesai (US-M3-03).
4. Bila GPS ponsel nonaktif, aplikasi meminta mengaktifkannya; tanpa lokasi, status tetap tercatat dengan penanda "tanpa lokasi" yang dilaporkan ke M12 sebagai anomali [USULAN].
5. Perekaman jejak berkelanjutan dari GPS ponsel hanya berjalan selama rit aktif dan hanya bila server menandai perangkat GPS truk mati (FR-M12-08) atau admin sistem mengaktifkannya untuk truk tertentu — GPS ponsel adalah cadangan (K11, NFR-17).
6. Rit internal pasokan depot memakai tombol yang sama; "Tiba" di depot dicocokkan dengan geofence depot bila FR-M12-05 (S) tersedia.

**US-M3-03 Menyelesaikan rit dengan bukti kirim** — M — FR-M3-03, BR-22, BR-23, FR-M12-03, P-01 langkah 6, P-01 langkah 7 (KP-7, PTB-29)
Sebagai Sopir, saya ingin menyelesaikan rit dengan foto, nama dan tanda tangan penerima, serta volume terkirim, agar pengiriman terbukti tanpa nota kertas.

Kriteria penerimaan:
1. Selesai memerlukan: minimal satu foto (diambil dari kamera aplikasi, bukan galeri [USULAN]), nama penerima (terisi nama kontak pelanggan, dapat diubah), tanda tangan penerima di layar, volume terkirim (terisi 5.000 L). Tanpa foto dan nama penerima, tombol Selesai tidak aktif (BR-22); tanda tangan dapat dilewati hanya dengan alasan "penerima tidak bersedia/tidak ada" [USULAN, menjaga FR-M3-03 tanpa memblokir rit].
2. Volume terkirim ≠ 5.000 L → alasan wajib dari daftar (tangki pelanggan penuh, kebocoran, permintaan pelanggan, lainnya + teks) (BR-22). Harga rit tetap harga pesanan; sistem menandai rit "volume parsial" ke Dispatcher dan Admin Keuangan; penyesuaian harga hanya lewat koreksi berjejak Admin Keuangan (BR-38) [USULAN].
3. Jarak lokasi Selesai ke koordinat alamat (dihitung lokal): > 200 m → alasan wajib (alamat di master salah, pelanggan minta titik lain, GPS tidak akurat, lainnya); > 1 km → alasan wajib dan rit ditandai untuk tinjauan pemilik (BR-23). Server menghitung ulang saat sinkron (FR-M12-03); hasil server yang berlaku.
4. Alamat Belum dikunci: tidak ada pembandingan; lokasi Selesai diusulkan sebagai koordinat alamat untuk dikonfirmasi Dispatcher (US-M1-01 KP-2).
5. Untuk rit internal pasokan depot, bukti kirim = volume diserahkan + foto; operator depot mengonfirmasi volume diterima di M6 (FR-M6-05); selisih kirim–terima ditandai ke M8 (P-04 langkah 3).
6. Setelah Selesai, rit dan bukti kirimnya terkunci di perangkat (FR-M3-07); foto dikompresi di perangkat (≤ 300 KB per foto, PAR-38 [USULAN]) dan diunggah saat sinkron; waktu Selesai = waktu perangkat, waktu sinkron dicatat terpisah.
7. Setelah pembayaran tercatat (US-M3-04), tombol "Kirim struk WA" membuka WhatsApp dengan struk terisi (nomor rit, tanggal, volume, harga, cara bayar, sisa piutang bila tempo) dalam satu ketukan — M untuk versi tautan karena P-01 langkah 7 adalah skenario UAT (BRD 12.6; PTB-29, CR-08); sopir dapat melewatinya dengan alasan singkat bila pelanggan tidak memakai WA. Pengiriman otomatis lewat WhatsApp Business API tetap Tahap 2 (US-P2-08).

**US-M3-04 Mencatat pembayaran per rit** — M — FR-M3-04, FR-M3-05, BR-19, P-01 langkah 7
Sebagai Sopir, saya ingin mencatat uang yang saya terima per rit tanpa menghitung harga, agar kas di tangan saya selalu sesuai catatan.

Kriteria penerimaan:
1. Langkah pembayaran adalah bagian dari Selesai dan tidak dapat dilewati. Cara bayar dan harga tampil dari pesanan; sopir tidak dapat mengubah harga (BR-19).
2. Tunai: bidang "diterima" terisi harga (angka seharusnya); sopir mengonfirmasi atau mengubah ke jumlah nyata. Jumlah lebih kecil → alasan wajib; sisa tercatat sebagai kurang bayar dan menjadi faktur jatuh tempo H+0 di M5 dengan notifikasi Admin Keuangan (PTB-18); pesanan berikutnya pelanggan itu bertanda "tagih kurang bayar" (US-M2-05 KP-6). Jumlah lebih besar tidak dapat dicatat; kembalian diberikan di lapangan sehingga kas seharusnya = harga.
3. Transfer: foto bukti transfer wajib + jumlah; aplikasi menampilkan nomor rekening PT yang benar untuk diberitahukan ke pelanggan; tidak menambah kas di tangan; status "belum dicocokkan" hingga dicocokkan Admin Keuangan (US-M4-04).
4. Tempo: hanya bila pesanan bercara-bayar tempo (kontrol kredit dilakukan di M2). Perubahan cara bayar di lapangan (PTB-19): tempo → tunai/transfer selalu boleh. Sopir tidak memutuskan kredit: tunai → tempo hanya lewat permintaan dari aplikasi yang disetujui Dispatcher saat daring (6.2a), untuk pelanggan berstatus Tempo dan dalam batas (BR-06). Bila luring atau tidak disetujui, kekurangan dicatat sebagai kurang bayar (KP-2) dan dapat dikonversi Admin Keuangan menjadi tempo setelah pemeriksaan batas; pelanggan Tunai tidak pernah menjadi tempo di lapangan.
5. Setiap pembayaran memperbarui otomatis: kas di tangan (tunai), daftar transfer belum dicocokkan (transfer), piutang pelanggan (tempo/kurang bayar).
6. Rit internal pasokan depot tidak memiliki langkah pembayaran (PTB-01).

**US-M3-05 Menerima pelunasan piutang saat pengiriman** — M — BR-07, FR-M5-03, P-05 langkah 3
Sebagai Sopir, saya ingin mencatat pelunasan piutang pelanggan yang saya kunjungi ke faktur yang benar, agar uang itu masuk setoran hari ini dan piutang pelanggan berkurang.

Kriteria penerimaan:
1. Pada rit pelanggan yang memiliki faktur terbuka, tombol "Terima pelunasan" menampilkan faktur terbuka (nomor, tanggal, sisa) dari data sinkron terakhir beserta waktunya. Faktur kurang bayar (PTB-18) tampil paling atas dengan penanda "tagih kurang bayar".
2. Sopir memilih faktur (bawaan: yang tertua) dan mencatat jumlah tunai atau foto bukti transfer; pelunasan sebagian diperbolehkan; alokasi ke faktur terpilih dari yang tertua.
3. Pelunasan tunai menambah kas di tangan dan masuk setoran hari itu (BR-07); saat sinkron tercatat sebagai pelunasan di M5 tanpa input ulang Admin Keuangan.
4. Pelunasan hanya untuk pelanggan pada rit hari itu; pelanggan lain melunasi lewat Admin Keuangan (kantor/transfer) [USULAN].
5. Bukti pelunasan digital via WA (S, PTB-29).

**US-M3-06 Menandai rit gagal, melaporkan kendala, dan memberi keterangan perjalanan** — M (rit gagal; keterangan BR-25) / S (kendala) — FR-M2-09, BR-24, FR-M3-10, BR-25, FR-M12-04
Sebagai Sopir, saya ingin melaporkan rit yang gagal atau kendala di jalan dengan foto, agar Dispatcher tahu dan tidak menyalahkan saya tanpa dasar.

Kriteria penerimaan:
1. "Rit gagal" tersedia pada status Berangkat/Tiba: alasan wajib (pelanggan tidak ada, pelanggan menolak, lokasi tidak dapat diakses, truk rusak, lainnya + teks), foto opsional; waktu dan posisi otomatis; rit → Gagal, pesanan kembali ke Dispatcher (US-M2-09). Dua gagal berturut untuk pelanggan yang sama memicu BR-24 di M2.
2. Air yang sudah dimuat pada rit gagal: sopir memilih tindak lanjut (dibawa ke rit berikutnya / kembali ke sumber / dibongkar di depot) — tercatat untuk neraca air M8 [USULAN].
3. Kendala tanpa mengakhiri rit (S): jenis, foto, catatan → kejadian ke Dispatcher; kendala "truk rusak" mengubah status truk menjadi Perbaikan setelah dikonfirmasi Dispatcher.
4. Keterangan perjalanan di luar jadwal/jam (BR-25): permintaan keterangan dari M12 tampil sebagai tugas terbuka di aplikasi; sopir mengisi pada hari yang sama; tugas yang belum diisi hingga tutup kas dilaporkan ke pemilik (Bab 6.3).

**US-M3-07 Melihat kas di tangan dan menyetor akhir hari** — M — FR-M3-05, BR-08, BR-10, P-01 langkah 9, FR-M4-02
Sebagai Sopir, saya ingin melihat berapa uang yang seharusnya ada di tangan saya dan menyetornya dengan satu tombol, agar tidak ada perdebatan saat setoran.

Kriteria penerimaan:
1. Kas di tangan berjalan = Σ tunai rit Selesai + Σ pelunasan tunai − Σ pengeluaran rit dari kas (bila US-M3-08 dipakai, PTB-20); selalu tampil di layar utama; tidak dapat diubah sopir.
2. Tombol "Setor" aktif setelah tidak ada rit Berangkat/Tiba; ringkasan: jumlah rit Selesai/Gagal, tunai per rit, pelunasan, transfer (di luar kas), tempo, pengeluaran, total seharusnya disetor. Menekan Setor mengunci ringkasan (status Diajukan) dan mengirimnya ke Admin Keuangan; setelah Setor tidak ada rit baru hari itu kecuali Admin Keuangan membuka kembali setoran yang belum Diterima dengan alasan [USULAN].
3. Cara setor (PTB-23): bawaan serah fisik ke Admin Keuangan pada hari yang sama (BR-08); untuk sopir tertentu pemilik dapat mengizinkan setor tunai ke rekening PT dengan foto slip, yang tetap diterima Admin Keuangan lewat pencocokan mutasi (US-M4-04).
4. Setelah Admin Keuangan menerima (M4), sopir melihat jumlah diterima, selisih, alasan, dan status; sopir dapat menambahkan keterangan atas selisih dari aplikasi, yang masuk alur selisih M4 [USULAN].
5. Bila setoran belum Diajukan pada PAR-06 (22.00), aplikasi mengingatkan sopir dan memberi tahu Admin Keuangan; setoran tetap dapat diajukan setelahnya dengan penanda terlambat.
6. Riwayat setoran dan selisih sopir sendiri 90 hari terakhir tersedia di aplikasi; sopir tidak melihat data sopir lain [USULAN, turunan FR-M4-07 dan kepentingan "tidak dicurigai tanpa dasar", BRD 4.1].

**US-M3-08 Mencatat pengeluaran rit** — S — FR-M3-08, FR-M11-02, FR-M12-07
Sebagai Sopir, saya ingin mencatat BBM, tol, dan parkir dengan foto nota, agar pengeluaran itu tidak menjadi selisih setoran saya.

Kriteria penerimaan:
1. Jenis (BBM, tol, parkir, lainnya), jumlah, foto nota wajib, terkait rit atau hari, truk; sumber dana: kas di tangan atau uang pribadi (PTB-20).
2. Pengeluaran berstatus "menunggu verifikasi" sampai Admin Keuangan menerima nota saat penerimaan setoran (US-M4-02); ditolak → dihitung sebagai selisih kas dengan alasan; diterima dari uang pribadi → diganti Admin Keuangan dan tercatat.
3. Pengeluaran BBM terkait truk dan tanggal untuk jurnal otomatis M11 dan biaya per rit bersama jarak GPS (FR-M12-07, S).

**US-M3-09 Bekerja tanpa sinyal dan menyinkronkan otomatis** — M — FR-M3-06, NFR-06 s.d. NFR-08, NFR-10
Sebagai Sopir, saya ingin semua tindakan tetap bisa dilakukan tanpa sinyal, agar saya tidak perlu menunggu atau mengulang.

Kriteria penerimaan:
1. Seluruh tindakan US-M3-02 s.d. US-M3-08 berfungsi tanpa sinyal minimal satu hari kerja penuh; data rit hari ini, koordinat dan catatan pelanggan, harga pesanan, faktur terbuka pelanggan hari itu, dan template struk diunduh saat jadwal terbit atau saat login.
2. Setiap item menampilkan status "tersimpan di ponsel"/"terkirim"; ikon di layar utama menunjukkan jumlah item belum terkirim; sinkron otomatis ≤ 5 menit setelah sinyal kembali dan dapat dipicu manual; pengiriman ulang tidak menggandakan (Bab 6.4).
3. Admin Keuangan tidak dapat menerima setoran sebelum seluruh transaksi hari itu dari perangkat tersebut tersinkron; ringkasan setoran menampilkan "menunggu sinkron" bila masih ada antrean [USULAN].
4. Login PIN berfungsi offline; kredensial tidak tersimpan dalam bentuk terbaca (NFR-10); pergantian pengguna (sopir ↔ kernet pengganti) tidak menghapus antrean.
5. Perangkat rusak/hilang dengan antrean belum terkirim: pencatatan oleh Admin Keuangan atas nama sopir dengan penanda "dicatat kantor" (Bab 6.1) berdasarkan bukti yang ada; kejadian dilaporkan ke pemilik dan dihitung pada KPI-01.

**US-M3-10 Keamanan perangkat dan kesiapan lapangan** — M — FR-M3-07, FR-M3-09, FR-M10-05 (M, PTB-06), NFR-09, NFR-10, NFR-16, NFR-17, K24, BR-36, BR-37
Sebagai Pemilik, saya ingin aplikasi hanya berjalan di ponsel perusahaan yang terdaftar dengan PIN per orang, agar setiap transaksi jelas siapa pelakunya.

Kriteria penerimaan:
1. Aplikasi hanya dapat login pada perangkat terdaftar (M10); PIN 6 digit per pengguna; 5 kali salah → terkunci 15 menit dan admin sistem diberi tahu (PAR-36 [USULAN]); layar terkunci setelah 10 menit tidak aktif (PAR-37 [USULAN]) tanpa kehilangan data.
2. Tidak ada tombol ubah/hapus pada transaksi terkirim; koreksi hanya oleh Admin Keuangan dengan alasan (FR-M3-07).
3. Sopir baru mampu menjalankan satu rit lengkap (Berangkat–Selesai–bayar–Setor) tanpa pendampingan setelah pelatihan ≤ 2 jam dan panduan 1 halaman (NFR-16); diuji pada pilot 2 truk.
4. Kuota ≤ 50 MB/bulan per sopir (foto terkompresi, jejak GPS ponsel hanya cadangan) dan ukuran unduhan aplikasi kecil (NFR-17); diukur pada pilot.
5. Perangkat hilang: admin sistem memblokir dan menghapus jarak jauh (BR-37); akun karyawan keluar dinonaktifkan hari itu.
6. Pesan kesalahan berbahasa Indonesia dan berisi tindakan, misalnya "Sinyal hilang — data tersimpan, lanjutkan"; tidak ada kode teknis.

### 7.3.5 Aturan bisnis yang dipaksakan
BR-07 (pelunasan lewat sopir ke faktur, masuk setoran hari itu), BR-08 (setor hari yang sama), BR-10 (rit terkunci bila setoran belum ditutup), BR-19 (harga tidak terlihat/terubah selain pesanan), BR-22 (bukti kirim; volume parsial beralasan), BR-23 (jarak lokasi), BR-24 (rit gagal tercatat), BR-25 (keterangan perjalanan), BR-36/BR-37 (akun dan perangkat), BR-38 (tanpa hapus).

### 7.3.6 Pengecualian & kegagalan
- Ponsel rusak di tengah hari: sopir login di ponsel cadangan; rit yang belum Selesai berlanjut; data belum tersinkron di ponsel rusak dipulihkan bila ponsel hidup kembali, jika tidak mengikuti US-M3-09 KP-5.
- Ganti kru di tengah hari (sopir sakit): Dispatcher menetapkan pengganti pada jadwal kru; setoran dipisah per pengguna — masing-masing menyetor kas yang diterimanya.
- Sopir memilih rit yang salah saat Selesai (pelanggan A dicatat sebagai B): tidak dapat diubah sopir; Admin Keuangan membalik dan mencatat ulang dengan alasan; kas tidak berubah.
- Pelanggan meminta tambahan tangki di lokasi: sopir menghubungi Dispatcher; pesanan baru dibuat di M2 (kontrol kredit tetap berlaku) dan rit baru muncul di aplikasi.
- Truk lain membantu menyelesaikan rit: Dispatcher memindahkan rit ke truk itu lebih dulu; sopir tidak dapat mengambil rit truk lain.
- Kehilangan uang di jalan: setoran diajukan apa adanya; selisih mengikuti alur M4 dengan bukti laporan.

### 7.3.7 Di luar cakupan M3
Optimasi rute; pemesanan oleh pelanggan (Tahap 2); pemeliharaan armada; pencatatan pengisian air (M8, operator produksi); pelacakan berkelanjutan sebagai sumber utama (M12, perangkat GPS).

### 7.3.8 Hal terbuka
PTB-09, PTB-10, PTB-18, PTB-19, PTB-20, PTB-23, PTB-29.

## 7.4 M4 — Kas & Setoran

### 7.4.1 Tujuan
Uang tunai dari 18 titik penerimaan tercatat seharusnya vs diterima setiap hari, selisih dihitung sistem dan dijelaskan pada hari yang sama, dan kas harian ditutup ≤ 15 menit dengan ringkasan H+0 untuk pemilik. Menjawab P1, T1, KPI-01–KPI-03, KPI-08; FR-M4-01 s.d. FR-M4-07; BR-08 s.d. BR-14; P-06.

### 7.4.2 Peran & antarmuka
Web kantor. Admin Keuangan (dan Admin Keuangan cadangan, R13): penerimaan setoran, selisih, transfer, kas kantor, tutup kas. Pemilik: keputusan selisih ≥ ambang, izin pengecualian, ringkasan H+0 (web/ponsel). Sopir, operator depot, kasir: melihat hasil setoran mereka di aplikasinya (M3/M6/M7). Pemilik tidak menginput setoran (BRD 4.2).

### 7.4.3 Objek & status
Setoran (Berjalan → Diajukan → Diterima → Ditutup), Selisih (Terbentuk → Dijelaskan → Disetujui/Ditolak → Ditindaklanjuti → Selesai), Transfer masuk (Belum dicocokkan / Cocok / Tidak ditemukan), Kas kantor (saldo harian), Setor ke bank, Kas kecil (S), Hari kas (Terbuka → Ditutup), Ganti rugi karyawan (Tercatat → Dilunasi).

### 7.4.4 User story

**US-M4-01 Melihat posisi kas harian per sumber** — M — FR-M4-01, BR-08, P-06 langkah 1
Sebagai Admin Keuangan, saya ingin melihat dalam satu layar berapa uang yang seharusnya ada di setiap sopir, depot, toko, dan kas kantor hari ini, agar saya tahu siapa yang belum menyetor sebelum menutup kas.

Kriteria penerimaan:
1. Layar "Kas hari ini": satu baris per sumber (7 sopir, 10 depot, 1 toko, kas kantor): seharusnya (dari M3/M6/M7, diperbarui saat sinkron), status setoran, diterima, selisih, alasan; total per lini dan keseluruhan.
2. Kolom terpisah untuk transfer belum dicocokkan dan QRIS (PTB-04) agar tidak tercampur dengan kas fisik.
3. Kas kantor: saldo awal + setoran diterima − setor ke bank − pengeluaran kas kecil (bila S) − penggantian pengeluaran rit; saldo sistem dibandingkan dengan hitung fisik saat tutup kas (US-M4-06).
4. Sumber yang belum menyetor lewat waktu ditonjolkan: setoran sopir belum Diajukan > 1 jam setelah rit terakhir Selesai (PAR-44 [USULAN]); setoran depot > 1 hari (PAR-27); kas outlet depot > PAR-02 ditandai (BR-08).
5. Riwayat per tanggal dan ekspor Excel (NFR-23).

**US-M4-02 Menerima setoran dan menghitung selisih** — M — FR-M4-02, FR-M4-03, BR-08, BR-09, BR-12, K12, P-01 langkah 9, P-02 langkah 6
Sebagai Admin Keuangan, saya ingin memasukkan jumlah uang fisik yang saya terima dan membiarkan sistem menghitung selisihnya, agar tidak ada perdebatan tentang angka seharusnya.

Kriteria penerimaan:
1. Daftar setoran Diajukan (sopir) dan tutup shift belum disetor (depot/toko); memilih satu menampilkan ringkasan seharusnya per rit/transaksi, pelunasan, dan pengeluaran menunggu verifikasi (US-M3-08); angka seharusnya tidak dapat diubah.
2. Admin Keuangan memasukkan jumlah fisik diterima (rincian pecahan opsional [USULAN]) dan memverifikasi pengeluaran rit satu per satu (terima/tolak, PTB-20); sistem menghitung selisih = diterima − (seharusnya − pengeluaran diterima).
3. Selisih ≠ 0 → alasan wajib dari daftar (salah kembalian, uang rusak/palsu, nota pengeluaran ditolak, kurang bayar pelanggan belum tercatat, lainnya + teks) dan objek Selisih terbentuk (Bab 5.2).
4. |Selisih| ≥ PAR-01 → objek Selisih dikirim ke pemilik seketika dengan tenggat tindak lanjut 24 jam (BR-09, 6.2a). Setoran tetap Ditutup oleh Admin Keuangan setelah selisih diberi alasan, berapa pun besarnya; keputusan pemilik berjalan di alur Selisih (US-M4-03) dan tidak menahan penutupan (BR-10 mengacu pada penutupan oleh Admin Keuangan). Di bawah ambang: Admin Keuangan menutup dengan alasan; pemilik melihatnya di H+0.
5. Selisih lebih dicatat dan disetor penuh; tidak ada pengembalian ke penyetor (BR-12).
6. Penerimaan mencatat waktu; setoran diterima setelah PAR-06 atau pada hari berikutnya ditandai "terlambat" dengan alasan (BR-08).
7. Setoran depot/toko diterima secara fisik atau lewat setor bank dengan slip (PTB-23) yang dicocokkan di US-M4-04; tutup shift depot yang belum disetor > 1 hari ditandai (PAR-27).
8. Setoran Ditutup membuka kunci rit sopir hari berikutnya secara otomatis (BR-10) dan hasilnya tampil di aplikasi sopir/POS.
9. Pemisahan tugas: penerima setoran tidak dapat mengubah transaksi lapangan; peran Admin Keuangan dapat dipegang dua orang (utama dan cadangan, R13) [ASUMSI-PRD]; pemilik tidak menerima setoran.
10. Opsional (PTB-62, PAR-83, bawaan nonaktif): bila pemilik mengaktifkan PAR-83, selisih kurang ≥ ambang PAR-83 yang belum diputuskan tetap mengunci rit sopir tersebut sampai pemilik memutuskan; kejadian ini tampil sebagai notifikasi kritis ke pemilik dan Dispatcher (6.3).

**US-M4-03 Menindaklanjuti selisih dan mencatat ganti rugi** — M — FR-M4-03, BR-09, BR-11, BR-12, KPI-03; FR-M4-07 (S)
Sebagai Pemilik, saya ingin memutuskan setiap selisih di atas ambang dan melihat riwayat selisih per orang, agar tindak lanjut adil dan berdasar data.

Kriteria penerimaan:
1. Daftar selisih terbuka dengan umur; selisih yang belum Selesai > 24 jam ditonjolkan dan dihitung pada KPI-03.
2. Pemilik memutuskan: **Disetujui** (alasan diterima; selisih dibebankan ke akun beban selisih kas pada pusat laba sumbernya, M11) atau **Ditolak** → Ditindaklanjuti: sistem mencatat "beban ganti rugi karyawan" per kejadian (karyawan, tanggal, jumlah, rit/shift, alasan) — sistem tidak memotong gaji (BR-11c).
3. Rekap bulanan ganti rugi per karyawan diekspor (Excel/PDF) ke penggajian; pelunasan ganti rugi dicatat Admin Keuangan (setor tunai karyawan atau konfirmasi potongan dari penggajian, PTB-22); saldo ganti rugi per karyawan terlihat pemilik dan karyawan bersangkutan.
4. Parameter "ganti rugi aktif" diatur pemilik setelah Peraturan Perusahaan berlaku (BR-11a/b, R08); sebelum aktif, selisih Ditolak tetap tercatat tanpa beban ganti rugi (PTB-22).
5. Selisih di bawah ambang yang ditutup Admin Keuangan dapat dibuka kembali pemilik dalam 7 hari [USULAN].
6. Riwayat selisih per sopir/operator (S, FR-M4-07): jumlah kejadian, nilai kurang/lebih, alasan per bulan, dan deret hari tanpa selisih sebagai dasar insentif nihil selisih 3 bulan (BR-12, usulan BRD).

**US-M4-04 Mencatat dan mencocokkan transfer masuk** — M (pencocokan manual) / S (impor berkas) — FR-M4-04, NFR-22, P-06 langkah 2, PTB-04, PTB-16
Sebagai Admin Keuangan, saya ingin setiap transfer yang dicatat lapangan dicocokkan dengan mutasi bank, agar tidak ada pembayaran transfer yang ternyata tidak pernah masuk.

Kriteria penerimaan:
1. Daftar transfer tercatat: pembayaran rit (M3), pelunasan transfer (M3/M5), QRIS per shift depot (M6, PTB-04), setor bank sopir/outlet (PTB-23), pelunasan mitra toko (M7) — dengan jumlah, foto bukti, sumber, tanggal, status.
2. Pencocokan manual (M): Admin Keuangan menandai Cocok dengan mencatat referensi mutasi (tanggal, jumlah, keterangan) dari internet banking.
3. Impor berkas mutasi (S): unggah CSV/Excel; sistem mengusulkan pasangan (jumlah sama, tanggal ± 1 hari); Admin Keuangan mengonfirmasi; mutasi tanpa pasangan masuk daftar tindak lanjut.
4. Transfer tanpa mutasi > 2 hari (PAR-39 [USULAN]) → status Tidak ditemukan dan notifikasi pemilik; untuk pembayaran rit, piutang sementara terbentuk pada pelanggan dengan penanda "transfer belum diterima" sampai terselesaikan [USULAN].
5. Hasil pencocokan harian menjadi masukan rekonsiliasi bank bulanan M11 (FR-M11-06).

**US-M4-05 Kas kantor, setor ke bank, dan kas kecil** — M (setor ke bank [USULAN]) / S (kas kecil) — FR-M4-05, FR-M11-02, FR-M11-06
Sebagai Admin Keuangan, saya ingin mencatat uang yang saya setor ke bank dan pengeluaran kas kecil dengan bukti, agar saldo kas kantor di sistem selalu sama dengan uang di laci.

Kriteria penerimaan:
1. Setor ke bank: jumlah, tanggal, rekening PT, foto slip; mengurangi kas kantor; dicocokkan dengan mutasi (US-M4-04). Diperlukan agar rekonsiliasi kas–bank M11 nol selisih [USULAN].
2. Kas kecil (S): pengisian dari kas kantor; pengeluaran dengan kategori, pusat laba, foto bukti; pengisian atau pengeluaran > Rp 500.000 perlu persetujuan pemilik (PAR-43 [USULAN], sejalan BR-38 "di atas Rp 500.000"); rekonsiliasi fisik mingguan dengan selisih beralasan.
3. Semua mutasi kas kantor dan kas kecil menghasilkan jurnal otomatis M11 dengan pusat laba (FR-M11-02).

**US-M4-06 Menutup kas harian dan menerbitkan ringkasan H+0** — M — FR-M4-06, BR-14, NFR-04, P-06 langkah 3–4, FR-M9-01, KPI-02, KPI-08
Sebagai Admin Keuangan, saya ingin menutup kas hari ini dalam ≤ 15 menit setelah semua setoran masuk, agar pemilik menerima ringkasan H+0 tanpa saya mengetik laporan.

Kriteria penerimaan:
1. "Tutup kas" hanya aktif bila: semua setoran sopir hari itu Diterima/Ditutup, semua shift depot dan toko Ditutup dan setorannya Diterima atau tercatat setor bank, tidak ada rit Berangkat/Tiba, dan hari sebelumnya sudah ditutup [USULAN]. Sumber yang menghalangi ditampilkan dengan tombol hubungi.
2. Pengecualian (PTB-21, CR-06): pemilik dapat mengizinkan tutup kas dengan setoran tertunda **per kejadian** (bukan izin tetap) untuk sumber yang berhalangan, dengan alasan (6.2a); setoran tertunda maksimal 1 hari (PAR-89), tercatat sebagai pengecualian di H+0, tetap memblokir rit sopir tersebut (BR-10), dan kasnya harus diterima ≤ 24 jam — lewat itu menjadi selisih yang mengikuti US-M4-03.
3. Layar tutup kas menampilkan seluruh selisih hari itu (alasan, status), transfer belum dicocokkan, dan kas kantor sistem vs hitung fisik; selisih kas kantor wajib alasan dan mengikuti alur selisih.
4. Waktu setoran terakhir hari itu Diterima, "mulai tutup kas", dan "kas ditutup" tercatat; KPI-02 = setoran terakhir Diterima → kas ditutup (Bab 1.3); tutup setelah PAR-06 ditandai terlambat.
5. Setelah ditutup, ringkasan H+0 terbit otomatis ≤ 30 menit (NFR-04) ke pemilik (notifikasi + dashboard M9): omzet per lini, kas seharusnya vs diterima, selisih dan alasan, piutang terbentuk/dilunasi/lewat tempo, rit terjadwal vs selesai per truk, galon per depot, transfer belum dicocokkan, pengecualian hari itu.
6. Pemilik menyetujui atau menolak penjelasan selisih langsung dari ringkasan (satu ketuk per selisih); penolakan mengembalikan selisih ke Admin Keuangan (US-M4-03).
7. Hari yang ditutup terkunci; transaksi terlambat sinkron masuk hari itu dengan penanda dan kasnya ke setoran hari berikutnya (Bab 5.3); koreksi hanya lewat transaksi pembalik (BR-38).

### 7.4.5 Aturan bisnis yang dipaksakan
BR-08 s.d. BR-12 dan BR-14 (lihat kriteria di atas); BR-13 (void) dipaksakan di M6/M7 dan notifikasinya diterima Admin Keuangan (Bab 6.3); BR-38 (koreksi > Rp 500.000 persetujuan pemilik); FR-M10-03 (penerima setoran bukan pembuat transaksi).

### 7.4.6 Pengecualian & kegagalan
- Admin Keuangan berhalangan: Admin Keuangan cadangan menerima setoran dan menutup kas dengan peran yang sama; keduanya terlatih (R13).
- Sopir/operator tidak muncul untuk menyetor: PTB-21; setoran diterima hari berikutnya ditandai; sopir tidak dapat memulai rit (BR-10).
- Internet/listrik kantor mati: tutup kas tertunda; H+0 terbit terlambat dan tercatat; tidak ada jalur manual.
- Uang palsu/rusak ditemukan saat hitung: dicatat sebagai selisih dengan alasan dan foto.
- Setoran lewat bank tanpa penyetor hadir: dianggap Diterima hanya setelah mutasi cocok.

### 7.4.7 Di luar cakupan M4
Penggajian (hanya rekap ganti rugi); gerbang pembayaran; rekonsiliasi bank bulanan dan jurnal (M11); kas outlet mitra Tahap 3 (tenant sendiri, dilaporkan lewat portal).

### 7.4.8 Hal terbuka
PTB-04, PTB-08, PTB-16, PTB-20, PTB-21, PTB-22, PTB-23.

## 7.5 M5 — Piutang & Penagihan

### 7.5.1 Tujuan
Piutang terlihat setiap saat per pelanggan dengan jatuh tempo dan batas yang ditetapkan pemilik; pelanggan yang lewat tempo tertahan otomatis; pelunasan dialokasikan ke faktur yang benar; pelanggan tagihan bulanan menerima faktur otomatis. Menjawab P2, T2, KPI-04; FR-M5-01 s.d. FR-M5-07; BR-01 s.d. BR-07; P-05.

### 7.5.2 Peran & antarmuka
Web kantor. Admin Keuangan: pelunasan, pengingat, faktur, kartu piutang. Pemilik: pemberian Tempo, pembukaan Ditahan, laporan umur piutang. Dispatcher: melihat status kredit dan eksposur saat membuat pesanan (M2). Sopir: pelunasan di lapangan (M3). Kasir toko: penjualan tempo mitra (M7). Pelanggan: faktur dan pengingat via tautan WA/e-mail.

### 7.5.3 Objek & status
Faktur (Terbuka → Sebagian dibayar → Lunas; umur: belum jatuh tempo / 1–7 / 8–30 / > 30 hari), Pelunasan, Uang muka pelanggan [USULAN], Status kredit (Tunai / Tempo / Ditahan), Eksposur kredit, Faktur bulanan, Pengingat (Dijadwalkan → Dibuka), Saldo awal piutang (cut-over).

### 7.5.4 User story

**US-M5-01 Piutang terbentuk otomatis dari pengiriman dan penjualan tempo** — M — FR-M5-01, FR-M5-02, BR-02, BR-06, P-05 langkah 1
Sebagai Admin Keuangan, saya ingin piutang terbentuk sendiri saat rit tempo Selesai atau toko menjual tempo, agar saya tidak pernah mencatat piutang manual.

Kriteria penerimaan:
1. Rit Selesai bercara-bayar tempo → faktur kirim otomatis per rit (PTB-24): nomor (mengikuti PTB-14), tanggal kirim, pelanggan, alamat, nomor rit, volume, harga, jatuh tempo = tanggal kirim + tempo pelanggan (PAR-08). Penjualan tempo toko → faktur per transaksi (M7). Kurang bayar lapangan (PTB-18) → faktur jatuh tempo H+0.
2. Pelanggan bertanda "tagihan bulanan" (BR-05): rit tempo masuk daftar "belum ditagih" dan ditagih lewat faktur bulanan (US-M5-06), bukan faktur per rit.
3. Saldo piutang pelanggan = Σ sisa faktur terbuka + belum ditagih; eksposur (BR-06) = saldo piutang + nilai pesanan tempo Baru/Terjadwal/Dalam pengiriman; keduanya tampil di M1, M2, dan aplikasi sopir (data sinkron).
4. Satu batas kredit per pelanggan berlaku lintas lini (air truk dan toko) [ASUMSI-PRD PTB-25].
5. Faktur dapat diunduh PDF dengan identitas PT (Bab 2.3), tanpa PPN dan tanpa faktur pajak (BR-29), dan dikirim via tautan WA/e-mail; pengiriman tercatat.
6. Faktur tidak dapat dihapus; koreksi lewat nota kredit/pembalik beralasan (BR-38).

**US-M5-02 Mencatat pelunasan dan alokasinya** — M — FR-M5-03, BR-07
Sebagai Admin Keuangan, saya ingin mencatat pelunasan sebagian atau penuh ke faktur tertentu dengan bukti, agar saldo pelanggan selalu tepat.

Kriteria penerimaan:
1. Pelunasan kantor: pelanggan, tanggal, jumlah, cara (tunai kantor → kas kantor M4; transfer → daftar pencocokan US-M4-04), alokasi ke satu atau beberapa faktur (bawaan: tertua dulu, dapat diubah), sebagian/penuh; bukti wajib untuk transfer.
2. Pelunasan lewat sopir (M3) masuk otomatis dengan alokasinya dan setoran hari itu (BR-07); Admin Keuangan tidak mencatat ulang, hanya melihat.
3. Kelebihan bayar menjadi uang muka pelanggan yang dialokasikan otomatis ke faktur berikutnya atau dikembalikan dengan persetujuan pemilik [USULAN].
4. Faktur Lunas terkunci; pembatalan pelunasan hanya lewat pembalik beralasan (BR-38), > Rp 500.000 dengan persetujuan pemilik.
5. Bukti pelunasan digital (PDF/WA) untuk pelanggan.

**US-M5-03 Kontrol jatuh tempo dan status Ditahan** — M — FR-M5-06, BR-01, BR-03, KPI-04
Sebagai Pemilik, saya ingin pelanggan yang terlambat lebih dari 7 hari tertahan otomatis dan hanya saya yang bisa membukanya, agar kebijakan kredit berjalan tanpa mengandalkan ingatan.

Kriteria penerimaan:
1. Setiap hari setelah tutup kas [USULAN], sistem menghitung umur faktur; ada faktur lewat tempo > PAR-09 (7 hari) → status kredit Ditahan otomatis; notifikasi ke Dispatcher, Admin Keuangan, dan pemilik (Bab 6.3); pesanan tempo baru diblokir (US-M2-05).
2. Rit tempo pelanggan tersebut yang belum Berangkat ditandai ke Dispatcher untuk diubah ke tunai atau ditarik; rit yang sudah Berangkat berlanjut (PTB-27).
3. Ditahan dilepas otomatis saat seluruh faktur lewat tempo lunas; pembukaan sebelum lunas hanya oleh pemilik dengan alasan, berlaku sampai keterlambatan berikutnya [USULAN].
4. Riwayat status kredit per pelanggan (kapan, oleh siapa, alasan) tersimpan.
5. Masa transisi (R07): pemilik dapat menunda penahanan otomatis per pelanggan dengan tanggal berakhir maksimal 2 bulan sejak go-live (PAR-41 [USULAN]); pelanggan dalam masa transisi tetap tampil di laporan lewat tempo.
6. Pemberian status Tempo mengikuti US-M1-01 KP-3 (BR-01, PAR-11, PAR-82); sistem menampilkan pelanggan Tunai yang memenuhi kedua syarat sebagai daftar "layak diajukan Tempo" [USULAN].

**US-M5-04 Laporan umur piutang dan kartu piutang** — M — FR-M5-04, P-05 langkah 6, KPI-04, BR-39
Sebagai Pemilik, saya ingin melihat umur piutang per pelanggan kapan saja dan menerima ringkasannya setiap minggu, agar piutang lewat tempo tetap di bawah 5%.

Kriteria penerimaan:
1. Laporan umur piutang: per pelanggan, segmen, dan lini (air truk, toko): belum jatuh tempo / 1–7 / 8–30 / > 30 hari; % lewat tempo terhadap total piutang (KPI-04); tersedia kapan saja; ringkasan mingguan otomatis ke pemilik setiap Senin pagi (PAR-40 [USULAN]).
2. Kartu piutang per pelanggan: faktur, pelunasan, uang muka, saldo berjalan; ekspor PDF/Excel; dapat dikirim ke pelanggan sebagai pernyataan piutang.
3. Daftar tindakan harian untuk Admin Keuangan: pelanggan yang perlu diingatkan (H-3, H+1) dan yang akan/sudah Ditahan.
4. Ekspor yang memuat data pelanggan hanya oleh pemilik/Admin Keuangan dengan tujuan tercatat (BR-39).

**US-M5-05 Pengingat jatuh tempo lewat WA** — S — FR-M5-05, NFR-20, K21, P-05 langkah 2
Sebagai Admin Keuangan, saya ingin mengirim pengingat H-3 dan H+1 dari template dengan satu klik, agar pelanggan membayar tepat waktu tanpa saya mengetik pesan.

Kriteria penerimaan:
1. Daftar pengingat harian: H-3 sebelum jatuh tempo dan H+1 sesudahnya (PAR-13), per pelanggan dengan total sisa; tombol membuka WhatsApp dengan template terisi (nomor faktur, jumlah, jatuh tempo, rekening PT); status "dibuka" tercatat.
2. Template dikelola pemilik; bila WhatsApp Business API diaktifkan, pengiriman otomatis tanpa mengubah alur.
3. Pelanggan tagihan bulanan diingatkan berdasarkan faktur bulanan; faktur bersengketa (7.5.6) tidak diingatkan sampai sengketa selesai.

**US-M5-06 Faktur bulanan untuk pelanggan tagihan bulanan** — M — FR-M5-07, BR-05
Sebagai Admin Keuangan, saya ingin faktur bulanan terbit otomatis dengan rincian rit untuk pelanggan berperjanjian, agar hotel dan industri menerima satu tagihan yang jelas.

Kriteria penerimaan:
1. Penanda "tagihan bulanan" hanya untuk pelanggan dengan perjanjian tertulis terlampir dan disetujui pemilik (BR-05).
2. Faktur bulanan terbit otomatis tanggal 1 untuk periode bulan sebelumnya, jatuh tempo tanggal 15 bulan yang sama — untuk layanan bulan M: terbit tanggal 1 bulan M+1, jatuh tempo tanggal 15 bulan M+1 (PAR-12; PTB-26, CR-07); memuat rincian rit (nomor, tanggal, alamat, volume, harga), pelunasan dan uang muka yang sudah diterima, dan saldo terutang.
3. Rit yang Selesai tersinkron setelah faktur terbit masuk faktur bulan berikutnya dengan penanda; faktur yang sudah terbit tidak berubah — koreksi lewat nota kredit.
4. PDF dikirim oleh Admin Keuangan via tautan WA/e-mail pada tanggal 1 dari daftar "faktur bulanan siap kirim"; status pengiriman tercatat.
5. Eksposur pelanggan tagihan bulanan menghitung rit belum ditagih (US-M5-01 KP-3) sehingga batas kredit tetap berlaku sepanjang bulan.

**US-M5-07 Saldo awal piutang saat cut-over** — M — BRD 10.3, NFR-34, FR-M11-09
Sebagai Admin Keuangan, saya ingin memasukkan piutang berjalan per faktur yang sudah dikonfirmasi pelanggan pada tanggal cut-over, agar sistem mulai dengan piutang yang diakui kedua pihak.

Kriteria penerimaan:
1. Input faktur saldo awal per pelanggan: tanggal, keterangan, jumlah, jatuh tempo, bukti konfirmasi pelanggan; ditandai "saldo awal" dan tidak menghasilkan jurnal penjualan (masuk neraca awal M11).
2. Total saldo awal piutang ditandatangani pemilik di sistem sebelum dipakai (NFR-34); perubahan setelahnya hanya lewat koreksi berjejak.
3. Faktur saldo awal mengikuti aturan umur, pengingat, dan penahanan yang sama, dengan masa transisi US-M5-03 KP-5.

### 7.5.5 Aturan bisnis yang dipaksakan
BR-01 (Tunai bawaan; syarat Tempo), BR-02 (tempo 14 hari), BR-03 (Ditahan > 7 hari; pembukaan pemilik), BR-04 (batas per segmen; ubah per pelanggan oleh pemilik), BR-05 (tagihan bulanan berperjanjian), BR-06 (eksposur), BR-07 (pelunasan lewat sopir), BR-29 (tanpa PPN), BR-38, BR-39.

### 7.5.6 Pengecualian & kegagalan
- Pelanggan menyengketakan faktur (volume/harga): Admin Keuangan menandai faktur "bersengketa" dengan catatan; pengingat dan penahanan atas faktur itu ditunda maksimal 7 hari (PAR-45) sampai diputuskan pemilik [USULAN]; keputusan = koreksi lewat nota kredit atau sengketa ditolak.
- Pelanggan membayar ke sopir tetapi sopir mencatatnya sebagai tunai rit (bukan pelunasan): Admin Keuangan membalik dan mengalokasikan ulang dengan alasan; kas tidak berubah.
- Transfer untuk beberapa faktur tanpa keterangan: alokasi tertua dulu, dapat diubah setelah konfirmasi pelanggan.
- Piutang tak tertagih: tidak diatur BRD; penghapusan hanya lewat jurnal manual M11 dengan persetujuan pemilik dan pelanggan tetap Ditahan (PTB-28).
- Pelanggan Tempo tutup usaha/dinonaktifkan: piutang tetap tampil sampai lunas atau dihapuskan (PTB-28).

### 7.5.7 Di luar cakupan M5
Gerbang pembayaran dan pembayaran digital pelanggan (Tahap 2); piutang mitra Tahap 3 (memakai M5 yang sama lewat portal); utang usaha kepada pemasok (M7/M11); penagihan oleh kolektor khusus (tidak ada dalam BRD).

### 7.5.8 Hal terbuka
PTB-18, PTB-24, PTB-25, PTB-26, PTB-27, PTB-28, PTB-29.

## 7.6 M6 — Penjualan Depot (POS)

### 7.6.1 Tujuan
Setiap galon yang keluar dari 10 depot tercatat saat terjadi oleh operator dalam ≤ 10 detik; kas dan bahan habis pakai per shift dihitung sistem dan dicocokkan dengan kenyataan; pasokan air dari truk EQUA dikonfirmasi di depot sehingga neraca air per outlet tersedia — dengan satu aplikasi yang sama untuk depot sendiri dan, kelak, mitra. Menjawab P1, P5, T1, T5, KPI-01, KPI-11; FR-M6-01 s.d. FR-M6-07 (FR-M6-04 diperlakukan M — PTB-07 disetujui); P-02; BR-08, BR-13, BR-15, BR-27, BR-33; NFR-06 s.d. NFR-08, NFR-30.

### 7.6.2 Peran & antarmuka
POS Android/tablet di meja kasir (10 + 1 cadangan; BRD 10.5), offline-first, multi-tenant. Operator depot: transaksi, shift, void, penerimaan pasokan, opname. Admin Keuangan: penerimaan setoran (M4), koreksi berjejak. Pemilik: persetujuan void besar dan penyesuaian stok, laporan per outlet (M9). Sopir: pasokan tiba (M3). Tahap 3: operator mitra dengan tenant sendiri.

### 7.6.3 Objek & status
Shift (Dibuka → Berjalan → Ditutup → Setoran: Belum disetor → Disetor → Diterima), Transaksi POS (Sah / Di-void; void > Rp 100.000: Menunggu persetujuan), Kas outlet (kas awal tetap + tunai berjalan), QRIS per shift (Belum dicocokkan → Cocok; PTB-04), Stok bahan habis pakai per outlet (tutup, tisu, galon kosong; kartu stok), Opname mingguan (Dihitung → Penyesuaian diajukan → Disetujui), Penerimaan pasokan air (Tiba (dari M3) → Dikonfirmasi / Selisih), Stok air outlet (liter), Tenant/Outlet (Bab 4.3).

### 7.6.4 User story

**US-M6-01 Transaksi cepat di POS depot** — M — FR-M6-01, BR-15, NFR-03, P-02 langkah 2, PTB-04, PTB-48
Sebagai Operator depot, saya ingin menjual isi ulang atau galon baru dalam beberapa ketukan sambil antrean menunggu, agar setiap penjualan tercatat tanpa memperlambat pelayanan.

Kriteria penerimaan:
1. Layar utama: kisi produk tenant (isi ulang, galon baru, tutup, tisu, cuci galon, dan lainnya dari master M1; maksimal 12 tombol besar), pengubah jumlah (+/−, bawaan 1), total otomatis; harga hanya dari master yang berlaku hari itu (BR-15) dan tidak dapat diubah operator; tidak ada diskon di POS depot (PTB-48).
2. Pembayaran: **tunai** (uang diterima → kembalian dihitung; bawaan pas) atau **QRIS statis** (operator menandai QRIS; opsional referensi) — QRIS tidak menambah kas fisik dan masuk daftar pencocokan M4 (PTB-04). Cara bayar lain tidak tersedia di Tahap 1 (BRD 3.3).
3. Dari ketuk produk sampai transaksi tersimpan ≤ 10 detik untuk transaksi 1–2 baris (FR-M6-01) dan setiap aksi ≤ 1 detik di perangkat (NFR-03); diukur pada UAT dengan 20 transaksi berturut.
4. Struk opsional: cetak bila printer bluetooth terpasang (NFR-25, C) atau tampilkan ringkasan di layar; nomor transaksi tetap terbentuk tanpa struk.
5. Setiap transaksi mencatat outlet, shift, operator, waktu perangkat, baris produk, jumlah, harga, cara bayar; ID dibuat di perangkat (Bab 6.4); transaksi tersimpan tidak dapat diubah — hanya void (US-M6-03).
6. Pelanggan tidak dicatat per transaksi (FR-M6-08 berprioritas C, tidak dibangun); kolom pelanggan opsional disiapkan kosong untuk Tahap 2 tanpa tampilan di POS.
7. Penjualan bertanda "internal" (misalnya galon untuk kebutuhan sendiri) tidak ada; semua keluar barang di luar penjualan dicatat lewat pemakaian/opname (US-M6-04).

**US-M6-02 Buka dan tutup shift dengan kas dan stok fisik; setoran outlet** — M — FR-M6-02, FR-M6-04 (M, PTB-07), BR-08, P-02 langkah 1, 5, 6, PTB-23, PTB-40
Sebagai Operator depot, saya ingin membuka shift dengan kas awal dan menutupnya dengan menghitung uang dan stok fisik, agar selisih dihitung sistem dan setoran saya jelas.

Kriteria penerimaan:
1. Buka shift: kas awal tetap per outlet (PAR-57, PTB-40) tampil dari sistem dan dikonfirmasi operator dengan hitung fisik; stok awal bahan habis pakai = stok sistem setelah shift sebelumnya (tampil, tidak diketik). Hanya satu shift terbuka per outlet; shift kemarin yang belum ditutup harus ditutup dulu.
2. Selama shift: kas berjalan = kas awal + tunai − kembalian − void tunai; melebihi PAR-02 (Rp 2 juta) → peringatan ke operator dan Admin Keuangan (BR-08) dengan tindakan "setor sebagian" (setor bank dengan foto slip, PTB-23).
3. Tutup shift: sistem menampilkan penjualan per produk, tunai seharusnya, QRIS, void, pemakaian bahan yang seharusnya (US-M6-04 KP-2); operator memasukkan kas fisik dan stok fisik tiga bahan utama (tutup, tisu, galon kosong); selisih kas dan selisih stok dihitung sistem; selisih kas ≠ 0 dan selisih stok di luar toleransi PAR-58 wajib alasan (P-02 langkah 5; bawaan PAR-58 = 0 selama pilot, dapat dinaikkan pemilik setelah ada data pilot).
4. Setelah ditutup, shift terkunci; transaksi baru masuk shift berikutnya; koreksi hanya oleh Admin Keuangan lewat pembalik (BR-38).
5. Setoran: tunai seharusnya − kas awal tetap = jumlah disetor (fisik ke Admin Keuangan atau setor bank dengan foto slip, PTB-23); status setoran mengikuti Bab 5.2; setoran belum diterima > 1 hari ditandai (PAR-27); hasil penerimaan (diterima, selisih, keputusan) tampil ke operator.
6. Operator melihat riwayat shift, selisih, dan galon/hari miliknya 90 hari terakhir; tidak melihat outlet lain [USULAN, paralel US-M3-07 KP-6].
7. Selisih kas ≥ PAR-01 mengikuti alur pemilik (US-M4-02/03); ganti rugi mengikuti PTB-22.

**US-M6-03 Void dengan alasan** — M — FR-M6-03, BR-13, BR-38, P-02 langkah 4, PTB-43
Sebagai Operator depot, saya ingin membatalkan transaksi yang salah dengan alasan tanpa bisa menghapusnya, agar kesalahan tetap terlihat dan tidak disalahgunakan.

Kriteria penerimaan:
1. Void hanya untuk transaksi pada shift yang masih terbuka; alasan wajib dari daftar (salah produk, salah jumlah, pelanggan batal, salah cara bayar, lainnya + teks); transaksi asli tetap tampil bertanda "di-void" dengan transaksi pengganti bila ada.
2. Void > Rp 100.000 memerlukan persetujuan pemilik (BR-13, US-M10-04); bila perangkat offline, void berstatus "menunggu persetujuan" dan transaksi tetap dihitung sebagai penjualan pada tutup shift sampai disetujui (PTB-43); persetujuan yang datang setelah shift ditutup diproses sebagai pembalik oleh Admin Keuangan.
3. Lebih dari 3 void per hari per outlet → notifikasi Admin Keuangan (BR-13); nilai dan jumlah void per outlet per hari tampil di M4 dan laporan outlet.
4. Void QRIS: transaksi ditandai; pengembalian dana di luar sistem dicatat Admin Keuangan sebagai pengeluaran dengan rujukan [USULAN].
5. Tidak ada tombol hapus; tidak ada void massal.

**US-M6-04 Stok bahan habis pakai dan opname mingguan** — M (PTB-07 disetujui) — FR-M6-04, BR-27, P-02 langkah 1, 5, PTB-37, PAR-58
Sebagai Pemilik, saya ingin pemakaian tutup, tisu, dan galon kosong dihitung dari penjualan dan dibandingkan dengan stok fisik, agar kebocoran bahan terlihat per outlet.

Kriteria penerimaan:
1. Kartu stok per bahan per outlet: masuk (penerimaan dari toko EQUA lewat transfer internal US-M7-06 atau dari pemasok lain dengan nota), keluar (pemakaian seharusnya), penyesuaian opname; saldo berjalan.
2. Pemakaian seharusnya dihitung dari resep per produk yang ditetapkan pemilik (misalnya 1 isi ulang = 1 tutup + 1 tisu; 1 galon baru = 1 galon kosong + 1 tutup) — resep dikelola per tenant di master.
3. Tutup shift mencatat stok fisik tiga bahan utama (US-M6-02 KP-3); selisih harian dicatat sebagai informasi dan tidak mengubah saldo; selisih di luar toleransi PAR-58 wajib alasan.
4. Opname mingguan (BR-27, PAR-32): operator menghitung seluruh bahan; selisih terhadap sistem → usulan penyesuaian beralasan → persetujuan pemilik (US-M10-04) → saldo disesuaikan dan jurnal M11 terbentuk; opname yang belum dilakukan pada minggu berjalan ditandai ke Admin Keuangan.
5. Penerimaan bahan dicatat operator saat barang tiba (jumlah per bahan, sumber, foto nota untuk pemasok luar); tanpa pencatatan, stok tidak bertambah.
6. Laporan pemakaian vs penjualan per outlet per minggu/bulan (M9) dengan rasio bahan per galon.

**US-M6-05 Menerima pasokan air dan neraca air outlet** — M — FR-M6-05, P-02 langkah 3, P-04 langkah 3, BR-33, BRD 9.9, PTB-01 (disetujui), PAR-59, PAR-61
Sebagai Operator depot, saya ingin mengonfirmasi volume air yang diterima dari truk EQUA saat truk tiba, agar pasokan dan penjualan galon outlet saya dapat dibandingkan.

Kriteria penerimaan:
1. Rit internal yang Selesai di M3 muncul di POS outlet tujuan sebagai "pasokan tiba" dengan volume diserahkan sopir; operator mengonfirmasi (bawaan volume sama) atau memasukkan volume diterima yang berbeda dengan alasan; selisih kirim–terima ditandai ke M8 dan Dispatcher (P-04 langkah 3).
2. Pasokan yang belum dikonfirmasi sampai tutup shift berikutnya (PAR-61) dianggap diterima sesuai catatan sopir dengan penanda "tanpa konfirmasi operator" dan dilaporkan ke Admin Keuangan.
3. Stok air outlet (liter) = stok awal + volume diterima − galon terjual × 19 L (A9; ukuran galon per produk di master); kapasitas simpan dari master M1; stok yang melampaui kapasitas ditandai.
4. Neraca air outlet mingguan dan bulanan: galon terjual × 19 L vs air diterima ± perubahan stok; galon terjual melebihi air yang tersedia lebih dari PAR-59 → ditandai ke pemilik (indikasi air dari sumber lain atau pencatatan pasokan kurang; BRD 9.9).
5. Volume diterima menjadi dasar harga transfer internal (BR-33, K20) untuk jurnal M11; tidak ada uang di depot untuk pasokan.
6. Pasokan dari sumber selain truk EQUA (darurat) dicatat dengan sumber "lain" dan alasan; tampil di neraca air dan laporan pemilik [USULAN].

**US-M6-06 Bekerja tanpa sinyal** — M — FR-M6-06, NFR-06 s.d. NFR-08
Sebagai Operator depot, saya ingin POS tetap bisa menjual saat sinyal hilang, agar antrean tidak berhenti.

Kriteria penerimaan:
1. Transaksi, void (kecuali yang perlu persetujuan), buka/tutup shift, penerimaan pasokan, dan opname berjalan tanpa sinyal minimal satu hari penuh; katalog produk, harga, resep bahan, dan stok diunduh saat login.
2. Status "tersimpan di perangkat"/"terkirim" per transaksi dan ringkasan antrean; sinkron ≤ 5 menit setelah sinyal kembali; tidak ada transaksi hilang atau dobel (Bab 6.4).
3. Tutup shift offline tetap sah; Admin Keuangan melihat status "menunggu sinkron" dan tidak dapat menerima setoran sebelum seluruh transaksi shift tersinkron (paralel US-M3-09 KP-3).
4. Perubahan harga master yang berlaku hari ini diterapkan saat sinkron berikutnya; transaksi yang sudah terjadi memakai harga yang ada di perangkat saat itu dan ditandai bila berbeda [USULAN].
5. Login PIN offline; perangkat terdaftar (US-M10-02).

**US-M6-07 Paket standar multi-tenant** — M — FR-M6-07, NFR-30, Bab 4.3, BRD 9.5, 9.9
Sebagai Pemilik, saya ingin POS depot yang sama dapat dipasang untuk depot mitra baru tanpa perubahan kode, agar kemitraan Tahap 3 tidak menunggu pengembangan ulang.

Kriteria penerimaan:
1. Setiap outlet berada di bawah satu tenant; tenant EQUA memuat 10 depot sendiri; tenant baru (mitra) dapat dibuat admin sistem dengan katalog standar EQUA disalin sebagai bawaan (Bab 4.3) dan diaktifkan dalam ≤ 1 jam kerja tanpa rilis aplikasi [USULAN ukuran].
2. Data transaksi, shift, stok, dan pengguna terpisah per tenant; tidak ada tampilan, pencarian, atau ekspor lintas tenant dari POS; agregasi hanya di web EQUA dengan hak baca sesuai perjanjian (NFR-30, BRD 10.6).
3. Pengaturan per tenant/outlet tanpa kode: produk dan harga, resep bahan, kas awal tetap, ambang void dan kas, printer, QRIS aktif/tidak, bahasa istilah tetap Indonesia.
4. Seluruh aturan kontrol (shift, void beralasan, selisih otomatis, penerimaan pasokan, neraca air) berlaku sama untuk tenant mitra; tidak ada logika khusus EQUA yang tertanam.
5. Laporan per outlet yang sama tersedia untuk pemilik tenant; laporan yang dipakai EQUA untuk royalti/neraca air mitra (BRD 9.9) bersumber dari data yang sama (dirinci Bab 9).
6. Uji penerimaan: satu tenant uji fiktif dibuat pada UAT dan tidak dapat melihat data EQUA, dan sebaliknya.

### 7.6.5 Aturan bisnis yang dipaksakan
BR-08 (kas outlet ≤ Rp 2 juta; setor hari yang sama), BR-13 (void), BR-15 (harga master), BR-27 (opname mingguan; penyesuaian disetujui pemilik), BR-33 (pasokan sebagai transfer internal), BR-38 (tanpa hapus); NFR-30.

### 7.6.6 Pengecualian & kegagalan
- Perangkat POS rusak di tengah shift: operator login di perangkat cadangan; shift berlanjut di perangkat baru setelah sinkron; transaksi yang belum tersinkron di perangkat rusak mengikuti US-M3-09 KP-5 (dicatat kantor bila hilang).
- Dua operator dalam sehari (pergantian): shift pertama ditutup dan disetor; shift kedua dibuka dengan kas awal tetap; kas awal tetap tidak berpindah tangan tanpa hitung.
- Pelanggan membayar QRIS tetapi gagal: operator mencatat sebagai tunai bila pelanggan membayar tunai; tidak ada transaksi "gagal" — transaksi baru dibuat setelah pembayaran diterima.
- Listrik padam/tablet habis baterai: kebijakan perangkat (BRD 10.5) — pencatatan di perangkat cadangan; tidak ada nota kertas setelah periode paralel (NFR-35).
- Truk memasok saat outlet tutup: sopir mencatat Selesai dengan foto (US-M3-03 KP-5); operator mengonfirmasi saat buka shift (KP-2 US-M6-05).

### 7.6.7 Di luar cakupan M6
Pelanggan depot terdaftar, langganan antar galon, saldo prabayar (FR-M6-08, C); gerbang pembayaran (QRIS dinamis); diskon/promosi di POS depot (PTB-48); daftar periksa mutu harian dan royalti mitra (Bab 9); pengiriman galon ke rumah pelanggan.

### 7.6.8 Hal terbuka
PTB-04, PTB-23, PTB-37, PTB-40, PTB-43, PTB-48.

## 7.7 M7 — Penjualan Toko & Stok

### 7.7.1 Tujuan
Setiap barang yang masuk toko punya nota pemasok dan harga beli, setiap yang keluar punya transaksi dengan harga mitra atau umum, dan stok di sistem sama dengan stok di rak — sehingga margin per barang dan utang pemasok diketahui. Menjawab P1, P4, T1, T4; FR-M7-01 s.d. FR-M7-06; P-03; BR-04, BR-06, BR-17, BR-18, BR-27, BR-28; PTB-25 (disetujui).

### 7.7.2 Peran & antarmuka
POS pada tablet Android toko (BRD 10.5 menyebut tablet atau PC; tablet dipilih agar satu basis kode POS, CR-16), memakai kerangka POS yang sama dengan M6 ditambah modul stok, pemasok, dan mitra [USULAN]. Kasir toko: penjualan, penerimaan barang, opname, daftar pesan ulang, usulan produk/harga. Admin Keuangan: persetujuan produk/harga toko (BRD 10.2), opname bersama kasir, utang pemasok, koreksi. Pemilik: persetujuan diskon > 5% dan penyesuaian stok. Dispatcher: penanda mitra terdaftar pada pelanggan (M1).

### 7.7.3 Objek & status
Barang toko (Aktif/Nonaktif; harga umum, harga mitra, harga beli rata-rata, stok minimum), Pemasok (master, [USULAN] dikelola kasir dan disetujui Admin Keuangan), Nota pembelian (Diterima → Utang terbentuk (S) → Lunas), Kartu stok (masuk/keluar/penyesuaian/transfer internal), Transaksi toko (Sah / Di-void; tunai, QRIS, tempo mitra), Diskon (≤ 5% / Menunggu persetujuan), Opname bulanan (Dihitung → Penyesuaian diajukan → Disetujui), Transfer internal ke depot (Dikirim → Diterima), Daftar pesan ulang, Shift/kas toko (seperti M6).

### 7.7.4 User story

**US-M7-01 POS toko dengan harga mitra dan umum** — M — FR-M7-01, BR-15, BR-17, BR-18, P-03 langkah 2
Sebagai Kasir toko, saya ingin harga mitra terpasang otomatis untuk mitra terdaftar dan harga umum untuk yang lain, agar tidak ada tawar-menawar di kasir.

Kriteria penerimaan:
1. Transaksi memilih pelanggan (wajib untuk harga mitra dan tempo; opsional "umum" untuk tunai): pelanggan bertanda "mitra toko" (US-M1-01 KP-6; BR-18) otomatis memakai harga mitra, selain itu harga umum; kasir tidak dapat memilih harga secara manual (BR-15).
2. Pencarian barang dengan nama/kode; pemindaian barcode kamera opsional [USULAN]; jumlah, satuan, total otomatis; cara bayar tunai, QRIS statis (PTB-04), atau tempo mitra (US-M7-04).
3. Diskon per transaksi maksimal 5% oleh kasir dengan alasan (BR-17); di atas itu transaksi berstatus "menunggu persetujuan pemilik" dan tidak dapat diselesaikan sampai disetujui (US-M10-04); diskon tercatat per transaksi dan dilaporkan bulanan.
4. Stok berkurang saat transaksi tersimpan; barang berstatus stok 0 tidak dapat dijual (BR-28: barang tanpa nota tidak masuk stok, karena itu tidak dapat dijual).
5. Void mengikuti aturan M6 (US-M6-03) termasuk BR-13; retur barang oleh pelanggan pada hari yang sama dilakukan lewat void; setelah itu lewat nota kredit oleh Admin Keuangan (PTB-46).
6. Struk tersedia (cetak bila printer; PDF/WA bila diminta); untuk tempo, struk menyebut nomor faktur M5.

**US-M7-02 Penerimaan barang dari pemasok dan kartu stok** — M — FR-M7-02, BR-28, P-03 langkah 1, PTB-38
Sebagai Kasir toko, saya ingin memasukkan barang dari nota pemasok dengan harga belinya, agar stok dan harga pokok selalu bersumber dari nota.

Kriteria penerimaan:
1. Penerimaan wajib merujuk nota pemasok: pemasok (master), nomor dan tanggal nota, foto nota, baris barang (jumlah, harga beli satuan), total; tanpa nota barang tidak dapat diterima (BR-28).
2. Barang baru dibuat kasir dengan nama, kode, satuan, kategori, harga umum, harga mitra, stok minimum, dan berlaku setelah disetujui Admin Keuangan (BRD 10.2); perubahan harga jual mengikuti BR-15 (persetujuan, tanggal berlaku, riwayat).
3. Kartu stok per barang: masuk (nota), keluar (penjualan, transfer internal ke depot), penyesuaian (opname), saldo berjalan, dan harga pokok rata-rata bergerak yang diperbarui setiap penerimaan (PTB-38; metode dapat diubah akuntan, K9).
4. Nota yang belum dibayar membentuk utang pemasok (US-M7-08, S) — bila S belum dibangun, nota tetap tercatat sebagai pembelian tunai/transfer dengan tanggal bayar.
5. Stok awal pada cut-over diimpor dari opname fisik yang ditandatangani (BRD 10.3, NFR-34) dengan harga beli terakhir sebagai harga pokok awal.
6. Penerimaan tidak dapat dihapus; koreksi lewat nota retur pemasok/pembalik beralasan (BR-38).

**US-M7-03 Stok minimum dan daftar pesan ulang** — M — FR-M7-02, P-03 langkah 4
Sebagai Kasir toko, saya ingin daftar barang yang stoknya di bawah minimum tersusun sendiri, agar barang laris tidak kosong.

Kriteria penerimaan:
1. Stok minimum per barang (master); saat saldo ≤ minimum, barang masuk daftar pesan ulang dengan saldo, rata-rata penjualan 30 hari, dan pemasok terakhir; notifikasi ke kasir (Bab 6.3).
2. Daftar dapat ditandai "sudah dipesan" (tanggal, pemasok) dan hilang otomatis saat penerimaan nota masuk.
3. Ekspor daftar (Excel/PDF) untuk pemesanan ke pemasok.

**US-M7-04 Penjualan tempo untuk mitra terdaftar** — M — FR-M7-03, BR-04, BR-06, BR-18, PTB-25 (disetujui), PTB-42
Sebagai Kasir toko, saya ingin penjualan tempo hanya bisa untuk mitra terdaftar yang masih dalam batas kreditnya, agar piutang toko terkendali seperti piutang truk.

Kriteria penerimaan:
1. Cara bayar tempo hanya tersedia bila pelanggan bertanda mitra toko dan berstatus kredit Tempo (US-M1-01 KP-3); pelanggan Ditahan atau Tunai ditolak dengan keterangan, dengan pilihan mengajukan persetujuan pemilik (US-M2-05 KP-3 berlaku sama).
2. Kontrol batas memakai satu batas kredit per pelanggan lintas lini (PTB-25): eksposur = piutang air truk + piutang toko + pesanan tempo belum dikirim + transaksi ini (BR-06); melebihi batas → ditolak.
3. Transaksi tempo membentuk faktur per transaksi di M5 (US-M5-01) dengan tempo pelanggan (bawaan 14 hari); pelunasan, pengingat, dan penahanan mengikuti M5.
4. Toko diasumsikan daring (PTB-42); bila offline, tempo hanya dengan data eksposur sinkron terakhir dan berpenanda untuk tinjauan Admin Keuangan (seperti PTB-19).
5. Mitra depot EQUA (Tahap 3) memakai jalur yang sama dengan batas kredit yang ditetapkan pada perjanjian mitra.

**US-M7-05 Stok opname dan penyesuaian** — M — FR-M7-04, BR-27, P-03 langkah 3
Sebagai Admin Keuangan, saya ingin opname bulanan menghasilkan daftar selisih yang jelas dan penyesuaian yang disetujui pemilik, agar stok di buku sama dengan stok di rak.

Kriteria penerimaan:
1. Opname bulanan (PAR-32) dilakukan kasir bersama Admin Keuangan: lembar hitung per barang (sistem menampilkan saldo hanya setelah jumlah fisik dimasukkan [USULAN, mencegah "menyamakan angka"]); selisih dihitung sistem per barang dalam jumlah dan nilai (harga pokok).
2. Selisih → usulan penyesuaian beralasan (rusak, hilang, salah catat, lainnya) → persetujuan pemilik (US-M10-04) → saldo disesuaikan, kartu stok mencatat penyesuaian, jurnal M11 terbentuk (beban selisih stok L4).
3. Selama opname berjalan, penjualan tetap boleh; sistem menghitung selisih berdasarkan saldo pada waktu hitung per barang.
4. Opname yang belum dilakukan sampai tanggal 5 bulan berikutnya ditandai ke pemilik [USULAN].
5. Riwayat opname dan selisih per barang per bulan tersedia (masukan laporan margin US-M7-07).

**US-M7-06 Transfer internal bahan ke depot sendiri** — M (tambahan, PTB-37 disetujui; tukar CR-14, Bab 2.4) — BR-33 (analog), FR-M6-04, FR-M7-02
Sebagai Kasir toko, saya ingin mengeluarkan tutup, tisu, dan galon kosong untuk depot sendiri sebagai transfer internal tanpa uang, agar stok toko berkurang dan stok depot bertambah dengan nilai yang adil.

Kriteria penerimaan:
1. Transfer internal memilih outlet depot tujuan dan baris barang; stok toko berkurang saat dikirim; stok depot bertambah saat operator mengonfirmasi penerimaan di POS depot (US-M6-04 KP-5); selisih kirim–terima ditandai.
2. Nilai transfer memakai harga mitra (PTB-37) dan dicatat sebagai pendapatan transfer internal L4 dan beban bahan L3, dieliminasi pada konsolidasi (M11) — tidak ada kas, tidak ada piutang.
3. Transfer tidak memerlukan persetujuan tetapi dilaporkan bulanan per depot; transfer ke outlet mitra (Tahap 3) bukan transfer internal melainkan penjualan mitra (US-M7-01).

**US-M7-07 Laporan barang laris/mati dan margin per barang** — S, dijadwalkan RL-6 (kompensasi, Bab 2.4) — FR-M7-05
Sebagai Pemilik, saya ingin tahu barang mana yang laku dan bermargin, agar modal toko tidak terparkir di barang mati.

Kriteria penerimaan:
1. Per barang per bulan: jumlah terjual, omzet, harga pokok (rata-rata bergerak), margin kotor, hari tanpa penjualan, saldo stok dan nilainya; kelompok "laris" (30% teratas) dan "mati" (tanpa penjualan ≥ 90 hari [USULAN]).
2. Per pelanggan mitra: pembelian bulanan (untuk paket mitra Bab 9).
3. Ekspor sesuai US-M9-03.

**US-M7-08 Utang pemasok dan jadwal pembayaran** — S — FR-M7-06, FR-M11-07
Sebagai Admin Keuangan, saya ingin utang ke pemasok tercatat dari nota dengan jatuh temponya, agar pembayaran terjadwal dan tidak ada nota terlewat.

Kriteria penerimaan:
1. Nota pembelian yang belum dibayar membentuk utang dengan jatuh tempo (dari nota; bila kosong 30 hari, PAR-67); daftar utang per pemasok dan umur; pengingat jatuh tempo ke Admin Keuangan (Bab 6.3).
2. Pembayaran (kas kantor atau transfer) dicatat di M4 dan dialokasikan ke nota; sebagian/penuh; bukti wajib untuk transfer.
3. Terintegrasi ke M11 sebagai utang usaha (US-M11-07); saldo awal utang pemasok saat cut-over diinput dari nota (BRD 10.3).

**US-M7-09 Kas toko harian dan setoran** — M — FR-M4-01, BR-08, BRD 1.2 (18 titik kas)
Sebagai Kasir toko, saya ingin menutup kas toko setiap hari dengan cara yang sama seperti depot, agar setoran toko masuk tutup kas Admin Keuangan.

Kriteria penerimaan:
1. Shift/kas toko mengikuti US-M6-02: kas awal tetap, kas fisik saat tutup, selisih otomatis beralasan, setoran fisik atau setor bank (PTB-23), hasil penerimaan tampil ke kasir.
2. Penjualan tempo dan QRIS tidak masuk kas fisik; tercatat di piutang (M5) dan daftar pencocokan (M4).
3. Tutup kas Admin Keuangan (US-M4-06) mensyaratkan shift toko ditutup.

### 7.7.5 Aturan bisnis yang dipaksakan
BR-04/BR-06 (batas kredit lintas lini), BR-13 (void), BR-15 (harga master), BR-17 (diskon ≤ 5%), BR-18 (harga mitra hanya mitra terdaftar), BR-27 (opname bulanan; penyesuaian disetujui pemilik), BR-28 (tanpa nota tidak masuk stok, tidak dapat dijual), BR-38.

### 7.7.6 Pengecualian & kegagalan
- Barang datang tanpa nota (pemasok kecil): kasir membuat "nota pengganti" dengan foto barang dan keterangan; barang tetap tidak dapat dijual sampai Admin Keuangan menerima nota pengganti itu sebagai nota (BR-28) [USULAN].
- Harga beli berbeda per nota: harga pokok rata-rata bergerak menyerap perbedaan (PTB-38); harga jual tidak berubah otomatis.
- Mitra terdaftar berubah status (berhenti membeli air EQUA > 90 hari): penanda mitra lepas otomatis (US-M1-01 KP-6) dan harga umum berlaku; pemilik dapat menetapkan manual.
- Stok fisik negatif secara sistem (penjualan tercatat melebihi stok karena penerimaan terlambat dicatat): sistem menolak penjualan di stok 0 (KP-4 US-M7-01); kasir mencatat penerimaan lebih dulu.
- Toko offline: penjualan tunai tetap berjalan (kerangka POS M6); tempo mengikuti PTB-42.

### 7.7.7 Di luar cakupan M7
Pembelian daring ke pemasok; katalog/toko daring untuk mitra (Tahap 3 portal); manajemen gudang berlokasi banyak (satu toko); retur ke pemasok lewat alur khusus (dicatat sebagai nota retur sederhana).

### 7.7.8 Hal terbuka
PTB-37, PTB-38, PTB-42, PTB-46.

## 7.8 M8 — Produksi & Stok Air

### 7.8.1 Tujuan
Setiap liter yang diproduksi dua sumber air tercatat dari angka meter dengan foto, setiap liter yang keluar tercatat per pengisian truk dan terkait rit, sehingga susut harian per sumber dan utilisasi kapasitas diketahui — dasar keputusan kapasitas (K22, R06) dan standar mutu untuk kemitraan. Menjawab P4, P5, T4, T5; FR-M8-01 s.d. FR-M8-05; P-04; BR-26; K1, K22; A9; FR-M12-05, FR-M12-07 (S).

### 7.8.2 Peran & antarmuka
Aplikasi lapangan Android pada ponsel per sumber air (2 unit; BRD 10.5), offline-first. Operator produksi (±6 orang, bergantian): meter, pengisian, pasokan, uji mutu — hanya sumber air yang ditugaskan (BRD 4.2). Dispatcher: melihat pengisian vs jadwal rit. Pemilik: neraca air, susut, utilisasi, mutu (M9). Sopir: rit yang diisi (M3). Operator depot: konfirmasi pasokan (M6).

### 7.8.3 Objek & status
Sumber air (master M1: kapasitas harian, meter, geofence), Pembacaan meter (pagi/malam; Tercatat → Diverifikasi bila anomali), Produksi harian per sumber, Pengisian truk (Dicatat → Terkait rit → Diverifikasi geofence (S)), Pasokan depot (subset pengisian untuk rit internal; Dikirim → Dikonfirmasi depot), Neraca air harian (Terbentuk → Susut normal / Susut di atas ambang → Investigasi → Selesai), Utilisasi (harian/bulanan), Catatan mutu (Jadwal uji → Hasil → Tindakan; S).

### 7.8.4 User story

**US-M8-01 Mencatat produksi harian dari angka meter dengan foto** — M — FR-M8-01, P-04 langkah 1
Sebagai Operator produksi, saya ingin memotret dan mengetik angka meter pagi dan malam, agar produksi harian dihitung sistem tanpa buku.

Kriteria penerimaan:
1. Setiap sumber memiliki satu atau lebih meter (master M1: pengenal, satuan, angka awal cut-over); pembacaan pagi (awal) dan malam (akhir) per meter: angka, foto meter (kamera aplikasi, terkompresi PAR-38), waktu perangkat; produksi harian = Σ (akhir − awal) per sumber.
2. Angka yang lebih kecil dari pembacaan sebelumnya ditolak dengan pesan; putaran meter (rollover) atau penggantian meter dicatat admin sistem/Admin Keuangan dengan alasan sehingga hitungan tetap benar [USULAN].
3. Pembacaan yang belum ada pada 08.00 (pagi) atau 23.00 (malam) [USULAN jam] → pengingat ke operator dan notifikasi ke pemilik pada H+0 sebagai "produksi belum tercatat"; produksi hari itu berstatus "belum lengkap" sampai dilengkapi dengan alasan.
4. Produksi harian yang menyimpang > 20% dari rata-rata 7 hari ditandai untuk verifikasi (foto meter dibandingkan) [USULAN ambang, PAR-68].
5. Pembacaan tidak dapat diubah setelah tersinkron; koreksi oleh Admin Keuangan dengan alasan dan foto pembanding (BR-38).

**US-M8-02 Mencatat pengisian truk per rit** — M — FR-M8-02, P-04 langkah 2, FR-M12-05 (S), PTB-09
Sebagai Operator produksi, saya ingin mencatat setiap pengisian truk dengan volume dan rit yang dituju, agar setiap liter yang keluar dari sumber punya tujuan.

Kriteria penerimaan:
1. Pengisian: truk (pilih dari daftar truk yang dijadwalkan mengisi di sumber ini hari itu; truk lain dapat dipilih dengan konfirmasi), volume (bawaan 5.000 L, ubah dengan alasan), waktu perangkat, rit tujuan yang disarankan dari papan jadwal M2 (rit berikutnya truk itu yang belum Berangkat), foto opsional.
2. Satu pengisian terkait satu rit (PTB-09); pengisian tanpa rit terjadwal dicatat sebagai "pengisian tanpa rit" dan ditandai ke Dispatcher dan pemilik (indikasi rit tanpa pesanan, P-01 langkah 8).
3. Pengisian untuk rit internal pasokan depot ditandai otomatis sebagai pasokan (US-M8-03).
4. Bila FR-M12-05 tersedia, pengisian dicocokkan dengan masuk/keluar geofence sumber (US-M12-06); ketidaksesuaian ditandai, tidak memblokir pencatatan.
5. Operator hanya melihat dan mencatat sumber air yang ditugaskan; pergantian operator antar sumber diatur lingkup (US-M10-01 KP-3).
6. Pengisian tersimpan tidak dapat diubah operator; koreksi oleh Admin Keuangan lewat pembalik (BR-38); volume terkirim ke pelanggan (M3) yang lebih kecil dari volume pengisian ditampilkan sebagai selisih rit untuk neraca air.

**US-M8-03 Pasokan air ke depot sendiri** — M — FR-M8-02, P-04 langkah 3, PTB-01 (disetujui), BR-33, FR-M6-05
Sebagai Pemilik, saya ingin air yang dikirim ke depot sendiri tercatat dari pengisian sampai konfirmasi depot, agar lini truk dan lini depot sama-sama adil (BR-33).

Kriteria penerimaan:
1. Rit internal (US-M2-01 KP-6) mengalir: pengisian di sumber (US-M8-02) → Selesai di depot oleh sopir dengan volume diserahkan (US-M3-03 KP-5) → konfirmasi volume diterima oleh operator depot (US-M6-05).
2. Sistem menampilkan tiga angka per pasokan (diisi, diserahkan, diterima); selisih di luar toleransi (PAR-69 [USULAN], bawaan 2%) ditandai ke Dispatcher dan pemilik dan masuk perhitungan susut (US-M8-04).
3. Nilai pasokan untuk jurnal M11 = volume diterima × harga transfer (tarif zona alamat depot, segmen depot pihak ketiga; K20).
4. Ringkasan pasokan per depot per hari/bulan (liter, jumlah rit) tersedia untuk neraca air outlet (US-M6-05 KP-4) dan Bab 9 (mitra).

**US-M8-04 Neraca air harian per sumber dan susut** — M — FR-M8-03, BR-26, P-04 langkah 4, PTB-41
Sebagai Pemilik, saya ingin tahu setiap hari berapa liter yang hilang antara meter dan truk, agar kebocoran atau pengisian tak tercatat terlihat.

Kriteria penerimaan:
1. Neraca harian per sumber sesuai BRD: produksi − Σ pengisian (termasuk pasokan depot) = susut; susut dalam liter dan persen produksi; dihitung otomatis setelah pembacaan malam.
2. Susut > 5% (PAR-18, BR-26) → tugas investigasi ke operator (alasan dari daftar: kebocoran, pencucian/pembuangan, meter bermasalah, pengisian belum tercatat, lainnya + foto) dan laporan ke pemilik pada H+0 (Bab 6.3); status Investigasi → Selesai setelah pemilik menerima penjelasan.
3. Sebagai informasi tambahan (PTB-41): rata-rata susut 7 hari dan pembacaan level tandon opsional (bila operator memasukkannya) untuk menjelaskan pergeseran stok antar hari; peringatan BR-26 tetap memakai angka harian.
4. Neraca bulanan per sumber: produksi, pengisian pelanggan, pasokan depot, susut, rata-rata per hari; ekspor (M9).
5. Susut negatif (pengisian melebihi produksi) ditandai sebagai anomali pencatatan (meter atau pengisian ganda) dan wajib verifikasi Admin Keuangan.

**US-M8-05 Utilisasi kapasitas dan peringatan** — S — FR-M8-04, P-04 langkah 5, K1, K22, R06
Sebagai Pemilik, saya ingin melihat seberapa dekat produksi dengan kapasitas 50.000 L per sumber, agar keputusan kapasitas dan kemitraan berdasar angka.

Kriteria penerimaan:
1. Utilisasi harian = Σ pengisian ÷ kapasitas harian sumber (master; K1); utilisasi bulanan = rata-rata harian dan hari di atas 90%; tampil per sumber dan gabungan.
2. Dua tingkat dengan satu definisi: utilisasi harian > 90% (PAR-19) langsung ditandai di dashboard dan H+0 (P-04 langkah 5); > 90% selama 3 hari berturut (PAR-85 [USULAN]) → notifikasi push ke pemilik (mencegah notifikasi berlebih, RP-10); ruang tumbuh (liter/hari dan setara rit) ditampilkan.
3. Ekspor data harian 6 bulan untuk studi kelayakan kapasitas (K22) dalam satu berkas.

**US-M8-06 Catatan mutu air** — S — FR-M8-05, BRD 9.5, 9.9, EP-3-05
Sebagai Pemilik, saya ingin jadwal dan hasil uji laboratorium per sumber dan per depot tercatat dengan tindak lanjutnya, agar standar mutu kemitraan berdasar bukti.

Kriteria penerimaan:
1. Jadwal uji per lokasi (sumber, depot) dengan frekuensi yang ditetapkan pemilik/konsultan (tidak ada bawaan di BRD; PAR-70); pengingat H-7 ke pemilik dan operator.
2. Hasil uji: tanggal, laboratorium, parameter dan nilai, lulus/tidak, lampiran foto/PDF sertifikat; hasil tidak lulus → tindakan wajib (deskripsi, penanggung jawab, tenggat) dan notifikasi pemilik.
3. Riwayat per lokasi untuk audit dan prospektus kemitraan (Bab 9); daftar periksa mutu harian depot dirinci pada Tahap 3 (EP-3-05), tidak dibangun di Tahap 1.

**US-M8-07 Bekerja tanpa sinyal di sumber air** — M — NFR-06 s.d. NFR-08, NFR-15 s.d. NFR-17
Sebagai Operator produksi, saya ingin mencatat meter dan pengisian meski sinyal di sumber lemah, agar tidak ada yang dicatat di kertas dulu.

Kriteria penerimaan:
1. Pembacaan meter, pengisian, pasokan, dan investigasi susut berfungsi offline minimal satu hari; jadwal rit hari ini (daftar truk yang akan mengisi) diunduh saat login dan diperbarui di latar.
2. Status per item dan sinkron otomatis ≤ 5 menit (Bab 6.4); foto terkompresi (PAR-38); login PIN pada perangkat terdaftar (US-M10-02).
3. Antarmuka ≤ 3 langkah, teks ≥ 16 pt, istilah lapangan (NFR-15 s.d. NFR-18); pelatihan ≤ 2 jam (NFR-16).

### 7.8.5 Aturan bisnis yang dipaksakan
BR-26 (susut > 5% → investigasi dan laporan pemilik), BR-33 (pasokan sebagai transfer internal dengan harga K20), BR-38 (tanpa hapus; koreksi berjejak); lingkup operator per sumber (BRD 4.2).

### 7.8.6 Pengecualian & kegagalan
- Meter rusak/diganti: admin sistem mencatat meter baru dengan angka awal; pembacaan terakhir meter lama ditutup; produksi hari itu diestimasi dari rata-rata 7 hari dan ditandai [USULAN].
- Truk mengisi di sumber yang bukan rencananya: operator memilih truk dengan konfirmasi; Dispatcher diberi tahu; rit tetap terkait.
- Pengisian sebagian (tangki masih berisi dari rit gagal): operator mencatat volume sebenarnya dengan alasan "sisa muatan" (terkait US-M3-06 KP-2).
- Ponsel sumber rusak: perangkat cadangan lapangan (BRD 10.5) dipakai; pencatatan atas nama operator dengan penanda perangkat cadangan.
- Pembacaan malam terlewat: neraca hari itu "belum lengkap"; pembacaan pagi berikutnya menjadi akhir hari sebelumnya dan awal hari ini, dengan produksi dua hari ditandai "gabungan" [USULAN].

### 7.8.7 Di luar cakupan M8
Sensor/IoT dan meter otomatis (BRD 3.3); perencanaan produksi; pembelian air dari pihak ketiga; daftar periksa mutu harian dan audit mitra (Tahap 3).

### 7.8.8 Hal terbuka
PTB-41; PAR-68 s.d. PAR-70.

## 7.9 M9 — Laporan & Dashboard Pemilik

### 7.9.1 Tujuan
Pemilik melihat keadaan usaha hari ini dalam satu layar tanpa menginput apa pun (KPI-08), menerima laba kotor per lini setiap bulan (KPI-09), dan mendapat pengecualian yang perlu diputuskan — semua bersumber dari data modul lain, tanpa pencatatan ulang. Menjawab P4, T4, KPI-08–KPI-11; FR-M9-01 s.d. FR-M9-06; NFR-04, NFR-19, NFR-23; BR-32, BR-33, BR-39.

### 7.9.2 Peran & antarmuka
Web kantor, responsif untuk ponsel pemilik (NFR-19). Pemilik: semua laporan dan kotak masuk pengecualian. Admin Keuangan: laporan keuangan dan kas. Dispatcher: laporan operasional pengiriman. Akuntan (baca-saja, PTB-11 disetujui): laporan keuangan. Komite pengarah: laporan KPI. M9 tidak memiliki transaksi sendiri; setiap angka berasal dari M2–M8, M11, dan M12 dengan satu definisi.

### 7.9.3 Objek & status
Ringkasan H+0 (Hari berjalan/belum ditutup → Terbit → Ditinjau pemilik), Laporan bulanan per lini (Sementara → Final setelah periode dikunci, BR-32), Notifikasi/pengecualian (Baru → Dibaca → Ditindaklanjuti → Selesai), Log ekspor, Katalog laporan (7.9.4).

### 7.9.4 Katalog laporan (turunan seluruh modul)

| Laporan | Isi utama | Sumber | Ketersediaan | Pembaca | Prio | Rujukan |
|---|---|---|---|---|---|---|
| Ringkasan H+0 | Omzet per lini; kas seharusnya vs diterima; selisih dan alasan; piutang terbentuk/dilunasi/lewat tempo; rit terjadwal vs selesai per truk; galon per depot; transfer belum dicocokkan; pengecualian | M4 tutup kas | Harian, ≤ 30 menit setelah tutup kas | Pemilik | M | FR-M9-01, NFR-04 |
| Kas hari ini | Posisi per sumber, status setoran | M4 | Real-time | Admin Keuangan, pemilik | M | FR-M4-01 |
| Riwayat selisih per orang | Kejadian, nilai, alasan, deret nihil selisih | M4 | Bulanan | Pemilik | S | FR-M4-07 |
| Umur piutang; kartu piutang; daftar penagihan | Per pelanggan/segmen/lini | M5 | Kapan saja; ringkasan mingguan | Pemilik, Admin Keuangan | M | FR-M5-04 |
| Laba kotor per lini dan konsolidasi; laba rugi, neraca, arus kas | Per L1–L5 dan gabungan | M11 | Bulanan ≤ tanggal 10 | Pemilik, akuntan | M | FR-M9-02 |
| Biaya produksi air per liter (L1) | Total biaya L1 ÷ liter pengisian; per sumber dan gabungan; tren bulanan | M11, M8 | Bulanan ≤ tanggal 10 | Pemilik, akuntan | M | FR-M9-02, PTB-39, CR-09 |
| Omzet bruto bulanan per lini; pemantauan PKP | Untuk konsultan pajak | M11 | Bulanan | Admin Keuangan, akuntan, pemilik | M | BR-29, BR-30, FR-M11-12 |
| Pesanan dan status; alasan pembatalan/kegagalan; dobel/terlewat | Per pelanggan, truk, alasan | M2 | Kapan saja; bulanan | Dispatcher, pemilik | M | FR-M2-02, FR-M2-09, KPI-06 |
| Rit terealisasi vs terjadwal per truk | Harian dan bulanan | M2, M3 | Harian | Dispatcher, pemilik | M | KPI-07 |
| Kinerja sopir/truk dan depot/operator | Rit, ketepatan, selisih, void, galon | M3, M4, M6, M12 | Bulanan | Pemilik | S | FR-M9-05 |
| Neraca air dan susut; utilisasi kapasitas | Per sumber | M8 | Harian; bulanan | Pemilik, operator produksi | M / S | FR-M8-03, FR-M8-04 |
| Penjualan depot per outlet | Galon, transaksi, void, selisih, setoran | M6 | Harian; bulanan | Pemilik | M | M6 (putaran 4) |
| Stok toko: kartu stok, laris/mati, stok minimum | Per barang | M7 | Mingguan; bulanan | Kasir, pemilik | M / S | M7 (putaran 4) |
| Riwayat perjalanan dan pengecualian GPS | Per rit, per truk per hari | M12 | Harian | Dispatcher, pemilik | M | FR-M12-02, FR-M12-04 |
| Tren mingguan/bulanan | Omzet, rit, galon, piutang | M2–M8, M11 | Mingguan; bulanan | Pemilik | S (RL-6) | FR-M9-06 |
| KPI program KPI-01–KPI-11 | Nilai, target, status | Semua | Bulanan (tinjauan bulan 10–12) | Pemilik, komite pengarah | S (RL-6) [USULAN] | BRD 2.3, 12.8, PTB-30 |
| Jejak audit dan log akses | Per objek, pengguna, waktu | M10 | Kapan saja | Pemilik, admin sistem, akuntan (objek keuangan) | M | FR-M10-02 |
| Riwayat harga; simulasi zona | Per produk/pelanggan | M1 | Kapan saja | Pemilik | M | FR-M1-02, FR-M1-05, K23 |

### 7.9.5 User story

**US-M9-01 Dashboard H+0** — M — FR-M9-01, NFR-04, NFR-19, P-06 langkah 4, KPI-08
Sebagai Pemilik, saya ingin membuka satu layar di ponsel setiap malam dan tahu omzet, kas, selisih, piutang, rit, dan galon hari ini, agar saya tidak lagi mengumpulkan angka dari telepon dan kertas.

Kriteria penerimaan:
1. Satu layar "Hari ini" dengan enam blok: omzet per lini (L2 truk, L3 depot, L4 toko; transfer internal L2→L3 ditampilkan terpisah dan tidak dihitung sebagai omzet luar, BR-33); kas seharusnya vs diterima vs selisih; piutang (saldo, terbentuk hari ini, dilunasi, lewat tempo, % KPI-04); rit per truk (terjadwal/selesai/gagal); galon per depot; pengecualian yang menunggu keputusan.
2. Sebelum tutup kas, layar menampilkan angka berjalan berlabel "belum ditutup — angka dapat berubah"; setelah kas ditutup, versi "H+0 terbit" terkunci dengan cap waktu, terbit ≤ 30 menit setelah tutup kas (NFR-04, KPI-08), dan pemilik diberi notifikasi (PTB-05).
3. Setiap angka dapat diketuk untuk turun ke rinciannya (truk → rit; depot → shift; selisih → setoran; piutang → pelanggan) tanpa berpindah modul.
4. Penjelasan selisih disetujui atau ditolak langsung dari layar ini (satu ketuk; alasan wajib bila menolak) — sama dengan US-M4-06 KP-6.
5. Terbaca di ponsel tanpa gulir mendatar; muat ≤ 2 detik (NFR-03).
6. Riwayat H+0 per tanggal tersimpan dan tidak berubah setelah terbit; transaksi terlambat sinkron dan koreksi tampil sebagai catatan tambahan bertanda pada tanggal masing-masing, bukan mengubah angka yang sudah terbit (Bab 5.3).
7. Rentang tampilan: hari ini, kemarin, 7 hari, bulan berjalan — dengan definisi angka yang sama.

**US-M9-02 Laporan bulanan laba kotor per lini dan konsolidasi** — M — FR-M9-02, BR-32, BR-33, KPI-09
Sebagai Pemilik, saya ingin tahu setiap bulan lini mana yang untung dan berapa, agar keputusan armada, depot, dan kemitraan berdasar angka.

Kriteria penerimaan:
1. Per lini L1–L5 (L5 kosong sampai Tahap 3): omzet, harga pokok/biaya langsung, laba kotor, marjin; konsolidasi mengeliminasi transfer internal (BR-33) sehingga laba gabungan tidak dihitung ganda.
2. Bersumber dari jurnal M11; berlabel "Sementara" sampai periode Ditutup/Dikunci (BR-32), lalu "Final"; tersedia paling lambat tanggal 10 (KPI-09).
3. Perbandingan dengan bulan sebelumnya dan bulan yang sama tahun lalu (setelah datanya ada).
4. Setiap angka dapat diturunkan ke akun dan ke transaksi sumbernya (rit, shift, penjualan toko, jurnal manual).
5. Selama M11 belum aktif (R04: akuntansi menyusul maksimal 2 bulan setelah go-live operasional), laporan menampilkan omzet per lini dan biaya yang sudah tercatat (pengeluaran rit, pembelian toko) berlabel "belum lengkap — M11 belum aktif" [USULAN].
6. Karena L1 diperlakukan sebagai pusat biaya (PTB-39, CR-09), laporan bulanan menampilkan biaya produksi air per liter (total biaya L1 ÷ liter pengisian, per sumber dan gabungan) sebagai dasar keputusan kapasitas (K22) dan harga mitra (BRD 9.6–9.7).

**US-M9-03 Ekspor Excel/PDF** — M — FR-M9-03, NFR-23, BR-39
Sebagai Pemilik, saya ingin setiap laporan dapat diunduh sebagai Excel atau PDF, agar dapat dibagikan ke akuntan, bank, atau komite pengarah.

Kriteria penerimaan:
1. Setiap laporan pada katalog 7.9.4 memiliki ekspor Excel (data mentah dan ringkasan) dan PDF (siap cetak; identitas PT; cap waktu; pembuat; filter yang dipakai); ekspor satu bulan data selesai ≤ 30 detik [USULAN].
2. Setiap ekspor tercatat (siapa, kapan, laporan, filter). Ekspor yang memuat data pribadi pelanggan/mitra hanya untuk pemilik dan Admin Keuangan dengan tujuan tercatat (BR-39); peran lain menerima versi tanpa nomor WA dan alamat lengkap [USULAN].
3. Ekspor jurnal ke format konsultan pajak (NFR-23) berada di M11 dengan mekanisme dan log yang sama.
4. Laporan berstatus Final menghasilkan berkas yang identik saat diekspor ulang.

**US-M9-04 Kotak masuk pengecualian dan pengaturan notifikasi pemilik** — S (kotak masuk) / M (infrastruktur notifikasi) — FR-M9-04, PTB-05 (disetujui), Bab 6.3
Sebagai Pemilik, saya ingin semua hal yang menunggu keputusan saya berkumpul di satu tempat dan sampai ke ponsel saya, agar tidak ada selisih atau anomali yang terlewat.

Kriteria penerimaan:
1. Infrastruktur notifikasi (M, PTB-05): pusat notifikasi dalam web/aplikasi dan push Android; setiap peristiwa Bab 6.3 memuat objek, nilai, penerima, tenggat, dan tautan tindakan; status Baru → Dibaca → Ditindaklanjuti; tidak dapat dihapus. Peristiwa berprioritas M (selisih ≥ ambang, setoran belum diterima, Ditahan, kurang bayar, transfer tidak ditemukan, perangkat GPS mati, sinkron gagal massal) dibangun bersama modul asalnya.
2. Kotak masuk pemilik (S, FR-M9-04): daftar "Perlu tindakan" (persetujuan menunggu, selisih ≥ ambang, rit gagal, anomali GPS, susut air) dan "Info"; pengelompokan per jenis; tindakan langsung dari daftar (setujui / tolak / minta keterangan).
3. Pengaturan per jenis: seketika / ringkasan harian / mati (peristiwa kritis tidak dapat dimatikan); jam tenang untuk non-kritis (PAR-56); ringkasan e-mail harian setelah tutup kas (PAR-55).
4. Permintaan yang melewati tenggat (Bab 6.2) naik ke puncak daftar dan diberi penanda; selisih yang lewat 24 jam dihitung KPI-03.

**US-M9-05 Kinerja per sopir/truk dan per depot/operator** — S — FR-M9-05, BR-12, KPI-07
Sebagai Pemilik, saya ingin melihat kinerja tiap sopir dan operator dari data, agar insentif dan teguran adil.

Kriteria penerimaan:
1. Sopir/truk per bulan: rit terjadwal, selesai, gagal (per alasan); rit tepat waktu (Selesai dalam ± 60 menit dari jam diminta bila ada [USULAN]); volume parsial; penyimpangan lokasi > 200 m / > 1 km; kejadian BR-25 dan keterangannya; selisih setoran (jumlah, nilai); setoran terlambat; jarak tempuh (M12); pengeluaran rit (bila S dibangun).
2. Depot/operator per bulan: galon per hari, transaksi, void (jumlah, nilai), selisih kas dan stok, setoran terlambat, kas melebihi batas, pasokan diterima vs susut outlet.
3. Deret hari tanpa selisih per orang sebagai dasar insentif nihil selisih (BR-12); peringkat hanya antar peran yang sebanding dan menampilkan zona/rute agar adil.
4. Hanya pemilik; sopir/operator melihat kinerjanya sendiri di aplikasinya (US-M3-07 KP-6).

**US-M9-06 Tren mingguan/bulanan** — S, dijadwalkan RL-6 (kompensasi, Bab 2.4) — FR-M9-06
Sebagai Pemilik, saya ingin melihat arah omzet, rit, galon, dan piutang dari minggu ke minggu, agar perubahan terlihat sebelum menjadi masalah.

Kriteria penerimaan:
1. Grafik dan tabel per minggu dan per bulan untuk 13 periode terakhir: omzet per lini, rit per truk, galon per depot, piutang (saldo, % lewat tempo); perbandingan dengan periode sebelumnya.
2. Definisi tiap ukuran sama dengan H+0 dan laporan bulanan (satu definisi omzet di seluruh sistem).
3. Ekspor sesuai US-M9-03.

**US-M9-07 Laporan KPI program (KPI-01–KPI-11)** — S [USULAN, PTB-30], dibangun di RL-6 — BRD 2.3, 12.8, Bab 1.3
Sebagai Pemilik, saya ingin melihat sebelas KPI program dengan nilai dan targetnya setiap bulan, agar tinjauan komite pengarah pada bulan 10–12 memakai angka dari sistem.

Kriteria penerimaan:
1. Satu halaman KPI: definisi dan rumus sesuai Bab 1.3, nilai bulan berjalan, target BRD 2.3, status; riwayat bulanan sejak pilot.
2. KPI-10 (jam pemilik per minggu) diinput manual pemilik dari catatannya; KPI-11 dihitung dari pengguna aktif (M10) dan tanggal nota kertas ditarik per unit yang dicatat manajer proyek.
3. Ekspor PDF untuk rapat komite pengarah (12.8).

### 7.9.6 Aturan bisnis yang dipaksakan
BR-32 (laporan bulanan Final hanya setelah periode dikunci), BR-33 (transfer internal terpisah dan dieliminasi pada konsolidasi), BR-39 (ekspor data pribadi), BR-29/BR-30 (omzet bruto dan pemantauan PKP tampil di laporan bulanan).

### 7.9.7 Pengecualian & kegagalan
- Tutup kas terlambat atau tertunda (PTB-21): H+0 terbit terlambat dengan cap waktu dan penanda; tidak ada H+0 manual.
- Data sumber dikoreksi lewat pembalik setelah H+0 terbit: angka H+0 tidak berubah; koreksi tampil pada tanggal koreksi dengan rujukan ke hari asal.
- M11 belum aktif: US-M9-02 KP-5.
- Laporan bulanan berubah setelah Final: hanya lewat jurnal periode berikutnya (BR-32); versi Final tetap tersimpan.

### 7.9.8 Di luar cakupan M9
Analitik lanjutan/alat BI eksternal; laporan untuk mitra (portal Tahap 3); pengiriman dokumen ke pelanggan (faktur dan kartu piutang di M5).

### 7.9.9 Hal terbuka
PTB-30.

## 7.10 M10 — Pengguna, Hak Akses & Jejak Audit

### 7.10.1 Tujuan
Setiap tindakan di sistem jelas siapa pelakunya, hanya dapat dilakukan oleh peran yang berhak dari perangkat yang sah, tidak dapat dihapus jejaknya, dan setiap koreksi atau persetujuan mengikuti pemisahan tugas yang dipaksakan sistem — bukan kebijakan di atas kertas. Menjawab T1 (kontrol kas), R09, KPI-11; FR-M10-01 s.d. FR-M10-05 (FR-M10-05 diperlakukan M — PTB-06 disetujui); NFR-09 s.d. NFR-12; BR-36 s.d. BR-39.

### 7.10.2 Peran & antarmuka
Web kantor. Admin sistem: pengguna, peran, lingkup, perangkat, pemantauan — tidak menyentuh transaksi keuangan. Pemilik: persetujuan multi-peran dan pendelegasian, tinjauan hak akses kuartalan, persetujuan anonimisasi. Semua peran: login, PIN, kotak persetujuan. Akuntan (baca-saja, PTB-11 disetujui): jejak audit objek keuangan. Aplikasi lapangan dan POS memakai layanan login/PIN/perangkat modul ini.

### 7.10.3 Objek & status
Pengguna (Aktif / Nonaktif / Terkunci sementara), Peran dan hak, Penugasan lingkup (truk, outlet, sumber air, toko, tenant), Perangkat (Terdaftar → Aktif → Diblokir / Dihapus jarak jauh), Sesi, Permintaan persetujuan (Bab 5.2), Pendelegasian [USULAN, PTB-32], Jejak audit (tidak dapat diubah), Log akses, Permintaan anonimisasi (Diajukan → Disetujui → Dijalankan), Tinjauan hak akses kuartalan, Kesehatan perangkat dan sinkron.

### 7.10.4 User story

**US-M10-01 Peran, pengguna, dan lingkup akses** — M — FR-M10-01, BR-36, BR-37, NFR-09, NFR-12, NFR-30, R09, BRD 10.2, KPI-11
Sebagai Admin sistem, saya ingin membuat akun dari data karyawan dengan satu peran dan lingkup yang jelas, agar tidak ada akun bersama, akun ganda, atau hak yang tersisa setelah orang keluar.

Kriteria penerimaan:
1. Katalog peran tetap: Pemilik, Admin Keuangan, Dispatcher, Sopir, Kernet (PTB-10 disetujui), Operator depot, Kasir toko, Operator produksi, Admin sistem, Akuntan (baca-saja; PTB-11 disetujui). Pada RL-7 ditambah "Pemilik mitra" (baca-saja, lingkup tenant sendiri; US-P3-10). Hak per peran mengikuti BRD 4.2 dan Bab 3.2; hak tidak dapat diubah per pengguna, hanya lewat peran [USULAN, mencegah hak ad hoc].
2. Setiap akun terikat tepat satu karyawan dari master M1 (BR-36); sistem menolak akun kedua untuk karyawan yang sama dan tidak mengizinkan akun tanpa karyawan (misalnya "kasir1").
3. Lingkup mengikat data yang terlihat: Sopir/Kernet → truk hari itu (jadwal kru, M2); Operator depot → outlet; Operator produksi → sumber air; Kasir → toko; Admin Keuangan → seluruh sumber kas EQUA; peran mitra (Tahap 3) → tenant sendiri (NFR-30). Tidak ada tampilan lintas lingkup untuk peran lapangan.
4. Satu orang lebih dari satu peran hanya lewat permintaan persetujuan pemilik (US-M10-04) dengan alasan dan masa berlaku. Kombinasi yang melanggar pemisahan tugas tidak dapat diajukan sama sekali (PTB-31 [USULAN]): Admin Keuangan bersama Dispatcher, Sopir, Kernet, Operator, atau Kasir; Admin sistem bersama peran yang menyentuh kas atau jurnal; Pemilik bersama peran pencatat transaksi harian.
5. Tanggal keluar pada master karyawan (M1) menonaktifkan akun pada hari itu secara otomatis (BR-37); admin sistem dapat menonaktifkan seketika; sesi aktif diputus, perangkat yang dipegangnya diblokir, data yang pernah dibuatnya tetap utuh dan tetap merujuk namanya.
6. Tinjauan hak akses kuartalan (R09, PAR-47): sistem menyusun daftar pengguna, peran, lingkup, terakhir login; pemilik menandai "ditinjau" per kuartal; pengguna tanpa login > 60 hari dan multi-peran yang lewat masa berlaku ditandai [USULAN].
7. Semua perubahan pengguna, peran, dan lingkup berjejak (US-M10-05) dan masuk ringkasan harian pemilik.
8. Pembuatan akun, pemberian atau perubahan peran, dan perluasan lingkup baru aktif setelah disetujui pemilik lewat US-M10-04 (BRD 10.2, 6.2a); pencabutan akses (karyawan keluar, perangkat hilang, pengurangan lingkup) berlaku seketika tanpa persetujuan (BR-37). Saat go-live, akun awal disetujui sekaligus per daftar bersama tanda tangan data awal (NFR-34), bukan satu per satu.

**US-M10-02 Login, PIN, perangkat terdaftar, dan sesi** — M (PTB-06 disetujui) — FR-M10-05, NFR-09, NFR-10, K24, BR-36, BR-37, BRD 10.5
Sebagai Pemilik, saya ingin aplikasi lapangan hanya berjalan di perangkat perusahaan yang terdaftar dengan PIN per orang, agar setiap transaksi jelas siapa pelakunya dan perangkat yang hilang tidak menjadi celah.

Kriteria penerimaan:
1. Aplikasi lapangan dan POS hanya dapat login pada perangkat yang didaftarkan admin sistem (pengenal perangkat, jenis, truk/outlet/sumber, pemegang, status); perangkat tidak terdaftar ditolak dengan pesan ke pengguna dan catatan ke admin sistem.
2. Satu perangkat dapat dipakai beberapa pengguna bergantian (perangkat truk: sopir dan kernet; perangkat cadangan) dengan PIN masing-masing; data offline milik pengguna lain tidak terlihat dan tidak terhapus saat berganti pengguna (Bab 6.5).
3. PIN 6 digit ditetapkan pengguna sendiri pada aktivasi pertama di hadapan admin sistem [USULAN]; reset PIN hanya oleh admin sistem dengan pemberitahuan ke pemilik; 5 kali salah → terkunci 15 menit (PAR-36); layar terkunci setelah 10 menit tidak aktif tanpa kehilangan data (PAR-37).
4. Web kantor: kata sandi minimal 10 karakter [USULAN] dan sesi kedaluwarsa setelah 30 menit tidak aktif atau maksimal 12 jam (PAR-46, NFR-09); pemilik, Admin Keuangan, dan admin sistem memakai autentikasi dua faktor (PTB-35; tambahan, Bab 2.4).
5. Kredensial tidak tersimpan dalam bentuk terbaca di perangkat; data lokal dan komunikasi terenkripsi (NFR-10); login PIN tetap berfungsi offline setelah aktivasi daring pertama.
6. Perangkat hilang/rusak: admin sistem memblokir seketika (tidak dapat login, tidak menerima data baru) dan memerintahkan hapus jarak jauh (data aplikasi dihapus pada kontak berikutnya); antrean belum terkirim yang ikut hilang dicatat sebagai kejadian dan dilaporkan ke pemilik (US-M3-09 KP-5).
7. Riwayat per perangkat: pengguna dan waktu pemakaian, login gagal, sinkron terakhir, versi aplikasi.

**US-M10-03 Pemisahan tugas dipaksakan** — M — FR-M10-03, BRD 4.2, Bab 6.2
Sebagai Pemilik, saya ingin sistem menolak — bukan sekadar memperingatkan — tindakan yang melanggar pemisahan tugas, agar kontrol tidak bergantung pada kepatuhan orang.

Kriteria penerimaan:
1. Aturan tetap yang diperiksa pada setiap tindakan: pembuat transaksi bukan penyetujunya; penerima setoran bukan penyetornya; Admin Keuangan tidak membuat/mengubah pesanan dan pengiriman; Dispatcher tidak mengakses kas; Sopir hanya rit sendiri dan tidak mengubah setelah kirim; Operator/Kasir hanya outletnya; Admin sistem tidak mengubah transaksi keuangan; Pemilik tidak menginput transaksi harian.
2. Pelanggaran ditolak dengan pesan yang menyebut aturannya; setiap percobaan tercatat di log akses; lebih dari 3 percobaan sehari oleh pengguna yang sama diberitahukan ke pemilik [USULAN].
3. Tidak ada mode darurat yang melewati aturan; jalur pengecualian hanya yang sudah ditentukan (Bab 6.1 "dicatat kantor", PTB-21) dan tetap berjejak.
4. Matriks peran × tindakan dapat ditampilkan dan diekspor pemilik untuk audit.

**US-M10-04 Alur persetujuan** — M — FR-M10-04, Bab 6.2, FR-M2-05, BR-01, BR-03, BR-09, BR-13, BR-15, BR-16, BR-17, BR-27, BR-32, BR-35, BR-38
Sebagai Pemilik, saya ingin semua permintaan persetujuan datang lewat satu mekanisme dengan tautan ke objeknya dan dapat saya putuskan dari ponsel, agar keputusan tidak tercecer di WA dan telepon.

Kriteria penerimaan:
1. Satu mekanisme untuk seluruh jenis di Bab 6.2a — selisih kas, pemberian Tempo dan pembukaan Ditahan, batas/tempo per pelanggan, harga master (jalur baku) dan harga khusus, diskon > 5%, void > Rp 100.000, penyesuaian stok, jurnal manual > Rp 5 juta, koreksi > Rp 500.000, kas kecil > Rp 500.000, pesanan tempo di luar kontrol kredit, pesanan saat kurang bayar kedua, tunai → tempo di lapangan (penyetuju Dispatcher), akun/peran/lingkup, multi-peran, tutup buku, pengecualian tutup kas — dengan data: pemohon, objek dan tautannya, nilai, alasan, tenggat, penyetuju.
2. Penyetuju mengikuti matriks Bab 6.2a (Tahap 1: pemilik, kecuali jenis yang diberikan ke Dispatcher); pemohon tidak pernah dapat menyetujui permintaannya sendiri walau memegang peran penyetuju (FR-M10-03). Keputusan langsung pemilik (6.2b) dan pengesampingan beralasan (6.2c) bukan permintaan persetujuan: tidak masuk alur ini, tetapi tetap berjejak dan diberitahukan.
3. Keputusan dari web atau ponsel (push, PTB-05) dengan satu ketuk; alasan wajib untuk penolakan; keputusan mengubah objek sumber secara otomatis (pesanan dapat dijadwalkan, harga berlaku, selisih Ditutup) dan tercatat di objek dan jejak audit.
4. Tenggat dan perilaku bila lewat tenggat mengikuti kolom Bab 6.2a (PTB-32): permintaan lewat tenggat diberi penanda dan pengingat, lalu diperlakukan sesuai kolom "Bila lewat tenggat" — misalnya pesanan tempo tetap tunai atau digeser ke H+1, void/diskon dianggap ditolak di akhir shift — sehingga operasi harian tidak menunggu pemilik.
5. Pendelegasian (PTB-32): bawaan tidak ada pendelegasian di Tahap 1. Bila pemilik memutuskan sebaliknya, delegasi hanya per jenis, berbatas waktu, tidak kepada pemohon atau peran yang bertentangan (KP-4 US-M10-01), dan seluruh keputusan delegasi tampil ke pemilik.
6. Ambang dan syarat tiap jenis diambil dari parameter Lampiran B, bukan tertanam di kode; perubahan parameter hanya oleh pemilik dan berjejak.

**US-M10-05 Jejak audit** — M — FR-M10-02, NFR-11, BR-31, BR-38, BR-39, BRD 10.6
Sebagai Pemilik, saya ingin riwayat lengkap setiap objek — siapa mengubah apa, kapan, dari nilai berapa ke berapa — yang tidak dapat diubah siapa pun, agar setiap angka dapat dipertanggungjawabkan.

Kriteria penerimaan:
1. Setiap pembuatan, perubahan, persetujuan, pembalikan, dan penonaktifan pada objek Bab 5.1 menghasilkan catatan: pelaku (pengguna, peran, perangkat), waktu perangkat dan server, objek, nilai lama, nilai baru, alasan bila diwajibkan, sumber (aplikasi lapangan / POS / web / sistem otomatis).
2. Catatan tidak dapat diubah atau dihapus oleh siapa pun termasuk admin sistem (NFR-11); integritasnya dapat diverifikasi (cara teknis diserahkan tim IT) [USULAN].
3. Pencarian per objek (riwayat lengkap satu pesanan/rit/faktur/shift), per pengguna, per rentang waktu, per jenis tindakan; ditampilkan dalam bahasa lapangan ("harga rit diubah dari Rp 200.000 menjadi Rp 210.000 oleh Pemilik, alasan: …").
4. Log akses terpisah: login/logout, login gagal, pendaftaran/pemblokiran perangkat, ekspor (BR-39), percobaan tindakan yang ditolak (US-M10-03); disimpan 1 tahun (PAR-29). Jejak audit transaksi keuangan disimpan ≥ 10 tahun bersama transaksinya (BR-31).
5. Tindakan otomatis sistem (Ditahan otomatis, faktur bulanan, penyusutan, deteksi GPS) dicatat dengan pelaku "Sistem" dan aturan pemicunya.
6. Ekspor jejak audit (Excel/PDF) oleh pemilik; akuntan (baca-saja) dapat melihat jejak objek keuangan.

**US-M10-06 Data pribadi, retensi, dan pencadangan** — M (NFR-14 S) — NFR-12, NFR-13, NFR-14, BR-31, BR-39, BRD 10.6
Sebagai Pemilik, saya ingin data pelanggan dan karyawan hanya terlihat oleh yang membutuhkannya dan disimpan sesuai ketentuan, agar EQUA patuh UU PDP dan pembukuan tanpa kehilangan catatan keuangan.

Kriteria penerimaan:
1. Data pribadi pelanggan (nama, WA, alamat, koordinat) hanya tampil pada peran yang memerlukannya untuk tugasnya: Dispatcher (M1/M2), Sopir/Kernet untuk rit hari itu, Admin Keuangan (piutang), Pemilik; peran lain melihat nama tanpa kontak [USULAN]. Data karyawan (PIN, riwayat selisih, ganti rugi) hanya untuk pemilik, admin sistem (tanpa nilai selisih), dan yang bersangkutan.
2. Permintaan penghapusan data pribadi (UU PDP): admin sistem mencatat permintaan; pemilik menyetujui; sistem menganonimkan nama, kontak, alamat, dan koordinat pada seluruh objek dan menyimpan catatan transaksi keuangan tanpa identitas (NFR-12, BRD 10.6). Pelanggan dengan piutang terbuka tidak dapat dianonimkan sebelum lunas atau dihapuskan (PTB-36 [USULAN]).
3. Jadwal retensi otomatis (PAR-29): data akuntansi dan transaksi ≥ 10 tahun (tidak ada penghapusan); foto bukti kirim, meter, dan nota dipindahkan ke arsip setelah 2 tahun (usulan BRD) dan tetap dapat dibuka dari rit/jurnal terkait; log akses 1 tahun; posisi GPS mentah 12 bulan (PTB-33).
4. Pencadangan otomatis harian dan salinan bulanan data akuntansi ≥ 10 tahun (NFR-13) dijalankan tim IT; produk menampilkan status cadangan terakhir kepada admin sistem dan pemilik [USULAN]. Uji pemulihan 2×/tahun (NFR-14, S) dicatat hasilnya.
5. Ekspor data pelanggan/mitra hanya oleh pemilik/Admin Keuangan dengan tujuan tercatat (BR-39); seluruh ekspor tercatat di log akses.
6. Seluruh data milik PT EQUA; data outlet mitra (Tahap 3) terpisah per tenant (NFR-30) dengan hak baca EQUA sesuai perjanjian (Bab 4.3).

**US-M10-07 Kesehatan perangkat, sinkron, dan pemantauan** — M — NFR-08, NFR-28, NFR-31, NFR-32, FR-M12-08
Sebagai Admin sistem, saya ingin melihat perangkat mana yang belum sinkron atau bermasalah sebelum lapangan menelepon, agar insiden tertangani dalam 30 menit.

Kriteria penerimaan:
1. Halaman "Perangkat & sinkron" untuk admin sistem, Dispatcher (perangkat truk), dan Admin Keuangan (sebelum menerima setoran, US-M3-09 KP-3): per perangkat — pengguna terakhir, sinkron terakhir, jumlah item belum terkirim menurut laporan perangkat, versi aplikasi, daya bila tersedia.
2. Peringatan otomatis ke tim IT (NFR-28): layanan tidak dapat diakses; sinkron gagal massal (lebih dari 3 perangkat gagal sinkron > 30 menit pada jam layanan [USULAN]); perangkat GPS mati (M12). Tercatat sebagai insiden dengan waktu tanggap ≤ 30 menit dan pemulihan ≤ 4 jam (NFR-31).
3. Pengguna lapangan dapat melaporkan kendala aplikasi (bukan kendala rit) dari menu bantuan; laporan menyertakan versi dan status sinkron otomatis [USULAN] dan masuk ke helpdesk IT. Setiap laporan dan masukan lapangan memiliki status (Diterima → Dijawab → Selesai) yang terlihat pelapor; jawaban ≤ 1 minggu (PAR-87, BRD 12.5) dipantau manajer proyek IT.
4. Rilis versi aplikasi: pemberitahuan pembaruan; versi minimal yang didukung; pengguna dengan versi di bawahnya diminta memperbarui sebelum melanjutkan (NFR-32).

### 7.10.5 Aturan bisnis yang dipaksakan
BR-36 (satu orang satu akun; PIN tidak dibagi), BR-37 (akses dicabut hari keluar; perangkat dihapus jarak jauh), BR-38 (tidak ada penghapusan — berlaku lintas modul lewat jejak audit), BR-39 (ekspor tercatat); FR-M10-03; NFR-09 s.d. NFR-12.

### 7.10.6 Pengecualian & kegagalan
- Pemilik kehilangan akses (lupa sandi atau perangkat 2FA): pemulihan oleh admin sistem dengan verifikasi di luar sistem; seluruh langkah berjejak dan diberitahukan ke pemilik lewat kanal lain.
- Satu-satunya admin sistem berhalangan: peran admin sistem dipegang 2–3 orang IT (BRD 10.4).
- Karyawan pindah peran (sopir menjadi operator): akun tetap, peran diganti dengan persetujuan pemilik, lingkup diubah; riwayat transaksi lama tetap merujuk peran saat itu.
- Pelanggan berpiutang meminta penghapusan data: ditunda sampai lunas/dihapuskan (US-M10-06 KP-2), pemohon diberi tahu.
- Perangkat cadangan dipakai oleh sopir yang bukan pemegang terdaftar: diperbolehkan bila perangkat berstatus cadangan; pemegang aktual tercatat per sesi.

### 7.10.7 Di luar cakupan M10
Akses konsol cloud dan autentikasi dua faktornya (BRD 10.4, tim IT); SSO/identitas eksternal; portal mitra (Tahap 3, hanya struktur tenant disiapkan); sanksi disiplin atas pelanggaran BR-36 (Peraturan Perusahaan).

### 7.10.8 Hal terbuka
PTB-31, PTB-32, PTB-35, PTB-36.

## 7.11 M11 — Akuntansi & Pajak

### 7.11.1 Tujuan
Setiap transaksi operasional menjadi jurnal secara otomatis pada pusat laba yang benar, sehingga laba rugi per lini dan konsolidasi, neraca, dan arus kas terbit setiap bulan paling lambat tanggal 10 tanpa pencatatan ulang; kewajiban PT non-PKP terpenuhi; dan periode yang sudah dikunci tidak dapat diubah. Menjawab P4, T4, KPI-09, KPI-10; FR-M11-01 s.d. FR-M11-12 (FR-M11-11 berprioritas C, tidak dibangun); P-07; BR-29 s.d. BR-35, BR-38; K3, K9, K10, K15, K20; NFR-13, NFR-23, NFR-36; R04, R11.

### 7.11.2 Peran & antarmuka
Web kantor. Admin Keuangan: jurnal manual, rekonsiliasi, aset, utang, tutup periode, ekspor pajak. Akuntan/konsultan (baca-saja, PTB-11 disetujui): meninjau jurnal otomatis dan laporan (3 bulan pertama, K9); menetapkan bagan akun, umur ekonomis, dan skema pajak di luar sistem lalu diinput Admin Keuangan. Pemilik: persetujuan jurnal manual > Rp 5 juta dan tinjauan jurnal ≤ Rp 5 juta saat tutup buku, koreksi > Rp 500.000, kunci periode, buka periode terkunci. Seluruh modul operasional: sumber jurnal otomatis.

### 7.11.3 Objek & status
Bagan akun (per pusat laba L1–L5), Pemetaan peristiwa → jurnal (dikelola Admin Keuangan/akuntan; berjejak), Jurnal otomatis (Terposting; hanya dapat dibalik), Jurnal manual (Draf → Diajukan → Disetujui → Terposting), Periode (Terbuka → Ditutup → Dikunci → Dibuka kembali), Aset tetap (Aktif → Dilepas; penyusutan bulanan), Rekonsiliasi bank/kas (Berjalan → Nol selisih), Utang usaha (S), Saldo awal (Draf → Ditandatangani → Terposting; penyesuaian ≤ 3 bulan, PTB-44), Pemantauan PKP (omzet 12 bulan berjalan), Ekspor pajak.

### 7.11.4 Peta peristiwa operasional → jurnal otomatis

Pemetaan akun sebenarnya ditetapkan akuntan (K9) di dalam sistem; tabel ini menetapkan **peristiwa apa saja yang wajib menghasilkan jurnal** dan pusat labanya. Transfer internal dieliminasi pada konsolidasi.

| Peristiwa (modul) | Perlakuan (dalam kata) | Pusat laba | Rujukan |
|---|---|---|---|
| Rit Selesai tunai / transfer / tempo (M3) | Pendapatan air truk; lawan: kas di tangan sopir / transfer belum dicocokkan / piutang | L2 | FR-M11-02, PTB-24 |
| Rit internal pasokan depot (M3, M6, M8) | Pendapatan transfer internal L2 dan beban air depot L3 sebesar volume diterima × harga transfer | L2 → L3 | BR-33, K20, US-M8-03 |
| Kurang bayar lapangan; pelunasan (M3, M5) | Piutang bertambah / berkurang; kas atau bank bertambah | L2 / L4 | PTB-18, FR-M5-03 |
| Setoran diterima (M4) | Kas kantor bertambah, kas di tangan berkurang; selisih kurang → beban selisih kas atau piutang karyawan (ganti rugi aktif); selisih lebih → pendapatan lain | Per sumber | BR-09, BR-11, BR-12, PTB-22 |
| Pengeluaran rit diverifikasi (M3, M4) | Beban BBM/tol/parkir per truk; lawan kas di tangan sopir atau kas kantor (uang pribadi diganti) | L2 | PTB-20 |
| Transfer dicocokkan; setor ke bank; kas kecil (M4) | Bank bertambah / kas kantor berkurang; beban kas kecil per kategori | Per pusat laba pengeluaran | US-M4-04, US-M4-05 |
| Penjualan POS depot tunai/QRIS; void (M6) | Pendapatan depot per outlet; lawan kas outlet / QRIS belum dicocokkan; void = pembalik | L3 per outlet | FR-M6-01, FR-M6-03 |
| Pemakaian bahan habis pakai per shift; opname depot (M6) | Beban bahan dari resep; penyesuaian opname → beban selisih stok setelah disetujui | L3 per outlet | FR-M6-04, BR-27 |
| Transfer internal bahan toko → depot (M7, M6) | Pendapatan transfer internal L4 dan persediaan bahan L3 sebesar harga mitra; HPP toko | L4 → L3 | PTB-37 |
| Penjualan toko tunai/QRIS/tempo; diskon; nota kredit (M7) | Pendapatan toko; HPP dari harga pokok rata-rata; piutang untuk tempo; diskon sebagai pengurang pendapatan | L4 | FR-M7-01, FR-M7-03, PTB-38, PTB-46 |
| Nota pembelian; pembayaran pemasok; opname toko (M7) | Persediaan bertambah; utang pemasok (S) atau kas/bank; penyesuaian opname → beban selisih stok | L4 | FR-M7-02, FR-M7-06 |
| Produksi dan susut air (M8) | Tidak ada jurnal nilai (air tidak dipersediakan); biaya L1 dari jurnal manual dan penyusutan; alokasi L1 ke L2/L3 bulanan menurut volume pengisian | L1 → L2, L3 | PTB-39 |
| Penyusutan bulanan (M11) | Beban penyusutan per aset ke pusat laba pemakainya | Per aset | FR-M11-05, BR-34 |
| Jurnal manual disetujui (M11) | Gaji, BBM (bila tidak lewat rit), sewa, listrik, pemeliharaan, biaya bank | Sesuai lampiran | FR-M11-03, BR-35 |
| Ganti rugi dilunasi (M4) | Piutang karyawan berkurang; kas atau utang gaji | Per sumber | PTB-22 |
| Estimasi biaya BBM per rit (M12, S) | Informasi (tidak dijurnal); dibandingkan dengan BBM nyata bulanan | L2 | FR-M12-07 |

### 7.11.5 User story

**US-M11-01 Bagan akun dan pusat laba** — M — FR-M11-01, K9, BR-33, PTB-39
Sebagai Admin Keuangan, saya ingin bagan akun dari akuntan terpasang dengan pusat laba per lini, agar setiap jurnal otomatis jatuh ke lini yang benar.

Kriteria penerimaan:
1. Bagan akun diimpor dari template akuntan (K9) dengan kode, nama, jenis, dan pusat laba (L1 produksi air, L2 air truk, L3 depot per outlet, L4 toko, L5 kemitraan; umum/kantor sebagai pusat biaya bersama); akun dinonaktifkan, tidak dihapus; perubahan berjejak.
2. Pemetaan peristiwa → akun (7.11.4) dikelola di dalam sistem oleh Admin Keuangan dengan tinjauan akuntan; setiap peristiwa wajib terpetakan sebelum M11 diaktifkan; peristiwa tanpa pemetaan ditolak posting dan masuk daftar tunggu, bukan hilang.
3. Pusat laba L1 diperlakukan sebagai pusat biaya yang dialokasikan ke L2 dan L3 setiap akhir bulan menurut proporsi volume pengisian (PAR-65; PTB-39 [KEPUTUSAN]); alokasi tampil terpisah pada laba rugi per lini.
4. Transfer internal (BR-33, PTB-37) memakai akun pendapatan/beban internal berpasangan sehingga konsolidasi mengeliminasinya otomatis.
5. Biaya bersama (kantor, Admin Keuangan, IT) dapat dialokasikan ke lini menurut kunci yang ditetapkan pemilik (omzet atau tetap) atau dibiarkan di pusat biaya bersama [USULAN].

**US-M11-02 Jurnal otomatis dari seluruh transaksi operasional** — M — FR-M11-02, P-07 langkah 1, 7.11.4, PTB-47
Sebagai Admin Keuangan, saya ingin setiap transaksi lapangan menjadi jurnal tanpa saya ketik, agar tutup buku hanya soal memeriksa, bukan mencatat.

Kriteria penerimaan:
1. Setiap peristiwa 7.11.4 menghasilkan jurnal saat peristiwanya sah (tersinkron dan, bila perlu, disetujui), dengan rujukan ke objek sumber (nomor rit, shift, nota, faktur) dan pusat laba; jurnal otomatis tidak dapat diubah manual (P-07 langkah 1) — hanya dibalik lewat koreksi berjejak sumbernya (BR-38).
2. Tanggal jurnal = tanggal bisnis peristiwa (Bab 5.3); peristiwa terlambat sinkron yang masuk periode Ditutup/Dikunci diposting ke periode terbuka pertama dengan penanda "asal periode …" (FR-M11-10).
3. Kesetimbangan debit–kredit diperiksa setiap posting; jurnal yang gagal terposting (pemetaan hilang, akun nonaktif) masuk daftar tunggu dengan alasan dan notifikasi Admin Keuangan; tidak ada peristiwa yang terlewat diam-diam.
4. Bila M11 diaktifkan setelah modul operasional berjalan (R04, maksimal 2 bulan), jurnal untuk seluruh peristiwa sejak tanggal cut-over dibangkitkan retroaktif dari data operasional dan diverifikasi akuntan sebelum periode pertama ditutup (PTB-47).
5. Akuntan (baca-saja) dapat menelusuri setiap jurnal ke transaksi sumbernya dan sebaliknya; jurnal per hari per modul dapat direkonsiliasi dengan ringkasan H+0 (jumlah dan nilai sama).

**US-M11-03 Jurnal manual dengan lampiran dan persetujuan** — M — FR-M11-03, BR-35, PTB-12, P-07 langkah 2, P-07 langkah 3
Sebagai Admin Keuangan, saya ingin mencatat gaji, sewa, listrik, dan pemeliharaan dengan lampiran dan persetujuan yang jelas, agar biaya tidak masuk tanpa bukti.

Kriteria penerimaan:
1. Jurnal manual: tanggal, akun debit/kredit, pusat laba, jumlah, keterangan, lampiran wajib (foto/PDF bukti); template untuk jenis berulang (gaji, sewa, listrik, BBM, pemeliharaan, biaya bank) [USULAN].
2. Jurnal > Rp 5 juta (PAR-20; BR-35 "di atas Rp 5 juta") diajukan ke pemilik lewat alur persetujuan (US-M10-04) sebelum terposting; jurnal ≤ Rp 5 juta terposting oleh Admin Keuangan dan masuk daftar tinjauan wajib pemilik — periode tidak dapat ditutup sebelum pemilik menandai daftar itu "ditinjau" (PTB-12, CR-04).
3. Jurnal manual terposting tidak dapat diubah; koreksi lewat jurnal pembalik beralasan; > Rp 500.000 dengan persetujuan pemilik (BR-38).
4. Jurnal berulang (sewa, penyusutan bukan — otomatis) dapat dijadwalkan bulanan sebagai draf yang tetap memerlukan lampiran dan persetujuan sesuai ambang.
5. Gaji dicatat sebagai jurnal manual total per bulan dari rekap penggajian di luar sistem; potongan ganti rugi dari rekap dicatat sebagai pelunasan piutang karyawan (PTB-22).
6. Jurnal akrual (P-07 langkah 3): jurnal manual bertanda "akrual" (misalnya listrik, sewa, atau gaji yang belum dibayar pada akhir bulan) dibalik otomatis pada tanggal 1 periode berikutnya; mengikuti ambang dan lampiran KP-2; daftar jenis akrual dan metodenya ditetapkan konsultan akuntan (K9).

**US-M11-04 Buku besar dan laporan keuangan** — M — FR-M11-04, FR-M9-02, P-07 langkah 5, PTB-45
Sebagai Pemilik, saya ingin laba rugi per lini dan konsolidasi, neraca, dan arus kas terbit dari sistem setiap bulan, agar akuntan meninjau, bukan menyusun.

Kriteria penerimaan:
1. Buku besar per akun dan pusat laba; neraca saldo; laba rugi per lini (L1–L5, dengan alokasi L1 dan biaya bersama terpisah) dan konsolidasi (eliminasi transfer internal); neraca; arus kas metode langsung dari akun kas/bank (PTB-45 [USULAN]); semua per periode dan kumulatif tahun berjalan.
2. Laporan berlabel "Sementara" pada periode terbuka dan "Final" setelah dikunci; versi Final tersimpan dan identik saat dibuka ulang (US-M9-03 KP-4).
3. Setiap angka laporan dapat diturunkan ke jurnal dan ke transaksi sumber (ketertelusuran dua arah).
4. Ekspor Excel/PDF (US-M9-03) dan ekspor jurnal ke format konsultan (US-M11-08).
5. Laporan bulan pertama setelah cut-over ditinjau akuntan sebagai bukti TG-8 (BRD 12.2); catatan tinjauan disimpan di periode.

**US-M11-05 Aset tetap dan penyusutan otomatis** — M — FR-M11-05, BR-34, K15, NFR-34, BRD 10.3
Sebagai Admin Keuangan, saya ingin daftar aset dari akuntan dan notaris masuk sistem dan menyusut sendiri setiap bulan, agar beban penyusutan per lini tidak dihitung manual.

Kriteria penerimaan:
1. Daftar aset: kategori (truk, instalasi sumber air, peralatan depot, bangunan, lainnya), tanggal perolehan, nilai (ditetapkan akuntan dan notaris, K15), umur ekonomis dan metode (ditetapkan akuntan; bawaan garis lurus, PAR-63), pusat laba pemakai (truk → L2; instalasi → L1; peralatan depot → L3 per outlet; bangunan → sesuai pemakaian), nilai sisa; impor dari template pada bulan 6–8 dan ditandatangani pemilik (NFR-34).
2. Penyusutan bulanan diposting otomatis pada hari pertama tutup periode; dapat dihitung ulang bila umur/nilai diubah akuntan dengan jurnal penyesuaian berjejak.
3. Aset yang tidak masuk PT dan disewakan ke PT (K15) tidak masuk daftar aset; sewanya dicatat sebagai jurnal manual berulang (US-M11-03 KP-4).
4. Penambahan aset baru dari pembelian (nota) atau jurnal manual; pelepasan/penjualan aset dengan laba-rugi pelepasan otomatis; riwayat per aset.
5. Laporan daftar aset dan akumulasi penyusutan per periode untuk akuntan dan pajak.

**US-M11-06 Rekonsiliasi bank dan kas** — M — FR-M11-06, P-07 langkah 4, US-M4-04, US-M4-05, PTB-16
Sebagai Admin Keuangan, saya ingin saldo bank dan kas di sistem cocok dengan rekening dan uang fisik sebelum tutup buku, agar tidak ada selisih yang terbawa ke bulan berikutnya.

Kriteria penerimaan:
1. Rekonsiliasi bank per rekening per periode: saldo rekening (input dari rekening koran atau impor berkas, FR-M4-04 S) vs saldo buku; item penyesuai: transfer belum dicocokkan, setoran dalam perjalanan, biaya/bunga bank (jurnal manual), transfer tidak ditemukan (US-M4-04 KP-4); selisih harus nol untuk menutup periode.
2. Rekonsiliasi kas: kas kantor (hitung fisik harian dari US-M4-06), kas awal tetap outlet, kas di tangan sopir (harus nol setelah setoran diterima), kas kecil (S) vs buku; selisih beralasan mengikuti alur selisih M4.
3. Hasil rekonsiliasi (nol selisih, siapa, kapan, item penyesuai) disimpan per periode dan tampil bagi akuntan.
4. Pencocokan harian di M4 mengisi rekonsiliasi bulanan secara otomatis; hanya item tersisa yang dikerjakan saat tutup buku.

**US-M11-07 Utang usaha kepada pemasok** — S — FR-M11-07, FR-M7-06, US-M7-08
Sebagai Admin Keuangan, saya ingin utang pemasok dan jatuh temponya tercatat di buku, agar neraca dan arus kas mencerminkan kewajiban yang ada.

Kriteria penerimaan:
1. Utang terbentuk dari nota pembelian M7 dan jurnal manual bertanda utang; umur utang; jadwal pembayaran; pembayaran dari M4 mengurangi utang.
2. Saldo awal utang saat cut-over dari nota (BRD 10.3) ditandatangani pemilik.
3. Laporan utang per pemasok dan jatuh tempo; pengingat (Bab 6.3).

**US-M11-08 Pelaporan pajak PT non-PKP dan pemantauan batas PKP** — M — FR-M11-08, FR-M11-12, BR-29, BR-30, BR-31, K10, R11, NFR-23
Sebagai Admin Keuangan, saya ingin omzet bruto bulanan per lini dan ekspor jurnal siap untuk konsultan pajak, dan peringatan sebelum omzet mendekati batas PKP, agar kewajiban pajak PT terpenuhi tanpa kejutan.

Kriteria penerimaan:
1. Sistem tidak memungut PPN dan tidak menerbitkan faktur pajak (BR-29); faktur dan struk bertuliskan identitas PT tanpa komponen PPN.
2. Omzet bruto bulanan per lini (pendapatan luar; transfer internal dikecualikan) tersedia sebagai laporan dan ekspor; bila konsultan menetapkan PPh final UMKM 0,5% (BR-30), sistem menampilkan estimasi PPh final bulanan sebagai informasi (PAR-64); skema lain diinput sebagai parameter oleh Admin Keuangan.
3. Ekspor jurnal, buku besar, dan omzet ke format yang disepakati konsultan pajak pada bulan 1 (NFR-23); format dapat diubah tanpa rilis aplikasi [USULAN: template ekspor terkonfigurasi].
4. Pemantauan PKP (FR-M11-12): omzet bruto 12 bulan berjalan (seluruh lini, pendapatan luar) dibandingkan dengan Rp 4,8 miliar (PAR-22); peringatan ke pemilik dan Admin Keuangan pada 80% dan 90% (BR-29), tampil di dashboard M9; proyeksi sederhana bulan tercapainya batas berdasarkan rata-rata 3 bulan [USULAN].
5. Retensi: pembukuan dan bukti transaksi digital tersimpan ≥ 10 tahun (BR-31; PAR-29) dengan salinan bulanan (NFR-13).

**US-M11-09 Saldo awal dan cut-over akuntansi** — M — FR-M11-09, NFR-34, NFR-36, K9, BRD 10.3, PTB-44, R04, PTB-47
Sebagai Admin Keuangan, saya ingin neraca awal dari akuntan masuk sistem pada tanggal 1 bulan cut-over dan dapat disesuaikan secara terkendali, agar tidak ada transaksi terbelah antara catatan lama dan sistem.

Kriteria penerimaan:
1. Cut-over hanya dapat ditetapkan pada tanggal 1 (NFR-36); transaksi operasional sebelum tanggal itu tidak dimigrasi (BRD 10.3); sistem menolak jurnal bertanggal sebelum cut-over kecuali jurnal saldo awal.
2. Jurnal saldo awal memuat kas dan bank (hitung fisik dan saldo rekening), piutang per faktur (US-M5-07), utang pemasok per nota, persediaan toko dan bahan depot (opname cut-over), aset tetap (US-M11-05), dan ekuitas penyeimbang; setiap kelompok ditandatangani pemilik (NFR-34) dan seluruhnya disahkan akuntan sebelum terposting.
3. Penyesuaian saldo awal setelah cut-over hanya lewat jurnal "penyesuaian saldo awal" dengan persetujuan pemilik dan catatan akuntan, paling lama 3 bulan setelah cut-over (PAR-62, PTB-44); setelah itu koreksi mengikuti jurnal biasa.
4. Bila modul operasional go-live lebih dulu dan M11 menyusul (R04), tanggal cut-over akuntansi tetap tanggal 1 bulan go-live operasional dan jurnal dibangkitkan retroaktif (PTB-47); laporan bulan-bulan itu berlabel "dibangkitkan retroaktif, diverifikasi akuntan".

**US-M11-10 Tutup dan kunci periode** — M — FR-M11-10, BR-32, P-07 langkah 7, TG-8
Sebagai Pemilik, saya ingin periode bulanan ditutup paling lambat tanggal 10 dan dikunci oleh saya, agar angka yang sudah dilaporkan tidak berubah diam-diam.

Kriteria penerimaan:
1. Prasyarat tutup periode (diperiksa sistem): semua hari kas periode itu Ditutup (M4); rekonsiliasi bank dan kas nol selisih (US-M11-06); tidak ada jurnal di daftar tunggu; penyusutan terposting; jurnal manual > Rp 5 juta periode itu disetujui atau ditolak dan daftar tinjauan jurnal ≤ Rp 5 juta ditandai pemilik (US-M11-03 KP-2); opname toko bulan itu selesai (US-M7-05); alokasi L1 dan biaya bersama terposting. Prasyarat yang belum terpenuhi ditampilkan dengan tautan ke tindakannya.
2. Admin Keuangan menutup periode; pemilik mengunci; pengingat pada tanggal 5 dan 8 bila belum ditutup [USULAN, PAR-71]; tutup setelah tanggal 10 ditandai terlambat (BR-32).
3. Periode Dikunci menolak semua posting; koreksi hanya lewat jurnal periode berikutnya dengan rujukan ke periode asal (FR-M11-10).
4. Pemilik dapat membuka periode terkunci dengan alasan (BR-32); pembukaan dan seluruh tindakan sesudahnya berjejak dan diberitahukan ke akuntan; laporan Final periode itu tersimpan sebagai versi sebelumnya dan versi baru diberi nomor revisi.
5. Tutup buku bulan pertama setelah cut-over menjadi bukti TG-8 (BRD 12.2) dengan catatan tinjauan akuntan.

### 7.11.6 Aturan bisnis yang dipaksakan
BR-29 (tanpa PPN/faktur pajak; peringatan PKP), BR-30 (omzet bruto per lini), BR-31 (retensi 10 tahun), BR-32 (tutup ≤ tanggal 10; kunci dan buka oleh pemilik), BR-33 (transfer internal), BR-34 (nilai aset dan penyusutan dari akuntan), BR-35 (jurnal manual: lampiran; > Rp 5 juta persetujuan), BR-38 (koreksi lewat pembalik; > Rp 500.000 persetujuan).

### 7.11.7 Pengecualian & kegagalan
- Bagan akun atau neraca awal terlambat (R04): modul operasional tetap berjalan; jurnal dibangkitkan retroaktif (PTB-47); periode pertama ditutup setelah akuntan memverifikasi.
- Akuntan mengubah pemetaan akun di tengah bulan: pemetaan berlaku ke depan; jurnal lama tidak diposting ulang kecuali lewat jurnal reklasifikasi beralasan.
- Skema pajak berubah (PT menjadi PKP): parameter pajak diubah Admin Keuangan dengan tanggal berlaku; penerbitan faktur pajak di luar cakupan Tahap 1 dan menjadi permintaan perubahan (BRD 12.4).
- Transaksi ditemukan salah setelah periode dikunci: jurnal koreksi di periode terbuka dengan rujukan; laporan periode lama tidak berubah.
- Rekonsiliasi bank tidak nol karena transfer pelanggan tidak ditemukan: periode tidak dapat ditutup; item diselesaikan lewat US-M4-04 (piutang sementara) atau jurnal beralasan.

### 7.11.8 Di luar cakupan M11
Anggaran vs realisasi (FR-M11-11, C); penggajian (hanya jurnal total dan rekap ganti rugi); faktur pajak/PPN (PT non-PKP); konsolidasi lintas badan usaha; e-Faktur/e-Bupot (di luar Tahap 1); laporan keuangan mitra (Tahap 3, tenant sendiri).

### 7.11.9 Hal terbuka
PTB-12, PTB-39, PTB-44, PTB-45, PTB-47.

## 7.12 M12 — Pelacakan Armada / GPS

### 7.12.1 Tujuan
Posisi 7 truk terlihat Dispatcher dan pemilik setiap menit; setiap rit meninggalkan jejak yang dapat dicocokkan dengan bukti kirim dan pengisian; perjalanan di luar jadwal dan lokasi Selesai yang menyimpang ditandai otomatis. Menjawab P3, T3, KPI-07; FR-M12-01 s.d. FR-M12-08; BR-23, BR-25; NFR-21, NFR-28; K11; B8; R05.

### 7.12.2 Peran & antarmuka
Sistem (penghubung vendor GPS, NFR-21); Dispatcher (pantau, riwayat, tindak lanjut keterangan sopir); Pemilik (pantau, tinjauan penyimpangan); Sopir (keterangan lewat M3; GPS ponsel sebagai cadangan); Admin sistem/tim IT (perangkat, peringatan). Antarmuka: web kantor (peta), penghubung perangkat GPS, aplikasi sopir (M3).

### 7.12.3 Objek & status
Perangkat GPS (Terdaftar → Aktif → Mati/Dicabut → Aktif kembali), Posisi mentah (sumber: perangkat/ponsel), Jejak per rit dan per truk per hari, Titik berhenti, Kejadian — penyimpangan lokasi Selesai (tingkat 1: > 200 m; tingkat 2: > 1 km), perjalanan di luar jadwal/jam (Terdeteksi → Keterangan sopir → Ditinjau pemilik → Selesai), berhenti tidak dikenal, perangkat mati, masuk/keluar geofence (S) — Lokasi sah (sumber air, depot, pool/garasi — PTB-34), Estimasi biaya BBM per rit (S).

### 7.12.4 User story

**US-M12-01 Menerima posisi dari perangkat GPS truk dan cadangan ponsel** — M — FR-M12-06, NFR-21, K11, BRD 10.5, R05
Sebagai Dispatcher, saya ingin posisi setiap truk masuk sendiri dari perangkat yang terpasang, dan ponsel sopir mengambil alih bila perangkat mati, agar tidak ada truk yang "hilang" dari peta.

Kriteria penerimaan:
1. Penghubung vendor menerima posisi (waktu perangkat, lintang/bujur, kecepatan, arah, status kontak/daya bila tersedia) dari 7 + 1 perangkat terpasang; posisi disimpan mentah dengan waktu server dan penanda kualitas (akurasi, valid/tidak); minimal 1 posisi per menit saat bergerak (FR-M12-01).
2. Perangkat dipetakan ke truk lewat master armada (US-M1-03); pergantian ke perangkat cadangan tidak memutus riwayat truk.
3. Penggantian vendor hanya mengubah modul penghubung; format posisi internal tetap (NFR-21). Uji 1 unit pada bulan 3 sebelum pembelian penuh (R05) dicatat hasilnya.
4. Sumber cadangan: titik status dari M3 (Berangkat/Tiba/Selesai) selalu disimpan; jejak berkelanjutan GPS ponsel aktif otomatis untuk truk yang perangkatnya Mati/Dicabut (US-M12-08) dan berhenti saat perangkat aktif kembali; sumber setiap posisi ditandai.
5. Waktu perangkat yang menyimpang > 10 menit dari server ditandai (PAR-42); posisi berakurasi buruk tidak dipakai untuk mendeteksi kejadian tetapi tetap disimpan.
6. Posisi mentah disimpan 12 bulan; ringkasan per rit/hari disimpan bersama rit (PTB-33, PAR-52).

**US-M12-02 Peta posisi truk real-time** — M — FR-M12-01, FR-M2-03, NFR-19, NFR-24
Sebagai Dispatcher, saya ingin melihat ketujuh truk di peta dengan status ritnya, agar saya dapat menjawab pelanggan yang bertanya "truknya di mana" tanpa menelepon sopir.

Kriteria penerimaan:
1. Peta 7 truk untuk Dispatcher (web) dan pemilik (web/ponsel): ikon per truk dengan nomor, status (rit aktif ke pelanggan X / menuju sumber / di sumber / di depot / berhenti / di luar jadwal), sopir hari itu, kecepatan, umur posisi terakhir; pembaruan ≤ 1 menit; posisi lebih tua dari 5 menit ditandai "basi" (PAR-48).
2. Klik truk → rit hari ini dan statusnya, rit berikutnya, perkiraan jarak dan waktu ke tujuan (peta komersial, NFR-24), kontak sopir, tautan ke riwayat.
3. Lapisan peta: alamat rit hari ini, sumber air, depot, pool (PTB-34), zona tarif (opsional).
4. Tampilan yang sama tersemat atau berdampingan pada papan jadwal (US-M2-03 KP-6); tidak ada data posisi untuk peran lain (sopir tidak melihat truk lain).
5. Putar ulang 24 jam terakhir dari peta.

**US-M12-03 Riwayat perjalanan per rit dan per hari** — M — FR-M12-02, KPI-07
Sebagai Pemilik, saya ingin melihat jejak, jarak, durasi, dan titik berhenti setiap rit dan setiap truk per hari, agar utilisasi dan kejanggalan terlihat dari data.

Kriteria penerimaan:
1. Per rit: jejak dari Berangkat sampai Selesai/Gagal, jarak (km), durasi, titik berhenti ≥ 5 menit (PAR-49) dengan lokasi dan lama, lama di lokasi pelanggan; ditautkan ke bukti kirim (M3) dan pengisian (M8).
2. Per truk per hari: jarak total, waktu bergerak, waktu berhenti, gerakan pertama dan terakhir, jumlah rit, jarak antar-rit (kembali ke sumber) — berdampingan dengan rit terjadwal vs selesai (KPI-07).
3. Jejak dapat diputar ulang dan diekspor (PDF ringkasan; Excel titik berhenti); posisi mentah tidak diekspor [USULAN].
4. Jarak dihitung dari jejak perangkat; bila hanya titik status ponsel yang tersedia, jarak diestimasi dari rute peta dan ditandai "estimasi".

**US-M12-04 Pencocokan lokasi Selesai dengan alamat pelanggan** — M — FR-M12-03, BR-23, US-M3-03
Sebagai Pemilik, saya ingin sistem membandingkan tempat sopir menekan Selesai dengan alamat pelanggan, agar pengiriman ke tempat yang salah atau tidak terjadi terlihat pada hari yang sama.

Kriteria penerimaan:
1. Saat rit Selesai tersinkron, server menghitung jarak titik Selesai (M3) ke koordinat alamat kirim: > 200 m → penyimpangan tingkat 1 (alasan sopir sudah tercatat); > 1 km → tingkat 2 untuk tinjauan pemilik (BR-23). Hitungan server menggantikan hitungan lokal aplikasi.
2. Pembandingan tambahan: posisi perangkat GPS truk pada waktu Selesai vs titik Selesai dari ponsel; beda > 200 m → "sumber lokasi tidak konsisten" [USULAN] (indikasi Selesai ditekan bukan di lokasi truk).
3. Daftar tinjauan pemilik: rit, pelanggan, jarak, alasan sopir, peta kecil; tindakan: terima alasan / minta keterangan (tugas ke M3) / tandai tindak lanjut; keputusan berjejak; pola berulang per sopir atau pelanggan masuk US-M9-05.
4. Alamat Belum dikunci: tidak ada penyimpangan; titik Selesai (atau posisi perangkat saat itu) diusulkan sebagai koordinat alamat (US-M1-01 KP-2).
5. Rit internal: tujuan pembanding = koordinat depot.

**US-M12-05 Perjalanan di luar jadwal atau jam operasional** — M — FR-M12-04, BR-25, P-01 langkah 8
Sebagai Pemilik, saya ingin tahu bila truk bergerak tanpa rit atau di luar jam operasional, dan sopir menjelaskannya pada hari yang sama, agar rit tanpa pesanan tidak terjadi tanpa terlihat.

Kriteria penerimaan:
1. Deteksi otomatis: truk bergerak > 500 m atau > 10 menit (PAR-50) tanpa rit Berangkat/Tiba pada truk itu, atau bergerak di luar 05.00–22.00 (PAR-07) — kecuali perjalanan yang diharapkan menuju/dari lokasi sah (ke sumber sebelum rit pertama; kembali ke pool setelah rit terakhir), dengan lokasi sah dari master (PTB-34).
2. Berhenti > 15 menit (PAR-51) di luar alamat rit, sumber, depot, atau pool selama rit aktif ditandai "berhenti tidak dikenal" (indikasi rit tanpa pesanan, P-01 langkah 8).
3. Setiap kejadian memuat waktu, lokasi, jarak/durasi, truk, pengguna aktif pada perangkat bila ada, dan peta; dikirim ke Dispatcher dan pemilik (Bab 6.3); sopir mendapat tugas keterangan pada hari yang sama di M3 (BR-25).
4. Alur: Terdeteksi → Keterangan sopir → Ditinjau pemilik (terima / tindak lanjut di luar sistem) → Selesai; kejadian tanpa keterangan hingga tutup kas tampil di H+0 dan kotak masuk pemilik.
5. Parameter deteksi dapat diubah pemilik (Lampiran B); perubahan berjejak.

**US-M12-06 Geofence sumber air dan depot** — S — FR-M12-05, P-04 langkah 2–3, FR-M8-02, FR-M6-05
Sebagai Pemilik, saya ingin waktu truk masuk dan keluar sumber air dan depot tercatat, agar pengisian dan pasokan yang dicatat operator dapat diverifikasi.

Kriteria penerimaan:
1. Geofence radius per lokasi (bawaan 100 m, PAR-54; dari master M1); kejadian masuk/keluar per truk dengan waktu dan lama.
2. Pencocokan dengan pengisian (M8): pengisian tercatat tanpa kejadian masuk geofence sumber dalam ± 30 menit → ditandai; truk di geofence sumber > 10 menit tanpa pengisian tercatat → ditandai [USULAN ambang].
3. Pencocokan dengan pasokan depot (M6/M8): rit internal Selesai tanpa masuk geofence depot → ditandai.
4. Kejadian bertanda masuk daftar tinjauan pemilik dan pertimbangan neraca air (M8).

**US-M12-07 Jarak per rit untuk biaya BBM dan pemeriksaan zona** — S, dijadwalkan RL-6 (kompensasi, Bab 2.4) — FR-M12-07, A13, FR-M11-02, US-M1-05 KP-6
Sebagai Pemilik, saya ingin biaya BBM per rit dan kesesuaian zona pelanggan dihitung dari jarak GPS, agar laba per rit dan tarif zona berdasar jarak nyata.

Kriteria penerimaan:
1. Jarak rit (US-M12-03) × konsumsi BBM standar per km × harga BBM per liter (PAR-53, ditetapkan pemilik) = estimasi biaya BBM per rit; dikirim ke M11 sebagai biaya per rit lini L2 dan dibandingkan bulanan dengan pembelian BBM nyata (US-M3-08, jurnal M11); selisihnya ditampilkan, tidak menyesuaikan otomatis.
2. Pemeriksaan zona: jarak rute sumber acuan → alamat (US-M1-05) dan rata-rata jarak GPS aktual 3 rit terakhir dibandingkan dengan batas zona; alamat yang jarak aktualnya masuk zona lain ditampilkan ke pemilik dengan selisih tarifnya; perubahan zona hanya lewat US-M1-05 (persetujuan pemilik), tidak otomatis.
3. Laporan bulanan biaya BBM per rit per truk dan per zona (M9).

**US-M12-08 Peringatan perangkat mati atau dicabut** — M (KP-1–2: deteksi, peringatan, aktivasi GPS ponsel — turunan NFR-28 dan FR-M12-06, CR-13) / S (KP-3–4) — FR-M12-08, NFR-28, FR-M12-06, BRD 10.5
Sebagai Admin sistem, saya ingin diberi tahu bila perangkat GPS truk berhenti mengirim posisi lebih dari 15 menit pada jam operasional, agar pencabutan atau kerusakan tertangani hari itu.

Kriteria penerimaan:
1. Tidak ada posisi dari perangkat > 15 menit (PAR-25) pada jam layanan, atau sinyal daya terputus dari perangkat → status Mati/Dicabut; peringatan ke tim IT dan Dispatcher (Bab 6.3); tercatat sebagai kejadian per truk.
2. Selama Mati/Dicabut: jejak GPS ponsel diaktifkan (US-M12-01 KP-4); rit tetap dapat berjalan; kejadian yang lebih dari 2 jam dalam sehari tampil di H+0 [USULAN].
3. Perangkat aktif kembali → kejadian ditutup dengan lama mati; pola berulang per truk dilaporkan ke pemilik (indikasi pencabutan disengaja).
4. Kesehatan perangkat GPS (terakhir terlihat, daya, versi) tampil pada halaman perangkat US-M10-07.

### 7.12.5 Aturan bisnis yang dipaksakan
BR-23 (penyimpangan lokasi), BR-25 (keterangan perjalanan hari yang sama), BR-38 (kejadian tidak dihapus), NFR-21 (penghubung vendor terpisah), NFR-28 (peringatan perangkat mati).

### 7.12.6 Pengecualian & kegagalan
- Perangkat belum terpasang saat pilot (R05): M12 berjalan dengan titik status ponsel; deteksi US-M12-05 dinonaktifkan per truk sampai perangkatnya aktif [USULAN].
- Layanan vendor GPS terganggu: posisi berstatus basi untuk semua truk sekaligus; tidak memicu peringatan "perangkat mati" bila vendor melaporkan gangguan sistemik; tim IT diberi tahu (NFR-28).
- Truk berstatus Perbaikan (M1): deteksi perjalanan dinonaktifkan; pergerakan ke bengkel tercatat sebagai kejadian berlabel perbaikan.
- Sopir membawa truk pulang (kebijakan pemilik): pool per truk ditetapkan sebagai alamat yang disetujui pemilik (PTB-34).
- Gangguan sinyal GPS di area tertentu: posisi berakurasi buruk tidak memicu kejadian; celah jejak ditandai pada riwayat.

### 7.12.7 Di luar cakupan M12
Sensor volume tangki/IoT (BRD 3.3); pemeliharaan armada; optimasi rute; pelacakan orang di luar konteks rit.

### 7.12.8 Hal terbuka
PTB-33, PTB-34.

---

# Bab 8 — Tahap 2: Aplikasi Pelanggan

Status bab ini: **untuk estimasi** (PTB-17). BRD menyediakan cakupan (3.4) dan tujuh epik (6.13); seluruh rincian di bawah yang melampaui teks itu berpenanda [USULAN] dan baru menjadi "untuk dibangun" setelah keputusan mulai Tahap 2 pada TG-9 (BRD 12.8). Penomoran user story `US-P2-nn` mengikuti epiknya.

## 8.1 Tujuan & prasyarat masuk

**Tujuan.** Pelanggan truk memesan, memantau, dan membayar sendiri tanpa menelepon (T6), dengan data yang sama yang dipakai Dispatcher dan sopir — aplikasi hanya membuka jendela ke proses Tahap 1, bukan proses baru (BRD 3.4).

**Prasyarat masuk** (diperiksa pada TG-9; semuanya turunan BRD):

| # | Prasyarat | Ukuran | Rujukan |
|---|---|---|---|
| 1 | Tahap 1 stabil | ≥ 3 bulan setelah go-live penuh; KPI-05 = 100%, KPI-06 = 0/bulan, KPI-07 baseline tersedia | BRD 3.2, 12.8 |
| 2 | Koordinat alamat terkunci | ≥ 95% alamat aktif berkoordinat (US-M1-06 KP-5) [USULAN ambang] | BRD 10.3 |
| 3 | Kanal pesan otomatis | WhatsApp Business API aktif (NFR-20, BRD 11.4) — PTB-60 | K21 |
| 4 | Keputusan gerbang pembayaran | Penyedia, biaya, dan rekonsiliasi diputuskan (PTB-50) | BRD 3.3 |
| 5 | Kapasitas rit terlihat | US-M2-10 (jadwal kru & kapasitas) terbangun dan PAR-33 dikalibrasi dari baseline KPI-07 tiga bulan, agar slot yang ditawarkan sesuai kapasitas nyata (rit pelanggan + internal) | FR-M2-10, PAR-33 |
| 6 | Platform aplikasi diputuskan | PTB-49 | — |

## 8.2 Peran & antarmuka

| Peran | Antarmuka | Yang dilakukan |
|---|---|---|
| Pelanggan truk (300, tumbuh ke 1.000; NFR-05) | Aplikasi pelanggan — usulan PWA (aplikasi web yang dapat dipasang) dulu, aplikasi Android/iOS bila adopsi terbukti (PTB-49) | Daftar, pesan, lacak, bayar, langganan, nilai, mengeluh |
| Dispatcher | Web kantor (M2) | Mengonfirmasi dan menjadwalkan pesanan aplikasi seperti pesanan telepon; menangani keluhan operasional |
| Admin Keuangan | Web kantor (M4, M5) | Mencocokkan pembayaran digital; tagihan |
| Pemilik | Web/ponsel (M9) | Penilaian, keluhan, adopsi |
| Sopir | M3 | Tidak berubah; status dan bukti kirimnya yang tampil ke pelanggan |
| Sistem | WA Business API, gerbang pembayaran, M12 | Notifikasi, pembayaran, posisi truk |

## 8.3 Objek & status

Akun pelanggan (Terdaftar → Terverifikasi WA → Terhubung ke pelanggan M1 / Pelanggan baru (Tunai)), Alamat kirim (milik pelanggan; koordinat dari peta pelanggan; zona otomatis US-M1-05), Pesanan mandiri (Diajukan → Dikonfirmasi Dispatcher → mengikuti siklus Pesanan Bab 5.2; Ditolak dengan alasan), Slot pengiriman (PTB-51), Pembayaran digital (Menunggu → Berhasil → Dicocokkan; Gagal/Kedaluwarsa), Langganan pelanggan (Aktif/Jeda/Berakhir — memakai US-M2-06), Pengingat isi ulang, Penilaian (per rit), Keluhan (Diajukan → Ditanggapi → Selesai), Pesanan galon antar (EP-2-07, ditunda).

## 8.4 Jembatan ke Tahap 1

Aplikasi tidak memiliki data sendiri: pelanggan dan alamat = M1; pesanan dan status = M2; status rit, bukti kirim, dan volume = M3; posisi truk = M12; faktur dan pelunasan = M5; harga = zona K23 dan harga khusus BR-16. Yang baru: verifikasi WA, gerbang pembayaran, notifikasi otomatis, penilaian, dan keluhan. Aturan Tahap 1 berlaku tanpa pengecualian: kontrol kredit (BR-01 s.d. BR-06), batas H+0 15.00 (BR-20), harga hanya dari master (BR-19), bukti kirim (BR-22).

## 8.5 User story per epik

Prioritas di dalam Tahap 2 adalah usulan PRD (PTB-52): EP-2-01 s.d. EP-2-04 (tanpa pembayaran digital) = M; pembayaran digital, EP-2-05, EP-2-06 = S; EP-2-07 = C (BRD: "bisa ditunda").

**US-P2-01 Mendaftar dengan verifikasi nomor WA dan menyimpan alamat** — EP-2-01 — M [USULAN]
Sebagai Pelanggan, saya ingin mendaftar dengan nomor WA yang sudah dikenal EQUA dan menyimpan alamat kirim saya, agar pesanan berikutnya cukup beberapa ketukan.

Kriteria penerimaan:
1. Pendaftaran dengan nomor WA + OTP 6 digit lewat WhatsApp Business API (PAR-74: berlaku 5 menit, 3 percobaan); tanpa kata sandi [USULAN].
2. Nomor yang cocok dengan pelanggan M1 langsung terhubung ke rekam pelanggan itu (nama, alamat, status kredit, harga khusus ikut) setelah konfirmasi nama; nomor baru membuat pelanggan baru berstatus Tunai (BR-01), segmen rumah tangga sebagai bawaan yang dapat diubah Dispatcher.
3. Alamat kirim: pelanggan menandai titik di peta (koordinat) dan menulis catatan akses; alamat baru berstatus "belum dikunci" sampai pengiriman pertama (US-M1-01 KP-2); zona dan harga dihitung otomatis (US-M1-05).
4. Satu nomor WA satu akun; pergantian nomor lewat verifikasi nomor lama dan baru atau lewat Dispatcher.
5. Persetujuan penggunaan data pribadi sesuai UU PDP ditampilkan saat daftar; penghapusan akun mengikuti US-M10-06 KP-2.

**US-P2-02 Memesan air truk dengan tanggal/slot dan harga transparan** — EP-2-02 — M [USULAN]
Sebagai Pelanggan, saya ingin memesan dengan melihat harga dan slot yang tersedia, agar saya tahu kapan air datang dan berapa yang harus dibayar.

Kriteria penerimaan:
1. Alur ≤ 4 langkah: alamat → jumlah tangki → tanggal dan slot (PAR-73: pagi/siang/sore; PTB-51) → ringkasan harga → kirim; harga per rit dari zona alamat + komponen BBM atau harga khusus (BR-19, K23), total tampil sebelum kirim; tidak ada tawar-menawar.
2. Slot yang ditawarkan berasal dari kapasitas rit harian M2 (US-M2-10) dikurangi rit terjadwal; slot penuh tidak dapat dipilih; pemesanan H+0 setelah 15.00 tidak tersedia (BR-20) — pelanggan diarahkan ke H+1 atau menelepon.
3. Cara bayar: tunai saat kirim (bawaan), transfer, pembayaran digital (US-P2-04), atau tempo hanya bila pelanggan berstatus Tempo dan dalam batas (US-M2-05 berlaku; penolakan menampilkan alasan singkat tanpa angka batas [USULAN]).
4. Pesanan masuk M2 berstatus Baru bertanda "dari aplikasi", melewati pemeriksaan dobel (US-M2-04); Dispatcher mengonfirmasi (menjadwalkan) atau menolak dengan alasan dalam ≤ 2 jam pada jam layanan [USULAN, PAR-75]; pelanggan menerima notifikasi WA/push pada konfirmasi (US-M2-07 menjadi otomatis).
5. Pelanggan dapat membatalkan sendiri sampai rit Berangkat (PAR-72); setelah itu hanya lewat Dispatcher; pembatalan tercatat dengan alasan (KPI-06).
6. Nomor pesanan (PTB-14) tampil dan dapat dirujuk saat menelepon.

**US-P2-03 Memantau status dan posisi truk** — EP-2-03 — M [USULAN]
Sebagai Pelanggan, saya ingin melihat status pesanan dan posisi truk saat sedang menuju ke saya, agar saya tidak perlu menunggu di depan rumah.

Kriteria penerimaan:
1. Garis waktu status dari M2/M3: Diajukan → Dikonfirmasi (tanggal, slot, truk) → Berangkat → Tiba → Selesai (volume terkirim, nama penerima, waktu) / Gagal (alasan yang layak dilihat pelanggan).
2. Peta posisi truk (M12) hanya selama rit berstatus Berangkat menuju alamat pelanggan tersebut, dengan perkiraan waktu tiba dari peta komersial (NFR-24); tidak ada posisi di luar itu (PTB-54).
3. Identitas yang tampil: nomor polisi truk dan nama depan sopir; tombol hubungi terhubung ke kantor (Dispatcher), bukan ke ponsel sopir [USULAN, menjaga sopir dari telepon di jalan].
4. Notifikasi otomatis (WA Business API dan push) pada Dikonfirmasi, Berangkat, dan Selesai; template dari NFR-20.
5. Bila truk tanpa posisi (perangkat mati dan ponsel cadangan tidak aktif), peta menampilkan "posisi sementara tidak tersedia", bukan posisi lama.

**US-P2-04 Riwayat, struk, tagihan, dan pembayaran digital** — EP-2-04 — M (riwayat, struk, tagihan) / S (pembayaran digital) [USULAN]
Sebagai Pelanggan, saya ingin melihat riwayat pesanan, struk dengan bukti kirim, dan tagihan saya, dan membayar dari aplikasi, agar tidak ada perdebatan soal volume dan uang.

Kriteria penerimaan:
1. Riwayat pesanan 24 bulan dengan status akhir; struk digital per rit (nomor, tanggal, volume terkirim, harga, cara bayar, nama penerima) — foto bukti kirim ditampilkan sebagai bukti [USULAN, dengan pengaburan wajah bila ada].
2. Tagihan: faktur terbuka (M5) dengan jatuh tempo dan sisa, kartu piutang, faktur bulanan PDF (US-M5-06); pelanggan Ditahan melihat keterangan dan cara melunasi.
3. Pembayaran digital (S): QRIS dinamis atau nomor virtual account per tagihan/pesanan lewat gerbang yang dipilih (PTB-50); status Berhasil diterima otomatis dari gerbang, pelunasan tercatat di M5 dan masuk daftar pencocokan M4 sebagai "pembayaran digital" dengan settlement bank; biaya gerbang dibukukan sebagai beban (M11) atau dibebankan ke pelanggan sesuai PTB-50.
4. Pembayaran digital untuk pesanan sebelum kirim menjadikan cara bayar "lunas di muka"; sopir melihat "sudah dibayar" di M3 dan tidak mencatat tunai (perubahan kecil di US-M3-04) [USULAN].
5. Ekspor riwayat (PDF) dan pengunduhan faktur tercatat (BR-39 tidak berlaku untuk data milik pelanggan sendiri).

**US-P2-05 Langganan berkala dan pengingat isi ulang** — EP-2-05 — S [USULAN]
Sebagai Pelanggan hotel/industri/kolam renang, saya ingin mengatur jadwal langganan sendiri dan diingatkan saat biasanya saya memesan, agar tidak pernah kehabisan air.

Kriteria penerimaan:
1. Pelanggan membuat/mengubah/menjeda pola langganan (hari, jumlah, slot) yang tersimpan sebagai pesanan berulang M2 (US-M2-06); perubahan berlaku untuk pesanan yang belum dibuat; pesanan langganan tetap melalui kontrol kredit.
2. Pengingat isi ulang: dari rata-rata jarak antar pesanan pelanggan (FR-M2-08), aplikasi mengirim "biasanya Anda memesan sekitar tanggal …" H-2 dengan tombol pesan ulang satu ketukan; pelanggan dapat mematikan pengingat.
3. Pelanggan menerima notifikasi bila pesanan langganan gagal dibuat (kredit ditahan) dengan tindakan yang disarankan.

**US-P2-06 Penilaian layanan dan keluhan** — EP-2-06 — S [USULAN]
Sebagai Pelanggan, saya ingin menilai pengiriman dan mengajukan keluhan yang ditanggapi, agar masalah tidak terulang.

Kriteria penerimaan:
1. Penilaian 1–5 dan komentar setelah rit Selesai (sekali per rit, dapat dilewati); terkait rit, truk, dan sopir; agregat tampil di US-M9-05, komentar mentah hanya untuk pemilik dan Dispatcher.
2. Keluhan: jenis (volume, keterlambatan, sikap, tagihan, lainnya), teks, foto, terkait pesanan/rit; masuk kotak keluhan Dispatcher (operasional) dan Admin Keuangan (tagihan); tanggapan pertama ≤ 24 jam pada jam layanan (PAR-75); status tampil ke pelanggan; keluhan volume dapat memicu sengketa faktur (7.5.6).
3. Keluhan tidak dapat dihapus; ditutup dengan penyelesaian tercatat; laporan bulanan keluhan per jenis dan per truk (M9).

**US-P2-07 Memesan galon antar dari depot terdekat** — EP-2-07 — C [USULAN; BRD: "bisa ditunda"]
Sebagai Pelanggan, saya ingin memesan galon isi ulang diantar dari depot EQUA terdekat, agar tidak perlu ke depot.

Kriteria penerimaan (garis besar):
1. Bergantung pada FR-M6-08 (pelanggan depot terdaftar, C) dan keputusan operasional siapa yang mengantar dan kapasitasnya (PTB-53); tanpa keputusan itu epik ini tidak diestimasi.
2. Bila dibangun: depot terdekat dari koordinat pelanggan dalam radius yang ditetapkan; pesanan masuk POS depot sebagai transaksi bertanda antar; pembayaran tunai saat antar atau digital; status sederhana (Diterima → Diantar → Selesai).

**US-P2-08 Kanal WhatsApp Business API dan notifikasi pelanggan** — turunan NFR-20, K21, BRD 11.4 — M [USULAN, PTB-60]
Sebagai Pemilik, saya ingin konfirmasi, struk, pengingat, dan status terkirim otomatis lewat WhatsApp resmi, agar Dispatcher dan Admin Keuangan tidak lagi mengetuk tautan satu per satu.

Kriteria penerimaan:
1. Template NFR-20 (konfirmasi pesanan, struk, pengingat H-3/H+1, status rit) dikirim otomatis lewat penyedia WhatsApp Business API; status terkirim/terbaca tercatat; alur Tahap 1 (US-M2-07, US-M3-03 KP-7, US-M5-05) berubah dari "buka tautan" menjadi otomatis tanpa perubahan lain.
2. Pelanggan yang tidak memakai aplikasi tetap menerima pesan WA yang sama (aplikasi bukan syarat).
3. Biaya per pesan dianggarkan (NFR-29) dan tampil di laporan biaya bulanan (M11).

## 8.6 Kebutuhan non-fungsional khusus Tahap 2 [USULAN]

| Aspek | Target | Rujukan |
|---|---|---|
| Waktu respons aplikasi pelanggan | Layar ≤ 2 detik pada jaringan seluler biasa; pemesanan lengkap ≤ 60 detik | NFR-03 |
| Skala | 1.000 pelanggan, 3.000 pesanan/bulan tanpa perubahan arsitektur | NFR-05 |
| Keamanan | OTP WA; sesi 30 hari dengan verifikasi ulang untuk pembayaran; data pribadi hanya milik sendiri | NFR-09, NFR-12 |
| Privasi posisi | Posisi truk hanya saat menuju pelanggan; tidak ada riwayat posisi untuk pelanggan | PTB-54 |
| Ketersediaan | Mengikuti jam layanan NFR-01; pemesanan di luar jam tetap diterima untuk H+1 | NFR-01 |
| Bahasa | Bahasa Indonesia; istilah pelanggan (bukan istilah internal seperti "rit") | NFR-15 |

## 8.7 Pengecualian & kegagalan
- Nomor WA pelanggan lama dipakai orang lain (nomor berganti pemilik): OTP berhasil tetapi nama tidak cocok → akun tidak dihubungkan otomatis; Dispatcher memverifikasi.
- Pelanggan memesan lewat aplikasi dan telepon sekaligus: pemeriksaan dobel US-M2-04 menampilkan keduanya ke Dispatcher.
- Gerbang pembayaran menyatakan Berhasil tetapi settlement tidak masuk: US-M4-04 (transfer tidak ditemukan) berlaku untuk pembayaran digital.
- Pelanggan tempo membayar digital setelah Ditahan: pelepasan otomatis mengikuti US-M5-03 KP-3.
- Truk menuju pelanggan lain lebih dulu (urutan diubah): peta pelanggan hanya aktif saat rit-nya Berangkat; perubahan slot diberitahukan.

## 8.8 Di luar cakupan Tahap 2
Pemesanan untuk pihak ketiga/agen; program loyalitas; obrolan langsung dengan sopir; pembayaran dengan kartu kredit fisik; aplikasi untuk pelanggan depot tanpa EP-2-07.

## 8.9 Hal terbuka
PTB-49, PTB-50, PTB-51, PTB-52, PTB-53, PTB-54, PTB-60.

# Bab 9 — Tahap 3: Portal Kemitraan / Frenchise

Status bab ini: **untuk estimasi** (PTB-17), kecuali **Paket Minimum Mitra Fase 1** (9.10) yang berstatus **untuk dibangun** pada RL-7 sesuai K17 (PTB-61, CR-15). BRD menyediakan cakupan (3.5), enam epik (6.14), dan skema kemitraan (Bab 9 BRD; K17–K19, K22). Rincian yang melampaui teks itu berpenanda [USULAN]. Sesuai BRD (catatan istilah Bab 9, R12), produk memakai istilah **"Kemitraan Depot EQUA"** dan **"Mitra"** sampai STPW terbit; istilah waralaba dikunci parameter (PTB-57). Penomoran `US-P3-nn` mengikuti epiknya.

## 9.1 Tujuan & prasyarat masuk

**Tujuan.** Paket "depot siap buka" (BRD 9.5) dapat dijual dan dikendalikan lewat sistem: mitra memakai POS yang sama dengan 10 depot sendiri, membeli air dan spare part dari EQUA, membayar tagihan yang dihitung otomatis, dan mematuhi standar mutu yang diaudit — sementara EQUA melihat kinerja tiap mitra tanpa pencatatan tambahan (T5; BRD 9.9).

**Prasyarat masuk** (turunan BRD 9.2, 9.4):

| # | Prasyarat | Ukuran | Rujukan |
|---|---|---|---|
| 1 | PT berdiri; merek diajukan/terdaftar | Akta, NIB, NPWP; tanda terima DJKI | K15, A14 |
| 2 | Bukti sistem di depot sendiri | 3 bulan data M6 dan M11 dari 10 depot; SOP dan standar mutu tertulis | BRD 9.2 butir 3 |
| 3 | Kapasitas air | Studi K22 selesai; ruang kapasitas untuk mitra Fase 1 ditetapkan (maksimal 5 mitra, PAR-81) | BRD 9.2 butir 1, R06 |
| 4 | Angka biaya ditinjau | Struktur 9.6 ditinjau setelah 3 bulan data (K18); parameter kontrak diisi | K18 |
| 5 | Dokumen legal | Perjanjian kemitraan (Opsi B) oleh konsultan hukum; prospektus dan STPW hanya untuk Fase 2 | BRD 9.2 butir 2 |
| 6 | M6 multi-tenant teruji | US-M6-07 KP-6 lulus dengan tenant uji | FR-M6-07, NFR-30 |

## 9.2 Peran & antarmuka

| Peran | Antarmuka | Yang dilakukan |
|---|---|---|
| Calon mitra / Mitra (pemilik outlet) | Portal mitra (web responsif) | Mendaftar, mengunggah dokumen, memesan air dan spare part, melihat tagihan dan laporan outletnya, membayar |
| Operator mitra | POS depot (M6) sebagai tenant mitra | Transaksi, shift, penerimaan pasokan, daftar periksa mutu |
| Pembina wilayah EQUA (1–2) | Web kantor (portal sisi EQUA) | Survei lokasi, penilaian, onboarding, audit mutu, pembinaan, skor mitra |
| Pemilik EQUA | Web/ponsel | Persetujuan mitra, kontrak dan parameternya, sanksi dan pemutusan, dashboard kemitraan |
| Admin Keuangan | M4, M5, M11 | Tagihan mitra, pelunasan, piutang mitra, royalti ke jurnal |
| Dispatcher | M2 | Pesanan air mitra sebagai pesanan biasa dengan SLA ≤ 24 jam |
| Kasir toko | M7 | Pesanan spare part mitra sebagai penjualan harga mitra |
| Konsultan hukum (di luar sistem) | — | Perjanjian, prospektus, STPW |

## 9.3 Objek & status

Calon mitra (Prospek → Survei → Dinilai (layak/tidak) → Disetujui pemilik → Kontrak → Onboarding → Aktif), Kontrak mitra (parameter per mitra: opsi B/A, fee awal, langganan sistem, royalti %, diskon air %, radius eksklusif, jangka waktu, tanggal mulai/berakhir, batas kredit; Aktif → Diperpanjang → Berakhir), Tenant & outlet mitra (Bab 4.3), Wilayah eksklusif (lingkaran radius dari koordinat outlet), Pesanan air mitra (= pesanan M2 dengan pelanggan outlet mitra, segmen mitra), Pesanan spare part (= penjualan M7 harga mitra), Tagihan mitra bulanan (= faktur bulanan M5 dengan komponen langganan, royalti, air/spare part tempo), Royalti (dihitung dari omzet POS; Sementara → Ditagih), Daftar periksa mutu harian (per outlet per hari), Audit (Dijadwalkan → Dilaksanakan → Temuan → Tindak lanjut), Hasil uji air per outlet (US-M8-06), Skor mitra (bulanan), Sanksi (Teguran → Penghentian pasokan sementara → Pemutusan), Pelepasan data saat berakhir (PTB-58).

## 9.4 Fase B dan Fase A sebagai parameter, bukan dua produk [USULAN, PTB-55]

Sistem membangun satu portal dengan **parameter kontrak per mitra** (PAR-35, PAR-78):

| Parameter | Opsi B — Kemitraan (Fase 1) | Opsi A — Waralaba (Fase 2) |
|---|---|---|
| Fee awal | Rp 0–5 juta | Rp 15–25 juta / 5 tahun |
| Air | Tarif zona depot pihak ketiga | Tarif zona − diskon 5–10% |
| Langganan sistem | Rp 150 ribu/outlet/bulan | Rp 150 ribu/outlet/bulan |
| Royalti | 0% | 3–5% omzet POS |
| Radius eksklusif | 1 km | 1–2 km |
| Jangka | 2 tahun | 5 tahun |
| Istilah di antarmuka | "Mitra Depot EQUA" | "Waralaba EQUA" setelah parameter STPW aktif (PTB-57) |

Konversi mitra Fase 1 ke Fase 2 (BRD 9.4) = kontrak baru dengan insentif fee awal, tanpa migrasi data.

## 9.5 User story per epik

Prioritas dalam Tahap 3 adalah usulan PRD (PTB-55): EP-3-02, EP-3-03, EP-3-04 = M (tanpa ini kemitraan tidak dapat ditagih dan dikendalikan); EP-3-01 = M untuk kontrak dan onboarding, S untuk pipeline prospek dan survei; EP-3-05 = M untuk hasil uji dan audit, S untuk daftar periksa harian; EP-3-06 = M untuk neraca air dan tagihan, S untuk skor dan pembinaan.

**US-P3-01 Pendaftaran, penilaian lokasi, kontrak, dan onboarding mitra** — EP-3-01 — M (kontrak, onboarding) / S (pipeline, survei) [USULAN]
Sebagai Pembina wilayah, saya ingin calon mitra dinilai dengan kriteria yang sama dan di-onboarding lewat daftar periksa, agar setiap mitra mulai dengan pasokan, sistem, dan pelatihan yang lengkap.

Kriteria penerimaan:
1. Prospek mendaftar di portal (nama, badan usaha, kontak WA, lokasi usulan di peta, modal); pembina mencatat survei (BRD 9.5: jarak dari sumber/rute truk, kepadatan, pesaing, tata letak) dengan foto; sistem menghitung otomatis: zona tarif dan jarak rute dari sumber (US-M1-05), pelanggaran radius eksklusif terhadap outlet EQUA dan mitra lain (PAR-35), dan ketersediaan kapasitas air (ruang kapasitas K22 − komitmen mitra aktif ≥ ±11,4 rit/bulan; PAR-81).
2. Prospek di luar jangkauan truk (K19) ditandai "tidak layak Fase 1"; prospek yang melanggar radius ditolak otomatis kecuali pemilik mengesampingkan dengan alasan.
3. Persetujuan pemilik (US-M10-04) → kontrak dengan parameter 9.4, dokumen perjanjian terunggah, tanggal mulai; kontrak membuat tenant dan outlet (US-M6-07), pelanggan mitra di M1 (segmen mitra depot, penanda mitra toko BR-18, batas kredit dari kontrak), dan wilayah eksklusif.
4. Daftar periksa onboarding (BRD 9.5): pelatihan operator 2 hari (tanggal, peserta), SOP diterima (tanda tangan digital), pesanan peralatan awal ke M7, pesanan air pertama ke M2, perangkat POS terdaftar (M10), uji air awal (US-M8-06); outlet berstatus Aktif hanya setelah semua butir wajib dicentang.
5. Jangka kontrak dan evaluasi tiap 3 bulan (PAR-77) dijadwalkan otomatis; pengingat 60 hari sebelum berakhir.

**US-P3-02 POS depot standar dengan data terpisah per mitra** — EP-3-02 — M [USULAN]
Sebagai Mitra, saya ingin memakai POS yang sama dengan depot EQUA dan yakin data saya hanya terlihat oleh saya dan EQUA sesuai perjanjian, agar saya mau memasukkan seluruh penjualan.

Kriteria penerimaan:
1. Tenant mitra memakai seluruh US-M6-01 s.d. US-M6-06 tanpa perubahan; katalog produk standar EQUA disalin; harga jual ditetapkan mitra dengan harga anjuran EQUA tampil (PTB-56); kas awal tetap, ambang void, dan resep bahan dapat diubah mitra dalam batas yang ditetapkan EQUA [USULAN].
2. Isolasi data (NFR-30): mitra dan operatornya hanya melihat outletnya; EQUA melihat data yang diperjanjikan (penjualan agregat dan per transaksi untuk royalti, pasokan, neraca air, mutu) — bukan data pengguna atau kas kecil mitra; hak baca EQUA tercantum di kontrak dan ditampilkan ke mitra [USULAN transparansi].
3. Setoran dan selisih kas mitra dikelola mitra sendiri (tidak masuk M4 EQUA); EQUA hanya melihat omzet tercatat.
4. Langganan sistem Rp 150 ribu/outlet/bulan (PAR-35) ditagih otomatis (US-P3-04); tenant yang menunggak > 30 hari [USULAN] beralih ke mode baca-saja setelah teguran (sanksi US-P3-07), bukan diblokir mendadak.
5. Penerimaan pasokan air mitra memakai US-M6-05; neraca air mitra (galon terjual × 19 L vs air dibeli dari EQUA) dihitung bulanan (BRD 9.9) dengan toleransi PAR-79.

**US-P3-03 Memesan air dan spare part ke EQUA dengan harga mitra dan tagihan** — EP-3-03 — M [USULAN]
Sebagai Mitra, saya ingin memesan air dan spare part dari portal dengan harga mitra dan tahu kapan datang, agar depot saya tidak kehabisan.

Kriteria penerimaan:
1. Pesanan air: jumlah tangki, tanggal/slot; masuk M2 sebagai pesanan pelanggan mitra (segmen mitra depot; harga = tarif zona alamat outlet, dikurangi diskon mitra bila Opsi A; K23, 9.6); SLA pengiriman ≤ 24 jam dari pesanan (BRD 9.8, PAR-76) dipantau: pesanan yang lewat SLA ditandai ke Dispatcher dan pemilik.
2. Cara bayar air: tunai kepada sopir, transfer, atau tempo dalam batas kredit kontrak (M5; PTB-25 satu batas lintas lini); status kredit Ditahan memblokir pesanan air seperti pelanggan lain — tetapi karena air adalah pasokan wajib (K19), penahanan mitra dinaikkan ke sanksi bertingkat (US-P3-07), bukan hanya blokir diam-diam [USULAN].
3. Pesanan spare part/bahan: katalog M7 harga mitra (BR-18); dikonfirmasi kasir toko; pengambilan di toko atau ikut truk air (ditandai pada rit) [USULAN]; tempo mengikuti batas kredit yang sama.
4. Status pesanan dan pengiriman (dari M2/M3/M12) tampil di portal seperti US-P2-03; bukti kirim dan volume dari M3; konfirmasi volume oleh operator mitra (US-M6-05).
5. Riwayat pembelian air dan spare part per bulan tersedia bagi mitra dan EQUA (dasar neraca air dan evaluasi ekonomi 9.7).

**US-P3-04 Royalti/fee otomatis, tagihan mitra, dan pembayaran** — EP-3-04 — M [USULAN]
Sebagai Admin Keuangan, saya ingin tagihan mitra terbit sendiri setiap bulan dari data POS dan kontrak, agar tidak ada royalti atau langganan yang terlewat.

Kriteria penerimaan:
1. Setiap tanggal 1, sistem menghitung per mitra untuk bulan sebelumnya: langganan sistem × jumlah outlet; royalti = % kontrak × omzet POS tercatat (transaksi Sah, tanpa void; Opsi A saja); fee awal (sekali, saat kontrak); ditambah faktur tempo air/spare part yang belum ditagih bila mitra bertanda tagihan bulanan (BR-05) — menjadi satu faktur bulanan M5 (US-M5-06) dengan rincian per komponen; jatuh tempo tanggal 15 (PAR-12).
2. Rincian royalti menampilkan omzet per outlet per hari yang menjadi dasarnya; mitra dapat mengajukan sengketa (7.5.6) dalam 7 hari.
3. Pembayaran lewat transfer/pembayaran digital (US-P2-04 bila ada) atau tunai ke Admin Keuangan; pelunasan, pengingat, umur piutang, dan penahanan mengikuti M5; keterlambatan memicu sanksi bertingkat (US-P3-07).
4. Jurnal otomatis (M11): pendapatan langganan sistem dan royalti pada L5; pendapatan air pada L2 dan spare part pada L4 seperti pelanggan biasa; laba L5 per mitra dibandingkan dengan ilustrasi 9.7 (US-P3-06).
5. Perubahan parameter kontrak (royalti %, diskon) berlaku mulai periode berikutnya dan berjejak.

**US-P3-05 Standar mutu: daftar periksa harian, jadwal audit, hasil uji air** — EP-3-05 — M (hasil uji, audit) / S (daftar periksa harian) [USULAN]
Sebagai Pembina wilayah, saya ingin mutu setiap outlet mitra terpantau dari daftar periksa, audit, dan uji laboratorium, agar merek EQUA terlindungi.

Kriteria penerimaan:
1. Daftar periksa harian di POS (S): butir dari SOP (kebersihan area, pencucian galon, sterilisasi, penanganan uang, tandon) dengan foto bukti untuk butir tertentu; diisi operator saat buka shift; butir tidak lulus memerlukan tindakan; kepatuhan pengisian per outlet per bulan dihitung.
2. Jadwal audit pembina per outlet (frekuensi dari kontrak; bawaan bulanan, BRD 9.5 "pembinaan bulanan"); lembar audit dengan skor per butir, foto, temuan, dan tenggat tindak lanjut; temuan yang lewat tenggat naik ke sanksi (US-P3-07).
3. Uji air laboratorium per outlet memakai US-M8-06 dengan jadwal dari kontrak (PAR-70); hasil tidak lulus → pasokan/penjualan tidak diblokir otomatis, tetapi tindakan wajib dan notifikasi pemilik; dua hasil tidak lulus berturut → sanksi [USULAN].
4. Skor mutu bulanan per outlet = gabungan daftar periksa, audit, dan uji (bobot ditetapkan pemilik); skor di bawah PAR-80 memicu teguran.
5. Seluruh bukti mutu tersimpan per outlet untuk prospektus dan audit merek.

**US-P3-06 Dashboard kinerja mitra dan pembina wilayah** — EP-3-06 — M (neraca air, tagihan) / S (skor, portofolio) [USULAN]
Sebagai Pemilik EQUA, saya ingin melihat setiap mitra dalam satu layar — omzet, air yang dibeli, neraca air, mutu, tagihan — agar mitra yang memakai sumber lain atau menunggak terlihat tanpa audit lapangan.

Kriteria penerimaan:
1. Per mitra/outlet per bulan: omzet POS, galon/hari, air dibeli dari EQUA (rit, liter), **neraca air** (galon terjual × 19 L vs air dibeli; selisih di atas PAR-79 ditandai merah — BRD 9.9), spare part dibeli, tagihan (terbit, dibayar, lewat tempo), skor mutu, sanksi aktif, evaluasi 3 bulan berikutnya.
2. Portofolio pembina: daftar mitra dengan peringkat risiko (neraca air, tunggakan, mutu), jadwal audit dan kunjungan, temuan terbuka.
3. Ekonomi kemitraan untuk pemilik: pendapatan EQUA per mitra (air, spare part, langganan, royalti) vs ilustrasi 9.7; total komitmen kapasitas air mitra vs ruang kapasitas (K22).
4. Mitra melihat dashboard outletnya sendiri (omzet, galon, neraca air versi mitra, tagihan, skor) — data yang sama, sudut pandang berbeda.
5. Ekspor sesuai US-M9-03; laporan bulanan mitra (BRD 9.8 kewajiban EQUA) terbit otomatis ke portal mitra.

**US-P3-07 Sanksi bertingkat, pemutusan, dan pelepasan** — turunan BRD 9.8 — M [USULAN, PTB-59]
Sebagai Pemilik EQUA, saya ingin sanksi dijalankan bertingkat dan tercatat, agar pemutusan mitra selalu punya jejak yang adil.

Kriteria penerimaan:
1. Pemicu sanksi tercatat otomatis (tunggakan lewat tempo, neraca air di luar toleransi, skor mutu rendah, temuan audit lewat tenggat, POS tidak dipakai) tetapi **sanksi selalu diputuskan pemilik** dengan alasan (US-M10-04): Teguran tertulis (surat dari template, tercatat) → Penghentian pasokan sementara (pesanan air mitra diblokir; portal menampilkan alasan dan syarat pemulihan) → Pemutusan.
2. Pemutusan: tenant dinonaktifkan pada tanggal berakhir; mitra menerima ekspor data outletnya (transaksi, stok, laporan) dalam 30 hari [USULAN, PTB-58]; data tetap tersimpan di EQUA sesuai retensi (BRD 10.6); merek dan sistem dilepas; peralatan tetap milik mitra (BRD 9.8) tidak dikelola sistem.
3. Seluruh tahap sanksi tampil di dashboard pembina dan riwayat mitra; sanksi yang dicabut tercatat dengan alasan.

## 9.6 Kebutuhan non-fungsional khusus Tahap 3 [USULAN]

| Aspek | Target | Rujukan |
|---|---|---|
| Isolasi tenant | Uji penetrasi lintas tenant sebelum mitra pertama; tidak ada kebocoran data antar tenant | NFR-30, R09 |
| Skala | 50 outlet mitra tanpa perubahan arsitektur | NFR-05 |
| Kepemilikan data | Seluruh data milik PT EQUA; hak akses mitra atas data outletnya dituangkan dalam perjanjian | BRD 10.6 |
| Istilah | "Mitra Depot EQUA" sampai STPW; parameter istilah waralaba dikunci pemilik | R12, PTB-57 |
| Biaya | Langganan sistem menutup biaya cloud dan dukungan per outlet; biaya per tenant tampil di M11 | BRD 9.6, NFR-29 |

## 9.7 Pengecualian & kegagalan
- Mitra memasok air dari sumber lain (neraca air merah): bukan pemblokiran otomatis; temuan masuk sanksi bertingkat dengan bukti.
- Kapasitas air habis saat ada prospek layak: prospek berstatus "daftar tunggu kapasitas" sampai K22 menambah ruang.
- Mitra menolak pembaruan versi POS: versi minimal yang didukung (US-M10-07 KP-4) berlaku; portal menampilkan tenggat.
- STPW terbit di tengah kontrak Opsi B: konversi ke Opsi A hanya lewat kontrak baru (9.4); istilah di antarmuka berubah setelah parameter PTB-57 aktif.
- Mitra dua outlet: satu tenant, dua outlet; langganan per outlet; wilayah eksklusif per outlet.

## 9.8 Di luar cakupan Tahap 3
Penyusunan prospektus dan pengajuan STPW (konsultan hukum); pemasaran dan perekrutan mitra di luar portal; pembiayaan investasi mitra; pengelolaan depot kelolaan Opsi C (kasus per kasus, di luar portal); mitra di luar jangkauan truk dengan sumber lokal (K19, Fase 2 dan seterusnya).

## 9.9 Hal terbuka
PTB-55, PTB-56, PTB-57, PTB-58, PTB-59, PTB-61.

## 9.10 Paket Minimum Mitra Fase 1 (K17; PTB-61, CR-15) — untuk dibangun

**Mengapa.** K17 menetapkan Kemitraan Depot EQUA (Opsi B) pada bulan 11–18, sedangkan portal lengkap (9.1–9.9) baru dirinci setelah Tahap 1 stabil (BRD 6.14). Paket ini menutup celah itu dengan kemampuan minimum, agar 1–2 mitra pertama dapat dilayani pada bulan 11–12 dan bertambah hingga 3–5 mitra sampai bulan 18 (PAR-81), tanpa menunggu portal lengkap. Opsi B tidak memungut royalti (BRD 9.6), sehingga perhitungan royalti tetap menjadi bagian portal lengkap (US-P3-04) untuk Opsi A (bulan 18+).

**Syarat masuk RL-7** (Bab 11.1): go-live penuh (TG-8); studi kapasitas K22 selesai dan ruang kapasitas mitra ditetapkan; PT berdiri; perjanjian kemitraan Opsi B siap (konsultan hukum); POS depot (M6) terbukti ≥ 3 bulan di depot sendiri (BRD 9.2 butir 3); uji isolasi tenant (US-M6-07 KP-6) dan uji penetrasi lintas tenant (9.6) lulus.

**Yang tetap manual selama mitra ≤ 5:** pendaftaran dan penilaian lokasi (US-P3-01); kontrak dan parameter mitra (dicatat di luar sistem, lalu diinput sebagai data pelanggan dan tenant); audit dan skor mutu (US-P3-05, kecuali uji air US-M8-06); sanksi (US-P3-07).

**US-P3-08 Pasokan air mitra tercatat di POS mitra dan neraca air per mitra** — M (Fase 1) — EP-3-02, EP-3-06, BRD 9.9, FR-M6-05, FR-M6-07, NFR-30
Sebagai Pemilik EQUA, saya ingin setiap rit air ke mitra dikonfirmasi di POS mitra dan dibandingkan dengan galon yang dijualnya, agar mitra yang memakai sumber lain terlihat tanpa audit lapangan.

Kriteria penerimaan:
1. Pelanggan mitra (M1, segmen depot pihak ketiga dengan penanda mitra depot EQUA, BR-18) ditautkan ke tenant dan outlet mitra (US-M6-07); pesanan air mitra dibuat di M2 seperti pelanggan biasa dengan harga zona Opsi B (BRD 9.6).
2. Rit pelanggan mitra yang Selesai di M3 muncul di POS outlet mitra sebagai "pasokan tiba" dan dikonfirmasi operator mitra seperti US-M6-05 KP-1–2; selisih kirim–terima ditandai ke Dispatcher.
3. Neraca air per mitra per bulan: galon terjual × 19 L vs air diterima dari EQUA; selisih di atas PAR-79 ditandai ke pemilik (BRD 9.9), memakai perhitungan yang sama dengan US-M6-05 KP-4.
4. Pesanan air mitra yang belum Selesai > 24 jam sejak dibuat (PAR-76) ditandai ke Dispatcher dan pemilik (6.3).
5. Isolasi data tetap berlaku (NFR-30): EQUA hanya melihat data yang diperjanjikan (penjualan, pasokan, neraca air).

**US-P3-09 Tagihan langganan sistem bulanan untuk mitra** — M (Fase 1) — EP-3-04, BRD 9.6, FR-M5-01, BR-05, BR-38
Sebagai Admin Keuangan, saya ingin langganan sistem Rp 150 ribu per outlet tertagih otomatis setiap bulan, agar pendapatan kemitraan tidak bergantung pada ingatan.

Kriteria penerimaan:
1. Faktur berulang per mitra: jumlah outlet aktif × tarif langganan (PAR-35), terbit tanggal 1 untuk bulan sebelumnya dengan jatuh tempo mengikuti PAR-12; tarif dan tanggal mulai diambil dari data kontrak yang diinput Admin Keuangan dan disetujui pemilik (6.2a).
2. Faktur mengikuti M5: pelunasan, pengingat, umur piutang, dan penahanan (US-M5-02 s.d. US-M5-05); mitra bertanda tagihan bulanan dapat menggabungkan faktur air/spare part tempo ke faktur yang sama (BR-05).
3. Jurnal otomatis: pendapatan langganan sistem pada pusat laba L5 (US-M11-02); tanpa royalti pada Opsi B.
4. Faktur tidak dapat dihapus; koreksi lewat nota kredit beralasan (BR-38).

**US-P3-10 Akses baca Pemilik mitra dan laporan bulanan** — M (Fase 1) — EP-3-06, BRD 9.5, 9.8, NFR-30, FR-M10-01
Sebagai Mitra, saya ingin melihat laporan outlet saya sendiri dan menerima laporan bulanan dari EQUA, agar saya percaya pada angka yang dipakai untuk tagihan dan pembinaan.

Kriteria penerimaan:
1. Peran "Pemilik mitra" (US-M10-01): baca-saja, lingkup tenant sendiri, lewat web kantor terbatas; akun mengikuti persetujuan US-M10-01 KP-8.
2. Laporan yang terlihat: penjualan per hari per outlet, galon, void, selisih shift, pasokan diterima, neraca air versi mitra, tagihan dan pembayaran — data yang sama dengan yang dipakai EQUA.
3. Laporan bulanan mitra (kewajiban EQUA, BRD 9.8) terbit otomatis tanggal 5 [USULAN] dan dapat diunduh PDF (US-M9-03).
4. Tidak ada tampilan data mitra lain atau data EQUA (NFR-30); percobaan akses lintas tenant ditolak dan tercatat (US-M10-03).

**US-P3-11 Permintaan dukungan teknis mitra dengan SLA 48 jam** — S (Fase 1) — BRD 9.5, 9.8
Sebagai Mitra, saya ingin mencatat permintaan dukungan teknis dan melihat statusnya, agar janji tanggap ≤ 48 jam dapat dibuktikan kedua pihak.

Kriteria penerimaan:
1. Permintaan: jenis (peralatan, spare part, sistem, mutu air), uraian, foto, outlet; status Diajukan → Ditanggapi → Selesai dengan waktu setiap perubahan.
2. Waktu tanggap dihitung dari Diajukan ke Ditanggapi; lewat 48 jam (PAR-76) → notifikasi pemilik (6.3); ringkasan kepatuhan SLA per bulan masuk laporan bulanan mitra (US-P3-10 KP-3).
3. Spare part yang dibutuhkan dipesan lewat M7 dengan harga mitra (BR-18) dan dirujuk dari permintaan.

# Bab 10 — Kebutuhan Non-Fungsional Produk

Bab ini menerjemahkan NFR-01 s.d. NFR-36 (BRD Bab 7) menjadi **perilaku produk** dan **cara verifikasi** yang dapat dijawab lulus/gagal. Prioritas diwarisi dari BRD. Verifikasi dibagi empat jenis: **UI** = uji internal tim IT; **UAT** = uji terima pemilik modul; **Pilot** = diukur selama pilot bulan 7 (BRD 12.3); **Ops** = diukur berkelanjutan setelah go-live dan dilaporkan ke komite pengarah.

## 10.1 Ketersediaan & kinerja

| NFR | Target BRD | Perilaku produk | Verifikasi | Prio |
|---|---|---|---|---|
| NFR-01 | Jam layanan 05.00–22.00 setiap hari; pemeliharaan di luar jam itu | Jendela pemeliharaan 23.30–04.30 (PAR-86) agar tutup kas ≤ 22.00, terbitnya H+0 (≤ 30 menit), dan tutup kas yang terlambat tidak terganggu; rilis mengikuti NFR-32; jam layanan menjadi PAR-07 untuk aturan BR-25 dan deteksi M12 | Ops: log pemeliharaan; tidak ada rilis pada jam layanan | M |
| NFR-02 | Ketersediaan ≥ 99,5%/bulan pada jam layanan (≤ ±2,5 jam gangguan) | Pemantauan uptime layanan inti (API sinkron, web kantor); gangguan tercatat sebagai insiden dengan durasi (US-M10-07) | Ops: laporan bulanan uptime ke komite pengarah; Pilot: 0 insiden kritis terbuka (12.3) | M |
| NFR-03 | Web ≤ 2 detik; aksi POS dan aplikasi sopir ≤ 1 detik di perangkat | Aksi lapangan diproses lokal (offline-first) sehingga tidak bergantung jaringan; layar web memakai data teragregasi | UI: uji waktu respons 20 aksi lapangan pada perangkat kelas menengah-bawah dan 20 layar web dengan data 1 tahun; UAT: pengukuran ulang oleh pemilik modul | M |
| NFR-04 | Dashboard H+0 ≤ 30 menit setelah tutup kas | US-M4-06 KP-5; cap waktu "kas ditutup" dan "H+0 terbit" tercatat (KPI-08) | Pilot dan Ops: 100% hari dengan selisih ≤ 30 menit | M |
| NFR-05 | 3× volume saat ini (20 truk, 30 depot + 50 outlet mitra, 1.000 pelanggan, 5.000 transaksi/hari) tanpa perubahan arsitektur | Batas tenant/outlet/perangkat tidak dikodekan; ID dan antrean sinkron tidak bergantung jumlah perangkat | UI: uji beban 3× sebelum pilot (BRD 12.6) dengan data sintetis; hasil dilampirkan ke TG-5 | S |

## 10.2 Kerja tanpa sinyal

| NFR | Target BRD | Perilaku produk | Verifikasi | Prio |
|---|---|---|---|---|
| NFR-06 | Aplikasi sopir dan POS depot mencatat tanpa sinyal ≥ 1 hari penuh | Bab 6.4; US-M3-09; US-M6-06; US-M8-07: seluruh tindakan lapangan bekerja offline; data referensi diunduh saat login | UI: perangkat dalam mode pesawat 24 jam dengan 1 hari transaksi penuh; UAT: skenario P-01 dan P-02 tanpa sinyal | M |
| NFR-07 | Sinkron otomatis ≤ 5 menit; tidak ada transaksi hilang/dobel; lapangan tidak ditimpa kantor | ID unik di perangkat; pengiriman ulang idempoten; konflik ditampilkan ke Admin Keuangan (Bab 6.4 KP-3) | UI: uji putus-sambung 50 kali dengan pencocokan jumlah dan nilai transaksi (0 selisih); Pilot: kriteria "sinkronisasi tanpa kehilangan data" (12.3) | M |
| NFR-08 | Pengguna melihat mana yang tersimpan lokal dan mana yang terkirim | Status per item dan hitungan antrean di layar utama (US-M3-09 KP-2, US-M6-06 KP-2); halaman perangkat & sinkron (US-M10-07) | UAT: sopir/operator baru dapat menyebutkan status item tanpa dibantu | M |

## 10.3 Keamanan & privasi

| NFR | Target BRD | Perilaku produk | Verifikasi | Prio |
|---|---|---|---|---|
| NFR-09 | Akses berbasis peran; PIN + perangkat terdaftar; sesi kedaluwarsa | US-M10-01 s.d. US-M10-03; PAR-36, PAR-37, PAR-46 | UI: matriks peran × tindakan diuji otomatis (setiap sel); UAT: percobaan tindakan terlarang per peran ditolak | M |
| NFR-10 | Terenkripsi saat dikirim dan disimpan; kredensial tidak terbaca di perangkat | Enkripsi transport dan penyimpanan; data lokal aplikasi terenkripsi; PIN disimpan sebagai hash (cara teknis oleh tim IT) | UI: pemeriksaan konfigurasi dan pemindaian; perangkat yang disalin datanya tidak menampilkan kredensial | M |
| NFR-11 | Jejak audit tidak dapat diubah/dihapus siapa pun termasuk admin | US-M10-05 KP-2 | UI: percobaan ubah/hapus lewat semua jalur (aplikasi, API, basis data aplikasi) gagal atau terdeteksi | M |
| NFR-12 | Data pribadi hanya untuk operasional; akses per peran; dapat dihapus/dianonimkan | US-M10-06 KP-1 s.d. KP-2 | UAT: anonimisasi satu pelanggan uji — identitas hilang, catatan keuangan tetap | M |
| NFR-13 | Cadangan otomatis harian; salinan bulanan akuntansi ≥ 10 tahun | Tim IT; status cadangan tampil (US-M10-06 KP-4) | Ops: log cadangan harian; uji pemulihan sekali sebelum go-live (12.6) | M |
| NFR-14 | RPO 1 jam, RTO 4 jam; diuji 2×/tahun | Tim IT; hasil uji dicatat di sistem | Ops: dua uji pemulihan per tahun terdokumentasi | S |

## 10.4 Kemudahan penggunaan

| NFR | Target BRD | Perilaku produk | Verifikasi | Prio |
|---|---|---|---|---|
| NFR-15 | Bahasa Indonesia; istilah lapangan | Glosarium BRD Lampiran A + Lampiran C PRD sebagai daftar istilah tunggal; tidak ada kode teknis di pesan | UAT: tinjauan seluruh teks layar lapangan oleh juara lapangan (12.1) | M |
| NFR-16 | Pelatihan ≤ 2 jam + panduan 1 halaman | US-M3-10 KP-3; US-M8-07 KP-3; alur ≤ 3 langkah | Pilot: 2 sopir dan 2 operator baru menyelesaikan alur lengkap tanpa pendampingan pada minggu kedua (12.3) | M |
| NFR-17 | Lancar di Android menengah-bawah; unduhan kecil; hemat baterai dan kuota ≤ 50 MB/bulan/sopir | Foto terkompresi (PAR-38); GPS ponsel hanya cadangan; sinkron bertahap | Pilot: pengukuran kuota dan baterai pada 2 truk pilot selama 14 hari | M |
| NFR-18 | Kontras tinggi, tombol besar, teks ≥ 16 pt | Pedoman tampilan lapangan (US-M3-01 KP-7) | UAT: pengujian di bawah sinar matahari langsung oleh sopir | S |
| NFR-19 | Web responsif laptop dan ponsel | Dashboard, persetujuan, dan peta terbaca di ponsel pemilik (US-M9-01 KP-5) | UAT: pemilik menyetujui selisih dan membaca H+0 dari ponsel | M |

## 10.5 Integrasi

| NFR | Target BRD | Perilaku produk | Verifikasi | Prio |
|---|---|---|---|---|
| NFR-20 | Template WA; semi-otomatis lewat tautan, dapat ditingkatkan ke WA Business API | US-M2-07, US-M3-03 KP-7, US-M5-05; peningkatan ke API tanpa mengubah alur (US-P2-08) | UAT: tiga template terkirim lewat tautan; UI: antarmuka penyedia API dapat diganti tanpa mengubah modul | S |
| NFR-21 | Perangkat GPS mengikuti protokol vendor; ganti vendor hanya ubah modul penghubung | US-M12-01 KP-3 | UI: uji 1 unit bulan 3 (R05); simulasi penghubung kedua dengan format internal tetap | M |
| NFR-22 | Impor berkas mutasi bank | US-M4-04 KP-3 | UAT: impor berkas dari bank yang dipakai PT | S |
| NFR-23 | Ekspor Excel/PDF semua laporan; jurnal ke format konsultan | US-M9-03; US-M11-08 KP-3 | UAT: setiap laporan di katalog 7.9.4 diekspor; konsultan memvalidasi format jurnal | M |
| NFR-24 | Peta komersial untuk koordinat dan navigasi; langganan dianggarkan | US-M1-01 KP-2; US-M3-01 KP-3; US-M12-02; cadangan tanpa peta (Bab 4.2) | UI: perilaku saat kuota peta habis (cadangan aktif); Ops: biaya bulanan tampil (NFR-29) | M |
| NFR-25 | Printer struk bluetooth di depot dan toko | Struk opsional (US-M6-01 KP-4) | — (C) | C |

## 10.6 Infrastruktur & operasional

| NFR | Target BRD | Perilaku produk | Verifikasi | Prio |
|---|---|---|---|---|
| NFR-26 | Region Jakarta | Tim IT; seluruh data dan cadangan berada di region Indonesia | UI: pemeriksaan konfigurasi sebelum TG-1 | M |
| NFR-27 | Tiga lingkungan; data produksi tidak dipakai uji tanpa penyamaran | Impor data awal diuji di lingkungan uji (US-M1-06 KP-3); alat penyamaran data pelanggan untuk lingkungan uji [USULAN] | UI: pemeriksaan tiap rilis; data uji tidak memuat WA/alamat nyata | M |
| NFR-28 | Peringatan otomatis ke tim IT: layanan mati, sinkron gagal massal, GPS mati | US-M10-07 KP-2; US-M12-08 KP-1–2 (M) | UI: simulasi tiga kondisi memicu peringatan ≤ 5 menit [USULAN ambang] | M |
| NFR-29 | Biaya cloud dianggarkan; ditinjau kuartalan; peringatan lampaui anggaran | Biaya cloud, peta, WA, dan GPS dicatat bulanan (jurnal manual M11) dan dibandingkan anggaran; peringatan ke pemilik | Ops: laporan biaya kuartalan ke komite pengarah | S |
| NFR-30 | Multi-tenant M6 sejak awal; data mitra terpisah | US-M6-07; US-P3-02; Bab 4.3 | UAT: tenant uji tidak melihat data EQUA dan sebaliknya (US-M6-07 KP-6); uji penetrasi lintas tenant sebelum mitra pertama (Bab 9.6) | M |

## 10.7 Dukungan & pemeliharaan

| NFR | Target BRD | Perilaku produk | Verifikasi | Prio |
|---|---|---|---|---|
| NFR-31 | Helpdesk siaga pada jam layanan; insiden kritis ditanggapi ≤ 30 menit, pulih ≤ 4 jam | Pelaporan kendala aplikasi dari perangkat (US-M10-07 KP-3); insiden tercatat dengan waktu tanggap dan pemulihan | Ops: laporan insiden bulanan; Pilot: waktu tanggap terukur | M |
| NFR-32 | Rilis di luar jam sibuk; catatan rilis; dapat kembali ke versi sebelumnya | Versi minimal aplikasi (US-M10-07 KP-4); catatan rilis dalam bahasa pengguna; rollback diuji per rilis | UI: setiap rilis memiliki catatan dan uji rollback | M |
| NFR-33 | Panduan pengguna per peran; SOP proses Bab 5; dokumentasi teknis | Panduan 1 halaman per peran lapangan (NFR-16); SOP P-01 s.d. P-07 versi sistem; bantuan dalam aplikasi menautkan panduan [USULAN] | UAT: panduan tersedia sebelum pelatihan; dokumentasi teknis diserahkan pada TG-5 | M |

## 10.8 Migrasi & cut-over

| NFR | Target BRD | Perilaku produk | Verifikasi | Prio |
|---|---|---|---|---|
| NFR-34 | Data awal divalidasi dan ditandatangani pemilik sebelum go-live | US-M1-06 KP-4; US-M5-07 KP-2; US-M11-05 KP-1; US-M11-09 KP-2 — tanda tangan di sistem per kelompok data | UAT: setiap kelompok data BRD 10.3 berstatus ditandatangani sebelum TG-7 | M |
| NFR-35 | Periode paralel ≤ 2 minggu per unit dengan pencocokan harian nota kertas vs sistem | Lembar pencocokan harian per unit (nota kertas vs transaksi sistem) diisi manajer proyek/Admin Keuangan; tanggal nota kertas ditarik per unit tercatat (masukan KPI-11) | Pilot: 14 hari berturut 100% cocok per unit (BRD 12.3); perluasan: kriteria 11.5 butir 2 (PAR-84), batas 2 minggu dengan pengecualian PAR-88 | M |
| NFR-36 | Cut-over akuntansi tanggal 1; tidak ada transaksi terbelah | US-M11-09 KP-1; jurnal ditolak sebelum cut-over | UAT: transaksi bertanggal sebelum cut-over ditolak; jurnal saldo awal diterima | M |

## 10.9 Ringkasan verifikasi sebelum go-live

Kriteria go-live penuh (BRD 12.6) dipetakan ke bab ini: seluruh NFR prioritas M di atas harus **lulus dan terukur** — bukti berupa laporan uji (UI), berita acara UAT per modul, laporan pilot 14 hari, dan laporan operasional bulan pertama. Rinciannya per rilis disusun di Bab 11.

# Bab 11 — Rilis, Pilot & Kriteria Penerimaan

Bab ini menurunkan tonggak (BRD 12.2), pilot dan perluasan (12.3), pengendalian perubahan (12.4), pelatihan (12.5), dan pengujian (12.6) menjadi **rilis produk dengan kriteria masuk dan keluar yang dapat diperiksa**. Jadwal tetap milik rencana proyek tim IT; PRD hanya menetapkan isi tiap rilis dan bukti penerimaannya.

## 11.1 Rilis produk

| Rilis | Tonggak BRD | Isi produk | Kriteria masuk | Kriteria keluar (bukti) |
|---|---|---|---|---|
| RL-0 — Desain | TG-1 (akhir bulan 2) | PRD v1.1 disetujui per modul bersama BRD v1.1; desain fungsional & teknis tim IT; lingkungan (NFR-26, NFR-27); vendor GPS dipilih; format ekspor konsultan disepakati (US-M11-08 KP-3) | BRD v1.1 dan PRD v1.1 ditandatangani dalam sesi yang sama; PTB kelas A/B yang menyentuh arsitektur diputuskan (PTB-01, PTB-02, PTB-05, PTB-06, PTB-10, PTB-39, PTB-61, PTB-62) | Dokumen desain disetujui pemilik modul; matriks peran × tindakan (US-M10-03 KP-4) disahkan pemilik; Lampiran A dibangkitkan dengan `tools/trace_check.py` tanpa rujukan palsu (0.2 butir 8) |
| RL-1 — Inti pesanan–kirim–setor | TG-4 (bulan 5) | M1, M2, M3, M4, M5, M9 (H+0 dan ekspor), M10, M12 (penghubung, peta, pencocokan lokasi, deteksi perangkat mati); seluruh kebutuhan M modul-modul itu | Master harga dan zona terisi (TG-2); identitas usaha dokumen terkonfigurasi — "EQUA" sampai PT berdiri (Bab 2.3); 1 unit GPS teruji (R05) | Uji internal lulus: fungsional, offline (NFR-06/07), keamanan (NFR-09–11); skenario P-01, P-05, P-06 berjalan ujung ke ujung dengan data uji; jejak audit terbukti (NFR-11) |
| RL-2 — Versi pilot lengkap | TG-5 (akhir bulan 6) | M6, M7, M8, M11; kebutuhan S yang lulus setelah M, kecuali FR-M7-05, FR-M9-06, FR-M12-07 yang dijadwalkan ke RL-6 (Bab 2.4); GPS terpasang di 7 truk; neraca awal draf; template data awal | RL-1 lulus; bagan akun dan pemetaan jurnal terisi (US-M11-01); pembekuan cakupan 4 minggu sebelum pilot (BRD 12.4) | Uji QA lulus termasuk beban 3× (NFR-05); UAT per modul oleh pemilik modul dengan skenario P-01 s.d. P-07 (11.3); dokumentasi dan panduan tersedia (NFR-33); uji pemulihan cadangan sekali (NFR-13) |
| RL-3 — Pilot | TG-6 (bulan 7) | Unit pilot: 2 truk (rute dekat dan jauh), 2 depot (ramai dan sepi), toko; Admin Keuangan menutup kas di sistem; data pelanggan dan harga dimigrasi | RL-2 lulus; pelatihan unit pilot selesai (12.5); perangkat terdaftar (US-M10-02); juara lapangan siap | Kriteria pilot 11.4 terpenuhi 14 hari berturut; evaluasi pilot ditandatangani pemilik |
| RL-4 — Perluasan | Bulan 8–9 (TG-7 akhir bulan 9) | Gelombang 1: lima truk sisanya; gelombang 2 dan 3: empat depot masing-masing; periode paralel ≤ 2 minggu per unit (NFR-35, 11.5); cut-over akuntansi tanggal 1 bulan yang ditetapkan (NFR-36) | Pilot lulus; perbaikan cacat pilot dirilis; data awal per kelompok ditandatangani (NFR-34); PT berdiri dengan akta, NIB, NPWP, dan rekening bank atas nama PT sebelum tanggal cut-over akuntansi (BRD B9) | Adopsi 100% (KPI-11): nota kertas ditarik di semua unit dengan tanggal tercatat; KPI-01 = 100% pada bulan berjalan |
| RL-5 — Go-live penuh | TG-8 (bulan 10) | Operasi penuh; tutup buku bulan pertama di sistem | Semua kebutuhan M lulus UAT; NFR M terukur (Bab 10); migrasi ditandatangani; helpdesk siap; Peraturan Perusahaan berlaku (BR-11); PT berdiri dan neraca awal disahkan akuntan (BRD 12.6) | Laporan keuangan bulan pertama ditinjau akuntan (US-M11-10 KP-5); komite pengarah menyatakan go-live |
| RL-6 — Stabilisasi | TG-9 (bulan 12) | Penyempurnaan laporan: FR-M7-05, FR-M9-06, FR-M12-07 (kompensasi Bab 2.4) dan halaman KPI (US-M9-07); KPI baseline 3 bulan; kalibrasi PAR-33 dari KPI-07; backlog Tahap 2 dari masukan lapangan | Go-live dinyatakan | Laporan KPI ke komite pengarah (US-M9-07); keputusan mulai Tahap 2 |
| RL-7 — Kesiapan Mitra Fase 1 | K17 (target bulan 11–12) | Paket Minimum Mitra Fase 1 (Bab 9.10): US-P3-08, US-P3-09, US-P3-10 (M), US-P3-11 (S) | Syarat masuk Bab 9.10: TG-8, studi K22, PT berdiri, perjanjian Opsi B, M6 ≥ 3 bulan, uji isolasi dan penetrasi tenant | Mitra pertama beroperasi: pasokan terkonfirmasi di POS mitra, neraca air per mitra terbit, faktur langganan pertama terbit; evaluasi 3 bulan terjadwal (PAR-77) |

Kebutuhan S dibangun setelah kebutuhan M modul yang sama lulus uji internal, dan hanya masuk rilis bila selesai sebelum pembekuan cakupan (Bab 2.1). Kebutuhan C tidak masuk rilis Tahap 1. Tiga kebutuhan S analitik (Bab 2.4) dijadwalkan ke RL-6.

## 11.2 Definisi lulus untuk user story

Satu user story dinyatakan **lulus** bila seluruh kriteria penerimaannya (KP) dijawab "lulus" oleh pemilik modul pada UAT dengan data nyata, dan cacat yang tersisa bukan cacat kritis atau mayor. User story berprioritas M yang tidak lulus menahan rilis. Kelas cacat [USULAN]:

| Kelas | Definisi | Konsekuensi |
|---|---|---|
| Kritis | Transaksi tidak dapat dicatat, hilang, dobel, atau dapat diubah tanpa jejak; kebocoran data lintas peran/tenant; salah hitung uang | Menahan rilis; ditanggapi ≤ 30 menit setelah go-live (NFR-31) |
| Mayor | Fungsi M tidak bekerja sesuai KP tetapi ada jalan lain berjejak | Menahan rilis kecuali komite pengarah menerima dengan tenggat perbaikan |
| Minor | Ketidaknyamanan, teks, tampilan | Masuk backlog; tidak menahan rilis |

## 11.3 Rencana UAT per modul

| Modul | Pemilik modul (BRD 12.1) | Skenario BRD | User story yang diuji (minimal seluruh M) | Data uji |
|---|---|---|---|---|
| M1 | Pemilik | P-01 langkah 1; migrasi 10.3 | US-M1-01 s.d. US-M1-06 | 300 pelanggan hasil impor uji; zona dan harga nyata |
| M2 | Dispatcher | P-01 langkah 1–4 | US-M2-01 s.d. US-M2-05, US-M2-08, US-M2-09, US-M2-11 (M); US-M2-06, 07, 10 (S) | Satu hari pesanan nyata (≥ 14 rit pelanggan + rit internal) |
| M3 | Dispatcher (bersama sopir juara lapangan) | P-01 langkah 5–9; P-05 langkah 3 | US-M3-01 s.d. US-M3-07 (termasuk struk WA versi tautan, US-M3-03 KP-7), US-M3-09, US-M3-10 (M); US-M3-08 (S) | Rit sungguhan di truk pilot, termasuk tanpa sinyal |
| M4 | Admin Keuangan | P-06; P-01 langkah 9; P-02 langkah 6 | US-M4-01 s.d. US-M4-06 | 18 sumber kas satu hari; skenario selisih ≥ dan < ambang |
| M5 | Admin Keuangan | P-05 | US-M5-01 s.d. US-M5-04, US-M5-06, US-M5-07 (M); US-M5-05 (S) | Piutang berjalan nyata (15–30 pelanggan) |
| M6 | Operator depot senior | P-02 | US-M6-01 s.d. US-M6-07 | Satu shift nyata di depot ramai dan sepi; tenant uji (US-M6-07 KP-6) |
| M7 | Kasir | P-03 | US-M7-01 s.d. US-M7-06, US-M7-09 (M); US-M7-08 (S); US-M7-07 (S, RL-6) | Opname fisik cut-over; nota pemasok nyata |
| M8 | Operator produksi | P-04 | US-M8-01 s.d. US-M8-04, US-M8-07 (M); US-M8-05, 06 (S) | Dua sumber, satu hari penuh meter dan pengisian |
| M9 | Pemilik | P-06 langkah 4; laporan 7.9.4 | US-M9-01 s.d. US-M9-03 (M); US-M9-04, US-M9-05 (S); US-M9-06, US-M9-07 (S, RL-6) | H+0 dari hari pilot; laporan bulanan sementara |
| M10 | Pemilik (bersama admin sistem) | Matriks peran; BR-36 s.d. BR-39 | US-M10-01 s.d. US-M10-07 | Setiap peran mencoba tindakan terlarang; perangkat hilang disimulasikan |
| M11 | Admin Keuangan (bersama akuntan) | P-07 | US-M11-01 s.d. US-M11-06, US-M11-08 s.d. US-M11-10 (M); US-M11-07 (S) | Jurnal otomatis dari data pilot; saldo awal draf; tutup periode uji |
| M12 | Dispatcher | P-01 langkah 5–8; BR-23, BR-25 | US-M12-01 s.d. US-M12-05, US-M12-08 KP-1–2 (M); US-M12-06, US-M12-08 KP-3–4 (S); US-M12-07 (S, RL-6) | Truk pilot dengan perangkat GPS; skenario perjalanan di luar jadwal dan perangkat dicabut |
| Mitra Fase 1 (RL-7) | Pemilik (bersama Admin Keuangan) | BRD 9.9; P-01 untuk pesanan mitra | US-P3-08 s.d. US-P3-10 (M); US-P3-11 (S) | Tenant uji dan mitra pertama; satu bulan tagihan langganan |

Akuntan ikut UAT M11 (BRD 4.3 RACI). Setiap UAT menghasilkan berita acara: user story, KP lulus/gagal, cacat dan kelasnya, tanda tangan pemilik modul.

## 11.4 Kriteria pilot (turunan BRD 12.3) dan cara mengukurnya

| Kriteria BRD | Ukuran di produk | Sumber |
|---|---|---|
| 14 hari berturut-turut 100% transaksi unit pilot tercatat | KPI-01 per unit pilot = 100% (transaksi dicatat di sumber, tanpa "dicatat kantor") dan lembar pencocokan nota kertas vs sistem (NFR-35) nol selisih | Bab 1.3; US-M4-06 |
| Semua selisih terjelaskan dalam 24 jam | KPI-03 = 0 pada unit pilot | US-M4-03 |
| Sopir dan operator bekerja tanpa pendampingan pada minggu kedua | Catatan juara lapangan/manajer proyek: tidak ada intervensi pendamping pada hari 8–14; NFR-16 terpenuhi | Bab 10.4 |
| Sinkronisasi offline tanpa kehilangan data | Jumlah dan nilai transaksi perangkat = server setiap hari; NFR-07 | Bab 10.2 |
| Laporan H+0 terbit otomatis | 14 dari 14 hari H+0 terbit ≤ 30 menit setelah tutup kas (KPI-08, NFR-04) | US-M9-01 |
| Tidak ada cacat kritis terbuka | Daftar cacat kelas Kritis = 0 pada akhir pilot | 11.2 |

Unit pilot dipilih agar mewakili ekstrem: satu rute dekat dan satu rute jauh (zona tarif dan jarak GPS), satu depot ramai dan satu sepi (antrean POS dan selisih).

## 11.5 Perluasan dan periode paralel (NFR-35)

1. Setiap unit (truk atau depot) memasuki periode paralel maksimal 2 minggu: nota kertas dan sistem berjalan bersama; Admin Keuangan/manajer proyek mengisi lembar pencocokan harian (jumlah transaksi dan nilai) dan menandai penyebab selisih (terjelaskan/tak terjelaskan).
2. Kriteria "14 hari berturut 100% cocok" hanya berlaku untuk unit pilot (BRD 12.3, 11.4). Unit perluasan menarik nota kertas pada hari ke-14, atau lebih cepat bila pemilik setuju dan terpenuhi PAR-84: 5 hari operasi terakhir 100% transaksi tercatat di sumber dengan 0 selisih tak terjelaskan, dan pengguna bekerja tanpa pendampingan. Tanggal penarikan dicatat (masukan KPI-11, US-M9-07).
3. Unit yang belum memenuhi PAR-84 pada hari ke-14 tetap menarik nota kertas (batas NFR-35) dan masuk pendampingan intensif 1 minggu tanpa kertas: juara lapangan mendampingi dan Admin Keuangan mencocokkan harian dari data sistem. Perpanjangan paralel hanya lewat keputusan komite pengarah sebagai pengecualian NFR-35 yang tercatat, maksimal 1 minggu (PAR-88; CR-17).
4. Urutan: gelombang 1 lima truk (minggu 1–2), gelombang 2 empat depot (minggu 3–4), gelombang 3 empat depot (minggu 5–6) — BRD 12.3; dua minggu sisa di bulan 8–9 menjadi cadangan untuk pendampingan intensif atau perpanjangan pengecualian.

## 11.6 Daftar periksa cut-over (NFR-34, NFR-36, BRD 10.3)

| Kelompok data | Sumber | Ditandatangani | Di produk |
|---|---|---|---|
| Pelanggan truk (300) dan alamat | Template impor, pembersihan duplikat | Pemilik | US-M1-06 KP-4 |
| Zona tarif dan daftar harga | Ditetapkan pemilik (K23) | Pemilik | US-M1-05 KP-5 (simulasi) |
| Armada, kru, karyawan, peran, perangkat | Input manual | Pemilik | US-M1-03, US-M1-04, US-M10-01, US-M10-02 |
| Depot dan sumber air (termasuk meter dan geofence) | Input manual | Pemilik | US-M1-04 |
| Produk dan stok toko; bahan habis pakai depot | Opname fisik pada tanggal cut-over | Pemilik | US-M7-02 KP-5; US-M6-04 |
| Aset tetap | Akuntan dan notaris (K15) | Pemilik dan akuntan | US-M11-05 KP-1 |
| Saldo awal kas dan bank | Hitung fisik dan saldo rekening | Pemilik | US-M11-09 KP-2 |
| Piutang berjalan | Konfirmasi ke pelanggan, per faktur | Pemilik | US-M5-07 |
| Utang pemasok | Nota pemasok | Pemilik | US-M7-08 / US-M11-07 |
| Bagan akun dan pemetaan jurnal | Akuntan | Akuntan | US-M11-01 |

Cut-over akuntansi hanya pada tanggal 1 (NFR-36); transaksi sebelum tanggal itu tidak dimigrasi; modul operasional dapat go-live lebih dulu dengan jurnal dibangkitkan retroaktif (PTB-47). Keputusan go/no-go cut-over oleh komite pengarah dengan daftar ini sebagai bukti.

## 11.7 Pengendalian perubahan PRD (turunan BRD 12.4)

1. PRD v1.1 menjadi baseline produk setelah disetujui bersama BRD v1.1 (Bab 14). Permintaan perubahan dicatat (siapa, apa, mengapa, user story terdampak — lihat matriks balik Lampiran A.8) dan dinilai manajer proyek IT dalam 5 hari kerja.
2. Perubahan yang hanya mengubah kriteria penerimaan tanpa menambah cakupan atau menggeser jadwal disetujui pemilik modul dan manajer proyek IT; perubahan yang menambah cakupan atau menggeser jadwal diputuskan komite pengarah dengan aturan tukar (fitur masuk = fitur setara keluar) atau pergeseran jadwal yang disadari pemilik.
3. Pembekuan cakupan 4 minggu sebelum pilot dan sebelum go-live; hanya perbaikan cacat.
4. Keputusan atas PTB kelas C yang mengikuti usulan PRD bukan perubahan cakupan. PTB kelas A dan B — termasuk yang mengikuti usulan PRD — diperlakukan sebagai permintaan perubahan: kelas A melalui CR BRD (Lampiran D) dan kelas B melalui komite pengarah (Bab 13).
5. Setiap perubahan dicatat pada riwayat versi PRD dan, bila mengubah BRD, pada riwayat versi BRD dengan nomor CR yang sama.
6. Setiap kenaikan prioritas ke M dicatat di Bab 2.4 beserta jenisnya (koreksi konsistensi atau tambahan) dan kompensasinya.

## 11.8 Pelatihan dan bahan yang harus disediakan produk (turunan BRD 12.5)

| Kelompok | Bahan dari produk |
|---|---|
| Sopir dan kernet; operator depot; operator produksi | Panduan 1 halaman per peran (NFR-16); lingkungan latihan dengan data uji di perangkat terdaftar; skenario rit/shift latihan yang tidak masuk buku [USULAN] |
| Kasir toko | Panduan POS, penerimaan barang, opname |
| Dispatcher | Panduan pesanan, papan jadwal, peta; skenario rit gagal dan kredit ditahan |
| Admin Keuangan | Panduan kas, piutang, tutup kas; SOP P-05 s.d. P-07 versi sistem; pendampingan akuntan 3 bulan |
| Pemilik | Panduan dashboard, kotak masuk persetujuan, penanganan pengecualian dari ponsel |
| Seluruh karyawan | Sosialisasi: "sistem membuktikan kejujuran, bukan mencurigai" — riwayat selisih dan kinerja sendiri terlihat di aplikasi (US-M3-07 KP-6, US-M6-02 KP-6) mendukung pesan ini |

## 11.9 Tata kelola setelah go-live (turunan BRD 12.8)

Tinjauan KPI bulan 10, 11, dan 12 memakai Bab 1.3 dan halaman KPI (US-M9-07, RL-6); backlog Tahap 2 disusun dari masukan lapangan dan register Bab 13; skema kemitraan ditinjau setelah 3 bulan data M6 dan M11 (Bab 9.1 prasyarat 2 dan 4), dan Paket Minimum Mitra Fase 1 (RL-7) dievaluasi setiap 3 bulan (PAR-77). Register PTB tetap hidup: keputusan baru dicatat dengan tanggal; hanya usulan kelas C yang berlaku sebagai bawaan (0.2 butir 7).

# Bab 12 — Risiko & Ketergantungan Produk

## 12.1 Risiko BRD (R01–R14) dan jawaban produk

| Risiko BRD | Jawaban di PRD | Sisa risiko / pemilik |
|---|---|---|
| R01 Adopsi lapangan rendah | Alur ≤ 3 langkah dan offline-first (Bab 2.1, 6.4); sopir/operator melihat riwayat selisih dan kinerja sendiri (US-M3-07 KP-6, US-M6-02 KP-6); pelatihan ≤ 2 jam terukur (Bab 10.4); nota kertas ditarik per unit (11.5) | Sikap; insentif BR-12 — pemilik |
| R02 Scope creep tim IT | Setiap user story merujuk ID BRD; kelas A/B/C untuk PTB dan [USULAN] (0.2 butir 7); daftar tambahan M dan kompensasinya (2.4); Lampiran A dibangkitkan skrip dan menandai user story tanpa FR; pengendalian perubahan 11.7 | Disiplin tim — manajer proyek IT |
| R03 Kemacetan keputusan pemilik | Persetujuan sekali ketuk dari ponsel (US-M10-04); perilaku bila lewat tenggat per jenis sehingga operasi harian tidak menunggu pemilik (6.2a, PTB-32); keputusan selisih tidak mengunci rit (US-M4-02 KP-4); keputusan langsung pemilik dan pengesampingan beralasan di luar alur persetujuan (6.2b, 6.2c); pendelegasian sebagai opsi (PTB-32) | Beban pemilik tetap tinggi di Tahap 1 — pemilik |
| R04 PT/neraca awal terlambat | Jurnal dibangkitkan retroaktif (PTB-47); laporan "belum lengkap" (US-M9-02 KP-5); identitas dokumen "EQUA" sebelum PT (Bab 2.3) | Cut-over mundur — Admin Keuangan |
| R05 GPS terlambat/tidak cocok | Penghubung vendor terpisah (US-M12-01 KP-3); mode degradasi dengan titik status ponsel (Bab 7.12.6) | Kualitas data M12 pilot — tim IT |
| R06 Kapasitas air | Utilisasi dan ruang tumbuh (US-M8-05); komitmen kapasitas mitra (US-P3-01 KP-1, PAR-81) | Keputusan investasi — pemilik |
| R07 Pelanggan tempo menolak aturan | Masa transisi per pelanggan ≤ 2 bulan (US-M5-03 KP-5); pengecualian pemilik berjejak | Kehilangan pelanggan — Dispatcher |
| R08 Sengketa ganti rugi | Ganti rugi tidak aktif sampai Peraturan Perusahaan berlaku (PTB-22); sistem tidak memotong gaji (BR-11c); selisih dan keputusan berjejak | Legal — pemilik |
| R09 Kebocoran data/akses tidak sah | Bab 6.5, US-M10-02, US-M10-03, US-M10-06; tinjauan akses kuartalan (PAR-47); uji lintas tenant (Bab 9.6) | Operasi keamanan — tim IT |
| R10 Gangguan internet lapangan | Offline ≥ 1 hari, sinkron idempoten (Bab 6.4; Bab 10.2) | Perangkat rusak dengan antrean (US-M3-09 KP-5) — tim IT |
| R11 Omzet melampaui PKP tanpa disadari | Pemantauan 80/90% dan proyeksi (US-M11-08 KP-4) | Pengukuhan PKP — Admin Keuangan |
| R12 Istilah waralaba sebelum STPW | Istilah dikunci parameter (PTB-57) | Materi di luar sistem — pemilik |
| R13 Kehilangan Admin Keuangan | Peran dapat dipegang dua orang (US-M4-02 KP-9); SOP versi sistem (11.8) | Pelatihan cadangan — pemilik |
| R14 Pelanggan mempersoalkan tarif zona | Simulasi zona vs harga hari ini (US-M1-05 KP-5); harga khusus BR-16; pemeriksaan zona dari jarak GPS (US-M12-07) | Komunikasi — pemilik |

## 12.2 Risiko produk tambahan [USULAN]

| ID | Risiko | Kemungkinan | Dampak | Mitigasi di PRD | Pemilik |
|---|---|---|---|---|---|
| RP-01 | Konflik data offline (rit ditarik kantor tetapi sudah dikerjakan sopir) membingungkan Admin Keuangan | Sedang | Sedang | Aturan "lapangan tidak ditimpa" dan konflik ditampilkan (Bab 6.4 KP-3; US-M2-03 KP-5) | Tim IT |
| RP-02 | Hitung stok fisik harian di depot ramai dianggap beban dan diisi asal | Sedang | Sedang | Hanya 3 bahan utama dan toleransi (US-M6-02 KP-3, PAR-58); opname mingguan yang resmi (US-M6-04 KP-4) | Pemilik modul M6 |
| RP-03 | Koordinat alamat buruk pada awal sehingga zona/harga dan penyimpangan lokasi salah | Tinggi (30 hari pertama) | Sedang | Kunci koordinat dari pengiriman pertama; zona manual bertanda; simulasi harga (US-M1-01 KP-2, US-M1-05) | Dispatcher |
| RP-04 | Pertumbuhan penyimpanan foto (30–50 MB/hari) dan biaya cloud | Sedang | Rendah | Kompresi (PAR-38); arsip 2 tahun (PAR-29); biaya dipantau (NFR-29) | Tim IT |
| RP-05 | Kernet pengganti mengaburkan akuntabilitas kas | Rendah | Sedang | Hak hanya lewat jadwal kru; transaksi atas nama pengguna aktif (PTB-10) | Dispatcher |
| RP-06 | WA semi-otomatis membebani Dispatcher/Admin Keuangan (ratusan tautan per bulan) | Tinggi | Rendah | Daftar kerja satu klik (US-M2-07, US-M5-05); peningkatan ke API di Tahap 2 (PTB-60) | Pemilik |
| RP-07 | Pemetaan jurnal terlambat dari akuntan sehingga periode pertama tidak dapat ditutup | Sedang | Tinggi | Daftar tunggu jurnal (US-M11-02 KP-3); pembangkitan retroaktif (PTB-47); format ekspor disepakati bulan 1 | Admin Keuangan |
| RP-08 | Perangkat GPS dicabut sengaja; jejak ponsel dimatikan | Sedang | Sedang | Peringatan 15 menit, pola berulang dilaporkan (US-M12-08 KP-3); "tanpa lokasi" ditandai (US-M12-01) | Pemilik |
| RP-09 | Aturan kredit yang kaku membuat Dispatcher memaksa cara bayar tunai lalu sopir mencatat kurang bayar | Sedang | Sedang | Kurang bayar menjadi faktur H+0, ditagih pada pengiriman berikutnya, dan kurang bayar kedua menahan pesanan baru (PTB-18); sopir tidak memutuskan kredit — tunai → tempo lewat Dispatcher (PTB-19) | Admin Keuangan |
| RP-10 | Notifikasi terlalu banyak sehingga pemilik mengabaikan yang penting | Sedang | Sedang | Kelas kritis tidak dapat dimatikan; ringkasan harian dan jam tenang (US-M9-04 KP-3); ambang dapat diatur (Lampiran B) | Pemilik |
| RP-11 | Tahap 2: settlement gerbang pembayaran tidak cocok dengan pelunasan | Sedang | Sedang | Pembayaran digital masuk pencocokan M4 (US-P2-04 KP-3); PTB-50 | Admin Keuangan |
| RP-12 | Tahap 3: isolasi tenant gagal dan data mitra bocor ke mitra lain | Rendah | Tinggi | Uji penetrasi lintas tenant sebelum mitra pertama (Bab 9.6); tenant uji pada UAT (US-M6-07 KP-6) | Tim IT |
| RP-13 | Paket Mitra Fase 1 menarik tim dari stabilisasi Tahap 1 | Sedang | Sedang | Cakupan dibatasi 4 user story; syarat masuk RL-7 setelah TG-8; sisa kemitraan dikerjakan manual (9.10) | Manajer proyek IT |

## 12.3 Ketergantungan eksternal (BRD 11.4) dan cadangan produk

| Pihak | Dibutuhkan produk untuk | Cadangan bila terlambat |
|---|---|---|
| Konsultan akuntan | Bagan akun, pemetaan jurnal, neraca awal, umur aset, tinjauan bulan pertama | Modul operasional berjalan; jurnal retroaktif (PTB-47); laporan "belum lengkap" |
| Notaris dan konsultan hukum | Identitas PT pada dokumen; perjanjian mitra; STPW | Nama usaha "EQUA" pada dokumen (Bab 2.3); istilah waralaba terkunci (PTB-57); Tahap 3 tertunda |
| DJKI | Merek untuk Fase 2 kemitraan | Fase 1 (Opsi B) tidak memerlukan merek terdaftar |
| Vendor GPS | Perangkat dan layanan data | Titik status ponsel (Bab 7.12.6) |
| Google Cloud | Infrastruktur | — (rendah) |
| Penyedia WhatsApp Business API | Notifikasi otomatis Tahap 2 | Tautan semi-otomatis Tahap 1 tetap berjalan (K21) |
| Layanan peta komersial | Koordinat, jarak zona, navigasi | Koordinat dari GPS sopir; jarak garis lurus × faktor (US-M1-05 KP-2) |
| Konsultan pajak | Skema PPh, format ekspor | Omzet bruto per lini tersedia apa pun skemanya (US-M11-08 KP-2) |
| Konsultan HR/hukum ketenagakerjaan | Peraturan Perusahaan (BR-11, perangkat) | Ganti rugi nonaktif; selisih tetap tercatat (PTB-22) |
| Bank PT | Rekening, mutasi, setor bank | Pencocokan manual (PTB-16); setor fisik (PTB-23) |

## 12.4 Asumsi PRD (hanya kelas C yang berlaku sebagai bawaan)

Butir berpenanda [ASUMSI-PRD] di Bab 13 yang berkelas C (PTB-03, PTB-04, PTB-09, PTB-25, PTB-42, PTB-48) berlaku sebagai bawaan sampai pemilik menyatakan lain. Butir [ASUMSI-PRD] berkelas A (PTB-08, PTB-26, PTB-29) tidak berlaku sebagai bawaan dan diputuskan lewat CR di Lampiran D. masing-masing menyebut modul terdampak sehingga dampak perubahannya dapat dinilai lewat 11.7.

---
# Bab 13 — Register Pertanyaan Terbuka & Keputusan

**Kelas (v1.1).** Setiap PTB diberi kelas: **A — mengubah BRD** (kebutuhan, prioritas, aturan, atau keputusan BRD; diputuskan lewat CR di Lampiran D dan dicatat pada riwayat versi BRD); **B — menambah perilaku di luar BRD** (diputuskan komite pengarah; aturan tukar bila ber-prioritas M); **C — merinci BRD tanpa mengubah maksudnya** (berlaku sebagai bawaan setelah PRD disetujui; disahkan pemilik modul). PTB-49 s.d. PTB-60 (Tahap 2–3) tetap terbuka sampai gerbang tahapnya (TG-9 dan Bab 9.1), kecuali PTB-61.

**Catatan keputusan:** 9 Sep 2026 — PTB-01, PTB-02, PTB-05 disetujui sesuai usulan PRD; dipakai sebagai dasar M3–M5. 10 Sep 2026 — PTB-06, PTB-10, PTB-11 disetujui sesuai usulan PRD; dipakai sebagai dasar M9, M10, M12. 10 Sep 2026 — PTB-07, PTB-20, PTB-22, PTB-24, PTB-25, PTB-28 disetujui sesuai usulan PRD; dipakai sebagai dasar M6–M8 dan M11. 10 Sep 2026 — PTB-17, PTB-37, PTB-39 disetujui sesuai usulan PRD; PTB-17 menjadi dasar Bab 8–9. 27 Sep 2026 — v1.1: seluruh PTB diberi kelas; rekomendasi penyusun untuk PTB kelas A dan B dicatat pada kolom Status dan diputuskan pada sesi keputusan bersama CR di Lampiran D; PTB-61 dan PTB-62 ditambahkan.

| ID | Pokok | Usulan PRD | Jenis | Kelas | Dampak | Status |
|---|---|---|---|---|---|---|
| PTB-01 | Pasokan air ke 10 depot sendiri (±19.000 L/hari ≈ 4 rit/hari di luar 14 rit pelanggan) | Dijadwalkan lewat M2 sebagai pesanan internal, dijalankan sopir lewat M3, dinilai dengan harga transfer BR-33, tanpa pencatatan uang | [KEPUTUSAN] | C | M2, M3, M6, M8, M11 | **Disetujui 9 Sep 2026** — usulan PRD berlaku |
| PTB-02 | Sumber air acuan untuk zona tarif (dua sumber di dua kota) dan basis jarak | Sumber terdekat sebagai acuan bawaan, dapat diubah Dispatcher; jarak rute peta, cadangan garis lurus × 1,3 | [KEPUTUSAN] | C | M1, M2 | **Disetujui 9 Sep 2026** — usulan PRD berlaku |
| PTB-03 | Bentuk komponen BBM | Satu nilai rupiah per rit untuk semua zona, berlaku per tanggal | [ASUMSI-PRD] | C | M1 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-04 | QRIS di depot (P-02) tanpa gerbang pembayaran | QRIS statis dicatat sebagai non-tunai; dikeluarkan dari kas fisik saat tutup shift; dicocokkan Admin Keuangan lewat mutasi bank | [ASUMSI-PRD] | C | M6, M4 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-05 | Kanal notifikasi otomatis ke pemilik/Admin Keuangan | Pusat notifikasi dalam aplikasi + push Android; e-mail ringkasan harian; WA hanya ke pelanggan | [KEPUTUSAN] | C | Semua | **Disetujui 9 Sep 2026** — usulan PRD berlaku |
| PTB-06 | FR-M10-05 (PIN + perangkat terdaftar) berprioritas S | Diperlakukan sebagai M (NFR-09 M; K24) | [USULAN] | A | M10, M3, M6 | **Disetujui 10 Sep 2026** — usulan PRD berlaku; CR-01 |
| PTB-07 | FR-M6-04 (stok bahan habis pakai depot) S, tetapi P-02 langkah 1 & 5 dan BR-27 bergantung padanya | Naikkan ke M; bila tidak, opname depot mingguan ditunda sampai S terbangun | [KEPUTUSAN] | A | M6 | **Disetujui 10 Sep 2026** — usulan PRD berlaku; CR-02 |
| PTB-08 | BR-14 masih "(usulan)" padahal K21 menyetujui 22.00 | Diperlakukan disetujui: tutup kas ≤ 22.00 | [ASUMSI-PRD] | A | M4 | Rekomendasi v1.1: setujui; hapus "(usulan)" pada BR-14 — CR-03 |
| PTB-09 | Model rit | 1 rit = 1 pengiriman 5.000 L ke 1 alamat; n tangki = n rit | [ASUMSI-PRD] | C | M2, M3, M8 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-10 | Akun kernet | Akun sendiri; hak sopir hanya saat ditetapkan pengemudi pengganti di jadwal kru | [USULAN] | C | M3, M10 | **Disetujui 10 Sep 2026** — usulan PRD berlaku |
| PTB-11 | Akses akuntan | Peran baca-saja M11 selama pendampingan | [USULAN] | B | M10, M11 | **Disetujui 10 Sep 2026** — usulan PRD berlaku |
| PTB-12 | FR-M11-03 (semua jurnal manual disetujui pemilik) vs BR-35 (di atas Rp 5 juta) | Semua wajib lampiran; > Rp 5 juta disetujui pemilik sebelum posting; ≤ Rp 5 juta terposting dan masuk daftar tinjauan wajib pemilik sebagai syarat tutup buku | [USULAN] | A | M11 | Rekomendasi v1.1: setujui — CR-04 |
| PTB-13 | Harga pesanan bila harga master berubah sebelum kirim | Harga dikunci saat pesanan dibuat; Dispatcher diperingatkan dan dapat memperbarui dengan konfirmasi pelanggan | [USULAN] | C | M1, M2 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-14 | Format nomor pesanan/rit | P-YY-NNNNNN dan /n untuk rit | [USULAN] | C | M2 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-15 | "Jam diminta": jam pasti atau slot waktu | Jam pasti opsional; jam terima tetap dari master pelanggan | [USULAN] | C | M2, M3 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-16 | Rekonsiliasi bank (M) tanpa impor berkas (S) | Pencocokan manual transfer vs catatan wajib M; impor berkas mempercepat | [USULAN] | A | M4, M11 | Rekomendasi v1.1: setujui — CR-05 |
| PTB-17 | Tahap 2–3 "sama rinci" padahal BRD hanya epik | Pola user story yang sama; rincian di luar BRD berpenanda [USULAN], berstatus untuk estimasi | [KEPUTUSAN] | C | Bab 8–9 | **Disetujui 10 Sep 2026** — usulan PRD berlaku |
| PTB-18 | Kurang bayar tunai di lapangan (pelanggan membayar kurang dari harga) | Sisa menjadi faktur "kurang bayar" jatuh tempo H+0 dengan notifikasi Admin Keuangan; pesanan berikutnya bertanda "tagih kurang bayar" dan ditagih sopir; kurang bayar kedua saat yang pertama belum lunas → pesanan baru perlu persetujuan pemilik | [USULAN] | B | M3, M4, M5 | Rekomendasi v1.1: setujui dengan aturan tagih — keputusan komite pengarah |
| PTB-19 | Perubahan cara bayar di lapangan | Tempo → tunai/transfer selalu boleh; sopir tidak memutuskan kredit: tunai → tempo hanya lewat persetujuan Dispatcher saat daring untuk pelanggan Tempo dalam batas; bila luring dicatat sebagai kurang bayar lalu dapat dikonversi Admin Keuangan | [USULAN] | B | M3, M5 | Rekomendasi v1.1: ubah sesuai usulan ini — keputusan komite pengarah |
| PTB-20 | Pengeluaran rit (FR-M3-08, S): sumber dana dan verifikasi | Dicatat sopir dengan foto nota, dari kas di tangan atau uang pribadi; diverifikasi Admin Keuangan saat penerimaan setoran; sebelum verifikasi tetap dihitung dalam kas seharusnya | [KEPUTUSAN] | C | M3, M4, M11 | **Disetujui 10 Sep 2026** — usulan PRD berlaku |
| PTB-21 | Tutup kas saat ada setoran tertunda (sopir berhalangan) | Pemilik dapat mengizinkan tutup kas dengan setoran tertunda per kejadian (bukan izin tetap), maksimal 1 hari (PAR-89); rit sopir tetap terkunci (BR-10); kas diterima ≤ 24 jam | [USULAN] | A | M4 | Rekomendasi v1.1: setujui terbatas — CR-06 |
| PTB-22 | Ganti rugi (BR-11): pengaktifan dan pelunasan | Parameter "ganti rugi aktif" dinyalakan pemilik setelah Peraturan Perusahaan berlaku; pelunasan dicatat Admin Keuangan (setor tunai karyawan atau konfirmasi potongan dari penggajian); sistem tidak memotong gaji | [KEPUTUSAN] | C | M4, M11 | **Disetujui 10 Sep 2026** — usulan PRD berlaku |
| PTB-23 | Cara setor | Bawaan serah fisik ke Admin Keuangan pada hari yang sama; pemilik dapat mengizinkan setor tunai ke rekening PT dengan foto slip untuk sopir/outlet tertentu, diterima lewat pencocokan mutasi | [USULAN] | B | M3, M4, M6 | Rekomendasi v1.1: setujui (depot/toko sesuai P-02 langkah 6; sopir dengan izin pemilik per orang) — keputusan komite pengarah |
| PTB-24 | Satuan faktur untuk pelanggan tempo biasa | Satu faktur per rit tempo (jejak rit ↔ faktur ↔ pelunasan); pelanggan tagihan bulanan memakai faktur bulanan | [USULAN] | C | M5, M11 | **Disetujui 10 Sep 2026** — usulan PRD berlaku |
| PTB-25 | Batas kredit lintas lini | Satu batas kredit per pelanggan untuk air truk dan toko digabung | [ASUMSI-PRD] | C | M5, M7 | **Disetujui 10 Sep 2026** — usulan PRD berlaku |
| PTB-26 | Interpretasi BR-05 (tanggal faktur bulanan) | Faktur periode bulan M terbit tanggal 1 bulan M+1, jatuh tempo tanggal 15 bulan M+1 | [ASUMSI-PRD] | A | M5 | Rekomendasi v1.1: konfirmasi — CR-07 |
| PTB-27 | Rit tempo yang sudah terjadwal saat pelanggan menjadi Ditahan | Rit belum Berangkat ditandai ke Dispatcher (ubah ke tunai atau tarik); rit yang sudah Berangkat berlanjut | [USULAN] | C | M2, M5 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-28 | Penghapusan piutang tak tertagih | Tidak diatur BRD; hanya lewat jurnal manual M11 dengan persetujuan pemilik; pelanggan tetap Ditahan | [KEPUTUSAN] | B | M5, M11 | **Disetujui 10 Sep 2026** — usulan PRD berlaku |
| PTB-29 | Struk digital dan bukti pelunasan via WA dari aplikasi sopir | Struk digital WA versi tautan (satu ketuk) menjadi M karena P-01 langkah 7 adalah skenario UAT; pengiriman otomatis lewat API tetap Tahap 2 | [ASUMSI-PRD] | A | M3, M5 | Rekomendasi v1.1: naikkan ke M — CR-08 |
| PTB-30 | Laporan KPI program KPI-01–KPI-11 di M9 (tidak ada FR-nya di BRD) | Dibangun sebagai S: satu halaman KPI dengan rumus Bab 1.3, untuk tinjauan komite pengarah bulan 10–12 | [USULAN] | B | M9 | Rekomendasi v1.1: setujui sebagai S pada RL-6 — keputusan komite pengarah |
| PTB-31 | Kombinasi peran yang tidak dapat diajukan meski dengan persetujuan pemilik | Admin Keuangan bersama Dispatcher/Sopir/Kernet/Operator/Kasir; Admin sistem bersama peran kas/jurnal; Pemilik bersama pencatat transaksi harian | [USULAN] | B | M10 | Rekomendasi v1.1: setujui — keputusan komite pengarah |
| PTB-32 | Pendelegasian persetujuan saat pemilik berhalangan | Bawaan: tidak ada delegasi di Tahap 1; setiap jenis persetujuan punya perilaku bila lewat tenggat (6.2a) sehingga operasi tidak menunggu pemilik; delegasi hanya per jenis, berbatas waktu, bukan ke pemohon atau peran bertentangan | [KEPUTUSAN] | B | M10 | Rekomendasi v1.1: setujui — keputusan pemilik |
| PTB-33 | Retensi posisi GPS mentah (tidak diatur BRD) | Mentah 12 bulan; ringkasan per rit/hari disimpan bersama rit (10 tahun bila dipakai untuk biaya BBM di M11) | [USULAN] | C | M12, M10 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-34 | Lokasi "pool/garasi" truk sebagai lokasi sah di master | Ditambahkan ke master M1 (bersama depot dan sumber air) dengan geofence; dipakai aturan perjalanan di luar jadwal | [USULAN] | B | M1, M12 | Rekomendasi v1.1: setujui (tambahan, tukar CR-14) |
| PTB-35 | Autentikasi dua faktor untuk pemilik dan admin sistem pada web kantor | Diwajibkan untuk pemilik, Admin Keuangan, dan admin sistem (BRD 10.4 hanya mengatur konsol cloud) | [USULAN] | B | M10 | Rekomendasi v1.1: setujui (tambahan, tukar CR-14) |
| PTB-36 | Anonimisasi data pribadi pelanggan | Disetujui pemilik; tidak dapat dijalankan bila masih ada piutang terbuka; catatan keuangan dipertahankan tanpa identitas | [USULAN] | C | M10, M5 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-37 | Harga transfer internal bahan habis pakai dari toko ke depot sendiri (BRD hanya mengatur air, BR-33) | Harga mitra; dicatat sebagai pendapatan transfer internal L4 dan beban L3, dieliminasi pada konsolidasi | [KEPUTUSAN] | B | M6, M7, M11 | **Disetujui 10 Sep 2026** — usulan PRD berlaku; tambahan M, tukar CR-14 |
| PTB-38 | Metode harga pokok persediaan toko | Rata-rata bergerak; akuntan dapat mengubah (K9) | [USULAN] | C | M7, M11 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-39 | Perlakuan L1 (produksi air) dalam laba rugi per lini | Pusat biaya yang dialokasikan ke L2 dan L3 setiap bulan menurut proporsi volume pengisian; alternatif: harga air internal per liter | [KEPUTUSAN] | A | M11, M9 | **Disetujui 10 Sep 2026** — usulan PRD berlaku; CR-09 (laporan biaya per liter L1, US-M9-02 KP-6) |
| PTB-40 | Kas awal tetap (uang kembalian) per outlet depot | Rp 200.000 per outlet, ditetapkan pemilik, tidak ikut disetor | [USULAN] | C | M6, M4 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-41 | Neraca air harian dan perubahan stok tandon sumber | Rumus BRD dipertahankan untuk peringatan BR-26; rata-rata 7 hari dan pembacaan tandon opsional sebagai informasi | [USULAN] | C | M8 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-42 | Penjualan tempo toko saat offline | Toko diasumsikan daring; bila offline, tempo memakai eksposur sinkron terakhir dan berpenanda | [ASUMSI-PRD] | C | M7 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-43 | Void > Rp 100.000 saat POS offline | Berstatus menunggu persetujuan; transaksi tetap dihitung sampai disetujui; setelah shift ditutup diproses sebagai pembalik oleh Admin Keuangan | [USULAN] | C | M6, M7 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-44 | Penyesuaian saldo awal setelah cut-over | Hanya lewat jurnal "penyesuaian saldo awal" dengan persetujuan pemilik dan catatan akuntan, ≤ 3 bulan setelah cut-over | [USULAN] | C | M11 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-45 | Metode laporan arus kas | Metode langsung dari akun kas/bank | [USULAN] | C | M11 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-46 | Retur barang toko oleh pelanggan | Hari yang sama lewat void; setelah itu nota kredit oleh Admin Keuangan | [USULAN] | C | M7, M5 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-47 | M11 aktif setelah modul operasional (R04) | Jurnal dibangkitkan retroaktif dari data operasional sejak cut-over dan diverifikasi akuntan sebelum periode pertama ditutup | [USULAN] | C | M11 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-48 | Diskon di POS depot | Tidak ada di Tahap 1 (BRD hanya mengatur diskon toko, BR-17) | [ASUMSI-PRD] | C | M6 | Bawaan kelas C setelah PRD disetujui — disahkan pemilik modul |
| PTB-49 | Platform aplikasi pelanggan Tahap 2 | PWA (aplikasi web yang dapat dipasang) lebih dulu; aplikasi Android/iOS bila adopsi terbukti | [KEPUTUSAN] | C | Bab 8 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-50 | Gerbang pembayaran digital Tahap 2 (penyedia, biaya, settlement, siapa menanggung biaya) | Satu agregator dengan QRIS dinamis dan virtual account; settlement dicocokkan di M4; biaya dibukukan sebagai beban kecuali pemilik memutuskan dibebankan ke pelanggan | [KEPUTUSAN] | B | Bab 8, M4, M11 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-51 | Slot pengiriman yang ditawarkan ke pelanggan | Tiga slot (pagi/siang/sore, PAR-73) dari kapasitas rit M2; jam pasti tetap dimungkinkan lewat Dispatcher (PTB-15) | [USULAN] | C | Bab 8, M2 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-52 | Prioritas MoSCoW di dalam Tahap 2 | EP-2-01 s.d. EP-2-04 (tanpa pembayaran digital) M; pembayaran digital, EP-2-05, EP-2-06 S; EP-2-07 C | [USULAN] | B | Bab 8 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-53 | EP-2-07 pemesanan galon antar: siapa mengantar dan kapasitasnya | Ditunda (bergantung FR-M6-08 C dan keputusan operasional); tidak diestimasi sampai diputuskan | [KEPUTUSAN] | B | Bab 8, M6 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-54 | Tampilan posisi truk ke pelanggan | Hanya saat rit Berangkat menuju pelanggan itu; identitas: nopol dan nama depan sopir; tanpa riwayat posisi | [USULAN] | C | Bab 8, M12 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-55 | Fase B dan A sebagai parameter kontrak, dan prioritas MoSCoW Tahap 3 | Satu portal dengan parameter per mitra (9.4); EP-3-02/03/04 M, EP-3-01/05/06 sebagian M sebagian S | [USULAN] | B | Bab 9 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-56 | Harga jual di POS mitra | Ditetapkan mitra; EQUA menampilkan harga anjuran; royalti atas omzet tercatat | [KEPUTUSAN] | B | Bab 9, M6 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-57 | Istilah "waralaba" di antarmuka | Dikunci parameter yang hanya diaktifkan pemilik setelah STPW terbit; sebelum itu "Mitra Depot EQUA" (R12) | [USULAN] | C | Bab 9 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-58 | Data outlet mitra saat kontrak berakhir | Ekspor data outlet ke mitra dalam 30 hari; data tetap tersimpan di EQUA sesuai retensi (BRD 10.6) | [USULAN] | B | Bab 9, M10 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-59 | Sanksi bertingkat di sistem | Pemicu tercatat otomatis; setiap tahap sanksi (teguran → penghentian pasokan sementara → pemutusan) diputuskan pemilik dengan alasan | [USULAN] | C | Bab 9 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-60 | WhatsApp Business API sebagai prasyarat Tahap 2 | Diaktifkan di awal Tahap 2 (BRD 11.4) dan menggantikan tautan semi-otomatis tanpa mengubah alur Tahap 1 | [USULAN] | C | Bab 8, M2, M3, M5 | Terbuka — diputuskan pada gerbang Tahap 2/3 |
| PTB-61 | Jalur Kemitraan Fase 1 (K17, bulan 11–18) sebelum portal lengkap | Pertahankan K17 lewat Paket Minimum Mitra Fase 1 (9.10, RL-7): US-P3-08, US-P3-09, US-P3-10 (M), US-P3-11 (S); mulai 1–2 mitra bulan 11–12, hingga 3–5 mitra bulan 18; sisanya manual | [KEPUTUSAN] | A | Bab 9, M2, M5, M6, M10 | Rekomendasi v1.1: Opsi 1 — CR-15 |
| PTB-62 | Kunci rit karena selisih besar yang belum diputuskan | Parameter PAR-83, bawaan nonaktif; bila diaktifkan pemilik, selisih kurang ≥ ambang (misalnya Rp 500.000) yang belum diputuskan tetap mengunci rit sopir tersebut | [USULAN] | B | M3, M4 | Rekomendasi v1.1: tetap nonaktif — keputusan pemilik |

---

# Bab 14 — Persetujuan PRD

Dengan menandatangani dokumen ini, para pihak menetapkan PRD versi 1.1 sebagai baseline produk Program Digitalisasi Terpadu EQUA yang diturunkan dari BRD v1.1. PRD v1.1 dan BRD v1.1 ditandatangani dalam sesi yang sama; BRD v1.1 memuat CR yang disetujui pada Lampiran D. Usulan PRD berkelas C pada register Bab 13 berlaku sebagai bawaan; usulan berkelas A dan B hanya berlaku sesuai keputusan yang tercatat di Bab 13 dan Lampiran D. Perubahan setelah tanggal persetujuan mengikuti Bab 11.7.

| Peran | Nama | Jabatan | Tanda tangan | Tanggal |
|---|---|---|---|---|
| Sponsor dan product owner | | Pemilik EQUA | | |
| Manajer proyek IT | | | | |
| Pemilik modul M4, M5, M11 | | Admin Keuangan | | |
| Pemilik modul M2, M3, M12 | | Dispatcher | | |
| Pemilik modul M6 | | Operator depot senior | | |
| Pemilik modul M7 | | Kasir toko | | |
| Pemilik modul M8 | | Operator produksi | | |
| Konsultan akuntan (M11) | | | | |
| Disusun oleh | | Product Manager | | 27 September 2026 (v1.1) |

---

# Lampiran A — Matriks Ketertelusuran

Dibangkitkan otomatis oleh `tools/trace_check.py` dari BRD dan isi dokumen ini — jangan diedit manual; jalankan ulang skrip setiap PRD berubah (Bab 0.2 butir 8). **User story utama** = user story yang menyebut ID tersebut pada baris judulnya; **disebut juga di** = user story lain yang merujuknya di kriteria penerimaan. Blok user story berakhir pada judul user story atau judul bab/subbab berikutnya; rentang "s.d." dan "–" diurai menjadi ID tunggal. Prioritas efektif yang berbeda dari BRD dijelaskan di Bab 2.4.

## A.1 Kebutuhan fungsional Tahap 1 → user story

| FR | Kebutuhan (BRD) | Prio BRD | Efektif v1.1 | User story utama | Disebut juga di |
|---|---|---|---|---|---|
| FR-M1-01 | Data pelanggan: nama, segmen, kontak WA, lebih dari satu alamat kirim dengan titik koordinat, status kredit (tunai/tempo/ditahan), batas kredit, jatuh tempo, harga khusus | M | M | US-M1-01 | — |
| FR-M1-02 | Daftar produk dan harga untuk tiga lini: air truk berdasarkan zona jarak ditambah komponen BBM yang dapat diubah pemilik (A13, K23), produk depot, barang toko (harga mitra dan umum); riwayat perubahan harga tersimpan | M | M | US-M1-02 | — |
| FR-M1-03 | Data armada (nopol, kapasitas, kru default, perangkat GPS) dan karyawan (jabatan, peran sistem, lokasi tugas) | M | M | US-M1-03, US-M1-04 | — |
| FR-M1-04 | Data depot (lokasi, operator, kapasitas simpan) dan sumber air (kapasitas, meter) | M | M | US-M1-04 | — |
| FR-M1-05 | Tabel zona jarak (batas km dan tarif per zona) untuk harga air truk dan pengelompokan rit; setiap alamat pelanggan dipetakan ke satu zona (A13, K23) | M | M | US-M1-05 | — |
| FR-M1-06 | Impor awal 300 pelanggan dan daftar harga dari catatan yang ada; pembersihan duplikat | M | M | US-M1-06 | — |
| FR-M2-01 | Membuat pesanan dalam kurang dari 60 detik: cari pelanggan, pilih alamat, jumlah tangki, tanggal/jam diminta, cara bayar | M | M | US-M2-01 | — |
| FR-M2-02 | Nomor pesanan otomatis dan status: Baru → Terjadwal → Dalam pengiriman → Selesai / Dibatalkan (dengan alasan) | M | M | US-M2-02 | — |
| FR-M2-03 | Papan jadwal harian: menugaskan pesanan ke truk dan urutan rit; beban per truk terlihat; pesanan belum terjadwal menonjol | M | M | US-M2-03, US-M12-02 | — |
| FR-M2-04 | Peringatan pesanan dobel (pelanggan, alamat, dan hari yang sama) | M | M | US-M2-04 | — |
| FR-M2-05 | Kontrol kredit: pesanan tempo ditolak bila status kredit ditahan atau batas terlampaui, kecuali disetujui pemilik | M | M | US-M2-01, US-M2-05, US-M10-04 | — |
| FR-M2-06 | Pesanan berulang/langganan (misalnya hotel setiap Senin dan Kamis) dibuat otomatis | S | S | US-M2-06 | — |
| FR-M2-07 | Konfirmasi pesanan ke pelanggan lewat WA dari template (semi-otomatis) | S | S | US-M2-07 | — |
| FR-M2-08 | Riwayat pesanan dan catatan khusus per pelanggan (akses lokasi, jam terima) | M | M | US-M1-01, US-M2-08, US-M3-01 | US-P2-05 |
| FR-M2-09 | Pembatalan/penjadwalan ulang dengan alasan; rit gagal (pelanggan tidak ada) tercatat sebagai kejadian | M | M | US-M2-09, US-M3-06 | — |
| FR-M2-10 | Jadwal kerja dan libur bergantian kru serta ketersediaan truk, agar dispatcher melihat kapasitas rit harian yang nyata (A2) | S | S (bagian M: US-M2-11) | US-M2-10, US-M2-11 | — |
| FR-M3-01 | Daftar rit hari ini berurutan: pelanggan, alamat, catatan, tombol navigasi peta | M | M | US-M3-01 | — |
| FR-M3-02 | Status Berangkat / Tiba / Selesai dengan waktu dan lokasi otomatis | M | M | US-M3-02 | — |
| FR-M3-03 | Bukti kirim: foto, nama dan tanda tangan penerima, volume terkirim | M | M | US-M3-03 | — |
| FR-M3-04 | Pencatatan pembayaran per rit: tunai (jumlah), transfer (foto bukti), tempo | M | M | US-M3-04 | — |
| FR-M3-05 | Saldo kas di tangan berjalan dan tombol "Setor" akhir hari dengan ringkasan | M | M | US-M3-04, US-M3-07 | — |
| FR-M3-06 | Bekerja tanpa sinyal dan menyinkronkan otomatis saat sinyal kembali | M | M | US-M3-09 | — |
| FR-M3-07 | Transaksi tidak dapat diubah setelah dikirim; koreksi hanya oleh Admin Keuangan dengan alasan | M | M | US-M3-10 | US-M3-03 |
| FR-M3-08 | Pencatatan pengeluaran rit (BBM, tol, parkir) dengan foto nota | S | S | US-M3-08 | — |
| FR-M3-09 | Antarmuka Bahasa Indonesia, tombol besar, maksimal 3 langkah per tindakan; dapat dipakai kernet bila sopir berhalangan | M | M | US-M2-11, US-M3-01, US-M3-10 | — |
| FR-M3-10 | Pelaporan kendala lapangan (pelanggan tidak ada, jalan ditutup, truk rusak) dengan foto | S | S | US-M3-06 | — |
| FR-M4-01 | Posisi kas harian per sumber (setiap sopir, depot, toko): seharusnya vs diterima | M | M | US-M4-01, US-M7-09 | — |
| FR-M4-02 | Penerimaan setoran: Admin Keuangan menginput jumlah fisik; selisih dihitung sistem | M | M | US-M3-07, US-M4-02 | — |
| FR-M4-03 | Selisih wajib alasan dan status tindak lanjut; notifikasi pemilik bila melebihi ambang (K12) | M | M | US-M4-02, US-M4-03 | — |
| FR-M4-04 | Pencatatan transfer masuk dan pencocokan dengan mutasi bank (impor berkas dari internet banking) | S | S (bagian M: pencocokan manual) | US-M4-04 | US-M11-06 |
| FR-M4-05 | Kas kecil dan pengeluaran harian kantor dengan bukti | S | S | US-M4-05 | — |
| FR-M4-06 | Tutup kas harian tidak dapat dilakukan bila ada setoran yang belum diterima; laporan H+0 ke pemilik | M | M | US-M4-06 | — |
| FR-M4-07 | Riwayat selisih per sopir/operator untuk penilaian kinerja | S | S | US-M4-03 | US-M3-07 |
| FR-M5-01 | Piutang terbentuk otomatis dari pengiriman tempo dan penjualan tempo toko | M | M | US-M5-01, US-P3-09 | — |
| FR-M5-02 | Jatuh tempo dan batas kredit per pelanggan (K13) | M | M | US-M5-01 | — |
| FR-M5-03 | Pelunasan sebagian/penuh, tunai atau transfer, dialokasikan ke faktur tertentu, dengan bukti | M | M | US-M3-05, US-M5-02 | — |
| FR-M5-04 | Laporan umur piutang (belum jatuh tempo, 1–7, 8–30, lebih dari 30 hari) | M | M | US-M5-04 | — |
| FR-M5-05 | Pengingat WA H-3 dan H+1 dari template | S | S | US-M5-05 | — |
| FR-M5-06 | Status kredit otomatis "ditahan" bila lewat jatuh tempo melebihi batas; pemilik dapat membuka dengan alasan | M | M | US-M5-03 | — |
| FR-M5-07 | Faktur/tagihan bulanan PDF untuk pelanggan tagihan bulanan, dengan rincian rit | M | M | US-M5-06 | — |
| FR-M6-01 | Transaksi cepat: pilih produk, jumlah, total, bayar; ≤ 10 detik | M | M | US-M6-01 | — |
| FR-M6-02 | Buka/tutup shift dengan kas awal, kas akhir fisik, dan selisih otomatis | M | M | US-M6-02 | — |
| FR-M6-03 | Void dengan alasan; tidak ada hapus; void berlebihan dilaporkan | M | M | US-M6-03 | — |
| FR-M6-04 | Stok bahan habis pakai per outlet (tutup, tisu, galon kosong) dan pemakaian vs penjualan | S | M | US-M6-02, US-M6-04, US-M7-06 | — |
| FR-M6-05 | Penerimaan pasokan air dari EQUA (volume) terkait pengiriman (M8) | M | M | US-M6-05, US-M8-03, US-M12-06, US-P3-08 | US-M3-03 |
| FR-M6-06 | Berjalan tanpa sinyal; sinkron otomatis | M | M | US-M6-06 | — |
| FR-M6-07 | Dirancang sebagai paket standar: satu aplikasi untuk banyak outlet dan banyak pemilik, sehingga dapat dipakai mitra frenchise tanpa perubahan | M | M | US-M6-07, US-P3-08 | — |
| FR-M6-08 | Pelanggan depot terdaftar (langganan antar galon, saldo prabayar) | C | C | — | US-M6-01, US-P2-07 |
| FR-M7-01 | POS dengan harga mitra (mitra terdaftar) dan umum; diskon perlu persetujuan | M | M | US-M7-01 | — |
| FR-M7-02 | Kartu stok per barang, penerimaan dari pemasok dengan harga beli, stok minimum dan peringatan pesan ulang | M | M | US-M7-02, US-M7-03, US-M7-06 | — |
| FR-M7-03 | Penjualan tempo hanya untuk mitra terdaftar; terintegrasi M5 | M | M | US-M7-04 | — |
| FR-M7-04 | Stok opname dan penyesuaian dengan alasan dan persetujuan | M | M | US-M7-05 | — |
| FR-M7-05 | Laporan barang laris/mati dan margin per barang | S | S (RL-6) | US-M7-07 | — |
| FR-M7-06 | Utang kepada pemasok dan jadwal pembayaran (terintegrasi M11) | S | S | US-M7-08, US-M11-07 | — |
| FR-M8-01 | Produksi harian per sumber dari angka meter awal/akhir, dengan foto meter | M | M | US-M8-01 | — |
| FR-M8-02 | Pengisian truk per rit (volume, truk, waktu) dan pasokan ke depot | M | M | US-M8-02, US-M8-03, US-M12-06 | — |
| FR-M8-03 | Neraca air harian per sumber: produksi − pengisian − pasokan = susut | M | M | US-M8-04 | — |
| FR-M8-04 | Utilisasi kapasitas harian/bulanan dan peringatan di atas 90% | S | S | US-M8-05 | — |
| FR-M8-05 | Catatan mutu air (jadwal uji, hasil lab, tindakan) sebagai dasar standar frenchise | S | S | US-M8-06 | — |
| FR-M9-01 | Dashboard H+0: omzet per lini, kas diterima vs seharusnya, selisih, piutang, rit per truk, galon per depot | M | M | US-M4-06, US-M9-01 | — |
| FR-M9-02 | Laporan bulanan laba kotor per lini dan konsolidasi (dari M11) | M | M | US-M9-02, US-M11-04 | — |
| FR-M9-03 | Ekspor Excel/PDF untuk semua laporan | M | M | US-M9-03 | — |
| FR-M9-04 | Notifikasi pengecualian ke pemilik: selisih di atas ambang, pesanan gagal, anomali GPS, susut air | S | S (bagian M: infrastruktur notifikasi) | US-M9-04 | — |
| FR-M9-05 | Kinerja per sopir/truk (rit, selisih, ketepatan) dan per depot/operator (galon, selisih) | S | S | US-M9-05 | — |
| FR-M9-06 | Tren mingguan/bulanan: omzet, rit, galon, piutang | S | S (RL-6) | US-M9-06 | — |
| FR-M10-01 | Peran dan hak akses sesuai Bab 4.2; satu orang memegang lebih dari satu peran hanya dengan persetujuan pemilik | M | M | US-M10-01, US-P3-10 | — |
| FR-M10-02 | Jejak audit semua perubahan data: siapa, kapan, nilai lama, nilai baru; tidak dapat dihapus | M | M | US-M10-05 | — |
| FR-M10-03 | Pemisahan tugas dipaksakan: pembuat transaksi tidak dapat menyetujui transaksinya sendiri | M | M | US-M10-03 | US-M10-04 |
| FR-M10-04 | Alur persetujuan: selisih kas, pembukaan kredit, perubahan harga, void besar, penyesuaian stok, jurnal manual | M | M | US-M10-04 | — |
| FR-M10-05 | Login ponsel dengan PIN dan perangkat terdaftar; akses dinonaktifkan seketika saat karyawan keluar | S | M | US-M3-10, US-M10-02 | — |
| FR-M11-01 | Bagan akun standar dengan pusat laba per lini (L1–L5) sehingga laba rugi per lini tersedia | M | M | US-M11-01 | — |
| FR-M11-02 | Jurnal otomatis dari seluruh transaksi operasional (penjualan, kas, piutang, pembelian, stok, setoran, pengeluaran rit) | M | M | US-M3-08, US-M4-05, US-M11-02, US-M12-07 | — |
| FR-M11-03 | Jurnal manual (gaji, BBM, sewa, listrik, pemeliharaan) dengan lampiran dan persetujuan pemilik | M | M | US-M11-03 | — |
| FR-M11-04 | Buku besar, neraca saldo, laba rugi per lini dan konsolidasi, neraca, arus kas | M | M | US-M11-04 | — |
| FR-M11-05 | Daftar aset tetap (truk, instalasi sumber air, peralatan depot, bangunan) dan penyusutan otomatis | M | M | US-M11-05 | — |
| FR-M11-06 | Rekonsiliasi bank dan kas | M | M | US-M4-05, US-M11-06 | US-M4-04 |
| FR-M11-07 | Utang usaha kepada pemasok dan jatuh tempo pembayaran | S | S | US-M7-08, US-M11-07 | — |
| FR-M11-08 | Pelaporan pajak untuk PT non-PKP (K10): tanpa faktur pajak/PPN; omzet bruto bulanan per lini untuk PPh badan sesuai skema yang ditetapkan konsultan pajak; ekspor ke format konsultan | M | M | US-M11-08 | — |
| FR-M11-09 | Saldo awal per tanggal cut-over dan mekanisme penyesuaiannya (K9) | M | M | US-M5-07, US-M11-09 | — |
| FR-M11-10 | Tutup dan kunci periode; koreksi hanya melalui jurnal periode berikutnya | M | M | US-M11-10 | US-M11-02 |
| FR-M11-11 | Anggaran vs realisasi per lini | C | C | — | — |
| FR-M11-12 | Pemantauan omzet 12 bulan berjalan terhadap batas pengukuhan PKP Rp 4,8 miliar; peringatan ke pemilik pada 80% dan 90% (BR-29) | M | M | US-M11-08 | — |
| FR-M12-01 | Posisi 7 truk di peta secara real-time (pembaruan ≤ 1 menit) untuk dispatcher dan pemilik | M | M | US-M12-02 | US-M2-03, US-M12-01 |
| FR-M12-02 | Riwayat perjalanan per rit dan per hari: jejak, jarak, durasi, titik berhenti | M | M | US-M12-03 | — |
| FR-M12-03 | Pencocokan otomatis lokasi "Selesai" dengan koordinat alamat pelanggan; penyimpangan ditandai | M | M | US-M3-03, US-M12-04 | — |
| FR-M12-04 | Perjalanan di luar jadwal atau di luar jam operasional ditandai dan dilaporkan ke pemilik | M | M | US-M3-06, US-M12-05 | — |
| FR-M12-05 | Geofence sumber air dan depot: waktu masuk/keluar untuk memverifikasi pengisian dan pasokan | S | S | US-M8-02, US-M12-06 | US-M3-02 |
| FR-M12-06 | Sumber data: perangkat GPS terpasang di truk, dengan GPS ponsel sopir sebagai cadangan (K11) | M | M | US-M1-03, US-M3-02, US-M12-01, US-M12-08 | — |
| FR-M12-07 | Jarak tempuh per rit dari GPS sebagai dasar biaya BBM per rit (ke M11) dan pemeriksaan kesesuaian zona tarif pelanggan (A13) | S | S (RL-6) | US-M3-08, US-M12-07 | US-M1-05 |
| FR-M12-08 | Peringatan perangkat mati atau dicabut lebih dari 15 menit pada jam operasional | S | S (bagian M: KP-1–2) | US-M10-07, US-M12-08 | US-M3-02 |

## A.2 Aturan bisnis → user story

| BR | Aturan (ringkas) | User story utama | Disebut juga di |
|---|---|---|---|
| BR-01 | Pelanggan baru selalu tunai. Status tempo hanya diberikan setelah minimal 3 bulan atau 10 pesanan tanpa masala… | US-M1-01, US-M1-06, US-M5-03, US-M10-04 | US-M2-01, US-P2-01 |
| BR-02 | Jatuh tempo standar 14 hari sejak tanggal pengiriman | US-M1-01, US-M5-01 | — |
| BR-03 | Lewat jatuh tempo lebih dari 7 hari → status kredit otomatis "ditahan"; pesanan tempo diblokir sampai lunas; p… | US-M2-05, US-M5-03, US-M10-04 | — |
| BR-04 | Batas kredit per segmen (disetujui K16): rumah tangga tunai saja; depot pihak ketiga dan perumahan Rp 3 juta;… | US-M1-01, US-M2-05, US-M7-04 | — |
| BR-05 | Tagihan bulanan hanya untuk pelanggan dengan perjanjian tertulis; faktur terbit tanggal 1, jatuh tempo tanggal… | US-M5-06, US-P3-09 | US-M1-01, US-M5-01, US-P3-04 |
| BR-06 | Batas kredit dihitung dari piutang belum lunas ditambah pesanan tempo yang belum dikirim | US-M2-05, US-M5-01, US-M7-04 | US-M1-01, US-M3-04 |
| BR-07 | Pelunasan dapat diterima Admin Keuangan (kantor/transfer) atau sopir saat pengiriman berikutnya. Pelunasan lew… | US-M3-05, US-M5-02 | — |
| BR-08 | Seluruh uang tunai hari itu disetor pada hari yang sama. Sopir tidak membawa pulang uang; kas di outlet depot… | US-M3-07, US-M4-01, US-M4-02, US-M6-02, US-M7-09 | — |
| BR-09 | Selisih setoran ≥ Rp 50.000 per sopir/outlet per hari → notifikasi pemilik dan wajib tindak lanjut ≤ 24 jam. A… | US-M4-02, US-M4-03, US-M10-04 | — |
| BR-10 | Sopir tidak dapat memulai rit bila setoran hari sebelumnya belum ditutup oleh Admin Keuangan | US-M2-11, US-M3-01, US-M3-07 | US-M2-03, US-M4-02, US-M4-06 |
| BR-11 | Selisih kurang yang tidak dapat dipertanggungjawabkan menjadi ganti rugi karyawan melalui pemotongan gaji (kep… | US-M4-03 | — |
| BR-12 | Selisih lebih dicatat dan disetor penuh; bukan milik sopir/operator. Analis menyarankan insentif positif sebag… | US-M4-02, US-M4-03, US-M9-05 | — |
| BR-13 | Void di POS lebih dari 3 kali per hari per outlet → notifikasi Admin Keuangan; void di atas Rp 100.000 perlu p… | US-M6-03, US-M10-04 | US-M7-01 |
| BR-14 | Tutup kas harian oleh Admin Keuangan paling lambat pukul 22.00 (usulan); dashboard pemilik terbit otomatis set… | US-M4-06 | — |
| BR-15 | Harga hanya berasal dari master. Perubahan harga disetujui pemilik, berlaku mulai tanggal yang ditentukan, riw… | US-M1-02, US-M6-01, US-M7-01, US-M10-04 | US-M7-02 |
| BR-16 | Harga khusus per pelanggan dicatat dengan alasan dan tanggal berlaku; ditinjau setiap 6 bulan | US-M1-01, US-M10-04 | — |
| BR-17 | Diskon oleh kasir toko maksimal 5% (disetujui K21); di atas itu perlu persetujuan pemilik | US-M7-01, US-M10-04 | — |
| BR-18 | Harga mitra di toko hanya untuk mitra terdaftar: depot pihak ketiga yang menjadi pelanggan air EQUA dan mitra… | US-M1-01, US-M7-01, US-M7-04 | US-P3-01, US-P3-03, US-P3-08, US-P3-11 |
| BR-19 | Harga air truk ditentukan oleh zona jarak alamat pelanggan (tabel zona di M1, K23) ditambah komponen BBM yang… | US-M1-02, US-M1-05, US-M2-01, US-M3-01, US-M3-04 | US-P2-02 |
| BR-20 | Pesanan untuk hari yang sama diterima sampai pukul 15.00 (disetujui K21); setelah itu dijadwalkan H+1 kecuali… | US-M2-01 | US-P2-02 |
| BR-21 | Urutan jadwal: langganan berkala dan pelanggan dengan jam terima tetap lebih dulu, sisanya berdasarkan waktu p… | US-M2-03, US-M2-06 | — |
| BR-22 | Rit tidak dapat diselesaikan tanpa bukti kirim (foto dan nama penerima). Volume standar 5.000 L; volume parsia… | US-M3-03 | — |
| BR-23 | Lokasi "Selesai" lebih dari 200 m dari titik alamat pelanggan → wajib alasan; lebih dari 1 km → ditandai untuk… | US-M3-03, US-M12-04 | US-M3-02 |
| BR-24 | Rit gagal (pelanggan tidak ada/menolak) dicatat; dua kali gagal berturut-turut → pesanan berikutnya wajib konf… | US-M2-09, US-M3-06 | — |
| BR-25 | Perjalanan truk di luar jadwal atau di luar jam operasional (M12) ditandai; sopir wajib memberi keterangan pad… | US-M3-06, US-M12-05 | US-M9-05 |
| BR-26 | Neraca air harian per sumber. Susut di atas 5% (disetujui K21) → investigasi operator dan laporan ke pemilik | US-M8-04 | — |
| BR-27 | Stok opname: depot mingguan (bahan habis pakai), toko bulanan. Penyesuaian stok disetujui pemilik | US-M6-04, US-M7-05, US-M10-04 | — |
| BR-28 | Barang masuk toko wajib nota pemasok; tanpa nota tidak dapat dijual | US-M7-02 | US-M7-01 |
| BR-29 | Perusahaan berstatus PT non-PKP: tidak memungut PPN dan tidak menerbitkan faktur pajak. Sistem memantau omzet… | US-M11-08 | US-M5-01 |
| BR-30 | Skema PPh badan, termasuk opsi PPh final UMKM 0,5% dari omzet bruto bila memenuhi syarat, ditetapkan konsultan… | US-M11-08 | — |
| BR-31 | Pembukuan dan bukti transaksi (digital) disimpan minimal 10 tahun | US-M10-05, US-M10-06, US-M11-08 | — |
| BR-32 | Periode akuntansi bulanan; tutup buku paling lambat tanggal 10 bulan berikutnya; periode terkunci hanya dibuka… | US-M9-02, US-M10-04, US-M11-10 | — |
| BR-33 | Pusat laba per lini (L1–L5). Pasokan air dari truk EQUA ke depot sendiri dicatat sebagai transfer internal den… | US-M1-02, US-M6-05, US-M7-06, US-M8-03, US-M9-02, US-M11-01 | US-M9-01 |
| BR-34 | Aset tetap masuk PT pada nilai yang ditetapkan akuntan dan notaris (K15); penyusutan otomatis sesuai umur ekon… | US-M11-05 | — |
| BR-35 | Jurnal manual wajib lampiran; jurnal manual di atas Rp 5 juta (disetujui K21) perlu persetujuan pemilik | US-M10-04, US-M11-03 | — |
| BR-36 | Satu orang satu akun; PIN tidak boleh dibagi; pelanggaran diperlakukan sebagai pelanggaran disiplin | US-M2-11, US-M3-10, US-M10-01, US-M10-02 | — |
| BR-37 | Akses dicabut pada hari karyawan berhenti; perangkat lapangan dikembalikan atau dihapus jarak jauh | US-M3-10, US-M10-01, US-M10-02 | US-M1-04 |
| BR-38 | Koreksi transaksi hanya lewat transaksi pembalik dengan alasan; tidak ada penghapusan. Koreksi di atas Rp 500.… | US-M2-02, US-M6-03, US-M10-04, US-M10-05, US-P3-09 | US-M3-03, US-M4-05, US-M4-06, US-M5-01, US-M5-02, US-M6-02, US-M7-02, US-M8-01, US-M8-02, US-M11-02, US-M11-03 |
| BR-39 | Data pelanggan dan mitra tidak diekspor keluar sistem kecuali oleh pemilik atau Admin Keuangan untuk keperluan… | US-M5-04, US-M9-03, US-M10-05, US-M10-06 | US-P2-04 |

## A.3 Kebutuhan non-fungsional → verifikasi dan user story

| NFR | Kebutuhan (BRD) | Prio | Verifikasi | User story yang merujuk |
|---|---|---|---|---|
| NFR-01 | Jam layanan sistem | M | Bab 10.1 | — |
| NFR-02 | Ketersediaan pada jam layanan | M | Bab 10.1 | — |
| NFR-03 | Waktu respons | M | Bab 10.1 | US-M6-01, US-M9-01 |
| NFR-04 | Dashboard pemilik H+0 | M | Bab 10.1 | US-M4-06, US-M9-01 |
| NFR-05 | Beban rancangan | S | Bab 10.1 | — |
| NFR-06 | Aplikasi sopir dan POS depot tetap mencatat transaksi tanpa sinyal | M | Bab 10.2 | US-M3-09, US-M6-06, US-M8-07 |
| NFR-07 | Sinkronisasi | M | Bab 10.2 | US-M3-09, US-M6-06, US-M8-07 |
| NFR-08 | Kejelasan status | M | Bab 10.2 | US-M3-09, US-M6-06, US-M8-07, US-M10-07 |
| NFR-09 | Akses | M | Bab 10.3 | US-M3-10, US-M10-01, US-M10-02 |
| NFR-10 | Enkripsi | M | Bab 10.3 | US-M3-09, US-M3-10, US-M10-02 |
| NFR-11 | Jejak audit | M | Bab 10.3 | US-M10-05 |
| NFR-12 | Data pribadi pelanggan | M | Bab 10.3 | US-M10-01, US-M10-06 |
| NFR-13 | Pencadangan | M | Bab 10.3 | US-M10-06, US-M11-08 |
| NFR-14 | Pemulihan bencana | S | Bab 10.3 | US-M10-06 |
| NFR-15 | Bahasa | M | Bab 10.4 | US-M3-01, US-M8-07 |
| NFR-16 | Pelatihan | M | Bab 10.4 | US-M3-10, US-M8-07 |
| NFR-17 | Perangkat | M | Bab 10.4 | US-M3-02, US-M3-10, US-M8-07 |
| NFR-18 | Keterbacaan | S | Bab 10.4 | US-M3-01, US-M8-07 |
| NFR-19 | Web kantor dan pemilik | M | Bab 10.4 | US-M9-01, US-M12-02 |
| NFR-20 | WhatsApp | S | Bab 10.5 | US-M2-07, US-M5-05, US-P2-03, US-P2-08 |
| NFR-21 | Perangkat GPS | M | Bab 10.5 | US-M12-01 |
| NFR-22 | Mutasi bank | S | Bab 10.5 | US-M4-04 |
| NFR-23 | Ekspor | M | Bab 10.5 | US-M2-02, US-M4-01, US-M9-03, US-M11-08 |
| NFR-24 | Peta | M | Bab 10.5 | US-M1-05, US-M12-02, US-P2-03 |
| NFR-25 | Printer struk bluetooth | C | Bab 10.5 | US-M6-01 |
| NFR-26 | Lokasi data | M | Bab 10.6 | — |
| NFR-27 | Lingkungan | M | Bab 10.6 | — |
| NFR-28 | Pemantauan | M | Bab 10.6 | US-M10-07, US-M12-08 |
| NFR-29 | Biaya cloud | S | Bab 10.6 | US-P2-08 |
| NFR-30 | Multi-tenant | M | Bab 10.6 | US-M6-07, US-M10-01, US-M10-06, US-P3-02, US-P3-08, US-P3-10 |
| NFR-31 | Helpdesk | M | Bab 10.7 | US-M10-07 |
| NFR-32 | Rilis perubahan | M | Bab 10.7 | US-M10-07 |
| NFR-33 | Dokumentasi | M | Bab 10.7 | — |
| NFR-34 | Data awal | M | Bab 10.8 | US-M1-06, US-M5-07, US-M7-02, US-M10-01, US-M11-05, US-M11-09 |
| NFR-35 | Periode paralel | M | Bab 10.8 | — |
| NFR-36 | Cut-over akuntansi | M | Bab 10.8 | US-M11-09 |

## A.4 Epik Tahap 2 dan 3 → user story

| Epik | Isi (BRD) | User story |
|---|---|---|
| EP-2-01 | Pendaftaran dengan verifikasi nomor WA; alamat tersimpan | US-P2-01 |
| EP-2-02 | Pemesanan air truk dengan pilihan tanggal/slot dan harga transparan | US-P2-02 |
| EP-2-03 | Status dan pelacakan pengiriman (posisi truk saat menuju pelanggan, memakai M12) | US-P2-03 |
| EP-2-04 | Riwayat pesanan, struk, tagihan, dan pembayaran digital | US-P2-04 |
| EP-2-05 | Langganan berkala dan pengingat isi ulang | US-P2-05 |
| EP-2-06 | Penilaian layanan dan keluhan | US-P2-06 |
| EP-2-07 | Pemesanan galon antar dari depot terdekat (bisa ditunda) | US-P2-07 |
| EP-3-01 | Pendaftaran, penilaian lokasi, kontrak, dan onboarding mitra | US-P3-01 |
| EP-3-02 | POS depot standar (M6) dengan kepemilikan data terpisah per mitra | US-P3-02, US-P3-08 |
| EP-3-03 | Pemesanan air dan spare part ke EQUA dengan harga mitra dan tagihan | US-P3-03 |
| EP-3-04 | Perhitungan royalti/fee otomatis dari penjualan mitra; tagihan dan pembayaran | US-P3-04, US-P3-09 |
| EP-3-05 | Standar mutu: daftar periksa, jadwal audit, hasil uji air | US-M8-06, US-P3-05 |
| EP-3-06 | Dashboard kinerja mitra dan pembina wilayah | US-P3-06, US-P3-08, US-P3-10 |

## A.5 KPI → user story yang menyediakan datanya

| KPI | Ukuran (BRD 2.3) | Instrumentasi | User story yang merujuk |
|---|---|---|---|
| KPI-01 | Transaksi tercatat di sistem pada hari yang sama | Bab 1.3 | US-M3-09, US-M9-07 |
| KPI-02 | Waktu rekonsiliasi kas harian oleh pemilik/admin | Bab 1.3 | US-M4-06, US-M9-07 |
| KPI-03 | Selisih kas yang tidak terjelaskan > 24 jam | Bab 1.3 | US-M4-03, US-M9-04, US-M9-07 |
| KPI-04 | Piutang lewat jatuh tempo (% dari total piutang) | Bab 1.3 | US-M5-03, US-M5-04, US-M9-01, US-M9-07 |
| KPI-05 | Pesanan bernomor dan berstatus | Bab 1.3 | US-M2-02, US-M9-07 |
| KPI-06 | Pesanan terlewat atau dobel | Bab 1.3 | US-M2-04, US-M9-07, US-P2-02 |
| KPI-07 | Rit terealisasi vs terjadwal, per truk | Bab 1.3 | US-M2-10, US-M9-05, US-M9-07, US-M12-03 |
| KPI-08 | Laporan harian omzet–kas–piutang per lini | Bab 1.3 | US-M4-06, US-M9-01, US-M9-07 |
| KPI-09 | Laba kotor per lini | Bab 1.3 | US-M9-02, US-M9-07 |
| KPI-10 | Waktu pemilik untuk pencatatan/pembukuan | Bab 1.3 | US-M9-07 |
| KPI-11 | Adopsi pengguna lapangan (sopir, operator depot, kasir) | Bab 1.3 | US-M9-07, US-M10-01 |

## A.6 User story Tahap 1 tanpa FR pada judul (turunan NFR, BR, proses, atau usulan PRD)

| User story | Judul | Rujukan pada judul |
|---|---|---|
| US-M8-07 | Bekerja tanpa sinyal di sumber air | NFR-06, NFR-07, NFR-08, NFR-15, NFR-16, NFR-17 |
| US-M9-07 | Laporan KPI program (KPI-01–KPI-11) | KPI-01, KPI-02, KPI-03, KPI-04, KPI-05, KPI-06, KPI-07, KPI-08, KPI-09, KPI-10, KPI-11 |
| US-M10-06 | Data pribadi, retensi, dan pencadangan | BR-31, BR-39, NFR-12, NFR-13, NFR-14 |

## A.7 Hasil validasi

Status: **LULUS** — 90 FR, 39 BR, 36 NFR, 11 KPI, 13 epik; 114 user story (95 Tahap 1, 8 Tahap 2, 11 Tahap 3).

| Pemeriksaan | Jumlah | Rincian |
|---|---|---|
| FR M/S tanpa user story utama | 0 | — |
| FR C yang punya user story utama | 0 | — |
| BR tanpa user story | 0 | — |
| NFR tanpa baris verifikasi Bab 10 | 0 | — |
| KPI tanpa user story penyedia data | 0 | — |
| Epik tanpa user story | 0 | — |
| Rujukan palsu (ID tidak ada di blok user story) | 0 | — |
| Sisa ID lama PT-nn (peringatan) | 0 | — |
| Sisa ID lama K01–K09 (peringatan) | 0 | — |
| FR tanpa user story utama (disengaja) | 2 | FR-M6-08, FR-M11-11 |

## A.8 Matriks balik: user story → ID BRD

Dipakai untuk menilai dampak permintaan perubahan (Bab 11.7).

| User story | Prioritas | FR | BR | NFR | Epik | KPI |
|---|---|---|---|---|---|---|
| US-M1-01 | M | FR-M1-01, FR-M2-08 | BR-01, BR-02, BR-04, BR-05, BR-06, BR-16, BR-18 | — | — | — |
| US-M1-02 | M | FR-M1-02 | BR-15, BR-19, BR-33 | — | — | — |
| US-M1-03 | M | FR-M1-03, FR-M12-06 | — | — | — | — |
| US-M1-04 | M | FR-M1-03, FR-M1-04 | BR-37 | — | — | — |
| US-M1-05 | M | FR-M1-05, FR-M12-07 | BR-19 | NFR-24 | — | — |
| US-M1-06 | M | FR-M1-06 | BR-01 | NFR-34 | — | — |
| US-M2-01 | M | FR-M2-01, FR-M2-05 | BR-01, BR-19, BR-20 | — | — | — |
| US-M2-02 | M | FR-M2-02 | BR-38 | NFR-23 | — | KPI-05 |
| US-M2-03 | M | FR-M12-01, FR-M2-03 | BR-10, BR-21 | — | — | — |
| US-M2-04 | M | FR-M2-04 | — | — | — | KPI-06 |
| US-M2-05 | M | FR-M2-05 | BR-03, BR-04, BR-06 | — | — | — |
| US-M2-06 | S | FR-M2-06 | BR-21 | — | — | — |
| US-M2-07 | S | FR-M2-07 | — | NFR-20 | — | — |
| US-M2-08 | M | FR-M2-08 | — | — | — | — |
| US-M2-09 | M | FR-M2-09 | BR-24 | — | — | — |
| US-M2-10 | S | FR-M2-10 | — | — | — | KPI-07 |
| US-M2-11 | M | FR-M2-10, FR-M3-09 | BR-10, BR-36 | — | — | — |
| US-M3-01 | M | FR-M2-08, FR-M3-01, FR-M3-09 | BR-10, BR-19 | NFR-15, NFR-18 | — | — |
| US-M3-02 | M | FR-M12-05, FR-M12-06, FR-M12-08, FR-M3-02 | BR-23 | NFR-17 | — | — |
| US-M3-03 | M | FR-M12-03, FR-M3-03, FR-M3-07, FR-M6-05 | BR-22, BR-23, BR-38 | — | — | — |
| US-M3-04 | M | FR-M3-04, FR-M3-05 | BR-06, BR-19 | — | — | — |
| US-M3-05 | M | FR-M5-03 | BR-07 | — | — | — |
| US-M3-06 | M (rit gagal; keterangan BR-25) / S (kendala) | FR-M12-04, FR-M2-09, FR-M3-10 | BR-24, BR-25 | — | — | — |
| US-M3-07 | M | FR-M3-05, FR-M4-02, FR-M4-07 | BR-08, BR-10 | — | — | — |
| US-M3-08 | S | FR-M11-02, FR-M12-07, FR-M3-08 | — | — | — | — |
| US-M3-09 | M | FR-M3-06 | — | NFR-06, NFR-07, NFR-08, NFR-10 | — | KPI-01 |
| US-M3-10 | M | FR-M10-05, FR-M3-07, FR-M3-09 | BR-36, BR-37 | NFR-09, NFR-10, NFR-16, NFR-17 | — | — |
| US-M4-01 | M | FR-M4-01 | BR-08 | NFR-23 | — | — |
| US-M4-02 | M | FR-M4-02, FR-M4-03 | BR-08, BR-09, BR-10, BR-12 | — | — | — |
| US-M4-03 | M | FR-M4-03, FR-M4-07 | BR-09, BR-11, BR-12 | — | — | KPI-03 |
| US-M4-04 | M (pencocokan manual) / S (impor berkas) | FR-M11-06, FR-M4-04 | — | NFR-22 | — | — |
| US-M4-05 | M (setor ke bank [USULAN]) / S (kas kecil) | FR-M11-02, FR-M11-06, FR-M4-05 | BR-38 | — | — | — |
| US-M4-06 | M | FR-M4-06, FR-M9-01 | BR-10, BR-14, BR-38 | NFR-04 | — | KPI-02, KPI-08 |
| US-M5-01 | M | FR-M5-01, FR-M5-02 | BR-02, BR-05, BR-06, BR-29, BR-38 | — | — | — |
| US-M5-02 | M | FR-M5-03 | BR-07, BR-38 | — | — | — |
| US-M5-03 | M | FR-M5-06 | BR-01, BR-03 | — | — | KPI-04 |
| US-M5-04 | M | FR-M5-04 | BR-39 | — | — | KPI-04 |
| US-M5-05 | S | FR-M5-05 | — | NFR-20 | — | — |
| US-M5-06 | M | FR-M5-07 | BR-05 | — | — | — |
| US-M5-07 | M | FR-M11-09 | — | NFR-34 | — | — |
| US-M6-01 | M | FR-M6-01, FR-M6-08 | BR-15 | NFR-03, NFR-25 | — | — |
| US-M6-02 | M | FR-M6-02, FR-M6-04 | BR-08, BR-38 | — | — | — |
| US-M6-03 | M | FR-M6-03 | BR-13, BR-38 | — | — | — |
| US-M6-04 | M (PTB-07 disetujui) | FR-M6-04 | BR-27 | — | — | — |
| US-M6-05 | M | FR-M6-05 | BR-33 | — | — | — |
| US-M6-06 | M | FR-M6-06 | — | NFR-06, NFR-07, NFR-08 | — | — |
| US-M6-07 | M | FR-M6-07 | — | NFR-30 | — | — |
| US-M7-01 | M | FR-M7-01 | BR-13, BR-15, BR-17, BR-18, BR-28 | — | — | — |
| US-M7-02 | M | FR-M7-02 | BR-15, BR-28, BR-38 | NFR-34 | — | — |
| US-M7-03 | M | FR-M7-02 | — | — | — | — |
| US-M7-04 | M | FR-M7-03 | BR-04, BR-06, BR-18 | — | — | — |
| US-M7-05 | M | FR-M7-04 | BR-27 | — | — | — |
| US-M7-06 | M (tambahan, PTB-37 disetujui; tukar CR-14, Bab 2.4) | FR-M6-04, FR-M7-02 | BR-33 | — | — | — |
| US-M7-07 | S, dijadwalkan RL-6 (kompensasi, Bab 2.4) | FR-M7-05 | — | — | — | — |
| US-M7-08 | S | FR-M11-07, FR-M7-06 | — | — | — | — |
| US-M7-09 | M | FR-M4-01 | BR-08 | — | — | — |
| US-M8-01 | M | FR-M8-01 | BR-38 | — | — | — |
| US-M8-02 | M | FR-M12-05, FR-M8-02 | BR-38 | — | — | — |
| US-M8-03 | M | FR-M6-05, FR-M8-02 | BR-33 | — | — | — |
| US-M8-04 | M | FR-M8-03 | BR-26 | — | — | — |
| US-M8-05 | S | FR-M8-04 | — | — | — | — |
| US-M8-06 | S | FR-M8-05 | — | — | EP-3-05 | — |
| US-M8-07 | M | — | — | NFR-06, NFR-07, NFR-08, NFR-15, NFR-16, NFR-17, NFR-18 | — | — |
| US-M9-01 | M | FR-M9-01 | BR-33 | NFR-03, NFR-04, NFR-19 | — | KPI-04, KPI-08 |
| US-M9-02 | M | FR-M9-02 | BR-32, BR-33 | — | — | KPI-09 |
| US-M9-03 | M | FR-M9-03 | BR-39 | NFR-23 | — | — |
| US-M9-04 | S (kotak masuk) / M (infrastruktur notifikasi) | FR-M9-04 | — | — | — | KPI-03 |
| US-M9-05 | S | FR-M9-05 | BR-12, BR-25 | — | — | KPI-07 |
| US-M9-06 | S, dijadwalkan RL-6 (kompensasi, Bab 2.4) | FR-M9-06 | — | — | — | — |
| US-M9-07 | S [USULAN, PTB-30], dibangun di RL-6 | — | — | — | — | KPI-01, KPI-02, KPI-03, KPI-04, KPI-05, KPI-06, KPI-07, KPI-08, KPI-09, KPI-10, KPI-11 |
| US-M10-01 | M | FR-M10-01 | BR-36, BR-37 | NFR-09, NFR-12, NFR-30, NFR-34 | — | KPI-11 |
| US-M10-02 | M (PTB-06 disetujui) | FR-M10-05 | BR-36, BR-37 | NFR-09, NFR-10 | — | — |
| US-M10-03 | M | FR-M10-03 | — | — | — | — |
| US-M10-04 | M | FR-M10-03, FR-M10-04, FR-M2-05 | BR-01, BR-03, BR-09, BR-13, BR-15, BR-16, BR-17, BR-27, BR-32, BR-35, BR-38 | — | — | — |
| US-M10-05 | M | FR-M10-02 | BR-31, BR-38, BR-39 | NFR-11 | — | — |
| US-M10-06 | M (NFR-14 S) | — | BR-31, BR-39 | NFR-12, NFR-13, NFR-14, NFR-30 | — | — |
| US-M10-07 | M | FR-M12-08 | — | NFR-08, NFR-28, NFR-31, NFR-32 | — | — |
| US-M11-01 | M | FR-M11-01 | BR-33 | — | — | — |
| US-M11-02 | M | FR-M11-02, FR-M11-10 | BR-38 | — | — | — |
| US-M11-03 | M | FR-M11-03 | BR-35, BR-38 | — | — | — |
| US-M11-04 | M | FR-M11-04, FR-M9-02 | — | — | — | — |
| US-M11-05 | M | FR-M11-05 | BR-34 | NFR-34 | — | — |
| US-M11-06 | M | FR-M11-06, FR-M4-04 | — | — | — | — |
| US-M11-07 | S | FR-M11-07, FR-M7-06 | — | — | — | — |
| US-M11-08 | M | FR-M11-08, FR-M11-12 | BR-29, BR-30, BR-31 | NFR-13, NFR-23 | — | — |
| US-M11-09 | M | FR-M11-09 | — | NFR-34, NFR-36 | — | — |
| US-M11-10 | M | FR-M11-10 | BR-32 | — | — | — |
| US-M12-01 | M | FR-M12-01, FR-M12-06 | — | NFR-21 | — | — |
| US-M12-02 | M | FR-M12-01, FR-M2-03 | — | NFR-19, NFR-24 | — | — |
| US-M12-03 | M | FR-M12-02 | — | — | — | KPI-07 |
| US-M12-04 | M | FR-M12-03 | BR-23 | — | — | — |
| US-M12-05 | M | FR-M12-04 | BR-25 | — | — | — |
| US-M12-06 | S | FR-M12-05, FR-M6-05, FR-M8-02 | — | — | — | — |
| US-M12-07 | S, dijadwalkan RL-6 (kompensasi, Bab 2.4) | FR-M11-02, FR-M12-07 | — | — | — | — |
| US-M12-08 | M (KP-1–2: deteksi, peringatan, aktivasi GPS ponsel — turunan NFR-28 dan FR-M12-06, CR-13) / S (KP-3–4) | FR-M12-06, FR-M12-08 | — | NFR-28 | — | — |
| US-P2-01 | M [USULAN] | — | BR-01 | — | EP-2-01 | — |
| US-P2-02 | M [USULAN] | — | BR-19, BR-20 | — | EP-2-02 | KPI-06 |
| US-P2-03 | M [USULAN] | — | — | NFR-20, NFR-24 | EP-2-03 | — |
| US-P2-04 | M (riwayat, struk, tagihan) / S (pembayaran digital) [USULAN] | — | BR-39 | — | EP-2-04 | — |
| US-P2-05 | S [USULAN] | FR-M2-08 | — | — | EP-2-05 | — |
| US-P2-06 | S [USULAN] | — | — | — | EP-2-06 | — |
| US-P2-07 | C [USULAN; BRD: "bisa ditunda"] | FR-M6-08 | — | — | EP-2-07 | — |
| US-P2-08 | M [USULAN, PTB-60] | — | — | NFR-20, NFR-29 | — | — |
| US-P3-01 | M (kontrak, onboarding) / S (pipeline, survei) [USULAN] | — | BR-18 | — | EP-3-01 | — |
| US-P3-02 | M [USULAN] | — | — | NFR-30 | EP-3-02 | — |
| US-P3-03 | M [USULAN] | — | BR-18 | — | EP-3-03 | — |
| US-P3-04 | M [USULAN] | — | BR-05 | — | EP-3-04 | — |
| US-P3-05 | M (hasil uji, audit) / S (daftar periksa harian) [USULAN] | — | — | — | EP-3-05 | — |
| US-P3-06 | M (neraca air, tagihan) / S (skor, portofolio) [USULAN] | — | — | — | EP-3-06 | — |
| US-P3-07 | M [USULAN, PTB-59] | — | — | — | — | — |
| US-P3-08 | M (Fase 1) | FR-M6-05, FR-M6-07 | BR-18 | NFR-30 | EP-3-02, EP-3-06 | — |
| US-P3-09 | M (Fase 1) | FR-M5-01 | BR-05, BR-38 | — | EP-3-04 | — |
| US-P3-10 | M (Fase 1) | FR-M10-01 | — | NFR-30 | EP-3-06 | — |
| US-P3-11 | S (Fase 1) | — | BR-18 | — | — | — |

# Lampiran B — Parameter yang Dapat Dikonfigurasi

Nilai bawaan berasal dari BRD; perubahan hanya oleh pemilik melalui master, berjejak audit, dengan tanggal berlaku. Nilai "(usulan)" di BRD tetap berstatus usulan di sini.

| ID | Parameter | Nilai bawaan | Satuan / lingkup | Rujukan |
|---|---|---|---|---|
| PAR-01 | Ambang selisih setoran → notifikasi pemilik | 50.000 | Rp per sopir/outlet per hari; evaluasi 3 bulan | BR-09, K12 |
| PAR-02 | Kas maksimal di outlet depot | 2.000.000 | Rp | BR-08, K21 |
| PAR-03 | Void per hari per outlet → notifikasi | 3 | kejadian | BR-13 |
| PAR-04 | Void yang perlu persetujuan | > 100.000 | Rp | BR-13 |
| PAR-05 | Batas pesanan H+0 | 15.00 | WIB | BR-20 |
| PAR-06 | Batas tutup kas harian | 22.00 | WIB | BR-14, K21 |
| PAR-07 | Jam layanan | 05.00–22.00 | WIB, setiap hari | NFR-01 |
| PAR-08 | Tempo standar | 14 | hari sejak pengiriman | BR-02 |
| PAR-09 | Toleransi lewat tempo sebelum Ditahan | 7 | hari | BR-03 |
| PAR-10 | Batas kredit per segmen | Rumah tangga: tunai; depot pihak ketiga dan perumahan: 3.000.000; industri, proyek, hotel, kolam renang: 10.000.000 | Rp | BR-04, K16 |
| PAR-11 | Syarat pemberian Tempo (lama/volume) | ≥ 3 bulan sejak pesanan Selesai pertama atau ≥ 10 pesanan Selesai; ditambah PAR-82 | — | BR-01 |
| PAR-12 | Faktur bulanan: tanggal terbit / jatuh tempo | Layanan bulan M: terbit tanggal 1 bulan M+1 / jatuh tempo tanggal 15 bulan M+1 | tanggal (usulan BRD; PTB-26, CR-07) | BR-05 |
| PAR-13 | Pengingat piutang | H-3, H+1 | hari | FR-M5-05 |
| PAR-14 | Diskon kasir toko tanpa persetujuan | 5 | % | BR-17 |
| PAR-15 | Volume standar rit | 5.000 | L | BR-22 |
| PAR-16 | Penyimpangan lokasi Selesai: wajib alasan / tinjauan pemilik | > 200 / > 1.000 | m | BR-23 |
| PAR-17 | Rit gagal berturut → konfirmasi ulang | 2 | kejadian | BR-24 |
| PAR-18 | Susut air maksimal | 5 | % per sumber per hari | BR-26 |
| PAR-19 | Peringatan utilisasi sumber (penanda harian di dashboard) | > 90 | % | FR-M8-04, P-04 langkah 5 |
| PAR-20 | Jurnal manual yang perlu persetujuan sebelum posting | > 5.000.000 (≤ 5.000.000: tinjauan wajib pemilik saat tutup buku) | Rp | BR-35, PTB-12 |
| PAR-21 | Koreksi yang perlu persetujuan | > 500.000 | Rp | BR-38 |
| PAR-22 | Batas omzet PKP dan peringatan | 4.800.000.000; 80% dan 90% | Rp, 12 bulan berjalan | BR-29 |
| PAR-23 | Tutup buku paling lambat | tanggal 10 | bulan berikutnya | BR-32 |
| PAR-24 | Tinjauan harga khusus | 6 | bulan | BR-16 |
| PAR-25 | Perangkat GPS mati → peringatan | 15 | menit, pada jam layanan | FR-M12-08 |
| PAR-26 | Pembaruan posisi GPS | ≤ 1 | menit | FR-M12-01 |
| PAR-27 | Setoran depot dianggap terlambat | > 1 | hari sejak tutup shift | P-02 |
| PAR-28 | Periode paralel nota kertas | ≤ 2 | minggu per unit | NFR-35 |
| PAR-29 | Retensi: akuntansi / foto / log akses | 10 / 2 (usulan) / 1 | tahun | BR-31, BRD 10.6 |
| PAR-30 | Offline: antrean minimal / sinkron | 1 hari / ≤ 5 menit | — | NFR-06, NFR-07 |
| PAR-31 | Kuota data per sopir | ≤ 50 | MB/bulan | NFR-17 |
| PAR-32 | Stok opname | depot mingguan; toko bulanan | — | BR-27 |
| PAR-33 | Kapasitas rit per truk per hari (papan jadwal dan slot Tahap 2) | 3, dapat diatur per truk; dikalibrasi dari baseline KPI-07 sebelum Tahap 2 | rit (pelanggan + internal) | FR-M2-10, PTB-01 [USULAN] |
| PAR-34 | Pembuatan otomatis pesanan langganan | H-2 | hari sebelum tanggal kirim | US-M2-06 [USULAN] |
| PAR-35 | Kemitraan (Tahap 3): langganan sistem / royalti / radius eksklusif / diskon air Opsi A | 150.000 per outlet per bulan / 3–5% / 1 km (B), 1–2 km (A) / 5–10% | — | BRD 9.6, K18 |
| PAR-36 | PIN salah berturut → kunci sementara | 5 kali / 15 menit | — | US-M3-10 [USULAN] |
| PAR-37 | Kunci layar aplikasi lapangan saat tidak aktif | 10 | menit | US-M3-10 [USULAN] |
| PAR-38 | Ukuran foto setelah kompresi di perangkat | ≤ 300 | KB per foto | US-M3-03 [USULAN] |
| PAR-39 | Transfer tanpa mutasi → "Tidak ditemukan" | > 2 | hari | US-M4-04 [USULAN] |
| PAR-40 | Ringkasan umur piutang mingguan ke pemilik | Senin pagi | — | US-M5-04 [USULAN] |
| PAR-41 | Masa transisi penundaan penahanan kredit | ≤ 2 | bulan sejak go-live (R07) | US-M5-03 [USULAN] |
| PAR-42 | Selisih jam perangkat vs server yang ditandai | > 10 | menit | Bab 6.4 [USULAN] |
| PAR-43 | Kas kecil: pengisian/pengeluaran yang perlu persetujuan pemilik | > 500.000 | Rp | US-M4-05 [USULAN] |
| PAR-44 | Setoran sopir belum diajukan setelah rit terakhir Selesai | > 1 | jam | US-M4-01 [USULAN] |
| PAR-45 | Faktur bersengketa: penundaan pengingat/penahanan | ≤ 7 | hari | 7.5.6 [USULAN] |
| PAR-46 | Sesi web kantor: kedaluwarsa tidak aktif / maksimal | 30 menit / 12 jam | — | US-M10-02 [USULAN] |
| PAR-47 | Tinjauan hak akses oleh pemilik | tiap kuartal | — | US-M10-01, R09 |
| PAR-48 | Posisi truk dianggap basi di peta | > 5 | menit | US-M12-02 [USULAN] |
| PAR-49 | Titik berhenti pada riwayat perjalanan | ≥ 5 | menit tanpa gerak | US-M12-03 [USULAN] |
| PAR-50 | Perjalanan di luar jadwal: ambang gerak tanpa rit aktif | > 500 m atau > 10 menit | — | US-M12-05 [USULAN] |
| PAR-51 | Berhenti tidak dikenal saat rit aktif | > 15 | menit di luar lokasi sah | US-M12-05 [USULAN] |
| PAR-52 | Retensi posisi GPS mentah | 12 | bulan | PTB-33 [USULAN] |
| PAR-53 | Konsumsi BBM standar (L/km) dan harga BBM per liter untuk estimasi biaya rit | ditetapkan pemilik (tidak ada bawaan di BRD) | — | US-M12-07 |
| PAR-54 | Radius geofence sumber air / depot / pool | 100 | m | US-M12-06 [USULAN] |
| PAR-55 | Ringkasan e-mail harian ke pemilik | 22.30 (setelah tutup kas) | WIB | US-M9-04, PTB-05 |
| PAR-56 | Jam tenang notifikasi non-kritis | 22.00–05.00 | WIB | US-M9-04 [USULAN] |
| PAR-57 | Kas awal tetap per outlet depot/toko | 200.000 | Rp | US-M6-02, PTB-40 [USULAN] |
| PAR-58 | Toleransi selisih stok harian bahan habis pakai depot sebelum alasan wajib | 0 selama pilot (P-02 langkah 5); dapat dinaikkan pemilik setelah ada data pilot | buah per bahan | US-M6-04 [USULAN] |
| PAR-59 | Toleransi neraca air outlet depot (mingguan) | 5 | % | US-M6-05 [USULAN] |
| PAR-60 | Batas waktu void pada shift | hanya shift yang masih terbuka | — | US-M6-03 |
| PAR-61 | Batas konfirmasi penerimaan pasokan depot oleh operator | sampai tutup shift berikutnya | — | US-M6-05 [USULAN] |
| PAR-62 | Penyesuaian saldo awal diizinkan | ≤ 3 | bulan setelah cut-over | PTB-44 [USULAN] |
| PAR-63 | Metode penyusutan dan umur ekonomis | garis lurus; umur ditetapkan akuntan | — | BR-34, US-M11-05 |
| PAR-64 | Tarif PPh final UMKM (bila skema dipilih konsultan) | 0,5 | % omzet bruto | BR-30 |
| PAR-65 | Kunci alokasi biaya L1 ke L2/L3 | proporsi volume pengisian bulanan | — | PTB-39 |
| PAR-66 | Barang toko "mati" | ≥ 90 | hari tanpa penjualan | US-M7-07 [USULAN] |
| PAR-67 | Jatuh tempo utang pemasok bila nota tidak menyebut | 30 | hari | US-M7-08 [USULAN] |
| PAR-68 | Produksi harian menyimpang dari rata-rata 7 hari → verifikasi | > 20 | % | US-M8-01 [USULAN] |
| PAR-69 | Toleransi selisih pasokan depot (diisi vs diterima) | 2 | % | US-M8-03 [USULAN] |
| PAR-70 | Frekuensi uji laboratorium mutu air | ditetapkan pemilik/konsultan (tidak ada bawaan di BRD) | — | US-M8-06 |
| PAR-71 | Pengingat tutup periode | tanggal 5 dan 8 | bulan berikutnya | US-M11-10 [USULAN] |
| PAR-72 | Batas pembatalan pesanan mandiri oleh pelanggan (Tahap 2) | sampai rit Berangkat | — | US-P2-02 [USULAN] |
| PAR-73 | Slot pengiriman Tahap 2 | pagi 06.00–10.00; siang 10.00–14.00; sore 14.00–18.00 | WIB | PTB-51 [USULAN] |
| PAR-74 | OTP WhatsApp | 6 digit; berlaku 5 menit; 3 percobaan | — | US-P2-01 [USULAN] |
| PAR-75 | Tenggat konfirmasi pesanan aplikasi dan tanggapan keluhan | ≤ 2 jam (konfirmasi); ≤ 24 jam (keluhan) | jam layanan | US-P2-02, US-P2-06 [USULAN] |
| PAR-76 | SLA kepada mitra: pengiriman air / dukungan teknis | ≤ 24 jam / ≤ 48 jam | dari pesanan / permintaan | BRD 9.8 |
| PAR-77 | Evaluasi mitra | tiap 3 bulan | — | BRD 9.4 |
| PAR-78 | Jangka kontrak mitra | B: 2 tahun; A: 5 tahun | — | BRD 9.6 |
| PAR-79 | Toleransi neraca air mitra (galon terjual × 19 L vs air dibeli EQUA) | 10 | % per bulan | US-P3-06 [USULAN] |
| PAR-80 | Skor mutu minimum sebelum teguran | 80 | % | US-P3-05 [USULAN] |
| PAR-81 | Mitra maksimal Fase 1 sampai kapasitas bertambah | 5 | mitra | BRD 9.2, K22 |
| PAR-82 | Syarat "tanpa masalah" untuk pemberian Tempo (dalam periode PAR-11) | 0 kurang bayar lewat 7 hari; 0 transfer "Tidak ditemukan"; 0 sengketa ditolak; ≤ 1 rit gagal karena pelanggan menolak | — | BR-01, US-M1-01 [USULAN] |
| PAR-83 | Kunci rit karena selisih kurang besar yang belum diputuskan pemilik | Nonaktif (bila diaktifkan: ≥ 500.000) | Rp | US-M4-02, PTB-62 [USULAN] |
| PAR-84 | Tarik nota kertas unit perluasan sebelum atau pada hari ke-14 | 5 hari operasi terakhir: 100% tercatat di sumber dan 0 selisih tak terjelaskan | hari | NFR-35, 11.5 [USULAN] |
| PAR-85 | Notifikasi push utilisasi sumber | > PAR-19 selama 3 hari berturut | hari | US-M8-05 [USULAN] |
| PAR-86 | Jendela pemeliharaan sistem | 23.30–04.30 | WIB | NFR-01, NFR-32 [USULAN] |
| PAR-87 | Tenggat jawaban masukan lapangan | ≤ 1 | minggu | BRD 12.5, US-M10-07 |
| PAR-88 | Perpanjangan periode paralel (pengecualian keputusan komite pengarah) | ≤ 1 | minggu per unit | NFR-35, 11.5 (CR-17) |
| PAR-89 | Setoran tertunda yang diizinkan saat tutup kas (per kejadian, persetujuan pemilik) | ≤ 1 | hari | FR-M4-06, PTB-21 (CR-06) |

# Lampiran C — Glosarium Tambahan

Melengkapi Lampiran A BRD. Hanya memuat istilah yang lahir atau dipertegas di PRD.

| Istilah | Arti dalam PRD |
|---|---|
| User story (US) | Satu kebutuhan produk dari sudut pandang satu peran: "Sebagai …, saya ingin …, agar …", dengan kriteria penerimaan bernomor |
| Kriteria penerimaan (KP) | Pernyataan yang dapat dijawab lulus/gagal pada UAT; disebut dengan nomor di dalam user story-nya (misalnya US-M3-04 KP-2) |
| PTB | Pertanyaan terbuka di Bab 13 (v1.0: PT); berkelas A/B/C — hanya kelas C berlaku sebagai bawaan |
| PAR | Parameter yang dapat dikonfigurasi pemilik (Lampiran B) tanpa perubahan kode |
| Tanggal bisnis | Tanggal kalender WIB saat transaksi dicatat di perangkat, bukan saat tersinkron (Bab 5.3) |
| Hari kas | Satu hari operasional kas yang ditutup Admin Keuangan paling lambat 22.00 |
| Kas seharusnya | Jumlah uang yang menurut sistem ada di tangan seseorang atau di suatu outlet (Bab 6.1) |
| Kas di tangan | Kas seharusnya milik seorang sopir sebelum disetor |
| Kas awal tetap | Uang kembalian tetap di outlet yang tidak ikut disetor (PTB-40) |
| Setoran | Penyerahan kas seharusnya kepada Admin Keuangan, fisik atau lewat setor bank (PTB-23) |
| Selisih | Perbedaan antara kas/stok seharusnya dan kenyataan, selalu dihitung sistem |
| Transfer belum dicocokkan | Pembayaran transfer/QRIS yang sudah dicatat tetapi belum dipasangkan dengan mutasi bank |
| Kurang bayar lapangan | Sisa harga rit yang tidak dibayar tunai di lokasi, menjadi faktur jatuh tempo H+0 dan ditagih pada pengiriman berikutnya (PTB-18) |
| Rit internal | Rit truk yang memasok air ke depot sendiri, dinilai dengan harga transfer (PTB-01, BR-33) |
| Pengemudi pengganti | Kernet (atau sopir lain) yang ditetapkan Dispatcher untuk mengemudikan truk pada tanggal tertentu (US-M2-11, PTB-10) |
| Faktur kirim | Faktur per rit tempo untuk pelanggan tempo biasa (PTB-24) |
| Faktur bulanan | Satu faktur gabungan untuk pelanggan berperjanjian tagihan bulanan (BR-05, PTB-26) |
| Eksposur kredit | Piutang belum lunas + pesanan tempo belum dikirim + transaksi yang sedang diajukan (BR-06), satu batas lintas lini (PTB-25) |
| Uang muka pelanggan | Kelebihan pembayaran yang dialokasikan ke faktur berikutnya |
| Resep bahan | Jumlah bahan habis pakai yang seharusnya terpakai per produk depot (US-M6-04) |
| Neraca air outlet | Perbandingan galon terjual × 19 L dengan air yang diterima outlet (US-M6-05; BRD 9.9) |
| Lokasi sah | Sumber air, depot, dan pool/garasi truk yang dikecualikan dari deteksi perjalanan di luar jadwal (PTB-34) |
| Berhenti tidak dikenal | Truk berhenti > 15 menit di luar lokasi sah selama rit aktif (US-M12-05) |
| Jurnal otomatis | Jurnal yang dibangkitkan sistem dari peristiwa operasional (7.11.4); tidak dapat diubah manual |
| Jurnal manual | Jurnal yang dibuat Admin Keuangan dengan lampiran; > Rp 5 juta memerlukan persetujuan pemilik sebelum posting, sisanya ditinjau pemilik saat tutup buku |
| Periode dikunci | Periode akuntansi yang ditutup Admin Keuangan dan dikunci pemilik; koreksi hanya di periode berikutnya |
| Pusat biaya bersama | Biaya kantor/IT yang tidak dialokasikan atau dialokasikan menurut kunci pemilik (US-M11-01 KP-5) |
| Alokasi L1 | Pembebanan biaya produksi air ke L2 dan L3 menurut volume pengisian (PTB-39) |
| Tenant / outlet | Satu pemilik usaha / satu depot atau toko di bawahnya (Bab 4.3) |
| Pembina wilayah | Peran EQUA yang menilai, membina, dan mengaudit mitra (Bab 9) |
| Parameter kontrak mitra | Fee awal, langganan, royalti, diskon air, radius, jangka — per mitra (Bab 9.4) |
| Skor mutu | Gabungan daftar periksa, audit, dan uji air per outlet mitra (US-P3-05) |
| Sanksi bertingkat | Teguran → penghentian pasokan sementara → pemutusan, selalu diputuskan pemilik (PTB-59) |
| Slot pengiriman | Rentang waktu pagi/siang/sore yang ditawarkan ke pelanggan aplikasi (PTB-51) |
| PWA | Aplikasi web yang dapat dipasang di ponsel tanpa toko aplikasi (PTB-49) |
| OTP | Kode sekali pakai lewat WhatsApp untuk verifikasi nomor (US-P2-01) |
| Dicatat kantor | Transaksi lapangan yang terpaksa dicatat Admin Keuangan (perangkat rusak); dihitung "tidak di sumber" pada KPI-01 (Bab 6.1) |
| Kelas PTB | A = mengubah BRD (lewat CR BRD); B = menambah perilaku di luar BRD (keputusan komite pengarah); C = merinci BRD (berlaku sebagai bawaan) — Bab 13 |
| CR BRD | Usulan perubahan BRD v1.1 yang lahir dari PRD (Lampiran D) |
| Keputusan langsung pemilik | Tindakan yang kewenangan akhirnya ada pada pemilik dan diinput pemilik sendiri; tanpa langkah persetujuan, berjejak, diberitahukan (6.2b) |
| Pengesampingan beralasan | Tindakan pelaku yang melewati aturan bawaan dengan alasan wajib dan ditinjau setelahnya (6.2c) |
| Tempo migrasi | Status Tempo pelanggan lama yang dibawa saat cut-over dan disahkan dalam tanda tangan data awal; satu-satunya pengecualian syarat BR-01 (US-M1-06 KP-6) |
| Tagih kurang bayar | Penanda pada pesanan pelanggan yang masih punya faktur kurang bayar, agar sisanya ditagih sopir (PTB-18) |
| Paket Minimum Mitra Fase 1 | Empat user story yang memungkinkan Kemitraan Opsi B berjalan pada bulan 11–18 sebelum portal lengkap (9.10, RL-7) |
| Pemilik mitra | Peran baca-saja pemilik outlet mitra atas data tenant sendiri (US-P3-10) |
| Rilis (RL-n) | Paket produk dengan kriteria masuk dan keluar (Bab 11.1); v1.0 memakai R0–R6 |

# Lampiran D — Usulan Perubahan BRD v1.1 (CR)

BRD v1.0 belum ditandatangani. CR di bawah ini diputuskan pada satu sesi keputusan, lalu dimasukkan ke BRD v1.1 (riwayat versi BRD mencatat nomor CR yang sama) dan ditandatangani bersama PRD v1.1 (Bab 14). Status awal semua CR: **diusulkan (v1.1), menunggu keputusan pemilik dan komite pengarah**.

| CR | Sumber | Bagian BRD | Perubahan yang diusulkan | Jenis |
|---|---|---|---|---|
| CR-01 | PTB-06 (disetujui) | 6.10 FR-M10-05 | Prioritas S → M (konsistensi NFR-09 M dan K24) | Koreksi konsistensi |
| CR-02 | PTB-07 (disetujui) | 6.6 FR-M6-04 | Prioritas S → M (konsistensi BR-27; P-02 langkah 1 dan 5) | Koreksi konsistensi |
| CR-03 | PTB-08 | 8.2 BR-14 | Hapus "(usulan)"; batas tutup kas 22.00 sudah diputuskan K21 | Koreksi teks |
| CR-04 | PTB-12 | 6.11 FR-M11-03; 5.7 P-07 langkah 2 | Selaraskan dengan BR-35: jurnal manual > Rp 5 juta disetujui pemilik sebelum posting; ≤ Rp 5 juta ditinjau pemilik sebagai syarat tutup buku; semua wajib lampiran | Penyelarasan aturan |
| CR-05 | PTB-16 | 6.4 FR-M4-04 | Pecah: pencatatan dan pencocokan manual transfer (M, bagian FR-M11-06); impor berkas mutasi (S) | Prioritas parsial |
| CR-06 | PTB-21 | 6.4 FR-M4-06; 5.6 P-06 langkah 3 | Pengecualian: pemilik dapat mengizinkan tutup kas dengan setoran tertunda per kejadian, maks. 1 hari; rit sopir tetap terkunci; kas diterima ≤ 24 jam | Pengecualian aturan |
| CR-07 | PTB-26 | 8.1 BR-05 | Perjelas: layanan bulan M → faktur terbit tanggal 1 bulan M+1, jatuh tempo tanggal 15 bulan M+1 | Koreksi teks |
| CR-08 | PTB-29 | 7.5 NFR-20; 5.1 P-01 langkah 7 | Struk digital WA versi tautan menjadi M (skenario UAT BRD 12.6); otomatisasi lewat API tetap Tahap 2 | Prioritas parsial |
| CR-09 | PTB-39 (disetujui) | 6.11 FR-M11-01; 8.6 BR-33 | L1 diperlakukan sebagai pusat biaya yang dialokasikan ke L2/L3 menurut volume pengisian; ditambah laporan biaya produksi air per liter | Perubahan aturan |
| CR-10 | Tinjauan ketertelusuran | 2.3, 3.8, 12.2, 12.8, Lampiran B, dan semua rujukan | Ganti ID: KPI K01–K11 → KPI-01–KPI-11; tonggak T0–T9 → TG-0–TG-9 | Penamaan |
| CR-11 | PTB-01 | 1.2 | Jelaskan bahwa 14 rit/hari (±420/bulan) adalah rit pelanggan; total perjalanan truk ±18 rit/hari termasuk ±4 rit pasokan depot | Koreksi data |
| CR-12 | Tinjauan BR-01 | 8.1 BR-01, BR-04; 10.3 | Definisikan "tanpa masalah" (PAR-82); status "Tempo migrasi" untuk pelanggan tempo lama saat cut-over sebagai satu-satunya pengecualian; rumah tangga tunai tanpa pengecualian | Penjelasan aturan |
| CR-13 | Tinjauan dependensi M → S | 6.2 FR-M2-10; 6.9 FR-M9-04; 6.12 FR-M12-08 | Bagian M: penetapan pengemudi pengganti harian (FR-M2-10); infrastruktur notifikasi (FR-M9-04); deteksi perangkat mati, peringatan, dan aktivasi GPS ponsel (FR-M12-08) | Prioritas parsial |
| CR-14 | PTB-34, PTB-35, PTB-37 | 3.3; 6.7; 6.9; 6.12; 12.4 | Tambahan M (transfer bahan toko → depot, 2FA, master pool/garasi) dikompensasi dengan menjadwalkan FR-M7-05, FR-M9-06, FR-M12-07 (S) ke stabilisasi bulan 11–12; kesetaraan dikonfirmasi estimasi manajer proyek IT | Aturan tukar |
| CR-15 | PTB-61 | 3.5; 6.14; 9.4 | Paket Minimum Mitra Fase 1 dibangun untuk K17 (bulan 11–18) sebagai pengecualian "rincian Tahap 3 setelah Tahap 1 stabil" | Cakupan dan jadwal |
| CR-16 | Tinjauan perangkat | 10.5; 12.7 | Perangkat POS toko: tablet Android (bukan PC) agar satu basis kode POS | Perangkat |
| CR-17 | Tinjauan periode paralel | 7.8 NFR-35; 12.3 | Kriteria tarik nota kertas unit perluasan (PAR-84); perpanjangan hanya lewat keputusan komite pengarah, maks. 1 minggu (PAR-88) | Penjelasan aturan |
| CR-18 | Tinjauan kunci rit | 8.2 BR-09, BR-10 | Pertegas bahwa setoran "ditutup oleh Admin Keuangan" tidak menunggu keputusan pemilik atas selisih; keputusan selisih berjalan terpisah (≤ 24 jam); opsi PAR-83 (PTB-62) | Penjelasan aturan |

**Dampak jadwal.** CR-01 s.d. CR-13 dan CR-16 s.d. CR-18 berupa penyelarasan dokumen atau user story kecil; tidak menggeser TG-8 bila diputuskan dalam 2 minggu. CR-14 menjaga cakupan tetap setara lewat aturan tukar. CR-15 dibangun setelah go-live (RL-7).
