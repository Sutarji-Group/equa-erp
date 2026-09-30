# EQUA ERP — Program Digitalisasi Terpadu EQUA

**Versi 1.0.1** · [Catatan rilis](docs/RELEASE_NOTES_v1.0.md) · [CHANGELOG](CHANGELOG.md) ·
[Status implementasi per user story](docs/prd/status.md)

Satu platform, satu data untuk seluruh usaha EQUA di Cianjur: **air truk** (pesanan, jadwal, rit, setoran sopir),
**depot isi ulang** dan **toko** (POS multi-outlet, stok, shift), **dua sumber air** (produksi, meter, neraca air),
serta kas, piutang, akuntansi per pusat laba, armada/GPS, laporan H+0, dan kemitraan depot.

- **Web kantor** untuk pemilik, Admin Keuangan, Dispatcher, akuntan (baca-saja), admin sistem, dan pembina wilayah.
- **Aplikasi lapangan PWA offline-first** — `/sopir` (sopir & kernet), `/pos` (operator depot & kasir toko),
  `/produksi` (operator sumber air) — dengan antrean sinkron idempoten; tetap bekerja tanpa sinyal.
- **Portal pemilik mitra** `/mitra` (RL-7, aktif) dan **aplikasi pelanggan** `/app` (Tahap 2) — Tahap 2 dan portal
  lengkap Tahap 3 dibangun di balik *feature flag* yang mati secara bawaan.

Kebutuhan: [`docs/prd/PRD_EQUA_v1_1.md`](docs/prd/PRD_EQUA_v1_1.md) · Keputusan manajer proyek:
[`docs/DECISIONS.md`](docs/DECISIONS.md) · Arsitektur & konvensi kode: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
Panduan tim/agen: [`CLAUDE.md`](CLAUDE.md).

## Isi rilis v1.0

| Modul | Ringkasan | Antarmuka |
|---|---|---|
| M1 Data master | Pelanggan & alamat berkoordinat, produk & harga tiga lini, zona tarif, armada & kru, depot, sumber air, pool/garasi, karyawan, impor data awal & tanda tangan pemilik | `/master` |
| M2 Pesanan & rit | Pesanan < 60 detik, cek dobel, kontrol kredit tempo, papan jadwal rit, langganan, kru harian & pengemudi pengganti, konfirmasi WA | `/pesanan`, `/jadwal` |
| M3 Aplikasi sopir | Rit hari ini, Berangkat/Tiba/Selesai berlokasi, bukti kirim, bayar per rit, pelunasan, rit gagal, pengeluaran, kas di tangan & setor — offline | `/sopir` |
| M4 Kas & setoran | Posisi kas per sumber, terima setoran & selisih, transfer masuk & impor mutasi, kas kantor/kecil, tutup kas & ringkasan H+0 | `/kas` |
| M5 Piutang | Faktur otomatis, pelunasan & alokasi, jatuh tempo & status Ditahan, umur piutang, faktur bulanan, pengingat WA, saldo awal | `/piutang` |
| M6 POS depot | Transaksi cepat, shift & kas awal, void beralasan, stok bahan & opname, pasokan & neraca air outlet, multi-tenant — offline | `/pos`, `/outlet` |
| M7 Toko & stok | POS toko harga mitra/umum, penerimaan barang, stok minimum, tempo mitra, opname, transfer ke depot, laris/mati, utang pemasok | `/pos`, `/toko` |
| M8 Produksi air | Meter berfoto, pengisian truk per rit, pasokan depot, neraca air & susut, utilisasi, mutu air — offline | `/produksi` |
| M9 Laporan | Dashboard H+0, laba kotor per lini & konsolidasi, ekspor Excel/PDF, kotak masuk pengecualian, kinerja, tren, KPI-01..11 | `/laporan`, `/kotak-masuk` |
| M10 Akses & audit | Peran & lingkup, PIN + perangkat terdaftar, 2FA TOTP, pemisahan tugas, persetujuan, jejak audit, data pribadi & retensi, kesehatan perangkat | `/akses`, `/audit`, `/persetujuan` |
| M11 Akuntansi | Bagan akun & pusat laba, jurnal otomatis & manual, buku besar & laporan keuangan, aset tetap, rekonsiliasi, utang, pajak non-PKP, saldo awal, tutup/kunci periode | `/akuntansi` |
| M12 Armada/GPS | Ingest GPS perangkat & ponsel, peta real-time, riwayat & putar ulang, cek lokasi Selesai, di luar jadwal, geofence, jarak per rit, perangkat mati | `/armada` |
| P3 RL-7 | Pasokan & neraca air mitra, tagihan langganan sistem, portal baca pemilik mitra, dukungan teknis SLA 48 jam | `/kemitraan`, `/mitra` |
| P2 Tahap 2 *(flag)* | Aplikasi pelanggan: daftar via WA, pesan dengan slot, pantau truk, tagihan & bayar digital, langganan, keluhan | `/app` |
| P3 Tahap 3 *(flag)* | Calon mitra & kontrak, onboarding, pesanan portal, royalti, standar mutu, dasbor pembina, sanksi | `/kemitraan`, `/mitra` |

