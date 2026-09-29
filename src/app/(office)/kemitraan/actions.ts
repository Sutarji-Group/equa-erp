"use server";

import { revalidatePath } from "next/cache";

import type { P3ActionState } from "@/components/p3-partner/action-state";
import type { ActorContext } from "@/server/core/context";
import { requireOfficeSession } from "@/server/core/auth/office";
import { withTx } from "@/server/core/db";
import { toUserMessage, ValidationError } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as p3 from "@/server/modules/p3-partner";

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function num(fd: FormData, name: string): number | null {
  const v = str(fd, name);
  if (v === null) return null;
  const n = Number(v.replace(/[^0-9,.-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Desimal ("2,5" atau "2.5"; persen, koordinat) — BUKAN pemisah ribuan seperti `num`. */
function dec(fd: FormData, name: string): number | null {
  const v = str(fd, name);
  if (v === null) return null;
  const n = Number(v.replace(",", ".").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function attempt(fn: () => Promise<unknown>, message: string | ((r: unknown) => string), paths: string[]): Promise<P3ActionState> {
  try {
    const r = await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, message: typeof message === "function" ? message(r) : message };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

/** Unggah berkas formulir (maks. 4 MB, B-18; foto/PDF) → ID lampiran. */
async function upload(ctx: ActorContext, fd: FormData, name: string, kind: string): Promise<string | null> {
  const file = fd.get(name);
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > 4 * 1024 * 1024) throw ValidationError.field(name, "Berkas terlalu besar (maksimal 4 MB). Kompres foto atau pilih berkas lain.");
  const buf = Buffer.from(await file.arrayBuffer());
  const att = await withTx((tx) => put(tx, ctx, { blob: buf, contentType: file.type || "application/octet-stream", kind, originalName: file.name }));
  return att.id;
}

// ---------------------------------------------------------------------------------------------------- RL-7
export async function linkCustomerAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () => p3.linkPartnerCustomer(ctx, { customerId: str(fd, "customerId") ?? "", tenantId: str(fd, "tenantId") ?? "", outletId: str(fd, "outletId") ?? "", reason: str(fd, "reason") ?? "" }),
    "Pelanggan ditautkan sebagai mitra depot EQUA.",
    ["/kemitraan"],
  );
}

export async function registerOperatorAction(tenantId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () =>
      p3.registerPartnerOperator(ctx, {
        tenantId,
        outletId: str(fd, "outletId"),
        fullName: str(fd, "fullName") ?? "",
        phone: str(fd, "phone"),
        username: str(fd, "username") ?? "",
        role: (str(fd, "role") ?? "depot_operator") as "depot_operator" | "partner_owner",
        reason: str(fd, "reason") ?? "",
      }),
    "Akun mitra dibuat — menunggu persetujuan pemilik (Persetujuan).",
    [`/kemitraan/mitra/${tenantId}`],
  );
}

export async function registerDeviceAction(tenantId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () => p3.registerPartnerDevice(ctx, { tenantId, outletId: str(fd, "outletId") ?? "", deviceCode: str(fd, "deviceCode") ?? "", name: str(fd, "name") ?? "", kind: (str(fd, "kind") ?? "tablet") as "tablet" | "phone" }),
    (r) => `Perangkat terdaftar. Kode aktivasi (sekali tampil, berlaku 24 jam): ${(r as { displayCode: string }).displayCode}`,
    [`/kemitraan/mitra/${tenantId}`],
  );
}

export async function issuePinAction(tenantId: string, userId: string, _prev: P3ActionState): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.issuePartnerOperatorPin(ctx, { tenantId, userId }), (r) => `Kode aktivasi PIN (sekali tampil): ${(r as { displayCode?: string; code?: string }).displayCode ?? (r as { code?: string }).code ?? "-"}`, [`/kemitraan/mitra/${tenantId}`]);
}

export async function createContractAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const agreementAttachmentId = await upload(ctx, fd, "agreement", "agreement");
      return p3.createContract(ctx, {
        tenantId: str(fd, "tenantId") ?? "",
        customerId: str(fd, "customerId") ?? "",
        option: (str(fd, "option") ?? "option_b") as "option_b" | "option_a",
        startDate: str(fd, "startDate") ?? "",
        termMonths: num(fd, "termMonths"),
        subscriptionFeePerOutlet: num(fd, "subscriptionFeePerOutlet"),
        initialFee: num(fd, "initialFee"),
        royaltyPercent: dec(fd, "royaltyPercent"),
        waterDiscountPercent: dec(fd, "waterDiscountPercent"),
        creditLimit: num(fd, "creditLimit"),
        monthlyBilling: fd.get("monthlyBilling") === "on",
        agreementAttachmentId,
        reason: str(fd, "reason") ?? "",
      });
    },
    "Kontrak disimpan sebagai Draf dan diajukan ke pemilik.",
    ["/kemitraan/kontrak"],
  );
}

