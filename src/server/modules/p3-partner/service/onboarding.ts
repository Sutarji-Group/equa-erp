/**
 * P3 — daftar periksa onboarding outlet mitra (Tahap 3 US-P3-01 KP-4, BRD 9.5; flag `phase3.partner_portal`).
 *
 * Butir wajib per outlet: pelatihan operator 2 hari (tanggal, peserta), SOP diterima (tanda tangan digital pemilik
 * mitra di portal), pesanan peralatan awal ke M7 (penjualan toko harga mitra), pesanan air pertama ke M2, perangkat POS
 * terdaftar (M10), uji air awal (US-M8-06). Butir berujukan diverifikasi terhadap objek modul sumbernya. Outlet
 * berstatus Aktif (`outlets.activated_on`, mulai ditagih langganan) HANYA setelah semua butir wajib dicentang.
 */
import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { devices, onboardingChecklists, orders, outlets, partnerContracts, partnerProspects, posSales, qualityTests } from "@/db/schema";
import { enumValues, label, type EnumValue } from "@/lib/labels";
import { isBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorizeAny, runService } from "@/server/core/rbac";

import { assertOwnerTenant, assertPartnerActor, assertPortalEnabled, authorizePortalAction, contractOutlets, denyCrossTenant, loadContract, ownerTenantId, partnerCustomerForOutlet, type ContractRow } from "./common";

export type OnboardingItem = EnumValue<"onboarding_item">;
export type OnboardingRow = typeof onboardingChecklists.$inferSelect;
export const ONBOARDING_ITEMS = enumValues("onboarding_item") as readonly OnboardingItem[];

/** Buat butir onboarding (idempoten) untuk outlet mitra yang belum Aktif. */
export async function ensureOnboardingChecklist(tx: Tx, contract: ContractRow, outletId: string): Promise<number> {
  let created = 0;
  for (const item of ONBOARDING_ITEMS) {
    const [exists] = await tx
      .select({ id: onboardingChecklists.id })
      .from(onboardingChecklists)
      .where(and(eq(onboardingChecklists.contractId, contract.id), eq(onboardingChecklists.outletId, outletId), eq(onboardingChecklists.item, item)))
      .limit(1);
    if (exists) continue;
    await tx.insert(onboardingChecklists).values({ contractId: contract.id, outletId, item, isRequired: true });
    created++;
  }
  return created;
}

/** Saat kontrak Aktif: daftar periksa untuk setiap outlet depot yang belum Aktif (dipanggil aktivasi kontrak). */
export async function createOnboardingForContract(tx: Tx, contract: ContractRow): Promise<number> {
  // D-13 butir 1: hanya outlet yang dicakup kontrak ini (satu kontrak per outlet) yang belum Aktif.
  const rows = (await contractOutlets(tx, contract, { from: contract.startDate, to: contract.endDate })).filter((o) => !o.activatedOn);
  let n = 0;
  for (const o of rows) n += await ensureOnboardingChecklist(tx, contract, o.id);
  return n;
}

// =====================================================================================================================
// Verifikasi rujukan butir
// =====================================================================================================================

