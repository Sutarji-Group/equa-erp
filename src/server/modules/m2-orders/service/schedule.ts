/**
 * M2 — papan jadwal rit harian (US-M2-03; BR-10, BR-21; 7.2.6; Bab 6.4 KP-3).
 *
 * - Satu jalur per truk (kru hari itu dari US-M2-10/11), kolom "Belum terjadwal" (rit tanggal itu + tanggal lewat yang
 *   belum selesai) dengan hitungan; jumlah rit pelanggan/internal terpisah & gabungan, volume vs kapasitas (PAR-33;
 *   melebihi → peringatan, tidak diblokir).
 * - Tugaskan/urutkan (seret-lepas atau tombol); urutan usulan BR-21; tolak truk Perbaikan/Nonaktif/tanpa sopir.
 * - "Terbitkan" → rit terbit + event `trip.published`; perubahan setelah terbit tercatat (`schedule_change_logs`) dan
 *   diterbitkan ulang (revisi); rit Berangkat tidak dapat dipindah; "harga sementara" tidak dapat diterbitkan.
 * - Status rit real-time dari M3, posisi truk terakhir (`gps_positions`, M12), penanda kunci BR-10, konflik lapangan.
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import { customerAddresses, customers, dailySchedules, gpsPositions, orders, scheduleChangeLogs, truckDayStatus, trips, trucks } from "@/db/schema";
import { label, type EnumValue, type OrderStatus, type PaymentMethod, type TripStatus } from "@/lib/labels";
import { formatTanggal } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, parseInput, ValidationError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { authorize, can, runService, sod } from "@/server/core/rbac";
import { assertTruckCanReceiveTrips } from "@/server/modules/m1-master";

import { assignTripSchema, reorderSchema, type AssignTripInput, type ReorderInput } from "../schemas";
import { isTripOpen, isTripPublished, loadOrder, loadTrip, loadTruck, orderRules, userNames, type OrderRow, type TripRow, type TruckRow } from "./common";
import { resolveDayCrews, truckCapacity, type DayCrew } from "./crew";
import { recomputeOrderStatus, schedulingBlockers, type SchedulingBlocker } from "./lifecycle";
import { ensureSchedule, logScheduleChange, type ScheduleRow } from "./schedule-log";

// =====================================================================================================================
// Urutan usulan BR-21
// =====================================================================================================================

type RankInput = { recurring: boolean; fixedTime: string | null; requestedTime: string | null; orderCreatedAt: Date; number: string };

/**
 * BR-21: rit langganan dan pelanggan berjam-terima-tetap lebih dulu (urut jam), sisanya berdasarkan waktu pesanan
 * masuk. Negatif = `a` lebih dulu.
 */
export function compareBr21(a: RankInput, b: RankInput): number {
  const ga = a.recurring || !!a.fixedTime ? 0 : 1;
  const gb = b.recurring || !!b.fixedTime ? 0 : 1;
  if (ga !== gb) return ga - gb;
  if (ga === 0) {
    const ta = (a.requestedTime ?? a.fixedTime ?? "99:99").slice(0, 5);
    const tb = (b.requestedTime ?? b.fixedTime ?? "99:99").slice(0, 5);
    if (ta !== tb) return ta < tb ? -1 : 1;
  }
  const d = a.orderCreatedAt.getTime() - b.orderCreatedAt.getTime();
  if (d !== 0) return d;
  return a.number.localeCompare(b.number);
}

type TripWithRank = { trip: TripRow; rank: RankInput };

async function rankInputs(tx: Tx, tripRows: TripRow[]): Promise<TripWithRank[]> {
  if (!tripRows.length) return [];
  const rows = await tx
    .select({ id: orders.id, recurringOrderId: orders.recurringOrderId, source: orders.source, requestedTime: orders.requestedTime, createdAt: orders.createdAt, fixed: customers.fixedReceiveTime })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(inArray(orders.id, [...new Set(tripRows.map((t) => t.orderId))]));
  return tripRows.map((trip) => {
    const o = rows.find((r) => r.id === trip.orderId)!;
    return {
      trip,
      rank: {
        recurring: !!o.recurringOrderId || o.source === "recurring",
        fixedTime: o.fixed?.slice(0, 5) ?? null,
        requestedTime: o.requestedTime?.slice(0, 5) ?? null,
        orderCreatedAt: o.createdAt,
        number: trip.number,
      },
    };
  });
}

async function laneTrips(tx: Tx, truckId: string, date: string): Promise<TripRow[]> {
  return tx
    .select()
    .from(trips)
    .where(and(eq(trips.truckId, truckId), eq(trips.scheduledDate, date), isNull(trips.withdrawnAt), ne(trips.status, "failed")))
    .orderBy(asc(sql`coalesce(${trips.routeOrder}, 9999)`), asc(trips.number));
}

