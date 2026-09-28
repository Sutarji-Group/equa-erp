# M3 — Aplikasi Sopir (catatan pengembang)

Kode: `src/server/modules/m3-driver/` (API publik HANYA `index.ts`), klien ponsel `src/client/m3-driver/**` (kontrak,
reducer optimistis, GPS), UI lapangan `src/app/(field)/sopir/page.tsx` + `src/components/m3-driver/**`, UI kantor
`src/app/(office)/sopir-kantor/**`, uji `tests/m3-driver/**` (trips, payments, collections, failures, deposits, offline,
events, client, seed), E2E `e2e/m3-driver.mobile.spec.ts` (ponsel) + `e2e/m3-driver.spec.ts` (kantor), seed demo
`src/db/seed/demo-m3-driver.ts`, panduan `docs/guides/m3-driver.md`. PRD 7.3 (US-M3-01..10), Bab 5.2, 6.1 (dicatat
kantor), 6.2a (PTB-19), 6.3, 6.4 (tabrakan sinkron), BR-07/08/10/19/22/23/25/37/38, PTB-10/18/19/20/29/62.

## 1. Kontrak untuk modul lain

| Pemakai | Fungsi | Tanda tangan ringkas | Catatan |
| --- | --- | --- | --- |
| M4 | `isDriverDayFullySynced` | `(tx, userId, date) → boolean` | US-M3-09 KP-3/US-M3-10 KP-4: setoran sopir hanya boleh DITUTUP bila `true`. Membandingkan manifes Setor (snapshot `summarySnapshot.manifest`: id rit/pembayaran/pelunasan/pengeluaran yang tercatat di ponsel) dengan server + laporan kesehatan perangkat terakhir SETELAH Setor (`queueByUser`). |
| M4 | `driverDaySyncStatus` | `(tx, userId, date) → { deposit, submitted, missing, deviceQueue, fullySynced, message }` | Pesan "menunggu sinkron" untuk layar M4. |
| M4 | `reopenDriverDeposit` | `(ctx, { depositId, reason }, { tx? })` | Izin `m4.deposit.reopen`; Diajukan → Berjalan (belum Diterima), notifikasi `deposit.reopened` ke sopir. US-M3-07 KP-2. |
| M4 | `cashOnHand`, `dayFigures` | `(tx, userId, date)` | Angka seharusnya (tunai rit + pelunasan tunai − pengeluaran dari kas). |
| M2/M4 | `driverLock` | `(tx, { userId, employeeId, date, tenantId }) → DriverLock \| null` | `br10` (setoran < hari ini belum Ditutup — kueri sama dengan `m2.driverDepositLocks`) atau `par83` (PAR-83 aktif + selisih sopir belum diputuskan dengan `locks_trips` atau jumlah ≤ −`amount_gte`). |
| Kantor | `officeCompleteTrip`, `officeFailTrip`, `uploadOfficeEvidence`, `officeEntryBoard`, `officeEntryReport` | `(ctx, input, { tx? })` | "Dicatat kantor" (Bab 6.1), izin `m3.office_entry.create`/`.read`. |
| Kantor | `confirmIncident`, `listIncidents` | | `m3.trip_incident.confirm/read`; truk rusak → `m1.setTruckStatus(maintenance)`. |
| M9 | `driverTripReport`, `tripPaymentReport`, `collectionReport`, `expenseReport`, `driverDepositReport` | `(ctx, { from?, to?, truckId? })` | Juga terdaftar sebagai laporan ekspor (§6). |
| Uji/integrasi | `departTrip`, `arriveTrip`, `completeTrip`, `failTrip`, `requestFieldCredit`, `recordCollection`, `reportIncident`, `explainFleetEvent`, `recordExpense`, `submitDeposit`, `addDepositorNote`, `recordReceipt`, `recordPhonePositions` | `(ctx, payload, M3WriteMeta)` | Dipanggil handler sinkron; `fromSyncMeta(meta)` membangun `M3WriteMeta`. |

## 2. Event (dipancarkan; payload mandiri PTB-47, tambahan opsional di `events.types.ts`)

- `trip.departed` / `trip.arrived` — `{ tripId, orderId, truckId, driverUserId, at, lat, lng, accuracyM, noLocation,
  actualOrder, plannedOrder, outOfOrder, distanceToAddressM (arrived), isInternal, businessDate, lateSync }`.
- `trip.completed` — B-01 terpenuhi: `isInternal`, `destinationOutletId`, `volumeL`, `completedAt`, `price`,
  `paymentMethod`, `cashReceived`, `transferAmount`, `creditAmount`, `underpaymentAmount`, `profitCenter` (L2),
  `partialVolume*`, `distanceToAddressM` (SERVER), `locationDeviation`, `ownerReviewRequired`,
  `addressCoordinateLocked` (false → M1 mengusulkan titik), lampiran foto/tanda tangan/bukti transfer,
  `recordedByOffice`, `lateSync`.
