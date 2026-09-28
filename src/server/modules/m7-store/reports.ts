/**
 * M7 — laporan toko yang dapat diekspor Excel/PDF (katalog 7.9.4, US-M9-03, NFR-23; `/api/export/<kunci>`).
 * Filter umum: `outletId` (bawaan toko pertama dalam lingkup), `month` (YYYY-MM), `from`/`to` (YYYY-MM-DD).
 * Berlingkup tenant pelaku (NFR-30).
 */
import "server-only";

import { z } from "zod";

import { formatTanggal, isBusinessDate } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { registerReport } from "@/server/core/export";

import { listSuppliers } from "./service/catalog";
import { listPayables, listSupplierPayments } from "./service/payables";
import { listPurchaseReceipts } from "./service/purchases";
import { discountReport, getStoreItem, listStoreItems, partnerPurchases, productPerformance } from "./service/queries";
import { getReorderList } from "./service/reorder";
import { stockCountHistory } from "./service/stock-count";
import { transferReport } from "./service/transfers";

const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOpt = z.string().regex(monthRe, { error: "Bulan harus YYYY-MM." }).optional();
const dateOpt = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).optional();
const outletSchema = z.object({ outletId: z.uuid().optional() });
const monthSchema = z.object({ outletId: z.uuid().optional(), month: monthOpt });
const rangeSchema = z.object({ outletId: z.uuid().optional(), from: dateOpt, to: dateOpt, supplierId: z.uuid().optional() });

const describeMonth = (f: { month?: string }) => (f.month ? [`Bulan: ${f.month}`] : ["Bulan berjalan"]);
const describeRange = (f: { from?: string; to?: string }) => (f.from || f.to ? [`Periode: ${f.from ? formatTanggal(f.from) : "…"} s.d. ${f.to ? formatTanggal(f.to) : "…"}`] : []);

