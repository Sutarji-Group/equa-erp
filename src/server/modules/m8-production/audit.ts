/**
 * M8 — registrasi jejak audit & lampiran (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 *
 * Objek M8 berupa volume (liter), bukan uang → tidak ada `registerFinancialObjectType` (nilai pasokan depot adalah
 * penerimaan M6). Lampiran: foto meter, foto pengisian, foto investigasi susut, foto tandon, sertifikat uji mutu, foto
 * putaran/penggantian meter — dibaca kantor berizin (lingkup tenant) atau operator sumber itu.
 */
import "server-only";

import { eq } from "drizzle-orm";

import { meterAdjustments, meterReadings, qualityTests, tankLevelReadings, truckFills, waterBalances } from "@/db/schema";
import { registerAuditFieldLabel, registerAuditObjectLabel } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { inOutletScope, inSourceScope } from "@/server/core/rbac";
import { registerAttachmentAccess, type AttachmentRow } from "@/server/core/storage";

type SourceRef = { waterSourceId: string | null; tenantId: string; outletId?: string | null };

function sourceCheck(load: (tx: Tx, id: string) => Promise<SourceRef | undefined>) {
  return async (tx: Tx, ctx: ActorContext, row: AttachmentRow): Promise<boolean> => {
    if (!row.objectId) return false;
    const ref = await load(tx, row.objectId);
    if (!ref || ref.tenantId !== ctx.tenantId) return false;
    if (ref.waterSourceId) return inSourceScope(ctx, ref.waterSourceId, ref.tenantId);
    if (ref.outletId) return inOutletScope(ctx, ref.outletId, ref.tenantId);
    return ctx.scope.tenantIds.includes(ref.tenantId);
  };
}

export function registerAudit(): void {
  registerAuditObjectLabel("meter_reading", "Pembacaan meter");
  registerAuditObjectLabel("daily_production", "Produksi harian");
  registerAuditObjectLabel("truck_fill", "Pengisian truk");
  registerAuditObjectLabel("water_balance", "Neraca air harian");
  registerAuditObjectLabel("tank_level_reading", "Level tandon");
  registerAuditObjectLabel("meter_adjustment", "Putaran/penggantian meter");
  registerAuditObjectLabel("quality_test_schedule", "Jadwal uji mutu air");
  registerAuditObjectLabel("quality_test", "Hasil uji mutu air");
  registerAuditObjectLabel("depot_water_opening", "Stok air awal depot (cut-over)");

  registerAuditFieldLabel("meter_reading", "readingL", { label: "Angka meter", format: "liter" });
  registerAuditFieldLabel("meter_reading", "phase", { label: "Pembacaan", format: "enum:meter_phase" });
  registerAuditFieldLabel("meter_reading", "status", { label: "Status", format: "enum:meter_reading_status" });
  registerAuditFieldLabel("meter_reading", "lateReason", { label: "Alasan terlambat" });
  registerAuditFieldLabel("daily_production", "producedL", { label: "Produksi", format: "liter" });
  registerAuditFieldLabel("daily_production", "status", { label: "Status produksi", format: "enum:production_status" });
  registerAuditFieldLabel("daily_production", "flaggedForVerification", { label: "Perlu verifikasi" });
  registerAuditFieldLabel("truck_fill", "volumeL", { label: "Volume pengisian", format: "liter" });
  registerAuditFieldLabel("truck_fill", "status", { label: "Status pengisian", format: "enum:truck_fill_status" });
  registerAuditFieldLabel("truck_fill", "volumeReason", { label: "Alasan volume" });
  registerAuditFieldLabel("water_balance", "producedL", { label: "Produksi", format: "liter" });
  registerAuditFieldLabel("water_balance", "filledTotalL", { label: "Σ pengisian", format: "liter" });
  registerAuditFieldLabel("water_balance", "lossL", { label: "Susut", format: "liter" });
  registerAuditFieldLabel("water_balance", "lossPct", { label: "Susut (%)", format: "percent" });
  registerAuditFieldLabel("water_balance", "status", { label: "Status neraca", format: "enum:water_balance_status" });
  registerAuditFieldLabel("water_balance", "investigationReason", { label: "Alasan susut", format: "enum:loss_reason" });
  registerAuditFieldLabel("tank_level_reading", "levelL", { label: "Level tandon", format: "liter" });
  registerAuditFieldLabel("quality_test", "passed", { label: "Lulus" });
  registerAuditFieldLabel("depot_water_opening", "volumeL", { label: "Stok air awal", format: "liter" });
  registerAuditFieldLabel("depot_water_opening", "balanceAfterL", { label: "Saldo buku air", format: "liter" });
  registerAuditFieldLabel("quality_test_schedule", "nextDueDate", { label: "Uji berikutnya", format: "date" });

  const readPerms = ["m8.production.read", "m8.water_balance.read", "m8.truck_fill.read"] as const;

  registerAttachmentAccess("meter_reading", {
    permission: [...readPerms, "m8.meter_reading.create", "m1.water_meter.update"],
    check: sourceCheck(async (tx, id) => (await tx.select({ waterSourceId: meterReadings.waterSourceId, tenantId: meterReadings.tenantId }).from(meterReadings).where(eq(meterReadings.id, id)).limit(1))[0]),
  });
  registerAttachmentAccess("truck_fill", {
    permission: [...readPerms, "m8.truck_fill.create"],
    check: sourceCheck(async (tx, id) => (await tx.select({ waterSourceId: truckFills.waterSourceId, tenantId: truckFills.tenantId }).from(truckFills).where(eq(truckFills.id, id)).limit(1))[0]),
  });
  registerAttachmentAccess("water_balance", {
    permission: ["m8.water_balance.read", "m8.loss_investigation.create"],
    check: sourceCheck(async (tx, id) => (await tx.select({ waterSourceId: waterBalances.waterSourceId, tenantId: waterBalances.tenantId }).from(waterBalances).where(eq(waterBalances.id, id)).limit(1))[0]),
  });
  registerAttachmentAccess("tank_level_reading", {
    permission: [...readPerms, "m8.tank_level.create"],
    check: sourceCheck(async (tx, id) => (await tx.select({ waterSourceId: tankLevelReadings.waterSourceId, tenantId: tankLevelReadings.tenantId }).from(tankLevelReadings).where(eq(tankLevelReadings.id, id)).limit(1))[0]),
  });
  registerAttachmentAccess("meter_adjustment", {
    permission: [...readPerms, "m1.water_meter.update"],
    check: sourceCheck(async (tx, id) => (await tx.select({ waterSourceId: meterAdjustments.waterSourceId, tenantId: meterAdjustments.tenantId }).from(meterAdjustments).where(eq(meterAdjustments.id, id)).limit(1))[0]),
  });
  registerAttachmentAccess("quality_test", {
    permission: ["m8.quality_test.read", "m8.quality_test.create"],
    check: sourceCheck(
      async (tx, id) =>
        (await tx.select({ waterSourceId: qualityTests.waterSourceId, outletId: qualityTests.outletId, tenantId: qualityTests.tenantId }).from(qualityTests).where(eq(qualityTests.id, id)).limit(1))[0],
    ),
  });
}
