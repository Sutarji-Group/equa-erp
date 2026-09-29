/**
 * Tahap 3 — Portal Kemitraan (PRD Bab 9; feature flag `phase3.partner_portal`) & Paket Minimum Mitra Fase 1 (9.10,
 * RL-7: US-P3-08..11). Mitra = tenant + outlet (Bab 4.3) + pelanggan M1 bertanda mitra depot EQUA. Opsi B/A sebagai
 * parameter kontrak (PTB-55). Pesanan air mitra = pesanan M2; spare part = penjualan M7; tagihan = faktur M5.
 */
import { relations, sql } from "drizzle-orm";
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
import { businessDate, coord, dateStr, meters, money, pk, timestamps, tstz } from "./_columns";
import {
  approvalRef,
  attachmentRef,
  checkResultEnum,
  createdBy,
  fieldMeta,
  outletRef,
  outlets,
  tenantRef,
  tenants,
  userRef,
} from "./core";
import { customers, tariffZones, waterSources } from "./m1-master";
import { orders } from "./m2-orders";
import { invoices } from "./m5-receivables";
import { posSales, shifts } from "./m6-pos";

export const prospectStatusEnum = pgEnum("prospect_status", enumValues("prospect_status"));
export const partnerOptionEnum = pgEnum("partner_option", enumValues("partner_option"));
export const partnerContractStatusEnum = pgEnum("partner_contract_status", enumValues("partner_contract_status"));
export const onboardingItemEnum = pgEnum("onboarding_item", enumValues("onboarding_item"));
export const royaltyStatusEnum = pgEnum("royalty_status", enumValues("royalty_status"));
export const partnerAuditStatusEnum = pgEnum("partner_audit_status", enumValues("partner_audit_status"));
export const sanctionLevelEnum = pgEnum("sanction_level", enumValues("sanction_level"));
export const sanctionStatusEnum = pgEnum("sanction_status", enumValues("sanction_status"));
export const sanctionTriggerEnum = pgEnum("sanction_trigger", enumValues("sanction_trigger"));
export const supportRequestKindEnum = pgEnum("support_request_kind", enumValues("support_request_kind"));
export const supportRequestStatusEnum = pgEnum("support_request_status", enumValues("support_request_status"));

/** Calon mitra (US-P3-01): Prospek → Survei → Dinilai → Disetujui pemilik → Kontrak → Onboarding → Aktif. */
export const partnerProspects = pgTable(
  "partner_prospects",
  {
    id: pk(),
    /** Tenant EQUA yang mengelola prospek. */
    tenantId: tenantRef(),
    name: text("name").notNull(),
    businessEntity: text("business_entity"),
    waPhone: text("wa_phone").notNull(),
    proposedAddress: text("proposed_address"),
    proposedLat: coord("proposed_lat"),
    proposedLng: coord("proposed_lng"),
    capitalAmount: money("capital_amount"),
    status: prospectStatusEnum("status").notNull().default("prospect"),
    referenceWaterSourceId: uuid("reference_water_source_id").references((): AnyPgColumn => waterSources.id),
    routeDistanceM: meters("route_distance_m"),
    tariffZoneId: uuid("tariff_zone_id").references((): AnyPgColumn => tariffZones.id),
    /** Pelanggaran radius eksklusif (PAR-35) → ditolak otomatis kecuali pemilik mengesampingkan dengan alasan. */
    radiusViolation: boolean("radius_violation").notNull().default(false),
    radiusOverrideReason: text("radius_override_reason"),
    radiusOverrideBy: userRef("radius_override_by"),
    /** Ketersediaan kapasitas air (K22, PAR-81). */
    capacityAvailable: boolean("capacity_available"),
    infeasibleReason: text("infeasible_reason"),
    approvalRequestId: approvalRef(),
    /** Tenant mitra yang terbentuk saat kontrak. */
    partnerTenantId: uuid("partner_tenant_id").references((): AnyPgColumn => tenants.id),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("partner_prospects_status_idx").on(t.status)],
);

