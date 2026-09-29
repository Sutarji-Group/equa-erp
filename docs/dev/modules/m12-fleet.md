# M12 — Pelacakan Armada / GPS (catatan pengembang)

Kode: `src/server/modules/m12-fleet/` (API publik HANYA `index.ts`; logika `service/*.ts`, fungsi MURNI `domain/*.ts`,
skema Zod `schemas.ts`), rute `src/app/api/gps/{ingest/[vendor],live,replay}/route.ts`, UI kantor
`src/app/(office)/armada/**` (+ Server Actions `armada/actions.ts`, komponen `src/components/m12-fleet/*`), uji
`tests/m12-fleet/**`, E2E `e2e/m12-fleet.spec.ts`, seed demo `src/db/seed/demo-m12-fleet.ts`, simulator
`scripts/gps-simulate.ts`, panduan `docs/guides/m12-fleet.md`. PRD 7.12 (US-M12-01..08), BR-23, BR-25, BR-38, NFR-21,
NFR-28, PTB-33/34, Lampiran B PAR-07/16/25/26/42/48..54 + parameter non-PAR `m12.fleet_rules`.

## 1. Arsitektur singkat

- **Penghubung vendor (NFR-21)** — `domain/adapters.ts` (murni): `generic-json` (JSON satu posisi / larik /
  `{positions}`) dan `osmand` (OsmAnd/Traccar: query/form, knot, JSON Traccar Client). Semua memetakan ke **format posisi
  internal** `GpsFix`. Ganti vendor = tambah adaptor + daftarkan di `GPS_VENDOR_ADAPTERS`; penerima, tabel, deteksi, peta
  tidak berubah. Rute `GET|POST /api/gps/ingest/<vendor>` (token `GPS_INGEST_TOKEN`: `Authorization: Bearer` atau
  `?token=`; 401/404/400/422), maks 500 posisi per permintaan.
- **Penerima** `ingestGpsFixes(fixes, {vendor, receivedAt?, db?})` — satu transaksi, per butir: perangkat dari IMEI atau
  kode perangkat (`devices.kind=gps`, bukan diblokir) → truk lewat master armada `trucks.gps_device_id` (cadangan
  `devices.truck_id` bila truk tanpa perangkat) — posisi disimpan PER TRUK (ganti perangkat cadangan tidak memutus
  riwayat). Unik `(truck, source, device_time)` → kirim ulang = `duplicate`. Kualitas: `is_valid=false` bila vendor
  menandai tidak valid, 0,0, atau akurasi > `max_accuracy_m` (tetap disimpan; deteksi hanya membaca yang valid). PAR-42
  dinilai dari posisi terbaru kiriman → `clock_skew_flagged` + kejadian `clock_skew` (satu per perangkat per hari).
  Kesehatan perangkat diperbarui (terakhir terlihat, posisi terakhir, daya/versi/baterai terakhir yang dilaporkan).
  Daya `false` → Dicabut (`markDeviceOutage`); posisi baru setelah Mati (atau daya `true` setelah Dicabut) →
  `restoreDevice`.
- **Titik status M3** (handler `trip.departed/arrived/failed/completed`) selalu disimpan sebagai posisi sumber
  `status_point` (US-M12-01 KP-4). `noLocation` → kejadian `no_location` (detail memuat posisi perangkat saat itu —
  usulan koordinat alamat, US-M12-04 KP-4). Berangkat tersinkron terlambat menutup kejadian "di luar jadwal" yang ternyata
  bagian rit (`details.autoResolved = late_departure_sync`).
- **Selesai (US-M12-04)** — `handleTripCompleted`: jarak server titik Selesai → alamat **Dikunci** (Belum dikunci → tanpa
  penyimpangan; M1 mengusulkan koordinat) atau → **koordinat depot** untuk rit internal. > PAR-16 `reason_required_gt_m`
  → `location_deviation_l1` (Selesai, informasi), > `owner_review_gt_m` → `location_deviation_l2` (daftar tinjauan;
  `explained` bila sopir memilih alasan). Posisi perangkat ± `inconsistency_window_minutes` vs titik ponsel >
  `source_inconsistent_gt_m` → `location_source_inconsistent` (+ job menilai ulang 3 jam terakhir karena posisi perangkat
  dapat tiba terlambat). Jejak rit (`trip_tracks`) + estimasi BBM dihitung saat Selesai/Gagal.
