# M7 — Penjualan Toko & Stok (catatan pengembang)

Kode: `src/server/modules/m7-store/` (API publik HANYA `index.ts`), klien `src/client/m7-store/` (kontrak data, aturan
perangkat, reducer optimistis), UI POS mode toko `src/components/m7-store/store-*.tsx` + `pos-entry.tsx` (dipasang di
`src/app/(field)/pos/page.tsx`), UI kantor `src/app/(office)/toko/**` (+ `src/components/m7-store/office.tsx`), uji
`tests/m7-store/**`, E2E `e2e/m7-store.spec.ts` (kantor) + `e2e/m7-store.mobile.spec.ts` (tablet), seed demo
`src/db/seed/demo-m7-store.ts`. PRD 7.7 (US-M7-01..09), BR-17/18/27/28/38, PTB-37/42/46, Lampiran B PAR-14/21/57/66/67.

## 1. Arsitektur singkat

- **Satu aplikasi POS** (D-07, 7.7.2): `PosEntry` memilih layar dari `ref.outlet.kind` — `store` → `StorePosScreen`
  (M7) di atas kerangka M6 (`PosProvider`, shift, void, setoran, antrean offline). Kasir toko HANYA lewat POS.
- **Kebijakan toko** `storePolicy` (`service/policy.ts`) dipasang `registerSync()` lewat `registerPosKindPolicy` (B-05):
  izin `m7.*`, harga umum/mitra (BR-18), cara bayar `cash/qris/credit`, diskon per transaksi, stok barang toko
  (`sale`/`sale_void` di kartu stok, HPP rata-rata per baris `pos_sale_lines.unit_cost`), pesan ulang, tempo.
- **Penjualan menunggu persetujuan** (`pending_approval`): diskon > PAR-14 (`store_discount`) dan tempo di luar kontrol
  kredit (`store_credit_sale`, jenis BARU). Tidak dihitung, tanpa stok/event sampai SEMUA persetujuan terkait disetujui
  (`completePendingSale`); ditolak/kedaluwarsa/tutup shift → `rejected` (`onShiftClosing` membatalkan persetujuan
  terbuka lewat `systemContext`).
- **Tempo offline** (PTB-42): diterima + `credit_offline=true` + notifikasi `store.credit_offline_review` (FA).
- **Retur** (PTB-46): hari/shift yang sama = void POS; setelahnya `recordStoreReturn` (FA; > PAR-21 → `correction`
  objek `store_return`) → stok `correction` (HPP saat jual) + event `store_return.recorded`.

## 2. Perluasan M6 (minimal; dilaporkan)

| Berkas | Tambahan |
| --- | --- |
| `m6-pos/service/policy.ts` | `PosSaleDecision` (status `pending_approval`, `creditOffline`, `conflict`, `approvals[]`), `PosSaleValidateArgs` (input, subtotal, diskon, total, meta); kait `afterSalePending`, `resolvePriceKind`, `paymentMethods`, `allowsDiscount`; `afterSaleRecorded` boleh mengembalikan `{ payload }` tambahan event. |
| `m6-pos/service/sales.ts` | Skema `m6.pos_sale.create`: `paymentMethod credit`, `discountAmount/discountReason`, `requestApproval`, `creditOffline` (hanya bila kebijakan outlet mengizinkan — depot tetap menolak). Status tertunda; `completePendingSale`, `rejectPendingSale`; efek penjualan dipusatkan di `applySaleEffects`. |
| `m6-pos/index.ts` | Ekspor tipe & fungsi di atas. |
| `client/m6-pos/contract.ts`, `optimistic.ts` | Payload penjualan toko + teks status tertunda/ditolak. |
| `components/m6-pos/pos-app.tsx` | `PosScreen` diekspor (dipakai `PosEntry`). |
| `app/(field)/pos/page.tsx` | Merender `PosEntry` (depot → layar M6 apa adanya). |

## 3. Kontrak untuk modul lain

