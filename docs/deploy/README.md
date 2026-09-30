# Deploy EQUA ERP ke Vercel (produksi)

Dokumen ini untuk **tim IT / admin sistem**. Urutan di bawah membawa basis data produksi dari **kosong** ke siap
go-live (D-12 butir 4: produksi dimulai dari DB kosong saat cut-over). Operasional harian (insiden, cadangan, rotasi
rahasia, perangkat hilang) ada di [`docs/ops/runbook.md`](../ops/runbook.md); cut-over data ada di
[`docs/uat/cutover.md`](../uat/cutover.md).

| Komponen | Layanan | Catatan |
|---|---|---|
| Aplikasi (web kantor, PWA lapangan/POS, portal, API) | **Vercel**, region fungsi **`sin1` (Singapura)** | `vercel.json` (`regions`, install/build, Vercel Cron harian) |
| Basis data | **Neon Postgres** lewat **Vercel Marketplace**, region **AWS ap-southeast-1 (Singapura)**, `DB_DRIVER=neon` | Skema = migrasi `drizzle/` + `src/db/sql/hardening.sql` |
| Berkas (foto bukti kirim, meter, nota, slip) | **Vercel Blob** | Tanpa token = adaptor lokal (hanya dev) |
| E-mail (ringkasan harian, faktur/pernyataan piutang, titik jangkar audit) | **Resend** + domain pengirim terverifikasi | Tanpa kunci = e-mail hanya dicatat log / `mailto:` |
| Web Push | **VAPID** (kunci sendiri) | Notifikasi kantor & aplikasi pelanggan |
| Pekerjaan terjadwal | Vercel Cron (harian) + **GitHub Actions tiap 5 menit** atau **Upstash QStash** | `/api/cron/tick`, `Authorization: Bearer $CRON_SECRET` |
| Pemantau uptime eksternal | GitHub Actions job `monitor` (`scripts/uptime-monitor.sh`) | Berjalan di LUAR Vercel (NFR-28) |

> **Penyimpangan region yang disadari (D-01, NFR-26 / K5).** PRD meminta region Jakarta. Vercel dan Neon tidak punya
> region Jakarta, sehingga dipakai **Singapura** (`sin1` / `aws-ap-southeast-1`) — region terdekat. Data & cadangan
> berada di luar Indonesia; ini tercatat sebagai risiko **RP-14** ([`docs/uat/risiko.md`](../uat/risiko.md)) untuk
> komite pengarah & konsultan hukum (UU PDP). Arsitektur portabel (Postgres standar, adaptor penyimpanan) sehingga
> dapat dipindah ke GCP Jakarta (Cloud SQL + Cloud Run, `DB_DRIVER=pg`) bila kepatuhan mengharuskan — lihat §10.

---

## 1. Prasyarat

- Akun Vercel (Hobby cukup untuk pilot; **Pro saat go-live** — D-01), akses admin repositori GitHub.
- Node ≥ 22.12 dan pnpm 10 di laptop admin (untuk migrasi & seed dari mesin admin).
- Domain milik usaha (mis. `erp.equa.co.id`) dengan akses DNS — untuk HTTPS & pengirim e-mail Resend.
- `openssl` (membuat rahasia) dan `pnpm dlx web-push` (membuat kunci VAPID).

## 2. Proyek Vercel

1. Vercel → **Add New… → Project** → impor repositori ini. Framework terdeteksi **Next.js**; perintah install & build
   diambil dari `vercel.json` (`pnpm install --frozen-lockfile`, `pnpm build`). Node.js 22.
2. **Settings → Functions → Region**: pastikan **Singapore (sin1)** (sudah dipaksa `vercel.json` → `regions`).
3. **Settings → Git**: cabang produksi = cabang rilis (mis. `main`). Setiap PR mendapat deploy **Preview**.
4. Jangan deploy produksi sebelum §3–§6 selesai (aplikasi menolak berjalan tanpa rahasia produksi — fail-closed).

## 3. Basis data Neon (Vercel Marketplace)

