# M8 — Produksi & Stok Air (catatan pengembang)

Kode: `src/server/modules/m8-production/` (API publik HANYA `index.ts`), klien `src/client/m8-production/` (kontrak data
`contract.ts` + reducer optimistis `optimistic.ts`), UI PWA `src/app/(field)/produksi/page.tsx` +
`src/components/m8-production/**`, UI kantor `src/app/(office)/produksi/**`, uji `tests/m8-production/**`, E2E
`e2e/m8-production.spec.ts` + `e2e/m8-production.mobile.spec.ts`, seed demo `src/db/seed/demo-m8-production.ts`.
PRD 7.8 (US-M8-01..07), 7.8.6, BR-26/33/38, PTB-09/41, NFR-06..08/15..18, Lampiran B PAR-15/18/19/38/68/69/70/85 +
parameter non-PAR `m8.production_rules` (jam batas 08.00/23.00, jendela rata-rata susut, bulan ekspor utilisasi, H-N
pengingat uji, hari riwayat operator).

## 1. API publik (`index.ts`) — kontrak untuk modul lain

| Pemakai | Fungsi | Catatan |
| --- | --- | --- |
| M9 (H+0, dashboard) | `utilizationFlags(tx, tenantId, date): UtilizationDayRow[]` | Sumber (dan gabungan `sourceId=null`) dengan utilisasi harian > PAR-19. Tanpa otorisasi (pemanggil sudah berizin). |
| M9 | `computeMonthlyBalance(tx, tenantId, month, today, sourceId?)`, `computeUtilizationDays(tx, tenantId, from, to, { sourceId?, combined? })`, `computeUtilizationMonth(tx, tenantId, month, today, sourceId?)` | Neraca bulanan per sumber + gabungan (`sourceCode "GAB"`), utilisasi harian/bulanan (ruang tumbuh L & rit). |
| M6/M9/P3 | `depotSupplySummary(ctx, { from, to, outletId?, granularity: "day" \| "month" })`, `supplyRows(tx, tenantId, { from, to, outletId?, tripIds? })`, `summarizeSupply(rows, granularity)` | Pasokan depot tiga angka (diisi M8 / diserahkan M3 / diterima M6), selisih, `outOfTolerance` (PAR-69), `transferValue` (M6 `transferValueFor`, K20). |
| M11 (alokasi biaya L1) | `fillTotalsByDay(tx, sourceIds, from, to)` → `Map<"sourceId:date", { customerL, depotL, returnedL, totalL, count, withoutTripCount }>` | Volume BERSIH (pembalik bervolume negatif termasuk). |
| M12 (US-M12-06) | `setFillGeofenceResult(tx, { truckFillId, result: "verified" \| "mismatch", note?, now? })` | Menandai pengisian (tidak memblokir). M8 juga mendengar `fleet_event.detected` kind `fill_without_geofence` (payload `tripId` atau `fleet_events.details.truckFillId`). |
| Kantor/laporan | `sourceDayDetail`, `listWaterBalances`, `monthlyWaterBalance`, `productionWorklist`, `fillsVsSchedule`, `fillsInRange`, `depotSupplyList`, `utilizationDaily`, `utilizationMonthly`, `qualityOverview`, `qualityLocations`, `listMetersOverview`, `depotWaterOpenings` | Semua `ctx`-first dengan `authorize` + lingkup sumber/outlet pelaku. |
| Kantor (mutasi) | `correctMeterReading`, `verifyProduction`, `recordMeterRollover`, `recordMeterReplacement`, `reverseTruckFill`, `linkTruckFill`, `acceptLossInvestigation`, `returnLossInvestigation`, `verifyNegativeBalance`, `upsertQualitySchedule`, `deactivateQualitySchedule`, `recordQualityTest`, `completeQualityAction`, `recordDepotOpeningWater` | `fn(ctx, input, opts?: { tx })` — authorize → Zod → aturan + SoD → `runService` → audit → emit. |
| Offline | `buildProductionToday(tx, ctx, device, since, { now })` | Penyedia pull `m8.today` (lihat §3). |

