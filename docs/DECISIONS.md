# Register Keputusan Manajer Proyek IT — EQUA ERP

Dokumen ini adalah **sumber kebenaran keputusan** yang diambil manajer proyek IT untuk membangun produk sesuai
`docs/prd/PRD_EQUA_v1_1.md`. Setiap agen/pengembang WAJIB mengikuti keputusan di sini. Bila PRD dan dokumen ini
tampak bertentangan, dokumen ini yang berlaku (karena ia memutuskan hal yang di PRD masih terbuka).

Tanggal baseline: 27 September 2026.

---

## D-01 Tech stack (ADR)

| Lapisan | Pilihan | Alasan |
|---|---|---|
| Framework | **Next.js 16 (App Router) + TypeScript strict**, React 19 | Arahan sponsor: fullstack Next.js TS; satu basis kode untuk web kantor, aplikasi lapangan (PWA), POS (PWA), portal |
| Package manager | **pnpm** (workspace tunggal) | Store bersama → hemat disk untuk worktree paralel |
| Hosting | **Vercel** (Hobby/free tier untuk pilot; Pro saat go-live) | Ekosistem Vercel, arahan sponsor |
| Database | **PostgreSQL** — produksi: **Neon** (Vercel Marketplace, free tier); dev & test: **PGlite** (Postgres WASM, tanpa server) | Free tier, serverless, satu dialek SQL di semua lingkungan |
| ORM | **Drizzle ORM** + drizzle-kit | Ringan, type-safe, cocok serverless; dukung PGlite & Neon |
| Penyimpanan berkas (foto bukti kirim, meter, nota) | **Vercel Blob** (produksi); adaptor lokal (disk/DB) untuk dev/test | Free tier, ekosistem Vercel |
| Autentikasi | **Kustom, berbasis sesi DB** (cookie httpOnly) dengan primitif teruji: `@node-rs/argon2`/`bcryptjs` (hash), `otplib` (TOTP 2FA), `jose` (token perangkat) | PRD butuh PIN + perangkat terdaftar + login PIN offline + 2FA + pencabutan seketika — tidak didukung utuh oleh pustaka auth umum |
| UI | **Tailwind CSS v4 + shadcn/ui (Radix)**, `lucide-react`, `sonner` | Standar ekosistem Vercel |
| Form & validasi | `react-hook-form` + **Zod** (skema dipakai bersama server & klien) | |
| Tabel & grafik | TanStack Table, **Recharts** | |
| Peta | **Leaflet + OpenStreetMap** (gratis) di balik antarmuka `MapProvider`; jarak rute via adaptor (`straight_line_x1_3` bawaan, OSRM/Google opsional) | Free tier; PRD 4.2 & US-M1-05 KP-2 sudah menyediakan cadangan garis lurus × 1,3 |
| Offline-first lapangan & POS | **PWA** (Serwist service worker) + **IndexedDB (Dexie)** + antrean outbox dengan ID dibuat di perangkat (UUID v7), sinkron idempoten | Satu basis kode; dapat dipasang di Android; dapat dibungkus TWA bila perlu APK |
| Notifikasi | Pusat notifikasi in-app + **Web Push (VAPID)** + e-mail ringkasan harian via **Resend** (free tier) | PTB-05 disetujui: in-app + push; e-mail cadangan |
| WhatsApp | Tahap 1: **tautan `wa.me`** semi-otomatis (K21). Tahap 2: adaptor **WhatsApp Cloud API** (Meta) | NFR-20: dapat ditingkatkan tanpa mengubah alur |
| Pekerjaan terjadwal | Endpoint idempoten `/api/cron/*` dilindungi `CRON_SECRET`; dipicu **Vercel Cron** (harian) dan **GitHub Actions schedule / Upstash QStash** (tiap 5 menit, free tier) | Hobby plan membatasi frekuensi Vercel Cron |
| Ekspor | **exceljs** (Excel), **@react-pdf/renderer** (PDF) | NFR-23 |
| Uji | **Vitest** (unit + integrasi dengan PGlite in-memory), **Playwright** (e2e, Chromium) | Tanpa layanan eksternal di CI |
| Observabilitas | Vercel Analytics/Speed Insights, log terstruktur, tabel `incidents` | NFR-28/31 |

