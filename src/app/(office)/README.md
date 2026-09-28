# (office) — web kantor

Daring; Server Components + Server Actions; sesi web + 2FA. Satu folder per modul dengan URL berbahasa Indonesia
(`/beranda`, `/master/*`, `/pesanan`, `/jadwal`, `/kas/*`, `/piutang/*`, `/laporan/*`, `/akuntansi/*`, `/armada/*`, …).
Peta rute lengkap: `docs/ARCHITECTURE.md` §9.

- `layout.tsx` merender `OfficeShell` (`src/components/shared/office-shell.tsx`): sidebar dari registri
  `src/components/shared/nav/registry.ts` (disaring izin), topbar (lonceng notifikasi, kotak persetujuan, menu pengguna),
  breadcrumb otomatis dari registri.
- `_shell-data.ts` → `getOfficeShellData()` masih **placeholder** (`TODO(auth)`): pengguna demo hanya bila
  `NODE_ENV !== "production"`; di produksi `null` → layout mengarahkan ke `/masuk`. Agen auth (M10) menggantinya dengan
  sesi nyata + izin RBAC + hitungan lencana, dan mengisi `signOutAction`.
- Halaman rincian dapat menimpa label breadcrumb terakhir: `<OfficeBreadcrumbLabel label="P-26-000123" />`.
- Rute baru WAJIB ditambahkan (append) ke registri nav + `pnpm tsx tools/gen-nav-permissions.ts`.
- Demo visual komponen (dev saja): `/ui-kit`, `/ui-kit/kantor`, `/ui-kit/lapangan`, `/ui-kit/pos`, `/ui-kit/auth`.
