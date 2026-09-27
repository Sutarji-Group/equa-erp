# Arsitektur Teknis — EQUA ERP

Turunan dari PRD v1.1 (`docs/prd/PRD_EQUA_v1_1.md`) dan keputusan `docs/DECISIONS.md`. Dokumen ini menetapkan *bagaimana*
produk dibangun. Semua agen/pengembang wajib mengikutinya agar 12 modul yang dikerjakan paralel tetap menyatu.

---

## 1. Bentuk sistem

**Modular monolith** di satu aplikasi Next.js 16 (App Router) di atas satu basis data Postgres (PRD 1.1 "satu platform, satu data").

| Antarmuka (PRD 4.1) | Rute | Sifat |
|---|---|---|
| Web kantor | `src/app/(office)/**` | Daring; Server Components + Server Actions; sesi web + 2FA |
| Aplikasi lapangan sopir/kernet | `src/app/(field)/sopir/**` | PWA offline-first; login PIN + perangkat terdaftar |
| Aplikasi operator produksi | `src/app/(field)/produksi/**` | PWA offline-first |
| POS depot & toko (multi-tenant) | `src/app/(field)/pos/**` | PWA offline-first; satu aplikasi untuk semua outlet/tenant |
| Portal pemilik mitra (RL-7, Tahap 3) | `src/app/(portal)/mitra/**` | Daring; baca-saja lingkup tenant |
| Aplikasi pelanggan (Tahap 2) | `src/app/(customer)/app/**` | PWA; OTP WA; feature flag |
| API | `src/app/api/**` | sinkron lapangan, cron, penghubung GPS, unggah, ekspor, webhook |

## 2. Struktur direktori (WAJIB)

```
src/
  app/                      # rute Next.js (tipis: hanya memanggil layanan & merender)
    (auth)/                 # /masuk, /masuk/2fa, /aktivasi-perangkat
    (office)/               # web kantor — satu folder per modul (lihat §9)
    (field)/                # PWA lapangan: sopir, produksi, pos
    (portal)/  (customer)/  # RL-7 / Tahap 2-3
    api/
  db/
    schema/                 # skema Drizzle, SATU BERKAS PER MODUL + core.ts; index.ts me-reexport semua
    client.ts               # getDb(): PGlite (dev/test) | Neon (prod) | pg
    seed/                   # data demo & data awal
  server/                   # KODE SERVER SAJA ('server-only')
    core/                   # platform bersama (lihat §5)
    modules/
      m1-master/ m2-orders/ m3-driver/ m4-cash/ m5-receivables/ m6-pos/ m7-store/
      m8-production/ m9-reports/ m10-access/ m11-accounting/ m12-fleet/
      p2-customer/ p3-partner/
  client/                   # KODE PERAMBAN SAJA: offline db (Dexie), sync worker, kamera, geolokasi
  components/
    ui/                     # shadcn/ui
    shared/                 # komponen lintas modul (DataTable, MoneyInput, StatusBadge, PhotoCapture, ...)
    field/                  # komponen PWA lapangan (tombol besar, teks ≥ 16pt)
  lib/                      # isomorfik: money, time/business-date, labels (ID), zod schemas, geo
tests/                      # vitest (unit & integrasi) — tests/<modul>/*.test.ts
e2e/                        # playwright — skenario P-01..P-07
tools/                      # skrip: trace-check (US/KP → uji), generator
docs/                       # PRD, arsitektur, keputusan, panduan pengguna
```

Setiap modul di `src/server/modules/<modul>/` berisi:
```
index.ts          # API publik modul (fungsi layanan yang boleh dipanggil modul lain / UI)
service/*.ts      # fungsi layanan (mutasi & kueri) — menerima ActorContext
events.ts         # handler event domain yang didaftarkan modul ini
sync.ts           # handler perintah sinkron lapangan (bila modul punya aksi lapangan)
approvals.ts      # handler jenis persetujuan milik modul (onApproved/onRejected/onExpired)
jobs.ts           # pekerjaan terjadwal milik modul
schemas.ts        # skema Zod input
```

## 3. Aturan lapisan

1. **Rute/Server Action tipis** → memanggil fungsi layanan modul. Tidak ada kueri DB langsung di komponen.
2. **Fungsi layanan** berbentuk `fn(ctx: ActorContext, input)`. Di dalamnya, urutannya selalu:
   `authorize(ctx, 'perm')` → validasi Zod → aturan bisnis (termasuk `assertSod`) → tulis dalam **satu transaksi** →
   `audit.record(tx, …)` → `events.emit(tx, …)` → kembalikan hasil.
