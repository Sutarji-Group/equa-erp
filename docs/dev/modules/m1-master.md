# M1 — Master Data (catatan pengembang)

Kode: `src/server/modules/m1-master/` (API publik HANYA `index.ts`), UI `src/app/(office)/master/**` +
`src/components/m1-master/**`, uji `tests/m1-master/**`, E2E `e2e/m1-master.spec.ts`, seed demo
`src/db/seed/demo-m1-master.ts`. PRD 7.1 (US-M1-01..06), BR-04/16/17/18/19/33/37, K20/K23, NFR-34, 6.2b.

## 1. Kontrak untuk modul lain

Semua fungsi `ctx`-first mengikuti pola `authorize → parseInput → runService(tx) → audit → emit` dan menerima
`opts.tx` agar dapat dipanggil di dalam transaksi pemanggil. Fungsi `tx`-first tidak memeriksa izin (pemanggil sudah
terotorisasi) — JANGAN dipanggil dari UI langsung.

| Pemakai | Fungsi | Tanda tangan ringkas | Catatan |
| --- | --- | --- | --- |
| M2 | `searchCustomers` | `(ctx, q, { limit?, includeInactive?, tx? }) → CustomerSearchResult[]` | ≥ 2 karakter; nama/kode/alamat/WA; target ≤ 1 dtk (US-M2-01 KP-1). Nomor WA disamarkan tanpa izin PII. |
| M2 | `getCustomerSummary` | `(ctx, customerId, { tx?, date? }) → CustomerSummary` | Kartu ringkas: status & batas kredit, `openReceivable`, `openCreditOrders`, `remainingLimit`, 10 pesanan terakhir (+truk), rata-rata jarak antar pesanan, harga khusus aktif. Piutang = jumlah `invoices.outstanding_amount` (tabel M5). |
| M2 | `quickCreateCustomer` | `(ctx, { name, segment, waPhone, addressText, addressLabel?, lat?, lng?, manualZoneId?, manualZoneReason?, confirmDuplicate? }, { tx? }) → CreateCustomerResult` | `{status:"duplicates", candidates}` bila mirip dan belum dikonfirmasi (US-M1-01 KP-7 — memperingatkan, tidak memblokir). |
| M2 | `resolveTruckWaterPrice` | `(tx, { customerId, addressId, date, productId? }) → TruckWaterPrice` | `unitPrice = tarif zona(segmen) + BBM` atau harga khusus aktif (BR-17/19). Tanpa zona → `tempPrice: true` (tarif zona tertinggi + BBM) agar pesanan tetap dapat dibuat; UI wajib menandai "harga sementara". |
| M2 | `detectTruckPriceChange` | `(tx, { customerId, addressId, lockedUnitPrice, deliveryDate })` | PTB-13: harga terkunci vs harga berlaku saat antar. |
| M2 | `assertTruckCanReceiveTrips` / `truckDailyTripCapacity` | `(tx, truckId)` / `(tx, truckId, date)` | Menolak truk Perbaikan/Nonaktif (US-M1-03 KP-2); kapasitas = PAR-33 atau kapasitas khusus truk. |
| M6/M7 | `resolveProductPrice` | `(tx, { productId, kind, date, tenantId, outletId? }) → ProductPriceResult` | Harga khusus outlet didahulukan; produk nonaktif → `PRODUCT_INACTIVE`. |
| M8/M11 | `resolveInternalTransferPrice` | `(tx, { depotOutletId, date })` | BR-33/K20: tarif zona segmen *depot pihak ketiga* alamat pelanggan internal depot (PTB-01) + BBM. |
| M12 | `compareTripDistanceToZone` | `(tx, { addressId, actualDistanceM, date })` | US-M1-05 KP-6: `deviates` bila jarak aktual jatuh di zona lain. Tampilan/peringatan di M12. |
| semua | `mapAddressToZone` | `(tx, { lat, lng, tenantId?, date?, referenceWaterSourceId?, provider? }) → ZoneMapping` | Jarak jalan dari sumber air acuan (bawaan terdekat); cadangan garis lurus × 1,3 (`estimated: true`). `setRoutingProviderForTests()` untuk uji. |
| M5 | `evaluateCreditEligibility` | `(tx, customerId, { date? }) → CreditEligibility` | PAR-11 (and/or), PAR-82 (pemakaian), PAR-09 (hari), BR-04 rumah tangga selalu tidak layak. |
| M5 | `openReceivable` | `(tx, customerId) → number` | Dipakai aturan nonaktif (US-M1-01 KP-8). |
| M3 | event `trip.completed` | handler `m1-master:propose_coordinate` | Alamat Belum dikunci → usulan koordinat dari lokasi Selesai (idempoten), notifikasi dispatcher. |

