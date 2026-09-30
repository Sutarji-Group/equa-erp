# UAT M5 — Piutang & Penagihan

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Admin Keuangan |
| Skenario BRD | P-05 |
| User story diuji (PRD 11.3) | US-M5-01 s.d. US-M5-04, US-M5-06, US-M5-07 (M); US-M5-05 (S) |
| Data uji | Piutang berjalan nyata 15–30 pelanggan (faktur kertas terkonfirmasi untuk saldo awal) |
| Akun uji | Admin Keuangan (`keuangan1`), pemilik (`pemilik`), sopir (pelunasan lapangan) |
| Panduan pengguna | `docs/guides/m5-receivables.md` |
| Jumlah | 7 user story · 32 KP |

## Persiapan

- [ ] Rit tempo & kurang bayar dari UAT M3, penjualan tempo toko dari UAT M7; kunci Resend & domain terverifikasi untuk uji e-mail nyata (B-77).
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M5-01 Piutang terbentuk otomatis dari pengiriman dan penjualan tempo — M

**Layar:** Piutang › Faktur (`/piutang/faktur`), Kartu piutang (`/piutang/pelanggan/[id]`)  
**Rujukan PRD:** baris 948

**Langkah uji:**
1. Rit tempo/kurang bayar Selesai → faktur terbit otomatis (H+0); penjualan tempo toko → faktur saat tutup shift; saldo & eksposur tampil di kartu pelanggan M1 dan aplikasi sopir.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Rit Selesai bercara-bayar tempo → faktur kirim otomatis per rit (PTB-24): nomor (mengikuti PTB-14), tanggal kirim, pelanggan, alamat, nomor rit, volume, harga, jatuh tempo = tanggal kirim + tempo pelanggan (PAR-08). Penjualan tempo toko → faktur per transaksi (M7). Kurang bayar lapangan (PTB-18) → faktur jatuh tempo H+0. | ☐ | ☐ |  |
| 2 | Pelanggan bertanda "tagihan bulanan" (BR-05): rit tempo masuk daftar "belum ditagih" dan ditagih lewat faktur bulanan (US-M5-06), bukan faktur per rit. | ☐ | ☐ |  |
| 3 | Saldo piutang pelanggan = Σ sisa faktur terbuka + belum ditagih; eksposur (BR-06) = saldo piutang + nilai pesanan tempo Baru/Terjadwal/Dalam pengiriman; keduanya tampil di M1, M2, dan aplikasi sopir (data sinkron). | ☐ | ☐ |  |
| 4 | Satu batas kredit per pelanggan berlaku lintas lini (air truk dan toko) [ASUMSI-PRD PTB-25]. | ☐ | ☐ |  |
| 5 | Faktur dapat diunduh PDF dengan identitas PT (Bab 2.3), tanpa PPN dan tanpa faktur pajak (BR-29), dan dikirim via tautan WA/e-mail; pengiriman tercatat. | ☐ | ☐ |  |
| 6 | Faktur tidak dapat dihapus; koreksi lewat nota kredit/pembalik beralasan (BR-38). | ☐ | ☐ |  |

### US-M5-02 Mencatat pelunasan dan alokasinya — M

**Layar:** Piutang › Pelunasan (`/piutang/pelunasan`)  
**Rujukan PRD:** baris 959

**Langkah uji:**
1. Pelunasan tunai kantor & transfer (bukti wajib), alokasi otomatis ke faktur tertua; kelebihan → uang muka.
2. *Balik pelunasan* beralasan; ubah alokasi per faktur.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Pelunasan kantor: pelanggan, tanggal, jumlah, cara (tunai kantor → kas kantor M4; transfer → daftar pencocokan US-M4-04), alokasi ke satu atau beberapa faktur (bawaan: tertua dulu, dapat diubah), sebagian/penuh; bukti wajib untuk transfer. | ☐ | ☐ |  |
| 2 | Pelunasan lewat sopir (M3) masuk otomatis dengan alokasinya dan setoran hari itu (BR-07); Admin Keuangan tidak mencatat ulang, hanya melihat. | ☐ | ☐ |  |
| 3 | Kelebihan bayar menjadi uang muka pelanggan yang dialokasikan otomatis ke faktur berikutnya atau dikembalikan dengan persetujuan pemilik [USULAN]. | ☐ | ☐ |  |
| 4 | Faktur Lunas terkunci; pembatalan pelunasan hanya lewat pembalik beralasan (BR-38), > Rp 500.000 dengan persetujuan pemilik. | ☐ | ☐ |  |
| 5 | Bukti pelunasan digital (PDF/WA) untuk pelanggan. | ☐ | ☐ |  |

