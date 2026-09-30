# Status implementasi EQUA ERP v1.0 — per user story, PTB, dan CR

Tanggal: 30 September 2026 · Rilis: **v1.0.0** · Baseline kebutuhan: `docs/prd/PRD_EQUA_v1_1.md` · Keputusan:
`docs/DECISIONS.md` (D-01 s.d. D-13).

Kolom **KP teruji** diambil dari `pnpm trace` (rincian per KP dan jumlah uji: [`docs/dev/traceability.md`](../dev/traceability.md)).
Kolom **Status** adalah status implementasi di rilis v1.0. Konsistensi dokumen ini dengan PRD dan hasil `pnpm trace`
dijaga uji `tests/tools/prd-status.test.ts` — bila uji itu gagal setelah PRD/uji berubah, jalankan `pnpm trace` lalu
perbarui tabel di bawah.

| Status | Arti |
|---|---|
| **Aktif** | Dibangun dan langsung dipakai saat go-live (Tahap 1, RL-6, RL-7). |
| **Aktif — flag** | Dibangun, dipakai saat go-live, tetapi sebagian perilakunya diatur *feature flag*/parameter yang dinyalakan pemilik (lihat Catatan). |
| **Di balik flag** | Dibangun dan teruji, tetapi **mati secara bawaan**; pemilik menyalakan lewat **Pengaturan › Parameter › Fitur bertahap** (global atau per tenant) setelah gerbang tahap terpenuhi (`docs/uat/gerbang-tahap.md`). |
| **Tidak dibangun** | Prioritas C yang tidak dibangun sesuai D-02. |

Singkatan catatan: **UAT** = butir yang hanya dapat dibuktikan di lapangan/UAT manual (daftar lengkap di
`docs/uat/<modul>.md` bagian "UAT manual"); **B-nn** = butir `docs/dev/backlog.md`; **RL-6** = S analitik stabilisasi
(CR-14); **PAR-nn** = parameter Lampiran B.

---

## 1. Ringkasan

| Modul | Story | Prioritas M/S/C | KP teruji | Status rilis |
|---|---:|---|---:|---|
| M1 — Master Data | 6 | 6/0/0 | 36/36 | Aktif |
| M2 — Pesanan & Penjadwalan Rit | 11 | 8/3/0 | 51/51 | Aktif |
| M3 — Aplikasi Sopir | 10 | 9/1/0 | 55/55 | Aktif |
| M4 — Kas & Setoran | 6 | 6/0/0 | 36/36 | Aktif (ganti rugi di balik flag) |
| M5 — Piutang & Penagihan | 7 | 6/1/0 | 32/32 | Aktif |
| M6 — Penjualan Depot (POS) | 7 | 7/0/0 | 42/42 | Aktif |
| M7 — Penjualan Toko & Stok | 9 | 7/2/0 | 37/37 | Aktif |
| M8 — Produksi & Stok Air | 7 | 5/2/0 | 29/29 | Aktif |
| M9 — Laporan & Dashboard Pemilik | 7 | 3/4/0 | 31/31 | Aktif |
| M10 — Pengguna, Hak Akses & Jejak Audit | 7 | 7/0/0 | 41/41 | Aktif (delegasi di balik flag) |
| M11 — Akuntansi & Pajak | 10 | 9/1/0 | 47/47 | Aktif — setelah **Aktifkan M11** (B-84) |
| M12 — Pelacakan Armada / GPS | 8 | 6/2/0 | 36/36 | Aktif |
| P2 — Tahap 2: Aplikasi Pelanggan | 8 | 5/2/1 | 30/32 | Di balik flag `phase2.customer_app`; US-P2-07 tidak dibangun |
| P3 — Kemitraan (RL-7 + Tahap 3) | 11 | 10/1/0 | 49/49 | RL-7 aktif; Tahap 3 di balik flag `phase3.partner_portal` |
| **Jumlah** | **114** | | **552/554** | |

- **Prioritas M:** 490/490 KP teruji (100%) · 94 story lengkap.
- **Semua prioritas:** 552/554 KP (99,6%) · 113 story lengkap, 1 belum (US-P2-07, kelas C, tidak dibangun sesuai D-02/PTB-53).
- Uji otomatis: 1.439 judul uji di 238 berkas (1.180 merujuk user story), ditambah skenario E2E P-01..P-07
  (`e2e/scenarios/`, `docs/qa/skenario-uji.md`).
- Kebutuhan C yang tidak dibangun (D-02): FR-M6-08, FR-M11-11, NFR-25 printer bluetooth (struk tetap dicetak lewat
  dialog cetak peramban), US-P2-07/EP-2-07.
- Kebutuhan yang **hanya dapat dibuktikan di UAT/pilot** (tidak dapat diotomasi): kecepatan di lapangan (B-14),
  kamera & keterbacaan layar di bawah matahari (B-19), satu hari penuh tanpa sinyal (NFR-06/07), perangkat GPS nyata
  (B-47), e-mail Resend dengan domain terverifikasi (B-77), tinjauan akuntan (B-57, B-76, B-84), uji penetrasi lintas
  tenant manual (B-74), pemantau uptime dengan secret nyata (B-85), uji pemulihan cadangan (NFR-13).

## 2. Feature flag & parameter yang menentukan perilaku rilis