| Pemakai | Fungsi / event | Catatan |
| --- | --- | --- |
| **M4 kas** | `storeShiftsBlockingCashClose(tx, tenantId, businessDate)` | WAJIB dipanggil saat tutup kas harian (US-M7-09 KP-3): shift toko hari itu yang masih terbuka → tolak tutup kas. |
| M4 kas | baris `deposits` `source_type store_shift` | Sama dengan depot (M6). |
| M4 kas | `supplier_payment.recorded` (`method cash/transfer`, `bankAccountId`, `reversalOfId`, `allocations`) | Pembayaran pemasok kas kantor/transfer → M4 membuat mutasi kas kantor/bank; `supplier_payments.office_cash_movement_id` diisi M4. |
| **M5 piutang** | `pos_sale.recorded` `method=credit`, `outletKind=store`, `customerId`, `paymentTermDays` | Terbitkan **faktur per transaksi** (US-M7-04 KP-2) dan isi `pos_sales.invoice_id`; POS menampilkan nomor faktur dari pull (`recentSales.invoiceNumber`). |
| M5 piutang | `store_return.recorded` `{ storeReturnId, posSaleId, method, amount, cogs, lines, reason }` | Tempo → **nota kredit**; tunai/QRIS → pengembalian dana. |
| M5/M2 kredit | `storeCreditExposure(tx, customerId, amount)`, `uninvoicedStoreCredit` | Tempo toko yang belum difakturkan ikut eksposur; setelah M5 memfakturkan (invoice_id terisi) tidak dihitung ganda. |
| **M11 jurnal** | `purchase_receipt.recorded` (+`lines`, `dueDate`, `fromSubstituteNote`), `purchase_receipt.corrected`, `supplier_payment.recorded`, `internal_transfer.sent`, `stock.adjusted` (`outletKind store`), `pos_sale.recorded` (+`cogs`, `lineCosts`, `discountAmount`, `priceKind`), `store_return.recorded` | Nota pengganti TIDAK dijurnal sebelum diterima (event terbit saat diterima). |
| M9 laporan | `productPerformance`, `partnerPurchases`, `discountReport`, `transferReport`, `stockCountHistory`, `listPayables`, `listStoreItems`, `getReorderList` | Semua `ctx`-first, berlingkup tenant; ekspor lewat `/api/export/m7.*`. |
| M6 depot | `internal_transfers` (+lines `to_product_id`) | Diterima di POS depot (`m6.internal_transfer.receive`); `internal_transfer.received` → M7 memberi tahu FA bila selisih. |

## 4. Perintah sinkron (offline) & pull

| Perintah | Payload ringkas | Catatan |
| --- | --- | --- |
| `m6.pos_sale.create` (toko) | + `customerId?`, `paymentMethod credit`, `discountAmount?`, `discountReason?`, `requestApproval?`, `creditOffline?` | Pelanggan mitra wajib untuk tempo; stok kurang → ditolak. |
| `m7.purchase_receipt.create` | `{ receiptId, localNumber, deviceSeq, supplierId, isSubstitute, supplierNoteNumber?, supplierNoteDate?, dueDate?, lines[{productId,quantity,unitCost}], totalAmount, notes? }` + lampiran `receipt_note` / `goods_photo` | Nota wajib + foto; total ≠ jumlah baris ditolak; nota ganda ditolak; pengganti → `pending_acceptance`. |
| `m7.store_product.propose` / `m7.store_price.propose` / `m7.supplier.create` | lihat `src/client/m7-store/contract.ts` | Persetujuan FA (`store_product`, `supplier`). |
| `m7.reorder.mark_ordered` | `{ itemId, supplierId }` | |
| `m7.stock_count.count` | `{ stockCountId, lines[{productId, physicalQty, countedAt?, reason?, reasonNote?}] }` | Sistem = saldo PADA `countedAt` (US-M7-05 KP-3); jumlah sistem tidak dikirim ke perangkat (blind). |
| `m7.internal_transfer.create` | `{ transferId, localNumber, deviceSeq, toOutletId, lines[{productId,quantity}] }` | Hanya depot tenant sendiri; nilai harga mitra (PTB-37). |

Pull `m7.store` (peran `store_cashier`) → `StoreReference` (`src/client/m7-store/contract.ts`): pelanggan mitra +
eksposur, barang + saldo + harga, pemasok, depot, pesan ulang, opname berjalan, transaksi/penerimaan/transfer terakhir,
usulan. Reducer optimistis: `registerStoreOptimistic()`.

## 5. Registrasi

- Persetujuan (`approvals.ts`): `store_discount`, `store_credit_sale` → penjualan tertunda; `store_product` (objek
  `product`/`product_price`), `supplier`; `correction` objek `purchase_receipt` / `supplier_payment` / `store_return`.
- Event: handler `internal_transfer.received` → `m7-store:transfer_difference`.
- Job: `m7.stock_count.monthly_check` (07:05; opname bulan lalu belum ada setelah tanggal `stock_count_deadline_day`
  → `stock_count.overdue` ke pemilik), `m7.payable.due_reminder` (07:10; jatuh tempo ≤ N hari → `supplier_payable.due`
  FA, sekali per hari), `m7.reorder.sweep` (06:40).
