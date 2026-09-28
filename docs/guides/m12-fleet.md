# Panduan Pelacakan Armada / GPS (M12)

Menu web kantor **Armada**: **Peta truk**, **Riwayat perjalanan**, **Kejadian armada**, **Perangkat GPS**, **BBM & zona**.
Posisi truk masuk sendiri dari perangkat GPS yang terpasang di truk; bila perangkat mati atau dicabut, GPS ponsel sopir
mengambil alih. Hanya **pemilik** dan **Dispatcher** yang melihat posisi truk (sopir tidak melihat truk lain).

## Sopir & kernet (ringkas)

- **Tidak ada tombol baru.** Berangkat, Tiba, Selesai tetap seperti biasa; lokasi tombol dicatat otomatis sebagai titik
  status. Selesai jauh dari alamat pelanggan (> 200 m) → pilih alasan; sistem menghitung ulang jaraknya di kantor.
- **Keterangan perjalanan (BR-25).** Bila truk bergerak tanpa rit Berangkat, bergerak di luar jam 05.00–22.00, atau
  berhenti lama (> 15 menit) di tempat yang bukan alamat rit/sumber/depot/pool, aplikasi menampilkan tugas di menu
  **Keterangan**. Isi hari itu juga (mis. "ke tambal ban, izin Dispatcher"). Keterangan yang tidak diisi sampai kas ditutup
  masuk ke kotak masuk pemilik.
- **GPS ponsel cadangan.** Bila perangkat GPS truk mati/dicabut, aplikasi sopir otomatis mengirim lokasi ponsel selama
  rit berjalan (penanda "GPS ponsel aktif"). Biarkan lokasi ponsel menyala. Otomatis berhenti saat perangkat aktif lagi.
- **Jangan mencabut perangkat GPS.** Pencabutan tercatat (status **Dicabut**), tim IT & Dispatcher langsung diberi tahu,
  dan kejadian berulang dilaporkan ke pemilik.

## Dispatcher — Peta truk

1. Buka **Armada → Peta truk** (juga tampil di bawah **Papan jadwal** hari ini). Peta diperbarui sendiri tiap menit.
2. Daftar di kanan: nomor truk, status (Rit aktif ke pelanggan X / Menuju sumber / Di sumber / Di depot / Di pool /
   Berhenti / Di luar jadwal / Perbaikan / Tanpa posisi), sopir hari itu, kecepatan, umur posisi. **Basi** = posisi lebih
   tua dari 5 menit (PAR-48) — sinyal lemah atau perangkat bermasalah.
3. Klik truk (di peta atau daftar) → rit hari ini & statusnya, rit berikutnya, **perkiraan jarak & waktu tiba**, tombol
   **Telepon/WA sopir**, **Riwayat hari ini**, **Putar ulang 24 jam**. Pakai untuk menjawab pelanggan "truknya di mana".
4. Lapisan: centang/hapus **Alamat rit hari ini, Sumber air, Depot, Pool, Zona tarif (perkiraan)**. **Tampilkan semua
   truk** memusatkan ulang peta.

## Pemilik & Dispatcher — Riwayat perjalanan

- **Per truk per hari**: jarak total, waktu bergerak/berhenti, gerak pertama–terakhir, rit Selesai vs terjadwal (KPI-07),
  jarak antar-rit (kembali ke sumber), menit GPS mati. Klik truk → peta jejak, titik berhenti ≥ 5 menit, kejadian, putar
  ulang.
- **Per rit**: jejak Berangkat → Selesai/Gagal, jarak, durasi, titik berhenti, lama di pelanggan, foto bukti kirim, tanda
  tangan, pengisian di sumber. Label **estimasi** = hanya titik status ponsel (jarak dari rute peta, bukan jejak).
- Ekspor: **PDF/Excel ringkasan rit**, **Excel titik berhenti**, ringkasan truk per hari. Posisi mentah tidak diekspor.

## Pemilik — Kejadian armada & tinjauan

- Tab **Tinjauan pemilik**: penyimpangan lokasi Selesai > 1 km, sumber lokasi tidak konsisten (titik Selesai ponsel beda
  > 200 m dari posisi GPS truk), perjalanan di luar jadwal/jam, berhenti tidak dikenal, penanda geofence (pengisian tanpa
  truk di sumber, truk lama di sumber tanpa pengisian, pasokan depot tanpa masuk depot).
- Buka **Rincian & peta** → lihat titik kejadian, tujuan, posisi perangkat, keterangan sopir → pilih:
  **Terima alasan** (Selesai), **Minta keterangan sopir** (tugas muncul di aplikasi sopir hari itu; Dispatcher juga
  boleh), atau **Tandai tindak lanjut** (di luar sistem) lalu **Tandai Selesai** dengan hasilnya. Semua keputusan berjejak;
  kejadian tidak pernah dihapus.
- Tab **Ringkasan H+0**: kejadian tanpa keterangan saat kas ditutup, penyimpangan tingkat 2, perangkat mati > 2 jam.
  Tab **Pola berulang**: penyimpangan per sopir & per pelanggan (30 hari).
- Ambang deteksi (500 m / 10 menit, 15 menit berhenti, jam layanan, dll.) diubah di **Pengaturan → Parameter**
  (PAR-50, PAR-51, PAR-07, `m12.fleet_rules`) dengan tanggal berlaku; perubahan berjejak. Deteksi per truk dapat dimatikan
  lewat flag `fleet.offschedule_detection` (mis. perangkat baru dipasang).

## Admin Sistem — Perangkat GPS

- **Armada → Perangkat GPS**: terakhir terlihat, posisi terakhir, daya, versi, baterai, status **Aktif/Mati/Dicabut**,
  kejadian terbuka, jumlah mati 30 hari & pola per truk. Mati = tanpa posisi > 15 menit pada jam layanan (PAR-25).
- **GPS ponsel cadangan**: aktif otomatis saat perangkat mati; bisa dipaksa aktif/nonaktif per truk dengan alasan.
- Gangguan vendor (semua truk basi sekaligus) → hanya tim IT yang diberi tahu; hubungi vendor.
- Penghubung vendor: `POST /api/gps/ingest/generic-json` (JSON) atau `GET/POST /api/gps/ingest/osmand` (OsmAnd/Traccar),
  token `GPS_INGEST_TOKEN` (header `Authorization: Bearer …` atau `?token=`). Perangkat dikenali dari IMEI atau kode
  perangkat (daftarkan di **Akses → Perangkat**, pasang di truk lewat **Data master → Armada**).
- Uji tanpa perangkat: `pnpm tsx scripts/gps-simulate.ts --mundur 60 --percepat 6 --durasi 20` (skenario
  `--skenario luar-jadwal|cabut|mati`).

## Pemilik & Admin Keuangan — BBM & zona

- Tetapkan dulu **PAR-53** (konsumsi BBM L/km dan harga BBM per liter). Estimasi biaya BBM per rit = jarak GPS × konsumsi
  × harga; dibanding bulanan dengan BBM nyata (pengeluaran rit sopir). Selisih hanya ditampilkan.
- **Pemeriksaan zona**: alamat yang rata-rata jarak GPS 3 rit terakhir masuk zona tarif lain beserta selisih tarifnya.
  Mengubah zona tetap lewat **Data master → Zona** (persetujuan pemilik).