3. **Modul lain dipanggil hanya lewat `index.ts`**-nya, atau lewat **event domain**. Dilarang impor berkas internal modul lain.
4. **Tidak ada DELETE** pada tabel bisnis (trigger DB menolak). Koreksi = baris pembalik yang merujuk baris asal.
5. **Tidak ada angka aturan di kode**: ambang, batas, jam → `params.get(tx, 'PAR-xx', businessDate)`.
6. Kesalahan bisnis dilempar sebagai `DomainError(code, pesanIndonesia)`; UI menampilkan pesannya apa adanya.

### ActorContext
```ts
type ActorContext = {
  userId: string | null;        // null hanya untuk 'system'
  employeeId: string | null;
  roles: RoleCode[];            // peran aktif
  scope: { truckIds: string[]; outletIds: string[]; sourceIds: string[]; tenantIds: string[] };
  tenantId: string;             // tenant aktif (EQUA = tenant pertama)
  deviceId: string | null;
  source: 'web' | 'field' | 'pos' | 'system' | 'customer_app' | 'partner_portal';
  now: Date;                    // waktu server
  deviceTime?: Date;            // waktu perangkat (aksi lapangan)
  businessDate?: string;        // YYYY-MM-DD WIB dari perangkat
};
```
Helper: `systemContext()`, `testContext({ role, ... })`.

## 4. Glosarium kode (WAJIB dipakai konsisten)

Kode memakai bahasa Inggris; UI memakai istilah PRD lewat `src/lib/labels.ts`.

| Istilah PRD | Nama kode (entity / tabel) |
|---|---|
| Pelanggan / Alamat kirim | `Customer` / `customers`; `CustomerAddress` / `customer_addresses` |
| Zona tarif / Komponen BBM | `TariffZone` / `tariff_zones` (+`zone_tariffs`); `FuelComponent` / `fuel_components` |
| Produk & harga | `Product` / `products`; `ProductPrice` / `product_prices`; Harga khusus `SpecialPrice` / `special_prices` |
| Armada (truk) / Kru | `Truck` / `trucks`; `CrewAssignment` / `crew_assignments` (pengemudi harian); `CrewRoster` |
| Depot, Toko (outlet) / Tenant | `Outlet` (kind `depot`/`store`) / `outlets`; `Tenant` / `tenants` |
| Sumber air / Meter / Pool | `WaterSource`, `WaterMeter`, `PoolLocation` |
| Karyawan / Pengguna / Peran | `Employee`, `User`, `UserRole`, `UserScope` |
| Perangkat | `Device` / `devices` |
| Pesanan / Rit | `Order` / `orders`; `Trip` / `trips` |
| Jadwal harian per truk | `DailySchedule` / `daily_schedules` |
| Pesanan berulang | `RecurringOrder` / `recurring_orders` |
| Bukti kirim | kolom di `trips` + `attachments` |
| Pembayaran rit | `TripPayment` / `trip_payments` |
| Kurang bayar | `underpayment` (faktur kind `underpayment`) |
| Pengeluaran rit | `TripExpense` / `trip_expenses` |
| Setoran (sopir/depot/toko) | `Deposit` / `deposits` (source_type `driver`/`depot_shift`/`store_shift`) |
| Selisih | `Discrepancy` / `discrepancies` |
| Transfer masuk | `IncomingTransfer` / `incoming_transfers` |
| Kas kantor / Setor ke bank / Kas kecil | `OfficeCashMovement`, `BankDeposit`, `PettyCashTransaction` |
| Hari kas / Tutup kas | `CashDay` / `cash_days` |
| Ganti rugi karyawan | `Restitution` / `restitutions` |
| Faktur / Pelunasan / Alokasi / Uang muka / Nota kredit | `Invoice`, `CustomerPayment`, `PaymentAllocation`, `CustomerAdvance`, `CreditNote` |
| Status kredit Tunai/Tempo/Tempo migrasi/Ditahan | `credit_status`: `cash` / `credit` / `credit_migrated` / `on_hold` |
| Shift | `Shift` / `shifts` |
| Transaksi POS | `PosSale` / `pos_sales` + `pos_sale_lines` |
| Kartu stok / Saldo stok | `StockLedgerEntry` / `stock_ledger`; `StockBalance` / `stock_balances` |
| Opname | `StockCount` / `stock_counts` + `stock_count_lines` |
| Resep bahan | `DepotRecipe` / `depot_recipes` |
| Penerimaan pasokan air depot | `WaterSupplyReceipt` / `water_supply_receipts` |
| Pemasok / Nota pembelian | `Supplier`; `PurchaseReceipt` / `purchase_receipts` |
| Transfer internal toko → depot | `InternalTransfer` / `internal_transfers` |
| Pembacaan meter / Produksi harian | `MeterReading`; `DailyProduction` |
| Pengisian truk | `TruckFill` / `truck_fills` |
| Neraca air / Susut | `WaterBalance` / `water_balances` (`loss_l`, `loss_pct`) |
| Uji mutu | `QualityTest` |
| Ringkasan H+0 | `DailySummary` / `daily_summaries` |
| Bagan akun / Pusat laba | `Account` / `accounts`; `ProfitCenter` (`L1`..`L5`, `SHARED`) |
| Jurnal | `Journal` / `journals` + `journal_lines` |
| Periode | `AccountingPeriod` / `accounting_periods` |
| Aset tetap | `FixedAsset` |
| Posisi GPS / Kejadian armada | `GpsPosition` / `gps_positions`; `FleetEvent` / `fleet_events` |
| Keterangan perjalanan (BR-25) | `fleet_events.explanation` + tugas di aplikasi sopir |
| Persetujuan | `ApprovalRequest` / `approval_requests` |
| Notifikasi | `Notification` / `notifications` |
| Jejak audit / Log akses | `AuditLog` / `audit_logs`; `AccessLog` / `access_logs` |
| Parameter (PAR-xx) | `Parameter` / `parameters` |
| Tanda tangan data awal (NFR-34) | `DataSignoff` / `data_signoffs` |

