# Skenario uji lintas modul — BRD Bab 5 (P-01 s.d. P-07)

Suite Playwright `e2e/scenarios/` menjalankan setiap skenario BRD Bab 5 **lewat antarmuka nyata** — web kantor (konteks
desktop), aplikasi sopir & produksi (konteks ponsel Pixel 7), POS depot/toko (konteks tablet) — di atas data seed demo
yang sama, termasuk bagian **tanpa sinyal** (`context.setOffline`) untuk aksi lapangan. Setiap judul uji memuat `P-0n`
dan user story/KP yang dibuktikan (dibaca `pnpm trace` → `docs/dev/traceability.md`).

## Cara menjalankan

| Kebutuhan | Perintah |
| --- | --- |
| Seluruh E2E (modul + skenario) di DB segar | `PORT=3200 PGLITE_DATA_DIR=./.data/pglite-e2e-integr pnpm test:e2e` |
| Hanya skenario (server sudah jalan) | `E2E_BASE_URL=http://localhost:3200 pnpm test:e2e --project=scenarios` |
| Satu skenario | `… --project=scenarios e2e/scenarios/p-05` |

- Proyek `scenarios` terdaftar TERAKHIR di `playwright.config.ts` (workers = 1): berjalan sesudah spesifikasi modul
  (`chromium`, `mobile`) dan dalam urutan berkas P-01 → P-07; batas waktu 15 menit per skenario, aksi 20 detik.
- Server uji: `pnpm e2e:prepare` (skema + seed + data awal skenario) lalu `next start` dengan `ALLOW_DEV_SECRETS=1` dan
  `E2E_CLOCK_OVERRIDE=1` (lihat di bawah). Saat iterasi boleh `E2E_DEV=1` (server dev).
- Setelah uji gagal, `attachAllPages` menyimpan cuplikan ARIA + HTML SEMUA halaman di semua konteks (kantor, ponsel,
  tablet) ke folder hasil uji (`halaman-N-aria.txt`, `halaman-N.html`).

## Data & perangkat

- Akun & perangkat seed (`src/db/seed/org.ts`); kode aktivasi baru diterbitkan Admin Sistem di `/akses/perangkat/<id>`
  (US-M10-02) di awal setiap skenario, lalu PIN demo `123456`.
- Data awal khusus skenario (`src/db/seed/e2e-scenarios.ts`, dipanggil HANYA oleh `pnpm e2e:prepare`): pelanggan Tempo
  bersih **PLG-0951 CV Bata Merah Sukamanah** (tempo 14 hari, batas Rp 5.000.000, alamat terkunci + zona) untuk P-05 —
  status Tempo baru tidak dapat diberikan lewat UI tanpa riwayat pesanan (PAR-11), jadi disiapkan seperti data awal
  impor yang sudah ditandatangani.
- Unit yang dipakai (tidak bertabrakan dengan spesifikasi modul): P-01 truk **T6** (HP-T6, Yayan Sopyan) + GPS-T6;
  P-02/P-04 depot **D05** (POS-D05) + truk **T4** (HP-T4) + sumber **SA2** (HP-SA2); P-03 toko **TK1** (POS-TK1);
  P-05 truk **T5** (HP-T5, Iwan Setiawan); P-06 depot **D01** (POS-D01).

## Waktu berlalu — jam tersuntik khusus E2E

Langkah yang butuh waktu berlalu (besok pagi, H-3/H+1 jatuh tempo, lewat tempo > 7 hari, tanggal 1 bulan berikutnya,
job terjadwal) memakai jam tersuntik, **bukan** mengubah data langsung:

- Cookie `equa_e2e_clock=<selisih ms>` menggeser `ctx.now` web kantor dan `auth.now` perangkat lapangan (sesi tetap
  divalidasi jam nyata); jam peramban digeser `context.clock.install` bila perlu (`setClock` di `helpers.ts`).