Aksi lapangan operator (`recordMeterReading`, `recordTruckFill`, `recordTankLevel`, `submitLossInvestigation`,
`recordQualityTestFromField`) dipanggil HANYA lewat handler sinkron (`fromSyncMeta(meta)` → `M8FieldMeta`).

## 2. Event

**Dipancarkan** (payload lengkap di `src/server/core/events.types.ts`, tambahan opsional M8 ditandai):

| Event | Kapan | Payload tambahan M8 (opsional) |
| --- | --- | --- |
| `meter.reading_recorded` | Pembacaan operator & koreksi Admin Keuangan | `businessDate`, `readAt`, `correctionOfId`, `correctionReason`, `adjustmentKind` (putaran), `lateReason`, `photoAttachmentId`, `deviceId`, `lateSync` |
| `truck_fill.recorded` | Pengisian operator; **pembalik** Admin Keuangan (`volumeL` NEGATIF + `reversalOfId` + `reason`) | `businessDate`, `filledAt`, `tripNumber`, `destinationOutletId`, `withoutTrip`, `unplannedTruck`, `volumeReason`, `deviceId`, `lateSync` (`isSupply` = rit internal ke depot) |
| `water_balance.computed` | Neraca terbentuk/berubah (setelah pembacaan malam, pengisian susulan, pembalik, rit gagal kembali ke sumber, cek malam) | `businessDate`, `status`, `isIncomplete`, `productionStatus`, `filledCustomerL`, `filledDepotL`, `returnedL`, `negative`, `utilizationPct`, `utilizationHigh`, `avgLoss7dPct`, `recomputed` |

**Didengar** (`events.ts`, terisolasi savepoint): `water_supply.confirmed` (`m8-production:supply_check` → evaluasi selisih
pasokan PAR-69), `trip.completed` internal (`m8-production:trip_delivered`), `trip.failed` dengan
`loadedWaterDisposition = "returned_to_source"` (`m8-production:failed_trip_water` → neraca hari pengisian dihitung
ulang; air kembali dikurangkan dari Σ pengisian, US-M3-06 KP-2), `fleet_event.detected` (`m8-production:geofence`).

## 3. Sinkron (`sync.ts`) & pull

| Perintah | Payload | Izin | Catatan |
| --- | --- | --- | --- |
| `m8.meter_reading.create` | `{ readingId, waterMeterId, phase: morning/evening, readingL, lateReason? }` + lampiran `meter_photo` (WAJIB) | `m8.meter_reading.create` | Idempoten per `readingId`; fase yang sudah tercatat → SOD-05 (koreksi hanya FA). Angka < sebelumnya ditolak kecuali putaran tercatat. Lewat jam batas → `lateReason` wajib. |
| `m8.truck_fill.create` | `{ fillId, truckId, tripId \| null, volumeL, volumeReason?, unplannedConfirmed? }` + `truck_fill_photo` opsional | `m8.truck_fill.create` | Volume ≠ PAR-15 → alasan wajib; > kapasitas truk ditolak. Rit sudah berpengisian/ditarik/Selesai → dicatat tanpa rit + `status: "conflict"` (`requestedTripId`, `syncConflictNote`). Tanpa rit → notifikasi `production.fill_without_trip`; truk di luar rencana → `production.fill_unplanned_truck`. |
| `m8.tank_level.create` | `{ tankLevelId, levelL? , levelPct?, notes? }` + `tank_level_photo` opsional | `m8.tank_level.create` | Informasi (PTB-41). |
| `m8.loss_investigation.submit` | `{ waterBalanceId, reason (loss_reason), note? }` + `loss_investigation_photo` WAJIB | `m8.loss_investigation.create` | "Lainnya" wajib keterangan → status Investigasi; notifikasi `water.loss_explained` ke pemilik. |
| `m8.quality_test.create` | `{ qualityTestId, scheduleId?, testDate, laboratory, results[], passed, action?, notes? }` + `quality_certificate` WAJIB | `m8.quality_test.create` | Lokasi = sumber perangkat. |

