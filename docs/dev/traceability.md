# Ketertelusuran user story → uji otomatis

> **DIBANGKITKAN OTOMATIS oleh `pnpm trace` (tools/trace-check.ts) — jangan diedit manual.**
> Sumber: `docs/prd/PRD_EQUA_v1_1.md` (KP = baris bernomor di bawah "Kriteria penerimaan:") dan judul
> `describe`/`it`/`test` di `tests/**/*.test.ts(x)` + `e2e/**/*.spec.ts` yang memuat `US-Mx-nn` dan `KP-n`.

## Ringkasan

- **Prioritas M:** 134/490 KP (27.3%) · story: 13 lengkap, 37 sebagian, 44 belum
- **Semua prioritas:** 143/554 KP (25.8%) · story: 13 lengkap, 42 sebagian, 59 belum
- Uji dipindai: 498 judul di 60 berkas; 316 judul merujuk user story.

| Modul | Story | Lengkap | Sebagian | Belum | KP tercakup | % |
|---|---:|---:|---:|---:|---:|---:|
| M1 — Master Data | 6 | 6 | 0 | 0 | 36/36 | 100.0 |
| M2 — Pesanan & Penjadwalan Rit | 11 | 0 | 5 | 6 | 8/51 | 15.7 |
| M3 — Aplikasi Sopir | 10 | 0 | 6 | 4 | 8/55 | 14.5 |
| M4 — Kas & Setoran | 6 | 0 | 2 | 4 | 2/36 | 5.6 |
| M5 — Piutang & Penagihan | 7 | 0 | 3 | 4 | 4/32 | 12.5 |
| M6 — Penjualan Depot (POS) | 7 | 0 | 7 | 0 | 17/42 | 40.5 |
| M7 — Penjualan Toko & Stok | 9 | 0 | 4 | 5 | 5/37 | 13.5 |
| M8 — Produksi & Stok Air | 7 | 0 | 2 | 5 | 3/29 | 10.3 |
| M9 — Laporan & Dashboard Pemilik | 7 | 0 | 2 | 5 | 6/31 | 19.4 |
| M10 — Pengguna, Hak Akses & Jejak Audit | 7 | 7 | 0 | 0 | 41/41 | 100.0 |
| M11 — Akuntansi & Pajak | 10 | 0 | 6 | 4 | 7/47 | 14.9 |
| M12 — Pelacakan Armada / GPS | 8 | 0 | 2 | 6 | 3/36 | 8.3 |
| P2 — Tahap 2: Aplikasi Pelanggan | 8 | 0 | 1 | 7 | 1/32 | 3.1 |
| P3 — Tahap 3: Portal Kemitraan / Frenchise | 11 | 0 | 2 | 9 | 2/49 | 4.1 |

Status: **lengkap** = semua KP punya uji; **sebagian** = sebagian KP punya uji; **belum** = belum ada KP yang teruji
(kolom *Uji* tetap menghitung uji yang hanya menyebut ID story tanpa KP).

## M1 — Master Data

36/36 KP (100.0%) · story: 6 lengkap, 0 sebagian, 0 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M1-01 | Mengelola pelanggan dan alamat kirim | M | 10/10 | lengkap | — | 29 |
| US-M1-02 | Mengelola produk dan harga tiga lini | M | 6/6 | lengkap | — | 10 |
| US-M1-03 | Mengelola armada, kru, dan perangkat | M | 4/4 | lengkap | — | 4 |
| US-M1-04 | Mengelola depot, sumber air, dan karyawan | M | 4/4 | lengkap | — | 6 |
| US-M1-05 | Mengelola zona tarif dan pemetaan alamat | M | 6/6 | lengkap | — | 13 |
| US-M1-06 | Mengimpor data awal dan membersihkan duplikat | M | 6/6 | lengkap | — | 13 |

## M2 — Pesanan & Penjadwalan Rit

