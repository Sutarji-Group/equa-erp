/**
 * M4 — Kas & Setoran (PRD 7.4): setoran (sopir/shift depot/shift toko), selisih, transfer masuk & pencocokan mutasi,
 * rekening bank, setor ke bank, kas kantor, kas kecil, hari kas & tutup kas, pengecualian tutup kas, ganti rugi.
 * Nomor setoran `S-YY-NNNNNN` (D-04).
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { enumValues } from "../../lib/labels";
import { businessDate, dateStr, money, pk, refId, timestamps, tstz } from "./_columns";
import {
  approvalRef,
  approvalRequests,
  attachmentRef,
  cashDirectionEnum,
  createdBy,
  deactivation,
  employeeRef,
  employees,
  fieldMeta,
  outletRef,
  outlets,
  profitCenterEnum,
  tenantRef,
  userRef,
} from "./core";
import { customers, trucks } from "./m1-master";
import { tripExpenses, tripPayments } from "./m3-driver";
import { invoices } from "./m5-receivables";
import { shifts } from "./m6-pos";
import { accounts } from "./m11-accounting";

// =====================================================================================================================
// Enum M4
// =====================================================================================================================

export const depositStatusEnum = pgEnum("deposit_status", enumValues("deposit_status"));
export const depositSourceTypeEnum = pgEnum("deposit_source_type", enumValues("deposit_source_type"));
export const depositMethodEnum = pgEnum("deposit_method", enumValues("deposit_method"));
export const discrepancyStatusEnum = pgEnum("discrepancy_status", enumValues("discrepancy_status"));
export const discrepancySourceEnum = pgEnum("discrepancy_source", enumValues("discrepancy_source"));
export const discrepancyReasonEnum = pgEnum("discrepancy_reason", enumValues("discrepancy_reason"));
export const incomingTransferStatusEnum = pgEnum("incoming_transfer_status", enumValues("incoming_transfer_status"));
export const transferSourceKindEnum = pgEnum("transfer_source_kind", enumValues("transfer_source_kind"));
export const bankStatementLineStatusEnum = pgEnum("bank_statement_line_status", enumValues("bank_statement_line_status"));
export const bankDepositStatusEnum = pgEnum("bank_deposit_status", enumValues("bank_deposit_status"));
export const officeCashKindEnum = pgEnum("office_cash_kind", enumValues("office_cash_kind"));
export const pettyCashKindEnum = pgEnum("petty_cash_kind", enumValues("petty_cash_kind"));
export const pettyCashStatusEnum = pgEnum("petty_cash_status", enumValues("petty_cash_status"));
export const cashDayStatusEnum = pgEnum("cash_day_status", enumValues("cash_day_status"));
export const cashCloseExceptionStatusEnum = pgEnum(
  "cash_close_exception_status",
  enumValues("cash_close_exception_status"),
);
export const restitutionStatusEnum = pgEnum("restitution_status", enumValues("restitution_status"));
export const restitutionSettlementMethodEnum = pgEnum(
  "restitution_settlement_method",
  enumValues("restitution_settlement_method"),
);
// --- Tambahan modul M4 (hanya tambah) ---
/** Keputusan pemilik atas selisih (US-M4-03 KP-2). */
export const discrepancyDecisionEnum = pgEnum("discrepancy_decision", enumValues("discrepancy_decision"));

// =====================================================================================================================
// Setoran & selisih
// =====================================================================================================================

/**
 * Setoran (Bab 5.2): Berjalan → Diajukan (ringkasan terkunci) → Diterima (jumlah fisik; selisih dihitung) → Ditutup.
 * Sopir: satu setoran per pengguna per hari (setoran dipisah per pelaksana, US-M2-11 KP-3). Depot/toko: per shift.
 * selisih = diterima − (seharusnya − pengeluaran diterima) (US-M4-02 KP-2).
 */