1. Proyek Vercel → **Storage → Create Database → Neon** (Marketplace). Region **AWS Asia Pacific (Singapore)
   `aws-ap-southeast-1`**. Hubungkan ke lingkungan **Production** (dan buat **branch Neon terpisah untuk Preview** —
   jangan pernah memakai DB produksi untuk preview/uji, NFR-27).
2. Integrasi mengisi env `DATABASE_URL` (koneksi *pooled*) dan biasanya `DATABASE_URL_UNPOOLED` (langsung). Aplikasi
   memakai `DATABASE_URL`. Tambahkan sendiri **`DB_DRIVER=neon`** (Production & Preview).
3. Paket Neon: pilih paket dengan **riwayat pemulihan titik-waktu (PITR) ≥ 7 hari** untuk go-live — ini dasar RPO 1 jam
   (NFR-14). Paket gratis hanya menyimpan riwayat singkat; cukup untuk pilot, tidak untuk produksi.
   Kapasitas hasil uji beban 3× volume ([`docs/qa/uji-beban.md`](../qa/uji-beban.md)): ±25 MB/hari (±9 GB/tahun) →
   paket dengan penyimpanan **≥ 20 GB**; komputasi **tanpa scale-to-zero pada jam operasi 05.00–22.00 WIB**; aplikasi
   selalu memakai koneksi *pooled*. Sebelum pilot, ukur latensi di branch Neon terpisah (`DB_DRIVER=neon
   DATABASE_URL=… pnpm perf:generate` lalu `pnpm perf:measure`; RP-25).
4. **Migrasi dari laptop admin** (urutan resmi, idempoten — aman diulang):

   ```bash
   # pakai koneksi langsung (unpooled) untuk DDL; salin dari dashboard Neon / env Vercel
   export DB_DRIVER=neon
   export DATABASE_URL='postgresql://…/neondb?sslmode=require'

   pnpm install --frozen-lockfile
   pnpm db:migrate          # drizzle/0000_baseline_v1.sql (+ migrasi berikutnya) → hardening.sql
   pnpm db:verify           # katalog DB = PGlite segar hasil migrasi (harus "IDENTIK")
   pnpm db:seed:prod        # parameter Lampiran B, tenant EQUA, bagan akun & pemetaan, template + akun pertama
   ```

   - `db:migrate` = migrasi SQL `drizzle/` (tabel jurnal `drizzle.__drizzle_migrations`) **lalu** trigger pengerasan
     (tanpa DELETE, append-only, kolom imutabel, penjaga jurnal, FK komposit tenant). `src/db/sql/pre-push.sql` TIDAK
     dipakai di produksi (hanya DB dev lama `pnpm db:push`).
   - `db:seed:prod` TANPA data demo. Akun pertama **pemilik** & **admin sistem** dibuat interaktif (kata sandi tidak
     tampil) atau lewat argumen + env:

     ```bash
     EQUA_OWNER_PASSWORD='…sementara…' EQUA_ADMIN_PASSWORD='…sementara…' pnpm db:seed:prod -- \
       --owner-username pemilik --owner-name "Nama Pemilik" --owner-phone 62812xxxxxxx \
       --admin-username admin.it --admin-name "Nama Admin Sistem" --yes
     ```

     Kata sandi sementara ≥ 10 karakter; saat login pertama pengguna **mendaftarkan 2FA** lalu **wajib mengganti kata
     sandi**. Akun lain dibuat admin sistem di **Akses > Pengguna** dan aktif setelah disetujui pemilik. Seed menolak DB
     yang berisi data demo (`pnpm db:seed` JANGAN pernah dijalankan ke produksi).
   - Gladi bersih lokal tanpa Neon: `PGLITE_DATA_DIR=./.data/pglite-gladi pnpm db:migrate && … db:verify && … db:seed:prod`.
5. **Migrasi berikutnya** (rilis dengan perubahan skema): pengembang menjalankan `pnpm db:generate --name <perubahan>`,
   meng-commit berkas `drizzle/`. Uji `tests/db/migrations.test.ts` gagal bila skema berubah tanpa migrasi. Saat
   rilis: `pnpm db:migrate` → `pnpm db:verify` di jendela pemeliharaan (§7) **sebelum** mempromosikan deploy baru.
   Tulis migrasi *aditif* (kolom baru nullable, tabel baru) agar versi aplikasi sebelumnya tetap berjalan (rollback §8).

