# Audit S5 — temuan, perbaikan & sisa (S5-B)

Audit menyeluruh atas hasil integrasi S5-A (pengerasan backlog + skenario P-01..P-07) oleh tujuh auditor: empat
auditor PRD (prd-a..prd-d, per kelompok modul), UX, keamanan, dan PM. Temuan dikerjakan dua tim perbaikan:
**paket A** (`mod/s5b-fix-a`: M1, M2, M3, M6, M7, M8, M10, M12, P3, inti) dan **paket B** (`mod/s5b-fix-b`: M4, M5,
M9, M11, P2, NFR, UI kantor). Keduanya digabung ke `claude/festive-einstein-mfe4ao` pada integrasi S5-B (30 Sep 2026).

Aturan penanganan: setiap temuan diperbaiki dengan uji regresi yang judulnya memuat ID user story/KP; temuan yang bukan
perbaikan kecil yang aman ditunda ke backlog dengan alasan; tidak ada temuan yang boleh "ditolak" tanpa alasan tertulis.

## Ringkasan

| | Temuan | Kritis | Mayor | Minor | Diperbaiki | Ditolak | Sisa |
|---|---:|---:|---:|---:|---:|---:|---:|
| Paket A | 42 | 2 | 17 | 23 | 41 | 0 | 1 |
| Paket B | 36 | 0 | 25 | 11 | 36 | 0 | 0 |
| **Jumlah** | **78** | **2** | **42** | **34** | **77** | **0** | **1** |

- Temuan unik: **76**. Dua entri adalah temuan yang sama dari dua auditor: job `m7.reorder.sweep` tanpa transaksi (M7,
  paket A, dua entri) dan retensi GPS mentah di job M10 (paket A M10 + paket B NFR/B-42). Keduanya dihitung per entri
  di tabel. Retensi GPS diselesaikan satu kali saat integrasi (lihat "Temuan integrasi").
- **Ditolak: 0.** Tidak ada temuan yang dinilai keliru. Semua temuan dikonfirmasi terhadap PRD/keputusan PM.
- **Sisa: 1** (paket A, P3 minor, mitra dua outlet) → backlog **B-82** (butuh keputusan PM, bukan perbaikan kecil).
- Empat temuan integrasi baru ditemukan dan diperbaiki saat penggabungan. Tidak termasuk 78 entri di atas.

## Paket A — per kelompok

| Kelompok | Temuan | K/M/m | Diperbaiki | Ditolak | Sisa |
|---|---:|---|---:|---:|---:|
| M1 Master data | 1 | 0/1/0 | 1 | 0 | 0 |
| M2 Pesanan & jadwal | 5 | 0/1/4 | 5 | 0 | 0 |
| M3 Aplikasi sopir | 11 | 1/5/5 | 11 | 0 | 0 |
| M6 POS depot | 6 | 0/4/2 | 6 | 0 | 0 |
| M7 Toko & stok | 4 (2 entri sama) | 0/1/3 | 4 | 0 | 0 |
| M8 Produksi | 0 | — | — | — | — |
| M10 Akses & audit | 5 | 0/1/4 | 5 | 0 | 0 |
| M12 GPS | 1 | 0/0/1 | 1 | 0 | 0 |
| P3 Kemitraan | 6 | 0/2/4 | 5 | 0 | 1 |
| Inti (klien offline, job) | 3 | 1/2/0 | 3 | 0 | 0 |

Rincian perbaikan (hand-off masing-masing modul di `docs/dev/modules/*.md`, bagian "S5B paket A"):

- **M3** — setoran lintas tengah malam tetap dapat diajukan dengan penanda terlambat (US-M3-07 KP-5, BR-10); Setor per
  pemegang kas setelah ganti sopir (US-M2-11 KP-3); pelaksana & izin kernet dinilai pada waktu perangkat, kunci yang
  terbentuk sesudahnya = konflik, bukan tolak (Bab 6.4); pelunasan/pengeluaran setelah Setor tidak menempel ke setoran
  tertutup (BR-07); rit truk lain ditolak (US-M10-03 KP-1); jalur "dicatat kantor" untuk pelunasan & Setor
  (US-M3-09 KP-5); rit ditarik tampil di aplikasi (US-M3-01 KP-4); Tiba tidak direka; Tempo hanya bila berhak; struk WA
  tidak menghitung ganda; akurasi GPS ponsel dari parameter `m12.fleet_rules`.