export const deposits = pgTable(
  "deposits",
  {
    id: pk(),
    tenantId: tenantRef(),
    /** Unik per tenant (NFR-30, D-04) — `deposits_tenant_number_uq`. */
    number: text("number").notNull(),
    sourceType: depositSourceTypeEnum("source_type").notNull(),
    businessDate: businessDate().notNull(),
    status: depositStatusEnum("status").notNull().default("running"),
    /** Penyetor (sopir/kernet pengganti/operator/kasir). */
    depositorUserId: userRef("depositor_user_id"),
    depositorEmployeeId: employeeRef("depositor_employee_id"),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    outletId: outletRef(),
    shiftId: uuid("shift_id").references((): AnyPgColumn => shifts.id),
    method: depositMethodEnum("method").notNull().default("physical"),
    bankSlipAttachmentId: attachmentRef("bank_slip_attachment_id"),
    /** Setor bank dengan slip → dicocokkan sebagai transfer masuk (PTB-23; 7.4.6: Diterima setelah mutasi cocok). */
    slipTransferId: uuid("slip_transfer_id").references((): AnyPgColumn => incomingTransfers.id),
    /** Kas seharusnya (tunai rit + pelunasan tunai; depot/toko: tunai seharusnya − kas awal tetap). */
    expectedCash: money("expected_cash").notNull().default(0),
    /** Pengeluaran rit yang diterima saat verifikasi (PTB-20). */
    acceptedExpenses: money("accepted_expenses").notNull().default(0),
    /** Seharusnya − pengeluaran diterima. */
    expectedNet: money("expected_net").notNull().default(0),
    receivedAmount: money("received_amount"),
    /** diterima − expected_net (negatif = kurang). */
    discrepancyAmount: money("discrepancy_amount"),
    discrepancyReason: discrepancyReasonEnum("discrepancy_reason"),
    discrepancyNote: text("discrepancy_note"),
    /** Rincian pecahan uang (opsional). */
    denominations: jsonb("denominations").$type<Record<string, number>>(),
    /** Ringkasan terkunci saat Diajukan: jumlah rit Selesai/Gagal, tunai per rit, pelunasan, transfer, tempo, pengeluaran. */
    summarySnapshot: jsonb("summary_snapshot").$type<Record<string, unknown>>(),
    submittedAt: tstz("submitted_at"),
    /** Diajukan setelah PAR-06 (US-M3-07 KP-5). */
    submittedLate: boolean("submitted_late").notNull().default(false),
    receivedAt: tstz("received_at"),
    receivedBy: userRef("received_by"),
    /** Diterima setelah PAR-06 atau hari berikutnya (US-M4-02 KP-6). */
    receivedLate: boolean("received_late").notNull().default(false),
    lateReason: text("late_reason"),
    closedAt: tstz("closed_at"),
    closedBy: userRef("closed_by"),
    /** Admin Keuangan membuka kembali setoran yang belum Diterima (US-M3-07 KP-2). */
    reopenedAt: tstz("reopened_at"),
    reopenedBy: userRef("reopened_by"),
    reopenReason: text("reopen_reason"),
    /** Keterangan penyetor atas selisih dari aplikasi (US-M3-07 KP-4). */
    depositorNote: text("depositor_note"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
    /**
     * Setor sebagian di tengah shift (BR-08, PTB-23, US-M6-02 KP-2, US-M7-09 KP-1): kas berjalan > PAR-02 → setor bank
     * dengan slip. Setoran akhir shift (`is_partial = false`) tetap satu per shift dan ditunjuk `shifts.deposit_id`;
     * jumlahnya = tunai seharusnya − kas awal tetap − Σ setoran sebagian (`shifts.partial_deposit_total`).
     */
    isPartial: boolean("is_partial").notNull().default(false),
    // --- Tambahan modul M4 (hanya tambah) ---
    /**
     * Tunai terlambat sinkron dari tanggal yang setorannya sudah Diajukan/Diterima (Bab 5.3): dibawa ke setoran ini
     * (M3 `ensureRunningDeposit`) dan ditambahkan ke angka seharusnya saat diterima (US-M4-06 KP-7).
     */
    carryOverCash: money("carry_over_cash").notNull().default(0),
    /** Rincian penerimaan M4: verifikasi pengeluaran, tunai terbawa, status sinkron, cara terima (US-M4-02). */
    receiptSnapshot: jsonb("receipt_snapshot").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("deposits_tenant_number_uq").on(t.tenantId, t.number),
    uniqueIndex("deposits_driver_day_uq")
      .on(t.depositorUserId, t.businessDate)
      .where(sql`${t.sourceType} = 'driver'`),
    uniqueIndex("deposits_shift_final_uq")
      .on(t.shiftId)
      .where(sql`${t.shiftId} is not null and ${t.isPartial} = false`),
    index("deposits_status_date_idx").on(t.status, t.businessDate),
    index("deposits_date_idx").on(t.tenantId, t.businessDate),
  ],
);

/**
 * Selisih (Bab 5.2; BR-09, BR-11, BR-12): Terbentuk → Dijelaskan → Disetujui/Ditolak (pemilik; wajib bila
 * ≥ PAR-01) → Ditindaklanjuti → Selesai. Tidak menahan penutupan setoran kecuali PAR-83 aktif (PTB-62).
 */
export const discrepancies = pgTable(
  "discrepancies",
  {
    id: pk(),
    tenantId: tenantRef(),
    source: discrepancySourceEnum("source").notNull(),
    depositId: uuid("deposit_id").references((): AnyPgColumn => deposits.id),
    /** Karyawan yang bertanggung jawab (penyetor). */
    employeeId: employeeRef("employee_id"),
    userId: userRef("user_id"),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    outletId: outletRef(),
    shiftId: uuid("shift_id").references((): AnyPgColumn => shifts.id),
    businessDate: businessDate().notNull(),
    /** Bertanda: negatif = kurang, positif = lebih. */
    amount: money("amount").notNull(),
    status: discrepancyStatusEnum("status").notNull().default("formed"),
    reason: discrepancyReasonEnum("reason"),
    reasonNote: text("reason_note"),
    explanation: text("explanation"),
    explainedBy: userRef("explained_by"),
    explainedAt: tstz("explained_at"),
    /** |selisih| ≥ PAR-01 → keputusan pemilik ≤ 24 jam (6.2a). */
    requiresOwnerDecision: boolean("requires_owner_decision").notNull().default(false),
    approvalRequestId: approvalRef(),
    decidedBy: userRef("decided_by"),
    decidedAt: tstz("decided_at"),
    decisionReason: text("decision_reason"),
    /** Di bawah ambang: ditutup Admin Keuangan dengan alasan; pemilik dapat membuka kembali ≤ 7 hari (US-M4-03 KP-5). */
    closedBelowThresholdBy: userRef("closed_below_threshold_by"),
    closedBelowThresholdAt: tstz("closed_below_threshold_at"),
    reopenedBy: userRef("reopened_by"),
    reopenedAt: tstz("reopened_at"),
    reopenReason: text("reopen_reason"),
    followedUpAt: tstz("followed_up_at"),
    doneAt: tstz("done_at"),
    /** PAR-83 aktif: selisih kurang besar yang belum diputuskan mengunci rit sopir (PTB-62). */
    locksTrips: boolean("locks_trips").notNull().default(false),
    evidenceAttachmentId: attachmentRef("evidence_attachment_id"),
    ...timestamps(),
    createdBy: createdBy(),
    // --- Tambahan modul M4 (hanya tambah) ---
    /** Keputusan pemilik (Disetujui/Ditolak) — status bergerak ke Ditindaklanjuti/Selesai (US-M4-03 KP-2). */
    decision: discrepancyDecisionEnum("decision"),
    /** Catatan tindak lanjut Admin Keuangan saat selisih ditolak diselesaikan (US-M4-06 KP-6). */
    followUpNote: text("follow_up_note"),
    followedUpBy: userRef("followed_up_by"),
  },
  (t) => [
    index("discrepancies_status_idx").on(t.status, t.createdAt),
    index("discrepancies_employee_idx").on(t.employeeId, t.businessDate),
    index("discrepancies_deposit_idx").on(t.depositId),
  ],
);

// =====================================================================================================================
// Bank & transfer
// =====================================================================================================================

/** Rekening bank PT (nomor rekening yang ditampilkan ke pelanggan, US-M3-04 KP-3). */
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: pk(),
    tenantId: tenantRef(),
    bankName: text("bank_name").notNull(),
    accountNumber: text("account_number").notNull(),
    accountName: text("account_name").notNull(),
    branch: text("branch"),
    /** Rekening yang ditampilkan ke pelanggan (struk, pengingat). */
    isCustomerFacing: boolean("is_customer_facing").notNull().default(false),
    /** Akun buku rekening (M11). B-53: wajib diisi layanan & TIDAK dipakai rekening lain (indeks unik; NULL = data lama). */
    glAccountId: uuid("gl_account_id").references((): AnyPgColumn => accounts.id),
    ...deactivation(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("bank_accounts_tenant_number_uq").on(t.tenantId, t.accountNumber), uniqueIndex("bank_accounts_gl_account_uq").on(t.glAccountId)],
);

