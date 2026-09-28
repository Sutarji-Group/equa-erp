/**
 * M11 — Akuntansi & Pajak (PRD 7.11): pusat laba (L1–L5, SHARED), bagan akun, pemetaan peristiwa → akun, jurnal
 * (otomatis/manual/saldo awal/akrual/penyusutan/alokasi) + baris ber-dimensi pusat laba & outlet, antrean jurnal,
 * periode, aset tetap & penyusutan, rekonsiliasi bank/kas, pengaturan pajak, template ekspor, saldo awal, alokasi biaya.
 * Nomor jurnal `J-YYMM-NNNNN` (D-04).
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { dateStr, money, percent, pk, refId, timestamps, tstz } from "./_columns";
import {
  approvalRef,
  attachmentRef,
  createdBy,
  domainEvents,
  employeeRef,
  exportFormatEnum,
  outletRef,
  outlets,
  profitCenterEnum,
  tenantRef,
  userRef,
} from "./core";
import { trucks, waterSources } from "./m1-master";
import { bankAccounts, discrepancies } from "./m4-cash";
import { suppliers } from "./m7-store";

export const periodStatusEnum = pgEnum("period_status", enumValues("period_status"));
export const accountTypeEnum = pgEnum("account_type", enumValues("account_type"));
export const normalBalanceEnum = pgEnum("normal_balance", enumValues("normal_balance"));
export const journalKindEnum = pgEnum("journal_kind", enumValues("journal_kind"));
export const journalStatusEnum = pgEnum("journal_status", enumValues("journal_status"));
export const journalQueueStatusEnum = pgEnum("journal_queue_status", enumValues("journal_queue_status"));
export const journalQueueReasonEnum = pgEnum("journal_queue_reason", enumValues("journal_queue_reason"));
export const assetCategoryEnum = pgEnum("asset_category", enumValues("asset_category"));
export const assetStatusEnum = pgEnum("asset_status", enumValues("asset_status"));
export const depreciationMethodEnum = pgEnum("depreciation_method", enumValues("depreciation_method"));
export const reconciliationStatusEnum = pgEnum("reconciliation_status", enumValues("reconciliation_status"));
export const cashReconciliationKindEnum = pgEnum("cash_reconciliation_kind", enumValues("cash_reconciliation_kind"));
export const taxSchemeEnum = pgEnum("tax_scheme", enumValues("tax_scheme"));
export const openingBatchGroupEnum = pgEnum("opening_batch_group", enumValues("opening_batch_group"));
export const openingBatchStatusEnum = pgEnum("opening_batch_status", enumValues("opening_batch_status"));
export const allocationKindEnum = pgEnum("allocation_kind", enumValues("allocation_kind"));
export const allocationStatusEnum = pgEnum("allocation_status", enumValues("allocation_status"));

/** Pusat laba (US-M11-01 KP-1): L1 produksi air (pusat biaya, PTB-39), L2 air truk, L3 depot, L4 toko, L5 kemitraan, SHARED. */
export const profitCenters = pgTable(
  "profit_centers",
  {
    id: pk(),
    tenantId: tenantRef(),
    code: profitCenterEnum("code").notNull(),
    name: text("name").notNull(),
    /** L1 & SHARED = pusat biaya yang dialokasikan (PAR-65 / kunci pemilik). */
    isCostCenter: boolean("is_cost_center").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex("profit_centers_tenant_code_uq").on(t.tenantId, t.code)],
);

/** Bagan akun (US-M11-01): kode, nama, jenis, pusat laba bawaan; dinonaktifkan, tidak dihapus. */
export const accounts = pgTable(
  "accounts",
  {
    id: pk(),
    tenantId: tenantRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: accountTypeEnum("type").notNull(),
    normalBalance: normalBalanceEnum("normal_balance").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => accounts.id),
    /** Akun header (tidak dapat diposting) vs detail. */
    isPostable: boolean("is_postable").notNull().default(true),
    profitCenter: profitCenterEnum("profit_center"),
    /** Akun pendapatan/beban internal berpasangan → dieliminasi pada konsolidasi (BR-33, KP-4). */
    isInternalTransfer: boolean("is_internal_transfer").notNull().default(false),
    /** Akun kas/bank — sumber arus kas metode langsung (PTB-45). */
    isCash: boolean("is_cash").notNull().default(false),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    deactivatedAt: tstz("deactivated_at"),
    deactivationReason: text("deactivation_reason"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("accounts_tenant_code_uq").on(t.tenantId, t.code), index("accounts_type_idx").on(t.tenantId, t.type)],
);