### Penyimpangan yang disadari
- **NFR-26 / K5 (Google Cloud region Jakarta).** Sponsor mengarahkan ekosistem Vercel. Vercel & Neon tidak memiliki region
  Jakarta; dipakai **Singapura** (`sin1` / `aws-ap-southeast-1`) sebagai region terdekat. Arsitektur tetap portabel
  (Postgres standar, adaptor storage) sehingga dapat dipindah ke GCP Jakarta (Cloud SQL + Cloud Run) bila kepatuhan UU PDP
  mengharuskan. Dicatat sebagai risiko RP-14 untuk komite pengarah.
- **Aplikasi lapangan "Android"** dibangun sebagai **PWA** yang dipasang di ponsel Android perusahaan (perangkat tetap
  terdaftar lewat kode aktivasi, US-M10-02). Hapus jarak jauh = perintah wipe data aplikasi pada kontak berikutnya.

## D-02 Cakupan pembangunan

1. **Tahap 1 (M1–M12)**: seluruh kebutuhan **M dan S** dibangun, termasuk tiga S analitik RL-6 (FR-M7-05, FR-M9-06,
   FR-M12-07) dan halaman KPI (US-M9-07). Kebutuhan **C tidak dibangun** (FR-M6-08, FR-M11-11, NFR-25 printer bluetooth —
   struk tetap dapat dicetak lewat dialog cetak peramban).
2. **RL-7 Paket Minimum Mitra Fase 1** (US-P3-08 s.d. US-P3-11) dibangun.
3. **Tahap 2 (Aplikasi Pelanggan, US-P2-01..08) dan Tahap 3 portal lengkap (US-P3-01..07)** dibangun sebagai inkremen
   terakhir **di balik feature flag yang mati secara bawaan** (`phase2.customer_app`, `phase3.partner_portal`), karena PRD
   menetapkan gerbang masuk (TG-9, Bab 8.1, 9.1). Pemilik mengaktifkan flag setelah prasyarat terpenuhi. US-P2-07 (C) tidak dibangun.
4. Data awal/cut-over, parameter Lampiran B, jejak audit, dan pemisahan tugas adalah **bagian dari definisi selesai**
   setiap modul, bukan pekerjaan terpisah.

## D-03 Keputusan atas PTB yang masih terbuka (sesuai rekomendasi v1.1 PRD)

| PTB | Keputusan | Implementasi |
|---|---|---|
| PTB-03, 04, 09, 13, 14, 15, 27, 33, 36, 38, 40–48 (kelas C) | Berlaku sesuai usulan PRD | — |
| PTB-08 | Tutup kas ≤ 22.00 berlaku (PAR-06) | |
| PTB-12 | Jurnal manual > Rp 5 juta persetujuan sebelum posting; ≤ Rp 5 juta terposting + daftar tinjauan wajib pemilik | PAR-20 |
| PTB-16 | Pencocokan manual transfer = M; impor mutasi = S | |
| PTB-18 | Aturan kurang bayar + tagih kurang bayar + persetujuan pada kurang bayar kedua **berlaku** | |
| PTB-19 | Tunai → tempo hanya lewat persetujuan Dispatcher saat daring | approval type `field_payment_to_credit`, penyetuju `dispatcher` |
| PTB-21 | Tutup kas dengan setoran tertunda per kejadian, maks 1 hari (PAR-89) | |
| PTB-23 | Setor bank dengan slip: depot/toko boleh; sopir hanya dengan izin pemilik per orang | flag per karyawan `allow_bank_deposit` |
| PTB-26 | Faktur bulanan: layanan bulan M terbit tgl 1 M+1, jatuh tempo tgl 15 M+1 | PAR-12 |
| PTB-29 | Struk WA versi tautan = M | |
| PTB-30 | Halaman KPI dibangun (S, RL-6) | |
| PTB-31 | Kombinasi peran terlarang tidak dapat diajukan | `src/server/core/rbac/sod.ts` |
| PTB-32 | **Tanpa delegasi** secara bawaan; kemampuan delegasi dibangun tetapi nonaktif (feature flag `approvals.delegation`) | |
| PTB-34 | Master pool/garasi ditambahkan | tabel `pool_locations` |
| PTB-35 | 2FA TOTP wajib untuk pemilik, Admin Keuangan, admin sistem | |
| PTB-49 | Aplikasi pelanggan = PWA | |
| PTB-50 | Adaptor gerbang pembayaran generik; implementasi pertama **Midtrans** (sandbox) QRIS dinamis + VA; biaya gerbang dibukukan sebagai beban | `PaymentGateway` interface |
| PTB-51 | Tiga slot (PAR-73) | |
| PTB-52 | Prioritas Tahap 2 sesuai usulan | |
| PTB-53 | EP-2-07 tidak dibangun | |
| PTB-54 | Posisi truk ke pelanggan hanya saat rit Berangkat menuju pelanggan itu | |
| PTB-55 | Satu portal, Opsi A/B sebagai parameter kontrak | |
| PTB-56 | Harga jual POS mitra ditetapkan mitra; harga anjuran EQUA tampil | |
| PTB-57 | Istilah "waralaba" dikunci parameter, bawaan "Mitra Depot EQUA" | feature flag `partner.franchise_terms` |
| PTB-58 | Ekspor data outlet ke mitra ≤ 30 hari saat berakhir | |
| PTB-59 | Sanksi bertingkat, setiap tahap diputuskan pemilik | |
| PTB-60 | Adaptor WhatsApp Cloud API; tautan tetap berfungsi bila API mati | `WhatsAppProvider` interface |
| PTB-61 | Opsi 1 — Paket Minimum Mitra Fase 1 (RL-7) | |
| PTB-62 | PAR-83 dibangun, **bawaan nonaktif** | |

