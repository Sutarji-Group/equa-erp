/**
 * M3 — laporan yang dapat diekspor Excel/PDF (NFR-23, US-M9-03): setiap daftar M3 yang disebut PRD.
 *
 * - `m3.trips`            rit yang dikerjakan sopir: waktu Berangkat/Tiba/Selesai, volume & alasan parsial, penerima,
 *                         jarak lokasi & penyimpangan (BR-23), gagal & tindak lanjut air, urutan aktual, dicatat kantor,
 *                         terlambat sinkron (`m2.trip.read` / `m3.trip_incident.read`)
 * - `m3.trip_payments`    pembayaran per rit (tunai/transfer/tempo, kurang bayar, ubah cara bayar) (`m3.payment_report.read`)
 * - `m3.collections`      pelunasan lewat sopir (BR-07) (`m3.payment_report.read`)
 * - `m3.expenses`         pengeluaran rit & status verifikasi (US-M3-08) (`m3.payment_report.read`)
 * - `m3.driver_deposits`  setoran sopir: seharusnya, diterima, selisih, terlambat (`m3.payment_report.read`)
 * - `m3.office_entries`   pencatatan "dicatat kantor" (KPI-01 tidak di sumber, US-M3-09 KP-5) (`m3.office_entry.read`)
 * - `m3.incidents`        kendala perjalanan & rit gagal (US-M3-06) (`m3.trip_incident.read`)
 */
import "server-only";

import { z } from "zod";

import { isBusinessDate } from "@/lib/time";
import { registerReport } from "@/server/core/export";

import { listIncidents } from "./service/incidents";
import { officeEntryReport } from "./service/office";
import { collectionReport, driverDepositReport, driverTripReport, expenseReport, tripPaymentReport } from "./service/queries";

const dateOpt = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).optional();
const rangeFilters = z.object({ from: dateOpt, to: dateOpt, truckId: z.uuid().optional() });
type Range = z.infer<typeof rangeFilters>;
const describe = (f: Range) => [f.from || f.to ? `Tanggal ${f.from ?? "…"} s.d. ${f.to ?? "…"}` : "7 hari terakhir"];

