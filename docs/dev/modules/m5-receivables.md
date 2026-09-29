# M5 — Piutang & Penagihan (catatan pengembang)

Kode: `src/server/modules/m5-receivables/` (API publik HANYA `index.ts`; layanan di `service/*.ts`), UI kantor
`src/app/(office)/piutang/**` (+ Server Actions `piutang/actions.ts`, komponen `src/components/m5-receivables/*`), uji
`tests/m5-receivables/**`, E2E `e2e/m5-receivables.spec.ts`, seed demo `src/db/seed/demo-m5-receivables.ts`. PRD 7.5
(US-M5-01..07, 7.5.6), BR-01/02/03/05/06/07/29/38/39, PTB-14/18/24/25/27/28/46, PAR-08/09/12/13/21/40/41/45/55/62.
M5 TIDAK punya layar lapangan: pelunasan sopir = perintah M3, tempo toko = POS M6/M7 (M5 bereaksi lewat event).

## 1. Model & aturan inti

- **Faktur** (`invoices`, nomor `F-YY-NNNNNN`) jenis `delivery` (rit tempo, per rit — PTB-24), `underpayment`
  (kurang bayar lapangan, jatuh tempo H+`m5.receivable_rules.underpayment_due_days`), `monthly` (tagihan bulanan,
  PAR-12), `store_sale` (tempo toko, per transaksi), `opening_balance` (cut-over). Terbit HANYA lewat
  `ledger.issueInvoice` (nomor resmi, audit, `invoice.issued`, uang muka terbuka langsung dipotong).
- **Sisa**: `outstanding = amount − paid − credited − written_off` (CHECK DB). `paid` = Σ `payment_allocations`
  (pelunasan + uang muka, termasuk baris pembalik negatif; append-only) dan `credited` = Σ nota kredit `issued`
  (`NK-YY-NNNNNN`). `recomputeInvoice` idempoten; kelebihan alokasi (mis. sopir luring & kantor melunasi faktur yang
  sama) dibalik dari alokasi terbaru → **uang muka** (uang pelanggan tidak pernah hilang).
- **Alokasi bawaan tertua dulu** (`allocateOldest`), faktur bersengketa dilewati; kelebihan → `customer_advances`
  (dipotong otomatis ke faktur berikutnya; pengembalian = persetujuan `customer_refund`).
- **Koreksi tanpa hapus** (BR-38): nota kredit beralasan, pembalik/realokasi pelunasan; > PAR-21 → persetujuan
  `correction`. Faktur bersengketa hanya dikoreksi lewat keputusan sengketa pemilik (7.5.6); faktur saldo awal hanya
  lewat pembatalan (sebelum tanda tangan) / `opening_balance_adjustment` (sesudah).
- **Ditahan** (BR-03): setelah `cash_day.closed` atau job PAR-55, Tempo/Tempo migrasi dengan faktur lewat tempo
  > PAR-09 hari → `on_hold` (+`credit_status.changed`, notifikasi `credit.on_hold`). Dikecualikan: sengketa ≤ PAR-45 hari,
  faktur yang tercakup pembukaan pemilik (`hold_release_covers_due_until`), saldo awal yang belum ditandatangani, masa
  transisi PAR-41 (`hold_deferral_until`). Dilepas otomatis saat lunas (kecuali ada penghapusan piutang PTB-28).
  "Akan Ditahan" = lewat tempo > PAR-09 − `hold_warning_days` dengan pengecualian yang sama.
- **Saldo** (US-M5-01 KP-3) = faktur terbuka + rit "belum ditagih" (tagihan bulanan). **Eksposur** (BR-06) = saldo +
  pesanan tempo berjalan (+ `extraAmount`); satu batas lintas lini (PTB-25).
- Uang = integer rupiah; tanggal bisnis WIB (`ctxBusinessDate`); angka aturan dari parameter (PAR-xx +
  `m5.receivable_rules`: `underpayment_due_days`, `aging_first/second_bucket_days`, `hold_warning_days`,
  `statement_default_days`, `kpi04_target_percent`).

## 2. API publik (`@/server/modules/m5-receivables`)

Tanpa otorisasi (dipanggil modul lain DI DALAM transaksinya):

