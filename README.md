# EQUA ERP — Program Digitalisasi Terpadu EQUA

Satu platform, satu data untuk seluruh usaha EQUA di Cianjur: **air truk** (pesanan, jadwal, rit, setoran sopir),
**depot isi ulang** dan **toko** (POS multi-outlet, stok, shift), **dua sumber air** (produksi, meter, neraca air),
serta kas, piutang, akuntansi per pusat laba, armada/GPS, laporan H+0, dan kemitraan depot.

- Web kantor untuk pemilik, Admin Keuangan, Dispatcher, akuntan, admin sistem.
- Aplikasi lapangan **PWA offline-first** untuk sopir/kernet, operator produksi, dan kasir POS (antrean sinkron idempoten).
- Portal pemilik mitra (RL-7) dan aplikasi pelanggan (Tahap 2) di balik feature flag.

Kebutuhan lengkap: [`docs/prd/PRD_EQUA_v1_1.md`](docs/prd/PRD_EQUA_v1_1.md). Keputusan manajer proyek:
[`docs/DECISIONS.md`](docs/DECISIONS.md). Arsitektur & konvensi kode: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Panduan tim/agen: [`CLAUDE.md`](CLAUDE.md).

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript strict · pnpm 10 · Drizzle ORM · PostgreSQL
(Neon di produksi, PGlite di dev & uji) · Tailwind CSS v4 + shadcn/ui · Zod 4 · Dexie + Serwist (PWA) · Vitest ·
Playwright · Vercel (region `sin1`).

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
parameter Lampiran B PAR-01..PAR-89, bagan akun, template WA) dan satu akun per karyawan:

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

`db:seed` menolak berjalan bila `VERCEL_ENV=production`.

### Basis data

- Skema Drizzle: `src/db/schema/` (satu berkas per modul + `core.ts`). Pengerasan DB (`src/db/sql/hardening.sql`):
  trigger menolak DELETE/TRUNCATE pada semua tabel bisnis dan UPDATE/DELETE pada `audit_logs`, `access_logs`,
  `domain_events` — diterapkan otomatis oleh `db:push`, `db:migrate`, dan harness uji.
- Uji memakai PGlite in-memory dari snapshot yang di-cache (`tests/helpers/db.ts`: `createTestDb()` / `useTestDb()`).
- Produksi (Neon): `pnpm db:generate` (migrasi SQL ke `drizzle/`) lalu `DB_DRIVER=neon DATABASE_URL=… pnpm db:migrate`.

## Perintah

| Perintah | Fungsi |
|---|---|
| `pnpm dev` | Server pengembangan |
| `pnpm build` / `pnpm start` | Build produksi / jalankan hasil build |
| `pnpm typecheck` | Pemeriksaan tipe (`tsc --noEmit`) |
| `pnpm lint` | ESLint (flat config, next core-web-vitals + TypeScript) |
| `pnpm test` / `pnpm test:watch` | Uji unit & integrasi Vitest (PGlite in-memory, tanpa layanan luar) |
| `pnpm test:e2e` | Uji end-to-end Playwright (membangun & menjalankan aplikasi otomatis; `E2E_DEV=1` memakai `pnpm dev`) |
| `pnpm db:push` | Dorong skema Drizzle ke DB dev + trigger pengerasan (`--force` untuk perubahan yang menghapus data) |
| `pnpm db:seed` | Isi data demo & data awal (idempoten) |
| `pnpm db:generate` | Bangkitkan migrasi SQL produksi (`drizzle/`) |
| `pnpm db:migrate` | Terapkan migrasi `drizzle/` + trigger pengerasan (produksi/staging) |
| `pnpm trace` | Cakupan uji per user story / kriteria penerimaan |

Definisi selesai: `pnpm typecheck && pnpm lint && pnpm test` hijau (docs/DECISIONS.md D-06).

## Struktur

```
src/
  app/            rute Next.js — (auth) (office) (field) (portal) (customer) + api/
  db/             client.ts (getDb), schema/ (satu berkas per modul), seed/
  server/         kode server saja — core/ (platform inti) & modules/ (m1..m12, p2, p3)
  client/         kode peramban saja — Dexie, worker sinkron, kamera, geolokasi
  components/     ui/ (shadcn), shared/, field/
  lib/            isomorfik — time (WIB), money (rupiah), ids (UUID v7), geo, labels, env
tests/            Vitest — tests/<modul>/*.test.ts
e2e/              Playwright — skenario P-01..P-07 (`*.mobile.spec.ts` untuk PWA lapangan)
scripts/, tools/  skrip CLI (db:push, db:seed, trace)
docs/             PRD, arsitektur, keputusan, panduan pengguna
```

## Deploy

Vercel (Hobby untuk pilot) + Neon dari Vercel Marketplace. Set env produksi sesuai `.env.example`
(`DB_DRIVER=neon`, `DATABASE_URL`, `SESSION_SECRET`, `CRON_SECRET`, `GPS_INGEST_TOKEN`, dst.). Pekerjaan terjadwal:
Vercel Cron harian (`vercel.json`) sebagai cadangan dan GitHub Actions tiap 5 menit (`.github/workflows/cron.yml`,
butuh secret `CRON_SECRET` dan `APP_URL`).
