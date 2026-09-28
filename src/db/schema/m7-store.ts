/**
 * M7 — Penjualan Toko & Stok (PRD 7.7): pemasok, nota pembelian (+ nota pengganti), utang & pembayaran pemasok,
 * daftar pesan ulang, transfer internal toko → depot. Transaksi POS, kartu stok, opname & shift toko memakai tabel
 * kerangka POS di `m6-pos.ts`. Nomor nota pembelian internal `NB-YY-NNNNNN`, transfer internal `TI-YY-NNNNN` (D-04).
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
import { businessDate, dateStr, money, pk, timestamps, tstz } from "./_columns";
import {
  approvalRef,
  approvalRequests,
  attachmentRef,
  createdBy,
  fieldMeta,
  outlets,
  paymentMethodEnum,
  tenantRef,
  userRef,
} from "./core";
import { products } from "./m1-master";
import { bankAccounts, officeCashMovements } from "./m4-cash";

export const supplierStatusEnum = pgEnum("supplier_status", enumValues("supplier_status"));
export const purchaseReceiptStatusEnum = pgEnum("purchase_receipt_status", enumValues("purchase_receipt_status"));
export const payableStatusEnum = pgEnum("payable_status", enumValues("payable_status"));
export const reorderStatusEnum = pgEnum("reorder_status", enumValues("reorder_status"));
export const internalTransferStatusEnum = pgEnum("internal_transfer_status", enumValues("internal_transfer_status"));

/** Pemasok (master; dikelola kasir & disetujui Admin Keuangan). */
export const suppliers = pgTable(
  "suppliers",
  {
    id: pk(),
    tenantId: tenantRef(),
    code: text("code"),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    phone: text("phone"),
    address: text("address"),
    /** Jatuh tempo bawaan pemasok (kosong = PAR-67). */
    paymentTermDays: integer("payment_term_days"),
    status: supplierStatusEnum("status").notNull().default("pending_approval"),
    approvalRequestId: approvalRef(),
    approvedBy: userRef("approved_by"),
    approvedAt: tstz("approved_at"),
    notes: text("notes"),
    deactivatedAt: tstz("deactivated_at"),
    deactivationReason: text("deactivation_reason"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [index("suppliers_tenant_idx").on(t.tenantId)],
);

/**
 * Nota pembelian/penerimaan barang toko (US-M7-02): wajib merujuk nota pemasok (BR-28). Barang tanpa nota → "nota
 * pengganti" (foto barang + keterangan) yang tidak dapat dijual sampai diterima Admin Keuangan (7.7.6).
 * Utang terbentuk bila belum dibayar (US-M7-08); saldo awal utang saat cut-over (`is_opening_payable`).
 */
export const purchaseReceipts = pgTable(
  "purchase_receipts",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    /**
     * Nomor resmi (D-04) — diisi SERVER saat sinkron (kosong selama di antrean perangkat), unik per tenant (NFR-30).
     * Dokumen yang dibuat di perangkat memakai `local_number` (memuat kode perangkat, unik per perangkat) +
     * `device_seq`; dokumen kantor langsung memakai `number` (7.6.6, Bab 6.4 butir 2).
     */
    number: text("number"),
    localNumber: text("local_number"),
    deviceSeq: integer("device_seq"),
    supplierId: uuid("supplier_id")
      .notNull()
      .references((): AnyPgColumn => suppliers.id),
    supplierNoteNumber: text("supplier_note_number"),
    supplierNoteDate: dateStr("supplier_note_date"),
    noteAttachmentId: attachmentRef("note_attachment_id"),
    isSubstituteNote: boolean("is_substitute_note").notNull().default(false),
    substituteGoodsPhotoId: attachmentRef("substitute_goods_photo_id"),
    substituteAcceptedBy: userRef("substitute_accepted_by"),
    substituteAcceptedAt: tstz("substitute_accepted_at"),
    status: purchaseReceiptStatusEnum("status").notNull().default("received"),
    totalAmount: money("total_amount").notNull(),
    paymentStatus: payableStatusEnum("payment_status").notNull().default("unpaid"),
    paidAmount: money("paid_amount").notNull().default(0),
    /** Dari nota; kosong → tanggal nota + PAR-67. */
    dueDate: dateStr("due_date"),
    /** Dibayar saat terima (bila utang S belum dipakai). */
    paidOnReceiptMethod: paymentMethodEnum("paid_on_receipt_method"),
    isOpeningPayable: boolean("is_opening_payable").notNull().default(false),
    receivedBy: userRef("received_by"),
    businessDate: businessDate().notNull(),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => purchaseReceipts.id),
    reversalReason: text("reversal_reason"),
    notes: text("notes"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("purchase_receipts_supplier_idx").on(t.supplierId, t.paymentStatus),
    index("purchase_receipts_outlet_date_idx").on(t.outletId, t.businessDate),
    uniqueIndex("purchase_receipts_tenant_number_uq")
      .on(t.tenantId, t.number)
      .where(sql`${t.number} is not null`),
    uniqueIndex("purchase_receipts_device_local_number_uq")
      .on(t.deviceId, t.localNumber)
      .where(sql`${t.localNumber} is not null`),
    // BR-28, US-M7-02 KP-1/KP-6: nota pemasok yang sama tidak dapat diinput dua kali (kecuali setelah dibalik).
    uniqueIndex("purchase_receipts_supplier_note_uq")
      .on(t.tenantId, t.supplierId, t.supplierNoteNumber)
      .where(sql`${t.supplierNoteNumber} is not null and ${t.reversalOfId} is null and ${t.status} <> 'reversed'`),
    check(
      "purchase_receipts_number_chk",
      sql`(${t.number} is not null or ${t.localNumber} is not null) and (${t.deviceId} is null or (${t.localNumber} is not null and ${t.deviceSeq} is not null))`,
    ),
  ],
);

export const purchaseReceiptLines = pgTable(
  "purchase_receipt_lines",
  {
    id: pk(),
    /** NFR-30: disalin dari `purchase_receipts.tenant_id`. */
    tenantId: tenantRef(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references((): AnyPgColumn => purchaseReceipts.id),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    quantity: integer("quantity").notNull(),
    unitCost: money("unit_cost").notNull(),
    lineTotal: money("line_total").notNull(),
    ...timestamps(),
  },
  (t) => [
    index("purchase_receipt_lines_receipt_idx").on(t.receiptId),
    index("purchase_receipt_lines_tenant_idx").on(t.tenantId, t.productId),
  ],
);

/** Pembayaran pemasok (US-M7-08 KP-2): kas kantor atau transfer; dialokasikan ke nota. */
export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: pk(),
    tenantId: tenantRef(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references((): AnyPgColumn => suppliers.id),
    businessDate: businessDate().notNull(),
    amount: money("amount").notNull(),
    method: paymentMethodEnum("method").notNull(),
    proofAttachmentId: attachmentRef("proof_attachment_id"),
    bankAccountId: uuid("bank_account_id").references((): AnyPgColumn => bankAccounts.id),
    officeCashMovementId: uuid("office_cash_movement_id"),
    notes: text("notes"),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => supplierPayments.id),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("supplier_payments_supplier_idx").on(t.supplierId, t.businessDate),
    foreignKey({
      name: "supplier_payments_office_cash_fk",
      columns: [t.officeCashMovementId],
      foreignColumns: [officeCashMovements.id],
    }),
  ],
);

