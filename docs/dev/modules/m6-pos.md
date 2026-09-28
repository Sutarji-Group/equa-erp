# M6 — Penjualan Depot / POS multi-tenant (catatan pengembang)

Kode: `src/server/modules/m6-pos/` (API publik HANYA `index.ts`), klien `src/client/m6-pos/` (kontrak data + reducer
optimistis), UI PWA `src/app/(field)/pos/page.tsx` + `src/components/m6-pos/**`, UI kantor `src/app/(office)/outlet/**`,
uji `tests/m6-pos/**`, E2E `e2e/m6-pos.spec.ts` + `e2e/m6-pos.mobile.spec.ts`, seed demo `src/db/seed/demo-m6-pos.ts`.
PRD 7.6 (US-M6-01..07), 6.2a, PTB-40/43, BR-08/15/38, NFR-30, Lampiran B PAR-02/03/04/15/21/27/57/58/59/61.

## 1. Kerangka POS & titik perluasan (untuk M7 toko)

Satu mesin POS untuk semua outlet (`service/*.ts`). Perilaku per jenis outlet dipasang lewat `PosKindPolicy`
(`service/policy.ts`); depot (`depotPolicy`) terpasang bawaan.

```ts
registerPosKindPolicy({
  kind: "store", label: "Toko", depositSourceType: "store_shift", stockCountKind: "...",
  permissions: { saleCreate: "m7.pos_sale.create", saleVoid: "m7.pos_sale.void", saleCorrect: "...", shiftOpen: "m7.shift.open",
                 shiftClose: "m7.shift.close", shiftRead: "...", shiftDeposit: "m7.shift_deposit.create",
                 stockCount: "m7.stock_count.create", stockAdjustment: "...", consumableReceipt: "..." },
  priceKind: ({ customerId }) => (customerId ? "partner" : "general"),
  acceptsCustomer: true, productLine: "store",
  validateSale, afterSaleRecorded, afterSaleVoided, onShiftClosing, // kait opsional
});
```

- Panggil dari `registerSync()` M7. JANGAN mendaftarkan ulang persetujuan `pos_void`/`stock_adjustment` (satu handler
  per jenis — milik kerangka ini; handler memanggil kait `afterSaleVoided` kebijakan outlet).
- Perintah sinkron `m6.*` sudah menerima izin `m7.*` (shift, transaksi, void, setoran, opname) → toko memakai perintah
  & pull provider yang sama (`m6.pos`, peran `store_cashier`).
- Primitif stok: `postStockMovement(tx, { tenantId, outletId, productId, kind, quantity, unitCost?, businessDate,
  occurredAt, source, createdBy, note? })` — kartu stok append-only + saldo & HPP rata-rata bergerak (`stock_balances`).

## 2. Kontrak untuk modul lain

