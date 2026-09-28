/**
 * M3 — kueri kantor & laporan ekspor (NFR-23): rit sopir (bukti kirim, lokasi, volume, dicatat kantor, terlambat
 * sinkron), pembayaran rit, pelunasan lewat sopir, pengeluaran rit, setoran sopir. Semua berlingkup tenant pelaku.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";

import { customerPayments, customers, deposits, employees, tripExpenses, tripPayments, trips, trucks, users } from "@/db/schema";
import { addDays, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { authorizeAny } from "@/server/core/rbac";

export type RangeFilter = { from?: BusinessDate; to?: BusinessDate; truckId?: string | null };

function range(ctx: ActorContext, f: RangeFilter): { from: BusinessDate; to: BusinessDate } {
  const to = f.to ?? ctxBusinessDate(ctx);
  return { from: f.from ?? addDays(to, -6), to };
}

export type DriverTripReportRow = {
  number: string;
  scheduledDate: string;
  businessDate: string | null;
  truckCode: string | null;
  driverName: string | null;
  customerName: string;
  status: string;
  isInternal: boolean;
  departedAt: Date | null;
  arrivedAt: Date | null;
  completedAt: Date | null;
  deliveredVolumeL: number | null;
  partialVolumeReason: string | null;
  recipientName: string | null;
  signatureSkippedReason: string | null;
  completionDistanceM: number | null;
  locationDeviation: string;
  locationReason: string | null;
  ownerReviewRequired: boolean;
  noLocation: boolean;
  failReason: string | null;
  loadedWaterDisposition: string | null;
  actualOrder: number | null;
  routeOrder: number | null;
  recordedByOffice: boolean;
  lateSync: boolean;
  syncConflict: boolean;
};

/** Rit yang dikerjakan sopir (kantor: Dispatcher, Admin Keuangan, Pemilik — izin `m2.trip.read`). */
export async function driverTripReport(ctx: ActorContext, f: RangeFilter = {}, opts: { tx?: Tx } = {}): Promise<DriverTripReportRow[]> {
  await authorizeAny(ctx, ["m2.trip.read", "m3.trip_incident.read"], { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const { from, to } = range(ctx, f);
  const conds: SQL[] = [eq(trips.tenantId, ctx.tenantId), gte(trips.scheduledDate, from), lte(trips.scheduledDate, to), inArray(trips.status, ["departed", "arrived", "completed", "failed"])];
  if (f.truckId) conds.push(eq(trips.truckId, f.truckId));
  const rows = await db
    .select({ t: trips, truckCode: trucks.code, driverName: employees.fullName, customerName: customers.name })
    .from(trips)
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .leftJoin(users, eq(users.id, trips.driverUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(...conds))
    .orderBy(asc(trips.scheduledDate), asc(trucks.code), asc(trips.actualOrder));
  return rows.map((r) => ({
    number: r.t.number,
    scheduledDate: r.t.scheduledDate,
    businessDate: r.t.completionBusinessDate,
    truckCode: r.truckCode,
    driverName: r.driverName,
    customerName: r.customerName,
    status: r.t.status,
    isInternal: r.t.isInternal,
    departedAt: r.t.departedAt,
    arrivedAt: r.t.arrivedAt,
    completedAt: r.t.completedAt,
    deliveredVolumeL: r.t.deliveredVolumeL,
    partialVolumeReason: r.t.partialVolumeReason,
    recipientName: r.t.recipientName,
    signatureSkippedReason: r.t.signatureSkippedReason,
    completionDistanceM: r.t.completionDistanceM,
    locationDeviation: r.t.locationDeviation,
    locationReason: r.t.locationReason,
    ownerReviewRequired: r.t.ownerReviewRequired,
    noLocation: r.t.noLocation,
    failReason: r.t.failReason,
    loadedWaterDisposition: r.t.loadedWaterDisposition,
    actualOrder: r.t.actualOrder,
    routeOrder: r.t.routeOrder,
    recordedByOffice: r.t.recordedByOffice,
    lateSync: r.t.lateSync,
    syncConflict: r.t.syncConflict,
  }));
}

export async function tripPaymentReport(ctx: ActorContext, f: RangeFilter = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m3.payment_report.read"], { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const { from, to } = range(ctx, f);
  const rows = await db
    .select({ p: tripPayments, tripNumber: trips.number, truckCode: trucks.code, customerName: customers.name, driverName: employees.fullName })
    .from(tripPayments)
    .innerJoin(trips, eq(trips.id, tripPayments.tripId))
    .innerJoin(customers, eq(customers.id, tripPayments.customerId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .leftJoin(users, eq(users.id, tripPayments.driverUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(tripPayments.tenantId, ctx.tenantId), gte(tripPayments.businessDate, from), lte(tripPayments.businessDate, to), ...(f.truckId ? [eq(trips.truckId, f.truckId)] : [])))
    .orderBy(asc(tripPayments.businessDate), asc(trips.number));
  return rows.map((r) => ({
    businessDate: r.p.businessDate,
    tripNumber: r.tripNumber,
    truckCode: r.truckCode,
    driverName: r.driverName,
    customerName: r.customerName,
    method: r.p.method,
    originalMethod: r.p.originalMethod,
    expectedAmount: r.p.expectedAmount,
    receivedAmount: r.p.receivedAmount,
    underpaymentAmount: r.p.underpaymentAmount,
    underpaymentReason: r.p.underpaymentReason,
    isReversal: !!r.p.reversalOfId,
    recordedByOffice: r.p.recordedByOffice,
    lateSync: r.p.lateSync,
  }));
}

export async function collectionReport(ctx: ActorContext, f: RangeFilter = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m3.payment_report.read"], { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const { from, to } = range(ctx, f);
  const rows = await db
    .select({ p: customerPayments, customerName: customers.name, driverName: employees.fullName, tripNumber: trips.number })
    .from(customerPayments)
    .innerJoin(customers, eq(customers.id, customerPayments.customerId))
    .leftJoin(trips, eq(trips.id, customerPayments.tripId))
    .leftJoin(users, eq(users.id, customerPayments.driverUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(customerPayments.tenantId, ctx.tenantId), eq(customerPayments.channel, "driver"), gte(customerPayments.businessDate, from), lte(customerPayments.businessDate, to)))
    .orderBy(asc(customerPayments.businessDate));
  return rows.map((r) => ({
    businessDate: r.p.businessDate,
    driverName: r.driverName,
    customerName: r.customerName,
    tripNumber: r.tripNumber,
    method: r.p.method,
    amount: r.p.amount,
    advanceAmount: r.p.advanceAmount,
    recordedByOffice: r.p.recordedByOffice,
    lateSync: r.p.lateSync,
  }));
}

export async function expenseReport(ctx: ActorContext, f: RangeFilter = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m3.payment_report.read"], { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const { from, to } = range(ctx, f);
  const rows = await db
    .select({ e: tripExpenses, truckCode: trucks.code, driverName: employees.fullName, tripNumber: trips.number })
    .from(tripExpenses)
    .innerJoin(trucks, eq(trucks.id, tripExpenses.truckId))
    .leftJoin(trips, eq(trips.id, tripExpenses.tripId))
    .leftJoin(users, eq(users.id, tripExpenses.driverUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(tripExpenses.tenantId, ctx.tenantId), gte(tripExpenses.businessDate, from), lte(tripExpenses.businessDate, to), ...(f.truckId ? [eq(tripExpenses.truckId, f.truckId)] : [])))
    .orderBy(asc(tripExpenses.businessDate));
  return rows.map((r) => ({
    businessDate: r.e.businessDate,
    truckCode: r.truckCode,
    driverName: r.driverName,
    tripNumber: r.tripNumber,
    kind: r.e.kind,
    amount: r.e.amount,
    fundingSource: r.e.fundingSource,
    status: r.e.status,
    note: r.e.note,
  }));
}

export async function driverDepositReport(ctx: ActorContext, f: RangeFilter = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m3.payment_report.read"], { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const { from, to } = range(ctx, f);
  const rows = await db
    .select({ d: deposits, truckCode: trucks.code, driverName: employees.fullName })
    .from(deposits)
    .leftJoin(trucks, eq(trucks.id, deposits.truckId))
    .leftJoin(users, eq(users.id, deposits.depositorUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(deposits.tenantId, ctx.tenantId), eq(deposits.sourceType, "driver"), gte(deposits.businessDate, from), lte(deposits.businessDate, to)))
    .orderBy(desc(deposits.businessDate));
  return rows.map((r) => ({
    number: r.d.number,
    businessDate: r.d.businessDate,
    truckCode: r.truckCode,
    driverName: r.driverName,
    status: r.d.status,
    method: r.d.method,
    expectedCash: r.d.expectedCash,
    expectedNet: r.d.expectedNet,
    receivedAmount: r.d.receivedAmount,
    discrepancyAmount: r.d.discrepancyAmount,
    submittedAt: r.d.submittedAt,
    submittedLate: r.d.submittedLate,
    depositorNote: r.d.depositorNote,
  }));
}