| Flag / parameter | Bawaan | Diatur | Pengaruh |
|---|---|---|---|
| `phase2.customer_app` | mati | Pemilik — global / per tenant | Seluruh P2 (aplikasi `/app`, OTP, pembayaran digital, WA Cloud API ke pelanggan). Gerbang TG-9 (`docs/uat/gerbang-tahap.md`). |
| `phase3.partner_portal` | mati | Pemilik — global / per tenant | US-P3-01..07 (pendaftaran calon, kontrak & onboarding lengkap, pesanan portal, royalti Opsi A/B, mutu, dasbor, sanksi). RL-7 (US-P3-08..11) tidak memerlukan flag. |
| `accounting.m11_active` | hidup, tetapi jurnal otomatis hanya berjalan bila pemetaan wajib lengkap | Pemilik — tombol **Aktifkan M11** | Jurnal otomatis M11; peristiwa sebelum aktivasi dibangkitkan retroaktif (PTB-47). Ditekan setelah akuntan meninjau pemetaan (B-84, runbook cut-over). |
| `cash.restitution_active` | mati | Pemilik | Ganti rugi karyawan atas selisih Ditolak (BR-11, PTB-22) — dinyalakan setelah Peraturan Perusahaan berlaku. |
| `approvals.delegation` | mati | Pemilik | Pendelegasian persetujuan (PTB-32). |
| `partner.franchise_terms` | mati | Pemilik | Istilah "waralaba" di antarmuka; sebelum STPW terbit tampil "Mitra Depot EQUA" (PTB-57). |
| `fleet.offschedule_detection` | hidup | Pemilik / admin sistem — per truk | Deteksi perjalanan di luar jadwal (US-M12-05); dimatikan per truk sampai perangkat GPS aktif. |
| PAR-83 kunci rit selisih besar | nonaktif | Pemilik (parameter) | PTB-62 — bila diaktifkan, selisih kurang ≥ ambang yang belum diputuskan mengunci rit sopir. |
| PAR-86 jendela pemeliharaan | 23.30–04.30 WIB | Pemilik (parameter) | Rilis, migrasi, dan rotasi rahasia hanya di jendela ini (`docs/deploy/README.md`, NFR-32). |

## 3. Status per user story

### M1 — Master Data

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M1-01 | Mengelola pelanggan dan alamat kirim | M | 10/10 | Aktif | UAT B-14: cari pelanggan ≤ 1 detik pada data nyata. |
| US-M1-02 | Mengelola produk dan harga tiga lini | M | 6/6 | Aktif | Harga dikunci saat pesanan dibuat (PTB-13). |
| US-M1-03 | Mengelola armada, kru, dan perangkat | M | 4/4 | Aktif | Perangkat lapangan didaftarkan lewat kode aktivasi (M10). |
| US-M1-04 | Mengelola depot, sumber air, dan karyawan | M | 4/4 | Aktif | Master pool/garasi ditambahkan (PTB-34, CR-14). |
| US-M1-05 | Mengelola zona tarif dan pemetaan alamat | M | 6/6 | Aktif | Peta OSM + jarak garis lurus × 1,3 (D-10 butir 4); sumber terdekat sebagai acuan (PTB-02). |
| US-M1-06 | Mengimpor data awal dan membersihkan duplikat | M | 6/6 | Aktif | UAT: impor dengan data tersamar dulu (NFR-27); tanda tangan kelompok data sebelum TG-7 (NFR-34). |

### M2 — Pesanan & Penjadwalan Rit

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M2-01 | Membuat pesanan dalam kurang dari 60 detik | M | 8/8 | Aktif | UAT B-14: stopwatch < 60 detik. Pesanan internal pasokan depot (PTB-01); n tangki = n rit (PTB-09). |
| US-M2-02 | Nomor dan status pesanan | M | 4/4 | Aktif | Format nomor D-04 (PTB-14). |
| US-M2-03 | Papan jadwal rit harian | M | 7/7 | Aktif | Peta posisi truk tersemat dari M12. |
| US-M2-04 | Peringatan pesanan dobel | M | 3/3 | Aktif | |
| US-M2-05 | Kontrol kredit pada pesanan tempo | M | 6/6 | Aktif | Aturan kurang bayar & tagih kurang bayar (PTB-18). |
| US-M2-06 | Pesanan berulang / langganan | S | 4/4 | Aktif | |
| US-M2-07 | Konfirmasi pesanan ke pelanggan lewat WA | S | 3/3 | Aktif | Tautan `wa.me` semi-otomatis (Tahap 1); WhatsApp Cloud API hanya bila P2 aktif (PTB-60). |
| US-M2-08 | Riwayat dan catatan khusus pelanggan | M | 3/3 | Aktif | |
| US-M2-09 | Pembatalan, penjadwalan ulang, dan rit gagal | M | 4/4 | Aktif | |
| US-M2-10 | Jadwal kerja kru dan ketersediaan truk | S | 4/4 | Aktif | |
| US-M2-11 | Penetapan pengemudi pengganti harian | M | 5/5 | Aktif | Bagian M dari FR-M2-10 (CR-13); hak sopir kernet hanya saat ditetapkan (PTB-10). |

