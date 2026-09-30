# UAT M3 — Aplikasi Sopir

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Dispatcher (bersama sopir juara lapangan) |
| Skenario BRD | P-01 langkah 5–9; P-05 langkah 3 |
| User story diuji (PRD 11.3) | US-M3-01 s.d. US-M3-07 (termasuk struk WA versi tautan, US-M3-03 KP-7), US-M3-09, US-M3-10 (M); US-M3-08 (S) |
| Data uji | Rit sungguhan di truk pilot (rute dekat & jauh), termasuk ruas tanpa sinyal |
| Akun uji | Sopir (`sopir1`), kernet (`kernet1`) di ponsel truk T1; Dispatcher; Admin Keuangan (dicatat kantor & setoran) |
| Panduan pengguna | `docs/guides/lapangan/sopir-kernet.md (1 halaman) · docs/guides/m3-driver.md` |
| Jumlah | 10 user story · 55 KP |

## Persiapan

- [ ] Ponsel truk diaktifkan di hadapan admin sistem (`/aktivasi-perangkat`), sopir & kernet menetapkan PIN.
- [ ] Papan jadwal hari itu diterbitkan (UAT M2).
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M3-01 Melihat daftar rit hari ini dan menuju lokasi — M

**Layar:** Aplikasi sopir `/sopir` › Daftar rit  
**Rujukan PRD:** baris 718

**Langkah uji:**
1. Login PIN → rit hari ini urut rencana; buka rincian (catatan, telepon/WA, harga pesanan, faktur terbuka, kredit pelanggan) → *Navigasi* membuka peta ponsel.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Setelah login PIN, layar utama adalah daftar rit hari ini untuk truk yang ditugaskan: nomor urut, nomor rit, nama pelanggan, alamat singkat, jumlah tangki/volume, jam diminta, cara bayar, penanda catatan khusus, status. Rit berikutnya ditonjolkan; rit Selesai/Gagal turun ke bawah. | ☐ | ☐ |  |
| 2 | Detail rit menampilkan catatan khusus pelanggan (akses lokasi, jam terima), tombol telepon/WA ke pelanggan, harga pesanan ini (satu-satunya harga yang terlihat sopir, BR-19), daftar faktur terbuka pelanggan (untuk US-M3-05), dan penanda "Internal — Depot X" untuk rit pasokan depot (PTB-01). | ☐ | ☐ |  |
| 3 | Tombol navigasi membuka aplikasi peta ponsel dengan koordinat alamat; bila koordinat Belum dikunci, memakai teks alamat dan menampilkan "titik alamat akan dikunci saat Selesai". | ☐ | ☐ |  |
| 4 | Pembaruan jadwal dari Dispatcher (tambah, geser, tarik) tampil dengan penanda "diperbarui" dan ringkasan perubahan; rit yang sudah Berangkat tidak berubah. | ☐ | ☐ |  |
| 5 | Bila setoran hari sebelumnya belum Ditutup (BR-10), daftar tetap tampil tetapi tombol Berangkat terkunci dengan pesan "Setoran kemarin belum ditutup Admin Keuangan" dan tombol hubungi Admin Keuangan; kunci terbuka otomatis saat setoran Ditutup oleh Admin Keuangan (M4). Keputusan pemilik atas selisih tidak memengaruhi kunci ini, kecuali PAR-83 aktif (PTB-62) — dengan pesan "Menunggu keputusan pemilik atas selisih besar". | ☐ | ☐ |  |
| 6 | Kernet yang tidak ditetapkan sebagai pengemudi pengganti melihat daftar yang sama tanpa tombol tindakan; kernet pengganti mendapat tombol yang sama dengan sopir dan seluruh transaksinya tercatat atas namanya (US-M2-11; PTB-10). | ☐ | ☐ |  |
| 7 | Setiap tindakan dapat dicapai ≤ 3 ketukan dari daftar rit; teks ≥ 16 pt dan kontras tinggi (NFR-18, S); Bahasa Indonesia dengan istilah rit/setor/tempo (NFR-15). | ☐ | ☐ |  |

### US-M3-02 Mencatat Berangkat dan Tiba dengan waktu dan lokasi otomatis — M

**Layar:** `/sopir` › rincian rit  
**Rujukan PRD:** baris 730

