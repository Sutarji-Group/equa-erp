/**
 * M9 — Laporan & Dashboard Pemilik (PRD 7.9). M9 tidak memiliki transaksi sendiri; tabel di sini menyimpan snapshot
 * yang WAJIB tidak berubah (H+0 terbit, laporan Final), input manual KPI, dan catatan periode paralel (NFR-35).
 */
import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { enumValues } from "../../lib/labels";
import { businessDate, dateStr, money, pk, refId, timestamps, tstz } from "./_columns";
import { createdBy, outletRef, outlets, tenantRef, unitTypeEnum, userRef } from "./core";
import { trucks } from "./m1-master";
import { cashDays } from "./m4-cash";

export const dailySummaryStatusEnum = pgEnum("daily_summary_status", enumValues("daily_summary_status"));
export const summaryAddendumKindEnum = pgEnum("summary_addendum_kind", enumValues("summary_addendum_kind"));
export const reportStatusEnum = pgEnum("report_status", enumValues("report_status"));

/**
 * Ringkasan H+0 per tanggal (US-M9-01, US-M4-06 KP-5): terbit ≤ 30 menit setelah tutup kas (NFR-04); snapshot enam
 * blok terkunci setelah terbit — koreksi & transaksi terlambat sinkron menjadi addendum (KP-6).
 */