export const supplierPaymentAllocations = pgTable(
  "supplier_payment_allocations",
  {
    id: pk(),
    supplierPaymentId: uuid("supplier_payment_id").notNull(),
    purchaseReceiptId: uuid("purchase_receipt_id").notNull(),
    /** Bertanda (negatif untuk pembalikan). Append-only (hardening.sql). */
    amount: money("amount").notNull(),
    ...timestamps(),
    createdBy: createdBy(),
    /** Koreksi alokasi keliru = baris pembalik beralasan (BR-38, US-M7-08 KP-2). */
    reversalOfId: uuid("reversal_of_id"),
    reversalReason: text("reversal_reason"),
    correctionApprovalId: uuid("correction_approval_id"),
  },
  (t) => [
    index("supplier_payment_alloc_receipt_idx").on(t.purchaseReceiptId),
    foreignKey({ name: "supplier_payment_alloc_reversal_fk", columns: [t.reversalOfId], foreignColumns: [t.id] }),
    foreignKey({
      name: "supplier_payment_alloc_correction_fk",
      columns: [t.correctionApprovalId],
      foreignColumns: [approvalRequests.id],
    }),
    uniqueIndex("supplier_payment_alloc_reversal_uq")
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    foreignKey({
      name: "supplier_payment_alloc_payment_fk",
      columns: [t.supplierPaymentId],
      foreignColumns: [supplierPayments.id],
    }),
    foreignKey({
      name: "supplier_payment_alloc_receipt_fk",
      columns: [t.purchaseReceiptId],
      foreignColumns: [purchaseReceipts.id],
    }),
  ],
);

