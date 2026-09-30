# Register risiko proyek & mitigasi — rilis v1.0

Turunan PRD Bab 12 (risiko BRD R01–R14, risiko produk RP-01..RP-13, ketergantungan eksternal) dan Bab 13 (register
PTB), diperbarui dengan keputusan manajer proyek (`docs/DECISIONS.md` D-01..D-13) dan sisa backlog
(`docs/dev/backlog.md`). Ditinjau komite pengarah pada setiap tonggak (TG-5 RL-2, TG-6 pilot, TG-7, TG-8 go-live, TG-9).

Skala: Kemungkinan / Dampak = Rendah · Sedang · Tinggi.

## 1. Risiko keputusan & kepatuhan (dicatat untuk komite pengarah)

| ID | Risiko | K | D | Mitigasi | Pemilik | Status v1.0 |
|---|---|:-:|:-:|---|---|---|
| **RP-14** | **Penyimpangan region NFR-26 / K5** (D-01): data & cadangan di **Singapura** (Vercel `sin1`, Neon `aws-ap-southeast-1`), bukan Jakarta — potensi ketidaksesuaian UU PDP / kebijakan lokalisasi data | Sedang | Tinggi | Arsitektur portabel (Postgres standar, adaptor penyimpanan, `DB_DRIVER=pg`); prosedur pindah ke GCP Jakarta `docs/deploy/README.md` §10; enkripsi transport & penyimpanan; akses per peran | Pemilik + konsultan hukum | **Terbuka** — keputusan komite sebelum TG-8 |
| **RP-15** | Data pribadi tersimpan di **jejak audit** setelah anonimisasi (append-only NFR-11, D-09 butir 1) | Rendah | Sedang | Tampilan & ekspor jejak audit menyamarkan PII pelanggan teranonimkan bagi semua peran kecuali pemilik (B-09 SELESAI); jejak tetap sebagai catatan wajib hukum (BR-31) | Konsultan hukum | Mitigasi terpasang; tinjauan hukum |
| **RP-16** | **TG-9 pengaburan wajah** foto bukti kirim di aplikasi pelanggan belum dibangun (B-75, D-11 butir 3, D-12 butir 5) | — | Sedang | Tahap 2 mati bawaan; v1.0 menampilkan foto hanya ke akun pemilik pesanan; menjadi **syarat gerbang Tahap 2** (`docs/uat/gerbang-tahap.md` butir 7) | Manajer proyek IT | Ditunda ke gerbang Tahap 2 |
| RP-17 | Keputusan akuntansi belum ditinjau akuntan: kategori arus kas metode langsung heuristik (B-57); alokasi L1 → L3 per outlet & eliminasi markup rata-rata tertimbang (B-76) | Sedang | Sedang | Item UAT manual M11; berita acara tinjauan akuntan sebelum **Aktifkan M11** (B-84, D-13 butir 3); laporan berlabel Sementara sampai periode dikunci | Admin Keuangan + akuntan | **Terbuka** (UAT M11) |
| RP-18 | **Mitra dua outlet** (PRD 9.7) dimodelkan satu kontrak per outlet; batas kredit bersama & faktur gabungan lintas outlet tidak dibangun (B-82, D-13 butir 1); ringkasan portal/dasbor menampilkan kontrak terbaru saja | Rendah | Rendah | Uji penerimaan `tests/p3-partner/two-outlets.test.ts` lulus (tagihan & wilayah per outlet, isolasi); rincian per kontrak di `/kemitraan/kontrak`; perubahan model hanya lewat CR | Pemilik | Diterima (D-13) |
| RP-19 | Ketergantungan pada layanan luar kelas gratis (Vercel Hobby cron harian, GitHub Actions cron dapat tertunda, Neon Free PITR pendek, Resend kuota) | Sedang | Sedang | Cron 5 menit ganda (GitHub Actions + opsi Upstash QStash), job idempoten; **Vercel Pro & paket Neon ber-PITR ≥ 7 hari saat go-live** (D-01, deploy §3); pemantau eksternal | Tim IT | Terbuka — anggaran NFR-29 |
| RP-20 | Rotasi `SESSION_SECRET` berdampak berat (2FA semua peran wajib-2FA harus direset, semua perangkat lapangan aktivasi ulang, antrean offline hilang bila belum terkirim) | Rendah | Tinggi | Rotasi hanya bila bocor, di jendela PAR-86, prosedur runbook §5 (dua admin tetap login, semua perangkat "Semua terkirim" dulu); rahasia di Vercel env saja | Tim IT | Prosedur tersedia |
| RP-21 | Pencatatan status cadangan harian di sistem masih manual (Akses › Data pribadi → Cadangan) sehingga penanda NFR-13 dapat terlupa | Sedang | Rendah | Penanda merah bila > 26 jam; tugas harian runbook §1; PITR Neon tetap berjalan otomatis | Admin sistem | Terbuka (otomatisasi = backlog) |
| RP-22 | Baseline migrasi produksi tertinggal dari skema bila perubahan skema digabung tanpa `pnpm db:generate` (mis. indeks dari sprint kinerja S5-C) | Sedang | Tinggi | Uji `tests/db/migrations.test.ts` gagal bila skema berubah tanpa migrasi; `pnpm db:verify` setelah migrasi produksi; migrasi aditif | Tim IT / integrator | Terkendali oleh uji — baseline v1.0 dibangkitkan ulang saat integrasi rilis dan memuat 3 indeks S5-C |
| RP-23 | **Kapasitas nomor jurnal** `J-YYMM-NNNNN` = 99.999 per bulan per tenant; pada 3× volume EQUA menerbitkan ±72.000 jurnal/bulan (ruang 1,4×). Sekitar 4,2× volume jurnal otomatis berhenti (`SEQUENCE_EXHAUSTED`) | Rendah | Tinggi | Volume v1.0 (1×) ±24.000/bulan; pantau nomor jurnal tertinggi per bulan (runbook); keputusan PM: 6 digit (`DOC_TYPES`, berkas bersama) atau satu jurnal POS per shift (`docs/qa/uji-beban.md`) | Manajer proyek IT | **Terbuka** — keputusan PM sebelum volume > 3× |
| RP-24 | **Data seluler perangkat lapangan (NFR-17)**: sopir ±81 MB/bulan (batas 50 MB) — foto bukti kirim PAR-38 300 KB ±55%, pull 60 detik ±19 MB; tablet POS ±140 MB/bulan karena pull POS mengabaikan kursor `since` | Sedang | Sedang | Precache PWA lapangan sudah dipangkas (1,45 → 0,55 MB gzip); usulan: PAR-38 150 KB/1.280 px + pull 5 menit saat outbox kosong (PAR-30) → ±38 MB; POS di Wi-Fi depot bila ada; respons bersyarat pull POS = perubahan protokol sinkron inti (keputusan PM, pasca-v1.0) | Manajer proyek IT + pemilik | **Terbuka** — keputusan PM + ukur saat pilot |
| RP-25 | **Latensi Neon belum diukur**: uji beban memakai PGlite; rentang H+0 sebulan menjalankan 662 kueri (±0,9 dtk PGlite, perkiraan ±2,9 dtk di Neon bila 3 ms/kueri); render halaman Next.js produksi belum diukur | Sedang | Sedang | Skrip siap (`DB_DRIVER=neon … pnpm perf:generate && pnpm perf:measure`); region Singapura untuk Neon & fungsi Vercel, koneksi pooled, tanpa scale-to-zero jam operasi, `maxDuration` 60 dtk sinkron/ekspor; perbaikan (ringkasan armada rentang + cache parameter per permintaan) bila melebihi NFR-05 | Tim IT | **Terbuka** — ukur di Neon staging sebelum TG-6 pilot |