/** Tulis ulang urutan 1..n jalur (rit berjalan/selesai tetap di depan sesuai urutannya). */
async function writeLaneOrder(tx: Tx, ctx: ActorContext, ordered: TripRow[], opts: { log?: { schedule: ScheduleRow; reason: string | null } } = {}): Promise<void> {
  let i = 1;
  for (const t of ordered) {
    const next = i++;
    if (t.routeOrder === next) continue;
    await tx.update(trips).set({ routeOrder: next, updatedAt: ctx.now }).where(eq(trips.id, t.id));
    if (opts.log && isTripPublished(t)) {
      await logScheduleChange(tx, ctx, {
        tenantId: t.tenantId,
        scheduleId: opts.log.schedule.id,
        tripId: t.id,
        changeType: "reordered",
        before: { routeOrder: t.routeOrder },
        after: { routeOrder: next },
        reason: opts.log.reason,
        afterPublish: true,
      });
    }
  }
}

// =====================================================================================================================
// Papan
// =====================================================================================================================

export type BoardTrip = {
  id: string;
  number: string;
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  status: TripStatus;
  customerId: string;
  customerName: string;
  addressLabel: string;
  addressText: string;
  lat: number | null;
  lng: number | null;
  scheduledDate: string;
  requestedTime: string | null;
  fixedReceiveTime: string | null;
  tankCount: number;
  routeOrder: number | null;
  price: number;
  paymentMethod: PaymentMethod;
  plannedVolumeL: number;
  isInternal: boolean;
  recurring: boolean;
  published: boolean;
  overdue: boolean;
  possibleDuplicate: boolean;
  needsReschedule: boolean;
  needsReassignment: boolean;
  reconfirmationPending: boolean;
  collectUnderpayment: boolean;
  provisionalPrice: boolean;
  creditHold: boolean;
  syncConflict: boolean;
  syncConflictNote: string | null;
  notes: string | null;
  customerNotes: string | null;
  blockers: SchedulingBlocker[];
  departedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failReason: TripRow["failReason"];
};

export type BoardLane = {
  truck: { id: string; code: string; plateNumber: string; status: TruckRow["status"]; isActive: boolean; capacityL: number };
  dayStatus: EnumValue<"truck_day_status">;
  dayReason: string | null;
  crew: DayCrew;
  schedule: { id: string; status: EnumValue<"schedule_status">; version: number; publishedAt: Date | null; pendingChanges: boolean } | null;
  trips: BoardTrip[];
  counts: { customer: number; internal: number; total: number };
  volumeL: number;
  capacityTrips: number;
  capacityVolumeL: number;
  overCapacity: boolean;
  /** Dapat menerima rit (Aktif, operasi, ada sopir). */
  canReceive: boolean;
  cannotReceiveReason: string | null;
  lastPosition: { lat: number; lng: number; at: Date; speedKmh: number | null } | null;
};

export type Board = {
  date: string;
  today: string;
  generatedAt: Date;
  lanes: BoardLane[];
  unscheduled: BoardTrip[];
  conflicts: BoardTrip[];
  totals: { capacity: number; customer: number; internal: number; scheduled: number; unscheduled: number; overdue: number; overCapacity: boolean };
  canEdit: boolean;
  canPublish: boolean;
};

/** Papan jadwal per tanggal (US-M2-03 KP-1..KP-7). */
/**
 * Posisi valid terakhir per truk untuk papan (satu kueri LATERAL — indeks `gps_positions_truck_time_idx` mundur, berhenti
 * di baris pertama per truk). Pengganti `DISTINCT ON (truck_id)` yang memindai seluruh riwayat posisi (uji beban NFR-05:
 * ±0,9 dtk pada 730 rb posisi; docs/qa/uji-beban.md).
 */
async function lastValidPositions(tx: Tx, truckIds: string[]): Promise<{ truckId: string; lat: number; lng: number; at: Date; speedKmh: number | null }[]> {
  const res = await tx.execute<{ truck_id: string; lat: number; lng: number; device_time: Date | string; speed_kmh: number | null }>(sql`
    select p.truck_id, p.lat, p.lng, p.device_time, p.speed_kmh
    from (values ${sql.join(
      truckIds.map((id) => sql`(${id}::uuid)`),
      sql`, `,
    )}) as t(id)
    cross join lateral (
      select g.truck_id, g.lat, g.lng, g.device_time, g.speed_kmh
      from ${gpsPositions} g
      where g.truck_id = t.id and g.is_valid
      order by g.device_time desc
      limit 1
    ) p`);
  return res.rows.map((r) => ({
    truckId: r.truck_id,
    lat: Number(r.lat),
    lng: Number(r.lng),
    at: r.device_time instanceof Date ? r.device_time : new Date(r.device_time),
    speedKmh: r.speed_kmh === null ? null : Number(r.speed_kmh),
  }));
}