export const dailySummaries = pgTable(
  "daily_summaries",
  {
    id: pk(),
    tenantId: tenantRef(),
    businessDate: businessDate().notNull(),
    status: dailySummaryStatusEnum("status").notNull().default("running"),
    cashDayId: uuid("cash_day_id").references((): AnyPgColumn => cashDays.id),
    /** Snapshot terkunci: omzet per lini, kas, piutang, rit per truk, galon per depot, pengecualian. */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    cashClosedAt: tstz("cash_closed_at"),
    publishedAt: tstz("published_at"),
    /** Terbit > 30 menit setelah tutup kas atau tutup kas terlambat (7.9.7). */
    publishedLate: boolean("published_late").notNull().default(false),
    reviewedBy: userRef("reviewed_by"),
    reviewedAt: tstz("reviewed_at"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("daily_summaries_tenant_date_uq").on(t.tenantId, t.businessDate)],
);

/** Catatan tambahan bertanda pada H+0 yang sudah terbit (transaksi terlambat sinkron, koreksi; US-M9-01 KP-6). */
export const dailySummaryAddenda = pgTable(
  "daily_summary_addenda",
  {
    id: pk(),
    dailySummaryId: uuid("daily_summary_id")
      .notNull()
      .references((): AnyPgColumn => dailySummaries.id),
    businessDate: businessDate().notNull(),
    kind: summaryAddendumKindEnum("kind").notNull(),
    objectType: text("object_type"),
    objectId: text("object_id"),
    description: text("description").notNull(),
    /** Perubahan angka per blok (informasi; snapshot tidak berubah). */
    delta: jsonb("delta").$type<Record<string, unknown>>(),
    /** Tanggal koreksi dicatat (koreksi tampil pada tanggal koreksi dengan rujukan hari asal, 7.9.7). */
    recordedOn: dateStr("recorded_on").notNull(),
    ...timestamps(),
  },
  (t) => [index("daily_summary_addenda_summary_idx").on(t.dailySummaryId)],
);

/**
 * Snapshot laporan (US-M9-02, US-M11-04 KP-2): "Sementara" pada periode terbuka, "Final" setelah dikunci; versi Final
 * tersimpan & identik saat dibuka ulang (US-M9-03 KP-4); pembukaan periode → revisi baru (US-M11-10 KP-4).
 */
export const reportSnapshots = pgTable(
  "report_snapshots",
  {
    id: pk(),
    tenantId: tenantRef(),
    reportKey: text("report_key").notNull(),
    /** Mis. '2026-09' atau '2026-W39'. */
    period: text("period").notNull(),
    revision: integer("revision").notNull().default(1),
    status: reportStatusEnum("status").notNull().default("provisional"),
    filters: jsonb("filters").$type<Record<string, unknown>>(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    fileSha256: text("file_sha256"),
    accountingPeriodId: refId("accounting_period_id"),
    generatedAt: tstz("generated_at").notNull().defaultNow(),
    generatedBy: userRef("generated_by"),
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => reportSnapshots.id),
    ...timestamps(),
  },
  (t) => [uniqueIndex("report_snapshots_uq").on(t.tenantId, t.reportKey, t.period, t.revision)],
);

/** Input manual KPI (US-M9-07 KP-2): KPI-10 jam pemilik per minggu, dll. */
export const kpiManualInputs = pgTable(
  "kpi_manual_inputs",
  {
    id: pk(),
    tenantId: tenantRef(),
    kpiCode: text("kpi_code").notNull(),
    period: text("period").notNull(),
    value: numeric("value", { precision: 14, scale: 2, mode: "number" }).notNull(),
    note: text("note"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("kpi_manual_inputs_uq").on(t.tenantId, t.kpiCode, t.period)],
);

/** Tanggal nota kertas ditarik per unit (NFR-35, 11.5; masukan KPI-11) + perpanjangan PAR-88. */
export const unitPaperWithdrawals = pgTable(
  "unit_paper_withdrawals",
  {
    id: pk(),
    tenantId: tenantRef(),
    unitType: unitTypeEnum("unit_type").notNull(),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    outletId: outletRef(),
    parallelStartDate: dateStr("parallel_start_date").notNull(),
    withdrawnDate: dateStr("withdrawn_date"),
    /** Penarikan lebih cepat dengan persetujuan pemilik bila PAR-84 terpenuhi. */
    earlyWithdrawalApprovedBy: userRef("early_withdrawal_approved_by"),
    extensionDays: integer("extension_days").notNull().default(0),
    extensionReason: text("extension_reason"),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("unit_paper_withdrawals_unit_idx").on(t.unitType, t.truckId, t.outletId)],
);

/** Lembar pencocokan harian nota kertas vs sistem per unit (NFR-35, 11.5 butir 1; KPI-05). */
export const parallelRunChecks = pgTable(
  "parallel_run_checks",
  {
    id: pk(),
    tenantId: tenantRef(),
    unitType: unitTypeEnum("unit_type").notNull(),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    outletId: outletRef(),
    businessDate: businessDate().notNull(),
    paperCount: integer("paper_count").notNull(),
    paperAmount: money("paper_amount").notNull(),
    systemCount: integer("system_count").notNull(),
    systemAmount: money("system_amount").notNull(),
    differenceCount: integer("difference_count").notNull(),
    differenceAmount: money("difference_amount").notNull(),
    /** Penyebab selisih: terjelaskan / tak terjelaskan. */
    explained: boolean("explained").notNull().default(true),
    cause: text("cause"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("parallel_run_checks_unit_date_idx").on(t.unitType, t.truckId, t.outletId, t.businessDate)],
);

export const dailySummariesRelations = relations(dailySummaries, ({ one, many }) => ({
  cashDay: one(cashDays, { fields: [dailySummaries.cashDayId], references: [cashDays.id] }),
  addenda: many(dailySummaryAddenda),
}));

export const dailySummaryAddendaRelations = relations(dailySummaryAddenda, ({ one }) => ({
  summary: one(dailySummaries, { fields: [dailySummaryAddenda.dailySummaryId], references: [dailySummaries.id] }),
}));

export const unitPaperWithdrawalsRelations = relations(unitPaperWithdrawals, ({ one }) => ({
  truck: one(trucks, { fields: [unitPaperWithdrawals.truckId], references: [trucks.id] }),
  outlet: one(outlets, { fields: [unitPaperWithdrawals.outletId], references: [outlets.id] }),
}));

export const parallelRunChecksRelations = relations(parallelRunChecks, ({ one }) => ({
  truck: one(trucks, { fields: [parallelRunChecks.truckId], references: [trucks.id] }),
  outlet: one(outlets, { fields: [parallelRunChecks.outletId], references: [outlets.id] }),
}));
