/**
 * M2 — siklus status pesanan (Bab 5.2, US-M2-02 KP-2) dan reaksi terhadap event rit dari M3 (US-M2-09, PTB-27).
 *
 * Status pesanan dihitung dari rit-ritnya (rit Gagal tidak dihitung — diganti rit pengganti):
 * - semua rit aktif Selesai → Selesai (terkunci);
 * - ada rit Berangkat/Tiba → Dalam pengiriman;
 * - ada rit belum bertruk/belum terbit → Baru (termasuk setelah rit gagal: "perlu jadwal ulang");
 * - sebagian Selesai dan sisanya terbit → Dalam pengiriman;
 * - semua rit bertruk & terbit → Terjadwal.
 * "Menunggu persetujuan" dan "Dibatalkan" hanya diubah oleh alurnya sendiri. Setiap transisi berjejak (waktu, pelaku).
 */
import "server-only";

import { and, desc, eq, inArray, isNotNull, isNull, max, ne, or, sql } from "drizzle-orm";

import { approvalRequests, customers, orders, tripIncidents, trips } from "@/db/schema";
import { label, type OrderStatus } from "@/lib/labels";
import { toBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { tripNumber } from "@/server/core/numbering";

import { ACTIVE_ORDER_STATUSES, isTripPublished, loadOrder, orderRules, orderTrips, type OrderRow, type TripRow } from "./common";
import { underpaymentStatus } from "./credit";

// =====================================================================================================================
// Hitung ulang status
// =====================================================================================================================

/** Status turunan dari rit (tanpa Menunggu persetujuan/Dibatalkan). */
export function deriveOrderStatus(tripRows: Pick<TripRow, "status" | "truckId" | "publishedAt" | "withdrawnAt">[]): OrderStatus {
  const active = tripRows.filter((t) => t.status !== "failed" && !(t.withdrawnAt && t.status === "assigned"));
  if (active.length === 0) return "new";
  if (active.every((t) => t.status === "completed")) return "completed";
  if (active.some((t) => t.status === "departed" || t.status === "arrived")) return "in_delivery";
  if (active.some((t) => t.status === "assigned" && !isTripPublished(t))) return "new";
  if (active.some((t) => t.status === "completed")) return "in_delivery";
  return "scheduled";
}

/**
 * Hitung ulang & simpan status pesanan (+ waktu terjadwal/berangkat/selesai), catat transisi di jejak audit. Pesanan
 * Dibatalkan tidak diubah; Menunggu persetujuan hanya berubah lewat keputusan (kecuali rit sudah jalan).
 */
export async function recomputeOrderStatus(
  tx: Tx,
  ctx: ActorContext,
  orderId: string,
  opts: { reason?: string | null; rule?: string | null } = {},
): Promise<{ order: OrderRow; changed: boolean }> {
  const order = await loadOrder(tx, null, orderId, { forUpdate: true });
  if (order.status === "cancelled") return { order, changed: false };
  const tripRows = await orderTrips(tx, orderId);
  let next = deriveOrderStatus(tripRows);
  if (order.status === "awaiting_approval" && (next === "new" || next === "scheduled")) next = "awaiting_approval";
  const patch: Partial<typeof orders.$inferInsert> = {};
  if (next !== order.status) patch.status = next;
  if (next === "scheduled" && !order.scheduledAt) patch.scheduledAt = ctx.now;
  const departed = tripRows.filter((t) => t.departedAt).map((t) => t.departedAt!.getTime());
  if (departed.length && !order.firstDepartedAt) patch.firstDepartedAt = new Date(Math.min(...departed));
  if (next === "completed" && !order.completedAt) {
    const done = tripRows.filter((t) => t.completedAt).map((t) => t.completedAt!.getTime());
    patch.completedAt = done.length ? new Date(Math.max(...done)) : ctx.now;
    patch.needsReschedule = false;
  }
  if (Object.keys(patch).length === 0) return { order, changed: false };
  const [after] = await tx.update(orders).set({ ...patch, updatedAt: ctx.now }).where(eq(orders.id, orderId)).returning();
  if (patch.status) {
    await auditRecord(tx, {
      ctx,
      objectType: "order",
      objectId: orderId,
      action: "status",
      before: { status: order.status },
      after: { status: next },
      reason: opts.reason ?? `Status ${label("order_status", order.status)} → ${label("order_status", next)}`,
      rule: opts.rule ?? "5.2",
    });
    if (next === "completed") await clearDuplicateFlags(tx, ctx, after!);
  }
  return { order: after!, changed: !!patch.status };
}

/**
 * US-M2-04 KP-2: penanda "kemungkinan dobel" bertahan sampai salah satu pesanan (yang ditandai atau yang
 * diduplikasi) Selesai/Dibatalkan.
 */
export async function clearDuplicateFlags(tx: Tx, ctx: ActorContext, order: Pick<OrderRow, "id" | "duplicateOfOrderId" | "possibleDuplicate">): Promise<void> {
  const ids = new Set<string>();
  if (order.possibleDuplicate) ids.add(order.id);
  const linked = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.duplicateOfOrderId, order.id), eq(orders.possibleDuplicate, true)));
  for (const r of linked) ids.add(r.id);
  if (order.duplicateOfOrderId && order.possibleDuplicate) ids.add(order.id);
  if (ids.size === 0) return;
  await tx.update(orders).set({ possibleDuplicate: false, updatedAt: ctx.now }).where(inArray(orders.id, [...ids]));
  for (const id of ids) {
    await auditRecord(tx, {
      ctx,
      objectType: "order",
      objectId: id,
      action: "update",
      before: { possibleDuplicate: true },
      after: { possibleDuplicate: false },
      reason: "Salah satu pesanan dobel sudah Selesai/Dibatalkan",
      rule: "US-M2-04 KP-2",
    });
  }
}

