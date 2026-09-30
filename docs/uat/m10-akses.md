# UAT M10 — Pengguna, Hak Akses & Jejak Audit

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Pemilik (bersama admin sistem) |
| Skenario BRD | Matriks peran × tindakan; BR-36 s.d. BR-39 |
| User story diuji (PRD 11.3) | US-M10-01 s.d. US-M10-07 |
| Data uji | Setiap peran mencoba tindakan terlarang; perangkat hilang disimulasikan; satu pelanggan uji dianonimkan |
| Akun uji | Semua peran (satu akun per peran); dua admin sistem (`admin1`, `admin2`) |
| Panduan pengguna | `docs/guides/m10-access.md · docs/ops/runbook.md` |
| Jumlah | 7 user story · 41 KP |

## Persiapan

- [ ] Matriks peran diekspor (Akses › Peran & matriks) dan disahkan pemilik sebagai acuan uji.
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M10-01 Peran, pengguna, dan lingkup akses — M

**Layar:** Akses › Pengguna (`/akses/pengguna`), Persetujuan  
**Rujukan PRD:** baris 1471

**Langkah uji:**
1. Admin sistem membuat akun dari karyawan (satu peran + lingkup) → aktif setelah pemilik menyetujui; akun awal go-live lewat daftar bertanda tangan.
2. Cabut peran/kurangi lingkup/nonaktifkan → seketika (sesi dicabut, perangkat diblokir); tanggal keluar → nonaktif otomatis; tinjauan hak akses kuartalan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Katalog peran tetap: Pemilik, Admin Keuangan, Dispatcher, Sopir, Kernet (PTB-10 disetujui), Operator depot, Kasir toko, Operator produksi, Admin sistem, Akuntan (baca-saja; PTB-11 disetujui). Pada RL-7 ditambah "Pemilik mitra" (baca-saja, lingkup tenant sendiri; US-P3-10). Hak per peran mengikuti BRD 4.2 dan Bab 3.2; hak tidak dapat diubah per pengguna, hanya lewat peran [USULAN, mencegah hak ad hoc]. | ☐ | ☐ |  |
| 2 | Setiap akun terikat tepat satu karyawan dari master M1 (BR-36); sistem menolak akun kedua untuk karyawan yang sama dan tidak mengizinkan akun tanpa karyawan (misalnya "kasir1"). | ☐ | ☐ |  |
| 3 | Lingkup mengikat data yang terlihat: Sopir/Kernet → truk hari itu (jadwal kru, M2); Operator depot → outlet; Operator produksi → sumber air; Kasir → toko; Admin Keuangan → seluruh sumber kas EQUA; peran mitra (Tahap 3) → tenant sendiri (NFR-30). Tidak ada tampilan lintas lingkup untuk peran lapangan. | ☐ | ☐ |  |
| 4 | Satu orang lebih dari satu peran hanya lewat permintaan persetujuan pemilik (US-M10-04) dengan alasan dan masa berlaku. Kombinasi yang melanggar pemisahan tugas tidak dapat diajukan sama sekali (PTB-31 [USULAN]): Admin Keuangan bersama Dispatcher, Sopir, Kernet, Operator, atau Kasir; Admin sistem bersama peran yang menyentuh kas atau jurnal; Pemilik bersama peran pencatat transaksi harian. | ☐ | ☐ |  |
| 5 | Tanggal keluar pada master karyawan (M1) menonaktifkan akun pada hari itu secara otomatis (BR-37); admin sistem dapat menonaktifkan seketika; sesi aktif diputus, perangkat yang dipegangnya diblokir, data yang pernah dibuatnya tetap utuh dan tetap merujuk namanya. | ☐ | ☐ |  |
| 6 | Tinjauan hak akses kuartalan (R09, PAR-47): sistem menyusun daftar pengguna, peran, lingkup, terakhir login; pemilik menandai "ditinjau" per kuartal; pengguna tanpa login > 60 hari dan multi-peran yang lewat masa berlaku ditandai [USULAN]. | ☐ | ☐ |  |
| 7 | Semua perubahan pengguna, peran, dan lingkup berjejak (US-M10-05) dan masuk ringkasan harian pemilik. | ☐ | ☐ |  |
| 8 | Pembuatan akun, pemberian atau perubahan peran, dan perluasan lingkup baru aktif setelah disetujui pemilik lewat US-M10-04 (BRD 10.2, 6.2a); pencabutan akses (karyawan keluar, perangkat hilang, pengurangan lingkup) berlaku seketika tanpa persetujuan (BR-37). Saat go-live, akun awal disetujui sekaligus per daftar bersama tanda tangan data awal (NFR-34), bukan satu per satu. | ☐ | ☐ |  |

