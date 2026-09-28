# M4 — Kas & Setoran (catatan pengembang)

Kode: `src/server/modules/m4-cash/` (API publik HANYA `index.ts`; logika di `service/*.ts`, skema Zod `schemas.ts`),
kontrak isomorfik `src/client/m4-cash/contract.ts`, UI kantor `src/app/(office)/kas/**` (+ Server Actions
`kas/actions.ts`, komponen `src/components/m4-cash/*`), uji `tests/m4-cash/**`, E2E `e2e/m4-cash.spec.ts`, seed demo
`src/db/seed/demo-m4-cash.ts`, panduan `docs/guides/m4-cash.md`. PRD 7.4 (US-M4-01..06), Bab 5.3, BR-08..BR-14,
BR-38, PTB-04/20/21/22/23/62, Lampiran B PAR-01/02/06/21/27/39/43/44/83/89 + parameter non-PAR `m4.cash_rules`.

## 1. Arsitektur singkat

- **Setoran** lahir di modul lapangan: sopir (M3 `ensureRunningDeposit` → "Setor" → `submitted`), shift depot/toko
  (M6/M7 tutup shift → `deposits.source_type depot_shift|store_shift`). M4 hanya **menerima** di web kantor.
- **Angka seharusnya** dihitung ulang dari data tersinkron (`depositFigures`): tunai rit + pelunasan tunai (sopir) atau
  ringkasan shift; `sameDayItems` (rincian per rit/pelunasan), `carryOverItems`/`carryOverCash` (tunai terlambat sinkron
  dari hari yang setorannya sudah ditutup, Bab 5.3), pengeluaran rit (`pending_verification` menahan penerimaan).
  Masukan penerimaan TIDAK menerima angka seharusnya (skema `.strict()`). Snapshot saat terima → `deposits.receipt_snapshot`.
- **Selisih** (`formDiscrepancy`): `requiresOwnerDecision = |selisih| ≥ PAR-01 || locksTrips`; `locksTrips` = PAR-83 aktif
  & selisih kurang ≥ `amount_gte` (sopir/setoran tertunda). ≥ ambang → notifikasi kritis + persetujuan
  `cash_discrepancy` (pengaju Admin Keuangan). Setoran **tetap Ditutup** (BR-10 mengacu penutupan FA). Di bawah ambang
  ditutup FA bersama setoran (`closeBelowThreshold`; pemilik dapat membuka kembali ≤ `discrepancy_reopen_days`).
- **Keputusan pemilik** (`applyDiscrepancyDecision`, dipanggil handler persetujuan atau `decideDiscrepancy`):
  Disetujui → `done` (beban selisih kas, `discrepancy.decided`); Ditolak → flag `cash.restitution_active` (lingkup
  tenant) aktif & selisih kurang & ada karyawan → `restitutions` (rujukan setoran + rit bila tunggal, alasan) +
  `restitution.recorded`, status `followed_up`; selain itu `rejected` → notifikasi `discrepancy.returned` ke FA →
  `completeDiscrepancyFollowUp`.
- **Kas kantor** = buku `office_cash_movements` (masuk/keluar per `kind`); saldo = `officeCashBalance(date)`. Semua
  penulisan lewat `postOfficeCash` + `assertCashDayOpen`. Uang yang diterima setelah hari kasnya ditutup (setoran
  tertunda, penggantian pengeluaran pribadi, pembayaran pemasok M7) memakai `openCashDate()` → hari kas terbuka
  berikutnya, deskripsi bertanda "(setelah kas ditutup)" (US-M4-06 KP-7).
- **Transfer masuk** (`incoming_transfers`, satu per objek sumber) dibentuk handler event (§3.2). Pencocokan manual
  (`matchTransfer`) atau impor mutasi (`importBankStatement` → `proposeStatementMatches` → `confirmStatementMatches`);
  job harian → Tidak ditemukan (> PAR-39 hari). Setor bank dengan slip (sopir/outlet): transfer `bank_deposit_slip`;
  saat cocok → `receiveDepositCore(via "bank", bankAccountId)` → setoran Diterima & Ditutup.