/** Daftar pesan ulang (US-M7-03): saldo ≤ stok minimum; "sudah dipesan"; hilang otomatis saat nota masuk. */
export const reorderItems = pgTable(
  "reorder_items",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    status: reorderStatusEnum("status").notNull().default("open"),
    triggeredAt: tstz("triggered_at").notNull(),
    balanceAtTrigger: integer("balance_at_trigger").notNull(),
    lastSupplierId: uuid("last_supplier_id").references((): AnyPgColumn => suppliers.id),
    orderedAt: tstz("ordered_at"),
    orderedSupplierId: uuid("ordered_supplier_id").references((): AnyPgColumn => suppliers.id),
    orderedBy: userRef("ordered_by"),
    closedAt: tstz("closed_at"),
    closedByReceiptId: uuid("closed_by_receipt_id").references((): AnyPgColumn => purchaseReceipts.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("reorder_items_live_uq")
      .on(t.outletId, t.productId)
      .where(sql`${t.status} in ('open', 'ordered')`),
  ],
);

/**
 * Transfer internal bahan toko → depot sendiri (US-M7-06): stok toko berkurang saat dikirim; stok depot bertambah saat
 * operator mengonfirmasi (US-M6-04 KP-5). Nilai = harga mitra (PTB-37); tanpa kas/piutang.
 */
export const internalTransfers = pgTable(
  "internal_transfers",
  {
    id: pk(),
    tenantId: tenantRef(),
    /**
     * Nomor resmi (D-04) — diisi SERVER saat sinkron (kosong selama di antrean perangkat), unik per tenant (NFR-30).
     * Dokumen yang dibuat di perangkat memakai `local_number` (memuat kode perangkat, unik per perangkat) +
     * `device_seq`; dokumen kantor langsung memakai `number` (7.6.6, Bab 6.4 butir 2).
     */
    number: text("number"),
    localNumber: text("local_number"),
    deviceSeq: integer("device_seq"),
    fromOutletId: uuid("from_outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    toOutletId: uuid("to_outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    status: internalTransferStatusEnum("status").notNull().default("sent"),
    businessDate: businessDate().notNull(),
    sentAt: tstz("sent_at").notNull(),
    sentBy: userRef("sent_by"),
    receivedAt: tstz("received_at"),
    receivedBy: userRef("received_by"),
    totalValue: money("total_value").notNull(),
    hasDifference: boolean("has_difference").notNull().default(false),
    notes: text("notes"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
    /** Koreksi = baris pembalik beralasan (BR-38). */
    reversalOfId: uuid("reversal_of_id"),
    reversalReason: text("reversal_reason"),
    correctionApprovalId: uuid("correction_approval_id"),
  },
  (t) => [
    index("internal_transfers_to_outlet_idx").on(t.toOutletId, t.status),
    uniqueIndex("internal_transfers_tenant_number_uq")
      .on(t.tenantId, t.number)
      .where(sql`${t.number} is not null`),
    uniqueIndex("internal_transfers_device_local_number_uq")
      .on(t.deviceId, t.localNumber)
      .where(sql`${t.localNumber} is not null`),
    foreignKey({ name: "internal_transfers_reversal_fk", columns: [t.reversalOfId], foreignColumns: [t.id] }),
    foreignKey({
      name: "internal_transfers_correction_approval_fk",
      columns: [t.correctionApprovalId],
      foreignColumns: [approvalRequests.id],
    }),
    uniqueIndex("internal_transfers_reversal_uq")
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    check(
      "internal_transfers_number_chk",
      sql`(${t.number} is not null or ${t.localNumber} is not null) and (${t.deviceId} is null or (${t.localNumber} is not null and ${t.deviceSeq} is not null))`,
    ),
  ],
);

export const internalTransferLines = pgTable(
  "internal_transfer_lines",
  {
    id: pk(),
    /** NFR-30: disalin dari `internal_transfers.tenant_id`. */
    tenantId: tenantRef(),
    transferId: uuid("transfer_id")
      .notNull()
      .references((): AnyPgColumn => internalTransfers.id),
    /** Barang toko yang dikirim. */
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    /** Diterima sebagai produk depot (bahan) — lihat `products.store_product_id`. */
    toProductId: uuid("to_product_id").references((): AnyPgColumn => products.id),
    quantitySent: integer("quantity_sent").notNull(),
    quantityReceived: integer("quantity_received"),
    /** Harga mitra per satuan (nilai transfer, PTB-37). */
    unitValue: money("unit_value").notNull(),
    /** HPP toko (rata-rata bergerak) saat kirim. */
    unitCost: money("unit_cost"),
    lineValue: money("line_value").notNull(),
    differenceReason: text("difference_reason"),
    ...timestamps(),
  },
  (t) => [
    index("internal_transfer_lines_transfer_idx").on(t.transferId),
    index("internal_transfer_lines_tenant_idx").on(t.tenantId, t.productId),
  ],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  purchaseReceipts: many(purchaseReceipts),
  payments: many(supplierPayments),
}));