| Pemakai | Fungsi / event | Catatan |
| --- | --- | --- |
| M4 kas | `isShiftFullySynced(tx, shiftId)` / `shiftSyncStatus(tx, shiftId)` | WAJIB diperiksa sebelum menerima setoran shift (US-M6-06 KP-3): perangkat melaporkan daftar transaksi/void saat tutup (`summary.device`); `missingSaleIds`/`missingVoidIds` belum tersinkron → tolak terima. |
| M4 kas | baris `deposits` | M6 membuat setoran akhir shift (`source_type depot_shift`, `is_partial=false`, status `submitted`, `expected_cash = tunai − kas awal tetap − Σ sebagian`) dan setoran sebagian (`is_partial=true`, slip wajib). Serah fisik/slip oleh operator (`m6.shift_deposit.submit`) → `shifts.deposit_status = deposited`. M4 memancarkan `deposit.received` → M6 menandai `received`. |
| M4/M5/M9 | event `shift.closed` | Payload lengkap (tambahan opsional di `events.types.ts`): per cara bayar, QRIS, void (+menunggu), setoran, selisih kas & alasan, penjualan per produk, galon, pemakaian bahan (nilai), `syncConflict`. |
| M5 jurnal | `pos_sale.recorded`, `pos_sale.voided` (`afterClose`, `reversalId`), `consumable.usage_posted`, `stock.adjusted`, `consumable.received`, `internal_transfer.received`, `water_supply.confirmed` | Nilai pemakaian = HPP rata-rata bergerak; pembalik setelah tutup punya `reversalId`. |
| M3 rit | event `trip.completed` yang DIHARAPKAN: `{ tripId, isInternal, destinationOutletId, volumeL, completedAt }` | Rit internal ke depot → pasokan "Tiba" (idempoten per `tripId`). |
| M8/M11 | `waterBalancesFor(tx, tenantId, from, to, outletIds?)`, `transferValueFor` | Neraca air depot (galon × ukuran ≤ stok awal + diterima; PAR-59). |
| M9/P3 | `dailyOutletReport`, `voidReport`, `usageVsSalesReport`, `stockCardReport`, `waterBalanceReport`, `waterSupplyReport`, `shiftReport`, `salesReport`, `stockCountReport`, `listTenantOutlets` | Semua `ctx`-first, berlingkup tenant pelaku; izin `m6.outlet.read` ATAU `p3.partner_report.read`. |
| M10 | `createPartnerTenant`, `listTenants`, `copyStandardCatalog` | Tenant mitra + outlet + salinan katalog standar (produk depot, harga standar, resep). |

Fungsi layanan lapangan dipanggil HANYA lewat handler sinkron (`toFieldWriteMeta(meta)` → `FieldWriteMeta`).

## 3. Perintah sinkron (offline, `sync.ts`) & pull

| Perintah | Payload ringkas | Catatan |
| --- | --- | --- |
| `m6.shift.open` | `{ shiftId, openingCashCounted, openingNote?, outletId? }` | Shift lain terbuka → disimpan sebagai **konflik** (`sync_conflict`), notifikasi FA `pos.shift_conflict`. |
| `m6.pos_sale.create` | `{ saleId, shiftId, localNumber, deviceSeq, lines[{productId,quantity,unitPrice}], paymentMethod cash/qris, cashReceived?, qrisReference?, replacesSaleId? }` | Nomor resmi `Dxx-YYMMDD-NNNN` saat sinkron (tanggal bisnis perangkat); harga perangkat ≠ master → `price_mismatch` (tidak ditolak). Kas > PAR-02 → `outlet_cash.over_limit`. |
| `m6.pos_sale.void` | `{ saleId, reason, note? }` | ≤ PAR-04 → langsung void; > PAR-04 → `void_pending` + persetujuan `pos_void`. > PAR-03/hari → `pos.excessive_voids`. Void QRIS → `pos.qris_voided`. |
| `m6.shift_deposit.partial` | `{ depositId, shiftId, amount, note? }` + lampiran `bank_slip` | Slip wajib. |
| `m6.shift.close` | `{ shiftId, closingCashCounted, cashDifferenceReason?, stock[{productId, physicalQty, reason?, deviceExpectedQty?}], saleIds, voidedSaleIds, deviceExpectedDrawer? }` | Shift belum ada di server → galat biasa (retry). Selisih tanpa alasan ditolak, KECUALI angka perangkat tidak berselisih (diterima + catatan konflik). |
| `m6.shift_deposit.submit` | `{ shiftId, method physical/bank_slip, note? }` (+slip) | Serah setoran akhir. |
| `m6.water_supply.confirm` | `{ receiptId, receivedVolumeL, reason? }` | Selisih > PAR-59% wajib alasan → `water_supply.discrepancy` ke dispatcher. |
| `m6.water_supply.record_other` | `{ receiptId, volumeL, reason, sourceNote? }` | Pasokan darurat sumber lain. |
| `m6.consumable_receipt.create` | `{ receiptId, source supplier/other, supplierId?, supplierName?, supplierNoteNumber?, lines[{productId, quantity, unitCost?}], notes? }` (+foto nota) | Pemasok: nomor nota + foto wajib. |
| `m6.internal_transfer.receive` | `{ transferId, receiptId, lines[{lineId, quantityReceived, reason?}] }` | Transfer internal dari toko (tabel M7 `internal_transfers`). |
| `m6.stock_count.submit` | `{ stockCountId, lines[{productId, physicalQty, reason? (rusak/hilang/salah catat/lainnya), reasonNote?}], notes? }` | Sistem saat hitung = saldo − pemakaian shift berjalan sampai jam hitung. Selisih → persetujuan `stock_adjustment`. |