## 4. Rahasia & variabel lingkungan

Isi di **Vercel → Settings → Environment Variables**. Sumber kebenaran: `.env.example` (penjelasan) dan
`src/lib/env.ts` (validasi Zod). Aplikasi **menolak berjalan** di produksi/preview bila rahasia bawaan dev dipakai
(`SESSION_SECRET`, `CRON_SECRET`, `GPS_INGEST_TOKEN`) atau PGlite dipakai di produksi.

Pembangkit rahasia:

```bash
openssl rand -base64 48          # SESSION_SECRET (≥ 32 karakter)
openssl rand -hex 32             # CRON_SECRET, GPS_INGEST_TOKEN, WA_WEBHOOK_VERIFY_TOKEN
pnpm dlx web-push generate-vapid-keys   # VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
```

| Variabel | Prod | Preview | Nilai / catatan |
|---|---|---|---|
| `DB_DRIVER` | wajib | wajib | `neon` (produksi menolak `pglite`) |
| `DATABASE_URL` | wajib | wajib (branch Neon preview) | diisi integrasi Neon (pooled) |
| `PGLITE_DATA_DIR` | — | — | hanya dev lokal |
| `APP_URL` | wajib | disarankan | URL publik HTTPS, mis. `https://erp.equa.co.id` (tautan e-mail/WA, pemantau, cron) |
| `SESSION_SECRET` | wajib | wajib (berbeda dari prod) | kunci turunan sesi, **2FA TOTP**, secret perangkat, kode aktivasi, OTP pelanggan, tag titik jangkar audit — rotasi lihat runbook §5 |
| `CRON_SECRET` | wajib | wajib | Bearer `/api/cron/tick` & `/api/monitor/outage`; juga secret GitHub Actions |
| `GPS_INGEST_TOKEN` | wajib | wajib | token vendor GPS → `/api/gps/ingest/<vendor>` |
| `ALLOW_DEV_SECRETS` | **KOSONG** | **KOSONG** | hanya E2E lokal; ditolak di `VERCEL_ENV=production` |
| `E2E_CLOCK_OVERRIDE` | **KOSONG** | **KOSONG** | hanya uji E2E lokal; ditolak di deploy Vercel |
| `BLOB_READ_WRITE_TOKEN` | wajib | wajib | diisi integrasi Vercel Blob (§5) |
| `RESEND_API_KEY` | wajib | opsional | kunci Resend produksi (§5) |
| `EMAIL_FROM` | wajib | opsional | mis. `EQUA <noreply@equa.co.id>` — **domain harus terverifikasi di Resend** (B-77) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | wajib | opsional | pasangan kunci VAPID; ganti = semua langganan push perlu didaftarkan ulang |
| `VAPID_SUBJECT` | wajib | opsional | `mailto:it@equa.co.id` |
| `MAP_ROUTING_PROVIDER` | — | — | bawaan `straight_line_x1_3` (D-10 butir 4; biaya peta 0); `osrm`/`google` opsional |
| `MAP_ROUTING_URL` / `MAP_ROUTING_API_KEY` | bila osrm/google | — | server OSRM / kunci API |
| `WA_PROVIDER` | — | — | `link` (Tahap 1, tautan wa.me). `cloud_api` hanya saat Tahap 2 aktif |
| `WA_CLOUD_TOKEN` / `WA_CLOUD_PHONE_ID` | bila `cloud_api` | — | WhatsApp Cloud API (Meta) |
| `WA_WEBHOOK_VERIFY_TOKEN` / `WA_APP_SECRET` | bila `cloud_api` | — | webhook `/api/customer/webhook/wa` (wajib di produksi bila `cloud_api`) |
| `PAYMENT_GATEWAY` | — | — | `none` (bawaan) / `midtrans` (Tahap 2) |
| `MIDTRANS_SERVER_KEY` / `MIDTRANS_CLIENT_KEY` | bila midtrans | sandbox | webhook `/api/customer/webhook/pembayaran` |
| `MIDTRANS_IS_PRODUCTION` | bila midtrans | `false` | `true` hanya produksi |
| `NODE_ENV`, `VERCEL_ENV`, `NEXT_PHASE` | otomatis | otomatis | diisi platform — jangan diisi manual |