| Fungsi | Tanda tangan | Pemakai |
| --- | --- | --- |
| `getReceivableBalance` | `(tx, customerId, { asOf? }) → ReceivableBalance { openInvoices, openInvoiceCount, unbilledCharges, balance, overdue, oldestDueDate }` | M1 kartu pelanggan, M2 kredit (sudah dipakai `m2-orders/service/credit.ts`), M7 |
| `computeExposure` | `(tx, customerId, { extraAmount?, excludeOrderId?, asOf? }) → CreditExposureView` | M2/M7 kontrol kredit |
| `writeOffInvoice` | `(tx, { ctx, invoiceId, amount?, journalId?, approvalId?, reason }) → InvoiceRow` | M11 jurnal manual penghapusan (PTB-28) |
| `pendingTransferInvoice` | `(tx, incomingTransferId) → InvoiceRow \| null` | M4 pencocokan transfer |

Layanan layar (`fn(ctx, input, opts?: { tx })`; authorize → Zod → aturan/SoD → `runService` → audit → emit):

| Area | Fungsi |
| --- | --- |
| Faktur | `listInvoices(ctx, filter)`, `getInvoiceDetail(ctx, id)`, `invoiceDocument`, `renderInvoicePdf(ctx, id) → { filename, body }`, `sendInvoice(ctx, { invoiceId, via: "wa"\|"email" }) → { link, text }`, `disputeInvoice(ctx, { invoiceId, note })`, `decideDispute(ctx, { invoiceId, decision: "credit_note"\|"reject", amount?, reason })`, `requestCreditNote(ctx, { invoiceId, amount, reason }) → issued \| pending_approval`, `convertUnderpaymentToCredit(ctx, { invoiceId, reason })`, `customerOptions(ctx, { withOpenOnly? })` |
| Pelunasan | `recordOfficePayment(ctx, { customerId, businessDate, amount, method: "cash"\|"transfer", proofAttachmentId?, allocations?, notes? })`, `reverseCustomerPayment(ctx, { paymentId, reason })`, `reallocateCustomerPayment(ctx, { paymentId, allocations, reason })`, `reclassifyTripCash(ctx, { tripId, amount?, allocations?, reason })`, `reclassCandidates(ctx, { customerId? })`, `applyAdvance(ctx, { advanceId, invoiceId, amount? })`, `requestAdvanceRefund(ctx, { advanceId, amount, method: "cash"\|"transfer", bankAccountId?, reason })`, `listPayments`, `listAdvances`, `getPaymentDetail(ctx, id)`, `paymentReceipt`, `renderPaymentReceiptPdf`, `sendPaymentReceipt(ctx, { paymentId })` |
| Status kredit | `creditStatusBoard(ctx, { date? }) → { onHold, willHold[+holdOn], transition }`, `getCreditExposure(ctx, customerId)`, `creditHistory`, `creditEligibleCustomers`, `runHoldEvaluationNow`, `releaseCreditHold(ctx, { customerId, reason })` (pemilik), `requestCreditHoldRelease`, `deferCreditHold(ctx, { customerId, until, reason })`, `endCreditHoldDeferral`, `holdDeferralLimit`, `transitionLimit(tx, date)` |
| Umur & kartu | `agingReport(ctx, { asOf?, segment?, line? }) → AgingReport (+kpi04TargetPercent)`, `customerStatement(ctx, customerId, { from?, to? })`, `sendStatement(ctx, { customerId })`, `receivableOverview(ctx)`, `dailyActionList(ctx)` |
| Pengingat | `listReminders(ctx, { date? }) → { groups, daysBeforeDue, daysAfterDue }`, `openReminder(ctx, { customerId, kind, date? }) → { link, text }`, `reminderKindLabel(kind, list)`, `listReceivableTemplates`, `updateReceivableTemplate(ctx, { kind, body, reason })` |
| Bulanan | `monthlyBoard(ctx)`, `monthlyPeriod(tx, date)`, `runMonthlyInvoicingNow(ctx, { date? })`, `requestMonthlyBilling(ctx, { customerId, agreementAttachmentId, reason })` |
| Saldo awal | `openingBoard(ctx)`, `createOpeningInvoice(ctx, { customerId, issueDate, dueDate, amount, description, confirmationAttachmentId })`, `cancelOpeningInvoice(ctx, { invoiceId, reason })`, `signOpeningBalances(ctx, { note?, expectedTotal? })`, `requestOpeningAdjustment(ctx, { action: "add"\|"reduce", … })` |

## 3. Event

Dipancarkan M5 (payload lengkap di `src/server/core/events.types.ts`):