## 2. Risiko BRD R01–R14 (PRD 12.1) — jawaban produk v1.0

| ID | Risiko | Jawaban di produk (v1.0) | Sisa risiko / pemilik |
|---|---|---|---|
| R01 | Adopsi lapangan rendah | Alur ≤ 3 langkah, offline-first, panduan 1 halaman per peran (`docs/guides/lapangan/`), riwayat selisih & kinerja sendiri di aplikasi, periode paralel & KPI-11 | Sikap; insentif BR-12 — pemilik |
| R02 | Scope creep tim IT | Ketertelusuran US/KP → uji (`pnpm trace`: 490/490 KP M teruji), register keputusan D-01..D-13, backlog | Disiplin — manajer proyek IT |
| R03 | Kemacetan keputusan pemilik | Persetujuan sekali ketuk (ponsel), perilaku lewat tenggat per jenis, selisih tidak mengunci rit, Kotak masuk | Beban pemilik — pemilik |
| R04 | PT / neraca awal terlambat | Jurnal retroaktif (PTB-47), laporan "belum lengkap", identitas "EQUA" sebelum PT | Cut-over mundur — Admin Keuangan |
| R05 | GPS terlambat / tidak cocok | Penghubung vendor terpisah (generic-json/OsmAnd), GPS ponsel cadangan, titik status | Uji perangkat nyata **B-47** — tim IT |
| R06 | Kapasitas air | Utilisasi & ruang tumbuh (M8), PAR-81 kapasitas mitra | Keputusan investasi — pemilik |
| R07 | Pelanggan tempo menolak aturan | Masa transisi per pelanggan, pengecualian berjejak | Kehilangan pelanggan — Dispatcher |
| R08 | Sengketa ganti rugi | Ganti rugi nonaktif sampai Peraturan Perusahaan (flag `cash.restitution_active`), sistem tidak memotong gaji | Legal — pemilik |
| R09 | Kebocoran data / akses tidak sah | RBAC + SoD ditolak di layanan, 2FA, perangkat terdaftar, jejak audit berantai + titik jangkar e-mail, FK komposit tenant, tinjauan akses kuartalan | Uji penetrasi manual **B-74** — tim IT |
| R10 | Gangguan internet lapangan | Offline ≥ 1 hari, sinkron idempoten, versi minimal menahan (bukan membuang) antrean | Uji rute tanpa sinyal **B-19** — tim IT |
| R11 | Omzet melampaui PKP | Pemantauan 80/90% & proyeksi (satu definisi M9 = M11) | Pengukuhan PKP — Admin Keuangan |
| R12 | Istilah waralaba sebelum STPW | Flag `partner.franchise_terms` terkunci pemilik | Materi di luar sistem — pemilik |
| R13 | Kehilangan Admin Keuangan | Peran dapat dipegang dua orang, SOP & panduan | Pelatihan cadangan — pemilik |
| R14 | Pelanggan mempersoalkan tarif zona | Simulasi zona, harga khusus, pemeriksaan zona dari jarak GPS | Komunikasi — pemilik |