### US-M5-03 Kontrol jatuh tempo dan status Ditahan — M

**Layar:** Piutang › Status kredit (`/piutang/status-kredit`), Ringkasan piutang  
**Rujukan PRD:** baris 969

**Langkah uji:**
1. Faktur lewat tempo + PAR-09 → status Ditahan (evaluasi malam / *Hitung ulang Ditahan*); pesanan tempo ditolak; *Ajukan pembukaan* ke pemilik.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Setiap hari setelah tutup kas [USULAN], sistem menghitung umur faktur; ada faktur lewat tempo > PAR-09 (7 hari) → status kredit Ditahan otomatis; notifikasi ke Dispatcher, Admin Keuangan, dan pemilik (Bab 6.3); pesanan tempo baru diblokir (US-M2-05). | ☐ | ☐ |  |
| 2 | Rit tempo pelanggan tersebut yang belum Berangkat ditandai ke Dispatcher untuk diubah ke tunai atau ditarik; rit yang sudah Berangkat berlanjut (PTB-27). | ☐ | ☐ |  |
| 3 | Ditahan dilepas otomatis saat seluruh faktur lewat tempo lunas; pembukaan sebelum lunas hanya oleh pemilik dengan alasan, berlaku sampai keterlambatan berikutnya [USULAN]. | ☐ | ☐ |  |
| 4 | Riwayat status kredit per pelanggan (kapan, oleh siapa, alasan) tersimpan. | ☐ | ☐ |  |
| 5 | Masa transisi (R07): pemilik dapat menunda penahanan otomatis per pelanggan dengan tanggal berakhir maksimal 2 bulan sejak go-live (PAR-41 [USULAN]); pelanggan dalam masa transisi tetap tampil di laporan lewat tempo. | ☐ | ☐ |  |
| 6 | Pemberian status Tempo mengikuti US-M1-01 KP-3 (BR-01, PAR-11, PAR-82); sistem menampilkan pelanggan Tunai yang memenuhi kedua syarat sebagai daftar "layak diajukan Tempo" [USULAN]. | ☐ | ☐ |  |

### US-M5-04 Laporan umur piutang dan kartu piutang — M

**Layar:** Piutang › Umur piutang (`/piutang/umur`)  
**Rujukan PRD:** baris 980

**Langkah uji:**
1. Umur per pelanggan/segmen/lini + KPI-04; ekspor meminta *Tujuan ekspor*; kartu piutang → *Kirim pernyataan piutang* (WA/e-mail).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Laporan umur piutang: per pelanggan, segmen, dan lini (air truk, toko): belum jatuh tempo / 1–7 / 8–30 / > 30 hari; % lewat tempo terhadap total piutang (KPI-04); tersedia kapan saja; ringkasan mingguan otomatis ke pemilik setiap Senin pagi (PAR-40 [USULAN]). | ☐ | ☐ |  |
| 2 | Kartu piutang per pelanggan: faktur, pelunasan, uang muka, saldo berjalan; ekspor PDF/Excel; dapat dikirim ke pelanggan sebagai pernyataan piutang. | ☐ | ☐ |  |
| 3 | Daftar tindakan harian untuk Admin Keuangan: pelanggan yang perlu diingatkan (H-3, H+1) dan yang akan/sudah Ditahan. | ☐ | ☐ |  |
| 4 | Ekspor yang memuat data pelanggan hanya oleh pemilik/Admin Keuangan dengan tujuan tercatat (BR-39). | ☐ | ☐ |  |

### US-M5-05 Pengingat jatuh tempo lewat WA — S

**Layar:** Piutang › Pengingat jatuh tempo (`/piutang/pengingat`)  
**Rujukan PRD:** baris 989

**Langkah uji:**
1. Daftar H-3/H+1 → *Buka WhatsApp* (template terisi) → status Dibuka; faktur bersengketa ditunda.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Daftar pengingat harian: H-3 sebelum jatuh tempo dan H+1 sesudahnya (PAR-13), per pelanggan dengan total sisa; tombol membuka WhatsApp dengan template terisi (nomor faktur, jumlah, jatuh tempo, rekening PT); status "dibuka" tercatat. | ☐ | ☐ |  |
| 2 | Template dikelola pemilik; bila WhatsApp Business API diaktifkan, pengiriman otomatis tanpa mengubah alur. | ☐ | ☐ |  |
| 3 | Pelanggan tagihan bulanan diingatkan berdasarkan faktur bulanan; faktur bersengketa (7.5.6) tidak diingatkan sampai sengketa selesai. | ☐ | ☐ |  |

