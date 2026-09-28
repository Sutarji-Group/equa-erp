/**
 * M2 — data laporan bulanan (US-M2-04 KP-3 / KPI-06, US-M2-09 KP-4, tinjauan 6.2c) — dipakai layar & ekspor (M9
 * membaca yang sama).
 */
import "server-only";

import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";

import { customers, orders, trips, trucks } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { businessDateToUtcRange, firstDayOfMonth, lastDayOfMonth, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ValidationError } from "@/server/core/errors";
import { authorize } from "@/server/core/rbac";

import { userNames } from "./common";

function monthRange(month: string): { from: BusinessDate; to: BusinessDate } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw ValidationError.field("month", "Bulan harus berformat YYYY-MM.");
  const from = `${month}-01`;
  return { from: firstDayOfMonth(from), to: lastDayOfMonth(from) };
}

export type CancelFailRow = {
  groupType: "customer" | "truck";
  groupName: string;
  kind: "cancel" | "fail";
  reason: string;
  reasonLabel: string;
  count: number;
};

/**
 * Laporan bulanan alasan pembatalan & kegagalan per pelanggan dan per truk (US-M2-09 KP-4). Pembatalan dihitung dari
 * tanggal batal (WIB), kegagalan dari tanggal gagal.
 */
export async function monthlyCancelFailReport(ctx: ActorContext, month: string, opts: { tx?: Tx } = {}): Promise<{ month: string; rows: CancelFailRow[]; totals: { cancelled: number; failed: number; duplicateCancelled: number } }> {
  await authorize(ctx, "m2.order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const { from, to } = monthRange(month);
  const start = businessDateToUtcRange(from).start;
  const end = businessDateToUtcRange(to).end;
  const cancelled = await tx
    .select({ reason: orders.cancelReason, customerName: customers.name, n: sql<number>`count(*)::int` })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.status, "cancelled"), gte(orders.cancelledAt, start), lt(orders.cancelledAt, end)))
    .groupBy(orders.cancelReason, customers.name);
  const cancelledByTruck = await tx
    .select({ reason: orders.cancelReason, truckCode: trucks.code, n: sql<number>`count(distinct ${orders.id})::int` })
    .from(orders)
    .innerJoin(trips, eq(trips.orderId, orders.id))
    .innerJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.status, "cancelled"), gte(orders.cancelledAt, start), lt(orders.cancelledAt, end)))
    .groupBy(orders.cancelReason, trucks.code);
  const failed = await tx
    .select({ reason: trips.failReason, customerName: customers.name, truckCode: trucks.code, n: sql<number>`count(*)::int` })
    .from(trips)
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(eq(trips.tenantId, ctx.tenantId), eq(trips.status, "failed"), gte(trips.failedAt, start), lt(trips.failedAt, end)))
    .groupBy(trips.failReason, customers.name, trucks.code);
  const rows: CancelFailRow[] = [];
  for (const c of cancelled) {
    rows.push({ groupType: "customer", groupName: c.customerName, kind: "cancel", reason: c.reason ?? "other", reasonLabel: label("order_cancel_reason", c.reason), count: Number(c.n) });
  }
  for (const c of cancelledByTruck) {
    rows.push({ groupType: "truck", groupName: c.truckCode, kind: "cancel", reason: c.reason ?? "other", reasonLabel: label("order_cancel_reason", c.reason), count: Number(c.n) });
  }
  const failCust = new Map<string, CancelFailRow>();
  const failTruck = new Map<string, CancelFailRow>();
  for (const f of failed) {
    const reason = f.reason ?? "other";
    const kc = `${f.customerName}|${reason}`;
    const rc = failCust.get(kc) ?? { groupType: "customer" as const, groupName: f.customerName, kind: "fail" as const, reason, reasonLabel: label("trip_fail_reason", reason), count: 0 };
    rc.count += Number(f.n);
    failCust.set(kc, rc);
    const truck = f.truckCode ?? "(tanpa truk)";
    const kt = `${truck}|${reason}`;
    const rt = failTruck.get(kt) ?? { groupType: "truck" as const, groupName: truck, kind: "fail" as const, reason, reasonLabel: label("trip_fail_reason", reason), count: 0 };
    rt.count += Number(f.n);
    failTruck.set(kt, rt);
  }
  rows.push(...failCust.values(), ...failTruck.values());
  rows.sort((a, b) => a.groupType.localeCompare(b.groupType) || a.groupName.localeCompare(b.groupName) || a.kind.localeCompare(b.kind) || b.count - a.count);
  return {
    month,
    rows,
    totals: {
      cancelled: cancelled.reduce((s, c) => s + Number(c.n), 0),
      failed: failed.reduce((s, f) => s + Number(f.n), 0),
      duplicateCancelled: cancelled.filter((c) => c.reason === "duplicate").reduce((s, c) => s + Number(c.n), 0),
    },
  };
}

export type Kpi06Row = {
  kind: "duplicate_cancelled" | "overdue_unscheduled";
  number: string;
  customerName: string;
  requestedDate: string;
  status: EnumValue<"order_status">;
  note: string | null;
  at: Date | null;
};

