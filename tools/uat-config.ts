/**
 * Konfigurasi dokumen UAT per modul (PRD 11.3) — dipakai `tools/gen-uat.ts` (`pnpm uat:gen`) untuk membangkitkan
 * `docs/uat/<modul>.md`. Teks KP diambil APA ADANYA dari PRD; berkas ini hanya memuat metadata 11.3 (pemilik modul,
 * skenario BRD, data uji), langkah di layar nyata per user story, dan item UAT manual dari backlog/NFR.
 * Ubah berkas ini (bukan hasil di docs/uat) lalu jalankan `pnpm uat:gen`.
 */

export type StoryUat = {
  /** Layar/menu nyata (web kantor, aplikasi lapangan, POS, portal). */
  screen: string;
  /** Langkah uji ringkas (urut). */
  steps: string[];
};

export type ManualItem = { ref: string; text: string };

export type ModuleUat = {
  /** Nama berkas di docs/uat (tanpa .md). */
  file: string;
  /** Kode modul PRD ("M1".."M12", "P3"). */
  module: string;
  title: string;
  /** Awalan US yang dicakup (mis. "US-M1-"); untuk RL-7 dibatasi `only`. */
  prefix: string;
  only?: string[];
  owner: string;
  scenario: string;
  stories: string;
  data: string;
  accounts: string;
  guide: string;
  setup: string[];
  steps: Record<string, StoryUat>;
  manual: ManualItem[];
};

