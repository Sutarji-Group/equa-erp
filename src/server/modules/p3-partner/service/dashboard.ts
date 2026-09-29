/**
 * P3 — dashboard kinerja mitra, portofolio pembina, ekonomi kemitraan (Tahap 3 US-P3-06; flag `phase3.partner_portal`).
 *
 * - KP-1: per mitra/outlet per bulan: omzet POS, galon/hari, air dibeli dari EQUA (rit, liter), neraca air (merah bila
 *   > PAR-79), spare part dibeli, tagihan (terbit, dibayar, lewat tempo), skor mutu, sanksi aktif, evaluasi berikutnya.
 * - KP-2: portofolio pembina: peringkat risiko (neraca air, tunggakan, mutu, temuan, sanksi), jadwal audit, temuan
 *   terbuka.
 * - KP-3: ekonomi kemitraan untuk pemilik: pendapatan EQUA per mitra (air, spare part, langganan, royalti) vs ilustrasi
 *   (`p3.economics_illustration`, BRD 9.7); total komitmen kapasitas air mitra vs ruang kapasitas (K22).
 * - KP-4: dashboard mitra sendiri = data yang sama (lihat `portalHome` + `partnerMetrics` tenant sendiri).
 */
import "server-only";

import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { invoiceLines, invoices, outlets, partnerAudits, partnerContracts, partnerScores, posSales, tenants, trips } from "@/db/schema";
import { daysBetween, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { authorize, authorizeAny } from "@/server/core/rbac";
import { salesAggregates } from "@/server/modules/m6-pos";

import { assertOwnerTenant, isValidMonth, LIVE_CONTRACT_STATUSES, latestContractFor, monthKey, monthRange, partnerCustomersOf, partnerRules, partnerTenants, tenantOutlets, type TenantRow } from "./common";
import { activeSanctions } from "./sanctions";
import { partnerWaterBalance, type PartnerWaterBalanceRow } from "./supply";

export type PartnerMetrics = {
  tenant: Pick<TenantRow, "id" | "code" | "name" | "isActive" | "readOnly">;
  month: string;
  outlets: {
    outletId: string;
    outletName: string;
    salesTotal: number;
    gallons: number;
    gallonsPerDay: number;
    balance: PartnerWaterBalanceRow | null;
    score: number | null;
    belowThreshold: boolean;
  }[];
  salesTotal: number;
  gallons: number;
  waterTrips: number;
  waterL: number;
  waterAmount: number;
  sparePartAmount: number;
  invoices: { issued: number; paid: number; outstanding: number; overdue: number; maxOverdueDays: number };
  subscriptionRevenue: number;
  royaltyRevenue: number;
  waterBalanceExceeded: boolean;
  activeSanctions: { id: string; level: string; effectiveFrom: string | null }[];
  nextEvaluationDate: string | null;
  contractNumber: string | null;
  contractEndDate: string | null;
};

/** Angka satu mitra untuk bulan (tanpa otorisasi; pemanggil memastikan hak & tenant). */
export async function partnerMetrics(tx: Tx, tenant: TenantRow, month: string, today: BusinessDate): Promise<PartnerMetrics> {
  const { from, to } = monthRange(month);
  const end = to < today ? to : today;
  const days = Math.max(1, daysBetween(from, end) + 1);
  const outletRows = await tenantOutlets(tx, tenant.id, { depotOnly: true });
  const sales = outletRows.length ? await salesAggregates(tx, tenant.id, { from, to, outletIds: outletRows.map((o) => o.id) }) : [];
  const balance = await partnerWaterBalance(tx, tenant.id, month);
  const scores = outletRows.length ? await tx.select().from(partnerScores).where(and(inArray(partnerScores.outletId, outletRows.map((o) => o.id)), eq(partnerScores.period, month))) : [];
  const custIds = (await partnerCustomersOf(tx, tenant.id)).map((c) => c.id);
  const water = custIds.length
    ? await tx
        .select({ n: sql<string>`count(*)`, l: sql<string>`coalesce(sum(${trips.deliveredVolumeL}), 0)`, amount: sql<string>`coalesce(sum(${trips.price}), 0)` })
        .from(trips)
        .where(and(inArray(trips.customerId, custIds), eq(trips.status, "completed"), gte(trips.completionBusinessDate, from), lte(trips.completionBusinessDate, to)))
    : [{ n: "0", l: "0", amount: "0" }];
  const spare = custIds.length
    ? await tx
        .select({ amount: sql<string>`coalesce(sum(case when ${posSales.status} in ('valid', 'void_pending') or ${posSales.isReversal} then ${posSales.total} else 0 end), 0)` })
        .from(posSales)
        .where(and(inArray(posSales.customerId, custIds), gte(posSales.businessDate, from), lte(posSales.businessDate, to)))
    : [{ amount: "0" }];
  const inv = custIds.length ? await tx.select().from(invoices).where(and(inArray(invoices.customerId, custIds), gte(invoices.issueDate, from), lte(invoices.issueDate, to))) : [];
  const openInv = custIds.length ? await tx.select().from(invoices).where(and(inArray(invoices.customerId, custIds), sql`${invoices.outstandingAmount} > 0`)) : [];
  const overdue = openInv.filter((i) => i.dueDate < today);
  const partnerInvIds = inv.filter((i) => i.kind === "partner_subscription").map((i) => i.id);
  const lines = partnerInvIds.length ? await tx.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, partnerInvIds)) : [];
  const contract = await latestContractFor(tx, tenant.id);
  const act = await activeSanctions(tx, tenant.id, today);
  return {
    tenant: { id: tenant.id, code: tenant.code, name: tenant.name, isActive: tenant.isActive, readOnly: tenant.readOnly },
    month,
    outlets: outletRows.map((o) => {
      const s = sales.filter((r) => r.outletId === o.id);
      const gallons = s.reduce((x, r) => x + r.gallons, 0);
      const sc = scores.find((x) => x.outletId === o.id) ?? null;
      return {
        outletId: o.id,
        outletName: o.name,
        salesTotal: s.reduce((x, r) => x + r.salesTotal, 0),
        gallons,
        gallonsPerDay: Math.round((gallons / days) * 10) / 10,
        balance: balance.find((b) => b.outletId === o.id) ?? null,
        score: sc ? sc.totalScore : null,
        belowThreshold: sc?.belowThreshold ?? false,
      };
    }),
    salesTotal: sales.reduce((x, r) => x + r.salesTotal, 0),
    gallons: sales.reduce((x, r) => x + r.gallons, 0),
    waterTrips: Number(water[0]?.n ?? 0),
    waterL: Number(water[0]?.l ?? 0),
    waterAmount: Number(water[0]?.amount ?? 0),
    sparePartAmount: Number(spare[0]?.amount ?? 0),
    invoices: {
      issued: inv.reduce((s, i) => s + i.amount, 0),
      paid: inv.reduce((s, i) => s + i.paidAmount, 0),
      outstanding: openInv.reduce((s, i) => s + i.outstandingAmount, 0),
      overdue: overdue.reduce((s, i) => s + i.outstandingAmount, 0),
      maxOverdueDays: overdue.reduce((m, i) => Math.max(m, daysBetween(i.dueDate, today)), 0),
    },
    subscriptionRevenue: lines.filter((l) => l.component === "subscription" || l.component === "other").reduce((s, l) => s + l.amount, 0),
    royaltyRevenue: lines.filter((l) => l.component === "royalty").reduce((s, l) => s + l.amount, 0),
    waterBalanceExceeded: balance.some((b) => b.exceeded),
    activeSanctions: act.map((s) => ({ id: s.id, level: s.level, effectiveFrom: s.effectiveFrom })),
    nextEvaluationDate: contract?.nextEvaluationDate ?? null,
    contractNumber: contract?.number ?? null,
    contractEndDate: contract?.endDate ?? null,
  };
}

