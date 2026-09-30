# UAT RL-7 — Paket Minimum Mitra Fase 1 (RL-7)

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Pemilik (bersama Admin Keuangan) |
| Skenario BRD | BRD 9.9; P-01 untuk pesanan air mitra |
| User story diuji (PRD 11.3) | US-P3-08 s.d. US-P3-10 (M); US-P3-11 (S) |
| Data uji | Tenant uji dan mitra pertama (termasuk skenario mitra dua outlet PRD 9.7); satu bulan tagihan langganan |
| Akun uji | Admin sistem, Admin Keuangan, pemilik EQUA, pembina wilayah (`pembina1`), pemilik mitra (`mitra1`, portal `/mitra`), operator POS mitra (`opmitra1`) |
| Panduan pengguna | `docs/guides/p3-partner.md` |
| Jumlah | 4 user story · 16 KP |

## Persiapan

- [ ] Syarat masuk Bab 9.10: TG-8, studi K22, PT berdiri, perjanjian Opsi B, M6 ≥ 3 bulan, uji isolasi & penetrasi tenant (B-74).
- [ ] Tenant mitra dibuat (Depot & toko › Tenant & paket POS); satu pelanggan mitra per outlet; kontrak per outlet disetujui pemilik (D-13 butir 1).
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-P3-08 Pasokan air mitra tercatat di POS mitra dan neraca air per mitra — M (Fase 1)

**Layar:** Kemitraan › Pasokan & neraca mitra (`/kemitraan/pasokan`); POS mitra › Pasokan air  
**Rujukan PRD:** baris 2112

**Langkah uji:**
1. Pesan air untuk pelanggan mitra (M2) → rit Selesai → pasokan *Tiba* di POS mitra → operator mitra mengonfirmasi (beda → alasan, Dispatcher diberi tahu).
2. Neraca air per mitra per bulan; kelebihan > PAR-79 → notifikasi pemilik; pesanan air mitra lewat PAR-76 ditandai.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Pelanggan mitra (M1, segmen depot pihak ketiga dengan penanda mitra depot EQUA, BR-18) ditautkan ke tenant dan outlet mitra (US-M6-07); pesanan air mitra dibuat di M2 seperti pelanggan biasa dengan harga zona Opsi B (BRD 9.6). | ☐ | ☐ |  |
| 2 | Rit pelanggan mitra yang Selesai di M3 muncul di POS outlet mitra sebagai "pasokan tiba" dan dikonfirmasi operator mitra seperti US-M6-05 KP-1–2; selisih kirim–terima ditandai ke Dispatcher. | ☐ | ☐ |  |
| 3 | Neraca air per mitra per bulan: galon terjual × 19 L vs air diterima dari EQUA; selisih di atas PAR-79 ditandai ke pemilik (BRD 9.9), memakai perhitungan yang sama dengan US-M6-05 KP-4. | ☐ | ☐ |  |
| 4 | Pesanan air mitra yang belum Selesai > 24 jam sejak dibuat (PAR-76) ditandai ke Dispatcher dan pemilik (6.3). | ☐ | ☐ |  |
| 5 | Isolasi data tetap berlaku (NFR-30): EQUA hanya melihat data yang diperjanjikan (penjualan, pasokan, neraca air). | ☐ | ☐ |  |

### US-P3-09 Tagihan langganan sistem bulanan untuk mitra — M (Fase 1)

**Layar:** Kemitraan › Kontrak mitra (`/kemitraan/kontrak`), Tagihan langganan (`/kemitraan/langganan`); Piutang  
**Rujukan PRD:** baris 2122

**Langkah uji:**
1. Admin Keuangan input kontrak per outlet → pemilik menyetujui; tgl 1: faktur langganan = outlet aktif × tarif (per outlet untuk mitra dua outlet), jatuh tempo PAR-12.
2. Pelunasan & umur piutang di M5 (lini Kemitraan); jurnal pendapatan L5 pada bulan layanan; perubahan tarif berlaku bulan berikutnya.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Faktur berulang per mitra: jumlah outlet aktif × tarif langganan (PAR-35), terbit tanggal 1 untuk bulan sebelumnya dengan jatuh tempo mengikuti PAR-12; tarif dan tanggal mulai diambil dari data kontrak yang diinput Admin Keuangan dan disetujui pemilik (6.2a). | ☐ | ☐ |  |
| 2 | Faktur mengikuti M5: pelunasan, pengingat, umur piutang, dan penahanan (US-M5-02 s.d. US-M5-05); mitra bertanda tagihan bulanan dapat menggabungkan faktur air/spare part tempo ke faktur yang sama (BR-05). | ☐ | ☐ |  |
| 3 | Jurnal otomatis: pendapatan langganan sistem pada pusat laba L5 (US-M11-02); tanpa royalti pada Opsi B. | ☐ | ☐ |  |
| 4 | Faktur tidak dapat dihapus; koreksi lewat nota kredit beralasan (BR-38). | ☐ | ☐ |  |

### US-P3-10 Akses baca Pemilik mitra dan laporan bulanan — M (Fase 1)