export async function getBoard(ctx: ActorContext, date: string, opts: { tx?: Tx } = {}): Promise<Board> {
  await authorize(ctx, "m2.schedule.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const rules = await orderRules(tx, date);
  const truckRows = await tx.select().from(trucks).where(eq(trucks.tenantId, ctx.tenantId)).orderBy(asc(trucks.code));
  const days = await tx.select().from(truckDayStatus).where(and(eq(truckDayStatus.tenantId, ctx.tenantId), eq(truckDayStatus.businessDate, date)));
  const schedules = await tx.select().from(dailySchedules).where(and(eq(dailySchedules.tenantId, ctx.tenantId), eq(dailySchedules.businessDate, date)));
  const crews = await resolveDayCrews(tx, ctx.tenantId, date, today);

  const laneRows = await tx
    .select()
    .from(trips)
    .where(and(eq(trips.tenantId, ctx.tenantId), eq(trips.scheduledDate, date), isNull(trips.withdrawnAt), sql`${trips.truckId} is not null`))
    .orderBy(asc(sql`coalesce(${trips.routeOrder}, 9999)`), asc(trips.number));
  const pendingRows = await tx
    .select()
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .where(
      and(
        eq(trips.tenantId, ctx.tenantId),
        isNull(trips.withdrawnAt),
        eq(trips.status, "assigned"),
        ne(orders.status, "cancelled"),
        or(and(isNull(trips.truckId), lte(trips.scheduledDate, date)), and(sql`${trips.truckId} is not null`, lt(trips.scheduledDate, date))),
      ),
    );
  const unscheduledRows = pendingRows.map((r) => r.trips);
  const conflictRows = await tx
    .select()
    .from(trips)
    .where(and(eq(trips.tenantId, ctx.tenantId), eq(trips.syncConflict, true), isNull(trips.syncConflictResolvedAt)));

  const allTrips = [...laneRows, ...unscheduledRows, ...conflictRows];
  const orderIds = [...new Set(allTrips.map((t) => t.orderId))];
  const orderRows = orderIds.length
    ? await tx
        .select({ o: orders, customerName: customers.name, customerNotes: customers.notes, fixed: customers.fixedReceiveTime, addressLabel: customerAddresses.label, addressText: customerAddresses.addressText, lat: customerAddresses.lat, lng: customerAddresses.lng })
        .from(orders)
        .innerJoin(customers, eq(customers.id, orders.customerId))
        .innerJoin(customerAddresses, eq(customerAddresses.id, orders.addressId))
        .where(inArray(orders.id, orderIds))
    : [];
  const byOrder = new Map(orderRows.map((r) => [r.o.id, r]));
  const blockerCache = new Map<string, SchedulingBlocker[]>();
  const view = async (t: TripRow): Promise<BoardTrip> => {
    const r = byOrder.get(t.orderId)!;
    const o = r.o;
    let blockers: SchedulingBlocker[] = [];
    if (t.status === "assigned" && !t.withdrawnAt && !isTripPublished(t)) {
      const key = `${o.id}:${t.creditHoldFlaggedAt && !t.creditHoldResolution ? "h" : ""}`;
      if (!blockerCache.has(key)) blockerCache.set(key, await schedulingBlockers(tx, o, { forPublish: true, trip: t }));
      blockers = blockerCache.get(key)!;
    }
    return {
      id: t.id,
      number: t.number,
      orderId: o.id,
      orderNumber: o.number,
      orderStatus: o.status,
      status: t.status,
      customerId: o.customerId,
      customerName: r.customerName,
      addressLabel: r.addressLabel,
      addressText: r.addressText,
      lat: r.lat,
      lng: r.lng,
      scheduledDate: t.scheduledDate,
      requestedTime: o.requestedTime?.slice(0, 5) ?? null,
      fixedReceiveTime: r.fixed?.slice(0, 5) ?? null,
      tankCount: o.tankCount,
      routeOrder: t.routeOrder,
      price: t.price,
      paymentMethod: t.paymentMethod,
      plannedVolumeL: t.plannedVolumeL,
      isInternal: t.isInternal,
      recurring: !!o.recurringOrderId || o.source === "recurring",
      published: isTripPublished(t),
      overdue: t.scheduledDate < date && t.status === "assigned",
      possibleDuplicate: o.possibleDuplicate,
      needsReschedule: o.needsReschedule,
      needsReassignment: t.needsReassignment,
      reconfirmationPending: o.reconfirmationRequired && !o.reconfirmedAt,
      collectUnderpayment: o.collectUnderpayment,
      provisionalPrice: o.priceIsProvisional,
      creditHold: !!t.creditHoldFlaggedAt && !t.creditHoldResolution,
      syncConflict: t.syncConflict && !t.syncConflictResolvedAt,
      syncConflictNote: t.syncConflictNote,
      notes: o.notes,
      customerNotes: r.customerNotes,
      blockers,
      departedAt: t.departedAt,
      completedAt: t.completedAt,
      failedAt: t.failedAt,
      failReason: t.failReason,
    };
  };

  // US-M12-02 KP-4: posisi truk hanya untuk peran berizin peta armada (pemilik & Dispatcher), bukan semua pembaca papan.
  const lastPositions = truckRows.length && can(ctx, "m12.position.read") ? await lastValidPositions(tx, truckRows.map((t) => t.id)) : [];

  const lanes: BoardLane[] = [];
  let capacity = 0;
  let customer = 0;
  let internal = 0;
  for (const t of truckRows) {
    const own = laneRows.filter((x) => x.truckId === t.id);
    const day = days.find((d) => d.truckId === t.id) ?? null;
    const operating = t.isActive && t.status === "active" && day?.status !== "maintenance";
    if (!operating && own.length === 0) continue;
    const crew = crews.get(t.id)!;
    const cap = truckCapacity(t, day, rules.defaultTripCapacity);
    const active = own.filter((x) => x.status !== "failed");
    const counts = { customer: active.filter((x) => !x.isInternal).length, internal: active.filter((x) => x.isInternal).length, total: active.length };
    const schedule = schedules.find((s) => s.truckId === t.id) ?? null;
    capacity += cap;
    customer += counts.customer;
    internal += counts.internal;
    const cannot =
      !t.isActive || t.status !== "active"
        ? `Truk ${label("truck_status", t.status)}`
        : day?.status === "maintenance"
          ? `Perbaikan hari ini${day.reason ? `: ${day.reason}` : ""}`
          : !crew.driverEmployeeId
            ? "Tanpa sopir hari ini — tetapkan pengemudi di Jadwal kru"
            : null;
    const pos = lastPositions.find((p) => p.truckId === t.id);
    lanes.push({
      truck: { id: t.id, code: t.code, plateNumber: t.plateNumber, status: t.status, isActive: t.isActive, capacityL: t.capacityL },
      dayStatus: day?.status ?? "operating",
      dayReason: day?.reason ?? null,
      crew,
      schedule: schedule
        ? {
            id: schedule.id,
            status: schedule.status,
            version: schedule.version,
            publishedAt: schedule.publishedAt,
            pendingChanges: schedule.status === "published" && (!!schedule.lastChangedAt && (!schedule.publishedAt || schedule.lastChangedAt > schedule.publishedAt) || own.some((x) => isTripOpen(x) && !x.publishedAt)),
          }
        : null,
      trips: await Promise.all(own.map(view)),
      counts,
      volumeL: active.reduce((s, x) => s + x.plannedVolumeL, 0),
      capacityTrips: cap,
      capacityVolumeL: cap * t.capacityL,
      overCapacity: counts.total > cap,
      canReceive: !cannot,
      cannotReceiveReason: cannot,
      lastPosition: pos ? { lat: pos.lat, lng: pos.lng, at: pos.at, speedKmh: pos.speedKmh ?? null } : null,
    });
  }
  const unscheduledViews = await Promise.all(unscheduledRows.map(view));
  const unscheduledRanked = (await rankInputs(tx, unscheduledRows)).sort((a, b) => {
    const oa = a.trip.scheduledDate < date ? 0 : 1;
    const ob = b.trip.scheduledDate < date ? 0 : 1;
    return oa - ob || compareBr21(a.rank, b.rank);
  });
  const unscheduled = unscheduledRanked.map((r) => unscheduledViews.find((v) => v.id === r.trip.id)!);
  return {
    date,
    today,
    generatedAt: ctx.now,
    lanes,
    unscheduled,
    conflicts: await Promise.all(conflictRows.map(view)),
    totals: {
      capacity,
      customer,
      internal,
      scheduled: customer + internal,
      unscheduled: unscheduled.length,
      overdue: unscheduled.filter((u) => u.overdue).length,
      overCapacity: customer + internal > capacity,
    },
    canEdit: can(ctx, "m2.schedule.update"),
    canPublish: can(ctx, "m2.schedule.publish"),
  };
}

// =====================================================================================================================
// Tugaskan, tarik, urutkan
// =====================================================================================================================

async function assertLaneAccepts(tx: Tx, ctx: ActorContext, truck: TruckRow, date: string): Promise<DayCrew> {
  await assertTruckCanReceiveTrips(tx, truck.id);
  const day = (await tx.select().from(truckDayStatus).where(and(eq(truckDayStatus.truckId, truck.id), eq(truckDayStatus.businessDate, date))).limit(1))[0];
  if (day?.status === "maintenance") {
    throw new DomainError("TRUCK_MAINTENANCE_DAY", `Truk ${truck.code} berstatus Perbaikan pada ${formatTanggal(date, { weekday: false })}${day.reason ? ` (${day.reason})` : ""} dan tidak dapat menerima rit.`);
  }
  const crew = (await resolveDayCrews(tx, truck.tenantId, date, ctxBusinessDate(ctx), [truck.id])).get(truck.id)!;
  if (!crew.driverEmployeeId) {
    throw new DomainError("TRUCK_NO_DRIVER", `Truk ${truck.code} belum punya sopir pada ${formatTanggal(date, { weekday: false })}. Tetapkan pengemudi hari itu di Jadwal kru dulu.`);
  }
  return crew;
}

export type AssignResult = { trip: TripRow; warnings: string[] };

/**
 * Tugaskan rit ke truk & urutan (US-M2-03 KP-2..KP-5). Tanpa `position` → posisi usulan BR-21. Rit Berangkat tidak
 * dapat dipindah; truk Perbaikan/Nonaktif/tanpa sopir ditolak; kapasitas terlampaui hanya diperingatkan.
 */
export async function assignTrip(ctx: ActorContext, input: AssignTripInput, opts: { tx?: Tx } = {}): Promise<AssignResult> {
  await authorize(ctx, "m2.schedule.update", { tx: opts.tx, objectType: "trip", objectId: input.tripId });
  const data = parseInput(assignTripSchema, input, { tripId: "Rit", truckId: "Truk", date: "Tanggal", position: "Urutan" });
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const today = ctxBusinessDate(ctx);
    if (data.date < today) throw ValidationError.field("date", "Rit tidak dapat dijadwalkan ke tanggal yang sudah lewat.");
    const trip = await loadTrip(tx, ctx, data.tripId, { forUpdate: true });
    if (trip.status !== "assigned") {
      throw new ConflictError("TRIP_NOT_MOVABLE", `Rit ${trip.number} sudah ${label("trip_status", trip.status)} dan tidak dapat dipindahkan.`);
    }
    if (trip.withdrawnAt) throw new ConflictError("TRIP_WITHDRAWN", `Rit ${trip.number} sudah ditarik (pesanan dibatalkan).`);
    const order = await loadOrder(tx, ctx, trip.orderId);
    const blockers = await schedulingBlockers(tx, order);
    if (blockers.length) throw new DomainError(blockers[0]!.code.toUpperCase(), blockers.map((b) => b.message).join(" "));
    const truck = await loadTruck(tx, ctx, data.truckId);
    const crew = await assertLaneAccepts(tx, ctx, truck, data.date);
    const schedule = await ensureSchedule(tx, ctx, { tenantId: truck.tenantId, truckId: truck.id, date: data.date });

    const sameLane = trip.truckId === truck.id && trip.scheduledDate === data.date;
    const lane = (await laneTrips(tx, truck.id, data.date)).filter((t) => t.id !== trip.id);
    const fixed = lane.filter((t) => !isTripOpen(t));
    const open = lane.filter(isTripOpen);
    let index: number;
    if (data.position) {
      index = Math.min(Math.max(data.position - 1 - fixed.length, 0), open.length);
    } else if (sameLane) {
      index = open.findIndex((t) => (t.routeOrder ?? 0) > (trip.routeOrder ?? 0));
      if (index < 0) index = open.length;
    } else {
      const ranked = await rankInputs(tx, [...open, trip]);
      const mine = ranked.find((r) => r.trip.id === trip.id)!;
      index = open.findIndex((t) => compareBr21(mine.rank, ranked.find((r) => r.trip.id === t.id)!.rank) < 0);
      if (index < 0) index = open.length;
    }
    const wasPublished = isTripPublished(trip);
    const prevScheduleId = trip.scheduleId;
    const patch: Partial<typeof trips.$inferInsert> = {
      truckId: truck.id,
      scheduleId: schedule.id,
      scheduledDate: data.date,
      needsReassignment: false,
      driverEmployeeId: crew.driverEmployeeId,
      updatedAt: ctx.now,
    };
    if (!sameLane) patch.publishedAt = null;
    const [after] = await tx.update(trips).set(patch).where(eq(trips.id, trip.id)).returning();
    const ordered = [...fixed, ...open.slice(0, index), after!, ...open.slice(index)];
    await writeLaneOrder(tx, ctx, ordered, { log: { schedule, reason: data.reason } });

    if (!sameLane) {
      const changeType = trip.truckId ? (trip.truckId === truck.id ? "moved" : "truck_changed") : "added";
      const newPublished = !!schedule.publishedAt;
      await logScheduleChange(tx, ctx, {
        tenantId: trip.tenantId,
        scheduleId: schedule.id,
        tripId: trip.id,
        changeType,
        before: { truckId: trip.truckId, scheduledDate: trip.scheduledDate, routeOrder: trip.routeOrder },
        after: { truckId: truck.id, scheduledDate: data.date, routeOrder: index + fixed.length + 1 },
        reason: data.reason,
        afterPublish: newPublished || wasPublished,
      });
      if (prevScheduleId && prevScheduleId !== schedule.id) {
        await logScheduleChange(tx, ctx, {
          tenantId: trip.tenantId,
          scheduleId: prevScheduleId,
          tripId: trip.id,
          changeType: trip.truckId === truck.id ? "moved" : "truck_changed",
          before: { truckId: trip.truckId, scheduledDate: trip.scheduledDate },
          after: { truckId: truck.id, scheduledDate: data.date },
          reason: data.reason,
          afterPublish: wasPublished,
        });
      }
    }
    await auditRecord(tx, {
      ctx,
      objectType: "trip",
      objectId: trip.id,
      action: "assign",
      before: { truckId: trip.truckId, scheduledDate: trip.scheduledDate, routeOrder: trip.routeOrder },
      after: { truckId: truck.id, truckCode: truck.code, scheduledDate: data.date, routeOrder: index + fixed.length + 1 },
      reason: data.reason,
      rule: "US-M2-03",
    });
    await recomputeOrderStatus(tx, ctx, order.id, { reason: `Rit ${trip.number} ditugaskan ke ${truck.code}` });

    const warnings: string[] = [];
    const rules = await orderRules(tx, data.date);
    const day = (await tx.select().from(truckDayStatus).where(and(eq(truckDayStatus.truckId, truck.id), eq(truckDayStatus.businessDate, data.date))).limit(1))[0];
    const cap = truckCapacity(truck, day ?? null, rules.defaultTripCapacity);
    if (ordered.length > cap) warnings.push(`Truk ${truck.code} kini ${ordered.length} rit, melebihi kapasitas ${cap} rit/hari (PAR-33). Tetap disimpan.`);
    if (crew.lockMessage) warnings.push(`Rit akan tampil terkunci di aplikasi sopir: ${crew.lockMessage}`);
    const final = (await tx.select().from(trips).where(eq(trips.id, trip.id)).limit(1))[0]!;
    return { trip: final, warnings };
  });
}