- **M1/M2** — batas kredit tidak ikut naik saat segmen diubah (US-M1-01 KP-4); `order.status_changed` di setiap
  transisi (US-M2-02 KP-2); ubah cara bayar hanya menggugurkan persetujuan tempo; BR-24 tidak berlaku untuk pesanan
  internal; terbit ulang tidak memasang penghalang ulang pada rit yang sudah terbit; pesanan terkirim sebagian =
  Dalam pengiriman.
- **M6/M7** — harga master dipaksakan server dengan jendela katalog offline (`m6.price_rules`); pasokan air yang sudah
  diterima otomatis hanya membawa penyesuaian nilai (BR-33); tunai POS tersinkron setelah tutup shift masuk setoran /
  setoran susulan (US-M4-06 KP-7); opname wajib lengkap + hitung buta toko (US-M6-04 KP-4, US-M7-05 KP-1, BR-27);
  tutup shift ditolak server tanpa stok fisik bahan utama (`STOCK_COUNT_REQUIRED`); harga transfer hilang dilaporkan;
  tempo offline ditentukan server dari jeda sinkron (PTB-42); job per unit kerja dalam transaksi.
- **M10/M12** — anonimisasi memakai definisi piutang M5 termasuk rit belum ditagih (PTB-36); ringkasan akses harian
  tanpa celah 22.15–24.00; versi minimal ditegakkan server (`APP_UPDATE_REQUIRED`, login PIN 426); retensi GPS lewat
  M12; label objek persetujuan tanpa UUID; GPS ponsel cadangan aktif saat vendor GPS padam.
- **P3** — riwayat parameter kontrak untuk tagihan bulan lalu (`partner_contracts.terms_history`); nota kredit faktur
  mitra terbatas komponen L5; flag Tahap 3 per tenant; pendapatan L5 dijurnal pada bulan layanan; portal menampilkan
  versi minimal POS + tenggat.
- **Inti** — galat unggah lampiran sementara tidak menolak perintah, "Kirim ulang", pemangkasan antrean & Blob (Dexie v3);
  `inJobTx` + audit D-12 butir 8 atas semua job paket A & inti (pengecualian yang disengaja tercatat di
  `docs/dev/sprint0-notes.md`).

## Paket B — per kelompok

| Kelompok | Temuan | K/M/m | Diperbaiki | Ditolak | Sisa |
|---|---:|---|---:|---:|---:|
| M4 Kas & setoran | 8 | 0/6/2 | 8 | 0 | 0 |
| M5 Piutang | 6 | 0/4/2 | 6 | 0 | 0 |
| M9 Laporan | 1 | 0/1/0 | 1 | 0 | 0 |
| M11 Akuntansi | 10 | 0/8/2 | 10 | 0 | 0 |
| P2 Aplikasi pelanggan | 5 | 0/3/2 | 5 | 0 | 0 |
| NFR (pemantauan, data pribadi) | 5 | 0/2/3 | 5 | 0 | 0 |
| UI kantor (NFR-19) | 1 | 0/1/0 | 1 | 0 | 0 |

Rincian perbaikan (hand-off modul bagian "S5-B perbaikan temuan audit (tim B)"):

- **M4** — mutasi dari jalur persetujuan/pembalik tidak menulis ke hari kas tertutup; pembalik setor bank tidak
  diterapkan bila sudah cocok; ambang PAR-01 per sopir/outlet per hari; selisih setoran tertunda diselesaikan saat kas
  diterima; penerima setoran bukan pencatat transaksi "dicatat kantor" (SOD-02); tutup kas tertunda membandingkan saldo
  yang benar; `/kas/tutup` menampilkan outlet/truk & karyawan (D-12 butir 7); pesan berkas xlsx rusak berbahasa Indonesia.
- **M5** — uang muka bertanda pesanan (B-81, D-12 butir 1); e-mail pernyataan cukup `m5.invoice.send` (B-77, D-12
  butir 2); ambang PAR-21 tidak dapat dipecah; teks tanpa kode enum/PRD; faktur bulanan susulan; PAR-41 wajib tanggal
  go-live.
- **M11/M9** — pasokan air dijurnal sekali per penerimaan; alokasi susulan; rekonsiliasi basi & kas sopir nol; nilai
  aset impor lewat persetujuan penyesuaian saldo awal; pelepasan aset berlampiran + persetujuan; penghapusan piutang
  selalu disetujui pemilik (PTB-28); sumber air wajib pada baris beban L1 jurnal manual; konsolidasi M9 = M11; ekspor
  Final identik; pesan pemetaan berlabel Indonesia; M11 aktif hanya bila pemetaan wajib lengkap atau diaktifkan pemilik.
- **P2** — gerbang flag Tahap 2 pada notifikasi & sesi; pencocokan nama nomor daur ulang diperketat; Web Push tanpa SSRF;
  OTP tanpa enumerasi + batas per IP/total.
- **NFR** — pemantau uptime eksternal + gangguan berdurasi + laporan uptime bulanan (NFR-28/NFR-02); PAR-86 dibaca kode;
  anonimisasi & retensi data aplikasi pelanggan (NFR-12); `pnpm db:mask` (NFR-27); retensi GPS milik M12 (B-42).
- **UI kantor** — halaman kantor tidak melebar di ponsel (anak grid konten `min-w-0`); asersi E2E lebar viewport atas
  semua rute menu dari registri navigasi.

## Temuan integrasi (ditemukan & diperbaiki saat penggabungan)

1. **Retensi GPS ganda arah (konflik).** Paket A membuat `runRetention` M10 memanggil M12 `purgeExpiredPositions`;
   paket B melepas GPS sepenuhnya dari M10. Yang dipertahankan: M10 **tidak** menyentuh `gps_positions`
   (`gpsPurged` = 0). Penghapusan hanya lewat job M12 `m12.gps.retention` yang memastikan ringkasan rit/hari dulu. Dua
   temuan (A: US-M12-01 KP-6, B: B-42) tetap terpenuhi, dan retensi OTP/ganti nomor paket B dipertahankan.
2. **Pasokan air: nilai penuh terbalik (kerusakan semantik lintas paket).** Paket A (M6) memancarkan konfirmasi atas
   pasokan yang sudah diterima otomatis dengan `adjustmentOfAutoAccepted` dan `transferValue` = penyesuaian. Paket B
   (M11) menganggap setiap `transferValue` bernilai penuh lalu menjurnal selisihnya. Gabungan keduanya membuat
   konfirmasi volume sama (penyesuaian 0) menjurnal **−nilai penuh**, sehingga transfer internal L2→L3 hilang dari buku.
   Perbaikan di M11 (`bookedWaterSupplyValue`/`waterSupply`): event penyesuaian ditambahkan ke nilai terbukukan, event
   biasa mengganti. Uji: `tests/m11-accounting/audit-s5b.test.ts` ("integrasi S5-B") dan `tests/m6-pos/audit-fixes.test.ts`
   (BR-33, satu jurnal bersih). Keduanya terbukti gagal tanpa perbaikan.
3. **Label objek persetujuan baru.** Jalur persetujuan nilai aset impor (paket B) memakai objek
   `opening_adjustment_journal` yang belum berlabel, sehingga kartu /persetujuan (paket A) hanya menampilkan "Objek".
   Label "jurnal penyesuaian saldo awal" didaftarkan di `src/server/modules/m11-accounting/audit.ts`.
4. **P-07 tutup buku gagal di rekonsiliasi kas sopir (data demo vs aturan baru).** Paket B (US-M11-06 KP-2) mewajibkan
   kas di tangan sopir nol: saldo fisik 0 dan saldo sistem 0. Rit demo M3/M4 ditulis seed tanpa event, sehingga saat
   E2E menerima setoran demo yang masih Diajukan/Berjalan (S-26-900405, S-26-900202), kas di tangan sopir dikredit tanpa
   debit padanan. Saldo menjadi −Rp 760.000 dan tidak dapat direkonsiliasi nol, sehingga periode tidak dapat ditutup.
   Paket A lulus P-07 dengan aturan lama (fisik = sistem), paket B tidak menjalankan P-07. Perbaikan: seed demo M11
   membukukan tunai rit & pelunasan sopir di setoran demo yang belum diterima ke kas di tangan sopir, seperti jurnal
   otomatisnya (`pendingDriverCashJournals`, `src/db/seed/demo-m11-accounting.ts`; uji
   `tests/m11-accounting/demo-seed-driver-cash.test.ts`). Spec P-07 kini menegaskan saldo sistem kas sopir = 0
   sebelum menyimpan rekonsiliasi.

Tidak ada kerusakan pada berkas bersama. Pemeriksaan tambahan: semua job M4, M5, M9, M11 dan P2 (di luar cakupan audit job
paket A) sudah menjalankan tulisannya di dalam `withTx`/`inJobTx`. D-12 butir 8 kini terpenuhi di seluruh modul.

## Verifikasi integrasi

Dijalankan pada cabang integrasi setelah kedua merge dan perbaikan integrasi:

- `pnpm typecheck` · `pnpm lint`: lulus.
- `pnpm test` (Vitest): 203 berkas, 1.352 uji lulus. Termasuk uji regresi integrasi baru: `tests/m11-accounting/audit-s5b.test.ts`
  ("integrasi S5-B"), `tests/m6-pos/audit-fixes.test.ts` (BR-33), dan `tests/m11-accounting/demo-seed-driver-cash.test.ts`.
- `pnpm build`: lulus.
- `pnpm test:e2e` seluruh proyek (chromium, mobile, scenarios P-01..P-07) pada DB segar
  (`PORT=3200 PGLITE_DATA_DIR=./.data/pglite-e2e-integr`): **65/65 lulus**. Rinciannya: chromium 49, mobile 9 (termasuk asersi lebar
  ponsel NFR-19 atas semua rute menu), dan scenarios 7 (P-01..P-07). Jalan pertama sebelum perbaikan temuan integrasi 4:
  64/65, P-07 gagal di rekonsiliasi kas sopir. Server E2E sudah dihentikan.
- `pnpm trace`: KP prioritas M 490/490 (100%); semua prioritas 552/554 (P2 93,8%, satu story tanpa uji otomatis, tidak
  berubah dari S5-A).

## Sisa & tindak lanjut

| Backlog | Isi | Pemilik |
|---|---|---|
| B-82 | PRD 9.7 mitra dua outlet: kontrak banyak pelanggan, batas kredit bersama, penggabungan faktur rit air lintas pelanggan mitra | PM (keputusan) → P3, M1, M5 |
| B-83 | Migrasi produksi skema S5-B (`terms_history`, `customer_advances.order_id`, `asset_disposal`, `otp_codes.request_ip`, `service_outages`) | Core, S5-C |
| B-84 | Runbook cut-over: pemilik "Aktifkan M11" setelah akuntan meninjau pemetaan | PM, cut-over |
| B-85 | Secret/variabel repositori pemantau uptime (`APP_URL`, `CRON_SECRET`, `ALERT_WEBHOOK_URL` / `RESEND_API_KEY` + `ALERT_EMAIL_TO`) | Ops, UAT |
| B-77 | Kiriman e-mail nyata dengan kunci Resend produksi & domain terverifikasi (kode selesai) | UAT |
| B-76, B-57 | Tinjauan akuntan atas alokasi L1 → L3, eliminasi markup, dan kategori arus kas | UAT (akuntan) |

Catatan riwayat: commit `90e5dcb` dan `fbb028e` (paket B) masih berjudul "wip … belum terverifikasi". Isinya sudah
diverifikasi (E2E NFR-19 & P-06 lulus di paket B dan di integrasi ini). Riwayat tidak ditulis ulang.