## 2. Event

Dipancarkan (tambahan `src/server/core/events.types.ts`):

- `employee.exited` `{ employeeId, exitDate, tenantId }` — dipancarkan saat tanggal keluar diisi/diubah dan sekali lagi
  saat tanggal itu tercapai (langsung bila ≤ hari ini, atau job `m1.employee_exit` yang juga menonaktifkan karyawan &
  melepas kru default). Handler M10 menonaktifkan akun bila `exitDate ≤ hari ini` (BR-37). Definisi di
  `events.types.ts` + baris di `tests/core/events.test.ts` SAMA PERSIS dengan cabang `mod/m10-access` (penggabungan bersih).
- Status truk Perbaikan/Nonaktif TIDAK memancarkan event baru (katalog §8 dijaga); rit terjadwal ditandai
  `trips.needs_reassignment = true` + notifikasi `truck.trips_need_reassignment` + jejak audit (US-M1-03 KP-2).
- `credit_status.changed` (sudah ada di katalog) — setiap perubahan status kredit (persetujuan, Tempo migrasi).

Ditangani: `trip.completed` (lihat atas).

## 3. Persetujuan (handler di `approvals.ts`)

| Jenis | objectType | Pengaju → pemutus | Efek disetujui | Lewat tenggat |
| --- | --- | --- | --- | --- |
| `credit_grant` | `customer` | Dispatcher → Pemilik | status Tempo + batas + tempo (riwayat, audit, event) | bawaan inti; status tetap Tunai |
| `credit_terms_change` | `customer` | Dispatcher → Pemilik | batas/tempo baru | bawaan inti; batas/tempo lama tetap |
| `special_price` | `special_price` | Dispatcher → Pemilik | harga khusus aktif; `review_date = valid_from + PAR-24 bulan` | bawaan inti; harga master tetap |
| `price_change` | `zone_tariff` / `fuel_component` / `product_price` / `tariff_zone_table` | Admin Keuangan → Pemilik | baris harga/tabel zona aktif pada tanggal berlaku | harga lama tetap berlaku (baris usulan ditutup) |

Pemilik dapat menetapkan harga/tabel zona langsung (`m1.price.set`, tanggal berlaku ≥ hari ini) → notifikasi
`price.changed_by_owner` ke Admin Keuangan & dispatcher. Jalur usulan wajib berlaku ≥ besok (tenggat = awal hari berlaku).

## 4. Notifikasi (tambahan `notifications/catalog.ts`)

`address.coordinate_proposed` (dispatcher), `truck.trips_need_reassignment` (dispatcher, tinggi),
`zone.addresses_moved` (pemilik), `initial_data.signoff_pending` (pemilik), `credit.migrated_set` (Admin Keuangan).
Memakai yang sudah ada: `price.changed_by_owner`, `special_price.review_due`.

## 5. Parameter

- PAR: 08, 09, 10, 11, 24, 33, 41, 82 (lihat Lampiran B).
- `m1.master_rules` (non-PAR, tambahan `params-registry.ts`): `store_partner_active_days` (90),
  `coordinate_completion_days` (30), `duplicate_name_min_similarity_pct` (60).

## 6. Pekerjaan terjadwal (`jobs.ts`)

`m1.zone_table_effective` 00.10 · `m1.employee_exit` 00.15 · `m1.store_partner_flags` 01.15 ·
`m1.special_price_review` bulanan tgl 1 06.50. Semua idempoten.

## 7. Sinkron (pull provider, `sync.ts`)

- `m1.catalog` (operator depot, kasir toko): produk aktif + harga berlaku untuk outlet perangkat; `undefined` bila tidak berubah.
- `m1.store_partners` (kasir toko): daftar depot mitra toko untuk harga mitra di POS.

## 8. Laporan ekspor (`reports.ts`, `/api/export/<kunci>`)

