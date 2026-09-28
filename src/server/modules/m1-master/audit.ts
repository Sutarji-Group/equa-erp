/**
 * M1 — registrasi jejak audit & lampiran milik modul ini (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 * Semua perubahan master berjejak (US-M1-01 KP-10, US-M1-04 KP-4, Bab 6.7).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { importBatches, waterMeters, waterSources } from "@/db/schema";
import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { inTenantScope } from "@/server/core/rbac";
import { registerAttachmentAccess } from "@/server/core/storage";

export function registerAudit(): void {
  registerAuditObjectLabel("tariff_zone", "zona tarif");
  registerAuditObjectLabel("tariff_zone_boundary", "batas zona tarif");
  registerAuditObjectLabel("tariff_zone_table", "tabel zona tarif");
  registerAuditObjectLabel("water_meter", "meter air");
  registerAuditObjectLabel("pool_location", "pool/garasi");
  registerAuditObjectLabel("import_batch", "batch impor data awal");
  registerAuditObjectLabel("import_batch_row", "baris impor data awal");
  registerAuditObjectLabel("data_signoff", "tanda tangan data awal");
  registerAuditObjectLabel("customer_legacy_price", "harga saat ini pelanggan (impor)");
  registerAuditObjectLabel("customer_credit_history", "riwayat status kredit");

  registerAuditFieldLabel("*", "segment", { label: "segmen", format: "enum:customer_segment" });
  registerAuditFieldLabel("*", "coordinateStatus", { label: "status koordinat", format: "enum:coordinate_status" });
  registerAuditFieldLabel("*", "zoneAssignment", { label: "pemetaan zona", format: "enum:zone_assignment" });
  registerAuditFieldLabel("*", "paymentTermDays", { label: "tempo (hari)" });
  registerAuditFieldLabel("*", "waPhone", { label: "nomor WA" });
  registerAuditFieldLabel("*", "exitDate", { label: "tanggal keluar", format: "date" });
  registerAuditFieldLabel("*", "hireDate", { label: "tanggal masuk", format: "date" });
  registerAuditFieldLabel("*", "validFrom", { label: "berlaku mulai", format: "date" });
  registerAuditFieldLabel("*", "reviewDate", { label: "tanggal tinjauan", format: "date" });
  registerAuditFieldLabel("*", "amountPerTrip", { label: "komponen BBM per rit", format: "rupiah" });
  registerAuditFieldLabel("*", "minDistanceM", { label: "batas bawah (m)" });
  registerAuditFieldLabel("*", "maxDistanceM", { label: "batas atas (m)" });
  registerAuditFieldLabel("*", "isStorePartner", { label: "mitra toko", format: "boolean" });
  registerAuditFieldLabel("truck", "defaultDriverEmployeeId", { label: "sopir default" });
  registerAuditFieldLabel("truck", "defaultHelperEmployeeId", { label: "kernet default" });

  // Harga & tarif = objek keuangan (akuntan melihat; admin sistem tanpa nilai — US-M10-06 KP-1).
  registerFinancialObjectType("zone_tariff");
  registerFinancialObjectType("fuel_component");
  registerFinancialObjectType("product_price");
  registerFinancialObjectType("special_price");
  registerFinancialObjectType("customer_legacy_price");

  // Foto angka awal meter (US-M1-04 KP-2).
  registerAttachmentAccess("water_meter", {
    permission: ["m1.water_source.read", "m8.production.read"],
    check: async (tx, ctx, row) => {
      const rows = await tx
        .select({ tenantId: waterSources.tenantId })
        .from(waterMeters)
        .innerJoin(waterSources, eq(waterSources.id, waterMeters.waterSourceId))
        .where(eq(waterMeters.id, row.objectId!))
        .limit(1);
      return !!rows[0] && inTenantScope(ctx, rows[0].tenantId);
    },
  });
  // Berkas impor data awal (US-M1-06 KP-1).
  registerAttachmentAccess("import_batch", {
    permission: ["m1.import.read", "m1.import.create"],
    check: async (tx, ctx, row) => {
      const rows = await tx.select({ tenantId: importBatches.tenantId }).from(importBatches).where(eq(importBatches.id, row.objectId!)).limit(1);
      return !!rows[0] && inTenantScope(ctx, rows[0].tenantId);
    },
  });
}
