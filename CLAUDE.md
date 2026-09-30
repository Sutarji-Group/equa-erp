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

## Catatan teknis model data (F2)
- Skema: `src/db/schema/<modul>.ts` (+ `core.ts`, `_columns.ts`), di-reexport `index.ts`. Impor di dalam skema memakai
  jalur RELATIF (drizzle-kit CLI). `core.ts` tidak mengimpor berkas modul; enum yang dipakai > 1 modul ada di `core.ts`;
  tabel modul lain hanya dirujuk di callback lazy (`.references(() => …)`, `relations()`). SATU `relations()` per tabel,
  di berkas pemilik tabel (tipe Drizzle tidak menggabungkan beberapa deklarasi).
- Konvensi kolom: `pk()` (uuid v7), `timestamps()`, `createdBy()`, `money()` (bigint rupiah), `liters()`, `businessDate()`
  ('YYYY-MM-DD' WIB), `fieldMeta()` (device_time, synced_at, sync_command_id, recorded_by_office, late_sync,
  clock_skew_flagged). Nilai enum = `src/lib/labels.ts` (`pgEnum(nama, enumValues(nama))`).
- Unik multi-kolom WAJIB `uniqueIndex()` (bukan `unique()`), dan nama FK > 63 karakter WAJIB `foreignKey({ name })` —
  agar `pnpm db:push` idempoten. Setelah mengubah skema: `pnpm typecheck && pnpm test` (snapshot uji dibangun ulang).
- DB menolak DELETE/TRUNCATE tabel bisnis dan UPDATE/DELETE `audit_logs`/`access_logs`/`domain_events`
  (`src/db/sql/hardening.sql`, SQLSTATE `EQ001`/`EQ002`, `isHardeningViolation()`); job retensi memakai `withRetentionPurge()`.
  Tambahan tinjauan skema S0: UPDATE ledger/alokasi ditolak (`EQ002`), kolom imutabel transaksi (`EQ003`, daftar kolom
  per tabel di `IMMUTABLE_COLUMN_GUARDS`, src/db/hardening.ts), jurnal terposting seimbang saat COMMIT (`EQ004`), periode
  Ditutup/Dikunci (`EQ005`), sebelum cut-over (`EQ006`). FK komposit tenant NFR-30 (`TENANT_FOREIGN_KEYS`) dikelola
  hardening.sql, bukan drizzle-kit. Tabel anak ber-`tenant_id` (mis. `device_usage_logs`) WAJIB diisi dari induknya.
  DB dev lama: `pnpm db:push` menjalankan `src/db/sql/pre-push.sql` dulu (kolom NOT NULL baru).
- Uji DB: `useTestDb({ seed?: boolean })` atau `createTestDb()` dari `tests/helpers/db.ts` (PGlite dari snapshot cache,
  ±1 detik). Data seed: ID deterministik `seedId(kunci)` + pembantu `userIdByUsername`, `outletId`, `truckId`,
  `customerId`, `productId`, … dari `@/db/seed`.

## Catatan teknis platform inti (F3a)
- Semua di `src/server/core/` (`server-only`). Impor per berkas: `@/server/core/{db,context,errors,numbering,params,flags,audit,access-log,events,storage,jobs,wa,maps,ledger,actor}`,
  `@/server/core/rbac` (authorize, lingkup, `sod`), `@/server/core/approvals`, `@/server/core/notifications`, `@/server/core/export`.
- Pola layanan: `await authorize(ctx, "m2.order.create")` SEBELUM transaksi → `parseInput(schema, input, labels)` →
  `runService(ctx, opts, async (tx) => { sod.assert…; tulis; await audit.record(tx, …); await emit(tx, …) })`.
  Fungsi yang boleh dipanggil dari transaksi modul lain menerima `opts?: { tx?: Tx }` (PGlite = satu koneksi: di dalam
  transaksi JANGAN memakai `getDb()`). Penolakan (`ForbiddenError`) dicatat ke `access_logs` otomatis.
- Registrasi modul: isi `src/server/modules/<modul>/{events,approvals,sync,jobs,reports}.ts` — daftarkan HANYA di dalam
  fungsi `register*()` (bukan top-level). `ensureBootstrapped()` menjalankannya sekali per proses (dipanggil `emit`,
  approvals, jobs, export, `getActorContext`).
- Katalog bersama (hanya tambah): izin `rbac/permissions.ts` (kolom `roles` = matriks), event `events.types.ts`,
  persetujuan `approvals/registry.ts`, notifikasi `notifications/catalog.ts`, parameter `params-registry.ts`, flag
  `flags.ts` (`FLAG_REGISTRY`), jenis nomor `numbering.ts` (`DOC_TYPES`).
- Uji: `tests/helpers/context.ts` (`testContext`, `seededContext("pemilik")`), `tests/helpers/factories.ts`
  (`createTestUser(db, { roles, scope })`). Aktor route handler: `getActorContext(request)` — resolver dipasang F3c lewat
  `setActorResolver` (sampai itu `null` → 401).

## Catatan teknis F3c & perubahan pasca-tinjauan
- Rincian API: `docs/dev/sprint0-notes.md` bagian "F3c" dan "Perubahan pasca-tinjauan". KOREKSI catatan F3a di atas:
  resolver pelaku SUDAH dipasang F3c (`getActorContext(request)` → cookie web kantor / token perangkat).
- Halaman modul kantor WAJIB `requirePermission("<izin nav>")` (layout hanya memeriksa sesi). Kasir toko hanya POS (D-07).
- `nextNumber(tx, type, ctxBusinessDate(ctx), { tenantId })`, `params.get(tx, key, ctxBusinessDate(ctx))`, `notify(tx, { tenantId, … })`,
  `postJournal/postFromMapping(tx, { tenantId, … })` — tenant & tanggal bisnis WAJIB.
- Handler event terisolasi savepoint secara bawaan (`on(type, fn, { name: "<modul>:<tujuan>", isolate })`); handler
  sinkron: `DomainError` = ditolak final, galat lain = retry, `{ status: "conflict" }` untuk tabrakan kantor; izin
  bersyarat kernet lewat `conditions`. Kolom lapangan: `{ ...fieldMetaValues(meta) }`.
- `getDb()` di dalam `withTx` melempar galat di dev/uji — selalu teruskan `tx`. Savepoint: `withSavepoint(tx, fn)`.
- Perintah sinkron terikat sesi PIN + ditandatangani (klien `enqueue` otomatis). Uji modul lapangan: `tests/helpers/field.ts`
  (`fieldDevice`, `signedCommand`), data: `tests/helpers/fixtures.ts`, registrasi: `bootstrapForTests()`.
- Lampiran: daftarkan akses baca per objek (`registerAttachmentAccess`) di `src/server/modules/<modul>/audit.ts`.
- Rute lapangan/kantor: `src/lib/field-routes.ts`. E2E `next start` memakai `ALLOW_DEV_SECRETS=1` (rahasia dev ditolak di produksi).

## Alur Git (D-16)
- `main` = produksi, `development` = staging/UAT. Keduanya dilindungi: **tanpa push langsung**, perubahan lewat PR.
- Kerja baru: branch dari `development` (`feature/*`, `fix/*`, `docs/*`, sesi agen `claude/*`) → PR ke `development`.
  Rilis: PR `development` → `main` (merge commit) + tag `vX.Y.Z`; hotfix: `hotfix/*` dari `main` → PR ke `main`, lalu
  `main` digabung kembali ke `development`. Rincian: `CONTRIBUTING.md`.