## D-04 Konvensi produk yang diputuskan
- **Nomor dokumen** (PTB-14 diperluas): Pesanan `P-YY-NNNNNN`; rit `P-YY-NNNNNN/n`; Faktur `F-YY-NNNNNN`; Nota kredit
  `NK-YY-NNNNNN`; Transaksi POS `{kodeOutlet}-YYMMDD-NNNN`; Setoran `S-YY-NNNNNN`; Jurnal `J-YYMM-NNNNN`; Persetujuan
  `A-YY-NNNNNN`; Nota pembelian internal `NB-YY-NNNNNN`; Transfer internal `TI-YY-NNNNN`. YY = tahun 2 digit WIB.
- **Identitas usaha** pada struk/faktur: parameter `company.identity` (bawaan nama usaha "EQUA"; diganti identitas PT setelah PT berdiri, Bab 2.3).
- **Bahasa**: seluruh teks antarmuka Bahasa Indonesia dengan istilah lapangan (rit, setor, tempo, galon, tutup kas, tutup shift).
- **Zona waktu**: WIB (Asia/Jakarta). Tanggal bisnis = tanggal WIB saat dicatat di perangkat (Bab 5.3).
- **Uang**: rupiah bulat (integer). **Volume**: liter bulat. 1 galon = 19 L (A9) sebagai bawaan per produk.
- **Tanpa penghapusan** (Bab 6.1): tidak ada operasi DELETE pada data bisnis; koreksi = transaksi pembalik; master = nonaktifkan.

## D-05 Rencana eksekusi (sprint)

| Sprint | Isi | Setara rilis PRD |
|---|---|---|
| S0 Fondasi | Scaffold, model data lengkap, platform inti (auth, RBAC+SoD, audit, persetujuan, parameter, notifikasi, sinkron offline, event bus, penomoran, ekspor), kerangka UI | RL-0 |
| S1 Inti | M1, M10, M2, M3, M4, M5, M12, M9 (H+0, ekspor) | RL-1 |
| S2 Pilot lengkap | M6, M7, M8, M11, kebutuhan S | RL-2 |
| S3 Stabilisasi & Mitra | RL-6 (laporan analitik, KPI), RL-7 (Mitra Fase 1) | RL-6, RL-7 |
| S4 Tahap 2 & 3 | Aplikasi pelanggan PWA, portal mitra lengkap (feature flag) | Tahap 2/3 |
| S5 QA & Rilis | Uji e2e skenario P-01..P-07, uji isolasi tenant, uji offline, audit keamanan, panduan pengguna, konfigurasi deploy | RL-2/RL-5 bukti |

## D-06 Definisi selesai (DoD) per user story
1. Semua KP berprioritas M diimplementasikan; KP [USULAN] kelas C diimplementasikan; KP kelas A/B mengikuti D-03.
2. Setiap KP yang dapat diuji otomatis memiliki uji Vitest/Playwright yang **judulnya memuat ID** (mis. `US-M2-01 KP-2`).
3. `pnpm typecheck`, `pnpm lint`, `pnpm test` hijau.
4. Mutasi melewati lapisan layanan: otorisasi peran + lingkup, pemisahan tugas, jejak audit, event domain.
5. Ambang/angka aturan diambil dari parameter (Lampiran B), tidak ditanam di kode.
6. Teks UI Bahasa Indonesia, pesan kesalahan berisi tindakan (bukan kode teknis).

