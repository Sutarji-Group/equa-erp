/**
 * P3 — calon mitra: pendaftaran, survei & penilaian lokasi, persetujuan pemilik, kontrak → tenant/outlet/pelanggan
 * (Tahap 3 US-P3-01 KP-1..KP-3; flag `phase3.partner_portal`).
 *
 * - KP-1: prospek mendaftar lewat portal publik (`registerProspectFromPortal`) atau dicatat pembina; pembina mencatat
 *   survei (jarak/rute, kepadatan, pesaing, tata letak) + foto; sistem menghitung otomatis zona tarif & jarak rute dari
 *   sumber (M1 `mapAddressToZone`, US-M1-05), pelanggaran radius eksklusif terhadap depot EQUA & wilayah mitra lain
 *   (PAR-35), dan ruang kapasitas air (K22: ruang − komitmen mitra aktif ≥ komitmen per mitra; maks PAR-81 mitra).
 * - KP-2: di luar jangkauan truk (tanpa zona, K19) → "Tidak layak" (Fase 1); radius dilanggar → "Ditolak" otomatis
 *   kecuali pemilik mengesampingkan beralasan; kapasitas habis → "Daftar tunggu kapasitas" (9.7).
 * - KP-3: persetujuan pemilik (`partner_prospect`) → Admin Keuangan menginput kontrak berparameter (Opsi A/B; tenant &
 *   outlet M6, pelanggan mitra M1 + tautan, dokumen perjanjian) → persetujuan kontrak (`partner_contract`) →
 *   aktivasi (batas kredit, wilayah eksklusif, daftar periksa onboarding).
 */
import "server-only";

import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { customers, exclusiveTerritories, outlets, partnerContracts, partnerProspects, partnerSurveys, tenants } from "@/db/schema";
import { haversineMeters } from "@/lib/geo";
import { label } from "@/lib/labels";
import { zRupiahNonNegative } from "@/lib/money";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, authorizeAny, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";
import { normalizeWaNumber } from "@/server/core/wa";
import { createCustomer, mapAddressToZone } from "@/server/modules/m1-master";
import { createPartnerTenant } from "@/server/modules/m6-pos";

import { assertOwnerTenant, assertPortalEnabled, LIVE_CONTRACT_STATUSES, ownerTenantId, partnerRules } from "./common";
import { createContract, type CreateContractInput } from "./contracts";

export type ProspectRow = typeof partnerProspects.$inferSelect;
export type SurveyRow = typeof partnerSurveys.$inferSelect;

const prospectFields = {
  name: z.string().trim().min(3, { error: "Nama calon mitra minimal 3 karakter." }).max(120),
  businessEntity: z.string().trim().max(120).nullable().optional(),
  waPhone: z.string().trim().min(8, { error: "Nomor WA wajib diisi." }).max(30),
  proposedAddress: z.string().trim().min(5, { error: "Alamat lokasi usulan wajib diisi." }).max(300),
  lat: z.coerce.number({ error: "Pilih lokasi di peta." }).min(-90).max(90),
  lng: z.coerce.number({ error: "Pilih lokasi di peta." }).min(-180).max(180),
  capitalAmount: zRupiahNonNegative.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
};
const prospectSchema = z.object(prospectFields);
export type ProspectInput = z.input<typeof prospectSchema>;
const LABELS = { name: "Nama", waPhone: "Nomor WA", proposedAddress: "Alamat usulan", lat: "Lokasi", lng: "Lokasi", capitalAmount: "Modal" };