/**
 * Transfer masuk tercatat (US-M4-04): Belum dicocokkan → Cocok / Tidak ditemukan (> PAR-39). Sumber polimorfik
 * (`source_object_type/id`): pembayaran rit, pelunasan, QRIS shift, slip setor bank, pembayaran digital, dll.
 */
export const incomingTransfers = pgTable(
  "incoming_transfers",
  {
    id: pk(),
    tenantId: tenantRef(),
    sourceKind: transferSourceKindEnum("source_kind").notNull(),
    sourceObjectType: text("source_object_type"),
    sourceObjectId: refId("source_object_id"),
    customerId: uuid("customer_id").references((): AnyPgColumn => customers.id),
    outletId: outletRef(),
    shiftId: uuid("shift_id").references((): AnyPgColumn => shifts.id),
    amount: money("amount").notNull(),
    transferDate: dateStr("transfer_date").notNull(),
    businessDate: businessDate().notNull(),
    proofAttachmentId: attachmentRef("proof_attachment_id"),
    bankAccountId: uuid("bank_account_id").references((): AnyPgColumn => bankAccounts.id),
    reference: text("reference"),
    status: incomingTransferStatusEnum("status").notNull().default("unmatched"),
    matchedAt: tstz("matched_at"),
    matchedBy: userRef("matched_by"),
    /** Referensi mutasi saat cocok manual (KP-2). */
    matchRefDate: dateStr("match_ref_date"),
    matchRefAmount: money("match_ref_amount"),
    matchRefNote: text("match_ref_note"),
    bankStatementLineId: uuid("bank_statement_line_id"),
    notFoundAt: tstz("not_found_at"),
    /** KP-4: piutang sementara pada pelanggan dengan penanda "transfer belum diterima" (`invoices.pending_transfer_id`). */
    temporaryInvoiceId: uuid("temporary_invoice_id").references((): AnyPgColumn => invoices.id),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
    // --- Tambahan modul M4 (hanya tambah) ---
    /** Pencatat di lapangan (sopir/operator/kasir) — kolom "transfer belum dicocokkan" per sumber (US-M4-01 KP-2). */
    sourceUserId: userRef("source_user_id"),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    /** Transaksi sumber dibalik sebelum dicocokkan (pembayaran rit dikoreksi, setor bank dibalik). */
    cancelledAt: tstz("cancelled_at"),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    foreignKey({
      name: "incoming_transfers_statement_line_fk",
      columns: [t.bankStatementLineId],
      foreignColumns: [bankStatementLines.id],
    }),
    index("incoming_transfers_status_idx").on(t.status, t.transferDate),
    index("incoming_transfers_customer_idx").on(t.customerId),
    // US-M4-04 KP-1 / US-M4-01 KP-3: satu transfer tercatat per objek sumber (event terulang tidak menggandakan).
    uniqueIndex("incoming_transfers_source_uq")
      .on(t.sourceObjectType, t.sourceObjectId)
      .where(sql`${t.sourceObjectId} is not null`),
    // US-M6-04 KP-1 / PTB-04: satu transfer QRIS per shift.
    uniqueIndex("incoming_transfers_qris_shift_uq")
      .on(t.shiftId)
      .where(sql`${t.sourceKind} = 'qris_shift' and ${t.shiftId} is not null`),
  ],
);

