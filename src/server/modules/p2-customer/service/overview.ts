/**
 * P2 — ringkasan adopsi aplikasi pelanggan untuk pemilik (8.2 "Penilaian, keluhan, adopsi"), pull sopir "sudah
 * dibayar" (US-P2-04 KP-4), dan data ekspor laporan modul.
 */
import "server-only";

import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { customerAccounts, customerAppOrders, orders, paymentIntents, trips } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { addDays, lastDayOfMonth, monthOf, toBusinessDate, wibToUtc } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { authorize } from "@/server/core/rbac";

import { isAppEnabled } from "./common";
import { complaintMonthlyReport, ratingAggregates } from "./feedback";
import { prepaidTrips } from "./payments";

export type AdoptionOverview = {
  month: string;
  enabled: boolean;
  accounts: { status: EnumValue<"customer_account_status">; label: string; count: number }[];
  linkedAccounts: number;
  ordersTotal: number;
  ordersFromApp: number;
  appSharePct: number;
  appOrdersConfirmedOnTime: number;
  appOrdersConfirmedLate: number;
  appOrdersRejected: number;
  appOrdersCancelledByCustomer: number;
  digitalPayments: { count: number; amount: number; fees: number };
  rating: { count: number; average: number };
  complaints: { total: number; open: number; overdue: number };
};

/** Ringkasan adopsi bulan berjalan / terpilih (pemilik, Dispatcher, Admin Keuangan — `p2.adoption.read`). */
export async function adoptionOverview(ctx: ActorContext, filter: { month?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<AdoptionOverview> {
  await authorize(ctx, "p2.adoption.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const month = filter.month && /^\d{4}-\d{2}$/.test(filter.month) ? filter.month : monthOf(ctxBusinessDate(ctx));
  const from = `${month}-01`;
  const to = lastDayOfMonth(from);
  const start = wibToUtc(from, "00:00");
  const end = wibToUtc(addDays(to, 1), "00:00");
  const accRows = await tx
    .select({ status: customerAccounts.status, n: count() })
    .from(customerAccounts)
    .where(eq(customerAccounts.tenantId, ctx.tenantId))
    .groupBy(customerAccounts.status);
  const [ordersTotal] = await tx
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.isInternal, false), gte(orders.requestedDate, from), sql`${orders.requestedDate} <= ${to}`));
  const appRows = await tx
    .select({ a: customerAppOrders, status: orders.status })
    .from(customerAppOrders)
    .innerJoin(orders, eq(orders.id, customerAppOrders.orderId))
    .where(and(eq(customerAppOrders.tenantId, ctx.tenantId), gte(customerAppOrders.createdAt, start), lt(customerAppOrders.createdAt, end)));
  const [pay] = await tx
    .select({ n: count(), amount: sql<number>`coalesce(sum(${paymentIntents.amount}), 0)::bigint`, fees: sql<number>`coalesce(sum(${paymentIntents.gatewayFee}), 0)::bigint` })
    .from(paymentIntents)
    .where(and(eq(paymentIntents.tenantId, ctx.tenantId), inArray(paymentIntents.status, ["succeeded", "matched"]), gte(paymentIntents.succeededAt, start), lt(paymentIntents.succeededAt, end)));
  const rating = await ratingAggregates(tx, { tenantId: ctx.tenantId, from, to });
  const comp = await complaintMonthlyReport(tx, { tenantId: ctx.tenantId, month, now: ctx.now });
  const total = Number(ordersTotal?.n ?? 0);
  const fromApp = appRows.length;
  return {
    month,
    enabled: await isAppEnabled(tx, ctx.tenantId),
    accounts: accRows.map((r) => ({ status: r.status, label: label("customer_account_status", r.status), count: Number(r.n) })),
    linkedAccounts: Number(accRows.find((r) => r.status === "linked")?.n ?? 0),
    ordersTotal: total,
    ordersFromApp: fromApp,
    appSharePct: total ? Math.round((fromApp / total) * 1000) / 10 : 0,
    appOrdersConfirmedOnTime: appRows.filter((r) => r.a.confirmedAt && (!r.a.confirmDueAt || r.a.confirmedAt <= r.a.confirmDueAt)).length,
    appOrdersConfirmedLate: appRows.filter((r) => r.a.confirmedAt && r.a.confirmDueAt && r.a.confirmedAt > r.a.confirmDueAt).length,
    appOrdersRejected: appRows.filter((r) => r.a.rejectedAt).length,
    appOrdersCancelledByCustomer: appRows.filter((r) => r.a.cancelledByCustomerAt).length,
    digitalPayments: { count: Number(pay?.n ?? 0), amount: Number(pay?.amount ?? 0), fees: Number(pay?.fees ?? 0) },
    rating: rating.overall,
    complaints: { total: comp.total, open: comp.open, overdue: comp.overdueFirstResponse },
  };
}

export type PrepaidTripPull = { date: string; trips: { tripId: string; orderId: string; paidAmount: number; paidAt: string | null; reference: string }[] };

/**
 * Pull `p2.prepaid_trips` (sopir/kernet): rit hari ini pada truk dalam lingkup yang SUDAH DIBAYAR di muka lewat
 * pembayaran digital — aplikasi sopir menampilkan "sudah dibayar" dan tidak menagih tunai (US-P2-04 KP-4).
 */
export async function prepaidTripsPull(tx: Tx, ctx: ActorContext): Promise<PrepaidTripPull> {
  const date = ctxBusinessDate(ctx) ?? toBusinessDate(ctx.now);
  const truckIds = ctx.scope.truckIds;
  if (!truckIds.length) return { date, trips: [] };
  const rows = await tx.select({ id: trips.id }).from(trips).where(and(eq(trips.scheduledDate, date), inArray(trips.truckId, truckIds)));
  const paid = await prepaidTrips(tx, rows.map((r) => r.id));
  return { date, trips: paid.map((p) => ({ tripId: p.tripId, orderId: p.orderId, paidAmount: p.paidAmount, paidAt: p.paidAt?.toISOString() ?? null, reference: p.reference })) };
}