/** Tarik rit dari jalur truk kembali ke "Belum terjadwal" (perubahan setelah terbit tercatat, KP-5). */
export async function unassignTrip(ctx: ActorContext, input: { tripId: string; reason?: string | null }, opts: { tx?: Tx } = {}): Promise<TripRow> {
  await authorize(ctx, "m2.schedule.update", { tx: opts.tx, objectType: "trip", objectId: input.tripId });
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const trip = await loadTrip(tx, ctx, input.tripId, { forUpdate: true });
    if (trip.status !== "assigned") throw new ConflictError("TRIP_NOT_MOVABLE", `Rit ${trip.number} sudah ${label("trip_status", trip.status)} dan tidak dapat ditarik.`);
    if (!trip.truckId) throw new ConflictError("TRIP_UNASSIGNED", `Rit ${trip.number} belum dijadwalkan.`);
    const published = isTripPublished(trip);
    const reason = input.reason?.trim() || null;
    if (published && (!reason || reason.length < 3)) throw ValidationError.field("reason", "Rit sudah terbit: alasan menarik rit wajib diisi (minimal 3 karakter).");
    const [after] = await tx
      .update(trips)
      .set({ truckId: null, scheduleId: null, routeOrder: null, publishedAt: null, updatedAt: ctx.now })
      .where(eq(trips.id, trip.id))
      .returning();
    if (trip.scheduleId) {
      await logScheduleChange(tx, ctx, {
        tenantId: trip.tenantId,
        scheduleId: trip.scheduleId,
        tripId: trip.id,
        changeType: "withdrawn",
        before: { truckId: trip.truckId, routeOrder: trip.routeOrder },
        after: { truckId: null },
        reason,
        afterPublish: published,
      });
    }
    const lane = await laneTrips(tx, trip.truckId, trip.scheduledDate);
    await writeLaneOrder(tx, ctx, lane);
    await auditRecord(tx, { ctx, objectType: "trip", objectId: trip.id, action: "unassign", before: { truckId: trip.truckId, routeOrder: trip.routeOrder }, after: { truckId: null }, reason, rule: "US-M2-03 KP-5" });
    await recomputeOrderStatus(tx, ctx, trip.orderId, { reason: `Rit ${trip.number} ditarik dari jadwal` });
    return after!;
  });
}