### M3 — Aplikasi Sopir

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M3-01 | Melihat daftar rit hari ini dan menuju lokasi | M | 7/7 | Aktif | PWA di ponsel Android perusahaan (D-01). |
| US-M3-02 | Mencatat Berangkat dan Tiba dengan waktu dan lokasi otomatis | M | 6/6 | Aktif | |
| US-M3-03 | Menyelesaikan rit dengan bukti kirim | M | 7/7 | Aktif | UAT B-19: kamera nyata, foto ≤ PAR-38 tetap terbaca. |
| US-M3-04 | Mencatat pembayaran per rit | M | 6/6 | Aktif | Struk WA versi tautan = M (PTB-29, CR-08); tunai → tempo lewat persetujuan Dispatcher (PTB-19). |
| US-M3-05 | Menerima pelunasan piutang saat pengiriman | M | 5/5 | Aktif | |
| US-M3-06 | Menandai rit gagal, melaporkan kendala, dan memberi keterangan perjalanan | M | 4/4 | Aktif | |
| US-M3-07 | Melihat kas di tangan dan menyetor akhir hari | M | 6/6 | Aktif — flag | Setor bank oleh sopir hanya dengan izin pemilik per orang (PTB-23); kunci rit PAR-83 nonaktif (PTB-62). |
| US-M3-08 | Mencatat pengeluaran rit | S | 3/3 | Aktif | Diverifikasi Admin Keuangan saat setoran (PTB-20). |
| US-M3-09 | Bekerja tanpa sinyal dan menyinkronkan otomatis | M | 5/5 | Aktif | UAT NFR-06/07: satu hari penuh tanpa sinyal & 50× putus-sambung. |
| US-M3-10 | Keamanan perangkat dan kesiapan lapangan | M | 6/6 | Aktif | PIN + perangkat terdaftar = M (PTB-06, CR-01); hapus jarak jauh = wipe pada kontak berikutnya (D-01). |

### M4 — Kas & Setoran

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M4-01 | Melihat posisi kas harian per sumber | M | 5/5 | Aktif | QRIS statis dipisah dari kas fisik (PTB-04). |
| US-M4-02 | Menerima setoran dan menghitung selisih | M | 10/10 | Aktif | Setoran ditutup tanpa menunggu keputusan selisih (CR-18). |
| US-M4-03 | Menindaklanjuti selisih dan mencatat ganti rugi | M | 6/6 | Aktif — flag | Ganti rugi di balik `cash.restitution_active` (PTB-22). |
| US-M4-04 | Mencatat dan mencocokkan transfer masuk | M | 5/5 | Aktif | Pencocokan manual = M, impor mutasi = S, keduanya dibangun (PTB-16, CR-05). UAT NFR-22: format mutasi bank nyata. |
| US-M4-05 | Kas kantor, setor ke bank, dan kas kecil | M | 3/3 | Aktif | Satu akun buku per rekening bank (B-79; validasi di runbook cut-over). |
| US-M4-06 | Menutup kas harian dan menerbitkan ringkasan H+0 | M | 7/7 | Aktif | Tutup kas ≤ 22.00 (PTB-08, CR-03); tutup dengan setoran tertunda per kejadian ≤ PAR-89 (PTB-21, CR-06). UAT NFR-04. |

### M5 — Piutang & Penagihan

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M5-01 | Piutang terbentuk otomatis dari pengiriman dan penjualan tempo | M | 6/6 | Aktif | Satu faktur per rit tempo (PTB-24); satu batas kredit lintas lini (PTB-25). |
| US-M5-02 | Mencatat pelunasan dan alokasinya | M | 5/5 | Aktif | Uang muka rit prabayar bertanda pesanan (B-81, D-12 butir 1). |
| US-M5-03 | Kontrol jatuh tempo dan status Ditahan | M | 6/6 | Aktif | Rit terjadwal saat Ditahan (PTB-27); hapus piutang lewat jurnal manual (PTB-28). |
| US-M5-04 | Laporan umur piutang dan kartu piutang | M | 4/4 | Aktif | UAT B-77: e-mail pernyataan lewat Resend dengan domain terverifikasi. |
| US-M5-05 | Pengingat jatuh tempo lewat WA | S | 3/3 | Aktif | Tautan WA (Tahap 1). |
| US-M5-06 | Faktur bulanan untuk pelanggan tagihan bulanan | M | 5/5 | Aktif | Terbit tgl 1 M+1, jatuh tempo tgl 15 M+1 (PTB-26, CR-07, PAR-12). UAT B-77 untuk e-mail faktur. |
| US-M5-07 | Saldo awal piutang saat cut-over | M | 3/3 | Aktif | Status "Tempo migrasi" (CR-12); lihat `docs/uat/cutover.md`. |

### M6 — Penjualan Depot (POS)

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M6-01 | Transaksi cepat di POS depot | M | 7/7 | Aktif | UAT B-14: ≤ 10 detik per transaksi. Tanpa diskon depot (PTB-48); printer bluetooth tidak dibangun (NFR-25, C). |
| US-M6-02 | Buka dan tutup shift dengan kas dan stok fisik; setoran outlet | M | 7/7 | Aktif | Kas awal tetap per outlet (PTB-40). |
| US-M6-03 | Void dengan alasan | M | 5/5 | Aktif | Void besar saat offline menunggu persetujuan (PTB-43). |
| US-M6-04 | Stok bahan habis pakai dan opname mingguan | M | 6/6 | Aktif | Dinaikkan ke M (PTB-07, CR-02). |
| US-M6-05 | Menerima pasokan air dan neraca air outlet | M | 6/6 | Aktif | |
| US-M6-06 | Bekerja tanpa sinyal | M | 5/5 | Aktif | UAT NFR-06: satu hari penuh tanpa sinyal di depot nyata. |
| US-M6-07 | Paket standar multi-tenant | M | 6/6 | Aktif | Isolasi tenant NFR-30 (FK komposit + uji isolasi). |