/** Impor berkas mutasi bank (US-M4-04 KP-3, S; NFR-22). */
export const bankStatementImports = pgTable(
  "bank_statement_imports",
  {
    id: pk(),
    tenantId: tenantRef(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references((): AnyPgColumn => bankAccounts.id),
    fileAttachmentId: attachmentRef("file_attachment_id"),
    originalFilename: text("original_filename"),
    periodStart: dateStr("period_start"),
    periodEnd: dateStr("period_end"),
    lineCount: integer("line_count").notNull().default(0),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("bank_statement_imports_account_idx").on(t.bankAccountId)],
);

/** Baris mutasi bank; pasangan diusulkan (jumlah sama, tanggal ± 1 hari) lalu dikonfirmasi. */
export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: pk(),
    importId: uuid("import_id").references((): AnyPgColumn => bankStatementImports.id),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references((): AnyPgColumn => bankAccounts.id),
    lineDate: dateStr("line_date").notNull(),
    description: text("description"),
    /** Bertanda: kredit (masuk) positif, debit (keluar) negatif. */
    amount: money("amount").notNull(),
    balance: money("balance"),
    reference: text("reference"),
    /** Hash isi baris untuk mencegah impor ganda. */
    rowHash: text("row_hash").notNull(),
    status: bankStatementLineStatusEnum("status").notNull().default("unmatched"),
    matchedBy: userRef("matched_by"),
    matchedAt: tstz("matched_at"),
    followUpNote: text("follow_up_note"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("bank_statement_lines_account_hash_uq").on(t.bankAccountId, t.rowHash),
    index("bank_statement_lines_status_idx").on(t.status, t.lineDate),
  ],
);