- **Deteksi (US-M12-05)** — job 5 menit `runTravelDetection`: jejak valid perangkat `detection_lookback_hours` →
  titik berhenti (PAR-49, `stop_radius_m`) → segmen gerak → potongan DI LUAR interval rit (Berangkat→Selesai/Gagal) yang
  sudah berakhir. Berakhir di lokasi sah (sumber/depot/pool, radius M1 atau PAR-54) = perjalanan yang diharapkan (tidak
  ditandai). Menyentuh luar PAR-07 → `off_hours_trip`; > PAR-50 m/menit → `off_schedule_trip`. Selama rit aktif berhenti
  > PAR-51 di luar alamat rit (radius PAR-16)/sumber/depot/pool → `unknown_stop` (diperbarui selama masih berhenti).
  Pengguna aktif = sopir rit hari itu, bila tidak ada pengguna terakhir ponsel truk. Notifikasi Dispatcher & pemilik +
  pemberitahuan sopir (`fleet.explanation_requested`); `requires_explanation=true` → tugas **Keterangan** di pull
  `m3.today` (M3 `openExplanationTasks`, hari ini & kemarin). Dinonaktifkan per truk: perangkat belum terpasang/belum
  pernah mengirim, flag `fleet.offschedule_detection` mati untuk truk (lingkup `truck`), atau
  `trucks.fleet_detection_enabled=false`. Truk Perbaikan → `maintenance_trip` tanpa keterangan.
- **Alur kejadian** — Terdeteksi → Keterangan sopir (M3 `m3.travel_explanation.create`) → Ditinjau pemilik (`accepted` →
  Selesai; `follow_up` → Ditinjau → `closeFleetEvent` → Selesai) atau `request_explanation` (pemilik/Dispatcher: tugas
  ulang ke sopir). `cash_day.closed` → kejadian tanpa keterangan diberi `details.unexplainedAtCashClose` + kotak masuk
  pemilik (`travel_explanation.missing`, kunci grup harian — sama dengan M3). Semua berjejak audit (`fleet_event`),
  idempoten per `fleet_events.dedupe_key`, tidak ada DELETE (BR-38).
- **Geofence (US-M12-06, S)** — job 5 menit: masuk/keluar per truk (`geofence_enter` dengan lama + `geofence_exit`,
  histeresis `geofence_exit_margin_m`); pengisian M8 tanpa posisi di geofence sumber ± `fill_geofence_window_minutes`
  → `fill_without_geofence` (juga langsung dari `truck_fill.recorded` bila jendela sudah lewat); di sumber >
  `source_dwell_without_fill_minutes` tanpa pengisian → `geofence_without_fill`; rit internal Selesai tanpa masuk depot →
  `supply_without_geofence`. Tanpa posisi perangkat pada jendela = tidak dapat diverifikasi (tidak ditandai).
- **Perangkat mati (US-M12-08)** — job 5 menit pada jam layanan: tanpa posisi > PAR-25 → Mati (`device_offline`),
  peringatan `gps.device_dead` (IT & Dispatcher), insiden M10 `raiseIncident(kind gps_device_dead)`, GPS ponsel cadangan
  (`phone_tracking_flags`, dibaca pull `m3.today.gpsTracking`). Semua perangkat terpantau basi sekaligus (≥
  `vendor_outage_min_devices`) = gangguan vendor → hanya IT (`gps.vendor_outage`). Aktif kembali → kejadian ditutup dengan
  lama mati, ponsel dimatikan, `gps.device_restored`; ≥ `repeat_outage_count` dalam `repeat_outage_days` → pemilik
  (`fleet.device_outage_pattern`, sekali per truk per minggu). > `device_dead_h0_minutes` sehari → H+0.