### M7 — Penjualan Toko & Stok

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M7-01 | POS toko dengan harga mitra dan umum | M | 6/6 | Aktif | Kasir hanya lewat POS (D-07). UAT: pindai barcode dengan kamera tablet, B-14 ≤ 30 detik untuk 5 barang. |
| US-M7-02 | Penerimaan barang dari pemasok dan kartu stok | M | 6/6 | Aktif | Harga pokok rata-rata bergerak (PTB-38). |
| US-M7-03 | Stok minimum dan daftar pesan ulang | M | 3/3 | Aktif | |
| US-M7-04 | Penjualan tempo untuk mitra terdaftar | M | 5/5 | Aktif | Tempo saat offline memakai eksposur sinkron terakhir (PTB-42). |
| US-M7-05 | Stok opname dan penyesuaian | M | 5/5 | Aktif | Retur: hari sama = void, setelahnya nota kredit (PTB-46). |
| US-M7-06 | Transfer internal bahan ke depot sendiri | M | 3/3 | Aktif | Harga mitra, dieliminasi pada konsolidasi (PTB-37, CR-14). |
| US-M7-07 | Laporan barang laris/mati dan margin per barang | S | 3/3 | Aktif | RL-6 (FR-M7-05, CR-14). |
| US-M7-08 | Utang pemasok dan jadwal pembayaran | S | 3/3 | Aktif | |
| US-M7-09 | Kas toko harian dan setoran | M | 3/3 | Aktif | |

### M8 — Produksi & Stok Air

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M8-01 | Mencatat produksi harian dari angka meter dengan foto | M | 5/5 | Aktif | UAT B-19: foto meter terbaca setelah kompresi. |
| US-M8-02 | Mencatat pengisian truk per rit | M | 6/6 | Aktif | |
| US-M8-03 | Pasokan air ke depot sendiri | M | 4/4 | Aktif | Harga transfer BR-33 (PTB-01). |
| US-M8-04 | Neraca air harian per sumber dan susut | M | 5/5 | Aktif | Rata-rata 7 hari & tandon sebagai informasi (PTB-41); penanda geofence (B-45) — UAT dengan truk GPS nyata. |
| US-M8-05 | Utilisasi kapasitas dan peringatan | S | 3/3 | Aktif | |
| US-M8-06 | Catatan mutu air | S | 3/3 | Aktif | |
| US-M8-07 | Bekerja tanpa sinyal di sumber air | M | 3/3 | Aktif | UAT NFR-06. |

### M9 — Laporan & Dashboard Pemilik

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M9-01 | Dashboard H+0 | M | 7/7 | Aktif | UAT NFR-04/KPI-08: 14 dari 14 hari H+0 ≤ 30 menit di pilot. |
| US-M9-02 | Laporan bulanan laba kotor per lini dan konsolidasi | M | 6/6 | Aktif | L1 pusat biaya + biaya per liter (PTB-39, CR-09); bergantung aktivasi M11. |
| US-M9-03 | Ekspor Excel/PDF | M | 4/4 | Aktif | UAT NFR-23: centang ekspor per laporan katalog 7.9.4. |
| US-M9-04 | Kotak masuk pengecualian dan pengaturan notifikasi pemilik | S | 4/4 | Aktif | Infrastruktur notifikasi = bagian M (CR-13); in-app + push + e-mail (PTB-05). |
| US-M9-05 | Kinerja per sopir/truk dan per depot/operator | S | 4/4 | Aktif | |
| US-M9-06 | Tren mingguan/bulanan | S | 3/3 | Aktif | RL-6 (FR-M9-06, CR-14). |
| US-M9-07 | Laporan KPI program (KPI-01–KPI-11) | S | 3/3 | Aktif | Halaman KPI dibangun (PTB-30, CR-10). |

### M10 — Pengguna, Hak Akses & Jejak Audit

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M10-01 | Peran, pengguna, dan lingkup akses | M | 8/8 | Aktif | Kombinasi peran terlarang tidak dapat diajukan (PTB-31); akuntan baca-saja (PTB-11). |
| US-M10-02 | Login, PIN, perangkat terdaftar, dan sesi | M | 7/7 | Aktif | 2FA TOTP wajib pemilik, Admin Keuangan, admin sistem (PTB-35); wajib ganti kata sandi pertama (B-08). |
| US-M10-03 | Pemisahan tugas dipaksakan | M | 4/4 | Aktif | Sistem menolak, bukan memperingatkan (FR-M10-03). |
| US-M10-04 | Alur persetujuan | M | 6/6 | Aktif — flag | Tanpa delegasi bawaan, `approvals.delegation` (PTB-32); lewat tenggat permintaan akses = `escalate` (D-08). |
| US-M10-05 | Jejak audit | M | 6/6 | Aktif | Append-only dijaga DB; PII pelanggan dianonimkan disamarkan kecuali untuk pemilik (D-09, B-09, RP-15). |
| US-M10-06 | Data pribadi, retensi, dan pencadangan | M | 6/6 | Aktif | UAT NFR-13: uji pemulihan cadangan sebelum go-live (runbook §4); anonimisasi (PTB-36); retensi GPS mentah 12 bulan (PTB-33). |
| US-M10-07 | Kesehatan perangkat, sinkron, dan pemantauan | M | 4/4 | Aktif | UAT B-85: secret repositori pemantau terisi, peringatan ≤ 5 menit (NFR-28). |