- **Tutup kas** (`cash_days`): `closeBlockers` (setoran sopir/shift belum diterima, shift terbuka depot M6 & toko M7
  `storeShiftsBlockingCashClose`, rit Berangkat/Tiba, hari sebelumnya, pengecualian menunggu) → pengecualian per
  kejadian (`cash_close_exception`, maks PAR-89 hari; kas wajib diterima ≤ `discrepancy_follow_up_hours`, lewat → job
  membentuk selisih `pending_deposit`) → `closeCashDay` (fisik ≠ sistem → alasan wajib, selisih + mutasi `adjustment`)
  → `cash_day.closed`. Hari ditutup dikunci (tulis kas kantor/setor bank/kas kecil ditolak).

## 2. API publik (`index.ts`)

Semua `fn(ctx, input, opts?: { tx })`; baca memakai `opts.tx ?? getDb()`. Izin di kolom kanan (matriks `rbac/permissions.ts`).

| Fungsi | Masukan | Izin / catatan |
| --- | --- | --- |
| `getCashPosition(ctx, { date? })` | | `m4.cash_position.read` — baris per sumber (`line` driver/depot/store/office), total per lini, sorotan PAR-44/27/02 |
| `listDepositsForReceipt(ctx)` · `listDeposits(ctx, {from,to})` · `getDepositDetail(ctx, id)` | | `m4.deposit.read`; detail: `figures`, `sync`, `canReceive`, `blockReason`, `late` |
| `verifyExpense(ctx, {expenseId, accept, reason?})` | tolak wajib alasan | `m4.deposit.receive`; uang pribadi diterima → `expense_reimbursement` |
| `receiveDeposit(ctx, {depositId, receivedAmount, denominations?, expenseDecisions?, discrepancyReason?, discrepancyNote?, lateReason?, evidenceAttachmentId?, close=true})` | | `m4.deposit.receive`; SOD penerima ≠ penyetor; sinkron penuh (B-04/B-15); → `ReceiveResult { deposit, discrepancy, closed }` |
| `closeDeposit(ctx, {depositId})` · `reopenDeposit(ctx, {depositId, reason})` | | `m4.deposit.receive` / didelegasikan ke M3 `reopenDriverDeposit` (izin M3; sopir Diajukan) |
| `listDiscrepancies(ctx, {view, from?, to?, source?})` · `discrepancyHistory(ctx, {months})` · `kpi03(db, tenantId, {from,to,now})` | | `m4.discrepancy.read`; KPI-03 = belum Selesai > N jam |
| `explainDiscrepancy(ctx, {discrepancyId, reason, explanation})` | | `m4.discrepancy.explain` (FA); memperbarui penjelasan persetujuan terbuka |
| `decideDiscrepancy(ctx, id, {decision: "approve"\|"reject", reason?})` | tolak wajib alasan | `m4.discrepancy.decide` (pemilik; satu ketuk, dipakai M9 H+0 US-M4-06 KP-6) — memutuskan lewat persetujuan terbuka bila ada |
| `reopenDiscrepancy(ctx, {discrepancyId, reason})` · `completeDiscrepancyFollowUp(ctx, {discrepancyId, note})` | | `m4.discrepancy.reopen` (pemilik, ≤ 7 hari) / `m4.discrepancy.explain` (FA) |
| `getRestitutionActive(ctx)` · `setRestitutionActive(ctx, {enabled, reason≥5})` | | baca `m4.restitution.read`; ubah = pengatur flag (pemilik) → audit `feature_flag` + notifikasi FA `parameter.changed` |
| `listRestitutions(ctx, {employeeId?, view})` · `restitutionBalances(ctx)` · `restitutionMonthlyRecap(ctx, {month})` | | baris daftar memuat `depositId/depositNumber/discrepancyAmount/reversedSettlementIds` |
| `settleRestitution(ctx, {restitutionId, amount, method: cash\|payroll_deduction, settledOn?, reference?})` · `reverseRestitutionSettlement(ctx, {settlementId, reason})` | | FA; SOD bukan karyawan ybs; pembalik > PAR-21 → `correction` |
| `listIncomingTransfers(ctx, {status?, sourceKind?, from?, to?})` · `matchTransfer(ctx, {transferId, refDate, refAmount, refNote, statementLineId?, discrepancyReason?, discrepancyNote?})` | | `m4.incoming_transfer.*` |
| `importBankStatement(ctx, {bankAccountId, fileName, content, fileAttachmentId?})` → `ImportResult` | CSV/XLSX | tanpa impor ganda (`row_hash`); lampiran ditautkan ke `bank_statement_import` |
| `proposeStatementMatches(ctx, {bankAccountId?})` · `confirmStatementMatches(ctx, {pairs[]})` · `markStatementLine(ctx, {lineId, status, note})` · `listStatementLines(ctx, {status?})` · `dailyMatchingResults(ctx, {from,to})` | | usulan: jumlah sama, tanggal ± `statement_match_days` |
| `getOfficeCash(ctx, {date?})` · `listOfficeCashMovements(ctx, {from,to})` · `recordOfficeCashOpening(ctx, {amount, businessDate?, note})` | | opening sekali (cut-over) |
| `recordBankDeposit(ctx, {bankAccountId, amount, businessDate?, slipAttachmentId, notes?})` · `reverseBankDeposit(ctx, {bankDepositId, reason})` | | pembalik > PAR-21 → `correction` objek `bank_deposit` |
| `listBankAccounts` · `createBankAccount(ctx, {bankName, accountNumber, accountName, branch?, isCustomerFacing?})` · `deactivateBankAccount(ctx, {bankAccountId, reason})` | | `m4.bank_account.update` |
| `recordPettyCash(ctx, {kind: topup\|expense, amount, businessDate?, category?, profitCenter?, outletId?, description, receiptAttachmentId?})` · `countPettyCash(ctx, {physicalAmount, countDate?, reason?})` · `getPettyCash(ctx, {from?,to?})` · `pettyCashOutletOptions(ctx)` | | > PAR-43 → persetujuan `petty_cash` |
| `getCashDayScreen(ctx, {date?})` · `startCashClose(ctx, {date?})` · `requestCloseException(ctx, {date?, depositId?\|shiftId?, reason})` · `closeCashDay(ctx, {date?, officeCashPhysical, officeCashReason?, officeCashNote?})` · `listCashDays(ctx, {from,to})` | | `m4.cash_day.*`; KPI-02 menit (setoran terakhir diterima → kas ditutup) |
| Job/uji: `runTransferNotFoundCheck(now)`, `sweepSlipDeposits(now)`, `runDriverNotSubmittedCheck(now)`, `runPendingDepositDueCheck(now)` | | idempoten |
| `buildMyCash(tx, ctx, since, now)` | | penyedia pull `m4.my_cash` |

