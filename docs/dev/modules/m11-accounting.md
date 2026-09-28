# M11 — Akuntansi & Pajak (catatan pengembang)

Kode: `src/server/modules/m11-accounting/` (API publik HANYA `index.ts`; logika `service/*.ts`, tabel perlakuan
peristiwa `constants.ts`), UI kantor `src/app/(office)/akuntansi/**` (+ Server Actions `akuntansi/actions.ts`, unduhan
`akuntansi/pajak/ekspor/route.ts`), komponen `src/components/m11-accounting/*`, uji `tests/m11-accounting/**`, E2E
`e2e/m11-accounting.spec.ts`, seed `src/db/seed/demo-m11-accounting.ts`, panduan `docs/guides/m11-accounting.md`.
PRD 7.11 (US-M11-01..10), 7.11.4, Bab 6.2/6.3, BR-29..35, BR-38, PTB-12/39/44/45/47, Lampiran B PAR-20..23, 29, 57,
62..65, 71 + parameter non-PAR `accounting.cutover_date`, `m11.shared_cost_allocation`, `m11.accounting_rules`, flag
`accounting.m11_active`.

## 1. Arsitektur singkat

- **Jurnal otomatis** (`events.ts` → `service/engine.ts` → `auto-journals.ts` `specForEvent` → `posting.ts`
  `executeSpec`). Handler terdaftar untuk setiap `JOURNALED_EVENTS` (33 peristiwa) dan berjalan **tepat sebelum COMMIT**
  transaksi sumber (`onBeforeCommit`) di savepoint: atomik dengan sumbernya, tidak pernah menggagalkan transaksi
  lapangan (R04). Galat tak terduga → `journal_queue` alasan `other` + notifikasi `journal.queued`.
- **Gerbang** (`posting.ts gate`): tenant pembukuan (`tenants.kind = owner`; tenant mitra dilewati), flag
  `accounting.m11_active`, cut-over (`accounting.cutover_date` BERLAKU SAAT INI; peristiwa sebelum cut-over dilewati,
  tidak dimigrasi). Idempoten per `source_event_id` (kind `auto`).
- **Pemetaan**: `resolveMapping(event, entry, tanggal peristiwa)`; bila pada tanggal itu belum ada (antrean menunggu lalu
  pemetaan dilengkapi — berlaku ke depan), dipakai pemetaan yang berlaku `today` agar antrean dapat diselesaikan. Aturan
  pusat laba `fixed | from_outlet | from_source | split_internal`; akun pengganti per entri (akun buku rekening bank
  `bank_accounts.gl_account_id`). Pemetaan hilang / akun nonaktif → `journal_queue` (`mapping_missing` /
  `account_inactive`), satu baris menunggu per event; `saveMapping` memproses ulang antrean kunci peristiwa itu.
- **Pembalik** (void POS, pembalik pelunasan, setor bank dibalik, dsb.) = `ReversalSpec`: membalik jurnal otomatis objek
  sumber (kind `reversal`, baris ditukar). Jurnal asal tidak pernah diubah (hardening EQ003).
- **Jurnal non-otomatis** (manual, pembalik, akrual, penyusutan, alokasi, saldo awal) lewat `common.insertJournal`:
  seimbang, akun aktif & detail, cut-over (kecuali `opening_balance`), periode `strict` (harus terbuka) atau `forward`
  (periode terbuka pertama + `origin_period`), nomor `J-YYMM-NNNNN`.
- **Laporan** (`statements.ts`) dihitung per PERIODE POSTING (peristiwa terlambat yang masuk periode berikutnya tidak
  mengubah laporan periode terkunci). Laba rugi per lini `centers[pc] = {revenue, beforeAllocation, allocationL1,
  allocationShared, net}`; akun alokasi dari pemetaan `m11.allocation`; eliminasi = akun `is_internal_transfer` + jurnal
  dengan sumber `INTERNAL_TRANSFER_SOURCES`. Final = `report_snapshots` (`m11.statements`, `scope_key` period|ytd) saat
  dikunci; revisi baru menggantikan (`superseded_by_id`), lama tetap tersimpan.
