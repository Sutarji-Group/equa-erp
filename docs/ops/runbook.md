# Runbook Operasional EQUA ERP

Untuk **tim IT (admin sistem)**, dengan peran pendamping **pemilik**, **Admin Keuangan**, dan **Dispatcher**. Deploy &
konfigurasi awal: [`docs/deploy/README.md`](../deploy/README.md). Cut-over data: [`docs/uat/cutover.md`](../uat/cutover.md).
Semua tindakan di aplikasi berjejak (Jejak audit tidak dapat diubah/dihapus siapa pun — NFR-11).

| Siapa | Tanggung jawab operasional |
|---|---|
| **Admin sistem (tim IT, 2–3 orang)** | pemantauan, insiden, cadangan & uji pulih, rilis, rotasi rahasia, akun & perangkat, helpdesk (jawab ≤ 1 minggu, PAR-87) |
| **Pemilik** | menyetujui akun/peran/lingkup, keputusan insiden kritis (komunikasi ke unit), tinjauan akses kuartalan, tanda tangan data awal, mengaktifkan M11 & fitur bertahap |
| **Admin Keuangan** | memeriksa "belum terkirim" sebelum menerima setoran, "dicatat kantor" saat perangkat lapangan mati, tutup kas |
| **Dispatcher** | titik kontak pertama sopir (perangkat truk, GPS), menandai truk Perbaikan |
| **Juara lapangan** | pendamping pengguna lapangan pada pilot/perluasan |

Jam layanan helpdesk = jam layanan PAR-07 (05.00–22.00 WIB, setiap hari). Jendela pemeliharaan PAR-86 23.30–04.30 WIB.

---

## 1. Pemantauan rutin

**Otomatis.** Job `m10.monitor.health` (tiap 5 menit lewat `/api/cron/tick`) mendeteksi sinkron gagal massal
(`monitoring.mass_sync_failure`: > 3 perangkat, > 30 menit), jeda denyut layanan (`monitoring.service_down`: > 15 menit
di jam layanan), dan menghitung GPS mati. M12 membuka insiden **GPS mati** (> PAR-25, 15 menit). Pemantau **eksternal**
GitHub Actions (`scripts/uptime-monitor.sh`, tiap 5 menit) memeriksa `/masuk` & `/api/health/sync` dan mengirim
peringatan lewat `ALERT_WEBHOOK_URL` / e-mail Resend (NFR-28) — tetap bekerja saat aplikasi mati.

**Harian (admin sistem, pagi ≤ 07.00 & sore):**
- [ ] **Akses > Perangkat & sinkron**: insiden terbuka (tanggapi ≤ 30 menit), perangkat dengan antrean lama, konflik
      sinkron, "denyut terakhir" < 10 menit, kartu **Uptime bulan ini** (target 99,5%, NFR-02).
- [ ] **Armada > Perangkat GPS**: perangkat Mati/Dicabut.
- [ ] **Akses > Data pribadi → Cadangan**: "Cadangan harian terakhir" hijau (≤ 26 jam, `backup.policy`) — lihat §4.
- [ ] **Bantuan → Kotak helpdesk**: laporan kendala baru (jawab ≤ 1 minggu; yang terlambat diingatkan otomatis).
- [ ] Kotak masuk e-mail: ringkasan harian pemilik (PAR-55, 22.30) & **titik jangkar audit** harian — arsipkan e-mail
      titik jangkar (bukti keutuhan jejak audit di luar DB, dipakai *Verifikasi keutuhan* di Jejak audit).
- [ ] Vercel → Deployments/Logs: galat 5xx berulang; Neon → Monitoring: koneksi & penyimpanan.

**Bulanan:** laporan uptime (`m10.uptime_monthly`) & insiden (`m10.incidents`) ke komite pengarah (NFR-02, NFR-31);
biaya cloud/peta/WA/GPS dicatat sebagai jurnal manual M11 dan dibandingkan anggaran (NFR-29; laporan biaya di
Akuntansi > Laporan).

**Kuartalan:** pemilik menjalankan **Akses > Tinjauan hak akses** (PAR-47); admin sistem menyiapkan daftar akun tanpa
login > 60 hari.