| Event | Payload inti | Pemakai |
| --- | --- | --- |
| `invoice.issued` | `invoiceId, number, customerId, kind, amount, issueDate, dueDate, tripId?, posSaleId?, profitCenter, outletId?, isOpeningBalance?, pendingTransferId?, periodMonth?, reclassifiedFromTripPaymentId?` | M11: jurnal penjualan **kecuali** `isOpeningBalance` (neraca awal), `pendingTransferId` & `reclassifiedFromTripPaymentId` (reklasifikasi, bukan pendapatan) |
| `invoice.paid` | `invoiceId, customerId, amount, number, kind, paidAt` | notifikasi/laporan |
| `credit_note.issued` | `creditNoteId, number, invoiceId, customerId, amount, reason, profitCenter, purpose, posSaleId?, storeReturnId?, advanceAmount?, approvalId?` | M11: `correction/dispute/store_return/pos_void/opening_adjustment` membalik pendapatan; `underpayment_conversion`, `pending_transfer_resolved` hanya reklasifikasi |
| `collection.recorded` (kanal `office`) | `customerPaymentId, customerId, amount, channel, method, allocations, advanceAmount, bankAccountId?, proofAttachmentId?, businessDate, reclassifiedFromTripPaymentId?, notes?` | M4: tunai kantor → kas kantor; transfer → pencocokan; `method: "internal"` (reklasifikasi 7.5.6) = TANPA gerak kas |
| `payment.reversed` | `customerPaymentId, reversalId, customerId, amount, reason, channel, method, bankAccountId?, depositId?, incomingTransferId?, businessDate, approvalId?` | M4 membalik kas/transfer; M11 jurnal pembalik |
| `customer_advance.refunded` | `customerAdvanceId, customerId, amount, method, bankAccountId?, approvalId, reason` | M4 kas keluar |
| `credit_status.changed` | `customerId, from, to, reason, automatic, rule?` | M2 (blokir pesanan tempo, tandai rit belum Berangkat PTB-27), notifikasi |
| `invoice.written_off` | `invoiceId, customerId, amount, reason, journalId, approvalId` | M11 TIDAK menjurnal ulang (jurnal manualnya sendiri) |

