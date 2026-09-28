/**
 * M7 — registrasi jejak audit & lampiran toko (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { purchaseReceipts, supplierPayments } from "@/db/schema";
import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { can, inOutletScope } from "@/server/core/rbac";
import { registerAttachmentAccess } from "@/server/core/storage";

export function registerAudit(): void {
  registerAuditObjectLabel("purchase_receipt", "Nota pembelian toko");
  registerAuditObjectLabel("supplier", "Pemasok");
  registerAuditObjectLabel("supplier_payment", "Pembayaran pemasok");
  registerAuditObjectLabel("reorder_item", "Daftar pesan ulang");
  registerAuditObjectLabel("product_price", "Harga produk");
  registerAuditObjectLabel("store_return", "Retur barang toko");

  registerAuditFieldLabel("purchase_receipt", "totalAmount", { label: "Total nota", format: "rupiah" });
  registerAuditFieldLabel("purchase_receipt", "amount", { label: "Nilai", format: "rupiah" });
  registerAuditFieldLabel("purchase_receipt", "status", { label: "Status", format: "enum:purchase_receipt_status" });
  registerAuditFieldLabel("purchase_receipt", "dueDate", { label: "Jatuh tempo", format: "date" });
  registerAuditFieldLabel("purchase_receipt", "supplierNoteDate", { label: "Tanggal nota", format: "date" });
  registerAuditFieldLabel("supplier_payment", "amount", { label: "Jumlah bayar", format: "rupiah" });
  registerAuditFieldLabel("supplier_payment", "method", { label: "Cara bayar", format: "enum:payment_method" });
  registerAuditFieldLabel("supplier", "status", { label: "Status", format: "enum:supplier_status" });
  registerAuditFieldLabel("reorder_item", "status", { label: "Status", format: "enum:reorder_status" });
  registerAuditFieldLabel("pos_sale", "discountAmount", { label: "Diskon", format: "rupiah" });
  registerAuditFieldLabel("pos_sale", "subtotal", { label: "Subtotal", format: "rupiah" });
  registerAuditFieldLabel("internal_transfer", "totalValue", { label: "Nilai (harga mitra)", format: "rupiah" });
  registerAuditFieldLabel("internal_transfer", "totalCost", { label: "HPP toko", format: "rupiah" });

  registerFinancialObjectType("purchase_receipt");
  registerFinancialObjectType("supplier_payment");
  registerFinancialObjectType("internal_transfer");
  registerFinancialObjectType("store_return");

  // Foto nota / foto barang nota pengganti: kantor berizin baca nota (lingkup toko) atau kasir toko itu.
  registerAttachmentAccess("purchase_receipt", {
    permission: ["m7.purchase_receipt.read", "m7.supplier_payable.read"],
    check: async (tx, ctx, row) => {
      if (!row.objectId) return false;
      const [r] = await tx.select({ outletId: purchaseReceipts.outletId, tenantId: purchaseReceipts.tenantId }).from(purchaseReceipts).where(eq(purchaseReceipts.id, row.objectId)).limit(1);
      if (!r || r.tenantId !== ctx.tenantId) return false;
      return can(ctx, "m7.supplier_payable.read") || inOutletScope(ctx, r.outletId, r.tenantId);
    },
  });
  // Bukti transfer pembayaran pemasok: pemilik, Admin Keuangan, akuntan (izin utang pemasok).
  registerAttachmentAccess("supplier_payment", {
    permission: "m7.supplier_payable.read",
    check: async (tx, ctx, row) => {
      if (!row.objectId) return false;
      const [p] = await tx.select({ tenantId: supplierPayments.tenantId }).from(supplierPayments).where(eq(supplierPayments.id, row.objectId)).limit(1);
      return !!p && p.tenantId === ctx.tenantId;
    },
  });
}
