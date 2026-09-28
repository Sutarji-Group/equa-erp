/**
 * M3 — Aplikasi Sopir (PRD 7.3): pembayaran per rit dan pengeluaran rit. Status rit & bukti kirim ada di `trips` (M2);
 * pelunasan piutang lewat sopir memakai `customer_payments` (M5) dengan `channel = 'driver'`; setoran di `deposits` (M4).
 */
import { relations } from "drizzle-orm";
import { foreignKey, index, pgEnum, pgTable, text, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

import { enumValues } from "../../lib/labels";
import { businessDate, money, pk, timestamps, tstz } from "./_columns";
import { approvalRef, attachmentRef, createdBy, fieldMeta, paymentMethodEnum, tenantRef, userRef } from "./core";
import { customers, trucks } from "./m1-master";
import { trips } from "./m2-orders";
import { deposits, incomingTransfers, officeCashMovements } from "./m4-cash";
import { invoices } from "./m5-receivables";

export const tripExpenseKindEnum = pgEnum("trip_expense_kind", enumValues("trip_expense_kind"));
export const expenseFundingSourceEnum = pgEnum("expense_funding_source", enumValues("expense_funding_source"));
export const expenseStatusEnum = pgEnum("expense_status", enumValues("expense_status"));

/**
 * Pembayaran per rit (US-M3-04): tunai (jumlah nyata; kurang → kurang bayar PTB-18), transfer (foto bukti →
 * transfer belum dicocokkan), tempo (→ faktur M5). Harga tidak dapat diubah sopir (BR-19). Koreksi = baris pembalik
 * (`reversal_of_id`) oleh Admin Keuangan (BR-38).
 */
export const tripPayments = pgTable(
  "trip_payments",
  {
    id: pk(),
    tenantId: tenantRef(),
    tripId: uuid("trip_id")
      .notNull()
      .references((): AnyPgColumn => trips.id),
    customerId: uuid("customer_id")
      .notNull()
      .references((): AnyPgColumn => customers.id),
    /** Pelaksana (sopir/kernet pengganti) — setoran dipisah per pengguna (US-M2-11 KP-3). */
    driverUserId: userRef("driver_user_id"),
    method: paymentMethodEnum("method").notNull(),
    /** Harga pesanan (angka seharusnya). */
    expectedAmount: money("expected_amount").notNull(),
    /** Tunai diterima / jumlah transfer / 0 untuk tempo. */
    receivedAmount: money("received_amount").notNull(),
    /** PTB-18: sisa tunai yang tidak dibayar → faktur kurang bayar jatuh tempo H+0. */
    underpaymentAmount: money("underpayment_amount").notNull().default(0),
    underpaymentReason: text("underpayment_reason"),
    transferProofAttachmentId: attachmentRef("transfer_proof_attachment_id"),
    incomingTransferId: uuid("incoming_transfer_id").references((): AnyPgColumn => incomingTransfers.id),
    /** Faktur kirim (tempo) atau faktur kurang bayar. */
    invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
    /** PTB-19: cara bayar semula bila diubah di lapangan (tunai → tempo lewat persetujuan Dispatcher). */
    originalMethod: paymentMethodEnum("original_method"),
    methodChangeApprovalId: approvalRef("method_change_approval_id"),
    /** Setoran sopir hari itu yang memuat tunai ini. */
    depositId: uuid("deposit_id").references((): AnyPgColumn => deposits.id),
    businessDate: businessDate().notNull(),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => tripPayments.id),
    reversalReason: text("reversal_reason"),
    correctionApprovalId: approvalRef("correction_approval_id"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("trip_payments_trip_idx").on(t.tripId),
    index("trip_payments_driver_date_idx").on(t.driverUserId, t.businessDate),
    index("trip_payments_deposit_idx").on(t.depositId),
  ],
);

/**
 * Pengeluaran rit (US-M3-08, S): BBM/tol/parkir/lainnya dengan foto nota wajib; sumber dana kas di tangan atau uang
 * pribadi (PTB-20); menunggu verifikasi Admin Keuangan saat penerimaan setoran (US-M4-02 KP-2).
 */
export const tripExpenses = pgTable(
  "trip_expenses",
  {
    id: pk(),
    tenantId: tenantRef(),
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    truckId: uuid("truck_id")
      .notNull()
      .references((): AnyPgColumn => trucks.id),
    driverUserId: userRef("driver_user_id"),
    businessDate: businessDate().notNull(),
    kind: tripExpenseKindEnum("kind").notNull(),
    amount: money("amount").notNull(),
    receiptAttachmentId: attachmentRef("receipt_attachment_id"),
    fundingSource: expenseFundingSourceEnum("funding_source").notNull(),
    status: expenseStatusEnum("status").notNull().default("pending_verification"),
    verifiedBy: userRef("verified_by"),
    verifiedAt: tstz("verified_at"),
    rejectionReason: text("rejection_reason"),
    depositId: uuid("deposit_id").references((): AnyPgColumn => deposits.id),
    /** Uang pribadi yang diganti dari kas kantor. */
    reimbursedAt: tstz("reimbursed_at"),
    officeCashMovementId: uuid("office_cash_movement_id"),
    note: text("note"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    foreignKey({
      name: "trip_expenses_office_cash_fk",
      columns: [t.officeCashMovementId],
      foreignColumns: [officeCashMovements.id],
    }),
    index("trip_expenses_truck_date_idx").on(t.truckId, t.businessDate),
    index("trip_expenses_deposit_idx").on(t.depositId),
    index("trip_expenses_status_idx").on(t.status),
  ],
);

export const tripPaymentsRelations = relations(tripPayments, ({ one }) => ({
  trip: one(trips, { fields: [tripPayments.tripId], references: [trips.id] }),
  customer: one(customers, { fields: [tripPayments.customerId], references: [customers.id] }),
  deposit: one(deposits, { fields: [tripPayments.depositId], references: [deposits.id] }),
  invoice: one(invoices, { fields: [tripPayments.invoiceId], references: [invoices.id] }),
  incomingTransfer: one(incomingTransfers, {
    fields: [tripPayments.incomingTransferId],
    references: [incomingTransfers.id],
  }),
}));

export const tripExpensesRelations = relations(tripExpenses, ({ one }) => ({
  trip: one(trips, { fields: [tripExpenses.tripId], references: [trips.id] }),
  truck: one(trucks, { fields: [tripExpenses.truckId], references: [trucks.id] }),
  deposit: one(deposits, { fields: [tripExpenses.depositId], references: [deposits.id] }),
}));