### Kode peran (`RoleCode`)
`owner` (Pemilik) · `finance_admin` (Admin Keuangan) · `dispatcher` · `driver` (Sopir) · `helper` (Kernet) ·
`depot_operator` (Operator depot) · `store_cashier` (Kasir toko) · `production_operator` (Operator produksi) ·
`system_admin` (Admin sistem) · `accountant` (Akuntan, baca-saja) · `partner_owner` (Pemilik mitra, RL-7) ·
`regional_coach` (Pembina wilayah, Tahap 3). Pelanggan Tahap 2 memakai autentikasi terpisah (`customer_accounts`).

### Enum status (kode → label UI)
- Pesanan `order_status`: `new` Baru · `awaiting_approval` Menunggu persetujuan · `scheduled` Terjadwal · `in_delivery` Dalam pengiriman · `completed` Selesai · `cancelled` Dibatalkan
- Rit `trip_status`: `assigned` Ditugaskan · `departed` Berangkat · `arrived` Tiba · `completed` Selesai · `failed` Gagal
- Setoran `deposit_status`: `running` Berjalan · `submitted` Diajukan · `received` Diterima · `closed` Ditutup
- Selisih `discrepancy_status`: `formed` Terbentuk · `explained` Dijelaskan · `approved` Disetujui · `rejected` Ditolak · `followed_up` Ditindaklanjuti · `done` Selesai
- Shift: `open` / `closed`; setoran shift `not_deposited` / `deposited` / `received`
- Faktur: `open` Terbuka · `partial` Sebagian dibayar · `paid` Lunas
- Periode: `open` · `closed` · `locked` · `reopened`
- Persetujuan: `submitted` · `approved` · `rejected` · `expired` · `cancelled`
- Perangkat: `registered` · `active` · `blocked` · `wipe_pending` · `wiped`
- Transfer masuk: `unmatched` Belum dicocokkan · `matched` Cocok · `not_found` Tidak ditemukan
- Notifikasi: `new` · `read` · `actioned` · `done`

## 5. Platform inti (`src/server/core/`)

