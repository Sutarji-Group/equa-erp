/**
 * M8 — laporan produksi yang dapat diekspor Excel/PDF (katalog PRD 7.9.4, US-M9-03, NFR-23): pembacaan meter, produksi
 * harian, pengisian truk (+ selisih rit), pasokan depot (tiga angka + nilai transfer) & ringkasannya, neraca harian &
 * bulanan (US-M8-04 KP-4), utilisasi harian 6 bulan satu berkas (US-M8-05 KP-3) & bulanan, pengisian vs jadwal, riwayat
 * uji mutu. Semua berlingkup tenant pelaku; filter `from`/`to` (YYYY-MM-DD), `sourceId`, `outletId`, `month` (YYYY-MM).
 */
import "server-only";

import { and, asc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";

import { dailyProductions, employees, meterReadings, users, waterMeters, waterSources } from "@/db/schema";
import { addDays, formatTanggal, isBusinessDate, monthOf } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { registerReport } from "@/server/core/export";
import { inSourceScope } from "@/server/core/rbac";

import { m8Rules } from "./service/common";
import { fillsVsSchedule, listFills } from "./service/fills";
import { qualityOverview } from "./service/quality";
import { computeMonthlyBalance, listWaterBalances } from "./service/queries";
import { summarizeSupply, supplyRows } from "./service/supply";
import { computeUtilizationDays, computeUtilizationMonth, utilizationExportRange } from "./service/utilization";

const dateOpt = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).optional();
const rangeSchema = z.object({ from: dateOpt, to: dateOpt, sourceId: z.uuid().optional(), outletId: z.uuid().optional() });
type RangeFilters = z.infer<typeof rangeSchema>;
const monthSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, { error: "Bulan harus YYYY-MM." }).optional(), sourceId: z.uuid().optional() });
type MonthFilters = z.infer<typeof monthSchema>;

function range(ctx: ActorContext, f: RangeFilters, days = 7) {
  const today = ctxBusinessDate(ctx);
  return { from: f.from ?? addDays(today, -(days - 1)), to: f.to ?? today };
}

function describe(f: RangeFilters): string[] {
  const out: string[] = [];
  if (f.from || f.to) out.push(`Periode: ${f.from ? formatTanggal(f.from) : "…"} s.d. ${f.to ? formatTanggal(f.to) : "…"}`);
  if (f.sourceId) out.push("Satu sumber air");
  if (f.outletId) out.push("Satu depot");
  return out;
}

function describeMonth(f: MonthFilters): string[] {
  return [`Bulan: ${f.month ?? "berjalan"}`, ...(f.sourceId ? ["Satu sumber air"] : [])];
}

