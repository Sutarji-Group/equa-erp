import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { customers, exclusiveTerritories, notifications, onboardingChecklists, outlets, partnerContracts, partnerEvaluations, partnerProspects, posSales, shifts, tariffZones } from "@/db/schema";
import { EQUA_TENANT_ID, outletId as seedOutlet, tariffZoneId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { setActorResolver } from "@/server/core/actor";
import * as approvals from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { DomainError, ForbiddenError, ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { put } from "@/server/core/storage";
import { createOrder } from "@/server/modules/m2-orders";
import {
  completeOnboardingItem,
  computePartnerBill,
  createContract,
  createContractFromProspect,
  createProspect,
  getProspect,
  overrideRadius,
  recordEvaluation,
  recordPartnerQualityTest,
  recordSurvey,
  registerPartnerDevice,
  registerProspectFromPortal,
  runContractLifecycle,
  signSop,
  submitProspect,
} from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { uniqueSeq } from "../helpers/db-fixtures";
import { createTestUser, type TestUser } from "../helpers/factories";
import { JPEG, PDF } from "../m5-receivables/helpers";
import { admin, at, disablePhase3, dispatcher, enablePhase3, finance, owner, setupPartner, T_SEPT } from "./helpers";

const FEASIBLE = { lat: -6.745, lng: 107.06 };
const NEAR_D02 = { lat: -6.818, lng: 107.1435 };
const FAR = { lat: -7.25, lng: 107.6 };

describe("US-P3-01 Pendaftaran, penilaian lokasi, kontrak, dan onboarding mitra (Tahap 3, flag)", () => {
  const t = useTestDb({ seed: true });
  let coach: TestUser;
  let prospectId: string;
  let contractId: string;
  let tenantId: string;
  let outletId: string;
  let customerId: string;
  beforeAll(async () => {
    bootstrapForTests();
    coach = await createTestUser(t.db, { role: "regional_coach", now: T_SEPT });
  });
  afterAll(async () => {
    setActorResolver(null);
  });
  const coachCtx = (now: Date = T_SEPT) => ({ ...coach.ctx, now });

  it("US-P3-01 KP-1 prospek mendaftar di portal (flag wajib aktif); pembina mencatat survei + foto; sistem menghitung zona, jarak rute dari sumber, radius eksklusif & kapasitas air", async () => {
    const input = { name: "Bu Siti Rahma", businessEntity: "CV Tirta Rahma", waPhone: "0812-7777-1111", proposedAddress: "Jl. Raya Cugenang No. 5, Cianjur", ...FEASIBLE, capitalAmount: 60_000_000 };
    await expect(registerProspectFromPortal(input, { now: T_SEPT })).rejects.toThrow(/Tahap 3/);
    await enablePhase3();
    const reg = await registerProspectFromPortal(input, { now: T_SEPT });
    prospectId = reg.id;
    const notes = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.prospect_registered"), eq(notifications.objectId, reg.id)));
    expect(notes.some((n) => n.recipientUserId === coach.userId)).toBe(true);
    await expect(createProspect(dispatcher(), input)).rejects.toBeInstanceOf(ForbiddenError);
    const photo = await withTx((tx) => put(tx, coachCtx(), { blob: JPEG, contentType: "image/jpeg", kind: "survey_photo" }));
    const res = await recordSurvey(coachCtx(), { prospectId, distanceNotes: "Dekat jalur truk ke SA1", densityNotes: "Perumahan padat", competitorNotes: "1 depot lain 2 km", layoutNotes: "Ruko 4×10 m", recommendation: "Layak, lokasi strategis", photoAttachmentIds: [photo.id] });
    expect(res.assessment).toMatchObject({ outOfReach: false, radiusConflicts: [], status: "feasible" });
    expect(res.assessment.zoneCode).toMatch(/^Z\d$/);
    expect(res.assessment.routeDistanceM).toBeGreaterThan(0);
    expect(res.assessment.capacity).toMatchObject({ roomTrips: 57, perPartnerTrips: 11.4, maxPartners: 5, available: true });
    expect(res.prospect).toMatchObject({ status: "feasible", tariffZoneId: res.assessment.tariffZoneId, radiusViolation: false, capacityAvailable: true });
    // Kapasitas habis (K22) → daftar tunggu kapasitas (9.7).
    const rules = await withTx((tx) => params.get(tx, "p3.partner_rules", "2026-09-10"));
    await params.set(owner(), "p3.partner_rules", { ...rules, capacity_room_trips_per_month: 5 }, "2026-09-10", "Simulasi kapasitas habis");
    const w = await createProspect(coachCtx(), { ...input, name: "Pak Asep Waitlist", waPhone: "0812-7777-2222" });
    const wr = await recordSurvey(coachCtx(), { prospectId: w.id, recommendation: "Layak tetapi kapasitas penuh" });
    expect(wr.prospect.status).toBe("waitlisted");
    await params.set(owner(), "p3.partner_rules", rules, "2026-09-10", "Kembalikan kapasitas");
  });

  it("US-P3-01 KP-2 di luar jangkauan truk → 'tidak layak Fase 1'; melanggar radius → ditolak otomatis kecuali pemilik mengesampingkan dengan alasan", async () => {
    // Zona terjauh dinonaktifkan agar tabel zona berbatas (K19).
    await t.db.update(tariffZones).set({ isActive: false }).where(eq(tariffZones.id, tariffZoneId("Z4")));
    const far = await createProspect(coachCtx(), { name: "Calon Jauh", waPhone: "0812-7777-3333", proposedAddress: "Garut", ...FAR });
    const fr = await recordSurvey(coachCtx(), { prospectId: far.id, recommendation: "Terlalu jauh" });
    expect(fr.prospect.status).toBe("infeasible");
    expect(fr.prospect.infeasibleReason).toMatch(/tidak layak Fase 1/);
    await t.db.update(tariffZones).set({ isActive: true }).where(eq(tariffZones.id, tariffZoneId("Z4")));
    const near = await createProspect(coachCtx(), { name: "Calon Dekat D02", waPhone: "0812-7777-4444", proposedAddress: "Jl. Siliwangi", ...NEAR_D02 });
    const nr = await recordSurvey(coachCtx(), { prospectId: near.id, recommendation: "Dekat depot EQUA" });
    expect(nr.prospect).toMatchObject({ status: "rejected", radiusViolation: true });
    expect(nr.assessment.radiusConflicts[0]).toMatchObject({ kind: "equa_outlet", name: "Depot EQUA Muka" });
    await expect(overrideRadius(coachCtx(), { prospectId: near.id, reason: "Pembina mencoba mengesampingkan" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitProspect(coachCtx(), { prospectId: near.id, reason: "Ajukan yang ditolak" })).rejects.toBeInstanceOf(DomainError);
    const ov = await overrideRadius(owner(), { prospectId: near.id, reason: "Segmen pasar berbeda (kawasan industri), disetujui pemilik" });
    expect(ov.prospect).toMatchObject({ status: "feasible", radiusOverrideReason: "Segmen pasar berbeda (kawasan industri), disetujui pemilik" });
  });

  it("US-P3-01 KP-3 persetujuan pemilik → kontrak berparameter + dokumen perjanjian → tenant & outlet (M6), pelanggan mitra (M1, batas kredit kontrak), wilayah eksklusif", async () => {
    const approval = await submitProspect(coachCtx(), { prospectId, reason: "Lokasi layak, modal cukup" });
    await expect(createContractFromProspect(finance(), { prospectId, tenantCode: "MTRSR", outletCode: "SR1", outletName: "Depot Mitra Tirta Rahma", startDate: "2026-09-15", agreementAttachmentId: newId(), reason: "Kontrak" })).rejects.toThrow(/disetujui pemilik/);
    await approvals.decide(owner(), approval.id, "approve", "Setuju, lanjut kontrak Opsi B");
    expect((await t.db.select().from(partnerProspects).where(eq(partnerProspects.id, prospectId)))[0]!.status).toBe("approved");
    const agreement = await withTx((tx) => put(tx, finance(), { blob: PDF, contentType: "application/pdf", kind: "agreement", originalName: "perjanjian.pdf" }));
    const res = await createContractFromProspect(finance(), { prospectId, tenantCode: "MTRSR", outletCode: "SR1", outletName: "Depot Mitra Tirta Rahma", startDate: "2026-09-15", creditLimit: 2_000_000, agreementAttachmentId: agreement.id, reason: "Perjanjian Opsi B ditandatangani" });
    tenantId = res.tenant.id;
    outletId = res.outlet.id;
    customerId = res.customerId;
    contractId = res.contract.id;
    const [o] = await t.db.select().from(outlets).where(eq(outlets.id, outletId));
    expect(o).toMatchObject({ tenantId, activatedOn: null, lat: FEASIBLE.lat, lng: FEASIBLE.lng });
    const [c] = await t.db.select().from(customers).where(eq(customers.id, customerId));
    expect(c).toMatchObject({ segment: "third_party_depot", isEquaPartner: true, partnerTenantId: tenantId, partnerOutletId: outletId, isStorePartner: true });
    expect(res.contract).toMatchObject({ status: "draft", prospectId, agreementAttachmentId: agreement.id });
    await approvals.decide(owner(), res.approval.id, "approve", "Kontrak disetujui");
    const [after] = await t.db.select().from(customers).where(eq(customers.id, customerId));
    expect(after).toMatchObject({ creditLimit: 2_000_000, creditStatus: "credit" });
    const terr = await t.db.select().from(exclusiveTerritories).where(eq(exclusiveTerritories.contractId, contractId));
    expect(terr).toHaveLength(1);
    expect(terr[0]).toMatchObject({ outletId, radiusM: 1_000, validFrom: "2026-09-15" });
    expect((await t.db.select().from(partnerProspects).where(eq(partnerProspects.id, prospectId)))[0]!.status).toBe("contracted");
    const view = await getProspect(coachCtx(), prospectId);
    expect(view.contracts.map((x) => x.id)).toEqual([contractId]);
    // Wilayah eksklusif baru ikut dinilai untuk calon berikutnya.
    const neighbor = await createProspect(coachCtx(), { name: "Tetangga", waPhone: "0812-7777-5555", proposedAddress: "Sebelah", lat: FEASIBLE.lat + 0.001, lng: FEASIBLE.lng });
    const nb = await recordSurvey(coachCtx(), { prospectId: neighbor.id, recommendation: "Cek radius mitra" });
    expect(nb.assessment.radiusConflicts.some((x) => x.kind === "partner_territory")).toBe(true);
  });

  it("US-P3-01 KP-4 daftar periksa onboarding (pelatihan, SOP tanda tangan digital, peralatan M7, air pertama M2, perangkat POS M10, uji air M8); outlet Aktif hanya setelah semua butir wajib", async () => {
    const items = await t.db.select().from(onboardingChecklists).where(eq(onboardingChecklists.contractId, contractId));
    expect(items.map((i) => i.item).sort()).toEqual(["equipment_order", "first_water_order", "initial_water_test", "pos_device_registered", "sop_signed", "training"]);
    const [contract] = await t.db.select().from(partnerContracts).where(eq(partnerContracts.id, contractId));
    expect((await withTx((tx) => computePartnerBill(tx, contract!, "2026-09"))).outletCount).toBe(0);
    const now = at("2026-09-20T03:00:00Z");
    await expect(completeOnboardingItem(coachCtx(now), { contractId, outletId, item: "training" })).rejects.toBeInstanceOf(ValidationError);
    await completeOnboardingItem(coachCtx(now), { contractId, outletId, item: "training", trainingDate: "2026-09-18", trainingEndDate: "2026-09-19", participants: "Dedi, Rina" });
    await expect(completeOnboardingItem(coachCtx(now), { contractId, outletId, item: "training", trainingDate: "2026-09-18", participants: "x" })).rejects.toThrow(/sudah dicentang/);
    await expect(completeOnboardingItem(coachCtx(now), { contractId, outletId, item: "sop_signed" })).rejects.toThrow(/portal mitra/);
    // Peralatan awal = penjualan toko harga mitra untuk pelanggan mitra.
    const store = seedOutlet("TK1");
    const [shift] = await t.db.insert(shifts).values({ tenantId: EQUA_TENANT_ID, outletId: store, operatorUserId: userIdByUsername("kasir"), businessDate: "2026-09-19", status: "closed", openedAt: now, closedAt: now, openingCashFixed: 200_000 }).returning();
    const [sale] = await t.db
      .insert(posSales)
      .values({ tenantId: EQUA_TENANT_ID, outletId: store, shiftId: shift!.id, number: `TK1-260919-${String(uniqueSeq()).padStart(4, "0")}`, localNumber: `L-${newId()}`, deviceSeq: uniqueSeq(), operatorUserId: userIdByUsername("kasir"), customerId, priceKind: "partner", businessDate: "2026-09-19", soldAt: now, subtotal: 780_000, total: 780_000, paymentMethod: "cash", cashReceived: 780_000, changeAmount: 0 })
      .returning();
    await completeOnboardingItem(coachCtx(now), { contractId, outletId, item: "equipment_order", referenceId: sale!.id });
    const order = await createOrder(dispatcher(now), { customerId, addressId: await firstAddress(customerId), tankCount: 1, requestedDate: "2026-09-21", paymentMethod: "cash" });
    expect(order.status).toBe("created");
    if (order.status !== "created") return;
    await expect(completeOnboardingItem(coachCtx(now), { contractId, outletId, item: "first_water_order", referenceId: newId() })).rejects.toBeInstanceOf(ValidationError);
    await completeOnboardingItem(coachCtx(now), { contractId, outletId, item: "first_water_order", referenceId: order.order.id });
    const dev = await registerPartnerDevice(admin(now), { tenantId, outletId, deviceCode: `TAB-SR-${uniqueSeq()}`, name: "Tablet POS SR1" });
    await completeOnboardingItem(coachCtx(now), { contractId, outletId, item: "pos_device_registered", referenceId: dev.device.id });
    const test = await recordPartnerQualityTest(coachCtx(now), { outletId, testDate: "2026-09-19", laboratory: "Labkesda Cianjur", results: [{ parameter: "E. coli", value: "0", unit: "CFU/100 mL", limit: "0", passed: true }], passed: true, certificate: { blob: PDF, contentType: "application/pdf", name: "sertifikat.pdf" } });
    const res = await completeOnboardingItem(coachCtx(now), { contractId, outletId, item: "initial_water_test", referenceId: test.id });
    expect(res.activated).toBe(false);
    // SOP ditandatangani digital oleh pemilik mitra di portal → semua butir lengkap → outlet Aktif.
    const partnerOwner = await createTestUser(t.db, { role: "partner_owner", tenantId, scope: { tenantIds: [tenantId] } });
    const portal = { ...partnerOwner.ctx, now, source: "partner_portal" as const };
    await expect(signSop(portal, { outletId, signerName: "Siti Rahma", agree: false as unknown as true })).rejects.toBeInstanceOf(ValidationError);
    const signed = await signSop(portal, { outletId, signerName: "Siti Rahma", agree: true });
    expect(signed.activated).toBe(true);
    const [o] = await t.db.select().from(outlets).where(eq(outlets.id, outletId));
    expect(o).toMatchObject({ activatedOn: "2026-09-20", billingStartDate: "2026-09-20" });
    expect(o!.onboardingCompletedAt).not.toBeNull();
    expect((await t.db.select().from(partnerProspects).where(eq(partnerProspects.id, prospectId)))[0]!.status).toBe("active");
    expect((await withTx((tx) => computePartnerBill(tx, contract!, "2026-09"))).outletCount).toBe(1);
  });

  it("US-P3-01 KP-5 jangka kontrak & evaluasi tiap PAR-77 (3 bulan) dijadwalkan otomatis; pengingat 60 hari sebelum berakhir", async () => {
    const [c] = await t.db.select().from(partnerContracts).where(eq(partnerContracts.id, contractId));
    expect(c).toMatchObject({ evaluationIntervalMonths: 3, nextEvaluationDate: "2026-12-15", endDate: "2028-09-14" });
    const life = await runContractLifecycle(at("2026-12-15T00:30:00Z"));
    expect(life.evaluations).toContain(contractId);
    const [ev] = await t.db.select().from(partnerEvaluations).where(eq(partnerEvaluations.contractId, contractId));
    expect(ev).toMatchObject({ dueDate: "2026-12-15", conductedAt: null });
    expect((await t.db.select().from(partnerContracts).where(eq(partnerContracts.id, contractId)))[0]!.nextEvaluationDate).toBe("2027-03-15");
    const done = await recordEvaluation(coachCtx(at("2026-12-16T03:00:00Z")), { evaluationId: ev!.id, summary: "Omzet stabil, neraca air normal, tagihan lancar", recommendation: "Lanjutkan" });
    expect(done.conductedAt).not.toBeNull();
    // Kontrak jangka pendek → pengingat 60 hari sebelum berakhir (sekali).
    const p = await setupPartner(t.db, { contract: false });
    const short = await createContract(finance(), { tenantId: p.tenantId, customerId: p.customerId, startDate: "2026-08-01", termMonths: 3, reason: "Kontrak uji coba 3 bulan" });
    await approvals.decide(owner(), short.approval.id, "approve", "Uji coba");
    const r1 = await runContractLifecycle(at("2026-09-10T00:30:00Z"));
    expect(r1.expiring).toContain(short.contract.id);
    expect((await runContractLifecycle(at("2026-09-11T00:30:00Z"))).expiring).not.toContain(short.contract.id);
    const note = await t.db.select().from(notifications).where(and(eq(notifications.event, "partner.contract_expiring"), eq(notifications.objectId, short.contract.id)));
    expect(note.length).toBeGreaterThan(0);
    // Lewat tanggal berakhir → Berakhir.
    const ended = await runContractLifecycle(at("2026-11-01T00:30:00Z"));
    expect(ended.ended).toContain(short.contract.id);
    await disablePhase3();
  });
});

async function firstAddress(customerId: string): Promise<string> {
  const { getDb } = await import("@/server/core/db");
  const { customerAddresses } = await import("@/db/schema");
  const [a] = await getDb().select({ id: customerAddresses.id }).from(customerAddresses).where(eq(customerAddresses.customerId, customerId)).limit(1);
  return a!.id;
}