8/51 KP (15.7%) · story: 0 lengkap, 5 sebagian, 6 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M2-01 | Membuat pesanan dalam kurang dari 60 detik | M | 2/8 | sebagian | 2, 4, 5, 6, 7, 8 | 2 |
| US-M2-02 | Nomor dan status pesanan | M | 1/4 | sebagian | 2, 3, 4 | 2 |
| US-M2-03 | Papan jadwal rit harian | M | 0/7 | belum | 1, 2, 3, 4, 5, 6, 7 | 0 |
| US-M2-04 | Peringatan pesanan dobel | M | 0/3 | belum | 1, 2, 3 | 0 |
| US-M2-05 | Kontrol kredit pada pesanan tempo | M | 1/6 | sebagian | 1, 2, 3, 4, 5 | 1 |
| US-M2-06 | Pesanan berulang / langganan | S | 2/4 | sebagian | 1, 4 | 1 |
| US-M2-07 | Konfirmasi pesanan ke pelanggan lewat WA | S | 2/3 | sebagian | 3 | 2 |
| US-M2-08 | Riwayat dan catatan khusus pelanggan | M | 0/3 | belum | 1, 2, 3 | 0 |
| US-M2-09 | Pembatalan, penjadwalan ulang, dan rit gagal | M | 0/4 | belum | 1, 2, 3, 4 | 0 |
| US-M2-10 | Jadwal kerja kru dan ketersediaan truk | S | 0/4 | belum | 1, 2, 3, 4 | 0 |
| US-M2-11 | Penetapan pengemudi pengganti harian | M | 0/5 | belum | 1, 2, 3, 4, 5 | 5 |

## M3 — Aplikasi Sopir

8/55 KP (14.5%) · story: 0 lengkap, 6 sebagian, 4 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M3-01 | Melihat daftar rit hari ini dan menuju lokasi | M | 0/7 | belum | 1, 2, 3, 4, 5, 6, 7 | 0 |
| US-M3-02 | Mencatat Berangkat dan Tiba dengan waktu dan lokasi otomatis | M | 0/6 | belum | 1, 2, 3, 4, 5, 6 | 0 |
| US-M3-03 | Menyelesaikan rit dengan bukti kirim | M | 1/7 | sebagian | 1, 2, 3, 4, 5, 7 | 8 |
| US-M3-04 | Mencatat pembayaran per rit | M | 2/6 | sebagian | 3, 4, 5, 6 | 3 |
| US-M3-05 | Menerima pelunasan piutang saat pengiriman | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-M3-06 | Menandai rit gagal, melaporkan kendala, dan memberi keterangan perjalanan | M | 1/4 | sebagian | 1, 2, 3 | 1 |
| US-M3-07 | Melihat kas di tangan dan menyetor akhir hari | M | 0/6 | belum | 1, 2, 3, 4, 5, 6 | 0 |
| US-M3-08 | Mencatat pengeluaran rit | S | 1/3 | sebagian | 1, 3 | 1 |
| US-M3-09 | Bekerja tanpa sinyal dan menyinkronkan otomatis | M | 2/5 | sebagian | 1, 3, 5 | 9 |
| US-M3-10 | Keamanan perangkat dan kesiapan lapangan | M | 1/6 | sebagian | 2, 3, 4, 5, 6 | 7 |

## M4 — Kas & Setoran

2/36 KP (5.6%) · story: 0 lengkap, 2 sebagian, 4 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M4-01 | Melihat posisi kas harian per sumber | M | 1/5 | sebagian | 1, 2, 4, 5 | 2 |
| US-M4-02 | Menerima setoran dan menghitung selisih | M | 0/10 | belum | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 | 0 |
| US-M4-03 | Menindaklanjuti selisih dan mencatat ganti rugi | M | 0/6 | belum | 1, 2, 3, 4, 5, 6 | 0 |
| US-M4-04 | Mencatat dan mencocokkan transfer masuk | M | 1/5 | sebagian | 2, 3, 4, 5 | 1 |
| US-M4-05 | Kas kantor, setor ke bank, dan kas kecil | M | 0/3 | belum | 1, 2, 3 | 0 |
| US-M4-06 | Menutup kas harian dan menerbitkan ringkasan H+0 | M | 0/7 | belum | 1, 2, 3, 4, 5, 6, 7 | 0 |

