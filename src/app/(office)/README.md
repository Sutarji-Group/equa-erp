# (office) — web kantor

Daring; Server Components + Server Actions; sesi web + 2FA. Satu folder per modul dengan URL berbahasa Indonesia
(`/beranda`, `/master/*`, `/pesanan`, `/jadwal`, `/kas/*`, `/piutang/*`, `/laporan/*`, `/akuntansi/*`, `/armada/*`, …).
Peta rute lengkap: `docs/ARCHITECTURE.md` §9.

- `layout.tsx` merender `OfficeShell` (`src/components/shared/office-shell.tsx`): sidebar dari registri
  `src/components/shared/nav/registry.ts` (disaring izin), topbar (lonceng notifikasi, kotak persetujuan, menu pengguna),
  breadcrumb otomatis dari registri.
- `layout.tsx` memanggil `requireOfficeSession()` (sesi nyata; /masuk bila belum masuk/sesi habis, /masuk/2fa bila
  menunggu 2FA) lalu `_shell-data.ts` → `getOfficeShellData(session)`: izin RBAC, hitungan persetujuan & notifikasi,
  pratinjau notifikasi, feature flag; keluar = `POST /keluar`.
- Halaman modul WAJIB: `const { ctx, user, permissions } = await requirePermission("<izin nav halaman itu>")` dari
  `@/server/core/auth/office` — layout HANYA memeriksa sesi, bukan izin, jadi halaman tanpa `requirePermission` dapat
  dibuka lewat URL oleh pengguna kantor mana pun. `requireOfficeSession()` saja hanya untuk halaman milik semua pengguna
  kantor (beranda, notifikasi, preferensi notifikasi). Server Action: `"use server"` + `requireOfficeSession()` +
  layanan modul (yang memanggil `authorize`) + `revalidatePath`.
- Halaman rincian dapat menimpa label breadcrumb terakhir: `<OfficeBreadcrumbLabel label="P-26-000123" />`.
- Rute baru WAJIB ditambahkan (append) ke registri nav + `pnpm tsx tools/gen-nav-permissions.ts`.
- Demo visual komponen (dev saja): `/ui-kit`, `/ui-kit/kantor`, `/ui-kit/lapangan`, `/ui-kit/pos`, `/ui-kit/auth`.
