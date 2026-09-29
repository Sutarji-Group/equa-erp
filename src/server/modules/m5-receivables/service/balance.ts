/**
 * M5 — saldo piutang & eksposur kredit (US-M5-01 KP-3/KP-4, US-M5-06 KP-5; BR-06, PTB-25).
 *
 * - Saldo piutang pelanggan = Σ sisa faktur terbuka (semua lini: air truk, toko, kurang bayar, bulanan, saldo awal,
 *   piutang sementara transfer) + tagihan belum ditagih (`unbilled_charges`, pelanggan tagihan bulanan).
 * - Eksposur = saldo piutang + nilai rit tempo pesanan Baru/Menunggu persetujuan/Terjadwal/Dalam pengiriman yang
 *   belum Selesai + penjualan tempo toko Sah yang belum difakturkan (+ nilai transaksi yang sedang dinilai).
 * SATU batas per pelanggan lintas lini (PTB-25). M2 `computeCreditExposure` memakai `getReceivableBalance` ini.
 */
import "server-only";

import { and, eq, gt, inArray, isNull, min, ne, sql, sum, type SQL } from "drizzle-orm";

import { customers, invoices, orders, posSales, trips, unbilledCharges } from "@/db/schema";
import type { CreditStatus } from "@/lib/labels";
import type { BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { NotFoundError } from "@/server/core/errors";
import { assertTenantScope, authorize } from "@/server/core/rbac";

export type ReceivableBalance = {
  customerId: string;
  /** Σ sisa faktur terbuka (semua lini). */
  openInvoices: number;
  /** Jumlah faktur terbuka. */
  openInvoiceCount: number;
  /** Rit tempo pelanggan tagihan bulanan yang belum difakturkan. */
  unbilledCharges: number;
  /** Saldo piutang = faktur terbuka + belum ditagih (US-M5-01 KP-3). */
  balance: number;
  /** Sisa faktur yang sudah lewat jatuh tempo per `asOf`. */
  overdue: number;
  /** Jatuh tempo paling awal faktur terbuka. */
  oldestDueDate: BusinessDate | null;
};

/** Saldo piutang pelanggan (tanpa otorisasi — untuk modul lain di dalam transaksinya). */
export async function getReceivableBalance(tx: Tx, customerId: string, opts: { asOf?: BusinessDate } = {}): Promise<ReceivableBalance> {
  const [inv] = await tx
    .select({
      total: sum(invoices.outstandingAmount),
      n: sql<number>`count(*)::int`,
      oldest: min(invoices.dueDate),
      overdue: opts.asOf ? sql<string>`coalesce(sum(case when ${invoices.dueDate} < ${opts.asOf} then ${invoices.outstandingAmount} else 0 end), 0)` : sql<string>`0`,
    })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), gt(invoices.outstandingAmount, 0)));
  const [unb] = await tx
    .select({ total: sum(unbilledCharges.amount) })
    .from(unbilledCharges)
    .where(and(eq(unbilledCharges.customerId, customerId), eq(unbilledCharges.status, "unbilled")));
  const openInvoices = Number(inv?.total ?? 0);
  const unbilled = Number(unb?.total ?? 0);
  return {
    customerId,
    openInvoices,
    openInvoiceCount: Number(inv?.n ?? 0),
    unbilledCharges: unbilled,
    balance: openInvoices + unbilled,
    overdue: Number(inv?.overdue ?? 0),
    oldestDueDate: (inv?.oldest as string | null) ?? null,
  };
}

export type CreditExposureView = ReceivableBalance & {
  creditStatus: CreditStatus;
  creditLimit: number;
  paymentTermDays: number;
  monthlyBilling: boolean;
  /** Rit tempo pesanan berjalan (Ditugaskan/Berangkat/Tiba, tidak ditarik) — BR-06. */
  openCreditOrders: number;
  /** Penjualan tempo toko Sah yang belum menjadi faktur M5. */
  uninvoicedStoreCredit: number;
  extraAmount: number;
  exposure: number;
  remaining: number;
  exceedsLimit: boolean;
};

const ACTIVE_ORDER_STATUSES = ["new", "awaiting_approval", "scheduled", "in_delivery"] as const;