## D-07 Kasir toko hanya lewat POS (tinjauan arsitektur pasca-F3c)
- Peran `store_cashier` hanya berantarmuka `pos` (`ROLE_CATALOG.interfaces`), sesuai PRD 7.7.2 ("semua fitur Kasir di
  POS tablet") dan PRD 4.1 (Kasir bukan pengguna web kantor). Login web kantor & `getOfficeSession` MENOLAK peran tanpa
  antarmuka `web` dengan pesan yang benar (Kasir/lapangan → aplikasi POS/lapangan; pemilik mitra → portal), bukan
  "akun tidak aktif".
- Semua aksi Kasir M7 (penerimaan barang/nota pembelian, opname, daftar pesan ulang, usulan barang/harga, pemasok baru)
  dibangun sebagai HANDLER SINKRON POS + penyedia pull. Halaman `/toko/*` untuk pemilik, Admin Keuangan, akuntan.
- Portal pemilik mitra (RL-7) memakai `loginWithPassword(..., { interface: "portal" })`.

## D-08 Perilaku lewat tenggat permintaan akses — DIKONFIRMASI PM (28 Sep 2026): `escalate`
- `account_create`, `role_grant`, `scope_extension` tetap `escalate` (tetap terbuka, ditandai terlambat, pengingat ke
  pemilik; akun/peran TIDAK aktif selama belum disetujui — kolom PRD "Akun/peran tidak aktif" terpenuhi karena
  permintaan tidak pernah memberi akses tanpa keputusan). Alternatif `expire` (permintaan gugur, harus diajukan ulang)
  dapat diganti di `approvals/registry.ts` tanpa perubahan skema bila PM memilihnya.

## D-09 Keputusan PM atas isu integrasi ronde 1–2 (28 Sep 2026)
1. **Data pribadi di jejak audit setelah anonimisasi.** Jejak audit tetap append-only (NFR-11) dan menyimpan nilai lama
   sebagai catatan wajib hukum (pembukuan ≥ 10 tahun, BR-31). Mitigasi: tampilan & ekspor jejak audit untuk objek
   pelanggan yang sudah dianonimkan HARUS menyamarkan nilai data pribadi bagi semua peran kecuali pemilik (dikerjakan
   pada sprint pengerasan S5). Dicatat sebagai risiko kepatuhan RP-15 untuk ditinjau konsultan hukum.
2. **Menu 'Impor data awal'** tetap berizin `m1.import.create` (Dispatcher/Admin Keuangan yang mengimpor). Pemilik
   menandatangani ringkasan lewat `/master/tanda-tangan` — sesuai pemisahan tugas (pemilik tidak menginput data).
3. **Koreksi lintas modul (BR-38):** satu jenis persetujuan `correction`, handler didaftarkan per `objectType`
   (lihat ARCHITECTURE §8). Modul yang membutuhkan koreksi > PAR-21 WAJIB memakai mekanisme ini.
4. **Pemberitahuan setoran depot terlambat (PAR-27)** dimiliki M6 (`m6.deposit.late_check`); M4 TIDAK membuat job duplikat,
   hanya menampilkan sorotan di 'Kas hari ini'.
5. **Template WA konfirmasi pesanan** boleh diedit dari layar M2 (izin `m1.wa_template.*`), tabel tetap milik M1.
6. Backlog lintas modul dilacak di `docs/dev/backlog.md`.

## D-10 Keputusan PM atas isu integrasi ronde 3–6 (29 Sep 2026)
1. **Jurnal piutang (B-31/B-52):** DISETUJUI pendekatan M11 — pendapatan & piutang dijurnal saat peristiwa sumber
   (`trip.completed` tempo/kurang bayar, penjualan POS tempo); `invoice.issued` TIDAK dijurnal ulang. Faktur yang tidak
   berasal dari rit, POS, atau saldo awal (mis. langganan sistem mitra RL-7) WAJIB punya event sumber sendiri yang
   dijurnal (`partner.subscription_invoiced` → L5).
2. **E-mail faktur/pernyataan (B-36):** dikirim dari server lewat Resend dengan PDF terlampir bila `RESEND_API_KEY`
   terisi; bila tidak, tetap tautan `mailto:` (dicatat sebagai "dibuka", bukan "terkirim"). Dikerjakan di sprint pengerasan.
3. **Batas unggah Server Action (B-18):** `serverActions.bodySizeLimit = '4mb'` (di bawah batas badan permintaan Vercel
   4,5 MB) + kompresi gambar di klien sebelum unggah; PDF > 4 MB ditolak dengan pesan tindakan.
4. **Peta komersial (B-46):** tetap sesuai D-01 — OSM + garis lurus × 1,3 bawaan; OSRM/penyedia komersial opsional lewat
   `MAP_ROUTING_URL`. Biaya peta = 0 selama pilot.
5. **Kode notifikasi `access.request_pending` (B-60):** dipertahankan di katalog sebagai alias terdokumentasi; pemberitahuan
   permintaan akses memakai `approval.requested` (tidak ada notifikasi ganda).
6. **Uji bergantung jam dinding:** DILARANG. Semua uji memakai `ctx.now` / waktu tetap (penyebab dua kegagalan ronde 5 sudah
   diperbaiki integrator).

## D-11 Keputusan PM atas isu integrasi ronde 7 (P2 + P3) (29 Sep 2026)
1. **Aksi portal Tahap 3 (B-71):** DISETUJUI diberikan bersyarat lewat `authorizePortalAction` hanya bila flag
   `phase3.partner_portal` aktif untuk tenant itu — dengan syarat keempat izin (`p3.portal_order.create`,
   `p3.portal_dispute.create`, `p3.portal_sop.sign`, `p3.portal_settings.update`) terdaftar di katalog izin sebagai
   **izin bersyarat** (seperti izin kernet pengganti) sehingga tampil di ekspor matriks peran (US-M10-03 KP-4).
2. **Proxy portal (B-70):** `/mitra/:path*` ditambahkan ke matcher `src/proxy.ts` (pengalihan cookie ringan), pemeriksaan
   sesi sebenarnya tetap di layout server portal.
3. **Pengaburan wajah foto bukti kirim di aplikasi pelanggan (B-75):** tidak dibangun di v1.0 (Tahap 2 di balik flag).
   Foto bukti kirim hanya tampil ke akun pemilik pesanan itu sendiri. Pengaburan menjadi syarat gerbang aktivasi Tahap 2
   (TG-9) — dicatat di `docs/uat` & risiko.
4. **Pembayaran digital prabayar (B-65):** rit yang sudah dibayar digital tampil "sudah dibayar" di aplikasi sopir dan
   pendapatan diakui terhadap uang muka pelanggan saat rit Selesai (bukan kurang bayar). Wajib diselesaikan di S5.

## D-12 Keputusan PM atas isu integrasi S5-A (29 Sep 2026)
1. **Uang muka rit prabayar (B-81):** DIPERBAIKI di S5-B — uang muka dari pembayaran P2 yang menarget pesanan ditandai
   `order_id`; `applyOpenAdvances` tidak memakai uang muka bertanda pesanan lain; faktur rit pesanan itu memakai uang muka
   bertandanya lebih dulu. Bila pesanan dibatalkan, tanda dilepas (uang muka menjadi umum) dan tercatat di jejak audit.
2. **E-mail pernyataan piutang (B-77):** izin `m5.invoice.send` cukup untuk mengirim faktur/pernyataan; PDF dibangkitkan
   internal tanpa melewati otorisasi ekspor `m5.aging.export` (tetap diaudit). Diperbaiki di S5-B. Uji kiriman nyata
   dengan kunci Resend & domain terverifikasi = UAT.
3. **Asal pesanan portal (B-78):** DITERIMA — `source` diteruskan saat `createOrder` (bukan diperbarui setelahnya) adalah
   desain yang benar; ditinjau ulang oleh auditor S5-B.
4. **Migrasi produksi (B-79):** produksi dimulai dari DB kosong saat cut-over, sehingga baseline migrasi S5-C memuat
   `invoices.opening_line` & `bank_accounts_gl_account_uq`; pembersihan akun buku bersama hanya untuk DB dev (`pre-push.sql`).
   Impor data awal cut-over wajib memvalidasi satu akun buku per rekening bank — masuk runbook cut-over.
5. **TG-9 (B-80):** dicatat oleh S5-C di `docs/uat/` (gerbang aktivasi Tahap 2) dan daftar risiko `docs/uat/risiko.md`.
6. **B-02:** DITUTUP — digantikan pull `m3.today` (superset `m2.schedule`, kunci BR-10 sama).
7. **Tutup kas (temuan skenario P-06):** daftar "Selisih hari ini" di `/kas/tutup` menampilkan outlet/truk & nama karyawan,
   bukan hanya jenis sumber. Diperbaiki di S5-B.
8. **Job terjadwal:** setiap job yang menulis lebih dari satu baris WAJIB berjalan di dalam transaksi per unit kerja
   (`withTx`/`inJobTx`) — runner memberi koneksi biasa. Temuan M11 (EQ004 pembalik akrual) diperbaiki di S5-A;
   S5-B mengaudit semua modul.
9. **Uji skenario E2E (`e2e/scenarios/`)** dijalankan sebagai satu proyek utuh pada DB segar dan tidak melintasi tengah
   malam WIB; override waktu E2E (`src/server/core/e2e-clock.ts`) hanya aktif bila `E2E_CLOCK_OVERRIDE=1` +
   `ALLOW_DEV_SECRETS=1` dan bukan deploy Vercel produksi/preview — DISETUJUI.

## D-13 Keputusan PM atas isu integrasi S5-B (30 Sep 2026)
1. **Mitra dua outlet (B-82):** PRD 9.7 hanya menuntut "satu tenant, dua outlet; langganan per outlet; wilayah eksklusif
   per outlet". Model v1.0: satu tenant mitra, **satu kontrak per outlet** (tiap outlet = satu pelanggan mitra dengan
   batas kredit & faktur sendiri), wilayah eksklusif & langganan per outlet. Batas kredit bersama dan faktur gabungan
   lintas outlet TIDAK dibangun (bukan tuntutan PRD). S5-C menambah uji penerimaan "PRD 9.7 mitra dua outlet" dan
   memperbaiki minimal bila gagal.
