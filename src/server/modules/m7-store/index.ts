/**
 * M7 — Penjualan Toko & Stok: API PUBLIK modul. POS toko, penerimaan barang, stok, opname, transfer internal, utang pemasok (PRD 7.7).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Kontrak untuk modul lain (rincian: docs/dev/modules/m7-store.md):
 * - Kerangka POS M6: `storePolicy` dipasang `registerSync()` (B-05) — penjualan/void/shift toko lewat perintah `m6.*`.
 * - M4 kas: `storeShiftsBlockingCashClose(tx, tenantId, businessDate)` — tutup kas mensyaratkan shift toko ditutup
 *   (US-M7-09 KP-3); `supplier_payment.recorded` (kas kantor/transfer keluar).
 * - M5 piutang: `pos_sale.recorded` metode `credit` (toko) → faktur per transaksi (`paymentTermDays`), `store_return.recorded`
 *   → nota kredit/pengembalian dana; `evaluateStoreCredit`/`storeCreditExposure` (tempo toko belum difakturkan).
 * - M11: `purchase_receipt.recorded`/`.corrected`, `supplier_payment.recorded`, `internal_transfer.sent`, `stock.adjusted`
 *   (outletKind store), `pos_sale.recorded` (+`cogs`, `lineCosts`, diskon), `store_return.recorded`.
 */
import "server-only";

export const MODULE_KEY = "m7-store" as const;
export const MODULE_NAME = "Penjualan Toko & Stok" as const;

// --- Kebijakan POS toko (kerangka M6) ---------------------------------------------------------------------------------
export { storePolicy, discountExceedsLimit, STORE_SALE_APPROVAL_TYPES } from "./service/policy";
export { evaluateStoreCredit, storeCreditExposure, uninvoicedStoreCredit } from "./service/credit";
export type { StoreCreditCheck, StoreCreditExposure } from "./service/credit";
export { recordStoreReturn, returnedQuantities, storeReturnSchema, storeSalesForReturn } from "./service/returns";
export type { ReturnableSale } from "./service/returns";
export { storeShiftsBlockingCashClose } from "./service/shifts";
export type { OpenStoreShift } from "./service/shifts";

// --- Barang, harga toko, pemasok (US-M7-02 KP-2, 7.7.3) --------------------------------------------------------------
export {
  proposeStoreProduct,
  proposeStorePrice,
  proposeSupplier,
  updateSupplier,
  setSupplierActive,
  listSuppliers,
  proposeProductSchema,
  proposePriceSchema,
  proposeSupplierSchema,
} from "./service/catalog";
export type { SupplierListRow } from "./service/catalog";

// --- Penerimaan barang & kartu stok (US-M7-02) -----------------------------------------------------------------------
export {
  recordPurchaseReceipt,
  acceptSubstituteNote,
  correctPurchaseReceipt,
  recordOpeningPayable,
  listPurchaseReceipts,
  getPurchaseReceipt,
  purchaseReceiptSchema,
  correctionSchema,
  openingPayableSchema,
} from "./service/purchases";
export type { PurchaseListRow, PurchaseReceiptInput, PurchaseCorrectionInput } from "./service/purchases";

// --- Pesan ulang (US-M7-03) ------------------------------------------------------------------------------------------
export { evaluateReorder, closeReorderOnReceipt, markReorderOrdered, reorderList, getReorderList, markOrderedSchema, soldQuantities } from "./service/reorder";
export type { ReorderListRow } from "./service/reorder";

// --- Opname & stok awal (US-M7-05, US-M7-02 KP-5) --------------------------------------------------------------------
export {
  recordStoreCount,
  recountStoreLine,
  submitStoreStockCount,
  prepareOpeningStock,
  signOpeningStock,
  listStoreStockCounts,
  getStoreStockCount,
  stockCountHistory,
  runStoreStockCountCheck,
  storeCountSchema,
} from "./service/stock-count";
export type { CountedLine, StockCountHistoryRow } from "./service/stock-count";

// --- Transfer internal (US-M7-06) ------------------------------------------------------------------------------------
export { sendInternalTransfer, transferReport, depotMaterialFor, internalTransferSchema } from "./service/transfers";
export type { TransferReportRow } from "./service/transfers";

// --- Utang pemasok (US-M7-08) ----------------------------------------------------------------------------------------
export {
  listPayables,
  payableRows,
  receiptBalances,
  recordSupplierPayment,
  reverseSupplierPayment,
  listSupplierPayments,
  runPayableReminders,
  agingBucket,
  AGING_LABELS,
} from "./service/payables";
export type { PayableRow, SupplierAgingRow, SupplierPaymentInput, AgingBucket } from "./service/payables";

// --- Tampilan kantor & laporan (US-M7-07) ----------------------------------------------------------------------------
export { listStoreItems, getStoreItem, stockCard, productPerformance, partnerPurchases, discountReport, storeOverview, pendingStoreApprovals, listStoreOutlets } from "./service/queries";
export type { StoreItemRow, StockCardRow, ProductPerformanceRow, PartnerPurchaseRow, DiscountRow } from "./service/queries";
export { storeOutletsOf, resolveOfficeStore, monthLabel, monthRange, balanceAt } from "./service/common";

// --- Data offline POS toko -------------------------------------------------------------------------------------------
export { buildStoreReference } from "./service/pull";