// =====================================================================================================================
// Penghalang penjadwalan
// =====================================================================================================================

export type SchedulingBlocker = {
  code: "awaiting_approval" | "locked" | "credit_rejected" | "reconfirmation" | "second_underpayment" | "provisional_price" | "credit_hold";
  message: string;
};

/**
 * Penghalang menjadwalkan/menerbitkan rit pesanan: menunggu persetujuan (US-M2-05 KP-3), tempo ditolak, konfirmasi
 * ulang BR-24, kurang bayar kedua PTB-18; saat terbit juga harga sementara (7.1.6) dan pelanggan Ditahan (PTB-27).
 */
export async function schedulingBlockers(
  tx: Tx,
  order: OrderRow,
  opts: { forPublish?: boolean; trip?: TripRow | null } = {},
): Promise<SchedulingBlocker[]> {
  const out: SchedulingBlocker[] = [];
  if (order.status === "cancelled" || order.status === "completed") {
    out.push({ code: "locked", message: `Pesanan ${order.number} sudah ${label("order_status", order.status)}.` });
    return out;
  }
  if (order.status === "awaiting_approval") {
    out.push({
      code: "awaiting_approval",
      message: `Pesanan ${order.number} menunggu persetujuan pemilik; tidak dapat dijadwalkan sampai disetujui (atau ubah cara bayar ke tunai).`,
    });
  }
  const approvalIds = [order.creditApprovalRequestId, order.underpaymentApprovalRequestId].filter((x): x is string => !!x);
  const approvals = approvalIds.length
    ? await tx.select({ id: approvalRequests.id, status: approvalRequests.status }).from(approvalRequests).where(inArray(approvalRequests.id, approvalIds))
    : [];
  const statusOf = (id: string | null) => (id ? (approvals.find((a) => a.id === id)?.status ?? null) : null);
  const creditDecision = statusOf(order.creditApprovalRequestId);
  if (order.paymentMethod === "credit" && order.status !== "awaiting_approval" && (creditDecision === "rejected" || creditDecision === "cancelled")) {
    out.push({ code: "credit_rejected", message: `Tempo pesanan ${order.number} tidak disetujui pemilik. Ubah cara bayar ke tunai atau batalkan pesanan.` });
  }
  if (order.reconfirmationRequired && !order.reconfirmedAt) {
    out.push({
      code: "reconfirmation",
      message: `Pelanggan pesanan ${order.number} mengalami rit gagal berturut (BR-24). Centang "sudah dikonfirmasi ulang" (waktu & cara) sebelum dijadwalkan.`,
    });
  }
  if (order.status !== "awaiting_approval" && statusOf(order.underpaymentApprovalRequestId) !== "approved") {
    const up = await underpaymentStatus(tx, order.customerId);
    if (up.secondUnpaid) {
      out.push({
        code: "second_underpayment",
        message: `Pelanggan pesanan ${order.number} punya ${up.openCount} faktur kurang bayar belum lunas (PTB-18). Pesanan hanya dapat dijadwalkan setelah lunas atau disetujui pemilik.`,
      });
    }
  }
  if (opts.forPublish) {
    if (order.priceIsProvisional) {
      out.push({
        code: "provisional_price",
        message: `Pesanan ${order.number} berharga sementara (alamat belum berzona). Tetapkan zona alamat di Data master lalu perbarui harga sebelum terbit.`,
      });
    }
    if (opts.trip?.creditHoldFlaggedAt && !opts.trip.creditHoldResolution) {
      out.push({
        code: "credit_hold",
        message: `Rit ${opts.trip.number}: pelanggan Ditahan (PTB-27). Ubah cara bayar pesanan ke tunai atau tarik rit dari jadwal.`,
      });
    }
  }
  return out;
}