| Komponen | Berkas | Tanggung jawab |
|---|---|---|
| DB & transaksi | `db.ts` | `withTx(fn)`, tipe `Tx` |
| Konteks & error | `context.ts`, `errors.ts` | `ActorContext`, `DomainError`, `ForbiddenError` |
| Waktu & tanggal bisnis | `src/lib/time.ts` | WIB, `toBusinessDate(date)`, jam layanan |
| Uang | `src/lib/money.ts` | format `Rp 1.250.000`, parse, pembulatan |
| Penomoran | `numbering.ts` | `nextNumber(tx, 'order', date)` → `P-27-000123` (baris terkunci per jenis+tahun) |
| Parameter | `params.ts` | `get(tx, key, date)`, `set(ctx, key, value, effectiveFrom, reason)` (hanya pemilik, berjejak; 6.2b); seed Lampiran B |
| Feature flag | `flags.ts` | per global/tenant/outlet/truk (PRD 2.1 "fitur dapat dimatikan per unit") |
| RBAC | `rbac/roles.ts`, `rbac/matrix.ts`, `rbac/authorize.ts` | katalog peran, matriks peran × izin (dapat diekspor, US-M10-03 KP-4), `authorize(ctx, perm)` + cek lingkup |
| Pemisahan tugas | `rbac/sod.ts` | aturan tetap US-M10-03 KP-1; kombinasi peran terlarang PTB-31; pelanggaran → tolak + log akses; > 3/hari → notifikasi pemilik |
| Jejak audit | `audit.ts` | `record(tx, {ctx, objectType, objectId, action, before, after, reason})`; tabel append-only; **hash berantai** (`prev_hash`, `hash`) + trigger DB tolak UPDATE/DELETE; `verifyChain()` |
| Log akses | `access-log.ts` | login, gagal login, perangkat, ekspor, penolakan |
| Persetujuan | `approvals/*.ts` | `submit(ctx, {type, objectRef, amount, reason, payload})`, `decide(ctx, id, 'approve'|'reject', reason)`, `expireDue()`; registri handler per jenis; tenggat & perilaku lewat tenggat per jenis (6.2a); pemohon ≠ penyetuju |
| Notifikasi | `notifications/*.ts` | `notify(tx, {event, recipients: {roles|userIds}, severity, objectRef, value, deadline, link})`; kanal in-app, web push, ringkasan e-mail; preferensi & jam tenang; kritis tidak bisa dimatikan |
| Event domain | `events.ts` | `emit(tx, type, payload)` → simpan `domain_events` + jalankan handler terdaftar **sinkron dalam transaksi yang sama** |
| Sinkron lapangan | `sync/*.ts` | `/api/sync/push` (batch perintah idempoten), `/api/sync/pull` (data referensi per lingkup), registri handler per `commandType` |
| Berkas | `storage.ts` | `put(blob) → attachment`; Vercel Blob (prod) / lokal (dev/test) |
| Ekspor | `export/*.ts` | `toExcel(reportDef, rows)`, `toPdf(reportDef, data)`; catat `export_logs` (BR-39: data pribadi hanya pemilik/Admin Keuangan + tujuan) |
| Pekerjaan terjadwal | `jobs.ts` | registri job per modul; `/api/cron/tick` menjalankan job yang jatuh tempo secara idempoten (`job_runs`) |
| WhatsApp | `wa.ts` | `buildWaLink(phone, template, vars)`; adaptor Cloud API (Tahap 2); catat "dibuka" |
| Peta & geo | `src/lib/geo.ts`, `maps.ts` | haversine, jarak × 1,3, zona, geofence |
| Jurnal otomatis | `ledger.ts` | `postJournal(tx, {date, source, ref, lines})` — cek debit=kredit, periode terbuka (lewat → periode terbuka pertama + penanda asal), antrean bila pemetaan hilang. Dipakai M11 lewat event. |

## 6. Autentikasi, perangkat & sesi (US-M10-02, Bab 6.5)

- **Web kantor**: username + kata sandi (≥ 10 karakter, argon2/bcrypt) → bila peran `owner`/`finance_admin`/`system_admin`
  wajib **TOTP** (otplib). Sesi di tabel `sessions` (token acak, disimpan sebagai hash) + cookie `equa_session`
  httpOnly/secure/sameSite=lax. Kedaluwarsa tidak aktif 30 menit & maksimal 12 jam (PAR-46). Nonaktif akun → semua sesi dicabut.
- **Perangkat lapangan/POS**: admin sistem mendaftarkan perangkat → kode aktivasi 8 karakter (berlaku 24 jam) → di
  ponsel buka `/aktivasi-perangkat` → perangkat menerima `deviceId` + `deviceSecret` (disimpan di IndexedDB; server
  menyimpan hash). Setiap permintaan lapangan membawa token perangkat (JWT `jose` ditandatangani dengan secret perangkat).
