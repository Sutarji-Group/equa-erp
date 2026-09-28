/**
 * Tahap 2 — Aplikasi Pelanggan (PRD Bab 8; feature flag `phase2.customer_app`, bawaan mati). Aplikasi tidak memiliki
 * data bisnis sendiri (8.4): pelanggan/alamat = M1, pesanan = M2, faktur = M5. Yang baru: akun & verifikasi WA (OTP),
 * sesi pelanggan, penilaian, keluhan, pembayaran digital (PTB-50), preferensi pengingat isi ulang.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { enumValues } from "../../lib/labels";
import { createdAtOnly, dateStr, money, pk, timestamps, tstz } from "./_columns";
import { attachmentRef, employeeRef, tenantRef, userRef } from "./core";
import { customers, trucks } from "./m1-master";
import { orders, trips } from "./m2-orders";
import { customerPayments, invoices } from "./m5-receivables";
import { incomingTransfers } from "./m4-cash";

export const customerAccountStatusEnum = pgEnum("customer_account_status", enumValues("customer_account_status"));
export const otpPurposeEnum = pgEnum("otp_purpose", enumValues("otp_purpose"));
export const complaintKindEnum = pgEnum("complaint_kind", enumValues("complaint_kind"));
export const complaintStatusEnum = pgEnum("complaint_status", enumValues("complaint_status"));
export const paymentIntentStatusEnum = pgEnum("payment_intent_status", enumValues("payment_intent_status"));
export const paymentIntentMethodEnum = pgEnum("payment_intent_method", enumValues("payment_intent_method"));

/**
 * Akun pelanggan (US-P2-01): satu nomor WA satu akun; terhubung ke pelanggan M1 setelah konfirmasi nama; nomor baru →
 * pelanggan baru Tunai (BR-01). Persetujuan UU PDP dicatat.
 */
export const customerAccounts = pgTable(
  "customer_accounts",
  {
    id: pk(),
    tenantId: tenantRef(),
    phone: text("phone").notNull().unique("customer_accounts_phone_uq"),
    customerId: uuid("customer_id").references((): AnyPgColumn => customers.id),
    status: customerAccountStatusEnum("status").notNull().default("registered"),
    displayName: text("display_name"),
    verifiedAt: tstz("verified_at"),
    linkedAt: tstz("linked_at"),
    /** Dispatcher yang memverifikasi bila nama tidak cocok (8.7). */
    linkedBy: userRef("linked_by"),
    consentPdpAt: tstz("consent_pdp_at"),
    consentVersion: text("consent_version"),
    lastLoginAt: tstz("last_login_at"),
    deactivatedAt: tstz("deactivated_at"),
    anonymizedAt: tstz("anonymized_at"),
    ...timestamps(),
  },
  (t) => [index("customer_accounts_customer_idx").on(t.customerId)],
);