Pull provider `m6.pos` (peran `depot_operator`, `store_cashier`): `PosReference` (`src/client/m6-pos/contract.ts`) —
outlet, pengaturan (PAR-02/03/04/57/58, grid, QRIS/printer), shift terbuka + transaksinya, shift konflik, shift terakhir,
bahan & saldo, resep, air (stok, kapasitas, pasokan menunggu), transfer masuk, opname minggu ini, riwayat 90 hari,
void hari ini. Katalog/harga dari pull `m1.catalog`. Reducer optimistis `applyPosCommand` (murni) menerapkan antrean di
atas pull terakhir; angka shift di perangkat `deviceShiftFigures`.

## 4. Persetujuan (`approvals.ts`)

| Jenis | Objek | Efek disetujui | Ditolak / lewat tenggat |
| --- | --- | --- | --- |
| `pos_void` | `pos_sale` | shift masih terbuka → `voided`; sudah ditutup → notifikasi FA `pos.void_reversal_needed`, FA membuat pembalik (`reverseSaleAfterClose`) | kembali `valid` (tetap dihitung). Tenggat = tanggal bisnis shift pukul `m6.pos_rules.void_approval_deadline_time` (23:59). |
| `stock_adjustment` | `stock_count` | kartu stok `adjustment` per baris selisih (nilai HPP), `stock.adjusted` | saldo tetap; tenggat 3 hari → eskalasi (inti) |

Pembalik tanpa persetujuan hanya ≤ PAR-21; di atasnya WAJIB ada persetujuan void pemilik (lihat §9).

## 5. Notifikasi (tambahan `notifications/catalog.ts`)

`pos.qris_voided` (FA), `pos.void_reversal_needed` (FA, tinggi), `water_supply.discrepancy` (dispatcher),
`pos.shift_conflict` (FA, tinggi), `tenant.created` (pemilik). Memakai yang ada: `outlet_cash.over_limit`,
`pos.excessive_voids`, `water_supply.unconfirmed`, `outlet.water_balance_exceeded`, `stock_count.overdue`,
`deposit.depot_late`.

## 6. Parameter

PAR-02, 03, 04, 15, 21, 27, 57, 58, 59, 61 (Lampiran B; lingkup tenant/outlet lewat `params.get(..., { tenantId,
outletId })`). Non-PAR `m6.pos_rules` (tambahan `params-registry.ts`): `void_approval_deadline_time` "23:59",
`operator_history_days` 90, `grid_max_products` 12, `max_sale_lines` 20, `max_quantity_per_line` 999. Ambang per outlet
diatur pemilik di `/outlet/[id]?tab=pengaturan` (`setOutletThreshold` → `params.set` lingkup outlet).

## 7. Pekerjaan terjadwal (`jobs.ts`, idempoten)

`m6.stock_count.weekly_check` Minggu 20.00 · `m6.water_balance.weekly` Senin 06.15 · `m6.water_balance.monthly` tgl 1
06.20 · `m6.deposit.late_check` harian 08.10 (PAR-27).

## 8. Laporan ekspor (`reports.ts`, `/api/export/<kunci>?format=xlsx|pdf&from&to&outletId`)

