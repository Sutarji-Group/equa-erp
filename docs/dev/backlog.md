# Backlog lintas modul (dikelola manajer proyek IT)

Isu terbuka hasil integrasi yang harus dituntaskan oleh modul/sprint yang disebut. Centang saat selesai.

| # | Isu | Pemilik | Sumber |
|---|---|---|---|
| B-01 | M3 memancarkan `trip.completed` dengan `isInternal`, `destinationOutletId`, `volumeL`, `completedAt` (M6 butuh untuk 'pasokan tiba') | M3 | M6 |
| B-02 | M3 memakai pull `m2.schedule` (DriverSchedule), menghormati `DriverTrip.locked` (BR-10) | M3 | M2 |
| B-03 | Aplikasi lapangan (/sopir, /pos, /produksi) memasang `<FieldSupportPanel />` di menu Bantuan | M3, M6, M8 | M10 |
| B-04 | M4: sebelum menerima setoran shift panggil `isShiftFullySynced`; pancarkan `deposit.received` dengan `sourceType` agar M6 menandai setoran shift 'received' | M4 | M6 |
| B-05 | M7: `registerPosKindPolicy(storePolicy)` di `registerSync()`; jangan mendaftarkan ulang handler `pos_void`/`stock_adjustment` | M7 | M6 |
| B-06 | M12 memanggil `compareTripDistanceToZone` (M1, US-M1-05 KP-6) dan `raiseIncident` (M10) | M12 | M1, M10 |
| B-07 | M10 `createUser`/`registerDevice` menerima `tenantId` agar operator & tablet tenant mitra dapat dibuat dari UI | RL-7 (P3) | M6 |
| B-08 | Login web memaksa ganti kata sandi bila `must_change_password`; halaman ubah kata sandi mandiri | S5 pengerasan | M10 |
| B-09 | Tampilan/ekspor jejak audit menyamarkan PII pelanggan yang dianonimkan (D-09 butir 1) | S5 pengerasan | M10 |
| B-10 | Layar kantor stok air awal depot (`outlet_water_ledger` kind opening) untuk cut-over | M8 atau S5 | M6 |
| B-11 | KPI-07 (rit terealisasi vs terjadwal) di laporan | M9 | M2 |
| B-12 | Kunci rit PAR-83 (selisih besar) di M3 pull & M4 | M3, M4 | M2 |
| B-13 | Pemilik mitra (portal) memakai fungsi laporan M6 (`p3.partner_report.read`) | RL-7 (P3) | M6 |
| B-14 | Uji waktu UAT manusia: pesanan < 60 dtk (US-M2-01 KP-7), transaksi POS ≤ 10 dtk (US-M6-01 KP-3), cari pelanggan ≤ 1 dtk pada volume nyata | UAT | M1, M2, M6 |