## 2. Insiden (NFR-28, NFR-31)

| Kelas (PRD 11.2) | Contoh | Tanggap | Pulih |
|---|---|---|---|
| **Kritis** | aplikasi/DB tidak dapat diakses di jam layanan; transaksi hilang/dobel; kebocoran data lintas peran/tenant; salah hitung uang | **≤ 30 menit** | **≤ 4 jam** |
| **Mayor** | fungsi M tidak jalan tetapi ada jalan lain berjejak (mis. e-mail gagal → `mailto:`; GPS mati → GPS ponsel cadangan) | ≤ 30 menit | ≤ 1 hari kerja |
| **Minor** | teks, tampilan, ketidaknyamanan | ≤ 1 minggu (helpdesk) | backlog |

Target 30 menit / 4 jam = parameter `monitoring.incident_targets`; waktu tanggap & pulih tiap insiden terukur di
**Akses > Perangkat & sinkron** (laporan `m10.incidents`).

**Alur baku:**
1. **Terima** peringatan (webhook/e-mail pemantau, notifikasi `incident.opened`, telepon Dispatcher/Admin Keuangan).
2. **Tanggapi** di sistem: Akses > Perangkat & sinkron → insiden → *Tanggapi* (≤ 30 menit). Bila aplikasi mati, catat
   jam tanggap manual lalu isi saat aplikasi pulih.
3. **Komunikasikan** ke grup WA operasional: dampak, apa yang tetap jalan (aplikasi lapangan & POS **tetap mencatat
   offline** — jangan beralih ke kertas; tutup kas menunggu), perkiraan pulih. Pemilik diberi tahu untuk Kritis.
4. **Diagnosis & pulihkan** (playbook di bawah). 5. **Selesaikan** insiden dengan penyebab & tindakan. 6. Kritis →
   catatan pasca-insiden ≤ 2 hari kerja (penyebab akar, pencegahan) dan item backlog.

**Playbook:**
- **Web kantor / API tidak dapat diakses.** Cek status Vercel & Neon; `GET /api/health` (aplikasi) vs
  `/api/health/sync` (DB). Aplikasi mati tetapi DB sehat → *Instant Rollback* ke deploy terakhir yang baik
  (`docs/deploy/README.md` §8). DB mati → cek kuota/suspend Neon (compute *autosuspend*, batas paket), pulihkan
  (§4) bila data rusak. Setelah pulih, pemantau eksternal mencatat gangguan + durasinya otomatis.
- **Sinkron gagal massal.** Akses > Perangkat & sinkron → alasan penolakan terbanyak. Versi aplikasi lama
  (`APP_UPDATE_REQUIRED`) → minta perangkat memperbarui/muat ulang PWA; galat server → log Vercel `/api/sync/push`.
  Antrean di perangkat **tidak hilang**; jangan minta pengguna menghapus data aplikasi.
- **Pekerjaan terjadwal berhenti** (denyut terlambat, H+0 tidak terbit, pengingat tidak jalan). Cek GitHub Actions /
  QStash (secret `APP_URL`, `CRON_SECRET`), panggil manual
  `curl -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/cron/tick` — idempoten, aman diulang.
  H+0 punya job cadangan `m9.h0.publish_pending`.
- **GPS truk mati/dicabut.** Aplikasi sopir otomatis memakai GPS ponsel selama rit berjalan. Dispatcher menghubungi
  sopir; admin sistem memeriksa perangkat (Armada > Perangkat GPS → rincian). Vendor dihubungi bila > 1 hari.
- **E-mail tidak terkirim.** Cek kunci & domain Resend (status Verified, kuota). Faktur/pernyataan tetap dapat
  dikirim lewat WA/`mailto:`.
- **Dugaan kebocoran / akun disalahgunakan.** Nonaktifkan akun (Akses > Pengguna → *Nonaktifkan*: sesi dicabut,
  perangkat dipegang diblokir), blokir perangkat, rotasi rahasia terkait (§5), periksa Jejak audit & Log akses,
  laporkan ke pemilik (kewajiban UU PDP bila data pribadi terdampak).

