/**
 * M8 — Produksi & Stok Air (PRD 7.8): pembacaan meter (pagi/malam, foto), produksi harian per sumber, pengisian truk per
 * rit (termasuk pasokan depot), neraca air harian & susut (BR-26), level tandon (PTB-41), jadwal & hasil uji mutu.
 * Pasokan depot = pengisian untuk rit internal (`is_depot_supply`) + konfirmasi di `water_supply_receipts` (M6).
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
import { businessDate, dateStr, liters, meterLiters, percent, pk, timestamps, tstz } from "./_columns";
import {
  attachmentRef,
  createdBy,
  employeeRef,
  fieldMeta,
  outletRef,
  outlets,
  tenantRef,
  userRef,
} from "./core";
import { trucks, waterMeters, waterSources } from "./m1-master";
import { trips } from "./m2-orders";

export const meterPhaseEnum = pgEnum("meter_phase", enumValues("meter_phase"));
export const meterReadingStatusEnum = pgEnum("meter_reading_status", enumValues("meter_reading_status"));
export const meterAdjustmentKindEnum = pgEnum("meter_adjustment_kind", enumValues("meter_adjustment_kind"));
export const productionStatusEnum = pgEnum("production_status", enumValues("production_status"));
export const truckFillStatusEnum = pgEnum("truck_fill_status", enumValues("truck_fill_status"));
export const waterBalanceStatusEnum = pgEnum("water_balance_status", enumValues("water_balance_status"));
export const lossReasonEnum = pgEnum("loss_reason", enumValues("loss_reason"));
export const qualityLocationTypeEnum = pgEnum("quality_location_type", enumValues("quality_location_type"));

/**
 * Pembacaan meter pagi (awal) / malam (akhir) per meter (US-M8-01). Angka lebih kecil dari pembacaan sebelumnya
 * ditolak kecuali rollover/penggantian meter oleh admin (KP-2). Koreksi = baris baru; baris lama `superseded_by_id`.
 */
export const meterReadings = pgTable(
  "meter_readings",
  {
    id: pk(),
    tenantId: tenantRef(),
    waterSourceId: uuid("water_source_id")
      .notNull()
      .references((): AnyPgColumn => waterSources.id),
    waterMeterId: uuid("water_meter_id")
      .notNull()
      .references((): AnyPgColumn => waterMeters.id),
    businessDate: businessDate().notNull(),
    phase: meterPhaseEnum("phase").notNull(),
    readingL: meterLiters("reading_l").notNull(),
    photoAttachmentId: attachmentRef("photo_attachment_id"),
    readAt: tstz("read_at").notNull(),
    recordedBy: userRef("recorded_by"),
    status: meterReadingStatusEnum("status").notNull().default("recorded"),
    anomalyNote: text("anomaly_note"),
    adjustmentKind: meterAdjustmentKindEnum("adjustment_kind"),
    adjustmentReason: text("adjustment_reason"),
    verifiedBy: userRef("verified_by"),
    verifiedAt: tstz("verified_at"),
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => meterReadings.id),
    correctionReason: text("correction_reason"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
    // --- Tambahan M8 (hanya tambah) ---
    /** US-M8-01 KP-3: pembacaan yang dicatat setelah jam batas (PAR m8.production_rules) wajib beralasan. */
    lateReason: text("late_reason"),
    /** Putaran meter (KP-2): penyesuaian yang dipakai pembacaan ini (angka lebih kecil dari sebelumnya diterima). */
    adjustmentId: uuid("adjustment_id"),
  },
  (t) => [
    uniqueIndex("meter_readings_meter_date_phase_uq")
      .on(t.waterMeterId, t.businessDate, t.phase)
      .where(sql`${t.supersededById} is null`),
    index("meter_readings_source_date_idx").on(t.waterSourceId, t.businessDate),
    uniqueIndex("meter_readings_sync_command_uq")
      .on(t.syncCommandId)
      .where(sql`${t.syncCommandId} is not null`),
  ],
);

