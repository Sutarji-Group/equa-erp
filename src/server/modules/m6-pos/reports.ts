/**
 * M6 — laporan outlet yang dapat diekspor Excel/PDF (katalog PRD 7.9.4, US-M9-03, NFR-23; US-M6-07 KP-5 laporan per
 * outlet yang sama untuk pemilik tenant). Semua laporan berlingkup tenant pelaku (NFR-30) — tidak ada ekspor lintas
 * tenant. Filter: `from`, `to` (YYYY-MM-DD, bawaan 7 hari terakhir), `outletId` (opsional).
 */
import "server-only";

import { z } from "zod";

import { formatTanggal, isBusinessDate } from "@/lib/time";
import type { ActorContext } from "@/server/core/context";
import { registerReport } from "@/server/core/export";

import {
  dailyOutletReport,
  defaultRange,
  salesReport,
  shiftReport,
  stockCardReport,
  stockCountReport,
  usageVsSalesReport,
  voidReport,
  waterBalanceReport,
  waterSupplyReport,
} from "./service/queries";

const dateOpt = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).optional();
const rangeSchema = z.object({ from: dateOpt, to: dateOpt, outletId: z.uuid().optional() });
type RangeFilters = z.infer<typeof rangeSchema>;

function range(ctx: ActorContext, f: RangeFilters, days = 7) {
  const d = defaultRange(ctx, days);
  return { from: f.from ?? d.from, to: f.to ?? d.to, outletId: f.outletId ?? null };
}

function describe(f: RangeFilters): string[] {
  const out: string[] = [];
  if (f.from || f.to) out.push(`Periode: ${f.from ? formatTanggal(f.from) : "…"} s.d. ${f.to ? formatTanggal(f.to) : "…"}`);
  if (f.outletId) out.push("Satu outlet");
  return out;
}

