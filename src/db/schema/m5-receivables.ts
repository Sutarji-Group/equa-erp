/**
 * M5 — Piutang & Penagihan (PRD 7.5): faktur (kirim/toko/kurang bayar/bulanan/saldo awal/langganan mitra), baris
 * faktur, rit belum ditagih (pelanggan tagihan bulanan), pelunasan & alokasi, uang muka, nota kredit, pengingat.
 * Nomor faktur `F-YY-NNNNNN`, nota kredit `NK-YY-NNNNNN` (D-04). Tanpa PPN (BR-29).
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { enumValues } from "../../lib/labels";
import { businessDate, dateStr, liters, money, pk, timestamps, tstz } from "./_columns";
import {
  approvalRef,
  approvalRequests,
  attachmentRef,
  createdBy,
  fieldMeta,
  paymentMethodEnum,
  tenantRef,
  userRef,
} from "./core";
import { customerAddresses, customers, products } from "./m1-master";
import { trips } from "./m2-orders";
import { deposits, incomingTransfers, officeCashMovements } from "./m4-cash";
import { posSaleLines, posSales } from "./m6-pos";
import { journals } from "./m11-accounting";

export const invoiceStatusEnum = pgEnum("invoice_status", enumValues("invoice_status"));
export const invoiceKindEnum = pgEnum("invoice_kind", enumValues("invoice_kind"));
export const disputeStatusEnum = pgEnum("dispute_status", enumValues("dispute_status"));
export const paymentChannelEnum = pgEnum("payment_channel", enumValues("payment_channel"));
export const unbilledStatusEnum = pgEnum("unbilled_status", enumValues("unbilled_status"));
export const advanceStatusEnum = pgEnum("advance_status", enumValues("advance_status"));
export const creditNoteStatusEnum = pgEnum("credit_note_status", enumValues("credit_note_status"));
export const invoiceLineComponentEnum = pgEnum("invoice_line_component", enumValues("invoice_line_component"));
export const reminderKindEnum = pgEnum("reminder_kind", enumValues("reminder_kind"));
/** Lini piutang (umur per lini, US-M5-04 KP-1) — dipakai faktur saldo awal (B-37). */
export const receivableLineEnum = pgEnum("receivable_line", enumValues("receivable_line"));
export const reminderStatusEnum = pgEnum("reminder_status", enumValues("reminder_status"));

/**
 * Faktur (Terbuka → Sebagian dibayar → Lunas; US-M5-01). Tidak dapat dihapus; koreksi lewat nota kredit (BR-38).
 * sisa = amount − paid_amount − credited_amount − written_off_amount (disimpan untuk kueri umur piutang; CHECK).
 */