/** KP-1: dashboard kinerja semua mitra (EQUA). */
export async function partnerDashboard(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.partner.read", "p3.partner_score.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const today = ctxBusinessDate(ctx);
  const month = isValidMonth(input.month) ? input.month! : monthKey(today);
  const rows: PartnerMetrics[] = [];
  for (const t of await partnerTenants(tx, { includeInactive: true })) rows.push(await partnerMetrics(tx, t, month, today));
  return { month, tolerancePct: (await params.get(tx, "PAR-79", monthRange(month).to)).percent, rows };
}

export type PortfolioRow = {
  metrics: PartnerMetrics;
  riskPoints: number;
  risk: "low" | "medium" | "high";
  reasons: string[];
  nextAudit: string | null;
  openFindings: number;
};

/** KP-2: portofolio pembina — peringkat risiko, jadwal audit & kunjungan, temuan terbuka. */
export async function coachPortfolio(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.partner_score.read", "p3.partner.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const today = ctxBusinessDate(ctx);
  const month = isValidMonth(input.month) ? input.month! : monthKey(today);
  const rules = await partnerRules(tx, today);
  const out: PortfolioRow[] = [];
  for (const t of await partnerTenants(tx)) {
    const m = await partnerMetrics(tx, t, month, today);
    const audits = await tx.select().from(partnerAudits).where(eq(partnerAudits.tenantId, t.id)).orderBy(asc(partnerAudits.scheduledDate));
    const nextAudit = audits.find((a) => a.status === "scheduled")?.scheduledDate ?? null;
    const openFindings = audits.filter((a) => a.status === "findings" || a.status === "follow_up").length;
    let points = 0;
    const reasons: string[] = [];
    if (m.waterBalanceExceeded) {
      points += 2;
      reasons.push("Neraca air di luar toleransi");
    }
    if (m.invoices.overdue > 0) {
      points += m.invoices.maxOverdueDays > rules.read_only_overdue_days ? 2 : 1;
      reasons.push(`Tunggakan ${m.invoices.maxOverdueDays} hari`);
    }
    if (m.outlets.some((o) => o.belowThreshold)) {
      points += 2;
      reasons.push("Skor mutu di bawah PAR-80");
    }
    if (openFindings) {
      points += 1;
      reasons.push(`${openFindings} temuan audit terbuka`);
    }
    if (m.activeSanctions.length) {
      points += 1;
      reasons.push(`${m.activeSanctions.length} sanksi berlaku`);
    }
    out.push({ metrics: m, riskPoints: points, risk: points >= 4 ? "high" : points >= 2 ? "medium" : "low", reasons, nextAudit, openFindings });
  }
  out.sort((a, b) => b.riskPoints - a.riskPoints || a.metrics.tenant.name.localeCompare(b.metrics.tenant.name));
  const upcomingAudits = await tx
    .select({ id: partnerAudits.id, tenantId: partnerAudits.tenantId, outletId: partnerAudits.outletId, scheduledDate: partnerAudits.scheduledDate, outletName: outlets.name, tenantName: tenants.name })
    .from(partnerAudits)
    .innerJoin(outlets, eq(outlets.id, partnerAudits.outletId))
    .innerJoin(tenants, eq(tenants.id, partnerAudits.tenantId))
    .where(eq(partnerAudits.status, "scheduled"))
    .orderBy(asc(partnerAudits.scheduledDate))
    .limit(50);
  return { month, rows: out, upcomingAudits };
}