- Laporan (`reports.ts`): `m7.reorder`, `m7.items`, `m7.stock_card`, `m7.purchases`, `m7.payables`,
  `m7.payables_aging`, `m7.supplier_payments`, `m7.suppliers`, `m7.stock_counts`, `m7.product_performance`,
  `m7.partner_purchases`, `m7.discounts`, `m7.internal_transfers`.
- Lampiran (`audit.ts`): akses baca `purchase_receipt`, `supplier_payment`.

## 6. Tambahan berkas bersama (append-only)

`labels.ts` (`approval_type.store_credit_sale`), `approvals/registry.ts` (`store_credit_sale`), `rbac/permissions.ts`
(`m7.report.read`, `m7.supplier.deactivate`, `m7.supplier_payment.reverse`), `notifications/catalog.ts`
(`store.substitute_note_pending`, `store.credit_offline_review`, `store.transfer_difference`), `params-registry.ts`
(`m7.store_rules`), `events.types.ts` (field opsional + event `store_return.recorded`), `nav/registry.ts` (`/toko/laporan`
+ rincian tersembunyi), `docs/nav-permissions.md`, `tests/core/events.test.ts`, `src/db/seed/index.ts` (panggil demo M7).

## 7. Kantor `/toko/*`

| Rute | Izin | Isi |
| --- | --- | --- |
| `/toko/barang`, `/toko/barang/[id]` | `m7.stock.read` | Saldo, harga umum/mitra, HPP, usulan menunggu, riwayat harga, kartu stok + ekspor. |
| `/toko/pemasok` | `m7.supplier.read` | Ubah kontak/tempo (FA), nonaktifkan beralasan. |
| `/toko/pembelian`, `/toko/pembelian/[id]` | `m7.purchase_receipt.read` | Daftar & rincian nota, terima nota pengganti, retur/pembalik, saldo awal utang. |
| `/toko/opname`, `/toko/opname/[id]` | `m7.stock_count.read` | Riwayat, ajukan penyesuaian (FA ≠ penghitung), stok awal cut-over + tanda tangan pemilik. |
| `/toko/pesan-ulang` | `m7.reorder.read` | Daftar + ekspor. |
| `/toko/utang` | `m7.supplier_payable.read` | Umur utang, nota terbuka, bayar (+bukti), balik pembayaran. |
| `/toko/laporan` | `m7.report.read` / `m7.product_performance.read` | Laris/mati & margin (pemilik), mitra, diskon, transfer, opname, retur pelanggan (FA). |

## 8. Uji & data demo

- Vitest `tests/m7-store/*.test.ts` — setiap KP bertanda `US-M7-0x KP-n`; toko uji baru per kasus (`makeStore`) agar
  tidak terpengaruh data demo TK1. `seed.test.ts` memeriksa konsistensi demo (saldo = Σ kartu stok, umur utang).
- Demo TK1: 3 pemasok, stok awal, 3 nota + saldo awal utang, nota pengganti menunggu, opname bulan lalu, transfer ke D03
  (Dikirim), shift kemarin (7 transaksi, diskon, tempo), 3 baris pesan ulang. Tanpa event (M5 belum memfakturkan tempo demo).
- E2E: `PORT=3107 PGLITE_DATA_DIR=./.data/pglite-e2e-m7-store pnpm test:e2e e2e/m7-store`.

## 9. Batasan / tindak lanjut

- US-M7-04 KP-5 (mitra depot EQUA, Tahap 3): memakai jalur tempo yang sama — pelanggan `is_equa_partner` + mitra toko
  (manual) dengan batas & tempo dari perjanjian di master pelanggan (M1). Belum ada tautan otomatis perjanjian → batas.
- Pesan sukses Server Action hilang bila formulirnya ikut hilang setelah revalidasi (mis. terima nota pengganti);
  status baru tetap terlihat di halaman (ringkasan/daftar).
- Nomor faktur tempo di struk bergantung M5 (`pos_sales.invoice_id`); sampai M5 ada, struk menulis "terbit setelah terkirim".
- Pembayaran pemasok belum membuat mutasi kas kantor/bank — M4 berlangganan `supplier_payment.recorded`.
- `docs/ARCHITECTURE.md` §8 perlu menambahkan `store_return.recorded` (berkas milik PM).