export function registerReports(): void {
  registerReport({
    key: "m6.outlet_daily",
    title: "Ringkasan harian per outlet (penjualan, galon, void, setoran)",
    module: "m6",
    permission: "m6.outlet.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "outletName", header: "Nama outlet", width: 24 },
      { key: "gallons", header: "Galon terjual", type: "number", total: true, width: 10 },
      { key: "transactions", header: "Transaksi", type: "number", total: true, width: 10 },
      { key: "salesTotal", header: "Penjualan", type: "rupiah", total: true, width: 14 },
      { key: "cashSales", header: "Tunai", type: "rupiah", total: true, width: 14 },
      { key: "qrisSales", header: "QRIS", type: "rupiah", total: true, width: 14 },
      { key: "voidCount", header: "Void", type: "number", total: true, width: 8 },
      { key: "voidAmount", header: "Nilai void", type: "rupiah", total: true, width: 12 },
      { key: "shiftsClosed", header: "Shift ditutup", type: "number", width: 10 },
      { key: "depositTotal", header: "Setoran", type: "rupiah", total: true, width: 14 },
      { key: "cashDifference", header: "Selisih kas", type: "rupiah", total: true, width: 12 },
      { key: "priceMismatch", header: "Beda harga", type: "number", width: 10 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => ({ rows: await dailyOutletReport(ctx, range(ctx, f), { tx }) }),
  });

  registerReport({
    key: "m6.shifts",
    title: "Riwayat shift outlet (kas, selisih, setoran)",
    module: "m6",
    permission: "m6.outlet.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "operatorName", header: "Operator", width: 20 },
      { key: "status", header: "Status", type: "enum", enumName: "shift_status", width: 10 },
      { key: "openedAt", header: "Dibuka", type: "datetime", width: 16 },
      { key: "closedAt", header: "Ditutup", type: "datetime", width: 16 },
      { key: "openingCashFixed", header: "Kas awal tetap", type: "rupiah", width: 12 },
      { key: "cashSales", header: "Tunai", type: "rupiah", total: true, width: 12 },
      { key: "qrisSales", header: "QRIS", type: "rupiah", total: true, width: 12 },
      { key: "voidCount", header: "Void", type: "number", width: 6 },
      { key: "expectedCash", header: "Tunai seharusnya", type: "rupiah", width: 14 },
      { key: "closingCashCounted", header: "Kas fisik", type: "rupiah", width: 12 },
      { key: "cashDifference", header: "Selisih", type: "rupiah", total: true, width: 12 },
      { key: "cashDifferenceReason", header: "Alasan selisih", width: 24 },
      { key: "partialDepositTotal", header: "Setor sebagian", type: "rupiah", width: 12 },
      { key: "depositAmount", header: "Setoran", type: "rupiah", total: true, width: 12 },
      { key: "depositStatus", header: "Status setoran", type: "enum", enumName: "shift_deposit_status", width: 12 },
      { key: "syncConflict", header: "Konflik", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => ({ rows: await shiftReport(ctx, range(ctx, f, 30), { tx }) }),
  });

  registerReport({
    key: "m6.pos_sales",
    title: "Transaksi POS outlet",
    module: "m6",
    permission: "m6.outlet.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "number", header: "Nomor", width: 20 },
      { key: "localNumber", header: "Nomor perangkat", width: 26 },
      { key: "soldAt", header: "Waktu (perangkat)", type: "datetime", width: 16 },
      { key: "paymentMethod", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 10 },
      { key: "total", header: "Total", type: "rupiah", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "pos_sale_status", width: 14 },
      { key: "voidReason", header: "Alasan void", type: "enum", enumName: "void_reason", width: 14 },
      { key: "counted", header: "Dihitung", type: "boolean", width: 8 },
      { key: "isReversal", header: "Pembalik", type: "boolean", width: 8 },
      { key: "priceMismatch", header: "Beda harga", type: "boolean", width: 8 },
      { key: "lateSync", header: "Terlambat sinkron", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => ({ rows: await salesReport(ctx, range(ctx, f, 1), { tx }) }),
  });

  registerReport({
    key: "m6.voids",
    title: "Void per outlet per hari",
    module: "m6",
    permission: "m6.outlet.read",
    containsPii: false,
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "outletName", header: "Nama outlet", width: 24 },
      { key: "voidCount", header: "Jumlah void", type: "number", total: true, width: 10 },
      { key: "voidAmount", header: "Nilai void", type: "rupiah", total: true, width: 14 },
      { key: "pendingCount", header: "Menunggu persetujuan", type: "number", width: 12 },
      { key: "qrisVoidCount", header: "Void QRIS", type: "number", width: 10 },
      { key: "overLimit", header: "> PAR-03", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => ({ rows: await voidReport(ctx, range(ctx, f, 30), { tx }) }),
  });

  registerReport({
    key: "m6.usage_vs_sales",
    title: "Pemakaian bahan vs penjualan (rasio bahan per galon)",
    module: "m6",
    permission: "m6.outlet.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema.extend({ granularity: z.enum(["week", "month"]).optional() }),
    describeFilters: describe,
    columns: [
      { key: "period", header: "Periode", width: 10 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "productName", header: "Bahan", width: 22 },
      { key: "gallonsSold", header: "Galon terjual", type: "number", width: 10 },
      { key: "expectedUsage", header: "Pemakaian seharusnya", type: "number", width: 12 },
      { key: "opnameAdjustment", header: "Penyesuaian opname", type: "number", width: 12 },
      { key: "shiftDifference", header: "Selisih harian (info)", type: "number", width: 12 },
      { key: "effectiveUsage", header: "Pemakaian efektif", type: "number", width: 12 },
      { key: "ratioPerGallon", header: "Rasio per galon", type: "number", width: 10 },
    ],
    fetch: async (ctx, f: RangeFilters & { granularity?: "week" | "month" }, { tx }) => ({
      rows: await usageVsSalesReport(ctx, { ...range(ctx, f, 28), granularity: f.granularity ?? "week" }, { tx }),
    }),
  });

  registerReport({
    key: "m6.stock_card",
    title: "Kartu stok bahan per outlet",
    module: "m6",
    permission: "m6.outlet.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ from: dateOpt, to: dateOpt, outletId: z.uuid(), productId: z.uuid().optional() }),
    describeFilters: describe,
    columns: [
      { key: "occurredAt", header: "Waktu", type: "datetime", width: 16 },
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "productName", header: "Bahan", width: 22 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "stock_movement_kind", width: 16 },
      { key: "quantity", header: "Jumlah", type: "number", width: 10 },
      { key: "unitCost", header: "Harga pokok", type: "rupiah", width: 12 },
      { key: "balanceAfter", header: "Saldo", type: "number", width: 10 },
      { key: "note", header: "Catatan", width: 30 },
    ],
    fetch: async (ctx, f: { from?: string; to?: string; outletId: string; productId?: string }, { tx }) => {
      const r = range(ctx, f, 30);
      return { rows: (await stockCardReport(ctx, { outletId: f.outletId, productId: f.productId ?? null, from: r.from, to: r.to }, { tx })).rows };
    },
  });

  registerReport({
    key: "m6.stock_counts",
    title: "Opname bahan per outlet",
    module: "m6",
    permission: "m6.outlet.read",
    containsPii: false,
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "periodLabel", header: "Minggu", width: 10 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "productName", header: "Bahan", width: 22 },
      { key: "systemQtyAtCount", header: "Saldo sistem", type: "number", width: 10 },
      { key: "physicalQty", header: "Fisik", type: "number", width: 10 },
      { key: "differenceQty", header: "Selisih", type: "number", width: 10 },
      { key: "differenceValue", header: "Nilai selisih", type: "rupiah", total: true, width: 12 },
      { key: "reason", header: "Alasan", type: "enum", enumName: "stock_adjust_reason", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "stock_count_status", width: 16 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => ({ rows: await stockCountReport(ctx, range(ctx, f, 60), { tx }) }),
  });

  registerReport({
    key: "m6.water_supply",
    title: "Penerimaan pasokan air depot",
    module: "m6",
    permission: "m6.outlet.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "source", header: "Sumber", type: "enum", enumName: "water_supply_source", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "water_supply_status", width: 18 },
      { key: "deliveredVolumeL", header: "Diserahkan sopir (L)", type: "liter", total: true, width: 14 },
      { key: "receivedVolumeL", header: "Diterima (L)", type: "liter", total: true, width: 12 },
      { key: "differenceL", header: "Selisih (L)", type: "liter", total: true, width: 10 },
      { key: "differenceReason", header: "Alasan selisih", width: 22 },
      { key: "otherSourceReason", header: "Alasan sumber lain", width: 22 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => ({ rows: await waterSupplyReport(ctx, range(ctx, f, 30), { tx }) }),
  });

  registerReport({
    key: "m6.water_balance",
    title: "Neraca air outlet depot",
    module: "m6",
    permission: "m6.outlet.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "outletName", header: "Outlet", width: 24 },
      { key: "from", header: "Dari", type: "date", width: 12 },
      { key: "to", header: "Sampai", type: "date", width: 12 },
      { key: "openingL", header: "Stok awal (L)", type: "liter", width: 12 },
      { key: "receivedL", header: "Air diterima (L)", type: "liter", width: 12 },
      { key: "soldL", header: "Galon terjual × ukuran (L)", type: "liter", width: 16 },
      { key: "adjustmentL", header: "Penyesuaian (L)", type: "liter", width: 12 },
      { key: "closingL", header: "Stok akhir (L)", type: "liter", width: 12 },
      { key: "excessPct", header: "Kelebihan (%)", type: "percent", width: 10 },
      { key: "tolerancePct", header: "Toleransi PAR-59 (%)", type: "percent", width: 10 },
      { key: "exceeded", header: "Ditandai", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => ({ rows: await waterBalanceReport(ctx, range(ctx, f, 7), { tx }) }),
  });
}
