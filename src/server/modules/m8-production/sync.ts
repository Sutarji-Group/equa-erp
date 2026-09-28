/**
 * M8 — handler perintah sinkron aplikasi operator produksi (outbox offline, docs/ARCHITECTURE.md §7; US-M8-07) +
 * penyedia pull.
 *
 * | Perintah                        | Layanan                      | Izin                          |
 * |---------------------------------|------------------------------|-------------------------------|
 * | `m8.meter_reading.create`       | `recordMeterReading`         | m8.meter_reading.create       |
 * | `m8.truck_fill.create`          | `recordTruckFill`            | m8.truck_fill.create          |
 * | `m8.tank_level.create`          | `recordTankLevel`            | m8.tank_level.create          |
 * | `m8.loss_investigation.submit`  | `submitLossInvestigation`    | m8.loss_investigation.create  |
 * | `m8.quality_test.create`        | `recordQualityTestFromField` | m8.quality_test.create        |
 *
 * Idempoten: ID perintah = kunci `sync_commands`; objek memakai ID perangkat (pembacaan, pengisian, tandon, uji) →
 * pengiriman ulang tidak menggandakan data. Operator hanya mencatat di sumber air perangkatnya bila sumber itu dalam
 * lingkup tugasnya (US-M8-02 KP-5); rit yang bertabrakan dengan perubahan kantor → pengisian tetap dicatat + `conflict`.
 * Pull: `m8.today` (operator produksi).
 */
import "server-only";

import { registerPullProvider, registerSyncHandler } from "@/server/core/sync";

import { M8_COMMANDS, M8_REFS } from "@/client/m8-production/contract";

import { lossInvestigationSchema, submitLossInvestigation } from "./service/balance";
import { fromSyncMeta } from "./service/common";
import { recordTruckFill, truckFillSchema } from "./service/fills";
import { meterReadingSchema, recordMeterReading } from "./service/meters";
import { buildProductionToday } from "./service/pull";
import { qualityTestFieldSchema, recordQualityTestFromField } from "./service/quality";
import { recordTankLevel, tankLevelSchema } from "./service/tank";

export function registerSync(): void {
  registerSyncHandler(M8_COMMANDS.meterReading, {
    permission: "m8.meter_reading.create",
    schema: meterReadingSchema,
    labels: { waterMeterId: "Meter", phase: "Pagi/malam", readingL: "Angka meter", lateReason: "Alasan terlambat" },
    description: "Pembacaan meter pagi/malam + foto (US-M8-01).",
    handle: async (ctx, p, meta) => {
      const res = await recordMeterReading(ctx, p, fromSyncMeta(meta));
      return { objectType: "meter_reading", objectId: res.reading.id, result: { status: res.reading.status, duplicate: res.duplicate } };
    },
  });

  registerSyncHandler(M8_COMMANDS.truckFill, {
    permission: "m8.truck_fill.create",
    schema: truckFillSchema,
    labels: { truckId: "Truk", tripId: "Rit", volumeL: "Volume", volumeReason: "Alasan volume" },
    description: "Pengisian truk per rit (US-M8-02, US-M8-03).",
    handle: async (ctx, p, meta) => {
      const res = await recordTruckFill(ctx, p, fromSyncMeta(meta));
      const base = {
        objectType: "truck_fill",
        objectId: res.fill.id,
        result: { status: res.fill.status, tripId: res.fill.tripId, isDepotSupply: res.fill.isDepotSupply, unplannedTruck: res.fill.unplannedTruck, duplicate: res.duplicate },
      };
      return res.conflict ? { ...base, status: "conflict" as const, message: res.conflict } : base;
    },
  });

  registerSyncHandler(M8_COMMANDS.tankLevel, {
    permission: "m8.tank_level.create",
    schema: tankLevelSchema,
    labels: { levelL: "Level tandon (L)", levelPct: "Level tandon (%)" },
    description: "Level tandon opsional (US-M8-04 KP-3, PTB-41).",
    handle: async (ctx, p, meta) => {
      const res = await recordTankLevel(ctx, p, fromSyncMeta(meta));
      return { objectType: "tank_level_reading", objectId: res.row.id, result: { duplicate: res.duplicate } };
    },
  });

  registerSyncHandler(M8_COMMANDS.lossInvestigation, {
    permission: "m8.loss_investigation.create",
    schema: lossInvestigationSchema,
    labels: { waterBalanceId: "Neraca air", reason: "Alasan susut", note: "Keterangan" },
    description: "Investigasi susut di atas ambang (US-M8-04 KP-2, BR-26).",
    handle: async (ctx, p, meta) => {
      const res = await submitLossInvestigation(ctx, p, fromSyncMeta(meta));
      const base = { objectType: "water_balance", objectId: res.balance.id, result: { status: res.balance.status } };
      return res.conflict ? { ...base, status: "conflict" as const, message: res.conflict } : base;
    },
  });

  registerSyncHandler(M8_COMMANDS.qualityTest, {
    permission: "m8.quality_test.create",
    schema: qualityTestFieldSchema,
    labels: { testDate: "Tanggal uji", laboratory: "Laboratorium", results: "Hasil uji", action: "Tindakan" },
    description: "Hasil uji mutu air sumber + foto sertifikat (US-M8-06 KP-2).",
    handle: async (ctx, p, meta) => {
      const res = await recordQualityTestFromField(ctx, p, fromSyncMeta(meta));
      return { objectType: "quality_test", objectId: res.test.id, result: { passed: res.test.passed, duplicate: res.duplicate } };
    },
  });

  registerPullProvider(M8_REFS.today, {
    roles: ["production_operator"],
    fetch: ({ ctx, tx, since, now, device }) => buildProductionToday(tx, ctx, device, since, { now }),
  });
}