/** Urutkan rit jalur (seret-lepas atau tombol naik/turun). Rit yang sudah berjalan/selesai tetap di depan. */
export async function reorderTrips(ctx: ActorContext, input: ReorderInput, opts: { tx?: Tx } = {}): Promise<TripRow[]> {
  await authorize(ctx, "m2.schedule.update", { tx: opts.tx, objectType: "truck", objectId: input.truckId });
  const data = parseInput(reorderSchema, input);
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const truck = await loadTruck(tx, ctx, data.truckId);
    const lane = await laneTrips(tx, truck.id, data.date);
    const open = lane.filter(isTripOpen);
    const openIds = new Set(open.map((t) => t.id));
    const given = data.tripIds.filter((id) => openIds.has(id));
    if (given.length !== open.length || new Set(given).size !== open.length) {
      throw new ConflictError("LANE_CHANGED", "Susunan rit di truk ini sudah berubah. Muat ulang papan lalu ulangi.");
    }
    const schedule = await ensureSchedule(tx, ctx, { tenantId: truck.tenantId, truckId: truck.id, date: data.date });
    const ordered = [...lane.filter((t) => !isTripOpen(t)), ...given.map((id) => open.find((t) => t.id === id)!)];
    await writeLaneOrder(tx, ctx, ordered, { log: { schedule, reason: data.reason } });
    await auditRecord(tx, { ctx, objectType: "daily_schedule", objectId: schedule.id, action: "reorder", after: { order: ordered.map((t) => t.number) }, reason: data.reason, rule: "US-M2-03 KP-2" });
    return laneTrips(tx, truck.id, data.date);
  });
}