- `POST /api/cron/tick?only=<job>&now=<ISO>` (Bearer `CRON_SECRET`) menjalankan job pada waktu tersuntik.
- Aktif HANYA bila `E2E_CLOCK_OVERRIDE=1` **dan** `ALLOW_DEV_SECRETS=1` **dan** `VERCEL_ENV` bukan `production`/`preview`
  (`e2eClockAllowed`, `src/lib/env.ts`); `serverEnv()` menolak `E2E_CLOCK_OVERRIDE` di deploy Vercel; selisih maks.
  400 hari. Tanpa izin: cookie diabaikan, `?now=` → 400. Diuji `tests/core/e2e-clock.test.ts` (NFR-09).

## Pemetaan langkah → user story/KP → spesifikasi

Status: **Lulus** = lulus pada run penuh `pnpm test:e2e` di DB segar 30 Sep 2026 (lihat bagian Hasil).

### P-01 Air truk — `e2e/scenarios/p-01-air-truk.spec.ts`

| # | Langkah (BRD Bab 5) | US/KP | Langkah uji | Status |
| --- | --- | --- | --- | --- |
| 1 | Dispatcher membuat pesanan (< 60 dtk untuk pelanggan lama), tunai/transfer/tempo + 1 pesanan besok | US-M2-01 KP-1, KP-7 | "Dispatcher: 4 pesanan hari ini + 1 pesanan besok untuk T6" | Lulus |
| 2 | Papan jadwal: tugaskan ke T6 & terbitkan | US-M2-03 KP-2 | "Dispatcher: papan jadwal — tugaskan rit ke T6 lalu terbitkan" | Lulus |
| 3–4 | Sopir Berangkat/Tiba (GPS ponsel), rit ke-2 TANPA SINYAL | US-M3-02 KP-1, US-M3-09 KP-2 | "Sopir: rit … (cash/transfer/credit/under)" | Lulus |
| 5 | Selesai: foto + nama penerima + tanda tangan | US-M3-03 KP-1 | idem | Lulus |
| 6 | Bayar tunai / transfer (foto bukti) / tempo / kurang bayar beralasan (PTB-18) | US-M3-04 KP-1, KP-2 | idem | Lulus |
| 7 | Struk WA satu ketukan (tautan wa.me berisi rit, volume, harga, cara bayar) | US-M3-03 KP-7 | idem (rit tunai) | Lulus |
| 8 | Perjalanan di luar jadwal terdeteksi dari jejak GPS vendor → keterangan sopir → pemilik menerima | US-M12-05 KP-1 | "GPS: job deteksi …" (ingest `/api/gps/ingest/generic-json` + job `m12.detection.travel`) | Lulus |
| 9 | Kas di tangan → Setor | US-M3-07 KP-1 | "Sopir: kas di tangan → Setor" | Lulus |
| 10 | Admin Keuangan menerima setoran (dihitung sistem) → Ditutup; transfer & faktur tempo/kurang bayar terbentuk | US-M4-02 KP-1 | "Admin Keuangan menerima setoran sopir T6 …" | Lulus |
| 11 | BR-10: rit besok terkunci sebelum setoran Ditutup, terbuka sesudahnya (papan & ponsel, jam besok 07.00) | BR-10 | dua langkah "BR-10: …" | Lulus |

### P-02 Depot — `e2e/scenarios/p-02-depot.spec.ts`

| # | Langkah | US/KP | Langkah uji | Status |
| --- | --- | --- | --- | --- |
| 1 | Buka shift (kas awal tetap PAR-57) | US-M6-02 KP-1 | "Operator depot membuka shift" | Lulus |
| 2 | Jual tunai & QRIS, sebagian TANPA SINYAL → terkirim otomatis | US-M6-01 KP-1, KP-2; US-M6-06 KP-1, KP-2 | "Jual tunai (daring) lalu QRIS & tunai TANPA SINYAL …" | Lulus |
| 3 | Void ≤ PAR-04 langsung; void > PAR-04 (Rp 135.000) menunggu → pemilik menyetujui dari ponsel | US-M6-03 KP-1, KP-2 | "Void kecil langsung; void besar …" | Lulus |
| 4 | Pasokan air dari rit internal T4 → dikonfirmasi di POS | US-M6-05 KP-1 | "Sopir T4 menyerahkan pasokan internal …" | Lulus |
| 5 | Tutup shift: kas fisik + stok bahan fisik (selisih beralasan), setoran diserahkan | US-M6-02 KP-3, KP-5 | "Tutup shift: kas fisik & stok bahan dihitung …" | Lulus |
| 6 | Admin Keuangan menerima setoran shift | US-M4-02 KP-7 | "Admin Keuangan menerima setoran shift D05" | Lulus |

### P-03 Toko — `e2e/scenarios/p-03-toko.spec.ts`

| # | Langkah | US/KP | Langkah uji | Status |
| --- | --- | --- | --- | --- |
| 1 | Penerimaan barang dari nota pemasok (nomor, foto, baris, total) | US-M7-02 KP-1 | "Penerimaan 200 tutup galon dari nota pemasok" | Lulus |
| 2 | Jual harga mitra, harga umum (TANPA SINYAL, diskon 5 % beralasan), tempo mitra (sisa batas) | US-M7-01 KP-1, KP-2, KP-3; US-M7-04 KP-2 | "Jual harga mitra, harga umum, dan tempo mitra" | Lulus |
| 3 | Opname bulanan hitung buta (SELURUH barang toko dihitung — opname sebagian ditolak saat diajukan, S5B) → penyesuaian beralasan → persetujuan pemilik | US-M7-05 KP-1, KP-2 | "Opname bulanan …", "Admin Keuangan mengajukan penyesuaian opname …" | Lulus |
| 4 | Transfer internal ke depot D05 → diterima operator depot | US-M7-06 KP-1 | "Transfer internal 50 tutup galon ke D05 …" | Lulus |
| 5 | Tutup shift toko (tempo tidak masuk laci) & serah setoran | US-M7-09 KP-1, KP-2 | "Tutup shift toko & serah setoran" | Lulus |

### P-04 Produksi — `e2e/scenarios/p-04-produksi.spec.ts`

| # | Langkah | US/KP | Langkah uji | Status |
| --- | --- | --- | --- | --- |
| 1 | Meter pagi (angka + foto) | US-M8-01 KP-1 | "Operator mencatat meter pagi (+ foto)" | Lulus |
| 2 | Pengisian truk per rit (rit pasokan depot T4, 5.000 L) | US-M8-02 KP-1 | "Operator mengisi truk T4 5.000 L …" | Lulus |
| 3 | Pasokan depot: sopir menyerahkan 5.000 L, depot menerima 4.950 L beralasan → tiga angka | US-M8-03 KP-1, US-M6-05 KP-1 | "Sopir T4 menyerahkan 5.000 L; operator D05 menerima 4.950 L …" | Lulus |
| 4 | Meter malam TANPA SINYAL → neraca harian, susut 73,7 % > 5 % → investigasi (alasan + foto) → pemilik menerima | US-M8-04 KP-1, KP-2; US-M8-07 KP-1 | "Operator mencatat meter malam TANPA SINYAL …", "Pemilik melihat neraca air …" | Lulus |

### P-05 Piutang — `e2e/scenarios/p-05-piutang.spec.ts`

| # | Langkah | US/KP | Langkah uji | Status |
| --- | --- | --- | --- | --- |
| 1 | Rit tempo Selesai → faktur kirim otomatis (jatuh tempo +14 hari) → kirim via tautan WA | US-M5-01 KP-1, KP-5 | "Sopir T5 menyelesaikan rit 1 tempo", "Faktur kirim terbit otomatis …" | Lulus |
| 2 | Pengingat H-3 (job harian + jam kantor H-3): WA berisi faktur, jumlah, jatuh tempo → Dibuka | US-M5-05 KP-1 | "Pengingat H-3 …" | Lulus |
| 3 | Rit berikutnya: faktur terbuka dari data sinkron → Terima pelunasan sebagian (tertua) → bukti WA | US-M3-05 KP-1, KP-2, KP-5 | "Rit 2: faktur terbuka tampil …" | Lulus |
| 4 | Alokasi otomatis tanpa input ulang; umur "belum jatuh tempo"; kas pelunasan masuk setoran | US-M5-02 KP-2, US-M3-05 KP-3, US-M5-01 KP-3, US-M5-04 KP-1 | "Kantor: pelunasan sopir teralokasi …" | Lulus |
| 5 | H+1: pengingat sesudah jatuh tempo (2 faktur) + daftar tindakan + umur 1–7 hari | US-M5-05 KP-1, US-M5-04 KP-1, KP-3 | "H+1: …" | Lulus |
| 6 | Lewat tempo > 7 hari → job PAR-55 → Ditahan otomatis (riwayat) → pesanan tempo ditolak | US-M5-03 KP-1, KP-4; US-M2-05 KP-1 | "Jatuh tempo + 8 hari: …" | Lulus |
| 7 | Pelunasan kantor penuh (tertua dulu) → Ditahan dilepas otomatis | US-M5-02 KP-1, US-M5-03 KP-3 | "Pelunasan kantor penuh → …" | Lulus |

