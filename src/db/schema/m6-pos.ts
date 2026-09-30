/**
 * M6 — Penjualan Depot (POS) + kerangka POS/stok yang dipakai M7 (PRD 7.6, 7.7): shift & hitung stok shift, transaksi
 * POS + baris, kartu stok & saldo stok (rata-rata bergerak), opname, penerimaan bahan habis pakai, penerimaan pasokan
 * air depot & buku air outlet. MULTI-TENANT: setiap tabel transaksi memuat `tenant_id` + `outlet_id` (NFR-30).
 * Nomor transaksi POS `{kodeOutlet}-YYMMDD-NNNN` (D-04).
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
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
import { businessDate, liters, money, pk, refId, timestamps, tstz } from "./_columns";
import {
  approvalRef,
  approvalRequests,
  attachmentRef,
  createdBy,
  fieldMeta,
  outlets,
  paymentMethodEnum,
  priceKindEnum,
  tenantRef,
  userRef,
} from "./core";
import { customers, productPrices, products } from "./m1-master";
import { trips } from "./m2-orders";
import { deposits } from "./m4-cash";
import { invoices } from "./m5-receivables";
import { internalTransfers, suppliers } from "./m7-store";

// =====================================================================================================================
// Enum M6
// =====================================================================================================================

export const shiftStatusEnum = pgEnum("shift_status", enumValues("shift_status"));
export const shiftDepositStatusEnum = pgEnum("shift_deposit_status", enumValues("shift_deposit_status"));
export const posSaleStatusEnum = pgEnum("pos_sale_status", enumValues("pos_sale_status"));
export const voidReasonEnum = pgEnum("void_reason", enumValues("void_reason"));
export const stockMovementKindEnum = pgEnum("stock_movement_kind", enumValues("stock_movement_kind"));
export const stockCountKindEnum = pgEnum("stock_count_kind", enumValues("stock_count_kind"));
export const stockCountStatusEnum = pgEnum("stock_count_status", enumValues("stock_count_status"));
export const stockAdjustReasonEnum = pgEnum("stock_adjust_reason", enumValues("stock_adjust_reason"));
export const shiftStockPhaseEnum = pgEnum("shift_stock_phase", enumValues("shift_stock_phase"));
export const consumableSourceEnum = pgEnum("consumable_source", enumValues("consumable_source"));
export const waterSupplyStatusEnum = pgEnum("water_supply_status", enumValues("water_supply_status"));
export const waterSupplySourceEnum = pgEnum("water_supply_source", enumValues("water_supply_source"));
export const outletWaterKindEnum = pgEnum("outlet_water_kind", enumValues("outlet_water_kind"));

// =====================================================================================================================
// Shift
// =====================================================================================================================

/**
 * Shift depot/toko (Bab 5.2, US-M6-02, US-M7-09): Dibuka → Berjalan → Ditutup → setoran Belum disetor → Disetor →
 * Diterima. HANYA SATU shift terbuka per outlet (partial unique index) — kecuali shift yang dibuka offline di perangkat
 * cadangan saat shift lama masih terbuka: disimpan sebagai konflik sinkron (`sync_conflict`), bukan ditolak (7.6.6).
 */
