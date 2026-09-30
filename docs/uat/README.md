# Uji Terima Pengguna (UAT), pilot, perluasan & cut-over

Bukti penerimaan rilis sesuai PRD Bab 11 dan verifikasi NFR Bab 10. Uji otomatis (Vitest/Playwright, `pnpm trace`:
seluruh KP prioritas M teruji) membuktikan logika; UAT membuktikan perilaku di **layar nyata, perangkat nyata, data
nyata** oleh **pemilik modul**, dan menghasilkan **berita acara** bertanda tangan.

## Dokumen

| Dokumen | Isi | Kapan |
|---|---|---|
| UAT per modul: [M1](m1-data-master.md) · [M2](m2-pesanan.md) · [M3](m3-sopir.md) · [M4](m4-kas.md) · [M5](m5-piutang.md) · [M6](m6-pos-depot.md) · [M7](m7-toko.md) · [M8](m8-produksi.md) · [M9](m9-laporan.md) · [M10](m10-akses.md) · [M11](m11-akuntansi.md) · [M12](m12-armada.md) · [RL-7 Mitra](rl7-mitra.md) | Skenario BRD, checklist lulus/gagal setiap KP (teks PRD), langkah di layar, data uji, item UAT manual, catatan cacat, kelas cacat (11.2), berita acara (11.3) | RL-2 (TG-5), RL-7 |
| [pilot.md](pilot.md) | Kriteria pilot 11.4 & cara mengukurnya di sistem, lembar harian 14 hari, evaluasi pilot | RL-3 (TG-6) |
| [paralel.md](paralel.md) | Perluasan & periode paralel NFR-35, PAR-28/84/88, lembar pencocokan | RL-4 |
| [cutover.md](cutover.md) | Daftar periksa 11.6 → layar & tanda tangan di sistem, validasi akun buku per rekening (B-79), aktivasi M11 (B-84), go/no-go | sebelum TG-7/TG-8 |
| [gerbang-tahap.md](gerbang-tahap.md) | Gerbang aktivasi Tahap 2 (TG-9, termasuk pengaburan wajah foto bukti kirim) & Tahap 3; cara menyalakan flag per tenant | TG-9 dan sesudahnya |
| [risiko.md](risiko.md) | Register risiko & mitigasi (PRD Bab 12/13, D-01 region, B-76/B-57, sisa backlog) | setiap tonggak |

Dokumen UAT per modul **dibangkitkan** dari PRD: ubah `tools/uat-config.ts` lalu jalankan `pnpm uat:gen`
(uji `tests/tools/gen-uat.test.ts` memastikan dokumen selalu mutakhir dan setiap KP tercantum).

## Cara menjalankan UAT

1. **Lingkungan uji** (NFR-27): deploy Preview + branch Neon terpisah; `pnpm db:migrate` lalu `pnpm db:seed:prod`
   (data nyata dari impor uji yang disamarkan `pnpm db:mask -- --yes`) atau gladi dengan data demo `pnpm db:seed`
   (akun demo di `README.md`). Jangan memakai DB produksi.
2. **Perangkat nyata**: ponsel truk, tablet POS depot & toko, ponsel sumber air diaktifkan lewat `/aktivasi-perangkat`.
3. **Urutan disarankan**: M10 (akun, peran) → M1 (master) → M2 → M3 → M8 → M6 → M7 → M4 → M5 → M12 → M11 → M9;
   skenario ujung-ke-ujung P-01..P-07 (`docs/qa/skenario-uji.md`) sebagai uji gabungan.
4. **Setiap KP** dijawab Lulus/Gagal oleh pemilik modul; Gagal → catat cacat + kelas (Kritis/Mayor/Minor, PRD 11.2).
   Cacat Kritis/Mayor diperbaiki, dirilis ke lingkungan uji, lalu KP diuji ulang.
5. **Berita acara** per modul ditandatangani pemilik modul, manajer proyek IT, dan saksi (juara lapangan/akuntan).
   User story M yang tidak lulus menahan rilis.

## Kelas cacat (PRD 11.2)

| Kelas | Definisi | Konsekuensi |
|---|---|---|
| **Kritis** | Transaksi tidak dapat dicatat, hilang, dobel, atau dapat diubah tanpa jejak; kebocoran data lintas peran/tenant; salah hitung uang | Menahan rilis; ditanggapi ≤ 30 menit setelah go-live (NFR-31) |
| **Mayor** | Fungsi M tidak bekerja sesuai KP tetapi ada jalan lain berjejak | Menahan rilis kecuali komite pengarah menerima dengan tenggat perbaikan |
| **Minor** | Ketidaknyamanan, teks, tampilan | Masuk backlog; tidak menahan rilis |

## Ringkasan item UAT manual (dari backlog & NFR)

B-14 (uji waktu manusia), B-19 (matahari, kamera, tanpa sinyal), B-47 (GPS nyata), B-57/B-76 (tinjauan akuntan),
B-74 (aplikasi pelanggan 4G & uji penetrasi lintas tenant), B-77 (e-mail Resend nyata), B-79 (akun buku per rekening),
B-84 (Aktifkan M11), B-85 (pemantau uptime), NFR-03/06/07/08/09/12/13/16/18/19/22/23/24/28/30/34/36 — lihat bagian
"Item UAT manual" tiap dokumen modul dan [risiko.md](risiko.md) §4.