Pull `m8.today` (peran `production_operator`): sumber perangkat (lingkup wajib, selain itu `blockedReason`), aturan
(PAR-15/18/38/69 + jam batas), meter (pembacaan terakhir, `previousDayL`, pagi/malam hari ini, putaran tertunda),
produksi hari ini/kemarin, **truk + rit hari ini** (terjadwal di sumber ini = rit berikutnya belum Berangkat & belum
diisi, beralamat sumber acuan = sumber ini; `nextTripId`; air rit gagal yang dibawa), pengisian hari ini, tandon, tugas
investigasi (31 hari), neraca terakhir, jadwal & hasil uji + calon penanggung jawab, riwayat N hari. `undefined` bila
tidak ada perubahan sejak kursor (hemat kuota). Reducer optimistis: `registerM8Optimistic()` (semua perintah di atas).

## 4. Persetujuan & notifikasi

Tidak ada jenis persetujuan 6.2a untuk M8 (`approvals.ts` kosong dengan alasan): koreksi pembacaan & pembalik pengisian
langsung oleh Admin Keuangan (BR-38, berjejak audit). Notifikasi baru (katalog, hanya tambah):
`production.reading_reminder` (operator), `production.deviation` (FA), `production.fill_without_trip` (Dispatcher +
pemilik), `production.fill_unplanned_truck` (Dispatcher), `production.supply_difference` (Dispatcher + pemilik),
`water.loss_explained` (pemilik), `water.loss_explanation_returned` (operator). Dipakai dari katalog yang ada:
`production.missing_or_negative`, `water.loss_over_threshold`, `source.utilization_high` (sekali per rangkaian berturut
PAR-85), `quality_test.failed`, `quality_test.due`. Semua lewat `notifyOnce` (kunci grup per objek) → cek ulang tidak
menggandakan.

## 5. Pekerjaan terjadwal (`jobs.ts`)

`m8.meter.morning_check` (jam `m8.production_rules.morning_deadline`, 08.00) & `m8.meter.evening_check` (23.00):
pembacaan belum ada → pengingat operator + "produksi belum tercatat" pemilik, produksi Belum lengkap; cek malam juga
membentuk neraca hari itu. `m8.quality.reminder` (07.10): jadwal uji jatuh tempo ≤ H-7 → pemilik + operator lokasi.

## 6. Laporan ekspor (`/api/export/<kunci>?format=xlsx|pdf&…`)

`m8.meter_readings`, `m8.daily_production` (`m8.production.read`); `m8.truck_fills`, `m8.fills_vs_schedule` (`date`),
`m8.depot_supply`, `m8.depot_supply_summary` (`granularity`) (`m8.truck_fill.read`); `m8.water_balance_daily`,
`m8.water_balance_monthly` (`month`) (`m8.water_balance.read`); `m8.utilization_daily` (`m8.utilization.export`, bawaan
6 bulan per sumber + gabungan), `m8.utilization_monthly` (`m8.utilization.read`); `m8.quality_tests` (`locationId`).
Filter umum `from`, `to`, `sourceId`, `outletId`.

## 7. Rute UI

- Lapangan: `/produksi` (PWA operator; Hari ini, Meter, Isi truk, Riwayat, Bantuan + tandon/investigasi/uji mutu).
- Kantor (didaftarkan di `OFFICE_ROUTES_UNDER_FIELD_PREFIX` + matcher `src/proxy.ts`): `/produksi/neraca-air` (+ tab
  bulanan), `/produksi/neraca-air/rincian?sumber=&tanggal=`, `/produksi/utilisasi`, `/produksi/mutu`,
  `/produksi/pengisian` (tab jadwal, semua, pasokan, stok awal depot), `/produksi/kelola-meter`.

