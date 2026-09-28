/**
 * P3 — pembantu bersama modul Kemitraan (RL-7 & Tahap 3): tenant/outlet/kontrak/pelanggan mitra, flag Tahap 3,
 * istilah "Mitra Depot EQUA" / "Waralaba" (PTB-57), otorisasi tindakan portal Tahap 3, notifikasi sekali per kunci,
 * dan utilitas bulan layanan.
 *
 * ISOLASI (NFR-30): data mitra hidup di tenant mitra (`tenants.kind = partner`); pelanggan mitra, pesanan air, faktur,
 * & kontrak dibaca/ditulis di tenant EQUA (`kind = owner`). Layanan kantor P3 WAJIB dipanggil pelaku tenant EQUA
 * (`assertOwnerTenant`), layanan portal WAJIB memakai `ctx.tenantId` pelaku (pemilik mitra) — tidak pernah parameter.
 */
import "server-only";

import { and, asc, desc, eq, inArray, lte, or, gte } from "drizzle-orm";

import { customers, notifications, outlets, partnerContracts, tenants } from "@/db/schema";
import { addDays, firstDayOfMonth, lastDayOfMonth, type BusinessDate } from "@/lib/time";

import { EQUA_TENANT_ID, hasRole, isSystem, type ActorContext } from "@/server/core/context";
import { getDb, isTransaction, type Tx } from "@/server/core/db";
import { DomainError, ForbiddenError, NotFoundError } from "@/server/core/errors";
import * as flags from "@/server/core/flags";
import { notify, type NotifyInput } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, recordDenial } from "@/server/core/rbac";

export type TenantRow = typeof tenants.$inferSelect;
export type OutletRow = typeof outlets.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type ContractRow = typeof partnerContracts.$inferSelect;

/** Status kontrak yang masih mengikat (ditagih, dipantau). */
export const LIVE_CONTRACT_STATUSES = ["active", "extended"] as const;

// =====================================================================================================================
// Tenant
// =====================================================================================================================

/** Tenant pemilik program kemitraan (EQUA): tenant `owner` pertama. */
export async function ownerTenantId(tx: Tx): Promise<string> {
  const [row] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.kind, "owner")).orderBy(asc(tenants.createdAt)).limit(1);
  return row?.id ?? EQUA_TENANT_ID;
}

export async function loadTenant(tx: Tx, tenantId: string): Promise<TenantRow | null> {
  const [row] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return row ?? null;
}

/** Tenant mitra (NotFound bila bukan tenant mitra). */
export async function loadPartnerTenant(tx: Tx, tenantId: string): Promise<TenantRow> {
  const row = await loadTenant(tx, tenantId);
  if (!row || row.kind !== "partner") throw new NotFoundError("Mitra tidak ditemukan.");
  return row;
}

/** Pelaku kantor P3 wajib dari tenant EQUA (pemilik program); tenant mitra tidak pernah membuka layar EQUA. */
export async function assertOwnerTenant(tx: Tx, ctx: ActorContext): Promise<void> {
  if (isSystem(ctx)) return;
  const row = await loadTenant(tx, ctx.tenantId);
  if (row?.kind !== "owner") {
    throw new ForbiddenError("Layar kemitraan EQUA hanya untuk pengguna EQUA (NFR-30).", { rule: "NFR-30", objectType: "tenant", objectId: ctx.tenantId });
  }
}

/** Pelaku portal wajib pemilik tenant mitra (tenant sendiri). */
export async function assertPartnerActor(tx: Tx, ctx: ActorContext): Promise<TenantRow> {
  const row = await loadTenant(tx, ctx.tenantId);
  if (!row || row.kind !== "partner" || !ctx.scope.tenantIds.includes(row.id)) {
    throw new ForbiddenError("Portal mitra hanya untuk pemilik mitra pada tenantnya sendiri (NFR-30).", { rule: "NFR-30", objectType: "tenant", objectId: ctx.tenantId });
  }
  return row;
}

export async function partnerTenants(tx: Tx, opts: { includeInactive?: boolean } = {}): Promise<TenantRow[]> {
  const conds = [eq(tenants.kind, "partner")];
  if (!opts.includeInactive) conds.push(eq(tenants.isActive, true));
  return tx.select().from(tenants).where(and(...conds)).orderBy(asc(tenants.code));
}