Ditangani M5 (semua idempoten, terisolasi savepoint): `trip.completed` & `trip.payment_recorded` (faktur kirim /
belum ditagih / kurang bayar H+0), `collection.recorded` (alokasi pelunasan sopir/kasir; kanal kantor diabaikan
karena sudah diterapkan layanan), `shift.closed` (faktur tempo toko per transaksi + `pos_sales.invoice_id`),
`pos_sale.recorded` (tempo toko tersinkron SETELAH shift ditutup → faktur langsung), `pos_sale.voided` &
`store_return.recorded` (nota kredit; bagian terbayar → uang muka), `transfer.not_found` (piutang sementara "transfer
belum diterima"), `transfer.matched` (nota kredit `pending_transfer_resolved` + pelunasan), `cash_day.closed`
(evaluasi Ditahan).

## 4. Sinkron, persetujuan, notifikasi, job, laporan

- **Pull** `m5.customer_credit` (sopir/kernet): `{ date, generatedAt, customers[{ customerId, name, creditStatus,
  creditLimit, balance, exposure, remaining, overdue, onHold }] }` untuk pelanggan rit hari ini pada truk pelaku.
- **Persetujuan** (`approvals.ts`): `credit_hold_release` (customer), `monthly_billing` (customer), `customer_refund`
  (customer_advance), `correction` (customer_payment / trip_cash_reclass / invoice), `opening_balance_adjustment`
  (opening_receivable). Handler menulis dengan `tx` + audit; tenggat `none` (tidak ada perubahan data saat kedaluwarsa).
- **Notifikasi**: `credit.on_hold`, `credit.hold_released`, `credit.hold_deferred`, `receivable.reminder_due`,
  `receivable.weekly_aging`, `receivable.monthly_ready`, `receivable.advance_review`, `receivable.dispute_opened`,
  `receivable.dispute_decided`, `initial_data.signoff_pending`, `trip.underpayment`.
- **Job**: `m5.credit_hold.daily` (PAR-55), `m5.reminders.daily` (PAR-07 mulai; kirim otomatis bila
  `WA_PROVIDER=cloud_api`), `m5.monthly_invoices` (harian; menerbitkan pada tanggal PAR-12, idempoten per
  pelanggan/periode; job terlambat → tanggal faktur = tanggal jalan, jatuh tempo ≥ tanggal faktur),
  `m5.weekly_aging` (PAR-40; ringkasan + sasaran KPI-04 ke pemilik).
- **Laporan** (`/api/export/<key>`): `m5.invoices`*, `m5.aging`*, `m5.aging_groups`, `m5.customer_card`*,
  `m5.payments`*, `m5.advances`, `m5.reminders`*, `m5.monthly_invoices`, `m5.unbilled`, `m5.credit_status`,
  `m5.credit_eligible`, `m5.opening_balances` (* = data pelanggan → POST dengan tujuan tercatat, BR-39).
- **Lampiran** (`audit.ts`): akses baca objek `invoice` (konfirmasi saldo awal); bukti transfer `customer_payment` oleh
  M3/inti.

## 5. Kantor `/piutang/*`

| Rute | Izin halaman | Isi |
| --- | --- | --- |
| `/piutang` | `m5.receivable.read` | KPI, daftar tindakan harian (ingatkan, akan Ditahan, Ditahan), hitung ulang Ditahan |
| `/piutang/faktur`, `/piutang/faktur/[id]`, `…/[id]/pdf` | `m5.invoice.read` | Saringan + ekspor; rincian: baris, alokasi, nota kredit, sengketa & keputusan, konversi kurang bayar, batal saldo awal, kirim WA/e-mail, PDF |
| `/piutang/pelunasan`, `/piutang/pelunasan/[id]`, `…/[id]/bukti` | `m5.customer_payment.read` | Catat pelunasan (+bukti), riwayat, uang muka (alokasi/pengembalian), reklasifikasi tunai rit; rincian: alokasi hidup, pembalik, realokasi, bukti PDF/WA |
| `/piutang/umur` | `m5.aging.read` | Umur per pelanggan/segmen/lini, KPI-04 vs sasaran, ekspor bertujuan |
| `/piutang/pelanggan/[id]` | `m5.aging.read` atau `m5.credit_exposure.read` | Kartu piutang, eksposur, riwayat status, pembukaan/pengajuan Ditahan, masa transisi, pernyataan WA |
| `/piutang/pengingat` | `m5.reminder.read` | Daftar H-n/H+n (PAR-13), Buka WhatsApp (status Dibuka), template (pemilik) |
| `/piutang/faktur-bulanan` | `m5.monthly_invoice.read` | Siap kirim / terkirim, belum ditagih, pelanggan bulanan, pengajuan (+perjanjian), terbitkan sekarang |
| `/piutang/saldo-awal` | `m5.opening_balance.read` | Input saldo awal (+konfirmasi), tanda tangan pemilik, koreksi berjejak |
| `/piutang/status-kredit` | `m5.credit_exposure.read` | Ditahan / akan Ditahan / masa transisi, cek eksposur, layak Tempo, pengajuan tagihan bulanan (Dispatcher) |

Unggahan Server Action: `put()` jenis `transfer_proof` / `agreement` / `customer_confirmation` (maks. 1 MB, B-18).
Ikon tombol klien dikirim sebagai ELEMEN (`icon={<MessageCircle aria-hidden />}`), bukan komponen.

## 6. Tambahan berkas bersama (append-only)

`labels.ts` (`aging_bucket`, `receivable_line`, `statement_entry`, `dispute_decision`, `wa_message_kind.invoice`),
`events.types.ts` (field opsional di `CollectionRecordedPayload`, `InvoiceIssuedPayload`, `InvoicePaidPayload`,
`CreditNoteIssuedPayload`, `PaymentReversedPayload`, `InvoiceWrittenOffPayload`), `notifications/catalog.ts` (5 entri
`receivable.*`/`credit.hold_released`), `params-registry.ts` (`m5.receivable_rules`), `rbac/permissions.ts`
(`m5.credit_hold.release`, `m5.credit_hold.evaluate`, `m5.monthly_invoice.issue`, `m5.opening_balance.sign`),
`nav/registry.ts` (`/piutang/status-kredit` + rincian tersembunyi), `docs/nav-permissions.md` (dibangkitkan),
`src/db/seed/index.ts` (panggil demo M5), `m2-orders/service/credit.ts` (minimal: saldo lewat `getReceivableBalance`).

## 7. Uji & data demo

- Vitest `tests/m5-receivables/*.test.ts` (setiap KP M & S bertanda `US-M5-0x KP-n`; pelanggan uji baru per kasus).
  `seed.test.ts` memeriksa demo: `recomputeInvoice` tidak mengubah faktur mana pun, uang muka/pelunasan seimbang, B-23,
  papan status kredit, pengingat, faktur bulanan (sebelum/sesudah tanggal 15), saldo awal dapat ditandatangani.
- Demo (relatif hari ini, tanpa event; dilewati di Vitest kecuali `force`): PLG-0024 lewat tempo 6 hari dibayar
  sebagian (akan Ditahan) + nota kredit; PLG-0025 pengingat H-3 & H+1 (Dibuka); PLG-0026 Ditahan (lewat 26 hari +
  kurang bayar lama); PLG-0033 bersengketa; PLG-0034 faktur bulanan + rit belum ditagih; PLG-0001 uang muka terpotong
  ke faktur tempo toko demo M7; PLG-0018 kurang bayar H+0; PLG-0037 lunas transfer; PLG-0028 saldo awal menunggu
  tanda tangan.
- E2E: `PORT=3105 PGLITE_DATA_DIR=./.data/pglite-e2e-m5-receivables pnpm test:e2e e2e/m5-receivables`.

## 8. Backlog yang diselesaikan

- **B-16**: alokasi `collection.recorded` → sisa faktur; faktur tempo & kurang bayar H+0 dari `trip.completed` /
  `trip.payment_recorded`; konversi kurang bayar → tempo (`convertUnderpaymentToCredit`, setelah `field_credit` disetujui).
- **B-22**: faktur per penjualan tempo toko (saat tutup shift; tersinkron sesudahnya → langsung) + `pos_sales.invoice_id`;
  void/retur setelah tutup shift → nota kredit (terbayar → uang muka).
- **B-23**: seed demo memfakturkan penjualan tempo toko demo M7 (PLG-0001) dan mengisi `pos_sales.invoice_id`.

## 9. Keputusan desain

- Faktur tempo toko terbit saat **tutup shift** (bukan per penjualan) agar void hari itu tetap urusan POS dan M7 tidak
  melihat faktur untuk shift terbuka; penjualan yang tersinkron setelah tutup shift difakturkan langsung.
- E-mail = tautan `mailto:` berisi subjek & teks (tanpa SMTP); PDF diunduh terpisah. Status "dikirim"/"dibuka" = tautan
  dibuka (K21), bukan klaim terkirim.
- Reklasifikasi tunai rit (7.5.6) = pelunasan `method: "internal"` — tidak ada uang berpindah; rit tetap tunai.
- Faktur saldo awal dikecualikan dari umur/pengingat/penahanan/"akan Ditahan" sampai total ditandatangani (US-M5-07 KP-3).
- Sasaran KPI-04 di parameter `m5.receivable_rules.kpi04_target_percent` (bawaan 5), bukan angka tertanam.

## 10. Tindak lanjut (modul lain / PM)

- **M1**: ringkasan kartu pelanggan menghitung piutang langsung dari `invoices` (tanpa rit belum ditagih) — ganti ke
  `getReceivableBalance(tx, id).balance` (US-M5-01 KP-3).
- ~~**M3**: aplikasi sopir belum menampilkan pull `m5.customer_credit`; `trip.corrected` / `trip_payment.reversed`
  belum dipancarkan M3~~ — SELESAI S5 paket A (B-33, B-34). Tambahan M5 (berkas baru `service/trip-corrections.ts`,
  handler `m5-receivables:trip_corrected` & `m5-receivables:trip_payment_reversed`, ekspor `tripOpenReceivable`):
  koreksi harga naik → faktur koreksi jenis `underpayment` (atau `unbilled_charges` naik bila tagihan bulanan belum
  terbit); turun → kurangi belum ditagih, nota kredit purpose baru `trip_correction` atas faktur rit bersisa, sisanya
  (`trip.corrected.advanceAmount`) uang muka; pembalik pembayaran tunai/transfer rit → faktur koreksi sebesar uang yang
  dibalik. Idempoten per `correctionId`/`reversalId` (tertulis `[kunci]` di keterangan dokumen). Uji
  `tests/integration/m3-corrections.test.ts`.
- **B-65 (untuk paket B, kontrak di `docs/dev/modules/m3-driver.md` §2)**: rit prabayar digital Selesai memancarkan
  `trip.completed.prepaidAmount` (`paymentMethod: "digital"`, tanpa kurang bayar) — M5 perlu memakai uang muka
  pelanggan sebesar itu (bukan faktur).
- **M4**: berlangganan `collection.recorded` kanal `office` (tunai → kas kantor; transfer → pencocokan; `internal` =
  tanpa kas), `payment.reversed`, `customer_advance.refunded`; pancarkan `transfer.not_found` / `transfer.matched`
  dengan `customerId` & `sourceKind` — SELESAI (integrasi M4+M5, `tests/integration/m4-m5.test.ts`).
- **M11**: jurnal dari event di §3 (pengecualian saldo awal/reklasifikasi), panggil `writeOffInvoice` di jurnal
  penghapusan (PTB-28).
- **M2/M7**: eksposur toko memakai `storeCreditExposure` (tempo toko belum difakturkan) di atas `computeExposure`.
- Saldo awal dihitung di lini "Air truk" pada umur piutang per lini (tidak ada lini asal pada faktur kertas).
- `docs/ARCHITECTURE.md` §9 perlu menambahkan `/piutang/status-kredit` (berkas milik PM).