/** Geser satu rit naik/turun di jalurnya (alternatif tombol untuk ponsel). */
export async function moveTripInLane(ctx: ActorContext, input: { tripId: string; direction: "up" | "down" }, opts: { tx?: Tx } = {}): Promise<TripRow[]> {
  await authorize(ctx, "m2.schedule.update", { tx: opts.tx, objectType: "trip", objectId: input.tripId });
  const tx0 = opts.tx ?? getDb();
  const trip = await loadTrip(tx0, ctx, input.tripId);
  if (!trip.truckId) throw new ConflictError("TRIP_UNASSIGNED", `Rit ${trip.number} belum dijadwalkan.`);
  const open = (await laneTrips(tx0, trip.truckId, trip.scheduledDate)).filter(isTripOpen);
  const i = open.findIndex((t) => t.id === trip.id);
  if (i < 0) throw new ConflictError("TRIP_NOT_MOVABLE", `Rit ${trip.number} tidak dapat digeser.`);
  const j = input.direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= open.length) return open;
  const ids = open.map((t) => t.id);
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return reorderTrips(ctx, { truckId: trip.truckId, date: trip.scheduledDate, tripIds: ids }, opts);
}

/** Terapkan urutan usulan BR-21 pada rit terbuka jalur. */
export async function applySuggestedOrder(ctx: ActorContext, input: { truckId: string; date: string }, opts: { tx?: Tx } = {}): Promise<TripRow[]> {
  await authorize(ctx, "m2.schedule.update", { tx: opts.tx, objectType: "truck", objectId: input.truckId });
  const tx0 = opts.tx ?? getDb();
  const open = (await laneTrips(tx0, input.truckId, input.date)).filter(isTripOpen);
  if (open.length < 2) return open;
  const ranked = (await rankInputs(tx0, open)).sort((a, b) => compareBr21(a.rank, b.rank));
  return reorderTrips(ctx, { truckId: input.truckId, date: input.date, tripIds: ranked.map((r) => r.trip.id), reason: "Urutan usulan BR-21" }, opts);
}