- **PIN**: 6 digit, ditetapkan pengguna pada aktivasi pertama di hadapan admin sistem; server menyimpan hash argon2;
  perangkat menyimpan *verifier* (PBKDF2 + salt, bukan PIN) agar **login PIN offline** (US-M10-02 KP-5). 5 kali salah →
  kunci 15 menit (PAR-36); layar terkunci setelah 10 menit tidak aktif (PAR-37).
- Perangkat `blocked` → semua permintaan ditolak; `wipe_pending` → respons berikutnya memerintahkan klien menghapus
  IndexedDB lalu status `wiped`. Antrean yang hilang dicatat sebagai kejadian.
- Pergantian pengguna di perangkat yang sama tidak menghapus antrean pengguna lain (data per `userId` di IndexedDB).
- Proxy Next.js (`src/proxy.ts`, pengganti middleware di Next 16) hanya melakukan pengecekan cookie ringan; otorisasi
  sebenarnya selalu di lapisan layanan.

## 7. Offline-first & sinkron (Bab 6.4, NFR-06..08)

- Klien menyimpan **outbox** di Dexie: `{ id: uuidv7, type, payload, userId, deviceTime, businessDate, attachments[], status: 'queued'|'sent'|'rejected' }`.
- Worker sinkron: saat daring, kirim batch ≤ 50 ke `POST /api/sync/push`; lampiran diunggah dulu lewat `POST /api/sync/upload`
  (idempoten per `attachmentId`). Server memproses berurutan; hasil per perintah: `applied` / `duplicate` (sudah pernah) /
  `rejected` (alasan Indonesia) / `conflict`. Tabel `sync_commands` menjamin idempotensi (PK = id klien).
- Pemicu: setiap perubahan status jaringan (`online`), interval 60 detik, tombol "Kirim sekarang". Target ≤ 5 menit (PAR-30).
- `GET /api/sync/pull?since=cursor` → data referensi sesuai lingkup (rit hari ini + catatan pelanggan + faktur terbuka
  pelanggan hari itu + harga + katalog + resep + stok + template struk) dan status objek (mis. setoran Ditutup → buka kunci rit).
- **Lapangan tidak pernah ditimpa kantor**: perintah lapangan yang bertabrakan dengan perubahan kantor (mis. rit ditarik
  tetapi sudah dikerjakan offline) tetap sah, ditandai `conflict`, dan tampil ke Dispatcher/Admin Keuangan.
- Waktu perangkat dipakai sebagai waktu transaksi; selisih jam > 10 menit (PAR-42) ditandai.
- Foto dikompresi di perangkat ≤ 300 KB (PAR-38) dengan canvas sebelum masuk antrean.
- Laporan kesehatan perangkat (jumlah antrean, versi, baterai) dikirim bersama push → halaman "Perangkat & sinkron" (US-M10-07).

## 8. Event domain (katalog awal — nama WAJIB sama)

`trip.published` · `trip.departed` · `trip.arrived` · `trip.completed` · `trip.failed` · `trip.payment_recorded` ·
`collection.recorded` · `trip.expense_recorded` · `expense.verified` · `deposit.submitted` · `deposit.received` ·
`deposit.closed` · `discrepancy.formed` · `discrepancy.decided` · `transfer.matched` · `transfer.not_found` ·
`bank_deposit.recorded` · `office_cash.moved` · `petty_cash.recorded` · `cash_day.closed` · `invoice.issued` ·
`invoice.paid` · `credit_note.issued` · `payment.reversed` · `credit_status.changed` · `shift.opened` · `shift.closed` ·
`pos_sale.recorded` · `pos_sale.voided` · `consumable.usage_posted` · `consumable.received` · `stock.adjusted` ·
`internal_transfer.sent` · `internal_transfer.received` · `purchase_receipt.recorded` · `supplier_payment.recorded` ·
`water_supply.confirmed` · `meter.reading_recorded` · `truck_fill.recorded` · `water_balance.computed` ·
`restitution.recorded` · `restitution.settled` · `approval.decided` · `fleet_event.detected` · `period.closed` ·
`period.locked` · `asset.depreciated` · `partner.subscription_invoiced` · `digital_payment.succeeded`

Payload tiap event diketik di `src/server/core/events.types.ts`. Modul menambah event baru hanya dengan menambah entri
di berkas itu (tambahan, tidak mengubah yang ada). M11 berlangganan event keuangan untuk jurnal otomatis (PRD 7.11.4);
M9 membaca data, tidak berlangganan.

