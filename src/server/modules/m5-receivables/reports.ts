/**
 * M5 — laporan Piutang yang dapat diekspor Excel/PDF (NFR-23, US-M9-03; `/api/export/<kunci>`). Laporan yang memuat
 * data pelanggan ditandai `containsPii` → ekspor hanya pemilik/Admin Keuangan dengan tujuan tercatat (BR-39,
 * US-M5-04 KP-4); peran lain menerima versi tanpa kontak.
 */
import "server-only";

import { z } from "zod";

import { label } from "@/lib/labels";
import { formatTanggal } from "@/lib/time";

import { registerReport } from "@/server/core/export";

import { agingReport, customerStatement } from "./service/aging";
import { creditEligibleCustomers, creditStatusBoard } from "./service/credit-hold";
import { listInvoices } from "./service/invoices";
import { monthlyBoard } from "./service/monthly";
import { openingBoard } from "./service/opening";
import { listAdvances, listPayments } from "./service/payments";
import { listReminders, reminderKindLabel } from "./service/reminders";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const uuid = z.string().uuid().optional();

export function registerReports(): void {
  registerReport({
    key: "m5.invoices",
    title: "Daftar faktur piutang",
    module: "m5",
    permission: "m5.invoice.export",
    containsPii: true,
    orientation: "landscape",
    filtersSchema: z.object({ status: z.string().optional(), kind: z.string().optional(), customerId: uuid, from: date, to: date, overdue: z.string().optional() }),
    describeFilters: (f) => [f.status ? `Status: ${f.status === "unpaid" ? "Belum lunas" : label("invoice_status", f.status)}` : "", f.kind ? `Jenis: ${label("invoice_kind", f.kind)}` : "", f.from ? `Dari ${f.from}` : "", f.to ? `Sampai ${f.to}` : "", f.overdue ? "Hanya lewat tempo" : ""].filter(Boolean),
    columns: [
      { key: "number", header: "Nomor" },
      { key: "kind", header: "Jenis", type: "enum", enumName: "invoice_kind" },
      { key: "customerName", header: "Pelanggan", width: 24 },
      { key: "issueDate", header: "Tanggal", type: "date" },
      { key: "dueDate", header: "Jatuh tempo", type: "date" },
      { key: "amount", header: "Nilai", type: "rupiah", total: true },
      { key: "paidAmount", header: "Dibayar", type: "rupiah", total: true },
      { key: "creditedAmount", header: "Nota kredit", type: "rupiah", total: true },
      { key: "outstandingAmount", header: "Sisa", type: "rupiah", total: true },
      { key: "status", header: "Status", type: "enum", enumName: "invoice_status" },
      { key: "bucket", header: "Umur", type: "enum", enumName: "aging_bucket" },
      { key: "disputeStatus", header: "Sengketa", type: "enum", enumName: "dispute_status" },
    ],
    fetch: async (ctx, f, { tx }) => {
      const rows = await listInvoices(
        ctx,
        { status: (f.status as never) ?? null, kind: (f.kind as never) ?? null, customerId: f.customerId ?? null, from: f.from ?? null, to: f.to ?? null, overdue: f.overdue === "1", limit: 5000 },
        { tx },
      );
      return { rows };
    },
  });

  registerReport({
    key: "m5.aging",
    title: "Umur piutang per pelanggan",
    module: "m5",
    permission: "m5.aging.export",
    containsPii: true,
    orientation: "landscape",
    filtersSchema: z.object({ asOf: date, segment: z.string().optional(), line: z.string().optional() }),
    describeFilters: (f) => [f.asOf ? `Posisi ${formatTanggal(f.asOf, { weekday: false })}` : "Posisi hari ini", f.segment ? `Segmen ${label("customer_segment", f.segment)}` : "", f.line ? `Lini ${label("receivable_line", f.line)}` : ""].filter(Boolean),
    columns: [
      { key: "code", header: "Kode" },
      { key: "name", header: "Pelanggan", width: 26 },
      { key: "segment", header: "Segmen", type: "enum", enumName: "customer_segment" },
      { key: "creditStatus", header: "Status kredit", type: "enum", enumName: "credit_status" },
      { key: "inTransition", header: "Masa transisi", type: "boolean" },
      { key: "not_due", header: "Belum jatuh tempo", type: "rupiah", total: true },
      { key: "d1_7", header: "1–7 hari", type: "rupiah", total: true },
      { key: "d8_30", header: "8–30 hari", type: "rupiah", total: true },
      { key: "over_30", header: "> 30 hari", type: "rupiah", total: true },
      { key: "unbilled", header: "Belum ditagih", type: "rupiah", total: true },
      { key: "total", header: "Total", type: "rupiah", total: true },
    ],
    fetch: async (ctx, f, { tx }) => {
      const r = await agingReport(ctx, { asOf: f.asOf ?? null, segment: (f.segment as never) ?? null, line: (f.line as never) ?? null }, { tx });
      return {
        rows: r.customers,
        summary: [
          { label: "Total piutang", value: r.totals.total, type: "rupiah" as const },
          { label: "Lewat tempo", value: r.totals.overdue, type: "rupiah" as const },
          { label: "% lewat tempo (KPI-04)", value: `${r.totals.overduePct.toLocaleString("id-ID")}%` },
          ...r.byLine.map((g) => ({ label: `Lini ${g.label}`, value: g.total, type: "rupiah" as const })),
          ...r.bySegment.map((g) => ({ label: `Segmen ${g.label}`, value: g.total, type: "rupiah" as const })),
        ],
      };
    },
  });

  registerReport({
    key: "m5.aging_groups",
    title: "Umur piutang per segmen & lini",
    module: "m5",
    permission: "m5.aging.read",
    containsPii: false,
    filtersSchema: z.object({ asOf: date }),
    columns: [
      { key: "group", header: "Kelompok" },
      { key: "label", header: "Nama", width: 22 },
      { key: "not_due", header: "Belum jatuh tempo", type: "rupiah" },
      { key: "d1_7", header: "1–7 hari", type: "rupiah" },
      { key: "d8_30", header: "8–30 hari", type: "rupiah" },
      { key: "over_30", header: "> 30 hari", type: "rupiah" },
      { key: "unbilled", header: "Belum ditagih", type: "rupiah" },
      { key: "total", header: "Total", type: "rupiah" },
    ],
    fetch: async (ctx, f, { tx }) => {
      const r = await agingReport(ctx, { asOf: f.asOf ?? null }, { tx });
      return {
        rows: [...r.byLine.map((g) => ({ ...g, group: "Lini" })), ...r.bySegment.map((g) => ({ ...g, group: "Segmen" }))],
        summary: [
          { label: "Total piutang", value: r.totals.total, type: "rupiah" as const },
          { label: "% lewat tempo (KPI-04)", value: `${r.totals.overduePct.toLocaleString("id-ID")}%` },
        ],
      };
    },
  });

  registerReport({
    key: "m5.customer_card",
    title: "Kartu piutang pelanggan",
    module: "m5",
    permission: "m5.aging.export",
    containsPii: true,
    filtersSchema: z.object({ customerId: z.string().uuid({ error: "Pilih pelanggan." }), from: date, to: date }),
    describeFilters: (f) => [f.from ? `Dari ${formatTanggal(f.from, { weekday: false })}` : "", f.to ? `Sampai ${formatTanggal(f.to, { weekday: false })}` : ""].filter(Boolean),
    columns: [
      { key: "date", header: "Tanggal", type: "date" },
      { key: "kind", header: "Jenis", type: "enum", enumName: "statement_entry" },
      { key: "reference", header: "Nomor" },
      { key: "description", header: "Uraian", width: 36 },
      { key: "debit", header: "Tagihan", type: "rupiah", total: true },
      { key: "credit", header: "Pembayaran/kredit", type: "rupiah", total: true },
      { key: "balance", header: "Saldo", type: "rupiah" },
    ],
    fetch: async (ctx, f, { tx }) => {
      const st = await customerStatement(ctx, f.customerId, { from: f.from ?? null, to: f.to ?? null }, { tx });
      return {
        rows: [{ date: st.from, kind: "opening", reference: "", description: "Saldo sebelumnya", debit: 0, credit: 0, balance: st.openingBalance }, ...st.entries],
        summary: [
          { label: "Pelanggan", value: `${st.customer.name}${st.customer.code ? ` (${st.customer.code})` : ""}` },
          { label: "Saldo akhir", value: st.closingBalance, type: "rupiah" as const },
          { label: "Belum ditagih", value: st.unbilled, type: "rupiah" as const },
          { label: "Uang muka tersisa", value: st.openAdvance, type: "rupiah" as const },
        ],
      };
    },
  });

  registerReport({
    key: "m5.payments",
    title: "Pelunasan piutang",
    module: "m5",
    permission: "m5.customer_payment.read",
    containsPii: true,
    orientation: "landscape",
    filtersSchema: z.object({ customerId: uuid, from: date, to: date, channel: z.string().optional() }),
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date" },
      { key: "customerName", header: "Pelanggan", width: 24 },
      { key: "channel", header: "Kanal", type: "enum", enumName: "payment_channel" },
      { key: "method", header: "Cara", type: "enum", enumName: "payment_method" },
      { key: "amount", header: "Jumlah", type: "rupiah", total: true },
      { key: "advanceAmount", header: "Uang muka", type: "rupiah", total: true },
      { key: "invoices", header: "Faktur", width: 30, value: (r: { allocations: { number: string; amount: number }[] }) => r.allocations.map((a) => a.number).join(", ") },
      { key: "reversed", header: "Dibalik", type: "boolean" },
    ],
    fetch: async (ctx, f, { tx }) => ({ rows: await listPayments(ctx, { customerId: f.customerId ?? null, from: f.from ?? null, to: f.to ?? null, channel: (f.channel as never) ?? null, limit: 5000 }, { tx }) }),
  });

  registerReport({
    key: "m5.advances",
    title: "Uang muka pelanggan",
    module: "m5",
    permission: "m5.customer_payment.read",
    containsPii: false,
    columns: [
      { key: "customerName", header: "Pelanggan", width: 24 },
      { key: "createdAt", header: "Dibuat", type: "datetime" },
      { key: "amount", header: "Jumlah", type: "rupiah", total: true },
      { key: "remainingAmount", header: "Sisa", type: "rupiah", total: true },
      { key: "status", header: "Status", type: "enum", enumName: "advance_status" },
      { key: "notes", header: "Keterangan", width: 30 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listAdvances(ctx, {}, { tx }) }),
  });

  registerReport({
    key: "m5.reminders",
    title: "Daftar pengingat jatuh tempo",
    module: "m5",
    permission: "m5.reminder.read",
    containsPii: true,
    filtersSchema: z.object({ date }),
    columns: [
      { key: "kindLabel", header: "Jenis" },
      { key: "customerName", header: "Pelanggan", width: 24 },
      { key: "waPhone", header: "WA", pii: "phone" },
      { key: "invoiceNumbers", header: "Faktur", width: 26, value: (r: { invoices: { number: string }[] }) => r.invoices.map((i) => i.number).join(", ") },
      { key: "total", header: "Total sisa", type: "rupiah", total: true },
      { key: "status", header: "Status", type: "enum", enumName: "reminder_status" },
    ],
    fetch: async (ctx, f, { tx }) => {
      const list = await listReminders(ctx, { date: f.date ?? null }, { tx });
      return { rows: list.groups.map((g) => ({ ...g, kindLabel: reminderKindLabel(g.kind, list) })) };
    },
  });

  registerReport({
    key: "m5.monthly_invoices",
    title: "Faktur bulanan",
    module: "m5",
    permission: "m5.monthly_invoice.read",
    containsPii: false,
    columns: [
      { key: "number", header: "Nomor" },
      { key: "customerName", header: "Pelanggan", width: 24 },
      { key: "periodMonth", header: "Bulan layanan", type: "date" },
      { key: "issueDate", header: "Terbit", type: "date" },
      { key: "dueDate", header: "Jatuh tempo", type: "date" },
      { key: "amount", header: "Nilai", type: "rupiah", total: true },
      { key: "outstandingAmount", header: "Sisa", type: "rupiah", total: true },
      { key: "sentAt", header: "Dikirim", type: "datetime" },
      { key: "sentVia", header: "Lewat" },
    ],
    fetch: async (ctx, _f, { tx }) => {
      const b = await monthlyBoard(ctx, { tx });
      return { rows: [...b.ready, ...b.sent] };
    },
  });

  registerReport({
    key: "m5.unbilled",
    title: "Rit belum ditagih (pelanggan tagihan bulanan)",
    module: "m5",
    permission: "m5.monthly_invoice.read",
    containsPii: false,
    columns: [
      { key: "customerName", header: "Pelanggan", width: 24 },
      { key: "n", header: "Jumlah rit", type: "number", total: true },
      { key: "first", header: "Layanan pertama", type: "date" },
      { key: "late", header: "Susulan", type: "number" },
      { key: "total", header: "Nilai", type: "rupiah", total: true },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await monthlyBoard(ctx, { tx })).unbilled }),
  });

  registerReport({
    key: "m5.credit_status",
    title: "Status kredit: Ditahan, akan Ditahan, masa transisi",
    module: "m5",
    permission: "m5.credit_exposure.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "group", header: "Kelompok" },
      { key: "code", header: "Kode" },
      { key: "name", header: "Pelanggan", width: 24 },
      { key: "creditStatus", header: "Status", type: "enum", enumName: "credit_status" },
      { key: "overdueTotal", header: "Lewat tempo", type: "rupiah", total: true },
      { key: "worstDaysPastDue", header: "Hari terlama", type: "number" },
      { key: "holdDeferralUntil", header: "Masa transisi s.d.", type: "date" },
      { key: "lastReason", header: "Alasan terakhir", width: 30 },
    ],
    fetch: async (ctx, _f, { tx }) => {
      const b = await creditStatusBoard(ctx, { tx });
      return {
        rows: [...b.onHold.map((r) => ({ ...r, group: "Ditahan" })), ...b.willHold.map((r) => ({ ...r, group: "Akan Ditahan" })), ...b.transition.map((r) => ({ ...r, group: "Masa transisi" }))],
      };
    },
  });

  registerReport({
    key: "m5.credit_eligible",
    title: "Pelanggan layak diajukan Tempo",
    module: "m5",
    permission: "m5.credit_exposure.read",
    containsPii: false,
    columns: [
      { key: "code", header: "Kode" },
      { key: "name", header: "Pelanggan", width: 26 },
      { key: "segment", header: "Segmen", type: "enum", enumName: "customer_segment" },
      { key: "completedOrders", header: "Pesanan Selesai", type: "number", value: (r: { eligibility: { metrics: { completedOrders: number } } }) => r.eligibility.metrics.completedOrders },
      { key: "firstCompleted", header: "Selesai pertama", type: "date", value: (r: { eligibility: { metrics: { firstCompletedDate: string | null } } }) => r.eligibility.metrics.firstCompletedDate },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await creditEligibleCustomers(ctx, { tx }) }),
  });

  registerReport({
    key: "m5.opening_balances",
    title: "Saldo awal piutang",
    module: "m5",
    permission: "m5.opening_balance.read",
    containsPii: false,
    columns: [
      { key: "number", header: "Nomor" },
      { key: "customerName", header: "Pelanggan", width: 24 },
      { key: "lineLabel", header: "Lini" },
      { key: "issueDate", header: "Tanggal", type: "date" },
      { key: "dueDate", header: "Jatuh tempo", type: "date" },
      { key: "description", header: "Keterangan", width: 26 },
      { key: "amount", header: "Nilai", type: "rupiah", total: true },
      { key: "creditedAmount", header: "Koreksi", type: "rupiah", total: true },
      { key: "outstandingAmount", header: "Sisa", type: "rupiah", total: true },
    ],
    fetch: async (ctx, _f, { tx }) => {
      const b = await openingBoard(ctx, { tx });
      return {
        rows: b.summary.invoices.map((i) => ({ ...i, lineLabel: label("receivable_line", i.openingLine ?? "truck") })),
        status: b.signoff ? label("signoff_status", b.signoff.status) : "Belum ada",
        summary: [{ label: "Total saldo awal", value: b.summary.total, type: "rupiah" as const }],
      };
    },
  });
}