Cakupan uji: 490/490 KP prioritas M dan 552/554 KP seluruhnya (US-P2-07 kelas C tidak dibangun) — rincian
[`docs/dev/traceability.md`](docs/dev/traceability.md) (`pnpm trace`).

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript strict · pnpm 10 · Drizzle ORM · PostgreSQL
(Neon di produksi, PGlite di dev & uji) · Tailwind CSS v4 + shadcn/ui · Zod 4 · Dexie + Serwist (PWA) · Vitest ·
Playwright · Vercel (region `sin1`; penyimpangan region dicatat di D-01 / RP-14) · Vercel Blob · Resend · Web Push (VAPID).

## Menjalankan secara lokal

Prasyarat: Node.js ≥ 22.12 dan pnpm 10 (`corepack enable`).

```bash
pnpm install        # pasang dependensi
pnpm db:push        # dorong skema ke PGlite lokal (.data/pglite) — tanpa server DB
pnpm db:seed        # isi data demo
pnpm dev            # http://localhost:3000
```

Tidak perlu berkas `.env` untuk dev: semua variabel punya bawaan (lihat [`.env.example`](.env.example) dan
`src/lib/env.ts`). Untuk memakai Postgres sungguhan, set `DB_DRIVER=pg` (atau `neon`) dan `DATABASE_URL`.

> PGlite berbasis berkas hanya boleh dibuka satu proses. Hentikan `pnpm dev` sebelum menjalankan `pnpm db:push` atau
> `pnpm db:seed`. Untuk mengulang DB dev dari nol: hapus direktori `.data/pglite`, lalu `pnpm db:push && pnpm db:seed`.

### Akun demo (HANYA dev/demo — jangan dipakai di produksi)

`pnpm db:seed` membuat tenant EQUA (10 depot D01–D10, toko TK1, sumber air SA1/SA2, 7 truk T1–T7, ±40 pelanggan demo,
parameter Lampiran B PAR-01..PAR-89, bagan akun, template WA), satu tenant mitra demo, dan satu akun per karyawan:

| Peran | Nama pengguna |
|---|---|
| Pemilik | `pemilik` |
| Admin Keuangan | `keuangan1`, `keuangan2` |
| Dispatcher | `dispatcher1`, `dispatcher2` |
| Admin sistem | `admin1`, `admin2` |
| Akuntan (baca-saja) | `akuntan` |
| Sopir / Kernet (truk T1–T7) | `sopir1`..`sopir7` / `kernet1`..`kernet7` |
| Operator depot (D01–D10) | `depot01`..`depot10` |
| Kasir toko (TK1) | `kasir` |
| Operator produksi (SA1: 1–3, SA2: 4–6) | `produksi1`..`produksi6` |
| Pembina wilayah | `pembina1` |
| Pemilik mitra (portal `/mitra`) / operator depot mitra | `mitra1` / `opmitra1` |

- Kata sandi web kantor semua akun: **`equa-demo-2026`**; PIN lapangan/POS: **`123456`**.
- 2FA TOTP (PTB-35) aktif untuk pemilik, Admin Keuangan, dan admin sistem dengan rahasia demo tetap (base32; tambahkan
  ke aplikasi authenticator secara manual). Disimpan di `users.totp_secret_enc` dengan awalan `plain:` (dev saja):

