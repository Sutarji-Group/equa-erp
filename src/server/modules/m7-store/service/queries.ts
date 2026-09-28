/**
 * M7 — tampilan kantor & laporan toko (US-M7-01 KP-3, US-M7-02 KP-3, US-M7-07; katalog 7.9.4, US-M9-03).
 *
 * Semua berlingkup tenant pelaku (NFR-30) dan toko dalam lingkupnya. Laporan dipakai layar `/toko/*` dan ekspor
 * Excel/PDF (`reports.ts`).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { approvalRequests, customers, employees, posSaleLines, posSales, productPrices, products, purchaseReceipts, reorderItems, stockBalances, stockLedger, users } from "@/db/schema";
import type { PriceKind } from "@/lib/labels";
import { addDays, daysBetween, isBusinessDate, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError } from "@/server/core/errors";
import { queryEvents } from "@/server/core/events";
import * as params from "@/server/core/params";
import { authorize, authorizeAny } from "@/server/core/rbac";
import { priceHistory, resolveProductPrice } from "@/server/modules/m1-master";
import { COUNTED_SALE } from "@/server/modules/m6-pos";

import { balanceAt, loadStoreProduct, monthLabel, monthRange, resolveOfficeStore, storeRules } from "./common";
import { payableRows } from "./payables";
import { lastSuppliers } from "./reorder";

async function currentPrices(tx: Tx, product: { id: string; tenantId: string; status: string }, outletId: string | null, date: BusinessDate): Promise<Partial<Record<PriceKind, number>>> {
  const out: Partial<Record<PriceKind, number>> = {};
  if (product.status !== "active") return out;
  for (const kind of ["general", "partner"] as const) {
    try {
      out[kind] = (await resolveProductPrice(tx, { productId: product.id, kind, date, tenantId: product.tenantId, outletId })).unitPrice;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return out;
}

export type StoreItemRow = {
  id: string;
  code: string;
  name: string;
  unit: string;
  category: string | null;
  status: string;
  barcode: string | null;
  minStock: number | null;
  prices: Partial<Record<PriceKind, number>>;
  balance: number;
  avgCost: number;
  stockValue: number;
  belowMinimum: boolean;
  pendingPrices: number;
  lastSupplierName: string | null;
  lastUnitCost: number | null;
};

/** Barang & stok toko (izin `m7.stock.read`). */
export async function listStoreItems(ctx: ActorContext, filter: { outletId?: string | null; includeInactive?: boolean } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.stock.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const outlet = await resolveOfficeStore(tx, ctx, filter.outletId ?? null);
  const rows = await tx
    .select()
    .from(products)
    .where(and(eq(products.tenantId, ctx.tenantId), eq(products.line, "store")))
    .orderBy(asc(products.sortOrder), asc(products.code));
  const visible = rows.filter((r) => filter.includeInactive || r.status !== "inactive");
  const ids = visible.map((r) => r.id);
  const bal = outlet && ids.length ? await tx.select().from(stockBalances).where(and(eq(stockBalances.outletId, outlet.id), inArray(stockBalances.productId, ids))) : [];
  const balBy = new Map(bal.map((b) => [b.productId, b]));
  const pending = ids.length
    ? await tx
        .select({ productId: productPrices.productId, n: sql<number>`count(*)::int` })
        .from(productPrices)
        .where(and(inArray(productPrices.productId, ids), eq(productPrices.status, "pending")))
        .groupBy(productPrices.productId)
    : [];
  const pendBy = new Map(pending.map((p) => [p.productId, Number(p.n)]));
  const last = outlet ? await lastSuppliers(tx, outlet.id, ids) : new Map();
  const date = ctxBusinessDate(ctx);
  const items: StoreItemRow[] = [];
  for (const r of visible) {
    const b = balBy.get(r.id);
    items.push({
      id: r.id,
      code: r.code,
      name: r.name,
      unit: r.unit,
      category: r.category,
      status: r.status,
      barcode: r.barcode,
      minStock: r.minStock,
      prices: await currentPrices(tx, r, outlet?.id ?? null, date),
      balance: b?.quantity ?? 0,
      avgCost: b?.avgCost ?? 0,
      stockValue: b?.totalValue ?? 0,
      belowMinimum: r.minStock !== null && (b?.quantity ?? 0) <= r.minStock,
      pendingPrices: pendBy.get(r.id) ?? 0,
      lastSupplierName: last.get(r.id)?.supplierName ?? null,
      lastUnitCost: last.get(r.id)?.unitCost ?? null,
    });
  }
  return { outlet, items };
}