### US-M10-02 Login, PIN, perangkat terdaftar, dan sesi — M (PTB-06 disetujui)

**Layar:** `/masuk`, `/masuk/2fa`, `/aktivasi-perangkat`, Akses › Perangkat  
**Rujukan PRD:** baris 1484

**Langkah uji:**
1. Login kata sandi + 2FA (pemilik, Admin Keuangan, admin sistem); sesi kedaluwarsa 30 menit diam / 12 jam (PAR-46).
2. Daftarkan perangkat → kode aktivasi (24 jam) → PIN; login PIN offline; 5× salah → kunci 15 menit.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Aplikasi lapangan dan POS hanya dapat login pada perangkat yang didaftarkan admin sistem (pengenal perangkat, jenis, truk/outlet/sumber, pemegang, status); perangkat tidak terdaftar ditolak dengan pesan ke pengguna dan catatan ke admin sistem. | ☐ | ☐ |  |
| 2 | Satu perangkat dapat dipakai beberapa pengguna bergantian (perangkat truk: sopir dan kernet; perangkat cadangan) dengan PIN masing-masing; data offline milik pengguna lain tidak terlihat dan tidak terhapus saat berganti pengguna (Bab 6.5). | ☐ | ☐ |  |
| 3 | PIN 6 digit ditetapkan pengguna sendiri pada aktivasi pertama di hadapan admin sistem [USULAN]; reset PIN hanya oleh admin sistem dengan pemberitahuan ke pemilik; 5 kali salah → terkunci 15 menit (PAR-36); layar terkunci setelah 10 menit tidak aktif tanpa kehilangan data (PAR-37). | ☐ | ☐ |  |
| 4 | Web kantor: kata sandi minimal 10 karakter [USULAN] dan sesi kedaluwarsa setelah 30 menit tidak aktif atau maksimal 12 jam (PAR-46, NFR-09); pemilik, Admin Keuangan, dan admin sistem memakai autentikasi dua faktor (PTB-35; tambahan, Bab 2.4). | ☐ | ☐ |  |
| 5 | Kredensial tidak tersimpan dalam bentuk terbaca di perangkat; data lokal dan komunikasi terenkripsi (NFR-10); login PIN tetap berfungsi offline setelah aktivasi daring pertama. | ☐ | ☐ |  |
| 6 | Perangkat hilang/rusak: admin sistem memblokir seketika (tidak dapat login, tidak menerima data baru) dan memerintahkan hapus jarak jauh (data aplikasi dihapus pada kontak berikutnya); antrean belum terkirim yang ikut hilang dicatat sebagai kejadian dan dilaporkan ke pemilik (US-M3-09 KP-5). | ☐ | ☐ |  |
| 7 | Riwayat per perangkat: pengguna dan waktu pemakaian, login gagal, sinkron terakhir, versi aplikasi. | ☐ | ☐ |  |

### US-M10-03 Pemisahan tugas dipaksakan — M

**Layar:** Akses › Peran & matriks (`/akses/peran`)  
**Rujukan PRD:** baris 1496