export const invoices = pgTable(
  "invoices",
  {
    id: pk(),
    tenantId: tenantRef(),
    number: text("number").notNull().unique(),
    kind: invoiceKindEnum("kind").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    addressId: uuid("address_id").references((): AnyPgColumn => customerAddresses.id),
    /** Faktur kirim / kurang bayar: rit sumber. */
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    /** Penjualan tempo toko (US-M7-04 KP-3). */
    posSaleId: uuid("pos_sale_id").references((): AnyPgColumn => posSales.id),
    /** Faktur bulanan/langganan mitra: hari pertama bulan layanan (YYYY-MM-01). */
    periodMonth: dateStr("period_month"),
    /** Kontrak mitra (langganan sistem, US-P3-09) — tanpa FK (tabel di p3-partner). */
    partnerContractId: uuid("partner_contract_id"),
    issueDate: dateStr("issue_date").notNull(),
    dueDate: dateStr("due_date").notNull(),
    amount: money("amount").notNull(),
    paidAmount: money("paid_amount").notNull().default(0),
    creditedAmount: money("credited_amount").notNull().default(0),
    outstandingAmount: money("outstanding_amount").notNull(),
    status: invoiceStatusEnum("status").notNull().default("open"),
    description: text("description"),
    /** US-M5-07: saldo awal cut-over — tidak menghasilkan jurnal penjualan (masuk neraca awal M11). */
    isOpeningBalance: boolean("is_opening_balance").notNull().default(false),
    openingConfirmationAttachmentId: attachmentRef("opening_confirmation_attachment_id"),
    /** Lini asal faktur saldo awal (kertas) untuk umur piutang per lini (B-37); kosong = air truk. */
    openingLine: receivableLineEnum("opening_line"),
    // --- sengketa (7.5.6; PAR-45) ---
    disputeStatus: disputeStatusEnum("dispute_status").notNull().default("none"),
    disputedAt: tstz("disputed_at"),
    disputeNote: text("dispute_note"),
    /** Penundaan pengingat/penahanan maks. PAR-45 hari. */
    disputeUntil: dateStr("dispute_until"),
    disputeDecidedAt: tstz("dispute_decided_at"),
    disputeDecidedBy: userRef("dispute_decided_by"),
    // --- dokumen & pengiriman (US-M5-01 KP-5) ---
    pdfAttachmentId: attachmentRef("pdf_attachment_id"),
    sentAt: tstz("sent_at"),
    sentVia: text("sent_via"),
    paidAt: tstz("paid_at"),
    ...timestamps(),
    createdBy: createdBy(),
    /**
     * Piutang sementara "transfer belum diterima" (US-M4-04 KP-4, PTB-28, 7.5.6): transfer masuk yang Tidak ditemukan.
     */
    pendingTransferId: uuid("pending_transfer_id").references((): AnyPgColumn => incomingTransfers.id),
    /** Penghapusan piutang tak tertagih lewat jurnal manual (US-M5-01 KP-6) — mengurangi sisa tanpa nota kredit. */
    writtenOffAmount: money("written_off_amount").notNull().default(0),
    writtenOffAt: tstz("written_off_at"),
    writeOffJournalId: uuid("write_off_journal_id"),
    writeOffApprovalId: uuid("write_off_approval_id"),
  },
  (t) => [
    index("invoices_customer_status_idx").on(t.customerId, t.status),
    index("invoices_due_status_idx").on(t.status, t.dueDate),
    foreignKey({ name: "invoices_write_off_journal_fk", columns: [t.writeOffJournalId], foreignColumns: [journals.id] }),
    foreignKey({
      name: "invoices_write_off_approval_fk",
      columns: [t.writeOffApprovalId],
      foreignColumns: [approvalRequests.id],
    }),
    // US-M7-04 KP-3: satu faktur per penjualan tempo toko.
    uniqueIndex("invoices_pos_sale_uq")
      .on(t.posSaleId)
      .where(sql`${t.posSaleId} is not null`),
    check(
      "invoices_outstanding_chk",
      sql`${t.outstandingAmount} = ${t.amount} - ${t.paidAmount} - ${t.creditedAmount} - ${t.writtenOffAmount} and ${t.outstandingAmount} >= 0`,
    ),
    uniqueIndex("invoices_kind_trip_uq")
      .on(t.kind, t.tripId)
      .where(sql`${t.tripId} is not null`),
    uniqueIndex("invoices_monthly_uq")
      .on(t.customerId, t.kind, t.periodMonth)
      .where(sql`${t.kind} in ('monthly', 'partner_subscription')`),
  ],
);

/** Baris faktur: rincian rit (nomor, tanggal, alamat, volume, harga) / barang / komponen mitra. */
export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: pk(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references((): AnyPgColumn => invoices.id),
    lineNo: integer("line_no").notNull(),
    component: invoiceLineComponentEnum("component").notNull(),
    description: text("description").notNull(),
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    posSaleLineId: uuid("pos_sale_line_id").references((): AnyPgColumn => posSaleLines.id),
    productId: uuid("product_id").references((): AnyPgColumn => products.id),
    serviceDate: dateStr("service_date"),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: money("unit_price").notNull(),
    amount: money("amount").notNull(),
    volumeL: liters("volume_l"),
    unbilledChargeId: uuid("unbilled_charge_id").references((): AnyPgColumn => unbilledCharges.id),
    ...timestamps(),
  },
  (t) => [uniqueIndex("invoice_lines_invoice_line_uq").on(t.invoiceId, t.lineNo)],
);

/**
 * Rit/transaksi tempo pelanggan tagihan bulanan yang belum ditagih (US-M5-01 KP-2/3). Masuk eksposur (US-M5-06 KP-5).
 * Tersinkron setelah faktur bulanan terbit → bulan berikutnya dengan penanda (US-M5-06 KP-3).
 */
export const unbilledCharges = pgTable(
  "unbilled_charges",
  {
    id: pk(),
    tenantId: tenantRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    posSaleId: uuid("pos_sale_id").references((): AnyPgColumn => posSales.id),
    serviceDate: dateStr("service_date").notNull(),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    volumeL: liters("volume_l"),
    status: unbilledStatusEnum("status").notNull().default("unbilled"),
    invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
    /** Masuk faktur bulan berikutnya karena tersinkron setelah faktur terbit. */
    lateSync: boolean("late_sync").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    index("unbilled_charges_customer_idx").on(t.customerId, t.status),
    uniqueIndex("unbilled_charges_trip_uq")
      .on(t.tripId)
      .where(sql`${t.tripId} is not null`),
  ],
);