export type StockCardRow = {
  id: string;
  occurredAt: Date;
  businessDate: string;
  kind: string;
  quantity: number;
  unitCost: number | null;
  totalCost: number | null;
  balanceAfter: number;
  avgCostAfter: number | null;
  sourceObjectType: string | null;
  sourceObjectId: string | null;
  note: string | null;
};

/** Kartu stok per barang: masuk (nota), keluar (penjualan, transfer), penyesuaian, saldo berjalan & HPP rata-rata. */
export async function stockCard(tx: Tx, input: { outletId: string; productId: string; from: BusinessDate; to: BusinessDate }): Promise<{ opening: number; rows: StockCardRow[] }> {
  const [open] = await tx
    .select({ q: sql<string>`coalesce(sum(${stockLedger.quantity}), 0)` })
    .from(stockLedger)
    .where(and(eq(stockLedger.outletId, input.outletId), eq(stockLedger.productId, input.productId), sql`${stockLedger.businessDate} < ${input.from}`));
  const rows = await tx
    .select()
    .from(stockLedger)
    .where(and(eq(stockLedger.outletId, input.outletId), eq(stockLedger.productId, input.productId), gte(stockLedger.businessDate, input.from), lte(stockLedger.businessDate, input.to)))
    .orderBy(asc(stockLedger.createdAt));
  return {
    opening: Number(open?.q ?? 0),
    rows: rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt,
      businessDate: r.businessDate,
      kind: r.kind,
      quantity: r.quantity,
      unitCost: r.unitCost,
      totalCost: r.totalCost,
      balanceAfter: r.balanceAfter,
      avgCostAfter: r.avgCostAfter,
      sourceObjectType: r.sourceObjectType,
      sourceObjectId: r.sourceObjectId,
      note: r.note,
    })),
  };
}

/** Rincian barang toko: harga berlaku & riwayat, kartu stok, usulan menunggu. */
export async function getStoreItem(ctx: ActorContext, productId: string, filter: { outletId?: string | null; from?: string | null; to?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.stock.read", { tx: opts.tx, objectType: "product", objectId: productId });
  const tx = opts.tx ?? getDb();
  const product = await loadStoreProduct(tx, ctx.tenantId, productId);
  const outlet = await resolveOfficeStore(tx, ctx, filter.outletId ?? null);
  const today = ctxBusinessDate(ctx);
  const from = filter.from && isBusinessDate(filter.from) ? filter.from : addDays(today, -60);
  const to = filter.to && isBusinessDate(filter.to) ? filter.to : today;
  const card = outlet ? await stockCard(tx, { outletId: outlet.id, productId, from, to }) : { opening: 0, rows: [] };
  const [bal] = outlet ? await tx.select().from(stockBalances).where(and(eq(stockBalances.outletId, outlet.id), eq(stockBalances.productId, productId))).limit(1) : [];
  const history = await priceHistory(tx, ctx.tenantId, { productId });
  const priceRows = await tx.select({ id: productPrices.id }).from(productPrices).where(eq(productPrices.productId, productId));
  const pending = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, ctx.tenantId),
        eq(approvalRequests.status, "submitted"),
        inArray(approvalRequests.objectId, [productId, ...priceRows.map((p) => p.id)]),
      ),
    );
  const [reorder] = outlet
    ? await tx
        .select()
        .from(reorderItems)
        .where(and(eq(reorderItems.outletId, outlet.id), eq(reorderItems.productId, productId), inArray(reorderItems.status, ["open", "ordered"])))
        .limit(1)
    : [];
  return {
    product,
    outlet,
    prices: await currentPrices(tx, product, outlet?.id ?? null, today),
    balance: bal ?? null,
    card,
    range: { from, to },
    history,
    pendingApprovals: pending,
    reorder: reorder ?? null,
  };
}

// =====================================================================================================================
// US-M7-07 — barang laris/mati & margin per barang per bulan
// =====================================================================================================================

export type ProductPerformanceRow = {
  productId: string;
  code: string;
  name: string;
  unit: string;
  category: string | null;
  soldQty: number;
  revenue: number;
  cogs: number;
  grossMargin: number;
  marginPct: number | null;
  lastSaleDate: string | null;
  daysWithoutSale: number;
  balance: number;
  stockValue: number;
  group: "fast" | "dead" | "normal";
  groupLabel: string;
};

type SaleLineAgg = { productId: string; qty: number; revenue: number; cogs: number };