// =====================================================================================================================
// Terbitkan
// =====================================================================================================================

export type PublishResult = { scheduleId: string; truckCode: string; revision: number; tripIds: string[]; warnings: string[] };

/**
 * Terbitkan jadwal truk ke aplikasi sopir (US-M2-03 KP-5): rit terbuka jalur menjadi Ditugaskan & terbit, event
 * `trip.published` (revisi 0 = terbit pertama; perubahan setelah terbit → revisi berikutnya). Ditolak bila ada rit
 * "harga sementara", menunggu persetujuan, konfirmasi ulang BR-24, kurang bayar kedua, atau pelanggan Ditahan.
 */
export async function publishSchedule(ctx: ActorContext, input: { truckId: string; date: string }, opts: { tx?: Tx } = {}): Promise<PublishResult> {
  await authorize(ctx, "m2.schedule.publish", { tx: opts.tx, objectType: "truck", objectId: input.truckId });
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const truck = await loadTruck(tx, ctx, input.truckId);
    const today = ctxBusinessDate(ctx);
    if (input.date < today) throw ValidationError.field("date", "Jadwal tanggal lewat tidak dapat diterbitkan.");
    const crew = await assertLaneAccepts(tx, ctx, truck, input.date);
    const schedule = (await tx.select().from(dailySchedules).where(and(eq(dailySchedules.truckId, truck.id), eq(dailySchedules.businessDate, input.date))).for("update").limit(1))[0];
    if (!schedule) throw new DomainError("NOTHING_TO_PUBLISH", `Belum ada rit di truk ${truck.code} untuk diterbitkan.`);
    const lane = await laneTrips(tx, truck.id, input.date);
    const open = lane.filter(isTripOpen);
    const pending = !!schedule.lastChangedAt && (!schedule.publishedAt || schedule.lastChangedAt > schedule.publishedAt);
    if (open.length === 0 && !pending) throw new DomainError("NOTHING_TO_PUBLISH", `Tidak ada rit atau perubahan di truk ${truck.code} untuk diterbitkan.`);
    if (open.length && open.every((t) => t.publishedAt) && !pending && schedule.status === "published") {
      throw new DomainError("NOTHING_TO_PUBLISH", `Jadwal truk ${truck.code} sudah terbit tanpa perubahan baru.`);
    }
    const problems: string[] = [];
    const orderCache = new Map<string, OrderRow>();
    for (const t of open) {
      const o = orderCache.get(t.orderId) ?? (await loadOrder(tx, null, t.orderId));
      orderCache.set(o.id, o);
      const blockers = await schedulingBlockers(tx, o, { forPublish: true, trip: t });
      // US-M2-05 KP-6 (PTB-18 "pesanan baru") / BR-24: penghalang per pelanggan yang muncul SETELAH rit terbit tidak
      // menahan penerbitan ulang seluruh jalur truk — hanya rit yang belum terbit yang dievaluasi.
      const relevant = t.publishedAt ? blockers.filter((b) => b.code !== "second_underpayment" && b.code !== "reconfirmation") : blockers;
      for (const b of relevant) problems.push(`Rit ${t.number}: ${b.message}`);
    }
    if (problems.length) throw new DomainError("PUBLISH_BLOCKED", `Jadwal truk ${truck.code} belum dapat diterbitkan. ${problems.join(" ")}`);
    const revision = schedule.publishedAt ? schedule.version + 1 : 0;
    if (open.length) {
      await tx
        .update(trips)
        .set({ publishedAt: ctx.now, driverEmployeeId: crew.driverEmployeeId, updatedAt: ctx.now })
        .where(inArray(trips.id, open.map((t) => t.id)));
    }
    await tx
      .update(dailySchedules)
      .set({ status: "published", version: revision, publishedAt: ctx.now, publishedBy: ctx.userId, updatedAt: ctx.now })
      .where(eq(dailySchedules.id, schedule.id));
    for (const orderId of orderCache.keys()) await recomputeOrderStatus(tx, ctx, orderId, { reason: `Jadwal ${truck.code} terbit` });
    await auditRecord(tx, {
      ctx,
      objectType: "daily_schedule",
      objectId: schedule.id,
      action: "publish",
      after: { truckCode: truck.code, businessDate: input.date, revision, trips: open.map((t) => t.number), driverEmployeeId: crew.driverEmployeeId },
      rule: "US-M2-03 KP-5",
      businessDate: input.date,
    });
    await emit(tx, "trip.published", { scheduleId: schedule.id, truckId: truck.id, tripIds: lane.filter((t) => !t.withdrawnAt).map((t) => t.id), revision }, { ctx, objectType: "daily_schedule", objectId: schedule.id, businessDate: input.date });
    const warnings: string[] = [];
    if (crew.lockMessage) warnings.push(`Rit tampil terkunci di aplikasi sopir: ${crew.lockMessage}`);
    return { scheduleId: schedule.id, truckCode: truck.code, revision, tripIds: open.map((t) => t.id), warnings };
  });
}