export function registerReports(): void {
  registerReport({
    key: "m7.reorder",
    title: "Daftar pesan ulang toko (stok ≤ minimum)",
    module: "m7",
    permission: "m7.reorder.export",
    containsPii: false,
    filtersSchema: outletSchema,
    columns: [
      { key: "code", header: "Kode", width: 12 },
      { key: "name", header: "Barang", width: 28 },
      { key: "unit", header: "Satuan", width: 8 },
      { key: "minStock", header: "Stok minimum", type: "number", width: 10 },
      { key: "balance", header: "Saldo", type: "number", width: 10 },
      { key: "avgDailySales", header: "Rata-rata jual/hari", type: "number", width: 12 },
      { key: "lastSupplierName", header: "Pemasok terakhir", width: 22 },
      { key: "lastUnitCost", header: "Harga beli terakhir", type: "rupiah", width: 14 },
      { key: "status", header: "Status", type: "enum", enumName: "reorder_status", width: 14 },
      { key: "orderedSupplierName", header: "Dipesan ke", width: 20 },
      { key: "orderedAt", header: "Tanggal pesan", type: "date", width: 12 },
    ],
    fetch: async (ctx, f: z.infer<typeof outletSchema>, { tx }) => ({ rows: (await getReorderList(ctx, { outletId: f.outletId ?? null }, { tx })).rows }),
  });

  registerReport({
    key: "m7.items",
    title: "Barang & stok toko",
    module: "m7",
    permission: "m7.stock.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: outletSchema,
    columns: [
      { key: "code", header: "Kode", width: 12 },
      { key: "name", header: "Barang", width: 28 },
      { key: "category", header: "Kategori", width: 14 },
      { key: "unit", header: "Satuan", width: 8 },
      { key: "general", header: "Harga umum", type: "rupiah", width: 12, value: (r: { prices: { general?: number } }) => r.prices.general ?? null },
      { key: "partner", header: "Harga mitra", type: "rupiah", width: 12, value: (r: { prices: { partner?: number } }) => r.prices.partner ?? null },
      { key: "balance", header: "Saldo", type: "number", width: 10, total: true },
      { key: "minStock", header: "Stok minimum", type: "number", width: 10 },
      { key: "avgCost", header: "HPP rata-rata", type: "rupiah", width: 12 },
      { key: "stockValue", header: "Nilai stok", type: "rupiah", width: 14, total: true },
      { key: "status", header: "Status", type: "enum", enumName: "product_status", width: 14 },
    ],
    fetch: async (ctx, f: z.infer<typeof outletSchema>, { tx }) => ({ rows: (await listStoreItems(ctx, { outletId: f.outletId ?? null }, { tx })).items }),
  });

  const cardSchema = z.object({ outletId: z.uuid().optional(), productId: z.uuid({ error: "Pilih barang." }), from: dateOpt, to: dateOpt });
  registerReport({
    key: "m7.stock_card",
    title: "Kartu stok barang toko",
    module: "m7",
    permission: "m7.stock.read",
    containsPii: false,
    filtersSchema: cardSchema,
    describeFilters: describeRange,
    columns: [
      { key: "occurredAt", header: "Waktu", type: "datetime", width: 16 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "stock_movement_kind", width: 16 },
      { key: "quantity", header: "Jumlah", type: "number", width: 10 },
      { key: "unitCost", header: "Harga pokok", type: "rupiah", width: 12 },
      { key: "totalCost", header: "Nilai", type: "rupiah", width: 12 },
      { key: "balanceAfter", header: "Saldo", type: "number", width: 10 },
      { key: "avgCostAfter", header: "HPP rata-rata", type: "rupiah", width: 12 },
      { key: "note", header: "Keterangan", width: 30 },
    ],
    fetch: async (ctx, f: z.infer<typeof cardSchema>, { tx }) => {
      const item = await getStoreItem(ctx, f.productId, { outletId: f.outletId ?? null, from: f.from ?? null, to: f.to ?? null }, { tx });
      return {
        rows: item.card.rows,
        summary: [
          { label: "Barang", value: `${item.product.code} ${item.product.name}` },
          { label: "Saldo awal periode", value: item.card.opening, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "m7.purchases",
    title: "Nota pembelian / penerimaan barang toko",
    module: "m7",
    permission: "m7.purchase_receipt.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describeRange,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "number", header: "Nomor", width: 14 },
      { key: "supplierName", header: "Pemasok", width: 22 },
      { key: "supplierNoteNumber", header: "Nota pemasok", width: 14 },
      { key: "supplierNoteDate", header: "Tgl nota", type: "date", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "purchase_receipt_status", width: 16 },
      { key: "totalAmount", header: "Total", type: "rupiah", width: 14, total: true },
      { key: "outstanding", header: "Sisa utang", type: "rupiah", width: 14, total: true },
      { key: "dueDate", header: "Jatuh tempo", type: "date", width: 12 },
      { key: "isOpeningPayable", header: "Saldo awal", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, f: z.infer<typeof rangeSchema>, { tx }) => ({
      rows: await listPurchaseReceipts(ctx, { outletId: f.outletId ?? null, supplierId: f.supplierId ?? null, from: f.from ?? null, to: f.to ?? null, limit: 5000 }, { tx }),
    }),
  });

  const payableSchema = z.object({ supplierId: z.uuid().optional(), asOf: dateOpt });
  registerReport({
    key: "m7.payables",
    title: "Utang pemasok per nota & umur",
    module: "m7",
    permission: "m7.supplier_payable.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: payableSchema,
    describeFilters: (f) => (f.asOf ? [`Per tanggal ${formatTanggal(f.asOf)}`] : []),
    columns: [
      { key: "supplierName", header: "Pemasok", width: 22 },
      { key: "supplierNoteNumber", header: "Nota pemasok", width: 14 },
      { key: "number", header: "Nomor", width: 14 },
      { key: "supplierNoteDate", header: "Tgl nota", type: "date", width: 12 },
      { key: "dueDate", header: "Jatuh tempo", type: "date", width: 12 },
      { key: "total", header: "Total", type: "rupiah", width: 14, total: true },
      { key: "paid", header: "Dibayar", type: "rupiah", width: 14, total: true },
      { key: "returned", header: "Retur", type: "rupiah", width: 12, total: true },
      { key: "outstanding", header: "Sisa", type: "rupiah", width: 14, total: true },
      { key: "daysOverdue", header: "Hari lewat", type: "number", width: 8 },
      { key: "bucketLabel", header: "Umur", width: 16 },
    ],
    fetch: async (ctx, f: z.infer<typeof payableSchema>, { tx }) => ({ rows: (await listPayables(ctx, { supplierId: f.supplierId ?? null, asOf: f.asOf ?? null }, { tx })).rows }),
  });

  registerReport({
    key: "m7.payables_aging",
    title: "Umur utang per pemasok",
    module: "m7",
    permission: "m7.supplier_payable.read",
    containsPii: false,
    filtersSchema: payableSchema,
    columns: [
      { key: "supplierName", header: "Pemasok", width: 26 },
      { key: "not_due", header: "Belum jatuh tempo", type: "rupiah", width: 14, total: true },
      { key: "d1_7", header: "1–7 hari", type: "rupiah", width: 12, total: true },
      { key: "d8_30", header: "8–30 hari", type: "rupiah", width: 12, total: true },
      { key: "over_30", header: "> 30 hari", type: "rupiah", width: 12, total: true },
      { key: "total", header: "Total", type: "rupiah", width: 14, total: true },
    ],
    fetch: async (ctx, f: z.infer<typeof payableSchema>, { tx }) => ({ rows: (await listPayables(ctx, { supplierId: f.supplierId ?? null, asOf: f.asOf ?? null }, { tx })).bySupplier }),
  });

  registerReport({
    key: "m7.supplier_payments",
    title: "Pembayaran pemasok",
    module: "m7",
    permission: "m7.supplier_payable.read",
    containsPii: false,
    filtersSchema: z.object({ supplierId: z.uuid().optional() }),
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "supplierName", header: "Pemasok", width: 24 },
      { key: "method", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 12 },
      { key: "amount", header: "Jumlah", type: "rupiah", width: 14, total: true },
      { key: "notes", header: "Keterangan", width: 30 },
    ],
    fetch: async (ctx, f: { supplierId?: string }, { tx }) => ({ rows: await listSupplierPayments(ctx, { supplierId: f.supplierId ?? null, limit: 5000 }, { tx }) }),
  });

  registerReport({
    key: "m7.suppliers",
    title: "Daftar pemasok toko",
    module: "m7",
    permission: "m7.supplier.read",
    containsPii: false,
    columns: [
      { key: "name", header: "Pemasok", width: 26 },
      { key: "contactName", header: "Kontak", width: 18 },
      { key: "phone", header: "Telepon", width: 14 },
      { key: "paymentTermDays", header: "Tempo (hari)", type: "number", width: 10 },
      { key: "status", header: "Status", type: "enum", enumName: "supplier_status", width: 14 },
      { key: "outstanding", header: "Sisa utang", type: "rupiah", width: 14, total: true },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listSuppliers(ctx, { includeInactive: true }, { tx }) }),
  });

  const historySchema = z.object({ outletId: z.uuid().optional(), productId: z.uuid().optional(), fromMonth: monthOpt, toMonth: monthOpt });
  registerReport({
    key: "m7.stock_counts",
    title: "Riwayat opname toko & selisih per barang per bulan",
    module: "m7",
    permission: "m7.stock_count.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: historySchema,
    columns: [
      { key: "periodLabel", header: "Bulan", width: 10 },
      { key: "code", header: "Kode", width: 12 },
      { key: "name", header: "Barang", width: 26 },
      { key: "physicalQty", header: "Fisik", type: "number", width: 8 },
      { key: "systemQty", header: "Sistem (saat hitung)", type: "number", width: 10 },
      { key: "differenceQty", header: "Selisih", type: "number", width: 8, total: true },
      { key: "differenceValue", header: "Nilai selisih", type: "rupiah", width: 12, total: true },
      { key: "reason", header: "Alasan", type: "enum", enumName: "stock_adjust_reason", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "stock_count_status", width: 14 },
    ],
    fetch: async (ctx, f: z.infer<typeof historySchema>, { tx }) => ({
      rows: await stockCountHistory(ctx, { outletId: f.outletId ?? null, productId: f.productId ?? null, fromMonth: f.fromMonth ?? null, toMonth: f.toMonth ?? null }, { tx }),
    }),
  });

  registerReport({
    key: "m7.product_performance",
    title: "Barang laris/mati & margin per barang",
    module: "m7",
    permission: "m7.product_performance.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "code", header: "Kode", width: 12 },
      { key: "name", header: "Barang", width: 26 },
      { key: "groupLabel", header: "Kelompok", width: 8 },
      { key: "soldQty", header: "Terjual", type: "number", width: 8, total: true },
      { key: "revenue", header: "Omzet", type: "rupiah", width: 14, total: true },
      { key: "cogs", header: "Harga pokok", type: "rupiah", width: 14, total: true },
      { key: "grossMargin", header: "Margin kotor", type: "rupiah", width: 14, total: true },
      { key: "marginPct", header: "Margin %", type: "percent", width: 8 },
      { key: "daysWithoutSale", header: "Hari tanpa penjualan", type: "number", width: 10 },
      { key: "balance", header: "Saldo stok", type: "number", width: 8 },
      { key: "stockValue", header: "Nilai stok", type: "rupiah", width: 14, total: true },
    ],
    fetch: async (ctx, f: z.infer<typeof monthSchema>, { tx }) => {
      const r = await productPerformance(ctx, { outletId: f.outletId ?? null, month: f.month ?? null }, { tx });
      return {
        rows: r.rows,
        summary: [
          { label: "Laris", value: `${r.fastPercent}% teratas menurut omzet` },
          { label: "Mati", value: `tanpa penjualan ≥ ${r.deadDays} hari (PAR-66)` },
        ],
      };
    },
  });

  registerReport({
    key: "m7.partner_purchases",
    title: "Pembelian bulanan per pelanggan mitra toko",
    module: "m7",
    permission: "m7.report.read",
    containsPii: false,
    filtersSchema: monthSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "code", header: "Kode", width: 10 },
      { key: "name", header: "Pelanggan", width: 26 },
      { key: "isStorePartner", header: "Mitra toko", type: "boolean", width: 8 },
      { key: "transactions", header: "Transaksi", type: "number", width: 8, total: true },
      { key: "cash", header: "Tunai", type: "rupiah", width: 12, total: true },
      { key: "qris", header: "QRIS", type: "rupiah", width: 12, total: true },
      { key: "credit", header: "Tempo", type: "rupiah", width: 12, total: true },
      { key: "discount", header: "Diskon", type: "rupiah", width: 12, total: true },
      { key: "total", header: "Total", type: "rupiah", width: 14, total: true },
    ],
    fetch: async (ctx, f: z.infer<typeof monthSchema>, { tx }) => ({ rows: (await partnerPurchases(ctx, { outletId: f.outletId ?? null, month: f.month ?? null }, { tx })).rows }),
  });

  registerReport({
    key: "m7.discounts",
    title: "Diskon kasir toko per transaksi (bulanan)",
    module: "m7",
    permission: "m7.report.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "soldAt", header: "Waktu", type: "datetime", width: 16 },
      { key: "number", header: "Nomor", width: 18, value: (r: { number: string | null; localNumber: string }) => r.number ?? r.localNumber },
      { key: "customerName", header: "Pelanggan", width: 20 },
      { key: "cashierName", header: "Kasir", width: 16 },
      { key: "subtotal", header: "Subtotal", type: "rupiah", width: 12 },
      { key: "discountAmount", header: "Diskon", type: "rupiah", width: 12, total: true },
      { key: "discountPercent", header: "%", type: "percent", width: 6 },
      { key: "reason", header: "Alasan", width: 24 },
      { key: "approvalStatus", header: "Persetujuan", type: "enum", enumName: "approval_status", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "pos_sale_status", width: 14 },
    ],
    fetch: async (ctx, f: z.infer<typeof monthSchema>, { tx }) => {
      const r = await discountReport(ctx, { outletId: f.outletId ?? null, month: f.month ?? null }, { tx });
      return { rows: r.rows, summary: [{ label: "Diskon berlaku", value: r.totals.amount, type: "rupiah" }, { label: "Transaksi berdiskon", value: r.totals.count, type: "number" }] };
    },
  });

  const transferSchema = z.object({ month: monthOpt, toOutletId: z.uuid().optional() });
  registerReport({
    key: "m7.internal_transfers",
    title: "Transfer internal toko → depot (bulanan per depot)",
    module: "m7",
    permission: "m7.report.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: transferSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "sentAt", header: "Dikirim", type: "datetime", width: 16 },
      { key: "number", header: "Nomor", width: 14 },
      { key: "toOutletName", header: "Depot tujuan", width: 20 },
      { key: "status", header: "Status", type: "enum", enumName: "internal_transfer_status", width: 12 },
      { key: "items", header: "Barang", width: 36, value: (r: { lines: { name: string; quantitySent: number; quantityReceived: number | null }[] }) => r.lines.map((l) => `${l.name} ${l.quantitySent}${l.quantityReceived !== null && l.quantityReceived !== l.quantitySent ? `→${l.quantityReceived}` : ""}`).join(", ") },
      { key: "totalValue", header: "Nilai (harga mitra)", type: "rupiah", width: 14, total: true },
      { key: "hasDifference", header: "Selisih", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, f: z.infer<typeof transferSchema>, { tx }) => {
      const month = f.month ?? ctxBusinessDate(ctx).slice(0, 7);
      const r = await transferReport(ctx, { month, toOutletId: f.toOutletId ?? null }, { tx });
      return { rows: r.rows, summary: r.byDepot.map((d) => ({ label: d.outletName, value: d.totalValue, type: "rupiah" as const })) };
    },
  });
}
