/**
 * M7 — data referensi offline POS toko (pull `m7.store`; D-07, Bab 6.4 butir 4): pelanggan mitra + eksposur sinkron
 * terakhir (PTB-42), barang toko + saldo + harga umum/mitra, pemasok, depot tujuan transfer, daftar pesan ulang,
 * opname bulan berjalan, transaksi hari ini (status persetujuan & nomor faktur tempo M5), nota & transfer terakhir,
 * usulan kasir. Shift, penjualan & void memakai pull kerangka POS `m6.pos`.
 *
 * ISOLASI TENANT (NFR-30): hanya toko perangkat (atau lingkup kasir untuk perangkat cadangan) di tenant perangkat.
 */
import "server-only";

import { and, desc, eq, gte, inArray, or } from "drizzle-orm";

import type { StoreReference } from "@/client/m7-store/contract";
import { approvalRequests, customers, internalTransfers, invoices, outlets, posSales, products, purchaseReceipts, stockBalances, stockCountLines, stockCounts, suppliers } from "@/db/schema";
import { label } from "@/lib/labels";
import { addDays, toBusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { resolveProductPrice } from "@/server/modules/m1-master";

import { loadOutlet, monthLabel, storeRules } from "./common";
import { storeCreditExposure } from "./credit";
import { reorderList } from "./reorder";

export async function buildStoreReference(tx: Tx, ctx: ActorContext, device: { outletId: string | null; tenantId: string }, now: Date): Promise<StoreReference | null> {
  const outletId = device.outletId ?? ctx.scope.outletIds[0] ?? null;
  if (!outletId) return null;
  const outlet = await loadOutlet(tx, outletId).catch(() => null);
  if (!outlet || outlet.kind !== "store" || outlet.tenantId !== device.tenantId || outlet.tenantId !== ctx.tenantId) return null;
  if (!ctx.scope.outletIds.includes(outlet.id) && !ctx.scope.tenantIds.includes(outlet.tenantId)) return null;
  const date = toBusinessDate(now);
  const [discount, rules] = await Promise.all([params.get(tx, "PAR-14", date), storeRules(tx, date, outlet.tenantId)]);

  const partnerRows = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, outlet.tenantId), eq(customers.isActive, true), eq(customers.isStorePartner, true)))
    .orderBy(customers.name);
  const custs = [];
  for (const c of partnerRows) {
    const exp = await storeCreditExposure(tx, c.id, 0);
    custs.push({
      id: c.id,
      code: c.code,
      name: c.name,
      waPhone: c.waPhone,
      isStorePartner: c.isStorePartner,
      creditStatus: c.creditStatus,
      creditLimit: c.creditLimit,
      paymentTermDays: c.paymentTermDays,
      exposure: exp.exposure,
    });
  }

  const prodRows = await tx
    .select()
    .from(products)
    .where(and(eq(products.tenantId, outlet.tenantId), eq(products.line, "store"), inArray(products.status, ["active", "pending_approval"])))
    .orderBy(products.sortOrder, products.code);
  const bal = await tx.select().from(stockBalances).where(eq(stockBalances.outletId, outlet.id));
  const balBy = new Map(bal.map((b) => [b.productId, b.quantity]));
  const productsRef: StoreReference["products"] = [];
  for (const p of prodRows) {
    const prices: StoreReference["products"][number]["prices"] = {};
    if (p.status === "active") {
      for (const kind of ["general", "partner"] as const) {
        try {
          prices[kind] = (await resolveProductPrice(tx, { productId: p.id, kind, date, tenantId: outlet.tenantId, outletId: outlet.id })).unitPrice;
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
        }
      }
    }
    productsRef.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, category: p.category, barcode: p.barcode, minStock: p.minStock, status: p.status, balance: balBy.get(p.id) ?? 0, prices });
  }

  const sups = await tx
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.tenantId, outlet.tenantId), inArray(suppliers.status, ["active", "pending_approval"])))
    .orderBy(suppliers.name);
  const depots = await tx
    .select({ id: outlets.id, code: outlets.code, name: outlets.name })
    .from(outlets)
    .where(and(eq(outlets.tenantId, outlet.tenantId), eq(outlets.kind, "depot"), eq(outlets.isActive, true)))
    .orderBy(outlets.code);

  const reorder = await reorderList(tx, { tenantId: outlet.tenantId, outletId: outlet.id, date });

  const period = monthLabel(date);
  const counts = await tx
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.outletId, outlet.id), eq(stockCounts.periodLabel, period), eq(stockCounts.kind, "monthly_store")))
    .orderBy(desc(stockCounts.startedAt));
  const open = counts.find((c) => c.status === "counting") ?? null;
  const openLines = open ? await tx.select().from(stockCountLines).where(eq(stockCountLines.stockCountId, open.id)) : [];

  const since = addDays(date, -1);
  const sales = await tx
    .select({ s: posSales, customerName: customers.name })
    .from(posSales)
    .leftJoin(customers, eq(customers.id, posSales.customerId))
    .where(and(eq(posSales.outletId, outlet.id), eq(posSales.isReversal, false), or(gte(posSales.businessDate, since), eq(posSales.status, "pending_approval"))))
    .orderBy(desc(posSales.soldAt))
    .limit(200);
  const saleIds = sales.map((s) => s.s.id);
  const inv = saleIds.length ? await tx.select({ posSaleId: invoices.posSaleId, number: invoices.number, dueDate: invoices.dueDate, id: invoices.id }).from(invoices).where(inArray(invoices.posSaleId, saleIds)) : [];
  const invBy = new Map(inv.map((i) => [i.posSaleId!, i]));

  const receipts = await tx
    .select({ r: purchaseReceipts, supplierName: suppliers.name })
    .from(purchaseReceipts)
    .innerJoin(suppliers, eq(suppliers.id, purchaseReceipts.supplierId))
    .where(eq(purchaseReceipts.outletId, outlet.id))
    .orderBy(desc(purchaseReceipts.createdAt))
    .limit(20);
  const transfers = await tx
    .select({ t: internalTransfers, toName: outlets.name })
    .from(internalTransfers)
    .innerJoin(outlets, eq(outlets.id, internalTransfers.toOutletId))
    .where(eq(internalTransfers.fromOutletId, outlet.id))
    .orderBy(desc(internalTransfers.sentAt))
    .limit(20);
  const proposals = ctx.userId
    ? await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.requesterUserId, ctx.userId), inArray(approvalRequests.type, ["store_product", "supplier", "store_discount", "store_credit_sale"])))
        .orderBy(desc(approvalRequests.createdAt))
        .limit(20)
    : [];

  return {
    version: 1,
    generatedAt: now.toISOString(),
    businessDate: date,
    outletId: outlet.id,
    rules: { discountMaxPercent: discount.max_percent, creditOfflineAfterMinutes: rules.credit_offline_after_minutes, averageSalesDays: rules.average_sales_days },
    customers: custs,
    products: productsRef,
    suppliers: sups.map((s) => ({ id: s.id, code: s.code, name: s.name, status: s.status, paymentTermDays: s.paymentTermDays })),
    depots,
    reorder: reorder.map((r) => ({
      id: r.id,
      productId: r.productId,
      name: r.name,
      unit: r.unit,
      minStock: r.minStock,
      balance: r.balance,
      avgDailySales: r.avgDailySales,
      lastSupplierId: r.lastSupplierId,
      lastSupplierName: r.lastSupplierName,
      status: r.status,
      orderedAt: r.orderedAt?.toISOString() ?? null,
      orderedSupplierName: r.orderedSupplierName,
    })),
    openStockCount: open
      ? {
          id: open.id,
          periodLabel: open.periodLabel,
          status: open.status,
          startedAt: open.startedAt.toISOString(),
          lines: openLines.map((l) => ({ productId: l.productId, physicalQty: l.physicalQty, systemQty: l.systemQtyAtCount, differenceQty: l.differenceQty, reason: l.reason })),
        }
      : null,
    monthCountDone: counts.some((c) => c.status === "submitted" || c.status === "approved"),
    recentSales: sales.map(({ s, customerName }) => ({
      id: s.id,
      number: s.number,
      localNumber: s.localNumber,
      soldAt: s.soldAt.toISOString(),
      customerId: s.customerId,
      customerName: customerName ?? null,
      paymentMethod: s.paymentMethod,
      subtotal: s.subtotal,
      discountAmount: s.discountAmount,
      total: s.total,
      status: s.status,
      creditOffline: s.creditOffline,
      invoiceNumber: invBy.get(s.id)?.number ?? null,
      invoiceDueDate: invBy.get(s.id)?.dueDate ?? null,
    })),
    recentReceipts: receipts.map(({ r, supplierName }) => ({
      id: r.id,
      number: r.number,
      localNumber: r.localNumber,
      supplierName,
      supplierNoteNumber: r.supplierNoteNumber,
      businessDate: r.businessDate,
      status: r.status,
      isSubstituteNote: r.isSubstituteNote,
      total: r.totalAmount,
    })),
    recentTransfers: transfers.map(({ t, toName }) => ({
      id: t.id,
      number: t.number,
      localNumber: t.localNumber,
      toOutletName: toName,
      status: t.status,
      totalValue: t.totalValue,
      hasDifference: t.hasDifference,
      sentAt: t.sentAt.toISOString(),
    })),
    proposals: proposals.map((p) => ({ id: p.id, type: p.type, label: label("approval_type", p.type), status: p.status, createdAt: p.createdAt.toISOString(), decisionReason: p.decisionReason ?? p.cancelReason ?? null })),
  };
}
