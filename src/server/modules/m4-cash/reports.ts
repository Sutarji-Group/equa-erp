/**
 * M4 — laporan kas yang dapat diekspor Excel/PDF (NFR-23, US-M9-03; `/api/export/<kunci>?format=xlsx|pdf&…`).
 * Semua berlingkup tenant pelaku; tanpa data pribadi pelanggan (nama karyawan bukan PII pelanggan, BR-39).
 */
import "server-only";

import { z } from "zod";

import { label } from "@/lib/labels";
import { addDays, formatTanggal, isBusinessDate, monthOf } from "@/lib/time";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { registerReport } from "@/server/core/export";

import { listCashDays } from "./service/cash-day";
import { listDeposits } from "./service/deposits";
import { discrepancyHistory, listDiscrepancies } from "./service/discrepancies";
import { getOfficeCash, listOfficeCashMovements } from "./service/office-cash";
import { getPettyCash } from "./service/petty-cash";
import { getCashPosition } from "./service/position";
import { listRestitutions, restitutionMonthlyRecap } from "./service/restitutions";
import { dailyMatchingResults, listIncomingTransfers, listStatementLines } from "./service/transfers";

const dateOpt = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).optional();
const rangeSchema = z.object({ from: dateOpt, to: dateOpt });
type Range = z.infer<typeof rangeSchema>;
const monthSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, { error: "Bulan harus YYYY-MM." }).optional() });

function range(ctx: ActorContext, f: Range, days = 30) {
  const to = f.to ?? ctxBusinessDate(ctx);
  return { from: f.from ?? addDays(to, -(days - 1)), to };
}

function describe(f: Range): string[] {
  return f.from || f.to ? [`Periode: ${f.from ? formatTanggal(f.from) : "…"} s.d. ${f.to ? formatTanggal(f.to) : "…"}`] : [];
}