| Pengguna | Rahasia TOTP |
|---|---|
| `pemilik` | `EQUADEMOPEMILIKRAHASIATOTPDEVAAA` |
| `keuangan1` | `EQUADEMOKEUANGANSATURAHASIATOTPA` |
| `keuangan2` | `EQUADEMOKEUANGANDUARAHASIATOTPAA` |
| `admin1` | `EQUADEMOADMINSATURAHASIATOTPAAAA` |
| `admin2` | `EQUADEMOADMINDUARAHASIATOTPAAAAA` |

`db:seed` menolak berjalan bila `VERCEL_ENV=production`; produksi memakai `db:seed:prod` (tanpa data demo).

## Basis data

- Skema Drizzle: `src/db/schema/` (satu berkas per modul + `core.ts`). Pengerasan DB (`src/db/sql/hardening.sql`):
  trigger menolak DELETE/TRUNCATE tabel bisnis, UPDATE/DELETE log & ledger, perubahan kolom imutabel, jurnal tidak
  seimbang, periode tertutup, dan transaksi sebelum cut-over; FK komposit tenant (NFR-30) — diterapkan otomatis oleh
  `db:push`, `db:migrate`, dan harness uji.
- **Dev**: `pnpm db:push` (dengan `src/db/sql/pre-push.sql` untuk DB dev lama). **Produksi/staging**: migrasi berversi
  di `drizzle/` (baseline `0000_baseline_v1`). Urutan pertama kali di DB kosong:

  ```bash
  DB_DRIVER=neon DATABASE_URL=… pnpm db:migrate     # migrasi drizzle/ + trigger pengerasan (idempoten)
  DB_DRIVER=neon DATABASE_URL=… pnpm db:verify      # katalog DB = migrasi referensi di PGlite segar
  DB_DRIVER=neon DATABASE_URL=… pnpm db:seed:prod   # parameter Lampiran B, tenant EQUA, peran, CoA & pemetaan, template; akun pemilik & admin sistem
  ```

  Rincian (variabel, pilihan `db:seed:prod`, cut-over): [`docs/deploy/README.md`](docs/deploy/README.md).
- Setelah mengubah skema: `pnpm db:generate` (migrasi baru di `drizzle/`) — uji `tests/db/migrations.test.ts` gagal
  bila skema dan migrasi tidak sama.
- Uji memakai PGlite in-memory dari snapshot yang di-cache (`tests/helpers/db.ts`: `createTestDb()` / `useTestDb()`).

## Perintah

| Perintah | Fungsi |
|---|---|
| `pnpm dev` | Server pengembangan |
| `pnpm build` / `pnpm start` | Build produksi / jalankan hasil build |
| `pnpm typecheck` | Pemeriksaan tipe (`next typegen && tsc --noEmit`) |
| `pnpm lint` | ESLint (flat config, next core-web-vitals + TypeScript) |
| `pnpm test` / `pnpm test:watch` | Uji unit & integrasi Vitest (PGlite in-memory, tanpa layanan luar) |
| `pnpm test:e2e` | Uji end-to-end Playwright, termasuk skenario P-01..P-07 (`E2E_DEV=1` memakai `pnpm dev`) |
| `pnpm db:push` | Dorong skema Drizzle ke DB dev + trigger pengerasan (`--force` untuk perubahan yang menghapus data) |
| `pnpm db:seed` | Isi data demo & data awal (idempoten; ditolak di produksi) |
| `pnpm db:seed:prod` | Data awal produksi tanpa demo + akun pemilik & admin sistem pertama (interaktif atau argumen) |
| `pnpm db:generate` | Bangkitkan migrasi SQL produksi (`drizzle/`) |
| `pnpm db:migrate` | Terapkan migrasi `drizzle/` + trigger pengerasan (produksi/staging) |
| `pnpm db:verify` | Bandingkan katalog DB target dengan migrasi referensi (keluar 1 bila berbeda) |
| `pnpm db:mask -- --yes` | Samarkan data pribadi pada salinan DB di lingkungan uji (NFR-27; ditolak di produksi) |
| `pnpm trace` | Cakupan uji per user story / kriteria penerimaan → `docs/dev/traceability.md` |
| `pnpm uat:gen` | Bangkitkan checklist UAT per modul `docs/uat/*.md` dari PRD (`--check` untuk memeriksa saja) |