export const shifts = pgTable(
  "shifts",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    operatorUserId: userRef("operator_user_id").notNull(),
    businessDate: businessDate().notNull(),
    status: shiftStatusEnum("status").notNull().default("open"),
    openedAt: tstz("opened_at").notNull(),
    /** Kas awal tetap dari sistem (PAR-57/outlet) & hasil hitung fisik saat buka. */
    openingCashFixed: money("opening_cash_fixed").notNull(),
    openingCashCounted: money("opening_cash_counted"),
    closedAt: tstz("closed_at"),
    // --- ringkasan saat tutup (dihitung sistem) ---
    cashSales: money("cash_sales"),
    qrisSales: money("qris_sales"),
    creditSales: money("credit_sales"),
    voidCount: integer("void_count"),
    voidAmount: money("void_amount"),
    /** Tunai seharusnya = kas awal + tunai − kembalian − void tunai. */
    expectedCash: money("expected_cash"),
    closingCashCounted: money("closing_cash_counted"),
    cashDifference: money("cash_difference"),
    cashDifferenceReason: text("cash_difference_reason"),
    /** Jumlah disetor = tunai seharusnya − kas awal tetap (US-M6-02 KP-5). */
    depositAmount: money("deposit_amount"),
    depositStatus: shiftDepositStatusEnum("deposit_status").notNull().default("not_deposited"),
    depositId: uuid("deposit_id").references((): AnyPgColumn => deposits.id),
    depositedAt: tstz("deposited_at"),
    /** BR-08: kas berjalan > PAR-02 → peringatan. */
    cashLimitAlertAt: tstz("cash_limit_alert_at"),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
    /** Σ setoran sebagian (`deposits.is_partial`) selama shift (BR-08, US-M6-02 KP-2/KP-5). */
    partialDepositTotal: money("partial_deposit_total").notNull().default(0),
    /**
     * Konflik sinkron (7.6.6, US-M6-06 KP-1/KP-3, Bab 6.4 butir 3): shift dibuka offline saat shift lain di outlet masih
     * terbuka. Disimpan (beserta penjualannya) dan ditampilkan ke Admin Keuangan, bukan ditolak.
     */
    syncConflict: boolean("sync_conflict").notNull().default(false),
    syncConflictNote: text("sync_conflict_note"),
    conflictResolvedAt: tstz("conflict_resolved_at"),
    conflictResolvedBy: userRef("conflict_resolved_by"),
  },
  (t) => [
    uniqueIndex("shifts_one_open_per_outlet_uq")
      .on(t.outletId)
      .where(sql`${t.status} = 'open' and ${t.syncConflict} = false`),
    index("shifts_outlet_date_idx").on(t.outletId, t.businessDate),
    index("shifts_deposit_status_idx").on(t.depositStatus),
  ],
);