export async function tenantOutlets(tx: Tx, tenantId: string, opts: { depotOnly?: boolean } = {}): Promise<OutletRow[]> {
  const conds = [eq(outlets.tenantId, tenantId)];
  if (opts.depotOnly) conds.push(eq(outlets.kind, "depot"));
  return tx.select().from(outlets).where(and(...conds)).orderBy(asc(outlets.code));
}

/** Outlet milik tenant tertentu; bila outlet ada tetapi milik tenant lain → `null` (pemanggil memutuskan tolak/abaikan). */
export async function outletOfTenant(tx: Tx, tenantId: string, outletId: string): Promise<{ outlet: OutletRow | null; foreign: boolean }> {
  const [row] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).limit(1);
  if (!row) return { outlet: null, foreign: false };
  if (row.tenantId !== tenantId) return { outlet: null, foreign: true };
  return { outlet: row, foreign: false };
}

// =====================================================================================================================
// Pelanggan & kontrak mitra
// =====================================================================================================================

/** Pelanggan mitra depot EQUA (tenant EQUA) yang tertaut ke tenant mitra. */
export async function partnerCustomersOf(tx: Tx, partnerTenantId: string): Promise<CustomerRow[]> {
  return tx
    .select()
    .from(customers)
    .where(and(eq(customers.isEquaPartner, true), eq(customers.partnerTenantId, partnerTenantId)))
    .orderBy(asc(customers.name));
}

/** Pelanggan mitra yang tertaut ke outlet mitra tertentu (null bila bukan outlet mitra). */
export async function partnerCustomerForOutlet(tx: Tx, outletId: string): Promise<CustomerRow | null> {
  const [row] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.isEquaPartner, true), eq(customers.partnerOutletId, outletId)))
    .limit(1);
  return row ?? null;
}