/** Sesi pelanggan (tabel teknis — boleh dihapus): 30 hari; verifikasi ulang untuk pembayaran (8.6). */
export const customerSessions = pgTable(
  "customer_sessions",
  {
    id: pk(),
    customerAccountId: uuid("customer_account_id")
      .notNull()
      .references((): AnyPgColumn => customerAccounts.id),
    tokenHash: text("token_hash").notNull().unique(),
    lastActiveAt: tstz("last_active_at").notNull().defaultNow(),
    expiresAt: tstz("expires_at").notNull(),
    reverifiedAt: tstz("reverified_at"),
    revokedAt: tstz("revoked_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    ...createdAtOnly(),
  },
  (t) => [index("customer_sessions_account_idx").on(t.customerAccountId)],
);

/** Kode OTP WhatsApp (PAR-74: 6 digit, 5 menit, 3 percobaan) — tabel teknis, boleh dihapus. */
export const otpCodes = pgTable(
  "otp_codes",
  {
    id: pk(),
    phone: text("phone").notNull(),
    purpose: otpPurposeEnum("purpose").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    consumedAt: tstz("consumed_at"),
    customerAccountId: uuid("customer_account_id").references((): AnyPgColumn => customerAccounts.id),
    waMessageLogId: uuid("wa_message_log_id"),
    ...createdAtOnly(),
  },
  (t) => [index("otp_codes_phone_idx").on(t.phone, t.createdAt)],
);

/** Penilaian 1–5 per rit Selesai (US-P2-06 KP-1; sekali per rit). */
export const tripRatings = pgTable(
  "trip_ratings",
  {
    id: pk(),
    tenantId: tenantRef(),
    tripId: uuid("trip_id")
      .notNull()
      .unique("trip_ratings_trip_uq")
      .references((): AnyPgColumn => trips.id),
    customerAccountId: uuid("customer_account_id")
      .notNull()
      .references((): AnyPgColumn => customerAccounts.id),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    truckId: uuid("truck_id").references((): AnyPgColumn => trucks.id),
    driverEmployeeId: employeeRef("driver_employee_id"),
    rating: smallint("rating").notNull(),
    comment: text("comment"),
    ...timestamps(),
  },
  (t) => [check("trip_ratings_rating_chk", sql`${t.rating} between 1 and 5`)],
);

/**
 * Keluhan (US-P2-06 KP-2/3): Diajukan → Ditanggapi (≤ PAR-75) → Selesai; tidak dapat dihapus; keluhan volume dapat
 * memicu sengketa faktur (7.5.6).
 */
export const complaints = pgTable(
  "complaints",
  {
    id: pk(),
    tenantId: tenantRef(),
    customerAccountId: uuid("customer_account_id").references((): AnyPgColumn => customerAccounts.id),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    orderId: uuid("order_id").references((): AnyPgColumn => orders.id),
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
    kind: complaintKindEnum("kind").notNull(),
    description: text("description").notNull(),
    photoAttachmentId: attachmentRef("photo_attachment_id"),
    status: complaintStatusEnum("status").notNull().default("submitted"),
    /** Kotak keluhan: dispatcher (operasional) atau finance_admin (tagihan). */
    assignedRole: text("assigned_role").notNull(),
    dueAt: tstz("due_at"),
    firstResponseAt: tstz("first_response_at"),
    firstResponseBy: userRef("first_response_by"),
    response: text("response"),
    resolution: text("resolution"),
    resolvedAt: tstz("resolved_at"),
    resolvedBy: userRef("resolved_by"),
    ...timestamps(),
  },
  (t) => [index("complaints_status_idx").on(t.status, t.createdAt), index("complaints_customer_idx").on(t.customerId)],
);

/**
 * Pembayaran digital (US-P2-04 KP-3, PTB-50: adaptor generik, pertama Midtrans): Menunggu → Berhasil → Dicocokkan;
 * Gagal/Kedaluwarsa. Berhasil → pelunasan M5 + daftar pencocokan M4; biaya gerbang dibukukan sebagai beban.
 */
export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: pk(),
    tenantId: tenantRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    customerAccountId: uuid("customer_account_id").references((): AnyPgColumn => customerAccounts.id),
    invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
    orderId: uuid("order_id").references((): AnyPgColumn => orders.id),
    amount: money("amount").notNull(),
    gateway: text("gateway").notNull().default("midtrans"),
    method: paymentIntentMethodEnum("method").notNull(),
    status: paymentIntentStatusEnum("status").notNull().default("pending"),
    gatewayOrderId: text("gateway_order_id").notNull().unique("payment_intents_gateway_order_uq"),
    gatewayTransactionId: text("gateway_transaction_id"),
    qrString: text("qr_string"),
    vaNumber: text("va_number"),
    vaBank: text("va_bank"),
    expiresAt: tstz("expires_at"),
    succeededAt: tstz("succeeded_at"),
    settledAt: tstz("settled_at"),
    gatewayFee: money("gateway_fee"),
    lastNotification: jsonb("last_notification").$type<Record<string, unknown>>(),
    customerPaymentId: uuid("customer_payment_id").references((): AnyPgColumn => customerPayments.id),
    incomingTransferId: uuid("incoming_transfer_id").references((): AnyPgColumn => incomingTransfers.id),
    ...timestamps(),
  },
  (t) => [index("payment_intents_customer_idx").on(t.customerId, t.status)],
);

/** Preferensi pengingat isi ulang (US-P2-05 KP-2): dari rata-rata jarak antar pesanan; dapat dimatikan. */
export const refillReminderPrefs = pgTable(
  "refill_reminder_prefs",
  {
    id: pk(),
    customerAccountId: uuid("customer_account_id").notNull().unique("refill_reminder_prefs_account_uq"),
    enabled: boolean("enabled").notNull().default(true),
    avgIntervalDays: integer("avg_interval_days"),
    nextReminderDate: dateStr("next_reminder_date"),
    lastRemindedAt: tstz("last_reminded_at"),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: "refill_reminder_prefs_account_fk",
      columns: [t.customerAccountId],
      foreignColumns: [customerAccounts.id],
    }),
  ],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const customerAccountsRelations = relations(customerAccounts, ({ one, many }) => ({
  customer: one(customers, { fields: [customerAccounts.customerId], references: [customers.id] }),
  sessions: many(customerSessions),
  ratings: many(tripRatings),
  complaints: many(complaints),
  paymentIntents: many(paymentIntents),
}));

export const customerSessionsRelations = relations(customerSessions, ({ one }) => ({
  account: one(customerAccounts, { fields: [customerSessions.customerAccountId], references: [customerAccounts.id] }),
}));

export const tripRatingsRelations = relations(tripRatings, ({ one }) => ({
  trip: one(trips, { fields: [tripRatings.tripId], references: [trips.id] }),
  account: one(customerAccounts, { fields: [tripRatings.customerAccountId], references: [customerAccounts.id] }),
}));

export const complaintsRelations = relations(complaints, ({ one }) => ({
  account: one(customerAccounts, { fields: [complaints.customerAccountId], references: [customerAccounts.id] }),
  customer: one(customers, { fields: [complaints.customerId], references: [customers.id] }),
  order: one(orders, { fields: [complaints.orderId], references: [orders.id] }),
  trip: one(trips, { fields: [complaints.tripId], references: [trips.id] }),
}));

export const paymentIntentsRelations = relations(paymentIntents, ({ one }) => ({
  account: one(customerAccounts, { fields: [paymentIntents.customerAccountId], references: [customerAccounts.id] }),
  customer: one(customers, { fields: [paymentIntents.customerId], references: [customers.id] }),
  invoice: one(invoices, { fields: [paymentIntents.invoiceId], references: [invoices.id] }),
  order: one(orders, { fields: [paymentIntents.orderId], references: [orders.id] }),
}));

export const refillReminderPrefsRelations = relations(refillReminderPrefs, ({ one }) => ({
  account: one(customerAccounts, { fields: [refillReminderPrefs.customerAccountId], references: [customerAccounts.id] }),
}));
