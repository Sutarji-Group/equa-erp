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
> `pnpm db:seed`.

## Perintah

| Perintah | Fungsi |
|---|---|
| `pnpm dev` | Server pengembangan |
| `pnpm build` / `pnpm start` | Build produksi / jalankan hasil build |
| `pnpm typecheck` | Pemeriksaan tipe (`tsc --noEmit`) |
| `pnpm lint` | ESLint (flat config, next core-web-vitals + TypeScript) |
| `pnpm test` / `pnpm test:watch` | Uji unit & integrasi Vitest (PGlite in-memory, tanpa layanan luar) |
| `pnpm test:e2e` | Uji end-to-end Playwright (membangun & menjalankan aplikasi otomatis; `E2E_DEV=1` memakai `pnpm dev`) |
| `pnpm db:push` | Dorong skema Drizzle ke DB dev |
| `pnpm db:seed` | Isi data demo & data awal |
| `pnpm db:generate` | Bangkitkan migrasi SQL produksi (`drizzle/`) |
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