## M5 — Piutang & Penagihan

4/32 KP (12.5%) · story: 0 lengkap, 3 sebagian, 4 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M5-01 | Piutang terbentuk otomatis dari pengiriman dan penjualan tempo | M | 1/6 | sebagian | 1, 2, 3, 4, 5 | 2 |
| US-M5-02 | Mencatat pelunasan dan alokasinya | M | 2/5 | sebagian | 1, 3, 5 | 2 |
| US-M5-03 | Kontrol jatuh tempo dan status Ditahan | M | 1/6 | sebagian | 1, 2, 4, 5, 6 | 1 |
| US-M5-04 | Laporan umur piutang dan kartu piutang | M | 0/4 | belum | 1, 2, 3, 4 | 0 |
| US-M5-05 | Pengingat jatuh tempo lewat WA | S | 0/3 | belum | 1, 2, 3 | 0 |
| US-M5-06 | Faktur bulanan untuk pelanggan tagihan bulanan | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-M5-07 | Saldo awal piutang saat cut-over | M | 0/3 | belum | 1, 2, 3 | 0 |

## M6 — Penjualan Depot (POS)

17/42 KP (40.5%) · story: 0 lengkap, 7 sebagian, 0 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M6-01 | Transaksi cepat di POS depot | M | 3/7 | sebagian | 3, 5, 6, 7 | 3 |
| US-M6-02 | Buka dan tutup shift dengan kas dan stok fisik; setoran outlet | M | 4/7 | sebagian | 3, 6, 7 | 3 |
| US-M6-03 | Void dengan alasan | M | 2/5 | sebagian | 3, 4, 5 | 3 |
| US-M6-04 | Stok bahan habis pakai dan opname mingguan | M | 1/6 | sebagian | 2, 3, 4, 5, 6 | 2 |
| US-M6-05 | Menerima pasokan air dan neraca air outlet | M | 2/6 | sebagian | 2, 4, 5, 6 | 2 |
| US-M6-06 | Bekerja tanpa sinyal | M | 3/5 | sebagian | 4, 5 | 3 |
| US-M6-07 | Paket standar multi-tenant | M | 2/6 | sebagian | 1, 4, 5, 6 | 3 |

## M7 — Penjualan Toko & Stok

5/37 KP (13.5%) · story: 0 lengkap, 4 sebagian, 5 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M7-01 | POS toko dengan harga mitra dan umum | M | 0/6 | belum | 1, 2, 3, 4, 5, 6 | 0 |
| US-M7-02 | Penerimaan barang dari pemasok dan kartu stok | M | 2/6 | sebagian | 2, 3, 4, 5 | 2 |
| US-M7-03 | Stok minimum dan daftar pesan ulang | M | 0/3 | belum | 1, 2, 3 | 0 |
| US-M7-04 | Penjualan tempo untuk mitra terdaftar | M | 1/5 | sebagian | 1, 2, 4, 5 | 1 |
| US-M7-05 | Stok opname dan penyesuaian | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-M7-06 | Transfer internal bahan ke depot sendiri | M | 1/3 | sebagian | 2, 3 | 1 |
| US-M7-07 | Laporan barang laris/mati dan margin per barang | S | 0/3 | belum | 1, 2, 3 | 0 |
| US-M7-08 | Utang pemasok dan jadwal pembayaran | S | 1/3 | sebagian | 1, 3 | 2 |
| US-M7-09 | Kas toko harian dan setoran | M | 0/3 | belum | 1, 2, 3 | 0 |

## M8 — Produksi & Stok Air

