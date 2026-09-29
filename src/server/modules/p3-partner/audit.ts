/**
 * P3 — registrasi jejak audit & lampiran (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 *
 * Lampiran objek P3 dalam tenant yang sama dibaca lewat `/api/attachments/<id>` dengan aturan di bawah; lampiran tenant
 * mitra yang dibuka pengguna EQUA (dan bukti kirim untuk pemilik mitra) lewat rute P3 (`service/attachments.ts`).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { partnerAudits, partnerSupportRequests, qualityChecklists } from "@/db/schema";
import { registerAuditFieldLabel, registerAuditObjectLabel, registerFinancialObjectType } from "@/server/core/audit";
import { registerAttachmentAccess } from "@/server/core/storage";

export function registerAudit(): void {
  registerAuditObjectLabel("partner_contract", "kontrak mitra");
  registerAuditObjectLabel("partner_prospect", "calon mitra");
  registerAuditObjectLabel("partner_survey", "survei lokasi mitra");
  registerAuditObjectLabel("partner_evaluation", "evaluasi berkala mitra");
  registerAuditObjectLabel("partner_sanction", "sanksi mitra");
  registerAuditObjectLabel("partner_support_request", "permintaan dukungan mitra");
  registerAuditObjectLabel("partner_monthly_report", "laporan bulanan mitra");
  registerAuditObjectLabel("partner_portal_order", "pesanan portal mitra");
  registerAuditObjectLabel("partner_audit", "audit mutu mitra");
  registerAuditObjectLabel("quality_checklist", "daftar periksa mutu harian");
  registerAuditObjectLabel("onboarding_checklist", "butir onboarding mitra");

  registerAuditFieldLabel("partner_contract", "subscriptionFeePerOutlet", { label: "langganan per outlet", format: "rupiah" });
  registerAuditFieldLabel("partner_contract", "initialFee", { label: "fee awal", format: "rupiah" });
  registerAuditFieldLabel("partner_contract", "creditLimit", { label: "batas kredit", format: "rupiah" });
  registerAuditFieldLabel("partner_contract", "startDate", { label: "tanggal mulai", format: "date" });
  registerAuditFieldLabel("partner_contract", "endDate", { label: "tanggal berakhir", format: "date" });
  registerAuditFieldLabel("partner_contract", "status", { label: "status kontrak", format: "enum:partner_contract_status" });
  registerAuditFieldLabel("partner_contract", "option", { label: "opsi kemitraan", format: "enum:partner_option" });
  registerAuditFieldLabel("partner_sanction", "level", { label: "tingkat sanksi", format: "enum:sanction_level" });
  registerAuditFieldLabel("partner_sanction", "status", { label: "status sanksi", format: "enum:sanction_status" });
  registerAuditFieldLabel("partner_prospect", "status", { label: "status calon mitra", format: "enum:prospect_status" });
  registerAuditFieldLabel("partner_support_request", "status", { label: "status permintaan", format: "enum:support_request_status" });
  registerAuditFieldLabel("outlet", "billingStartDate", { label: "mulai ditagih langganan", format: "date" });
  registerAuditFieldLabel("outlet", "activatedOn", { label: "tanggal Aktif", format: "date" });

  registerFinancialObjectType("partner_contract");

  registerAttachmentAccess("partner_support_request", {
    permission: ["p3.support_request.read"],
    check: async (tx, ctx, row) => {
      if (!row.objectId) return false;
      const [r] = await tx.select({ tenantId: partnerSupportRequests.tenantId }).from(partnerSupportRequests).where(eq(partnerSupportRequests.id, row.objectId)).limit(1);
      return !!r && r.tenantId === ctx.tenantId;
    },
  });
  registerAttachmentAccess("quality_checklist", {
    permission: ["p3.quality_checklist.read", "p3.quality_checklist.create", "p3.partner_report.read"],
    check: async (tx, ctx, row) => {
      if (!row.objectId) return false;
      const [r] = await tx.select({ tenantId: qualityChecklists.tenantId }).from(qualityChecklists).where(eq(qualityChecklists.id, row.objectId)).limit(1);
      return !!r && r.tenantId === ctx.tenantId;
    },
  });
  registerAttachmentAccess("partner_audit", {
    permission: ["p3.quality_checklist.read", "p3.partner_score.read", "p3.partner_audit.create"],
    check: async (tx, _ctx, row) => {
      if (!row.objectId) return false;
      const [r] = await tx.select({ id: partnerAudits.id }).from(partnerAudits).where(eq(partnerAudits.id, row.objectId)).limit(1);
      return !!r;
    },
  });
  registerAttachmentAccess("partner_survey", { permission: ["p3.partner_prospect.create", "p3.partner.read"] });
}