/**
 * Pemetaan peristiwa → akun (7.11.4, US-M11-01 KP-2): satu baris per (event_key, entry_key) — mis. event
 * `trip.completed`, entry `cash`. Berlaku ke depan (`effective_from`, 7.11.7). Pusat laba: tetap atau aturan
 * (`profit_center_rule`: 'fixed' | 'from_outlet' | 'from_source' | 'split_internal').
 */
export const eventAccountMappings = pgTable(
  "event_account_mappings",
  {
    id: pk(),
    tenantId: tenantRef(),
    eventKey: text("event_key").notNull(),
    entryKey: text("entry_key").notNull(),
    description: text("description").notNull(),
    debitAccountId: uuid("debit_account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id),
    creditAccountId: uuid("credit_account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id),
    debitProfitCenter: profitCenterEnum("debit_profit_center"),
    creditProfitCenter: profitCenterEnum("credit_profit_center"),
    profitCenterRule: text("profit_center_rule").notNull().default("fixed"),
    effectiveFrom: dateStr("effective_from").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("event_account_mappings_uq").on(t.tenantId, t.eventKey, t.entryKey, t.effectiveFrom)],
);

/**
 * Periode akuntansi bulanan (BR-32, US-M11-10): Terbuka → Ditutup (Admin Keuangan) → Dikunci (pemilik) → Dibuka
 * kembali (pemilik, alasan; revisi laporan Final bertambah).
 */
export const accountingPeriods = pgTable(
  "accounting_periods",
  {
    id: pk(),
    tenantId: tenantRef(),
    /** 'YYYY-MM'. */
    period: text("period").notNull(),
    startDate: dateStr("start_date").notNull(),
    endDate: dateStr("end_date").notNull(),
    status: periodStatusEnum("status").notNull().default("open"),
    closedAt: tstz("closed_at"),
    closedBy: userRef("closed_by"),
    /** Ditutup setelah PAR-23 (tanggal 10). */
    closedLate: boolean("closed_late").notNull().default(false),
    lockedAt: tstz("locked_at"),
    lockedBy: userRef("locked_by"),
    reopenedAt: tstz("reopened_at"),
    reopenedBy: userRef("reopened_by"),
    reopenReason: text("reopen_reason"),
    revision: integer("revision").notNull().default(1),
    /** PTB-12: daftar tinjauan jurnal manual ≤ PAR-20 ditandai pemilik sebelum tutup. */
    manualReviewMarkedAt: tstz("manual_review_marked_at"),
    manualReviewMarkedBy: userRef("manual_review_marked_by"),
    prerequisitesSnapshot: jsonb("prerequisites_snapshot").$type<Record<string, unknown>>(),
    /** Catatan tinjauan akuntan (US-M11-04 KP-5, TG-8). */
    accountantReviewNote: text("accountant_review_note"),
    /** Laporan periode ini dibangkitkan retroaktif (PTB-47). */
    isRetroactive: boolean("is_retroactive").notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex("accounting_periods_tenant_period_uq").on(t.tenantId, t.period)],
);

/**
 * Jurnal (US-M11-02/03): otomatis (terposting; hanya dapat dibalik), manual (Draf → Diajukan → Disetujui →
 * Terposting; > PAR-20 persetujuan sebelum posting; ≤ PAR-20 masuk daftar tinjauan wajib pemilik; lampiran wajib).
 */
export const journals = pgTable(
  "journals",
  {
    id: pk(),
    tenantId: tenantRef(),
    /** Unik per tenant (NFR-30, D-04) — `journals_tenant_number_uq`. */
    number: text("number").notNull(),
    kind: journalKindEnum("kind").notNull(),
    status: journalStatusEnum("status").notNull().default("draft"),
    /** Tanggal bisnis peristiwa (Bab 5.3). */
    journalDate: dateStr("journal_date").notNull(),
    periodId: uuid("period_id").references((): AnyPgColumn => accountingPeriods.id),
    /** FR-M11-10: peristiwa terlambat masuk periode terbuka pertama dengan penanda "asal periode …". */
    originPeriod: text("origin_period"),
    description: text("description").notNull(),
    /** Modul/peristiwa sumber (mis. 'trip.completed'). */
    sourceType: text("source_type"),
    sourceObjectType: text("source_object_type"),
    sourceObjectId: refId("source_object_id"),
    sourceEventId: uuid("source_event_id").references((): AnyPgColumn => domainEvents.id),
    totalDebit: money("total_debit").notNull().default(0),
    totalCredit: money("total_credit").notNull().default(0),
    attachmentId: attachmentRef("attachment_id"),
    approvalRequestId: approvalRef(),
    /** PTB-12: jurnal manual ≤ PAR-20 masuk daftar tinjauan wajib pemilik. */
    requiresOwnerReview: boolean("requires_owner_review").notNull().default(false),
    ownerReviewedAt: tstz("owner_reviewed_at"),
    ownerReviewedBy: userRef("owner_reviewed_by"),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => journals.id),
    reversalReason: text("reversal_reason"),
    /** US-M11-03 KP-6: jurnal akrual dibalik otomatis tanggal 1 periode berikutnya. */
    autoReverseOn: dateStr("auto_reverse_on"),
    /** Template berulang (gaji, sewa, listrik, BBM, pemeliharaan, biaya bank). */
    templateKey: text("template_key"),
    /** PTB-47: dibangkitkan retroaktif. */
    isRetroactive: boolean("is_retroactive").notNull().default(false),
    postedAt: tstz("posted_at"),
    postedBy: userRef("posted_by"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("journals_period_idx").on(t.periodId),
    index("journals_date_idx").on(t.tenantId, t.journalDate),
    index("journals_source_idx").on(t.sourceObjectType, t.sourceObjectId),
    /** Satu jurnal otomatis per event domain (idempotensi posting). */
    uniqueIndex("journals_auto_event_uq")
      .on(t.sourceEventId)
      .where(sql`${t.kind} = 'auto' and ${t.sourceEventId} is not null and ${t.reversalOfId} is null`),
    uniqueIndex("journals_tenant_number_uq").on(t.tenantId, t.number),
    // US-M11-10 KP-3 / BR-32: jurnal terposting selalu berperiode. Keseimbangan, periode Ditutup/Dikunci, dan cut-over
    // dijaga trigger di src/db/sql/hardening.sql (EQ004/EQ005/EQ006).
    check("journals_posted_period_chk", sql`${t.status} <> 'posted' or ${t.periodId} is not null`),
  ],
);

/** Baris jurnal ber-dimensi pusat laba + outlet (+ truk/sumber air untuk rincian). Debit & kredit ≥ 0, salah satu. */
export const journalLines = pgTable(
  "journal_lines",
  {
    id: pk(),
    journalId: uuid("journal_id")
      .notNull()
      .references((): AnyPgColumn => journals.id),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id),
    profitCenter: profitCenterEnum("profit_center").notNull(),
    outletId: outletRef(),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    waterSourceId: uuid("water_source_id").references((): AnyPgColumn => waterSources.id),
    debit: money("debit").notNull().default(0),
    credit: money("credit").notNull().default(0),
    description: text("description"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("journal_lines_journal_line_uq").on(t.journalId, t.lineNo),
    index("journal_lines_account_idx").on(t.accountId, t.profitCenter),
    index("journal_lines_outlet_idx").on(t.outletId),
    check(
      "journal_lines_amount_chk",
      sql`${t.debit} >= 0 and ${t.credit} >= 0 and (${t.debit} = 0 or ${t.credit} = 0) and (${t.debit} + ${t.credit}) > 0`,
    ),
  ],
);

/** Antrean jurnal yang gagal terposting (pemetaan hilang, akun nonaktif…; US-M11-02 KP-3) — tidak hilang diam-diam. */
export const journalQueue = pgTable(
  "journal_queue",
  {
    id: pk(),
    tenantId: tenantRef(),
    eventKey: text("event_key").notNull(),
    domainEventId: uuid("domain_event_id").references((): AnyPgColumn => domainEvents.id),
    sourceObjectType: text("source_object_type"),
    sourceObjectId: refId("source_object_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    journalDate: dateStr("journal_date").notNull(),
    reason: journalQueueReasonEnum("reason").notNull(),
    message: text("message"),
    status: journalQueueStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    resolvedJournalId: uuid("resolved_journal_id").references((): AnyPgColumn => journals.id),
    resolvedAt: tstz("resolved_at"),
    ...timestamps(),
  },
  (t) => [index("journal_queue_status_idx").on(t.status, t.createdAt)],
);

/** Aset tetap (US-M11-05): nilai & umur dari akuntan/notaris (BR-34, K15); pusat laba pemakai; penyusutan bulanan. */
export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: pk(),
    tenantId: tenantRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: assetCategoryEnum("category").notNull(),
    acquisitionDate: dateStr("acquisition_date").notNull(),
    acquisitionCost: money("acquisition_cost").notNull(),
    residualValue: money("residual_value").notNull().default(0),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    depreciationMethod: depreciationMethodEnum("depreciation_method").notNull().default("straight_line"),
    profitCenter: profitCenterEnum("profit_center").notNull(),
    outletId: outletRef(),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    waterSourceId: uuid("water_source_id").references((): AnyPgColumn => waterSources.id),
    assetAccountId: uuid("asset_account_id").references((): AnyPgColumn => accounts.id),
    accumulatedAccountId: uuid("accumulated_account_id").references((): AnyPgColumn => accounts.id),
    expenseAccountId: uuid("expense_account_id").references((): AnyPgColumn => accounts.id),
    status: assetStatusEnum("status").notNull().default("active"),
    disposedAt: dateStr("disposed_at"),
    disposalProceeds: money("disposal_proceeds"),
    disposalGainLoss: money("disposal_gain_loss"),
    disposalJournalId: uuid("disposal_journal_id").references((): AnyPgColumn => journals.id),
    /** import | purchase | manual_journal */
    source: text("source").notNull().default("import"),
    signoffId: refId("signoff_id"),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("fixed_assets_tenant_code_uq").on(t.tenantId, t.code)],
);

/** Penyusutan per aset per periode (diposting otomatis hari pertama tutup periode; US-M11-05 KP-2). */
export const depreciationEntries = pgTable(
  "depreciation_entries",
  {
    id: pk(),
    fixedAssetId: uuid("fixed_asset_id")
      .notNull()
      .references((): AnyPgColumn => fixedAssets.id),
    periodId: uuid("period_id")
      .notNull()
      .references((): AnyPgColumn => accountingPeriods.id),
    amount: money("amount").notNull(),
    accumulatedAfter: money("accumulated_after").notNull(),
    bookValueAfter: money("book_value_after").notNull(),
    journalId: uuid("journal_id").references((): AnyPgColumn => journals.id),
    /** Penyesuaian berjejak bila umur/nilai diubah akuntan. */
    isAdjustment: boolean("is_adjustment").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("depreciation_entries_asset_period_uq")
      .on(t.fixedAssetId, t.periodId)
      .where(sql`${t.isAdjustment} = false`),
  ],
);

/** Rekonsiliasi bank per rekening per periode (US-M11-06 KP-1): selisih harus nol untuk menutup periode. */
export const bankReconciliations = pgTable(
  "bank_reconciliations",
  {
    id: pk(),
    tenantId: tenantRef(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references((): AnyPgColumn => bankAccounts.id),
    periodId: uuid("period_id")
      .notNull()
      .references((): AnyPgColumn => accountingPeriods.id),
    statementBalance: money("statement_balance").notNull(),
    bookBalance: money("book_balance").notNull(),
    /** Item penyesuai: transfer belum dicocokkan, setoran dalam perjalanan, biaya/bunga bank, transfer tidak ditemukan. */
    adjustingItems: jsonb("adjusting_items").$type<Record<string, unknown>[]>().notNull().default([]),
    difference: money("difference").notNull(),
    status: reconciliationStatusEnum("status").notNull().default("in_progress"),
    completedBy: userRef("completed_by"),
    completedAt: tstz("completed_at"),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("bank_reconciliations_account_period_uq").on(t.bankAccountId, t.periodId)],
);

/** Rekonsiliasi kas (US-M11-06 KP-2): kas kantor, kas awal tetap outlet, kas di tangan sopir, kas kecil vs buku. */
export const cashReconciliations = pgTable(
  "cash_reconciliations",
  {
    id: pk(),
    tenantId: tenantRef(),
    periodId: uuid("period_id")
      .notNull()
      .references((): AnyPgColumn => accountingPeriods.id),
    kind: cashReconciliationKindEnum("kind").notNull(),
    outletId: outletRef(),
    employeeId: employeeRef("employee_id"),
    systemBalance: money("system_balance").notNull(),
    physicalBalance: money("physical_balance").notNull(),
    difference: money("difference").notNull(),
    reason: text("reason"),
    discrepancyId: uuid("discrepancy_id").references((): AnyPgColumn => discrepancies.id),
    status: reconciliationStatusEnum("status").notNull().default("in_progress"),
    completedBy: userRef("completed_by"),
    completedAt: tstz("completed_at"),
    ...timestamps(),
  },
  (t) => [index("cash_reconciliations_period_idx").on(t.periodId, t.kind)],
);

/** Pengaturan pajak berlaku per tanggal (US-M11-08; BR-29/30; tarif PPh final PAR-64). */
export const taxSettings = pgTable(
  "tax_settings",
  {
    id: pk(),
    tenantId: tenantRef(),
    scheme: taxSchemeEnum("scheme").notNull().default("non_pkp_final"),
    isPkp: boolean("is_pkp").notNull().default(false),
    effectiveFrom: dateStr("effective_from").notNull(),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("tax_settings_tenant_from_uq").on(t.tenantId, t.effectiveFrom)],
);

/** Template ekspor ke format konsultan pajak (US-M11-08 KP-3) — dapat diubah tanpa rilis aplikasi. */
export const exportTemplates = pgTable(
  "export_templates",
  {
    id: pk(),
    tenantId: tenantRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** journals | ledger | revenue */
    target: text("target").notNull(),
    format: exportFormatEnum("format").notNull().default("xlsx"),
    columnMapping: jsonb("column_mapping").$type<Record<string, unknown>[]>().notNull(),
    version: integer("version").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("export_templates_tenant_key_version_uq").on(t.tenantId, t.key, t.version)],
);

/**
 * Saldo awal per kelompok (US-M11-09): Draf → Ditandatangani (pemilik, NFR-34) → Terposting (setelah disahkan akuntan).
 * Cut-over hanya tanggal 1 (NFR-36).
 */
export const openingBalanceBatches = pgTable(
  "opening_balance_batches",
  {
    id: pk(),
    tenantId: tenantRef(),
    group: openingBatchGroupEnum("group").notNull(),
    cutoverDate: dateStr("cutover_date").notNull(),
    status: openingBatchStatusEnum("status").notNull().default("draft"),
    signoffId: refId("signoff_id"),
    accountantApprovedBy: userRef("accountant_approved_by"),
    accountantApprovedAt: tstz("accountant_approved_at"),
    journalId: uuid("journal_id").references((): AnyPgColumn => journals.id),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("opening_balance_batches_group_idx").on(t.tenantId, t.group),
    check("opening_balance_batches_first_day_chk", sql`extract(day from ${t.cutoverDate}) = 1`),
  ],
);

export const openingBalanceLines = pgTable(
  "opening_balance_lines",
  {
    id: pk(),
    batchId: uuid("batch_id")
      .notNull()
      .references((): AnyPgColumn => openingBalanceBatches.id),
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id),
    profitCenter: profitCenterEnum("profit_center").notNull(),
    outletId: outletRef(),
    debit: money("debit").notNull().default(0),
    credit: money("credit").notNull().default(0),
    description: text("description"),
    /** Rujukan dokumen (faktur saldo awal, nota pemasok, aset). */
    referenceType: text("reference_type"),
    referenceId: refId("reference_id"),
    ...timestamps(),
  },
  (t) => [index("opening_balance_lines_batch_idx").on(t.batchId)],
);

/** Alokasi biaya bulanan: L1 → L2/L3 menurut volume pengisian (PAR-65, PTB-39) & biaya bersama (US-M11-01 KP-5). */
export const costAllocationRuns = pgTable(
  "cost_allocation_runs",
  {
    id: pk(),
    tenantId: tenantRef(),
    periodId: uuid("period_id")
      .notNull()
      .references((): AnyPgColumn => accountingPeriods.id),
    kind: allocationKindEnum("kind").notNull(),
    /** Dasar alokasi (liter pengisian per L2/L3, omzet, atau kunci tetap). */
    basis: jsonb("basis").$type<Record<string, unknown>>().notNull(),
    totalAmount: money("total_amount").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    journalId: uuid("journal_id").references((): AnyPgColumn => journals.id),
    status: allocationStatusEnum("status").notNull().default("draft"),
    postedBy: userRef("posted_by"),
    postedAt: tstz("posted_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    uniqueIndex("cost_allocation_runs_posted_uq")
      .on(t.periodId, t.kind)
      .where(sql`${t.status} = 'posted'`),
  ],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  parent: one(accounts, { fields: [accounts.parentId], references: [accounts.id], relationName: "account_parent" }),
  children: many(accounts, { relationName: "account_parent" }),
  lines: many(journalLines),
}));

export const eventAccountMappingsRelations = relations(eventAccountMappings, ({ one }) => ({
  debitAccount: one(accounts, {
    fields: [eventAccountMappings.debitAccountId],
    references: [accounts.id],
    relationName: "mapping_debit",
  }),
  creditAccount: one(accounts, {
    fields: [eventAccountMappings.creditAccountId],
    references: [accounts.id],
    relationName: "mapping_credit",
  }),
}));

export const accountingPeriodsRelations = relations(accountingPeriods, ({ many }) => ({
  journals: many(journals),
}));

export const journalsRelations = relations(journals, ({ one, many }) => ({
  period: one(accountingPeriods, { fields: [journals.periodId], references: [accountingPeriods.id] }),
  lines: many(journalLines),
  reversalOf: one(journals, { fields: [journals.reversalOfId], references: [journals.id], relationName: "journal_reversal" }),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  journal: one(journals, { fields: [journalLines.journalId], references: [journals.id] }),
  account: one(accounts, { fields: [journalLines.accountId], references: [accounts.id] }),
  outlet: one(outlets, { fields: [journalLines.outletId], references: [outlets.id] }),
}));

export const journalQueueRelations = relations(journalQueue, ({ one }) => ({
  resolvedJournal: one(journals, { fields: [journalQueue.resolvedJournalId], references: [journals.id] }),
}));

export const fixedAssetsRelations = relations(fixedAssets, ({ many }) => ({
  depreciation: many(depreciationEntries),
}));

export const depreciationEntriesRelations = relations(depreciationEntries, ({ one }) => ({
  asset: one(fixedAssets, { fields: [depreciationEntries.fixedAssetId], references: [fixedAssets.id] }),
  period: one(accountingPeriods, { fields: [depreciationEntries.periodId], references: [accountingPeriods.id] }),
  journal: one(journals, { fields: [depreciationEntries.journalId], references: [journals.id] }),
}));

export const bankReconciliationsRelations = relations(bankReconciliations, ({ one }) => ({
  bankAccount: one(bankAccounts, { fields: [bankReconciliations.bankAccountId], references: [bankAccounts.id] }),
  period: one(accountingPeriods, { fields: [bankReconciliations.periodId], references: [accountingPeriods.id] }),
}));

export const cashReconciliationsRelations = relations(cashReconciliations, ({ one }) => ({
  period: one(accountingPeriods, { fields: [cashReconciliations.periodId], references: [accountingPeriods.id] }),
}));

export const openingBalanceBatchesRelations = relations(openingBalanceBatches, ({ one, many }) => ({
  lines: many(openingBalanceLines),
  journal: one(journals, { fields: [openingBalanceBatches.journalId], references: [journals.id] }),
}));

export const openingBalanceLinesRelations = relations(openingBalanceLines, ({ one }) => ({
  batch: one(openingBalanceBatches, { fields: [openingBalanceLines.batchId], references: [openingBalanceBatches.id] }),
  account: one(accounts, { fields: [openingBalanceLines.accountId], references: [accounts.id] }),
}));

export const costAllocationRunsRelations = relations(costAllocationRuns, ({ one }) => ({
  period: one(accountingPeriods, { fields: [costAllocationRuns.periodId], references: [accountingPeriods.id] }),
  journal: one(journals, { fields: [costAllocationRuns.journalId], references: [journals.id] }),
}));

// =====================================================================================================================
// Tambahan agen M11 (hanya tambah) — jurnal berulang, rincian jurnal manual, utang dari jurnal manual, jurnal
// retroaktif (PTB-47), catatan tinjauan akuntan per periode, pelengkap aset & pajak.
// =====================================================================================================================

export const recurringJournalTemplateEnum = pgEnum("recurring_journal_template", enumValues("recurring_journal_template"));
export const journalPayableStatusEnum = pgEnum("journal_payable_status", enumValues("journal_payable_status"));
export const periodReviewKindEnum = pgEnum("period_review_kind", enumValues("period_review_kind"));

/** Baris template jurnal manual/berulang (akun + pusat laba + sisi + jumlah). */
export type TemplateJournalLine = {
  accountId: string;
  profitCenter: string;
  outletId?: string | null;
  side: "debit" | "credit";
  amount: number;
  memo?: string | null;
};

/**
 * Jurnal berulang terjadwal bulanan (US-M11-03 KP-4): sewa, listrik, gaji, dsb. Job M11 membuat DRAF tiap bulan
 * (tetap memerlukan lampiran & persetujuan sesuai ambang PAR-20). Penyusutan BUKAN jurnal berulang (otomatis, US-M11-05).
 */
export const recurringJournals = pgTable(
  "recurring_journals",
  {
    id: pk(),
    tenantId: tenantRef(),
    name: text("name").notNull(),
    template: recurringJournalTemplateEnum("template").notNull(),
    description: text("description").notNull(),
    lines: jsonb("lines").$type<TemplateJournalLine[]>().notNull(),
    /** Tanggal jurnal draf di bulan berjalan (1–28). */
    dayOfMonth: integer("day_of_month").notNull().default(1),
    /** Draf bertanda akrual → dibalik otomatis tanggal 1 periode berikutnya (US-M11-03 KP-6). */
    isAccrual: boolean("is_accrual").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    /** 'YYYY-MM' draf terakhir yang dibuat (idempotensi job bulanan). */
    lastGeneratedPeriod: text("last_generated_period"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("recurring_journals_tenant_idx").on(t.tenantId, t.isActive),
    check("recurring_journals_day_chk", sql`${t.dayOfMonth} between 1 and 28`),
  ],
);

/**
 * Rincian jurnal manual (US-M11-03, US-M11-07, PTB-28): asal jurnal berulang, penanda utang, pelunasan utang, penghapusan
 * piutang, catatan akuntan (penyesuaian saldo awal).
 */
export const manualJournalDetails = pgTable(
  "manual_journal_details",
  {
    id: pk(),
    tenantId: tenantRef(),
    journalId: uuid("journal_id")
      .notNull()
      .references((): AnyPgColumn => journals.id),
    recurringJournalId: uuid("recurring_journal_id").references((): AnyPgColumn => recurringJournals.id),
    /** 'YYYY-MM' untuk draf dari jurnal berulang. */
    recurringPeriod: text("recurring_period"),
    /** Jurnal bertanda utang (US-M11-07 KP-1). */
    payable: jsonb("payable").$type<{ supplierId?: string | null; payeeName: string; dueDate: string; amount: number } | null>(),
    /** Jurnal pembayaran utang manual (mengurangi utang). */
    settlesPayableId: uuid("settles_payable_id"),
    /** Jurnal penghapusan piutang (PTB-28) → `m5.writeOffInvoice` saat terposting. */
    writeOff: jsonb("write_off").$type<{ invoiceId: string; amount: number } | null>(),
    /** Catatan akuntan (wajib untuk penyesuaian saldo awal, US-M11-09 KP-3). */
    accountantNote: text("accountant_note"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("manual_journal_details_journal_uq").on(t.journalId),
    uniqueIndex("manual_journal_details_recurring_uq")
      .on(t.recurringJournalId, t.recurringPeriod)
      .where(sql`${t.recurringJournalId} is not null`),
  ],
);

/** Utang dari jurnal manual bertanda utang (US-M11-07 KP-1): umur, jadwal, pelunasan lewat jurnal pembayaran. */
export const journalPayables = pgTable(
  "journal_payables",
  {
    id: pk(),
    tenantId: tenantRef(),
    journalId: uuid("journal_id")
      .notNull()
      .references((): AnyPgColumn => journals.id),
    supplierId: uuid("supplier_id").references((): AnyPgColumn => suppliers.id),
    payeeName: text("payee_name").notNull(),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    dueDate: dateStr("due_date").notNull(),
    settledAmount: money("settled_amount").notNull().default(0),
    status: journalPayableStatusEnum("status").notNull().default("open"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    uniqueIndex("journal_payables_journal_uq").on(t.journalId),
    index("journal_payables_due_idx").on(t.tenantId, t.status, t.dueDate),
    check("journal_payables_amount_chk", sql`${t.amount} > 0 and ${t.settledAmount} >= 0 and ${t.settledAmount} <= ${t.amount}`),
  ],
);

/** Pelunasan utang jurnal manual (jurnal pembayaran → mengurangi utang). */
export const journalPayableSettlements = pgTable(
  "journal_payable_settlements",
  {
    id: pk(),
    payableId: uuid("payable_id")
      .notNull()
      .references((): AnyPgColumn => journalPayables.id),
    journalId: uuid("journal_id")
      .notNull()
      .references((): AnyPgColumn => journals.id),
    amount: money("amount").notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("journal_payable_settlements_uq").on(t.payableId, t.journalId)],
);

/**
 * Pembangkitan jurnal retroaktif (PTB-47, US-M11-02 KP-4, US-M11-09 KP-4): M11 menyusul modul operasional → seluruh
 * peristiwa sejak cut-over diputar ulang dari `domain_events` (idempoten per event) lalu diverifikasi akuntan.
 */
export const retroactiveRuns = pgTable(
  "retroactive_runs",
  {
    id: pk(),
    tenantId: tenantRef(),
    fromDate: dateStr("from_date").notNull(),
    toDate: dateStr("to_date").notNull(),
    status: text("status").notNull().default("running"),
    eventsScanned: integer("events_scanned").notNull().default(0),
    posted: integer("posted").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    queued: integer("queued").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    /** Periode yang jurnalnya dibangkitkan (label "dibangkitkan retroaktif"). */
    periods: jsonb("periods").$type<string[]>().notNull().default([]),
    startedBy: userRef("started_by"),
    startedAt: tstz("started_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    verifiedBy: userRef("verified_by"),
    verifiedAt: tstz("verified_at"),
    verificationNote: text("verification_note"),
    ...timestamps(),
  },
  (t) => [index("retroactive_runs_tenant_idx").on(t.tenantId, t.startedAt)],
);

/** Catatan tinjauan akuntan per periode (US-M11-04 KP-5, US-M11-10 KP-5 bukti TG-8) — riwayat lengkap. */
export const periodReviewNotes = pgTable(
  "period_review_notes",
  {
    id: pk(),
    tenantId: tenantRef(),
    periodId: uuid("period_id")
      .notNull()
      .references((): AnyPgColumn => accountingPeriods.id),
    kind: periodReviewKindEnum("kind").notNull().default("review"),
    note: text("note").notNull(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("period_review_notes_period_idx").on(t.periodId, t.createdAt)],
);

/** Pelengkap aset tetap (M11): akumulasi saat cut-over (aset impor) & jurnal perolehan (nota/jurnal manual). */
export const fixedAssetExtras = pgTable(
  "fixed_asset_extras",
  {
    id: pk(),
    fixedAssetId: uuid("fixed_asset_id")
      .notNull()
      .references((): AnyPgColumn => fixedAssets.id),
    /** Akumulasi penyusutan s.d. cut-over (aset dari impor saldo awal). */
    openingAccumulated: money("opening_accumulated").notNull().default(0),
    /** Jurnal perolehan (penambahan dari nota/jurnal manual, US-M11-05 KP-4). */
    acquisitionJournalId: uuid("acquisition_journal_id").references((): AnyPgColumn => journals.id),
    ...timestamps(),
  },
  (t) => [uniqueIndex("fixed_asset_extras_asset_uq").on(t.fixedAssetId)],
);

/** Tarif skema pajak selain PPh final UMKM (US-M11-08 KP-2: "skema lain diinput sebagai parameter"). */
export const taxSchemeRates = pgTable(
  "tax_scheme_rates",
  {
    id: pk(),
    taxSettingId: uuid("tax_setting_id")
      .notNull()
      .references((): AnyPgColumn => taxSettings.id),
    ratePercent: percent("rate_percent").notNull(),
    basis: text("basis").notNull().default("gross_revenue"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("tax_scheme_rates_setting_uq").on(t.taxSettingId)],
);

export const manualJournalDetailsRelations = relations(manualJournalDetails, ({ one }) => ({
  journal: one(journals, { fields: [manualJournalDetails.journalId], references: [journals.id] }),
}));
export const journalPayablesRelations = relations(journalPayables, ({ one, many }) => ({
  journal: one(journals, { fields: [journalPayables.journalId], references: [journals.id] }),
  settlements: many(journalPayableSettlements),
}));
export const journalPayableSettlementsRelations = relations(journalPayableSettlements, ({ one }) => ({
  payable: one(journalPayables, { fields: [journalPayableSettlements.payableId], references: [journalPayables.id] }),
}));
export const periodReviewNotesRelations = relations(periodReviewNotes, ({ one }) => ({
  period: one(accountingPeriods, { fields: [periodReviewNotes.periodId], references: [accountingPeriods.id] }),
}));