3/29 KP (10.3%) · story: 0 lengkap, 2 sebagian, 5 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M8-01 | Mencatat produksi harian dari angka meter dengan foto | M | 1/5 | sebagian | 1, 2, 3, 4 | 2 |
| US-M8-02 | Mencatat pengisian truk per rit | M | 2/6 | sebagian | 1, 3, 4, 5 | 2 |
| US-M8-03 | Pasokan air ke depot sendiri | M | 0/4 | belum | 1, 2, 3, 4 | 0 |
| US-M8-04 | Neraca air harian per sumber dan susut | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-M8-05 | Utilisasi kapasitas dan peringatan | S | 0/3 | belum | 1, 2, 3 | 0 |
| US-M8-06 | Catatan mutu air | S | 0/3 | belum | 1, 2, 3 | 0 |
| US-M8-07 | Bekerja tanpa sinyal di sumber air | M | 0/3 | belum | 1, 2, 3 | 0 |

## M9 — Laporan & Dashboard Pemilik

6/31 KP (19.4%) · story: 0 lengkap, 2 sebagian, 5 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M9-01 | Dashboard H+0 | M | 0/7 | belum | 1, 2, 3, 4, 5, 6, 7 | 0 |
| US-M9-02 | Laporan bulanan laba kotor per lini dan konsolidasi | M | 0/6 | belum | 1, 2, 3, 4, 5, 6 | 0 |
| US-M9-03 | Ekspor Excel/PDF | M | 3/4 | sebagian | 3 | 11 |
| US-M9-04 | Kotak masuk pengecualian dan pengaturan notifikasi pemilik | S | 3/4 | sebagian | 2 | 9 |
| US-M9-05 | Kinerja per sopir/truk dan per depot/operator | S | 0/4 | belum | 1, 2, 3, 4 | 0 |
| US-M9-06 | Tren mingguan/bulanan | S | 0/3 | belum | 1, 2, 3 | 0 |
| US-M9-07 | Laporan KPI program (KPI-01–KPI-11) | S | 0/3 | belum | 1, 2, 3 | 0 |

## M10 — Pengguna, Hak Akses & Jejak Audit

41/41 KP (100.0%) · story: 7 lengkap, 0 sebagian, 0 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M10-01 | Peran, pengguna, dan lingkup akses | M | 8/8 | lengkap | — | 34 |
| US-M10-02 | Login, PIN, perangkat terdaftar, dan sesi | M | 7/7 | lengkap | — | 41 |
| US-M10-03 | Pemisahan tugas dipaksakan | M | 4/4 | lengkap | — | 23 |
| US-M10-04 | Alur persetujuan | M | 6/6 | lengkap | — | 23 |
| US-M10-05 | Jejak audit | M | 6/6 | lengkap | — | 21 |
| US-M10-06 | Data pribadi, retensi, dan pencadangan | M | 6/6 | lengkap | — | 11 |
| US-M10-07 | Kesehatan perangkat, sinkron, dan pemantauan | M | 4/4 | lengkap | — | 12 |

## M11 — Akuntansi & Pajak

7/47 KP (14.9%) · story: 0 lengkap, 6 sebagian, 4 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M11-01 | Bagan akun dan pusat laba | M | 1/5 | sebagian | 2, 3, 4, 5 | 1 |
| US-M11-02 | Jurnal otomatis dari seluruh transaksi operasional | M | 2/5 | sebagian | 2, 4, 5 | 13 |
| US-M11-03 | Jurnal manual dengan lampiran dan persetujuan | M | 1/6 | sebagian | 1, 2, 4, 5, 6 | 1 |
| US-M11-04 | Buku besar dan laporan keuangan | M | 1/5 | sebagian | 1, 3, 4, 5 | 1 |
| US-M11-05 | Aset tetap dan penyusutan otomatis | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-M11-06 | Rekonsiliasi bank dan kas | M | 0/4 | belum | 1, 2, 3, 4 | 0 |
| US-M11-07 | Utang usaha kepada pemasok | S | 0/3 | belum | 1, 2, 3 | 0 |
| US-M11-08 | Pelaporan pajak PT non-PKP dan pemantauan batas PKP | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-M11-09 | Saldo awal dan cut-over akuntansi | M | 1/4 | sebagian | 2, 3, 4 | 4 |
| US-M11-10 | Tutup dan kunci periode | M | 1/5 | sebagian | 1, 2, 4, 5 | 2 |