## 3. Risiko produk RP-01..RP-13 (PRD 12.2) — status

| ID | Risiko | Mitigasi terpasang | Pemantauan |
|---|---|---|---|
| RP-01 | Konflik data offline | Lapangan tidak ditimpa; konflik tampil di papan jadwal & Perangkat & sinkron | Konflik terbuka harian |
| RP-02 | Hitung stok fisik harian diisi asal | Hanya bahan utama + toleransi PAR-58; opname mingguan resmi | Selisih stok per operator (Laporan kinerja) |
| RP-03 | Koordinat awal buruk | Kunci koordinat dari Selesai pertama & posisi GPS truk (B-43), zona manual bertanda | % alamat terkunci (gerbang Tahap 2 ≥ 95%) |
| RP-04 | Pertumbuhan penyimpanan foto | Kompresi ≤ 300 KB, arsip 2 tahun (PAR-29) | Biaya Blob bulanan (NFR-29) |
| RP-05 | Kernet pengganti mengaburkan kas | Hak hanya lewat jadwal kru, transaksi atas nama pengguna aktif | Laporan setoran |
| RP-06 | WA semi-otomatis membebani | Daftar kerja satu klik; API di Tahap 2 | Beban kerja Dispatcher/Admin Keuangan |
| RP-07 | Pemetaan jurnal terlambat | Daftar tunggu jurnal, retroaktif, seed pemetaan bawaan lengkap | Daftar tunggu = 0 |
| RP-08 | GPS dicabut sengaja | Peringatan ≤ 15 menit, pola berulang ke pemilik | Kejadian armada |
| RP-09 | Aturan kredit kaku → kurang bayar | Faktur kurang bayar H+0, kurang bayar kedua menahan, tunai→tempo lewat Dispatcher | Umur piutang kurang bayar |
| RP-10 | Notifikasi berlebihan | Kritis tidak dapat dimatikan, ringkasan & jam tenang | Masukan pemilik bulan 1 |
| RP-11 | Settlement gerbang tidak cocok (Tahap 2) | Transfer masuk neto (B-63), pencocokan M4 | Saat Tahap 2 aktif |
| RP-12 | Isolasi tenant gagal (Tahap 3) | FK komposit tenant DB, `denyCrossTenant` berjejak, uji otomatis portal | Uji penetrasi manual B-74 sebelum mitra pertama |
| RP-13 | Paket Mitra Fase 1 menarik tim dari Tahap 1 | Cakupan 4 user story, syarat masuk RL-7 setelah TG-8 | Manajer proyek IT |

