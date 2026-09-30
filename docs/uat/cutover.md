# Daftar periksa cut-over (NFR-34, NFR-36, BRD 10.3 — PRD 11.6)

Produksi dimulai dari **DB kosong** (D-12 butir 4). Setiap kelompok data dimasukkan lewat layar/impor, divalidasi, lalu
**ditandatangani di sistem** (`data_signoffs`, penyusun ≠ penanda tangan — SOD-01). Keputusan go/no-go cut-over oleh
komite pengarah dengan daftar ini sebagai bukti. Cut-over akuntansi **hanya tanggal 1** (NFR-36); transaksi sebelum
tanggal itu tidak dimigrasi; modul operasional boleh go-live lebih dulu dengan jurnal dibangkitkan retroaktif (PTB-47).
Langkah teknis: [`docs/deploy/README.md`](../deploy/README.md) §3, operasional: [`docs/ops/runbook.md`](../ops/runbook.md) §10.

## 0. Basis data & akun pertama (tim IT)

- [ ] `pnpm db:migrate` → `pnpm db:verify` (**IDENTIK**) → `pnpm db:seed:prod` (parameter Lampiran B, tenant EQUA,
      bagan akun & pemetaan bawaan, template WA — tanpa data demo) — tanggal/jam: ________ oleh: ________
- [ ] Akun pertama pemilik & admin sistem login → 2FA terdaftar → kata sandi sementara diganti.
- [ ] Parameter Lampiran B ditinjau pemilik (Pengaturan › Parameter), identitas usaha `company.identity` ("EQUA" sampai
      PT berdiri, lalu identitas PT).
- [ ] Impor diuji dulu di lingkungan uji dengan data tersamar (NFR-27, `pnpm db:mask -- --yes`), lalu mode Produksi.

## 1. Kelompok data (PRD 11.6 → layar & tanda tangan)

| # | Kelompok data | Sumber | Masuk lewat (layar) | Tanda tangan di sistem | Penanda tangan | ✓ tanggal |
|---|---|---|---|---|---|---|
| 1 | **Pelanggan truk (300) & alamat** | Template impor, pembersihan duplikat | Master › **Impor data awal** (jenis pelanggan; mode Uji → Produksi; baris salah/duplikat diputuskan) | Master › **Tanda tangan data awal** → *Pelanggan & alamat* (US-M1-06 KP-4) | Pemilik |  |
| 2 | **Zona tarif & daftar harga** | Ditetapkan pemilik (K23) | Master › **Zona tarif** (*Simulasi* dulu, US-M1-05 KP-5), **Produk & harga** / impor tarif | Tanda tangan data awal → *Zona tarif & daftar harga* | Pemilik |  |
| 3 | **Armada, kru, karyawan, peran, perangkat** | Input manual / impor | Master › **Armada & kru**, **Karyawan**; Akses › **Pengguna** (*Akun awal go-live* → *Susun daftar untuk ditandatangani*); Akses › **Perangkat** | Tanda tangan data awal → *Armada, kru, karyawan, peran, perangkat*; Akses › Pengguna → *Tanda tangani & aktifkan semua* (*Akun pengguna awal*, US-M10-01 KP-8) | Pemilik |  |
| 4 | **Depot & sumber air** (meter, geofence) | Input manual / impor | Master › **Depot & toko**, **Sumber air** (meter + foto angka awal), **Pool/garasi** | Tanda tangan data awal → *Depot & sumber air* | Pemilik |  |
| 5 | **Produk & stok toko; bahan habis pakai depot; stok air depot** | Opname fisik pada tanggal cut-over | Toko › **Opname** (*Stok awal cut-over*: jumlah fisik & harga beli terakhir, US-M7-02 KP-5); POS depot › Stok bahan (opname awal, US-M6-04); Produksi air › **Pengisian & pasokan** → *Stok awal depot* (air) | Rincian opname → tanda tangan *Stok toko & bahan depot* | Pemilik |  |
| 6 | **Aset tetap** | Akuntan & notaris (K15) | Akuntansi › **Aset tetap** → *Impor* → *Pratinjau* → *Simpan impor* (aset pribadi yang disewakan ke PT ditolak — catat sewanya) | *Tandatangani daftar aset* (US-M11-05 KP-1) | Pemilik & akuntan |  |
| 7 | **Saldo awal kas & bank** | Hitung fisik & saldo rekening | Kas › **Kas kantor & setor bank** (saldo awal kas kantor; rekening bank PT — lihat §2); Akuntansi › **Saldo awal** kelompok kas & bank | Akuntansi › Saldo awal → tanda tangan *Saldo awal kas & bank* (US-M11-09 KP-2) | Pemilik |  |
| 8 | **Piutang berjalan** | Konfirmasi ke pelanggan, per faktur | Piutang › **Saldo awal piutang** (per faktur kertas + lampiran konfirmasi + lini asal) | Tanda tangan *Piutang berjalan* (US-M5-07) | Pemilik |  |
| 9 | **Utang pemasok** | Nota pemasok | Toko › **Penerimaan barang** → *Saldo awal utang* (bagian bawah); Akuntansi › Saldo awal kelompok utang | Tanda tangan *Utang pemasok* (US-M7-08 / US-M11-07) | Pemilik |  |
| 10 | **Bagan akun & pemetaan jurnal** | Akuntan | Akuntansi › **Bagan akun**, **Pemetaan jurnal otomatis** (bawaan seed produksi, ditinjau & disesuaikan) | Berita acara tinjauan akuntan (lampiran) → pemilik **Aktifkan M11** (§3) | Akuntan |  |
| 11 | **Ekuitas saldo awal** | Akuntan | Akuntansi › **Saldo awal** kelompok ekuitas | Tanda tangan *Ekuitas saldo awal* | Pemilik |  |
| 12 | **Neraca awal** | Semua kelompok akuntansi di atas | Akuntansi › Saldo awal → akuntan *Sahkan saldo awal* → **Posting jurnal saldo awal** | Pengesahan akuntan (US-M11-09) | Akuntan |  |

