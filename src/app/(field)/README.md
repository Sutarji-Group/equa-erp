# (field) — PWA lapangan (offline-first)

Rute: `/aktivasi-perangkat`, `/sopir/**` (M3), `/produksi/**` (M8), `/pos/**` (M6/M7). Halaman client-side: perangkat
terdaftar (token JWT perangkat) + login PIN (online/offline), tanpa cookie. Aksi dicatat ke outbox Dexie lalu
disinkronkan (`src/client/offline`, `docs/ARCHITECTURE.md` §7).

- `layout.tsx`: tema kontras tinggi `data-theme="field"`, manifest `/lapangan.webmanifest`, pendaftaran service worker
  (`/serwist/sw.js`, sumber `src/app/sw.ts`).
- Beranda: `<FieldHomePage home="/sopir" title="…">…isi modul…</FieldHomePage>` (`src/components/field/field-home.tsx`)
  = `FieldGate` (aktivasi, PIN, kunci layar PAR-37, worker sinkron, hapus jarak jauh) + `FieldShell` + daftar status
  data + "Kirim data uji". Di dalamnya pakai `useFieldSession()`, `enqueue`, `useReference`, `useSyncStatus`.
- Uji e2e: `e2e/*.mobile.spec.ts` (proyek Playwright `mobile`), DB disiapkan `pnpm e2e:prepare`.