### M11 — Akuntansi & Pajak

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M11-01 | Bagan akun dan pusat laba | M | 5/5 | Aktif — flag | Jurnal otomatis aktif setelah **Aktifkan M11** (B-84, D-13 butir 3). |
| US-M11-02 | Jurnal otomatis dari seluruh transaksi operasional | M | 5/5 | Aktif — flag | Retroaktif sejak cut-over (PTB-47); UAT B-76 tinjauan akuntan alokasi L1 → L3 & eliminasi. |
| US-M11-03 | Jurnal manual dengan lampiran dan persetujuan | M | 6/6 | Aktif | > PAR-20 disetujui sebelum posting; ≤ PAR-20 masuk tinjauan wajib (PTB-12, CR-04). |
| US-M11-04 | Buku besar dan laporan keuangan | M | 5/5 | Aktif | Arus kas metode langsung (PTB-45); UAT B-57 tinjauan kategori arus kas. |
| US-M11-05 | Aset tetap dan penyusutan otomatis | M | 5/5 | Aktif | |
| US-M11-06 | Rekonsiliasi bank dan kas | M | 4/4 | Aktif | PTB-16, CR-05. |
| US-M11-07 | Utang usaha kepada pemasok | S | 3/3 | Aktif | |
| US-M11-08 | Pelaporan pajak PT non-PKP dan pemantauan batas PKP | M | 5/5 | Aktif | UAT NFR-23: konsultan pajak memvalidasi format ekspor. |
| US-M11-09 | Saldo awal dan cut-over akuntansi | M | 4/4 | Aktif | Penyesuaian saldo awal ≤ 3 bulan (PTB-44); transaksi sebelum cut-over ditolak (NFR-36, `EQ006`). |
| US-M11-10 | Tutup dan kunci periode | M | 5/5 | Aktif | Periode Ditutup/Dikunci dijaga DB (`EQ005`). |

### M12 — Pelacakan Armada / GPS

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-M12-01 | Menerima posisi dari perangkat GPS truk dan cadangan ponsel | M | 6/6 | Aktif | UAT B-47: satu unit perangkat GPS nyata (R05). |
| US-M12-02 | Peta posisi truk real-time | M | 5/5 | Aktif | Lapisan pool/garasi (PTB-34). |
| US-M12-03 | Riwayat perjalanan per rit dan per hari | M | 4/4 | Aktif | |
| US-M12-04 | Pencocokan lokasi Selesai dengan alamat pelanggan | M | 5/5 | Aktif | |
| US-M12-05 | Perjalanan di luar jadwal atau jam operasional | M | 5/5 | Aktif — flag | `fleet.offschedule_detection` per truk (mati sampai perangkat GPS aktif). |
| US-M12-06 | Geofence sumber air dan depot | S | 4/4 | Aktif | |
| US-M12-07 | Jarak per rit untuk biaya BBM dan pemeriksaan zona | S | 3/3 | Aktif | RL-6 (FR-M12-07, CR-14). |
| US-M12-08 | Peringatan perangkat mati atau dicabut | M | 4/4 | Aktif | Bagian M (CR-13); UAT B-47 skenario perangkat dicabut. |

### P2 — Tahap 2: Aplikasi Pelanggan (flag `phase2.customer_app`, bawaan mati)

Syarat aktivasi (TG-9, `docs/uat/gerbang-tahap.md`): antara lain pengaburan wajah foto bukti kirim (B-75, D-11 butir 3)
yang **belum dibangun** di v1.0, uji performa 4G (B-74), dan keputusan PTB-49..PTB-60 pada gerbang Tahap 2.

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-P2-01 | Mendaftar dengan verifikasi nomor WA dan menyimpan alamat | M | 5/5 | Di balik flag | PWA (PTB-49). |
| US-P2-02 | Memesan air truk dengan tanggal/slot dan harga transparan | M | 6/6 | Di balik flag | Tiga slot PAR-73 (PTB-51). UAT B-74: pemesanan ≤ 60 detik di 4G. |
| US-P2-03 | Memantau status dan posisi truk | M | 5/5 | Di balik flag | Posisi hanya saat rit Berangkat menuju pelanggan itu (PTB-54). |
| US-P2-04 | Riwayat, struk, tagihan, dan pembayaran digital | M | 5/5 | Di balik flag | Adaptor gerbang pembayaran, implementasi pertama Midtrans sandbox (PTB-50); prabayar diakui dari uang muka (D-11 butir 4). |
| US-P2-05 | Langganan berkala dan pengingat isi ulang | S | 3/3 | Di balik flag | |
| US-P2-06 | Penilaian layanan dan keluhan | S | 3/3 | Di balik flag | |
| US-P2-07 | Memesan galon antar dari depot terdekat | C | 0/2 | Tidak dibangun | D-02 butir 3, PTB-53 (bergantung FR-M6-08 C). |
| US-P2-08 | Kanal WhatsApp Business API dan notifikasi pelanggan | M | 3/3 | Di balik flag | Adaptor WhatsApp Cloud API; tautan tetap berfungsi bila API mati (PTB-60). |

### P3 — Kemitraan: RL-7 (aktif) + Tahap 3 (flag `phase3.partner_portal`, bawaan mati)

Model mitra dua outlet v1.0 (PRD 9.7, D-13 butir 1): satu tenant mitra, **satu kontrak per outlet** (pelanggan mitra,
batas kredit, dan faktur sendiri per outlet), wilayah eksklusif & langganan per outlet — diuji
`tests/p3-partner/two-outlets.test.ts`. Uji penetrasi lintas tenant manual wajib sebelum mitra pertama aktif (B-74).