## 3. Perangkat lapangan

**Perangkat hilang / dicuri / rusak** (sopir melapor ke Dispatcher atau Admin Keuangan):
1. Admin sistem: Akses > **Perangkat** → rincian → **Blokir** (semua permintaan ditolak seketika) → **Hapus data
   jarak jauh** (dieksekusi pada kontak berikutnya; antrean yang ikut hilang tercatat sebagai insiden
   `lost_device_queue`).
2. Admin Keuangan mencatat rit/transaksi hari itu lewat **Dicatat kantor** (ditandai, pemilik diberi tahu, KPI-01).
3. Pasang **perangkat cadangan** (HP/tablet cadangan terdaftar `isSpare`): Rincian perangkat → tetapkan unit & pemegang
   → **Kode aktivasi** (8 karakter, 24 jam, tampil sekali) → di perangkat buka `/aktivasi-perangkat` → pengguna login
   PIN. Data referensi terunduh saat login; pekerjaan offline tersedia kembali.
4. Perangkat ditemukan kembali: tetap perlakukan sebagai baru (daftar ulang) setelah dihapus.

**Pindah perangkat ke unit lain:** Rincian perangkat → ubah unit/pemegang (memutus sesi). Pastikan "Semua terkirim"
lebih dulu.

**Pembaruan versi minimal aplikasi (US-M10-07 KP-4, NFR-32).** Setelah rilis yang mewajibkan aplikasi lapangan baru:
Akses > **Perangkat & sinkron** → *Versi aplikasi lapangan/POS* → *Tetapkan versi minimal*: isi versi (mis. `1.0.1`) + alasan. Perangkat versi lama menampilkan
"Perbarui aplikasi"; kiriman data **ditahan** (tidak hilang) sampai aplikasi dimuat ulang/diperbarui. Portal mitra
menampilkan versi & tenggat ke pemilik mitra (PRD 9.7). Naikkan versi minimal hanya di jendela pemeliharaan dan
beri tahu Dispatcher/Admin Keuangan sehari sebelumnya.

## 4. Pencadangan & uji pemulihan (NFR-13, NFR-14)

Target: **RPO 1 jam, RTO 4 jam**, uji pulih **2× per tahun** (`backup.policy.restore_tests_per_year`) dan sekali
sebelum go-live; salinan bulanan akuntansi disimpan **≥ 10 tahun** (PAR-29 `accounting_years`, BR-31).

| Lapisan | Cara | Memenuhi |
|---|---|---|
| Pemulihan titik-waktu (PITR) Neon | otomatis (WAL berkelanjutan); paket dengan riwayat ≥ 7 hari | RPO ≪ 1 jam, RTO: branch baru dalam menit |
| Salinan harian | Neon menyimpan riwayat; admin sistem memeriksa & **mencatat "Harian – berhasil"** di Akses > Data pribadi → Cadangan (v1.0: pencatatan manual) | NFR-13, penanda merah bila > 26 jam |
| Salinan bulanan (arsip 10 tahun) | tanggal 1 (setelah tutup buku bulan lalu): `pg_dump` terenkripsi ke penyimpanan terpisah milik PT (bukan akun Neon/Vercel yang sama) + ekspor laporan keuangan & jurnal Final (Akuntansi > Laporan / Pajak) | NFR-13, BR-31 |
| Berkas (foto, nota) | Vercel Blob; retensi foto 2 tahun (PAR-29) | — |

**Salinan bulanan (contoh):**
```bash
pg_dump "$DATABASE_URL_UNPOOLED" --format=custom --no-owner --file equa-$(date +%Y-%m).dump
gpg --symmetric --cipher-algo AES256 equa-$(date +%Y-%m).dump   # simpan kunci di brankas pemilik
```
Catat di Akses > Data pribadi → Cadangan: jenis **Bulanan**, lokasi arsip, ukuran.