**Langkah uji:**
1. Uji aturan tetap: pemohon ≠ penyetuju, penyetor ≠ penerima setoran, pemilik tidak menginput transaksi harian; ajukan kombinasi peran terlarang → tidak dapat diajukan; > 3 penolakan/hari → notifikasi pemilik.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Aturan tetap yang diperiksa pada setiap tindakan: pembuat transaksi bukan penyetujunya; penerima setoran bukan penyetornya; Admin Keuangan tidak membuat/mengubah pesanan dan pengiriman; Dispatcher tidak mengakses kas; Sopir hanya rit sendiri dan tidak mengubah setelah kirim; Operator/Kasir hanya outletnya; Admin sistem tidak mengubah transaksi keuangan; Pemilik tidak menginput transaksi harian. | ☐ | ☐ |  |
| 2 | Pelanggaran ditolak dengan pesan yang menyebut aturannya; setiap percobaan tercatat di log akses; lebih dari 3 percobaan sehari oleh pengguna yang sama diberitahukan ke pemilik [USULAN]. | ☐ | ☐ |  |
| 3 | Tidak ada mode darurat yang melewati aturan; jalur pengecualian hanya yang sudah ditentukan (Bab 6.1 "dicatat kantor", PTB-21) dan tetap berjejak. | ☐ | ☐ |  |
| 4 | Matriks peran × tindakan dapat ditampilkan dan diekspor pemilik untuk audit. | ☐ | ☐ |  |

### US-M10-04 Alur persetujuan — M

**Layar:** Persetujuan (`/persetujuan`)  
**Rujukan PRD:** baris 1505

**Langkah uji:**
1. Tabel aturan 6.2a (pemohon, penyetuju, ambang parameter, tenggat, perlakuan lewat tenggat); setujui satu ketuk dari tautan push; tolak wajib alasan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Satu mekanisme untuk seluruh jenis di Bab 6.2a — selisih kas, pemberian Tempo dan pembukaan Ditahan, batas/tempo per pelanggan, harga master (jalur baku) dan harga khusus, diskon > 5%, void > Rp 100.000, penyesuaian stok, jurnal manual > Rp 5 juta, koreksi > Rp 500.000, kas kecil > Rp 500.000, pesanan tempo di luar kontrol kredit, pesanan saat kurang bayar kedua, tunai → tempo di lapangan (penyetuju Dispatcher), akun/peran/lingkup, multi-peran, tutup buku, pengecualian tutup kas — dengan data: pemohon, objek dan tautannya, nilai, alasan, tenggat, penyetuju. | ☐ | ☐ |  |
| 2 | Penyetuju mengikuti matriks Bab 6.2a (Tahap 1: pemilik, kecuali jenis yang diberikan ke Dispatcher); pemohon tidak pernah dapat menyetujui permintaannya sendiri walau memegang peran penyetuju (FR-M10-03). Keputusan langsung pemilik (6.2b) dan pengesampingan beralasan (6.2c) bukan permintaan persetujuan: tidak masuk alur ini, tetapi tetap berjejak dan diberitahukan. | ☐ | ☐ |  |
| 3 | Keputusan dari web atau ponsel (push, PTB-05) dengan satu ketuk; alasan wajib untuk penolakan; keputusan mengubah objek sumber secara otomatis (pesanan dapat dijadwalkan, harga berlaku, selisih Ditutup) dan tercatat di objek dan jejak audit. | ☐ | ☐ |  |
| 4 | Tenggat dan perilaku bila lewat tenggat mengikuti kolom Bab 6.2a (PTB-32): permintaan lewat tenggat diberi penanda dan pengingat, lalu diperlakukan sesuai kolom "Bila lewat tenggat" — misalnya pesanan tempo tetap tunai atau digeser ke H+1, void/diskon dianggap ditolak di akhir shift — sehingga operasi harian tidak menunggu pemilik. | ☐ | ☐ |  |
| 5 | Pendelegasian (PTB-32): bawaan tidak ada pendelegasian di Tahap 1. Bila pemilik memutuskan sebaliknya, delegasi hanya per jenis, berbatas waktu, tidak kepada pemohon atau peran yang bertentangan (KP-4 US-M10-01), dan seluruh keputusan delegasi tampil ke pemilik. | ☐ | ☐ |  |
| 6 | Ambang dan syarat tiap jenis diambil dari parameter Lampiran B, bukan tertanam di kode; perubahan parameter hanya oleh pemilik dan berjejak. | ☐ | ☐ |  |

### US-M10-05 Jejak audit — M

**Layar:** Jejak audit (`/audit`, tab Log akses)  
**Rujukan PRD:** baris 1516

