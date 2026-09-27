# (field) — PWA lapangan (offline-first)

Rute: `/sopir/**` (M3), `/produksi/**` (M8), `/pos/**` (M6/M7). Login PIN + perangkat terdaftar; aksi dicatat ke
outbox Dexie lalu disinkronkan (`docs/ARCHITECTURE.md` §7).

`layout.tsx` memasang tema kontras tinggi `data-theme="field"` (teks dasar 18px, lihat `src/app/globals.css`).
Komponen lapangan (tombol besar, input angka) ditempatkan di `src/components/field/`. Uji e2e: `e2e/*.mobile.spec.ts` (proyek Playwright `mobile`).