export const MODULES: ModuleUat[] = [
  // ------------------------------------------------------------------------------------------------------------- M1
  {
    file: "m1-data-master",
    module: "M1",
    title: "Master Data",
    prefix: "US-M1-",
    owner: "Pemilik",
    scenario: "P-01 langkah 1; migrasi BRD 10.3",
    stories: "US-M1-01 s.d. US-M1-06 (semua M)",
    data: "300 pelanggan hasil impor uji (template Master > Impor, data disamarkan — NFR-27); zona tarif & harga nyata dari pemilik (K23)",
    accounts: "Dispatcher (`dispatcher1`), Admin Keuangan (`keuangan1`), pemilik (`pemilik`), admin sistem (`admin1`)",
    guide: "docs/guides/m1-master.md",
    setup: [
      "Lingkungan uji (Preview + branch Neon) dengan `pnpm db:migrate && pnpm db:seed:prod`, atau gladi dengan data demo `pnpm db:seed`.",
      "Berkas impor uji 300 pelanggan (beberapa duplikat & baris salah disengaja) dan daftar tarif zona dari pemilik.",
    ],
    steps: {
      "US-M1-01": {
        screen: "Data master › Pelanggan (`/master/pelanggan`, `/master/pelanggan/[id]`)",
        steps: [
          "Dispatcher: *Pelanggan baru* — isi nama, segmen, WA, satu alamat dengan koordinat (klik peta) dan satu tanpa koordinat.",
          "Simpan pelanggan kedua dengan WA sama → kandidat duplikat tampil, tidak memblokir.",
          "Coba *Ajukan Tempo* pada pelanggan baru (tidak aktif) dan pada pelanggan memenuhi PAR-11; ajukan harga khusus → pemilik memutuskan di Persetujuan.",
          "Coba nonaktifkan pelanggan berpiutang (ditolak) lalu yang bersih (berhasil, beralasan); periksa Jejak audit.",
        ],
      },
      "US-M1-02": {
        screen: "Data master › Produk & harga (`/master/produk`)",
        steps: [
          "Admin Keuangan menginput harga baru bertanggal berlaku besok → pemilik menyetujui; pemilik menginput harga sendiri (keputusan langsung, alasan wajib).",
          "Buat pesanan untuk tanggal sebelum & sesudah tanggal berlaku → harga mengikuti tanggal; ubah harga saat pesanan sudah terkunci → Dispatcher diberi peringatan.",
          "Nonaktifkan satu produk → hilang dari POS/pesanan, tetap di riwayat.",
        ],
      },
      "US-M1-03": {
        screen: "Data master › Armada & kru (`/master/armada`)",
        steps: [
          "Tambah/ubah truk (nopol, kapasitas, pool, perangkat GPS & ponsel, sopir & kernet default).",
          "Coba jadikan satu sopir kru default dua truk (ditolak); ubah status truk ke Perbaikan → rit terjadwal ditandai perlu dipindah + notifikasi Dispatcher.",
        ],
      },
      "US-M1-04": {
        screen: "Data master › Depot & toko, Sumber air, Pool/garasi, Karyawan",
        steps: [
          "Tambah depot (kode, koordinat, radius geofence, kapasitas, kas awal tetap) dan sumber air + meter dengan foto angka awal.",
          "Tambah karyawan dengan tanggal keluar hari ini → akun nonaktif otomatis (cek Akses › Pengguna).",
        ],
      },
      "US-M1-05": {
        screen: "Data master › Zona tarif (`/master/zona`)",
        steps: [
          "Isi tarif per zona & komponen BBM; jalankan *Simulasi* perubahan tarif sebelum disetujui pemilik.",
          "Alamat berkoordinat terpetakan ke zona otomatis; alamat tanpa koordinat → zona manual beralasan; bandingkan jarak rit dengan zona (pemeriksaan zona).",
        ],
      },
      "US-M1-06": {
        screen: "Data master › Impor data awal (`/master/impor`), Tanda tangan data awal (`/master/tanda-tangan`)",
        steps: [
          "Unduh template, unggah 300 pelanggan mode **Uji** → laporan validasi (baris salah, duplikat); perbaiki/kecualikan/gabungkan.",
          "Ulangi mode **Produksi** → *Masukkan data*; pelanggan tempo migrasi berstatus *Tempo migrasi*.",
          "Pemilik menandatangani kelompok data *Pelanggan* (penyusun ≠ penanda tangan).",
        ],
      },
    },
    manual: [
      { ref: "B-14", text: "Cari pelanggan ≤ 1 detik pada volume nyata (300+ pelanggan) — ukur 10 pencarian nama/WA/alamat dengan stopwatch." },
      { ref: "NFR-27", text: "Impor data awal diuji di lingkungan uji dengan data tersamar (`pnpm db:mask`) sebelum impor produksi (US-M1-06 KP-3)." },
      { ref: "NFR-34", text: "Kelompok data pelanggan, tarif & harga, armada & kru, depot & sumber air berstatus *Ditandatangani* sebelum TG-7." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------- M2
  {
    file: "m2-pesanan",
    module: "M2",
    title: "Pesanan & Penjadwalan Rit",
    prefix: "US-M2-",
    owner: "Dispatcher",
    scenario: "P-01 langkah 1–4",
    stories: "US-M2-01 s.d. US-M2-05, US-M2-08, US-M2-09, US-M2-11 (M); US-M2-06, US-M2-07, US-M2-10 (S)",
    data: "Satu hari pesanan nyata (≥ 14 rit pelanggan + rit internal pasokan depot)",
    accounts: "Dispatcher (`dispatcher1`), pemilik (`pemilik`), sopir (`sopir1` di ponsel truk T1)",
    guide: "docs/guides/m2-orders.md",
    setup: ["Master pelanggan, zona, harga, armada & kru terisi (UAT M1 lulus); ponsel truk T1 terdaftar."],
    steps: {
      "US-M2-01": {
        screen: "Pesanan & jadwal › Pesanan baru (`/pesanan/baru`)",
        steps: [
          "Catat pesanan telepon: cari pelanggan (2 huruf), jumlah tangki, tanggal/jam, cara bayar → *Simpan pesanan*; nomor `P-YY-NNNNNN` tampil.",
          "Catat setelah 15.00 untuk hari ini → tanggal pindah ke besok (paksa hari ini = alasan).",
          "Pelanggan baru dari layar yang sama (status Tunai); pasokan depot internal (harga transfer internal).",
        ],
      },
      "US-M2-02": {
        screen: "Pesanan (`/pesanan`, `/pesanan/[id]`)",
        steps: ["Ikuti satu pesanan Baru → Terjadwal → Dalam pengiriman → Selesai (rit dari aplikasi sopir); lihat riwayat status & nomor rit `/n`."],
      },
      "US-M2-03": {
        screen: "Papan jadwal (`/jadwal`)",
        steps: [
          "Seret rit ke jalur truk, atur urutan (BR-21), *Terbitkan* per truk → rit tampil di aplikasi sopir.",
          "Tarik/pindah rit setelah terbit → penanda & terbit ulang; rit lewat tanggal tampil merah paling atas; peta truk tampil di bawah papan.",
        ],
      },
      "US-M2-04": {
        screen: "Pesanan baru",
        steps: ["Buat pesanan kedua pelanggan & tanggal sama → *Kemungkinan dobel*: uji *Pesanan tambahan* (alasan) dan *Batalkan yang ini* (alasan Dobel, KPI-06)."],
      },
      "US-M2-05": {
        screen: "Pesanan baru (tempo), Persetujuan (`/persetujuan`)",
        steps: [
          "Pesanan tempo pelanggan Tunai/Ditahan/melampaui batas → ditolak; *Ajukan ke pemilik* → Menunggu persetujuan, belum dapat dijadwalkan.",
          "Pemilik menyetujui/menolak dari ponsel; pelanggan dengan kurang bayar kedua belum lunas tertahan.",
        ],
      },
      "US-M2-06": {
        screen: "Pesanan berulang (`/langganan`)",
        steps: ["Buat langganan mingguan → pesanan terbentuk otomatis PAR-34 hari sebelum tanggal kirim; jeda/akhiri langganan beralasan."],
      },
      "US-M2-07": {
        screen: "Pesanan baru → *Kirim konfirmasi WA*",
        steps: ["Tekan *Kirim konfirmasi WA* → WhatsApp terbuka dengan template terisi (nomor, tanggal, harga, total); status tercatat *Dibuka*."],
      },
      "US-M2-08": {
        screen: "Pesanan baru (panel kanan), Data master › Pelanggan",
        steps: ["Saat memilih pelanggan: riwayat, piutang, catatan khusus & jam terima tetap tampil; catatan khusus terbawa ke rit di aplikasi sopir."],
      },
      "US-M2-09": {
        screen: "Rincian pesanan (`/pesanan/[id]`), Papan jadwal",
        steps: [
          "*Batalkan* (alasan wajib; tidak dihapus), *Jadwal ulang* (tanggal baru + alasan).",
          "Rit gagal dari aplikasi sopir → kartu *Perlu jadwal ulang* di papan; konfirmasi ulang wajib setelah 2 rit gagal.",
        ],
      },
      "US-M2-10": {
        screen: "Jadwal kru (`/jadwal/kru`)",
        steps: ["Tandai sopir libur/bertugas di truk lain pada jadwal mingguan; ubah kapasitas rit per truk per hari; status truk Perbaikan beralasan."],
      },
      "US-M2-11": {
        screen: "Jadwal kru › Pengemudi hari itu",
        steps: [
          "Tetapkan kernet/sopir lain sebagai pengganti (alasan) → di ponsel truk pengganti mendapat tombol sopir; berlaku sampai akhir hari.",
          "Coba tetapkan sopir yang setoran kemarin belum Ditutup → ditolak (BR-10).",
        ],
      },
    },
    manual: [
      { ref: "B-14", text: "Pesanan telepon/WA dicatat < 60 detik (US-M2-01 KP-7): stopwatch 10 pesanan oleh Dispatcher pada data nyata; catat rata-rata & terlama." },
      { ref: "NFR-20", text: "Tiga template WA (konfirmasi pesanan, struk rit, pengingat) terkirim lewat tautan dari ponsel/PC kantor nyata." },
      { ref: "NFR-19", text: "Pemilik menyetujui pesanan tempo dari ponsel (layar Persetujuan terbaca di lebar ponsel)." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------- M3
  {
    file: "m3-sopir",
    module: "M3",
    title: "Aplikasi Sopir",
    prefix: "US-M3-",
    owner: "Dispatcher (bersama sopir juara lapangan)",
    scenario: "P-01 langkah 5–9; P-05 langkah 3",
    stories: "US-M3-01 s.d. US-M3-07 (termasuk struk WA versi tautan, US-M3-03 KP-7), US-M3-09, US-M3-10 (M); US-M3-08 (S)",
    data: "Rit sungguhan di truk pilot (rute dekat & jauh), termasuk ruas tanpa sinyal",
    accounts: "Sopir (`sopir1`), kernet (`kernet1`) di ponsel truk T1; Dispatcher; Admin Keuangan (dicatat kantor & setoran)",
    guide: "docs/guides/lapangan/sopir-kernet.md (1 halaman) · docs/guides/m3-driver.md",
    setup: [
      "Ponsel truk diaktifkan di hadapan admin sistem (`/aktivasi-perangkat`), sopir & kernet menetapkan PIN.",
      "Papan jadwal hari itu diterbitkan (UAT M2).",
    ],
    steps: {
      "US-M3-01": {
        screen: "Aplikasi sopir `/sopir` › Daftar rit",
        steps: ["Login PIN → rit hari ini urut rencana; buka rincian (catatan, telepon/WA, harga pesanan, faktur terbuka, kredit pelanggan) → *Navigasi* membuka peta ponsel."],
      },
      "US-M3-02": {
        screen: "`/sopir` › rincian rit",
        steps: ["*Berangkat* lalu *Tiba* — waktu & lokasi otomatis; coba berangkatkan rit kedua saat satu berjalan (ditolak)."],
      },
      "US-M3-03": {
        screen: "`/sopir` › *Selesai & bayar*",
        steps: [
          "Foto bukti kirim dari kamera aplikasi (wajib), nama & tanda tangan penerima, volume (beda → alasan); lokasi jauh dari alamat → alasan.",
          "*Kirim struk WA* (tautan) atau lewati beralasan.",
        ],
      },
      "US-M3-04": {
        screen: "`/sopir` › langkah Pembayaran",
        steps: [
          "Tunai pas, tunai kurang (alasan → faktur kurang bayar), transfer + foto bukti, tempo (pesanan tempo atau *Pelanggan minta tempo?* → Dispatcher menyetujui di Persetujuan ≤ 30 menit).",
        ],
      },
      "US-M3-05": {
        screen: "`/sopir` › rincian rit › *Terima pelunasan*",
        steps: ["Centang faktur (bawaan tertua), tunai/transfer, jumlah → simpan → kirim bukti pelunasan WA; kas di tangan bertambah untuk tunai."],
      },
      "US-M3-06": {
        screen: "`/sopir` › *Rit gagal* / *Kendala* / menu *Keterangan*; kantor: Kendala sopir (`/sopir-kantor/kendala`)",
        steps: [
          "Rit gagal: alasan + foto + tindak lanjut air; Dispatcher melihat di papan (perlu jadwal ulang).",
          "Kendala truk rusak → Dispatcher *Konfirmasi* + ubah truk ke Perbaikan; tugas keterangan perjalanan (BR-25) diisi sopir hari itu.",
        ],
      },
      "US-M3-07": {
        screen: "`/sopir` › *Setor*; kantor: Kas › Setoran",
        steps: [
          "Kas di tangan = tunai rit + pelunasan tunai − pengeluaran; semua rit selesai → *Setor Rp …* (ringkasan terkunci).",
          "Admin Keuangan menerima & menutup setoran; sopir melihat hasil & selisih di kartu *Setoran & ganti rugi saya*; rit besok terbuka setelah Ditutup.",
        ],
      },
      "US-M3-08": {
        screen: "`/sopir` › Setor › *Catat pengeluaran*",
        steps: ["BBM/tol/parkir: jumlah, foto nota wajib, sumber dana (kas di tangan/pribadi) → Admin Keuangan menerima/menolak saat menerima setoran."],
      },
      "US-M3-09": {
        screen: "`/sopir` (mode pesawat)",
        steps: [
          "Aktifkan mode pesawat: Berangkat–Tiba–Selesai–bayar–setor tetap jalan; status *Tersimpan di ponsel: N*.",
          "Matikan mode pesawat → *Semua terkirim* ≤ 5 menit tanpa dobel; kantor mengubah rit yang sudah dikerjakan offline → tampil *Konflik*, data lapangan tetap sah.",
        ],
      },
      "US-M3-10": {
        screen: "`/sopir` login PIN, *Ganti pengguna*; kantor: Akses › Perangkat",
        steps: [
          "Salah PIN 5× → terkunci 15 menit; layar terkunci setelah 10 menit diam; ganti pengguna tidak menghapus antrean sopir lain.",
          "Ponsel tidak terdaftar ditolak; admin sistem memblokir perangkat → permintaan berikutnya ditolak.",
        ],
      },
    },
    manual: [
      { ref: "B-19 / NFR-18", text: "Ukuran teks ≥ 16 pt & kontras terbaca di bawah sinar matahari langsung oleh sopir (tanpa kacamata baca)." },
      { ref: "B-19", text: "Kamera nyata ponsel truk: foto bukti kirim & nota ≤ PAR-38 (bawaan 150 KB, sisi 1.280 px) setelah kompresi, tetap terbaca." },
      { ref: "B-19 / NFR-06", text: "Rute Cianjur tanpa sinyal: satu hari penuh rit (≥ 24 jam mode pesawat untuk uji UI) → semua transaksi terkirim, jumlah & nilai = server." },
      { ref: "NFR-07", text: "Uji putus-sambung 50× (matikan/nyalakan data) → 0 transaksi hilang/dobel (cocokkan jumlah & nilai)." },
      { ref: "NFR-08", text: "Sopir baru dapat menyebutkan status item (tersimpan vs terkirim) tanpa dibantu." },
      { ref: "NFR-16", text: "Pelatihan ≤ 2 jam dengan panduan 1 halaman; alur rit ≤ 3 langkah." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------- M4
  {
    file: "m4-kas",
    module: "M4",
    title: "Kas & Setoran",
    prefix: "US-M4-",
    owner: "Admin Keuangan",
    scenario: "P-06; P-01 langkah 9; P-02 langkah 6",
    stories: "US-M4-01 s.d. US-M4-06",
    data: "18 sumber kas satu hari (7 sopir, 10 depot, toko); skenario selisih ≥ dan < ambang PAR-01",
    accounts: "Admin Keuangan (`keuangan1`), pemilik (`pemilik`), sopir/operator/kasir yang menyetor",
    guide: "docs/guides/m4-cash.md",
    setup: ["Satu hari operasi uji selesai (rit, shift depot & toko ditutup); rekening bank PT tercatat dengan akun buku sendiri."],
    steps: {
      "US-M4-01": {
        screen: "Kas & setoran › Kas hari ini (`/kas`)",
        steps: ["Periksa satu baris per sumber (seharusnya, status, diterima, selisih); QRIS/transfer terpisah; sorotan sopir belum setor > 1 jam, kas outlet > PAR-02."],
      },
      "US-M4-02": {
        screen: "Kas › Setoran (`/kas/setoran/[id]`)",
        steps: [
          "Terima setoran sopir: verifikasi pengeluaran, isi jumlah fisik (atau pecahan), selisih < ambang → alasan & tutup; selisih ≥ PAR-01 → diteruskan ke pemilik, setoran tetap Ditutup.",
          "Coba menerima setoran saat perangkat penyetor *Menunggu sinkron* atau setoran milik sendiri → ditolak.",
        ],
      },
      "US-M4-03": {
        screen: "Kas › Selisih (`/kas/selisih`), Kas › Ganti rugi",
        steps: [
          "Jelaskan selisih; pemilik *Setujui*/*Tolak* dari Kotak masuk (≤ 24 jam, KPI-03); selisih ditolak + ganti rugi aktif → ganti rugi karyawan tercatat.",
          "Catat pelunasan ganti rugi (setor tunai / potongan penggajian) dan unduh rekap bulanan penggajian.",
        ],
      },
      "US-M4-04": {
        screen: "Kas › Transfer masuk (`/kas/transfer`)",
        steps: [
          "Cocokkan manual satu transfer dengan mutasi internet banking; impor CSV/Excel mutasi → usulan pasangan → konfirmasi; impor ulang tidak menggandakan.",
          "Transfer tanpa mutasi > PAR-39 → *Tidak ditemukan* + piutang sementara M5.",
        ],
      },
      "US-M4-05": {
        screen: "Kas › Kas kantor & setor bank (`/kas/kantor`), Kas kecil (`/kas/kas-kecil`)",
        steps: [
          "Setor ke bank dengan foto slip; balik setor bank beralasan (> PAR-21 persetujuan pemilik).",
          "Kas kecil pengisian & pengeluaran (> PAR-43 menunggu pemilik); hitung fisik mingguan.",
        ],
      },
      "US-M4-06": {
        screen: "Kas › Tutup kas (`/kas/tutup`)",
        steps: [
          "*Mulai tutup kas* → selesaikan penghalang (setoran belum diterima, shift terbuka, rit berjalan); ajukan pengecualian setoran tertunda (PAR-89).",
          "Hitung fisik kas kantor → *Tutup kas* sebelum 22.00 → H+0 terbit ≤ 30 menit (cap waktu di Laporan › Hari ini).",
        ],
      },
    },
    manual: [
      { ref: "NFR-22", text: "Impor berkas mutasi dari bank yang dipakai PT (format asli CSV/Excel) berhasil dan usulan pasangan benar." },
      { ref: "D-12 butir 4 / B-79", text: "Setiap rekening bank punya akun buku sendiri (tidak ada penanda *Akun buku dipakai bersama* di Kas kantor)." },
      { ref: "NFR-04", text: "Pada hari uji, selisih waktu tutup kas → H+0 terbit ≤ 30 menit." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------- M5
  {
    file: "m5-piutang",
    module: "M5",
    title: "Piutang & Penagihan",
    prefix: "US-M5-",
    owner: "Admin Keuangan",
    scenario: "P-05",
    stories: "US-M5-01 s.d. US-M5-04, US-M5-06, US-M5-07 (M); US-M5-05 (S)",
    data: "Piutang berjalan nyata 15–30 pelanggan (faktur kertas terkonfirmasi untuk saldo awal)",
    accounts: "Admin Keuangan (`keuangan1`), pemilik (`pemilik`), sopir (pelunasan lapangan)",
    guide: "docs/guides/m5-receivables.md",
    setup: ["Rit tempo & kurang bayar dari UAT M3, penjualan tempo toko dari UAT M7; kunci Resend & domain terverifikasi untuk uji e-mail nyata (B-77)."],
    steps: {
      "US-M5-01": {
        screen: "Piutang › Faktur (`/piutang/faktur`), Kartu piutang (`/piutang/pelanggan/[id]`)",
        steps: ["Rit tempo/kurang bayar Selesai → faktur terbit otomatis (H+0); penjualan tempo toko → faktur saat tutup shift; saldo & eksposur tampil di kartu pelanggan M1 dan aplikasi sopir."],
      },
      "US-M5-02": {
        screen: "Piutang › Pelunasan (`/piutang/pelunasan`)",
        steps: [
          "Pelunasan tunai kantor & transfer (bukti wajib), alokasi otomatis ke faktur tertua; kelebihan → uang muka.",
          "*Balik pelunasan* beralasan; ubah alokasi per faktur.",
        ],
      },
      "US-M5-03": {
        screen: "Piutang › Status kredit (`/piutang/status-kredit`), Ringkasan piutang",
        steps: ["Faktur lewat tempo + PAR-09 → status Ditahan (evaluasi malam / *Hitung ulang Ditahan*); pesanan tempo ditolak; *Ajukan pembukaan* ke pemilik."],
      },
      "US-M5-04": {
        screen: "Piutang › Umur piutang (`/piutang/umur`)",
        steps: ["Umur per pelanggan/segmen/lini + KPI-04; ekspor meminta *Tujuan ekspor*; kartu piutang → *Kirim pernyataan piutang* (WA/e-mail)."],
      },
      "US-M5-05": {
        screen: "Piutang › Pengingat jatuh tempo (`/piutang/pengingat`)",
        steps: ["Daftar H-3/H+1 → *Buka WhatsApp* (template terisi) → status Dibuka; faktur bersengketa ditunda."],
      },
      "US-M5-06": {
        screen: "Piutang › Faktur bulanan (`/piutang/faktur-bulanan`)",
        steps: ["Pelanggan tagihan bulanan (perjanjian terunggah, disetujui pemilik) → faktur bulan lalu terbit tgl 1, jatuh tempo tgl 15 (PAR-12) → kirim WA/e-mail."],
      },
      "US-M5-07": {
        screen: "Piutang › Saldo awal piutang (`/piutang/saldo-awal`)",
        steps: [
          "Input saldo awal per faktur kertas terkonfirmasi + lampiran + lini asal; batalkan satu entri (nota kredit berjejak).",
          "Pemilik menandatangani; perubahan sesudahnya hanya *Ajukan koreksi*.",
        ],
      },
    },
    manual: [
      { ref: "B-77", text: "Kirim faktur & pernyataan piutang lewat e-mail dengan kunci Resend produksi dan domain pengirim **Verified**: e-mail diterima pelanggan uji dengan PDF terlampir, tercatat *terkirim*." },
      { ref: "B-77", text: "Setiap peran yang memiliki izin kirim faktur (`m5.invoice.send`) dapat mengirim pernyataan tanpa izin ekspor umur piutang (D-12 butir 2)." },
      { ref: "NFR-20", text: "Pengingat jatuh tempo lewat tautan WA dari ponsel kantor nyata." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------- M6
  {
    file: "m6-pos-depot",
    module: "M6",
    title: "Penjualan Depot (POS)",
    prefix: "US-M6-",
    owner: "Operator depot senior",
    scenario: "P-02",
    stories: "US-M6-01 s.d. US-M6-07",
    data: "Satu shift nyata di depot ramai dan depot sepi; tenant uji untuk isolasi (US-M6-07 KP-6)",
    accounts: "Operator depot (`depot01`) di tablet POS D01; Admin Keuangan; pemilik; admin sistem (tenant)",
    guide: "docs/guides/lapangan/operator-depot.md (1 halaman) · docs/guides/m6-pos.md",
    setup: ["Tablet POS depot diaktifkan; produk, harga, resep bahan, kas awal tetap outlet terisi; stok awal bahan & air depot ditandatangani."],
    steps: {
      "US-M6-01": {
        screen: "POS `/pos` › Jual",
        steps: ["Ketuk produk, atur jumlah, tunai (uang pas/kembalian) dan QRIS → struk tampil/cetak; harga dari kantor tidak dapat diketik."],
      },
      "US-M6-02": {
        screen: "POS › Buka shift / Shift & void › Tutup shift / Riwayat › Setoran shift",
        steps: [
          "Buka shift dengan hitung kas awal & stok awal; tutup shift: kas fisik & stok fisik (beda → alasan).",
          "*Tandai sudah disetor* (serah fisik / setor bank + foto slip) → Admin Keuangan menerima (status Diterima).",
        ],
      },
      "US-M6-03": {
        screen: "POS › Shift & void › *Void…*; kantor: Persetujuan",
        steps: ["Void beralasan; void > PAR-04 menunggu pemilik (transaksi tetap dihitung); > PAR-03 void/hari → notifikasi Admin Keuangan; *Buat transaksi pengganti*."],
      },
      "US-M6-04": {
        screen: "POS › Stok bahan; kantor: Pemantauan outlet",
        steps: ["Pemakaian bahan otomatis per resep; terima transfer dari toko & bahan pemasok lain (foto nota); *Opname mingguan* → selisih diajukan ke pemilik."],
      },
      "US-M6-05": {
        screen: "POS › Pasokan air; kantor: Laporan outlet › neraca air",
        steps: ["Truk internal Tiba → *Sesuai, terima* / *Volume berbeda* (alasan); pasokan darurat sumber lain; neraca air mingguan (galon × ukuran vs air diterima, toleransi PAR-59)."],
      },
      "US-M6-06": {
        screen: "POS (mode pesawat)",
        steps: ["Satu shift penuh tanpa sinyal: jual, void, tutup shift → nomor lokal; sambung → nomor resmi `{kode}-YYMMDD-NNNN`, *Semua terkirim*, tanpa dobel."],
      },
      "US-M6-07": {
        screen: "Depot & toko › Tenant & paket POS (`/outlet/tenant`)",
        steps: [
          "Admin sistem membuat tenant uji + depot pertama (katalog standar tersalin); tablet & akun operator tenant uji.",
          "Operator tenant uji tidak melihat data EQUA dan sebaliknya (KP-6); laporan tenant terpisah.",
        ],
      },
    },
    manual: [
      { ref: "B-14", text: "Transaksi POS ≤ 10 detik (US-M6-01 KP-3): stopwatch 20 transaksi di depot ramai oleh operator senior." },
      { ref: "B-19 / NFR-06", text: "POS depot tanpa sinyal satu hari penuh di depot nyata; semua data terkirim saat sinyal kembali." },
      { ref: "NFR-03", text: "Aksi POS ≤ 1 detik di tablet kelas menengah-bawah (20 aksi)." },
      { ref: "NFR-25 (C)", text: "Printer bluetooth tidak dibangun (D-02); struk dicetak lewat dialog cetak peramban bila printer tersedia." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------- M7
  {
    file: "m7-toko",
    module: "M7",
    title: "Penjualan Toko & Stok",
    prefix: "US-M7-",
    owner: "Kasir",
    scenario: "P-03",
    stories: "US-M7-01 s.d. US-M7-06, US-M7-09 (M); US-M7-08 (S); US-M7-07 (S, RL-6)",
    data: "Opname fisik cut-over toko; nota pemasok nyata; pelanggan mitra toko tempo",
    accounts: "Kasir (`kasir`) di tablet POS toko TK1; Admin Keuangan; pemilik",
    guide: "docs/guides/lapangan/kasir-toko.md (1 halaman) · docs/guides/m7-store.md",
    setup: ["Tablet toko diaktifkan (mode toko otomatis); barang, harga umum & mitra, stok minimum, pemasok terisi; stok awal cut-over ditandatangani."],
    steps: {
      "US-M7-01": {
        screen: "POS toko `/pos` › Jual",
        steps: ["Pelanggan umum vs mitra toko (harga mitra otomatis); cari/pindai barang; diskon > batas → menunggu pemilik (barang belum diserahkan)."],
      },
      "US-M7-02": {
        screen: "POS › Terima barang; kantor: Toko › Penerimaan barang",
        steps: ["Nota pemasok (foto wajib, total = nota) → stok & utang bertambah; nota ganda ditolak; nota pengganti menunggu Admin Keuangan; kartu stok per barang."],
      },
      "US-M7-03": {
        screen: "POS › Stok & opname › Pesan ulang; kantor: Toko › Pesan ulang",
        steps: ["Barang ≤ stok minimum masuk daftar pesan ulang → *Sudah dipesan* → selesai sendiri saat barang diterima."],
      },
      "US-M7-04": {
        screen: "POS › Jual › Tempo mitra",
        steps: ["Mitra berstatus Tempo dalam batas → tempo; melewati batas/Ditahan → tunai/QRIS atau ajukan persetujuan pemilik; faktur M5 terbit."],
      },
      "US-M7-05": {
        screen: "POS › Stok & opname › Opname; kantor: Toko › Opname",
        steps: ["Opname bulanan bersama Admin Keuangan (jumlah sistem tersembunyi) → alasan selisih → diajukan → pemilik menyetujui penyesuaian."],
      },
      "US-M7-06": {
        screen: "POS › Stok & opname › Transfer ke depot; POS depot › Stok bahan",
        steps: ["Kirim tutup/tisu/galon ke depot EQUA (bukan penjualan) → depot menerima (beda → alasan); jurnal harga mitra, markup dieliminasi pada konsolidasi."],
      },
      "US-M7-07": {
        screen: "Toko › Laporan toko (`/toko/laporan`)",
        steps: ["Barang laris/mati (PAR-66) & margin per barang per bulan; ekspor Excel/PDF (RL-6)."],
      },
      "US-M7-08": {
        screen: "Toko › Utang pemasok (`/toko/utang`)",
        steps: ["Umur utang per pemasok; *Catat pembayaran* (kas kantor/transfer + bukti) teralokasi per nota; *Balik pembayaran* beralasan."],
      },
      "US-M7-09": {
        screen: "POS › Shift & kas; kantor: Kas › Tutup kas",
        steps: ["Tutup shift toko (QRIS & tempo tidak masuk laci) → setor → Admin Keuangan menerima; kas kantor tidak dapat ditutup sebelum shift toko ditutup."],
      },
    },
    manual: [
      { ref: "UAT", text: "Pindai barcode dengan kamera tablet toko nyata (tombol *Pindai*)." },
      { ref: "B-14", text: "Transaksi toko 5 barang ≤ 30 detik di jam ramai (catat waktu)." },
      { ref: "BR-27", text: "Opname fisik cut-over menghitung seluruh barang toko (tidak hanya sampel)." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------- M8
  {
    file: "m8-produksi",
    module: "M8",
    title: "Produksi & Stok Air",
    prefix: "US-M8-",
    owner: "Operator produksi",
    scenario: "P-04",
    stories: "US-M8-01 s.d. US-M8-04, US-M8-07 (M); US-M8-05, US-M8-06 (S)",
    data: "Dua sumber air, satu hari penuh angka meter & pengisian truk (termasuk pasokan depot)",
    accounts: "Operator produksi (`produksi1` SA1, `produksi4` SA2) di ponsel sumber; pemilik; Admin Keuangan",
    guide: "docs/guides/lapangan/operator-produksi.md (1 halaman) · docs/guides/m8-production.md",
    setup: ["Ponsel sumber diaktifkan; meter dengan angka awal berfoto (M1); jadwal pengisian truk hari itu terbit."],
    steps: {
      "US-M8-01": {
        screen: "Aplikasi produksi `/produksi` › Catat meter",
        steps: ["Angka meter pagi & malam + foto wajib; angka lebih kecil ditolak; lewat 08.00/23.00 → alasan terlambat; koreksi berfoto oleh Admin Keuangan."],
      },
      "US-M8-02": {
        screen: "`/produksi` › Isi truk",
        steps: ["Truk terjadwal paling atas → volume (beda → alasan, *Sisa muatan*) → rit tujuan; truk lain / tanpa rit ditandai ke kantor; geofence armada memverifikasi."],
      },
      "US-M8-03": {
        screen: "`/produksi` › Isi truk (rit internal); kantor: Produksi › Pengisian & pasokan",
        steps: ["Pengisian untuk pasokan depot → depot mengonfirmasi di POS; selisih > PAR-69 ditandai; stok awal air depot (cut-over) di tab *Stok awal depot*."],
      },
      "US-M8-04": {
        screen: "Produksi air › Neraca air (`/produksi/neraca-air`, rincian)",
        steps: ["Neraca per sumber per hari (produksi vs pengisian vs pasokan vs kembali); susut > batas → operator mengisi penjelasan + foto → pemilik *Terima* / *Kembalikan*."],
      },
      "US-M8-05": {
        screen: "Produksi air › Utilisasi kapasitas (`/produksi/utilisasi`)",
        steps: ["Utilisasi harian, hari > PAR-19, ruang tumbuh; notifikasi push setelah PAR-85 hari berturut."],
      },
      "US-M8-06": {
        screen: "`/produksi` › Hasil uji mutu; kantor: Produksi air › Mutu air",
        steps: ["Catat hasil lab + foto sertifikat; tidak lulus → tindakan, penanggung jawab, tenggat; pengingat jadwal uji."],
      },
      "US-M8-07": {
        screen: "`/produksi` (mode pesawat)",
        steps: ["Satu hari meter & pengisian tanpa sinyal → terkirim saat sinyal kembali tanpa dobel; *Bantuan → Kirim sekarang*."],
      },
    },
    manual: [
      { ref: "B-19", text: "Foto meter dengan kamera ponsel sumber nyata terbaca (angka jelas) setelah kompresi." },
      { ref: "NFR-06", text: "Sumber air tanpa sinyal satu hari penuh; data terkirim utuh." },
      { ref: "B-45", text: "Penanda geofence armada (pengisian tanpa truk di sumber, truk di sumber tanpa pengisian) tampil di rincian neraca dengan truk GPS nyata." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------- M9
  {
    file: "m9-laporan",
    module: "M9",
    title: "Laporan & Dashboard Pemilik",
    prefix: "US-M9-",
    owner: "Pemilik",
    scenario: "P-06 langkah 4; katalog laporan PRD 7.9.4",
    stories: "US-M9-01 s.d. US-M9-03 (M); US-M9-04, US-M9-05 (S); US-M9-06, US-M9-07 (S, RL-6)",
    data: "H+0 dari hari pilot; laporan bulanan sementara; lembar pencocokan periode paralel",
    accounts: "Pemilik (`pemilik`) di ponsel & laptop; Admin Keuangan; akuntan; Dispatcher",
    guide: "docs/guides/m9-reports.md",
    setup: ["Minimal satu hari kas ditutup (UAT M4) dan satu bulan data uji untuk laporan bulanan sementara."],
    steps: {
      "US-M9-01": {
        screen: "Laporan › Hari ini (H+0) (`/laporan/hari-ini`), Beranda",
        steps: [
          "Sebelum tutup kas: *Belum ditutup — angka dapat berubah*; setelah tutup kas: *H+0 terbit* terkunci dengan cap waktu ≤ 30 menit + notifikasi.",
          "Ketuk angka → rincian; *Setujui/Tolak* selisih dari blok Pengecualian; transaksi terlambat sinkron tampil sebagai catatan tambahan (angka terbit tidak berubah).",
        ],
      },
      "US-M9-02": {
        screen: "Laporan › Laba kotor bulanan (`/laporan/bulanan`)",
        steps: ["Per lini L1–L5 + eliminasi + konsolidasi; status Sementara → Final setelah periode dikunci; ketuk lini → akun → jurnal → transaksi sumber; unduh Final identik."],
      },
      "US-M9-03": {
        screen: "Laporan › Katalog laporan (`/laporan/katalog`)",
        steps: ["Ekspor setiap laporan katalog ke Excel & PDF; laporan berdata pribadi meminta *Tujuan ekspor* dan tercatat (BR-39); Dispatcher tanpa WA/alamat lengkap."],
      },
      "US-M9-04": {
        screen: "Kotak masuk (`/kotak-masuk`), Pengaturan notifikasi",
        steps: ["Setujui/Tolak/Minta keterangan langsung dari daftar; butir lewat tenggat di atas; atur seketika/ringkasan/mati & jam tenang (kritis tetap seketika); ringkasan e-mail 22.30."],
      },
      "US-M9-05": {
        screen: "Laporan › Kinerja sopir & depot (`/laporan/kinerja`)",
        steps: ["Tab sopir & truk (tepat waktu, penyimpangan lokasi, selisih, hari tanpa selisih) dan depot/operator; peringkat antar peran sebanding."],
      },
      "US-M9-06": {
        screen: "Laporan › Tren (`/laporan/tren`)",
        steps: ["Mingguan & bulanan 13 periode: omzet per lini, rit, galon, piutang; ekspor (RL-6)."],
      },
      "US-M9-07": {
        screen: "Laporan › KPI program (`/laporan/kpi`), Periode paralel (`/laporan/periode-paralel`)",
        steps: ["KPI-01–KPI-11 dengan status & riwayat; isi KPI-10 jam/minggu; PDF komite pengarah (RL-6)."],
      },
    },
    manual: [
      { ref: "NFR-19", text: "Pemilik membaca H+0 dan menyetujui satu selisih dari ponsel (lebar layar ponsel, tanpa geser horizontal)." },
      { ref: "NFR-23", text: "Setiap laporan di katalog 7.9.4 berhasil diekspor Excel & PDF (centang per laporan)." },
      { ref: "NFR-04 / KPI-08", text: "Pilot: 14 dari 14 hari H+0 terbit ≤ 30 menit setelah tutup kas (lihat docs/uat/pilot.md)." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------ M10
  {
    file: "m10-akses",
    module: "M10",
    title: "Pengguna, Hak Akses & Jejak Audit",
    prefix: "US-M10-",
    owner: "Pemilik (bersama admin sistem)",
    scenario: "Matriks peran × tindakan; BR-36 s.d. BR-39",
    stories: "US-M10-01 s.d. US-M10-07",
    data: "Setiap peran mencoba tindakan terlarang; perangkat hilang disimulasikan; satu pelanggan uji dianonimkan",
    accounts: "Semua peran (satu akun per peran); dua admin sistem (`admin1`, `admin2`)",
    guide: "docs/guides/m10-access.md · docs/ops/runbook.md",
    setup: ["Matriks peran diekspor (Akses › Peran & matriks) dan disahkan pemilik sebagai acuan uji."],
    steps: {
      "US-M10-01": {
        screen: "Akses › Pengguna (`/akses/pengguna`), Persetujuan",
        steps: [
          "Admin sistem membuat akun dari karyawan (satu peran + lingkup) → aktif setelah pemilik menyetujui; akun awal go-live lewat daftar bertanda tangan.",
          "Cabut peran/kurangi lingkup/nonaktifkan → seketika (sesi dicabut, perangkat diblokir); tanggal keluar → nonaktif otomatis; tinjauan hak akses kuartalan.",
        ],
      },
      "US-M10-02": {
        screen: "`/masuk`, `/masuk/2fa`, `/aktivasi-perangkat`, Akses › Perangkat",
        steps: [
          "Login kata sandi + 2FA (pemilik, Admin Keuangan, admin sistem); sesi kedaluwarsa 30 menit diam / 12 jam (PAR-46).",
          "Daftarkan perangkat → kode aktivasi (24 jam) → PIN; login PIN offline; 5× salah → kunci 15 menit.",
        ],
      },
      "US-M10-03": {
        screen: "Akses › Peran & matriks (`/akses/peran`)",
        steps: ["Uji aturan tetap: pemohon ≠ penyetuju, penyetor ≠ penerima setoran, pemilik tidak menginput transaksi harian; ajukan kombinasi peran terlarang → tidak dapat diajukan; > 3 penolakan/hari → notifikasi pemilik."],
      },
      "US-M10-04": {
        screen: "Persetujuan (`/persetujuan`)",
        steps: ["Tabel aturan 6.2a (pemohon, penyetuju, ambang parameter, tenggat, perlakuan lewat tenggat); setujui satu ketuk dari tautan push; tolak wajib alasan."],
      },
      "US-M10-05": {
        screen: "Jejak audit (`/audit`, tab Log akses)",
        steps: ["Cari per objek/pengguna/tanggal/tindakan; kalimat bahasa lapangan; *Verifikasi keutuhan* rantai hash; percobaan ubah/hapus lewat aplikasi/API/DB gagal (EQ001/EQ002)."],
      },
      "US-M10-06": {
        screen: "Akses › Data pribadi (`/akses/data-pribadi`)",
        steps: [
          "Anonimkan satu pelanggan uji (persetujuan pemilik; ditunda bila piutang terbuka) → identitas hilang, catatan keuangan tetap; jejak audit menyamarkan PII bagi selain pemilik.",
          "Catat cadangan harian/bulanan & uji pemulihan (RPO/RTO); retensi berjalan (log akses 1 tahun, GPS 12 bulan).",
        ],
      },
      "US-M10-07": {
        screen: "Akses › Perangkat & sinkron (`/akses/sinkron`), Bantuan (`/bantuan`)",
        steps: [
          "Antrean per perangkat, konflik, insiden (tanggap/pulih), uptime bulanan; tetapkan versi minimal → perangkat lama diminta memperbarui (antrean tertahan, tidak hilang).",
          "Laporan kendala dari perangkat → jawab di helpdesk → pelapor *Tandai selesai*.",
        ],
      },
    },
    manual: [
      { ref: "NFR-09", text: "Setiap peran mencoba minimal 3 tindakan terlarang (termasuk lewat URL langsung) → ditolak dan tercatat di Log akses." },
      { ref: "US-M10-02", text: "Simulasi perangkat hilang: blokir + hapus data jarak jauh di perangkat nyata; perangkat cadangan diaktifkan ≤ 30 menit." },
      { ref: "NFR-13", text: "Uji pemulihan cadangan sekali sebelum go-live (runbook §4), RPO & RTO dicatat di sistem." },
      { ref: "NFR-12", text: "Anonimisasi satu pelanggan uji: identitas hilang, faktur & jurnal tetap." },
      { ref: "NFR-28 / B-85", text: "Simulasi tiga kondisi (layanan mati, sinkron gagal massal, GPS mati) memicu peringatan ke tim IT ≤ 5 menit; secret repositori pemantau terisi." },
      { ref: "NFR-30", text: "Tenant uji tidak melihat data EQUA dan sebaliknya (lihat juga RL-7 B-74)." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------ M11
  {
    file: "m11-akuntansi",
    module: "M11",
    title: "Akuntansi & Pajak",
    prefix: "US-M11-",
    owner: "Admin Keuangan (bersama akuntan)",
    scenario: "P-07",
    stories: "US-M11-01 s.d. US-M11-06, US-M11-08 s.d. US-M11-10 (M); US-M11-07 (S)",
    data: "Jurnal otomatis dari data pilot; saldo awal draf; tutup periode uji; daftar aset dari akuntan & notaris",
    accounts: "Admin Keuangan (`keuangan1`), pemilik (`pemilik`), akuntan (`akuntan`, baca-saja)",
    guide: "docs/guides/m11-accounting.md",
    setup: [
      "Bagan akun & pemetaan bawaan (seed produksi) ditinjau akuntan; pemilik menekan *Aktifkan M11* setelah tinjauan (B-84).",
      "Periode uji terbuka; tanggal cut-over ditetapkan pemilik (tanggal 1).",
    ],
    steps: {
      "US-M11-01": {
        screen: "Akuntansi › Bagan akun (`/akuntansi/akun`), Pemetaan jurnal otomatis (`/akuntansi/pemetaan`)",
        steps: ["Tinjau akun per pusat laba L1–L5/Umum; lengkapi pemetaan wajib; *Aktifkan M11* ditolak bila ada yang belum lengkap."],
      },
      "US-M11-02": {
        screen: "Akuntansi › Jurnal (`/akuntansi/jurnal`, *Daftar tunggu*, *Rekonsiliasi harian*)",
        steps: ["Transaksi pilot (rit, POS, setoran, pembelian) → jurnal otomatis tertaut sumber (*Lihat jurnal* dari rincian transaksi); daftar tunggu kosong; rekonsiliasi harian = H+0."],
      },
      "US-M11-03": {
        screen: "Akuntansi › Jurnal › Jurnal manual baru",
        steps: ["Jurnal ≤ Rp 5 juta berlampiran → terposting + daftar tinjauan pemilik; > Rp 5 juta → persetujuan; akrual dibalik otomatis; *Balik jurnal* beralasan."],
      },
      "US-M11-04": {
        screen: "Akuntansi › Buku besar, Laporan keuangan (`/akuntansi/laporan`)",
        steps: ["Laba rugi per lini (alokasi L1 & biaya bersama terpisah, eliminasi internal), neraca, arus kas; telusur akun → jurnal → transaksi; ekspor."],
      },
      "US-M11-05": {
        screen: "Akuntansi › Aset tetap (`/akuntansi/aset`)",
        steps: ["Impor daftar aset → pemilik menandatangani → penyusutan otomatis tgl 1; ubah umur → jurnal penyesuaian; lepas aset → laba/rugi pelepasan."],
      },
      "US-M11-06": {
        screen: "Akuntansi › Rekonsiliasi bank & kas (`/akuntansi/rekonsiliasi`)",
        steps: ["Isi saldo rekening koran per rekening (akun buku sendiri per rekening); item pencocokan terisi otomatis; selisih kas beralasan."],
      },
      "US-M11-07": {
        screen: "Akuntansi › Utang usaha (`/akuntansi/utang`)",
        steps: ["Utang pemasok toko (M7) & utang manual; jatuh tempo; pembayaran jurnal *membayar utang*."],
      },
      "US-M11-08": {
        screen: "Akuntansi › Pajak (`/akuntansi/pajak`)",
        steps: ["Omzet bruto bulanan per lini (internal dikecualikan), estimasi PPh final, pemantauan PKP 12 bulan (sama dengan dasbor M9); ekspor format konsultan."],
      },
      "US-M11-09": {
        screen: "Akuntansi › Saldo awal (`/akuntansi/saldo-awal`)",
        steps: ["Tetapkan cut-over (tanggal 1); isi tiap kelompok → pemilik menandatangani → akuntan mengesahkan → posting; jurnal sebelum cut-over ditolak (EQ006) kecuali saldo awal."],
      },
      "US-M11-10": {
        screen: "Akuntansi › Periode (`/akuntansi/periode/[id]`)",
        steps: ["Prasyarat tutup (hari kas ditutup, rekonsiliasi, daftar tunggu, penyusutan, tinjauan) → *Tutup periode* → pemilik *Kunci*; posting ke periode terkunci ditolak; buka kembali beralasan → revisi."],
      },
    },
    manual: [
      { ref: "B-57", text: "Akuntan meninjau kategori arus kas metode langsung (heuristik nama/induk akun lawan) terhadap bagan akun final." },
      { ref: "B-76", text: "Akuntan meninjau alokasi biaya L1 → L3 per outlet (volume pasokan) dan eliminasi markup transfer internal toko → depot (rata-rata tertimbang)." },
      { ref: "NFR-23", text: "Konsultan pajak memvalidasi format ekspor jurnal/buku besar (template dapat diubah tanpa rilis)." },
      { ref: "B-84 / D-13 butir 3", text: "Berita acara tinjauan pemetaan oleh akuntan ditandatangani sebelum pemilik menekan *Aktifkan M11*." },
      { ref: "NFR-36", text: "Transaksi bertanggal sebelum cut-over ditolak; jurnal saldo awal diterima." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------ M12
  {
    file: "m12-armada",
    module: "M12",
    title: "Pelacakan Armada / GPS",
    prefix: "US-M12-",
    owner: "Dispatcher",
    scenario: "P-01 langkah 5–8; BR-23, BR-25",
    stories: "US-M12-01 s.d. US-M12-05, US-M12-08 KP-1–2 (M); US-M12-06, US-M12-08 KP-3–4 (S); US-M12-07 (S, RL-6)",
    data: "Truk pilot dengan perangkat GPS nyata; skenario perjalanan di luar jadwal dan perangkat dicabut",
    accounts: "Dispatcher (`dispatcher1`), pemilik, admin sistem, sopir truk pilot",
    guide: "docs/guides/m12-fleet.md",
    setup: ["Perangkat GPS terpasang & terdaftar (IMEI) di truk pilot; vendor mengirim ke `/api/gps/ingest/<vendor>` dengan `GPS_INGEST_TOKEN`."],
    steps: {
      "US-M12-01": {
        screen: "Armada › Perangkat GPS (`/armada/perangkat`)",
        steps: ["Posisi masuk ≤ 1 menit (PAR-26); pengiriman ulang vendor tidak dobel; GPS mati → aplikasi sopir mengirim GPS ponsel selama rit (penanda *GPS ponsel aktif*)."],
      },
      "US-M12-02": {
        screen: "Armada › Peta truk (`/armada/peta`), peta di Papan jadwal",
        steps: ["Status per truk, umur posisi (basi > PAR-48), klik truk → rit, perkiraan tiba, telepon/WA sopir; lapisan alamat/sumber/depot/zona."],
      },
      "US-M12-03": {
        screen: "Armada › Riwayat perjalanan (`/armada/riwayat`)",
        steps: ["Per truk per hari (jarak, berhenti ≥ PAR-49, KPI-07) dan per rit (jejak, bukti kirim); putar ulang 24 jam; ekspor ringkasan."],
      },
      "US-M12-04": {
        screen: "Armada › Kejadian armada (`/armada/kejadian`)",
        steps: ["Selesai > 200 m / > 1 km dari alamat → tingkat penyimpangan; titik ponsel vs GPS truk tidak konsisten; pemilik *Terima alasan* / *Minta keterangan sopir*."],
      },
      "US-M12-05": {
        screen: "Armada › Kejadian armada; aplikasi sopir › Keterangan",
        steps: ["Gerak tanpa rit Berangkat / di luar jam PAR-07 / berhenti tidak dikenal > PAR-51 → kejadian + tugas keterangan sopir (BR-25); tanpa keterangan saat tutup kas → kotak masuk pemilik."],
      },
      "US-M12-06": {
        screen: "Produksi air › Neraca air (rincian), Armada › Kejadian",
        steps: ["Pengisian dengan truk di geofence sumber → *Terverifikasi geofence*; pengisian tanpa geofence / truk lama di sumber tanpa pengisian / pasokan depot tanpa masuk depot → penanda."],
      },
      "US-M12-07": {
        screen: "Armada › BBM & zona (`/armada/bbm`)",
        steps: ["Isi PAR-53 → estimasi BBM per rit vs BBM nyata bulanan; pemeriksaan zona dari jarak GPS 3 rit terakhir (RL-6)."],
      },
      "US-M12-08": {
        screen: "Armada › Perangkat GPS, Akses › Perangkat › rincian (kartu GPS)",
        steps: ["Cabut perangkat → status *Dicabut*, tim IT & Dispatcher diberi tahu ≤ PAR-25; mati > 15 menit di jam layanan → insiden; pola per truk 30 hari."],
      },
    },
    manual: [
      { ref: "B-47", text: "Uji 1 unit perangkat GPS nyata (R05, US-M12-01 KP-3): posisi, daya, versi, IMEI dikenali." },
      { ref: "B-47", text: "Skenario perangkat dicabut di truk pilot: peringatan terkirim, GPS ponsel cadangan aktif, kejadian berulang dilaporkan ke pemilik." },
      { ref: "NFR-24", text: "Cadangan tanpa peta komersial: garis lurus × 1,3 dipakai untuk jarak/zona (D-10 butir 4), biaya peta = 0." },
      { ref: "NFR-21", text: "Simulasi penghubung vendor kedua (format OsmAnd/Traccar) dengan format internal tetap." },
    ],
  },
  // ------------------------------------------------------------------------------------------------------------ RL-7
  {
    file: "rl7-mitra",
    module: "P3",
    title: "Paket Minimum Mitra Fase 1 (RL-7)",
    prefix: "US-P3-",
    only: ["US-P3-08", "US-P3-09", "US-P3-10", "US-P3-11"],
    owner: "Pemilik (bersama Admin Keuangan)",
    scenario: "BRD 9.9; P-01 untuk pesanan air mitra",
    stories: "US-P3-08 s.d. US-P3-10 (M); US-P3-11 (S)",
    data: "Tenant uji dan mitra pertama (termasuk skenario mitra dua outlet PRD 9.7); satu bulan tagihan langganan",
    accounts: "Admin sistem, Admin Keuangan, pemilik EQUA, pembina wilayah (`pembina1`), pemilik mitra (`mitra1`, portal `/mitra`), operator POS mitra (`opmitra1`)",
    guide: "docs/guides/p3-partner.md",
    setup: [
      "Syarat masuk Bab 9.10: TG-8, studi K22, PT berdiri, perjanjian Opsi B, M6 ≥ 3 bulan, uji isolasi & penetrasi tenant (B-74).",
      "Tenant mitra dibuat (Depot & toko › Tenant & paket POS); satu pelanggan mitra per outlet; kontrak per outlet disetujui pemilik (D-13 butir 1).",
    ],
    steps: {
      "US-P3-08": {
        screen: "Kemitraan › Pasokan & neraca mitra (`/kemitraan/pasokan`); POS mitra › Pasokan air",
        steps: [
          "Pesan air untuk pelanggan mitra (M2) → rit Selesai → pasokan *Tiba* di POS mitra → operator mitra mengonfirmasi (beda → alasan, Dispatcher diberi tahu).",
          "Neraca air per mitra per bulan; kelebihan > PAR-79 → notifikasi pemilik; pesanan air mitra lewat PAR-76 ditandai.",
        ],
      },
      "US-P3-09": {
        screen: "Kemitraan › Kontrak mitra (`/kemitraan/kontrak`), Tagihan langganan (`/kemitraan/langganan`); Piutang",
        steps: [
          "Admin Keuangan input kontrak per outlet → pemilik menyetujui; tgl 1: faktur langganan = outlet aktif × tarif (per outlet untuk mitra dua outlet), jatuh tempo PAR-12.",
          "Pelunasan & umur piutang di M5 (lini Kemitraan); jurnal pendapatan L5 pada bulan layanan; perubahan tarif berlaku bulan berikutnya.",
        ],
      },
      "US-P3-10": {
        screen: "Portal pemilik mitra `/mitra` (beranda, penjualan, pasokan, tagihan, laporan bulanan)",
        steps: [
          "Pemilik mitra login portal (akun mitra tidak dapat membuka web kantor) → data hanya tenantnya; angka penjualan = laporan EQUA.",
          "Laporan bulanan terbit tgl 5 (PDF, tidak berubah setelah terbit); coba buka faktur/outlet tenant lain → ditolak & tercatat.",
        ],
      },
      "US-P3-11": {
        screen: "Portal › Dukungan teknis; kantor: Kemitraan › Dukungan teknis (`/kemitraan/dukungan`)",
        steps: ["Mitra mengirim permintaan + foto → pembina menanggapi ≤ 48 jam → Selesai; SLA terlewat → notifikasi; kepatuhan SLA di laporan bulanan."],
      },
    },
    manual: [
      { ref: "B-74 / PRD 9.6", text: "Uji penetrasi lintas tenant MANUAL sebelum mitra pertama aktif (URL langsung, ID objek tenant lain, ekspor, lampiran) melengkapi uji otomatis `tests/p3-partner/portal.test.ts`." },
      { ref: "PRD 9.7 / D-13 butir 1", text: "Mitra dua outlet: dua pelanggan mitra + dua kontrak (satu per outlet), wilayah eksklusif per outlet, dua faktur langganan (uji otomatis `tests/p3-partner/two-outlets.test.ts`); batas kredit bersama & faktur gabungan TIDAK dibangun." },
      { ref: "B-74 / NFR-03", text: "Portal mitra dibuka dari ponsel pemilik mitra di jaringan 4G ≤ 2 detik per layar." },
    ],
  },
];