### P-06 Tutup kas harian — `e2e/scenarios/p-06-tutup-kas.spec.ts`

| # | Langkah | US/KP | Langkah uji | Status |
| --- | --- | --- | --- | --- |
| 0 | Depot D01: jual tunai & QRIS, tutup shift, serah setoran Rp 90.000 | (penyiapan) | "Operator D01: …" | Lulus |
| 1 | Semua setoran diterima; D01 kurang Rp 50.000 (= PAR-01) beralasan → ke pemilik; sumber berhalangan → pengecualian per kejadian disetujui pemilik; hari kas sebelumnya ditutup dulu | US-M4-02 KP-1, KP-2, KP-7; US-M4-06 KP-1, KP-2 | "Tutup kas: setoran diterima …" | Lulus |
| 2 | Transfer (QRIS shift D01, transfer rit, pelunasan) dicocokkan dengan referensi mutasi | US-M4-04 KP-1, KP-2 | idem (`before`) | Lulus |
| 3 | Layar tutup kas: selisih hari itu; mulai tutup kas tercatat; hitung fisik kas kantor → Tutup kas | US-M4-06 KP-3, KP-4 | idem | Lulus |
| 4 | H+0 "belum ditutup" sebelum tutup; terbit ≤ 30 menit sesudahnya | US-M4-06 KP-5, US-M9-01 KP-2 | "H+0 terbit ≤ 30 menit …" | Lulus |
| 5 | Pemilik (ponsel) menyetujui selisih satu ketuk dari ringkasan H+0 → Selesai | US-M4-06 KP-6, US-M9-01 KP-4, US-M4-03 KP-2 | idem | Lulus |

### P-07 Tutup buku bulanan — `e2e/scenarios/p-07-tutup-buku.spec.ts`

| # | Langkah | US/KP | Langkah uji | Status |
| --- | --- | --- | --- | --- |
| 1 | Jurnal otomatis dari transaksi skenario (pendapatan air truk, piutang, beban selisih kas D01 dari P-06) | US-M11-02 KP-1 | "Jurnal otomatis: …" | Lulus |
| 2–3 | Jurnal akrual manual Rp 6.500.000 (> PAR-20) berlampiran → persetujuan pemilik → terposting; tinjauan pemilik | US-M11-03 KP-1, KP-2 | "Jurnal akrual gaji …", "Pemilik menandai daftar tinjauan …" | Lulus |
| 4 | Rekonsiliasi bank (saldo rekening koran = saldo buku + item otomatis) & kas → nol selisih; kas di tangan sopir: saldo sistem & fisik = 0 (S5-B) | US-M11-06 KP-1, KP-2 | "Rekonsiliasi bank & kas periode → nol selisih" | Lulus |
| 5 | Laba kotor per lini "Sementara" | US-M9-02 KP-1, KP-2 | "Laba kotor bulanan per lini berstatus 'Sementara'" | Lulus |
| 6 | Tanggal 1 bulan berikutnya: prasyarat terpenuhi → Admin Keuangan menutup → pemilik mengunci → "Final" | US-M11-10 KP-1, KP-2; US-M9-02 KP-2 | "Tanggal …: prasyarat terpenuhi …", "Pemilik mengunci periode …" | Lulus |
| 7 | Jurnal akrual dibalik otomatis tanggal 1 periode berikutnya (job `m11.accrual.reverse`) | US-M11-03 KP-6 | "Tanggal … 00.30: jurnal akrual dibalik otomatis …" | Lulus |

