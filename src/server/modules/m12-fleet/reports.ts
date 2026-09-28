/**
 * M12 — laporan yang dapat diekspor Excel/PDF (NFR-23, US-M9-03; US-M12-03 KP-3: PDF ringkasan & Excel titik berhenti,
 * posisi mentah TIDAK diekspor):
 * - `m12.trips`            ringkasan perjalanan per rit (jarak, durasi, titik berhenti, lama di pelanggan, estimasi)
 * - `m12.stops`            titik berhenti per rit (lokasi & lama)
 * - `m12.truck_days`       ringkasan truk per hari + rit terjadwal vs Selesai (KPI-07)
 * - `m12.fleet_events`     kejadian armada (tinjauan pemilik, keterangan sopir, keputusan)
 * - `m12.location_patterns` pola penyimpangan lokasi per sopir & pelanggan (US-M12-04 KP-3 → US-M9-05)
 * - `m12.device_outages`   perangkat GPS mati/dicabut per truk (US-M12-08 KP-3)
 * - `m12.gps_devices`      kesehatan perangkat GPS (US-M12-08 KP-4)
 * - `m12.fuel_monthly`     estimasi biaya BBM per rit (truk & zona) bulan itu (US-M12-07 KP-3)
 * - `m12.fuel_trucks`      estimasi vs BBM nyata per truk (US-M12-07 KP-1)
 * - `m12.fuel_zones`       estimasi BBM per zona (US-M12-07 KP-3)
 * - `m12.zone_check`       pemeriksaan zona (US-M12-07 KP-2; alamat = data pribadi → wilayah saja untuk peran lain)
 */
import "server-only";

import { z } from "zod";

import { addDays, isBusinessDate, toBusinessDate } from "@/lib/time";
import { registerReport } from "@/server/core/export";
import { ctxBusinessDate } from "@/server/core/context";

import { deviceOutageReport, listGpsDevices } from "./service/devices";
import { fuelMonthly, zoneCheck } from "./service/fuel";
import { stopsReport, tripSummaryReport, truckDayReport } from "./service/history";
import { listFleetEvents, locationDeviationPatterns } from "./service/review";

const date = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." });
const rangeFilters = z.object({ from: date.optional(), to: date.optional(), truckId: z.uuid().optional() });
type Range = z.infer<typeof rangeFilters>;
const monthFilters = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "Bulan harus YYYY-MM." }).optional() });
type Month = z.infer<typeof monthFilters>;
const eventFilters = rangeFilters.extend({
  view: z.enum(["review", "open", "all"]).optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
});
type EventFilters = z.infer<typeof eventFilters>;

const describeRange = (f: Range) => [f.from || f.to ? `Tanggal ${f.from ?? "…"} s.d. ${f.to ?? "…"}` : "7 hari terakhir"];
const MAX_RANGE_DAYS = 62;

function range(f: Range, today: string, defaultDays = 6): { from: string; to: string } {
  const to = f.to ?? today;
  let from = f.from ?? addDays(to, -defaultDays);
  if (addDays(from, MAX_RANGE_DAYS) < to) from = addDays(to, -MAX_RANGE_DAYS);
  return { from, to };
}

const min = (s: number | null | undefined) => (s === null || s === undefined ? null : Math.round(s / 60));
const kmOf = (m: number | null | undefined) => (m === null || m === undefined ? null : Math.round(m / 100) / 10);