/** KP-3: ekonomi kemitraan (pemilik) — pendapatan EQUA per mitra vs ilustrasi; komitmen kapasitas vs ruang (K22). */
export async function partnershipEconomics(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_economics.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const today = ctxBusinessDate(ctx);
  const month = isValidMonth(input.month) ? input.month! : monthKey(today);
  const illus = await params.get(tx, "p3.economics_illustration", monthRange(month).to);
  const rules = await partnerRules(tx, today);
  const rows = [];
  for (const t of await partnerTenants(tx, { includeInactive: true })) {
    const m = await partnerMetrics(tx, t, month, today);
    const revenue = { water: m.waterAmount, sparePart: m.sparePartAmount, subscription: m.subscriptionRevenue, royalty: m.royaltyRevenue };
    const total = revenue.water + revenue.sparePart + revenue.subscription + revenue.royalty;
    const illustration = illus.water_per_month + illus.spare_part_per_month + illus.subscription_per_month + illus.royalty_per_month;
    rows.push({ tenant: m.tenant, revenue, total, illustration, gapPct: illustration ? Math.round(((total - illustration) / illustration) * 1000) / 10 : null, waterTrips: m.waterTrips });
  }
  const [{ n }] = (await tx.select({ n: sql<string>`count(distinct ${partnerContracts.tenantId})` }).from(partnerContracts).where(inArray(partnerContracts.status, [...LIVE_CONTRACT_STATUSES]))) as [{ n: string }];
  const activePartners = Number(n);
  return {
    month,
    illustration: illus,
    rows,
    capacity: { roomTrips: rules.capacity_room_trips_per_month, committedTrips: Math.round(activePartners * rules.commitment_trips_per_partner * 10) / 10, activePartners, actualTrips: rows.reduce((s, r) => s + r.waterTrips, 0) },
  };
}