/** Survei lokasi oleh pembina (BRD 9.5): jarak/rute, kepadatan, pesaing, tata letak + foto (attachments). */
export const partnerSurveys = pgTable(
  "partner_surveys",
  {
    id: pk(),
    prospectId: uuid("prospect_id")
      .notNull()
      .references((): AnyPgColumn => partnerProspects.id),
    surveyedAt: tstz("surveyed_at").notNull(),
    surveyorUserId: userRef("surveyor_user_id"),
    distanceNotes: text("distance_notes"),
    densityNotes: text("density_notes"),
    competitorNotes: text("competitor_notes"),
    layoutNotes: text("layout_notes"),
    scores: jsonb("scores").$type<Record<string, unknown>>(),
    recommendation: text("recommendation"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("partner_surveys_prospect_idx").on(t.prospectId)],
);

/**
 * Kontrak mitra dengan parameter per mitra (9.4; PAR-35, PAR-78): opsi B/A, fee awal, langganan per outlet, royalti,
 * diskon air, radius eksklusif, jangka, batas kredit. Perubahan parameter berlaku periode berikutnya (US-P3-04 KP-5).
 */
export const partnerContracts = pgTable(
  "partner_contracts",
  {
    id: pk(),
    /** Tenant mitra. */
    tenantId: tenantRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    prospectId: uuid("prospect_id").references((): AnyPgColumn => partnerProspects.id),
    number: text("number").notNull().unique(),
    option: partnerOptionEnum("option").notNull().default("option_b"),
    initialFee: money("initial_fee").notNull().default(0),
    subscriptionFeePerOutlet: money("subscription_fee_per_outlet").notNull(),
    /** Royalti dalam basis poin (300 = 3%). Opsi B = 0. */
    royaltyBp: integer("royalty_bp").notNull().default(0),
    waterDiscountBp: integer("water_discount_bp").notNull().default(0),
    exclusiveRadiusM: meters("exclusive_radius_m").notNull(),
    termMonths: integer("term_months").notNull(),
    startDate: dateStr("start_date").notNull(),
    endDate: dateStr("end_date").notNull(),
    creditLimit: money("credit_limit").notNull().default(0),
    monthlyBilling: boolean("monthly_billing").notNull().default(false),
    status: partnerContractStatusEnum("status").notNull().default("draft"),
    agreementAttachmentId: attachmentRef("agreement_attachment_id"),
    approvalRequestId: approvalRef(),
    renewedFromId: uuid("renewed_from_id").references((): AnyPgColumn => partnerContracts.id),
    /** Parameter baru yang berlaku mulai periode berikutnya. */
    pendingTerms: jsonb("pending_terms").$type<Record<string, unknown>>(),
    pendingTermsEffectiveFrom: dateStr("pending_terms_effective_from"),
    evaluationIntervalMonths: integer("evaluation_interval_months").notNull().default(3),
    nextEvaluationDate: dateStr("next_evaluation_date"),
    terminatedAt: tstz("terminated_at"),
    terminationReason: text("termination_reason"),
    /** PTB-58: ekspor data outlet ke mitra ≤ 30 hari saat berakhir. */
    dataExportDueDate: dateStr("data_export_due_date"),
    dataExportedAt: tstz("data_exported_at"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("partner_contracts_tenant_idx").on(t.tenantId, t.status)],
);

/** Wilayah eksklusif per outlet (lingkaran radius dari koordinat outlet). */
export const exclusiveTerritories = pgTable(
  "exclusive_territories",
  {
    id: pk(),
    contractId: uuid("contract_id")
      .notNull()
      .references((): AnyPgColumn => partnerContracts.id),
    outletId: outletRef(),
    centerLat: coord("center_lat").notNull(),
    centerLng: coord("center_lng").notNull(),
    radiusM: meters("radius_m").notNull(),
    validFrom: dateStr("valid_from").notNull(),
    validUntil: dateStr("valid_until"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("exclusive_territories_contract_idx").on(t.contractId)],
);

/** Daftar periksa onboarding (US-P3-01 KP-4): outlet Aktif hanya setelah semua butir wajib dicentang. */
export const onboardingChecklists = pgTable(
  "onboarding_checklists",
  {
    id: pk(),
    contractId: uuid("contract_id")
      .notNull()
      .references((): AnyPgColumn => partnerContracts.id),
    outletId: outletRef(),
    item: onboardingItemEnum("item").notNull(),
    isRequired: boolean("is_required").notNull().default(true),
    completedAt: tstz("completed_at"),
    completedBy: userRef("completed_by"),
    evidenceAttachmentId: attachmentRef("evidence_attachment_id"),
    /** Rujukan objek terkait (pesanan air pertama, perangkat POS, uji air…). */
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("onboarding_checklists_contract_item_uq")
      .on(t.contractId, t.item)
      .where(sql`${t.outletId} is null`),
    uniqueIndex("onboarding_checklists_outlet_item_uq")
      .on(t.contractId, t.outletId, t.item)
      .where(sql`${t.outletId} is not null`),
  ],
);

/** Perhitungan royalti & langganan bulanan per kontrak (US-P3-04, US-P3-09): Sementara → Ditagih. */
export const royaltyCalculations = pgTable(
  "royalty_calculations",
  {
    id: pk(),
    tenantId: tenantRef(),
    contractId: uuid("contract_id")
      .notNull()
      .references((): AnyPgColumn => partnerContracts.id),
    /** Bulan layanan 'YYYY-MM'. */
    period: text("period").notNull(),
    outletCount: integer("outlet_count").notNull(),
    subscriptionAmount: money("subscription_amount").notNull(),
    /** Omzet POS tercatat (transaksi Sah, tanpa void). */
    grossSales: money("gross_sales").notNull().default(0),
    royaltyBp: integer("royalty_bp").notNull().default(0),
    royaltyAmount: money("royalty_amount").notNull().default(0),
    /** Rincian omzet per outlet per hari (dasar royalti, KP-2). */
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    status: royaltyStatusEnum("status").notNull().default("provisional"),
    invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
    computedAt: tstz("computed_at").notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("royalty_calculations_contract_period_uq").on(t.contractId, t.period)],
);

/** Daftar periksa mutu harian di POS (US-P3-05 KP-1, S): diisi operator saat buka shift. */
export const qualityChecklists = pgTable(
  "quality_checklists",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    businessDate: businessDate().notNull(),
    shiftId: uuid("shift_id").references((): AnyPgColumn => shifts.id),
    filledBy: userRef("filled_by"),
    filledAt: tstz("filled_at").notNull(),
    passedAll: boolean("passed_all").notNull(),
    ...fieldMeta(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("quality_checklists_outlet_date_uq").on(t.outletId, t.businessDate),
    uniqueIndex("quality_checklists_sync_command_uq")
      .on(t.syncCommandId)
      .where(sql`${t.syncCommandId} is not null`),
  ],
);

export const qualityChecklistItems = pgTable(
  "quality_checklist_items",
  {
    id: pk(),
    /** NFR-30: disalin dari `quality_checklists.tenant_id`. */
    tenantId: tenantRef(),
    checklistId: uuid("checklist_id")
      .notNull()
      .references((): AnyPgColumn => qualityChecklists.id),
    itemKey: text("item_key").notNull(),
    label: text("label").notNull(),
    result: checkResultEnum("result").notNull(),
    photoAttachmentId: attachmentRef("photo_attachment_id"),
    /** Butir tidak lulus memerlukan tindakan. */
    actionNote: text("action_note"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("quality_checklist_items_uq").on(t.checklistId, t.itemKey),
    index("quality_checklist_items_tenant_idx").on(t.tenantId, t.checklistId),
  ],
);

/** Audit pembina per outlet (US-P3-05 KP-2): skor per butir, foto, temuan, tenggat tindak lanjut. */
export const partnerAudits = pgTable(
  "partner_audits",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    contractId: uuid("contract_id").references((): AnyPgColumn => partnerContracts.id),
    scheduledDate: dateStr("scheduled_date").notNull(),
    conductedAt: tstz("conducted_at"),
    auditorUserId: userRef("auditor_user_id"),
    status: partnerAuditStatusEnum("status").notNull().default("scheduled"),
    score: numeric("score", { precision: 5, scale: 2, mode: "number" }),
    items: jsonb("items").$type<Record<string, unknown>[]>(),
    findings: jsonb("findings").$type<Record<string, unknown>[]>(),
    followUpDueDate: dateStr("follow_up_due_date"),
    followUpDoneAt: tstz("follow_up_done_at"),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("partner_audits_outlet_idx").on(t.outletId, t.scheduledDate)],
);

/** Skor mutu bulanan per outlet (US-P3-05 KP-4): gabungan daftar periksa, audit, uji (bobot pemilik); < PAR-80 → teguran. */
export const partnerScores = pgTable(
  "partner_scores",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    period: text("period").notNull(),
    checklistScore: numeric("checklist_score", { precision: 5, scale: 2, mode: "number" }),
    auditScore: numeric("audit_score", { precision: 5, scale: 2, mode: "number" }),
    testScore: numeric("test_score", { precision: 5, scale: 2, mode: "number" }),
    weights: jsonb("weights").$type<Record<string, number>>(),
    totalScore: numeric("total_score", { precision: 5, scale: 2, mode: "number" }).notNull(),
    belowThreshold: boolean("below_threshold").notNull().default(false),
    computedAt: tstz("computed_at").notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("partner_scores_outlet_period_uq").on(t.outletId, t.period)],
);

/**
 * Sanksi bertingkat (US-P3-07, PTB-59): pemicu tercatat otomatis, setiap tahap diputuskan pemilik — Teguran →
 * Penghentian pasokan sementara → Pemutusan.
 */
export const partnerSanctions = pgTable(
  "partner_sanctions",
  {
    id: pk(),
    tenantId: tenantRef(),
    contractId: uuid("contract_id")
      .notNull()
      .references((): AnyPgColumn => partnerContracts.id),
    level: sanctionLevelEnum("level").notNull(),
    status: sanctionStatusEnum("status").notNull().default("triggered"),
    trigger: sanctionTriggerEnum("trigger").notNull(),
    triggerDetail: jsonb("trigger_detail").$type<Record<string, unknown>>(),
    approvalRequestId: approvalRef(),
    decidedBy: userRef("decided_by"),
    decidedAt: tstz("decided_at"),
    decisionReason: text("decision_reason"),
    letterAttachmentId: attachmentRef("letter_attachment_id"),
    effectiveFrom: dateStr("effective_from"),
    liftedAt: tstz("lifted_at"),
    liftedBy: userRef("lifted_by"),
    liftReason: text("lift_reason"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("partner_sanctions_contract_idx").on(t.contractId, t.status)],
);

/** Permintaan dukungan teknis mitra (US-P3-11, S): Diajukan → Ditanggapi (SLA PAR-76 48 jam) → Selesai. */
export const partnerSupportRequests = pgTable(
  "partner_support_requests",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    kind: supportRequestKindEnum("kind").notNull(),
    description: text("description").notNull(),
    photoAttachmentId: attachmentRef("photo_attachment_id"),
    status: supportRequestStatusEnum("status").notNull().default("submitted"),
    submittedAt: tstz("submitted_at").notNull().defaultNow(),
    submittedBy: userRef("submitted_by"),
    slaDueAt: tstz("sla_due_at"),
    slaBreached: boolean("sla_breached").notNull().default(false),
    respondedAt: tstz("responded_at"),
    respondedBy: userRef("responded_by"),
    response: text("response"),
    doneAt: tstz("done_at"),
    /** Spare part dipesan lewat M7 harga mitra (KP-3). */
    relatedPosSaleId: uuid("related_pos_sale_id").references((): AnyPgColumn => posSales.id),
    ...timestamps(),
  },
  (t) => [index("partner_support_requests_status_idx").on(t.status, t.submittedAt)],
);

/** Laporan bulanan mitra (US-P3-10 KP-3; BRD 9.8) — terbit otomatis tanggal 5, unduh PDF. */
export const partnerMonthlyReports = pgTable(
  "partner_monthly_reports",
  {
    id: pk(),
    /** Tenant mitra. */
    tenantId: tenantRef(),
    period: text("period").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    slaSummary: jsonb("sla_summary").$type<Record<string, unknown>>(),
    pdfAttachmentId: attachmentRef("pdf_attachment_id"),
    publishedAt: tstz("published_at"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("partner_monthly_reports_tenant_period_uq").on(t.tenantId, t.period)],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const partnerProspectsRelations = relations(partnerProspects, ({ many }) => ({
  surveys: many(partnerSurveys),
  contracts: many(partnerContracts),
}));

export const partnerSurveysRelations = relations(partnerSurveys, ({ one }) => ({
  prospect: one(partnerProspects, { fields: [partnerSurveys.prospectId], references: [partnerProspects.id] }),
}));

export const partnerContractsRelations = relations(partnerContracts, ({ one, many }) => ({
  tenant: one(tenants, { fields: [partnerContracts.tenantId], references: [tenants.id] }),
  customer: one(customers, { fields: [partnerContracts.customerId], references: [customers.id] }),
  prospect: one(partnerProspects, { fields: [partnerContracts.prospectId], references: [partnerProspects.id] }),
  territories: many(exclusiveTerritories),
  onboarding: many(onboardingChecklists),
  royalties: many(royaltyCalculations),
  sanctions: many(partnerSanctions),
}));

export const exclusiveTerritoriesRelations = relations(exclusiveTerritories, ({ one }) => ({
  contract: one(partnerContracts, { fields: [exclusiveTerritories.contractId], references: [partnerContracts.id] }),
}));

export const onboardingChecklistsRelations = relations(onboardingChecklists, ({ one }) => ({
  contract: one(partnerContracts, { fields: [onboardingChecklists.contractId], references: [partnerContracts.id] }),
}));

export const royaltyCalculationsRelations = relations(royaltyCalculations, ({ one }) => ({
  contract: one(partnerContracts, { fields: [royaltyCalculations.contractId], references: [partnerContracts.id] }),
  invoice: one(invoices, { fields: [royaltyCalculations.invoiceId], references: [invoices.id] }),
}));

export const qualityChecklistsRelations = relations(qualityChecklists, ({ one, many }) => ({
  outlet: one(outlets, { fields: [qualityChecklists.outletId], references: [outlets.id] }),
  items: many(qualityChecklistItems),
}));

export const qualityChecklistItemsRelations = relations(qualityChecklistItems, ({ one }) => ({
  checklist: one(qualityChecklists, { fields: [qualityChecklistItems.checklistId], references: [qualityChecklists.id] }),
}));

export const partnerAuditsRelations = relations(partnerAudits, ({ one }) => ({
  outlet: one(outlets, { fields: [partnerAudits.outletId], references: [outlets.id] }),
  contract: one(partnerContracts, { fields: [partnerAudits.contractId], references: [partnerContracts.id] }),
}));

export const partnerScoresRelations = relations(partnerScores, ({ one }) => ({
  outlet: one(outlets, { fields: [partnerScores.outletId], references: [outlets.id] }),
}));

export const partnerSanctionsRelations = relations(partnerSanctions, ({ one }) => ({
  contract: one(partnerContracts, { fields: [partnerSanctions.contractId], references: [partnerContracts.id] }),
}));

export const partnerSupportRequestsRelations = relations(partnerSupportRequests, ({ one }) => ({
  outlet: one(outlets, { fields: [partnerSupportRequests.outletId], references: [outlets.id] }),
}));

export const partnerMonthlyReportsRelations = relations(partnerMonthlyReports, ({ one }) => ({
  tenant: one(tenants, { fields: [partnerMonthlyReports.tenantId], references: [tenants.id] }),
}));

// =====================================================================================================================
// Tambahan modul P3 (hanya tambah) — pesanan dari portal mitra (Tahap 3) & evaluasi berkala kontrak
// =====================================================================================================================

export const portalOrderKindEnum = pgEnum("portal_order_kind", enumValues("portal_order_kind"));
export const portalOrderStatusEnum = pgEnum("portal_order_status", enumValues("portal_order_status"));
export const sparePartPickupEnum = pgEnum("spare_part_pickup", enumValues("spare_part_pickup"));

/**
 * Pesanan dari portal mitra (US-P3-03, Tahap 3 — flag `phase3.partner_portal`): air → pesanan M2 (`orders`, asal
 * `partner_portal`, harga zona − diskon Opsi A); spare part → dikonfirmasi kasir toko sebagai penjualan M7 harga mitra
 * (`pos_sales`), diambil di toko atau ikut truk air (ditandai pada rit).
 */
export const partnerPortalOrders = pgTable(
  "partner_portal_orders",
  {
    id: pk(),
    /** Tenant mitra pemesan. */
    tenantId: tenantRef(),
    contractId: uuid("contract_id")
      .notNull()
      .references((): AnyPgColumn => partnerContracts.id),
    /** Pelanggan mitra di tenant EQUA (M1). */
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    /** Outlet mitra tujuan. */
    outletId: outletRef(),
    kind: portalOrderKindEnum("kind").notNull(),
    status: portalOrderStatusEnum("status").notNull().default("submitted"),
    requestedDate: dateStr("requested_date"),
    requestedTime: text("requested_time"),
    tankCount: integer("tank_count"),
    paymentMethod: text("payment_method"),
    /** Spare part: [{ productId, code, name, quantity, unitPrice }] (harga mitra BR-18 saat dipesan). */
    items: jsonb("items").$type<Record<string, unknown>[]>(),
    pickup: sparePartPickupEnum("pickup"),
    estimatedAmount: money("estimated_amount").notNull().default(0),
    /** Pesanan M2 yang terbentuk (air). */
    orderId: uuid("order_id").references((): AnyPgColumn => orders.id),
    /** Penjualan toko M7 yang mengonfirmasi (spare part). */
    posSaleId: uuid("pos_sale_id").references((): AnyPgColumn => posSales.id),
    submittedBy: userRef("submitted_by"),
    submittedAt: tstz("submitted_at").notNull().defaultNow(),
    confirmedAt: tstz("confirmed_at"),
    rejectedReason: text("rejected_reason"),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [
    index("partner_portal_orders_tenant_idx").on(t.tenantId, t.status),
    uniqueIndex("partner_portal_orders_pos_sale_uq")
      .on(t.posSaleId)
      .where(sql`${t.posSaleId} is not null`),
  ],
);

/** Evaluasi berkala mitra (US-P3-01 KP-5; PAR-77): dijadwalkan otomatis dari kontrak, dicatat pembina. */
export const partnerEvaluations = pgTable(
  "partner_evaluations",
  {
    id: pk(),
    /** Tenant mitra. */
    tenantId: tenantRef(),
    contractId: uuid("contract_id")
      .notNull()
      .references((): AnyPgColumn => partnerContracts.id),
    dueDate: dateStr("due_date").notNull(),
    conductedAt: tstz("conducted_at"),
    conductedBy: userRef("conducted_by"),
    /** Ringkasan angka saat evaluasi (omzet, neraca air, tunggakan, skor). */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    summary: text("summary"),
    recommendation: text("recommendation"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("partner_evaluations_contract_due_uq").on(t.contractId, t.dueDate)],
);

export const partnerPortalOrdersRelations = relations(partnerPortalOrders, ({ one }) => ({
  contract: one(partnerContracts, { fields: [partnerPortalOrders.contractId], references: [partnerContracts.id] }),
  customer: one(customers, { fields: [partnerPortalOrders.customerId], references: [customers.id] }),
  order: one(orders, { fields: [partnerPortalOrders.orderId], references: [orders.id] }),
  posSale: one(posSales, { fields: [partnerPortalOrders.posSaleId], references: [posSales.id] }),
}));

export const partnerEvaluationsRelations = relations(partnerEvaluations, ({ one }) => ({
  contract: one(partnerContracts, { fields: [partnerEvaluations.contractId], references: [partnerContracts.id] }),
}));