`m1.customers` (PII, `m1.customer.export`, tujuan wajib), `m1.price_history`, `m1.zone_simulation`, `m1.zone_moves`,
`m1.products`, `m1.trucks`, `m1.outlets`, `m1.water_sources`, `m1.employees` (PII), `m1.special_price_reviews`,
`m1.import_validation` (PII, filter `batchId`).

## 9. Rute UI

`/master/pelanggan` (+`/baru`, `/[id]`), `/master/produk`, `/master/zona` (`?usulan=<approvalId>`, `?tanggal=`),
`/master/armada`, `/master/depot`, `/master/sumber-air`, `/master/pool`, `/master/karyawan`, `/master/impor`
(+`/[id]`, `/template/<jenis>[?contoh=1]`), `/master/tanda-tangan` (menu baru, izin `m1.data_signoff.read`).

## 10. Skema

Tambahan `src/db/schema/m1-master.ts`: tabel `customer_legacy_prices` (harga saat ini per pelanggan dari impor —
dasar simulasi zona K23; bukan harga transaksi). Tabel lain sudah ada sejak S0.

## 11. Keputusan desain

1. Alamat tanpa zona → harga sementara = tarif zona tertinggi + BBM (`tempPrice: true`), bukan penolakan.
2. Harga transfer internal depot memakai tarif segmen depot pihak ketiga + BBM (sama dengan harga air truk ke depot).
3. Tempo migrasi (6.2b) diterapkan saat pemilik menandatangani kelompok "Pelanggan & alamat", bukan saat impor dimasukkan.
4. Mode uji impor ditolak di lingkungan produksi (`isProductionLike`); impor produksi hanya sekali per jenis.
5. Baris non-pelanggan yang duplikat dengan data di DB = Salah (harus dikecualikan beralasan); pelanggan = usulan gabung.
6. M1 menandai `trips.needs_reassignment` langsung (tanpa event baru; M2 membaca penandanya).
7. `devices.truck_id` tidak ditulis M1 (domain M10); M1 hanya memvalidasi perangkat GPS/ponsel di form truk.
8. Pelanggan hasil impor produksi (`is_initial_data`) hanya dapat dikoreksi dengan alasan (audit `correct`).

## 12. Belum/terbuka

- Penanda "tagihan bulanan" di KP-1 US-M1-01 disimpan, alur faktur bulanan milik M5.
- Peringatan deviasi jarak (US-M1-05 KP-6) ditampilkan M12 memakai `compareTripDistanceToZone`.

## 13. S5 pengerasan — paket B

- **B-32** kartu pelanggan `/master/pelanggan/[id]` (`customerSummary`): saldo piutang = M5
  `getReceivableBalance(tx, id).balance` (faktur terbuka semua lini + rit belum ditagih) dan eksposur/batas tersisa =
  M5 `computeExposure` (satu definisi dengan M2/M5/M7; kolom baru `uninvoicedStoreCredit`). Uji
  `tests/m1-master/customers.test.ts` (`B-32 …`).
- **B-43** `proposeCoordinateFromTrip`: rit Selesai tanpa lokasi ponsel (`no_location`) → posisi perangkat GPS truk saat
  Selesai (US-M12-04 KP-4): `fleet_events(no_location).details.devicePosition`, atau — karena handler M1 terdaftar
  sebelum M12 pada event `trip.completed` yang sama — dihitung dengan `m12.devicePositionAt` + `m12Rules`
  (`inconsistency_window_minutes`). Impor M12 DINAMIS (M12 `fuel.ts` mengimpor M1 → hindari siklus). Audit menyimpan
  `pointSource` (`phone`/`gps_device`), notifikasi Dispatcher menyebut "tanpa lokasi ponsel". Uji
  `tests/m1-master/coordinate-device.test.ts`.
- **B-18/B-24**: formulir `/master/*` memakai `useFlashActionState` (pesan sukses tidak hilang setelah revalidasi) dan
  penjaga unggah bersama (4 MB, kompresi foto).

## 14. Perbaikan audit S5B (paket A)

- **US-M1-01 KP-4 / BR-04**: mengubah segmen pelanggan berstatus selain Tunai TIDAK mengubah `creditLimit`. Bila batas
  bawaan segmen baru berbeda dan pengubah berizin, sistem mengajukan `credit_terms_change` ke pemilik; hasil layanan
  memuat `creditTermsApproval`. Uji: `tests/m1-master/credit.test.ts` (KP-4 BR-04).