- **Periode** (`periods.ts`): prasyarat → tutup (FA; penyusutan diposting dulu; terlambat bila > PAR-23) → persetujuan
  `period_lock` → dikunci (pemilik) → buka kembali (pemilik, alasan ≥ 10 karakter, revisi + 1, notifikasi akuntan).

## 2. API publik (`index.ts`)

| Area | Fungsi |
| --- | --- |
| Bagan akun & pemetaan | `listAccounts`, `listProfitCenters`, `accountOptions`, `createAccount`, `updateAccount`, `deactivateAccount`, `reactivateAccount`, `importChartOfAccounts`, `listMappings`, `saveMapping`, `mappingCompleteness`, `setAccountingActive` |
| Jurnal otomatis | `processEvent`, `specForEvent`, `JOURNALED_EVENTS`, `isJournaledEvent`, `listJournalQueue`, `retryJournalQueueItem`, `retryAllJournalQueue`, `retryPendingQueue`, `pendingQueueCount`, `generateRetroactiveJournals`, `verifyRetroactiveRun`, `listRetroactiveRuns`, `dailyReconciliation(Tx)` |
| Jurnal & ketertelusuran | `listJournals`, `getJournalDetail`, `journalsForSource`, `sourceLink`, `formOptions`, `openManualJournals` |
| Jurnal manual | `createManualJournal`, `attachJournalEvidence`, `submitManualJournal`, `cancelManualJournal`, `reverseManualJournal`, `ownerReviewList`, `markManualJournalsReviewed`, `listRecurringJournals`, `saveRecurringJournal`, `generateRecurringDraftsNow`, `runRecurringDrafts`, `runAccrualReversals`, `manualTemplates`, `manualJournalSchema` |
| Laporan | `getStatements`, `getLedger`, `loadStatements`, `compute*`, `finalVersions`, `accountBalanceAt`, `allocationStatus`, `runCostAllocation`, `setSharedCostKey`, `splitByWeights` |
| Aset | `assetRegister`, `assetDetail`, `createAsset`, `importAssets`, `signAssetRegister`, `updateAssetEstimate`, `disposeAsset`, `runDepreciation`, `runMonthlyDepreciation`, `monthlyDepreciation`, `depreciationStart` |
| Rekonsiliasi | `reconciliationOverview`, `saveBankReconciliation`, `saveCashReconciliation`, `reconciliationHistory`, `ADJUSTING_LABELS` |
| Utang | `payablesView`, `runJournalPayableReminders`, `PAYABLE_AGING_LABELS` |
| Pajak | `taxOverview`, `monthlyRevenueReport`, `setTaxScheme`, `pkpStatus`, `runPkpMonitor`, `listExportTemplates`, `saveExportTemplate`, `exportWithTemplate`, `EXPORT_FIELDS` |
| Saldo awal | `openingOverview`, `setCutoverDate`, `prefillOpeningGroup`, `saveOpeningBatch`, `signOpeningBatch`, `attestOpeningBalances`, `postOpeningBalances`, `requestOpeningAdjustment`, `OPENING_GROUPS` |
| Periode | `listPeriods`, `periodDetail`, `closePeriod`, `lockPeriod`, `reopenPeriod`, `addPeriodReviewNote`, `periodPrerequisites`, `runPeriodReminders` |

**Kontrak untuk modul lain** (tanpa otorisasi, dalam transaksi pemanggil): `pkpStatus(tx, tenantId, date)` (dasbor M9,
US-M11-08 KP-4), `dailyReconciliationTx(tx, tenantId, date)`, tautan jurnal suatu transaksi
`/akuntansi/jurnal?sumberTipe=<objectType>&sumberId=<id>`.

## 3. Event

