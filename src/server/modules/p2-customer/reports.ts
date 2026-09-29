/**
 * P2 — laporan yang dapat diekspor Excel/PDF (NFR-23; setiap daftar kantor modul P2): pesanan aplikasi, keluhan &
 * laporan bulanan per jenis/truk (US-P2-06 KP-3), penilaian per truk/sopir & komentar (US-P2-06 KP-1), pembayaran
 * digital (US-P2-04 KP-3), biaya pesan WhatsApp (US-P2-08 KP-3, NFR-29), akun aplikasi (US-P2-01).
 */
import "server-only";

import { z } from "zod";

import { formatTanggal, isBusinessDate } from "@/lib/time";

import { registerReport } from "@/server/core/export";

import { listAccounts } from "./service/accounts";
import { complaintReport, listComplaints, ratingOverview } from "./service/feedback";
import { listAppOrders } from "./service/orders";
import { listPaymentIntents } from "./service/payments";
import { waCostSummary } from "./service/wa-cloud";

const monthSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, { error: "Bulan harus YYYY-MM." }).optional() });
type MonthFilters = z.infer<typeof monthSchema>;
const describeMonth = (f: MonthFilters) => [`Bulan: ${f.month ?? "berjalan"}`];

const dateOpt = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).optional();

export function registerReports(): void {
  registerReport({
    key: "p2.app_orders",
    title: "Pesanan dari aplikasi pelanggan (konfirmasi PAR-75)",
    module: "p2",
    permission: "p2.app_order.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ from: dateOpt, to: dateOpt, view: z.enum(["pending", "all"]).optional() }),
    describeFilters: (f: { from?: string; to?: string; view?: string }) => [
      f.view === "pending" ? "Hanya yang menunggu konfirmasi" : "Semua pesanan aplikasi",
      ...(f.from || f.to ? [`Tanggal kirim ${f.from ? formatTanggal(f.from) : "…"} s.d. ${f.to ? formatTanggal(f.to) : "…"}`] : []),
    ],
    columns: [
      { key: "number", header: "No. pesanan", width: 14 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "requestedDate", header: "Tanggal kirim", type: "date", width: 12 },
      { key: "slot", header: "Slot", type: "enum", enumName: "delivery_slot", width: 8 },
      { key: "tankCount", header: "Tangki", type: "number", width: 8 },
      { key: "total", header: "Total", type: "rupiah", total: true, width: 14 },
      { key: "paymentPreference", header: "Cara bayar", type: "enum", enumName: "customer_payment_choice", width: 16 },
      { key: "status", header: "Status pesanan", type: "enum", enumName: "order_status", width: 14 },
      { key: "createdAt", header: "Diajukan", type: "datetime", width: 16 },
      { key: "confirmDueAt", header: "Tenggat konfirmasi", type: "datetime", width: 16 },
      { key: "confirmedAt", header: "Dikonfirmasi", type: "datetime", width: 16 },
      { key: "rejectReason", header: "Alasan tolak", width: 22 },
      { key: "possibleDuplicate", header: "Kemungkinan dobel", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, f: { from?: string; to?: string; view?: "pending" | "all" }, { tx }) => ({ rows: await listAppOrders(ctx, { view: f.view ?? "all", from: f.from, to: f.to }, { tx }) }),
  });

  registerReport({
    key: "p2.complaints",
    title: "Keluhan pelanggan",
    module: "p2",
    permission: "p2.complaint.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthSchema.extend({ box: z.enum(["dispatcher", "finance_admin", "all"]).optional(), status: z.string().optional() }),
    describeFilters: (f: MonthFilters & { box?: string }) => [...describeMonth(f), `Kotak: ${f.box === "finance_admin" ? "Tagihan" : f.box === "dispatcher" ? "Operasional" : "semua"}`],
    columns: [
      { key: "createdAt", header: "Diajukan", type: "datetime", width: 16 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "complaint_kind", width: 12 },
      { key: "box", header: "Kotak", type: "enum", enumName: "complaint_box", width: 16 },
      { key: "status", header: "Status", type: "enum", enumName: "complaint_status", width: 12 },
      { key: "orderNumber", header: "Pesanan", width: 14 },
      { key: "truck", header: "Truk", width: 12 },
      { key: "description", header: "Keluhan", width: 40 },
      { key: "dueAt", header: "Tenggat tanggapan", type: "datetime", width: 16 },
      { key: "firstResponseAt", header: "Tanggapan pertama", type: "datetime", width: 16 },
      { key: "resolvedAt", header: "Selesai", type: "datetime", width: 16 },
      { key: "overdue", header: "Lewat tenggat", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, f: MonthFilters & { box?: "dispatcher" | "finance_admin" | "all"; status?: string }, { tx }) => ({
      rows: await listComplaints(ctx, { box: f.box ?? "all", status: f.status ?? null, month: f.month ?? null }, { tx }),
    }),
  });

  registerReport({
    key: "p2.complaints_monthly",
    title: "Laporan bulanan keluhan per jenis & per truk",
    module: "p2",
    permission: "p2.adoption.read",
    containsPii: false,
    filtersSchema: monthSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "group", header: "Kelompok", width: 12 },
      { key: "name", header: "Jenis / truk", width: 28 },
      { key: "count", header: "Jumlah keluhan", type: "number", total: true, width: 12 },
      { key: "open", header: "Belum selesai", type: "number", width: 12 },
    ],
    fetch: async (ctx, f: MonthFilters, { tx }) => {
      const r = await complaintReport(ctx, { month: f.month ?? null }, { tx });
      return {
        rows: [
          ...r.byKind.map((k) => ({ group: "Per jenis", name: k.label, count: k.count, open: k.open })),
          ...r.byTruck.map((t) => ({ group: "Per truk", name: t.truck, count: t.count, open: null })),
        ],
        summary: [
          { label: "Total keluhan", value: r.total, type: "number" },
          { label: "Lewat tenggat tanggapan (PAR-75)", value: r.overdueFirstResponse, type: "number" },
          { label: "Rata-rata tanggapan pertama (jam)", value: r.avgFirstResponseHours ?? "—" },
        ],
      };
    },
  });

  registerReport({
    key: "p2.ratings",
    title: "Penilaian layanan per truk & sopir",
    module: "p2",
    permission: "p2.rating.read",
    containsPii: false,
    filtersSchema: monthSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "group", header: "Kelompok", width: 10 },
      { key: "label", header: "Truk / sopir", width: 26 },
      { key: "count", header: "Jumlah penilaian", type: "number", width: 12 },
      { key: "average", header: "Rata-rata (1–5)", type: "number", width: 12 },
      { key: "lowCount", header: "Nilai ≤ 2", type: "number", width: 10 },
    ],
    fetch: async (ctx, f: MonthFilters, { tx }) => {
      const r = await ratingOverview(ctx, { month: f.month ?? null }, { tx });
      return {
        rows: [...r.trucks.map((x) => ({ group: "Truk", ...x })), ...r.drivers.map((x) => ({ group: "Sopir", ...x }))],
        summary: [
          { label: "Jumlah penilaian", value: r.overall.count, type: "number" },
          { label: "Rata-rata keseluruhan", value: r.overall.average, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "p2.rating_comments",
    title: "Komentar penilaian pelanggan (pemilik & Dispatcher)",
    module: "p2",
    permission: "p2.rating.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "createdAt", header: "Waktu", type: "datetime", width: 16 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "tripNumber", header: "Pengiriman", width: 16 },
      { key: "truck", header: "Truk", width: 12 },
      { key: "driverName", header: "Sopir", width: 18 },
      { key: "rating", header: "Nilai", type: "number", width: 8 },
      { key: "comment", header: "Komentar", width: 40 },
    ],
    fetch: async (ctx, f: MonthFilters, { tx }) => ({ rows: (await ratingOverview(ctx, { month: f.month ?? null }, { tx })).comments }),
  });

  registerReport({
    key: "p2.payment_intents",
    title: "Pembayaran digital pelanggan (QRIS/VA)",
    module: "p2",
    permission: "p2.payment_intent.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ status: z.string().optional() }),
    columns: [
      { key: "createdAt", header: "Dibuat", type: "datetime", width: 16 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "target", header: "Untuk", width: 26 },
      { key: "method", header: "Metode", width: 12 },
      { key: "gatewayOrderId", header: "No. transaksi gerbang", width: 20 },
      { key: "amount", header: "Jumlah", type: "rupiah", total: true, width: 14 },
      { key: "gatewayFee", header: "Biaya gerbang", type: "rupiah", total: true, width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "payment_intent_status", width: 12 },
      { key: "succeededAt", header: "Berhasil", type: "datetime", width: 16 },
      { key: "settledAt", header: "Dicocokkan", type: "datetime", width: 16 },
    ],
    fetch: async (ctx, f: { status?: string }, { tx }) => ({ rows: await listPaymentIntents(ctx, { status: f.status ?? null }, { tx }) }),
  });

  registerReport({
    key: "p2.wa_costs",
    title: "Biaya pesan WhatsApp Business API per kategori",
    module: "p2",
    permission: "p2.wa_cost.read",
    containsPii: false,
    filtersSchema: monthSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "category", header: "Kategori Meta", width: 18 },
      { key: "count", header: "Pesan tertagih", type: "number", total: true, width: 14 },
      { key: "amount", header: "Biaya", type: "rupiah", total: true, width: 14 },
    ],
    fetch: async (ctx, f: MonthFilters, { tx }) => {
      const r = await waCostSummary(ctx, { month: f.month ?? null }, { tx });
      return { rows: r.byCategory, summary: [{ label: "Total biaya bulan ini", value: r.totalCost, type: "rupiah" }] };
    },
  });

  registerReport({
    key: "p2.customer_accounts",
    title: "Akun aplikasi pelanggan",
    module: "p2",
    permission: "p2.customer_account.read",
    containsPii: true,
    columns: [
      { key: "createdAt", header: "Terdaftar", type: "datetime", width: 16 },
      { key: "phone", header: "Nomor WA", pii: "phone", width: 16 },
      { key: "displayName", header: "Nama di aplikasi", width: 22 },
      { key: "status", header: "Status", type: "enum", enumName: "customer_account_status", width: 18 },
      { key: "customerCode", header: "Kode pelanggan", width: 12 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "consentAt", header: "Persetujuan UU PDP", type: "datetime", width: 16 },
      { key: "lastLoginAt", header: "Masuk terakhir", type: "datetime", width: 16 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listAccounts(ctx, {}, { tx }) }),
  });
}
