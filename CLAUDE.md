# EQUA ERP — Panduan untuk Tim Pengembang & Agen

Produk: Program Digitalisasi Terpadu EQUA (usaha air truk, depot isi ulang, toko, dua sumber air di Cianjur).
Kebutuhan: `docs/prd/PRD_EQUA_v1_1.md` (baca bab modul yang Anda kerjakan + Bab 5, 6, Lampiran B).
Keputusan manajer proyek: `docs/DECISIONS.md`. Arsitektur & konvensi: `docs/ARCHITECTURE.md` (WAJIB dibaca sebelum menulis kode).

## Stack
Next.js 16 App Router · TypeScript strict · pnpm · Drizzle ORM · Postgres (Neon prod / PGlite dev & test) ·
Tailwind v4 + shadcn/ui · Zod · Dexie (IndexedDB) + Serwist (PWA) · Vitest · Playwright · Vercel.

## Perintah
- `pnpm install` — pasang dependensi
- `pnpm dev` — server dev (PGlite lokal di `.data/`, tanpa setup DB)
- `pnpm typecheck` · `pnpm lint` · `pnpm test` (Vitest) · `pnpm test:e2e` (Playwright) · `pnpm build`
- `pnpm db:push` (dorong skema ke DB dev) · `pnpm db:seed` (data demo) · `pnpm db:generate` (migrasi SQL produksi)
- `pnpm trace` — cakupan uji per user story / kriteria penerimaan

## Aturan yang tidak boleh dilanggar
1. **Teks antarmuka Bahasa Indonesia** dengan istilah lapangan PRD (rit, setor, tempo, galon, tutup kas). Pesan kesalahan berisi tindakan, tanpa kode teknis.
2. **Identifier kode bahasa Inggris** sesuai glosarium `docs/ARCHITECTURE.md` §4. Jangan membuat sinonim baru.
3. **Tidak ada penghapusan data bisnis.** Koreksi = transaksi pembalik beralasan; master = nonaktifkan.
4. **Semua mutasi lewat fungsi layanan** `fn(ctx, input)`: `authorize` → validasi Zod → aturan bisnis + pemisahan tugas → transaksi → `audit.record` → `events.emit`.
5. **Ambang/angka aturan dari parameter** (`params.get(tx,'PAR-xx', date)`), tidak ditanam di kode.
6. **Uang = integer rupiah**, volume = integer liter, waktu disimpan UTC (`timestamptz`), tanggal bisnis = tanggal WIB (`src/lib/time.ts`).
7. **Sistem menolak, bukan memperingatkan** untuk pelanggaran pemisahan tugas (FR-M10-03) — kecuali PRD menyebut "peringatan".
8. Aksi lapangan (sopir, POS, produksi) **harus berfungsi offline** lewat outbox sinkron idempoten.
9. Uji memakai PGlite in-memory; **judul uji memuat ID user story/KP** (mis. `US-M4-02 KP-4 …`).
10. Jangan ubah/rename isi berkas bersama (`src/server/core/**`, `src/db/schema/core.ts`, registri nav, labels, matriks RBAC, katalog event) — hanya tambahkan. Laporkan setiap tambahan.

## Definisi selesai
Lihat `docs/DECISIONS.md` D-06. `pnpm typecheck && pnpm lint && pnpm test` harus hijau sebelum commit.

## Catatan teknis scaffold (Sprint 0)
- Next.js 16 berbeda dari data latih: baca panduan di `node_modules/next/dist/docs/` sebelum memakai API Next (lihat `AGENTS.md`).
  `middleware` → `src/proxy.ts`; Turbopack bawaan untuk `dev` & `build`; `next build` menjalankan `tsc` atas seluruh proyek (termasuk `tests/`).
- DB: `getDb()` / `setDbForTests()` / `createPgliteDb()` di `src/db/client.ts`. PGlite berkas (`.data/pglite`) hanya boleh dibuka satu proses — hentikan `pnpm dev` sebelum `pnpm db:push`/`db:seed`.
- Komponen shadcn/ui di `src/components/ui/` (gaya new-york, Tailwind v4, Radix `radix-ui`). Registri shadcn tidak dapat diakses dari mesin agen; komponen baru disalin manual dari repo shadcn-ui (`apps/v4/registry/new-york-v4/ui/`).
- Pustaka isomorfik: `@/lib/time` (WIB), `@/lib/money` (rupiah), `@/lib/ids` (UUID v7), `@/lib/geo`, `@/lib/labels`, `@/lib/env` (server).