## 8. Aturan kunci

- Produksi = Σ (akhir − awal) per meter aktif. Awal = pagi (atau malam sebelumnya → "Gabungan"); akhir = malam (atau
  pagi berikutnya → "Gabungan", 7.8.6). Putaran → (angka putaran − awal) + akhir. Penggantian → estimasi rata-rata
  PAR-68 hari, "Estimasi". Belum lengkap bila pembacaan hilang. Penyimpangan > PAR-68 (hanya produksi lengkap) → bertanda
  + pembacaan "Anomali" + notifikasi FA; FA memverifikasi.
- Neraca = produksi − Σ pengisian bersih (pelanggan + pasokan depot − air rit gagal kembali ke sumber). Status otomatis:
  Terbentuk (belum lengkap) → Susut normal / Susut di atas ambang (PAR-18) / Susut negatif; Investigasi → Selesai
  (pemilik menerima; SOD: penerima ≠ penjelas) atau dikembalikan; susut negatif → verifikasi FA → Selesai. Status manual
  tidak ditimpa hitung ulang.
- Utilisasi = Σ pengisian ÷ kapasitas harian sumber (M1). > PAR-19 ditandai; > PAR-19 selama PAR-85 hari berturut →
  push pemilik sekali per rangkaian.
- Pasokan depot: selisih diisi − diterima > PAR-69% → Dispatcher & pemilik (sekali per rit); masuk neraca bulanan
  (`supplyDifferenceL`).
- Mutu: frekuensi PAR-70 bila `configured`, selain itu wajib diisi; uji berikutnya = tanggal uji + frekuensi; tidak
  lulus → tindakan (deskripsi, penanggung jawab aktif, tenggat ≥ tanggal uji) + notifikasi pemilik.
- Stok air awal depot (B-10): sekali per depot, ≤ kapasitas toren, lewat `m6.postWaterMovement` jenis `opening`
  (buku air M6 append-only); koreksi = penyesuaian stok air M6.

## 9. Keputusan desain

- Tidak menambah jenis event: pembalik pengisian dipancarkan sebagai `truck_fill.recorded` bervolume negatif
  (`reversalOfId`) agar konsumen volume (M11/M9) cukup menjumlah.
- Koreksi pembacaan = baris baru (`superseded_by_id` pada baris lama) — tabel pembacaan tidak pernah dihapus/diubah angkanya.
- Rute kantor pengisian & kelola meter diberi nama `/produksi/pengisian` dan `/produksi/kelola-meter` (bukan
  `/produksi/meter`) karena `/produksi/meter` dicadangkan sebagai jalur aplikasi lapangan (uji field-routes).
- Rencana sumber per truk ditentukan dari **alamat rit berikutnya yang belum diisi** (sumber acuan alamat M1), bukan
  tabel rencana terpisah — konsisten dengan papan jadwal M2.
- Seed demo menulis baris langsung (tanpa event) dan menghitung produksi/neraca dengan aturan yang sama; uji
  `tests/m8-production/seed.test.ts` memastikan hitung ulang layanan tidak mengubah angka demo.

## 10. Belum / terbuka

- Penjaga imutabel DB (`IMMUTABLE_COLUMN_GUARDS`, `src/db/hardening.ts`) untuk `meter_readings.reading_l` &
  `truck_fills.volume_l` belum ditambahkan (berkas inti) — imutabilitas dijaga layanan (SOD-05). Usulan untuk Core.
- M12: pencocokan geofence penuh (masuk/keluar sumber) memakai `setFillGeofenceResult`; M8 baru menangani
  `fill_without_geofence`.
- M9: ringkasan H+0 memakai `utilizationFlags` & `water_balance.computed` (belum dibangun).
- Foto pembacaan demo tidak disertakan (seed tanpa berkas); unggahan foto kantor (koreksi, sertifikat) lewat Server
  Action tunduk batas 1 MB bawaan Next (B-18).
