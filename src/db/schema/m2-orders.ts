/**
 * M2 — Pesanan & Penjadwalan Rit (PRD 7.2) + objek rit yang dijalankan M3 (bukti kirim = kolom `trips` + attachments).
 * Nomor pesanan `P-YY-NNNNNN`; nomor rit `P-YY-NNNNNN/n` (D-04, US-M2-02 KP-1).
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
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { enumValues } from "../../lib/labels";
import { businessDate, coord, createdAtOnly, dateStr, liters, meters, money, pk, timestamps, tstz } from "./_columns";
import {
  approvalRef,
  approvalRequests,
  attachmentRef,
  createdBy,
  deliverySlotEnum,
  deviceRef,
  employeeRef,
  employees,
  fieldMeta,
  outletRef,
  outlets,
  paymentMethodEnum,
  tenantRef,
  userRef,
} from "./core";
import {
  customerAddresses,
  customers,
  fuelComponents,
  products,
  specialPrices,
  tariffZones,
  trucks,
  zoneTariffs,
} from "./m1-master";
import { tripExpenses, tripPayments } from "./m3-driver";
import { customerAccounts } from "./p2-customer";

// =====================================================================================================================
// Enum M2
// =====================================================================================================================

export const orderStatusEnum = pgEnum("order_status", enumValues("order_status"));
export const tripStatusEnum = pgEnum("trip_status", enumValues("trip_status"));
export const orderSourceEnum = pgEnum("order_source", enumValues("order_source"));
export const orderPriceSourceEnum = pgEnum("order_price_source", enumValues("order_price_source"));
export const orderCancelReasonEnum = pgEnum("order_cancel_reason", enumValues("order_cancel_reason"));
export const tripFailReasonEnum = pgEnum("trip_fail_reason", enumValues("trip_fail_reason"));
export const partialVolumeReasonEnum = pgEnum("partial_volume_reason", enumValues("partial_volume_reason"));
export const locationReasonEnum = pgEnum("location_reason", enumValues("location_reason"));
export const locationDeviationEnum = pgEnum("location_deviation", enumValues("location_deviation"));
export const loadedWaterDispositionEnum = pgEnum("loaded_water_disposition", enumValues("loaded_water_disposition"));
export const scheduleStatusEnum = pgEnum("schedule_status", enumValues("schedule_status"));
export const scheduleChangeTypeEnum = pgEnum("schedule_change_type", enumValues("schedule_change_type"));
export const recurringStatusEnum = pgEnum("recurring_status", enumValues("recurring_status"));
export const recurringPatternEnum = pgEnum("recurring_pattern", enumValues("recurring_pattern"));
export const recurringFailureReasonEnum = pgEnum("recurring_failure_reason", enumValues("recurring_failure_reason"));
export const crewAssignmentSourceEnum = pgEnum("crew_assignment_source", enumValues("crew_assignment_source"));
export const crewRoleEnum = pgEnum("crew_role", enumValues("crew_role"));
export const crewRosterStatusEnum = pgEnum("crew_roster_status", enumValues("crew_roster_status"));
/** Nama tipe DB `truck_day_state` (bukan `truck_day_status`) karena Postgres membuat tipe komposit bernama sama dengan tabel. */
export const truckDayStatusEnum = pgEnum("truck_day_state", enumValues("truck_day_status"));
export const tripIncidentKindEnum = pgEnum("trip_incident_kind", enumValues("trip_incident_kind"));

// =====================================================================================================================
// Pesanan berulang
// =====================================================================================================================

/** Pesanan berulang / langganan (US-M2-06; dipakai aplikasi pelanggan US-P2-05). */
export const recurringOrders = pgTable(
  "recurring_orders",
  {
    id: pk(),
    tenantId: tenantRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    addressId: uuid("address_id")
      .notNull()
      .references((): AnyPgColumn => customerAddresses.id),
    pattern: recurringPatternEnum("pattern").notNull(),
    /** Hari dalam minggu ISO (1 = Senin … 7 = Minggu) bila pola mingguan. */
    daysOfWeek: smallint("days_of_week").array(),
    /** Interval hari bila pola interval. */
    intervalDays: integer("interval_days"),
    tankCount: integer("tank_count").notNull().default(1),
    requestedTime: time("requested_time"),
    slot: deliverySlotEnum("slot"),
    paymentMethod: paymentMethodEnum("payment_method").notNull().default("cash"),
    startDate: dateStr("start_date").notNull(),
    endDate: dateStr("end_date"),
    status: recurringStatusEnum("status").notNull().default("active"),
    /** Tanggal kirim terakhir yang sudah dibangkitkan (H-2, PAR-34). */
    lastGeneratedDate: dateStr("last_generated_date"),
    /** Asal langganan (kantor / aplikasi pelanggan / portal mitra) — nilai `order_source`. */
    createdVia: orderSourceEnum("created_via").notNull().default("office"),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("recurring_orders_status_idx").on(t.status), index("recurring_orders_customer_idx").on(t.customerId)],
);