## 4. Item UAT manual yang belum dapat diotomasi (sisa backlog)

| Backlog | Isi | Dokumen UAT |
|---|---|---|
| B-14 | Uji waktu manusia: pesanan < 60 dtk, transaksi POS ≤ 10 dtk, cari pelanggan ≤ 1 dtk pada volume nyata | `m1-data-master.md`, `m2-pesanan.md`, `m6-pos-depot.md` |
| B-19 | Teks & kontras di bawah matahari (NFR-18), kamera nyata, tanpa sinyal di rute Cianjur | `m3-sopir.md`, `m6-pos-depot.md`, `m8-produksi.md` |
| B-47 | Perangkat GPS nyata 1 unit & skenario dicabut di truk pilot | `m12-armada.md` |
| B-57 / B-76 | Tinjauan akuntan: arus kas metode langsung; alokasi L1→L3 & eliminasi markup | `m11-akuntansi.md`, `cutover.md` §3 |
| B-74 | Aplikasi pelanggan ≤ 2 dtk di 4G & pemesanan ≤ 60 dtk; uji penetrasi lintas tenant manual | `gerbang-tahap.md`, `rl7-mitra.md` |
| B-77 | Kiriman e-mail nyata dengan kunci Resend produksi & domain pengirim terverifikasi | `m5-piutang.md`, deploy §5 |
| B-79 | Validasi satu akun buku per rekening bank saat impor data awal | `cutover.md` §2 |
| B-84 | Pemilik menekan "Aktifkan M11" setelah akuntan meninjau pemetaan | `cutover.md` §3 |
| B-85 | Secret/variabel repositori pemantau uptime terisi & peringatan terbukti terkirim | deploy §6, `m10-akses.md` |

## 5. Ketergantungan eksternal (PRD 12.3, disesuaikan D-01)

| Pihak | Dibutuhkan untuk | Cadangan bila terlambat |
|---|---|---|
| Konsultan akuntan | Bagan akun, pemetaan, neraca awal, umur aset, tinjauan B-57/B-76 | Modul operasional berjalan; jurnal retroaktif; laporan "belum lengkap" |
| Notaris / konsultan hukum | Identitas PT, perjanjian mitra, STPW, tinjauan RP-14/RP-15 | "EQUA" di dokumen; istilah waralaba terkunci; Tahap 3 tertunda |
| Vendor GPS | Perangkat & data | GPS ponsel cadangan, titik status |
| Vercel & Neon (pengganti Google Cloud, D-01) | Hosting & DB | Instant Rollback, PITR/branch Neon, pindah ke GCP Jakarta (deploy §10) |
| Resend | E-mail faktur, ringkasan, peringatan | `mailto:` & WA; peringatan lewat webhook |
| Penyedia WA Business API (Tahap 2) | OTP & notifikasi pelanggan | Tautan wa.me Tahap 1 tetap berjalan |
| Midtrans (Tahap 2) | Pembayaran digital | Transfer/tunai biasa |
| Konsultan pajak | Skema PPh, format ekspor | Omzet bruto per lini tersedia; template ekspor dapat diubah tanpa rilis |
| Konsultan HR | Peraturan Perusahaan (ganti rugi) | Ganti rugi nonaktif, selisih tetap tercatat |
| Bank PT | Rekening, mutasi | Pencocokan manual, setor fisik |