async function verifyReference(tx: Tx, contract: ContractRow, outletId: string, item: OnboardingItem, referenceId: string | null | undefined): Promise<string | null> {
  const needs: Partial<Record<OnboardingItem, string>> = {
    equipment_order: "pos_sale",
    first_water_order: "order",
    pos_device_registered: "device",
    initial_water_test: "quality_test",
  };
  const type = needs[item];
  if (!type) return null;
  if (!referenceId) throw ValidationError.field("referenceId", `Pilih ${label("onboarding_item", item).toLowerCase()} yang menjadi bukti butir ini.`);
  const customer = await partnerCustomerForOutlet(tx, outletId);
  if (item === "equipment_order") {
    const [s] = await tx.select().from(posSales).where(eq(posSales.id, referenceId)).limit(1);
    if (!s || !customer || s.customerId !== customer.id) throw ValidationError.field("referenceId", "Penjualan toko bukan untuk pelanggan mitra outlet ini.");
    if (s.priceKind !== "partner") throw ValidationError.field("referenceId", "Peralatan awal wajib dijual dengan harga mitra (BR-18).");
  } else if (item === "first_water_order") {
    const [o] = await tx.select().from(orders).where(eq(orders.id, referenceId)).limit(1);
    if (!o || !customer || o.customerId !== customer.id) throw ValidationError.field("referenceId", "Pesanan air bukan untuk pelanggan mitra outlet ini.");
    if (o.status === "cancelled") throw ValidationError.field("referenceId", "Pesanan air ini dibatalkan.");
  } else if (item === "pos_device_registered") {
    const [d] = await tx.select().from(devices).where(eq(devices.id, referenceId)).limit(1);
    if (!d || d.tenantId !== contract.tenantId || d.outletId !== outletId) throw ValidationError.field("referenceId", "Perangkat POS bukan milik outlet mitra ini (daftarkan di Rincian mitra).");
    if (d.status === "blocked" || d.status === "wiped" || d.status === "wipe_pending") throw ValidationError.field("referenceId", "Perangkat POS diblokir/dihapus.");
  } else if (item === "initial_water_test") {
    const [q] = await tx.select().from(qualityTests).where(eq(qualityTests.id, referenceId)).limit(1);
    if (!q || q.outletId !== outletId) throw ValidationError.field("referenceId", "Hasil uji air bukan untuk outlet ini.");
    if (!q.passed) throw ValidationError.field("referenceId", "Uji air awal harus LULUS sebelum outlet diaktifkan.");
  }
  return type;
}

/** Aktifkan outlet bila semua butir wajib selesai (idempoten). */
async function activateIfComplete(tx: Tx, ctx: ActorContext, contract: ContractRow, outletId: string): Promise<boolean> {
  const items = await tx.select().from(onboardingChecklists).where(and(eq(onboardingChecklists.contractId, contract.id), eq(onboardingChecklists.outletId, outletId)));
  if (!items.length || items.some((i) => i.isRequired && !i.completedAt)) return false;
  const [o] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).for("update").limit(1);
  if (!o || o.activatedOn) return false;
  const today = ctxBusinessDate(ctx);
  const billingStart = today > contract.startDate ? today : contract.startDate;
  await tx.update(outlets).set({ activatedOn: today, onboardingCompletedAt: ctx.now, billingStartDate: billingStart, updatedAt: ctx.now }).where(eq(outlets.id, outletId));
  await auditRecord(tx, { ctx, objectType: "outlet", objectId: outletId, action: "activate", before: { activatedOn: null }, after: { activatedOn: today, billingStartDate: billingStart }, rule: "US-P3-01 KP-4" });
  if (contract.prospectId) await tx.update(partnerProspects).set({ status: "active", updatedAt: ctx.now }).where(eq(partnerProspects.id, contract.prospectId));
  await notify(tx, {
    event: "partner.onboarding_completed",
    tenantId: await ownerTenantId(tx),
    title: `Outlet mitra ${o.name} Aktif`,
    body: `Semua butir onboarding wajib selesai. Langganan sistem mulai ditagih ${billingStart}.`,
    objectType: "outlet",
    objectId: outletId,
    link: `/kemitraan/mitra/${contract.tenantId}`,
    now: ctx.now,
  });
  return true;
}

// =====================================================================================================================
// Centang butir (pembina) & tanda tangan SOP (mitra, portal)
// =====================================================================================================================

const completeSchema = z.object({
  contractId: z.uuid(),
  outletId: z.uuid(),
  item: z.enum(ONBOARDING_ITEMS as [OnboardingItem, ...OnboardingItem[]]),
  referenceId: z.uuid().nullable().optional(),
  trainingDate: z
    .string()
    .refine(isBusinessDate, { error: "Tanggal pelatihan harus YYYY-MM-DD." })
    .nullable()
    .optional(),
  trainingEndDate: z
    .string()
    .refine(isBusinessDate, { error: "Tanggal selesai pelatihan harus YYYY-MM-DD." })
    .nullable()
    .optional(),
  participants: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  evidenceAttachmentId: z.uuid().nullable().optional(),
});
export type CompleteOnboardingInput = z.input<typeof completeSchema>;

