/**
 * M3 — registrasi jejak audit & lampiran (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 *
 * Objek keuangan (US-M10-06 KP-1: akuntan melihat, admin sistem tanpa nilai): pembayaran rit, pengeluaran rit,
 * pelunasan lewat sopir, setoran sopir. Lampiran:
 * - foto bukti kirim / tanda tangan (objek `trip`) & foto rit gagal/kendala (`trip_incident`): kantor berizin baca rit
 *   (`m2.trip.read` / `m3.trip_incident.read`, lingkup tenant) atau kru truk itu (`m3.trip.read`, lingkup truk);
 * - bukti transfer (`trip_payment`, `customer_payment`), nota pengeluaran (`trip_expense`), slip setor (`deposit`):
 *   pemilik/Admin Keuangan/akuntan (`m3.payment_report.read`) + pengunggahnya (aturan inti).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { tripIncidents, trips } from "@/db/schema";
import { isUuid } from "@/lib/ids";
import type { ActorContext } from "@/server/core/context";
import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { can, inTruckScope } from "@/server/core/rbac";
import { registerAttachmentAccess } from "@/server/core/storage";

/** Pemilik & Admin Keuangan membaca semua lampiran rit (pengawasan, sama dengan aturan inti objek tak terdaftar). */
function isOversight(ctx: ActorContext): boolean {
  return ctx.roles.includes("owner") || ctx.roles.includes("finance_admin");
}

export function registerAudit(): void {
  registerAuditObjectLabel("trip_payment", "pembayaran rit");
  registerAuditObjectLabel("trip_expense", "pengeluaran rit");
  registerAuditObjectLabel("customer_payment", "pelunasan");
  registerAuditObjectLabel("deposit", "setoran");
  registerAuditObjectLabel("fleet_event", "kejadian armada");

  registerAuditFieldLabel("trip", "status", { label: "status rit", format: "enum:trip_status" });
  registerAuditFieldLabel("trip", "deliveredVolumeL", { label: "volume terkirim", format: "liter" });
  registerAuditFieldLabel("trip", "partialVolumeReason", { label: "alasan volume parsial", format: "enum:partial_volume_reason" });
  registerAuditFieldLabel("trip", "locationDeviation", { label: "penyimpangan lokasi", format: "enum:location_deviation" });
  registerAuditFieldLabel("trip", "failReason", { label: "alasan gagal", format: "enum:trip_fail_reason" });
  registerAuditFieldLabel("trip", "loadedWaterDisposition", { label: "tindak lanjut air dimuat", format: "enum:loaded_water_disposition" });
  registerAuditFieldLabel("trip_payment", "method", { label: "cara bayar", format: "enum:payment_method" });
  registerAuditFieldLabel("trip_payment", "expectedAmount", { label: "seharusnya", format: "rupiah" });
  registerAuditFieldLabel("trip_payment", "receivedAmount", { label: "diterima", format: "rupiah" });
  registerAuditFieldLabel("trip_payment", "underpaymentAmount", { label: "kurang bayar", format: "rupiah" });
  registerAuditFieldLabel("trip_expense", "amount", { label: "jumlah", format: "rupiah" });
  registerAuditFieldLabel("trip_expense", "kind", { label: "jenis", format: "enum:trip_expense_kind" });
  registerAuditFieldLabel("customer_payment", "amount", { label: "jumlah", format: "rupiah" });
  registerAuditFieldLabel("deposit", "status", { label: "status setoran", format: "enum:deposit_status" });
  registerAuditFieldLabel("deposit", "expectedCash", { label: "tunai seharusnya", format: "rupiah" });
  registerAuditFieldLabel("deposit", "expectedNet", { label: "seharusnya disetor", format: "rupiah" });

  registerFinancialObjectType("trip_payment");
  registerFinancialObjectType("trip_expense");
  registerFinancialObjectType("customer_payment");
  registerFinancialObjectType("deposit");

  registerAttachmentAccess("trip", {
    permission: ["m2.trip.read", "m3.trip_incident.read", "m3.trip.read"],
    check: async (tx, ctx, row) => {
      if (isOversight(ctx)) return true;
      if (!row.objectId || !isUuid(row.objectId)) return false;
      const t = (await tx.select({ truckId: trips.truckId, tenantId: trips.tenantId }).from(trips).where(eq(trips.id, row.objectId)).limit(1))[0];
      if (!t || t.tenantId !== ctx.tenantId) return false;
      if (can(ctx, "m2.trip.read") || can(ctx, "m3.trip_incident.read")) return true;
      return !!t.truckId && inTruckScope(ctx, t.truckId);
    },
  });
  registerAttachmentAccess("trip_incident", {
    permission: ["m2.trip.read", "m3.trip_incident.read", "m3.trip.read"],
    check: async (tx, ctx, row) => {
      if (isOversight(ctx)) return true;
      if (!row.objectId || !isUuid(row.objectId)) return false;
      const i = (await tx.select({ truckId: tripIncidents.truckId, tenantId: tripIncidents.tenantId }).from(tripIncidents).where(eq(tripIncidents.id, row.objectId)).limit(1))[0];
      if (!i || i.tenantId !== ctx.tenantId) return false;
      if (can(ctx, "m2.trip.read") || can(ctx, "m3.trip_incident.read")) return true;
      return !!i.truckId && inTruckScope(ctx, i.truckId);
    },
  });
  for (const objectType of ["trip_payment", "customer_payment", "trip_expense", "deposit"]) {
    registerAttachmentAccess(objectType, { permission: ["m3.payment_report.read", "m4.deposit.read"] });
  }
}