export function registerReports(): void {
  registerReport({
    key: "m8.meter_readings",
    title: "Pembacaan meter sumber air (pagi/malam, koreksi, terlambat)",
    module: "m8",
    permission: "m8.production.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "sourceName", header: "Sumber air", width: 22 },
      { key: "meterCode", header: "Meter", width: 14 },
      { key: "phase", header: "Pembacaan", type: "enum", enumName: "meter_phase", width: 12 },
      { key: "readingL", header: "Angka meter", type: "liter", width: 14 },
      { key: "readAt", header: "Waktu perangkat", type: "datetime", width: 16 },
      { key: "status", header: "Status", type: "enum", enumName: "meter_reading_status", width: 12 },
      { key: "recordedByName", header: "Pencatat", width: 18 },
      { key: "lateReason", header: "Alasan terlambat", width: 22 },
      { key: "correctionReason", header: "Alasan koreksi", width: 22 },
      { key: "adjustmentKind", header: "Penyesuaian", type: "enum", enumName: "meter_adjustment_kind", width: 14 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => {
      const r = range(ctx, f);
      const rows = await tx
        .select({ m: meterReadings, meterCode: waterMeters.code, sourceName: waterSources.name, recordedByName: employees.fullName })
        .from(meterReadings)
        .innerJoin(waterMeters, eq(waterMeters.id, meterReadings.waterMeterId))
        .innerJoin(waterSources, eq(waterSources.id, meterReadings.waterSourceId))
        .leftJoin(users, eq(users.id, meterReadings.recordedBy))
        .leftJoin(employees, eq(employees.id, users.employeeId))
        .where(
          and(
            eq(meterReadings.tenantId, ctx.tenantId),
            gte(meterReadings.businessDate, r.from),
            lte(meterReadings.businessDate, r.to),
            ...(f.sourceId ? [eq(meterReadings.waterSourceId, f.sourceId)] : []),
          ),
        )
        .orderBy(asc(meterReadings.businessDate), asc(waterMeters.code), asc(meterReadings.readAt));
      return {
        rows: rows
          .filter((x) => inSourceScope(ctx, x.m.waterSourceId, x.m.tenantId))
          .map((x) => ({ ...x.m, meterCode: x.meterCode, sourceName: x.sourceName, recordedByName: x.recordedByName })),
      };
    },
  });

  registerReport({
    key: "m8.daily_production",
    title: "Produksi harian per sumber (status, penyimpangan, verifikasi)",
    module: "m8",
    permission: "m8.production.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "sourceName", header: "Sumber air", width: 22 },
      { key: "producedL", header: "Produksi", type: "liter", total: true, width: 14 },
      { key: "status", header: "Status", type: "enum", enumName: "production_status", width: 14 },
      { key: "deviationPct", header: "Menyimpang dari rata-rata (%)", type: "percent", width: 14 },
      { key: "flaggedForVerification", header: "Perlu verifikasi", type: "boolean", width: 10 },
      { key: "verified", header: "Diverifikasi", type: "boolean", width: 10 },
      { key: "incompleteReason", header: "Keterangan", width: 40 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => {
      const r = range(ctx, f);
      const rows = await tx
        .select({ p: dailyProductions, sourceName: waterSources.name })
        .from(dailyProductions)
        .innerJoin(waterSources, eq(waterSources.id, dailyProductions.waterSourceId))
        .where(
          and(
            eq(dailyProductions.tenantId, ctx.tenantId),
            gte(dailyProductions.businessDate, r.from),
            lte(dailyProductions.businessDate, r.to),
            ...(f.sourceId ? [eq(dailyProductions.waterSourceId, f.sourceId)] : []),
          ),
        )
        .orderBy(asc(dailyProductions.businessDate), asc(waterSources.code));
      return { rows: rows.map((x) => ({ ...x.p, sourceName: x.sourceName, verified: !!x.p.verifiedAt })) };
    },
  });

  registerReport({
    key: "m8.truck_fills",
    title: "Pengisian truk per rit (selisih rit, tanpa rit, di luar rencana)",
    module: "m8",
    permission: "m8.truck_fill.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "filledAt", header: "Waktu isi", type: "datetime", width: 16 },
      { key: "sourceName", header: "Sumber air", width: 20 },
      { key: "truckCode", header: "Truk", width: 8 },
      { key: "tripNumber", header: "Rit", width: 16 },
      { key: "destination", header: "Pelanggan/depot", width: 22 },
      { key: "volumeL", header: "Volume isi", type: "liter", total: true, width: 12 },
      { key: "volumeReason", header: "Alasan volume", width: 20 },
      { key: "deliveredVolumeL", header: "Terkirim", type: "liter", width: 12 },
      { key: "tripDifferenceL", header: "Selisih rit", type: "liter", total: true, width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "truck_fill_status", width: 14 },
      { key: "isDepotSupply", header: "Pasokan depot", type: "boolean", width: 10 },
      { key: "withoutTrip", header: "Tanpa rit", type: "boolean", width: 10 },
      { key: "unplannedTruck", header: "Di luar rencana", type: "boolean", width: 10 },
      { key: "reversed", header: "Dibalik", type: "boolean", width: 8 },
      { key: "deviceSpare", header: "Ponsel cadangan", type: "boolean", width: 10 },
      { key: "geofenceMismatch", header: "Tidak cocok geofence", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => {
      const r = range(ctx, f);
      const rows = await listFills(tx, ctx.tenantId, { from: r.from, to: r.to, sourceId: f.sourceId ?? null });
      return {
        rows: rows
          .filter((x) => inSourceScope(ctx, x.waterSourceId, x.tenantId))
          .map((x) => ({
            ...x,
            destination: x.tripIsInternal ? x.destinationName : x.customerName,
            tripDifferenceL: x.deliveredVolumeL !== null && x.tripStatus === "completed" && !x.reversalOfId ? x.volumeL - x.deliveredVolumeL : null,
            withoutTrip: !x.tripId && !x.reversalOfId,
            reversed: !!x.reversedAt || !!x.reversalOfId,
          })),
      };
    },
  });

  registerReport({
    key: "m8.depot_supply",
    title: "Pasokan air depot: diisi, diserahkan, diterima, nilai transfer",
    module: "m8",
    permission: "m8.truck_fill.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "outletName", header: "Depot", width: 22 },
      { key: "tripNumber", header: "Rit", width: 16 },
      { key: "truckCode", header: "Truk", width: 8 },
      { key: "sourceName", header: "Sumber air", width: 18 },
      { key: "filledL", header: "Diisi", type: "liter", total: true, width: 12 },
      { key: "deliveredL", header: "Diserahkan", type: "liter", total: true, width: 12 },
      { key: "receivedL", header: "Diterima", type: "liter", total: true, width: 12 },
      { key: "differenceL", header: "Selisih diisi−diterima", type: "liter", total: true, width: 12 },
      { key: "differencePct", header: "Selisih (%)", type: "percent", width: 10 },
      { key: "outOfTolerance", header: "Di luar toleransi", type: "boolean", width: 10 },
      { key: "transferValue", header: "Nilai transfer", type: "rupiah", total: true, width: 14 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => {
      const r = range(ctx, f);
      return { rows: await supplyRows(tx, ctx.tenantId, { from: r.from, to: r.to, outletId: f.outletId ?? null }) };
    },
  });

  const summarySchema = rangeSchema.extend({ granularity: z.enum(["day", "month"]).optional() });
  registerReport({
    key: "m8.depot_supply_summary",
    title: "Ringkasan pasokan per depot per hari/bulan (liter, jumlah rit)",
    module: "m8",
    permission: "m8.truck_fill.read",
    containsPii: false,
    filtersSchema: summarySchema,
    describeFilters: (f: z.infer<typeof summarySchema>) => [...describe(f), f.granularity === "month" ? "Per bulan" : "Per hari"],
    columns: [
      { key: "period", header: "Periode", width: 12 },
      { key: "outletName", header: "Depot", width: 24 },
      { key: "trips", header: "Jumlah rit", type: "number", total: true, width: 10 },
      { key: "filledL", header: "Diisi", type: "liter", total: true, width: 12 },
      { key: "deliveredL", header: "Diserahkan", type: "liter", total: true, width: 12 },
      { key: "receivedL", header: "Diterima", type: "liter", total: true, width: 12 },
      { key: "differenceL", header: "Selisih", type: "liter", total: true, width: 12 },
      { key: "transferValue", header: "Nilai transfer", type: "rupiah", total: true, width: 14 },
    ],
    fetch: async (ctx, f: z.infer<typeof summarySchema>, { tx }) => {
      const r = range(ctx, f, 31);
      return { rows: summarizeSupply(await supplyRows(tx, ctx.tenantId, { from: r.from, to: r.to, outletId: f.outletId ?? null }), f.granularity ?? "day") };
    },
  });

  registerReport({
    key: "m8.water_balance_daily",
    title: "Neraca air harian per sumber (produksi, pengisian, susut, utilisasi)",
    module: "m8",
    permission: "m8.water_balance.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "sourceName", header: "Sumber air", width: 20 },
      { key: "producedL", header: "Produksi", type: "liter", total: true, width: 12 },
      { key: "filledCustomerL", header: "Pengisian pelanggan", type: "liter", total: true, width: 12 },
      { key: "filledDepotL", header: "Pasokan depot", type: "liter", total: true, width: 12 },
      { key: "returnedL", header: "Air kembali", type: "liter", total: true, width: 10 },
      { key: "filledTotalL", header: "Σ pengisian", type: "liter", total: true, width: 12 },
      { key: "lossL", header: "Susut", type: "liter", total: true, width: 12 },
      { key: "lossPct", header: "Susut (%)", type: "percent", width: 10 },
      { key: "avgLoss7dPct", header: "Rata-rata susut 7 hari (%)", type: "percent", width: 12 },
      { key: "utilizationPct", header: "Utilisasi (%)", type: "percent", width: 10 },
      { key: "isIncomplete", header: "Belum lengkap", type: "boolean", width: 10 },
      { key: "status", header: "Status", type: "enum", enumName: "water_balance_status", width: 16 },
      { key: "investigationReason", header: "Alasan susut", type: "enum", enumName: "loss_reason", width: 16 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => {
      const r = range(ctx, f);
      return { rows: await listWaterBalances(ctx, { from: r.from, to: r.to, sourceId: f.sourceId ?? null }, { tx }) };
    },
  });

  registerReport({
    key: "m8.water_balance_monthly",
    title: "Neraca air bulanan per sumber (produksi, pengisian pelanggan, pasokan depot, susut, rata-rata/hari)",
    module: "m8",
    permission: "m8.water_balance.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "sourceName", header: "Sumber air", width: 22 },
      { key: "daysWithProduction", header: "Hari berproduksi", type: "number", width: 10 },
      { key: "producedL", header: "Produksi", type: "liter", width: 14 },
      { key: "customerFillsL", header: "Pengisian pelanggan", type: "liter", width: 14 },
      { key: "depotSupplyL", header: "Pasokan depot", type: "liter", width: 14 },
      { key: "returnedL", header: "Air kembali", type: "liter", width: 10 },
      { key: "lossL", header: "Susut", type: "liter", width: 12 },
      { key: "lossPct", header: "Susut (%)", type: "percent", width: 10 },
      { key: "avgProducedPerDayL", header: "Rata-rata produksi/hari", type: "liter", width: 14 },
      { key: "avgLossPerDayL", header: "Rata-rata susut/hari", type: "liter", width: 12 },
      { key: "supplyDifferenceL", header: "Selisih pasokan depot", type: "liter", width: 12 },
      { key: "incompleteDays", header: "Hari belum lengkap", type: "number", width: 10 },
      { key: "overThresholdDays", header: "Hari susut > ambang", type: "number", width: 10 },
      { key: "negativeDays", header: "Hari susut negatif", type: "number", width: 10 },
    ],
    fetch: async (ctx, f: MonthFilters, { tx }) => ({
      rows: await computeMonthlyBalance(tx, ctx.tenantId, f.month ?? monthOf(ctxBusinessDate(ctx)), ctxBusinessDate(ctx), f.sourceId ?? null),
    }),
  });

  registerReport({
    key: "m8.utilization_daily",
    title: "Utilisasi kapasitas harian per sumber & gabungan (studi kapasitas K22)",
    module: "m8",
    permission: "m8.utilization.export",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: rangeSchema,
    describeFilters: describe,
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 12 },
      { key: "sourceName", header: "Sumber air", width: 24 },
      { key: "capacityL", header: "Kapasitas harian", type: "liter", width: 14 },
      { key: "filledL", header: "Σ pengisian", type: "liter", width: 14 },
      { key: "customerL", header: "Pengisian pelanggan", type: "liter", width: 14 },
      { key: "depotL", header: "Pasokan depot", type: "liter", width: 14 },
      { key: "fillCount", header: "Jumlah pengisian", type: "number", width: 10 },
      { key: "utilizationPct", header: "Utilisasi (%)", type: "percent", width: 10 },
      { key: "high", header: "Di atas ambang", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, f: RangeFilters, { tx }) => {
      const today = ctxBusinessDate(ctx);
      const rules = await m8Rules(tx, today, ctx.tenantId);
      const def = utilizationExportRange(today, rules.utilizationExportMonths);
      return { rows: await computeUtilizationDays(tx, ctx.tenantId, f.from ?? def.from, f.to ?? def.to, { sourceId: f.sourceId ?? null }) };
    },
  });

  registerReport({
    key: "m8.utilization_monthly",
    title: "Utilisasi kapasitas bulanan (rata-rata, hari di atas ambang, ruang tumbuh)",
    module: "m8",
    permission: "m8.utilization.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthSchema,
    describeFilters: describeMonth,
    columns: [
      { key: "sourceName", header: "Sumber air", width: 24 },
      { key: "capacityL", header: "Kapasitas harian", type: "liter", width: 14 },
      { key: "days", header: "Hari", type: "number", width: 8 },
      { key: "avgFilledL", header: "Rata-rata pengisian/hari", type: "liter", width: 14 },
      { key: "avgUtilizationPct", header: "Rata-rata utilisasi (%)", type: "percent", width: 12 },
      { key: "maxUtilizationPct", header: "Utilisasi tertinggi (%)", type: "percent", width: 12 },
      { key: "daysAboveThreshold", header: "Hari di atas ambang", type: "number", width: 10 },
      { key: "growthRoomL", header: "Ruang tumbuh (L/hari)", type: "liter", width: 14 },
      { key: "growthRoomTrips", header: "Setara rit/hari", type: "number", width: 10 },
    ],
    fetch: async (ctx, f: MonthFilters, { tx }) => ({
      rows: await computeUtilizationMonth(tx, ctx.tenantId, f.month ?? monthOf(ctxBusinessDate(ctx)), ctxBusinessDate(ctx), f.sourceId ?? null),
    }),
  });

  const dateSchema = z.object({ date: dateOpt, sourceId: z.uuid().optional() });
  registerReport({
    key: "m8.fills_vs_schedule",
    title: "Pengisian vs jadwal rit per truk",
    module: "m8",
    permission: "m8.truck_fill.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: dateSchema,
    describeFilters: (f: z.infer<typeof dateSchema>) => [`Tanggal: ${f.date ? formatTanggal(f.date) : "hari ini"}`],
    columns: [
      { key: "truckCode", header: "Truk", width: 8 },
      { key: "tripNumber", header: "Rit", width: 16 },
      { key: "customerName", header: "Pelanggan/depot", width: 24 },
      { key: "tripStatus", header: "Status rit", type: "enum", enumName: "trip_status", width: 12 },
      { key: "filledAtSource", header: "Diisi di", width: 20 },
      { key: "volumeL", header: "Volume isi", type: "liter", total: true, width: 12 },
      { key: "note", header: "Catatan", width: 30 },
    ],
    fetch: async (ctx, f: z.infer<typeof dateSchema>, { tx }) => {
      const date = f.date ?? ctxBusinessDate(ctx);
      const trucks = await fillsVsSchedule(ctx, { date, sourceId: f.sourceId ?? null }, { tx });
      const rows: Record<string, unknown>[] = [];
      for (const t of trucks) {
        for (const tr of t.trips) {
          rows.push({
            truckCode: t.truckCode,
            tripNumber: tr.number,
            customerName: tr.customerName,
            tripStatus: tr.status,
            filledAtSource: tr.fill?.sourceName ?? null,
            volumeL: tr.fill?.volumeL ?? null,
            note: tr.fill ? null : "Belum diisi",
          });
        }
        for (const fw of t.fillsWithoutTrip) {
          rows.push({ truckCode: t.truckCode, tripNumber: null, customerName: null, tripStatus: null, filledAtSource: fw.sourceName, volumeL: fw.volumeL, note: "Pengisian tanpa rit" });
        }
      }
      return { rows };
    },
  });

  const qualitySchema = z.object({ locationId: z.uuid().optional() });
  registerReport({
    key: "m8.quality_tests",
    title: "Riwayat uji mutu air per lokasi (hasil, tindakan)",
    module: "m8",
    permission: "m8.quality_test.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: qualitySchema,
    describeFilters: (f: z.infer<typeof qualitySchema>) => (f.locationId ? ["Satu lokasi"] : ["Semua lokasi"]),
    columns: [
      { key: "testDate", header: "Tanggal uji", type: "date", width: 12 },
      { key: "locationName", header: "Lokasi", width: 24 },
      { key: "laboratory", header: "Laboratorium", width: 20 },
      { key: "passed", header: "Lulus", type: "boolean", width: 8 },
      { key: "summary", header: "Parameter & nilai", width: 40 },
      { key: "actionRequired", header: "Tindakan", width: 28 },
      { key: "actionOwnerName", header: "Penanggung jawab", width: 18 },
      { key: "actionDueDate", header: "Tenggat", type: "date", width: 12 },
      { key: "actionDone", header: "Tindakan selesai", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, f: z.infer<typeof qualitySchema>, { tx }) => {
      const { tests } = await qualityOverview(ctx, { locationId: f.locationId ?? null }, { tx });
      return {
        rows: tests.map((t) => ({
          ...t,
          summary: ((t.results ?? []) as { parameter?: string; value?: string; unit?: string | null; passed?: boolean }[])
            .map((r) => `${r.parameter}: ${r.value}${r.unit ? ` ${r.unit}` : ""}${r.passed === false ? " (tidak lulus)" : ""}`)
            .join("; "),
          actionDone: !!t.actionDoneAt,
        })),
      };
    },
  });
}