async function insertProspect(tx: Tx, ctx: ActorContext, data: z.output<typeof prospectSchema>, source: "portal" | "coach"): Promise<ProspectRow> {
  const wa = normalizeWaNumber(data.waPhone);
  if (!wa) throw ValidationError.field("waPhone", "Nomor WA tidak valid. Contoh yang benar: 0812-3456-7890.");
  const equa = await ownerTenantId(tx);
  const [row] = await tx
    .insert(partnerProspects)
    .values({
      tenantId: equa,
      name: data.name,
      businessEntity: data.businessEntity ?? null,
      waPhone: wa,
      proposedAddress: data.proposedAddress,
      proposedLat: data.lat,
      proposedLng: data.lng,
      capitalAmount: data.capitalAmount ?? null,
      status: "prospect",
      notes: data.notes ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  await auditRecord(tx, { ctx, objectType: "partner_prospect", objectId: row!.id, action: "create", after: { name: data.name, source, lat: data.lat, lng: data.lng }, rule: "US-P3-01 KP-1" });
  await notify(tx, {
    event: "partner.prospect_registered",
    tenantId: equa,
    title: `Calon mitra baru: ${data.name}`,
    body: `${data.proposedAddress}${source === "portal" ? " (daftar lewat portal)" : ""}. Jadwalkan survei lokasi.`,
    objectType: "partner_prospect",
    objectId: row!.id,
    link: `/kemitraan/calon/${row!.id}`,
    now: ctx.now,
  });
  return row!;
}

/** KP-1: pendaftaran calon mitra dari portal publik (tanpa akun). Flag global Tahap 3 wajib aktif. */
export async function registerProspectFromPortal(input: ProspectInput, opts: { now?: Date } = {}): Promise<{ id: string }> {
  const data = parseInput(prospectSchema, input, LABELS);
  return withTx(async (tx) => {
    const equa = await ownerTenantId(tx);
    const ctx = systemContext({ tenantId: equa, now: opts.now ?? new Date() });
    await assertPortalEnabled(tx);
    const row = await insertProspect(tx, ctx, data, "portal");
    return { id: row.id };
  });
}

/** KP-1: pembina mencatat calon mitra. */
export async function createProspect(ctx: ActorContext, input: ProspectInput, opts: { tx?: Tx } = {}): Promise<ProspectRow> {
  await authorize(ctx, "p3.partner_prospect.create", { tx: opts.tx, objectType: "partner_prospect" });
  const data = parseInput(prospectSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    await assertPortalEnabled(tx);
    return insertProspect(tx, ctx, data, "coach");
  });
}

// =====================================================================================================================
// KP-1/KP-2: penilaian otomatis
// =====================================================================================================================

export type RadiusConflict = { kind: "equa_outlet" | "partner_territory"; name: string; distanceM: number; radiusM: number };
export type ProspectAssessment = {
  referenceWaterSourceId: string | null;
  referenceWaterSourceName: string | null;
  routeDistanceM: number | null;
  distanceMethod: string | null;
  tariffZoneId: string | null;
  zoneCode: string | null;
  outOfReach: boolean;
  radiusConflicts: RadiusConflict[];
  capacity: { roomTrips: number; committedTrips: number; perPartnerTrips: number; activePartners: number; maxPartners: number; available: boolean };
  status: "feasible" | "infeasible" | "rejected" | "waitlisted";
  reason: string | null;
};

/** Hitung penilaian lokasi (tanpa menulis). `radiusOverridden` = pemilik sudah mengesampingkan pelanggaran radius. */
export async function assessLocation(tx: Tx, input: { lat: number; lng: number; date: string; radiusOverridden?: boolean; excludeTenantId?: string | null }): Promise<ProspectAssessment> {
  const equa = await ownerTenantId(tx);
  let mapping: Awaited<ReturnType<typeof mapAddressToZone>> | null = null;
  try {
    mapping = await mapAddressToZone(tx, { lat: input.lat, lng: input.lng, tenantId: equa, date: input.date });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
  const p35 = await params.get(tx, "PAR-35", input.date);
  const point = { lat: input.lat, lng: input.lng };
  const conflicts: RadiusConflict[] = [];
  const depots = await tx
    .select({ id: outlets.id, name: outlets.name, lat: outlets.lat, lng: outlets.lng })
    .from(outlets)
    .innerJoin(tenants, eq(tenants.id, outlets.tenantId))
    .where(and(eq(tenants.kind, "owner"), eq(outlets.kind, "depot"), eq(outlets.isActive, true)));
  for (const d of depots) {
    if (d.lat === null || d.lng === null) continue;
    const dist = Math.round(haversineMeters(point, { lat: d.lat, lng: d.lng }));
    if (dist < p35.exclusive_radius_m_option_b) conflicts.push({ kind: "equa_outlet", name: d.name, distanceM: dist, radiusM: p35.exclusive_radius_m_option_b });
  }
  const territories = await tx
    .select({ t: exclusiveTerritories, outletName: outlets.name, tenantId: outlets.tenantId })
    .from(exclusiveTerritories)
    .innerJoin(outlets, eq(outlets.id, exclusiveTerritories.outletId))
    .where(and(eq(exclusiveTerritories.isActive, true), sql`(${exclusiveTerritories.validUntil} is null or ${exclusiveTerritories.validUntil} >= ${input.date})`));
  for (const { t, outletName, tenantId } of territories) {
    if (input.excludeTenantId && tenantId === input.excludeTenantId) continue;
    const dist = Math.round(haversineMeters(point, { lat: t.centerLat, lng: t.centerLng }));
    if (dist < t.radiusM) conflicts.push({ kind: "partner_territory", name: outletName, distanceM: dist, radiusM: t.radiusM });
  }
  const rules = await partnerRules(tx, input.date);
  const p81 = await params.get(tx, "PAR-81", input.date);
  const [{ n }] = (await tx
    .select({ n: count(sql`distinct ${partnerContracts.tenantId}`) })
    .from(partnerContracts)
    .where(inArray(partnerContracts.status, [...LIVE_CONTRACT_STATUSES]))) as [{ n: number }];
  const activePartners = Number(n);
  const committed = activePartners * rules.commitment_trips_per_partner;
  const available = activePartners < p81.count && rules.capacity_room_trips_per_month - committed >= rules.commitment_trips_per_partner;
  const outOfReach = !mapping || !mapping.zoneId;
  let status: ProspectAssessment["status"] = "feasible";
  let reason: string | null = null;
  if (outOfReach) {
    status = "infeasible";
    reason = mapping ? `Di luar jangkauan truk: jarak rute ${Math.round(mapping.distanceM / 100) / 10} km dari ${mapping.referenceWaterSourceName} melampaui zona tarif (K19) — tidak layak Fase 1.` : "Jarak dari sumber air tidak dapat dihitung — tidak layak Fase 1.";
  } else if (conflicts.length && !input.radiusOverridden) {
    status = "rejected";
    reason = `Melanggar radius eksklusif (PAR-35): ${conflicts.map((c) => `${c.name} ${c.distanceM} m < ${c.radiusM} m`).join("; ")}. Ditolak otomatis kecuali pemilik mengesampingkan dengan alasan.`;
  } else if (!available) {
    status = "waitlisted";
    reason = `Ruang kapasitas air mitra habis: ${activePartners}/${p81.count} mitra (PAR-81), komitmen ${committed} dari ${rules.capacity_room_trips_per_month} rit/bulan (K22).`;
  }
  return {
    referenceWaterSourceId: mapping?.referenceWaterSourceId ?? null,
    referenceWaterSourceName: mapping?.referenceWaterSourceName ?? null,
    routeDistanceM: mapping?.distanceM ?? null,
    distanceMethod: mapping?.distanceMethod ?? null,
    tariffZoneId: mapping?.zoneId ?? null,
    zoneCode: mapping?.zoneCode ?? null,
    outOfReach,
    radiusConflicts: conflicts,
    capacity: { roomTrips: rules.capacity_room_trips_per_month, committedTrips: committed, perPartnerTrips: rules.commitment_trips_per_partner, activePartners, maxPartners: p81.count, available },
    status,
    reason,
  };
}

async function applyAssessment(tx: Tx, ctx: ActorContext, prospect: ProspectRow): Promise<{ prospect: ProspectRow; assessment: ProspectAssessment }> {
  if (prospect.proposedLat === null || prospect.proposedLng === null) throw ValidationError.field("lat", "Lokasi usulan belum dipilih di peta.");
  const assessment = await assessLocation(tx, { lat: prospect.proposedLat, lng: prospect.proposedLng, date: ctxBusinessDate(ctx), radiusOverridden: !!prospect.radiusOverrideReason });
  const [row] = await tx
    .update(partnerProspects)
    .set({
      status: assessment.status,
      referenceWaterSourceId: assessment.referenceWaterSourceId,
      routeDistanceM: assessment.routeDistanceM,
      tariffZoneId: assessment.tariffZoneId,
      radiusViolation: assessment.radiusConflicts.length > 0,
      capacityAvailable: assessment.capacity.available,
      infeasibleReason: assessment.reason,
      updatedAt: ctx.now,
    })
    .where(eq(partnerProspects.id, prospect.id))
    .returning();
  await auditRecord(tx, {
    ctx,
    objectType: "partner_prospect",
    objectId: prospect.id,
    action: "assess",
    before: { status: prospect.status },
    after: { status: assessment.status, zone: assessment.zoneCode, routeDistanceM: assessment.routeDistanceM, radiusConflicts: assessment.radiusConflicts.length, capacityAvailable: assessment.capacity.available },
    reason: assessment.reason,
    rule: "US-P3-01 KP-1/KP-2",
  });
  return { prospect: row!, assessment };
}

async function loadProspect(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<ProspectRow> {
  const q = tx.select().from(partnerProspects).where(eq(partnerProspects.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  if (!rows[0]) throw new NotFoundError("Calon mitra tidak ditemukan.");
  return rows[0];
}

const surveySchema = z.object({
  prospectId: z.uuid(),
  distanceNotes: z.string().trim().max(1000).nullable().optional(),
  densityNotes: z.string().trim().max(1000).nullable().optional(),
  competitorNotes: z.string().trim().max(1000).nullable().optional(),
  layoutNotes: z.string().trim().max(1000).nullable().optional(),
  recommendation: z.string().trim().min(5, { error: "Tulis rekomendasi pembina (minimal 5 karakter)." }).max(1000),
  scores: z.record(z.string(), z.number().min(0).max(100)).nullable().optional(),
  photoAttachmentIds: z.array(z.uuid()).max(10).default([]),
});
export type SurveyInput = z.input<typeof surveySchema>;

/** KP-1: survei lokasi + penilaian otomatis (zona, jarak, radius, kapasitas). */
export async function recordSurvey(ctx: ActorContext, input: SurveyInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_survey.create", { tx: opts.tx, objectType: "partner_prospect", objectId: input?.prospectId });
  const data = parseInput(surveySchema, input, { recommendation: "Rekomendasi", photoAttachmentIds: "Foto" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    await assertPortalEnabled(tx);
    const prospect = await loadProspect(tx, data.prospectId, { forUpdate: true });
    if (["approved", "contracted", "onboarding", "active"].includes(prospect.status)) {
      throw new DomainError("PROSPECT_DECIDED", `Calon mitra sudah ${label("prospect_status", prospect.status).toLowerCase()}; survei baru tidak mengubah keputusan.`);
    }
    const [survey] = await tx
      .insert(partnerSurveys)
      .values({
        prospectId: prospect.id,
        surveyedAt: ctx.now,
        surveyorUserId: ctx.userId,
        distanceNotes: data.distanceNotes ?? null,
        densityNotes: data.densityNotes ?? null,
        competitorNotes: data.competitorNotes ?? null,
        layoutNotes: data.layoutNotes ?? null,
        scores: data.scores ?? null,
        recommendation: data.recommendation,
        createdBy: ctx.userId,
      })
      .returning();
    for (const id of data.photoAttachmentIds) await linkAttachment(tx, id, { type: "partner_survey", id: survey!.id });
    await auditRecord(tx, { ctx, objectType: "partner_survey", objectId: survey!.id, action: "create", after: { prospectId: prospect.id, photos: data.photoAttachmentIds.length, recommendation: data.recommendation }, rule: "US-P3-01 KP-1" });
    const res = await applyAssessment(tx, ctx, { ...prospect, status: "surveyed" });
    return { survey: survey!, ...res };
  });
}

const overrideSchema = z.object({ prospectId: z.uuid(), reason: z.string().trim().min(10, { error: "Alasan mengesampingkan radius wajib (minimal 10 karakter)." }).max(500) });

/** KP-2: pemilik mengesampingkan pelanggaran radius eksklusif (beralasan) → penilaian ulang. */
export async function overrideRadius(ctx: ActorContext, input: z.input<typeof overrideSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_prospect.waive_radius", { tx: opts.tx, objectType: "partner_prospect", objectId: input?.prospectId });
  const data = parseInput(overrideSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    await assertPortalEnabled(tx);
    const prospect = await loadProspect(tx, data.prospectId, { forUpdate: true });
    if (!prospect.radiusViolation) throw new DomainError("NO_RADIUS_VIOLATION", "Calon mitra ini tidak melanggar radius eksklusif.");
    await tx.update(partnerProspects).set({ radiusOverrideReason: data.reason, radiusOverrideBy: ctx.userId, updatedAt: ctx.now }).where(eq(partnerProspects.id, prospect.id));
    await auditRecord(tx, { ctx, objectType: "partner_prospect", objectId: prospect.id, action: "override_radius", after: { radiusOverrideReason: data.reason }, reason: data.reason, rule: "US-P3-01 KP-2" });
    return applyAssessment(tx, ctx, { ...prospect, radiusOverrideReason: data.reason });
  });
}

const submitSchema = z.object({ prospectId: z.uuid(), reason: z.string().trim().min(5, { error: "Tulis ringkasan usulan (minimal 5 karakter)." }).max(1000) });

/** KP-3: pembina mengajukan calon mitra Layak ke pemilik (`partner_prospect`). */
export async function submitProspect(ctx: ActorContext, input: z.input<typeof submitSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_prospect.update", { tx: opts.tx, objectType: "partner_prospect", objectId: input?.prospectId });
  const data = parseInput(submitSchema, input, { reason: "Ringkasan usulan" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    await assertPortalEnabled(tx);
    const prospect = await loadProspect(tx, data.prospectId, { forUpdate: true });
    if (prospect.status !== "feasible") throw new DomainError("PROSPECT_NOT_FEASIBLE", `Hanya calon mitra berstatus Layak yang dapat diajukan (status sekarang: ${label("prospect_status", prospect.status)}).`);
    const approval = await approvals.submit(
      ctx,
      {
        type: "partner_prospect",
        objectType: "partner_prospect",
        objectId: prospect.id,
        reason: data.reason,
        payload: { name: prospect.name, address: prospect.proposedAddress, routeDistanceM: prospect.routeDistanceM, radiusOverride: prospect.radiusOverrideReason, link: `/kemitraan/calon/${prospect.id}` },
      },
      { tx },
    );
    await tx.update(partnerProspects).set({ approvalRequestId: approval.id, updatedAt: ctx.now }).where(eq(partnerProspects.id, prospect.id));
    await auditRecord(tx, { ctx, objectType: "partner_prospect", objectId: prospect.id, action: "submit", after: { approval: approval.number }, reason: data.reason, rule: "US-P3-01 KP-3" });
    return approval;
  });
}

/** Handler persetujuan calon mitra (ctx = pemilik). */
export async function decideProspect(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow, decision: "approved" | "rejected", reason: string | null) {
  const prospect = await loadProspect(tx, request.objectId, { forUpdate: true });
  if (prospect.status !== "feasible") return { skipped: `Status ${label("prospect_status", prospect.status)}` };
  const status = decision === "approved" ? "approved" : "rejected";
  await tx.update(partnerProspects).set({ status, notes: reason ? [prospect.notes, `Keputusan pemilik: ${reason}`].filter(Boolean).join("\n") : prospect.notes, updatedAt: ctx.now }).where(eq(partnerProspects.id, prospect.id));
  await auditRecord(tx, { ctx, objectType: "partner_prospect", objectId: prospect.id, action: decision === "approved" ? "approve" : "reject", before: { status: prospect.status }, after: { status }, reason, rule: "US-P3-01 KP-3, 6.2a" });
  return { status };
}

// =====================================================================================================================
// KP-3: kontrak dari calon mitra → tenant, outlet, pelanggan mitra (+ tautan) → persetujuan kontrak
// =====================================================================================================================

const contractFromProspectSchema = z.object({
  prospectId: z.uuid(),
  tenantCode: z.string().trim().min(2).max(10).regex(/^[A-Za-z0-9]+$/, { error: "Kode tenant hanya huruf dan angka." }),
  tenantName: z.string().trim().min(3).max(120).nullable().optional(),
  outletCode: z.string().trim().min(2).max(10).regex(/^[A-Za-z0-9]+$/, { error: "Kode outlet hanya huruf dan angka." }),
  outletName: z.string().trim().min(3).max(120),
  option: z.enum(["option_b", "option_a"]).default("option_b"),
  startDate: z.string(),
  termMonths: z.coerce.number().int().min(1).max(120).nullable().optional(),
  subscriptionFeePerOutlet: zRupiahNonNegative.nullable().optional(),
  initialFee: zRupiahNonNegative.nullable().optional(),
  royaltyPercent: z.coerce.number().min(0).max(100).nullable().optional(),
  waterDiscountPercent: z.coerce.number().min(0).max(100).nullable().optional(),
  exclusiveRadiusM: z.coerce.number().int().min(0).max(20_000).nullable().optional(),
  creditLimit: zRupiahNonNegative.nullable().optional(),
  monthlyBilling: z.boolean().default(false),
  agreementAttachmentId: z.uuid({ error: "Unggah dokumen perjanjian kemitraan." }),
  reason: z.string().trim().min(5).max(500),
});
export type ContractFromProspectInput = z.input<typeof contractFromProspectSchema>;

/**
 * Admin Keuangan: kontrak berparameter dari calon mitra yang disetujui pemilik. Membuat tenant & outlet mitra (M6,
 * katalog standar disalin; outlet BELUM Aktif sampai onboarding lengkap), pelanggan mitra (M1, segmen depot pihak
 * ketiga + penanda mitra depot EQUA & mitra toko, alamat = lokasi outlet) lalu kontrak Draf + persetujuan pemilik.
 */
export async function createContractFromProspect(ctx: ActorContext, input: ContractFromProspectInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_contract.create", { tx: opts.tx, objectType: "partner_prospect", objectId: input?.prospectId });
  const data = parseInput(contractFromProspectSchema, input, { tenantCode: "Kode tenant", outletCode: "Kode outlet", outletName: "Nama outlet", startDate: "Tanggal mulai", agreementAttachmentId: "Dokumen perjanjian", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    await assertPortalEnabled(tx);
    const prospect = await loadProspect(tx, data.prospectId, { forUpdate: true });
    if (prospect.status !== "approved") throw new DomainError("PROSPECT_NOT_APPROVED", "Kontrak hanya untuk calon mitra yang sudah disetujui pemilik.");
    const equa = await ownerTenantId(tx);
    const sys = systemContext({ tenantId: equa, now: ctx.now, businessDate: ctxBusinessDate(ctx) });
    const created = await createPartnerTenant(
      sys,
      { code: data.tenantCode, name: data.tenantName ?? prospect.name, outlets: [{ code: data.outletCode, name: data.outletName, address: prospect.proposedAddress }], copyStandardCatalog: true, reason: `Kontrak mitra dari calon ${prospect.name}: ${data.reason}` },
      { tx },
    );
    const outlet = created.outlets[0]!;
    // Outlet mitra Tahap 3 baru Aktif setelah daftar periksa onboarding lengkap (US-P3-01 KP-4).
    await tx.update(outlets).set({ activatedOn: null, lat: prospect.proposedLat, lng: prospect.proposedLng, updatedAt: ctx.now }).where(eq(outlets.id, outlet.id));
    const cust = await createCustomer(
      ctx,
      {
        name: prospect.businessEntity ?? prospect.name,
        segment: "third_party_depot",
        waPhone: prospect.waPhone,
        contactName: prospect.name,
        notes: `Mitra depot EQUA — outlet ${data.outletName}`,
        addresses: [{ label: data.outletName, addressText: prospect.proposedAddress ?? data.outletName, lat: prospect.proposedLat, lng: prospect.proposedLng }],
        confirmDuplicate: true,
        duplicateNote: "Pelanggan mitra dibuat dari kontrak calon mitra",
      },
      { tx, skipAuthorize: true },
    );
    if (cust.status !== "created") throw new DomainError("CUSTOMER_NOT_CREATED", "Pelanggan mitra gagal dibuat. Periksa data calon mitra.");
    const customerId = cust.customer.id;
    await tx
      .update(customers)
      .set({ isEquaPartner: true, partnerTenantId: created.tenant.id, partnerOutletId: outlet.id, isStorePartner: true, storePartnerSource: "manual", updatedAt: ctx.now })
      .where(eq(customers.id, customerId));
    await auditRecord(tx, { ctx, objectType: "customer", objectId: customerId, action: "update", after: { isEquaPartner: true, partnerTenantId: created.tenant.id, partnerOutletId: outlet.id, isStorePartner: true }, reason: data.reason, rule: "US-P3-01 KP-3, BR-18" });
    const contractInput: CreateContractInput = {
      tenantId: created.tenant.id,
      customerId,
      option: data.option,
      startDate: data.startDate,
      termMonths: data.termMonths ?? null,
      subscriptionFeePerOutlet: data.subscriptionFeePerOutlet ?? null,
      initialFee: data.initialFee ?? null,
      royaltyPercent: data.royaltyPercent ?? null,
      waterDiscountPercent: data.waterDiscountPercent ?? null,
      exclusiveRadiusM: data.exclusiveRadiusM ?? null,
      creditLimit: data.creditLimit ?? null,
      monthlyBilling: data.monthlyBilling,
      agreementAttachmentId: data.agreementAttachmentId,
      prospectId: prospect.id,
      reason: data.reason,
    };
    const res = await createContract(ctx, contractInput, { tx });
    await tx.update(partnerProspects).set({ status: "contracted", partnerTenantId: created.tenant.id, updatedAt: ctx.now }).where(eq(partnerProspects.id, prospect.id));
    await auditRecord(tx, { ctx, objectType: "partner_prospect", objectId: prospect.id, action: "contract", before: { status: "approved" }, after: { status: "contracted", tenantId: created.tenant.id, contract: res.contract.number }, rule: "US-P3-01 KP-3" });
    return { ...res, tenant: created.tenant, outlet, customerId };
  });
}

// =====================================================================================================================
// Kueri
// =====================================================================================================================

export async function listProspects(ctx: ActorContext, filter: { status?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.partner_prospect.create", "p3.partner.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const rows = await tx
    .select()
    .from(partnerProspects)
    .where(filter.status ? eq(partnerProspects.status, filter.status as ProspectRow["status"]) : undefined)
    .orderBy(desc(partnerProspects.createdAt))
    .limit(300);
  return rows;
}

export async function getProspect(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.partner_prospect.create", "p3.partner.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const prospect = await loadProspect(tx, id);
  const surveys = await tx.select().from(partnerSurveys).where(eq(partnerSurveys.prospectId, id)).orderBy(desc(partnerSurveys.surveyedAt));
  const approvalList = await approvals.listForObject(tx, "partner_prospect", id);
  const assessment =
    prospect.proposedLat !== null && prospect.proposedLng !== null
      ? await assessLocation(tx, { lat: prospect.proposedLat, lng: prospect.proposedLng, date: ctxBusinessDate(ctx), radiusOverridden: !!prospect.radiusOverrideReason })
      : null;
  const contracts = await tx.select().from(partnerContracts).where(eq(partnerContracts.prospectId, id)).orderBy(asc(partnerContracts.createdAt));
  return { prospect, surveys, approvals: approvalList, assessment, contracts };
}