export const purchaseReceiptsRelations = relations(purchaseReceipts, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [purchaseReceipts.supplierId], references: [suppliers.id] }),
  outlet: one(outlets, { fields: [purchaseReceipts.outletId], references: [outlets.id] }),
  lines: many(purchaseReceiptLines),
  allocations: many(supplierPaymentAllocations),
}));

export const purchaseReceiptLinesRelations = relations(purchaseReceiptLines, ({ one }) => ({
  receipt: one(purchaseReceipts, { fields: [purchaseReceiptLines.receiptId], references: [purchaseReceipts.id] }),
  product: one(products, { fields: [purchaseReceiptLines.productId], references: [products.id] }),
}));

export const supplierPaymentsRelations = relations(supplierPayments, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [supplierPayments.supplierId], references: [suppliers.id] }),
  allocations: many(supplierPaymentAllocations),
}));

export const supplierPaymentAllocationsRelations = relations(supplierPaymentAllocations, ({ one }) => ({
  payment: one(supplierPayments, {
    fields: [supplierPaymentAllocations.supplierPaymentId],
    references: [supplierPayments.id],
  }),
  receipt: one(purchaseReceipts, {
    fields: [supplierPaymentAllocations.purchaseReceiptId],
    references: [purchaseReceipts.id],
  }),
}));

export const reorderItemsRelations = relations(reorderItems, ({ one }) => ({
  outlet: one(outlets, { fields: [reorderItems.outletId], references: [outlets.id] }),
  product: one(products, { fields: [reorderItems.productId], references: [products.id] }),
}));

export const internalTransfersRelations = relations(internalTransfers, ({ one, many }) => ({
  fromOutlet: one(outlets, {
    fields: [internalTransfers.fromOutletId],
    references: [outlets.id],
    relationName: "internal_transfer_from",
  }),
  toOutlet: one(outlets, {
    fields: [internalTransfers.toOutletId],
    references: [outlets.id],
    relationName: "internal_transfer_to",
  }),
  lines: many(internalTransferLines),
}));

export const internalTransferLinesRelations = relations(internalTransferLines, ({ one }) => ({
  transfer: one(internalTransfers, { fields: [internalTransferLines.transferId], references: [internalTransfers.id] }),
  product: one(products, {
    fields: [internalTransferLines.productId],
    references: [products.id],
    relationName: "internal_transfer_line_product",
  }),
  toProduct: one(products, {
    fields: [internalTransferLines.toProductId],
    references: [products.id],
    relationName: "internal_transfer_line_to_product",
  }),
}));
