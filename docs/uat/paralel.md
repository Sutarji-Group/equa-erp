# Perluasan & periode paralel (RL-4) — NFR-35, PAR-28/84/88 (PRD 11.5)

Setiap unit (truk atau depot) yang mulai memakai sistem menjalani **periode paralel maksimal 2 minggu** (PAR-28): nota
kertas dan sistem berjalan bersama, lalu nota kertas **ditarik** dan tanggalnya dicatat (masukan KPI-11). Tidak ada
pencatatan ganda di sistem — nota kertas hanya pembanding.

## Urutan gelombang (BRD 12.3)

| Gelombang | Unit | Minggu |
|---|---|---|
| 1 | lima truk sisanya | 1–2 |
| 2 | empat depot | 3–4 |
| 3 | empat depot | 5–6 |
| cadangan | pendampingan intensif / perpanjangan pengecualian | sisa bulan 8–9 |

## Di sistem: Laporan › Periode paralel (`/laporan/periode-paralel`)

| Langkah | Siapa | Layar & tindakan |
|---|---|---|
| 1. Mulai | Admin Keuangan / manajer proyek (admin sistem) | *Mulai periode paralel unit* (pilih truk/depot, tanggal mulai) saat unit baru memakai sistem |
| 2. Setiap hari | Admin Keuangan | **Lembar pencocokan harian** per unit: isi jumlah & nilai **nota kertas**; angka sistem dihitung otomatis. Berbeda → pilih **Terjelaskan / Tak terjelaskan** + **penyebab** (wajib). Koreksi lembar menimpa baris hari itu dan tercatat di jejak audit |
| 3a. Tarik hari ke-14 | Admin Keuangan | *Tarik nota kertas*: tanggal hari ke-14 atau sesudahnya → langsung tercatat |
| 3b. Tarik lebih awal | Admin Keuangan → pemilik | Tanggal < hari ke-14 → **diajukan ke pemilik** (Kotak masuk › Persetujuan menunggu) — hanya bila **PAR-84** terpenuhi: 5 hari operasi terakhir 100% transaksi tercatat di sumber, 0 selisih tak terjelaskan, pengguna bekerja tanpa pendampingan |
| 4. Belum memenuhi PAR-84 pada hari ke-14 | Admin Keuangan + juara lapangan | Nota kertas **tetap ditarik** (batas NFR-35); unit masuk **pendampingan intensif 1 minggu tanpa kertas** — juara lapangan mendampingi, Admin Keuangan mencocokkan harian dari data sistem |
| 5. Perpanjangan (pengecualian) | Komite pengarah → Admin Keuangan | *Perpanjang* hanya atas keputusan komite pengarah, **maksimal 1 minggu (PAR-88)**, alasan & nomor keputusan dicatat (CR-17) |

KPI-11 (adopsi lapangan) dihitung otomatis dari pengguna aktif per peran dan tanggal nota kertas ditarik per unit
(Laporan › KPI program).

## Kriteria per unit

| Kriteria | Ukuran | Sumber |
|---|---|---|
| Nota kertas ditarik ≤ hari ke-14 (atau pengecualian PAR-88 tercatat) | tanggal penarikan | Periode paralel |
| 100% transaksi tercatat di sumber (5 hari terakhir bila tarik lebih awal) | KPI-01 unit | KPI program, Laporan sopir (*Dicatat kantor*) |
| 0 selisih tak terjelaskan | lembar pencocokan | Periode paralel |
| Pengguna bekerja tanpa pendampingan | catatan juara lapangan | di luar sistem |

## Keluar RL-4 (PRD 11.1)

- Adopsi 100% (KPI-11): nota kertas ditarik di semua unit dengan tanggal tercatat.
- KPI-01 = 100% pada bulan berjalan.
- Data awal per kelompok ditandatangani (NFR-34, `docs/uat/cutover.md`) dan cut-over akuntansi tanggal 1 (NFR-36).

## Rekap gelombang (ditandatangani manajer proyek & pemilik)

| Unit | Mulai paralel | Tarik nota (tanggal) | Lebih awal? (disetujui pemilik) | Pendampingan intensif? | Perpanjangan PAR-88 (no. keputusan komite) | Paraf |
|---|---|---|:-:|:-:|---|---|
| T3 |  |  |  |  |  |  |
| … |  |  |  |  |  |  |