**Uji pemulihan (2×/tahun, dicatat di sistem):**
1. Neon → Branches → **Create branch** dari titik waktu (mis. 1 jam lalu) — catat jam mulai.
2. Arahkan salinan aplikasi uji (Vercel Preview atau lokal `DB_DRIVER=neon DATABASE_URL=<branch>`) ke branch itu.
3. `pnpm db:verify` (skema identik) → periksa angka kunci: jumlah transaksi & kas hari terakhir, saldo piutang,
   neraca saldo = laporan produksi pada titik yang sama; `Verifikasi keutuhan` Jejak audit dengan titik jangkar e-mail.
4. Catat jam selesai → **RTO** = selesai − mulai (≤ 240 menit); **RPO** = selisih titik pulih vs transaksi terakhir.
5. Akses > Data pribadi → Cadangan → jenis **Uji pemulihan** (RPO & RTO wajib diisi) + catatan. Hapus branch uji.
6. Pemulihan sungguhan (bencana): ikuti `docs/deploy/README.md` §8 "Rollback basis data".

Data uji dari salinan produksi WAJIB disamarkan: salin ke lingkungan uji lalu `pnpm db:mask -- --yes` (NFR-27; skrip
menolak lingkungan produksi).

## 5. Rotasi rahasia

Rotasi terjadwal tahunan (atau segera bila bocor), **di jendela pemeliharaan PAR-86**, dicatat sebagai insiden
"security" (untuk kebocoran) atau log pemeliharaan.

| Rahasia | Dampak saat diganti | Langkah |
|---|---|---|
| `CRON_SECRET` | pemicu cron & pemantau ditolak sampai diperbarui | ganti di Vercel **dan** secret GitHub/QStash bersamaan → Redeploy → *Run workflow* `tick` |
| `GPS_INGEST_TOKEN` | posisi vendor GPS ditolak sampai vendor memperbarui | koordinasikan jam dengan vendor; GPS ponsel cadangan menutup celah |
| `RESEND_API_KEY` | e-mail gagal sementara | buat kunci baru → ganti di Vercel & GitHub (`monitor`) → cabut kunci lama |
| `VAPID_*` | semua langganan Web Push tidak berlaku; pengguna mendaftar ulang saat membuka aplikasi | hanya bila bocor |
| `DATABASE_URL` (kata sandi Neon) | koneksi terputus sampai env diperbarui | Neon → reset password peran → perbarui env Vercel (integrasi) → Redeploy |
| `WA_*`, `MIDTRANS_*` | kanal Tahap 2 terganggu | ganti di Meta/Midtrans lalu Vercel |
| **`SESSION_SECRET`** | **berat** — lihat di bawah | hanya bila bocor/diduga bocor |

**Dampak rotasi `SESSION_SECRET`** (semua kunci turunan HKDF, `src/server/core/auth/crypto.ts`):
- **2FA TOTP** semua pemilik, Admin Keuangan, dan admin sistem **tidak terbaca** → login ditolak "Verifikasi 2 langkah
  perlu direset admin sistem" sampai 2FA direset satu per satu (pengguna lalu memindai QR baru).
- **Secret perangkat** tidak cocok → **semua ponsel/tablet lapangan & POS harus diaktifkan ulang** (kode aktivasi
  baru per perangkat); kode aktivasi & kode PIN yang beredar batal; sesi lapangan harus login PIN ulang (kunci tanda
  tangan perintah sinkron diturunkan dari rahasia ini). **Antrean offline di perangkat hilang saat aktivasi ulang** —
  pastikan semua perangkat "Semua terkirim" dulu.
- Kode OTP aplikasi pelanggan yang beredar batal (berumur pendek).
- **Tag titik jangkar audit** lama tidak dapat diverifikasi dengan kunci baru — **arsipkan nilai lama di brankas
  pemilik** untuk verifikasi historis.
- Sesi web kantor TIDAK terputus (token disimpan sebagai SHA-256), sehingga admin yang sedang login tetap bisa bekerja.

**Prosedur:** (1) jendela PAR-86, umumkan H-1 ke Dispatcher/Admin Keuangan/unit; (2) semua perangkat "Semua
terkirim"; (3) **dua admin sistem tetap login** di web kantor (sesi bertahan); (4) ganti env → Redeploy; (5) admin A
mereset 2FA admin B, admin B mereset 2FA admin A (tidak dapat mereset akun sendiri), lalu 2FA pemilik & Admin
Keuangan; (6) daftar ulang semua perangkat (Akses > Perangkat → kode aktivasi) — mulai dari truk & depot yang buka
05.00; (7) catat di insiden/log pemeliharaan.

## 6. Akun: reset PIN / kata sandi / 2FA

Verifikasi identitas orangnya di luar sistem (tatap muka/telepon atasan) sebelum mereset. Admin sistem **tidak
dapat mereset akunnya sendiri** — minta admin sistem lain. Pemilik otomatis diberi tahu; reset akun pemilik juga
dikirim ke e-mail.

- **Lupa PIN / terkunci 5× salah (PAR-36, 15 menit):** Akses > Pengguna → rincian → **Reset PIN** → kode tampil sekali
  → di perangkat terdaftar pengguna memasukkan kode lalu menetapkan PIN baru sendiri (PIN mudah ditebak ditolak).
- **Lupa kata sandi web:** **Reset kata sandi** → kata sandi sementara tampil sekali (≥ 10 karakter) → pengguna wajib
  menggantinya saat login (sesi web lama dicabut).
- **Ganti ponsel autentikator / 2FA tidak terbaca:** **Reset 2FA** → login berikutnya meminta pemindaian QR baru.
- **Pengguna mengganti kata sandi sendiri:** menu pengguna → *Ubah kata sandi* (`/akun/kata-sandi`).

## 7. Onboarding & offboarding karyawan

**Karyawan baru:**
1. Admin sistem/Admin Keuangan: **Master > Karyawan** → tambah (nomor, jabatan, lokasi, peran rencana, tanggal masuk).
2. Admin sistem: **Akses > Pengguna → Buat akun dari karyawan** → satu peran + lingkup (sopir/kernet → truk; operator
   depot → depot; kasir → toko; operator produksi → sumber air; peran kantor → seluruh EQUA) + alasan. Kombinasi
   peran terlarang (PTB-31) tidak dapat diajukan.
3. **Pemilik menyetujui** di **Persetujuan** (akses tidak pernah aktif tanpa keputusan pemilik; lewat 2 hari kerja
   tetap terbuka & ditandai terlambat — D-08).
4. Lapangan: **Reset PIN / PIN awal** → aktivasi di hadapan admin sistem pada perangkat unitnya. Kantor: kata sandi
   sementara → login → 2FA (pemilik/Admin Keuangan/admin sistem) → ganti kata sandi.
5. Pelatihan ≤ 2 jam + panduan satu halaman peran ([`docs/guides/`](../guides/README.md)).

**Karyawan keluar / pindah:**
- Isi **tanggal keluar** di Master > Karyawan → pada tanggal itu akun **dinonaktifkan otomatis** (sesi dicabut,
  perangkat yang dipegang diblokir, kru default truk dilepas; BR-37). Keluar mendadak → Akses > Pengguna →
  **Nonaktifkan** (seketika).
- Pindah peran: rincian pengguna → *Ajukan pindah peran* (disetujui pemilik; peran lama dicabut saat disetujui).
  Mengurangi lingkup/mencabut peran berlaku **seketika** tanpa persetujuan.
- Kembalikan perangkat; pastikan setoran & ganti rugi terakhir tuntas (Kas > Ganti rugi).
- Data pribadi karyawan yang sudah keluar dapat dianonimkan lewat Akses > Data pribadi (disetujui pemilik; catatan
  keuangan tetap).

## 8. Penambahan outlet, truk, sumber air, tenant mitra

- **Depot/toko EQUA baru:** Master > **Depot & toko** (kode outlet dipakai nomor struk `{kode}-YYMMDD-NNNN`,
  koordinat & radius geofence, kapasitas tandon) → produk & harga outlet (Master > Produk & harga) → resep bahan →
  daftarkan tablet POS (Akses > Perangkat, unit = outlet) → akun operator (lingkup outlet) → stok awal bahan & air
  (Produksi > Pengisian & pasokan → *Stok awal depot*; Toko > Opname untuk toko) → ditandatangani pemilik.