/** Produksi harian per sumber = Σ (akhir − awal) per meter (US-M8-01 KP-1); menyimpang > PAR-68 → verifikasi. */
export const dailyProductions = pgTable(
  "daily_productions",
  {
    id: pk(),
    tenantId: tenantRef(),
    waterSourceId: uuid("water_source_id")
      .notNull()
      .references((): AnyPgColumn => waterSources.id),
    businessDate: businessDate().notNull(),
    producedL: meterLiters("produced_l"),
    status: productionStatusEnum("status").notNull().default("incomplete"),
    incompleteReason: text("incomplete_reason"),
    /** Rincian per meter (awal, akhir, selisih). */
    detail: jsonb("detail").$type<Record<string, unknown>[]>(),
    /** Penyimpangan terhadap rata-rata 7 hari (%). */
    deviationPct: percent("deviation_pct"),
    flaggedForVerification: boolean("flagged_for_verification").notNull().default(false),
    verifiedBy: userRef("verified_by"),
    verifiedAt: tstz("verified_at"),
    computedAt: tstz("computed_at"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("daily_productions_source_date_uq").on(t.waterSourceId, t.businessDate)],
);

/**
 * Pengisian truk per rit (US-M8-02): satu pengisian ↔ satu rit (PTB-09); tanpa rit → ditandai. Pasokan depot ditandai
 * otomatis (US-M8-03). Koreksi oleh Admin Keuangan lewat pembalik (BR-38).
 */
export const truckFills = pgTable(
  "truck_fills",
  {
    id: pk(),
    tenantId: tenantRef(),
    waterSourceId: uuid("water_source_id")
      .notNull()
      .references((): AnyPgColumn => waterSources.id),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    businessDate: businessDate().notNull(),
    volumeL: liters("volume_l").notNull(),
    /** Wajib bila volume ≠ PAR-15 (mis. "sisa muatan", 7.8.6). */
    volumeReason: text("volume_reason"),
    filledAt: tstz("filled_at").notNull(),
    recordedBy: userRef("recorded_by"),
    photoAttachmentId: attachmentRef("photo_attachment_id"),
    status: truckFillStatusEnum("status").notNull().default("recorded"),
    isDepotSupply: boolean("is_depot_supply").notNull().default(false),
    /** Truk di luar rencana sumber ini dipilih dengan konfirmasi (7.8.6). */
    unplannedTruck: boolean("unplanned_truck").notNull().default(false),
    geofenceMismatch: boolean("geofence_mismatch").notNull().default(false),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => truckFills.id),
    reversalReason: text("reversal_reason"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
    /** Baris asal yang sudah dibalik: `reversed_at` + `reversed_by_id` (= baris pembalik). */
    reversedAt: tstz("reversed_at"),
    reversedById: uuid("reversed_by_id"),
    // --- Tambahan M8 (hanya tambah) ---
    /** Rit yang dipilih operator tetapi tidak dapat ditautkan (sudah berpengisian/ditarik kantor) — ditaut kemudian. */
    requestedTripId: uuid("requested_trip_id").references((): AnyPgColumn => trips.id),
    /** Bab 6.4 butir 3: catatan tabrakan dengan data kantor/perangkat lain (tampil ke Admin Keuangan). */
    syncConflictNote: text("sync_conflict_note"),
  },
  (t) => [
    index("truck_fills_source_date_idx").on(t.waterSourceId, t.businessDate),
    index("truck_fills_trip_idx").on(t.tripId),
    index("truck_fills_truck_date_idx").on(t.truckId, t.businessDate),
    foreignKey({ name: "truck_fills_reversed_by_fk", columns: [t.reversedById], foreignColumns: [t.id] }),
    // US-M8-02 KP-2/KP-6, PTB-09: satu pengisian hidup per rit (neraca air tidak rusak oleh pencatatan ganda).
    uniqueIndex("truck_fills_trip_live_uq")
      .on(t.tripId)
      .where(sql`${t.tripId} is not null and ${t.reversalOfId} is null and ${t.reversedAt} is null`),
    uniqueIndex("truck_fills_reversal_uq")
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    uniqueIndex("truck_fills_sync_command_uq")
      .on(t.syncCommandId)
      .where(sql`${t.syncCommandId} is not null`),
  ],
);

/**
 * Neraca air harian per sumber (US-M8-04): produksi − Σ pengisian = susut (L & %); > PAR-18 → investigasi; negatif →
 * anomali, verifikasi Admin Keuangan. Utilisasi = Σ pengisian ÷ kapasitas harian (US-M8-05).
 */
export const waterBalances = pgTable(
  "water_balances",
  {
    id: pk(),
    tenantId: tenantRef(),
    waterSourceId: uuid("water_source_id")
      .notNull()
      .references((): AnyPgColumn => waterSources.id),
    businessDate: businessDate().notNull(),
    producedL: meterLiters("produced_l"),
    filledCustomerL: liters("filled_customer_l").notNull().default(0),
    filledDepotL: liters("filled_depot_l").notNull().default(0),
    filledTotalL: liters("filled_total_l").notNull().default(0),
    lossL: meterLiters("loss_l"),
    lossPct: percent("loss_pct"),
    avgLoss7dPct: percent("avg_loss_7d_pct"),
    utilizationPct: percent("utilization_pct"),
    isIncomplete: boolean("is_incomplete").notNull().default(false),
    status: waterBalanceStatusEnum("status").notNull().default("formed"),
    investigationReason: lossReasonEnum("investigation_reason"),
    investigationNote: text("investigation_note"),
    investigationPhotoId: attachmentRef("investigation_photo_id"),
    investigatedBy: userRef("investigated_by"),
    investigatedAt: tstz("investigated_at"),
    acceptedBy: userRef("accepted_by"),
    acceptedAt: tstz("accepted_at"),
    verifiedBy: userRef("verified_by"),
    verifiedAt: tstz("verified_at"),
    computedAt: tstz("computed_at"),
    ...timestamps(),
    // --- Tambahan M8 (hanya tambah) ---
    /** Air rit gagal yang dikembalikan ke sumber (US-M3-06 KP-2) — dikurangkan dari Σ pengisian. */
    returnedL: liters("returned_l"),
    /** US-M8-04 KP-5: catatan verifikasi Admin Keuangan atas susut negatif. */
    verificationNote: text("verification_note"),
    /** US-M8-04 KP-2: catatan pemilik saat menerima/mengembalikan penjelasan susut. */
    reviewNote: text("review_note"),
  },
  (t) => [
    uniqueIndex("water_balances_source_date_uq").on(t.waterSourceId, t.businessDate),
    index("water_balances_status_idx").on(t.status),
  ],
);

/** Level tandon opsional (PTB-41) untuk menjelaskan pergeseran stok antar hari. */
export const tankLevelReadings = pgTable(
  "tank_level_readings",
  {
    id: pk(),
    tenantId: tenantRef(),
    waterSourceId: uuid("water_source_id")
      .notNull()
      .references((): AnyPgColumn => waterSources.id),
    businessDate: businessDate().notNull(),
    levelL: liters("level_l"),
    levelPct: percent("level_pct"),
    readAt: tstz("read_at").notNull(),
    recordedBy: userRef("recorded_by"),
    photoAttachmentId: attachmentRef("photo_attachment_id"),
    notes: text("notes"),
    ...fieldMeta(),
    ...timestamps(),
  },
  (t) => [
    index("tank_level_readings_source_date_idx").on(t.waterSourceId, t.businessDate),
    uniqueIndex("tank_level_readings_sync_command_uq")
      .on(t.syncCommandId)
      .where(sql`${t.syncCommandId} is not null`),
  ],
);

/** Jadwal uji mutu per lokasi (US-M8-06 KP-1; frekuensi PAR-70; pengingat H-7). */
export const qualityTestSchedules = pgTable(
  "quality_test_schedules",
  {
    id: pk(),
    tenantId: tenantRef(),
    locationType: qualityLocationTypeEnum("location_type").notNull(),
    waterSourceId: uuid("water_source_id").references((): AnyPgColumn => waterSources.id),
    outletId: outletRef(),
    frequencyDays: integer("frequency_days"),
    nextDueDate: dateStr("next_due_date"),
    laboratory: text("laboratory"),
    parameters: jsonb("parameters").$type<string[]>(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("quality_test_schedules_due_idx").on(t.nextDueDate)],
);

/** Hasil uji laboratorium (US-M8-06 KP-2): tidak lulus → tindakan wajib (penanggung jawab, tenggat). */
export const qualityTests = pgTable(
  "quality_tests",
  {
    id: pk(),
    tenantId: tenantRef(),
    scheduleId: uuid("schedule_id").references((): AnyPgColumn => qualityTestSchedules.id),
    locationType: qualityLocationTypeEnum("location_type").notNull(),
    waterSourceId: uuid("water_source_id").references((): AnyPgColumn => waterSources.id),
    outletId: outletRef(),
    testDate: dateStr("test_date").notNull(),
    laboratory: text("laboratory"),
    /** [{ parameter, value, unit, limit, passed }] */
    results: jsonb("results").$type<Record<string, unknown>[]>().notNull(),
    passed: boolean("passed").notNull(),
    certificateAttachmentId: attachmentRef("certificate_attachment_id"),
    actionRequired: text("action_required"),
    actionOwnerEmployeeId: employeeRef("action_owner_employee_id"),
    actionDueDate: dateStr("action_due_date"),
    actionDoneAt: tstz("action_done_at"),
    actionNote: text("action_note"),
    ...timestamps(),
    createdBy: createdBy(),
    // --- Tambahan M8 (hanya tambah) ---
    actionDoneBy: userRef("action_done_by"),
  },
  (t) => [index("quality_tests_location_idx").on(t.locationType, t.waterSourceId, t.outletId, t.testDate)],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const meterReadingsRelations = relations(meterReadings, ({ one }) => ({
  waterSource: one(waterSources, { fields: [meterReadings.waterSourceId], references: [waterSources.id] }),
  meter: one(waterMeters, { fields: [meterReadings.waterMeterId], references: [waterMeters.id] }),
}));

export const dailyProductionsRelations = relations(dailyProductions, ({ one }) => ({
  waterSource: one(waterSources, { fields: [dailyProductions.waterSourceId], references: [waterSources.id] }),
}));

export const truckFillsRelations = relations(truckFills, ({ one }) => ({
  waterSource: one(waterSources, { fields: [truckFills.waterSourceId], references: [waterSources.id] }),
  truck: one(trucks, { fields: [truckFills.truckId], references: [trucks.id] }),
  trip: one(trips, { fields: [truckFills.tripId], references: [trips.id] }),
}));

export const waterBalancesRelations = relations(waterBalances, ({ one }) => ({
  waterSource: one(waterSources, { fields: [waterBalances.waterSourceId], references: [waterSources.id] }),
}));

export const tankLevelReadingsRelations = relations(tankLevelReadings, ({ one }) => ({
  waterSource: one(waterSources, { fields: [tankLevelReadings.waterSourceId], references: [waterSources.id] }),
}));

export const qualityTestSchedulesRelations = relations(qualityTestSchedules, ({ one, many }) => ({
  waterSource: one(waterSources, { fields: [qualityTestSchedules.waterSourceId], references: [waterSources.id] }),
  outlet: one(outlets, { fields: [qualityTestSchedules.outletId], references: [outlets.id] }),
  tests: many(qualityTests),
}));

export const qualityTestsRelations = relations(qualityTests, ({ one }) => ({
  schedule: one(qualityTestSchedules, { fields: [qualityTests.scheduleId], references: [qualityTestSchedules.id] }),
  waterSource: one(waterSources, { fields: [qualityTests.waterSourceId], references: [waterSources.id] }),
  outlet: one(outlets, { fields: [qualityTests.outletId], references: [outlets.id] }),
}));

// =====================================================================================================================
// Tambahan M8 (hanya tambah)
// =====================================================================================================================

/**
 * Putaran (rollover) / penggantian meter yang dicatat admin sistem atau Admin Keuangan dengan alasan (US-M8-01 KP-2,
 * 7.8.6). Putaran: pembacaan pertama sesudahnya boleh lebih kecil dari sebelumnya; produksi = (angka putaran − angka
 * sebelumnya) + angka baru. Penggantian: meter lama ditutup (`water_meters.final_reading_l`), meter baru dengan angka
 * awal; produksi hari itu diestimasi dari rata-rata 7 hari dan ditandai.
 */
export const meterAdjustments = pgTable(
  "meter_adjustments",
  {
    id: pk(),
    tenantId: tenantRef(),
    waterSourceId: uuid("water_source_id")
      .notNull()
      .references((): AnyPgColumn => waterSources.id),
    waterMeterId: uuid("water_meter_id")
      .notNull()
      .references((): AnyPgColumn => waterMeters.id),
    kind: meterAdjustmentKindEnum("kind").notNull(),
    /** Tanggal bisnis kejadian (pembacaan sesudah kejadian bertanggal ini atau sesudahnya). */
    businessDate: businessDate().notNull(),
    occurredAt: tstz("occurred_at").notNull(),
    /** Pembacaan terakhir sebelum kejadian (informasi). */
    previousReadingId: uuid("previous_reading_id").references((): AnyPgColumn => meterReadings.id),
    previousReadingL: meterLiters("previous_reading_l"),
    /** Putaran: angka meter saat kembali ke nol (mis. 100.000.000 L). */
    rolloverAtL: meterLiters("rollover_at_l"),
    /** Penggantian: angka akhir meter lama. */
    finalReadingL: meterLiters("final_reading_l"),
    newMeterId: uuid("new_meter_id").references((): AnyPgColumn => waterMeters.id),
    newInitialReadingL: meterLiters("new_initial_reading_l"),
    /** Putaran: pembacaan pertama sesudah putaran yang memakai penyesuaian ini. */
    appliedReadingId: uuid("applied_reading_id").references((): AnyPgColumn => meterReadings.id),
    reason: text("reason").notNull(),
    photoAttachmentId: attachmentRef("photo_attachment_id"),
    recordedBy: userRef("recorded_by"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("meter_adjustments_meter_date_idx").on(t.waterMeterId, t.businessDate),
    index("meter_adjustments_source_date_idx").on(t.waterSourceId, t.businessDate),
  ],
);

export const meterAdjustmentsRelations = relations(meterAdjustments, ({ one }) => ({
  waterSource: one(waterSources, { fields: [meterAdjustments.waterSourceId], references: [waterSources.id] }),
  meter: one(waterMeters, { fields: [meterAdjustments.waterMeterId], references: [waterMeters.id] }),
}));
