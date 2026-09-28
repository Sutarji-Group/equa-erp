# Backlog lintas modul (dikelola manajer proyek IT)

Isu terbuka hasil integrasi yang harus dituntaskan oleh modul/sprint yang disebut. Kolom **Status**: `SELESAI` (dengan
modul & integrasi yang menuntaskan), `Sebagian` (bagian yang sudah dikerjakan disebut), kosong = terbuka.

| # | Isu | Pemilik | Sumber | Status |
|---|---|---|---|---|
| B-01 | M3 memancarkan `trip.completed` dengan `isInternal`, `destinationOutletId`, `volumeL`, `completedAt` (M6 butuh untuk 'pasokan tiba') | M3 | M6 | SELESAI (M3, integrasi M3+M7) |
| B-02 | M3 memakai pull `m2.schedule` (DriverSchedule), menghormati `DriverTrip.locked` (BR-10) | M3 | M2 | SELESAI-DIGANTI (M3): ponsel memakai pull `m3.today` (superset `m2.schedule`, kunci BR-10 sama & ditegakkan server). PM menutup atau menata ulang butir ini |
| B-03 | Aplikasi lapangan (/sopir, /pos, /produksi) memasang `<FieldSupportPanel />` di menu Bantuan | M3, M6 (+M7 layar toko), M8 | M10 | Sebagian: /sopir SELESAI (M3); /pos (depot & toko) dan /produksi belum |
| B-04 | M4: sebelum menerima setoran shift panggil `isShiftFullySynced`; pancarkan `deposit.received` dengan `sourceType` agar M6 menandai setoran shift 'received' | M4 | M6 | |
| B-05 | M7: `registerPosKindPolicy(storePolicy)` di `registerSync()`; jangan mendaftarkan ulang handler `pos_void`/`stock_adjustment` | M7 | M6 | SELESAI (M7, integrasi M3+M7) |
| B-06 | M12 memanggil `compareTripDistanceToZone` (M1, US-M1-05 KP-6) dan `raiseIncident` (M10) | M12 | M1, M10 | |
| B-07 | M10 `createUser`/`registerDevice` menerima `tenantId` agar operator & tablet tenant mitra dapat dibuat dari UI | RL-7 (P3) | M6 | |
| B-08 | Login web memaksa ganti kata sandi bila `must_change_password`; halaman ubah kata sandi mandiri | S5 pengerasan | M10 | |
| B-09 | Tampilan/ekspor jejak audit menyamarkan PII pelanggan yang dianonimkan (D-09 butir 1) | S5 pengerasan | M10 | |
| B-10 | Layar kantor stok air awal depot (`outlet_water_ledger` kind opening) untuk cut-over | M8 atau S5 | M6 | |
| B-11 | KPI-07 (rit terealisasi vs terjadwal) di laporan | M9 | M2 | |
| B-12 | Kunci rit PAR-83 (selisih besar) di M3 pull & M4 | M3, M4 | M2 | Sebagian: M3 SELESAI (`driverLock` di pull `m3.today` + listener `discrepancy.formed` → `m3-driver:par83_trip_lock`); M4 membentuk selisih & memancarkan `discrepancy.formed` (lihat B-15) |
| B-13 | Pemilik mitra (portal) memakai fungsi laporan M6 (`p3.partner_report.read`) | RL-7 (P3) | M6 | |
| B-14 | Uji waktu UAT manusia: pesanan < 60 dtk (US-M2-01 KP-7), transaksi POS ≤ 10 dtk (US-M6-01 KP-3), cari pelanggan ≤ 1 dtk pada volume nyata | UAT | M1, M2, M6 | |
| B-15 | M4: panggil `isDriverDayFullySynced(tx, userId, date)` sebelum menutup setoran sopir; `reopenDriverDeposit` dari layar setoran; bentuk selisih & pancarkan `discrepancy.formed` (M3 mendengarkan untuk kunci PAR-83). Kontrak lain untuk M4: `driverDaySyncStatus`, `cashOnHand`, `dayFigures`, `driverLock` | M4 | M3 | |
| B-16 | M5: terapkan alokasi `collection.recorded` ke `invoices.outstanding_amount`; buat faktur tempo & faktur kurang bayar H+0 (PTB-18) dari `trip.payment_recorded`; konversi kurang bayar → tempo setelah notifikasi `field_credit.decided` | M5 | M3 | |
| B-17 | M12: pakai `noLocation`, `outOfOrder`, jarak dihitung server, dan `gps_positions` sumber `phone` (ponsel cadangan); buat `fleet_events.requires_explanation` agar tugas keterangan BR-25 muncul di aplikasi sopir | M12 | M3 | |
| B-18 | Unggah bukti kantor di `/sopir-kantor/dicatat-kantor` lewat Server Action dibatasi 1 MB bawaan Next — pertimbangkan `serverActions.bodySizeLimit` (next.config) atau unggah lewat route lampiran | S5 pengerasan (PM) | M3 | |
| B-19 | UAT lapangan (tidak dapat diotomasi): NFR-18 ukuran teks & kontras di bawah matahari, kamera nyata, uji tanpa sinyal di rute Cianjur (aplikasi sopir & POS) | UAT | M3 | |
| B-20 | M4: panggil `storeShiftsBlockingCashClose(tx, tenantId, businessDate)` saat tutup kas harian (US-M7-09 KP-3) | M4 | M7 | |
| B-21 | M4: berlangganan `supplier_payment.recorded` → gerak kas/bank kantor & isi `supplier_payments.office_cash_movement_id` | M4 | M7 | |
| B-22 | M5: faktur per penjualan tempo toko dari `pos_sale.recorded` (`method=credit`, `outletKind=store`, `paymentTermDays`) dan isi `pos_sales.invoice_id` (struk saat ini "terbit setelah terkirim"); nota kredit / pengembalian dana dari `store_return.recorded` | M5 | M7 | |
| B-23 | Seed demo: penjualan tempo toko PLG-0001 belum memiliki faktur M5 (seed menulis baris langsung tanpa event) — tambahkan faktur demo saat M5 dibangun | M5 | M7 | |
| B-24 | Pesan sukses Server Action hilang bila formnya dilepas setelah revalidasi (mis. menerima nota pengganti di `/toko/pembelian/[id]`); status baru tetap tampil — pertimbangkan toast/flash lintas revalidasi | FUI / M7 | M7 | |
| B-25 | Tinjauan pemilik M6 atas perluasan M7 di berkas M6 (`m6-pos/service/policy.ts`, `service/sales.ts`, `index.ts`, `src/client/m6-pos/{contract,optimistic}.ts`, `components/m6-pos/pos-app.tsx`, `(field)/pos/page.tsx` → `PosEntry`) | M6 | M7 | |
| B-26 | `isTransaction()` (`src/server/core/db.ts`) memakai `instanceof PgTransaction` → di runtime Next transaksi `/api/sync/push` tidak dikenali (salinan drizzle per bundel rute) sehingga handler event terisolasi M1/M2/M6 atas `trip.*` gagal (dev) / PGlite deadlock (`next start`) | Core | M3 | SELESAI (integrasi M3+M7): diganti `is(tx, PgTransaction)` Drizzle (`entityKind`), uji `tests/core/db-transaction.test.ts` |
| B-27 | `e2e/field-offline.mobile.spec.ts` memakai tombol perancah "Kirim data uji" yang hilang setelah M3 mengganti `/sopir` | Core | integrasi | SELESAI (integrasi M3+M7): skenario offline memakai Setor nyata aplikasi sopir (antre → muat ulang offline → terkirim) |