**Langkah uji:**
1. *Berangkat* lalu *Tiba* — waktu & lokasi otomatis; coba berangkatkan rit kedua saat satu berjalan (ditolak).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Berangkat dan Tiba masing-masing satu ketukan; mencatat waktu perangkat, posisi GPS ponsel, dan akurasinya; hanya satu rit berstatus Berangkat/Tiba per truk pada satu waktu [USULAN]. | ☐ | ☐ |  |
| 2 | Memulai rit di luar urutan (misalnya rit ke-3 sebelum ke-2) dimungkinkan dengan konfirmasi; urutan aktual tercatat dan tampil ke Dispatcher (US-M2-03). | ☐ | ☐ |  |
| 3 | Tiba menghitung jarak posisi ke koordinat alamat secara lokal (tanpa sinyal) agar aturan BR-23 dapat dipaksakan pada langkah Selesai (US-M3-03). | ☐ | ☐ |  |
| 4 | Bila GPS ponsel nonaktif, aplikasi meminta mengaktifkannya; tanpa lokasi, status tetap tercatat dengan penanda "tanpa lokasi" yang dilaporkan ke M12 sebagai anomali [USULAN]. | ☐ | ☐ |  |
| 5 | Perekaman jejak berkelanjutan dari GPS ponsel hanya berjalan selama rit aktif dan hanya bila server menandai perangkat GPS truk mati (FR-M12-08) atau admin sistem mengaktifkannya untuk truk tertentu — GPS ponsel adalah cadangan (K11, NFR-17). | ☐ | ☐ |  |
| 6 | Rit internal pasokan depot memakai tombol yang sama; "Tiba" di depot dicocokkan dengan geofence depot bila FR-M12-05 (S) tersedia. | ☐ | ☐ |  |

### US-M3-03 Menyelesaikan rit dengan bukti kirim — M

**Layar:** `/sopir` › *Selesai & bayar*  
**Rujukan PRD:** baris 741

**Langkah uji:**
1. Foto bukti kirim dari kamera aplikasi (wajib), nama & tanda tangan penerima, volume (beda → alasan); lokasi jauh dari alamat → alasan.
2. *Kirim struk WA* (tautan) atau lewati beralasan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Selesai memerlukan: minimal satu foto (diambil dari kamera aplikasi, bukan galeri [USULAN]), nama penerima (terisi nama kontak pelanggan, dapat diubah), tanda tangan penerima di layar, volume terkirim (terisi 5.000 L). Tanpa foto dan nama penerima, tombol Selesai tidak aktif (BR-22); tanda tangan dapat dilewati hanya dengan alasan "penerima tidak bersedia/tidak ada" [USULAN, menjaga FR-M3-03 tanpa memblokir rit]. | ☐ | ☐ |  |
| 2 | Volume terkirim ≠ 5.000 L → alasan wajib dari daftar (tangki pelanggan penuh, kebocoran, permintaan pelanggan, lainnya + teks) (BR-22). Harga rit tetap harga pesanan; sistem menandai rit "volume parsial" ke Dispatcher dan Admin Keuangan; penyesuaian harga hanya lewat koreksi berjejak Admin Keuangan (BR-38) [USULAN]. | ☐ | ☐ |  |
| 3 | Jarak lokasi Selesai ke koordinat alamat (dihitung lokal): > 200 m → alasan wajib (alamat di master salah, pelanggan minta titik lain, GPS tidak akurat, lainnya); > 1 km → alasan wajib dan rit ditandai untuk tinjauan pemilik (BR-23). Server menghitung ulang saat sinkron (FR-M12-03); hasil server yang berlaku. | ☐ | ☐ |  |
| 4 | Alamat Belum dikunci: tidak ada pembandingan; lokasi Selesai diusulkan sebagai koordinat alamat untuk dikonfirmasi Dispatcher (US-M1-01 KP-2). | ☐ | ☐ |  |
| 5 | Untuk rit internal pasokan depot, bukti kirim = volume diserahkan + foto; operator depot mengonfirmasi volume diterima di M6 (FR-M6-05); selisih kirim–terima ditandai ke M8 (P-04 langkah 3). | ☐ | ☐ |  |
| 6 | Setelah Selesai, rit dan bukti kirimnya terkunci di perangkat (FR-M3-07); foto dikompresi di perangkat (≤ 300 KB per foto, PAR-38 [USULAN]) dan diunggah saat sinkron; waktu Selesai = waktu perangkat, waktu sinkron dicatat terpisah. | ☐ | ☐ |  |
| 7 | Setelah pembayaran tercatat (US-M3-04), tombol "Kirim struk WA" membuka WhatsApp dengan struk terisi (nomor rit, tanggal, volume, harga, cara bayar, sisa piutang bila tempo) dalam satu ketukan — M untuk versi tautan karena P-01 langkah 7 adalah skenario UAT (BRD 12.6; PTB-29, CR-08); sopir dapat melewatinya dengan alasan singkat bila pelanggan tidak memakai WA. Pengiriman otomatis lewat WhatsApp Business API tetap Tahap 2 (US-P2-08). | ☐ | ☐ |  |

