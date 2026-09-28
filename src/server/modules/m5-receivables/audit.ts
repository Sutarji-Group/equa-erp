/**
 * M5 — registrasi jejak audit & lampiran Piutang (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 * Hanya MENAMBAH label baru (label objek `invoice`, `customer_payment`, `credit_note`, kolom `*.amount`,
 * `*.creditStatus` sudah ada di inti/M3 — tidak ditimpa).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { invoices } from "@/db/schema";
import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { can } from "@/server/core/rbac";
import { registerAttachmentAccess } from "@/server/core/storage";

export function registerAudit(): void {
  registerAuditObjectLabel("customer_advance", "uang muka pelanggan");
  registerAuditObjectLabel("unbilled_charge", "rit belum ditagih");
  registerAuditObjectLabel("receivable_reminder", "pengingat jatuh tempo");

  registerAuditFieldLabel("invoice", "outstandingAmount", { label: "sisa faktur", format: "rupiah" });
  registerAuditFieldLabel("invoice", "writtenOffAmount", { label: "dihapusbukukan", format: "rupiah" });
  registerAuditFieldLabel("invoice", "dueDate", { label: "jatuh tempo", format: "date" });
  registerAuditFieldLabel("invoice", "issueDate", { label: "tanggal faktur", format: "date" });
  registerAuditFieldLabel("invoice", "kind", { label: "jenis faktur", format: "enum:invoice_kind" });
  registerAuditFieldLabel("invoice", "disputeStatus", { label: "sengketa", format: "enum:dispute_status" });
  registerAuditFieldLabel("invoice", "disputeUntil", { label: "penundaan sengketa sampai", format: "date" });
  registerAuditFieldLabel("customer_payment", "advanceAmount", { label: "uang muka", format: "rupiah" });
  registerAuditFieldLabel("customer_payment", "method", { label: "cara bayar", format: "enum:payment_method" });
  registerAuditFieldLabel("customer_payment", "channel", { label: "kanal pelunasan", format: "enum:payment_channel" });
  registerAuditFieldLabel("customer_advance", "remainingAmount", { label: "sisa uang muka", format: "rupiah" });
  registerAuditFieldLabel("customer", "holdDeferralUntil", { label: "masa transisi sampai", format: "date" });
  registerAuditFieldLabel("customer", "holdReleaseCoversDueUntil", { label: "pembukaan Ditahan berlaku untuk jatuh tempo s.d.", format: "date" });
  registerAuditFieldLabel("customer", "monthlyBilling", { label: "tagihan bulanan", format: "boolean" });

  registerFinancialObjectType("unbilled_charge");
  registerFinancialObjectType("receivable_reminder");

  // Bukti konfirmasi saldo awal & dokumen faktur (objek `invoice`). Bukti transfer pelunasan (objek `customer_payment`)
  // didaftarkan M3 (`m3.payment_report.read` / `m4.deposit.read`); pemilik & Admin Keuangan selalu boleh.
  registerAttachmentAccess("invoice", {
    permission: ["m5.invoice.read", "m5.opening_balance.read"],
    check: async (tx, ctx, row) => {
      if (!row.objectId) return false;
      const [inv] = await tx.select({ tenantId: invoices.tenantId }).from(invoices).where(eq(invoices.id, row.objectId)).limit(1);
      return !!inv && inv.tenantId === ctx.tenantId && (can(ctx, "m5.invoice.read") || can(ctx, "m5.opening_balance.read"));
    },
  });
}