### 3.1 Didengar M11 (`events.ts`, nama handler `m11-accounting:journal:<type>`)
`trip.completed` (tunai/transfer/tempo+kurang bayar; rit internal dilewati → `water_supply.confirmed`), `trip.corrected`,
`trip_payment.reversed`, `trip_expense.reversed`, `collection.recorded` (reklasifikasi dilewati), `expense.verified`,
`deposit.received` (selisih kurang per pusat laba sumber; lebih → pendapatan lain; `bank_slip` → akun bank),
`discrepancy.decided` (ditolak + ganti rugi → piutang karyawan), `discrepancy.reopened`, `transfer.matched`
(kecuali `bank_deposit_slip`), `bank_deposit.recorded/reversed`, `office_cash.moved` (hanya penyesuaian hitung fisik
bersumber selisih), `petty_cash.recorded`, `restitution.settled`, `restitution.settlement_reversed`, `credit_note.issued`
(`underpayment_conversion`/`pending_transfer_resolved` dilewati; retur/void hanya bagian terbayar → uang muka),
`payment.reversed`, `customer_advance.refunded`, `pos_sale.recorded` (depot L3 per outlet; toko L4 + diskon + HPP),
`pos_sale.voided`, `store_return.recorded`, `consumable.usage_posted/received/receipt_reversed`, `stock.adjusted`,
`internal_transfer.sent`, `purchase_receipt.recorded` (saldo awal utang dilewati), `purchase_receipt.corrected`,
`supplier_payment.recorded`, `water_supply.confirmed` (transfer internal L2 → L3), `partner.subscription_invoiced` (L5),
`digital_payment.succeeded`. Peristiwa sengaja tidak dijurnal: `SKIPPED_EVENTS` (constants.ts; tampil di layar
pemetaan).

### 3.2 Dipancarkan M11
`period.closed`, `period.locked` (periode), `asset.depreciated` (per aset per periode).

## 4. Persetujuan (`approvals.ts`)
`manual_journal` (objek `journal`, > PAR-20, tenggat = batas tutup buku PAR-23, lewat → eskalasi),
`correction` (objek `journal`, pembalik > PAR-21), `period_lock` (objek `accounting_period`, businessDate = akhir
periode), `opening_balance_adjustment` (objek `opening_adjustment_journal`).

## 5. Job (`jobs.ts`)
`m11.depreciation.monthly` (tgl 1 01.30), `m11.accrual.reverse` (00.30), `m11.recurring.drafts` (06.00),
`m11.pkp.monitor` (06.40), `m11.period.reminders` (07.15; PAR-71 & terlambat > PAR-23), `m11.payable.reminders` (07.20),
`m11.queue.retry` (05.00). Semua idempoten (groupKey notifikasi / cek entri).

## 6. Laporan ekspor (`reports.ts`, `/api/export/<kunci>`)
`m11.accounts`, `m11.mappings`, `m11.journals`, `m11.journal_queue`, `m11.ledger`, `m11.trial_balance`,
`m11.profit_loss`, `m11.balance_sheet`, `m11.cash_flow` (status "Sementara/Final/revisi/retroaktif"), `m11.assets`,
`m11.bank_reconciliations`, `m11.cash_reconciliations`, `m11.revenue_tax`, `m11.payables`, `m11.opening_balances`,
`m11.periods`, `m11.daily_reconciliation`. Ekspor format konsultan: `GET /akuntansi/pajak/ekspor?template=&periode=`.

## 7. UI kantor (`/akuntansi/*`, setiap halaman `requirePermission`)
`/akuntansi` (ringkasan), `/akun`, `/pemetaan`, `/jurnal` (tab jurnal/daftar tunggu/tinjauan pemilik/rekonsiliasi
harian/berulang/retroaktif; `?sumberTipe=&sumberId=` = jurnal suatu sumber), `/jurnal/baru`, `/jurnal/[id]`,
`/buku-besar`, `/laporan`, `/aset`, `/aset/[id]`, `/rekonsiliasi`, `/periode`, `/periode/[id|YYYY-MM]`, `/pajak`,
`/saldo-awal`, `/utang`. Editor baris jurnal berbaris tetap (tanpa JS): `line_{account|pc|outlet|debit|credit|memo}_<i>`.

## 8. Aturan & keputusan desain
- **Anti posting ganda (B-30/B-31)** — lihat kepala `auto-journals.ts`: pendapatan diakui pada peristiwa SUMBER (rit
  Selesai, POS); `invoice.issued` TIDAK dijurnal (piutang sudah terbentuk saat rit tempo/penjualan tempo); faktur saldo
  awal → jurnal saldo awal; `transfer.matched` slip setor bank tidak dijurnal; `office_cash.moved` hanya penyesuaian;
  pembayaran pemasok dijurnal dari `supplier_payment.recorded`.
