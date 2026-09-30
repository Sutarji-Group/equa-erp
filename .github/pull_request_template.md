## Ringkasan

<!-- Apa yang berubah dan mengapa. Rujuk US/KP, BR, NFR, butir backlog (B-xx) atau keputusan (D-xx). -->

## Tujuan branch

- [ ] `development` (fitur/perbaikan biasa)
- [ ] `main` (rilis `vX.Y.Z` dari `development`, atau `hotfix/*`)

## Daftar periksa

- [ ] `pnpm typecheck && pnpm lint && pnpm test` hijau (CI "Typecheck, lint, test")
- [ ] Uji baru/diubah memuat ID user story/KP di judul (CLAUDE.md aturan 9)
- [ ] Teks antarmuka Bahasa Indonesia; pesan galat berisi tindakan, tanpa kode teknis
- [ ] Perubahan skema disertai migrasi aditif (`pnpm db:generate`) dan `tests/db/migrations` lulus
- [ ] Berkas bersama (`src/server/core/**`, katalog, RBAC, nav, labels) hanya ditambah — dilaporkan di bawah
- [ ] `CHANGELOG.md` bagian `[Belum dirilis]` diperbarui bila perilaku berubah
- [ ] E2E tersentuh dijalankan (wajib untuk PR rilis ke `main`: `pnpm test:e2e` penuh + skenario)

## Catatan untuk reviewer / UAT

<!-- Langkah uji di staging, data uji, risiko, perubahan parameter bawaan (CHANGED_DEFAULTS), migrasi. -->
