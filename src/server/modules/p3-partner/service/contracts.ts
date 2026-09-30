/**
 * P3 — kontrak mitra berparameter (9.4 PTB-55; PAR-35, PAR-77, PAR-78):
 *
 * - RL-7 US-P3-09 KP-1: tarif langganan & tanggal mulai diinput Admin Keuangan (`createContract`) dan berlaku setelah
 *   pemilik menyetujui (6.2a `partner_contract`). Kontrak draf/ditolak tidak pernah ditagih.
 * - US-P3-04 KP-5 (Tahap 3): perubahan parameter (langganan, royalti %, diskon air %, batas kredit) diajukan →
 *   disetujui pemilik → berlaku mulai periode (bulan) berikutnya; berjejak (`pending_terms` + jejak audit).
 * - Opsi B (Fase 1, RL-7) TANPA royalti & tanpa diskon air (BRD 9.6); Opsi A hanya bila portal lengkap aktif (D-02).
 * - Aktivasi kontrak: batas kredit pelanggan mitra dari kontrak (US-P3-01 KP-3), penanda tagihan bulanan (BR-05 —
 *   perjanjian = kontrak yang disetujui pemilik), tanggal mulai tagih outlet aktif, wilayah eksklusif outlet.
 * - Siklus (job harian): parameter tertunda diterapkan pada tanggal berlakunya, kontrak lewat tanggal berakhir →
 *   Berakhir; Tahap 3: pengingat 60 hari sebelum berakhir & evaluasi berkala PAR-77 (US-P3-01 KP-5).
 */
import "server-only";