- Label retroaktif disimpan di tingkat periode (`accounting_periods.is_retroactive`) + `retroactive_runs`, karena jurnal
  terposting imutabel dan `postJournal` inti tidak menerima penanda.
- Draf jurnal manual hanya pada periode terbuka (`postingPeriodFor(strict)`); koreksi periode terkunci = jurnal di
  periode terbuka dengan `originPeriod`.
- Tanggal impor divalidasi (`parseDateText` menolak tanggal mustahil).
- Nilai pajak per periode memakai tanggal akhir periode (bukan tanggal 28).

## 9. Tambahan berkas bersama (append-only)
`src/lib/labels.ts` (grup `opening_equity`; enum `recurring_journal_template`, `journal_payable_status`,
`period_review_kind`; daftar `period_prerequisite`, `shared_cost_basis`), `src/db/schema/m11-accounting.ts` (tabel
`recurring_journals`, `manual_journal_details`, `journal_payables`, `journal_payable_settlements`, `retroactive_runs`,
`period_review_notes`, `fixed_asset_extras`, `tax_scheme_rates`), `rbac/permissions.ts` (8 izin `m11.*`),
`nav/registry.ts` (`m11.payables` → `/akuntansi/utang`; `docs/nav-permissions.md` dibangkitkan ulang),
`notifications/catalog.ts` (`journal.owner_review`, `journal.recurring_ready`, `journal.retroactive_done`,
`asset.signoff_pending`), `params-registry.ts` (`m11.shared_cost_allocation`, `m11.accounting_rules`),
`src/db/seed/index.ts` (panggilan `seedDemoM11Accounting`).

## 10. Seed demo
`seedM11AccountingDefaults` SELALU (juga DB uji): akun 6-9301/6-9302 + pemetaan wajib yang belum ada di seed inti
(`m11.allocation`, `m11.asset_disposal`, `m11.opening_balance`, selisih setoran depot/toko) — melempar galat bila masih
ada pemetaan wajib yang tidak tertutup. Data transaksi demo (dev/E2E saja): 8 jurnal `JD-YYMM-NNNNN` bulan berjalan
(rit tunai/tempo, setoran, penjualan depot & toko + HPP, pasokan air internal, listrik L1 bertinjauan pemilik, setor
bank), jurnal berulang sewa kantor (K15), 2 aset tetap (truk T1, peralatan D01).

## 11. Butir terbuka (nomor = `docs/dev/backlog.md`)
- `bank_accounts.gl_account_id` bisa kosong/dipakai bersama → rekonsiliasi per rekening memakai akun bawaan pemetaan
  `transfer.matched` (ditandai "akun buku dipakai bersama"). Sebaiknya M4 mewajibkan akun buku per rekening — B-53.
- Dasbor M9 sebaiknya menampilkan `pkpStatus` (US-M11-08 KP-4 "tampil di dashboard M9") — B-54.
- Modul lain dapat menautkan `/akuntansi/jurnal?sumberTipe=&sumberId=` dari layar rinciannya (ketertelusuran dua arah) — B-55.
- B-31 diselesaikan berbeda dari harapan hand-off M5: `invoice.issued` tidak dijurnal (lihat §8); konfirmasi M5/PM — B-52.
- Alokasi L1 ke L3 belum dipecah per outlet (satu baris L3); markup transfer internal toko → depot (harga mitra) belum
  dieliminasi dari persediaan depot pada konsolidasi — B-56.
- Arus kas: kategori dari nama/induk akun lawan (heuristik) — tinjau bersama akuntan bila bagan akun berubah — B-57.
- Unggahan bukti jurnal & berkas impor lewat Server Action (batas 1 MB bawaan Next) — B-18.

Integrasi M9 + M11: laporan M11 `m11.profit_loss`, `m11.balance_sheet`, `m11.cash_flow`, `m11.journals` tampil di katalog
laporan M9 (`/laporan/katalog`); `period.locked` → M9 menyimpan versi Final laba kotor bulanan (revisi saat dikunci
ulang). Uji `tests/integration/m9-m11.test.ts` (jurnal otomatis → angka M9 = laba rugi M11 per lini).