**Langkah uji:**
1. Cari per objek/pengguna/tanggal/tindakan; kalimat bahasa lapangan; *Verifikasi keutuhan* rantai hash; percobaan ubah/hapus lewat aplikasi/API/DB gagal (EQ001/EQ002).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Setiap pembuatan, perubahan, persetujuan, pembalikan, dan penonaktifan pada objek Bab 5.1 menghasilkan catatan: pelaku (pengguna, peran, perangkat), waktu perangkat dan server, objek, nilai lama, nilai baru, alasan bila diwajibkan, sumber (aplikasi lapangan / POS / web / sistem otomatis). | ☐ | ☐ |  |
| 2 | Catatan tidak dapat diubah atau dihapus oleh siapa pun termasuk admin sistem (NFR-11); integritasnya dapat diverifikasi (cara teknis diserahkan tim IT) [USULAN]. | ☐ | ☐ |  |
| 3 | Pencarian per objek (riwayat lengkap satu pesanan/rit/faktur/shift), per pengguna, per rentang waktu, per jenis tindakan; ditampilkan dalam bahasa lapangan ("harga rit diubah dari Rp 200.000 menjadi Rp 210.000 oleh Pemilik, alasan: …"). | ☐ | ☐ |  |
| 4 | Log akses terpisah: login/logout, login gagal, pendaftaran/pemblokiran perangkat, ekspor (BR-39), percobaan tindakan yang ditolak (US-M10-03); disimpan 1 tahun (PAR-29). Jejak audit transaksi keuangan disimpan ≥ 10 tahun bersama transaksinya (BR-31). | ☐ | ☐ |  |
| 5 | Tindakan otomatis sistem (Ditahan otomatis, faktur bulanan, penyusutan, deteksi GPS) dicatat dengan pelaku "Sistem" dan aturan pemicunya. | ☐ | ☐ |  |
| 6 | Ekspor jejak audit (Excel/PDF) oleh pemilik; akuntan (baca-saja) dapat melihat jejak objek keuangan. | ☐ | ☐ |  |

### US-M10-06 Data pribadi, retensi, dan pencadangan — M (NFR-14 S)

**Layar:** Akses › Data pribadi (`/akses/data-pribadi`)  
**Rujukan PRD:** baris 1527

**Langkah uji:**
1. Anonimkan satu pelanggan uji (persetujuan pemilik; ditunda bila piutang terbuka) → identitas hilang, catatan keuangan tetap; jejak audit menyamarkan PII bagi selain pemilik.
2. Catat cadangan harian/bulanan & uji pemulihan (RPO/RTO); retensi berjalan (log akses 1 tahun, GPS 12 bulan).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Data pribadi pelanggan (nama, WA, alamat, koordinat) hanya tampil pada peran yang memerlukannya untuk tugasnya: Dispatcher (M1/M2), Sopir/Kernet untuk rit hari itu, Admin Keuangan (piutang), Pemilik; peran lain melihat nama tanpa kontak [USULAN]. Data karyawan (PIN, riwayat selisih, ganti rugi) hanya untuk pemilik, admin sistem (tanpa nilai selisih), dan yang bersangkutan. | ☐ | ☐ |  |
| 2 | Permintaan penghapusan data pribadi (UU PDP): admin sistem mencatat permintaan; pemilik menyetujui; sistem menganonimkan nama, kontak, alamat, dan koordinat pada seluruh objek dan menyimpan catatan transaksi keuangan tanpa identitas (NFR-12, BRD 10.6). Pelanggan dengan piutang terbuka tidak dapat dianonimkan sebelum lunas atau dihapuskan (PTB-36 [USULAN]). | ☐ | ☐ |  |
| 3 | Jadwal retensi otomatis (PAR-29): data akuntansi dan transaksi ≥ 10 tahun (tidak ada penghapusan); foto bukti kirim, meter, dan nota dipindahkan ke arsip setelah 2 tahun (usulan BRD) dan tetap dapat dibuka dari rit/jurnal terkait; log akses 1 tahun; posisi GPS mentah 12 bulan (PTB-33). | ☐ | ☐ |  |
| 4 | Pencadangan otomatis harian dan salinan bulanan data akuntansi ≥ 10 tahun (NFR-13) dijalankan tim IT; produk menampilkan status cadangan terakhir kepada admin sistem dan pemilik [USULAN]. Uji pemulihan 2×/tahun (NFR-14, S) dicatat hasilnya. | ☐ | ☐ |  |
| 5 | Ekspor data pelanggan/mitra hanya oleh pemilik/Admin Keuangan dengan tujuan tercatat (BR-39); seluruh ekspor tercatat di log akses. | ☐ | ☐ |  |
| 6 | Seluruh data milik PT EQUA; data outlet mitra (Tahap 3) terpisah per tenant (NFR-30) dengan hak baca EQUA sesuai perjanjian (Bab 4.3). | ☐ | ☐ |  |