// =====================================================================================================================
// Rit gagal berturut (BR-24)
// =====================================================================================================================

/** Jumlah rit gagal berturut terakhir pelanggan (urut waktu selesai/gagal, terbaru dulu). */
export async function consecutiveFailures(tx: Tx, customerId: string): Promise<{ count: number; lastFailedAt: Date | null }> {
  const rows = await tx
    .select({ status: trips.status, failedAt: trips.failedAt, completedAt: trips.completedAt })
    .from(trips)
    .where(and(eq(trips.customerId, customerId), inArray(trips.status, ["completed", "failed"])))
    .orderBy(desc(sql`coalesce(${trips.failedAt}, ${trips.completedAt}, ${trips.updatedAt})`))
    .limit(50);
  let count = 0;
  let lastFailedAt: Date | null = null;
  for (const r of rows) {
    if (r.status !== "failed") break;
    count++;
    if (!lastFailedAt && r.failedAt) lastFailedAt = r.failedAt;
  }
  return { count, lastFailedAt };
}

/** Konteks pelaku untuk transisi yang dipicu event lapangan: "Sistem, dari sopir" (Bab 5.2). */
export function eventActorContext(event: Pick<DomainEvent, "tenantId" | "occurredAt" | "actorUserId" | "source" | "businessDate">): ActorContext {
  const base = systemContext({ tenantId: event.tenantId ?? undefined, now: event.occurredAt, businessDate: event.businessDate ?? undefined });
  if (!event.actorUserId) return base;
  return { ...base, userId: event.actorUserId, source: event.source ?? "field" };
}

/** Konflik lapangan vs kantor (Bab 6.4 KP-3): rit ditarik/dipindah tetapi dikerjakan offline — tetap sah, ditandai. */
async function flagConflictIfWithdrawn(tx: Tx, ctx: ActorContext, trip: TripRow, orderStatus: OrderStatus, eventTruckId: string | null): Promise<boolean> {
  const reasons: string[] = [];
  if (trip.withdrawnAt || (eventTruckId && !trip.truckId)) reasons.push("rit sudah ditarik dari jadwal oleh kantor");
  if (orderStatus === "cancelled") reasons.push("pesanan sudah dibatalkan kantor");
  if (eventTruckId && trip.truckId && eventTruckId !== trip.truckId) reasons.push("rit sudah dipindah ke truk lain");
  if (reasons.length === 0 || trip.syncConflict) return false;
  const note = `Dikerjakan di lapangan walau ${reasons.join(" dan ")} — tetap sah (Bab 6.4); tindak lanjuti.`;
  // Lapangan tidak ditimpa kantor: rit yang ditarik tetapi dikerjakan truk X dicatat atas truk pelaksananya.
  const patch: Partial<typeof trips.$inferInsert> = { syncConflict: true, syncConflictNote: note, updatedAt: ctx.now };
  if (eventTruckId && !trip.truckId) patch.truckId = eventTruckId;
  await tx.update(trips).set(patch).where(eq(trips.id, trip.id));
  await auditRecord(tx, { ctx, objectType: "trip", objectId: trip.id, action: "conflict", after: { syncConflict: true }, reason: note, rule: "6.4" });
  return true;
}