- `trip.failed` — `{ reason, note, loadedWaterDisposition (M8), photoAttachmentId, plannedVolumeL, … }`; dua gagal
  berturut → BR-24 ditangani M2 (M3 hanya menghitung `consecutiveFailuresFor` untuk tampilan).
- `trip.payment_recorded` — `{ tripPaymentId, method, expectedAmount, receivedAmount, underpaymentAmount,
  underpaymentReason, originalMethod, methodChangeApprovalId, transferProofAttachmentId, bankAccountId, depositId,
  isCredit, profitCenter }`. **M5**: faktur kirim (tempo) & faktur kurang bayar H+0 (PTB-18), transfer belum dicocokkan.
- `collection.recorded` — `{ customerPaymentId, customerId, method, amount, allocations[], advanceAmount, tripId,
  depositId, proofAttachmentId }`. **M5 menerapkan alokasi ke `invoices.outstanding_amount`** (M3 hanya menulis
  `customer_payments` + `payment_allocations`; sisa efektif di ponsel = min(outstanding, amount − credited − written off −
  Σ alokasi)).
- `trip.expense_recorded` — `{ expenseId, kind, amount, fundingSource, receiptAttachmentId, depositId }` → verifikasi M4.
- `deposit.submitted` — `{ depositId, depositNumber, userId, expectedCash, claimedCashExpenses, expectedNet, method,
  submittedLate }`.

Didengar: `discrepancy.formed` (`m3-driver:par83_trip_lock`) → notifikasi `discrepancy.trip_lock` ke sopir bila PAR-83
mengunci (B-12; kunci sendiri dihitung saat pull & ditegakkan server saat Berangkat).

## 3. Persetujuan & notifikasi

- `field_payment_to_credit` (katalog lama, penyetuju Dispatcher, PTB-19): diajukan lewat perintah
  `m3.field_credit.request` hanya bila pelanggan Tempo/Tempo migrasi dan `m2.evaluateCreditOrder` lolos; perintah yang
  tiba > `m3.driver_rules.field_credit_max_delay_minutes` setelah waktu perangkat ditolak (hanya saat daring). Tenggat =
  `field_credit_wait_minutes`. `onApproved/onRejected/onExpired/onCancelled` memperbarui status di pull; bila rit sudah
  Selesai sebagai kurang bayar → notifikasi `field_credit.decided` ke Admin Keuangan (konversi ke tempo di M5).
- Notifikasi baru: `trip.partial_volume`, `trip_incident.reported`, `deposit.driver_reminder`, `deposit.depositor_note`,
  `deposit.reopened`, `field_credit.decided`. Dipakai juga: `trip.underpayment`, `trip.location_deviation`,
  `device.lost_queue` (dicatat kantor → pemilik), `discrepancy.trip_lock`.

## 4. Sinkron (`sync.ts`)

Perintah (izin; kernet pengganti lewat `conditions` = `substituteDriverConditions`): `m3.trip.depart|arrive|complete|fail`,
`m3.field_credit.request`, `m3.collection.create`, `m3.trip_incident.create`, `m3.travel_explanation.create`,
`m3.trip_expense.create`, `m3.deposit.submit`, `m3.deposit.note`, `m3.receipt.record`, `gps.phone_positions` (batch
posisi ponsel cadangan, `onConflictDoNothing`, sumber `phone`). Jenis lampiran: `M3_ATTACHMENT_KINDS`.
Pull: `m3.today` (rit hari ini + faktur terbuka + kas + setoran + tugas keterangan + templat struk + pengaturan;
`undefined` bila tidak berubah sejak `since`) dan `m3.deposits` (riwayat `history_days`).
Tabrakan kantor (Bab 6.4 butir 3): rit ditarik/dipindah truk setelah diunduh → `{ status: "conflict" }` + `trips.sync_conflict`;
rit sudah Selesai/Gagal oleh perintah lain → konflik (catatan pertama berlaku).

## 5. Pekerjaan terjadwal (`jobs.ts`)

`m3.deposit.reminder` (harian pukul PAR-06): sopir yang punya rit/kas tetapi belum Setor → `deposit.driver_reminder`
(sekali per hari, `notifyOnce`). `m3.travel_explanation.missing` (PAR-06): tugas keterangan BR-25 belum diisi → pemilik.

## 6. Laporan ekspor (`/api/export/<kunci>`)

`m3.trips`, `m3.trip_payments`, `m3.collections`, `m3.expenses`, `m3.driver_deposits`, `m3.office_entries`, `m3.incidents`.

## 7. Rute UI

- Lapangan: `/sopir` (PWA; `SopirApp` → FieldGate → DriverProvider; menu Rit/Setor/Keterangan/Riwayat/Bantuan; Bantuan
  memasang `<FieldSupportPanel />` — B-03).