/**
 * KPI-06 (US-M2-04 KP-3): pesanan dibatalkan dengan alasan "dobel" + pesanan lewat tanggal tanpa jadwal ulang (masih
 * Baru/Menunggu persetujuan, tanggal diminta sudah lewat) dalam bulan itu.
 */
export async function kpi06Report(ctx: ActorContext, month: string, opts: { tx?: Tx } = {}): Promise<{ month: string; rows: Kpi06Row[]; duplicateCancelled: number; overdueUnscheduled: number }> {
  await authorize(ctx, "m2.order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const { from, to } = monthRange(month);
  const today = ctxBusinessDate(ctx);
  const start = businessDateToUtcRange(from).start;
  const end = businessDateToUtcRange(to).end;
  const dups = await tx
    .select({ o: orders, customerName: customers.name })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.status, "cancelled"), eq(orders.cancelReason, "duplicate"), gte(orders.cancelledAt, start), lt(orders.cancelledAt, end)))
    .orderBy(asc(orders.cancelledAt));
  const lastDay = to < today ? to : today;
  const overdue = await tx
    .select({ o: orders, customerName: customers.name })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.tenantId, ctx.tenantId), inArray(orders.status, ["new", "awaiting_approval"]), gte(orders.requestedDate, from), lt(orders.requestedDate, lastDay)))
    .orderBy(asc(orders.requestedDate));
  const rows: Kpi06Row[] = [
    ...dups.map(({ o, customerName }) => ({ kind: "duplicate_cancelled" as const, number: o.number, customerName, requestedDate: o.requestedDate, status: o.status, note: o.cancelNote, at: o.cancelledAt })),
    ...overdue.map(({ o, customerName }) => ({ kind: "overdue_unscheduled" as const, number: o.number, customerName, requestedDate: o.requestedDate, status: o.status, note: o.needsReschedule ? "Perlu jadwal ulang (rit gagal)" : null, at: null })),
  ];
  return { month, rows, duplicateCancelled: dups.length, overdueUnscheduled: overdue.length };
}

export type OverrideRow = { kind: "after_cutoff" | "duplicate_additional"; number: string; customerName: string; requestedDate: string; reason: string | null; createdByName: string | null; createdAt: Date };

/** Pengesampingan beralasan 6.2c (H+0 setelah PAR-05, pesanan tambahan walau dobel) untuk tinjauan pemilik bulanan. */
export async function overridesReport(ctx: ActorContext, month: string, opts: { tx?: Tx } = {}): Promise<OverrideRow[]> {
  await authorize(ctx, "m2.order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const { from, to } = monthRange(month);
  const rows = await tx
    .select({ o: orders, customerName: customers.name })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(
        eq(orders.tenantId, ctx.tenantId),
        gte(orders.requestedDate, from),
        lte(orders.requestedDate, to),
        sql`(${orders.afterCutoffForced} or (${orders.duplicateOfOrderId} is not null and ${orders.status} <> 'cancelled'))`,
      ),
    )
    .orderBy(asc(orders.requestedDate), asc(orders.createdAt));
  const names = await userNames(tx, rows.map((r) => r.o.createdBy));
  const out: OverrideRow[] = [];
  for (const { o, customerName } of rows) {
    const createdByName = o.createdBy ? (names.get(o.createdBy) ?? null) : "Sistem";
    if (o.afterCutoffForced) out.push({ kind: "after_cutoff", number: o.number, customerName, requestedDate: o.requestedDate, reason: o.afterCutoffReason, createdByName, createdAt: o.createdAt });
    if (o.duplicateOfOrderId && o.status !== "cancelled") out.push({ kind: "duplicate_additional", number: o.number, customerName, requestedDate: o.requestedDate, reason: o.duplicateReason, createdByName, createdAt: o.createdAt });
  }
  return out;
}

/** Ringkas hitungan untuk layar daftar pesanan. */
export async function orderCounters(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m2.order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const [row] = await tx
    .select({
      today: sql<number>`count(*) filter (where ${orders.requestedDate} = ${today} and ${orders.status} <> 'cancelled')::int`,
      awaiting: sql<number>`count(*) filter (where ${orders.status} = 'awaiting_approval')::int`,
      duplicates: sql<number>`count(*) filter (where ${orders.possibleDuplicate})::int`,
      reschedule: sql<number>`count(*) filter (where ${orders.needsReschedule} and ${orders.status} in ('new','awaiting_approval'))::int`,
      reconfirm: sql<number>`count(*) filter (where ${orders.reconfirmationRequired} and ${orders.reconfirmedAt} is null and ${orders.status} in ('new','awaiting_approval','scheduled'))::int`,
    })
    .from(orders)
    .where(eq(orders.tenantId, ctx.tenantId));
  const [unscheduled] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .where(and(eq(trips.tenantId, ctx.tenantId), isNull(trips.truckId), isNull(trips.withdrawnAt), eq(trips.status, "assigned"), lte(trips.scheduledDate, today), ne(orders.status, "cancelled")));
  return { ...row!, unscheduledTrips: Number(unscheduled?.n ?? 0) };
}
