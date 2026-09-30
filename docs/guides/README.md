# Panduan pengguna EQUA ERP — indeks per peran

Panduan lapangan **1 halaman** per peran (NFR-16, pelatihan ≤ 2 jam; alur ≤ 3 langkah) ada di folder
[`lapangan/`](lapangan/) — cetak dan tempel di truk, depot, toko, dan sumber air. Panduan modul berisi rincian lengkap
per peran (web kantor). Semua teks layar Bahasa Indonesia dengan istilah lapangan (rit, setor, tempo, galon, tutup kas).

| Peran | Antarmuka | Mulai dari | Panduan lain |
|---|---|---|---|
| **Pemilik** | Web kantor (laptop & ponsel) | [Laporan & dashboard — H+0, Kotak masuk, laba kotor, KPI](m9-reports.md#pemilik) | Persetujuan & akses [M10](m10-access.md#pemilik) · selisih & kas [M4](m4-cash.md#pemilik) · piutang [M5](m5-receivables.md#pemilik) · pesanan [M2](m2-orders.md#pemilik) · master & tanda tangan data awal [M1](m1-master.md#pemilik) · outlet [M6](m6-pos.md#pemilik) · toko [M7](m7-store.md#pemilik) · neraca air [M8](m8-production.md#pemilik) · akuntansi, kunci periode, *Aktifkan M11* [M11](m11-accounting.md#pemilik) · armada [M12](m12-fleet.md) · kemitraan [P3](p3-partner.md#pemilik-equa) · aplikasi pelanggan [P2](p2-customer.md#pemilik) |
| **Admin Keuangan** | Web kantor | [Kas & setoran, tutup kas](m4-cash.md#admin-keuangan-kantor) | Piutang [M5](m5-receivables.md#admin-keuangan) · akuntansi & pajak [M11](m11-accounting.md#admin-keuangan) · dicatat kantor [M3](m3-driver.md#admin-keuangan--dicatat-kantor) · outlet [M6](m6-pos.md#admin-keuangan) · toko [M7](m7-store.md#admin-keuangan-kantor) · produksi [M8](m8-production.md#admin-keuangan) · laporan & periode paralel [M9](m9-reports.md#admin-keuangan) · master [M1](m1-master.md#admin-keuangan) · kontrak & tagihan mitra [P3](p3-partner.md#admin-keuangan) |
| **Dispatcher** | Web kantor | [Pesanan & papan jadwal](m2-orders.md#dispatcher) | Peta & riwayat truk [M12](m12-fleet.md#dispatcher--peta-truk) · kendala sopir [M3](m3-driver.md#dispatcher--kendala-sopir) · pelanggan & armada [M1](m1-master.md#dispatcher) · piutang pelanggan [M5](m5-receivables.md#dispatcher) · produksi [M8](m8-production.md#dispatcher) · aplikasi pelanggan [P2](p2-customer.md#dispatcher) |
| **Sopir & kernet** | Aplikasi `/sopir` (ponsel truk) | [**1 halaman**](lapangan/sopir-kernet.md) | Rincian [M3](m3-driver.md#sopir--kernet) · GPS [M12](m12-fleet.md#sopir--kernet-ringkas) · setoran [M4](m4-cash.md#sopir-operator-depot-kasir-toko-lapangan--1-halaman) · akun & PIN [M10](m10-access.md) |
| **Operator depot** | POS `/pos` (tablet depot) | [**1 halaman**](lapangan/operator-depot.md) | Rincian [M6](m6-pos.md#operator-depot-tablet-pos--1-halaman) · setoran [M4](m4-cash.md) |
| **Kasir toko** | POS `/pos` (tablet toko) | [**1 halaman**](lapangan/kasir-toko.md) | Rincian [M7](m7-store.md#kasir-toko-tablet-pos--1-halaman) · setoran [M4](m4-cash.md) |
| **Operator produksi** | Aplikasi `/produksi` (ponsel sumber air) | [**1 halaman**](lapangan/operator-produksi.md) | Rincian [M8](m8-production.md#operator-produksi-satu-halaman) |
| **Admin sistem (tim IT)** | Web kantor | [Pengguna, perangkat, sinkron, audit](m10-access.md#admin-sistem-tim-it) | Runbook operasional [`docs/ops/runbook.md`](../ops/runbook.md) · deploy [`docs/deploy/README.md`](../deploy/README.md) · master & impor [M1](m1-master.md#admin-sistem) · perangkat GPS [M12](m12-fleet.md#admin-sistem--perangkat-gps) · tenant & tablet POS [M6](m6-pos.md#admin-sistem) · akun mitra [P3](p3-partner.md#admin-sistem) · aplikasi pelanggan [P2](p2-customer.md#admin-sistem) · produksi [M8](m8-production.md#admin-sistem) |
| **Akuntan (baca-saja)** | Web kantor | [Akuntansi & laporan keuangan](m11-accounting.md#akuntan-baca-saja) | Laba kotor bulanan [M9](m9-reports.md#akuntan) · kas [M4](m4-cash.md#akuntan) · piutang [M5](m5-receivables.md#akuntan) · jejak audit keuangan [M10](m10-access.md#akuntan-baca-saja) |
| **Pemilik mitra** | Portal `/mitra` | [Portal pemilik mitra — 1 halaman](p3-partner.md#pemilik-mitra-portal-mitra--1-halaman) | — |
| **Operator depot mitra** | POS `/pos` (tablet mitra) | [1 halaman](lapangan/operator-depot.md) | [P3 — operator depot mitra](p3-partner.md#operator-depot-mitra-tablet-pos--1-halaman) |
| **Pembina wilayah** | Web kantor `/kemitraan` | [Kemitraan](p3-partner.md#pembina-wilayah-equa-web-kantor-kemitraan) | — |
| **Pelanggan** (Tahap 2, bila diaktifkan) | Aplikasi `/app` (ponsel) | [Aplikasi pelanggan](p2-customer.md#pelanggan-di-ponsel) | — |

## Panduan modul (rincian lengkap)

| Modul | Panduan |
|---|---|
| M1 Data master | [m1-master.md](m1-master.md) |
| M2 Pesanan & penjadwalan rit | [m2-orders.md](m2-orders.md) |
| M3 Aplikasi sopir | [m3-driver.md](m3-driver.md) |
| M4 Kas & setoran | [m4-cash.md](m4-cash.md) |
| M5 Piutang & penagihan | [m5-receivables.md](m5-receivables.md) |
| M6 Penjualan depot (POS) | [m6-pos.md](m6-pos.md) |
| M7 Penjualan toko & stok | [m7-store.md](m7-store.md) |
| M8 Produksi & stok air | [m8-production.md](m8-production.md) |
| M9 Laporan & dashboard | [m9-reports.md](m9-reports.md) |
| M10 Pengguna, hak akses & jejak audit | [m10-access.md](m10-access.md) |
| M11 Akuntansi & pajak | [m11-accounting.md](m11-accounting.md) |
| M12 Pelacakan armada / GPS | [m12-fleet.md](m12-fleet.md) |
| P2 Aplikasi pelanggan (Tahap 2) | [p2-customer.md](p2-customer.md) |
| P3 Kemitraan (RL-7 + Tahap 3) | [p3-partner.md](p3-partner.md) |

## Panduan lapangan 1 halaman

| Peran | Berkas |
|---|---|
| Sopir & kernet | [lapangan/sopir-kernet.md](lapangan/sopir-kernet.md) |
| Operator depot (EQUA & mitra) | [lapangan/operator-depot.md](lapangan/operator-depot.md) |
| Kasir toko | [lapangan/kasir-toko.md](lapangan/kasir-toko.md) |
| Operator produksi | [lapangan/operator-produksi.md](lapangan/operator-produksi.md) |

Menu **Bantuan** di web kantor dan aplikasi lapangan menyediakan laporan kendala ke tim IT (dijawab ≤ 1 minggu, PAR-87).