/** Stok fisik bahan utama saat buka/tutup shift (US-M6-02 KP-3, US-M6-04 KP-3; toleransi PAR-58). */
export const shiftStockCounts = pgTable(
  "shift_stock_counts",
  {
    id: pk(),
    tenantId: tenantRef(),
    shiftId: uuid("shift_id")
      .notNull()
      .references((): AnyPgColumn => shifts.id),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    phase: shiftStockPhaseEnum("phase").notNull(),
    systemQty: integer("system_qty").notNull(),
    physicalQty: integer("physical_qty"),
    /** Pemakaian seharusnya dari resep (tutup shift). */
    expectedUsage: integer("expected_usage"),
    difference: integer("difference"),
    reason: text("reason"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("shift_stock_counts_uq").on(t.shiftId, t.productId, t.phase)],
);

// =====================================================================================================================
// Transaksi POS
// =====================================================================================================================

/**
 * Transaksi POS depot/toko (US-M6-01, US-M7-01). Tidak dapat diubah/dihapus — hanya void beralasan (US-M6-03).
 * ID dibuat di perangkat (Bab 6.4). Diskon hanya toko (≤ PAR-14, lebih → menunggu persetujuan; BR-17).
 */
export const posSales = pgTable(
  "pos_sales",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    shiftId: uuid("shift_id")
      .notNull()
      .references((): AnyPgColumn => shifts.id),
    /**
     * Nomor resmi `{kodeOutlet}-YYMMDD-NNNN` (D-04) — diisi SERVER saat sinkron (kosong selama di antrean perangkat),
     * unik per outlet. Nomor yang tampil/tercetak di perangkat = `local_number`.
     */
    number: text("number"),
    /**
     * Nomor terbit di perangkat (7.6.6, US-M6-01 KP-4/KP-5, US-M6-06 KP-2): memuat kode perangkat, mis.
     * `D01-270926-P2-0007`, unik per perangkat; `device_seq` = urutan per perangkat.
     */
    localNumber: text("local_number").notNull(),
    deviceSeq: integer("device_seq").notNull(),
    operatorUserId: userRef("operator_user_id").notNull(),
    /** Opsional untuk tunai umum; wajib untuk harga mitra & tempo (US-M7-01 KP-1). Depot: disiapkan kosong (FR-M6-08). */
    customerId: uuid("customer_id").references((): AnyPgColumn => customers.id),
    priceKind: priceKindEnum("price_kind").notNull(),
    businessDate: businessDate().notNull(),
    soldAt: tstz("sold_at").notNull(),
    subtotal: money("subtotal").notNull(),
    /** Diskon kasir toko (persen, 2 desimal) & nilainya. */
    discountPercent: numeric("discount_percent", { precision: 5, scale: 2, mode: "number" }),
    discountAmount: money("discount_amount").notNull().default(0),
    discountReason: text("discount_reason"),
    discountApprovalId: approvalRef("discount_approval_id"),
    total: money("total").notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    cashReceived: money("cash_received"),
    changeAmount: money("change_amount"),
    qrisReference: text("qris_reference"),
    /** Penjualan tempo mitra → faktur M5 (US-M7-04 KP-3). */
    invoiceId: uuid("invoice_id").references((): AnyPgColumn => invoices.id),
    status: posSaleStatusEnum("status").notNull().default("valid"),
    voidReason: voidReasonEnum("void_reason"),
    voidNote: text("void_note"),
    voidRequestedAt: tstz("void_requested_at"),
    voidedAt: tstz("voided_at"),
    voidedBy: userRef("voided_by"),
    voidApprovalId: approvalRef("void_approval_id"),
    /** Transaksi pengganti dari void (US-M6-03 KP-1). */
    replacesSaleId: uuid("replaces_sale_id").references((): AnyPgColumn => posSales.id),
    /** US-M6-06 KP-4: harga di perangkat berbeda dari harga master berlaku. */
    priceMismatch: boolean("price_mismatch").notNull().default(false),
    /** PTB-42: tempo offline memakai eksposur sinkron terakhir → tinjauan Admin Keuangan. */
    creditOffline: boolean("credit_offline").notNull().default(false),
    receiptPrinted: boolean("receipt_printed").notNull().default(false),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
    /**
     * Koreksi setelah shift ditutup (US-M6-02 KP-4, US-M6-03 KP-2/PTB-43, BR-38, 7.11.4): baris pembalik bernilai
     * negatif (total & baris) pada tanggal bisnis & shift saat koreksi, merujuk transaksi asal.
     */
    reversalOfId: uuid("reversal_of_id"),
    isReversal: boolean("is_reversal").notNull().default(false),
    reversalReason: text("reversal_reason"),
    correctionApprovalId: uuid("correction_approval_id"),
  },
  (t) => [
    uniqueIndex("pos_sales_outlet_number_uq")
      .on(t.outletId, t.number)
      .where(sql`${t.number} is not null`),
    uniqueIndex("pos_sales_device_local_number_uq").on(t.deviceId, t.localNumber),
    index("pos_sales_outlet_date_idx").on(t.outletId, t.businessDate),
    // Uji beban NFR-05: agregat omzet/galon per tenant & rentang tanggal (M9 H+0/bulanan, M6 `salesAggregates`) tanpa
    // filter outlet — tanpa indeks ini memindai seluruh transaksi semua tenant (±4.800/hari pada 3× volume).
    index("pos_sales_tenant_date_idx").on(t.tenantId, t.businessDate),
    index("pos_sales_shift_idx").on(t.shiftId),
    index("pos_sales_customer_idx").on(t.customerId),
    foreignKey({ name: "pos_sales_reversal_fk", columns: [t.reversalOfId], foreignColumns: [t.id] }),
    foreignKey({
      name: "pos_sales_correction_approval_fk",
      columns: [t.correctionApprovalId],
      foreignColumns: [approvalRequests.id],
    }),
    uniqueIndex("pos_sales_reversal_uq")
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    check(
      "pos_sales_reversal_chk",
      sql`(${t.isReversal} = false and ${t.reversalOfId} is null and ${t.total} >= 0) or (${t.isReversal} = true and ${t.reversalOfId} is not null and ${t.total} <= 0)`,
    ),
  ],
);