2. **Migrasi produksi skema S5-B (B-83):** masuk baseline migrasi S5-C (semua kolom baru nullable, tabel `service_outages`).
3. **Aktivasi M11 (B-84):** langkah runbook cut-over — pemilik menekan "Aktifkan M11" setelah akuntan meninjau pemetaan.
4. **Pemantau uptime (B-85):** secret/variabel repositori (`APP_URL`, `CRON_SECRET`, `ALERT_WEBHOOK_URL` atau
   `RESEND_API_KEY` + `ALERT_EMAIL_TO`) masuk daftar periksa deploy S5-C.
5. Hasil audit S5-B (`docs/qa/audit-s5.md`): 78 temuan, 77 diperbaiki, 0 ditolak, 1 diputuskan (butir 1). DITERIMA.

## D-14 Keputusan PM atas hasil uji beban S5-C → rilis perbaikan v1.0.1 (30 Sep 2026)
1. **Nomor jurnal (B-87):** format jurnal diubah menjadi `J-YYMM-NNNNNN` (6 digit, kapasitas 999.999/bulan/tenant ≈ 40×
   volume saat ini). Satu jurnal per transaksi POS dipertahankan (jejak per transaksi lebih penting daripada ringkas).
   Perubahan `DOC_TYPES` (berkas bersama) DIIZINKAN PM; nomor yang sudah terbit tidak diubah. D-04 diperbarui.