| US | Judul | Prio | KP teruji | Status | Catatan |
|---|---|:-:|---:|---|---|
| US-P3-01 | Pendaftaran, penilaian lokasi, kontrak, dan onboarding mitra | M | 5/5 | Di balik flag | Flag per tenant (KP-5); istilah "Mitra Depot EQUA" (PTB-57). |
| US-P3-02 | POS depot standar dengan data terpisah per mitra | M | 5/5 | Di balik flag | Harga jual ditetapkan mitra, harga anjuran tampil (PTB-56). POS mitra dasar sudah tersedia lewat RL-7/M6-07. |
| US-P3-03 | Memesan air dan spare part ke EQUA dengan harga mitra dan tagihan | M | 5/5 | Di balik flag | Aksi portal bersyarat flag (D-11 butir 1); asal pesanan portal (D-12 butir 3). |
| US-P3-04 | Royalti/fee otomatis, tagihan mitra, dan pembayaran | M | 5/5 | Di balik flag | Opsi A/B sebagai parameter kontrak (PTB-55). |
| US-P3-05 | Standar mutu: daftar periksa harian, jadwal audit, hasil uji air | M | 5/5 | Di balik flag | |
| US-P3-06 | Dashboard kinerja mitra dan pembina wilayah | M | 5/5 | Di balik flag | Mitra dua outlet: dasbor/portal menampilkan kontrak terbaru per tenant (lihat risiko RP-18). |
| US-P3-07 | Sanksi bertingkat, pemutusan, dan pelepasan | M | 3/3 | Di balik flag | Setiap tahap diputuskan pemilik (PTB-59); ekspor data outlet ≤ 30 hari (PTB-58). |
| US-P3-08 | Pasokan air mitra tercatat di POS mitra dan neraca air per mitra | M | 5/5 | Aktif | RL-7 (PTB-61, CR-15). |
| US-P3-09 | Tagihan langganan sistem bulanan untuk mitra | M | 4/4 | Aktif | RL-7; langganan per outlet (PRD 9.7); dijurnal lewat `partner.subscription_invoiced` (D-10 butir 1). |
| US-P3-10 | Akses baca Pemilik mitra dan laporan bulanan | M | 4/4 | Aktif | RL-7; portal `/mitra` baca-saja. UAT B-74: ≤ 2 detik per layar di 4G. |
| US-P3-11 | Permintaan dukungan teknis mitra dengan SLA 48 jam | S | 3/3 | Aktif | RL-7. |

---

## 4. Status PTB (PRD Bab 13)

Rujukan keputusan: PRD Bab 13 (catatan 9–10 Sep 2026) dan `docs/DECISIONS.md` D-03 (27 Sep 2026). Kelas C berlaku
sebagai bawaan setelah PRD disetujui; kelas A/B berlaku sesuai keputusan. PTB-49..PTB-60 dibangun sesuai usulan di
balik flag Tahap 2/3, tetapi **keputusan bisnisnya tetap dikonfirmasi pada gerbang tahap** (TG-9, Bab 9.1).