`m6.outlet_daily`, `m6.shifts`, `m6.pos_sales`, `m6.voids`, `m6.usage_vs_sales` (`granularity week|month`),
`m6.stock_card` (`outletId` wajib), `m6.stock_counts`, `m6.water_supply`, `m6.water_balance`. Izin `m6.outlet.read`.

## 9. Rute UI

- PWA: `/pos` (FieldGate + PIN; menu Jual, Shift & void, Pasokan air, Stok bahan, Riwayat + antrean data).
- Kantor: `/outlet` (pemantauan per outlet, konflik shift), `/outlet/[id]` (`?tab=ringkasan|shift|transaksi|stok|air|
  opname|pengaturan`), `/outlet/shift/[id]` (angka, status sinkron, pembalik FA), `/outlet/laporan`
  (`?tab=harian|void|pemakaian|air|pasokan|shift|opname`), `/outlet/tenant` (izin `m10.tenant.read`; buat tenant
  mitra `m10.tenant.create`). Izin baru: `m6.shift_conflict.resolve` (FA).

## 10. Keputusan desain

1. **Transaksi dihitung** = pembalik ATAU status `valid`/`void_pending` ATAU `voided` yang sudah punya pembalik.
   Void menunggu persetujuan tetap dihitung sampai disetujui (6.2a).
2. **Tenggat void** = akhir tanggal bisnis shift (bukan jam tutup shift) agar persetujuan setelah tutup masih mungkin
   (PTB-43); disetujui setelah tutup → pembalik oleh FA pada tanggal koreksi, shift asal tidak diubah.
3. Pemakaian bahan & penjualan galon (buku air) diposting **per shift saat tutup** (sumber `shift`); transaksi yang
   tersinkron setelah shift ditutup & void setelah tutup diposting per transaksi.
4. Stok air = Σ buku air − liter galon shift terbuka. Pasokan "Tiba" sebelum shift dibuka dan belum dikonfirmasi saat
   tutup → diterima otomatis sesuai volume sopir (PAR-61); konfirmasi yang datang kemudian → penyesuaian selisih.
5. Data lapangan **tidak ditolak** bila bisa dihindari: shift ganda = konflik, harga beda = ditandai, selisih yang
   tidak terlihat di perangkat = diterima + catatan konflik untuk FA.
6. Isolasi tenant (NFR-30): layanan membandingkan `outlet.tenantId` dengan `ctx.tenantId` (NotFound), pull memeriksa
   tenant perangkat/pengguna/outlet, laporan berlingkup tenant pelaku.
7. Nomor lokal perangkat `Dxx-YYMMDD-<kode perangkat>-NNNN` dipertahankan di samping nomor resmi.

## 11. Belum / terbuka

- Koreksi > PAR-21 tanpa persetujuan void ditolak; jenis persetujuan bersama `correction` perlu satu handler lintas
  modul (belum ada) — dicatat untuk integrasi.
- M10 `createUser`/`registerDevice` perlu mendukung tenant mitra (sekarang memakai tenant pelaku) agar operator &
  tablet mitra dapat dibuat dari UI.
- M4 wajib memanggil `isShiftFullySynced` dan membentuk selisih dari `shift.closed`/`deposits`. Job
  `m6.deposit.late_check` dapat tumpang tindih dengan job keterlambatan setoran M4 — satukan saat integrasi.
- M3 harus memancarkan `trip.completed` dengan `isInternal`, `destinationOutletId`, `volumeL`, `completedAt`.
- Belum ada layar kantor untuk stok air awal depot (seed demo mengisi D02/D03).
- Portal pemilik mitra (P3) sebaiknya memakai fungsi laporan M6 di atas (izin `p3.partner_report.read` sudah diterima).
- Seed demo menulis langsung (tanpa event): modul lain tidak menerima `shift.closed` untuk shift demo D02.