## 9. Peta rute web kantor (URL berbahasa Indonesia)

| Modul | Rute |
|---|---|
| Beranda per peran | `/beranda` |
| M1 | `/master/pelanggan`, `/master/produk`, `/master/zona`, `/master/armada`, `/master/depot`, `/master/sumber-air`, `/master/pool`, `/master/karyawan`, `/master/impor` |
| M2 | `/pesanan`, `/pesanan/baru`, `/pesanan/[id]`, `/jadwal` (papan), `/jadwal/kru`, `/langganan` |
| M3 (kantor) | `/sopir-kantor/dicatat-kantor` (pencatatan darurat "dicatat kantor") |
| M4 | `/kas` (kas hari ini), `/kas/setoran`, `/kas/selisih`, `/kas/transfer`, `/kas/kantor`, `/kas/kas-kecil`, `/kas/tutup`, `/kas/ganti-rugi` |
| M5 | `/piutang`, `/piutang/faktur`, `/piutang/pelunasan`, `/piutang/umur`, `/piutang/pengingat`, `/piutang/faktur-bulanan`, `/piutang/saldo-awal` |
| M6/M7 (kantor) | `/outlet`, `/toko/barang`, `/toko/pemasok`, `/toko/pembelian`, `/toko/opname`, `/toko/pesan-ulang`, `/toko/utang` |
| M8 (kantor) | `/produksi/neraca-air`, `/produksi/utilisasi`, `/produksi/mutu` |
| M9 | `/laporan/hari-ini` (H+0), `/laporan/bulanan`, `/laporan/katalog`, `/laporan/kinerja`, `/laporan/tren`, `/laporan/kpi`, `/kotak-masuk` |
| M10 | `/akses/pengguna`, `/akses/peran`, `/akses/perangkat`, `/akses/sinkron`, `/akses/tinjauan`, `/akses/data-pribadi`, `/audit`, `/persetujuan`, `/notifikasi`, `/pengaturan/parameter`, `/pengaturan/notifikasi`, `/bantuan` |
| M11 | `/akuntansi/akun`, `/akuntansi/pemetaan`, `/akuntansi/jurnal`, `/akuntansi/buku-besar`, `/akuntansi/laporan`, `/akuntansi/aset`, `/akuntansi/rekonsiliasi`, `/akuntansi/periode`, `/akuntansi/pajak`, `/akuntansi/saldo-awal` |
| M12 | `/armada/peta`, `/armada/riwayat`, `/armada/kejadian` |
| RL-7 / Tahap 3 | `/kemitraan/*` (kantor), `/mitra/*` (portal) |

Navigasi dirender dari registri `src/components/shared/nav/registry.ts` (sudah memuat semua entri + izin yang dibutuhkan).

## 10. Uji

- `tests/helpers/db.ts`: PGlite in-memory per berkas uji, skema didorong dari `src/db/schema` (drizzle-kit `pushSchema`
  atau migrasi hasil generate), seed minimal. **Tidak ada layanan eksternal**.
- `tests/helpers/factories.ts`: pembuat data (pelanggan, truk, pesanan, rit, pengguna per peran…).
- Judul uji memuat ID: `it('US-M2-05 KP-2 menolak tempo bila eksposur > batas', …)`. `tools/trace-check.ts` menghitung
  cakupan KP per user story dari judul uji.
- E2E Playwright (`e2e/`) untuk skenario P-01..P-07 dan offline (mode pesawat via `context.setOffline(true)`).

## 11. Aturan kerja paralel (worktree)

- Setiap agen modul hanya menulis di: `src/server/modules/<modulnya>/`, `src/app/**/<rute modulnya>/`,
  `src/db/schema/<modulnya>.ts`, `tests/<modulnya>/`, `e2e/<modulnya>*`, `src/client/<modulnya>/`,
  `src/components/<modulnya>/`, `docs/guides/<modulnya>*`.
- Berkas bersama (`core/*`, `schema/core.ts`, `events.types.ts`, `nav/registry.ts`, `labels.ts`, `rbac/matrix.ts`) hanya
  boleh **ditambah** (append) — jangan ubah/rename yang ada. Sebutkan setiap perubahan berkas bersama di laporan akhir.
- Migrasi: saat pengembangan dipakai `db:push`; migrasi SQL produksi dibangkitkan satu kali saat integrasi.
- Commit di cabang modul (`mod/<modul>`), jangan push. Orkestrator menggabungkan & mendorong.