import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { customers, exclusiveTerritories, outlets, partnerContracts, partnerEvaluations, tenants } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah, zRupiahNonNegative } from "@/lib/money";
import { addDays, firstDayOfMonth, isBusinessDate, toBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import * as params from "@/server/core/params";
import { authorize, authorizeAny, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import {
  addMonths,
  assertOwnerTenant,
  bpToPercent,
  contractOutlets,
  loadContract,
  loadPartnerTenant,
  notifyOnce,
  ownerTenantId,
  partnerRules,
  percentToBp,
  portalEnabled,
  type ContractRow,
} from "./common";
import { createOnboardingForContract } from "./onboarding";

// =====================================================================================================================
// Parameter kontrak berlaku per periode (US-P3-04 KP-5)
// =====================================================================================================================

export type ContractTerms = {
  subscriptionFeePerOutlet: number;
  royaltyBp: number;
  waterDiscountBp: number;
  creditLimit: number;
};

type PendingTerms = Partial<ContractTerms> & { reason?: string; approvalNumber?: string };

/** Satu penerapan parameter: `before` berlaku untuk bulan layanan < `effectiveFrom` (US-P3-04 KP-5). */
export type TermsHistoryEntry = { effectiveFrom: BusinessDate; before: ContractTerms; approvalNumber?: string | null; appliedAt?: string };

function termsHistoryOf(contract: Pick<ContractRow, "termsHistory">): TermsHistoryEntry[] {
  return ((contract.termsHistory ?? []) as unknown as TermsHistoryEntry[]).slice().sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/**
 * Parameter yang berlaku untuk bulan layanan `periodMonth` ('YYYY-MM-01'): riwayat penerapan (bulan sebelum tanggal
 * berlaku memakai parameter lama — tagihan bulan lalu yang terbit SETELAH job siklus 00.30 tetap bertarif lama), lalu
 * kolom dasar, lalu `pending_terms` yang sudah jatuh tanggal berlakunya.
 */
export function effectiveTerms(contract: ContractRow, periodMonth: BusinessDate): ContractTerms {
  const older = termsHistoryOf(contract).find((h) => periodMonth < h.effectiveFrom);
  if (older) return older.before;
  const base: ContractTerms = {
    subscriptionFeePerOutlet: contract.subscriptionFeePerOutlet,
    royaltyBp: contract.royaltyBp,
    waterDiscountBp: contract.waterDiscountBp,
    creditLimit: contract.creditLimit,
  };
  const pending = contract.pendingTerms as PendingTerms | null;
  if (!pending || !contract.pendingTermsEffectiveFrom || contract.pendingTermsEffectiveFrom > periodMonth) return base;
  return {
    subscriptionFeePerOutlet: pending.subscriptionFeePerOutlet ?? base.subscriptionFeePerOutlet,
    royaltyBp: pending.royaltyBp ?? base.royaltyBp,
    waterDiscountBp: pending.waterDiscountBp ?? base.waterDiscountBp,
    creditLimit: pending.creditLimit ?? base.creditLimit,
  };
}

// =====================================================================================================================
// Input kontrak (Admin Keuangan) → persetujuan pemilik (6.2a)
// =====================================================================================================================

const dateSchema = z.string().refine(isBusinessDate, { error: "Tanggal harus berformat YYYY-MM-DD." });
const pctSchema = z.coerce.number({ error: "Persen harus angka." }).min(0, { error: "Persen tidak boleh negatif." }).max(100);

const createContractSchema = z.object({
  tenantId: z.uuid({ error: "Pilih tenant mitra." }),
  customerId: z.uuid({ error: "Pilih pelanggan mitra (sudah ditautkan ke tenant)." }),
  option: z.enum(["option_b", "option_a"]).default("option_b"),
  startDate: dateSchema,
  termMonths: z.coerce.number().int().min(1).max(120).nullable().optional(),
  subscriptionFeePerOutlet: zRupiahNonNegative.nullable().optional(),
  initialFee: zRupiahNonNegative.nullable().optional(),
  royaltyPercent: pctSchema.nullable().optional(),
  waterDiscountPercent: pctSchema.nullable().optional(),
  exclusiveRadiusM: z.coerce.number().int().min(0).max(20_000).nullable().optional(),
  creditLimit: zRupiahNonNegative.nullable().optional(),
  monthlyBilling: z.boolean().default(false),
  agreementAttachmentId: z.uuid().nullable().optional(),
  prospectId: z.uuid().nullable().optional(),
  reason: z.string().trim().min(5, { error: "Alasan/dasar perjanjian wajib diisi (minimal 5 karakter)." }).max(500),
});
export type CreateContractInput = z.input<typeof createContractSchema>;

async function nextContractNumber(tx: Tx, date: BusinessDate): Promise<string> {
  const yy = date.slice(2, 4);
  const [{ n }] = (await tx
    .select({ n: count() })
    .from(partnerContracts)
    .where(sql`${partnerContracts.number} like ${`KM-${yy}-%`}`)) as [{ n: number }];
  for (let i = Number(n) + 1; ; i++) {
    const number = `KM-${yy}-${String(i).padStart(4, "0")}`;
    const [dup] = await tx.select({ id: partnerContracts.id }).from(partnerContracts).where(eq(partnerContracts.number, number)).limit(1);
    if (!dup) return number;
  }
}

/** Validasi & default parameter kontrak dari PAR-35/PAR-78 (tanpa angka di kode). */
async function resolveTerms(tx: Tx, data: z.output<typeof createContractSchema>, date: BusinessDate) {
  const p35 = await params.get(tx, "PAR-35", date);
  const p78 = await params.get(tx, "PAR-78", date);
  const optionA = data.option === "option_a";
  const royaltyPercent = data.royaltyPercent ?? (optionA ? p35.royalty_percent_min : 0);
  const discountPercent = data.waterDiscountPercent ?? (optionA ? p35.water_discount_percent_min : 0);
  if (!optionA && (royaltyPercent > 0 || discountPercent > 0)) {
    throw ValidationError.field("royaltyPercent", "Opsi B (Kemitraan Fase 1) tanpa royalti dan tanpa diskon air (BRD 9.6).");
  }
  if (optionA) {
    if (royaltyPercent < p35.royalty_percent_min || royaltyPercent > p35.royalty_percent_max) {
      throw ValidationError.field("royaltyPercent", `Royalti Opsi A harus ${p35.royalty_percent_min}–${p35.royalty_percent_max}% (PAR-35).`);
    }
    if (discountPercent < p35.water_discount_percent_min || discountPercent > p35.water_discount_percent_max) {
      throw ValidationError.field("waterDiscountPercent", `Diskon air Opsi A harus ${p35.water_discount_percent_min}–${p35.water_discount_percent_max}% (PAR-35).`);
    }
  }
  const radius = data.exclusiveRadiusM ?? (optionA ? p35.exclusive_radius_m_option_a_min : p35.exclusive_radius_m_option_b);
  if (optionA && (radius < p35.exclusive_radius_m_option_a_min || radius > p35.exclusive_radius_m_option_a_max)) {
    throw ValidationError.field("exclusiveRadiusM", `Radius eksklusif Opsi A ${p35.exclusive_radius_m_option_a_min}–${p35.exclusive_radius_m_option_a_max} m (PAR-35).`);
  }
  const termMonths = data.termMonths ?? (optionA ? p78.option_a_years : p78.option_b_years) * 12;
  return {
    subscriptionFeePerOutlet: data.subscriptionFeePerOutlet ?? p35.subscription_per_outlet,
    royaltyBp: percentToBp(royaltyPercent),
    waterDiscountBp: percentToBp(discountPercent),
    exclusiveRadiusM: radius,
    termMonths,
    endDate: addDays(addMonths(data.startDate, termMonths), -1),
  };
}

/**
 * Admin Keuangan menginput kontrak mitra (Draf) → persetujuan pemilik `partner_contract` (6.2a, US-P3-09 KP-1).
 * Pelanggan wajib sudah ditautkan ke tenant mitra (US-P3-08 KP-1).
 */
export async function createContract(ctx: ActorContext, input: CreateContractInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_contract.create", { tx: opts.tx, objectType: "partner_contract" });
  const data = parseInput(createContractSchema, input, {
    tenantId: "Tenant mitra",
    customerId: "Pelanggan mitra",
    startDate: "Tanggal mulai",
    subscriptionFeePerOutlet: "Langganan per outlet",
    royaltyPercent: "Royalti",
    waterDiscountPercent: "Diskon air",
    reason: "Alasan",
  });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const today = ctxBusinessDate(ctx);
    const tenant = await loadPartnerTenant(tx, data.tenantId);
    if (!tenant.isActive) throw new DomainError("TENANT_INACTIVE", `Tenant ${tenant.name} sudah nonaktif.`);
    if (data.option === "option_a" && !(await portalEnabled(tx, tenant.id))) {
      throw new DomainError("OPTION_A_DISABLED", "Opsi A (waralaba, royalti) hanya tersedia setelah portal kemitraan lengkap (Tahap 3) diaktifkan pemilik. Pakai Opsi B untuk mitra Fase 1.");
    }
    const [c] = await tx.select().from(customers).where(eq(customers.id, data.customerId)).limit(1);
    if (!c || c.tenantId !== ctx.tenantId) throw new NotFoundError("Pelanggan tidak ditemukan.");
    if (!c.isEquaPartner || c.partnerTenantId !== tenant.id) {
      throw ValidationError.field("customerId", "Tautkan pelanggan ke tenant & outlet mitra ini terlebih dahulu (US-P3-08 KP-1).");
    }
    // D-13 butir 1 (PRD 9.7 mitra dua outlet): satu kontrak berlaku PER OUTLET — kontrak lain tenant yang sama hanya
    // menghalangi bila untuk pelanggan/outlet yang sama (tiap outlet = satu pelanggan mitra, `partner_outlet_id`).
    const overlapping = await tx
      .select({
        id: partnerContracts.id,
        number: partnerContracts.number,
        status: partnerContracts.status,
        approvalRequestId: partnerContracts.approvalRequestId,
        customerId: partnerContracts.customerId,
        outletId: customers.partnerOutletId,
      })
      .from(partnerContracts)
      .innerJoin(customers, eq(customers.id, partnerContracts.customerId))
      .where(and(eq(partnerContracts.tenantId, tenant.id), inArray(partnerContracts.status, ["draft", "active", "extended"])));
    for (const o of overlapping) {
      const sameOutlet = o.customerId === c.id || !o.outletId || !c.partnerOutletId || o.outletId === c.partnerOutletId;
      if (!sameOutlet) continue;
      if (o.status !== "draft") throw new DomainError("CONTRACT_ACTIVE_EXISTS", `Outlet mitra ini masih punya kontrak ${o.number} berstatus ${label("partner_contract_status", o.status)}. Ajukan perubahan parameter, bukan kontrak baru.`);
      const req = o.approvalRequestId ? await approvals.getApproval(tx, o.approvalRequestId) : null;
      if (req?.status === "submitted") throw new DomainError("CONTRACT_PENDING_EXISTS", `Kontrak ${o.number} masih menunggu persetujuan pemilik.`);
    }
    const terms = await resolveTerms(tx, data, today);
    const p77 = await params.get(tx, "PAR-77", today);
    const number = await nextContractNumber(tx, today);
    const [row] = await tx
      .insert(partnerContracts)
      .values({
        tenantId: tenant.id,
        customerId: c.id,
        prospectId: data.prospectId ?? null,
        number,
        option: data.option,
        initialFee: data.initialFee ?? 0,
        subscriptionFeePerOutlet: terms.subscriptionFeePerOutlet,
        royaltyBp: terms.royaltyBp,
        waterDiscountBp: terms.waterDiscountBp,
        exclusiveRadiusM: terms.exclusiveRadiusM,
        termMonths: terms.termMonths,
        startDate: data.startDate,
        endDate: terms.endDate,
        creditLimit: data.creditLimit ?? 0,
        monthlyBilling: data.monthlyBilling,
        status: "draft",
        agreementAttachmentId: data.agreementAttachmentId ?? null,
        evaluationIntervalMonths: p77.months,
        nextEvaluationDate: addMonths(data.startDate, p77.months),
        createdBy: ctx.userId,
      })
      .returning();
    if (data.agreementAttachmentId) await linkAttachment(tx, data.agreementAttachmentId, { type: "partner_contract", id: row!.id });
    const approval = await approvals.submit(
      ctx,
      {
        type: "partner_contract",
        objectType: "partner_contract",
        objectId: row!.id,
        amount: terms.subscriptionFeePerOutlet,
        reason: data.reason,
        payload: {
          kind: "create",
          number,
          tenantName: tenant.name,
          customerName: c.name,
          option: data.option,
          optionLabel: label("partner_option", data.option),
          subscriptionFeePerOutlet: terms.subscriptionFeePerOutlet,
          royaltyPercent: bpToPercent(terms.royaltyBp),
          waterDiscountPercent: bpToPercent(terms.waterDiscountBp),
          initialFee: data.initialFee ?? 0,
          creditLimit: data.creditLimit ?? 0,
          monthlyBilling: data.monthlyBilling,
          startDate: data.startDate,
          endDate: terms.endDate,
          link: `/kemitraan/kontrak?id=${row!.id}`,
        },
      },
      { tx },
    );
    await tx.update(partnerContracts).set({ approvalRequestId: approval.id }).where(eq(partnerContracts.id, row!.id));
    await auditRecord(tx, {
      ctx,
      objectType: "partner_contract",
      objectId: row!.id,
      action: "create",
      after: {
        number,
        tenantId: tenant.id,
        customerId: c.id,
        option: data.option,
        subscriptionFeePerOutlet: terms.subscriptionFeePerOutlet,
        royaltyBp: terms.royaltyBp,
        waterDiscountBp: terms.waterDiscountBp,
        startDate: data.startDate,
        endDate: terms.endDate,
        creditLimit: data.creditLimit ?? 0,
        monthlyBilling: data.monthlyBilling,
        status: "draft",
        approval: approval.number,
      },
      reason: data.reason,
      rule: "US-P3-09 KP-1, 6.2a",
    });
    return { contract: { ...row!, approvalRequestId: approval.id }, approval };
  });
}

const termsSchema = z.object({
  contractId: z.uuid(),
  subscriptionFeePerOutlet: zRupiahNonNegative.nullable().optional(),
  royaltyPercent: pctSchema.nullable().optional(),
  waterDiscountPercent: pctSchema.nullable().optional(),
  creditLimit: zRupiahNonNegative.nullable().optional(),
  reason: z.string().trim().min(5, { error: "Alasan perubahan wajib diisi (minimal 5 karakter)." }).max(500),
});

/**
 * US-P3-04 KP-5: usulan perubahan parameter kontrak → persetujuan pemilik → berlaku mulai bulan berikutnya
 * (`pending_terms`); periode berjalan tetap memakai parameter lama.
 */
export async function proposeContractTerms(ctx: ActorContext, input: z.input<typeof termsSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_contract.update", { tx: opts.tx, objectType: "partner_contract", objectId: input?.contractId });
  const data = parseInput(termsSchema, input, { subscriptionFeePerOutlet: "Langganan per outlet", royaltyPercent: "Royalti", waterDiscountPercent: "Diskon air", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const contract = await loadContract(tx, data.contractId);
    if (!["active", "extended"].includes(contract.status)) throw new DomainError("CONTRACT_NOT_ACTIVE", "Perubahan parameter hanya untuk kontrak Aktif/Diperpanjang.");
    const today = ctxBusinessDate(ctx);
    const changes: Partial<ContractTerms> = {};
    if (data.subscriptionFeePerOutlet != null) changes.subscriptionFeePerOutlet = data.subscriptionFeePerOutlet;
    if (data.royaltyPercent != null) changes.royaltyBp = percentToBp(data.royaltyPercent);
    if (data.waterDiscountPercent != null) changes.waterDiscountBp = percentToBp(data.waterDiscountPercent);
    if (data.creditLimit != null) changes.creditLimit = data.creditLimit;
    if (!Object.keys(changes).length) throw ValidationError.field("subscriptionFeePerOutlet", "Isi minimal satu parameter yang diubah.");
    if (contract.option === "option_b" && ((changes.royaltyBp ?? 0) > 0 || (changes.waterDiscountBp ?? 0) > 0)) {
      throw ValidationError.field("royaltyPercent", "Opsi B tanpa royalti dan tanpa diskon air; konversi ke Opsi A hanya lewat kontrak baru (9.4).");
    }
    if (contract.option === "option_a") {
      const p35 = await params.get(tx, "PAR-35", today);
      if (changes.royaltyBp !== undefined && (changes.royaltyBp < percentToBp(p35.royalty_percent_min) || changes.royaltyBp > percentToBp(p35.royalty_percent_max))) {
        throw ValidationError.field("royaltyPercent", `Royalti Opsi A harus ${p35.royalty_percent_min}–${p35.royalty_percent_max}% (PAR-35).`);
      }
    }
    const effectiveFrom = firstDayOfMonth(addDays(`${today.slice(0, 7)}-01`, 32));
    const approval = await approvals.submit(
      ctx,
      {
        type: "partner_contract",
        objectType: "partner_contract",
        objectId: contract.id,
        amount: changes.subscriptionFeePerOutlet ?? null,
        reason: data.reason,
        payload: {
          kind: "terms_change",
          number: contract.number,
          changes,
          before: effectiveTerms(contract, today),
          effectiveFrom,
          royaltyPercent: changes.royaltyBp !== undefined ? bpToPercent(changes.royaltyBp) : undefined,
          waterDiscountPercent: changes.waterDiscountBp !== undefined ? bpToPercent(changes.waterDiscountBp) : undefined,
          link: `/kemitraan/kontrak?id=${contract.id}`,
        },
      },
      { tx },
    );
    await auditRecord(tx, { ctx, objectType: "partner_contract", objectId: contract.id, action: "propose_terms", after: { changes, effectiveFrom, approval: approval.number }, reason: data.reason, rule: "US-P3-04 KP-5" });
    return { approval, effectiveFrom };
  });
}

// =====================================================================================================================
// Efek keputusan pemilik (handler persetujuan; ctx = penyetuju)
// =====================================================================================================================

/** Aktifkan kontrak yang disetujui: status Aktif, batas kredit & tagihan bulanan pelanggan, tanggal tagih, wilayah. */
export async function activateContract(tx: Tx, ctx: ActorContext, contractId: string, request: approvals.ApprovalRow): Promise<Record<string, unknown>> {
  const contract = await loadContract(tx, contractId, { forUpdate: true });
  if (contract.status !== "draft") return { skipped: `Kontrak ${contract.number} sudah ${label("partner_contract_status", contract.status)}.` };
  await tx.update(partnerContracts).set({ status: "active", updatedAt: ctx.now }).where(eq(partnerContracts.id, contract.id));
  await auditRecord(tx, { ctx, objectType: "partner_contract", objectId: contract.id, action: "activate", before: { status: "draft" }, after: { status: "active", approval: request.number }, rule: "6.2a" });

  // Pelanggan mitra: batas kredit dari kontrak (US-P3-01 KP-3; satu batas lintas lini PTB-25) & tagihan bulanan (BR-05).
  const [c] = await tx.select().from(customers).where(eq(customers.id, contract.customerId)).for("update").limit(1);
  const effects: Record<string, unknown> = { contract: contract.number };
  if (c) {
    const set: Partial<typeof customers.$inferInsert> = { updatedAt: ctx.now };
    const before = { creditStatus: c.creditStatus, creditLimit: c.creditLimit, monthlyBilling: c.monthlyBilling };
    if (contract.creditLimit > 0) {
      set.creditLimit = contract.creditLimit;
      set.creditLimitOverridden = true;
      if (c.creditStatus === "cash") set.creditStatus = "credit";
    }
    if (contract.monthlyBilling && !c.monthlyBilling) {
      set.monthlyBilling = true;
      set.monthlyBillingApprovalId = request.id;
      if (contract.agreementAttachmentId) set.monthlyBillingAgreementAttachmentId = contract.agreementAttachmentId;
    }
    await tx.update(customers).set(set).where(eq(customers.id, c.id));
    const after = { creditStatus: set.creditStatus ?? c.creditStatus, creditLimit: set.creditLimit ?? c.creditLimit, monthlyBilling: set.monthlyBilling ?? c.monthlyBilling };
    await auditRecord(tx, { ctx, objectType: "customer", objectId: c.id, action: "update", before, after: { ...after, contract: contract.number }, rule: "US-P3-01 KP-3, BR-05, 6.2a" });
    if (set.creditStatus && set.creditStatus !== c.creditStatus) {
      await emit(
        tx,
        "credit_status.changed",
        { customerId: c.id, from: c.creditStatus, to: set.creditStatus, reason: `Kontrak mitra ${contract.number} disetujui pemilik (${request.number})`, automatic: false, rule: "US-P3-01 KP-3" },
        { ctx, tenantId: c.tenantId, objectType: "customer", objectId: c.id },
      );
    }
    effects.customer = after;
  }

  // Outlet aktif YANG DICAKUP kontrak ini (D-13 butir 1: satu kontrak per outlet): mulai ditagih langganan sejak
  // maks(tanggal mulai kontrak, tanggal aktif outlet) + wilayah eksklusif per outlet.
  const outletRows = await contractOutlets(tx, { ...contract, status: "active" }, { from: contract.startDate, to: contract.endDate });
  let billing = 0;
  let territories = 0;
  for (const o of outletRows) {
    if (o.activatedOn && !o.billingStartDate) {
      const start = o.activatedOn > contract.startDate ? o.activatedOn : contract.startDate;
      await tx.update(outlets).set({ billingStartDate: start, updatedAt: ctx.now }).where(eq(outlets.id, o.id));
      await auditRecord(tx, { ctx, objectType: "outlet", objectId: o.id, action: "update", before: { billingStartDate: null }, after: { billingStartDate: start }, rule: "US-P3-09 KP-1" });
      billing++;
    }
    if (o.lat !== null && o.lng !== null && contract.exclusiveRadiusM > 0) {
      const [t] = await tx.select({ id: exclusiveTerritories.id }).from(exclusiveTerritories).where(and(eq(exclusiveTerritories.contractId, contract.id), eq(exclusiveTerritories.outletId, o.id))).limit(1);
      if (!t) {
        await tx.insert(exclusiveTerritories).values({ contractId: contract.id, outletId: o.id, centerLat: o.lat, centerLng: o.lng, radiusM: contract.exclusiveRadiusM, validFrom: contract.startDate, validUntil: contract.endDate });
        territories++;
      }
    }
  }
  // Tahap 3: outlet yang belum Aktif mendapat daftar periksa onboarding (US-P3-01 KP-4).
  const onboardingItems = await createOnboardingForContract(tx, { ...contract, status: "active" });
  return { ...effects, outletsBilling: billing, territories, onboardingItems };
}

/** Terapkan usulan parameter yang disetujui sebagai `pending_terms` (berlaku mulai `effectiveFrom`). */
export async function scheduleContractTerms(tx: Tx, ctx: ActorContext, contractId: string, request: approvals.ApprovalRow): Promise<Record<string, unknown>> {
  const contract = await loadContract(tx, contractId, { forUpdate: true });
  const payload = (request.payload ?? {}) as { changes?: Partial<ContractTerms>; effectiveFrom?: string };
  const pending: PendingTerms = { ...(payload.changes ?? {}), reason: request.reason, approvalNumber: request.number };
  // US-P3-04 KP-5: berlaku mulai bulan SESUDAH persetujuan — persetujuan yang terlambat (setelah tanggal berlaku usulan)
  // tidak mengubah tarif bulan layanan yang sudah berjalan.
  const earliest = firstDayOfMonth(addDays(`${ctxBusinessDate(ctx).slice(0, 7)}-01`, 32));
  const effectiveFrom = payload.effectiveFrom && payload.effectiveFrom >= earliest ? payload.effectiveFrom : earliest;
  await tx.update(partnerContracts).set({ pendingTerms: pending, pendingTermsEffectiveFrom: effectiveFrom, updatedAt: ctx.now }).where(eq(partnerContracts.id, contract.id));
  await auditRecord(tx, {
    ctx,
    objectType: "partner_contract",
    objectId: contract.id,
    action: "schedule_terms",
    before: effectiveTerms(contract, effectiveFrom),
    after: { ...pending, effectiveFrom, proposedEffectiveFrom: payload.effectiveFrom ?? null },
    reason: request.reason,
    rule: "US-P3-04 KP-5, 6.2a",
  });
  return { effectiveFrom, changes: payload.changes };
}

// =====================================================================================================================
// Kueri
// =====================================================================================================================

export type ContractListRow = ContractRow & {
  tenantName: string;
  tenantCode: string;
  customerName: string;
  approvalStatus: string | null;
  approvalNumber: string | null;
  termsNow: ContractTerms;
};

export async function listContracts(ctx: ActorContext, filter: { tenantId?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<ContractListRow[]> {
  await authorizeAny(ctx, ["p3.partner_contract.read", "p3.subscription.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const rows = await tx
    .select({ contract: partnerContracts, tenantName: tenants.name, tenantCode: tenants.code, customerName: customers.name })
    .from(partnerContracts)
    .innerJoin(tenants, eq(tenants.id, partnerContracts.tenantId))
    .innerJoin(customers, eq(customers.id, partnerContracts.customerId))
    .where(filter.tenantId ? eq(partnerContracts.tenantId, filter.tenantId) : undefined)
    .orderBy(desc(partnerContracts.createdAt));
  const today = ctxBusinessDate(ctx);
  const out: ContractListRow[] = [];
  for (const r of rows) {
    const req = r.contract.approvalRequestId ? await approvals.getApproval(tx, r.contract.approvalRequestId) : null;
    out.push({ ...r.contract, tenantName: r.tenantName, tenantCode: r.tenantCode, customerName: r.customerName, approvalStatus: req?.status ?? null, approvalNumber: req?.number ?? null, termsNow: effectiveTerms(r.contract, `${today.slice(0, 7)}-01`) });
  }
  return out;
}

export async function getContract(ctx: ActorContext, contractId: string, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.partner_contract.read", "p3.subscription.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const contract = await loadContract(tx, contractId);
  const approvalsForContract = await approvals.listForObject(tx, "partner_contract", contract.id);
  const territories = await tx.select().from(exclusiveTerritories).where(eq(exclusiveTerritories.contractId, contract.id));
  const evaluations = await tx.select().from(partnerEvaluations).where(eq(partnerEvaluations.contractId, contract.id)).orderBy(desc(partnerEvaluations.dueDate));
  return { contract, approvals: approvalsForContract, territories, evaluations, termsNow: effectiveTerms(contract, `${ctxBusinessDate(ctx).slice(0, 7)}-01`) };
}

// =====================================================================================================================
// Siklus kontrak (job harian)
// =====================================================================================================================

export type ContractLifecycleResult = { termsApplied: string[]; ended: string[]; expiring: string[]; evaluations: string[] };

/**
 * Job harian: (1) parameter tertunda diterapkan pada tanggal berlaku (berjejak); (2) kontrak lewat tanggal berakhir →
 * Berakhir; Tahap 3 (flag): (3) pengingat PAR/aturan `contract_expiry_reminder_days` sebelum berakhir, (4) evaluasi
 * berkala PAR-77 terjadwal + notifikasi pembina (US-P3-01 KP-5).
 */
export async function runContractLifecycle(now: Date, opts: { db?: Db } = {}): Promise<ContractLifecycleResult> {
  const today = toBusinessDate(now);
  return withTx(
    async (tx) => {
      const out: ContractLifecycleResult = { termsApplied: [], ended: [], expiring: [], evaluations: [] };
      const equa = await ownerTenantId(tx);
      const ctx = systemContext({ tenantId: equa, now, businessDate: today });
      const rules = await partnerRules(tx, today);
      const live = await tx.select().from(partnerContracts).where(inArray(partnerContracts.status, ["active", "extended"])).orderBy(asc(partnerContracts.number));
      for (const c of live) {
        if (c.pendingTerms && c.pendingTermsEffectiveFrom && c.pendingTermsEffectiveFrom <= today) {
          const next = effectiveTerms(c, c.pendingTermsEffectiveFrom);
          const before: ContractTerms = { subscriptionFeePerOutlet: c.subscriptionFeePerOutlet, royaltyBp: c.royaltyBp, waterDiscountBp: c.waterDiscountBp, creditLimit: c.creditLimit };
          // Riwayat: parameter lama tetap berlaku untuk bulan layanan sebelum tanggal berlaku (tagihan 00.40 bulan lalu).
          const history: TermsHistoryEntry[] = [
            ...termsHistoryOf(c),
            { effectiveFrom: c.pendingTermsEffectiveFrom, before, approvalNumber: (c.pendingTerms as PendingTerms).approvalNumber ?? null, appliedAt: now.toISOString() },
          ];
          await tx
            .update(partnerContracts)
            .set({ ...next, termsHistory: history as unknown as Record<string, unknown>[], pendingTerms: null, pendingTermsEffectiveFrom: null, updatedAt: now })
            .where(eq(partnerContracts.id, c.id));
          await auditRecord(tx, {
            ctx,
            objectType: "partner_contract",
            objectId: c.id,
            action: "apply_terms",
            before,
            after: { ...next, effectiveFrom: c.pendingTermsEffectiveFrom },
            reason: (c.pendingTerms as PendingTerms).reason ?? null,
            rule: "US-P3-04 KP-5",
          });
          if (next.creditLimit !== c.creditLimit) {
            await tx.update(customers).set({ creditLimit: next.creditLimit, creditLimitOverridden: true, updatedAt: now }).where(eq(customers.id, c.customerId));
            await auditRecord(tx, { ctx, objectType: "customer", objectId: c.customerId, action: "update", before: { creditLimit: c.creditLimit }, after: { creditLimit: next.creditLimit, contract: c.number }, rule: "US-P3-04 KP-5" });
          }
          out.termsApplied.push(c.id);
        }
        if (c.endDate < today) {
          await tx.update(partnerContracts).set({ status: "ended", updatedAt: now }).where(eq(partnerContracts.id, c.id));
          await auditRecord(tx, { ctx, objectType: "partner_contract", objectId: c.id, action: "end", before: { status: c.status }, after: { status: "ended", endDate: c.endDate }, rule: "PAR-78" });
          out.ended.push(c.id);
          continue;
        }
        // US-P3-01 KP-5: flag Tahap 3 dapat hidup per tenant mitra (bukan hanya global).
        if (!(await portalEnabled(tx, c.tenantId))) continue;
        if (addDays(c.endDate, -rules.contract_expiry_reminder_days) <= today) {
          const sent = await notifyOnce(tx, {
            event: "partner.contract_expiring",
            tenantId: equa,
            title: `Kontrak mitra ${c.number} berakhir ${c.endDate}`,
            body: `Kontrak berakhir dalam ≤ ${rules.contract_expiry_reminder_days} hari. Putuskan perpanjangan atau pengakhiran (PAR-78).`,
            objectType: "partner_contract",
            objectId: c.id,
            link: `/kemitraan/kontrak?id=${c.id}`,
            groupKey: `partner.contract_expiring:${c.id}:${c.endDate}`,
            now,
          });
          if (sent) out.expiring.push(c.id);
        }
        if (c.nextEvaluationDate && c.nextEvaluationDate <= today) {
          await tx.insert(partnerEvaluations).values({ tenantId: c.tenantId, contractId: c.id, dueDate: c.nextEvaluationDate }).onConflictDoNothing();
          const nextDate = addMonths(c.nextEvaluationDate, c.evaluationIntervalMonths);
          await tx.update(partnerContracts).set({ nextEvaluationDate: nextDate, updatedAt: now }).where(eq(partnerContracts.id, c.id));
          await notifyOnce(tx, {
            event: "partner.evaluation_due",
            tenantId: equa,
            title: `Evaluasi berkala mitra ${c.number} jatuh tempo ${c.nextEvaluationDate}`,
            body: `Evaluasi tiap ${c.evaluationIntervalMonths} bulan (PAR-77): tinjau omzet, neraca air, tagihan, dan mutu mitra.`,
            objectType: "partner_contract",
            objectId: c.id,
            link: `/kemitraan/kontrak?id=${c.id}`,
            groupKey: `partner.evaluation_due:${c.id}:${c.nextEvaluationDate}`,
            now,
          });
          out.evaluations.push(c.id);
        }
      }
      return out;
    },
    opts.db ? { db: opts.db } : {},
  );
}

/** Evaluasi berkala yang masih terbuka (belum dilaksanakan). */
export async function openEvaluations(tx: Tx, tenantId?: string | null) {
  return tx
    .select()
    .from(partnerEvaluations)
    .where(and(isNull(partnerEvaluations.conductedAt), ...(tenantId ? [eq(partnerEvaluations.tenantId, tenantId)] : [])))
    .orderBy(asc(partnerEvaluations.dueDate));
}

const evaluationSchema = z.object({
  evaluationId: z.uuid(),
  summary: z.string().trim().min(10, { error: "Ringkasan evaluasi minimal 10 karakter." }).max(2000),
  recommendation: z.string().trim().max(1000).nullable().optional(),
});

/** Pembina mencatat hasil evaluasi berkala (US-P3-01 KP-5, Tahap 3). */
export async function recordEvaluation(ctx: ActorContext, input: z.input<typeof evaluationSchema>, opts: { tx?: Tx; snapshot?: Record<string, unknown> } = {}) {
  await authorize(ctx, "p3.partner_evaluation.create", { tx: opts.tx, objectType: "partner_evaluation", objectId: input?.evaluationId });
  const data = parseInput(evaluationSchema, input, { summary: "Ringkasan", recommendation: "Rekomendasi" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const [row] = await tx.select().from(partnerEvaluations).where(eq(partnerEvaluations.id, data.evaluationId)).for("update").limit(1);
    if (!row) throw new NotFoundError("Evaluasi tidak ditemukan.");
    if (!(await portalEnabled(tx, row.tenantId))) throw new DomainError("PARTNER_PORTAL_DISABLED", "Evaluasi berkala terjadwal adalah fitur portal kemitraan lengkap (Tahap 3) yang belum diaktifkan.");
    if (row.conductedAt) throw new DomainError("EVALUATION_DONE", "Evaluasi ini sudah dicatat.");
    const [updated] = await tx
      .update(partnerEvaluations)
      .set({ conductedAt: ctx.now, conductedBy: ctx.userId, summary: data.summary, recommendation: data.recommendation ?? null, snapshot: opts.snapshot ?? null, updatedAt: ctx.now })
      .where(eq(partnerEvaluations.id, row.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "partner_evaluation", objectId: row.id, action: "conduct", after: { dueDate: row.dueDate, summary: data.summary }, rule: "US-P3-01 KP-5" });
    return updated!;
  });
}

/** Ringkasan uang kontrak untuk tampilan. */
export function describeContractTerms(t: ContractTerms): string {
  const parts = [`Langganan ${formatRupiah(t.subscriptionFeePerOutlet)}/outlet/bulan`];
  if (t.royaltyBp > 0) parts.push(`royalti ${bpToPercent(t.royaltyBp)}%`);
  if (t.waterDiscountBp > 0) parts.push(`diskon air ${bpToPercent(t.waterDiscountBp)}%`);
  if (t.creditLimit > 0) parts.push(`batas kredit ${formatRupiah(t.creditLimit)}`);
  return parts.join(", ");
}