Setelah ditandatangani, perubahan hanya lewat **koreksi berjejak** (*Ajukan koreksi* / *Ajukan penyesuaian* ≤ PAR-62,
3 bulan setelah cut-over, catatan akuntan + persetujuan pemilik).

## 2. Validasi satu akun buku per rekening bank (D-12 butir 4 / B-79) — WAJIB sebelum baris 7 ditandatangani

Basis data menolak dua rekening bank memakai akun buku yang sama (indeks unik `bank_accounts_gl_account_uq`) dan
rekonsiliasi bank M11 dilakukan per rekening. Saat memasukkan rekening PT:

1. Kas › **Kas kantor & setor bank** → *Tambah rekening* (bank, nomor, nama pemilik rekening, cabang, tampil ke
   pelanggan?). Biarkan akun buku **"— buat akun buku baru otomatis —"** → sistem membuat akun `1-12NN` sendiri untuk
   rekening itu (di bawah induk bank pada bagan akun).
2. Bila memilih akun buku yang sudah ada, pastikan akun itu **belum dipakai rekening lain** (sistem menolak bila sudah).
3. Periksa daftar rekening: **tidak boleh ada** penanda *Akun buku dipakai bersama* atau *Belum punya akun buku*.
   Bila ada → *Tetapkan akun buku sendiri* (alasan wajib, berjejak).
4. Cocokkan: jumlah rekening aktif = jumlah akun buku bank di Akuntansi › Bagan akun; saldo awal tiap rekening di
   Akuntansi › Saldo awal = saldo rekening koran tanggal cut-over.
5. Tanda tangan: ☐ Admin Keuangan (penyusun) ________ ☐ Pemilik ________

## 3. Aktivasi jurnal otomatis M11 (B-84 / D-13 butir 3)

Sampai diaktifkan, M11 hanya menjurnal bila SEMUA pemetaan wajib lengkap; peristiwa lain dibangkitkan retroaktif saat
aktif (PTB-47).

1. **Akuntan** meninjau Akuntansi › **Pemetaan jurnal otomatis** (setiap peristiwa wajib PRD 7.11.4 → akun debit/kredit
   & pusat laba) dan **Bagan akun** — termasuk kategori arus kas (B-57) serta alokasi L1 → L3 & eliminasi markup (B-76).
2. Admin Keuangan melengkapi/menyesuaikan pemetaan sesuai catatan akuntan (berjejak).
3. Berita acara tinjauan pemetaan ditandatangani akuntan: ________ tanggal ________
4. **Pemilik** menekan **Aktifkan M11** (Akuntansi › Pemetaan jurnal otomatis; alasan wajib). Sistem menolak bila masih
   ada pemetaan wajib yang belum lengkap/aktif.
5. Periksa Akuntansi › Jurnal › **Daftar tunggu** kosong dan *Rekonsiliasi harian* = H+0; akuntan memverifikasi jurnal
   **retroaktif** (Jurnal › Retroaktif) sebelum periode pertama ditutup.

## 4. Cut-over akuntansi (tanggal 1)

- [ ] Pemilik menetapkan tanggal cut-over (Akuntansi › Saldo awal) — hanya tanggal 1: ________
- [ ] PT berdiri (akta, NIB, NPWP, rekening atas nama PT) sebelum tanggal cut-over (BRD B9).
- [ ] Uji: jurnal bertanggal sebelum cut-over **ditolak** (EQ006); jurnal saldo awal **diterima** (NFR-36).
- [ ] Periode pertama terbuka; pajak: skema non-PKP sesuai konsultan (Akuntansi › Pajak).

## 5. Keputusan go/no-go (komite pengarah)

| Syarat | Bukti | Status |
|---|---|---|
| Semua kelompok §1 berstatus *Ditandatangani* | Master › Tanda tangan data awal; Akuntansi › Saldo awal | ☐ |
| Satu akun buku per rekening (§2) | tanda tangan §2 | ☐ |
| M11 aktif setelah tinjauan akuntan (§3) | berita acara + jejak audit *Aktifkan M11* | ☐ |
| UAT per modul diterima, 0 cacat Kritis | `docs/uat/*.md` berita acara | ☐ |
| Pilot lulus (RL-3) / perluasan sesuai rencana | `docs/uat/pilot.md`, `docs/uat/paralel.md` | ☐ |
| Uji pemulihan cadangan sebelum go-live | Akses › Data pribadi → Cadangan (uji pemulihan, RPO/RTO) | ☐ |
| Daftar periksa deploy selesai | `docs/deploy/README.md` §9 | ☐ |

Keputusan: ☐ **GO** tanggal ________ ☐ **NO-GO** (tindakan: ________)

| Pemilik | Manajer proyek IT | Akuntan | Admin Keuangan |
|---|---|---|---|
| <br><br>(______________) | <br><br>(______________) | <br><br>(______________) | <br><br>(______________) |