export async function loadContract(tx: Tx, contractId: string, opts: { forUpdate?: boolean } = {}): Promise<ContractRow> {
  const q = tx.select().from(partnerContracts).where(eq(partnerContracts.id, contractId)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  if (!rows[0]) throw new NotFoundError("Kontrak mitra tidak ditemukan.");
  return rows[0];
}

/** Kontrak yang berlaku pada tanggal (Aktif/Diperpanjang, mulai ≤ tanggal ≤ berakhir), terbaru dulu. */
export async function activeContractFor(tx: Tx, partnerTenantId: string, date: BusinessDate): Promise<ContractRow | null> {
  const [row] = await tx
    .select()
    .from(partnerContracts)
    .where(
      and(
        eq(partnerContracts.tenantId, partnerTenantId),
        inArray(partnerContracts.status, [...LIVE_CONTRACT_STATUSES]),
        lte(partnerContracts.startDate, date),
        gte(partnerContracts.endDate, date),
      ),
    )
    .orderBy(desc(partnerContracts.startDate))
    .limit(1);
  return row ?? null;
}

/** Kontrak terbaru tenant mitra (status apa pun). */
export async function latestContractFor(tx: Tx, partnerTenantId: string): Promise<ContractRow | null> {
  const [row] = await tx
    .select()
    .from(partnerContracts)
    .where(eq(partnerContracts.tenantId, partnerTenantId))
    .orderBy(desc(partnerContracts.startDate), desc(partnerContracts.createdAt))
    .limit(1);
  return row ?? null;
}

export async function contractsLiveOn(tx: Tx, from: BusinessDate, to: BusinessDate): Promise<ContractRow[]> {
  return tx
    .select()
    .from(partnerContracts)
    .where(
      and(
        or(eq(partnerContracts.status, "active"), eq(partnerContracts.status, "extended"), eq(partnerContracts.status, "ended"), eq(partnerContracts.status, "terminated")),
        lte(partnerContracts.startDate, to),
        gte(partnerContracts.endDate, from),
      ),
    )
    .orderBy(asc(partnerContracts.number));
}

// =====================================================================================================================
// Flag Tahap 3, istilah, otorisasi portal
// =====================================================================================================================

/** Portal kemitraan lengkap Tahap 3 aktif (global atau untuk tenant mitra ini) — D-02. */
export async function portalEnabled(tx: Tx, tenantId?: string | null): Promise<boolean> {
  return flags.isEnabled(tx, "phase3.partner_portal", tenantId ? { tenantId } : {});
}

/** Tolak tindakan Tahap 3 bila flag mati (bawaan) — RL-7 tetap berjalan. */
export async function assertPortalEnabled(tx: Tx, tenantId?: string | null): Promise<void> {
  if (!(await portalEnabled(tx, tenantId))) {
    throw new DomainError(
      "PARTNER_PORTAL_DISABLED",
      "Fitur ini bagian dari portal kemitraan lengkap (Tahap 3) yang belum diaktifkan pemilik. Minta pemilik mengaktifkan flag \"Portal kemitraan lengkap\" setelah prasyarat Bab 9.1 terpenuhi.",
    );
  }
}

export type PartnerTerms = { partner: string; program: string; franchise: boolean };

/** Istilah antarmuka (PTB-57): "Mitra Depot EQUA" sampai flag `partner.franchise_terms` diaktifkan pemilik. */
export async function partnerTerms(tx: Tx): Promise<PartnerTerms> {
  const franchise = await flags.isEnabled(tx, "partner.franchise_terms");
  return franchise
    ? { partner: "Waralaba EQUA", program: "Waralaba EQUA", franchise: true }
    : { partner: "Mitra Depot EQUA", program: "Kemitraan Depot EQUA", franchise: false };
}

/**
 * Otorisasi tindakan portal Tahap 3 (`p3.portal_*`). Izin ini TIDAK diberikan statis ke peran mana pun (Pemilik mitra
 * baca-saja pada RL-7, US-P3-10 KP-1); diberikan BERSYARAT ke Pemilik mitra pada tenantnya sendiri hanya bila flag
 * `phase3.partner_portal` aktif untuk tenant itu (D-02). Selain itu → `authorize` biasa (ditolak & tercatat).
 */
export async function authorizePortalAction(ctx: ActorContext, permission: string, opts: { tx?: Tx } = {}): Promise<void> {
  const db = opts.tx ?? getDb();
  if (hasRole(ctx, "partner_owner") && ctx.scope.tenantIds.includes(ctx.tenantId)) {
    const tenant = await loadTenant(db, ctx.tenantId);
    if (tenant?.kind === "partner" && (await portalEnabled(db, ctx.tenantId))) return;
  }
  await authorize(ctx, permission, { tx: opts.tx });
}

/** Tolak & catat percobaan lintas tenant (US-P3-10 KP-4, US-M10-03). */
export async function denyCrossTenant(ctx: ActorContext, what: string, objectType: string, objectId: string, tx?: Tx): Promise<never> {
  const error = new ForbiddenError(`Anda hanya dapat membuka ${what} milik tenant Anda sendiri (NFR-30).`, { rule: "NFR-30", objectType, objectId });
  if (!isTransaction(tx)) await recordDenial(ctx, error);
  throw error;
}

// =====================================================================================================================
// Notifikasi sekali per kunci
// =====================================================================================================================

/** Kirim notifikasi hanya bila belum pernah ada notifikasi berkode & `groupKey` sama di tenant itu. */
export async function notifyOnce(tx: Tx, input: NotifyInput & { groupKey: string }): Promise<boolean> {
  const [existing] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.tenantId, input.tenantId), eq(notifications.event, input.event), eq(notifications.groupKey, input.groupKey)))
    .limit(1);
  if (existing) return false;
  await notify(tx, input);
  return true;
}

// =====================================================================================================================
// Bulan & parameter
// =====================================================================================================================

/** 'YYYY-MM' dari tanggal bisnis. */
export function monthKey(date: BusinessDate): string {
  return date.slice(0, 7);
}

/** Rentang tanggal bulan layanan 'YYYY-MM'. */
export function monthRange(month: string): { from: BusinessDate; to: BusinessDate; periodMonth: BusinessDate } {
  const first = `${month}-01`;
  return { from: first, to: lastDayOfMonth(first), periodMonth: first };
}

/** Bulan sebelumnya 'YYYY-MM' dari tanggal bisnis. */
export function previousMonth(date: BusinessDate): string {
  return monthKey(addDays(firstDayOfMonth(date), -1));
}

/** Tambah n bulan kalender (tanggal dipangkas ke akhir bulan bila perlu). */
export function addMonths(date: BusinessDate, months: number): BusinessDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = Number(lastDayOfMonth(first).slice(8, 10));
  return `${first.slice(0, 8)}${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function isValidMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export async function partnerRules(tx: Tx, date: BusinessDate) {
  return params.get(tx, "p3.partner_rules", date);
}

/** Persen dari basis poin (300 → 3). */
export function bpToPercent(bp: number): number {
  return Math.round(bp) / 100;
}

/** Basis poin dari persen (3 → 300; 2,5 → 250). */
export function percentToBp(percent: number): number {
  return Math.round(percent * 100);
}