## 3. Event

### 3.1 Dipancarkan M4 (payload ringkas; tipe di `src/server/core/events.types.ts`)

| Event | Payload inti | Pemakai |
| --- | --- | --- |
| `deposit.received` | `depositId, sourceType, sourceUserId, truckId, outletId, expectedAmount, receivedAmount, discrepancyAmount, receivedBy, profitCenter, late, method, bankAccountId, isPartial, depositNumber, businessDate, shiftId, employeeId, expectedCash, acceptedExpenses, carryOverCash, discrepancyId, discrepancyReason` | M6 (setoran shift `received`), M11 jurnal |
| `deposit.closed` | `depositId, sourceType, sourceUserId, depositNumber, businessDate, truckId, outletId, shiftId, employeeId, receivedAmount, discrepancyAmount, unlocksTrips` | M3 (BR-10 buka kunci rit) |
| `expense.verified` | `tripExpenseId, truckId, kind, amount, fundingSource, accepted, depositId, …` | M11 |
| `discrepancy.formed` | `discrepancyId, depositId, sourceType, amount, overThreshold, employeeId, profitCenter, businessDate, userId, truckId, outletId, shiftId, reason, source, locksTrips, approvalId` | M3 (kunci PAR-83), M9 |
| `discrepancy.decided` | `discrepancyId, decision, amount, employeeId, restitutionActive, profitCenter, source, depositId, businessDate, outletId, truckId, restitutionId, decidedBy, reason` | M3 (buka kunci), M11 (beban/ganti rugi) |
| `discrepancy.reopened` | `discrepancyId, previousDecision, amount, employeeId, profitCenter, reason` | M9, M11 |
| `transfer.matched` | `incomingTransferId, amount, sourceKind, bankAccountId, matchedAt, targetType, targetId, customerId` | M5 (piutang sementara selesai), M11 rekonsiliasi |
| `transfer.not_found` | `incomingTransferId, amount, sourceKind, customerId, sourceObjectType, sourceObjectId, transferDate, tripId, outletId` | M5 (piutang sementara "transfer belum diterima") |
| `bank_deposit.recorded` / `bank_deposit.reversed` | `bankDepositId, amount, bankAccountId, sourceType` / `+ reversalId, reason` | M11 |
| `office_cash.moved` | `movementId, direction, kind, amount, businessDate, sourceObjectType, sourceObjectId, reversalOfId` | M11 (kind `opening_balance`, `adjustment`, `supplier_payment`, …) |
| `petty_cash.recorded` | `pettyCashTransactionId, kind, amount, category, profitCenter, businessDate, outletId, description, approvalId` | M11 |
| `cash_day.closed` | `cashDayId, closedBy, late, exceptionCount, businessDate, closedAt, closeStartedAt, lastDepositReceivedAt, kpi02Minutes, officeCashSystem, officeCashPhysical, officeCashDifference, discrepancyCount, unmatchedTransferCount, lateSyncCount` | **M9** ringkasan H+0 ≤ 30 menit (US-M4-06 KP-5) |
| `restitution.recorded` / `restitution.settled` / `restitution.settlement_reversed` | `restitutionId, employeeId, amount, discrepancyId, businessDate, profitCenter` / `restitutionId, employeeId, amount, method, settlementId, settledOn, fullySettled` / `settlementId, reversalId, restitutionId, employeeId, amount, method, reason` | M11, penggajian |