## M12 — Pelacakan Armada / GPS

3/36 KP (8.3%) · story: 0 lengkap, 2 sebagian, 6 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-M12-01 | Menerima posisi dari perangkat GPS truk dan cadangan ponsel | M | 2/6 | sebagian | 2, 3, 4, 5 | 1 |
| US-M12-02 | Peta posisi truk real-time | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-M12-03 | Riwayat perjalanan per rit dan per hari | M | 0/4 | belum | 1, 2, 3, 4 | 0 |
| US-M12-04 | Pencocokan lokasi Selesai dengan alamat pelanggan | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-M12-05 | Perjalanan di luar jadwal atau jam operasional | M | 1/5 | sebagian | 1, 2, 4, 5 | 1 |
| US-M12-06 | Geofence sumber air dan depot | S | 0/4 | belum | 1, 2, 3, 4 | 0 |
| US-M12-07 | Jarak per rit untuk biaya BBM dan pemeriksaan zona | S | 0/3 | belum | 1, 2, 3 | 0 |
| US-M12-08 | Peringatan perangkat mati atau dicabut | M | 0/4 | belum | 1, 2, 3, 4 | 0 |

## P2 — Tahap 2: Aplikasi Pelanggan

1/32 KP (3.1%) · story: 0 lengkap, 1 sebagian, 7 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-P2-01 | Mendaftar dengan verifikasi nomor WA dan menyimpan alamat | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P2-02 | Memesan air truk dengan tanggal/slot dan harga transparan | M | 1/6 | sebagian | 1, 2, 3, 5, 6 | 1 |
| US-P2-03 | Memantau status dan posisi truk | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P2-04 | Riwayat, struk, tagihan, dan pembayaran digital | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P2-05 | Langganan berkala dan pengingat isi ulang | S | 0/3 | belum | 1, 2, 3 | 0 |
| US-P2-06 | Penilaian layanan dan keluhan | S | 0/3 | belum | 1, 2, 3 | 0 |
| US-P2-07 | Memesan galon antar dari depot terdekat | C | 0/2 | belum | 1, 2 | 0 |
| US-P2-08 | Kanal WhatsApp Business API dan notifikasi pelanggan | M | 0/3 | belum | 1, 2, 3 | 0 |

## P3 — Tahap 3: Portal Kemitraan / Frenchise

2/49 KP (4.1%) · story: 0 lengkap, 2 sebagian, 9 belum

| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |
|---|---|:-:|---:|---|---|---:|
| US-P3-01 | Pendaftaran, penilaian lokasi, kontrak, dan onboarding mitra | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P3-02 | POS depot standar dengan data terpisah per mitra | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P3-03 | Memesan air dan spare part ke EQUA dengan harga mitra dan tagihan | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P3-04 | Royalti/fee otomatis, tagihan mitra, dan pembayaran | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P3-05 | Standar mutu: daftar periksa harian, jadwal audit, hasil uji air | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P3-06 | Dashboard kinerja mitra dan pembina wilayah | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P3-07 | Sanksi bertingkat, pemutusan, dan pelepasan | M | 0/3 | belum | 1, 2, 3 | 0 |
| US-P3-08 | Pasokan air mitra tercatat di POS mitra dan neraca air per mitra | M | 0/5 | belum | 1, 2, 3, 4, 5 | 0 |
| US-P3-09 | Tagihan langganan sistem bulanan untuk mitra | M | 1/4 | sebagian | 2, 3, 4 | 1 |
| US-P3-10 | Akses baca Pemilik mitra dan laporan bulanan | M | 1/4 | sebagian | 2, 3, 4 | 1 |
| US-P3-11 | Permintaan dukungan teknis mitra dengan SLA 48 jam | S | 0/3 | belum | 1, 2, 3 | 0 |