**Layar:** Portal pemilik mitra `/mitra` (beranda, penjualan, pasokan, tagihan, laporan bulanan)  
**Rujukan PRD:** baris 2131

**Langkah uji:**
1. Pemilik mitra login portal (akun mitra tidak dapat membuka web kantor) → data hanya tenantnya; angka penjualan = laporan EQUA.
2. Laporan bulanan terbit tgl 5 (PDF, tidak berubah setelah terbit); coba buka faktur/outlet tenant lain → ditolak & tercatat.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Peran "Pemilik mitra" (US-M10-01): baca-saja, lingkup tenant sendiri, lewat web kantor terbatas; akun mengikuti persetujuan US-M10-01 KP-8. | ☐ | ☐ |  |
| 2 | Laporan yang terlihat: penjualan per hari per outlet, galon, void, selisih shift, pasokan diterima, neraca air versi mitra, tagihan dan pembayaran — data yang sama dengan yang dipakai EQUA. | ☐ | ☐ |  |
| 3 | Laporan bulanan mitra (kewajiban EQUA, BRD 9.8) terbit otomatis tanggal 5 [USULAN] dan dapat diunduh PDF (US-M9-03). | ☐ | ☐ |  |
| 4 | Tidak ada tampilan data mitra lain atau data EQUA (NFR-30); percobaan akses lintas tenant ditolak dan tercatat (US-M10-03). | ☐ | ☐ |  |

### US-P3-11 Permintaan dukungan teknis mitra dengan SLA 48 jam — S (Fase 1)

**Layar:** Portal › Dukungan teknis; kantor: Kemitraan › Dukungan teknis (`/kemitraan/dukungan`)  
**Rujukan PRD:** baris 2140

**Langkah uji:**
1. Mitra mengirim permintaan + foto → pembina menanggapi ≤ 48 jam → Selesai; SLA terlewat → notifikasi; kepatuhan SLA di laporan bulanan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Permintaan: jenis (peralatan, spare part, sistem, mutu air), uraian, foto, outlet; status Diajukan → Ditanggapi → Selesai dengan waktu setiap perubahan. | ☐ | ☐ |  |
| 2 | Waktu tanggap dihitung dari Diajukan ke Ditanggapi; lewat 48 jam (PAR-76) → notifikasi pemilik (6.3); ringkasan kepatuhan SLA per bulan masuk laporan bulanan mitra (US-P3-10 KP-3). | ☐ | ☐ |  |
| 3 | Spare part yang dibutuhkan dipesan lewat M7 dengan harga mitra (BR-18) dan dirujuk dari permintaan. | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| B-74 / PRD 9.6 | Uji penetrasi lintas tenant MANUAL sebelum mitra pertama aktif (URL langsung, ID objek tenant lain, ekspor, lampiran) melengkapi uji otomatis `tests/p3-partner/portal.test.ts`. | ☐ | ☐ |  |
| PRD 9.7 / D-13 butir 1 | Mitra dua outlet: dua pelanggan mitra + dua kontrak (satu per outlet), wilayah eksklusif per outlet, dua faktur langganan (uji otomatis `tests/p3-partner/two-outlets.test.ts`); batas kredit bersama & faktur gabungan TIDAK dibangun. | ☐ | ☐ |  |
| B-74 / NFR-03 | Portal mitra dibuka dari ponsel pemilik mitra di jaringan 4G ≤ 2 detik per layar. | ☐ | ☐ |  |

## Catatan cacat

| No | US / KP | Uraian & langkah mereproduksi | Kelas | Penanggung jawab | Tenggat | Status |
|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |

## Kelas cacat (PRD 11.2)

| Kelas | Definisi | Konsekuensi |
|---|---|---|
| **Kritis** | Transaksi tidak dapat dicatat, hilang, dobel, atau dapat diubah tanpa jejak; kebocoran data lintas peran/tenant; salah hitung uang | Menahan rilis; ditanggapi ≤ 30 menit setelah go-live (NFR-31) |
| **Mayor** | Fungsi M tidak bekerja sesuai KP tetapi ada jalan lain berjejak | Menahan rilis kecuali komite pengarah menerima dengan tenggat perbaikan |
| **Minor** | Ketidaknyamanan, teks, tampilan | Masuk backlog; tidak menahan rilis |

User story **lulus** bila seluruh KP dijawab "lulus" oleh pemilik modul pada UAT dengan data nyata dan cacat tersisa bukan
Kritis/Mayor. User story prioritas M yang tidak lulus menahan rilis (PRD 11.2).

## Berita acara (PRD 11.3)

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — RL-7 Paket Minimum Mitra Fase 1 (RL-7)**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Pemilik (bersama Admin Keuangan) — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | BRD 9.9; P-01 untuk pesanan air mitra |
| Data uji | Tenant uji dan mitra pertama (termasuk skenario mitra dua outlet PRD 9.7); satu bulan tagihan langganan |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-P3-08 |  | __ / __ |  |
| US-P3-09 |  | __ / __ |  |
| US-P3-10 |  | __ / __ |  |
| US-P3-11 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
