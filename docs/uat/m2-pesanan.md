# UAT M2 — Pesanan & Penjadwalan Rit

> **Dibangkitkan `pnpm uat:gen`** (`tools/gen-uat.ts` + `tools/uat-config.ts`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [`docs/uat/README.md`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | Dispatcher |
| Skenario BRD | P-01 langkah 1–4 |
| User story diuji (PRD 11.3) | US-M2-01 s.d. US-M2-05, US-M2-08, US-M2-09, US-M2-11 (M); US-M2-06, US-M2-07, US-M2-10 (S) |
| Data uji | Satu hari pesanan nyata (≥ 14 rit pelanggan + rit internal pasokan depot) |
| Akun uji | Dispatcher (`dispatcher1`), pemilik (`pemilik`), sopir (`sopir1` di ponsel truk T1) |
| Panduan pengguna | `docs/guides/m2-orders.md` |
| Jumlah | 11 user story · 51 KP |

## Persiapan

- [ ] Master pelanggan, zona, harga, armada & kru terisi (UAT M1 lulus); ponsel truk T1 terdaftar.
- [ ] Uji otomatis modul hijau (`pnpm test`; cakupan KP di `docs/dev/traceability.md`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.

## Checklist user story & kriteria penerimaan

### US-M2-01 Membuat pesanan dalam kurang dari 60 detik — M

**Layar:** Pesanan & jadwal › Pesanan baru (`/pesanan/baru`)  
**Rujukan PRD:** baris 584

**Langkah uji:**
1. Catat pesanan telepon: cari pelanggan (2 huruf), jumlah tangki, tanggal/jam, cara bayar → *Simpan pesanan*; nomor `P-YY-NNNNNN` tampil.
2. Catat setelah 15.00 untuk hari ini → tanggal pindah ke besok (paksa hari ini = alasan).
3. Pelanggan baru dari layar yang sama (status Tunai); pasokan depot internal (harga transfer internal).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Satu layar tanpa pindah halaman: cari pelanggan (nama/WA/alamat; hasil tampil setelah 2 karakter dalam ≤ 1 detik), pilih alamat kirim (bawaan: alamat terakhir dipakai), jumlah tangki (bawaan 1), tanggal diminta (bawaan hari ini bila sebelum 15.00, bila tidak H+1 — BR-20), jam diminta (opsional; jam terima tetap pelanggan terisi otomatis), cara bayar (bawaan tunai; transfer; tempo hanya bila status Tempo dan dalam batas), catatan. | ☐ | ☐ |  |
| 2 | Harga per rit tampil otomatis dari zona alamat + komponen BBM atau harga khusus (US-M1-02, US-M1-05); total = harga × jumlah tangki; Dispatcher tidak dapat mengubah harga (BR-19). | ☐ | ☐ |  |
| 3 | Pelanggan baru dapat dibuat di layar yang sama dengan bidang minimal (nama, WA, alamat, segmen) dan otomatis Tunai (BR-01); kelengkapan lain dilengkapi kemudian. | ☐ | ☐ |  |
| 4 | Pesanan H+0 setelah 15.00: sistem mengusulkan H+1; Dispatcher dapat memaksa H+0 dengan alasan tercatat (BR-20). | ☐ | ☐ |  |
| 5 | Pesanan dengan n tangki menghasilkan n rit yang dapat dijadwalkan ke truk dan hari yang berbeda [ASUMSI-PRD PTB-09]. | ☐ | ☐ |  |
| 6 | Pesanan internal pasokan depot: pelanggan = depot sendiri, produk transfer internal, cara bayar "internal"; muncul di papan jadwal dan aplikasi sopir seperti rit biasa, tanpa pencatatan uang [KEPUTUSAN PTB-01]. | ☐ | ☐ |  |
| 7 | Waktu dari klik "Pesanan baru" hingga tersimpan ≤ 60 detik untuk pelanggan yang sudah ada, diukur pada UAT dengan 10 pesanan berturut oleh Dispatcher yang sudah dilatih. | ☐ | ☐ |  |
| 8 | Setelah tersimpan: nomor pesanan tampil besar dan tombol "Kirim konfirmasi WA" (US-M2-07). | ☐ | ☐ |  |

### US-M2-02 Nomor dan status pesanan — M

**Layar:** Pesanan (`/pesanan`, `/pesanan/[id]`)  
**Rujukan PRD:** baris 597

**Langkah uji:**
1. Ikuti satu pesanan Baru → Terjadwal → Dalam pengiriman → Selesai (rit dari aplikasi sopir); lihat riwayat status & nomor rit `/n`.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Nomor pesanan otomatis, unik, tidak dapat diubah, berurutan per tahun dengan format `P-YY-NNNNNN` (contoh P-27-000123) [USULAN PTB-14]; nomor rit = nomor pesanan + urutan tangki (P-27-000123/2). | ☐ | ☐ |  |
| 2 | Siklus status sesuai Bab 5.2 (Pesanan); setiap transisi mencatat waktu dan pelaku; status Selesai/Dibatalkan terkunci. | ☐ | ☐ |  |
| 3 | Pembatalan wajib alasan dari daftar (pelanggan batal, dobel, tidak ada truk, harga, lainnya + teks); pembatalan pesanan yang sudah Dalam pengiriman tidak dimungkinkan dari kantor. | ☐ | ☐ |  |
| 4 | Pencarian dan filter pesanan: nomor, pelanggan, tanggal, status, truk, cara bayar; ekspor Excel (NFR-23). | ☐ | ☐ |  |

### US-M2-03 Papan jadwal rit harian — M

**Layar:** Papan jadwal (`/jadwal`)  
**Rujukan PRD:** baris 606

**Langkah uji:**
1. Seret rit ke jalur truk, atur urutan (BR-21), *Terbitkan* per truk → rit tampil di aplikasi sopir.
2. Tarik/pindah rit setelah terbit → penanda & terbit ulang; rit lewat tanggal tampil merah paling atas; peta truk tampil di bawah papan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Papan per tanggal: satu jalur per truk aktif dengan kru hari itu (dari US-M2-10); kolom "Belum terjadwal" menampilkan semua rit tanggal itu (dan tanggal lewat yang belum selesai) dengan penonjolan warna dan hitungan. | ☐ | ☐ |  |
| 2 | Menugaskan rit ke truk dan urutan dengan seret-lepas atau pilih; urutan diberi nomor; sistem menampilkan jumlah rit (pelanggan dan internal, terpisah dan gabungan) dan volume per truk vs kapasitas rit harian (PAR-33, bawaan 3 rit/truk, dapat diatur per truk; kapasitas nyata dari US-M2-10 bila tersedia). | ☐ | ☐ |  |
| 3 | Urutan usulan otomatis mengikuti BR-21: rit langganan dan pelanggan berjam-terima-tetap lebih dulu, sisanya berdasarkan waktu pesanan masuk; Dispatcher dapat mengubah urutan. | ☐ | ☐ |  |
| 4 | Rit tidak dapat ditugaskan ke truk Perbaikan/Nonaktif atau tanpa sopir hari itu; sistem menolak dengan pesan. | ☐ | ☐ |  |
| 5 | Tombol "Terbitkan" mengirim jadwal ke aplikasi sopir; perubahan setelah terbit (tambah/geser/tarik rit) mengirim pembaruan dan tercatat; rit yang sudah Berangkat tidak dapat dipindahkan. | ☐ | ☐ |  |
| 6 | Papan menampilkan status rit real-time dari M3 (Ditugaskan/Berangkat/Tiba/Selesai/Gagal) dan posisi truk dari M12 (FR-M12-01) pada peta yang sama atau berdampingan. | ☐ | ☐ |  |
| 7 | Rit yang sopirnya terkunci karena setoran belum ditutup (BR-10) ditandai pada papan agar Dispatcher dapat menghubungi Admin Keuangan. | ☐ | ☐ |  |

### US-M2-04 Peringatan pesanan dobel — M

**Layar:** Pesanan baru  
**Rujukan PRD:** baris 618

**Langkah uji:**
1. Buat pesanan kedua pelanggan & tanggal sama → *Kemungkinan dobel*: uji *Pesanan tambahan* (alasan) dan *Batalkan yang ini* (alasan Dobel, KPI-06).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Saat menyimpan pesanan dengan pelanggan, alamat kirim, dan tanggal diminta yang sama dengan pesanan berstatus Baru/Terjadwal/Dalam pengiriman, sistem menampilkan pesanan yang ada (nomor, jumlah, status, pembuat) dan pilihan: "Ini pesanan tambahan" (lanjut, alasan tercatat) atau "Batalkan yang ini". | ☐ | ☐ |  |
| 2 | Pesanan yang dilanjutkan tetap ditandai "kemungkinan dobel" pada papan hingga salah satunya Selesai/Dibatalkan. | ☐ | ☐ |  |
| 3 | Jumlah pesanan dibatalkan dengan alasan "dobel" dan pesanan lewat tanggal tanpa jadwal ulang dilaporkan bulanan (KPI-06, M9). | ☐ | ☐ |  |

### US-M2-05 Kontrol kredit pada pesanan tempo — M

**Layar:** Pesanan baru (tempo), Persetujuan (`/persetujuan`)  
**Rujukan PRD:** baris 626

**Langkah uji:**
1. Pesanan tempo pelanggan Tunai/Ditahan/melampaui batas → ditolak; *Ajukan ke pemilik* → Menunggu persetujuan, belum dapat dijadwalkan.
2. Pemilik menyetujui/menolak dari ponsel; pelanggan dengan kurang bayar kedua belum lunas tertahan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Cara bayar "tempo" hanya dapat dipilih bila status kredit pelanggan = Tempo; bila Tunai, pilihan tidak tersedia dengan keterangan; bila Ditahan, ditolak dengan keterangan piutang lewat tempo dan tombol "Ajukan persetujuan pemilik". | ☐ | ☐ |  |
| 2 | Sistem menghitung eksposur = piutang belum lunas + nilai pesanan tempo berstatus Baru/Terjadwal/Dalam pengiriman + nilai pesanan ini (BR-06); bila > batas kredit, ditolak dengan angka eksposur dan batas, serta tombol "Ajukan persetujuan pemilik". | ☐ | ☐ |  |
| 3 | Pengajuan membuat permintaan persetujuan (Bab 6.2) dengan status pesanan "Menunggu persetujuan"; pesanan tidak dapat dijadwalkan sampai disetujui; pemilik menyetujui/menolak dengan alasan dari web/ponsel; Dispatcher dapat mengubah cara bayar ke tunai kapan saja. | ☐ | ☐ |  |
| 4 | Persetujuan berlaku untuk pesanan itu saja, bukan mengubah batas pelanggan. | ☐ | ☐ |  |
| 5 | Keputusan dan eksposur saat keputusan tercatat pada pesanan. | ☐ | ☐ |  |
| 6 | Pelanggan dengan faktur kurang bayar terbuka (PTB-18): pesanan baru bertanda "tagih kurang bayar" dan sisanya ditagih sopir saat pengiriman (US-M3-05); bila terjadi kurang bayar kedua saat yang pertama belum lunas, pesanan baru hanya dapat dijadwalkan setelah lunas atau disetujui pemilik (6.2a). | ☐ | ☐ |  |

### US-M2-06 Pesanan berulang / langganan — S

**Layar:** Pesanan berulang (`/langganan`)  
**Rujukan PRD:** baris 637

**Langkah uji:**
1. Buat langganan mingguan → pesanan terbentuk otomatis PAR-34 hari sebelum tanggal kirim; jeda/akhiri langganan beralasan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Pola: pelanggan, alamat, hari dalam minggu atau interval hari, jumlah tangki, jam diminta, cara bayar, tanggal mulai/berakhir; status Aktif/Jeda/Berakhir. | ☐ | ☐ |  |
| 2 | Sistem membuat pesanan berstatus Baru dengan tanda "langganan" pada H-2 [USULAN, PAR-34]; pesanan mengikuti kontrol kredit US-M2-05 dan diprioritaskan pada urutan BR-21. | ☐ | ☐ |  |
| 3 | Pola yang dijeda tidak menghasilkan pesanan; pesanan yang sudah dibuat dari pola tidak berubah bila pola diubah. | ☐ | ☐ |  |
| 4 | Daftar "pesanan langganan yang gagal dibuat" (misalnya kredit ditahan) tampil ke Dispatcher. | ☐ | ☐ |  |

### US-M2-07 Konfirmasi pesanan ke pelanggan lewat WA — S

**Layar:** Pesanan baru → *Kirim konfirmasi WA*  
**Rujukan PRD:** baris 646

**Langkah uji:**
1. Tekan *Kirim konfirmasi WA* → WhatsApp terbuka dengan template terisi (nomor, tanggal, harga, total); status tercatat *Dibuka*.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Template (dikelola pemilik) memuat nomor pesanan, tanggal/jam, jumlah tangki, harga, cara bayar, kontak EQUA; tombol membuka WhatsApp dengan pesan terisi ke nomor pelanggan. | ☐ | ☐ |  |
| 2 | Sistem mencatat "konfirmasi dibuka" (waktu, pelaku); tidak mengklaim terkirim/terbaca. | ☐ | ☐ |  |
| 3 | Bila WhatsApp Business API diaktifkan kemudian, pengiriman menjadi otomatis tanpa mengubah alur Dispatcher. | ☐ | ☐ |  |

### US-M2-08 Riwayat dan catatan khusus pelanggan — M

**Layar:** Pesanan baru (panel kanan), Data master › Pelanggan  
**Rujukan PRD:** baris 654

**Langkah uji:**
1. Saat memilih pelanggan: riwayat, piutang, catatan khusus & jam terima tetap tampil; catatan khusus terbawa ke rit di aplikasi sopir.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Panel pelanggan pada layar pesanan: 10 pesanan terakhir (tanggal, jumlah, status, truk), piutang terbuka dan batas tersisa, catatan khusus (akses lokasi, jam terima), harga khusus yang berlaku. | ☐ | ☐ |  |
| 2 | Catatan khusus ikut terkirim ke aplikasi sopir pada rit terkait. | ☐ | ☐ |  |
| 3 | Riwayat lengkap dapat diekspor per pelanggan. | ☐ | ☐ |  |

### US-M2-09 Pembatalan, penjadwalan ulang, dan rit gagal — M

**Layar:** Rincian pesanan (`/pesanan/[id]`), Papan jadwal  
**Rujukan PRD:** baris 662

**Langkah uji:**
1. *Batalkan* (alasan wajib; tidak dihapus), *Jadwal ulang* (tanggal baru + alasan).
2. Rit gagal dari aplikasi sopir → kartu *Perlu jadwal ulang* di papan; konfirmasi ulang wajib setelah 2 rit gagal.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Penjadwalan ulang mengubah tanggal diminta dengan alasan; riwayat tanggal tersimpan. | ☐ | ☐ |  |
| 2 | Rit Gagal dari M3 (pelanggan tidak ada/menolak/jalan ditutup/truk rusak) membuat kejadian dengan alasan, foto, waktu, lokasi; pesanan kembali ke Baru dengan penanda "perlu jadwal ulang" dan muncul di kolom belum terjadwal. | ☐ | ☐ |  |
| 3 | Dua rit gagal berturut-turut untuk pelanggan yang sama: pesanan berikutnya wajib dicentang "sudah dikonfirmasi ulang" (dengan waktu dan cara) sebelum dapat dijadwalkan (BR-24). | ☐ | ☐ |  |
| 4 | Laporan bulanan alasan pembatalan dan kegagalan per pelanggan dan per truk (M9). | ☐ | ☐ |  |

### US-M2-10 Jadwal kerja kru dan ketersediaan truk — S

**Layar:** Jadwal kru (`/jadwal/kru`)  
**Rujukan PRD:** baris 671

**Langkah uji:**
1. Tandai sopir libur/bertugas di truk lain pada jadwal mingguan; ubah kapasitas rit per truk per hari; status truk Perbaikan beralasan.

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Jadwal mingguan per truk per hari: sopir, kernet, libur; penetapan pengemudi pengganti harian memakai US-M2-11 (M) dan tetap berfungsi walau jadwal mingguan ini belum dibangun. | ☐ | ☐ |  |
| 2 | Status truk per hari (operasi/perbaikan) memengaruhi kapasitas; kapasitas rit harian = Σ kapasitas rit truk yang beroperasi (PAR-33, bawaan 3 per truk, dapat diatur per truk); beban = rit pelanggan + rit internal pasokan depot (PTB-01). PAR-33 dikalibrasi ulang dari baseline KPI-07 tiga bulan sebelum Tahap 2 (Bab 8.1). | ☐ | ☐ |  |
| 3 | Papan jadwal menampilkan kapasitas vs terjadwal; melebihi kapasitas diperingatkan, tidak diblokir. | ☐ | ☐ |  |
| 4 | Tanpa fitur ini (bila S ditunda), papan memakai kru default (US-M1-03), penetapan pengemudi pengganti harian (US-M2-11), dan kapasitas PAR-33. | ☐ | ☐ |  |

### US-M2-11 Penetapan pengemudi pengganti harian — M

**Layar:** Jadwal kru › Pengemudi hari itu  
**Rujukan PRD:** baris 680

**Langkah uji:**
1. Tetapkan kernet/sopir lain sebagai pengganti (alasan) → di ponsel truk pengganti mendapat tombol sopir; berlaku sampai akhir hari.
2. Coba tetapkan sopir yang setoran kemarin belum Ditutup → ditolak (BR-10).

| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |
|:-:|---|:-:|:-:|---|
| 1 | Per truk per tanggal, Dispatcher menetapkan pengemudi hari itu: sopir default (bawaan dari US-M1-03), kernet truk itu, atau sopir lain yang tidak bertugas; penetapan berlaku sampai akhir hari kas dan dapat diubah dengan alasan. | ☐ | ☐ |  |
| 2 | Pengemudi pengganti mendapat hak tindakan sopir di aplikasi (US-M3-01 KP-6) hanya untuk truk dan tanggal itu; kernet yang tidak ditetapkan tetap hanya membaca. | ☐ | ☐ |  |
| 3 | Ganti pengemudi di tengah hari: setoran dipisah per pengguna — masing-masing menyetor kas yang diterimanya (7.3.6); rit yang sudah Berangkat tetap atas nama pelaksananya. | ☐ | ☐ |  |
| 4 | Pengemudi yang setoran hari sebelumnya belum Ditutup tidak dapat ditetapkan (BR-10); sistem menampilkan alasannya. | ☐ | ☐ |  |
| 5 | Setiap penetapan berjejak (pelaku, waktu, alasan) dan tampil di papan jadwal (US-M2-03) serta laporan kinerja (US-M9-05). | ☐ | ☐ |  |

## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
| B-14 | Pesanan telepon/WA dicatat < 60 detik (US-M2-01 KP-7): stopwatch 10 pesanan oleh Dispatcher pada data nyata; catat rata-rata & terlama. | ☐ | ☐ |  |
| NFR-20 | Tiga template WA (konfirmasi pesanan, struk rit, pengingat) terkirim lewat tautan dari ponsel/PC kantor nyata. | ☐ | ☐ |  |
| NFR-19 | Pemilik menyetujui pesanan tempo dari ponsel (layar Persetujuan terbaca di lebar ponsel). | ☐ | ☐ |  |

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

**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — M2 Pesanan & Penjadwalan Rit**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | Dispatcher — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | P-01 langkah 1–4 |
| Data uji | Satu hari pesanan nyata (≥ 14 rit pelanggan + rit internal pasokan depot) |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
| US-M2-01 |  | __ / __ |  |
| US-M2-02 |  | __ / __ |  |
| US-M2-03 |  | __ / __ |  |
| US-M2-04 |  | __ / __ |  |
| US-M2-05 |  | __ / __ |  |
| US-M2-06 |  | __ / __ |  |
| US-M2-07 |  | __ / __ |  |
| US-M2-08 |  | __ / __ |  |
| US-M2-09 |  | __ / __ |  |
| US-M2-10 |  | __ / __ |  |
| US-M2-11 |  | __ / __ |  |

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |
