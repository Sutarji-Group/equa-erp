/**
 * M12 — Pelacakan Armada / GPS (PRD 7.12): posisi mentah (perangkat GPS / ponsel / titik status), kejadian armada
 * (penyimpangan lokasi, perjalanan di luar jadwal/jam, berhenti tidak dikenal, perangkat mati, geofence…), jejak per rit,
 * ringkasan per truk per hari, aktivasi GPS ponsel cadangan, estimasi biaya BBM per rit (S, RL-6).
 * Status perangkat GPS ada di kolom `devices.gps_*` (core).
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
  real,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { enumValues } from "../../lib/labels";
import { businessDate, coord, dateStr, meters, money, pk, refId, timestamps, tstz } from "./_columns";
import { devices, geofenceLocationTypeEnum, tenantRef, userRef } from "./core";
import { trucks } from "./m1-master";
import { trips } from "./m2-orders";

export const positionSourceEnum = pgEnum("position_source", enumValues("position_source"));
export const fleetEventKindEnum = pgEnum("fleet_event_kind", enumValues("fleet_event_kind"));
export const fleetEventStatusEnum = pgEnum("fleet_event_status", enumValues("fleet_event_status"));
export const fleetReviewDecisionEnum = pgEnum("fleet_review_decision", enumValues("fleet_review_decision"));
export const phoneTrackingReasonEnum = pgEnum("phone_tracking_reason", enumValues("phone_tracking_reason"));

/**
 * Posisi mentah (US-M12-01): waktu perangkat & server, kualitas, sumber. Retensi 12 bulan (PAR-52). Indeks utama
 * (truck_id, device_time).
 */
export const gpsPositions = pgTable(
  "gps_positions",
  {
    id: pk(),
    tenantId: tenantRef(),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    deviceId: uuid("device_id").references((): AnyPgColumn => devices.id),
    source: positionSourceEnum("source").notNull(),
    deviceTime: tstz("device_time").notNull(),
    serverTime: tstz("server_time").notNull().defaultNow(),
    lat: coord("lat").notNull(),
    lng: coord("lng").notNull(),
    speedKmh: real("speed_kmh"),
    heading: smallint("heading"),
    accuracyM: real("accuracy_m"),
    ignitionOn: boolean("ignition_on"),
    powerConnected: boolean("power_connected"),
    /** Posisi berakurasi buruk tetap disimpan tetapi tidak dipakai deteksi (KP-5). */
    isValid: boolean("is_valid").notNull().default(true),
    /** PAR-42: waktu perangkat menyimpang > 10 menit. */
    clockSkewFlagged: boolean("clock_skew_flagged").notNull().default(false),
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    userId: userRef("user_id"),
    // --- Tambahan M12 (hanya tambah) ---
    /** NFR-21: kunci penghubung vendor yang menerima posisi ini (`generic-json`, `osmand`, …). */
    vendor: text("vendor"),
    /** US-M12-01 KP-1: posisi mentah dari vendor (sebelum dipetakan ke format internal) — audit penggantian vendor (R05). */
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("gps_positions_truck_time_idx").on(t.truckId, t.deviceTime),
    index("gps_positions_device_time_idx").on(t.deviceId, t.deviceTime),
    index("gps_positions_trip_idx").on(t.tripId),
    // US-M12-01 KP-1/KP-6: retry penghubung vendor / kirim ulang outbox GPS ponsel tidak menggandakan posisi.
    uniqueIndex("gps_positions_dedupe_uq").on(t.truckId, t.source, t.deviceTime),
    // NFR-21 / PAR-52: job retensi 12 bulan menghapus berdasarkan waktu lintas truk (withRetentionPurge).
    index("gps_positions_time_idx").on(t.deviceTime),
  ],
);

/**
 * Kejadian armada (US-M12-04/05/06/08): Terdeteksi → Keterangan sopir (BR-25, hari yang sama) → Ditinjau pemilik →
 * Selesai. Keterangan perjalanan = `explanation` + tugas di aplikasi sopir (ARCHITECTURE §4).
 */
export const fleetEvents = pgTable(
  "fleet_events",
  {
    id: pk(),
    tenantId: tenantRef(),
    kind: fleetEventKindEnum("kind").notNull(),
    status: fleetEventStatusEnum("status").notNull().default("detected"),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    deviceId: uuid("device_id").references((): AnyPgColumn => devices.id),
    /** Pengguna aktif pada perangkat saat kejadian (KP-3). */
    userId: userRef("user_id"),
    businessDate: businessDate().notNull(),
    startedAt: tstz("started_at").notNull(),
    endedAt: tstz("ended_at"),
    durationS: integer("duration_s"),
    distanceM: meters("distance_m"),
    lat: coord("lat"),
    lng: coord("lng"),
    /** Lokasi sah/geofence terkait (sumber air, outlet, pool). */
    locationType: geofenceLocationTypeEnum("location_type"),
    locationId: refId("location_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    /** Butuh keterangan sopir (BR-25). */
    requiresExplanation: boolean("requires_explanation").notNull().default(false),
    explanation: text("explanation"),
    explainedBy: userRef("explained_by"),
    explainedAt: tstz("explained_at"),
    /**
     * Metadata offline keterangan BR-25 (US-M3-06 KP-4, US-M12-05 KP-3/KP-4): waktu isi di perangkat ≠ waktu sinkron;
     * "hari yang sama" dinilai dari `explanation_business_date`; terlambat → `explanation_late`.
     */
    explanationDeviceTime: tstz("explanation_device_time"),
    explanationDeviceId: uuid("explanation_device_id").references((): AnyPgColumn => devices.id),
    explanationSyncCommandId: uuid("explanation_sync_command_id"),
    explanationBusinessDate: dateStr("explanation_business_date"),
    explanationLate: boolean("explanation_late").notNull().default(false),
    reviewDecision: fleetReviewDecisionEnum("review_decision"),
    reviewNote: text("review_note"),
    reviewedBy: userRef("reviewed_by"),
    reviewedAt: tstz("reviewed_at"),
    doneAt: tstz("done_at"),
    ...timestamps(),
    // --- Tambahan M12 (hanya tambah) ---
    /**
     * Kunci pemicu kejadian (mis. `loc:<rit>`, `move:<truk>:<mulai>`, `dev:<perangkat>:<mulai>`): job deteksi tiap 5
     * menit & handler event dapat berjalan ulang tanpa menggandakan kejadian (BR-38: kejadian tidak dihapus).
     */
    dedupeKey: text("dedupe_key"),
  },
  (t) => [
    index("fleet_events_truck_date_idx").on(t.truckId, t.businessDate),
    index("fleet_events_status_kind_idx").on(t.status, t.kind),
    index("fleet_events_trip_idx").on(t.tripId),
    uniqueIndex("fleet_events_dedupe_uq")
      .on(t.tenantId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

/** Jejak per rit (US-M12-03 KP-1): jarak, durasi, titik berhenti ≥ PAR-49, lama di lokasi pelanggan. */
export const tripTracks = pgTable(
  "trip_tracks",
  {
    id: pk(),
    tripId: uuid("trip_id")
      .notNull()
      .unique("trip_tracks_trip_uq")
      .references((): AnyPgColumn => trips.id),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    startedAt: tstz("started_at"),
    endedAt: tstz("ended_at"),
    distanceM: meters("distance_m"),
    durationS: integer("duration_s"),
    /** [{ lat, lng, startedAt, endedAt, durationS }] */
    stops: jsonb("stops").$type<Record<string, unknown>[]>(),
    timeAtCustomerS: integer("time_at_customer_s"),
    /** Jejak disederhanakan untuk peta/putar ulang. */
    path: jsonb("path").$type<[number, number][]>(),
    /** KP-4: hanya titik status ponsel → jarak estimasi rute peta. */
    isEstimated: boolean("is_estimated").notNull().default(false),
    hasGaps: boolean("has_gaps").notNull().default(false),
    computedAt: tstz("computed_at"),
    ...timestamps(),
  },
);

/** Ringkasan per truk per hari (US-M12-03 KP-2). */
export const truckDaySummaries = pgTable(
  "truck_day_summaries",
  {
    id: pk(),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    businessDate: businessDate().notNull(),
    distanceM: meters("distance_m"),
    movingS: integer("moving_s"),
    stoppedS: integer("stopped_s"),
    firstMoveAt: tstz("first_move_at"),
    lastMoveAt: tstz("last_move_at"),
    tripCount: integer("trip_count"),
    betweenTripDistanceM: meters("between_trip_distance_m"),
    gpsDeadMinutes: integer("gps_dead_minutes"),
    isEstimated: boolean("is_estimated").notNull().default(false),
    computedAt: tstz("computed_at"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("truck_day_summaries_truck_date_uq").on(t.truckId, t.businessDate)],
);

/**
 * Aktivasi jejak GPS ponsel cadangan per truk (US-M12-01 KP-4, US-M3-02 KP-5): otomatis saat perangkat GPS Mati/Dicabut
 * atau dipaksa admin sistem; berakhir saat perangkat aktif kembali. Satu baris aktif per truk.
 */
export const phoneTrackingFlags = pgTable(
  "phone_tracking_flags",
  {
    id: pk(),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    reason: phoneTrackingReasonEnum("reason").notNull(),
    /** Kosong = sistem. */
    setBy: userRef("set_by"),
    startedAt: tstz("started_at").notNull(),
    endedAt: tstz("ended_at"),
    fleetEventId: uuid("fleet_event_id").references((): AnyPgColumn => fleetEvents.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("phone_tracking_flags_live_uq")
      .on(t.truckId)
      .where(sql`${t.endedAt} is null`),
  ],
);

/** Estimasi biaya BBM per rit (US-M12-07, S/RL-6): jarak × konsumsi × harga BBM (PAR-53); informasi, tidak dijurnal. */
export const fuelEstimates = pgTable(
  "fuel_estimates",
  {
    id: pk(),
    tripId: uuid("trip_id")
      .notNull()
      .unique("fuel_estimates_trip_uq")
      .references((): AnyPgColumn => trips.id),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    businessDate: businessDate().notNull(),
    distanceM: meters("distance_m").notNull(),
    consumptionLPerKm: numeric("consumption_l_per_km", { precision: 8, scale: 4, mode: "number" }).notNull(),
    fuelPricePerL: money("fuel_price_per_l").notNull(),
    estimatedCost: money("estimated_cost").notNull(),
    computedAt: tstz("computed_at").notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [index("fuel_estimates_truck_date_idx").on(t.truckId, t.businessDate)],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const gpsPositionsRelations = relations(gpsPositions, ({ one }) => ({
  truck: one(trucks, { fields: [gpsPositions.truckId], references: [trucks.id] }),
  device: one(devices, { fields: [gpsPositions.deviceId], references: [devices.id] }),
  trip: one(trips, { fields: [gpsPositions.tripId], references: [trips.id] }),
}));

export const fleetEventsRelations = relations(fleetEvents, ({ one }) => ({
  truck: one(trucks, { fields: [fleetEvents.truckId], references: [trucks.id] }),
  trip: one(trips, { fields: [fleetEvents.tripId], references: [trips.id] }),
  device: one(devices, { fields: [fleetEvents.deviceId], references: [devices.id] }),
}));

export const tripTracksRelations = relations(tripTracks, ({ one }) => ({
  trip: one(trips, { fields: [tripTracks.tripId], references: [trips.id] }),
  truck: one(trucks, { fields: [tripTracks.truckId], references: [trucks.id] }),
}));

export const truckDaySummariesRelations = relations(truckDaySummaries, ({ one }) => ({
  truck: one(trucks, { fields: [truckDaySummaries.truckId], references: [trucks.id] }),
}));

export const phoneTrackingFlagsRelations = relations(phoneTrackingFlags, ({ one }) => ({
  truck: one(trucks, { fields: [phoneTrackingFlags.truckId], references: [trucks.id] }),
  fleetEvent: one(fleetEvents, { fields: [phoneTrackingFlags.fleetEventId], references: [fleetEvents.id] }),
}));

export const fuelEstimatesRelations = relations(fuelEstimates, ({ one }) => ({
  trip: one(trips, { fields: [fuelEstimates.tripId], references: [trips.id] }),
  truck: one(trucks, { fields: [fuelEstimates.truckId], references: [trucks.id] }),
}));