### US-M10-07 Kesehatan perangkat, sinkron, dan pemantauan — M

**Layar:** Akses › Perangkat & sinkron (`/akses/sinkron`), Bantuan (`/bantuan`)  
**Rujukan PRD:** baris 1538

**Langkah uji:**
1. Antrean per perangkat, konflik, insiden (tanggap/pulih), uptime bulanan; tetapkan versi minimal → perangkat lama diminta memperbarui (antrean tertahan, tidak hilang).
2. Laporan kendala dari perangkat → jawab di helpdesk → pelapor *Tandai selesai*.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Halaman "Perangkat & sinkron" untuk admin sistem, Dispatcher (perangkat truk), dan Admin Keuangan (sebelum menerima setoran, US-M3-09 KP-3): per perangkat — pengguna terakhir, sinkron terakhir, jumlah item belum terkirim menurut laporan perangkat, versi aplikasi, daya bila tersedia. | ☐ | ☐ |  |
| 2 | Peringatan otomatis ke tim IT (NFR-28): layanan tidak dapat diakses; sinkron gagal massal (lebih dari 3 perangkat gagal sinkron > 30 menit pada jam layanan [USULAN]); perangkat GPS mati (M12). Tercatat sebagai insiden dengan waktu tanggap ≤ 30 menit dan pemulihan ≤ 4 jam (NFR-31). | ☐ | ☐ |  |
| 3 | Pengguna lapangan dapat melaporkan kendala aplikasi (bukan kendala rit) dari menu bantuan; laporan menyertakan versi dan status sinkron otomatis [USULAN] dan masuk ke helpdesk IT. Setiap laporan dan masukan lapangan memiliki status (Diterima → Dijawab → Selesai) yang terlihat pelapor; jawaban ≤ 1 minggu (PAR-87, BRD 12.5) dipantau manajer proyek IT. | ☐ | ☐ |  |
| 4 | Rilis versi aplikasi: pemberitahuan pembaruan; versi minimal yang didukung; pengguna dengan versi di bawahnya diminta memperbarui sebelum melanjutkan (NFR-32). | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| NFR-09 | Setiap peran mencoba minimal 3 tindakan terlarang (termasuk lewat URL langsung) → ditolak dan tercatat di Log akses. | ☐ | ☐ |  |
| US-M10-02 | Simulasi perangkat hilang: blokir + hapus data jarak jauh di perangkat nyata; perangkat cadangan diaktifkan ≤ 30 menit. | ☐ | ☐ |  |
| NFR-13 | Uji pemulihan cadangan sekali sebelum go-live (runbook §4), RPO & RTO dicatat di sistem. | ☐ | ☐ |  |
| NFR-12 | Anonimisasi satu pelanggan uji: identitas hilang, faktur & jurnal tetap. | ☐ | ☐ |  |
| NFR-28 / B-85 | Simulasi tiga kondisi (layanan mati, sinkron gagal massal, GPS mati) memicu peringatan ke tim IT ≤ 5 menit; secret repositori pemantau terisi. | ☐ | ☐ |  |
| NFR-30 | Tenant uji tidak melihat data EQUA dan sebaliknya (lihat juga RL-7 B-74). | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M10 Pengguna, Hak Akses & Jejak Audit**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Pemilik (bersama admin sistem) — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | Matriks peran × tindakan; BR-36 s.d. BR-39 |
| Data uji | Setiap peran mencoba tindakan terlarang; perangkat hilang disimulasikan; satu pelanggan uji dianonimkan |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M10-01 |  | __ / __ |  |
| US-M10-02 |  | __ / __ |  |
| US-M10-03 |  | __ / __ |  |
| US-M10-04 |  | __ / __ |  |
| US-M10-05 |  | __ / __ |  |
| US-M10-06 |  | __ / __ |  |
| US-M10-07 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