export function registerReports(): void {
  registerReport({
    key: "m4.cash_position",
    title: "Kas hari ini per sumber (seharusnya, diterima, selisih)",
    module: "m4",
    permission: "m4.cash_position.export",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ date: dateOpt }),
    describeFilters: (f: { date?: string }) => (f.date ? [`Tanggal: ${formatTanggal(f.date)}`] : []),
    columns: [
      { key: "lineLabel", header: "Lini", width: 14 },
      { key: "label", header: "Sumber", width: 28 },
      { key: "detail", header: "Keterangan", width: 26 },
      { key: "expected", header: "Seharusnya", type: "rupiah", total: true, width: 14 },
      { key: "statusText", header: "Status setoran", width: 16 },
      { key: "received", header: "Diterima", type: "rupiah", total: true, width: 14 },
      { key: "discrepancy", header: "Selisih", type: "rupiah", total: true, width: 12 },
      { key: "reason", header: "Alasan", width: 24 },
      { key: "unmatchedTransfers", header: "Transfer belum dicocokkan", type: "rupiah", total: true, width: 14 },
      { key: "qris", header: "QRIS", type: "rupiah", total: true, width: 12 },
      { key: "flagText", header: "Sorotan", width: 30 },
    ],
    fetch: async (ctx, f: { date?: string }, { tx }) => {
      const p = await getCashPosition(ctx, { date: f.date ?? null }, { tx });
      const lineLabel = Object.fromEntries(p.totals.map((t) => [t.line, t.label]));
      return {
        rows: p.rows.map((r) => ({ ...r, lineLabel: lineLabel[r.line], flagText: r.flags.map((x) => x.text).join("; ") })),
        summary: [
          { label: "Tanggal", value: formatTanggal(p.date) },
          { label: "Seharusnya (semua sumber)", value: p.overall.expected, type: "rupiah" },
          { label: "Diterima", value: p.overall.received, type: "rupiah" },
          { label: "Selisih", value: p.overall.discrepancy, type: "rupiah" },
          { label: "Kas kantor (sistem)", value: p.office.closing, type: "rupiah" },
        ],
        status: p.cashDayStatus === "closed" ? "Kas ditutup" : "Kas belum ditutup",
      };
    },
  });

  registerReport({
    key: "m4.deposits",
    title: "Setoran sopir, depot & toko",
    module: "m4",
    permission: "m4.deposit.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "number", header: "Nomor", width: 13 },
      { key: "sourceType", header: "Sumber", type: "enum", enumName: "deposit_source_type", width: 12 },
      { key: "sourceLabel", header: "Penyetor", width: 26 },
      { key: "method", header: "Cara setor", type: "enum", enumName: "deposit_method", width: 14 },
      { key: "status", header: "Status", type: "enum", enumName: "deposit_status", width: 10 },
      { key: "expectedNet", header: "Seharusnya", type: "rupiah", total: true, width: 13 },
      { key: "receivedAmount", header: "Diterima", type: "rupiah", total: true, width: 13 },
      { key: "discrepancyAmount", header: "Selisih", type: "rupiah", total: true, width: 12 },
      { key: "discrepancyReason", header: "Alasan", type: "enum", enumName: "discrepancy_reason", width: 18 },
      { key: "receivedAt", header: "Diterima pada", type: "datetime", width: 16 },
      { key: "receivedLate", header: "Terlambat", type: "boolean", width: 9 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await listDeposits(ctx, range(ctx, f, 7), { tx }) }),
  });

  registerReport({
    key: "m4.discrepancies",
    title: "Selisih setoran & kas (umur, keputusan)",
    module: "m4",
    permission: "m4.discrepancy.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema.extend({ view: z.enum(["open", "all"]).optional() }),
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "sourceLabel", header: "Sumber", width: 28 },
      { key: "amount", header: "Selisih", type: "rupiah", total: true, width: 12 },
      { key: "reason", header: "Alasan", type: "enum", enumName: "discrepancy_reason", width: 20 },
      { key: "reasonNote", header: "Keterangan", width: 24 },
      { key: "status", header: "Status", type: "enum", enumName: "discrepancy_status", width: 14 },
      { key: "decision", header: "Keputusan", type: "enum", enumName: "discrepancy_decision", width: 11 },
      { key: "ageHours", header: "Umur (jam)", type: "number", width: 9 },
      { key: "overdue", header: "> batas tindak lanjut", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, f: Range & { view?: "open" | "all" }, { tx }) => {
      const r = range(ctx, f, 30);
      const res = await listDiscrepancies(ctx, { view: f.view ?? "all", from: r.from, to: r.to }, { tx });
      return { rows: res.rows, summary: [{ label: "Lewat batas tindak lanjut (KPI-03)", value: res.overdueCount, type: "number" }] };
    },
  });

  registerReport({
    key: "m4.discrepancy_history",
    title: "Riwayat selisih per sopir/operator per bulan",
    module: "m4",
    permission: "m4.discrepancy.read",
    containsPii: false,
    filtersSchema: z.object({ months: z.coerce.number().int().min(1).max(24).optional() }),
    columns: [
      { key: "month", header: "Bulan", width: 9 },
      { key: "employeeName", header: "Karyawan", width: 24 },
      { key: "count", header: "Jumlah kejadian", type: "number", total: true, width: 10 },
      { key: "shortage", header: "Kurang", type: "rupiah", total: true, width: 13 },
      { key: "surplus", header: "Lebih", type: "rupiah", total: true, width: 13 },
      { key: "reasonText", header: "Alasan", width: 36 },
    ],
    fetch: async (ctx, f: { months?: number }, { tx }) => {
      const res = await discrepancyHistory(ctx, { months: f.months ?? 6 }, { tx });
      return {
        rows: res.rows.map((r) => ({ ...r, reasonText: Object.entries(r.reasons).map(([k, n]) => `${label("discrepancy_reason", k)} ×${n}`).join("; ") })),
        summary: res.streaks.map((s) => ({ label: `${s.employeeName} — hari tanpa selisih`, value: s.daysWithoutDiscrepancy, type: "number" as const })),
      };
    },
  });

  registerReport({
    key: "m4.incoming_transfers",
    title: "Transfer masuk & status pencocokan",
    module: "m4",
    permission: "m4.incoming_transfer.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema.extend({ status: z.enum(["open", "all", "unmatched", "matched", "not_found", "cancelled"]).optional() }),
    describeFilters: describe,
    columns: [
      { key: "transferDate", header: "Tanggal", type: "date", width: 11 },
      { key: "sourceKind", header: "Asal", type: "enum", enumName: "transfer_source_kind", width: 18 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "sourceUserName", header: "Pencatat", width: 18 },
      { key: "outletLabel", header: "Outlet", width: 18 },
      { key: "amount", header: "Jumlah", type: "rupiah", total: true, width: 13 },
      { key: "status", header: "Status", type: "enum", enumName: "incoming_transfer_status", width: 14 },
      { key: "matchRefDate", header: "Tgl mutasi", type: "date", width: 11 },
      { key: "matchRefNote", header: "Keterangan mutasi", width: 24 },
      { key: "ageDays", header: "Umur (hari)", type: "number", width: 8 },
    ],
    fetch: async (ctx, f: Range & { status?: "open" | "all" | "unmatched" | "matched" | "not_found" | "cancelled" }, { tx }) => ({
      rows: await listIncomingTransfers(ctx, { status: f.status ?? "all", from: f.from ?? null, to: f.to ?? null }, { tx }),
    }),
  });

  registerReport({
    key: "m4.statement_lines",
    title: "Mutasi bank tanpa pasangan (daftar tindak lanjut)",
    module: "m4",
    permission: "m4.incoming_transfer.read",
    containsPii: false,
    filtersSchema: z.object({ status: z.enum(["open", "all", "unmatched", "follow_up", "ignored", "matched"]).optional() }),
    columns: [
      { key: "lineDate", header: "Tanggal", type: "date", width: 11 },
      { key: "bankLabel", header: "Rekening", width: 20 },
      { key: "description", header: "Keterangan", width: 34 },
      { key: "amount", header: "Jumlah", type: "rupiah", total: true, width: 13 },
      { key: "status", header: "Status", type: "enum", enumName: "bank_statement_line_status", width: 14 },
      { key: "followUpNote", header: "Catatan", width: 24 },
    ],
    fetch: async (ctx, f: { status?: "open" | "all" | "unmatched" | "follow_up" | "ignored" | "matched" }, { tx }) => ({ rows: await listStatementLines(ctx, { status: f.status ?? "open" }, { tx }) }),
  });

  registerReport({
    key: "m4.daily_matching",
    title: "Hasil pencocokan transfer harian (masukan rekonsiliasi bank M11)",
    module: "m4",
    permission: "m4.incoming_transfer.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "matchedOn", header: "Dicocokkan", type: "date", width: 11 },
      { key: "transferDate", header: "Tgl transfer", type: "date", width: 11 },
      { key: "sourceKind", header: "Asal", type: "enum", enumName: "transfer_source_kind", width: 18 },
      { key: "bank", header: "Rekening", width: 20 },
      { key: "amount", header: "Jumlah", type: "rupiah", total: true, width: 13 },
      { key: "status", header: "Status", type: "enum", enumName: "incoming_transfer_status", width: 14 },
      { key: "matchRefDate", header: "Tgl mutasi", type: "date", width: 11 },
      { key: "matchRefNote", header: "Keterangan mutasi", width: 26 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await dailyMatchingResults(ctx, range(ctx, f, 1), { tx }) }),
  });

  registerReport({
    key: "m4.office_cash",
    title: "Mutasi kas kantor",
    module: "m4",
    permission: "m4.office_cash.read",
    containsPii: false,
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "kindLabel", header: "Jenis", width: 22 },
      { key: "direction", header: "Arah", type: "enum", enumName: "cash_direction", width: 8 },
      { key: "amount", header: "Jumlah", type: "rupiah", width: 13 },
      { key: "balanceAfter", header: "Saldo", type: "rupiah", width: 14 },
      { key: "description", header: "Uraian", width: 34 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await listOfficeCashMovements(ctx, range(ctx, f, 7), { tx }) }),
  });

  registerReport({
    key: "m4.bank_deposits",
    title: "Setor kas kantor ke bank",
    module: "m4",
    permission: "m4.office_cash.read",
    containsPii: false,
    filtersSchema: z.object({ date: dateOpt }),
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "bankLabel", header: "Rekening", width: 24 },
      { key: "amount", header: "Jumlah", type: "rupiah", total: true, width: 13 },
      { key: "status", header: "Status", type: "enum", enumName: "bank_deposit_status", width: 11 },
      { key: "notes", header: "Catatan", width: 26 },
    ],
    fetch: async (ctx, f: { date?: string }, { tx }) => ({ rows: (await getOfficeCash(ctx, { date: f.date ?? null }, { tx })).bankDeposits }),
  });

  registerReport({
    key: "m4.petty_cash",
    title: "Kas kecil (pengisian & pengeluaran)",
    module: "m4",
    permission: "m4.petty_cash.read",
    containsPii: false,
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "petty_cash_kind", width: 11 },
      { key: "category", header: "Kategori", type: "enum", enumName: "petty_cash_category", width: 20 },
      { key: "profitCenter", header: "Pusat laba", type: "enum", enumName: "profit_center", width: 16 },
      { key: "amount", header: "Jumlah", type: "rupiah", width: 13 },
      { key: "status", header: "Status", type: "enum", enumName: "petty_cash_status", width: 14 },
      { key: "description", header: "Uraian", width: 30 },
    ],
    fetch: async (ctx, f: Range, { tx }) => {
      const r = range(ctx, f, 30);
      const res = await getPettyCash(ctx, r, { tx });
      return { rows: res.rows, summary: [{ label: "Saldo kas kecil", value: res.balance, type: "rupiah" }] };
    },
  });

  registerReport({
    key: "m4.cash_days",
    title: "Riwayat tutup kas harian (KPI-02)",
    module: "m4",
    permission: "m4.cash_day.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "status", header: "Status", type: "enum", enumName: "cash_day_status", width: 10 },
      { key: "lastDepositReceivedAt", header: "Setoran terakhir diterima", type: "datetime", width: 17 },
      { key: "closeStartedAt", header: "Mulai tutup kas", type: "datetime", width: 17 },
      { key: "closedAt", header: "Kas ditutup", type: "datetime", width: 17 },
      { key: "kpi02Minutes", header: "KPI-02 (menit)", type: "number", width: 10 },
      { key: "closedLate", header: "Terlambat", type: "boolean", width: 9 },
      { key: "officeCashSystem", header: "Kas kantor sistem", type: "rupiah", width: 14 },
      { key: "officeCashPhysical", header: "Hitung fisik", type: "rupiah", width: 14 },
      { key: "officeCashDifference", header: "Selisih", type: "rupiah", width: 12 },
      { key: "closedByName", header: "Ditutup oleh", width: 18 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await listCashDays(ctx, range(ctx, f, 30), { tx }) }),
  });

  registerReport({
    key: "m4.restitutions",
    title: "Ganti rugi karyawan (per kejadian)",
    module: "m4",
    permission: "m4.restitution.read",
    containsPii: false,
    filtersSchema: z.object({ view: z.enum(["open", "all"]).optional() }),
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "employeeNo", header: "No. karyawan", width: 11 },
      { key: "employeeName", header: "Karyawan", width: 22 },
      { key: "amount", header: "Ganti rugi", type: "rupiah", total: true, width: 13 },
      { key: "settledAmount", header: "Dilunasi", type: "rupiah", total: true, width: 13 },
      { key: "outstanding", header: "Sisa", type: "rupiah", total: true, width: 13 },
      { key: "status", header: "Status", type: "enum", enumName: "restitution_status", width: 14 },
      { key: "reason", header: "Kejadian", width: 34 },
    ],
    fetch: async (ctx, f: { view?: "open" | "all" }, { tx }) => ({ rows: await listRestitutions(ctx, { view: f.view ?? "all" }, { tx }) }),
  });

  registerReport({
    key: "m4.restitution_recap",
    title: "Rekap bulanan ganti rugi per karyawan (untuk penggajian)",
    module: "m4",
    permission: "m4.restitution.export",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthSchema,
    describeFilters: (f: { month?: string }) => (f.month ? [`Bulan: ${f.month}`] : []),
    columns: [
      { key: "month", header: "Bulan", width: 9 },
      { key: "employeeNo", header: "No. karyawan", width: 11 },
      { key: "employeeName", header: "Karyawan", width: 22 },
      { key: "incidents", header: "Kejadian", type: "number", total: true, width: 9 },
      { key: "recorded", header: "Ganti rugi bulan ini", type: "rupiah", total: true, width: 14 },
      { key: "settledCash", header: "Dilunasi tunai", type: "rupiah", total: true, width: 13 },
      { key: "settledPayroll", header: "Potongan penggajian", type: "rupiah", total: true, width: 14 },
      { key: "outstandingEndOfMonth", header: "Sisa akhir bulan", type: "rupiah", total: true, width: 14 },
      { key: "details", header: "Rincian", width: 36 },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => ({
      rows: await restitutionMonthlyRecap(ctx, { month: f.month ?? monthOf(ctxBusinessDate(ctx)) }, { tx }),
      status: "Sistem tidak memotong gaji (BR-11c) — rekap untuk penggajian",
    }),
  });
}
