/**
 * P2 — registrasi jejak audit & lampiran (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 *
 * Tindakan pelanggan dicatat dengan sumber `customer_app` (pelaku "Sistem" + `customerAccountId` di nilai baru).
 * Pembayaran digital = objek keuangan (akuntan melihat; admin sistem tanpa nilai, US-M10-06 KP-1). Lampiran foto
 * keluhan dibaca kantor berizin `p2.complaint.read` dalam tenant yang sama; pelanggan membaca foto miliknya lewat
 * `/api/customer/lampiran/<id>` (kepemilikan diperiksa P2).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { complaints } from "@/db/schema";
import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { registerAttachmentAccess } from "@/server/core/storage";

export function registerAudit(): void {
  registerAuditObjectLabel("customer_account", "Akun aplikasi pelanggan");
  registerAuditObjectLabel("complaint", "Keluhan pelanggan");
  registerAuditObjectLabel("trip_rating", "Penilaian pengiriman");
  registerAuditObjectLabel("payment_intent", "Pembayaran digital");

  registerAuditFieldLabel("customer_account", "status", { label: "Status akun", format: "enum:customer_account_status" });
  registerAuditFieldLabel("customer_account", "customerId", { label: "Pelanggan tertaut" });
  registerAuditFieldLabel("customer_account", "phone", { label: "Nomor WA (disamarkan)" });
  registerAuditFieldLabel("customer_account", "consentVersion", { label: "Versi persetujuan UU PDP" });
  registerAuditFieldLabel("complaint", "status", { label: "Status keluhan", format: "enum:complaint_status" });
  registerAuditFieldLabel("complaint", "kind", { label: "Jenis keluhan", format: "enum:complaint_kind" });
  registerAuditFieldLabel("complaint", "box", { label: "Kotak keluhan", format: "enum:complaint_box" });
  registerAuditFieldLabel("trip_rating", "rating", { label: "Nilai (1–5)" });
  registerAuditFieldLabel("payment_intent", "amount", { label: "Jumlah", format: "rupiah" });
  registerAuditFieldLabel("payment_intent", "gatewayFee", { label: "Biaya gerbang", format: "rupiah" });
  registerAuditFieldLabel("payment_intent", "advanceAmount", { label: "Menjadi uang muka", format: "rupiah" });
  registerAuditFieldLabel("payment_intent", "status", { label: "Status pembayaran", format: "enum:payment_intent_status" });
  registerAuditFieldLabel("payment_intent", "method", { label: "Metode", format: "enum:payment_intent_method" });

  registerFinancialObjectType("payment_intent");

  registerAttachmentAccess("complaint", {
    permission: "p2.complaint.read",
    check: async (tx, ctx, row) => {
      if (!row.objectId) return false;
      const [c] = await tx.select({ tenantId: complaints.tenantId }).from(complaints).where(eq(complaints.id, row.objectId)).limit(1);
      return !!c && c.tenantId === ctx.tenantId;
    },
  });
}