/** Terbitkan semua jalur yang punya rit/perubahan belum terbit (per truk; kegagalan satu truk tidak menahan yang lain). */
export async function publishAllSchedules(ctx: ActorContext, date: string): Promise<{ published: PublishResult[]; failed: { truckCode: string; message: string }[] }> {
  await authorize(ctx, "m2.schedule.publish");
  const board = await getBoard(ctx, date);
  const published: PublishResult[] = [];
  const failed: { truckCode: string; message: string }[] = [];
  for (const lane of board.lanes) {
    const hasOpen = lane.trips.some((t) => t.status === "assigned" && !t.published);
    if (!hasOpen && !lane.schedule?.pendingChanges) continue;
    try {
      published.push(await publishSchedule(ctx, { truckId: lane.truck.id, date }));
    } catch (error) {
      failed.push({ truckCode: lane.truck.code, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!published.length && !failed.length) throw new DomainError("NOTHING_TO_PUBLISH", "Tidak ada jadwal baru atau perubahan untuk diterbitkan.");
  return { published, failed };
}

/** Tandai konflik lapangan (rit ditarik tetapi dikerjakan offline) sudah ditindaklanjuti (Bab 6.4 KP-3). */
export async function resolveTripConflict(ctx: ActorContext, input: { tripId: string; note: string }, opts: { tx?: Tx } = {}): Promise<TripRow> {
  await authorize(ctx, "m2.schedule.update", { tx: opts.tx, objectType: "trip", objectId: input.tripId });
  const note = (input.note ?? "").trim();
  if (note.length < 3) throw ValidationError.field("note", "Tindak lanjut konflik wajib diisi (minimal 3 karakter).");
  return runService(ctx, opts, async (tx) => {
    const trip = await loadTrip(tx, ctx, input.tripId, { forUpdate: true });
    if (!trip.syncConflict || trip.syncConflictResolvedAt) throw new ConflictError("NO_CONFLICT", `Rit ${trip.number} tidak memiliki konflik terbuka.`);
    const [after] = await tx
      .update(trips)
      .set({ syncConflictResolvedAt: ctx.now, syncConflictResolvedBy: ctx.userId, updatedAt: ctx.now })
      .where(eq(trips.id, trip.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "trip", objectId: trip.id, action: "resolve_conflict", before: { syncConflictNote: trip.syncConflictNote }, after: { resolved: true }, reason: note, rule: "6.4" });
    return after!;
  });
}

/** Log perubahan jadwal truk pada tanggal (untuk rincian papan & ekspor). */
export async function scheduleChangeHistory(ctx: ActorContext, input: { date: string; truckId?: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m2.schedule.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ l: scheduleChangeLogs, tripNumber: trips.number, truckCode: trucks.code })
    .from(scheduleChangeLogs)
    .innerJoin(dailySchedules, eq(dailySchedules.id, scheduleChangeLogs.scheduleId))
    .innerJoin(trips, eq(trips.id, scheduleChangeLogs.tripId))
    .innerJoin(trucks, eq(trucks.id, dailySchedules.truckId))
    .where(and(eq(dailySchedules.tenantId, ctx.tenantId), eq(dailySchedules.businessDate, input.date), input.truckId ? eq(dailySchedules.truckId, input.truckId) : sql`true`))
    .orderBy(desc(scheduleChangeLogs.changedAt));
  const names = await userNames(tx, rows.map((r) => r.l.changedBy));
  return rows.map((r) => ({ ...r.l, tripNumber: r.tripNumber, truckCode: r.truckCode, changedByName: r.l.changedBy ? (names.get(r.l.changedBy) ?? null) : null }));
}