export function registerReports(): void {
  registerReport({
    key: "m12.trips",
    title: "Ringkasan perjalanan per rit",
    module: "m12",
    permission: "m12.trip_history.export",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeFilters,
    describeFilters: describeRange,
    columns: [
      { key: "date", header: "Tanggal", type: "date", width: 11 },
      { key: "number", header: "No. rit", width: 16 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "driverName", header: "Pelaksana", width: 18 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "status", header: "Status", type: "enum", enumName: "trip_status", width: 10 },
      { key: "departedAt", header: "Berangkat", type: "datetime", width: 14 },
      { key: "endedAt", header: "Selesai/Gagal", type: "datetime", width: 14 },
      { key: "km", header: "Jarak (km)", type: "number", width: 9, value: (r) => kmOf(r.distanceM as number | null), total: true },
      { key: "durationMin", header: "Durasi (menit)", type: "number", width: 9, value: (r) => min(r.durationS as number | null) },
      { key: "stopCount", header: "Titik berhenti", type: "number", width: 8 },
      { key: "stopMin", header: "Lama berhenti (menit)", type: "number", width: 9, value: (r) => min(r.stopTotalS as number) },
      { key: "atCustomerMin", header: "Lama di pelanggan (menit)", type: "number", width: 10, value: (r) => min(r.timeAtCustomerS as number | null) },
      { key: "isEstimated", header: "Jarak estimasi", type: "boolean", width: 8 },
      { key: "hasGaps", header: "Celah jejak", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, f: Range, { tx }) => {
      const r = range(f, ctxBusinessDate(ctx));
      const rows = await tripSummaryReport(ctx, { ...r, truckId: f.truckId }, { tx });
      return {
        rows,
        summary: [
          { label: "Rit", value: rows.length, type: "number" },
          { label: "Jarak total (km)", value: kmOf(rows.reduce((s, x) => s + (x.distanceM ?? 0), 0)) ?? 0, type: "number" },
          { label: "Rit berjarak estimasi (hanya titik status)", value: rows.filter((x) => x.isEstimated).length, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "m12.stops",
    title: "Titik berhenti per rit",
    module: "m12",
    permission: "m12.trip_history.export",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeFilters,
    describeFilters: describeRange,
    columns: [
      { key: "date", header: "Tanggal", type: "date", width: 11 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "tripNumber", header: "No. rit", width: 16 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "startedAt", header: "Mulai", type: "datetime", width: 14 },
      { key: "endedAt", header: "Selesai", type: "datetime", width: 14 },
      { key: "durationMin", header: "Lama (menit)", type: "number", width: 8, total: true },
      { key: "place", header: "Tempat", width: 20 },
      { key: "lat", header: "Lintang", type: "number", width: 10 },
      { key: "lng", header: "Bujur", type: "number", width: 10 },
    ],
    fetch: async (ctx, f: Range, { tx }) => {
      const rows = await stopsReport(ctx, { ...range(f, ctxBusinessDate(ctx)), truckId: f.truckId }, { tx });
      return { rows, summary: [{ label: "Titik berhenti", value: rows.length, type: "number" }] };
    },
  });

  registerReport({
    key: "m12.truck_days",
    title: "Ringkasan truk per hari (KPI-07)",
    module: "m12",
    permission: "m12.trip_history.export",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeFilters,
    describeFilters: describeRange,
    columns: [
      { key: "date", header: "Tanggal", type: "date", width: 11 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "km", header: "Jarak (km)", type: "number", width: 9, value: (r) => kmOf(r.distanceM as number | null), total: true },
      { key: "movingMin", header: "Bergerak (menit)", type: "number", width: 9, value: (r) => min(r.movingS as number) },
      { key: "stoppedMin", header: "Berhenti (menit)", type: "number", width: 9, value: (r) => min(r.stoppedS as number) },
      { key: "firstMoveAt", header: "Gerak pertama", type: "datetime", width: 14 },
      { key: "lastMoveAt", header: "Gerak terakhir", type: "datetime", width: 14 },
      { key: "scheduledTrips", header: "Rit terjadwal", type: "number", width: 8, total: true },
      { key: "completedTrips", header: "Rit Selesai", type: "number", width: 8, total: true },
      { key: "failedTrips", header: "Rit Gagal", type: "number", width: 8, total: true },
      { key: "betweenKm", header: "Jarak antar-rit (km)", type: "number", width: 9, value: (r) => kmOf(r.betweenTripDistanceM as number | null) },
      { key: "gpsDeadMinutes", header: "GPS mati (menit)", type: "number", width: 8 },
      { key: "isEstimated", header: "Estimasi", type: "boolean", width: 7 },
    ],
    fetch: async (ctx, f: Range, { tx }) => {
      const r = range(f, ctxBusinessDate(ctx), 0);
      const rows = await truckDayReport(ctx, { ...r, truckId: f.truckId }, { tx });
      const scheduled = rows.reduce((s, x) => s + x.scheduledTrips, 0);
      const done = rows.reduce((s, x) => s + x.completedTrips, 0);
      return {
        rows,
        summary: [
          { label: "Rit terjadwal", value: scheduled, type: "number" },
          { label: "Rit Selesai", value: done, type: "number" },
          { label: "KPI-07 realisasi (%)", value: scheduled ? Math.round((done / scheduled) * 1000) / 10 : 0, type: "percent" },
        ],
      };
    },
  });

  registerReport({
    key: "m12.fleet_events",
    title: "Kejadian armada",
    module: "m12",
    permission: "m12.fleet_event.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: eventFilters,
    describeFilters: (f: EventFilters) => [...describeRange(f), f.view === "review" ? "Daftar tinjauan pemilik" : f.view === "open" ? "Belum Selesai" : "Semua"],
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "startedAt", header: "Mulai", type: "datetime", width: 14 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "fleet_event_kind", width: 20 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "tripNumber", header: "Rit", width: 16 },
      { key: "customerName", header: "Pelanggan", width: 18 },
      { key: "km", header: "Jarak (km)", type: "number", width: 8, value: (r) => kmOf(r.distanceM as number | null) },
      { key: "durationMin", header: "Lama (menit)", type: "number", width: 8, value: (r) => min(r.durationS as number | null) },
      { key: "userName", header: "Pengguna aktif", width: 16 },
      { key: "status", header: "Status", type: "enum", enumName: "fleet_event_status", width: 12 },
      { key: "explanation", header: "Keterangan sopir", width: 26 },
      { key: "explanationLate", header: "Keterangan terlambat", type: "boolean", width: 8 },
      { key: "reviewDecision", header: "Keputusan", type: "enum", enumName: "fleet_review_decision", width: 14 },
      { key: "reviewNote", header: "Catatan tinjauan", width: 22 },
    ],
    fetch: async (ctx, f: EventFilters, { tx }) => {
      const r = range(f, ctxBusinessDate(ctx), f.view === "review" ? 30 : 6);
      const rows = await listFleetEvents(ctx, { from: r.from, to: r.to, truckId: f.truckId, view: f.view, limit: 1000 }, { tx });
      return {
        rows,
        summary: [
          { label: "Kejadian", value: rows.length, type: "number" },
          { label: "Menunggu tinjauan pemilik", value: rows.filter((x) => x.needsReview).length, type: "number" },
          { label: "Menunggu keterangan sopir", value: rows.filter((x) => x.awaitingExplanation).length, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "m12.location_patterns",
    title: "Pola penyimpangan lokasi per sopir & pelanggan",
    module: "m12",
    permission: "m12.fleet_event.read",
    containsPii: false,
    filtersSchema: rangeFilters,
    describeFilters: describeRange,
    columns: [
      { key: "group", header: "Kelompok", width: 10 },
      { key: "name", header: "Nama", width: 26 },
      { key: "locationEvents", header: "Penyimpangan", type: "number", width: 10, total: true },
      { key: "level2", header: "Tingkat 2", type: "number", width: 9, total: true },
      { key: "inconsistent", header: "Sumber tidak konsisten", type: "number", width: 10, total: true },
    ],
    fetch: async (ctx, f: Range, { tx }) => {
      const r = range(f, ctxBusinessDate(ctx), 30);
      const p = await locationDeviationPatterns(ctx, r, { tx });
      return { rows: [...p.byDriver.map((x) => ({ ...x, group: "Sopir" })), ...p.byCustomer.map((x) => ({ ...x, group: "Pelanggan" }))] };
    },
  });

  registerReport({
    key: "m12.device_outages",
    title: "Perangkat GPS mati/dicabut per truk",
    module: "m12",
    permission: "m12.fleet_event.read",
    containsPii: false,
    filtersSchema: rangeFilters,
    describeFilters: describeRange,
    columns: [
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "deviceCode", header: "Perangkat", width: 12 },
      { key: "count", header: "Kejadian", type: "number", width: 8, total: true },
      { key: "unplugged", header: "Dicabut", type: "number", width: 8, total: true },
      { key: "totalMinutes", header: "Total mati (menit)", type: "number", width: 10, total: true },
      { key: "longestMinutes", header: "Terlama (menit)", type: "number", width: 10 },
      { key: "pattern", header: "Pola berulang", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, f: Range, { tx }) => ({ rows: await deviceOutageReport(ctx, range(f, ctxBusinessDate(ctx), 29), { tx }) }),
  });

  registerReport({
    key: "m12.gps_devices",
    title: "Kesehatan perangkat GPS",
    module: "m12",
    permission: "m12.fleet_event.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "deviceCode", header: "Perangkat", width: 12 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "vendor", header: "Vendor", width: 14 },
      { key: "firmwareVersion", header: "Versi", width: 10 },
      { key: "gpsState", header: "Status GPS", type: "enum", enumName: "gps_state", width: 10 },
      { key: "lastPositionAt", header: "Posisi terakhir", type: "datetime", width: 14 },
      { key: "lastSeenAt", header: "Terakhir terlihat", type: "datetime", width: 14 },
      { key: "powerConnected", header: "Daya tersambung", type: "boolean", width: 8 },
      { key: "batteryPct", header: "Baterai (%)", type: "number", width: 8 },
      { key: "outages30d", header: "Mati 30 hari", type: "number", width: 8 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listGpsDevices(ctx, { tx }) }),
  });

  registerReport({
    key: "m12.fuel_monthly",
    title: "Estimasi biaya BBM per rit (bulanan)",
    module: "m12",
    permission: "m12.fuel_estimate.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthFilters,
    describeFilters: (f: Month) => [`Bulan ${f.month ?? "berjalan"}`, "Estimasi informasi — tidak dijurnal (US-M12-07)"],
    columns: [
      { key: "date", header: "Tanggal", type: "date", width: 11 },
      { key: "number", header: "No. rit", width: 16 },
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "zoneCode", header: "Zona", width: 8 },
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "km", header: "Jarak (km)", type: "number", width: 9, value: (r) => kmOf(r.distanceM as number), total: true },
      { key: "liters", header: "BBM (L)", type: "number", width: 8, total: true },
      { key: "estimatedCost", header: "Estimasi biaya", type: "rupiah", width: 12, total: true },
    ],
    fetch: async (ctx, f: Month, { tx }) => {
      const res = await fuelMonthly(ctx, { month: f.month ?? toBusinessDate(ctx.now).slice(0, 7) }, { tx });
      return {
        rows: res.trips,
        status: res.configured ? undefined : "PAR-53 belum ditetapkan pemilik",
        summary: [
          ...res.byTruck.map((t) => ({ label: `Truk ${t.truckCode}: estimasi / BBM nyata / selisih`, value: `${t.estimatedCost} / ${t.actualFuel} / ${t.difference}` })),
          ...res.byZone.map((z) => ({ label: `Zona ${z.zoneCode}: ${z.trips} rit`, value: z.estimatedCost, type: "rupiah" as const })),
        ],
      };
    },
  });

  registerReport({
    key: "m12.fuel_trucks",
    title: "BBM per truk: estimasi vs nyata",
    module: "m12",
    permission: "m12.fuel_estimate.read",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: Month) => [`Bulan ${f.month ?? "berjalan"}`, "Selisih ditampilkan, tidak menyesuaikan otomatis"],
    columns: [
      { key: "truckCode", header: "Truk", width: 6 },
      { key: "trips", header: "Rit", type: "number", width: 6, total: true },
      { key: "km", header: "Jarak (km)", type: "number", width: 9, value: (r) => kmOf(r.distanceM as number), total: true },
      { key: "liters", header: "BBM estimasi (L)", type: "number", width: 9, total: true },
      { key: "estimatedCost", header: "Estimasi biaya", type: "rupiah", width: 12, total: true },
      { key: "actualFuel", header: "BBM nyata", type: "rupiah", width: 12, total: true },
      { key: "difference", header: "Selisih (nyata − estimasi)", type: "rupiah", width: 12, total: true },
    ],
    fetch: async (ctx, f: Month, { tx }) => ({ rows: (await fuelMonthly(ctx, { month: f.month ?? toBusinessDate(ctx.now).slice(0, 7) }, { tx })).byTruck }),
  });

  registerReport({
    key: "m12.fuel_zones",
    title: "Estimasi biaya BBM per zona",
    module: "m12",
    permission: "m12.fuel_estimate.read",
    containsPii: false,
    filtersSchema: monthFilters,
    describeFilters: (f: Month) => [`Bulan ${f.month ?? "berjalan"}`],
    columns: [
      { key: "zoneCode", header: "Zona", width: 10 },
      { key: "trips", header: "Rit", type: "number", width: 6, total: true },
      { key: "km", header: "Jarak (km)", type: "number", width: 9, value: (r) => kmOf(r.distanceM as number), total: true },
      { key: "estimatedCost", header: "Estimasi biaya", type: "rupiah", width: 12, total: true },
      { key: "avgCostPerTrip", header: "Rata-rata per rit", type: "rupiah", width: 12 },
    ],
    fetch: async (ctx, f: Month, { tx }) => ({ rows: (await fuelMonthly(ctx, { month: f.month ?? toBusinessDate(ctx.now).slice(0, 7) }, { tx })).byZone }),
  });

  registerReport({
    key: "m12.zone_check",
    title: "Pemeriksaan zona dari jarak GPS",
    module: "m12",
    permission: "m12.fuel_estimate.read",
    containsPii: true,
    orientation: "landscape",
    describeFilters: () => ["Alamat yang rata-rata jarak GPS rit terakhirnya masuk zona lain — perubahan zona hanya lewat US-M1-05"],
    columns: [
      { key: "customerName", header: "Pelanggan", width: 22 },
      { key: "addressText", header: "Alamat", width: 26, pii: "address" },
      { key: "currentZoneCode", header: "Zona alamat", width: 8 },
      { key: "routeKm", header: "Jarak rute M1 (km)", type: "number", width: 9, value: (r) => kmOf(r.routeDistanceM as number | null) },
      { key: "gpsKm", header: "Rata-rata GPS (km)", type: "number", width: 9, value: (r) => kmOf(r.avgGpsDistanceM as number) },
      { key: "tripsUsed", header: "Rit", type: "number", width: 5 },
      { key: "actualZoneCode", header: "Zona dari GPS", width: 8 },
      { key: "currentTariff", header: "Tarif zona alamat", type: "rupiah", width: 12 },
      { key: "actualTariff", header: "Tarif zona GPS", type: "rupiah", width: 12 },
      { key: "tariffDifference", header: "Selisih tarif", type: "rupiah", width: 12, total: true },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await zoneCheck(ctx, { tx })).rows }),
  });
}