- Kantor: `/sopir-kantor` (alih ke layar pertama yang diizinkan), `/sopir-kantor/dicatat-kantor`
  (`m3.office_entry.create`), `/sopir-kantor/kendala` (`m3.trip_incident.read`), `/sopir-kantor/laporan`
  (`m3.office_entry.read` | `m3.payment_report.read`). Nav: `m3.office_entry`, `m3.incidents`, `m3.reports`.

## 8. Aturan kunci

- BR-10/PAR-83: tombol Berangkat terkunci di ponsel DAN ditolak server (`DomainError` final) — kunci dari `driverLock`.
- BR-19: sopir hanya melihat harga pesanan; jumlah > harga ditolak (kembalian).
- BR-22: foto (maks `max_delivery_photos`, ≤ PAR-38) + nama penerima wajib; tanda tangan atau alasan; volume ≠ PAR-15 → alasan.
- BR-23/PAR-16: jarak dihitung ulang server hanya bila alamat Dikunci; level1 alasan, level2 alasan + tinjauan pemilik.
- PTB-18: tunai kurang → `underpaymentAmount` + alasan; PTB-20: pengeluaran dari kas mengurangi kas di tangan.
- Satu rit berjalan per truk; Setor ditolak bila ada rit Berangkat/Tiba; setelah Setor tidak ada rit baru kecuali dibuka kembali.
- Setoran sopir dibuat saat tunai/pengeluaran pertama (status Berjalan); tunai hari yang sudah Diajukan → setoran hari berjalan (carry-over).
- Dicatat kantor: alasan ≥ 10 huruf, jam kejadian WIB (`device_time`), atas nama pengemudi hari itu (`resolveDayCrews`), pemilik diberi tahu.

## 9. Keputusan desain

1. Pull sendiri `m3.today` (superset data rit + kas + faktur) alih-alih membaca `m2.schedule` di klien (B-02): satu
   revisi konsisten untuk kunci, kas, dan faktur. Semantik kunci identik dengan `DriverTrip.locked` M2 dan ditegakkan
   server. Pull `m2.schedule` tetap diunduh penyedia M2 (tidak dipakai UI sopir).
2. Nama perintah GPS `gps.phone_positions` (bukan `m3.*`) agar M12 dapat memakai ulang handler/tabel posisi.
3. `registerAttachmentAccess("deposit" | "trip_payment" | "customer_payment" | "trip_expense")` oleh M3 dengan izin
   `m3.payment_report.read` atau `m4.deposit.read` — M4 cukup memakai, tidak mendaftarkan ulang.
4. Parameter non-Lampiran B dikumpulkan di `m3.driver_rules` (params-registry).

## 10. Belum/terbuka

- **BLOKER inti (bukan berkas M3):** `isTransaction()` (`src/server/core/db.ts`) memakai `instanceof PgTransaction`.
  Di server Next (dev & `next start`) instans Drizzle di `globalThis.__equaDb` dibuat oleh bundel rute pertama yang
  memanggil `getDb()`, sehingga transaksi `/api/sync/push` bukan instans kelas `PgTransaction` milik bundel rute itu →
  `emit` → `withSavepoint` jatuh ke `withTx` → `getDb()` di dalam transaksi: dev = galat "getDb() dipanggil di dalam
  transaksi" (handler lintas modul M1/M2/M6 atas `trip.*` gagal diam-diam), produksi = PGlite **menggantung** (push
  sopir tidak pernah selesai). Uji Vitest tidak terdampak (satu instans modul). Perbaikan terverifikasi (E2E dev tanpa
  galat handler): `return tx instanceof PgTransaction || (!!tx && typeof (tx as { rollback?: unknown }).rollback === "function");`
  (atau `drizzle-orm` di `serverExternalPackages`). Sampai diperbaiki, `e2e/m3-driver.mobile.spec.ts` gagal pada build
  produksi (lulus dengan `E2E_DEV=1`).
- M4: panggil `isDriverDayFullySynced` sebelum menutup setoran; bentuk selisih & `discrepancy.formed` (memicu kunci PAR-83);
  panggil `reopenDriverDeposit` dari layar setoran.
- M5: terapkan `collection.recorded` ke faktur, buat faktur kurang bayar/tempo dari `trip.payment_recorded`, konversi
  kurang bayar → tempo setelah `field_credit.decided`.
- M12: pakai `noLocation`, `outOfOrder`, jarak server, dan `gps_positions` sumber `phone`; buat `fleet_events.requires_explanation`.
- UAT (tidak otomatis): NFR-18 teks ≥ 16 pt & kontras di bawah sinar matahari (US-M3-01 KP-7 sebagian), kamera nyata,
  uji lapangan tanpa sinyal di rute Cianjur.