/** Baris transaksi POS: harga dari master (BR-15) & harga pokok saat jual (HPP rata-rata bergerak, PTB-38). */
export const posSaleLines = pgTable(
  "pos_sale_lines",
  {
    id: pk(),
    posSaleId: uuid("pos_sale_id")
      .notNull()
      .references((): AnyPgColumn => posSales.id),
    /** Salinan dari transaksi induk (isolasi tenant NFR-30 & laporan per produk/outlet tanpa join). */
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    businessDate: businessDate().notNull(),
    lineNo: integer("line_no").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    productPriceId: uuid("product_price_id").references((): AnyPgColumn => productPrices.id),
    quantity: integer("quantity").notNull(),
    unitPrice: money("unit_price").notNull(),
    lineTotal: money("line_total").notNull(),
    unitCost: money("unit_cost"),
    /** Salinan ukuran galon saat jual (neraca air outlet, A9). */
    gallonSizeL: integer("gallon_size_l"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pos_sale_lines_sale_line_uq").on(t.posSaleId, t.lineNo),
    index("pos_sale_lines_product_idx").on(t.productId),
    index("pos_sale_lines_outlet_date_idx").on(t.outletId, t.businessDate, t.productId),
    // Uji beban NFR-05: galon terjual per tenant & rentang tanggal (M9) — lihat `pos_sales_tenant_date_idx`.
    index("pos_sale_lines_tenant_date_idx").on(t.tenantId, t.businessDate),
  ],
);

// =====================================================================================================================
// Stok
// =====================================================================================================================

/**
 * Kartu stok per barang per outlet (US-M6-04 KP-1, US-M7-02 KP-3): masuk, keluar, penyesuaian, transfer; baris
 * pembalik untuk koreksi. `quantity` bertanda; saldo & harga pokok rata-rata setelah mutasi dicatat.
 */
export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    kind: stockMovementKindEnum("kind").notNull(),
    quantity: integer("quantity").notNull(),
    unitCost: money("unit_cost"),
    totalCost: money("total_cost"),
    balanceAfter: integer("balance_after").notNull(),
    avgCostAfter: money("avg_cost_after"),
    businessDate: businessDate().notNull(),
    occurredAt: tstz("occurred_at").notNull(),
    sourceObjectType: text("source_object_type"),
    sourceObjectId: refId("source_object_id"),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => stockLedger.id),
    note: text("note"),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("stock_ledger_outlet_product_idx").on(t.outletId, t.productId, t.occurredAt),
    index("stock_ledger_source_idx").on(t.sourceObjectType, t.sourceObjectId),
    // US-M6-04 KP-1 / US-M7-04 KP-3: satu mutasi per (sumber, barang, jenis) — handler terulang tidak menggandakan stok.
    uniqueIndex("stock_ledger_source_uq")
      .on(t.sourceObjectType, t.sourceObjectId, t.productId, t.kind)
      .where(sql`${t.reversalOfId} is null`),
  ],
);

/**
 * Saldo stok per outlet per barang. Harga pokok rata-rata bergerak (PTB-38): `avg_cost` = total_value / quantity
 * (disimpan dibulatkan); `total_value` menjaga nilai persediaan tanpa galat pembulatan.
 */
export const stockBalances = pgTable(
  "stock_balances",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    quantity: integer("quantity").notNull().default(0),
    avgCost: money("avg_cost").notNull().default(0),
    totalValue: money("total_value").notNull().default(0),
    lastMovementAt: tstz("last_movement_at"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("stock_balances_outlet_product_uq").on(t.outletId, t.productId)],
);

/**
 * Opname (BR-27, PAR-32): depot mingguan, toko bulanan. Dihitung → Penyesuaian diajukan → Disetujui (pemilik) →
 * saldo disesuaikan + jurnal M11. Saldo sistem ditampilkan hanya setelah jumlah fisik dimasukkan (US-M7-05 KP-1).
 */
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    kind: stockCountKindEnum("kind").notNull(),
    /** Mis. '2026-W39' atau '2026-09'. */
    periodLabel: text("period_label").notNull(),
    status: stockCountStatusEnum("status").notNull().default("counting"),
    startedAt: tstz("started_at").notNull(),
    countedBy: userRef("counted_by"),
    /** Opname toko dilakukan kasir bersama Admin Keuangan. */
    coCounterUserId: userRef("co_counter_user_id"),
    submittedAt: tstz("submitted_at"),
    approvalRequestId: approvalRef(),
    decidedAt: tstz("decided_at"),
    adjustmentPostedAt: tstz("adjustment_posted_at"),
    /** Tenggat persetujuan (≤ 3 hari, 6.2a). */
    dueAt: tstz("due_at"),
    notes: text("notes"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
  },
  (t) => [
    index("stock_counts_outlet_idx").on(t.outletId, t.periodLabel),
    uniqueIndex("stock_counts_sync_command_uq")
      .on(t.syncCommandId)
      .where(sql`${t.syncCommandId} is not null`),
  ],
);