| PTB | Kelas | Keputusan | Implementasi v1.0 |
|---|:-:|---|---|
| PTB-01 | C | Disetujui 9 Sep 2026 | Pesanan internal pasokan depot (M2/M3/M8), harga transfer BR-33. |
| PTB-02 | C | Disetujui 9 Sep 2026 | Sumber terdekat acuan zona; jarak rute / garis lurus × 1,3. |
| PTB-03 | C | Berlaku (D-03) | Komponen BBM satu nilai rupiah per rit, berlaku per tanggal. |
| PTB-04 | C | Berlaku (D-03) | QRIS statis non-tunai, dicocokkan lewat mutasi. |
| PTB-05 | C | Disetujui 9 Sep 2026 | Pusat notifikasi + Web Push + e-mail ringkasan (Resend). |
| PTB-06 | A | Disetujui 10 Sep 2026 (CR-01) | PIN + perangkat terdaftar = M. |
| PTB-07 | A | Disetujui 10 Sep 2026 (CR-02) | Stok bahan & opname depot = M. |
| PTB-08 | A | Disetujui (D-03, CR-03) | Tutup kas ≤ 22.00 (PAR-06). |
| PTB-09 | C | Berlaku (D-03) | 1 rit = 1 pengiriman 5.000 L; n tangki = n rit. |
| PTB-10 | C | Disetujui 10 Sep 2026 | Akun kernet sendiri; hak sopir saat ditetapkan pengganti. |
| PTB-11 | B | Disetujui 10 Sep 2026 | Peran akuntan baca-saja. |
| PTB-12 | A | Disetujui (D-03, CR-04) | Jurnal manual > Rp 5 juta disetujui sebelum posting; ≤ Rp 5 juta tinjauan wajib (PAR-20). |
| PTB-13 | C | Berlaku (D-03) | Harga dikunci saat pesanan dibuat. |
| PTB-14 | C | Berlaku (D-03, D-04) | Format nomor dokumen D-04. |
| PTB-15 | C | Berlaku (D-03) | Jam pasti opsional. |
| PTB-16 | A | Disetujui (D-03, CR-05) | Pencocokan manual = M; impor mutasi = S (keduanya dibangun). |
| PTB-17 | C | Disetujui 10 Sep 2026 | Pola user story Tahap 2–3. |
| PTB-18 | B | Disetujui (D-03) | Kurang bayar + tagih kurang bayar + persetujuan kurang bayar kedua. |
| PTB-19 | B | Disetujui (D-03) | Tunai → tempo hanya lewat persetujuan Dispatcher saat daring. |
| PTB-20 | C | Disetujui 10 Sep 2026 | Pengeluaran rit berfoto, diverifikasi saat setoran. |
| PTB-21 | A | Disetujui terbatas (D-03, CR-06) | Tutup kas dengan setoran tertunda per kejadian, maks. 1 hari (PAR-89). |
| PTB-22 | C | Disetujui 10 Sep 2026 | Flag `cash.restitution_active` (bawaan mati); sistem tidak memotong gaji. |
| PTB-23 | B | Disetujui (D-03) | Setor bank: depot/toko boleh; sopir hanya dengan izin pemilik per orang. |
| PTB-24 | C | Disetujui 10 Sep 2026 | Satu faktur per rit tempo; faktur bulanan untuk pelanggan bulanan. |
| PTB-25 | C | Disetujui 10 Sep 2026 | Satu batas kredit lintas lini. |
| PTB-26 | A | Dikonfirmasi (D-03, CR-07) | Faktur bulanan tgl 1 M+1, jatuh tempo tgl 15 M+1 (PAR-12). |
| PTB-27 | C | Berlaku (D-03) | Rit belum Berangkat pelanggan Ditahan ditandai ke Dispatcher. |
| PTB-28 | B | Disetujui 10 Sep 2026 | Hapus piutang hanya lewat jurnal manual M11 berpersetujuan. |
| PTB-29 | A | Disetujui (D-03, CR-08) | Struk WA versi tautan = M. |
| PTB-30 | B | Disetujui (D-03) | Halaman KPI (S, RL-6). |
| PTB-31 | B | Disetujui (D-03) | Kombinasi peran terlarang ditolak saat diajukan (`sod.ts`). |
| PTB-32 | B | Disetujui (D-03) | Tanpa delegasi; kemampuan delegasi di balik flag `approvals.delegation`. |
| PTB-33 | C | Berlaku (D-03) | GPS mentah 12 bulan; ringkasan per rit/hari bersama rit. |
| PTB-34 | B | Disetujui (D-03, CR-14) | Master pool/garasi (`pool_locations`). |
| PTB-35 | B | Disetujui (D-03, CR-14) | 2FA TOTP wajib pemilik, Admin Keuangan, admin sistem. |
| PTB-36 | C | Berlaku (D-03) | Anonimisasi disetujui pemilik; ditolak bila ada piutang terbuka. |
| PTB-37 | B | Disetujui 10 Sep 2026 (CR-14) | Transfer internal bahan toko → depot harga mitra, dieliminasi. |
| PTB-38 | C | Berlaku (D-03) | Harga pokok rata-rata bergerak. |
| PTB-39 | A | Disetujui 10 Sep 2026 (CR-09) | L1 pusat biaya dialokasikan ke L2/L3; laporan biaya per liter. |
| PTB-40 | C | Berlaku (D-03) | Kas awal tetap per outlet. |
| PTB-41 | C | Berlaku (D-03) | Neraca air harian + rata-rata 7 hari & tandon sebagai informasi. |
| PTB-42 | C | Berlaku (D-03) | Tempo toko offline memakai eksposur sinkron terakhir. |
| PTB-43 | C | Berlaku (D-03) | Void besar offline menunggu persetujuan; pembalik setelah shift ditutup. |
| PTB-44 | C | Berlaku (D-03) | Penyesuaian saldo awal ≤ 3 bulan berpersetujuan. |
| PTB-45 | C | Berlaku (D-03) | Arus kas metode langsung. |
| PTB-46 | C | Berlaku (D-03) | Retur toko: void hari sama, setelahnya nota kredit. |
| PTB-47 | C | Berlaku (D-03) | M11 menyusul: jurnal retroaktif sejak cut-over (tombol **Aktifkan M11**). |
| PTB-48 | C | Berlaku (D-03) | Tanpa diskon POS depot. |
| PTB-49 | C | Dibangun sesuai usulan (D-03); dikonfirmasi pada gerbang Tahap 2 | Aplikasi pelanggan PWA. |
| PTB-50 | B | Dibangun sesuai usulan (D-03); dikonfirmasi pada gerbang Tahap 2 | Adaptor gerbang pembayaran; Midtrans sandbox; biaya dibukukan sebagai beban. |
| PTB-51 | C | Dibangun sesuai usulan (D-03); dikonfirmasi pada gerbang Tahap 2 | Tiga slot (PAR-73). |
| PTB-52 | B | Dibangun sesuai usulan (D-03); dikonfirmasi pada gerbang Tahap 2 | Prioritas Tahap 2 sesuai usulan. |
| PTB-53 | B | Tidak dibangun (D-03) | EP-2-07 / US-P2-07 ditunda. |
| PTB-54 | C | Dibangun sesuai usulan (D-03); dikonfirmasi pada gerbang Tahap 2 | Posisi truk hanya saat rit Berangkat menuju pelanggan itu. |
| PTB-55 | B | Dibangun sesuai usulan (D-03); dikonfirmasi pada gerbang Tahap 3 | Satu portal; Opsi A/B parameter kontrak. |
| PTB-56 | B | Dibangun sesuai usulan (D-03); dikonfirmasi pada gerbang Tahap 3 | Harga jual POS mitra ditetapkan mitra; harga anjuran tampil. |
| PTB-57 | C | Dibangun sesuai usulan (D-03) | Flag `partner.franchise_terms` (bawaan "Mitra Depot EQUA"). |
| PTB-58 | B | Dibangun sesuai usulan (D-03); dikonfirmasi pada gerbang Tahap 3 | Ekspor data outlet ke mitra ≤ 30 hari. |
| PTB-59 | C | Dibangun sesuai usulan (D-03) | Sanksi bertingkat, setiap tahap diputuskan pemilik. |
| PTB-60 | C | Dibangun sesuai usulan (D-03); dikonfirmasi pada gerbang Tahap 2 | Adaptor WhatsApp Cloud API; tautan tetap berfungsi bila API mati. |
| PTB-61 | A | Disetujui (D-03, CR-15) — Opsi 1 | Paket Minimum Mitra Fase 1 (RL-7) aktif. |
| PTB-62 | B | Disetujui (D-03) — tetap nonaktif | PAR-83 dibangun, bawaan nonaktif. |