- **Riwayat (US-M12-03)** — jarak dari jejak perangkat/ponsel (dibersihkan dari lonjakan > `max_plausible_speed_kmh`),
  titik berhenti ≥ PAR-49, lama di pelanggan, celah jejak; hanya titik status → jarak `RoutingProvider` (garis lurus
  × 1,3 bawaan) bertanda `isEstimated`. Ringkasan disimpan `trip_tracks`/`truck_day_summaries` (job harian 00.40 + 2
  hari tertinggal) sehingga tetap ada setelah retensi posisi mentah PAR-52 (job `m12.gps.retention` 02.20 memastikan
  ringkasan dulu, lalu `withRetentionPurge`).
- **BBM & zona (US-M12-07, S/RL-6)** — `fuel_estimates` = jarak × PAR-53 (hanya bila `configured`); dibanding BBM nyata
  (pengeluaran rit M3 `kind=fuel`, bukan ditolak, tanpa baris pembalik/asal yang dibalik). Pemeriksaan zona: rata-rata
  `zone_check_trip_count` rit terakhir (jejak non-estimasi) → M1 `compareTripDistanceToZone` + `getZoneTariff`; job
  bulanan → pemilik (`fleet.zone_mismatch`). Tidak mengubah zona.

## 2. API publik (`index.ts`)

| Fungsi | Izin / catatan |
| --- | --- |
| `GPS_VENDOR_ADAPTERS`, `getGpsVendorAdapter(key)`, `listGpsVendorAdapters()`, `parseFixTime`, `MAX_FIXES_PER_REQUEST` | murni |
| `ingestGpsFixes(fixes, {vendor, receivedAt?, db?, parseErrors?})` → `IngestResult` · `resolveGpsDevice(tx, ref)` · `isValidFix` | tanpa sesi (pelaku Sistem; rute memeriksa token) |
| `getFleetSnapshot(ctx, {date?})` → `FleetSnapshot` (truk, status, sopir+telepon, posisi, basi, rit hari ini/berikutnya, perkiraan tiba, lapisan) | `m12.position.read` (pemilik, Dispatcher) |
| `getReplay(ctx, {truckId, to?})` | `m12.position.read` + lingkup truk; jendela `replay_hours` |
| `listTripHistory(ctx, {date?, truckId?})` · `getTripHistory(ctx, tripId)` · `listTruckDays(ctx, {date?, truckId?})` · `getTruckDay(ctx, {truckId, date})` | `m12.trip_history.read` |
| `stopsReport` · `tripSummaryReport` · `truckDayReport` (ekspor) | `m12.trip_history.read` (+ laporan `m12.trip_history.export`) |
| `listFleetEvents(ctx, filter)` · `getFleetEvent(ctx, id)` · `getFleetDaySummary(ctx, date)` · `locationDeviationPatterns(ctx, {from,to})` | `m12.fleet_event.read` (pemilik, Dispatcher, Admin Sistem) |
| `reviewFleetEvent(ctx, {fleetEventId, decision: accepted\|request_explanation\|follow_up, note})` | `accepted`/`follow_up` = `m12.fleet_event.review` (pemilik); `request_explanation` = `m12.fleet_event.request_explanation` (pemilik, Dispatcher; catatan wajib) |
| `closeFleetEvent(ctx, {fleetEventId, note})` | `m12.fleet_event.review` |
| `listGpsDevices(ctx)` · `getGpsDeviceHealth(ctx, deviceId)` · `deviceOutageReport(ctx, {from,to})` | `m12.fleet_event.read` |
| `setPhoneTracking(ctx, {truckId, enabled, reason≥5})` | `m12.phone_tracking.enable` (Admin Sistem), audit `phone_tracking_flag` |
| `fuelMonthly(ctx, {month})` · `zoneCheck(ctx)` | `m12.fuel_estimate.read` (pemilik, Admin Keuangan) |
| Untuk modul lain (tx, tanpa izin): `fleetDaySummary(tx, tenantId, date, now)` (M9 H+0), `geofenceFlagsFor(tx, {tenantId, date, waterSourceId?})` (M8 neraca air), `zoneCheckRows(tx, tenantId, date)`, `deviceOutageMinutesOn`, `m12Rules`, `legalLocations` | |
| Job/uji: `runTravelDetection(now, db?)`, `runDeviceHealthCheck(now, db?)`, `runGeofenceProcessing(now, db?)`, `runDailySummaries(now, db?, {date?, catchUpDays?})`, `purgeExpiredPositions(now, db?)`, `runZoneCheckMonthly(now, db?)`, `recheckRecentCompletions(tx, tenantId, now)` | idempoten |