/** Setor ke bank oleh Admin Keuangan dari kas kantor (US-M4-05 KP-1). */
export const bankDeposits = pgTable(
  "bank_deposits",
  {
    id: pk(),
    tenantId: tenantRef(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references((): AnyPgColumn => bankAccounts.id),
    amount: money("amount").notNull(),
    businessDate: businessDate().notNull(),
    slipAttachmentId: attachmentRef("slip_attachment_id"),
    status: bankDepositStatusEnum("status").notNull().default("recorded"),
    bankStatementLineId: uuid("bank_statement_line_id").references((): AnyPgColumn => bankStatementLines.id),
    matchedAt: tstz("matched_at"),
    matchedBy: userRef("matched_by"),
    notes: text("notes"),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => bankDeposits.id),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("bank_deposits_date_idx").on(t.tenantId, t.businessDate)],
);

// =====================================================================================================================
// Kas kantor, kas kecil, hari kas
// =====================================================================================================================

/**
 * Mutasi kas kantor (US-M4-01 KP-3): saldo = Σ masuk − Σ keluar. Sumber polimorfik (setoran, setor bank, kas kecil,
 * penggantian pengeluaran rit, pelunasan tunai kantor, pembayaran pemasok, ganti rugi…).
 */
export const officeCashMovements = pgTable(
  "office_cash_movements",
  {
    id: pk(),
    tenantId: tenantRef(),
    businessDate: businessDate().notNull(),
    kind: officeCashKindEnum("kind").notNull(),
    direction: cashDirectionEnum("direction").notNull(),
    /** Selalu positif; arah di `direction`. */
    amount: money("amount").notNull(),
    sourceObjectType: text("source_object_type"),
    sourceObjectId: refId("source_object_id"),
    description: text("description"),
    reversalOfId: uuid("reversal_of_id"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    foreignKey({
      name: "office_cash_movements_reversal_fk",
      columns: [t.reversalOfId],
      foreignColumns: [t.id],
    }),
    index("office_cash_movements_date_idx").on(t.tenantId, t.businessDate),
    index("office_cash_movements_source_idx").on(t.sourceObjectType, t.sourceObjectId),
    // US-M4-01 KP-3: satu mutasi kas per (jenis, sumber) — posting turunan yang terulang tidak menggandakan saldo.
    uniqueIndex("office_cash_movements_source_uq")
      .on(t.kind, t.sourceObjectType, t.sourceObjectId)
      .where(sql`${t.reversalOfId} is null and ${t.sourceObjectId} is not null`),
  ],
);

/** Kas kecil (US-M4-05 KP-2, S): pengisian dari kas kantor; pengeluaran berkategori + pusat laba; > PAR-43 disetujui pemilik. */
export const pettyCashTransactions = pgTable(
  "petty_cash_transactions",
  {
    id: pk(),
    tenantId: tenantRef(),
    businessDate: businessDate().notNull(),
    kind: pettyCashKindEnum("kind").notNull(),
    amount: money("amount").notNull(),
    category: text("category"),
    profitCenter: profitCenterEnum("profit_center"),
    outletId: outletRef(),
    description: text("description"),
    receiptAttachmentId: attachmentRef("receipt_attachment_id"),
    status: pettyCashStatusEnum("status").notNull().default("approved"),
    approvalRequestId: uuid("approval_request_id"),
    officeCashMovementId: uuid("office_cash_movement_id"),
    reversalOfId: uuid("reversal_of_id"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("petty_cash_transactions_date_idx").on(t.tenantId, t.businessDate),
    foreignKey({
      name: "petty_cash_transactions_approval_fk",
      columns: [t.approvalRequestId],
      foreignColumns: [approvalRequests.id],
    }),
    foreignKey({
      name: "petty_cash_transactions_office_cash_fk",
      columns: [t.officeCashMovementId],
      foreignColumns: [officeCashMovements.id],
    }),
    foreignKey({ name: "petty_cash_transactions_reversal_fk", columns: [t.reversalOfId], foreignColumns: [t.id] }),
  ],
);

/** Rekonsiliasi fisik kas kecil mingguan dengan selisih beralasan (US-M4-05 KP-2). */
export const pettyCashCounts = pgTable(
  "petty_cash_counts",
  {
    id: pk(),
    tenantId: tenantRef(),
    countDate: dateStr("count_date").notNull(),
    systemBalance: money("system_balance").notNull(),
    physicalAmount: money("physical_amount").notNull(),
    difference: money("difference").notNull(),
    reason: text("reason"),
    discrepancyId: uuid("discrepancy_id").references((): AnyPgColumn => discrepancies.id),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("petty_cash_counts_date_idx").on(t.tenantId, t.countDate)],
);

/**
 * Hari kas (Bab 5.3): Terbuka → Ditutup (≤ PAR-06). KPI-02 = setoran terakhir Diterima → kas ditutup.
 * Kas kantor sistem vs hitung fisik saat tutup (US-M4-06 KP-3).
 */
export const cashDays = pgTable(
  "cash_days",
  {
    id: pk(),
    tenantId: tenantRef(),
    businessDate: businessDate().notNull(),
    status: cashDayStatusEnum("status").notNull().default("open"),
    lastDepositReceivedAt: tstz("last_deposit_received_at"),
    closeStartedAt: tstz("close_started_at"),
    closedAt: tstz("closed_at"),
    closedBy: userRef("closed_by"),
    closedLate: boolean("closed_late").notNull().default(false),
    officeCashSystem: money("office_cash_system"),
    officeCashPhysical: money("office_cash_physical"),
    officeCashDifference: money("office_cash_difference"),
    officeCashReason: text("office_cash_reason"),
    officeDiscrepancyId: uuid("office_discrepancy_id").references((): AnyPgColumn => discrepancies.id),
    /** Sumber yang menghalangi saat tutup (untuk jejak). */
    blockersSnapshot: jsonb("blockers_snapshot").$type<Record<string, unknown>[]>(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("cash_days_tenant_date_uq").on(t.tenantId, t.businessDate)],
);

/**
 * Pengecualian tutup kas dengan setoran tertunda per kejadian (PTB-21, CR-06): maks. PAR-89; rit sopir tetap terkunci;
 * kas harus diterima ≤ 24 jam, lewat itu menjadi selisih (US-M4-06 KP-2).
 */
export const cashCloseExceptions = pgTable(
  "cash_close_exceptions",
  {
    id: pk(),
    tenantId: tenantRef(),
    cashDayId: uuid("cash_day_id")
      .notNull()
      .references((): AnyPgColumn => cashDays.id),
    businessDate: businessDate().notNull(),
    sourceType: depositSourceTypeEnum("source_type").notNull(),
    depositId: uuid("deposit_id").references((): AnyPgColumn => deposits.id),
    employeeId: employeeRef("employee_id"),
    outletId: outletRef(),
    reason: text("reason").notNull(),
    status: cashCloseExceptionStatusEnum("status").notNull().default("submitted"),
    approvalRequestId: uuid("approval_request_id"),
    dueAt: tstz("due_at"),
    resolvedAt: tstz("resolved_at"),
    convertedDiscrepancyId: uuid("converted_discrepancy_id"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("cash_close_exceptions_day_idx").on(t.cashDayId),
    foreignKey({
      name: "cash_close_exceptions_approval_fk",
      columns: [t.approvalRequestId],
      foreignColumns: [approvalRequests.id],
    }),
    foreignKey({
      name: "cash_close_exceptions_discrepancy_fk",
      columns: [t.convertedDiscrepancyId],
      foreignColumns: [discrepancies.id],
    }),
  ],
);

/**
 * Ganti rugi karyawan per kejadian (BR-11c; US-M4-03 KP-2/3): tercatat saat selisih Ditolak dan parameter ganti rugi
 * aktif (feature flag `cash.restitution_active`, PTB-22). Sistem tidak memotong gaji.
 */
export const restitutions = pgTable(
  "restitutions",
  {
    id: pk(),
    tenantId: tenantRef(),
    employeeId: uuid("employee_id")
      .notNull()
      .references((): AnyPgColumn => employees.id),
    discrepancyId: uuid("discrepancy_id").references((): AnyPgColumn => discrepancies.id),
    businessDate: businessDate().notNull(),
    amount: money("amount").notNull(),
    tripId: refId("trip_id"),
    shiftId: uuid("shift_id").references((): AnyPgColumn => shifts.id),
    reason: text("reason").notNull(),
    status: restitutionStatusEnum("status").notNull().default("recorded"),
    settledAmount: money("settled_amount").notNull().default(0),
    settledAt: tstz("settled_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("restitutions_employee_idx").on(t.employeeId, t.businessDate)],
);

/** Pelunasan ganti rugi (setor tunai karyawan atau konfirmasi potongan dari penggajian, PTB-22). */
export const restitutionSettlements = pgTable(
  "restitution_settlements",
  {
    id: pk(),
    restitutionId: uuid("restitution_id")
      .notNull()
      .references((): AnyPgColumn => restitutions.id),
    amount: money("amount").notNull(),
    method: restitutionSettlementMethodEnum("method").notNull(),
    settledOn: dateStr("settled_on").notNull(),
    reference: text("reference"),
    officeCashMovementId: uuid("office_cash_movement_id"),
    reversalOfId: uuid("reversal_of_id"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("restitution_settlements_restitution_idx").on(t.restitutionId),
    foreignKey({
      name: "restitution_settlements_office_cash_fk",
      columns: [t.officeCashMovementId],
      foreignColumns: [officeCashMovements.id],
    }),
    foreignKey({ name: "restitution_settlements_reversal_fk", columns: [t.reversalOfId], foreignColumns: [t.id] }),
  ],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const depositsRelations = relations(deposits, ({ one, many }) => ({
  truck: one(trucks, { fields: [deposits.truckId], references: [trucks.id] }),
  outlet: one(outlets, { fields: [deposits.outletId], references: [outlets.id] }),
  shift: one(shifts, { fields: [deposits.shiftId], references: [shifts.id] }),
  depositorEmployee: one(employees, { fields: [deposits.depositorEmployeeId], references: [employees.id] }),
  tripPayments: many(tripPayments),
  tripExpenses: many(tripExpenses),
  discrepancies: many(discrepancies),
}));

export const discrepanciesRelations = relations(discrepancies, ({ one, many }) => ({
  deposit: one(deposits, { fields: [discrepancies.depositId], references: [deposits.id] }),
  employee: one(employees, { fields: [discrepancies.employeeId], references: [employees.id] }),
  outlet: one(outlets, { fields: [discrepancies.outletId], references: [outlets.id] }),
  truck: one(trucks, { fields: [discrepancies.truckId], references: [trucks.id] }),
  restitutions: many(restitutions),
}));

export const bankAccountsRelations = relations(bankAccounts, ({ one, many }) => ({
  glAccount: one(accounts, { fields: [bankAccounts.glAccountId], references: [accounts.id] }),
  statementLines: many(bankStatementLines),
}));

export const incomingTransfersRelations = relations(incomingTransfers, ({ one }) => ({
  customer: one(customers, { fields: [incomingTransfers.customerId], references: [customers.id] }),
  bankAccount: one(bankAccounts, { fields: [incomingTransfers.bankAccountId], references: [bankAccounts.id] }),
  statementLine: one(bankStatementLines, {
    fields: [incomingTransfers.bankStatementLineId],
    references: [bankStatementLines.id],
  }),
}));

export const bankStatementImportsRelations = relations(bankStatementImports, ({ one, many }) => ({
  bankAccount: one(bankAccounts, { fields: [bankStatementImports.bankAccountId], references: [bankAccounts.id] }),
  lines: many(bankStatementLines),
}));

export const bankStatementLinesRelations = relations(bankStatementLines, ({ one }) => ({
  import: one(bankStatementImports, { fields: [bankStatementLines.importId], references: [bankStatementImports.id] }),
  bankAccount: one(bankAccounts, { fields: [bankStatementLines.bankAccountId], references: [bankAccounts.id] }),
}));

export const bankDepositsRelations = relations(bankDeposits, ({ one }) => ({
  bankAccount: one(bankAccounts, { fields: [bankDeposits.bankAccountId], references: [bankAccounts.id] }),
}));

export const cashDaysRelations = relations(cashDays, ({ many }) => ({
  exceptions: many(cashCloseExceptions),
}));

export const cashCloseExceptionsRelations = relations(cashCloseExceptions, ({ one }) => ({
  cashDay: one(cashDays, { fields: [cashCloseExceptions.cashDayId], references: [cashDays.id] }),
  deposit: one(deposits, { fields: [cashCloseExceptions.depositId], references: [deposits.id] }),
}));

export const restitutionsRelations = relations(restitutions, ({ one, many }) => ({
  employee: one(employees, { fields: [restitutions.employeeId], references: [employees.id] }),
  discrepancy: one(discrepancies, { fields: [restitutions.discrepancyId], references: [discrepancies.id] }),
  settlements: many(restitutionSettlements),
}));

export const restitutionSettlementsRelations = relations(restitutionSettlements, ({ one }) => ({
  restitution: one(restitutions, { fields: [restitutionSettlements.restitutionId], references: [restitutions.id] }),
}));
