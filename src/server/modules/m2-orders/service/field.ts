/**
 * M2 — data untuk aplikasi sopir (penyedia pull `m2.schedule`) & job pagi (6.3 "pesanan belum terjadwal").
 *
 * Jadwal terbit truk hari itu (lingkup truk harian sopir/kernet dari jadwal kru) beserta catatan khusus pelanggan
 * (US-M2-08 KP-2), tagih kurang bayar (PTB-18), dan penanda kunci BR-10 (rit tampil tetapi terkunci). Dipakai M3.
 */
import "server-only";

import { and, asc, eq, inArray, isNull, lte, max, ne, sql } from "drizzle-orm";

import { customerAddresses, customers, dailySchedules, deposits, orders, trips, trucks } from "@/db/schema";
import { toBusinessDate, type BusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { notify } from "@/server/core/notifications";
import { can } from "@/server/core/rbac";

import { resolveDayCrews } from "./crew";
import { underpaymentStatus } from "./credit";

export type DriverTrip = {
  id: string;
  number: string;
  orderId: string;
  orderNumber: string;
  truckId: string;
  truckCode: string;
  scheduledDate: string;
  routeOrder: number | null;
  status: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  addressLabel: string;
  addressText: string;
  lat: number | null;
  lng: number | null;
  requestedTime: string | null;
  /** Catatan khusus: pelanggan (akses lokasi, jam terima) + alamat + pesanan (US-M2-08 KP-2). */
  customerNotes: string | null;
  addressNotes: string | null;
  orderNotes: string | null;
  price: number;
  paymentMethod: string;
  plannedVolumeL: number;
  isInternal: boolean;
  destinationOutletId: string | null;
  collectUnderpayment: boolean;
  underpaymentOutstanding: number;
  /** BR-10: setoran hari sebelumnya belum Ditutup → rit tampil tetapi terkunci. */
  locked: boolean;
  lockedReason: string | null;
  creditHold: boolean;
};

export type DriverSchedule = { date: BusinessDate; revision: Record<string, number>; trips: DriverTrip[] };

/**
 * Rit terbit untuk truk-truk dalam lingkup pelaku lapangan pada tanggal (US-M2-03 KP-5). `since` → `undefined` bila
 * tidak ada perubahan (hemat kuota, NFR-17).
 */
export async function driverSchedule(tx: Tx, ctx: ActorContext, date: BusinessDate, since: Date | null): Promise<DriverSchedule | undefined> {
  const truckIds = ctx.scope.truckIds;
  if (!truckIds.length) return { date, revision: {}, trips: [] };
  if (since) {
    const [t] = await tx.select({ m: max(trips.updatedAt) }).from(trips).where(and(inArray(trips.truckId, truckIds), eq(trips.scheduledDate, date)));
    const [s] = await tx.select({ m: max(dailySchedules.updatedAt) }).from(dailySchedules).where(and(inArray(dailySchedules.truckId, truckIds), eq(dailySchedules.businessDate, date)));
    const [d] = await tx.select({ m: max(deposits.updatedAt) }).from(deposits).where(and(eq(deposits.sourceType, "driver"), inArray(deposits.truckId, truckIds)));
    const latest = [t?.m, s?.m, d?.m].filter((x): x is Date => !!x).map((x) => new Date(x).getTime());
    if (latest.length && Math.max(...latest) <= since.getTime()) return undefined;
  }
  const rows = await tx
    .select({
      t: trips,
      orderNumber: orders.number,
      requestedTime: orders.requestedTime,
      orderNotes: orders.notes,
      collectUnderpayment: orders.collectUnderpayment,
      customerName: customers.name,
      customerPhone: customers.waPhone,
      customerNotes: customers.notes,
      fixedReceiveTime: customers.fixedReceiveTime,
      addressLabel: customerAddresses.label,
      addressText: customerAddresses.addressText,
      addressNotes: customerAddresses.notes,
      lat: customerAddresses.lat,
      lng: customerAddresses.lng,
      truckCode: trucks.code,
    })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
    .innerJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(inArray(trips.truckId, truckIds), eq(trips.scheduledDate, date), isNull(trips.withdrawnAt), sql`${trips.publishedAt} is not null`, ne(orders.status, "cancelled")))
    .orderBy(asc(trucks.code), asc(sql`coalesce(${trips.routeOrder}, 9999)`));
  const crews = await resolveDayCrews(tx, ctx.tenantId, date, toBusinessDate(ctx.now), truckIds);
  const schedules = await tx.select({ truckId: dailySchedules.truckId, version: dailySchedules.version }).from(dailySchedules).where(and(inArray(dailySchedules.truckId, truckIds), eq(dailySchedules.businessDate, date)));
  const pii = can(ctx, "m1.customer_pii.read");
  const upCache = new Map<string, number>();
  const out: DriverTrip[] = [];
  for (const r of rows) {
    const crew = crews.get(r.t.truckId!);
    let outstanding = 0;
    if (r.collectUnderpayment) {
      if (!upCache.has(r.t.customerId)) upCache.set(r.t.customerId, (await underpaymentStatus(tx, r.t.customerId)).openAmount);
      outstanding = upCache.get(r.t.customerId)!;
    }
    const fixed = r.fixedReceiveTime ? `Jam terima tetap ${r.fixedReceiveTime.slice(0, 5)}` : null;
    out.push({
      id: r.t.id,
      number: r.t.number,
      orderId: r.t.orderId,
      orderNumber: r.orderNumber,
      truckId: r.t.truckId!,
      truckCode: r.truckCode,
      scheduledDate: r.t.scheduledDate,
      routeOrder: r.t.routeOrder,
      status: r.t.status,
      customerId: r.t.customerId,
      customerName: r.customerName,
      customerPhone: pii ? r.customerPhone : null,
      addressLabel: r.addressLabel,
      addressText: r.addressText,
      lat: r.lat,
      lng: r.lng,
      requestedTime: r.requestedTime?.slice(0, 5) ?? null,
      customerNotes: [r.customerNotes, fixed].filter(Boolean).join(" · ") || null,
      addressNotes: r.addressNotes,
      orderNotes: r.orderNotes,
      price: r.t.price,
      paymentMethod: r.t.paymentMethod,
      plannedVolumeL: r.t.plannedVolumeL,
      isInternal: r.t.isInternal,
      destinationOutletId: r.t.destinationOutletId,
      collectUnderpayment: r.collectUnderpayment && outstanding > 0,
      underpaymentOutstanding: outstanding,
      locked: !!crew?.lock,
      lockedReason: crew?.lockMessage ?? null,
      creditHold: !!r.t.creditHoldFlaggedAt && !r.t.creditHoldResolution,
    });
  }
  return { date, revision: Object.fromEntries(schedules.map((s) => [s.truckId, s.version])), trips: out };
}