export function registerReports(): void {
  registerReport({
    key: "m3.trips",
    title: "Rit sopir & bukti kirim",
    module: "m3",
    permission: "m2.trip.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeFilters,
    describeFilters: describe,
    columns: [
      { key: "number", header: "No. rit", width: 16 },
      { key: "scheduledDate", header: "Tanggal", type: "date", width: 11 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "driverName", header: "Pelaksana", width: 18 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "status", header: "Status", type: "enum", enumName: "trip_status", width: 10 },
      { key: "routeOrder", header: "Urutan rencana", type: "number", width: 8 },
      { key: "actualOrder", header: "Urutan aktual", type: "number", width: 8 },
      { key: "departedAt", header: "Berangkat", type: "datetime", width: 14 },
      { key: "completedAt", header: "Selesai", type: "datetime", width: 14 },
      { key: "deliveredVolumeL", header: "Volume", type: "liter", width: 9, total: true },
      { key: "partialVolumeReason", header: "Alasan volume", type: "enum", enumName: "partial_volume_reason", width: 14 },
      { key: "recipientName", header: "Penerima", width: 14 },
      { key: "completionDistanceM", header: "Jarak ke alamat (m)", type: "number", width: 9 },
      { key: "locationDeviation", header: "Penyimpangan", type: "enum", enumName: "location_deviation", width: 12 },
      { key: "locationReason", header: "Alasan lokasi", type: "enum", enumName: "location_reason", width: 14 },
      { key: "failReason", header: "Alasan gagal", type: "enum", enumName: "trip_fail_reason", width: 14 },
      { key: "loadedWaterDisposition", header: "Air dimuat", type: "enum", enumName: "loaded_water_disposition", width: 14 },
      { key: "noLocation", header: "Tanpa lokasi", type: "boolean", width: 7 },
      { key: "recordedByOffice", header: "Dicatat kantor", type: "boolean", width: 7 },
      { key: "lateSync", header: "Terlambat sinkron", type: "boolean", width: 7 },
    ],
    fetch: async (ctx, f: Range, { tx }) => {
      const rows = await driverTripReport(ctx, f, { tx });
      return {
        rows,
        summary: [
          { label: "Rit Selesai", value: rows.filter((r) => r.status === "completed").length, type: "number" },
          { label: "Rit Gagal", value: rows.filter((r) => r.status === "failed").length, type: "number" },
          { label: "Dicatat kantor (KPI-01)", value: rows.filter((r) => r.recordedByOffice).length, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "m3.trip_payments",
    title: "Pembayaran rit",
    module: "m3",
    permission: "m3.payment_report.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeFilters,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "tripNumber", header: "No. rit", width: 16 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "driverName", header: "Pelaksana", width: 18 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "method", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 10 },
      { key: "originalMethod", header: "Cara bayar pesanan", type: "enum", enumName: "payment_method", width: 10 },
      { key: "expectedAmount", header: "Seharusnya", type: "rupiah", width: 12, total: true },
      { key: "receivedAmount", header: "Diterima", type: "rupiah", width: 12, total: true },
      { key: "underpaymentAmount", header: "Kurang bayar", type: "rupiah", width: 12, total: true },
      { key: "underpaymentReason", header: "Alasan kurang bayar", width: 22 },
      { key: "recordedByOffice", header: "Dicatat kantor", type: "boolean", width: 7 },
      { key: "lateSync", header: "Terlambat sinkron", type: "boolean", width: 7 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await tripPaymentReport(ctx, f, { tx }) }),
  });

  registerReport({
    key: "m3.collections",
    title: "Pelunasan lewat sopir",
    module: "m3",
    permission: "m3.payment_report.read",
    containsPii: false,
    filtersSchema: rangeFilters,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "driverName", header: "Sopir", width: 18 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "tripNumber", header: "Rit", width: 16 },
      { key: "method", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 10 },
      { key: "amount", header: "Jumlah", type: "rupiah", width: 12, total: true },
      { key: "advanceAmount", header: "Uang muka", type: "rupiah", width: 12, total: true },
      { key: "recordedByOffice", header: "Dicatat kantor", type: "boolean", width: 7 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await collectionReport(ctx, f, { tx }) }),
  });

  registerReport({
    key: "m3.expenses",
    title: "Pengeluaran rit",
    module: "m3",
    permission: "m3.payment_report.read",
    containsPii: false,
    filtersSchema: rangeFilters,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "driverName", header: "Sopir", width: 18 },
      { key: "tripNumber", header: "Rit", width: 16 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "trip_expense_kind", width: 10 },
      { key: "amount", header: "Jumlah", type: "rupiah", width: 12, total: true },
      { key: "fundingSource", header: "Sumber dana", type: "enum", enumName: "expense_funding_source", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "expense_status", width: 14 },
      { key: "note", header: "Catatan", width: 20 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await expenseReport(ctx, f, { tx }) }),
  });

  registerReport({
    key: "m3.driver_deposits",
    title: "Setoran sopir",
    module: "m3",
    permission: "m3.payment_report.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeFilters,
    describeFilters: describe,
    columns: [
      { key: "number", header: "No. setoran", width: 14 },
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "driverName", header: "Sopir", width: 18 },
      { key: "status", header: "Status", type: "enum", enumName: "deposit_status", width: 10 },
      { key: "method", header: "Cara setor", type: "enum", enumName: "deposit_method", width: 12 },
      { key: "expectedCash", header: "Tunai seharusnya", type: "rupiah", width: 12, total: true },
      { key: "expectedNet", header: "Seharusnya disetor", type: "rupiah", width: 12, total: true },
      { key: "receivedAmount", header: "Diterima", type: "rupiah", width: 12, total: true },
      { key: "discrepancyAmount", header: "Selisih", type: "rupiah", width: 12, total: true },
      { key: "submittedAt", header: "Diajukan", type: "datetime", width: 14 },
      { key: "submittedLate", header: "Terlambat", type: "boolean", width: 7 },
      { key: "depositorNote", header: "Keterangan sopir", width: 22 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await driverDepositReport(ctx, f, { tx }) }),
  });

  registerReport({
    key: "m3.office_entries",
    title: "Pencatatan \"dicatat kantor\" (KPI-01)",
    module: "m3",
    permission: "m3.office_entry.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeFilters,
    describeFilters: (f: Range) => [f.from || f.to ? `Tanggal ${f.from ?? "…"} s.d. ${f.to ?? "…"}` : "30 hari terakhir"],
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "kindLabel", header: "Jenis", width: 14 },
      { key: "tripNumber", header: "Rit", width: 16 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "driverName", header: "Atas nama", width: 18 },
      { key: "paymentMethod", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 10 },
      { key: "amount", header: "Jumlah", type: "rupiah", width: 12, total: true },
      { key: "reason", header: "Alasan & bukti", width: 30 },
      { key: "recordedAt", header: "Dicatat", type: "datetime", width: 14 },
    ],
    fetch: async (ctx, f: Range, { tx }) => {
      const rows = await officeEntryReport(ctx, f, { tx });
      const kindLabel = { trip_completed: "Rit Selesai", trip_failed: "Rit Gagal", collection: "Pelunasan", deposit: "Setor" } as const;
      return { rows: rows.map((r) => ({ ...r, kindLabel: kindLabel[r.kind] })), summary: [{ label: "Jumlah pencatatan kantor", value: rows.length, type: "number" }] };
    },
  });

  registerReport({
    key: "m3.incidents",
    title: "Kendala perjalanan & rit gagal",
    module: "m3",
    permission: "m3.trip_incident.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeFilters,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "occurredAt", header: "Waktu", type: "datetime", width: 14 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "tripNumber", header: "Rit", width: 16 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "trip_incident_kind", width: 12 },
      { key: "description", header: "Catatan", width: 34 },
      { key: "reporterName", header: "Pelapor", width: 16 },
      { key: "acknowledgedAt", header: "Dikonfirmasi", type: "datetime", width: 14 },
      { key: "truckStatusChanged", header: "Truk → Perbaikan", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await listIncidents(ctx, f, { tx }) }),
  });
}
