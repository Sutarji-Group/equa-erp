/**
 * M9 — registrasi jejak audit & lampiran (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 * - Label objek: ringkasan H+0, snapshot laporan (Final), input KPI, periode paralel & lembar pencocokan.
 * - Objek keuangan (akuntan melihat; admin sistem tanpa nilai): ringkasan H+0 & snapshot laporan bulanan.
 * - Lampiran berkas laporan Final (`report_snapshot`, US-M9-03 KP-4): dibaca siapa pun yang berhak laporan bulanan.
 */
import "server-only";

import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { registerAttachmentAccess } from "@/server/core/storage";

export function registerAudit(): void {
  registerAuditObjectLabel("daily_summary", "Ringkasan H+0");
  registerAuditObjectLabel("report_snapshot", "Laporan Final (snapshot)");
  registerAuditObjectLabel("kpi_manual_input", "Input KPI manual");
  registerAuditObjectLabel("unit_paper_withdrawal", "Periode paralel & tarik nota kertas");
  registerAuditObjectLabel("parallel_run_check", "Lembar pencocokan periode paralel");
  registerAuditFieldLabel("daily_summary", "externalRevenue", { label: "Omzet luar", format: "rupiah" });
  registerAuditFieldLabel("daily_summary", "cashDiscrepancy", { label: "Selisih kas", format: "rupiah" });
  registerAuditFieldLabel("daily_summary", "publishedLate", { label: "Terbit terlambat", format: "boolean" });
  registerAuditFieldLabel("parallel_run_check", "paperAmount", { label: "Nilai nota kertas", format: "rupiah" });
  registerAuditFieldLabel("parallel_run_check", "systemAmount", { label: "Nilai sistem", format: "rupiah" });
  registerAuditFieldLabel("parallel_run_check", "differenceAmount", { label: "Selisih nilai", format: "rupiah" });
  registerAuditFieldLabel("unit_paper_withdrawal", "withdrawnDate", { label: "Tanggal tarik nota kertas", format: "date" });
  registerFinancialObjectType("daily_summary");
  registerFinancialObjectType("report_snapshot");
  registerAttachmentAccess("report_snapshot", {
    permission: ["m9.monthly_report.read"],
    check: async (_tx, ctx, row) => !row.tenantId || row.tenantId === ctx.tenantId,
  });
}