### US-M3-04 Mencatat pembayaran per rit — M

**Layar:** `/sopir` › langkah Pembayaran  
**Rujukan PRD:** baris 753

**Langkah uji:**
1. Tunai pas, tunai kurang (alasan → faktur kurang bayar), transfer + foto bukti, tempo (pesanan tempo atau *Pelanggan minta tempo?* → Dispatcher menyetujui di Persetujuan ≤ 30 menit).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Langkah pembayaran adalah bagian dari Selesai dan tidak dapat dilewati. Cara bayar dan harga tampil dari pesanan; sopir tidak dapat mengubah harga (BR-19). | ☐ | ☐ |  |
| 2 | Tunai: bidang "diterima" terisi harga (angka seharusnya); sopir mengonfirmasi atau mengubah ke jumlah nyata. Jumlah lebih kecil → alasan wajib; sisa tercatat sebagai kurang bayar dan menjadi faktur jatuh tempo H+0 di M5 dengan notifikasi Admin Keuangan (PTB-18); pesanan berikutnya pelanggan itu bertanda "tagih kurang bayar" (US-M2-05 KP-6). Jumlah lebih besar tidak dapat dicatat; kembalian diberikan di lapangan sehingga kas seharusnya = harga. | ☐ | ☐ |  |
| 3 | Transfer: foto bukti transfer wajib + jumlah; aplikasi menampilkan nomor rekening PT yang benar untuk diberitahukan ke pelanggan; tidak menambah kas di tangan; status "belum dicocokkan" hingga dicocokkan Admin Keuangan (US-M4-04). | ☐ | ☐ |  |
| 4 | Tempo: hanya bila pesanan bercara-bayar tempo (kontrol kredit dilakukan di M2). Perubahan cara bayar di lapangan (PTB-19): tempo → tunai/transfer selalu boleh. Sopir tidak memutuskan kredit: tunai → tempo hanya lewat permintaan dari aplikasi yang disetujui Dispatcher saat daring (6.2a), untuk pelanggan berstatus Tempo dan dalam batas (BR-06). Bila luring atau tidak disetujui, kekurangan dicatat sebagai kurang bayar (KP-2) dan dapat dikonversi Admin Keuangan menjadi tempo setelah pemeriksaan batas; pelanggan Tunai tidak pernah menjadi tempo di lapangan. | ☐ | ☐ |  |
| 5 | Setiap pembayaran memperbarui otomatis: kas di tangan (tunai), daftar transfer belum dicocokkan (transfer), piutang pelanggan (tempo/kurang bayar). | ☐ | ☐ |  |
| 6 | Rit internal pasokan depot tidak memiliki langkah pembayaran (PTB-01). | ☐ | ☐ |  |

### US-M3-05 Menerima pelunasan piutang saat pengiriman — M

**Layar:** `/sopir` › rincian rit › *Terima pelunasan*  
**Rujukan PRD:** baris 764