Setelah mengubah env: **Redeploy** (env dibaca saat fungsi mulai).

## 5. Layanan pendukung

**Vercel Blob.** Storage → **Create → Blob** → hubungkan ke Production (dan Preview terpisah). Token
`BLOB_READ_WRITE_TOKEN` terisi otomatis. Pilih region terdekat (Singapura) bila tersedia. Lampiran dilayani lewat
`/api/attachments/[id]` (otorisasi per objek), bukan URL Blob publik.

**Resend (e-mail) — B-77.**
1. Buat API key produksi (akses *sending*), isi `RESEND_API_KEY`.
2. **Domains → Add domain** (mis. `equa.co.id`) → tambahkan catatan DNS (SPF/DKIM, MX pengembalian) → tunggu status
   **Verified**. Isi `EMAIL_FROM` dengan alamat di domain itu.
3. Uji kirim nyata (UAT B-77, [`docs/uat/m5-piutang.md`](../uat/m5-piutang.md)): Admin Keuangan → **Piutang > Faktur**
   → rincian → **Kirim e-mail** (PDF terlampir), dan pernyataan piutang pelanggan. Tanpa kunci, sistem jatuh ke draf
   `mailto:` (dicatat "dibuka", bukan "terkirim").
4. Penerima ringkasan harian & titik jangkar audit: parameter `notifications.digest_recipients` (Pengaturan > Parameter).

**Web Push (VAPID).** Isi tiga variabel VAPID dari pembangkit di §4. Kunci privat jangan pernah dibagikan.

**Vendor GPS.** Berikan ke vendor: URL `https://<domain>/api/gps/ingest/generic-json` (JSON) atau `/osmand`
(OsmAnd/Traccar, `?token=`), dan `GPS_INGEST_TOKEN`. Uji 1 unit (UAT B-47).

## 6. Pekerjaan terjadwal & pemantau uptime

`/api/cron/tick` menjalankan semua job yang jatuh tempo, **idempoten per slot** (`job_runs`) — pemicu ganda aman.

1. **Vercel Cron (harian, cadangan)**: sudah di `vercel.json` (`0 20 * * *` UTC = 03.00 WIB). Vercel otomatis mengirim
   `Authorization: Bearer $CRON_SECRET` bila env `CRON_SECRET` ada.
2. **Tiap 5 menit (wajib)** — pilih salah satu atau keduanya:
   - **GitHub Actions** `.github/workflows/cron.yml` job `tick` (jadwal `*/5 * * * *`, hanya berjalan dari cabang
     bawaan repositori; GitHub dapat menunda beberapa menit saat sibuk).
   - **Upstash QStash** (lebih tepat waktu): *Schedules → Create* → tujuan `https://<domain>/api/cron/tick`, cron
     `*/5 * * * *`, metode GET/POST, header diteruskan `Authorization: Bearer <CRON_SECRET>` (QStash:
     `Upstash-Forward-Authorization`).
3. **Secret & variabel repositori GitHub** (Settings → Secrets and variables → Actions) — **daftar periksa B-85 /
   D-13 butir 4**:

   | Nama | Jenis | Dipakai | Wajib |
   |---|---|---|---|
   | `APP_URL` | secret atau variable | `tick`, `monitor` | ya (tanpa ini job dilewati diam-diam) |
   | `CRON_SECRET` | secret | `tick`; `monitor` (mencatat gangguan pulih ke `/api/monitor/outage`) | ya |
   | `ALERT_WEBHOOK_URL` | secret | `monitor` — POST JSON `{"text": …}` (Slack/Discord/Google Chat/gerbang WA) | salah satu kanal |
   | `RESEND_API_KEY` + `ALERT_EMAIL_TO` | secret (+ secret/variable) | `monitor` — e-mail peringatan lewat Resend | salah satu kanal |
   | `ALERT_EMAIL_FROM` | variable | pengirim e-mail peringatan (domain terverifikasi) | disarankan |

