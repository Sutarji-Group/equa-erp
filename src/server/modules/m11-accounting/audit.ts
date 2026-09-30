/**
 * M11 — registrasi jejak audit & lampiran: label objek akuntansi (semua objek keuangan → akuntan melihat, admin sistem
 * tanpa nilai, US-M10-06 KP-1); lampiran bukti jurnal manual dapat dibaca pemegang izin baca jurnal (pemilik, Admin
 * Keuangan, akuntan).
 */
import "server-only";

import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { registerAttachmentAccess } from "@/server/core/storage";

export function registerAudit(): void {
  const labels: [string, string][] = [
    ["account", "akun"],
    ["event_account_mapping", "pemetaan jurnal otomatis"],
    ["journal", "jurnal"],
    ["journal_queue", "daftar tunggu jurnal"],
    ["accounting_period", "periode akuntansi"],
    ["fixed_asset", "aset tetap"],
    ["bank_reconciliation", "rekonsiliasi bank"],
    ["cash_reconciliation", "rekonsiliasi kas"],
    ["tax_setting", "skema pajak"],
    ["export_template", "template ekspor konsultan"],
    ["opening_balance_batch", "saldo awal"],
    ["opening_balance", "saldo awal (pengesahan akuntan)"],
    ["cost_allocation_run", "alokasi biaya"],
    ["recurring_journal", "jurnal berulang"],
    ["retroactive_run", "jurnal retroaktif"],
    ["journal_payable", "utang jurnal manual"],
    // Integrasi S5-B: objek persetujuan `opening_balance_adjustment` (nilai aset impor, B) tampil berlabel di /persetujuan (A).
    ["opening_adjustment_journal", "jurnal penyesuaian saldo awal"],
  ];
  for (const [type, text] of labels) {
    registerAuditObjectLabel(type, text);
    registerFinancialObjectType(type);
  }
  registerAuditFieldLabel("journal", "status", { label: "status jurnal", format: "enum:journal_status" });
  registerAuditFieldLabel("journal", "total", { label: "nilai", format: "rupiah" });
  registerAuditFieldLabel("journal", "amount", { label: "nilai", format: "rupiah" });
  registerAuditFieldLabel("accounting_period", "status", { label: "status periode", format: "enum:period_status" });
  registerAuditFieldLabel("account", "isActive", { label: "aktif", format: "boolean" });
  registerAuditFieldLabel("account", "profitCenter", { label: "pusat laba", format: "enum:profit_center" });
  registerAuditFieldLabel("fixed_asset", "usefulLifeMonths", { label: "umur (bulan)", format: "text" });
  registerAuditFieldLabel("fixed_asset", "acquisitionCost", { label: "nilai perolehan", format: "rupiah" });
  registerAuditFieldLabel("fixed_asset", "residualValue", { label: "nilai sisa", format: "rupiah" });
  registerAuditFieldLabel("bank_reconciliation", "difference", { label: "selisih", format: "rupiah" });
  registerAuditFieldLabel("cash_reconciliation", "difference", { label: "selisih", format: "rupiah" });

  registerAttachmentAccess("journal", { permission: "m11.journal.read" });
}