export async function completeOnboardingItem(ctx: ActorContext, input: CompleteOnboardingInput, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.onboarding.update"], { tx: opts.tx, objectType: "onboarding_checklist" });
  const data = parseInput(completeSchema, input, { item: "Butir", referenceId: "Bukti", trainingDate: "Tanggal pelatihan", participants: "Peserta" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const contract = await loadContract(tx, data.contractId);
    await assertPortalEnabled(tx, contract.tenantId);
    if (!["active", "extended"].includes(contract.status)) throw new DomainError("CONTRACT_NOT_ACTIVE", "Onboarding hanya untuk kontrak yang sudah disetujui pemilik.");
    const [row] = await tx
      .select()
      .from(onboardingChecklists)
      .where(and(eq(onboardingChecklists.contractId, contract.id), eq(onboardingChecklists.outletId, data.outletId), eq(onboardingChecklists.item, data.item)))
      .for("update")
      .limit(1);
    if (!row) throw new NotFoundError("Butir onboarding tidak ditemukan untuk outlet ini.");
    if (row.completedAt) throw new DomainError("ONBOARDING_ITEM_DONE", `${label("onboarding_item", data.item)} sudah dicentang.`);
    if (data.item === "sop_signed") throw new DomainError("SOP_SIGN_BY_PARTNER", "SOP ditandatangani digital oleh pemilik mitra dari portal mitra (bukan dicentang pembina).");
    let notes = data.notes ?? null;
    if (data.item === "training") {
      if (!data.trainingDate || !data.participants) throw ValidationError.field("trainingDate", "Isi tanggal pelatihan (2 hari) dan nama peserta.");
      const end = data.trainingEndDate ?? data.trainingDate;
      if (end < data.trainingDate) throw ValidationError.field("trainingEndDate", "Tanggal selesai tidak boleh sebelum tanggal mulai.");
      notes = [`Pelatihan ${data.trainingDate}${end !== data.trainingDate ? ` s.d. ${end}` : ""}`, `Peserta: ${data.participants}`, data.notes].filter(Boolean).join(" · ");
    }
    const referenceType = await verifyReference(tx, contract, data.outletId, data.item, data.referenceId);
    const [updated] = await tx
      .update(onboardingChecklists)
      .set({ completedAt: ctx.now, completedBy: ctx.userId, referenceType, referenceId: data.referenceId ?? null, notes, evidenceAttachmentId: data.evidenceAttachmentId ?? null, updatedAt: ctx.now })
      .where(eq(onboardingChecklists.id, row.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "onboarding_checklist", objectId: row.id, action: "complete", after: { item: data.item, referenceType, referenceId: data.referenceId ?? null, notes }, rule: "US-P3-01 KP-4" });
    const activated = await activateIfComplete(tx, ctx, contract, data.outletId);
    return { item: updated!, activated };
  });
}

const signSchema = z.object({
  outletId: z.uuid(),
  signerName: z.string().trim().min(3, { error: "Ketik nama lengkap Anda sebagai tanda tangan." }).max(120),
  agree: z.literal(true, { error: "Centang pernyataan bahwa Anda telah membaca dan menerima SOP." }),
});

/** Pemilik mitra menandatangani SOP secara digital (nama + waktu + jejak audit) — US-P3-01 KP-4. */
export async function signSop(ctx: ActorContext, input: z.input<typeof signSchema>, opts: { tx?: Tx } = {}) {
  await authorizePortalAction(ctx, "p3.portal_sop.sign", { tx: opts.tx });
  const data = parseInput(signSchema, input, { signerName: "Nama penanda tangan", agree: "Pernyataan" });
  return runService(ctx, opts, async (tx) => {
    const tenant = await assertPartnerActor(tx, ctx);
    const [o] = await tx.select().from(outlets).where(eq(outlets.id, data.outletId)).limit(1);
    if (!o) throw new NotFoundError("Outlet tidak ditemukan.");
    if (o.tenantId !== tenant.id) await denyCrossTenant(ctx, "outlet", "outlet", data.outletId, tx);
    const [row] = await tx
      .select({ item: onboardingChecklists, contract: partnerContracts })
      .from(onboardingChecklists)
      .innerJoin(partnerContracts, eq(partnerContracts.id, onboardingChecklists.contractId))
      .where(and(eq(onboardingChecklists.outletId, o.id), eq(onboardingChecklists.item, "sop_signed"), eq(partnerContracts.tenantId, tenant.id)))
      .limit(1);
    if (!row) throw new DomainError("NO_ONBOARDING", "Tidak ada SOP yang menunggu tanda tangan untuk outlet ini.");
    if (row.item.completedAt) throw new DomainError("SOP_ALREADY_SIGNED", "SOP outlet ini sudah ditandatangani.");
    const notes = `Ditandatangani digital oleh ${data.signerName} (${ctx.now.toISOString()})`;
    await tx.update(onboardingChecklists).set({ completedAt: ctx.now, completedBy: ctx.userId, referenceType: "digital_signature", notes, updatedAt: ctx.now }).where(eq(onboardingChecklists.id, row.item.id));
    await auditRecord(tx, { ctx, objectType: "onboarding_checklist", objectId: row.item.id, action: "sign_sop", after: { signerName: data.signerName, signedAt: ctx.now }, rule: "US-P3-01 KP-4" });
    const activated = await activateIfComplete(tx, ctx, row.contract, o.id);
    return { signedAt: ctx.now, activated };
  });
}