## 5. Status CR (PRD Lampiran D)

PRD Lampiran D mencatat status awal "diusulkan, menunggu keputusan pemilik dan komite pengarah". Manajer proyek
memutuskan PTB sumbernya di D-03 (27 Sep 2026) sehingga **v1.0 dibangun sesuai semua CR**. Pengesahan formal CR ke BRD
v1.1 tetap lewat tanda tangan Bab 14 — **tindakan komite pengarah** sebelum go-live.

| CR | Sumber | Status keputusan | Dampak di v1.0 |
|---|---|---|---|
| CR-01 | PTB-06 | Disetujui 10 Sep 2026 | FR-M10-05 = M (US-M10-02, US-M3-10). |
| CR-02 | PTB-07 | Disetujui 10 Sep 2026 | FR-M6-04 = M (US-M6-04). |
| CR-03 | PTB-08 | Diputuskan D-03 | BR-14 tutup kas 22.00 (US-M4-06, PAR-06). |
| CR-04 | PTB-12 | Diputuskan D-03 | Jurnal manual sesuai BR-35 (US-M11-03, PAR-20). |
| CR-05 | PTB-16 | Diputuskan D-03 | Pencocokan manual M + impor mutasi S (US-M4-04, US-M11-06). |
| CR-06 | PTB-21 | Diputuskan D-03 | Tutup kas dengan setoran tertunda (US-M4-06, PAR-89). |
| CR-07 | PTB-26 | Diputuskan D-03 | Tanggal faktur bulanan (US-M5-06, PAR-12). |
| CR-08 | PTB-29 | Diputuskan D-03 | Struk WA tautan = M (US-M3-04). |
| CR-09 | PTB-39 | Disetujui 10 Sep 2026 | L1 pusat biaya + biaya per liter (US-M9-02 KP-6, US-M11-01). |
| CR-10 | Tinjauan ketertelusuran | Diterapkan di PRD v1.1 | ID KPI-01..11 dan TG-0..TG-9 dipakai di kode & laporan KPI. |
| CR-11 | PTB-01 | Diterapkan di PRD v1.1 | Rit pasokan depot terpisah dari rit pelanggan di laporan (KPI-07). |
| CR-12 | Tinjauan BR-01 | Diterapkan di PRD v1.1 | PAR-82 "tanpa masalah"; status "Tempo migrasi" saat cut-over (US-M5-07). |
| CR-13 | Tinjauan dependensi M → S | Diterapkan di PRD v1.1 | Bagian M dibangun: US-M2-11, notifikasi (US-M9-04), perangkat mati (US-M12-08). |
| CR-14 | PTB-34/35/37 | Diputuskan D-03 (aturan tukar) | Tambahan M dibangun; RL-6 (US-M7-07, US-M9-06, US-M12-07) juga dibangun (D-02). |
| CR-15 | PTB-61 | Diputuskan D-03 (Opsi 1) | RL-7 US-P3-08..11 aktif. |
| CR-16 | Tinjauan perangkat | Diterapkan | POS toko = tablet Android (satu basis kode POS PWA). |
| CR-17 | Tinjauan periode paralel | Diterapkan | PAR-84 kriteria tarik nota kertas, PAR-88 perpanjangan maks. 1 minggu (`docs/uat/paralel.md`). |
| CR-18 | Tinjauan kunci rit | Diterapkan | Setoran ditutup tanpa menunggu keputusan selisih; PAR-83 opsional (PTB-62). |

## 6. Hal terbuka yang dibawa ke UAT, pilot, dan gerbang tahap

| Butir | Pemilik | Rujukan |
|---|---|---|
| Pengaburan wajah foto bukti kirim (syarat aktivasi Tahap 2) belum dibangun | PM / komite pengarah | B-75, D-11 butir 3, TG-9, RP-16 |
| Region hosting Singapura (bukan Jakarta) — tinjauan kepatuhan UU PDP | Komite pengarah / konsultan hukum | D-01, RP-14 |
| PII di jejak audit setelah anonimisasi — tinjauan konsultan hukum | Konsultan hukum | D-09 butir 1, RP-15 |
| Tinjauan akuntan: pemetaan jurnal, arus kas, alokasi L1, eliminasi | Akuntan | B-57, B-76, B-84, RP-17 |
| Batas kredit bersama & faktur gabungan lintas outlet mitra tidak dibangun | PM | D-13 butir 1, RP-18 |
| Butir UAT manual per modul (kecepatan, kamera, offline, GPS nyata, e-mail, penetrasi, pemantau, pemulihan) | Tim UAT | `docs/uat/*.md` bagian "UAT manual" |
| Tanda tangan PRD/BRD v1.1 (Bab 14) dan berita acara UAT per modul | Sponsor & pemilik modul | PRD Bab 11.3, Bab 14 |