/** Baris opname: jumlah fisik vs saldo sistem pada waktu hitung per barang (US-M7-05 KP-3). */
export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: pk(),
    /** NFR-30: disalin dari `stock_counts.tenant_id`. */
    tenantId: tenantRef(),
    stockCountId: uuid("stock_count_id")
      .notNull()
      .references((): AnyPgColumn => stockCounts.id),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    physicalQty: integer("physical_qty").notNull(),
    systemQtyAtCount: integer("system_qty_at_count").notNull(),
    countedAt: tstz("counted_at").notNull(),
    differenceQty: integer("difference_qty").notNull(),
    unitCost: money("unit_cost"),
    differenceValue: money("difference_value"),
    reason: stockAdjustReasonEnum("reason"),
    reasonNote: text("reason_note"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("stock_count_lines_uq").on(t.stockCountId, t.productId),
    index("stock_count_lines_tenant_idx").on(t.tenantId, t.productId),
  ],
);

/**
 * Penerimaan bahan habis pakai di depot (US-M6-04 KP-5): dari transfer internal toko (US-M7-06) atau pemasok lain
 * dengan nota. Tanpa pencatatan, stok tidak bertambah.
 */
export const consumableReceipts = pgTable(
  "consumable_receipts",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    source: consumableSourceEnum("source").notNull(),
    internalTransferId: uuid("internal_transfer_id"),
    supplierId: uuid("supplier_id").references((): AnyPgColumn => suppliers.id),
    supplierNoteNumber: text("supplier_note_number"),
    noteAttachmentId: attachmentRef("note_attachment_id"),
    shiftId: uuid("shift_id").references((): AnyPgColumn => shifts.id),
    receivedAt: tstz("received_at").notNull(),
    receivedBy: userRef("received_by"),
    businessDate: businessDate().notNull(),
    notes: text("notes"),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
    /** Koreksi = baris pembalik (BR-38, US-M6-05 KP-1); baris asal ditandai `reversed_at`. */
    reversalOfId: uuid("reversal_of_id"),
    reversalReason: text("reversal_reason"),
    correctionApprovalId: uuid("correction_approval_id"),
    reversedAt: tstz("reversed_at"),
  },
  (t) => [
    index("consumable_receipts_outlet_idx").on(t.outletId, t.businessDate),
    foreignKey({
      name: "consumable_receipts_transfer_fk",
      columns: [t.internalTransferId],
      foreignColumns: [internalTransfers.id],
    }),
    foreignKey({ name: "consumable_receipts_reversal_fk", columns: [t.reversalOfId], foreignColumns: [t.id] }),
    foreignKey({
      name: "consumable_receipts_correction_approval_fk",
      columns: [t.correctionApprovalId],
      foreignColumns: [approvalRequests.id],
    }),
    // US-M7-06 KP-1: satu penerimaan hidup per transfer internal.
    uniqueIndex("consumable_receipts_transfer_uq")
      .on(t.internalTransferId)
      .where(sql`${t.internalTransferId} is not null and ${t.reversalOfId} is null and ${t.reversedAt} is null`),
    uniqueIndex("consumable_receipts_reversal_uq")
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    uniqueIndex("consumable_receipts_sync_command_uq")
      .on(t.syncCommandId)
      .where(sql`${t.syncCommandId} is not null`),
  ],
);