// =====================================================================================================================
// Handler event M3
// =====================================================================================================================

/** `trip.departed` → pesanan Dalam pengiriman (rit pertama Berangkat). */
export async function onTripDeparted(tx: Tx, event: DomainEvent<"trip.departed">): Promise<void> {
  const ctx = eventActorContext(event);
  const tripRows = await tx.select().from(trips).where(eq(trips.id, event.payload.tripId)).limit(1);
  const trip = tripRows[0];
  if (!trip) return;
  const order = await loadOrder(tx, null, trip.orderId);
  await flagConflictIfWithdrawn(tx, ctx, trip, order.status, event.payload.truckId);
  await recomputeOrderStatus(tx, ctx, trip.orderId, { reason: `Rit ${trip.number} Berangkat`, rule: "5.2" });
}

/** `trip.completed` → Selesai bila semua rit Selesai; penanda dobel dilepas. */
export async function onTripCompleted(tx: Tx, event: DomainEvent<"trip.completed">): Promise<void> {
  const ctx = eventActorContext(event);
  const tripRows = await tx.select().from(trips).where(eq(trips.id, event.payload.tripId)).limit(1);
  const trip = tripRows[0];
  if (!trip) return;
  const order = await loadOrder(tx, null, trip.orderId);
  await flagConflictIfWithdrawn(tx, ctx, trip, order.status, event.payload.truckId);
  await recomputeOrderStatus(tx, ctx, trip.orderId, { reason: `Rit ${trip.number} Selesai`, rule: "5.2" });
}

/**
 * `trip.failed` (US-M2-09 KP-2/KP-3): kejadian rit gagal (bila M3 belum mencatatnya), rit pengganti di kolom "Belum
 * terjadwal", pesanan kembali Baru + "perlu jadwal ulang"; gagal berturut ≥ PAR-17 → semua pesanan berjalan pelanggan
 * wajib "sudah dikonfirmasi ulang" (BR-24); notifikasi Dispatcher (6.3). Idempoten per rit.
 */