## Ketergantungan & batasan yang diketahui

- P-01..P-06 masing-masing dapat berjalan sendiri di DB segar (diverifikasi) maupun sesudah spesifikasi modul. P-07
  menutup buku bulan berjalan dan MEMBUTUHKAN transaksi P-01..P-06 (mis. opname TK1 disetujui di P-03, hari kas ditutup
  di P-06) — jalankan seluruh proyek `scenarios`, bukan P-07 sendirian.
- P-06 menyelesaikan penghalang tutup kas secara umum (menerima setoran Diajukan dengan alasan terlambat bila perlu,
  mengajukan pengecualian per kejadian untuk sumber Berjalan/shift terbuka, menutup hari kas sebelumnya lebih dulu);
  rit Berangkat/Tiba yang tertinggal dari uji lain tidak dapat diselesaikan otomatis dan menggagalkan uji dengan pesan
  jelas.
- P-05 menjalankan job Ditahan pada jatuh tempo + 8 hari untuk SELURUH pelanggan tenant (sesuai job nyata) sehingga
  pelanggan demo lain yang lewat tempo ikut Ditahan; pelunasan kantor P-05 bertanggal jatuh tempo + 9 hari.
- P-07 mengunci periode bulan berjalan — DB uji tidak dipakai ulang sesudahnya (`pnpm e2e:prepare` membuat ulang).
- Jangan menjalankan suite melewati tengah malam WIB (tanggal bisnis berganti di tengah skenario).
- Skenario memakai jam nyata sebagai "hari ini"; aturan jam (PAR-06 22.00, PAR-07 05.00–22.00, BR-20 15.00) ditangani
  (alasan terlambat/paksa kirim diisi bila diminta, deteksi GPS menerima "di luar jadwal" maupun "di luar jam layanan").

## Cacat yang ditemukan & diperbaiki

| Skenario | Cacat | Perbaikan | Uji regresi |
| --- | --- | --- | --- |
| P-07 langkah 7 | Job `m11.accrual.reverse` gagal bila dijalankan runner cron (jalur yang sama dipakai penyusutan bulanan, proses ulang antrean, dan job M11 lain): runner meneruskan koneksi biasa, fungsi job menulis tanpa transaksi → kepala jurnal pembalik ter-COMMIT sebelum barisnya → EQ004 "tidak seimbang"; pembalik akrual tanggal 1 tidak pernah terbentuk (US-M11-03 KP-6). Uji modul hanya memanggil fungsi tanpa `db` sehingga lolos. | `inJobTx(db, run)` di `src/server/modules/m11-accounting/service/common.ts`, dipakai semua job M11 (`manual.ts`, `assets.ts`, `payables.ts`, `periods.ts`, `tax.ts`, `jobs.ts`) | `tests/m11-accounting/jobs-runner.test.ts` (gagal sebelum perbaikan, lulus sesudahnya) |

## Hasil

Run penuh 30 Sep 2026 (WIB) di DB segar, build produksi (`next start`):
`PORT=3200 PGLITE_DATA_DIR=./.data/pglite-e2e-integr pnpm test:e2e` → **64 lulus** (57 spesifikasi modul `chromium` +
`mobile`, lalu 7 skenario P-01..P-07; ±19 menit, skenario 30 dtk – 1,3 menit masing-masing). P-01..P-06 juga diverifikasi
berjalan sendiri di DB segar selama pengembangan. Vitest 191 berkas / 1.271 uji lulus; `pnpm trace`: KP prioritas M 490/490.

Catatan UX (bukan pelanggaran PRD): daftar "Selisih hari ini" di layar tutup kas hanya menampilkan jenis sumber
(mis. "Shift depot") tanpa nama outlet/karyawan — rinciannya lewat tautan ke `/kas/selisih`.