async function saleLineAggregates(tx: Tx, outletId: string, from: BusinessDate, to: BusinessDate): Promise<Map<string, SaleLineAgg>> {
  const rows = await tx
    .select({
      productId: posSaleLines.productId,
      quantity: posSaleLines.quantity,
      lineTotal: posSaleLines.lineTotal,
      unitCost: posSaleLines.unitCost,
      subtotal: posSales.subtotal,
      discount: posSales.discountAmount,
    })
    .from(posSaleLines)
    .innerJoin(posSales, eq(posSales.id, posSaleLines.posSaleId))
    .where(and(eq(posSaleLines.outletId, outletId), gte(posSaleLines.businessDate, from), lte(posSaleLines.businessDate, to), COUNTED_SALE));
  const out = new Map<string, SaleLineAgg>();
  for (const r of rows) {
    const cur = out.get(r.productId) ?? { productId: r.productId, qty: 0, revenue: 0, cogs: 0 };
    const disc = r.subtotal !== 0 ? Math.round((Math.abs(r.discount) * r.lineTotal) / Math.abs(r.subtotal)) : 0;
    cur.qty += r.quantity;
    cur.revenue += r.lineTotal - disc;
    cur.cogs += r.quantity * (r.unitCost ?? 0);
    out.set(r.productId, cur);
  }
  return out;
}