export async function onTripFailed(tx: Tx, event: DomainEvent<"trip.failed">): Promise<void> {
  const ctx = eventActorContext(event);
  const tripRows = await tx.select().from(trips).where(eq(trips.id, event.payload.tripId)).for("update").limit(1);
  const trip = tripRows[0];
  if (!trip) return;
  const order = await loadOrder(tx, null, trip.orderId, { forUpdate: true });
  const tenantId = trip.tenantId;
  const failedAt = trip.failedAt ?? event.occurredAt;

  // Kejadian rit gagal (alasan, waktu, lokasi; foto dicatat M3 pada lampiran rit).
  const incident = await tx
    .select({ id: tripIncidents.id })
    .from(tripIncidents)
    .where(and(eq(tripIncidents.tripId, trip.id), eq(tripIncidents.kind, "trip_failed")))
    .limit(1);
  if (!incident[0]) {
    const [row] = await tx
      .insert(tripIncidents)
      .values({
        tenantId,
        tripId: trip.id,
        truckId: trip.truckId ?? event.payload.truckId,
        kind: "trip_failed",
        description: `${label("trip_fail_reason", trip.failReason ?? event.payload.reason)}${trip.failNote ? ` — ${trip.failNote}` : ""}`,
        occurredAt: failedAt,
        lat: trip.failLat,
        lng: trip.failLng,
        reportedByUserId: event.actorUserId ?? trip.driverUserId,
        businessDate: event.businessDate ?? toBusinessDate(failedAt),
      })
      .returning({ id: tripIncidents.id });
    await auditRecord(tx, { ctx, objectType: "trip_incident", objectId: row!.id, action: "create", after: { tripId: trip.id, kind: "trip_failed" }, rule: "US-M2-09 KP-2" });
  }

  // Rit pengganti — kembali ke kolom "Belum terjadwal". Idempoten: rit aktif (bukan Gagal/ditarik) tidak pernah
  // melebihi jumlah tangki pesanan.
  let replacementNumber: string | null = null;
  if (order.status !== "cancelled") {
    const all = await orderTrips(tx, order.id);
    const activeCount = all.filter((t) => t.status !== "failed" && !t.withdrawnAt).length;
    if (activeCount < order.tankCount) {
      const [seq] = await tx.select({ max: max(trips.sequenceInOrder) }).from(trips).where(eq(trips.orderId, order.id));
      const next = Number(seq?.max ?? 0) + 1;
      replacementNumber = tripNumber(order.number, next);
      const [created] = await tx
        .insert(trips)
        .values({
          tenantId,
          orderId: order.id,
          number: replacementNumber,
          sequenceInOrder: next,
          status: "assigned",
          customerId: trip.customerId,
          addressId: trip.addressId,
          isInternal: trip.isInternal,
          destinationOutletId: trip.destinationOutletId,
          scheduledDate: trip.scheduledDate,
          price: trip.price,
          paymentMethod: trip.paymentMethod,
          plannedVolumeL: trip.plannedVolumeL,
          createdBy: null,
        })
        .returning({ id: trips.id });
      await auditRecord(tx, {
        ctx,
        objectType: "trip",
        objectId: created!.id,
        action: "create",
        after: { number: replacementNumber, replacesTripId: trip.id, replaces: trip.number },
        reason: `Pengganti rit gagal ${trip.number}`,
        rule: "US-M2-09 KP-2",
      });
    } else {
      replacementNumber = all.find((t) => t.status === "assigned" && !t.withdrawnAt && !t.truckId)?.number ?? null;
    }
    await tx.update(orders).set({ needsReschedule: true, updatedAt: ctx.now }).where(eq(orders.id, order.id));
  }

  // BR-24: gagal berturut → konfirmasi ulang wajib untuk pesanan berikutnya pelanggan.
  const rules = await orderRules(tx, event.businessDate ?? toBusinessDate(failedAt));
  const streak = await consecutiveFailures(tx, trip.customerId);
  const consecutive = Math.max(streak.count, event.payload.consecutiveFailures ?? 0);
  const needReconfirm = consecutive >= rules.consecutiveFailLimit;
  if (needReconfirm) {
    const affected = await tx
      .update(orders)
      .set({ reconfirmationRequired: true, reconfirmedAt: null, reconfirmedBy: null, reconfirmationMethod: null, updatedAt: ctx.now })
      .where(and(eq(orders.customerId, trip.customerId), inArray(orders.status, ["new", "awaiting_approval", "scheduled"])))
      .returning({ id: orders.id });
    // Pesanan yang sedang dalam pengiriman karena rit ini (kini kembali Baru) juga ditandai.
    await tx
      .update(orders)
      .set({ reconfirmationRequired: true, reconfirmedAt: null, reconfirmedBy: null, reconfirmationMethod: null, updatedAt: ctx.now })
      .where(eq(orders.id, order.id));
    const ids = new Set([...affected.map((a) => a.id), order.id]);
    for (const id of ids) {
      await auditRecord(tx, {
        ctx,
        objectType: "order",
        objectId: id,
        action: "update",
        after: { reconfirmationRequired: true },
        reason: `${consecutive} rit gagal berturut untuk pelanggan ini — wajib konfirmasi ulang sebelum dijadwalkan`,
        rule: "BR-24",
      });
    }
  }

  await recomputeOrderStatus(tx, ctx, order.id, { reason: `Rit ${trip.number} Gagal — perlu jadwal ulang`, rule: "US-M2-09 KP-2" });

  const customerRows = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, trip.customerId)).limit(1);
  await notify(tx, {
    event: "trip.failed",
    tenantId,
    severity: needReconfirm ? "high" : undefined,
    title: needReconfirm ? `${consecutive} rit gagal berturut: ${customerRows[0]?.name ?? "pelanggan"}` : `Rit gagal: ${trip.number}`,
    body: `${label("trip_fail_reason", trip.failReason ?? event.payload.reason)}${trip.failNote ? ` — ${trip.failNote}` : ""}. ${
      replacementNumber ? `Rit pengganti ${replacementNumber} ada di kolom Belum terjadwal.` : ""
    }${needReconfirm ? " Konfirmasi ulang pelanggan (waktu & cara) sebelum dijadwalkan (BR-24)." : ""}`.trim(),
    objectType: "order",
    objectId: order.id,
    link: `/pesanan/${order.id}`,
    groupKey: `trip.failed:${trip.id}`,
    now: ctx.now,
  });
}

