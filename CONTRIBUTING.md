# Alur kerja Git & rilis EQUA ERP

Keputusan: [`docs/DECISIONS.md`](docs/DECISIONS.md) D-16. Aturan penulisan kode: [`CLAUDE.md`](CLAUDE.md) dan
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Langkah deploy: [`docs/deploy/README.md`](docs/deploy/README.md).

## Branch & lingkungan

| Branch | Fungsi | Deploy Vercel | Basis data Neon | Siapa yang menggabung |
|---|---|---|---|---|
| `main` | **Produksi** — hanya kode yang lulus UAT di staging | Production (domain utama, mis. `erp.equa.co.id`) | branch Neon utama (data nyata) | pemilik repositori / PM, lewat PR dari `development` atau `hotfix/*` |
| `development` | **Staging / UAT** — integrasi sebelum rilis | Preview dengan alamat tetap (mis. `staging.erp.equa.co.id`) | branch Neon `development` (data uji tersamar, NFR-27) | tim, lewat PR dari branch kerja |
| `feature/*`, `fix/*`, `docs/*`, `claude/*` | Pekerjaan harian, satu topik per branch | Preview per PR (otomatis, sementara) | ikut DB staging | — |
| `hotfix/*` | Perbaikan darurat produksi | Preview per PR | ikut DB staging | — |

Aturan:
1. **Tidak ada push langsung ke `main` atau `development`** — selalu lewat Pull Request (dilindungi branch protection).
2. Setiap PR wajib lulus check CI **"Typecheck, lint, test"** (`.github/workflows/ci.yml`). PR ke `main` wajib satu
   persetujuan reviewer.
3. Branch kerja dibuat dari `development` terbaru dan dihapus setelah digabung.
4. Judul commit/PR mengikuti gaya yang sudah dipakai: `feat(m4): …`, `fix(ci): …`, `docs(pm): …`, `chore(release): …`.
   Uji yang menambah/mengubah perilaku memuat ID user story/KP di judulnya (CLAUDE.md aturan 9).
5. Teks antarmuka tetap Bahasa Indonesia; perubahan skema wajib disertai migrasi (`pnpm db:generate`, aditif).

## Alur harian

```bash
git switch development && git pull
git switch -c feature/m2-slot-pengiriman        # satu topik per branch
# … kerjakan, uji lokal:
pnpm typecheck && pnpm lint && pnpm test
git push -u origin feature/m2-slot-pengiriman   # buka PR → development
```

PR ke `development` → CI hijau → review → **Squash/merge** → Vercel otomatis men-deploy staging → uji di staging.

## Rilis ke produksi

1. Pastikan `development` hijau dan lulus UAT/uji asap di staging (daftar periksa `docs/deploy/README.md` §8–§9).
2. Di `development`: naikkan versi `package.json`, pindahkan isi `## [Belum dirilis]` di `CHANGELOG.md` ke bagian
   versi baru, perbarui catatan rilis pengguna (`docs/RELEASE_NOTES_v*.md`) — lewat PR `chore(release): vX.Y.Z`.
3. Buka PR **`development` → `main`** berjudul `Rilis vX.Y.Z` (gunakan **merge commit**, bukan squash, agar riwayat
   kedua branch tetap sejajar).
4. Setelah digabung, beri tag pada commit gabungan di `main` dan push tag:
   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "EQUA ERP vX.Y.Z"
   git push origin vX.Y.Z
   ```
5. Vercel men-deploy produksi dari `main`. Jalankan migrasi & langkah pasca-rilis di jendela pemeliharaan PAR-86
   (`docs/deploy/README.md` §8). Rollback: *Instant Rollback* Vercel ke deploy sebelumnya.

Penomoran versi: [Semantic Versioning](https://semver.org/lang/id/) — `PATCH` perbaikan, `MINOR` fitur baru yang
kompatibel, `MAJOR` perubahan yang memutus kompatibilitas (mis. protokol sinkron lapangan).

## Hotfix darurat

```bash
git switch main && git pull
git switch -c hotfix/tutup-kas-selisih
# … perbaiki + uji regresi, naikkan versi PATCH + CHANGELOG
# PR hotfix/* → main (review + CI), lalu tag vX.Y.Z+1
```

Setelah hotfix digabung ke `main`, **segera** gabungkan `main` kembali ke `development` (PR `main` → `development`)
agar perbaikan tidak hilang pada rilis berikutnya.

## Pengaturan satu kali (admin repositori)

GitHub:
1. **Settings → General → Default branch** = `main`. (Workflow terjadwal `.github/workflows/cron.yml` hanya berjalan
   dari branch bawaan.)
2. **Settings → Branches → Add branch ruleset / protection** untuk `main` dan `development`:
   *Require a pull request before merging* (untuk `main`: *Require approvals* = 1), *Require status checks to pass* →
   pilih **"Typecheck, lint, test"**, *Block force pushes*, *Restrict deletions*.
3. **Settings → General → Pull Requests**: aktifkan *Automatically delete head branches*.

Vercel:
1. **Settings → Git → Production Branch** = `main`.
2. **Settings → Environment Variables**: variabel **Production** untuk produksi; variabel **Preview** yang dibatasi ke
   branch `development` (Vercel: *Preview → Select a custom Git branch*) memakai `DATABASE_URL` branch Neon
   `development` dan rahasia yang **berbeda** dari produksi.
3. **Settings → Domains**: tambah `staging.<domain>` → *Git Branch* = `development`.

Neon: buat branch `development` dari branch utama (lalu samarkan data pribadi: `pnpm db:mask -- --yes`, NFR-27; runbook §samarkan data uji) atau isi ulang
dengan `pnpm db:migrate && pnpm db:seed`, lalu hubungkan ke lingkungan Preview Vercel.