### US-M5-06 Faktur bulanan untuk pelanggan tagihan bulanan — M

**Layar:** Piutang › Faktur bulanan (`/piutang/faktur-bulanan`)  
**Rujukan PRD:** baris 997

**Langkah uji:**
1. Pelanggan tagihan bulanan (perjanjian terunggah, disetujui pemilik) → faktur bulan lalu terbit tgl 1, jatuh tempo tgl 15 (PAR-12) → kirim WA/e-mail.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Penanda "tagihan bulanan" hanya untuk pelanggan dengan perjanjian tertulis terlampir dan disetujui pemilik (BR-05). | ☐ | ☐ |  |
| 2 | Faktur bulanan terbit otomatis tanggal 1 untuk periode bulan sebelumnya, jatuh tempo tanggal 15 bulan yang sama — untuk layanan bulan M: terbit tanggal 1 bulan M+1, jatuh tempo tanggal 15 bulan M+1 (PAR-12; PTB-26, CR-07); memuat rincian rit (nomor, tanggal, alamat, volume, harga), pelunasan dan uang muka yang sudah diterima, dan saldo terutang. | ☐ | ☐ |  |
| 3 | Rit yang Selesai tersinkron setelah faktur terbit masuk faktur bulan berikutnya dengan penanda; faktur yang sudah terbit tidak berubah — koreksi lewat nota kredit. | ☐ | ☐ |  |
| 4 | PDF dikirim oleh Admin Keuangan via tautan WA/e-mail pada tanggal 1 dari daftar "faktur bulanan siap kirim"; status pengiriman tercatat. | ☐ | ☐ |  |
| 5 | Eksposur pelanggan tagihan bulanan menghitung rit belum ditagih (US-M5-01 KP-3) sehingga batas kredit tetap berlaku sepanjang bulan. | ☐ | ☐ |  |

### US-M5-07 Saldo awal piutang saat cut-over — M

**Layar:** Piutang › Saldo awal piutang (`/piutang/saldo-awal`)  
**Rujukan PRD:** baris 1007

**Langkah uji:**
1. Input saldo awal per faktur kertas terkonfirmasi + lampiran + lini asal; batalkan satu entri (nota kredit berjejak).
2. Pemilik menandatangani; perubahan sesudahnya hanya *Ajukan koreksi*.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Input faktur saldo awal per pelanggan: tanggal, keterangan, jumlah, jatuh tempo, bukti konfirmasi pelanggan; ditandai "saldo awal" dan tidak menghasilkan jurnal penjualan (masuk neraca awal M11). | ☐ | ☐ |  |
| 2 | Total saldo awal piutang ditandatangani pemilik di sistem sebelum dipakai (NFR-34); perubahan setelahnya hanya lewat koreksi berjejak. | ☐ | ☐ |  |
| 3 | Faktur saldo awal mengikuti aturan umur, pengingat, dan penahanan yang sama, dengan masa transisi US-M5-03 KP-5. | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| B-77 | Kirim faktur & pernyataan piutang lewat e-mail dengan kunci Resend produksi dan domain pengirim **Verified**: e-mail diterima pelanggan uji dengan PDF terlampir, tercatat *terkirim*. | ☐ | ☐ |  |
| B-77 | Setiap peran yang memiliki izin kirim faktur (`m5.invoice.send`) dapat mengirim pernyataan tanpa izin ekspor umur piutang (D-12 butir 2). | ☐ | ☐ |  |
| NFR-20 | Pengingat jatuh tempo lewat tautan WA dari ponsel kantor nyata. | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M5 Piutang & Penagihan**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Admin Keuangan — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-05 |
| Data uji | Piutang berjalan nyata 15–30 pelanggan (faktur kertas terkonfirmasi untuk saldo awal) |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M5-01 |  | __ / __ |  |
| US-M5-02 |  | __ / __ |  |
| US-M5-03 |  | __ / __ |  |
| US-M5-04 |  | __ / __ |  |
| US-M5-05 |  | __ / __ |  |
| US-M5-06 |  | __ / __ |  |
| US-M5-07 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