/** Pesanan langganan yang gagal dibuat (US-M2-06 KP-4), mis. kredit ditahan. */
export const recurringOrderFailures = pgTable(
  "recurring_order_failures",
  {
    id: pk(),
    recurringOrderId: uuid("recurring_order_id").notNull(),
    targetDate: dateStr("target_date").notNull(),
    reason: recurringFailureReasonEnum("reason").notNull(),
    message: text("message"),
    resolvedAt: tstz("resolved_at"),
    resolvedBy: userRef("resolved_by"),
    orderId: uuid("order_id").references((): AnyPgColumn => orders.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("recurring_order_failures_uq").on(t.recurringOrderId, t.targetDate),
    foreignKey({
      name: "recurring_order_failures_recurring_fk",
      columns: [t.recurringOrderId],
      foreignColumns: [recurringOrders.id],
    }),
  ],
);

// =====================================================================================================================
// Pesanan
// =====================================================================================================================

/**
 * Pesanan (US-M2-01..09). Harga per rit dikunci saat dibuat (US-M1-02 KP-4, BR-19); n tangki → n rit (PTB-09).
 * Pesanan internal pasokan depot: `is_internal`, cara bayar `internal`, produk transfer internal (PTB-01).
 */
export const orders = pgTable(
  "orders",
  {
    id: pk(),
    tenantId: tenantRef(),
    number: text("number").notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    addressId: uuid("address_id")
      .notNull()
      .references((): AnyPgColumn => customerAddresses.id),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    status: orderStatusEnum("status").notNull().default("new"),
    source: orderSourceEnum("source").notNull().default("office"),
    tankCount: integer("tank_count").notNull().default(1),
    requestedDate: dateStr("requested_date").notNull(),
    requestedTime: time("requested_time"),
    /** Slot Tahap 2 (PAR-73). */
    slot: deliverySlotEnum("slot"),
    paymentMethod: paymentMethodEnum("payment_method").notNull().default("cash"),
    // --- harga terkunci (BR-19) ---
    pricePerTrip: money("price_per_trip").notNull(),
    totalAmount: money("total_amount").notNull(),
    priceSource: orderPriceSourceEnum("price_source").notNull(),
    tariffZoneId: uuid("tariff_zone_id").references((): AnyPgColumn => tariffZones.id),
    zoneTariffId: uuid("zone_tariff_id").references((): AnyPgColumn => zoneTariffs.id),
    fuelComponentId: uuid("fuel_component_id").references((): AnyPgColumn => fuelComponents.id),
    specialPriceId: uuid("special_price_id").references((): AnyPgColumn => specialPrices.id),
    /** 7.1.6: alamat tanpa koordinat & tanpa zona manual → "harga sementara"; tidak dapat diterbitkan. */
    priceIsProvisional: boolean("price_is_provisional").notNull().default(false),
    /** PTB-13: harga diperbarui sebelum tanggal kirim dengan konfirmasi pelanggan. */
    priceUpdatedAt: tstz("price_updated_at"),
    priceUpdatedBy: userRef("price_updated_by"),
    priceUpdateNote: text("price_update_note"),
    notes: text("notes"),
    // --- internal (PTB-01) ---
    isInternal: boolean("is_internal").notNull().default(false),
    internalOutletId: outletRef("internal_outlet_id"),
    recurringOrderId: uuid("recurring_order_id").references((): AnyPgColumn => recurringOrders.id),
    // --- aturan & pengesampingan beralasan (6.2c) ---
    /** BR-20: pesanan H+0 setelah 15.00 dipaksa dengan alasan. */
    afterCutoffForced: boolean("after_cutoff_forced").notNull().default(false),
    afterCutoffReason: text("after_cutoff_reason"),
    /** FR-M2-04: kemungkinan dobel (tetap ditandai sampai salah satunya Selesai/Dibatalkan). */
    possibleDuplicate: boolean("possible_duplicate").notNull().default(false),
    duplicateOfOrderId: uuid("duplicate_of_order_id").references((): AnyPgColumn => orders.id),
    duplicateReason: text("duplicate_reason"),
    /** PTB-18: pelanggan punya faktur kurang bayar terbuka → sopir menagih sisanya. */
    collectUnderpayment: boolean("collect_underpayment").notNull().default(false),
    /** Rit gagal → pesanan kembali Baru dengan penanda perlu jadwal ulang (US-M2-09 KP-2). */
    needsReschedule: boolean("needs_reschedule").notNull().default(false),
    /** BR-24: dua rit gagal berturut → wajib "sudah dikonfirmasi ulang". */
    reconfirmationRequired: boolean("reconfirmation_required").notNull().default(false),
    reconfirmedAt: tstz("reconfirmed_at"),
    reconfirmedBy: userRef("reconfirmed_by"),
    reconfirmationMethod: text("reconfirmation_method"),
    // --- kontrol kredit (US-M2-05) ---
    creditApprovalRequestId: approvalRef("credit_approval_request_id"),
    /** KP-5: eksposur & batas saat keputusan. */
    creditExposureAtDecision: money("credit_exposure_at_decision"),
    creditLimitAtDecision: money("credit_limit_at_decision"),
    // --- Tahap 2 / RL-7 ---
    /** PAR-76: SLA pesanan air mitra (≤ 24 jam sejak dibuat). */
    slaDueAt: tstz("sla_due_at"),
    // --- siklus status ---
    scheduledAt: tstz("scheduled_at"),
    firstDepartedAt: tstz("first_departed_at"),
    completedAt: tstz("completed_at"),
    cancelReason: orderCancelReasonEnum("cancel_reason"),
    cancelNote: text("cancel_note"),
    cancelledAt: tstz("cancelled_at"),
    cancelledBy: userRef("cancelled_by"),
    ...timestamps(),
    createdBy: createdBy(),
    /** PTB-18 / US-M2-05 KP-6: persetujuan "pesanan baru saat kurang bayar kedua belum lunas" (terpisah dari kredit). */
    underpaymentApprovalRequestId: uuid("underpayment_approval_request_id"),
    /** Tahap 2 (US-P2-02 KP-4/KP-5, US-M10-05 KP-1): pelaku dari aplikasi pelanggan (bukan `users`). */
    createdByCustomerAccountId: uuid("created_by_customer_account_id"),
    cancelledByCustomerAccountId: uuid("cancelled_by_customer_account_id"),
  },
  (t) => [
    index("orders_customer_date_idx").on(t.customerId, t.requestedDate),
    index("orders_status_date_idx").on(t.status, t.requestedDate),
    index("orders_address_date_idx").on(t.addressId, t.requestedDate),
    index("orders_tenant_date_idx").on(t.tenantId, t.requestedDate),
    // US-M2-06 KP-2/KP-3, KPI-06: job H-2 (PAR-34) tidak pernah membangkitkan pesanan langganan dua kali per tanggal.
    uniqueIndex("orders_recurring_date_uq")
      .on(t.recurringOrderId, t.requestedDate)
      .where(sql`${t.recurringOrderId} is not null`),
    foreignKey({
      name: "orders_underpayment_approval_fk",
      columns: [t.underpaymentApprovalRequestId],
      foreignColumns: [approvalRequests.id],
    }),
    foreignKey({
      name: "orders_created_by_customer_account_fk",
      columns: [t.createdByCustomerAccountId],
      foreignColumns: [customerAccounts.id],
    }),
    foreignKey({
      name: "orders_cancelled_by_customer_account_fk",
      columns: [t.cancelledByCustomerAccountId],
      foreignColumns: [customerAccounts.id],
    }),
  ],
);

/** Riwayat tanggal diminta (US-M2-09 KP-1: penjadwalan ulang beralasan). */
export const orderDateHistory = pgTable(
  "order_date_history",
  {
    id: pk(),
    orderId: uuid("order_id")
      .notNull()
      .references((): AnyPgColumn => orders.id),
    fromDate: dateStr("from_date").notNull(),
    toDate: dateStr("to_date").notNull(),
    fromTime: time("from_time"),
    toTime: time("to_time"),
    reason: text("reason").notNull(),
    changedBy: userRef("changed_by"),
    changedAt: tstz("changed_at").notNull().defaultNow(),
    ...createdAtOnly(),
  },
  (t) => [index("order_date_history_order_idx").on(t.orderId)],
);

// =====================================================================================================================
// Jadwal harian & kru
// =====================================================================================================================

/** Jadwal harian per truk (Draf/Terbit) — papan jadwal US-M2-03. */
export const dailySchedules = pgTable(
  "daily_schedules",
  {
    id: pk(),
    tenantId: tenantRef(),
    businessDate: businessDate().notNull(),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    status: scheduleStatusEnum("status").notNull().default("draft"),
    version: integer("version").notNull().default(0),
    publishedAt: tstz("published_at"),
    publishedBy: userRef("published_by"),
    lastChangedAt: tstz("last_changed_at"),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("daily_schedules_truck_date_uq").on(t.truckId, t.businessDate), index("daily_schedules_date_idx").on(t.businessDate)],
);

/**
 * Rit — satu perjalanan truk 5.000 L untuk satu alamat (PTB-09). Status: Ditugaskan → Berangkat → Tiba → Selesai/Gagal.
 * Bukti kirim (BR-22) & lokasi (BR-23) sebagai kolom; foto di `attachments` (object_type 'trip').
 */
export const trips = pgTable(
  "trips",
  {
    id: pk(),
    tenantId: tenantRef(),
    orderId: uuid("order_id")
      .notNull()
      .references((): AnyPgColumn => orders.id),
    /** P-27-000123/2. */
    number: text("number").notNull().unique(),
    /** Urutan tangki dalam pesanan (1..n). */
    sequenceInOrder: integer("sequence_in_order").notNull(),
    status: tripStatusEnum("status").notNull().default("assigned"),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    addressId: uuid("address_id")
      .notNull()
      .references((): AnyPgColumn => customerAddresses.id),
    isInternal: boolean("is_internal").notNull().default(false),
    destinationOutletId: outletRef("destination_outlet_id"),
    // --- penjadwalan ---
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    scheduledDate: dateStr("scheduled_date").notNull(),
    scheduleId: uuid("schedule_id").references((): AnyPgColumn => dailySchedules.id),
    /** Urutan rencana di papan (BR-21). */
    routeOrder: integer("route_order"),
    /** Urutan aktual (US-M3-02 KP-2). */
    actualOrder: integer("actual_order"),
    publishedAt: tstz("published_at"),
    /** Ditarik dari jadwal (tidak dihapus). */
    withdrawnAt: tstz("withdrawn_at"),
    /** US-M1-03 KP-2: truk berubah status → rit ditandai untuk dipindahkan. */
    needsReassignment: boolean("needs_reassignment").notNull().default(false),
    // --- harga & bayar (dari pesanan) ---
    price: money("price").notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    plannedVolumeL: liters("planned_volume_l").notNull().default(5000),
    // --- pelaksana (US-M2-11 KP-3: rit yang sudah Berangkat tetap atas nama pelaksananya) ---
    driverUserId: userRef("driver_user_id"),
    driverEmployeeId: employeeRef("driver_employee_id"),
    helperEmployeeId: employeeRef("helper_employee_id"),
    // --- Berangkat / Tiba (US-M3-02) ---
    departedAt: tstz("departed_at"),
    departedLat: coord("departed_lat"),
    departedLng: coord("departed_lng"),
    departedAccuracyM: meters("departed_accuracy_m"),
    arrivedAt: tstz("arrived_at"),
    arrivedLat: coord("arrived_lat"),
    arrivedLng: coord("arrived_lng"),
    arrivedAccuracyM: meters("arrived_accuracy_m"),
    arrivalDistanceM: meters("arrival_distance_m"),
    /** US-M3-02 KP-4: status tercatat tanpa lokasi. */
    noLocation: boolean("no_location").notNull().default(false),
    // --- Selesai & bukti kirim (US-M3-03) ---
    completedAt: tstz("completed_at"),
    completedLat: coord("completed_lat"),
    completedLng: coord("completed_lng"),
    completedAccuracyM: meters("completed_accuracy_m"),
    /** Jarak hitungan server (FR-M12-03) — yang berlaku. */
    completionDistanceM: meters("completion_distance_m"),
    completionDistanceClientM: meters("completion_distance_client_m"),
    locationDeviation: locationDeviationEnum("location_deviation").notNull().default("none"),
    locationReason: locationReasonEnum("location_reason"),
    locationReasonNote: text("location_reason_note"),
    /** BR-23: > 1 km → daftar tinjauan pemilik. */
    ownerReviewRequired: boolean("owner_review_required").notNull().default(false),
    ownerReviewedAt: tstz("owner_reviewed_at"),
    ownerReviewedBy: userRef("owner_reviewed_by"),
    ownerReviewNote: text("owner_review_note"),
    deliveredVolumeL: liters("delivered_volume_l"),
    partialVolumeReason: partialVolumeReasonEnum("partial_volume_reason"),
    partialVolumeNote: text("partial_volume_note"),
    recipientName: text("recipient_name"),
    signatureAttachmentId: attachmentRef("signature_attachment_id"),
    /** Tanda tangan dilewati dengan alasan "penerima tidak bersedia/tidak ada". */
    signatureSkippedReason: text("signature_skipped_reason"),
    /** US-M3-03 KP-7: struk WA dilewati dengan alasan singkat. */
    receiptSkippedReason: text("receipt_skipped_reason"),
    // --- Gagal (US-M3-06) ---
    failedAt: tstz("failed_at"),
    failReason: tripFailReasonEnum("fail_reason"),
    failNote: text("fail_note"),
    failLat: coord("fail_lat"),
    failLng: coord("fail_lng"),
    loadedWaterDisposition: loadedWaterDispositionEnum("loaded_water_disposition"),
    // --- konflik sinkron (Bab 6.4 KP-3): lapangan tidak ditimpa kantor ---
    syncConflict: boolean("sync_conflict").notNull().default(false),
    syncConflictNote: text("sync_conflict_note"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
    /**
     * Tanggal bisnis perangkat saat Selesai (Bab 5.3): rit lewat tanggal dapat selesai pada hari lain (KPI-01, H+0 rit
     * per truk). Metadata per aksi lapangan (Berangkat/Tiba/Selesai/Gagal) ada di `trip_status_events`.
     */
    completionBusinessDate: dateStr("completion_business_date"),
    syncConflictResolvedAt: tstz("sync_conflict_resolved_at"),
    syncConflictResolvedBy: userRef("sync_conflict_resolved_by"),
    /** US-M5-03 KP-2 / PTB-27: rit tempo belum Berangkat saat pelanggan menjadi Ditahan → ubah ke tunai atau tarik. */
    creditHoldFlaggedAt: tstz("credit_hold_flagged_at"),
    creditHoldResolution: text("credit_hold_resolution"),
  },
  (t) => [
    index("trips_truck_date_idx").on(t.truckId, t.scheduledDate),
    index("trips_truck_completion_idx").on(t.truckId, t.completionBusinessDate),
    index("trips_order_idx").on(t.orderId),
    index("trips_status_date_idx").on(t.status, t.scheduledDate),
    index("trips_customer_idx").on(t.customerId, t.scheduledDate),
    index("trips_driver_date_idx").on(t.driverUserId, t.scheduledDate),
    uniqueIndex("trips_order_seq_uq").on(t.orderId, t.sequenceInOrder),
  ],
);

/**
 * Riwayat aksi lapangan per rit (Bab 6.7, Bab 5.3, US-M3-03 KP-6, 7.2.6): satu baris per Berangkat/Tiba/Selesai/Gagal
 * dengan waktu perangkat & sinkron, lokasi, perintah sinkron, penanda dicatat kantor / terlambat sinkron / jam
 * menyimpang — tidak saling menimpa seperti `fieldMeta` tunggal di `trips`. Append-only (hardening.sql).
 */
export const tripStatusEvents = pgTable(
  "trip_status_events",
  {
    id: pk(),
    tenantId: tenantRef(),
    tripId: uuid("trip_id")
      .notNull()
      .references((): AnyPgColumn => trips.id),
    status: tripStatusEnum("status").notNull(),
    deviceTime: tstz("device_time"),
    /** Tanggal bisnis WIB di perangkat saat aksi. */
    businessDate: businessDate(),
    syncedAt: tstz("synced_at"),
    lat: coord("lat"),
    lng: coord("lng"),
    accuracyM: meters("accuracy_m"),
    userId: userRef("user_id"),
    deviceId: deviceRef(),
    syncCommandId: uuid("sync_command_id").unique("trip_status_events_sync_command_uq"),
    recordedByOffice: boolean("recorded_by_office").notNull().default(false),
    officeRecordReason: text("office_record_reason"),
    lateSync: boolean("late_sync").notNull().default(false),
    clockSkewFlagged: boolean("clock_skew_flagged").notNull().default(false),
    ...createdAtOnly(),
  },
  (t) => [index("trip_status_events_trip_idx").on(t.tripId, t.createdAt)],
);

/** Log perubahan jadwal (US-M2-03 KP-5: perubahan setelah terbit tercatat & dikirim ke sopir). */
export const scheduleChangeLogs = pgTable(
  "schedule_change_logs",
  {
    id: pk(),
    tenantId: tenantRef(),
    scheduleId: uuid("schedule_id").references((): AnyPgColumn => dailySchedules.id),
    tripId: uuid("trip_id")
      .notNull()
      .references((): AnyPgColumn => trips.id),
    changeType: scheduleChangeTypeEnum("change_type").notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    reason: text("reason"),
    afterPublish: boolean("after_publish").notNull().default(false),
    changedBy: userRef("changed_by"),
    changedAt: tstz("changed_at").notNull().defaultNow(),
    ...createdAtOnly(),
  },
  (t) => [index("schedule_change_logs_trip_idx").on(t.tripId), index("schedule_change_logs_schedule_idx").on(t.scheduleId)],
);

/**
 * Penetapan pengemudi harian per truk (US-M2-11): sopir default / kernet truk / sopir lain. Perubahan = baris baru,
 * baris lama `superseded_at` terisi (berjejak). Satu penetapan aktif per truk per tanggal & per pengemudi per tanggal.
 */
export const crewAssignments = pgTable(
  "crew_assignments",
  {
    id: pk(),
    tenantId: tenantRef(),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    businessDate: businessDate().notNull(),
    driverEmployeeId: uuid("driver_employee_id")
      .notNull()
      .references((): AnyPgColumn => employees.id),
    source: crewAssignmentSourceEnum("source").notNull(),
    reason: text("reason"),
    assignedBy: userRef("assigned_by"),
    supersededAt: tstz("superseded_at"),
    supersededBy: userRef("superseded_by"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("crew_assignments_truck_live_uq")
      .on(t.truckId, t.businessDate)
      .where(sql`${t.supersededAt} is null`),
    uniqueIndex("crew_assignments_driver_live_uq")
      .on(t.driverEmployeeId, t.businessDate)
      .where(sql`${t.supersededAt} is null`),
  ],
);

/** Jadwal kerja kru per karyawan per hari: bertugas di truk X sebagai sopir/kernet, atau libur (US-M2-10). */
export const crewRosters = pgTable(
  "crew_rosters",
  {
    id: pk(),
    tenantId: tenantRef(),
    employeeId: uuid("employee_id")
      .notNull()
      .references((): AnyPgColumn => employees.id),
    businessDate: businessDate().notNull(),
    status: crewRosterStatusEnum("status").notNull().default("on_duty"),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    role: crewRoleEnum("role"),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("crew_rosters_employee_date_uq").on(t.employeeId, t.businessDate), index("crew_rosters_date_idx").on(t.businessDate)],
);

/** Status truk per hari (operasi/perbaikan) & kapasitas rit hari itu (US-M2-10 KP-2). */
export const truckDayStatus = pgTable(
  "truck_day_status",
  {
    id: pk(),
    tenantId: tenantRef(),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    businessDate: businessDate().notNull(),
    status: truckDayStatusEnum("status").notNull().default("operating"),
    /** Kapasitas rit hari itu (kosong = trucks.daily_trip_capacity / PAR-33). */
    tripCapacity: integer("trip_capacity"),
    reason: text("reason"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [uniqueIndex("truck_day_status_truck_date_uq").on(t.truckId, t.businessDate)],
);

/** Kejadian rit & kendala di jalan (US-M2-09 KP-2, US-M3-06 KP-1/3). Foto di attachments (object 'trip_incident'). */
export const tripIncidents = pgTable(
  "trip_incidents",
  {
    id: pk(),
    tenantId: tenantRef(),
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    kind: tripIncidentKindEnum("kind").notNull(),
    description: text("description"),
    occurredAt: tstz("occurred_at").notNull(),
    lat: coord("lat"),
    lng: coord("lng"),
    reportedByUserId: userRef("reported_by_user_id"),
    /** Konfirmasi Dispatcher (kendala "truk rusak" → status truk Perbaikan). */
    acknowledgedAt: tstz("acknowledged_at"),
    acknowledgedBy: userRef("acknowledged_by"),
    truckStatusChanged: boolean("truck_status_changed").notNull().default(false),
    businessDate: businessDate().notNull(),
    ...fieldMeta(),
    ...timestamps(),
  },
  (t) => [
    index("trip_incidents_trip_idx").on(t.tripId),
    index("trip_incidents_date_idx").on(t.businessDate),
    uniqueIndex("trip_incidents_sync_command_uq")
      .on(t.syncCommandId)
      .where(sql`${t.syncCommandId} is not null`),
  ],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  address: one(customerAddresses, { fields: [orders.addressId], references: [customerAddresses.id] }),
  product: one(products, { fields: [orders.productId], references: [products.id] }),
  internalOutlet: one(outlets, { fields: [orders.internalOutletId], references: [outlets.id] }),
  recurringOrder: one(recurringOrders, { fields: [orders.recurringOrderId], references: [recurringOrders.id] }),
  trips: many(trips),
  dateHistory: many(orderDateHistory),
}));

export const orderDateHistoryRelations = relations(orderDateHistory, ({ one }) => ({
  order: one(orders, { fields: [orderDateHistory.orderId], references: [orders.id] }),
}));

export const tripsRelations = relations(trips, ({ one, many }) => ({
  order: one(orders, { fields: [trips.orderId], references: [orders.id] }),
  customer: one(customers, { fields: [trips.customerId], references: [customers.id] }),
  address: one(customerAddresses, { fields: [trips.addressId], references: [customerAddresses.id] }),
  truck: one(trucks, { fields: [trips.truckId], references: [trucks.id] }),
  schedule: one(dailySchedules, { fields: [trips.scheduleId], references: [dailySchedules.id] }),
  destinationOutlet: one(outlets, { fields: [trips.destinationOutletId], references: [outlets.id] }),
  incidents: many(tripIncidents),
  statusEvents: many(tripStatusEvents),
  changeLogs: many(scheduleChangeLogs),
  payments: many(tripPayments),
  expenses: many(tripExpenses),
}));

export const dailySchedulesRelations = relations(dailySchedules, ({ one, many }) => ({
  truck: one(trucks, { fields: [dailySchedules.truckId], references: [trucks.id] }),
  trips: many(trips),
}));

export const scheduleChangeLogsRelations = relations(scheduleChangeLogs, ({ one }) => ({
  trip: one(trips, { fields: [scheduleChangeLogs.tripId], references: [trips.id] }),
  schedule: one(dailySchedules, { fields: [scheduleChangeLogs.scheduleId], references: [dailySchedules.id] }),
}));

export const crewAssignmentsRelations = relations(crewAssignments, ({ one }) => ({
  truck: one(trucks, { fields: [crewAssignments.truckId], references: [trucks.id] }),
  driver: one(employees, { fields: [crewAssignments.driverEmployeeId], references: [employees.id] }),
}));

export const crewRostersRelations = relations(crewRosters, ({ one }) => ({
  employee: one(employees, { fields: [crewRosters.employeeId], references: [employees.id] }),
  truck: one(trucks, { fields: [crewRosters.truckId], references: [trucks.id] }),
}));

export const truckDayStatusRelations = relations(truckDayStatus, ({ one }) => ({
  truck: one(trucks, { fields: [truckDayStatus.truckId], references: [trucks.id] }),
}));

export const recurringOrdersRelations = relations(recurringOrders, ({ one, many }) => ({
  customer: one(customers, { fields: [recurringOrders.customerId], references: [customers.id] }),
  address: one(customerAddresses, { fields: [recurringOrders.addressId], references: [customerAddresses.id] }),
  failures: many(recurringOrderFailures),
  orders: many(orders),
}));

export const recurringOrderFailuresRelations = relations(recurringOrderFailures, ({ one }) => ({
  recurringOrder: one(recurringOrders, {
    fields: [recurringOrderFailures.recurringOrderId],
    references: [recurringOrders.id],
  }),
}));

export const tripStatusEventsRelations = relations(tripStatusEvents, ({ one }) => ({
  trip: one(trips, { fields: [tripStatusEvents.tripId], references: [trips.id] }),
}));

export const tripIncidentsRelations = relations(tripIncidents, ({ one }) => ({
  trip: one(trips, { fields: [tripIncidents.tripId], references: [trips.id] }),
  truck: one(trucks, { fields: [tripIncidents.truckId], references: [trucks.id] }),
}));