export const consumableReceiptLines = pgTable(
  "consumable_receipt_lines",
  {
    id: pk(),
    /** NFR-30: disalin dari `consumable_receipts.tenant_id`. */
    tenantId: tenantRef(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references((): AnyPgColumn => consumableReceipts.id),
    productId: uuid("product_id")
      .notNull()
      .references((): AnyPgColumn => products.id),
    quantity: integer("quantity").notNull(),
    unitCost: money("unit_cost"),
    /** Transfer internal: jumlah dikirim toko; selisih kirim–terima ditandai (US-M7-06 KP-1). */
    expectedQuantity: integer("expected_quantity"),
    differenceReason: text("difference_reason"),
    ...timestamps(),
  },
  (t) => [
    index("consumable_receipt_lines_receipt_idx").on(t.receiptId),
    index("consumable_receipt_lines_tenant_idx").on(t.tenantId, t.productId),
  ],
);

// =====================================================================================================================
// Air depot
// =====================================================================================================================

/**
 * Penerimaan pasokan air depot (US-M6-05, US-M8-03, US-P3-08): Tiba (rit internal/mitra Selesai) → Dikonfirmasi /
 * Selisih; tanpa konfirmasi sampai tutup shift berikutnya (PAR-61) → diterima sesuai catatan sopir dengan penanda.
 */
export const waterSupplyReceipts = pgTable(
  "water_supply_receipts",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    source: waterSupplySourceEnum("source").notNull().default("equa_truck"),
    tripId: uuid("trip_id").references((): AnyPgColumn => trips.id),
    status: waterSupplyStatusEnum("status").notNull().default("arrived"),
    /** Volume diserahkan menurut sopir (M3). */
    deliveredVolumeL: liters("delivered_volume_l"),
    receivedVolumeL: liters("received_volume_l"),
    differenceL: liters("difference_l"),
    differenceReason: text("difference_reason"),
    confirmedAt: tstz("confirmed_at"),
    confirmedBy: userRef("confirmed_by"),
    shiftId: uuid("shift_id").references((): AnyPgColumn => shifts.id),
    autoAcceptedAt: tstz("auto_accepted_at"),
    /** Pasokan darurat dari sumber lain: alasan (US-M6-05 KP-6). */
    otherSourceReason: text("other_source_reason"),
    businessDate: businessDate().notNull(),
    ...fieldMeta(),
    ...timestamps(),
    createdBy: createdBy(),
    /** Koreksi = baris pembalik (BR-38, US-M6-05 KP-1); baris asal ditandai `reversed_at`. */
    reversalOfId: uuid("reversal_of_id"),
    reversalReason: text("reversal_reason"),
    correctionApprovalId: uuid("correction_approval_id"),
    reversedAt: tstz("reversed_at"),
  },
  (t) => [
    uniqueIndex("water_supply_receipts_trip_uq")
      .on(t.tripId)
      .where(sql`${t.tripId} is not null and ${t.reversalOfId} is null and ${t.reversedAt} is null`),
    foreignKey({ name: "water_supply_receipts_reversal_fk", columns: [t.reversalOfId], foreignColumns: [t.id] }),
    foreignKey({
      name: "water_supply_receipts_correction_approval_fk",
      columns: [t.correctionApprovalId],
      foreignColumns: [approvalRequests.id],
    }),
    uniqueIndex("water_supply_receipts_reversal_uq")
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    uniqueIndex("water_supply_receipts_sync_command_uq")
      .on(t.syncCommandId)
      .where(sql`${t.syncCommandId} is not null`),
    index("water_supply_receipts_outlet_idx").on(t.outletId, t.businessDate),
    index("water_supply_receipts_status_idx").on(t.status),
  ],
);

/**
 * Buku air outlet (liter): stok air = stok awal + diterima − galon terjual × ukuran galon (US-M6-05 KP-3). Dasar neraca
 * air outlet mingguan/bulanan (PAR-59) & mitra (PAR-79).
 */
export const outletWaterLedger = pgTable(
  "outlet_water_ledger",
  {
    id: pk(),
    tenantId: tenantRef(),
    outletId: uuid("outlet_id")
      .notNull()
      .references((): AnyPgColumn => outlets.id),
    businessDate: businessDate().notNull(),
    kind: outletWaterKindEnum("kind").notNull(),
    /** Bertanda: masuk positif, keluar negatif. */
    volumeL: liters("volume_l").notNull(),
    balanceAfterL: liters("balance_after_l"),
    sourceObjectType: text("source_object_type"),
    sourceObjectId: refId("source_object_id"),
    occurredAt: tstz("occurred_at").notNull(),
    ...timestamps(),
    /** Koreksi = baris pembalik bertanda berlawanan (BR-38); buku air append-only (hardening.sql). */
    reversalOfId: uuid("reversal_of_id"),
    reversalReason: text("reversal_reason"),
    correctionApprovalId: uuid("correction_approval_id"),
  },
  (t) => [
    index("outlet_water_ledger_outlet_idx").on(t.outletId, t.businessDate),
    index("outlet_water_ledger_source_idx").on(t.sourceObjectType, t.sourceObjectId),
    foreignKey({ name: "outlet_water_ledger_reversal_fk", columns: [t.reversalOfId], foreignColumns: [t.id] }),
    foreignKey({
      name: "outlet_water_ledger_correction_approval_fk",
      columns: [t.correctionApprovalId],
      foreignColumns: [approvalRequests.id],
    }),
    uniqueIndex("outlet_water_ledger_reversal_uq")
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    // US-M6-05 KP-3: satu mutasi air per (sumber, jenis).
    uniqueIndex("outlet_water_ledger_source_uq")
      .on(t.sourceObjectType, t.sourceObjectId, t.kind)
      .where(sql`${t.reversalOfId} is null and ${t.sourceObjectId} is not null`),
  ],
);