### 3.2 Didengar M4 (`events.ts`, terisolasi savepoint)

`trip.payment_recorded` (transfer) · `collection.recorded` (transfer) · `shift.closed` (QRIS per shift) ·
`pos_sale.recorded` (QRIS terlambat) · `deposit.submitted` (slip) · `digital_payment.succeeded` (Tahap 2) →
transfer masuk. `trip_payment.reversed` / `payment.reversed` → transfer belum cocok Dibatalkan.
`supplier_payment.recorded` (tunai, M7) → mutasi kas kantor keluar/pembalik masuk + `supplier_payments.office_cash_movement_id` (B-21).

## 4. Lapangan & pull

M4 tidak punya perintah sinkron. Pull `m4.my_cash` (peran driver, helper, depot_operator, store_cashier) →
`MyCashReference` (`src/client/m4-cash/contract.ts`): setoran milik sendiri (diterima, selisih, keputusan pemilik) +
saldo ganti rugi. Komponen siap pasang: `<MyCashCard userId={…} />` (`src/components/m4-cash/my-cash-card.tsx`) —
**dipasang oleh pemilik aplikasi** (M3 `/sopir`, M6/M7 `/pos`; lihat §9). Hasil setoran juga dikirim sebagai notifikasi
`deposit.result` ke penyetor.

## 5. Registrasi