/** Laporan per barang per bulan (izin `m7.product_performance.read`, pemilik). */
export async function productPerformance(ctx: ActorContext, filter: { outletId?: string | null; month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m7.product_performance.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const month = filter.month ?? monthLabel(today);
  const { from, to } = monthRange(month);
  const outlet = await resolveOfficeStore(tx, ctx, filter.outletId ?? null);
  if (!outlet) return { outlet: null, month, rows: [] as ProductPerformanceRow[], deadDays: 0, fastPercent: 0 };
  const rules = await storeRules(tx, today, ctx.tenantId);
  const { days_without_sale: deadDays } = await params.get(tx, "PAR-66", today);
  const asOf = to < today ? to : today;
  const agg = await saleLineAggregates(tx, outlet.id, from, to);
  // Retur pelanggan setelah hari transaksi mengurangi jumlah, omzet & HPP pada bulan retur.
  const returns = await queryEvents(tx, { type: "store_return.recorded", tenantId: ctx.tenantId, limit: 5000 });
  for (const e of returns) {
    const p = e.payload as { outletId: string; businessDate: string; lines: { productId: string; quantity: number; lineTotal: number; unitCost: number }[] };
    if (p.outletId !== outlet.id || p.businessDate < from || p.businessDate > to) continue;
    for (const l of p.lines) {
      const cur = agg.get(l.productId) ?? { productId: l.productId, qty: 0, revenue: 0, cogs: 0 };
      cur.qty -= l.quantity;
      cur.revenue -= l.lineTotal;
      cur.cogs -= l.quantity * l.unitCost;
      agg.set(l.productId, cur);
    }
  }
  const items = await tx
    .select()
    .from(products)
    .where(and(eq(products.tenantId, ctx.tenantId), eq(products.line, "store")))
    .orderBy(asc(products.code));
  const lastSale = await tx
    .select({ productId: posSaleLines.productId, d: sql<string>`max(${posSaleLines.businessDate})` })
    .from(posSaleLines)
    .innerJoin(posSales, eq(posSales.id, posSaleLines.posSaleId))
    .where(and(eq(posSaleLines.outletId, outlet.id), lte(posSaleLines.businessDate, asOf), eq(posSales.isReversal, false), COUNTED_SALE))
    .groupBy(posSaleLines.productId);
  const lastBy = new Map(lastSale.map((l) => [l.productId, l.d]));
  const firstMove = await tx
    .select({ productId: stockLedger.productId, d: sql<string>`min(${stockLedger.businessDate})` })
    .from(stockLedger)
    .where(eq(stockLedger.outletId, outlet.id))
    .groupBy(stockLedger.productId);
  const firstBy = new Map(firstMove.map((f) => [f.productId, f.d]));
  const rows: ProductPerformanceRow[] = [];
  for (const p of items) {
    if (p.status === "inactive" && !agg.has(p.id)) continue;
    if (p.status === "pending_approval") continue;
    const a = agg.get(p.id) ?? { productId: p.id, qty: 0, revenue: 0, cogs: 0 };
    let balance: number;
    let stockValue: number;
    if (asOf === today) {
      const [b] = await tx.select().from(stockBalances).where(and(eq(stockBalances.outletId, outlet.id), eq(stockBalances.productId, p.id))).limit(1);
      balance = b?.quantity ?? 0;
      stockValue = b?.totalValue ?? 0;
    } else {
      const at = await balanceAt(tx, outlet.id, p.id, new Date(Date.parse(`${addDays(asOf, 1)}T00:00:00+07:00`) - 1));
      balance = at.quantity;
      stockValue = at.quantity * at.avgCost;
    }
    const last = lastBy.get(p.id) ?? null;
    const since = last ?? firstBy.get(p.id) ?? null;
    const daysWithoutSale = since ? Math.max(0, daysBetween(since, asOf)) : 0;
    rows.push({
      productId: p.id,
      code: p.code,
      name: p.name,
      unit: p.unit,
      category: p.category,
      soldQty: a.qty,
      revenue: a.revenue,
      cogs: a.cogs,
      grossMargin: a.revenue - a.cogs,
      marginPct: a.revenue > 0 ? Math.round(((a.revenue - a.cogs) / a.revenue) * 1000) / 10 : null,
      lastSaleDate: last,
      daysWithoutSale,
      balance,
      stockValue,
      group: "normal",
      groupLabel: "Biasa",
    });
  }
  const selling = rows.filter((r) => r.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  const fastCount = Math.ceil((selling.length * rules.fast_moving_top_percent) / 100);
  const fastIds = new Set(selling.slice(0, fastCount).map((r) => r.productId));
  for (const r of rows) {
    const everHadStock = firstBy.has(r.productId);
    if (fastIds.has(r.productId)) {
      r.group = "fast";
      r.groupLabel = "Laris";
    } else if (everHadStock && r.daysWithoutSale >= deadDays) {
      r.group = "dead";
      r.groupLabel = "Mati";
    }
  }
  rows.sort((a, b) => b.revenue - a.revenue || a.code.localeCompare(b.code));
  return { outlet, month, rows, deadDays, fastPercent: rules.fast_moving_top_percent };
}

// =====================================================================================================================
// US-M7-07 KP-2 — pembelian bulanan per pelanggan mitra
// =====================================================================================================================

export type PartnerPurchaseRow = {
  customerId: string;
  code: string | null;
  name: string;
  isStorePartner: boolean;
  transactions: number;
  total: number;
  cash: number;
  qris: number;
  credit: number;
  discount: number;
};

export async function partnerPurchases(ctx: ActorContext, filter: { outletId?: string | null; month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m7.report.read", "m7.product_performance.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const month = filter.month ?? monthLabel(ctxBusinessDate(ctx));
  const { from, to } = monthRange(month);
  const outlet = await resolveOfficeStore(tx, ctx, filter.outletId ?? null);
  if (!outlet) return { outlet: null, month, rows: [] as PartnerPurchaseRow[] };
  const rows = await tx
    .select({ s: posSales, name: customers.name, code: customers.code, isStorePartner: customers.isStorePartner })
    .from(posSales)
    .innerJoin(customers, eq(customers.id, posSales.customerId))
    .where(and(eq(posSales.outletId, outlet.id), gte(posSales.businessDate, from), lte(posSales.businessDate, to), COUNTED_SALE));
  const by = new Map<string, PartnerPurchaseRow>();
  for (const { s, name, code, isStorePartner } of rows) {
    const cur = by.get(s.customerId!) ?? { customerId: s.customerId!, code, name, isStorePartner, transactions: 0, total: 0, cash: 0, qris: 0, credit: 0, discount: 0 };
    if (!s.isReversal) cur.transactions++;
    cur.total += s.total;
    cur.discount += s.discountAmount;
    if (s.paymentMethod === "cash") cur.cash += s.total;
    else if (s.paymentMethod === "qris") cur.qris += s.total;
    else if (s.paymentMethod === "credit") cur.credit += s.total;
    by.set(s.customerId!, cur);
  }
  return { outlet, month, rows: [...by.values()].sort((a, b) => b.total - a.total) };
}

// =====================================================================================================================
// US-M7-01 KP-3 — diskon tercatat per transaksi, dilaporkan bulanan
// =====================================================================================================================

export type DiscountRow = {
  saleId: string;
  number: string | null;
  localNumber: string;
  businessDate: string;
  soldAt: Date;
  customerName: string | null;
  cashierName: string | null;
  subtotal: number;
  discountAmount: number;
  discountPercent: number | null;
  total: number;
  reason: string | null;
  status: string;
  approvalStatus: string | null;
};

export async function discountReport(ctx: ActorContext, filter: { outletId?: string | null; month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m7.report.read", "m7.product_performance.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const month = filter.month ?? monthLabel(ctxBusinessDate(ctx));
  const { from, to } = monthRange(month);
  const outlet = await resolveOfficeStore(tx, ctx, filter.outletId ?? null);
  if (!outlet) return { outlet: null, month, rows: [] as DiscountRow[], totals: { count: 0, amount: 0, overLimitCount: 0 } };
  const rows = await tx
    .select({ s: posSales, customerName: customers.name, cashierName: employees.fullName })
    .from(posSales)
    .leftJoin(customers, eq(customers.id, posSales.customerId))
    .leftJoin(users, eq(users.id, posSales.operatorUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(posSales.outletId, outlet.id), gte(posSales.businessDate, from), lte(posSales.businessDate, to), eq(posSales.isReversal, false), sql`${posSales.discountAmount} > 0`))
    .orderBy(desc(posSales.soldAt));
  const apprIds = rows.map((r) => r.s.discountApprovalId).filter((x): x is string => !!x);
  const apprs = apprIds.length ? await tx.select({ id: approvalRequests.id, status: approvalRequests.status }).from(approvalRequests).where(inArray(approvalRequests.id, apprIds)) : [];
  const apprBy = new Map(apprs.map((a) => [a.id, a.status]));
  const out: DiscountRow[] = rows.map(({ s, customerName, cashierName }) => ({
    saleId: s.id,
    number: s.number,
    localNumber: s.localNumber,
    businessDate: s.businessDate,
    soldAt: s.soldAt,
    customerName: customerName ?? null,
    cashierName: cashierName ?? null,
    subtotal: s.subtotal,
    discountAmount: s.discountAmount,
    discountPercent: s.discountPercent,
    total: s.total,
    reason: s.discountReason,
    status: s.status,
    approvalStatus: s.discountApprovalId ? (apprBy.get(s.discountApprovalId) ?? null) : null,
  }));
  const effective = out.filter((r) => r.status === "valid" || r.status === "void_pending");
  return {
    outlet,
    month,
    rows: out,
    totals: { count: effective.length, amount: effective.reduce((s, r) => s + r.discountAmount, 0), overLimitCount: out.filter((r) => r.approvalStatus !== null).length },
  };
}

// =====================================================================================================================
// Ringkasan toko (kepala halaman /toko/*)
// =====================================================================================================================

export async function storeOverview(ctx: ActorContext, filter: { outletId?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m7.stock.read", "m7.supplier_payable.read", "m7.report.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const outlet = await resolveOfficeStore(tx, ctx, filter.outletId ?? null);
  const today = ctxBusinessDate(ctx);
  if (!outlet) return null;
  const [stock] = await tx
    .select({ value: sql<string>`coalesce(sum(${stockBalances.totalValue}), 0)`, items: sql<number>`count(*) filter (where ${stockBalances.quantity} > 0)::int` })
    .from(stockBalances)
    .where(eq(stockBalances.outletId, outlet.id));
  const [reorder] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(reorderItems)
    .where(and(eq(reorderItems.outletId, outlet.id), eq(reorderItems.status, "open")));
  const [subst] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(purchaseReceipts)
    .where(and(eq(purchaseReceipts.outletId, outlet.id), eq(purchaseReceipts.status, "pending_acceptance")));
  const payables = await payableRows(tx, ctx.tenantId, today);
  const pendingProposals = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, ctx.tenantId), eq(approvalRequests.status, "submitted"), inArray(approvalRequests.type, ["store_product", "supplier"])));
  return {
    outlet,
    stockValue: Number(stock?.value ?? 0),
    itemsInStock: Number(stock?.items ?? 0),
    reorderOpen: Number(reorder?.n ?? 0),
    substitutePending: Number(subst?.n ?? 0),
    payableTotal: payables.reduce((s, r) => s + r.outstanding, 0),
    payableOverdue: payables.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.outstanding, 0),
    pendingProposals: Number(pendingProposals[0]?.n ?? 0),
  };
}

/** Persetujuan terbuka barang/harga/pemasok toko (untuk tombol putuskan di layar kantor). */
export async function pendingStoreApprovals(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m7.stock.read", "m7.supplier.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, ctx.tenantId), eq(approvalRequests.status, "submitted"), inArray(approvalRequests.type, ["store_product", "supplier"])))
    .orderBy(asc(approvalRequests.createdAt));
  return rows.map((r) => ({ ...r, canDecide: ctx.roles.includes("finance_admin") && r.requesterUserId !== ctx.userId }));
}