Rute: `GET /api/gps/live?tanggal=` (snapshot untuk komponen peta; 401/403), `GET /api/gps/replay?truk=&sampai=`.
Komponen: `FleetLiveMap` (klien; `initial: FleetSnapshot`, `compact`), `ReplayPlayer`, `TrackMap`, `GpsHealthCard`
(Server Component, data `getGpsDeviceHealth`).

## 3. Event

- **Dipancarkan**: `fleet_event.detected` untuk setiap kejadian baru (payload mandiri; tambahan opsional M12:
  `businessDate, endedAt, durationS, distanceM, lat, lng, deviceId, userId, requiresExplanation, locationType,
  locationId, truckFillId, waterSourceId`). Tidak ada tipe event baru.
- **Didengar** (handler bernama, savepoint): `trip.departed|arrived|failed` → `m12-fleet:trip_status_point`;
  `trip.completed` → `m12-fleet:trip_completed`; `truck_fill.recorded` → `m12-fleet:fill_geofence`; `cash_day.closed` →
  `m12-fleet:unexplained_at_cash_close`.

## 4. Job (`/api/cron/tick`)

`m12.devices.health` (5 mnt) · `m12.detection.travel` (5 mnt; + konsistensi sumber lokasi) · `m12.geofence.visits`
(5 mnt) · `m12.summaries.daily` (00.40) · `m12.gps.retention` (02.20; job M10 `m10.retention.daily` 02.30 tetap cadangan
idempoten) · `m12.zone_check.monthly` (tgl 1, 07.10).

## 5. Laporan (ekspor Excel/PDF; posisi mentah TIDAK diekspor)

`m12.trips`, `m12.stops`, `m12.truck_days` (izin `m12.trip_history.export`), `m12.fleet_events`,
`m12.location_patterns`, `m12.device_outages`, `m12.gps_devices` (`m12.fleet_event.read`), `m12.fuel_monthly`,
`m12.fuel_trucks`, `m12.fuel_zones`, `m12.zone_check` (`m12.fuel_estimate.read`; `zone_check` memuat alamat → PII).

## 6. Parameter, flag, notifikasi

- Lampiran B: PAR-07, 16, 25, 26, 42, 48, 49, 50, 51, 52, 53 (belum ditetapkan → estimasi BBM tidak dibuat), 54.
- `m12.fleet_rules` (tambahan `params-registry.ts`): akurasi, kecepatan/radius diam, gerak minimal, lonjakan, celah,
  ambang sumber tidak konsisten & jendela, jendela/lama geofence pengisian, histeresis, H+0 perangkat mati, pola berulang,
  gangguan vendor, kecepatan perkiraan tiba, jam putar ulang, jumlah rit cek zona, jendela deteksi.
- Flag `fleet.offschedule_detection` (lingkup truk) — matikan deteksi US-M12-05 per truk.
- Notifikasi dipakai: `fleet.off_schedule`, `fleet.unknown_stop`, `fleet.location_inconsistent`,
  `trip.location_deviation`, `travel_explanation.missing`, `gps.device_dead`; ditambahkan: `gps.device_restored`,
  `gps.vendor_outage`, `fleet.device_outage_pattern`, `fleet.geofence_mismatch`, `fleet.zone_mismatch`,
  `fleet.explanation_requested` (penerima eksplisit sopir).

## 7. Berkas bersama yang disentuh (hanya tambah)