/**
 * Pelunasan (US-M5-02): kantor (tunai → kas kantor; transfer → pencocokan), lewat sopir (M3, masuk setoran hari itu,
 * BR-07), kasir toko, pembayaran digital (Tahap 2). Pembatalan hanya lewat pembalik beralasan (> PAR-21 disetujui).
 */
export const customerPayments = pgTable(
  "customer_payments",
  {
    id: pk(),
    tenantId: tenantRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    channel: paymentChannelEnum("channel").notNull(),
    method: paymentMethodEnum("method").notNull(),
    amount: money("amount").notNull(),
    businessDate: businessDate().notNull(),
    proofAttachmentId: attachmentRef("proof_attachment_id"),
    incomingTransferId: uuid("incoming_transfer_id").references((): AnyPgColumn => incomingTransfers.id),
    /** Lewat sopir: rit tempat pelunasan diterima & setoran hari itu. */
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    driverUserId: userRef("driver_user_id"),
    depositId: uuid("deposit_id").references((): AnyPgColumn => deposits.id),
    /** Pembayaran digital (P2) — tanpa FK (tabel di p2-customer). */
    paymentIntentId: uuid("payment_intent_id"),
    officeCashMovementId: uuid("office_cash_movement_id"),
    /** Kelebihan bayar → uang muka (KP-3). */
    advanceAmount: money("advance_amount").notNull().default(0),
    notes: text("notes"),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => customerPayments.id),
    reversalReason: text("reversal_reason"),
    correctionApprovalId: uuid("correction_approval_id"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    foreignKey({
      name: "customer_payments_office_cash_fk",
      columns: [t.officeCashMovementId],
      foreignColumns: [officeCashMovements.id],
    }),
    foreignKey({
      name: "customer_payments_correction_approval_fk",
      columns: [t.correctionApprovalId],
      foreignColumns: [approvalRequests.id],
    }),
    index("customer_payments_customer_idx").on(t.customerId, t.businessDate),
    index("customer_payments_deposit_idx").on(t.depositId),
    uniqueIndex("customer_payments_sync_command_uq")
      .on(t.syncCommandId)
      .where(sql`${t.syncCommandId} is not null`),
  ],
);

/** Uang muka pelanggan (US-M5-02 KP-3): dialokasikan otomatis ke faktur berikutnya atau dikembalikan dengan persetujuan. */
export const customerAdvances = pgTable(
  "customer_advances",
  {
    id: pk(),
    tenantId: tenantRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    sourcePaymentId: uuid("source_payment_id").references((): AnyPgColumn => customerPayments.id),
    amount: money("amount").notNull(),
    remainingAmount: money("remaining_amount").notNull(),
    status: advanceStatusEnum("status").notNull().default("open"),
    refundApprovalId: approvalRef("refund_approval_id"),
    refundedAt: tstz("refunded_at"),
    refundedBy: userRef("refunded_by"),
    notes: text("notes"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("customer_advances_customer_idx").on(t.customerId, t.status)],
);

/** Nota kredit (koreksi faktur, sengketa, retur toko PTB-46). */
export const creditNotes = pgTable(
  "credit_notes",
  {
    id: pk(),
    tenantId: tenantRef(),
    number: text("number").notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references((): AnyPgColumn => invoices.id),
    amount: money("amount").notNull(),
    reason: text("reason").notNull(),
    issueDate: dateStr("issue_date").notNull(),
    status: creditNoteStatusEnum("status").notNull().default("issued"),
    approvalRequestId: approvalRef(),
    posSaleId: uuid("pos_sale_id").references((): AnyPgColumn => posSales.id),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("credit_notes_invoice_idx").on(t.invoiceId)],
);

/**
 * Alokasi ke faktur dari tepat satu sumber: pelunasan, uang muka, atau nota kredit. Pembalikan = baris negatif yang
 * merujuk baris asal.
 */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: pk(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references((): AnyPgColumn => invoices.id),
    customerPaymentId: uuid("customer_payment_id").references((): AnyPgColumn => customerPayments.id),
    customerAdvanceId: uuid("customer_advance_id").references((): AnyPgColumn => customerAdvances.id),
    creditNoteId: uuid("credit_note_id").references((): AnyPgColumn => creditNotes.id),
    /** Bertanda (negatif untuk pembalikan). */
    amount: money("amount").notNull(),
    allocatedAt: tstz("allocated_at").notNull().defaultNow(),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => paymentAllocations.id),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("payment_allocations_invoice_idx").on(t.invoiceId),
    index("payment_allocations_payment_idx").on(t.customerPaymentId),
    check(
      "payment_allocations_one_source_chk",
      sql`num_nonnulls(${t.customerPaymentId}, ${t.customerAdvanceId}, ${t.creditNoteId}) = 1`,
    ),
  ],
);