Definisi selesai: `pnpm typecheck && pnpm lint && pnpm test` hijau (docs/DECISIONS.md D-06).

## Struktur

```
src/
  app/            rute Next.js — (auth) (office) (field) (portal) (customer) + api/ (sinkron, cron, GPS, webhook)
  db/             client.ts (getDb), schema/, seed/ (demo & production.ts), sql/ (hardening, pre-push), migrations.ts
  server/         kode server saja — core/ (platform inti) & modules/ (m1..m12, p2, p3)
  client/         kode peramban saja — Dexie, outbox & worker sinkron, kamera, geolokasi
  components/     ui/ (shadcn), shared/, field/, komponen per modul
  lib/            isomorfik — time (WIB), money (rupiah), ids (UUID v7), geo, labels, env
drizzle/          migrasi SQL produksi (baseline v1)
tests/            Vitest — tests/<modul>/*.test.ts (judul memuat ID US/KP)
e2e/              Playwright — per modul + scenarios/ P-01..P-07 (`*.mobile.spec.ts` untuk PWA lapangan)
scripts/, tools/  skrip CLI (db:*, trace, uat:gen, simulator GPS, pemantau uptime)
docs/             lihat peta dokumen di bawah
```

## Peta dokumen

| Untuk | Dokumen |
|---|---|
| Pengguna (per peran, kartu lapangan 1 halaman) | [`docs/guides/README.md`](docs/guides/README.md) |
| Deploy produksi (Vercel, Neon, Blob, Resend, VAPID, cron, pemantau, rollback) | [`docs/deploy/README.md`](docs/deploy/README.md) |
| Operasional harian tim IT (insiden, cadangan & pemulihan, rotasi rahasia, perangkat hilang, onboarding) | [`docs/ops/runbook.md`](docs/ops/runbook.md) |
| UAT per modul, pilot, periode paralel, cut-over, gerbang Tahap 2/3, risiko | [`docs/uat/README.md`](docs/uat/README.md) |
| Status implementasi per user story, PTB, CR | [`docs/prd/status.md`](docs/prd/status.md) |
| Skenario uji P-01..P-07 & audit keamanan S5 | [`docs/qa/skenario-uji.md`](docs/qa/skenario-uji.md), [`docs/qa/audit-s5.md`](docs/qa/audit-s5.md) |
| Uji beban 3× volume, kapasitas Neon/Vercel, data seluler lapangan (NFR-03/05/17) | [`docs/qa/uji-beban.md`](docs/qa/uji-beban.md) |
| Catatan pengembang per modul & backlog lintas modul | `docs/dev/modules/*.md`, [`docs/dev/backlog.md`](docs/dev/backlog.md) |
| Matriks menu & izin | [`docs/nav-permissions.md`](docs/nav-permissions.md) |
| Alur Git: branch `main` (produksi) / `development` (staging), PR, rilis, hotfix | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

## Deploy (ringkas)

Branch **`main` = produksi**, **`development` = staging/UAT (Preview)**; semua perubahan lewat PR ke `development`,
rilis lewat PR `development` → `main` + tag `vX.Y.Z` ([`CONTRIBUTING.md`](CONTRIBUTING.md), D-16).

Vercel (Hobby untuk pilot, Pro saat go-live) region `sin1` + Neon dari Vercel Marketplace (`DB_DRIVER=neon`) + Vercel
Blob + Resend (domain pengirim terverifikasi) + VAPID untuk push. Pekerjaan terjadwal: Vercel Cron harian
(`vercel.json`) dan GitHub Actions tiap 5 menit (`.github/workflows/cron.yml`, secret `APP_URL` & `CRON_SECRET`),
beserta pemantau uptime (secret peringatan). `ALLOW_DEV_SECRETS` **tidak boleh** diset di produksi. Daftar periksa
lengkap sebelum rilis, jendela pemeliharaan PAR-86, dan rollback: [`docs/deploy/README.md`](docs/deploy/README.md).