// =====================================================================================================================
// Relasi
// =====================================================================================================================

export const shiftsRelations = relations(shifts, ({ one, many }) => ({
  outlet: one(outlets, { fields: [shifts.outletId], references: [outlets.id] }),
  deposit: one(deposits, { fields: [shifts.depositId], references: [deposits.id] }),
  sales: many(posSales),
  stockCounts: many(shiftStockCounts),
}));

export const shiftStockCountsRelations = relations(shiftStockCounts, ({ one }) => ({
  shift: one(shifts, { fields: [shiftStockCounts.shiftId], references: [shifts.id] }),
  product: one(products, { fields: [shiftStockCounts.productId], references: [products.id] }),
}));

export const posSalesRelations = relations(posSales, ({ one, many }) => ({
  outlet: one(outlets, { fields: [posSales.outletId], references: [outlets.id] }),
  shift: one(shifts, { fields: [posSales.shiftId], references: [shifts.id] }),
  customer: one(customers, { fields: [posSales.customerId], references: [customers.id] }),
  invoice: one(invoices, { fields: [posSales.invoiceId], references: [invoices.id] }),
  lines: many(posSaleLines),
}));

export const posSaleLinesRelations = relations(posSaleLines, ({ one }) => ({
  sale: one(posSales, { fields: [posSaleLines.posSaleId], references: [posSales.id] }),
  product: one(products, { fields: [posSaleLines.productId], references: [products.id] }),
}));

export const stockLedgerRelations = relations(stockLedger, ({ one }) => ({
  outlet: one(outlets, { fields: [stockLedger.outletId], references: [outlets.id] }),
  product: one(products, { fields: [stockLedger.productId], references: [products.id] }),
}));

export const stockBalancesRelations = relations(stockBalances, ({ one }) => ({
  outlet: one(outlets, { fields: [stockBalances.outletId], references: [outlets.id] }),
  product: one(products, { fields: [stockBalances.productId], references: [products.id] }),
}));

export const stockCountsRelations = relations(stockCounts, ({ one, many }) => ({
  outlet: one(outlets, { fields: [stockCounts.outletId], references: [outlets.id] }),
  lines: many(stockCountLines),
}));

export const stockCountLinesRelations = relations(stockCountLines, ({ one }) => ({
  stockCount: one(stockCounts, { fields: [stockCountLines.stockCountId], references: [stockCounts.id] }),
  product: one(products, { fields: [stockCountLines.productId], references: [products.id] }),
}));

export const consumableReceiptsRelations = relations(consumableReceipts, ({ one, many }) => ({
  outlet: one(outlets, { fields: [consumableReceipts.outletId], references: [outlets.id] }),
  internalTransfer: one(internalTransfers, {
    fields: [consumableReceipts.internalTransferId],
    references: [internalTransfers.id],
  }),
  supplier: one(suppliers, { fields: [consumableReceipts.supplierId], references: [suppliers.id] }),
  lines: many(consumableReceiptLines),
}));

export const consumableReceiptLinesRelations = relations(consumableReceiptLines, ({ one }) => ({
  receipt: one(consumableReceipts, { fields: [consumableReceiptLines.receiptId], references: [consumableReceipts.id] }),
  product: one(products, { fields: [consumableReceiptLines.productId], references: [products.id] }),
}));

export const waterSupplyReceiptsRelations = relations(waterSupplyReceipts, ({ one }) => ({
  outlet: one(outlets, { fields: [waterSupplyReceipts.outletId], references: [outlets.id] }),
  trip: one(trips, { fields: [waterSupplyReceipts.tripId], references: [trips.id] }),
  shift: one(shifts, { fields: [waterSupplyReceipts.shiftId], references: [shifts.id] }),
}));

export const outletWaterLedgerRelations = relations(outletWaterLedger, ({ one }) => ({
  outlet: one(outlets, { fields: [outletWaterLedger.outletId], references: [outlets.id] }),
}));
