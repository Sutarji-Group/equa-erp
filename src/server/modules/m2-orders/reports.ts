/**
 * M2 — laporan yang dapat diekspor Excel/PDF (NFR-23, US-M9-03): setiap daftar/laporan yang disebut PRD M2.
 *
 * - `m2.orders`                 daftar pesanan tersaring (US-M2-02 KP-4)
 * - `m2.customer_history`       riwayat lengkap per pelanggan (US-M2-08 KP-3)
 * - `m2.schedule`               papan jadwal per tanggal (US-M2-03)
 * - `m2.cancel_fail_monthly`    alasan batal & gagal per pelanggan dan per truk (US-M2-09 KP-4)
 * - `m2.kpi06_monthly`          dobel dibatalkan + lewat tanggal tanpa jadwal ulang (US-M2-04 KP-3, KPI-06)
 * - `m2.overrides_monthly`      pengesampingan beralasan 6.2c (H+0 setelah PAR-05, tambahan walau dobel)
 * - `m2.crew_assignments`       penetapan pengemudi harian (US-M2-11 KP-5 → laporan kinerja US-M9-05)
 * - `m2.crew_roster`            jadwal kru mingguan & kapasitas vs terjadwal (US-M2-10)
 * - `m2.recurring_orders`       pola langganan (US-M2-06)
 * - `m2.recurring_failures`     pesanan langganan gagal dibuat (US-M2-06 KP-4)
 */
import "server-only";

import { z } from "zod";

import { enumValues, label } from "@/lib/labels";
import { firstDayOfMonth, isBusinessDate, monthOf, toBusinessDate } from "@/lib/time";
import { registerReport } from "@/server/core/export";

import { getWeekRoster, listCrewAssignments } from "./service/crew";
import { customerOrderHistory, listOrders } from "./service/orders";
import { listRecurringFailures, listRecurringOrders } from "./service/recurring";
import { kpi06Report, monthlyCancelFailReport, overridesReport } from "./service/reporting";
import { getBoard } from "./service/schedule";

const dateOpt = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).optional();
const monthOpt = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "Bulan harus YYYY-MM." })
  .optional();

const orderFilters = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  from: dateOpt,
  to: dateOpt,
  truckId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  paymentMethod: z.enum(enumValues("payment_method")).optional(),
  flag: z.enum(["duplicate", "reschedule", "reconfirm", "after_cutoff", "provisional"]).optional(),
});

function currentMonth(): string {
  return monthOf(toBusinessDate(new Date()));
}