`src/db/schema/m12-fleet.ts` (`gps_positions.vendor`, `gps_positions.raw`, `fleet_events.dedupe_key` + indeks unik
parsial), `src/lib/labels.ts` (`fleet_live_status`, `fleet_event_group`), `src/server/core/events.types.ts` (kolom
opsional `FleetEventDetectedPayload`), `src/server/core/params-registry.ts` (`m12.fleet_rules`),
`src/server/core/notifications/catalog.ts` (6 kode), `src/components/shared/nav/registry.ts` (`/armada/perangkat`,
`/armada/bbm`) + `docs/nav-permissions.md` (dibangkitkan), `src/db/seed/index.ts` (panggil `seedDemoM12Fleet`).
Perubahan minimal M2 (sematan peta, US-M12-02 KP-4): `m2-orders/service/schedule.ts` (`lastPosition` hanya untuk izin
`m12.position.read`), `(office)/jadwal/page.tsx` (`FleetLiveMap` hari ini untuk pemilik & Dispatcher).
Penyesuaian uji M3 (satu kueri): `tests/m3-driver/offline.test.ts` US-M3-02 KP-5 menyaring `gps_positions.source =
'phone'` — M12 kini juga menyimpan titik status Berangkat/Tiba sebagai `status_point` untuk truk yang sama (US-M12-01
KP-4; nilai enum `status_point` sudah ada sejak F2), sehingga hitungan "3 baris per truk" tidak lagi berlaku tanpa saringan.

## 8. Uji & ketertelusuran

`tests/m12-fleet/`: `domain` (adaptor, jejak, status, simulator), `ingest` (US-M12-01 KP-1..6; KP-5 membandingkan deteksi jejak berakurasi baik vs buruk), `live` (US-M12-02
KP-1..5 + rute `/api/gps/live` + papan jadwal), `history` (US-M12-03 KP-1..4), `completion` (US-M12-04 KP-1..5),
`detection` (US-M12-05 KP-1..5 + 7.12.6), `geofence` (US-M12-06 KP-1..4), `fuel` (US-M12-07 KP-1..3), `devices`
(US-M12-08 KP-1..4 + gangguan vendor), `registration`, `seed`. Pembantu: `tests/m12-fleet/helpers.ts` (`gpsTruck`,
`attachGps`, `fix/dwell/drive/chain`, `feed` = penerima yang sama dengan rute). Tidak dapat diotomasi: uji 1 unit
perangkat vendor nyata di bulan 3 (US-M12-01 KP-3/R05 — adaptor kedua disimulasikan), peta komersial (NFR-24 — penyedia
rute bawaan garis lurus × 1,3; OSRM opsional `MAP_ROUTING_URL`).

## 9. Kontrak/isu untuk modul lain

- **M10**: halaman perangkat `/akses/perangkat/[id]` belum menyematkan `GpsHealthCard` (data `getGpsDeviceHealth`) — daya,
  versi, status GPS (US-M12-08 KP-4). Job pemantauan M10 sebaiknya tidak menggandakan peringatan perangkat GPS mati
  (M12 pemilik `gps.device_dead`). Retensi `gps_positions` sekarang dilakukan M12 (M10 cadangan).
- **M1**: `proposeCoordinateFromTrip` memakai titik Selesai ponsel saja; bila `noLocation`, pakai
  `fleet_events(no_location).details.devicePosition` (US-M12-04 KP-4).
- **M3**: untuk rit internal, jarak Selesai dibanding alamat pesanan — M12 menghitung ulang terhadap depot (KP-5);
  pertimbangkan menyelaraskan tingkat penyimpangan M3. `openExplanationTasks` memakai jendela hari ini & kemarin.
- **M8**: tandai `truck_fills.geofence_mismatch` dari `fleet_event.detected` (`truckFillId`) dan pakai `geofenceFlagsFor`
  pada neraca air (US-M12-06 KP-4). Integrasi M8 + M12: penandaan SELESAI (handler `m8-production:geofence`), dan
  `checkFillGeofence` kini memanggil `m8.setFillGeofenceResult(verified)` bila truk berada di geofence sumber (status
  pengisian "Terverifikasi geofence"); uji `tests/integration/m8-m12.test.ts`. Terbuka (B-45): `geofence_without_fill`
  di rincian neraca / investigasi susut M8.
