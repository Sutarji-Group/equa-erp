/**
 * M6 — registrasi jejak audit & lampiran (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { consumableReceipts } from "@/db/schema";
import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { can, inOutletScope } from "@/server/core/rbac";
import { registerAttachmentAccess } from "@/server/core/storage";

export function registerAudit(): void {
  registerAuditObjectLabel("shift", "Shift POS");
  registerAuditObjectLabel("pos_sale", "Transaksi POS");
  registerAuditObjectLabel("stock_count", "Opname");
  registerAuditObjectLabel("consumable_receipt", "Penerimaan bahan habis pakai");
  registerAuditObjectLabel("water_supply_receipt", "Penerimaan pasokan air depot");
  registerAuditObjectLabel("internal_transfer", "Transfer internal");
  registerAuditObjectLabel("tenant", "Tenant");

  registerAuditFieldLabel("shift", "openingCashFixed", { label: "Kas awal tetap", format: "rupiah" });
  registerAuditFieldLabel("shift", "openingCashCounted", { label: "Kas awal (hitung fisik)", format: "rupiah" });
  registerAuditFieldLabel("shift", "expectedCash", { label: "Tunai seharusnya", format: "rupiah" });
  registerAuditFieldLabel("shift", "closingCashCounted", { label: "Kas fisik tutup shift", format: "rupiah" });
  registerAuditFieldLabel("shift", "cashDifference", { label: "Selisih kas", format: "rupiah" });
  registerAuditFieldLabel("shift", "depositAmount", { label: "Jumlah disetor", format: "rupiah" });
  registerAuditFieldLabel("shift", "depositStatus", { label: "Status setoran", format: "enum:shift_deposit_status" });
  registerAuditFieldLabel("pos_sale", "total", { label: "Total", format: "rupiah" });
  registerAuditFieldLabel("pos_sale", "status", { label: "Status", format: "enum:pos_sale_status" });
  registerAuditFieldLabel("pos_sale", "paymentMethod", { label: "Cara bayar", format: "enum:payment_method" });
  registerAuditFieldLabel("water_supply_receipt", "receivedVolumeL", { label: "Volume diterima", format: "liter" });
  registerAuditFieldLabel("water_supply_receipt", "status", { label: "Status", format: "enum:water_supply_status" });
  registerAuditFieldLabel("stock_count", "status", { label: "Status", format: "enum:stock_count_status" });

  registerFinancialObjectType("shift");
  registerFinancialObjectType("pos_sale");
  registerFinancialObjectType("consumable_receipt");
  registerFinancialObjectType("stock_count");

  // Foto nota pemasok: kantor berizin baca outlet (lingkup tenant) atau operator outlet itu.
  registerAttachmentAccess("consumable_receipt", {
    permission: ["m6.outlet.read", "m6.shift.read"],
    check: async (tx, ctx, row) => {
      if (!row.objectId) return false;
      const [r] = await tx.select({ outletId: consumableReceipts.outletId, tenantId: consumableReceipts.tenantId }).from(consumableReceipts).where(eq(consumableReceipts.id, row.objectId)).limit(1);
      if (!r || r.tenantId !== ctx.tenantId) return false;
      return can(ctx, "m6.outlet.read") ? inOutletScope(ctx, r.outletId, r.tenantId) : ctx.scope.outletIds.includes(r.outletId);
    },
  });
}