/** Penjualan tempo toko Sah yang belum menjadi faktur M5 (shift toko masih terbuka / belum tersinkron). */
function uninvoicedStoreCreditConds(customerId: string, excludeSaleId?: string | null): SQL[] {
  const conds: SQL[] = [
    eq(posSales.customerId, customerId),
    eq(posSales.paymentMethod, "credit"),
    eq(posSales.status, "valid"),
    eq(posSales.isReversal, false),
    isNull(posSales.invoiceId),
    sql`not exists (select 1 from ${invoices} where ${invoices.posSaleId} = ${posSales.id})`,
  ];
  if (excludeSaleId) conds.push(ne(posSales.id, excludeSaleId));
  return conds;
}

/**
 * Eksposur kredit (BR-06) — SATU definisi lintas lini (PTB-25, B-35): saldo piutang (faktur terbuka + belum ditagih) +
 * rit tempo pesanan berjalan + penjualan tempo toko Sah yang belum difakturkan + `extraAmount`. Dipakai M1 (kartu
 * pelanggan), M2 (`computeCreditExposure` pesanan tempo), M7 (tempo toko & pull POS) dan layar M5. Tanpa otorisasi.
 */
export async function computeExposure(
  tx: Tx,
  customerId: string,
  opts: { extraAmount?: number; excludeOrderId?: string | null; excludeSaleId?: string | null; asOf?: BusinessDate } = {},
): Promise<CreditExposureView> {
  const rows = await tx
    .select({
      creditStatus: customers.creditStatus,
      creditLimit: customers.creditLimit,
      paymentTermDays: customers.paymentTermDays,
      monthlyBilling: customers.monthlyBilling,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const c = rows[0];
  if (!c) throw new NotFoundError("Pelanggan tidak ditemukan.");
  const bal = await getReceivableBalance(tx, customerId, { asOf: opts.asOf });
  const orderConds: SQL[] = [
    eq(trips.customerId, customerId),
    eq(trips.paymentMethod, "credit"),
    inArray(trips.status, ["assigned", "departed", "arrived"]),
    isNull(trips.withdrawnAt),
    inArray(orders.status, [...ACTIVE_ORDER_STATUSES]),
  ];
  if (opts.excludeOrderId) orderConds.push(ne(trips.orderId, opts.excludeOrderId));
  const [open] = await tx
    .select({ total: sum(trips.price) })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .where(and(...orderConds));
  const [store] = await tx
    .select({ total: sum(posSales.total) })
    .from(posSales)
    .where(and(...uninvoicedStoreCreditConds(customerId, opts.excludeSaleId)));
  const openCreditOrders = Number(open?.total ?? 0);
  const uninvoicedStoreCredit = Number(store?.total ?? 0);
  const extraAmount = Math.max(0, Math.round(opts.extraAmount ?? 0));
  const exposure = bal.balance + openCreditOrders + uninvoicedStoreCredit + extraAmount;
  return {
    ...bal,
    creditStatus: c.creditStatus,
    creditLimit: c.creditLimit,
    paymentTermDays: c.paymentTermDays,
    monthlyBilling: c.monthlyBilling,
    openCreditOrders,
    uninvoicedStoreCredit,
    extraAmount,
    exposure,
    remaining: c.creditLimit - exposure,
    exceedsLimit: exposure > c.creditLimit,
  };
}

/** Eksposur kredit untuk layar (izin `m5.credit_exposure.read` — pemilik, Admin Keuangan, Dispatcher). */
export async function getCreditExposure(ctx: ActorContext, customerId: string, opts: { extraAmount?: number; tx?: Tx } = {}): Promise<CreditExposureView> {
  await authorize(ctx, "m5.credit_exposure.read", { tx: opts.tx, objectType: "customer", objectId: customerId });
  const tx = opts.tx ?? getDb();
  const rows = await tx.select({ tenantId: customers.tenantId }).from(customers).where(eq(customers.id, customerId)).limit(1);
  if (!rows[0]) throw new NotFoundError("Pelanggan tidak ditemukan.");
  assertTenantScope(ctx, rows[0].tenantId);
  return computeExposure(tx, customerId, { extraAmount: opts.extraAmount, asOf: ctxBusinessDate(ctx) });
}
