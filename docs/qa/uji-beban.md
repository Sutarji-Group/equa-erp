# Uji beban 3× volume — NFR-03, NFR-05, NFR-17 (S5-C)

Dokumen ini adalah lampiran uji beban untuk gerbang TG-5 (PRD Bab 10.1 NFR-05: "uji beban 3× sebelum pilot dengan data
sintetis; hasil dilampirkan ke TG-5"). Isinya: cara data dibangkitkan, cara mengukur, hasil sebelum/sesudah perbaikan,
kesimpulan per target NFR, serta rekomendasi kapasitas Neon/Vercel dan hal yang harus diputuskan manajer proyek.

Ringkasnya:

| Target | Hasil | Status |
| --- | --- | --- |
| NFR-05: 3× volume (20 truk, 30 depot + 50 outlet mitra, 1.000 pelanggan, ±5.000 transaksi/hari) tanpa perubahan arsitektur | 60 hari data sintetis (±4.870 transaksi/hari, 1,5 GB) lolos semua penjaga DB & invarian; semua layanan kunci berjalan tanpa perubahan arsitektur | **Lulus**, dengan 1 batas kapasitas yang perlu keputusan (nomor jurnal, §7) |
| NFR-03: web ≤ 2 detik | Sebelum: laporan keuangan 3,0 dtk (gagal), 2 layar lain 0,9 dtk karena pindai penuh. Sesudah: semua 25 kasus lulus di PGlite; terlama 0,94 dtk (laporan bulanan) | **Lulus** di PGlite; perkiraan di Neon lulus kecuali dashboard rentang bulan bila latensi per kueri ≥ 2 ms (§6) |
| Pull sinkron ≤ 2 detik | Pull sopir 0,16 dtk (58 KB, gzip 8 KB); pull POS 0,12 dtk; delta sopir 0,06 dtk (0,7 KB gzip) | **Lulus** |
| NFR-17: unduhan kecil, kuota ≤ 50 MB/bulan/sopir | Precache PWA dipangkas 1,45 MB → 0,55 MB gzip. Perkiraan kuota bulanan dengan setelan sekarang ±80 MB, didominasi foto bukti (PAR-38 300 KB) dan pull 60 detik | **Belum memenuhi** tanpa keputusan PAR-38 & jeda sinkron (§5); diukur ulang pada pilot |

## 1. Lingkup & lingkungan

- **Mesin uji**: kontainer 4 CPU (dipakai bersama 1 agen lain — angka dapat berderau ±20–30 %), Node 22, PGlite 0.5.8
  (Postgres 17 WASM, satu utas, basis data berkas `.data/pglite-perf`). PGlite dipakai karena itulah DB dev/uji proyek;
  waktu komputasinya **lebih lambat** daripada Postgres asli/Neon, sehingga angka di sini adalah batas atas komputasi.
  Latensi jaringan Neon dimodelkan terpisah (§6).
- **Yang diukur**: fungsi layanan yang SAMA dengan yang dipanggil halaman/route handler (otorisasi, validasi, kueri,
  penyusunan data) — bukan kueri tiruan. Aksi lapangan lewat jalur perangkat sungguhan: aktivasi perangkat → login PIN
  → `processPull` / `processPush` (tanda tangan perintah, sesi, handler sinkron, event, jurnal otomatis M11).
- **Tidak diukur**: render HTML/RSC Next.js dan jaringan pengguna (Playwright timing produksi tidak dijalankan; lihat
  rekomendasi §8), serta Neon sungguhan (skrip sudah siap: `DB_DRIVER=neon`, §9).

## 2. Data sintetis (`pnpm perf:generate`)

Skrip `scripts/perf/generate.ts` (+ `scripts/perf/lib/*`) membangun DB PGlite TERPISAH `.data/pglite-perf` (tidak
menyentuh DB dev `.data/pglite`). Hari jangkar 2026-09-30, jam jangkar 13:30 WIB, benih acak 20260930 (deterministik).

| Komponen | Volume |
| --- | --- |
| Master | 20 truk (7 seed + 13 sintetis, masing-masing sopir, kernet, HP & GPS), 30 depot EQUA, 25 tenant mitra × 2 outlet = 50 outlet mitra, 1 toko, 1.030 pelanggan (1.000 luar + internal depot) |
| Per hari | ±135 rit (6 rit pelanggan/truk + 15 rit internal pasokan depot), ±2.100 transaksi POS depot EQUA (70/depot), ±2.500 POS mitra (50/outlet), ±150 transaksi toko, setoran sopir & shift, faktur tempo + pelunasan, posisi GPS 1/menit/truk selama jam operasi |
| 60 hari (tercatat) | 7.174 rit, 6.051 pembayaran rit, 794 faktur, 466 alokasi pelunasan, 3.029 setoran, 4.860 shift, 282.698 transaksi POS (314.288 baris), 142.978 jurnal (303.840 baris), 302.763 domain event, 730.157 posisi GPS, 313.774 perintah sinkron, 332.553 baris audit |
| Rerata | ±4.870 transaksi/hari; ukuran DB 1,48 GB (±25 MB/hari) |

Metodologi pembangkitan (bulk insert yang menjaga invarian — layanan per transaksi akan butuh berhari-hari):

1. **Skema + pengerasan DB diterapkan lebih dulu** (tanpa DELETE, append-only, kolom imutabel, jurnal seimbang saat
   COMMIT, FK komposit tenant). Seluruh data sintetis lolos penjaga yang sama dengan produksi.
2. Seed dasar non-demo (parameter, flag, organisasi, katalog, akun, pemetaan jurnal) lalu master diperbesar. Nomor WA
   sintetis berawalan `620000…`, alamat "Alamat sintetis No. N, Blok Uji" — **tanpa WA/alamat nyata (NFR-27)**.
3. Transaksi ditulis per hari dalam satu transaksi DB, langsung dalam keadaan akhir yang konsisten (rit selesai +
   status + pembayaran + setoran; shift ditutup + setoran + pemakaian bahan dari resep; kartu stok & saldo; kas harian
   ditutup). Rantai hash audit dihitung dengan fungsi inti yang sama (`computeAuditHash`).
4. **Jurnal M11 memakai mesin asli**: kemunculan pertama setiap varian peristiwa (174 varian) diposting lewat
   `processEvent` M11, lalu barisnya dipakai sebagai templat untuk peristiwa sejenis (akun & pusat laba sama, nominal
   baru, nomor `J-YYMM-NNNNN` berurutan dan disinkronkan ke `document_sequences`).
5. **H+0 setiap hari lampau diterbitkan lewat layanan M9** (`publishDailySummary`) — angka dihitung ulang dari data.
6. Verifikasi invarian (gagal → proses keluar kode 1): jurnal terposting seimbang; setiap event keuangan EQUA
   bernominal punya jurnal otomatis; saldo stok = Σ kartu stok; sisa faktur = jumlah − alokasi; setoran sopir = Σ tunai
   rit; setoran shift = tunai shift; shift EQUA ditutup punya setoran; nomor WA sintetis; rantai audit utuh. Semua OK.
   Lalu `ANALYZE`. Durasi ±10 menit.

Catatan teknis: PGlite memutus sinkron protokol bila satu pernyataan memuat > 32.767 parameter (semua kueri berikutnya
mengembalikan kosong tanpa galat). Pembangkit memecah insert per 30.000 parameter (`scripts/perf/lib/bulk.ts`). Kode
aplikasi tidak pernah mendekati batas ini, tetapi `inArray` dengan daftar ID sangat besar harus dihindari (batas
Postgres asli 65.535).

## 3. Cara mengukur (`pnpm perf:measure`)

- `scripts/perf/measure.ts`: setiap kasus dipanggil sekali untuk pemanasan lalu N kali (sebelum: 3×, sesudah: 5×);
  dilaporkan min/median/maks, **jumlah kueri SQL per panggilan** (pencatat Drizzle), ukuran respons JSON & gzip.
  Target: web 2.000 ms (NFR-03), pull 2.000 ms, push 50 perintah 10.000 ms, ekspor 10.000 ms.
- `--profil` mencetak 5 kueri terlama (perkiraan dari jeda antar-kueri) dan kueri identik yang paling sering berulang
  (petunjuk N+1). `pnpm perf:explain -- "<SQL>"` menjalankan `EXPLAIN (ANALYZE, BUFFERS)` di DB uji beban.
- **Bukti perilaku tidak berubah**: `--keluaran DIR` menyimpan keluaran setiap kasus. Keluaran versi sebelum perbaikan
  (commit `95fbf9c`) dan sesudah dibandingkan pada DB yang sama — **identik byte-per-byte** untuk kas hari ini, papan
  jadwal, H+0 (hari ini, kemarin, bulan), laporan bulanan, umur piutang, posisi GPS, riwayat hari, dan laporan
  keuangan (selain `computeMs`). Buku besar: 5.000 baris pertama identik; perbedaan hanya pada perbaikan galat (§4.4).
- Kasus push menulis ke DB uji (50 transaksi POS D05 per putaran), jadi shift D05 membesar setiap kali pengukuran
  dijalankan (±270 transaksi saat "sebelum", ±880 saat "sesudah"). Pull POS diukur juga di D06 (shift ±70 transaksi).

## 4. Hasil sebelum/sesudah

Median (ms) · jumlah kueri per panggilan · ukuran respons. Hasil lengkap: `.data/perf-hasil-sebelum.json`,
`.data/perf-hasil-sesudah.json` (dibangkitkan ulang dengan perintah di §9).

| Kasus (layanan) | Sebelum | Sesudah | Perbaikan |
| --- | --- | --- | --- |
| M4 kas hari ini (`getCashPosition`) | 459 · 265 kueri | **219** · 142 | agregat kas shift sekali untuk semua shift terbuka (§4.3) |
| M2 papan jadwal (`getBoard`) | 860 · 21 | **55** · 21 | posisi GPS terakhir LATERAL (§4.1) |
| M9 H+0 hari ini (berjalan) | 546 · 321 | **282** · 197 | ikut kas M4 |
| M9 H+0 kemarin (terbit) | 8 · 6 | 8 · 6 | — (snapshot) |
| M9 H+0 rentang bulan | 1.760 · 786 | **895** · 662 | angka hidup hanya tanggal belum terbit; omzet tanpa kueri galon (§4.5) |
| M9 laporan bulanan | 1.532 · 62 | **937** · 59 | indeks POS per tenant×tanggal; omzet tanpa kueri galon |
| M5 umur piutang | 30 · 3 | 29 · 3 | — |
| M12 posisi GPS terakhir (`getFleetSnapshot`) | 949 · 31 | **53** · 31 | LATERAL (§4.1) |
| M12 riwayat hari semua truk | 596 · 97 | 689 · 97 | — (derau; kode tidak berubah) |
| M12 rincian truk-hari | 105 · 48 | 102 · 48 | — |
| M11 buku besar kas depot | 433 · 3 · **2,4 MB, terpotong 5.000 baris, saldo salah** | **250** · 4 · 120 KB (halaman 1 dari ±190) | paginasi server + total atas seluruh rentang (§4.4) |
| M11 buku besar — halaman terakhir | — | 647 · 5 | saldo berjalan diteruskan dari baris sebelumnya |
| M11 buku besar pendapatan depot | 408 · 3 · 2,4 MB | **210** · 4 | idem |
| M11 buku besar — data ekspor (20.000 baris) | — | 1.472 · 4 · 9,6 MB | batas `LEDGER_MAX_ROWS` + catatan di berkas |
| M11 laporan keuangan + laba rugi per lini | **2.992 · 25 — GAGAL** | **851** · 17 | agregat bersegmen + memo, arus kas di SQL (§4.2) |
| M2 daftar pesanan | 48 · 3 | 50 · 3 | — (sudah dibatasi 500) |
| M4 daftar setoran | 54 · 52 | 77 · 52 | — (derau) |
| M5 faktur belum lunas | 16 · 2 | 15 · 2 | — |
| M11 daftar jurnal | 46 · 2 | 42 · 2 | — |
| M10 jejak audit | 4 · 1 | 4 · 1 | — |
| Pull sopir (HP-T3, penuh) | 156 · 117 · 58 KB (gzip 7,9) | 156 · 117 · 58 KB (gzip 7,9) | — |
| Pull sopir — delta tanpa perubahan | 65 · 58 · 1,5 KB (gzip 0,7) | 64 · 58 · 1,5 KB (gzip 0,7) | — |
| Pull POS D06 (shift ±70 transaksi) | — | 118 · 72 · 56 KB (gzip 7,3) | — |
| Pull POS D06 — delta | — | 95 · 62 · 44 KB (gzip 5,7) | penyedia POS belum memakai `since` (§5.3) |
| Pull POS D05 (shift ±270 → ±880 transaksi) | 102 · 72 · 60 KB | 236 · 72 · 349 KB (gzip 20) | muatan tumbuh per transaksi shift (§5.3) |
| Push 50 transaksi POS (D05) | 7.057 · 3.386 | **3.451** · 3.275 | cek batas kas BR-08 lewat agregat (§4.3); indeks jurnal per event |

Semua kasus lulus target sesudah perbaikan (25/25 + 2 kasus D06). Sebelum: 22/23 (laporan keuangan gagal).

### 4.1 Posisi GPS terakhir — `DISTINCT ON` → `LATERAL`

`getFleetSnapshot` (M12) dan papan jadwal (M2) mengambil posisi valid terakhir per truk dengan `DISTINCT ON
(truck_id) … ORDER BY truck_id, device_time DESC`, yang memindai seluruh riwayat posisi (730 rb baris; dengan retensi
12 bulan PAR-52 ±4 jt). Diganti satu kueri `VALUES (truk…) CROSS JOIN LATERAL (… ORDER BY device_time DESC LIMIT 1)`
yang memakai indeks `gps_positions_truck_time_idx` mundur dan berhenti di baris pertama per truk:
`latestTruckPositions()` (M12, diekspor) dan `lastValidPositions()` (lokal M2, menghindari impor melingkar M2↔M12).
915 ms → ±2 ms per kueri.

### 4.2 Laporan keuangan M11 — agregat bersegmen

`computeStatements` menjalankan 7 agregat penuh atas `journal_lines` (neraca saldo 3, laba rugi 1, neraca 2, arus kas
1) + 4 posisi markup transfer internal, masing-masing ±420 ms, dan memuat seluruh baris jurnal kas bulan itu ke memori
untuk arus kas (±1,2 dtk). Perbaikan (`StatementAggregates`): rentang dipecah pada titik potong (awal tahun, awal
rentang laporan) menjadi ≤ 3 segmen yang masing-masing dihitung SEKALI lalu dijumlahkan (aditif per akun × pusat laba ×
sumber internal); posisi markup dimemo; arus kas dihitung di SQL (`cashMovementsByCounterAccount`: kas bersih per
jurnal + akun lawan terbesar, seri → nomor baris terkecil). Keluaran identik (uji + perbandingan keluaran).

### 4.3 Kas shift — agregat, bukan memuat seluruh transaksi (N+1 / O(n²))

`checkCashLimit` (BR-08, dipanggil untuk SETIAP transaksi tunai yang tersinkron) dan posisi kas M4 (setiap shift
terbuka) memanggil `computeShiftFigures`, yang memuat semua transaksi + baris + produk + resep shift. Pada push 50
transaksi ke shift berisi 500 transaksi, satu kueri itu ±45 ms × 50 dan terus membesar sepanjang hari (O(n²) per
shift). Diganti `computeShiftCashTotals(tx, shifts[])`: satu `GROUP BY shift_id` (tunai & QRIS terhitung, kas di laci,
setoran) — nilai sama persis dengan `computeShiftFigures` (diuji atas semua shift seed + tunai/QRIS/void/void menunggu).

### 4.4 Buku besar — paginasi server & galat total yang ikut diperbaiki

`computeLedger` membatasi baris ke 5.000 secara diam-diam dan menghitung mutasi & saldo akhir dari baris yang
terpotong: untuk akun kas depot (47.584 baris/bulan pada 3×) saldo akhir tertulis Rp 387.000, seharusnya
Rp 13.304.000. Sekarang: mutasi & saldo akhir dari agregat atas SELURUH rentang; baris dipaginasi (`offset`/`limit`,
halaman `/akuntansi/buku-besar?hal=N`, 250 baris, navigasi "Sebelumnya/Berikutnya" + "Menampilkan baris X–Y dari Z");
saldo berjalan halaman diteruskan dari baris sebelumnya (`pageOpening`). Ekspor memuat ≤ 20.000 baris
(`LEDGER_MAX_ROWS`) dengan ringkasan mutasi seluruh rentang dan catatan bila terpotong. Untuk rentang kecil (< 250
baris) tampilan sama seperti sebelumnya.

### 4.5 Lain-lain

- Indeks baru (skema Drizzle, bernama): `journals_source_event_idx` (cek duplikat jurnal otomatis per event —
  sebelumnya pindai penuh 39–47 ms × 2 per transaksi push), `pos_sales_tenant_date_idx`,
  `pos_sale_lines_tenant_date_idx` (agregat POS per tenant × tanggal untuk H+0/bulanan).
- H+0 rentang (bulan/minggu): agregat harian hidup hanya untuk tanggal yang belum terbit (biasanya hari ini); tanggal
  terbit tetap memakai snapshot (perilaku sama). `salesAggregates({ withGallons: false })` untuk omzet.
- Uji Vitest baru: `tests/perf/load-fixes.test.ts` (indeks, kas shift, agregat tanpa galon, posisi terakhir vs acuan
  DISTINCT ON + papan M2, paginasi buku besar, agregat bersegmen = hitung langsung, arus kas SQL = algoritme acuan),
  `tests/perf/field-precache.test.ts` (precache PWA).

### 4.6 Sisa titik berat (belum diubah, di bawah target)

- **H+0 rentang bulan: 662 kueri** — 412 di antaranya pembacaan parameter berulang dari `fleetDaySummary` M12 per hari
  (30 hari × aturan armada + kejadian + truk + perangkat mati). Aman di PGlite (0,9 dtk) tetapi sensitif latensi Neon
  (§6). Usulan: `fleetRangeSummary` sekali per rentang + cache parameter per permintaan (tambahan di inti).
- Kas hari ini M4: 20 × 5 kueri per sopir (setoran berjalan, rit terakhir) — 142 kueri.
- Push: ±65 kueri per perintah POS (otorisasi, sesi, nomor, audit, event, jurnal otomatis); 3,5 dtk/50 perintah di
  PGlite.

## 5. PWA lapangan & kuota sopir (NFR-17)

### 5.1 Ukuran unduhan PWA (`pnpm perf:pwa` setelah `pnpm build`)

Service worker (`/serwist/sw.js`) sebelumnya mem-precache seluruh `/_next/static/**` (semua chunk web kantor: peta,
grafik, ekspor, dsb.) setiap pemasangan DAN setiap rilis yang mengubah chunk. Sekarang `manifestTransforms` di
`src/app/serwist/[path]/route.ts` menyaring ke aset halaman lapangan saja (`src/server/pwa/field-precache.ts`): chunk
dari manifest halaman `(field)/*` + `~offline` + berkas akar/polyfill, ditutup transitif atas impor dinamis Turbopack
(`"static/chunks/…"`) dan media CSS; berkas `public/` tetap ikut; bila struktur build tidak dikenali → semua di-precache
(perilaku lama, aman offline). Aset lain tetap dapat dimuat online (cache `next-static`).

| | Entri precache | Mentah | gzip |
| --- | --- | --- | --- |
| Sebelum | 145 (140 aset + 5 halaman) | 4,6 MB | ±1,45 MB |
| Sesudah | 38 (33 aset + 5 halaman) | 1,9 MB | **0,55 MB** |

`sw.js` sendiri 40 KB (gzip 13 KB). Penghematan ±0,9 MB per pemasangan dan per rilis.

### 5.2 Perkiraan kuota bulanan per sopir

Asumsi: 26 hari kerja; aplikasi aktif di layar 10 jam/hari; interval sinkron sekarang 60 dtk (`SYNC_INTERVAL_MS`)
→ ±600 putaran/hari; 6,75 rit/sopir/hari (3× volume: 135 rit / 20 truk); satu foto bukti Selesai wajib per rit
(BR-22) + tanda tangan; 1,5 foto nota BBM/tol per hari; header + TLS ±0,5 KB per permintaan (HTTP/2); 4 rilis/bulan.
Ukuran muatan dari pengukuran §4.

| Komponen | Hitungan | Sekarang | Dengan rekomendasi |
| --- | --- | --- | --- |
| Pull delta tanpa perubahan | 600 × (0,7 + 0,5) KB/hari | 18,7 MB | 3,7 MB (jeda 5 menit bila antrean kosong; PAR-30 ≤ 5 menit) |
| Pull penuh / data berubah | ±12 × 7,9 KB/hari | 2,5 MB | 2,5 MB |
| Push perintah | 6,75 rit × ±6 perintah × 1,5 KB | 1,6 MB | 1,6 MB |
| Foto bukti Selesai | 6,75 × 250 KB (batas PAR-38 300 KB) | 43,9 MB | 21,1 MB (target 120 KB: PAR-38 150 KB, sisi 1.280 px, kualitas awal 0,7) |
| Tanda tangan | 6,75 × 15 KB | 2,6 MB | 2,6 MB |
| Foto nota pengeluaran | 1,5 × 250 KB | 9,8 MB | 4,7 MB |
| Pembaruan aplikasi (precache) | 4 rilis × 0,55 MB (sebelum 1,45 MB) | 2,2 MB | 2,2 MB |
| GPS ponsel (cadangan) | 0 bila GPS truk hidup; terburuk ±4 MB bila mati sebulan | 0 | 0 |
| **Total** | | **±81 MB** | **±38 MB** |

Kesimpulan NFR-17: dengan PAR-38 = 300 KB dan pull setiap 60 dtk, kuota sopir **melebihi 50 MB/bulan**; foto bukti
adalah penyumbang terbesar (±55 %). Agar ≤ 50 MB perlu dua keputusan (bukan perubahan kode semata): (1) PAR-38 ≤ 150 KB
dan dimensi foto 1.280 px (`src/client/media/compress-image.ts`, bawaan 1.600 px/0,82), (2) jeda pull lapangan
mengikuti PAR-30 (≤ 5 menit) saat antrean kosong; push tetap segera saat ada perintah. Ukur ulang di pilot (PRD:
2 truk × 14 hari) — asumsi jam aktif layar dan ukuran foto nyata sangat menentukan.

### 5.3 Perangkat POS

Penyedia pull `m6.pos` mengabaikan `since`: setiap putaran (60 dtk) mengirim referensi lengkap, termasuk SEMUA
transaksi shift terbuka beserta barisnya. Shift ±70 transaksi: 44 KB (gzip 5,7 KB) per putaran → ±140 MB/bulan per
tablet POS bila buka 14 jam/hari; muatan tumbuh ±0,35 KB mentah per transaksi shift (D05 dengan ±880 transaksi: 349 KB).
Tidak memengaruhi NFR-17 (khusus sopir) tetapi penting bila tablet POS memakai kuota seluler. Usulan: respons
bersyarat per kunci referensi (klien mengirim sidik jari data yang dimiliki, server mengembalikan `data[key]` hanya bila
berubah) — perubahan protokol sinkron inti, masuk backlog.

## 6. Perkiraan di Neon (latensi per kueri)

Waktu di produksi ≈ komputasi + jumlah kueri × latensi pulang-pergi (RTT) aplikasi↔DB. Komputasi PGlite di sini batas
atas (Postgres asli umumnya lebih cepat). RTT 1 ms = fungsi Vercel & Neon satu region dengan koneksi pooled; 3 ms =
konservatif (driver WebSocket/HTTP, region berbeda zona).

| Kasus | Median PGlite | Kueri | ≈ Neon (RTT 1 ms) | ≈ Neon (RTT 3 ms) |
| --- | --- | --- | --- | --- |
| M9 H+0 rentang bulan | 895 | 662 | 1,56 dtk | **2,88 dtk** ✗ |
| M9 laporan bulanan | 937 | 59 | 1,00 dtk | 1,11 dtk |
| M11 laporan keuangan | 851 | 17 | 0,87 dtk | 0,90 dtk |
| M12 riwayat hari | 689 | 97 | 0,79 dtk | 0,98 dtk |
| M11 buku besar — halaman terakhir | 647 | 5 | 0,65 dtk | 0,66 dtk |
| M9 H+0 hari ini | 282 | 197 | 0,48 dtk | 0,87 dtk |
| M4 kas hari ini | 219 | 142 | 0,36 dtk | 0,65 dtk |
| Pull sopir | 156 | 117 | 0,27 dtk | 0,51 dtk |
| Push 50 perintah | 3.451 | 3.275 | 6,7 dtk | 13,3 dtk |

Pada RTT ≤ 1,5 ms semua layar web lulus NFR-03. Pada RTT 3 ms hanya H+0 rentang bulan yang melewati 2 dtk → wajib
satu region + koneksi pooled, dan perbaikan §4.6 dikerjakan sebelum pilot bila pengukuran staging menunjukkan RTT
> 1,5 ms. Push adalah proses latar (outbox), bukan layar; batas waktu fungsi harus cukup (§7).

## 7. Rekomendasi kapasitas Neon/Vercel & keputusan PM

**Neon**
- Region **ap-southeast-1 (Singapura)**, sama dengan region fungsi Vercel (`sin1`); gunakan string koneksi
  **pooled** (`-pooler`) untuk fungsi serverless.
- Compute: minimum 1 CU dengan autoscaling s.d. 2 CU. **Matikan scale-to-zero pada jam operasi** (05.00–22.00 WIB)
  atau setel jeda suspend panjang — cold start menambah ±0,5–1 dtk pada permintaan pertama (melanggar NFR-03 untuk
  pengguna pertama pagi hari, termasuk sinkron sopir pukul 05.30).
- Penyimpanan: 1,48 GB per 60 hari pada 3× → **±9 GB/tahun** (terbesar: `gps_positions` 325 MB/60 hari — retensi 12
  bulan PAR-52 ±2 GB tetap; `domain_events` 285 MB, `audit_logs` 261 MB, `pos_sales` 161 MB, `sync_commands` 149 MB —
  append-only/permanen). Pilih paket dengan kuota ≥ 20 GB untuk tahun pertama; pantau pertumbuhan (NFR-29). Rencana
  jangka menengah: partisi bulanan untuk `gps_positions`, `audit_logs`, `domain_events`, `sync_commands`.
- Migrasi produksi: baseline migrasi SQL memuat 3 indeks baru (§4.5) — SELESAI pada integrasi rilis v1.0:
  `drizzle/0000_baseline_v1` dibangkitkan ulang dan ditegaskan `tests/db/migrations.test.ts` (backlog B-86).

**Vercel**
- Fungsi region `sin1`. `maxDuration` ≥ 60 dtk untuk `/api/sync/push` (push 50 perintah ±7–13 dtk di Neon) dan
  `/api/export/*` (buku besar 20.000 baris, PDF/Excel); memori 1.024 MB untuk ekspor.
- Pertimbangkan batas batch push 20–25 perintah untuk jaringan seluler buruk (saat ini 50).

**Keputusan manajer proyek (berkas bersama / parameter — tidak diubah di cabang ini)**
1. **Kapasitas nomor jurnal** `J-YYMM-NNNNN` (5 digit, maks. 99.999/bulan/tenant; `DOC_TYPES` di
   `src/server/core/numbering.ts`): pada 3× volume EQUA menerbitkan ±72.000 jurnal/bulan (satu jurnal per transaksi
   POS/pembayaran/setoran) → cadangan hanya 1,4×. Pada ±4,2× volume, atau bila jumlah event berjurnal bertambah, jurnal
   otomatis berhenti dengan `SEQUENCE_EXHAUSTED`. Opsi: 6 digit (perubahan format berkas bersama) atau jurnal POS
   dikonsolidasikan per shift (perubahan rancangan M11).
2. **PAR-38** (batas foto) dan jeda pull lapangan (§5.2) untuk NFR-17.
3. Protokol pull bersyarat untuk POS (§5.3).

## 8. Kesimpulan per target

- **NFR-05 — lulus.** Data 3× selama 60 hari dibangkitkan tanpa melanggar penjaga DB; tidak ada batas tenant/outlet/
  perangkat yang dikodekan; layanan kunci berjalan dengan skema & arsitektur yang sama. Satu batas kapasitas nyata:
  nomor jurnal (§7.1).
- **NFR-03 — lulus di lingkungan uji** setelah perbaikan (laporan keuangan 3,0 → 0,85 dtk; papan jadwal & peta armada
  0,9 → 0,05 dtk; semua layar ≤ 0,94 dtk). Di Neon lulus dengan satu region + pooled; H+0 rentang bulan berisiko bila
  RTT > 1,5 ms (§6). Waktu render halaman (Playwright pada build produksi) belum diukur — lakukan di staging Neon.
- **Pull ≤ 2 dtk — lulus** (0,06–0,24 dtk). Push 50 perintah 3,5 dtk (latar).
- **NFR-17 — sebagian.** Unduhan aplikasi dipangkas ±62 % (0,55 MB gzip). Kuota bulanan sopir diperkirakan ±81 MB
  dengan setelan sekarang; ±38 MB dengan PAR-38 150 KB + jeda pull 5 menit. Wajib diukur di pilot.

## 9. Cara mengulang

```bash
pnpm perf:generate                      # ±10 menit → .data/pglite-perf (hapus & bangun ulang)
pnpm perf:measure --label sebelum       # tabel + .data/perf-hasil-sebelum.json
pnpm perf:measure --label sesudah --keluaran .data/keluaran-sesudah   # + keluaran per kasus untuk dibandingkan
pnpm perf:measure --kasus m9.h0_bulan --ulang 1 --profil              # kueri terlama & berulang
pnpm perf:explain -- "select … "        # EXPLAIN ANALYZE di DB uji beban
pnpm build && pnpm perf:pwa             # ukuran precache PWA
# Neon/Postgres staging (DB kosong bernama …perf…):
DB_DRIVER=neon DATABASE_URL=postgres://…/equa_perf pnpm perf:generate
DB_DRIVER=neon DATABASE_URL=postgres://…/equa_perf pnpm perf:measure --label neon
```

Opsi pembangkit: `--tanggal YYYY-MM-DD`, `--jam HH:mm`, `--hari N`, `--benih N`. Opsi pengukuran: `--label`,
`--ulang N`, `--kasus a,b`, `--profil`, `--keluaran DIR`. Push menulis ke DB uji — bangkitkan ulang untuk angka yang
dapat dibandingkan persis.
