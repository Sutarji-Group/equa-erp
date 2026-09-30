# Changelog

Semua perubahan penting EQUA ERP dicatat di sini. Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/)
dan penomoran [Semantic Versioning](https://semver.org/lang/id/). Catatan rilis untuk pengguna:
[`docs/RELEASE_NOTES_v1.0.md`](docs/RELEASE_NOTES_v1.0.md). Status per user story: [`docs/prd/status.md`](docs/prd/status.md).

## [Belum dirilis]

### Ditambahkan

- **Strategi branch** (D-16): `main` = produksi, `development` = staging/UAT, alur PR/rilis/hotfix di
  [`CONTRIBUTING.md`](CONTRIBUTING.md), templat PR (`.github/pull_request_template.md`), panduan deploy §2a.

### Diubah

- Workflow terjadwal `cron.yml` (`tick`, `monitor`) hanya berjalan terjadwal bila variabel repositori
  `CRON_ENABLED=true` — mencegah pemakaian menit Actions sebelum produksi siap (±8.640 menit/bulan per job pada repo
  private); *Run workflow* manual tetap tersedia.

### Diperbaiki

- **CI Test dibatalkan karena batas waktu** ("The operation was canceled" setelah 20 menit, semua uji yang sempat
  berjalan lulus): Vitest di CI kini memakai semua core runner (`--maxWorkers=100%`; `vitest.config.ts` tetap 50%
  untuk mesin dev bersama) dan batas job dinaikkan ke 45 menit. CI berjalan untuk push ke `main`/`development` dan
  untuk setiap PR (tidak lagi dobel push + PR pada branch kerja).
- **CI Typecheck gagal kehabisan memori** (`JavaScript heap out of memory`, exit 134): `tsc` atas seluruh proyek
  butuh ±2,4 GB heap, sedangkan batas bawaan Node di runner GitHub ±2 GB. Skrip `pnpm typecheck` kini menjalankan
  `tsc` dengan `--max-old-space-size=4096`, job CI memasang `NODE_OPTIONS=--max-old-space-size=4096` (juga untuk
  lint & uji), dan panduan deploy menyarankan variabel yang sama untuk build Vercel.

## [1.0.1] — 2026-09-30

Rilis perbaikan atas hasil uji beban 3× volume S5-C ([`docs/qa/uji-beban.md`](docs/qa/uji-beban.md) §10) sesuai
`docs/DECISIONS.md` D-14. Tanpa perubahan skema basis data; aplikasi lapangan versi 1.0.0 tetap dilayani (protokol
sinkron kompatibel mundur).

### Diubah

- **Nomor jurnal 6 digit** `J-YYMM-NNNNNN` (B-87, D-14 butir 1): kapasitas 99.999 → 999.999 jurnal per bulan per
  tenant. Nomor yang sudah terbit tidak diubah; penghitung bulan berjalan dilanjutkan (`J-2610-01234` →
  `J-2610-001235`). Buku besar, daftar tinjauan pemilik, ekspor templat pajak, dan rincian laporan bulanan M9
  diurutkan menurut urutan terbit sehingga bulan peralihan tetap berurutan. D-04 diperbarui; risiko RP-23 ditutup.
- **Foto lebih hemat kuota** (B-88, D-14 butir 2): bawaan PAR-38 300 → **150 KB**, sisi panjang foto 1.600 → 1.280 px,
  kualitas awal 0,7. Aplikasi lapangan dan formulir kas kantor membaca PAR-38 dari server (pemilik dapat mengubahnya
  di Pengaturan › Parameter tanpa rilis).
- **Sinkron latar adaptif** (B-88): antrean kosong → pull tiap 5 menit (dalam batas PAR-30) hanya selama aplikasi
  terlihat; ada antrean → push tiap 60 detik; antrean berubah → push segera lalu pull; login PIN/ganti pengguna,
  kembali online, dan aplikasi terlihat lagi → segera. Tombol **Kirim sekarang** tetap.

### Ditambahkan

- **Pull bersyarat** (B-89, D-14 butir 3): `GET /api/sync/pull?v=2&c.<kunci>=<kursor>` — kursor = sidik isi per
  penyedia; penyedia yang tidak berubah dijawab tanpa isi, koleksi yang tumbuh (penjualan shift POS & toko, rit &
  pembayaran sopir, stok) dikirim sebagai delta. Koreksi kantor, void, dan pembalik atas data lama pasti terkirim.
  Klien tanpa `v=2` menerima respons v1 persis.
- Tambahan platform inti (hanya tambah, dilaporkan di `docs/dev/sprint0-notes.md`): `docNumberOrder`
  (`numbering.ts`), `params.cached(tx)` / `ParamCache` / `invalidateParamCaches` (`params-read.ts`), protokol pull v2
  (`src/lib/pull-delta.ts`, `src/server/core/sync/conditional.ts`, opsi `collections` di `registerPullProvider`),
  `m12.fleetRangeSummary`.

### Kinerja

- Dashboard H+0 rentang sebulan: **662 → 197 kueri** (−70 %), 0,94 → 0,46 dtk di DB uji; perkiraan di Neon pada
  3 ms/kueri ±2,9 → ±1,05 dtk (NFR-03). Keluaran 19/19 kasus pengukuran identik dengan sebelum perbaikan.
- Pull tanpa perubahan: sopir 21,7 → 0,9 KB, POS 28,2 → 0,8 KB; pull setelah 1 transaksi POS 1,6 KB dan tidak lagi
  tumbuh dengan ukuran shift. Perkiraan kuota data bulanan: sopir ±81 → **±40 MB** (NFR-17 ≤ 50 MB), tablet POS
  ±140 → **±13 MB**.

### Diperbaiki

- Urutan kejadian armada pada ringkasan H+0 kini tetap (waktu mulai, lalu id) untuk kejadian berwaktu sama.

### Catatan rilis teknis

- Tanpa migrasi baru: baseline `drizzle/0000_baseline_v1` tetap; `pnpm db:migrate` → `pnpm db:verify` IDENTIK.
- DB yang sudah di-seed v1.0.0: setelah deploy jalankan sekali `pnpm db:seed:prod -- --no-accounts` → PAR-38 mendapat
  versi baru 150 KB berlaku hari itu bila nilainya masih bawaan 300 KB (nilai yang sudah diubah pemilik dan riwayat
  tidak disentuh). DB baru langsung memakai 150 KB. Diverifikasi saat integrasi pada DB hasil seed v1.0.0: `db:migrate`
  0 migrasi baru, `db:verify` IDENTIK, seed menambah versi PAR-38 150 KB berlaku hari itu, riwayat 300 KB tetap.
- Versi minimal aplikasi tidak perlu dinaikkan; penghematan kuota berlaku setelah perangkat memperbarui ke 1.0.1
  (otomatis saat aplikasi dibuka dan terhubung). Versi per perangkat terlihat di Akses › Perangkat & sinkron.
- Masih terbuka: kuota nyata di pilot (NFR-17, B-88/B-96), pengukuran Neon & render halaman produksi (B-90, B-95).

## [1.0.0] — 2026-09-30

Rilis pertama untuk go-live Tahap 1 (RL-1/RL-2), stabilisasi RL-6, dan Paket Minimum Mitra Fase 1 (RL-7) sesuai
PRD v1.1 dan `docs/DECISIONS.md` D-01 s.d. D-13. Tahap 2 (aplikasi pelanggan) dan portal lengkap Tahap 3 disertakan
di balik *feature flag* yang mati secara bawaan (D-02).

### Ditambahkan — platform (S0)

- Scaffold Next.js 16 App Router, TypeScript strict, pnpm, Drizzle ORM multi-driver (PGlite dev/uji, Neon produksi,
  `pg`), Tailwind v4 + shadcn/ui, Serwist PWA + Dexie, Vitest, Playwright.
- Model data lengkap semua modul; pengerasan DB (`src/db/sql/hardening.sql`): tanpa DELETE/TRUNCATE data bisnis,
  log & ledger append-only, kolom imutabel, jurnal seimbang saat COMMIT, periode Ditutup/Dikunci, batas cut-over, FK
  komposit tenant (NFR-30).
- Platform inti `src/server/core`: autentikasi sesi DB (kata sandi argon2, 2FA TOTP, PIN lapangan, perangkat terdaftar
  dengan token bertanda tangan, pencabutan seketika), RBAC + lingkup + pemisahan tugas yang menolak, persetujuan
  dengan tenggat, jejak audit berantai, log akses, event domain, parameter berlaku per tanggal (Lampiran B PAR-01..89),
  feature flag, penomoran dokumen, notifikasi in-app + Web Push + e-mail, ekspor Excel/PDF, penyimpanan berkas (Blob),
  pekerjaan terjadwal `/api/cron/*`, adaptor WA/peta/gerbang pembayaran.
- Sinkron offline idempoten: outbox di perangkat (UUID v7), perintah bertanda tangan terikat sesi PIN, unggah
  lampiran, pull per modul, kesehatan perangkat, versi minimal aplikasi ditegakkan server.

### Ditambahkan — modul Tahap 1 (S1–S2)

- **M1 Data master**: pelanggan & alamat berkoordinat, produk & harga tiga lini, zona tarif & pemetaan alamat, armada,
  kru, perangkat, depot, sumber air, pool/garasi, karyawan, impor data awal + pembersihan duplikat + tanda tangan.
- **M2 Pesanan & rit**: pesanan cepat, deteksi dobel, kontrol kredit tempo, papan jadwal rit, langganan, konfirmasi WA,
  pembatalan/jadwal ulang/rit gagal, jadwal kru & pengemudi pengganti harian.
- **M3 Aplikasi sopir** (`/sopir`, offline): rit hari ini, Berangkat/Tiba/Selesai berlokasi, bukti kirim, pembayaran
  per rit, pelunasan piutang, rit gagal & kendala, pengeluaran rit, kas di tangan & setor.
- **M4 Kas & setoran**: posisi kas per sumber, penerimaan setoran & selisih, tindak lanjut selisih & ganti rugi,
  transfer masuk & impor mutasi, kas kantor/kecil, tutup kas & ringkasan H+0.
- **M5 Piutang**: faktur otomatis, pelunasan & alokasi, uang muka, nota kredit, jatuh tempo & status Ditahan, umur
  piutang, pengingat WA, faktur bulanan, saldo awal cut-over.
- **M6 POS depot** (`/pos`, offline): transaksi, shift & kas awal, void beralasan & persetujuan, stok bahan & opname,
  pasokan & neraca air outlet, paket standar multi-tenant.
- **M7 Toko & stok**: POS toko harga mitra/umum, penerimaan barang & kartu stok, stok minimum, tempo mitra, opname,
  transfer internal ke depot, laris/mati & margin, utang pemasok, kas toko.
- **M8 Produksi air** (`/produksi`, offline): meter berfoto, pengisian truk per rit, pasokan depot, neraca air & susut,
  utilisasi, mutu air.
- **M9 Laporan**: dashboard H+0, laba kotor per lini & konsolidasi, katalog ekspor, kotak masuk pengecualian,
  kinerja sopir/truk/depot, tren, KPI-01..11.
- **M10 Akses & audit**: pengguna/peran/lingkup, perangkat & PIN, persetujuan akses, tinjauan akses, jejak audit &
  log akses, data pribadi (anonimisasi, retensi, cadangan), kesehatan perangkat & sinkron, insiden, tiket bantuan.
- **M11 Akuntansi**: bagan akun & pusat laba, jurnal otomatis dari semua modul, jurnal manual berlampiran &
  berpersetujuan, buku besar & laporan keuangan, aset tetap & penyusutan, rekonsiliasi bank/kas, utang, pajak non-PKP
  & pemantauan batas PKP, saldo awal, tutup/kunci periode.
- **M12 Armada/GPS**: ingest perangkat GPS & ponsel cadangan, peta real-time, riwayat & putar ulang, pencocokan lokasi
  Selesai, perjalanan di luar jadwal, geofence, jarak per rit, peringatan perangkat mati.

### Ditambahkan — stabilisasi, kemitraan, Tahap 2/3 (S3–S4)

- RL-6: laporan barang laris/mati, tren, jarak per rit, halaman KPI.
- **RL-7 Paket Minimum Mitra**: pasokan & neraca air per mitra, tagihan langganan sistem bulanan, portal baca pemilik
  mitra `/mitra`, dukungan teknis SLA 48 jam.
- **Tahap 3** (flag `phase3.partner_portal`): calon mitra & penilaian lokasi, kontrak & onboarding, pesanan portal,
  royalti Opsi A/B, standar mutu, dasbor pembina wilayah, sanksi bertingkat.
- **Tahap 2** (flag `phase2.customer_app`): aplikasi pelanggan PWA `/app` — daftar dengan OTP WA, pesan dengan slot,
  status & posisi truk, riwayat/tagihan & pembayaran digital (adaptor, Midtrans sandbox), langganan, penilaian &
  keluhan, WhatsApp Cloud API.

### Diubah / diperbaiki — pengerasan & QA (S5-A, S5-B)

- Butir backlog lintas modul B-01..B-78 dituntaskan atau diputuskan (`docs/dev/backlog.md`), antara lain wajib ganti
  kata sandi pertama (B-08), penyamaran PII jejak audit (B-09), koreksi rit lintas modul (B-34), e-mail faktur &
  pernyataan lewat Resend (B-36), akun buku per rekening bank (B-53), alokasi L1 → L3 & eliminasi (B-56), rit
  prabayar terhadap uang muka bertanda pesanan (B-65, B-81).
- Audit keamanan & kebenaran S5-B: 78 temuan, 77 diperbaiki, 1 diputuskan (`docs/qa/audit-s5.md`, D-13).
- Skenario E2E lintas modul P-01..P-07 (`e2e/scenarios/`, `docs/qa/skenario-uji.md`); override waktu E2E yang aman.

### Ditambahkan — kesiapan rilis (S5-C)

- Baseline migrasi produksi `drizzle/0000_baseline_v1` (termasuk skema S5-A/S5-B: B-79, B-83), `pnpm db:migrate`
  (migrasi + pengerasan, idempoten), `pnpm db:verify` (bandingkan katalog DB target dengan referensi), dan uji
  `tests/db/migrations.test.ts` (migrate = push, idempoten, tanpa DDL tertunda).
- `pnpm db:seed:prod`: data awal produksi tanpa demo (parameter Lampiran B, tenant EQUA, CoA & pemetaan jurnal,
  template WA) + akun pemilik & admin sistem pertama (wajib ganti kata sandi & daftar 2FA saat login pertama).
- Pengaturan **Fitur bertahap** untuk pemilik di Pengaturan › Parameter: flag global dan per tenant beralasan; layar
  kemitraan Tahap 3 memeriksa flag per tenant.
- PRD 9.7 mitra dua outlet: satu kontrak per outlet, tagihan langganan, wilayah eksklusif, dan onboarding per outlet
  (D-13 butir 1) + uji `tests/p3-partner/two-outlets.test.ts`.
- Dokumentasi: deploy (`docs/deploy/README.md`), runbook operasional (`docs/ops/runbook.md`), UAT per modul
  dibangkitkan dari PRD (`pnpm uat:gen`) + pilot, paralel, cut-over, gerbang tahap, register risiko (`docs/uat/`),
  indeks panduan per peran & kartu lapangan 1 halaman (`docs/guides/`), status implementasi (`docs/prd/status.md`).

### Kinerja — uji beban 3× volume (S5-C, NFR-03/05/17)

- Data sintetis 3× volume selama 60 hari (`pnpm perf:generate`) dan pengukuran 27 kasus layanan kunci & sinkron
  perangkat (`pnpm perf:measure`, `perf:explain`, `perf:pwa`); hasil & rekomendasi kapasitas di
  [`docs/qa/uji-beban.md`](docs/qa/uji-beban.md). Semua kasus lolos setelah perbaikan; keluaran identik byte demi byte
  dengan sebelum perbaikan.
- Indeks baru (masuk baseline migrasi): `journals_source_event_idx`, `pos_sales_tenant_date_idx`,
  `pos_sale_lines_tenant_date_idx`.
- Laporan keuangan M11 ±3,5× lebih cepat (agregat per segmen, arus kas di SQL); papan jadwal & peta armada (posisi GPS
  terakhir) ±16× lebih cepat; posisi kas & batas kas POS memakai satu agregat SQL per shift; rentang H+0 hanya
  menghitung langsung hari yang belum terbit.
- **Diperbaiki:** buku besar M11 kini berhalaman di server (`?hal=`) dengan mutasi & saldo akhir dihitung atas seluruh
  rentang — sebelumnya baris terpotong diam-diam pada 5.000 dan totalnya dihitung dari baris yang terpotong.
- PWA lapangan (NFR-17): service worker hanya mem-*precache* aset halaman lapangan (145 → 38 entri, ±1,45 → 0,55 MB
  gzip), dengan cadangan precache penuh bila tata letak build tidak dikenali.

### Keamanan

- 2FA TOTP wajib untuk pemilik, Admin Keuangan, dan admin sistem (PTB-35); rahasia dev ditolak di produksi
  (`ALLOW_DEV_SECRETS` hanya untuk E2E lokal); cron & ingest GPS dilindungi rahasia; header `nosniff`, CSRF, dan
  otorisasi per objek pada lampiran & ekspor; isolasi tenant diuji otomatis.

### Tidak dibangun (sesuai D-02)

- Kebutuhan prioritas C: FR-M6-08, FR-M11-11, NFR-25 printer bluetooth, US-P2-07 (galon antar).
- Pengaburan wajah foto bukti kirim di aplikasi pelanggan — syarat gerbang aktivasi Tahap 2 (TG-9, B-75).
- Batas kredit bersama & faktur gabungan lintas outlet mitra (D-13 butir 1).

### Catatan rilis teknis

- Produksi dimulai dari DB kosong saat cut-over: `pnpm db:migrate` → `pnpm db:verify` → `pnpm db:seed:prod`
  (`docs/deploy/README.md`). DB dev lama tetap `pnpm db:push`.
- Setiap perubahan skema setelah v1.0 WAJIB disertai `pnpm db:generate` (migrasi baru di `drizzle/`).

[Belum dirilis]: #belum-dirilis
[1.0.1]: #101--2026-09-30
[1.0.0]: #100--2026-09-30