- **M9**: H+0 memakai `fleetDaySummary(tx, tenantId, date, now)`; KPI-07 tersedia di `truck_day_summaries` / laporan
  `m12.truck_days`; pola penyimpangan `locationDeviationPatterns` (US-M9-05).
- **M11**: `fuel_estimates` = informasi biaya BBM per rit lini L2 (tidak dijurnal).

## 10. Backlog

B-06 SELESAI (M12 memanggil M1 `compareTripDistanceToZone`/`getZoneTariff` dan M10 `raiseIncident`). B-17 SELESAI
(`noLocation` → `no_location`; `outOfOrder`/`actual_order` ditandai di riwayat & laporan `m12.trips`; jarak dihitung
server; posisi sumber `phone` dipakai jejak/peta/putar ulang; `requires_explanation` → tugas keterangan M3).

Integrasi M8 + M12: seed demo M8 memberi T4 rit kemarin (sumber SA2) sehingga jejak T4 kemarin kini mengikuti rit; seed
M12 tetap menambahkan perjalanan di luar jadwal 15.00 (pool → warung → pool, `offScheduleExcursion`) setelah rit terakhir
agar jejak selaras dengan kejadian demo `off_schedule_trip` T4. Uji seed gabungan di `tests/integration/m8-m12.test.ts`
(jejak T4, pengisian demo M8 tanpa penanda geofence, jejak hari ini tanpa kejadian).

## 10. Pengerasan S5 (paket A)
- **B-42 SELESAI**: `/akses/perangkat/[id]` (M10) menyematkan `GpsHealthCard` untuk perangkat GPS; job pemantauan M10 tidak
  lagi membuat insiden/peringatan `gps.device_dead` (M12 pemilik tunggal; M10 hanya menghitung untuk ringkasan).
- **B-45 SELESAI**: `geofenceFlagsForSourceDay(ctx, { sourceId, date })` (izin `m8.water_balance.read` atau
  `m12.fleet_event.read`) untuk rincian neraca air M8.
- **B-48 SELESAI**: M3 kini mengukur Tiba/Selesai rit internal terhadap koordinat depot tujuan (`deviationTarget`, pull
  `m3.today` mengirim titik depot) → tingkat penyimpangan M3 = kejadian M12 (`location_deviation_l2`,
  `details.targetKind = "depot"`); uji `tests/m3-driver/trips.test.ts` (B-48 US-M12-04 KP-5). `openExplanationTasks`
  (M3) tetap berjendela hari ini & kemarin: BR-25 meminta keterangan "hari yang sama"; kemarin diberi sebagai kelonggaran
  sinkron terlambat — tugas yang lebih lama tetap tampil ke pemilik (M9 H+0 / kotak masuk), bukan ke sopir.
- **B-46** (peta komersial): keputusan D-10 butir 4 sudah tercermin — OSM + garis lurus × 1,3 bawaan, OSRM opsional lewat
  `MAP_ROUTING_PROVIDER=osrm` + `MAP_ROUTING_URL` (`src/server/core/maps.ts`, `src/lib/env.ts`); tidak ada perubahan kode.

## 11. Perbaikan audit S5B (paket A)

- **Gangguan vendor GPS (US-M12-01 KP-4, US-M12-08 KP-2, 7.12.6)**: cabang `vendorOutage` di `runDeviceHealthCheck`
  kini memanggil `startPhoneTracking` untuk setiap truk basi (tanpa notifikasi per truk); ingest posisi perangkat
  memanggil `stopPhoneTracking` saat umpan pulih.
- `purgeExpiredPositions` kini juga dipanggil job retensi M10 (satu jalur hapus GPS yang memastikan ringkasan).
- Uji: `tests/m12-fleet/devices.test.ts` (gangguan vendor: pelacakan ponsel hidup lalu berhenti).