export async function proposeTermsAction(contractId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () => p3.proposeContractTerms(ctx, { contractId, subscriptionFeePerOutlet: num(fd, "subscriptionFeePerOutlet"), royaltyPercent: dec(fd, "royaltyPercent"), waterDiscountPercent: dec(fd, "waterDiscountPercent"), creditLimit: num(fd, "creditLimit"), reason: str(fd, "reason") ?? "" }),
    (r) => `Perubahan diajukan ke pemilik; berlaku mulai ${(r as { effectiveFrom: string }).effectiveFrom}.`,
    ["/kemitraan/kontrak"],
  );
}

export async function runBillingAction(_prev: P3ActionState): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.runSubscriptionBillingNow(ctx, {}), (r) => `Tagihan bulan ${(r as { serviceMonth: string }).serviceMonth}: ${(r as { issued: unknown[] }).issued.length} faktur terbit.`, ["/kemitraan/langganan"]);
}

export async function publishReportsAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.publishMonthlyReportsNow(ctx, { month: str(fd, "month") }), (r) => `Laporan bulanan ${(r as { month: string }).month}: ${(r as { published: unknown[] }).published.length} mitra diterbitkan.`, ["/kemitraan/langganan"]);
}

export async function respondSupportAction(requestId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.respondSupportRequest(ctx, { requestId, response: str(fd, "response") ?? "", relatedPosSaleId: str(fd, "relatedPosSaleId") }), "Tanggapan dikirim ke mitra.", [`/kemitraan/dukungan/${requestId}`, "/kemitraan/dukungan"]);
}

export async function linkSparePartAction(requestId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.linkSupportSparePart(ctx, { requestId, posSaleId: str(fd, "posSaleId") ?? "" }), "Penjualan spare part dirujuk.", [`/kemitraan/dukungan/${requestId}`]);
}

export async function completeSupportAction(requestId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.completeSupportRequest(ctx, { requestId, note: str(fd, "note") }), "Permintaan ditandai Selesai.", [`/kemitraan/dukungan/${requestId}`, "/kemitraan/dukungan"]);
}

// ---------------------------------------------------------------------------------------------------- Tahap 3
export async function createProspectAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () =>
      p3.createProspect(ctx, {
        name: str(fd, "name") ?? "",
        businessEntity: str(fd, "businessEntity"),
        waPhone: str(fd, "waPhone") ?? "",
        proposedAddress: str(fd, "proposedAddress") ?? "",
        lat: dec(fd, "lat") ?? Number.NaN,
        lng: dec(fd, "lng") ?? Number.NaN,
        capitalAmount: num(fd, "capitalAmount"),
      }),
    "Calon mitra dicatat.",
    ["/kemitraan/calon"],
  );
}

export async function recordSurveyAction(prospectId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const photo = await upload(ctx, fd, "photo", "survey_photo");
      return p3.recordSurvey(ctx, {
        prospectId,
        distanceNotes: str(fd, "distanceNotes"),
        densityNotes: str(fd, "densityNotes"),
        competitorNotes: str(fd, "competitorNotes"),
        layoutNotes: str(fd, "layoutNotes"),
        recommendation: str(fd, "recommendation") ?? "",
        photoAttachmentIds: photo ? [photo] : [],
      });
    },
    "Survei dicatat & penilaian otomatis diperbarui.",
    [`/kemitraan/calon/${prospectId}`],
  );
}

export async function overrideRadiusAction(prospectId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.overrideRadius(ctx, { prospectId, reason: str(fd, "reason") ?? "" }), "Pelanggaran radius dikesampingkan; penilaian diperbarui.", [`/kemitraan/calon/${prospectId}`]);
}

export async function submitProspectAction(prospectId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.submitProspect(ctx, { prospectId, reason: str(fd, "reason") ?? "" }), "Diajukan ke pemilik.", [`/kemitraan/calon/${prospectId}`]);
}

export async function contractFromProspectAction(prospectId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    async () => {
      const agreementAttachmentId = await upload(ctx, fd, "agreement", "agreement");
      return p3.createContractFromProspect(ctx, {
        prospectId,
        tenantCode: str(fd, "tenantCode") ?? "",
        tenantName: str(fd, "tenantName"),
        outletCode: str(fd, "outletCode") ?? "",
        outletName: str(fd, "outletName") ?? "",
        option: (str(fd, "option") ?? "option_b") as "option_b" | "option_a",
        startDate: str(fd, "startDate") ?? "",
        subscriptionFeePerOutlet: num(fd, "subscriptionFeePerOutlet"),
        initialFee: num(fd, "initialFee"),
        royaltyPercent: dec(fd, "royaltyPercent"),
        waterDiscountPercent: dec(fd, "waterDiscountPercent"),
        creditLimit: num(fd, "creditLimit"),
        monthlyBilling: fd.get("monthlyBilling") === "on",
        agreementAttachmentId: agreementAttachmentId ?? "",
        reason: str(fd, "reason") ?? "",
      });
    },
    "Tenant, outlet & pelanggan mitra dibuat; kontrak diajukan ke pemilik.",
    [`/kemitraan/calon/${prospectId}`, "/kemitraan/kontrak"],
  );
}