4. **Uji**: Actions → *Cron tick* → **Run workflow** (workflow_dispatch). Job `tick` harus mendapat HTTP 200
   (`{"ok":true,…}`); job `monitor` mencetak `Web kantor EQUA: OK` dan `API sinkron EQUA: OK`. Simulasikan gangguan di
   preview (APP_URL salah) untuk memastikan peringatan benar-benar terkirim, lalu pulihkan (NFR-28 ≤ 5 menit).
5. Di aplikasi, **Akses > Perangkat & sinkron** menampilkan insiden, uptime bulanan (NFR-02, target 99,5%), dan
   pemantauan job (`m10.monitor.health` tiap 5 menit).

## 7. Domain, HTTPS, jendela pemeliharaan

- Vercel → **Settings → Domains** → tambah domain → pasang DNS (A/CNAME sesuai petunjuk). Sertifikat TLS otomatis;
  HTTPS wajib (PWA, service worker, cookie `secure`). Setelah domain aktif: set `APP_URL=https://<domain>` → Redeploy.
- **Jendela pemeliharaan PAR-86: 23.30–04.30 WIB (16.30–21.30 UTC).** Rilis, migrasi, dan rotasi rahasia HANYA di
  jendela ini (NFR-01, NFR-32) — agar tutup kas ≤ 22.00 dan H+0 (≤ 30 menit) tidak terganggu. Gangguan yang
  seluruhnya berada di jendela tercatat sebagai log pemeliharaan (tanpa insiden). Hindari 03.00 WIB tepat (Vercel Cron
  harian) bila migrasi berat.
- Parameter PAR-86 dapat diubah pemilik (Pengaturan > Parameter); pemantau membaca nilai yang berlaku.

## 8. Rilis & rollback (NFR-32)

**Setiap rilis:**
1. CI hijau (`pnpm typecheck && pnpm lint && pnpm test`) + `pnpm build`; E2E (`pnpm test:e2e`) untuk rilis besar.
2. Catatan rilis dalam bahasa pengguna (`docs/RELEASE_NOTES_v*.md`) + entri `CHANGELOG.md`.
3. Deploy ke **Preview** (branch Neon preview) → uji asap (login, satu rit, satu transaksi POS, tutup kas uji).
4. **Uji rollback di preview**: promosikan, lalu *Instant Rollback* ke deploy sebelumnya; aplikasi harus tetap
   berjalan dengan skema baru (migrasi aditif).
5. Di jendela PAR-86: `pnpm db:migrate` → `pnpm db:verify` (produksi) → **Promote to Production**.
6. Verifikasi pasca-rilis (§9). Bila aplikasi lapangan wajib diperbarui: admin sistem menaikkan **versi minimal** di
   **Akses > Perangkat & sinkron** (US-M10-07 KP-4) — perangkat versi lama menahan antrean (tidak hilang) sampai
   diperbarui.

**Rollback aplikasi:** Vercel → Deployments → deploy sebelumnya → **Instant Rollback** (hitungan detik, tanpa build).
Bila versi minimal sempat dinaikkan untuk rilis yang dibatalkan, turunkan kembali di **Akses > Perangkat & sinkron**
agar perangkat yang belum memperbarui tidak tertahan.

**Rollback basis data** (hanya bila migrasi merusak data — jarang, karena migrasi aditif):
1. Hentikan pemicu cron (nonaktifkan workflow / jadwal QStash) dan umumkan pemeliharaan.
2. Neon → **Branches → Create branch from point in time** (sesaat sebelum migrasi) → verifikasi (`pnpm db:verify`
   terhadap skema lama, hitung baris kunci) → jadikan branch utama (*Set as primary* / ganti `DATABASE_URL`).
3. Rollback aplikasi ke deploy yang cocok dengan skema itu → Redeploy → aktifkan cron.
4. Catat di **Akses > Perangkat & sinkron → insiden** (penyebab, durasi) dan data yang perlu dimasukkan ulang.
   Transaksi lapangan yang terkirim setelah titik pemulihan tetap ada di antrean perangkat bila belum dibersihkan —
   minta perangkat **Kirim sekarang** (sinkron idempoten).

## 9. Daftar periksa pra-rilis / go-live