**Langkah uji:**
1. Centang faktur (bawaan tertua), tunai/transfer, jumlah → simpan → kirim bukti pelunasan WA; kas di tangan bertambah untuk tunai.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Pada rit pelanggan yang memiliki faktur terbuka, tombol "Terima pelunasan" menampilkan faktur terbuka (nomor, tanggal, sisa) dari data sinkron terakhir beserta waktunya. Faktur kurang bayar (PTB-18) tampil paling atas dengan penanda "tagih kurang bayar". | ☐ | ☐ |  |
| 2 | Sopir memilih faktur (bawaan: yang tertua) dan mencatat jumlah tunai atau foto bukti transfer; pelunasan sebagian diperbolehkan; alokasi ke faktur terpilih dari yang tertua. | ☐ | ☐ |  |
| 3 | Pelunasan tunai menambah kas di tangan dan masuk setoran hari itu (BR-07); saat sinkron tercatat sebagai pelunasan di M5 tanpa input ulang Admin Keuangan. | ☐ | ☐ |  |
| 4 | Pelunasan hanya untuk pelanggan pada rit hari itu; pelanggan lain melunasi lewat Admin Keuangan (kantor/transfer) [USULAN]. | ☐ | ☐ |  |
| 5 | Bukti pelunasan digital via WA (S, PTB-29). | ☐ | ☐ |  |

### US-M3-06 Menandai rit gagal, melaporkan kendala, dan memberi keterangan perjalanan — M (rit gagal; keterangan BR-25) / S (kendala)

**Layar:** `/sopir` › *Rit gagal* / *Kendala* / menu *Keterangan*; kantor: Kendala sopir (`/sopir-kantor/kendala`)  
**Rujukan PRD:** baris 774

**Langkah uji:**
1. Rit gagal: alasan + foto + tindak lanjut air; Dispatcher melihat di papan (perlu jadwal ulang).
2. Kendala truk rusak → Dispatcher *Konfirmasi* + ubah truk ke Perbaikan; tugas keterangan perjalanan (BR-25) diisi sopir hari itu.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | "Rit gagal" tersedia pada status Berangkat/Tiba: alasan wajib (pelanggan tidak ada, pelanggan menolak, lokasi tidak dapat diakses, truk rusak, lainnya + teks), foto opsional; waktu dan posisi otomatis; rit → Gagal, pesanan kembali ke Dispatcher (US-M2-09). Dua gagal berturut untuk pelanggan yang sama memicu BR-24 di M2. | ☐ | ☐ |  |
| 2 | Air yang sudah dimuat pada rit gagal: sopir memilih tindak lanjut (dibawa ke rit berikutnya / kembali ke sumber / dibongkar di depot) — tercatat untuk neraca air M8 [USULAN]. | ☐ | ☐ |  |
| 3 | Kendala tanpa mengakhiri rit (S): jenis, foto, catatan → kejadian ke Dispatcher; kendala "truk rusak" mengubah status truk menjadi Perbaikan setelah dikonfirmasi Dispatcher. | ☐ | ☐ |  |
| 4 | Keterangan perjalanan di luar jadwal/jam (BR-25): permintaan keterangan dari M12 tampil sebagai tugas terbuka di aplikasi; sopir mengisi pada hari yang sama; tugas yang belum diisi hingga tutup kas dilaporkan ke pemilik (Bab 6.3). | ☐ | ☐ |  |

### US-M3-07 Melihat kas di tangan dan menyetor akhir hari — M

**Layar:** `/sopir` › *Setor*; kantor: Kas › Setoran  
**Rujukan PRD:** baris 783

