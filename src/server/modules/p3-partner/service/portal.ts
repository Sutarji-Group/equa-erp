/**
 * P3 — portal pemilik mitra (RL-7 US-P3-10; B-13). Pemilik mitra (`partner_owner`, antarmuka `portal`, baca-saja,
 * lingkup tenant sendiri) melihat laporan outletnya memakai FUNGSI LAPORAN M6 yang sama dengan EQUA (izin
 * `p3.partner_report.read` diterima M6), neraca air versi mitra, tagihan & pembayaran M5, riwayat pembelian, dan
 * laporan bulanan.
 *
 * KP-4 (NFR-30): tenant SELALU `ctx.tenantId` pelaku; parameter outlet/tenant lain → ditolak `ForbiddenError` +
 * tercatat di log akses (US-M10-03). Tidak ada data mitra lain atau data EQUA.
 */
import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { customerPayments, devices, invoiceLines, invoices, outlets, partnerAudits, paymentAllocations, customers, qualityTests, royaltyCalculations } from "@/db/schema";
import { addDays, lastDayOfMonth, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { NotFoundError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { compareVersions } from "@/server/core/sync";
import { authorize } from "@/server/core/rbac";
import { dailyOutletReport, shiftReport, voidReport, waterSupplyReport } from "@/server/modules/m6-pos";

import { listPartnerInvoices, type PartnerInvoiceRow } from "./billing";
import { assertPartnerActor, denyCrossTenant, isValidMonth, latestContractFor, monthKey, monthRange, partnerTerms, portalEnabled, tenantOutlets, bpToPercent } from "./common";
import { partnerMetrics, type PartnerMetrics } from "./dashboard";
import { monthlyReportsOf, type MonthlyReportRow } from "./monthly-report";
import { onboardingViews } from "./onboarding";
import { portalOrdersOf, portalOrderStatusText, sparePartCatalog } from "./portal-orders";
import { computeOutletScore } from "./quality";
import { activeSupplySuspension, sanctionsOfTenant } from "./sanctions";
import { EQUA_READ_RIGHTS } from "./partners";
import { partnerWaterBalance, purchaseHistory } from "./supply";
import { supportSlaSummary } from "./support";

/** Otorisasi portal + tenant mitra pelaku. */
async function portalTenant(ctx: ActorContext, tx?: Tx) {
  await authorize(ctx, "p3.partner_report.read", { tx });
  return assertPartnerActor(tx ?? getDb(), ctx);
}

/** Outlet parameter harus milik tenant sendiri; lintas tenant → ditolak & tercatat (US-P3-10 KP-4). */
async function assertOwnOutlet(ctx: ActorContext, outletId: string | null | undefined, tx?: Tx): Promise<void> {
  if (!outletId) return;
  const [o] = await (tx ?? getDb()).select({ tenantId: outlets.tenantId }).from(outlets).where(eq(outlets.id, outletId)).limit(1);
  if (!o) throw new NotFoundError("Outlet tidak ditemukan.");
  if (o.tenantId !== ctx.tenantId) await denyCrossTenant(ctx, "outlet", "outlet", outletId, tx);
}

function range(ctx: ActorContext, input: { from?: string | null; to?: string | null }): { from: BusinessDate; to: BusinessDate } {
  const today = ctxBusinessDate(ctx);
  const to = input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? input.to : today;
  const from = input.from && /^\d{4}-\d{2}-\d{2}$/.test(input.from) ? input.from : addDays(to, -29);
  return from <= to ? { from, to } : { from: to, to: from };
}

export type PortalHome = Awaited<ReturnType<typeof portalHome>>;

/** Beranda portal: identitas, outlet, ringkasan bulan berjalan, tagihan terbuka, hak baca EQUA, status Tahap 3. */
export async function portalHome(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  const tx = opts.tx ?? getDb();
  const tenant = await portalTenant(ctx, opts.tx);
  const month = isValidMonth(input.month) ? input.month! : monthKey(ctxBusinessDate(ctx));
  const { from, to } = monthRange(month);
  const today = ctxBusinessDate(ctx);
  const daily = await dailyOutletReport(ctx, { from, to: to < today ? to : today }, { tx: opts.tx });
  const balance = await partnerWaterBalance(tx, tenant.id, month);
  const invoiceRows = await listPartnerInvoices(tx, { tenantId: tenant.id, today, limit: 50 });
  const contract = await latestContractFor(tx, tenant.id);
  return {
    tenant: { id: tenant.id, code: tenant.code, name: tenant.name, readOnly: tenant.readOnly, isActive: tenant.isActive },
    terms: await partnerTerms(tx),
    phase3: await portalEnabled(tx, tenant.id),
    month,
    outlets: (await tenantOutlets(tx, tenant.id)).map((o) => ({ id: o.id, code: o.code, name: o.name, activatedOn: o.activatedOn, isActive: o.isActive })),
    summary: {
      salesTotal: daily.reduce((s, d) => s + d.salesTotal, 0),
      transactions: daily.reduce((s, d) => s + d.transactions, 0),
      gallons: daily.reduce((s, d) => s + d.gallons, 0),
      voidCount: daily.reduce((s, d) => s + d.voidCount, 0),
      cashDifference: daily.reduce((s, d) => s + d.cashDifference, 0),
    },
    waterBalance: balance,
    invoices: {
      open: invoiceRows.filter((i) => i.outstandingAmount > 0),
      outstanding: invoiceRows.reduce((s, i) => s + i.outstandingAmount, 0),
      overdue: invoiceRows.filter((i) => i.overdueDays > 0).reduce((s, i) => s + i.outstandingAmount, 0),
    },
    sla: await supportSlaSummary(tx, tenant.id, month, ctx.now),
    contract: contract
      ? {
          number: contract.number,
          option: contract.option,
          status: contract.status,
          startDate: contract.startDate,
          endDate: contract.endDate,
          subscriptionFeePerOutlet: contract.subscriptionFeePerOutlet,
          royaltyPercent: bpToPercent(contract.royaltyBp),
          waterDiscountPercent: bpToPercent(contract.waterDiscountBp),
          creditLimit: contract.creditLimit,
        }
      : null,
    readRights: EQUA_READ_RIGHTS,
    posVersion: await partnerPosVersion(tx, tenant.id, today),
  };
}

export type PartnerPosVersion = {
  minVersion: string;
  /** Versi minimal terjadwal berikutnya (tenggat pembaruan), bila ada. */
  next: { version: string; effectiveFrom: string } | null;
  devices: { id: string; name: string; outletId: string | null; appVersion: string | null; lastSeenAt: Date | null; belowMin: boolean; belowNext: boolean }[];
};

/**
 * PRD 9.7 (mitra menolak pembaruan versi POS), US-M10-07 KP-4, NFR-32 (temuan S5B): versi minimal POS yang berlaku,
 * versi minimal terjadwal berikutnya + tanggal berlakunya (tenggat), dan versi terpasang per tablet outlet mitra
 * (perangkat tenant sendiri saja, NFR-30).
 */
export async function partnerPosVersion(tx: Tx, tenantId: string, today: BusinessDate): Promise<PartnerPosVersion> {
  const minVersion = (await params.get(tx, "app.min_supported_version", today)).version;
  const upcoming = (await params.history(tx, "app.min_supported_version", {}))
    .filter((r) => r.effectiveFrom > today)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  const next = upcoming ? { version: String((upcoming.value as { version?: unknown }).version ?? ""), effectiveFrom: upcoming.effectiveFrom } : null;
  const rows = await tx
    .select({ id: devices.id, name: devices.name, outletId: devices.outletId, appVersion: devices.appVersion, lastSeenAt: devices.lastSeenAt, status: devices.status })
    .from(devices)
    .where(eq(devices.tenantId, tenantId))
    .orderBy(asc(devices.name));
  return {
    minVersion,
    next,
    devices: rows
      .filter((d) => d.status !== "wiped")
      .map((d) => ({
        id: d.id,
        name: d.name,
        outletId: d.outletId,
        appVersion: d.appVersion,
        lastSeenAt: d.lastSeenAt,
        belowMin: !!d.appVersion && compareVersions(d.appVersion, minVersion) < 0,
        belowNext: !!d.appVersion && !!next?.version && compareVersions(d.appVersion, next.version) < 0,
      })),
  };
}

/** Penjualan per hari per outlet, galon, void, selisih shift — fungsi laporan M6 yang sama dengan EQUA (B-13). */
export async function portalSalesReport(ctx: ActorContext, input: { from?: string | null; to?: string | null; outletId?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await portalTenant(ctx, opts.tx);
  await assertOwnOutlet(ctx, input.outletId, opts.tx);
  const r = range(ctx, input);
  const daily = await dailyOutletReport(ctx, { ...r, outletId: input.outletId ?? null }, { tx: opts.tx });
  const voids = await voidReport(ctx, { ...r, outletId: input.outletId ?? null }, { tx: opts.tx });
  const shifts = await shiftReport(ctx, { ...r, outletId: input.outletId ?? null }, { tx: opts.tx });
  return { ...r, daily, voids, shifts };
}

/** Pasokan diterima & neraca air versi mitra (US-P3-10 KP-2). */
export async function portalSupplyReport(ctx: ActorContext, input: { month?: string | null; outletId?: string | null } = {}, opts: { tx?: Tx } = {}) {
  const tx = opts.tx ?? getDb();
  const tenant = await portalTenant(ctx, opts.tx);
  await assertOwnOutlet(ctx, input.outletId, opts.tx);
  const month = isValidMonth(input.month) ? input.month! : monthKey(ctxBusinessDate(ctx));
  const { from, to } = monthRange(month);
  const supply = await waterSupplyReport(ctx, { from, to, outletId: input.outletId ?? null }, { tx: opts.tx });
  const balance = (await partnerWaterBalance(tx, tenant.id, month)).filter((b) => !input.outletId || b.outletId === input.outletId);
  return { month, supply, balance };
}

export type PortalInvoiceDetail = PartnerInvoiceRow & { lines: { description: string; component: string; quantity: number; unitPrice: number; amount: number }[]; payments: { businessDate: string; method: string; amount: number }[] };

/** Tagihan & pembayaran mitra (faktur M5 pelanggan mitra; KP-2). */
export async function portalInvoices(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<PortalInvoiceDetail[]> {
  const tx = opts.tx ?? getDb();
  const tenant = await portalTenant(ctx, opts.tx);
  const rows = await listPartnerInvoices(tx, { tenantId: tenant.id, today: ctxBusinessDate(ctx), limit: 120 });
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const lines = await tx.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)).orderBy(asc(invoiceLines.lineNo));
  const pays = await tx
    .select({ invoiceId: paymentAllocations.invoiceId, amount: paymentAllocations.amount, businessDate: customerPayments.businessDate, method: customerPayments.method })
    .from(paymentAllocations)
    .innerJoin(customerPayments, eq(customerPayments.id, paymentAllocations.customerPaymentId))
    .where(inArray(paymentAllocations.invoiceId, ids))
    .orderBy(asc(customerPayments.businessDate));
  return rows.map((r) => ({
    ...r,
    lines: lines.filter((l) => l.invoiceId === r.id).map((l) => ({ description: l.description, component: l.component, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount })),
    payments: pays.filter((p) => p.invoiceId === r.id).map((p) => ({ businessDate: p.businessDate, method: p.method, amount: p.amount })),
  }));
}

/** Satu tagihan mitra; faktur pelanggan lain → ditolak & tercatat. */
export async function portalInvoice(ctx: ActorContext, invoiceId: string, opts: { tx?: Tx } = {}): Promise<PortalInvoiceDetail> {
  const tx = opts.tx ?? getDb();
  await portalTenant(ctx, opts.tx);
  const [row] = await tx
    .select({ id: invoices.id, partnerTenantId: customers.partnerTenantId })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!row) throw new NotFoundError("Tagihan tidak ditemukan.");
  if (row.partnerTenantId !== ctx.tenantId) await denyCrossTenant(ctx, "tagihan", "invoice", invoiceId, opts.tx);
  const all = await portalInvoices(ctx, opts);
  const found = all.find((i) => i.id === invoiceId);
  if (!found) throw new NotFoundError("Tagihan tidak ditemukan.");
  return found;
}

/** Riwayat pembelian air & spare part per bulan (US-P3-03 KP-5; tampil juga di RL-7 sebagai data tagihan). */
export async function portalPurchaseHistory(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  const tx = opts.tx ?? getDb();
  const tenant = await portalTenant(ctx, opts.tx);
  const to = lastDayOfMonth(ctxBusinessDate(ctx));
  return purchaseHistory(tx, tenant.id, { from: `${monthKey(addDays(to, -370))}-01`, to });
}

/** Laporan bulanan yang sudah terbit (tenant sendiri). */
export async function portalMonthlyReports(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<MonthlyReportRow[]> {
  const tenant = await portalTenant(ctx, opts.tx);
  return monthlyReportsOf(opts.tx ?? getDb(), tenant.id);
}

export async function portalMonthlyReport(ctx: ActorContext, period: string, opts: { tx?: Tx } = {}): Promise<MonthlyReportRow | null> {
  const tenant = await portalTenant(ctx, opts.tx);
  return (await monthlyReportsOf(opts.tx ?? getDb(), tenant.id)).find((r) => r.period === period) ?? null;
}

/** Percobaan membuka data tenant lain dari portal (mis. URL rekayasa) — selalu ditolak & tercatat. */
export async function portalOpenTenant(ctx: ActorContext, tenantId: string, opts: { tx?: Tx } = {}) {
  const tenant = await portalTenant(ctx, opts.tx);
  if (tenantId !== tenant.id) await denyCrossTenant(ctx, "data mitra", "tenant", tenantId, opts.tx);
  return tenant;
}

// =====================================================================================================================
// Tahap 3 (flag `phase3.partner_portal` per tenant): dashboard, pesanan, mutu, sanksi, royalti — sudut pandang mitra
// =====================================================================================================================

/** Bulan 'YYYY-MM' sah atau bulan berjalan pelaku. */
function monthOf(ctx: ActorContext, month: string | null | undefined): string {
  return isValidMonth(month) ? month! : monthKey(ctxBusinessDate(ctx));
}

/**
 * US-P3-06 KP-4: dashboard outlet mitra sendiri — angka SAMA dengan dashboard EQUA (`partnerMetrics`), termasuk skor
 * mutu, sanksi, evaluasi berikutnya. `null` bila portal Tahap 3 belum aktif untuk tenant ini (RL-7: `portalHome`).
 */
export async function portalDashboard(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<PartnerMetrics | null> {
  const tx = opts.tx ?? getDb();
  const tenant = await portalTenant(ctx, opts.tx);
  if (!(await portalEnabled(tx, tenant.id))) return null;
  return partnerMetrics(tx, tenant, monthOf(ctx, input.month), ctxBusinessDate(ctx));
}

/** US-P3-03: pesanan air & spare part dari portal (status, rit, bukti kirim, konfirmasi volume) + katalog harga mitra. */
export async function portalOrders(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  const tx = opts.tx ?? getDb();
  const tenant = await portalTenant(ctx, opts.tx);
  const enabled = await portalEnabled(tx, tenant.id);
  const today = ctxBusinessDate(ctx);
  if (!enabled) return { enabled, orders: [], catalog: [], outlets: [], contract: null, suspension: null, readOnly: tenant.readOnly };
  const contract = await latestContractFor(tx, tenant.id);
  const suspension = await activeSupplySuspension(tx, tenant.id, today);
  const detail = (suspension?.triggerDetail ?? {}) as { proposalReason?: string; recoveryConditions?: string };
  return {
    enabled,
    orders: (await portalOrdersOf(tx, tenant.id)).map((o) => ({ ...o, statusText: portalOrderStatusText(o) })),
    catalog: await sparePartCatalog(tx, today),
    outlets: (await tenantOutlets(tx, tenant.id, { depotOnly: true })).filter((o) => o.isActive).map((o) => ({ id: o.id, code: o.code, name: o.name })),
    contract: contract ? { number: contract.number, option: contract.option, waterDiscountPercent: bpToPercent(contract.waterDiscountBp), creditLimit: contract.creditLimit } : null,
    suspension: suspension ? { effectiveFrom: suspension.effectiveFrom, reason: String(detail.proposalReason ?? suspension.decisionReason ?? ""), recoveryConditions: String(detail.recoveryConditions ?? "") } : null,
    readOnly: tenant.readOnly,
  };
}

/** US-P3-05 (sudut pandang mitra): skor mutu bulanan per outlet, audit & temuan, uji air, daftar periksa onboarding (SOP). */
export async function portalQuality(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  const tx = opts.tx ?? getDb();
  const tenant = await portalTenant(ctx, opts.tx);
  const enabled = await portalEnabled(tx, tenant.id);
  const month = monthOf(ctx, input.month);
  if (!enabled) return { enabled, month, outlets: [], audits: [], tests: [], onboarding: [] };
  const outletRows = await tenantOutlets(tx, tenant.id, { depotOnly: true });
  const outletsOut = [];
  for (const o of outletRows) outletsOut.push({ outletId: o.id, outletName: o.name, score: await computeOutletScore(tx, o.id, month) });
  const ids = outletRows.map((o) => o.id);
  const audits = ids.length ? await tx.select().from(partnerAudits).where(inArray(partnerAudits.outletId, ids)).orderBy(desc(partnerAudits.scheduledDate)).limit(24) : [];
  const tests = ids.length ? await tx.select().from(qualityTests).where(inArray(qualityTests.outletId, ids)).orderBy(desc(qualityTests.testDate)).limit(24) : [];
  const names = new Map(outletRows.map((o) => [o.id, o.name]));
  return {
    enabled,
    month,
    outlets: outletsOut,
    audits: audits.map((a) => ({ id: a.id, outletName: names.get(a.outletId) ?? "-", scheduledDate: a.scheduledDate, status: a.status, score: a.score, findings: (a.findings ?? []) as { text?: string }[], followUpDueDate: a.followUpDueDate, followUpDoneAt: a.followUpDoneAt })),
    tests: tests.map((t) => ({ id: t.id, outletName: names.get(t.outletId ?? "") ?? "-", testDate: t.testDate, laboratory: t.laboratory, passed: t.passed })),
    onboarding: await onboardingViews(tx, tenant.id),
  };
}

/** US-P3-07 (portal): sanksi berlaku & riwayat, penghentian pasokan (alasan & syarat pemulihan), mode baca-saja, ekspor data. */
export async function portalSanctions(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  const tx = opts.tx ?? getDb();
  const tenant = await portalTenant(ctx, opts.tx);
  const today = ctxBusinessDate(ctx);
  const contract = await latestContractFor(tx, tenant.id);
  return {
    enabled: await portalEnabled(tx, tenant.id),
    readOnly: tenant.readOnly,
    isActive: tenant.isActive,
    sanctions: await sanctionsOfTenant(tx, tenant.id),
    suspension: await activeSupplySuspension(tx, tenant.id, today),
    contract: contract ? { number: contract.number, status: contract.status, endDate: contract.endDate, dataExportDueDate: contract.dataExportDueDate, dataExportedAt: contract.dataExportedAt } : null,
  };
}

/** US-P3-04 KP-2 (portal): dasar royalti — omzet per outlet per hari untuk bulan tertagih (kontrak tenant sendiri). */
export async function portalRoyaltyDetail(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  const tx = opts.tx ?? getDb();
  const tenant = await portalTenant(ctx, opts.tx);
  const month = monthOf(ctx, input.month);
  const rows = await tx
    .select()
    .from(royaltyCalculations)
    .where(and(eq(royaltyCalculations.tenantId, tenant.id), eq(royaltyCalculations.period, month)))
    .limit(5);
  type DailyRow = { outletCode?: string; businessDate?: string; sales?: number; transactions?: number };
  return rows.map((r) => ({
    period: r.period,
    grossSales: r.grossSales,
    royaltyPercent: bpToPercent(r.royaltyBp),
    royaltyAmount: r.royaltyAmount,
    subscriptionAmount: r.subscriptionAmount,
    outletCount: r.outletCount,
    status: r.status,
    daily: (((r.detail ?? {}) as { royaltyDetail?: DailyRow[] }).royaltyDetail ?? []).map((d) => ({
      outletCode: String(d.outletCode ?? ""),
      businessDate: String(d.businessDate ?? ""),
      sales: Number(d.sales ?? 0),
      transactions: Number(d.transactions ?? 0),
    })),
  }));
}