/**
 * `credit_status.changed` ke Ditahan (US-M5-03 KP-2, PTB-27): rit tempo yang belum Berangkat ditandai di papan agar
 * Dispatcher mengubahnya ke tunai atau menariknya; kembali Tempo → tanda dilepas.
 */
export async function onCreditStatusChanged(tx: Tx, event: DomainEvent<"credit_status.changed">): Promise<void> {
  const ctx = eventActorContext(event);
  const { customerId, to } = event.payload;
  if (to === "on_hold") {
    const flagged = await tx
      .update(trips)
      .set({ creditHoldFlaggedAt: ctx.now, creditHoldResolution: null, updatedAt: ctx.now })
      .where(
        and(
          eq(trips.customerId, customerId),
          eq(trips.paymentMethod, "credit"),
          eq(trips.status, "assigned"),
          isNull(trips.withdrawnAt),
          or(isNull(trips.creditHoldFlaggedAt), isNotNull(trips.creditHoldResolution)),
        ),
      )
      .returning({ id: trips.id, number: trips.number, orderId: trips.orderId });
    if (flagged.length === 0) return;
    for (const t of flagged) {
      await auditRecord(tx, { ctx, objectType: "trip", objectId: t.id, action: "flag", after: { creditHoldFlaggedAt: ctx.now }, reason: "Pelanggan Ditahan", rule: "PTB-27" });
    }
    const cust = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, customerId)).limit(1);
    await notify(tx, {
      event: "order.credit_hold_trips",
      tenantId: event.tenantId ?? ctx.tenantId,
      title: `Pelanggan Ditahan: ${flagged.length} rit tempo belum berangkat`,
      body: `${cust[0]?.name ?? "Pelanggan"} — ${flagged.map((t) => t.number).join(", ")}. Ubah ke tunai atau tarik dari jadwal.`,
      objectType: "customer",
      objectId: customerId,
      link: `/pesanan?pelanggan=${customerId}`,
      now: ctx.now,
    });
    return;
  }
  if (event.payload.from === "on_hold") {
    const released = await tx
      .update(trips)
      .set({ creditHoldResolution: "released", updatedAt: ctx.now })
      .where(and(eq(trips.customerId, customerId), isNotNull(trips.creditHoldFlaggedAt), isNull(trips.creditHoldResolution)))
      .returning({ id: trips.id });
    for (const t of released) {
      await auditRecord(tx, { ctx, objectType: "trip", objectId: t.id, action: "update", after: { creditHoldResolution: "released" }, reason: "Status kredit kembali Tempo", rule: "PTB-27" });
    }
  }
}

/** Pesanan aktif pelanggan yang harus dikonfirmasi ulang saat dibuat (BR-24). */
export async function reconfirmationNeededFor(tx: Tx, customerId: string, date: string): Promise<boolean> {
  const rules = await orderRules(tx, date);
  const streak = await consecutiveFailures(tx, customerId);
  return streak.count >= rules.consecutiveFailLimit;
}

/** Pesanan berjalan lain dengan pelanggan + alamat + tanggal yang sama (FR-M2-04). */
export async function findDuplicateOrders(
  tx: Tx,
  input: { customerId: string; addressId: string; requestedDate: string; excludeOrderId?: string | null },
): Promise<OrderRow[]> {
  const conds = [
    eq(orders.customerId, input.customerId),
    eq(orders.addressId, input.addressId),
    eq(orders.requestedDate, input.requestedDate),
    inArray(orders.status, [...ACTIVE_ORDER_STATUSES]),
  ];
  if (input.excludeOrderId) conds.push(ne(orders.id, input.excludeOrderId));
  return tx.select().from(orders).where(and(...conds)).orderBy(orders.createdAt);
}