**Infrastruktur**
- [ ] Proyek Vercel region `sin1`; Neon `aws-ap-southeast-1`; Blob terhubung; domain + HTTPS aktif; `APP_URL` = domain.
- [ ] Semua env §4 terisi; `ALLOW_DEV_SECRETS` & `E2E_CLOCK_OVERRIDE` **kosong**; rahasia produksi ≠ preview ≠ dev.
- [ ] `pnpm db:migrate` → `pnpm db:verify` "IDENTIK" → `pnpm db:seed:prod` (akun pemilik & admin sistem dibuat).
- [ ] Paket Neon dengan PITR ≥ 7 hari; uji pemulihan pertama dilakukan & dicatat (runbook §4, NFR-13).
- [ ] Neon: penyimpanan ≥ 20 GB, tanpa scale-to-zero pada jam operasi; latensi diukur dengan `pnpm perf:measure` di branch Neon terpisah (`docs/qa/uji-beban.md`, RP-25).
- [ ] Resend: domain **Verified**, `EMAIL_FROM` di domain itu, uji kirim faktur & pernyataan (B-77).
- [ ] VAPID terisi; uji notifikasi push ke ponsel pemilik.
- [ ] GitHub secrets `APP_URL`, `CRON_SECRET`, `ALERT_WEBHOOK_URL` atau `RESEND_API_KEY`+`ALERT_EMAIL_TO` (B-85);
      *Run workflow* `tick` & `monitor` sukses; peringatan uji diterima tim IT.
- [ ] Vercel Cron harian aktif; job 5 menit berjalan (Akses > Perangkat & sinkron tidak menampilkan "denyut terlambat").
- [ ] Token vendor GPS diberikan; 1 unit mengirim posisi (Armada > Peta truk).

**Aplikasi & data**
- [ ] Pemilik & admin sistem login, mendaftarkan 2FA, mengganti kata sandi sementara.
- [ ] Parameter Lampiran B ditinjau pemilik (Pengaturan > Parameter), terutama PAR-01/02/04/06/10/12/21/86.
- [ ] Data awal diimpor & **ditandatangani** per kelompok (Master > Tanda tangan data awal) — `docs/uat/cutover.md`.
- [ ] Rekening bank: **satu akun buku per rekening** (Kas > Kas kantor; D-12 butir 4 / B-79).
- [ ] Akuntan meninjau pemetaan → pemilik menekan **Aktifkan M11** (Akuntansi > Pemetaan; B-84 / D-13 butir 3).
- [ ] Perangkat lapangan terdaftar & diaktifkan; versi minimal aplikasi ditetapkan (Akses > Perangkat & sinkron).
- [ ] Flag Tahap 2/3 **mati** kecuali gerbang terpenuhi (`docs/uat/gerbang-tahap.md`).
- [ ] Berita acara UAT per modul ditandatangani (`docs/uat/`), 0 cacat Kritis terbuka.
- [ ] Catatan rilis dibagikan ke pengguna (`docs/RELEASE_NOTES_v1.0.md`); panduan per peran tersedia (`docs/guides/`).

**Verifikasi pasca-deploy (5 menit)**
- [ ] `GET /api/health` → `{"ok":true}`; `GET /api/health/sync` → `{"ok":true}` (DB terjangkau).
- [ ] `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/tick` → `ok: true`.
- [ ] Login web kantor; buka Beranda, Kas hari ini, Laporan H+0; satu perangkat lapangan sinkron ("Semua terkirim").

## 10. Pindah ke region Indonesia (bila diwajibkan)

Aplikasi tidak terikat Vercel/Neon: `DB_DRIVER=pg` + `DATABASE_URL` Postgres standar (Cloud SQL Jakarta), jalankan
`pnpm build && pnpm start` di Cloud Run (`NODE_ENV=production`, rahasia wajib sama), penyimpanan berkas lewat adaptor
`src/server/core/storage.ts` (tambah adaptor GCS), cron dari Cloud Scheduler ke `/api/cron/tick`. Data dipindah dengan
`pg_dump`/`pg_restore` di jendela pemeliharaan, lalu `pnpm db:verify` pada DB baru.