export function registerReports(): void {
  registerReport({
    key: "m2.orders",
    title: "Daftar pesanan",
    module: "m2",
    permission: "m2.order.export",
    containsPii: true,
    orientation: "landscape",
    filtersSchema: orderFilters,
    describeFilters: (f: z.infer<typeof orderFilters>) =>
      [f.from || f.to ? `Tanggal diminta ${f.from ?? "…"} s.d. ${f.to ?? "…"}` : null, f.status ? `Status ${f.status === "active" ? "berjalan" : label("order_status", f.status)}` : null, f.q ? `Cari "${f.q}"` : null].filter(
        (x): x is string => !!x,
      ),
    columns: [
      { key: "number", header: "No. pesanan", width: 14 },
      { key: "requestedDate", header: "Tanggal diminta", type: "date", width: 12 },
      { key: "requestedTime", header: "Jam", width: 7 },
      { key: "customerName", header: "Pelanggan", width: 26 },
      { key: "addressText", header: "Alamat kirim", pii: "address", width: 30 },
      { key: "tankCount", header: "Tangki", type: "number", width: 7, total: true },
      { key: "paymentMethod", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 10 },
      { key: "pricePerTrip", header: "Harga/rit", type: "rupiah", width: 12 },
      { key: "totalAmount", header: "Total", type: "rupiah", width: 13, total: true },
      { key: "status", header: "Status", type: "enum", enumName: "order_status", width: 14 },
      { key: "trucks", header: "Truk", width: 10, value: (r: { trucks: string[] }) => r.trucks.join(", ") },
      { key: "flags", header: "Penanda", width: 22 },
      { key: "createdByName", header: "Pembuat", width: 16 },
    ],
    fetch: async (ctx, filters: z.infer<typeof orderFilters>, { tx }) => {
      const rows = await listOrders(ctx, { ...filters, status: filters.status as never, limit: 2000 }, { tx });
      return {
        rows: rows.map((r) => ({
          ...r,
          flags: [
            r.isInternal ? "internal" : null,
            r.possibleDuplicate ? "kemungkinan dobel" : null,
            r.needsReschedule ? "perlu jadwal ulang" : null,
            r.reconfirmationRequired && !r.reconfirmed ? "konfirmasi ulang" : null,
            r.collectUnderpayment ? "tagih kurang bayar" : null,
            r.afterCutoffForced ? "H+0 dipaksa" : null,
            r.priceIsProvisional ? "harga sementara" : null,
            r.cancelReason ? `batal: ${label("order_cancel_reason", r.cancelReason)}` : null,
          ]
            .filter(Boolean)
            .join("; "),
        })),
        summary: [{ label: "Jumlah pesanan", value: rows.length, type: "number" }],
      };
    },
  });

  const historyFilters = z.object({ customerId: z.uuid({ error: "Pilih pelanggan." }) });
  registerReport({
    key: "m2.customer_history",
    title: "Riwayat pesanan pelanggan",
    module: "m2",
    permission: "m2.order.export",
    containsPii: true,
    orientation: "landscape",
    filtersSchema: historyFilters,
    columns: [
      { key: "number", header: "No. pesanan", width: 14 },
      { key: "requestedDate", header: "Tanggal", type: "date", width: 12 },
      { key: "requestedTime", header: "Jam", width: 7 },
      { key: "tankCount", header: "Tangki", type: "number", width: 7, total: true },
      { key: "status", header: "Status", type: "enum", enumName: "order_status", width: 14 },
      { key: "paymentMethod", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 10 },
      { key: "pricePerTrip", header: "Harga/rit", type: "rupiah", width: 12 },
      { key: "totalAmount", header: "Total", type: "rupiah", width: 13, total: true },
      { key: "trucks", header: "Truk", width: 10 },
      { key: "addressLabel", header: "Alamat", width: 12 },
      { key: "addressText", header: "Alamat kirim", pii: "address", width: 28 },
      { key: "failedTrips", header: "Rit gagal", type: "number", width: 8, total: true },
      { key: "cancelReason", header: "Alasan batal", type: "enum", enumName: "order_cancel_reason", width: 14 },
      { key: "notes", header: "Catatan", width: 24 },
    ],
    describeFilters: () => [],
    fetch: async (ctx, filters: z.infer<typeof historyFilters>, { tx }) => {
      const res = await customerOrderHistory(ctx, filters.customerId, { tx });
      return { rows: res.rows, summary: [{ label: "Pelanggan", value: res.customer.name }, { label: "Jumlah pesanan", value: res.rows.length, type: "number" }] };
    },
  });

  const boardFilters = z.object({ date: dateOpt });
  registerReport({
    key: "m2.schedule",
    title: "Papan jadwal rit harian",
    module: "m2",
    permission: "m2.schedule.read",
    containsPii: true,
    orientation: "landscape",
    filtersSchema: boardFilters,
    describeFilters: (f: z.infer<typeof boardFilters>) => [`Tanggal ${f.date ?? toBusinessDate(new Date())}`],
    columns: [
      { key: "truckCode", header: "Truk", width: 8 },
      { key: "driverName", header: "Pengemudi", width: 18 },
      { key: "routeOrder", header: "Urutan", type: "number", width: 7 },
      { key: "number", header: "No. rit", width: 16 },
      { key: "customerName", header: "Pelanggan", width: 24 },
      { key: "addressText", header: "Alamat", pii: "address", width: 28 },
      { key: "requestedTime", header: "Jam", width: 7 },
      { key: "paymentMethod", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 10 },
      { key: "status", header: "Status rit", type: "enum", enumName: "trip_status", width: 12 },
      { key: "published", header: "Terbit", type: "boolean", width: 7 },
      { key: "internal", header: "Internal", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, filters: z.infer<typeof boardFilters>, { tx }) => {
      const board = await getBoard(ctx, filters.date ?? toBusinessDate(ctx.now), { tx });
      const rows: Record<string, unknown>[] = [];
      for (const lane of board.lanes) {
        for (const t of lane.trips) {
          rows.push({ truckCode: lane.truck.code, driverName: lane.crew.driverName, routeOrder: t.routeOrder, number: t.number, customerName: t.customerName, addressText: t.addressText, requestedTime: t.requestedTime, paymentMethod: t.paymentMethod, status: t.status, published: t.published, internal: t.isInternal });
        }
      }
      for (const t of board.unscheduled) {
        rows.push({ truckCode: "Belum terjadwal", driverName: null, routeOrder: null, number: t.number, customerName: t.customerName, addressText: t.addressText, requestedTime: t.requestedTime, paymentMethod: t.paymentMethod, status: t.status, published: false, internal: t.isInternal });
      }
      return {
        rows,
        summary: [
          { label: "Kapasitas rit", value: board.totals.capacity, type: "number" },
          { label: "Rit pelanggan", value: board.totals.customer, type: "number" },
          { label: "Rit internal", value: board.totals.internal, type: "number" },
          { label: "Belum terjadwal", value: board.totals.unscheduled, type: "number" },
        ],
      };
    },
  });

  const monthFilters = z.object({ month: monthOpt });
  registerReport({
    key: "m2.cancel_fail_monthly",
    title: "Alasan pembatalan & rit gagal per pelanggan dan truk (bulanan)",
    module: "m2",
    permission: "m2.order.export",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: z.infer<typeof monthFilters>) => [`Bulan ${f.month ?? currentMonth()}`],
    columns: [
      { key: "groupType", header: "Per", width: 10, value: (r: { groupType: string }) => (r.groupType === "customer" ? "Pelanggan" : "Truk") },
      { key: "groupName", header: "Pelanggan/truk", width: 28 },
      { key: "kind", header: "Jenis", width: 10, value: (r: { kind: string }) => (r.kind === "cancel" ? "Batal" : "Gagal") },
      { key: "reasonLabel", header: "Alasan", width: 24 },
      { key: "count", header: "Jumlah", type: "number", width: 8 },
    ],
    fetch: async (ctx, filters: z.infer<typeof monthFilters>, { tx }) => {
      const res = await monthlyCancelFailReport(ctx, filters.month ?? monthOf(toBusinessDate(ctx.now)), { tx });
      return {
        rows: res.rows,
        summary: [
          { label: "Pesanan dibatalkan", value: res.totals.cancelled, type: "number" },
          { label: "Dibatalkan karena dobel (KPI-06)", value: res.totals.duplicateCancelled, type: "number" },
          { label: "Rit gagal", value: res.totals.failed, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "m2.kpi06_monthly",
    title: "KPI-06: pesanan dobel dibatalkan & lewat tanggal tanpa jadwal ulang",
    module: "m2",
    permission: "m2.order.export",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: z.infer<typeof monthFilters>) => [`Bulan ${f.month ?? currentMonth()}`],
    columns: [
      { key: "kind", header: "Jenis", width: 26, value: (r: { kind: string }) => (r.kind === "duplicate_cancelled" ? "Dibatalkan: dobel" : "Lewat tanggal tanpa jadwal ulang") },
      { key: "number", header: "No. pesanan", width: 14 },
      { key: "customerName", header: "Pelanggan", width: 26 },
      { key: "requestedDate", header: "Tanggal diminta", type: "date", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "order_status", width: 14 },
      { key: "note", header: "Keterangan", width: 30 },
    ],
    fetch: async (ctx, filters: z.infer<typeof monthFilters>, { tx }) => {
      const res = await kpi06Report(ctx, filters.month ?? monthOf(toBusinessDate(ctx.now)), { tx });
      return {
        rows: res.rows,
        summary: [
          { label: "Dibatalkan karena dobel", value: res.duplicateCancelled, type: "number" },
          { label: "Lewat tanggal tanpa jadwal ulang", value: res.overdueUnscheduled, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "m2.overrides_monthly",
    title: "Pengesampingan beralasan pesanan (6.2c) — tinjauan pemilik",
    module: "m2",
    permission: "m2.order.export",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: z.infer<typeof monthFilters>) => [`Bulan ${f.month ?? currentMonth()}`],
    columns: [
      { key: "kind", header: "Jenis", width: 24, value: (r: { kind: string }) => (r.kind === "after_cutoff" ? "H+0 setelah batas (BR-20)" : "Tambahan walau dobel (FR-M2-04)") },
      { key: "number", header: "No. pesanan", width: 14 },
      { key: "customerName", header: "Pelanggan", width: 26 },
      { key: "requestedDate", header: "Tanggal diminta", type: "date", width: 12 },
      { key: "reason", header: "Alasan", width: 32 },
      { key: "createdByName", header: "Pelaku", width: 18 },
      { key: "createdAt", header: "Dicatat", type: "datetime", width: 16 },
    ],
    fetch: async (ctx, filters: z.infer<typeof monthFilters>, { tx }) => {
      const rows = await overridesReport(ctx, filters.month ?? monthOf(toBusinessDate(ctx.now)), { tx });
      return { rows, summary: [{ label: "Jumlah pengesampingan", value: rows.length, type: "number" }] };
    },
  });

  const rangeFilters = z.object({ from: dateOpt, to: dateOpt, truckId: z.uuid().optional() });
  registerReport({
    key: "m2.crew_assignments",
    title: "Penetapan pengemudi harian",
    module: "m2",
    permission: "m2.crew_assignment.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeFilters,
    describeFilters: (f: z.infer<typeof rangeFilters>) => [`Tanggal ${f.from ?? "awal bulan"} s.d. ${f.to ?? "hari ini"}`],
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "truckCode", header: "Truk", width: 8 },
      { key: "driverName", header: "Pengemudi", width: 22 },
      { key: "source", header: "Jenis", type: "enum", enumName: "crew_assignment_source", width: 14 },
      { key: "reason", header: "Alasan", width: 28 },
      { key: "assignedByName", header: "Ditetapkan oleh", width: 18 },
      { key: "assignedAt", header: "Waktu", type: "datetime", width: 16 },
      { key: "active", header: "Berlaku", type: "boolean", width: 8 },
      { key: "supersededByName", header: "Diganti oleh", width: 18 },
    ],
    fetch: async (ctx, filters: z.infer<typeof rangeFilters>, { tx }) => {
      const today = toBusinessDate(ctx.now);
      const rows = await listCrewAssignments(ctx, { from: filters.from ?? firstDayOfMonth(today), to: filters.to ?? today, truckId: filters.truckId }, { tx });
      return { rows, summary: [{ label: "Jumlah penetapan", value: rows.length, type: "number" }] };
    },
  });

  const weekFilters = z.object({ from: dateOpt });
  registerReport({
    key: "m2.crew_roster",
    title: "Jadwal kru mingguan & kapasitas rit",
    module: "m2",
    permission: "m2.crew_assignment.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: weekFilters,
    describeFilters: (f: z.infer<typeof weekFilters>) => [`Mulai ${f.from ?? toBusinessDate(new Date())}`],
    columns: [
      { key: "date", header: "Tanggal", type: "date", width: 12 },
      { key: "truckCode", header: "Truk", width: 8 },
      { key: "dayStatus", header: "Status truk", type: "enum", enumName: "truck_day_status", width: 12 },
      { key: "driverName", header: "Sopir", width: 20 },
      { key: "helperName", header: "Kernet", width: 20 },
      { key: "tripCapacity", header: "Kapasitas rit", type: "number", width: 10, total: true },
      { key: "scheduledTrips", header: "Terjadwal", type: "number", width: 10, total: true },
    ],
    fetch: async (ctx, filters: z.infer<typeof weekFilters>, { tx }) => {
      const week = await getWeekRoster(ctx, filters.from ?? toBusinessDate(ctx.now), { tx });
      const code = new Map(week.trucks.map((t) => [t.id, t.code]));
      return {
        rows: week.cells.map((c) => ({ date: c.date, truckCode: code.get(c.truckId), dayStatus: c.dayStatus, driverName: c.crew.driverName, helperName: c.crew.helperName, tripCapacity: c.tripCapacity, scheduledTrips: c.scheduledTrips })),
        summary: week.totals.map((t) => ({ label: `${t.date}: terjadwal / kapasitas`, value: `${t.scheduled} / ${t.capacity}` })),
      };
    },
  });

  registerReport({
    key: "m2.recurring_orders",
    title: "Pesanan berulang (langganan)",
    module: "m2",
    permission: "m2.recurring_order.read",
    containsPii: true,
    orientation: "landscape",
    columns: [
      { key: "customerName", header: "Pelanggan", width: 26 },
      { key: "addressText", header: "Alamat", pii: "address", width: 28 },
      { key: "pattern", header: "Pola", type: "enum", enumName: "recurring_pattern", width: 18 },
      { key: "detail", header: "Hari/interval", width: 18 },
      { key: "tankCount", header: "Tangki", type: "number", width: 7 },
      { key: "paymentMethod", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 10 },
      { key: "startDate", header: "Mulai", type: "date", width: 11 },
      { key: "endDate", header: "Berakhir", type: "date", width: 11 },
      { key: "status", header: "Status", type: "enum", enumName: "recurring_status", width: 10 },
      { key: "nextDates", header: "Kirim berikutnya", width: 24 },
    ],
    fetch: async (ctx, _filters, { tx }) => {
      const days = ["", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
      const rows = await listRecurringOrders(ctx, { tx });
      return {
        rows: rows.map((r) => ({
          ...r,
          detail: r.pattern === "weekly" ? (r.daysOfWeek ?? []).map((d) => days[d]).join(", ") : `Setiap ${r.intervalDays} hari`,
          nextDates: r.nextDates.join(", "),
        })),
      };
    },
  });

  registerReport({
    key: "m2.recurring_failures",
    title: "Pesanan langganan yang gagal dibuat",
    module: "m2",
    permission: "m2.recurring_order.read",
    containsPii: false,
    columns: [
      { key: "targetDate", header: "Tanggal kirim", type: "date", width: 12 },
      { key: "customerName", header: "Pelanggan", width: 26 },
      { key: "reason", header: "Alasan", type: "enum", enumName: "recurring_failure_reason", width: 22 },
      { key: "message", header: "Keterangan", width: 40 },
      { key: "resolvedAt", header: "Ditindaklanjuti", type: "datetime", width: 16 },
    ],
    fetch: async (ctx, _filters, { tx }) => ({ rows: await listRecurringFailures(ctx, { includeResolved: true, tx }) }),
  });
}