export async function completeOnboardingAction(contractId: string, outletId: string, item: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () =>
      p3.completeOnboardingItem(ctx, {
        contractId,
        outletId,
        item: item as (typeof p3.ONBOARDING_ITEMS)[number],
        referenceId: str(fd, "referenceId"),
        trainingDate: str(fd, "trainingDate"),
        trainingEndDate: str(fd, "trainingEndDate"),
        participants: str(fd, "participants"),
        notes: str(fd, "notes"),
      }),
    (r) => ((r as { activated: boolean }).activated ? "Butir dicentang — semua lengkap, outlet kini Aktif." : "Butir onboarding dicentang."),
    ["/kemitraan/onboarding"],
  );
}

export async function scheduleAuditAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.scheduleAudit(ctx, { outletId: str(fd, "outletId") ?? "", scheduledDate: str(fd, "scheduledDate") ?? "" }), "Audit dijadwalkan.", ["/kemitraan/mutu"]);
}

export async function conductAuditAction(auditId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  const items = ["kebersihan", "pencucian", "sterilisasi", "peralatan", "administrasi"]
    .map((k) => ({ key: k, label: str(fd, `label_${k}`) ?? k, score: dec(fd, `score_${k}`) }))
    .filter((i): i is { key: string; label: string; score: number } => i.score !== null);
  const findings = (str(fd, "findings") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length >= 5)
    .map((text) => ({ text }));
  return attempt(
    async () => {
      const photo = await upload(ctx, fd, "photo", "audit_photo");
      return p3.conductAudit(ctx, { auditId, items, findings, followUpDueDate: str(fd, "followUpDueDate"), notes: str(fd, "notes"), photoAttachmentIds: photo ? [photo] : [] });
    },
    "Lembar audit disimpan.",
    ["/kemitraan/mutu"],
  );
}

export async function closeAuditAction(auditId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.closeAuditFollowUp(ctx, { auditId, note: str(fd, "note") ?? "" }), "Tindak lanjut temuan dicatat.", ["/kemitraan/mutu"]);
}

export async function recordLabTestAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  const file = fd.get("certificate");
  return attempt(
    async () => {
      if (!(file instanceof File) || file.size === 0) throw ValidationError.field("certificate", "Lampirkan foto/PDF sertifikat hasil uji.");
      const passed = fd.get("passed") === "on";
      const buf = Buffer.from(await file.arrayBuffer());
      return p3.recordPartnerQualityTest(ctx, {
        outletId: str(fd, "outletId") ?? "",
        testDate: str(fd, "testDate") ?? "",
        laboratory: str(fd, "laboratory") ?? "",
        results: [{ parameter: str(fd, "parameter") ?? "Mikrobiologi", value: str(fd, "value") ?? "-", unit: str(fd, "unit"), limit: str(fd, "limit"), passed }],
        passed,
        notes: str(fd, "notes"),
        action: passed ? null : { description: str(fd, "actionDescription") ?? "", dueDate: str(fd, "actionDueDate") ?? "" },
        certificate: { blob: buf, contentType: file.type, name: file.name },
      });
    },
    "Hasil uji air dicatat.",
    ["/kemitraan/mutu"],
  );
}

export async function recordEvaluationAction(evaluationId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.recordEvaluation(ctx, { evaluationId, summary: str(fd, "summary") ?? "", recommendation: str(fd, "recommendation") }), "Evaluasi berkala dicatat.", ["/kemitraan/kontrak", "/kemitraan/dasbor"]);
}

export async function proposeSanctionAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () =>
      p3.proposeSanction(ctx, {
        sanctionId: str(fd, "sanctionId"),
        tenantId: str(fd, "tenantId"),
        level: str(fd, "level") as "warning" | "supply_suspension" | "termination" | null,
        reason: str(fd, "reason") ?? "",
        recoveryConditions: str(fd, "recoveryConditions"),
        effectiveDate: str(fd, "effectiveDate"),
      }),
    "Usulan sanksi diajukan ke pemilik.",
    ["/kemitraan/sanksi"],
  );
}

export async function liftSanctionAction(sanctionId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.liftSanction(ctx, { sanctionId, reason: str(fd, "reason") ?? "" }), "Sanksi dicabut / tidak dilanjutkan (tercatat).", ["/kemitraan/sanksi"]);
}

export async function markExportedAction(tenantId: string, _prev: P3ActionState): Promise<P3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => p3.markPartnerDataExported(ctx, { tenantId }), "Ekspor data ditandai sudah diserahkan ke mitra.", ["/kemitraan/sanksi"]);
}