- **Persetujuan** (`approvals.ts`): `cash_discrepancy` (objek `discrepancy`; eskalasi, KPI-03), `petty_cash`,
  `cash_close_exception` (tenggat eksplisit; `expire` → "Kas tidak dapat ditutup"), `correction` objek `bank_deposit` &
  `restitution_settlement`. Handler menulis dengan `tx` + ctx penyetuju.
- **Notifikasi** (katalog; `discrepancy.trip_lock` dikirim M3 dari `discrepancy.formed`): `discrepancy.over_threshold`, `discrepancy.returned`,
  `deposit.result`, `deposit.not_submitted`, `deposit.not_received_at_close`, `transfer.not_found`,
  `bank_statement.unmatched`, `restitution.recorded`, `cash_close_exception.overdue`, `cash_day.closed`,
  `parameter.changed` (flag ganti rugi).
- **Job** (`jobs.ts`): `m4.transfer.not_found_check` (06.50), `m4.transfer.slip_sweep`, `m4.deposit.not_submitted_check`,
  `m4.cash_close_exception.due_check` (tiap 5 menit).
- **Laporan** (`reports.ts`, `/api/export/<kunci>?format=xlsx|pdf`): `m4.cash_position`, `m4.deposits`,
  `m4.discrepancies`, `m4.discrepancy_history`, `m4.incoming_transfers`, `m4.statement_lines`, `m4.daily_matching`,
  `m4.office_cash`, `m4.bank_deposits`, `m4.petty_cash`, `m4.cash_days`, `m4.restitutions`, `m4.restitution_recap`.
- **Audit & lampiran** (`audit.ts`): label objek keuangan; akses baca lampiran `bank_deposit`, `petty_cash_transaction`,
  `bank_statement_import`, `discrepancy`.

## 6. UI kantor (`/kas/*`, setiap halaman `requirePermission`)

| Rute | Izin | Isi (test id utama) |
| --- | --- | --- |
| `/kas` | `m4.cash_position.read` | posisi per sumber `kas-driver|kas-depot|kas-store|kas-office`, `?tanggal=` |
| `/kas/setoran`, `/kas/setoran/[id]` | `m4.deposit.read` | `setoran-menunggu`, `rincian-seharusnya`, `pengeluaran-rit`, `form-terima-setoran` (`hitung-selisih[data-expected-net]`), `selisih-setoran` |
| `/kas/selisih` | `m4.discrepancy.read` | `daftar-selisih` (Setujui `setujui-<id>` / Tolak), `?tampil=semua|riwayat` |
| `/kas/transfer` | `m4.incoming_transfer.read` | `daftar-transfer`, `?tampil=mutasi`: `form-impor-mutasi`, `usulan-pasangan`, `mutasi-tanpa-pasangan` |
| `/kas/kantor` | `m4.office_cash.read` | `mutasi-kas-kantor`, `form-setor-bank`, `rekening-bank`, `daftar-setor-bank`, `form-saldo-awal` |
| `/kas/kas-kecil` | `m4.petty_cash.read` | `form-kas-kecil`, `form-hitung-kas-kecil`, `daftar-kas-kecil` |
| `/kas/tutup` | `m4.cash_day.read` | `penghalang-tutup-kas`, `form-tutup-kas` (`isian-tutup-kas[data-system-amount]`), `riwayat-hari-kas` |
| `/kas/ganti-rugi` | `m4.restitution.read` | `form-ganti-rugi-aktif` (pemilik), `saldo-ganti-rugi`, `daftar-ganti-rugi`, `rekap-ganti-rugi` |

Server Actions (`kas/actions.ts`) memanggil layanan dan me-revalidate semua rute `/kas`. Foto > 300 KB dikompres di
klien sebelum dikirim (batas body Server Action 1 MB, B-18).

## 7. Aturan & keputusan desain

