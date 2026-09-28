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

import { asc, eq, inArray } from "drizzle-orm";

import { customerPayments, invoiceLines, invoices, outlets, paymentAllocations, customers } from "@/db/schema";
import { addDays, lastDayOfMonth, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { NotFoundError } from "@/server/core/errors";
import { authorize } from "@/server/core/rbac";
import { dailyOutletReport, shiftReport, voidReport, waterSupplyReport } from "@/server/modules/m6-pos";

import { listPartnerInvoices, type PartnerInvoiceRow } from "./billing";
import { assertPartnerActor, denyCrossTenant, isValidMonth, latestContractFor, monthKey, monthRange, partnerTerms, portalEnabled, tenantOutlets, bpToPercent } from "./common";
import { monthlyReportsOf, type MonthlyReportRow } from "./monthly-report";
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