/**
 * Job pagi H (6.3 "Pesanan belum terjadwal"): rit untuk hari ini (dan tanggal lewat) yang belum bertruk/belum terbit
 * → satu notifikasi ke Dispatcher per hari.
 */
export async function notifyUnscheduledToday(tx: Tx, now: Date): Promise<{ tenants: number; trips: number }> {
  const today = toBusinessDate(now);
  const rows = await tx
    .select({ tenantId: trips.tenantId, n: sql<number>`count(*)::int` })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .where(
      and(
        isNull(trips.withdrawnAt),
        eq(trips.status, "assigned"),
        lte(trips.scheduledDate, today),
        ne(orders.status, "cancelled"),
        sql`(${trips.truckId} is null or ${trips.publishedAt} is null)`,
      ),
    )
    .groupBy(trips.tenantId);
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (!n) continue;
    total += n;
    await notify(tx, {
      event: "order.unscheduled",
      tenantId: r.tenantId,
      title: `${n} rit untuk hari ini belum terjadwal/terbit`,
      body: "Tugaskan ke truk dan terbitkan jadwal di papan jadwal.",
      objectType: "daily_schedule",
      objectId: today,
      valueText: `${n} rit`,
      link: `/jadwal?tanggal=${today}`,
      groupKey: `order.unscheduled:${today}`,
      now,
    });
  }
  return { tenants: rows.length, trips: total };
}