- Ambang dari parameter (Lampiran B): PAR-01 50.000 (ke pemilik), PAR-02 kas outlet maks, PAR-06 22.00 (batas tutup kas
  & terlambat), PAR-21 koreksi > 500.000, PAR-27 setoran depot > 1 hari, PAR-39 transfer > 2 hari, PAR-43 kas kecil >
  500.000, PAR-44 sopir belum setor > 1 jam, PAR-83 kunci rit (bawaan nonaktif), PAR-89 setoran tertunda maks 1 hari;
  `m4.cash_rules` (24 jam tindak lanjut, buka kembali 7 hari, pencocokan ± 1 hari, hitung kas kecil 7 hari, nihil
  selisih 3 bulan).
- **PAR-83 < PAR-01**: selisih pengunci rit selalu menunggu keputusan pemilik (kunci bertahan "sampai pemilik
  memutuskan") — tidak ikut ditutup FA di bawah ambang.
- **Hari kas tertutup**: tidak pernah diubah; uang yang datang kemudian → `openCashDate` (hari terbuka berikutnya).
- **Flag ganti rugi** disimpan lingkup **tenant** (`cash.restitution_active`) — mitra waralaba (Tahap 3) dapat berbeda.
- Pemilik tidak menerima setoran (SOD); penerima ≠ penyetor; karyawan tidak mencatat pelunasan ganti ruginya sendiri.
- Setoran slip bank: tidak dapat diterima fisik; `deposit.received` (method `bank_slip`, `bankAccountId`) adalah
  sumber jurnal kas→bank; `transfer.matched` untuk transfer `bank_deposit_slip`/`bank_deposit` hanya rekonsiliasi.

## 8. Tambahan berkas bersama (append-only)

`src/db/schema/m4-cash.ts` (enum `discrepancy_decision`; `deposits.carry_over_cash`, `receipt_snapshot`;
`discrepancies.decision`, `follow_up_note`, `followed_up_by`; `incoming_transfers.source_user_id`, `truck_id`,
`cancelled_at`, `cancel_reason`), `src/lib/labels.ts` (`incoming_transfer_status.cancelled`, `discrepancy_decision`,
`petty_cash_category`, `cash_close_blocker`, `cash_count_result`), `src/server/core/events.types.ts` (field opsional
pada payload §3.1), `notifications/catalog.ts` (`deposit.result`, `discrepancy.returned`, `restitution.recorded`,
`cash_close_exception.overdue`, `cash_day.closed`, `bank_statement.unmatched`), `params-registry.ts` (`m4.cash_rules`),
`rbac/permissions.ts` (`m4.bank_account.update`, `m4.bank_deposit.reverse`), `src/db/seed/index.ts` (panggilan
`seedDemoM4Cash` setelah M3/M6/M7). Registri nav tidak berubah.

## 9. Backlog & butir terbuka

- SELESAI di M4: **B-04** (`depositSyncStatus` → `m6.shiftSyncStatus`, `deposit.received.sourceType`), **B-12** bagian M4
  (`locks_trips` + `discrepancy.formed`), **B-15** (`isDriverDayFullySynced`, `reopenDeposit` → `reopenDriverDeposit`,
  `discrepancy.formed`), **B-20** (`storeShiftsBlockingCashClose` di penghalang), **B-21** (`supplier_payment.recorded`).
- **M3/M6/M7**: pasang `<MyCashCard>` di aplikasi sopir & POS (US-M4-03 KP-3 "saldo terlihat karyawan"; data pull sudah ada).
- **M9**: bangun ringkasan H+0 dari `cash_day.closed`; tombol satu ketuk memanggil `decideDiscrepancy`.
- **M5**: `transfer.not_found` → piutang sementara; `transfer.matched` → selesaikan.
- **M11**: pemetaan `office_cash.moved` (`adjustment`, `opening_balance`, `supplier_payment`), `bank_deposit.reversed`,
  `restitution.settlement_reversed`; aturan akun debit `deposit.received` method `bank_slip` → bank (`bankAccountId`);
  lewati jurnal `transfer.matched` untuk `bank_deposit_slip`/`bank_deposit` (hindari posting ganda).
- UI: `STATUS_TONES` bersama belum punya `incoming_transfer_status.cancelled` (M4 memakai `ToneBadge`).