// =====================================================================================================================
// Kueri
// =====================================================================================================================

export type OnboardingOutletView = { contract: ContractRow; outletId: string; outletName: string; activatedOn: string | null; items: OnboardingRow[]; done: number; total: number };

/** Papan onboarding (kontrak Aktif/Diperpanjang dengan outlet berdaftar periksa). */
export async function onboardingBoard(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<OnboardingOutletView[]> {
  await authorizeAny(ctx, ["p3.onboarding.update", "p3.partner_contract.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  return onboardingViews(tx, null);
}

export async function onboardingViews(tx: Tx, tenantId: string | null): Promise<OnboardingOutletView[]> {
  const rows = await tx
    .select({ item: onboardingChecklists, contract: partnerContracts, outletName: outlets.name, activatedOn: outlets.activatedOn })
    .from(onboardingChecklists)
    .innerJoin(partnerContracts, eq(partnerContracts.id, onboardingChecklists.contractId))
    .innerJoin(outlets, eq(outlets.id, onboardingChecklists.outletId))
    .where(tenantId ? eq(partnerContracts.tenantId, tenantId) : inArray(partnerContracts.status, ["active", "extended"]))
    .orderBy(asc(partnerContracts.number), asc(outlets.code));
  const map = new Map<string, OnboardingOutletView>();
  for (const r of rows) {
    const key = `${r.contract.id}:${r.item.outletId}`;
    const v = map.get(key) ?? { contract: r.contract, outletId: r.item.outletId!, outletName: r.outletName, activatedOn: r.activatedOn, items: [], done: 0, total: 0 };
    v.items.push(r.item);
    v.total++;
    if (r.item.completedAt) v.done++;
    map.set(key, v);
  }
  for (const v of map.values()) v.items.sort((a, b) => ONBOARDING_ITEMS.indexOf(a.item) - ONBOARDING_ITEMS.indexOf(b.item));
  return [...map.values()];
}

/** Kandidat rujukan butir (pesanan air, penjualan harga mitra, perangkat, uji air) untuk formulir pembina. */
export async function onboardingCandidates(ctx: ActorContext, input: { contractId: string; outletId: string }, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.onboarding.update"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const contract = await loadContract(tx, input.contractId);
  const customer = await partnerCustomerForOutlet(tx, input.outletId);
  const orderRows = customer ? await tx.select({ id: orders.id, number: orders.number, status: orders.status, requestedDate: orders.requestedDate }).from(orders).where(eq(orders.customerId, customer.id)).orderBy(asc(orders.createdAt)).limit(20) : [];
  const saleRows = customer ? await tx.select({ id: posSales.id, number: posSales.number, total: posSales.total, businessDate: posSales.businessDate }).from(posSales).where(and(eq(posSales.customerId, customer.id), eq(posSales.priceKind, "partner"))).limit(20) : [];
  const deviceRows = await tx.select({ id: devices.id, deviceCode: devices.deviceCode, name: devices.name, status: devices.status }).from(devices).where(and(eq(devices.tenantId, contract.tenantId), eq(devices.outletId, input.outletId)));
  const testRows = await tx.select({ id: qualityTests.id, testDate: qualityTests.testDate, passed: qualityTests.passed, laboratory: qualityTests.laboratory }).from(qualityTests).where(eq(qualityTests.outletId, input.outletId));
  return { orders: orderRows, sales: saleRows, devices: deviceRows, tests: testRows };
}