**Langkah uji:**
1. Kas di tangan = tunai rit + pelunasan tunai − pengeluaran; semua rit selesai → *Setor Rp …* (ringkasan terkunci).
2. Admin Keuangan menerima & menutup setoran; sopir melihat hasil & selisih di kartu *Setoran & ganti rugi saya*; rit besok terbuka setelah Ditutup.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Kas di tangan berjalan = Σ tunai rit Selesai + Σ pelunasan tunai − Σ pengeluaran rit dari kas (bila US-M3-08 dipakai, PTB-20); selalu tampil di layar utama; tidak dapat diubah sopir. | ☐ | ☐ |  |
| 2 | Tombol "Setor" aktif setelah tidak ada rit Berangkat/Tiba; ringkasan: jumlah rit Selesai/Gagal, tunai per rit, pelunasan, transfer (di luar kas), tempo, pengeluaran, total seharusnya disetor. Menekan Setor mengunci ringkasan (status Diajukan) dan mengirimnya ke Admin Keuangan; setelah Setor tidak ada rit baru hari itu kecuali Admin Keuangan membuka kembali setoran yang belum Diterima dengan alasan [USULAN]. | ☐ | ☐ |  |
| 3 | Cara setor (PTB-23): bawaan serah fisik ke Admin Keuangan pada hari yang sama (BR-08); untuk sopir tertentu pemilik dapat mengizinkan setor tunai ke rekening PT dengan foto slip, yang tetap diterima Admin Keuangan lewat pencocokan mutasi (US-M4-04). | ☐ | ☐ |  |
| 4 | Setelah Admin Keuangan menerima (M4), sopir melihat jumlah diterima, selisih, alasan, dan status; sopir dapat menambahkan keterangan atas selisih dari aplikasi, yang masuk alur selisih M4 [USULAN]. | ☐ | ☐ |  |
| 5 | Bila setoran belum Diajukan pada PAR-06 (22.00), aplikasi mengingatkan sopir dan memberi tahu Admin Keuangan; setoran tetap dapat diajukan setelahnya dengan penanda terlambat. | ☐ | ☐ |  |
| 6 | Riwayat setoran dan selisih sopir sendiri 90 hari terakhir tersedia di aplikasi; sopir tidak melihat data sopir lain [USULAN, turunan FR-M4-07 dan kepentingan "tidak dicurigai tanpa dasar", BRD 4.1]. | ☐ | ☐ |  |

### US-M3-08 Mencatat pengeluaran rit — S

**Layar:** `/sopir` › Setor › *Catat pengeluaran*  
**Rujukan PRD:** baris 794

**Langkah uji:**
1. BBM/tol/parkir: jumlah, foto nota wajib, sumber dana (kas di tangan/pribadi) → Admin Keuangan menerima/menolak saat menerima setoran.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Jenis (BBM, tol, parkir, lainnya), jumlah, foto nota wajib, terkait rit atau hari, truk; sumber dana: kas di tangan atau uang pribadi (PTB-20). | ☐ | ☐ |  |
| 2 | Pengeluaran berstatus "menunggu verifikasi" sampai Admin Keuangan menerima nota saat penerimaan setoran (US-M4-02); ditolak → dihitung sebagai selisih kas dengan alasan; diterima dari uang pribadi → diganti Admin Keuangan dan tercatat. | ☐ | ☐ |  |
| 3 | Pengeluaran BBM terkait truk dan tanggal untuk jurnal otomatis M11 dan biaya per rit bersama jarak GPS (FR-M12-07, S). | ☐ | ☐ |  |

### US-M3-09 Bekerja tanpa sinyal dan menyinkronkan otomatis — M

**Layar:** `/sopir` (mode pesawat)  
**Rujukan PRD:** baris 802

**Langkah uji:**
1. Aktifkan mode pesawat: Berangkat–Tiba–Selesai–bayar–setor tetap jalan; status *Tersimpan di ponsel: N*.
2. Matikan mode pesawat → *Semua terkirim* ≤ 5 menit tanpa dobel; kantor mengubah rit yang sudah dikerjakan offline → tampil *Konflik*, data lapangan tetap sah.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Seluruh tindakan US-M3-02 s.d. US-M3-08 berfungsi tanpa sinyal minimal satu hari kerja penuh; data rit hari ini, koordinat dan catatan pelanggan, harga pesanan, faktur terbuka pelanggan hari itu, dan template struk diunduh saat jadwal terbit atau saat login. | ☐ | ☐ |  |
| 2 | Setiap item menampilkan status "tersimpan di ponsel"/"terkirim"; ikon di layar utama menunjukkan jumlah item belum terkirim; sinkron otomatis ≤ 5 menit setelah sinyal kembali dan dapat dipicu manual; pengiriman ulang tidak menggandakan (Bab 6.4). | ☐ | ☐ |  |
| 3 | Admin Keuangan tidak dapat menerima setoran sebelum seluruh transaksi hari itu dari perangkat tersebut tersinkron; ringkasan setoran menampilkan "menunggu sinkron" bila masih ada antrean [USULAN]. | ☐ | ☐ |  |
| 4 | Login PIN berfungsi offline; kredensial tidak tersimpan dalam bentuk terbaca (NFR-10); pergantian pengguna (sopir ↔ kernet pengganti) tidak menghapus antrean. | ☐ | ☐ |  |
| 5 | Perangkat rusak/hilang dengan antrean belum terkirim: pencatatan oleh Admin Keuangan atas nama sopir dengan penanda "dicatat kantor" (Bab 6.1) berdasarkan bukti yang ada; kejadian dilaporkan ke pemilik dan dihitung pada KPI-01. | ☐ | ☐ |  |