/** Pengingat jatuh tempo H-3/H+1 (US-M5-05, PAR-13): Dijadwalkan → Dibuka (tautan WA). */
export const receivableReminders = pgTable(
  "receivable_reminders",
  {
    id: pk(),
    tenantId: tenantRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
    kind: reminderKindEnum("kind").notNull(),
    scheduledDate: dateStr("scheduled_date").notNull(),
    totalOutstanding: money("total_outstanding").notNull(),
    status: reminderStatusEnum("status").notNull().default("scheduled"),
    openedAt: tstz("opened_at"),
    openedBy: userRef("opened_by"),
    waMessageLogId: uuid("wa_message_log_id"),
    skipReason: text("skip_reason"),
    ...timestamps(),
  },
  (t) => [
    index("receivable_reminders_date_idx").on(t.scheduledDate, t.status),
    uniqueIndex("receivable_reminders_invoice_kind_uq")
      .on(t.invoiceId, t.kind)
      .where(sql`${t.invoiceId} is not null`),
  ],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  customer: one(customers, { fields: [invoices.customerId], references: [customers.id] }),
  address: one(customerAddresses, { fields: [invoices.addressId], references: [customerAddresses.id] }),
  trip: one(trips, { fields: [invoices.tripId], references: [trips.id] }),
  posSale: one(posSales, { fields: [invoices.posSaleId], references: [posSales.id] }),
  lines: many(invoiceLines),
  allocations: many(paymentAllocations),
  creditNotes: many(creditNotes),
  reminders: many(receivableReminders),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
  trip: one(trips, { fields: [invoiceLines.tripId], references: [trips.id] }),
  product: one(products, { fields: [invoiceLines.productId], references: [products.id] }),
}));

export const unbilledChargesRelations = relations(unbilledCharges, ({ one }) => ({
  customer: one(customers, { fields: [unbilledCharges.customerId], references: [customers.id] }),
  trip: one(trips, { fields: [unbilledCharges.tripId], references: [trips.id] }),
  invoice: one(invoices, { fields: [unbilledCharges.invoiceId], references: [invoices.id] }),
}));

export const customerPaymentsRelations = relations(customerPayments, ({ one, many }) => ({
  customer: one(customers, { fields: [customerPayments.customerId], references: [customers.id] }),
  trip: one(trips, { fields: [customerPayments.tripId], references: [trips.id] }),
  deposit: one(deposits, { fields: [customerPayments.depositId], references: [deposits.id] }),
  incomingTransfer: one(incomingTransfers, {
    fields: [customerPayments.incomingTransferId],
    references: [incomingTransfers.id],
  }),
  allocations: many(paymentAllocations),
}));

export const customerAdvancesRelations = relations(customerAdvances, ({ one, many }) => ({
  customer: one(customers, { fields: [customerAdvances.customerId], references: [customers.id] }),
  sourcePayment: one(customerPayments, {
    fields: [customerAdvances.sourcePaymentId],
    references: [customerPayments.id],
  }),
  allocations: many(paymentAllocations),
}));

export const creditNotesRelations = relations(creditNotes, ({ one, many }) => ({
  customer: one(customers, { fields: [creditNotes.customerId], references: [customers.id] }),
  invoice: one(invoices, { fields: [creditNotes.invoiceId], references: [invoices.id] }),
  allocations: many(paymentAllocations),
}));

export const paymentAllocationsRelations = relations(paymentAllocations, ({ one }) => ({
  invoice: one(invoices, { fields: [paymentAllocations.invoiceId], references: [invoices.id] }),
  payment: one(customerPayments, {
    fields: [paymentAllocations.customerPaymentId],
    references: [customerPayments.id],
  }),
  advance: one(customerAdvances, {
    fields: [paymentAllocations.customerAdvanceId],
    references: [customerAdvances.id],
  }),
  creditNote: one(creditNotes, { fields: [paymentAllocations.creditNoteId], references: [creditNotes.id] }),
}));

export const receivableRemindersRelations = relations(receivableReminders, ({ one }) => ({
  customer: one(customers, { fields: [receivableReminders.customerId], references: [customers.id] }),
  invoice: one(invoices, { fields: [receivableReminders.invoiceId], references: [invoices.id] }),
}));
