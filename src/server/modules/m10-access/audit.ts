/**
 * M10 — registrasi jejak audit milik modul ini (label objek & kolom dalam bahasa lapangan, US-M10-05 KP-3).
 * M10 tidak memiliki lampiran maupun objek keuangan.
 */
import "server-only";

import { registerAuditFieldLabel, registerAuditObjectLabel } from "@/server/core/audit";

export function registerAudit(): void {
  registerAuditObjectLabel("support_ticket", "laporan kendala");
  registerAuditObjectLabel("incident", "insiden");
  registerAuditObjectLabel("access_review", "tinjauan hak akses");
  registerAuditObjectLabel("anonymization_request", "permintaan anonimisasi");
  registerAuditObjectLabel("backup_status_log", "catatan cadangan");
  registerAuditObjectLabel("data_signoff", "tanda tangan data awal");
  registerAuditObjectLabel("retention_run", "retensi data");
  registerAuditObjectLabel("access_summary", "ringkasan perubahan akses");
  registerAuditObjectLabel("delegation", "delegasi persetujuan");

  registerAuditFieldLabel("user", "status", { label: "status", format: "enum:user_status" });
  registerAuditFieldLabel("user_role", "status", { label: "status", format: "enum:grant_status" });
  registerAuditFieldLabel("user_role", "role", { label: "peran", format: "enum:role" });
  registerAuditFieldLabel("user_scope", "status", { label: "status", format: "enum:grant_status" });
  registerAuditFieldLabel("user_scope", "scopeType", { label: "jenis lingkup", format: "enum:scope_type" });
  registerAuditFieldLabel("device", "status", { label: "status", format: "enum:device_status" });
  registerAuditFieldLabel("device", "isSpare", { label: "status cadangan", format: "boolean" });
  registerAuditFieldLabel("device", "holderEmployeeId", { label: "pemegang" });
  registerAuditFieldLabel("support_ticket", "status", { label: "status", format: "enum:ticket_status" });
  registerAuditFieldLabel("incident", "status", { label: "status", format: "enum:incident_status" });
  registerAuditFieldLabel("anonymization_request", "status", { label: "status", format: "enum:anonymization_status" });
  registerAuditFieldLabel("access_review", "status", { label: "status", format: "enum:access_review_status" });
}