### US-M3-10 Keamanan perangkat dan kesiapan lapangan — M

**Layar:** `/sopir` login PIN, *Ganti pengguna*; kantor: Akses › Perangkat  
**Rujukan PRD:** baris 812

**Langkah uji:**
1. Salah PIN 5× → terkunci 15 menit; layar terkunci setelah 10 menit diam; ganti pengguna tidak menghapus antrean sopir lain.
2. Ponsel tidak terdaftar ditolak; admin sistem memblokir perangkat → permintaan berikutnya ditolak.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Aplikasi hanya dapat login pada perangkat terdaftar (M10); PIN 6 digit per pengguna; 5 kali salah → terkunci 15 menit dan admin sistem diberi tahu (PAR-36 [USULAN]); layar terkunci setelah 10 menit tidak aktif (PAR-37 [USULAN]) tanpa kehilangan data. | ☐ | ☐ |  |
| 2 | Tidak ada tombol ubah/hapus pada transaksi terkirim; koreksi hanya oleh Admin Keuangan dengan alasan (FR-M3-07). | ☐ | ☐ |  |
| 3 | Sopir baru mampu menjalankan satu rit lengkap (Berangkat–Selesai–bayar–Setor) tanpa pendampingan setelah pelatihan ≤ 2 jam dan panduan 1 halaman (NFR-16); diuji pada pilot 2 truk. | ☐ | ☐ |  |
| 4 | Kuota ≤ 50 MB/bulan per sopir (foto terkompresi, jejak GPS ponsel hanya cadangan) dan ukuran unduhan aplikasi kecil (NFR-17); diukur pada pilot. | ☐ | ☐ |  |
| 5 | Perangkat hilang: admin sistem memblokir dan menghapus jarak jauh (BR-37); akun karyawan keluar dinonaktifkan hari itu. | ☐ | ☐ |  |
| 6 | Pesan kesalahan berbahasa Indonesia dan berisi tindakan, misalnya "Sinyal hilang — data tersimpan, lanjutkan"; tidak ada kode teknis. | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| B-19 / NFR-18 | Ukuran teks ≥ 16 pt & kontras terbaca di bawah sinar matahari langsung oleh sopir (tanpa kacamata baca). | ☐ | ☐ |  |
| B-19 | Kamera nyata ponsel truk: foto bukti kirim & nota ≤ PAR-38 (bawaan 150 KB, sisi 1.280 px) setelah kompresi, tetap terbaca. | ☐ | ☐ |  |
| B-19 / NFR-06 | Rute Cianjur tanpa sinyal: satu hari penuh rit (≥ 24 jam mode pesawat untuk uji UI) → semua transaksi terkirim, jumlah & nilai = server. | ☐ | ☐ |  |
| NFR-07 | Uji putus-sambung 50× (matikan/nyalakan data) → 0 transaksi hilang/dobel (cocokkan jumlah & nilai). | ☐ | ☐ |  |
| NFR-08 | Sopir baru dapat menyebutkan status item (tersimpan vs terkirim) tanpa dibantu. | ☐ | ☐ |  |
| NFR-16 | Pelatihan ≤ 2 jam dengan panduan 1 halaman; alur rit ≤ 3 langkah. | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M3 Aplikasi Sopir**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Dispatcher (bersama sopir juara lapangan) — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-01 langkah 5–9; P-05 langkah 3 |
| Data uji | Rit sungguhan di truk pilot (rute dekat & jauh), termasuk ruas tanpa sinyal |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M3-01 |  | __ / __ |  |
| US-M3-02 |  | __ / __ |  |
| US-M3-03 |  | __ / __ |  |
| US-M3-04 |  | __ / __ |  |
| US-M3-05 |  | __ / __ |  |
| US-M3-06 |  | __ / __ |  |
| US-M3-07 |  | __ / __ |  |
| US-M3-08 |  | __ / __ |  |
| US-M3-09 |  | __ / __ |  |
| US-M3-10 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