- **Truk baru:** Master > **Armada & kru** (nopol, kapasitas, kru default, pool) → ponsel truk & perangkat GPS
  (Akses > Perangkat; Armada > Perangkat GPS, IMEI vendor) → deteksi di luar jadwal per truk dimatikan sampai GPS
  aktif (flag `fleet.offschedule_detection` per truk). Uji 1 hari sebelum dijadwalkan.
- **Sumber air baru:** Master > **Sumber air** + meter (foto angka awal) → ponsel sumber + akun operator produksi.
- **Tenant mitra (RL-7):** Depot & toko > **Tenant & paket POS** (`/outlet/tenant`) → buat tenant (kode, nama, depot
  pertama; katalog standar tersalin) → Kemitraan: tautkan **satu pelanggan mitra per outlet** (US-P3-08 KP-1) →
  **kontrak per outlet** (Admin Keuangan input, pemilik setuju; D-13 butir 1) → akun operator POS & pemilik mitra
  (Kemitraan > rincian mitra, disetujui pemilik) → tablet POS mitra (kode aktivasi). Mitra dua outlet = dua pelanggan
  mitra + dua kontrak (tagihan & wilayah eksklusif per outlet). Sebelum mitra pertama aktif: **uji penetrasi lintas
  tenant manual** (B-74, PRD 9.6). Portal lengkap Tahap 3 per mitra: `docs/uat/gerbang-tahap.md`.

## 9. Retensi data

Job `m10.retention.daily` (02.30 WIB) dan `m12.gps.retention` menjalankan kebijakan berikut (parameter dapat diubah
pemilik; data akuntansi tidak pernah dihapus):

| Data | Retensi | Parameter / catatan |
|---|---|---|
| Akuntansi, faktur, jurnal, jejak audit | ≥ 10 tahun; **jejak audit tidak pernah dihapus** | PAR-29 `accounting_years`, NFR-11 |
| Foto (bukti kirim, meter, nota) | 2 tahun, lalu diarsipkan | PAR-29 `photo_years` |
| Log akses | 1 tahun (dihapus terkontrol `withRetentionPurge`) | PAR-29 `access_log_years` |
| Posisi GPS mentah | 12 bulan, **setelah ringkasan rit/hari dipastikan** | PAR-52 (hanya job M12) |
| Kode OTP aplikasi pelanggan | 30 hari | `p2.data_retention.otp_days` |
| Nomor permintaan ganti nomor WA | disamarkan setelah 90 hari | `p2.data_retention.phone_change_days` |
| Data pribadi pelanggan/karyawan atas permintaan | anonimisasi (disetujui pemilik; ditunda bila piutang terbuka) | US-M10-06 KP-2; jejak audit menyamarkan PII bagi selain pemilik (D-09) |

## 10. Cut-over & aktivasi (ringkas — rinci di `docs/uat/cutover.md`)

1. DB produksi kosong → `pnpm db:migrate` → `pnpm db:verify` → `pnpm db:seed:prod` (deploy §3).
2. Impor data awal per kelompok (Master > Impor) → tanda tangan pemilik per kelompok (Master > Tanda tangan data awal).
3. **Rekening bank: satu akun buku per rekening** (D-12 butir 4 / B-79). Kas > **Kas kantor & setor bank** → tambah
   rekening: sistem membuat akun buku `1-12NN` sendiri; rekening yang ditampilkan "tanpa akun buku sendiri" wajib
   ditetapkan (*Tetapkan akun buku sendiri*) — DB menolak dua rekening berbagi satu akun buku (indeks unik
   `bank_accounts_gl_account_uq`). Periksa sebelum saldo awal kas & bank ditandatangani.
4. Saldo awal piutang, utang, aset, kas & bank → neraca awal disahkan akuntan.
5. **Akuntan meninjau** Akuntansi > **Pemetaan jurnal otomatis** → pemilik menekan **Aktifkan M11** (B-84 / D-13
   butir 3). Sistem menolak bila ada pemetaan wajib yang belum lengkap; peristiwa sebelum aktivasi dibangkitkan
   retroaktif (PTB-47). Cut-over akuntansi hanya tanggal 1 (NFR-36).
