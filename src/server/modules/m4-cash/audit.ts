/**
 * M4 — registrasi jejak audit & lampiran (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 *
 * Objek keuangan (US-M10-06 KP-1: akuntan melihat; admin sistem tanpa nilai): selisih, transfer masuk, setor bank, mutasi
 * kas kantor, kas kecil, hari kas, ganti rugi, pelunasan ganti rugi, pengecualian tutup kas, impor mutasi. Label objek
 * `deposit` & akses lampiran slip setoran didaftarkan M3.
 * Lampiran: slip setor bank (`bank_deposit`), foto bukti kas kecil (`petty_cash_transaction`), berkas mutasi
 * (`bank_statement_import`), bukti selisih (`discrepancy`) — pemilik/Admin Keuangan/akuntan berizin baca kas.
 */
import "server-only";

import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { registerAttachmentAccess } from "@/server/core/storage";

export function registerAudit(): void {
  const labels: [string, string][] = [
    ["discrepancy", "selisih"],
    ["incoming_transfer", "transfer masuk"],
    ["bank_statement_import", "impor mutasi bank"],
    ["bank_statement_line", "baris mutasi bank"],
    ["bank_account", "rekening bank"],
    ["bank_deposit", "setor ke bank"],
    ["office_cash_movement", "mutasi kas kantor"],
    ["petty_cash_transaction", "kas kecil"],
    ["petty_cash_count", "hitung fisik kas kecil"],
    ["cash_day", "hari kas"],
    ["cash_close_exception", "pengecualian tutup kas"],
    ["restitution", "ganti rugi karyawan"],
    ["restitution_settlement", "pelunasan ganti rugi"],
  ];
  for (const [type, text] of labels) registerAuditObjectLabel(type, text);

  registerAuditFieldLabel("deposit", "receivedAmount", { label: "diterima", format: "rupiah" });
  registerAuditFieldLabel("deposit", "discrepancyAmount", { label: "selisih", format: "rupiah" });
  registerAuditFieldLabel("deposit", "acceptedExpenses", { label: "pengeluaran diterima", format: "rupiah" });
  registerAuditFieldLabel("deposit", "receivedLate", { label: "diterima terlambat", format: "boolean" });
  registerAuditFieldLabel("discrepancy", "status", { label: "status selisih", format: "enum:discrepancy_status" });
  registerAuditFieldLabel("discrepancy", "amount", { label: "selisih", format: "rupiah" });
  registerAuditFieldLabel("discrepancy", "reason", { label: "alasan", format: "enum:discrepancy_reason" });
  registerAuditFieldLabel("discrepancy", "decision", { label: "keputusan", format: "enum:discrepancy_decision" });
  registerAuditFieldLabel("incoming_transfer", "status", { label: "status transfer", format: "enum:incoming_transfer_status" });
  registerAuditFieldLabel("incoming_transfer", "matchRefAmount", { label: "jumlah mutasi", format: "rupiah" });
  registerAuditFieldLabel("incoming_transfer", "matchRefDate", { label: "tanggal mutasi", format: "date" });
  registerAuditFieldLabel("bank_deposit", "amount", { label: "jumlah setor", format: "rupiah" });
  registerAuditFieldLabel("office_cash_movement", "amount", { label: "jumlah", format: "rupiah" });
  registerAuditFieldLabel("office_cash_movement", "kind", { label: "jenis", format: "enum:office_cash_kind" });
  registerAuditFieldLabel("petty_cash_transaction", "amount", { label: "jumlah", format: "rupiah" });
  registerAuditFieldLabel("petty_cash_transaction", "status", { label: "status", format: "enum:petty_cash_status" });
  registerAuditFieldLabel("petty_cash_count", "difference", { label: "selisih", format: "rupiah" });
  registerAuditFieldLabel("cash_day", "officeCashDifference", { label: "selisih kas kantor", format: "rupiah" });
  registerAuditFieldLabel("cash_day", "closedLate", { label: "ditutup terlambat", format: "boolean" });
  registerAuditFieldLabel("restitution", "settledAmount", { label: "sudah dilunasi", format: "rupiah" });
  registerAuditFieldLabel("restitution", "status", { label: "status ganti rugi", format: "enum:restitution_status" });

  for (const type of [
    "discrepancy",
    "incoming_transfer",
    "bank_deposit",
    "office_cash_movement",
    "petty_cash_transaction",
    "petty_cash_count",
    "cash_day",
    "cash_close_exception",
    "restitution",
    "restitution_settlement",
    "bank_statement_import",
    "bank_statement_line",
    "bank_account",
  ]) {
    registerFinancialObjectType(type);
  }

  registerAttachmentAccess("bank_deposit", { permission: ["m4.office_cash.read", "m4.incoming_transfer.read"] });
  registerAttachmentAccess("petty_cash_transaction", { permission: "m4.petty_cash.read" });
  registerAttachmentAccess("bank_statement_import", { permission: "m4.incoming_transfer.read" });
  registerAttachmentAccess("discrepancy", { permission: "m4.discrepancy.read" });
}