2. **Kuota sopir NFR-17 (B-88):** bawaan PAR-38 menjadi **150 KB** dengan sisi panjang foto 1.280 px (masih dalam batas
   PRD "≤ 300 KB"); klien membaca PAR-38 dari server. Pull latar **tiap 5 menit bila outbox kosong** (dalam batas PAR-30
   "≤ 5 menit"); push tetap segera saat ada antrean, dan pull segera setelah push berhasil atau saat aplikasi kembali
   aktif. Target perkiraan ≤ 40 MB/bulan; pengukuran nyata di pilot (NFR-17 kolom verifikasi).
3. **Pull POS (B-89):** protokol pull mendukung respons bersyarat (kursor/versi per penyedia): penyedia yang datanya tidak
   berubah sejak kursor klien mengembalikan "tidak berubah" tanpa isi; penjualan shift terbuka dikirim sebagai delta.
   Perubahan protokol sinkron inti DIIZINKAN PM (kompatibel mundur dengan klien lama).
4. **Rentang H+0 (sebagian B-90):** kurangi kueri berulang — ringkasan armada M12 versi rentang + cache parameter per
   permintaan/transaksi (tambahan inti, hanya tambah). Pengukuran Neon & render halaman produksi tetap UAT staging.
5. **Rilis v1.0.1** = butir 1–4 + cek penuh (Vitest, build, seluruh E2E + skenario, trace, alur rilis bersih).
6. **Berkas `/rilis-server.pid`** (6 bita, sisa pemeriksaan alur rilis di akar sistem berkas kontainer) tidak berbahaya;
   penghapusan di luar repo diblokir pengaman — dibiarkan (kontainer sementara).
