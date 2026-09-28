/**
 * M8 — pengisian truk per rit (US-M8-02; PTB-09, BR-38, 7.8.6) dan pasokan depot (US-M8-03 KP-1: rit internal).
 *
 * Operator (lapangan, offline): truk dari daftar truk yang dijadwalkan mengisi di sumber ini hari itu (truk lain dengan
 * konfirmasi → Dispatcher diberi tahu), volume (bawaan PAR-15; berbeda → alasan, mis. "sisa muatan"), waktu perangkat,
 * rit tujuan yang disarankan (rit berikutnya truk itu yang belum Berangkat), foto opsional. Satu pengisian ↔ satu rit;
 * tanpa rit → "pengisian tanpa rit" + notifikasi Dispatcher & pemilik; rit internal → ditandai pasokan depot.
 * Rit yang sudah berpengisian / ditarik / dipindah kantor saat data tiba → pengisian TETAP dicatat (tanpa rit) dan
 * ditandai konflik (Bab 6.4 butir 3: lapangan tidak ditimpa kantor), Admin Keuangan dapat menautkannya.
 * Pengisian tersimpan tidak dapat diubah operator; koreksi Admin Keuangan lewat pembalik (volume negatif, BR-38).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { z } from "zod";

import { customers, devices, employees, fleetEvents, outlets, trips, truckFills, trucks, users, waterSources } from "@/db/schema";
import type { BusinessDate } from "@/lib/time";

import { M8_ATTACHMENT_KINDS, volumeNeedsReason } from "@/client/m8-production/contract";

import { record as auditRecord } from "@/server/core/audit";
import { systemContext, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit, type DomainEvent } from "@/server/core/events";
import { assertSourceScope, authorize, runService, sod } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { attachmentOfKind, liter, m8Rules, notifyOnce, plannedSourceByAddress, resolveOperatorSource, type M8FieldMeta } from "./common";
import { refreshSourceDay } from "./balance";
import { evaluateSupply } from "./supply";

export type TruckFillRow = typeof truckFills.$inferSelect;
export type TripRow = typeof trips.$inferSelect;

export const truckFillSchema = z
  .object({
    fillId: z.uuid({ error: "ID pengisian tidak valid." }),
    truckId: z.uuid({ error: "Pilih truk." }),
    tripId: z.uuid().nullable().optional(),
    volumeL: z.number({ error: "Volume wajib diisi." }).int({ error: "Volume harus liter bulat." }).min(1, { error: "Volume minimal 1 L." }).max(50_000),
    volumeReason: z.string().trim().max(300).nullable().optional(),
    unplannedConfirmed: z.boolean().optional(),
  })
  .strict();

// =====================================================================================================================
// Truk yang dijadwalkan mengisi di sumber (papan jadwal M2)
// =====================================================================================================================

export type SourceTruckPlan = {
  truckId: string;
  planned: boolean;
  plannedSourceId: string | null;
  nextTripId: string | null;
  trips: (TripRow & { customerName: string; destinationName: string | null; filled: boolean })[];
};

/**
 * Rencana pengisian hari itu per truk: rit TERBIT (tidak ditarik) urut rencana; rit berikutnya = rit pertama yang belum
 * Berangkat dan belum diisi; truk "dijadwalkan di sumber ini" bila sumber rencana alamat rit berikutnya = sumber ini.
 */
export async function truckPlansForDay(tx: Tx, tenantId: string, sourceId: string, date: BusinessDate): Promise<Map<string, SourceTruckPlan>> {
  const rows = await tx
    .select({ trip: trips, customerName: customers.name, destinationName: outlets.name })
    .from(trips)
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .leftJoin(outlets, eq(outlets.id, trips.destinationOutletId))
    .where(and(eq(trips.tenantId, tenantId), eq(trips.scheduledDate, date), isNotNull(trips.truckId), isNull(trips.withdrawnAt), isNotNull(trips.publishedAt)))
    .orderBy(asc(trips.routeOrder), asc(trips.number));
  const tripIds = rows.map((r) => r.trip.id);
  const filled = new Set(
    tripIds.length
      ? (
          await tx
            .select({ tripId: truckFills.tripId })
            .from(truckFills)
            .where(and(inArray(truckFills.tripId, tripIds), isNull(truckFills.reversalOfId), isNull(truckFills.reversedAt)))
        ).map((r) => r.tripId!)
      : [],
  );
  const plannedSource = await plannedSourceByAddress(
    tx,
    tenantId,
    rows.map((r) => r.trip.addressId),
  );
  const out = new Map<string, SourceTruckPlan>();
  for (const r of rows) {
    const truckId = r.trip.truckId!;
    const plan = out.get(truckId) ?? { truckId, planned: false, plannedSourceId: null, nextTripId: null, trips: [] };
    plan.trips.push({ ...r.trip, customerName: r.customerName, destinationName: r.destinationName, filled: filled.has(r.trip.id) });
    out.set(truckId, plan);
  }
  for (const plan of out.values()) {
    const next = plan.trips.find((t) => t.status === "assigned" && !t.filled);
    plan.nextTripId = next?.id ?? null;
    plan.plannedSourceId = next ? (plannedSource.get(next.addressId) ?? null) : null;
    plan.planned = !!next && plan.plannedSourceId === sourceId;
  }
  return out;
}

// =====================================================================================================================
// Catat pengisian (lapangan)
// =====================================================================================================================

export type RecordFillResult = { fill: TruckFillRow; duplicate: boolean; conflict: string | null };

/** Handler perintah `m8.truck_fill.create` (US-M8-02 KP-1/KP-2/KP-3/KP-5/KP-6, US-M8-03 KP-1). Idempoten per `fillId`. */
export async function recordTruckFill(ctx: ActorContext, input: z.output<typeof truckFillSchema>, meta: M8FieldMeta): Promise<RecordFillResult> {
  const { tx } = meta;
  await authorize(ctx, "m8.truck_fill.create", { tx, objectType: "truck", objectId: input.truckId });
  const source = await resolveOperatorSource(tx, ctx, meta.device);
  const date = meta.businessDate;

  const [same] = await tx.select().from(truckFills).where(eq(truckFills.id, input.fillId)).limit(1);
  if (same) {
    if (same.truckId === input.truckId && same.volumeL === input.volumeL && same.businessDate === date && (same.tripId ?? same.requestedTripId ?? null) === (input.tripId ?? null)) {
      return { fill: same, duplicate: true, conflict: same.syncConflictNote };
    }
    // US-M8-02 KP-6: pengisian tersimpan tidak dapat diubah operator (SOD-05).
    sod.assertNotLocked(true, { what: "Pengisian truk", objectType: "truck_fill", objectId: same.id });
  }

  const [truck] = await tx.select().from(trucks).where(eq(trucks.id, input.truckId)).limit(1);
  if (!truck || truck.tenantId !== source.tenantId) throw new NotFoundError("Truk tidak ditemukan.");
  if (input.volumeL > truck.capacityL) {
    throw new DomainError("FILL_OVER_CAPACITY", `Volume ${liter(input.volumeL)} melebihi kapasitas tangki truk ${truck.code} (${liter(truck.capacityL)}). Periksa angka volume.`);
  }
  const rules = await m8Rules(tx, date, source.tenantId);
  const volumeReason = input.volumeReason?.trim() || null;
  if (volumeNeedsReason(input.volumeL, rules.standardVolumeL) && (!volumeReason || volumeReason.length < 3)) {
    throw new DomainError("FILL_VOLUME_REASON_REQUIRED", `Volume berbeda dari ${liter(rules.standardVolumeL)} — pilih/isi alasannya (mis. sisa muatan).`);
  }
  const photo = attachmentOfKind(meta, M8_ATTACHMENT_KINDS.fillPhoto);

  const plans = await truckPlansForDay(tx, source.tenantId, source.id, date);
  const plan = plans.get(truck.id);
  const unplanned = !plan?.planned;

  // Rit tujuan: tautkan bila sah; bila bertabrakan (sudah diisi / ditarik / dipindah / selesai) → tanpa rit + konflik.
  let tripId: string | null = null;
  let trip: TripRow | null = null;
  let conflict: string | null = null;
  const requestedTripId = input.tripId ?? null;
  if (requestedTripId) {
    const [t] = await tx.select().from(trips).where(eq(trips.id, requestedTripId)).for("update").limit(1);
    if (!t || t.tenantId !== source.tenantId) throw new NotFoundError("Rit tujuan tidak ditemukan. Pilih rit dari daftar atau catat tanpa rit.");
    const [existing] = await tx
      .select({ id: truckFills.id })
      .from(truckFills)
      .where(and(eq(truckFills.tripId, t.id), isNull(truckFills.reversalOfId), isNull(truckFills.reversedAt)))
      .limit(1);
    if (existing) conflict = `Rit ${t.number} sudah punya pengisian lain; pengisian ini dicatat tanpa rit untuk diperiksa Admin Keuangan (satu pengisian satu rit, PTB-09).`;
    else if (t.withdrawnAt || t.truckId !== truck.id) conflict = `Rit ${t.number} sudah ditarik/dipindah kantor dari truk ${truck.code}; pengisian dicatat tanpa rit — Dispatcher/Admin Keuangan menautkannya.`;
    else if (t.status === "completed" || t.status === "failed") conflict = `Rit ${t.number} sudah ${t.status === "completed" ? "Selesai" : "Gagal"} saat data ini tiba; pengisian dicatat tanpa rit untuk diperiksa.`;
    else {
      tripId = t.id;
      trip = t;
    }
  }
  const isDepotSupply = !!trip?.isInternal;
  const [fill] = await tx
    .insert(truckFills)
    .values({
      id: input.fillId,
      tenantId: source.tenantId,
      waterSourceId: source.id,
      truckId: truck.id,
      tripId,
      businessDate: date,
      volumeL: input.volumeL,
      volumeReason: volumeNeedsReason(input.volumeL, rules.standardVolumeL) ? volumeReason : null,
      filledAt: meta.deviceTime,
      recordedBy: ctx.userId,
      photoAttachmentId: photo?.id ?? null,
      status: tripId ? "linked" : "unlinked",
      isDepotSupply,
      unplannedTruck: unplanned,
      requestedTripId: tripId ? null : requestedTripId,
      syncConflictNote: conflict,
      ...meta.fieldValues,
      createdBy: ctx.userId,
    })
    .returning();
  if (photo) await linkAttachment(tx, photo.id, { type: "truck_fill", id: fill!.id });
  await auditRecord(tx, {
    ctx,
    objectType: "truck_fill",
    objectId: fill!.id,
    action: "create",
    after: {
      truck: truck.code,
      tripNumber: trip?.number ?? null,
      volumeL: input.volumeL,
      volumeReason: fill!.volumeReason,
      isDepotSupply,
      unplannedTruck: unplanned,
      withoutTrip: !tripId,
      conflict,
    },
    reason: fill!.volumeReason,
    businessDate: date,
  });
  await emit(
    tx,
    "truck_fill.recorded",
    {
      truckFillId: fill!.id,
      waterSourceId: source.id,
      truckId: truck.id,
      tripId,
      volumeL: input.volumeL,
      isSupply: isDepotSupply,
      businessDate: date,
      filledAt: meta.deviceTime.toISOString(),
      tripNumber: trip?.number ?? null,
      destinationOutletId: trip?.destinationOutletId ?? null,
      withoutTrip: !tripId,
      unplannedTruck: unplanned,
      volumeReason: fill!.volumeReason,
      deviceId: meta.device.id,
      lateSync: meta.lateSync,
    },
    { ctx, objectType: "truck_fill", objectId: fill!.id, businessDate: date },
  );
  const link = `/produksi/pengisian?tanggal=${date}&sumber=${source.id}`;
  if (!tripId) {
    // KP-2: pengisian tanpa rit terjadwal → Dispatcher & pemilik (indikasi rit tanpa pesanan, P-01 langkah 8).
    await notifyOnce(tx, {
      event: "production.fill_without_trip",
      tenantId: source.tenantId,
      groupKey: `fill_without_trip:${fill!.id}`,
      title: `Pengisian tanpa rit: truk ${truck.code} di ${source.name} (${liter(input.volumeL)})`,
      body: conflict ?? "Tidak ada rit terjadwal yang dipilih untuk pengisian ini. Periksa kemungkinan rit tanpa pesanan.",
      objectType: "truck_fill",
      objectId: fill!.id,
      valueText: liter(input.volumeL),
      link,
      now: ctx.now,
    });
  }
  if (unplanned) {
    // 7.8.6: truk di luar rencana sumber ini → Dispatcher diberi tahu; rit tetap terkait.
    await notifyOnce(tx, {
      event: "production.fill_unplanned_truck",
      tenantId: source.tenantId,
      groupKey: `fill_unplanned:${fill!.id}`,
      title: `Truk ${truck.code} mengisi di ${source.name} di luar rencana`,
      body: plan?.plannedSourceId ? "Rit berikutnya truk ini direncanakan mengisi di sumber lain." : "Truk ini tidak punya rit terjadwal yang belum diisi hari ini.",
      objectType: "truck_fill",
      objectId: fill!.id,
      link,
      now: ctx.now,
    });
  }
  if (isDepotSupply && tripId) await evaluateSupply(tx, ctx, tripId);
  await refreshSourceDay(tx, ctx, source.id, date, { skipProduction: true });
  return { fill: fill!, duplicate: false, conflict };
}

// =====================================================================================================================
// Koreksi Admin Keuangan: pembalik & penautan (US-M8-02 KP-6, BR-38)
// =====================================================================================================================

async function loadFill(tx: Tx, ctx: ActorContext, fillId: string): Promise<TruckFillRow> {
  const [fill] = await tx.select().from(truckFills).where(eq(truckFills.id, fillId)).for("update").limit(1);
  if (!fill || fill.tenantId !== ctx.tenantId) throw new NotFoundError("Pengisian truk tidak ditemukan.");
  return fill;
}

const reverseSchema = z
  .object({
    fillId: z.uuid(),
    reason: z.string().trim().min(5, { error: "Alasan pembalik wajib diisi (minimal 5 huruf), mis. pengisian ganda." }).max(300),
  })
  .strict();

/**
 * Pembalik pengisian oleh Admin Keuangan: baris baru volume NEGATIF merujuk pengisian asal (`reversal_of_id`); baris asal
 * ditandai dibalik (tidak dihapus). Neraca hari itu dihitung ulang.
 */
export async function reverseTruckFill(ctx: ActorContext, input: z.input<typeof reverseSchema>, opts: { tx?: Tx } = {}): Promise<{ original: TruckFillRow; reversal: TruckFillRow }> {
  await authorize(ctx, "m8.truck_fill.correct", { tx: opts.tx, objectType: "truck_fill", objectId: input.fillId });
  const data = parseInput(reverseSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const fill = await loadFill(tx, ctx, data.fillId);
    await assertSourceScope(tx, ctx, fill.waterSourceId);
    if (fill.reversalOfId) throw new DomainError("FILL_IS_REVERSAL", "Baris pembalik tidak dapat dibalik lagi.");
    if (fill.reversedAt) throw new DomainError("FILL_ALREADY_REVERSED", "Pengisian ini sudah dibalik.");
    sod.assertNotSelf(fill.recordedBy, ctx.userId, "pengisian truk", { objectType: "truck_fill", objectId: fill.id });
    const [rev] = await tx
      .insert(truckFills)
      .values({
        tenantId: fill.tenantId,
        waterSourceId: fill.waterSourceId,
        truckId: fill.truckId,
        tripId: fill.tripId,
        businessDate: fill.businessDate,
        volumeL: -fill.volumeL,
        filledAt: ctx.now,
        recordedBy: ctx.userId,
        status: fill.status,
        isDepotSupply: fill.isDepotSupply,
        reversalOfId: fill.id,
        reversalReason: data.reason,
        createdBy: ctx.userId,
      })
      .returning();
    const [orig] = await tx
      .update(truckFills)
      .set({ reversedAt: ctx.now, reversedById: rev!.id, reversalReason: data.reason })
      .where(eq(truckFills.id, fill.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "truck_fill",
      objectId: fill.id,
      action: "reverse",
      before: { volumeL: fill.volumeL, reversed: false },
      after: { reversed: true, reversalId: rev!.id },
      reason: data.reason,
      rule: "US-M8-02 KP-6, BR-38",
      businessDate: fill.businessDate,
    });
    await emit(
      tx,
      "truck_fill.recorded",
      {
        truckFillId: rev!.id,
        waterSourceId: fill.waterSourceId,
        truckId: fill.truckId,
        tripId: fill.tripId,
        volumeL: -fill.volumeL,
        isSupply: fill.isDepotSupply,
        businessDate: fill.businessDate,
        filledAt: ctx.now.toISOString(),
        reversalOfId: fill.id,
        reason: data.reason,
      },
      { ctx, objectType: "truck_fill", objectId: rev!.id, businessDate: fill.businessDate },
    );
    await refreshSourceDay(tx, ctx, fill.waterSourceId, fill.businessDate, { skipProduction: true });
    return { original: orig!, reversal: rev! };
  });
}

const linkSchema = z
  .object({
    fillId: z.uuid(),
    tripId: z.uuid({ error: "Pilih rit." }),
    reason: z.string().trim().min(5, { error: "Alasan penautan wajib diisi (minimal 5 huruf)." }).max(300),
  })
  .strict();

/** Admin Keuangan menautkan pengisian tanpa rit ke rit truk yang sama (sekali; kolom `trip_id` sekali isi). */
export async function linkTruckFill(ctx: ActorContext, input: z.input<typeof linkSchema>, opts: { tx?: Tx } = {}): Promise<TruckFillRow> {
  await authorize(ctx, "m8.truck_fill.correct", { tx: opts.tx, objectType: "truck_fill", objectId: input.fillId });
  const data = parseInput(linkSchema, input, { tripId: "Rit", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const fill = await loadFill(tx, ctx, data.fillId);
    await assertSourceScope(tx, ctx, fill.waterSourceId);
    if (fill.reversalOfId || fill.reversedAt) throw new DomainError("FILL_REVERSED", "Pengisian yang sudah dibalik tidak dapat ditautkan.");
    if (fill.tripId) throw new DomainError("FILL_ALREADY_LINKED", "Pengisian ini sudah terkait rit.");
    const [trip] = await tx.select().from(trips).where(eq(trips.id, data.tripId)).for("update").limit(1);
    if (!trip || trip.tenantId !== ctx.tenantId) throw new NotFoundError("Rit tidak ditemukan.");
    if (trip.truckId !== fill.truckId) throw new DomainError("FILL_TRUCK_MISMATCH", "Rit ini bukan milik truk yang diisi.");
    const [other] = await tx
      .select({ id: truckFills.id })
      .from(truckFills)
      .where(and(eq(truckFills.tripId, trip.id), isNull(truckFills.reversalOfId), isNull(truckFills.reversedAt), ne(truckFills.id, fill.id)))
      .limit(1);
    if (other) throw new DomainError("TRIP_ALREADY_FILLED", `Rit ${trip.number} sudah punya pengisian. Balik pengisian yang salah lebih dulu.`);
    const [row] = await tx
      .update(truckFills)
      .set({ tripId: trip.id, status: "linked", isDepotSupply: trip.isInternal })
      .where(eq(truckFills.id, fill.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "truck_fill",
      objectId: fill.id,
      action: "link",
      before: { tripId: null, status: fill.status },
      after: { tripId: trip.id, tripNumber: trip.number, status: "linked", isDepotSupply: trip.isInternal },
      reason: data.reason,
      rule: "US-M8-02 KP-2",
      businessDate: fill.businessDate,
    });
    if (trip.isInternal) await evaluateSupply(tx, ctx, trip.id);
    await refreshSourceDay(tx, ctx, fill.waterSourceId, fill.businessDate, { skipProduction: true });
    return row!;
  });
}

// =====================================================================================================================
// Geofence (US-M8-02 KP-4 — FR-M12-05 bila tersedia; tidak memblokir pencatatan)
// =====================================================================================================================

/**
 * Hasil pencocokan geofence sumber untuk satu pengisian (dipanggil M12 atau handler `fleet_event.detected`).
 * Ketidaksesuaian hanya DITANDAI — pengisian tetap sah.
 */
export async function setFillGeofenceResult(tx: Tx, input: { truckFillId: string; result: "verified" | "mismatch"; note?: string | null; now?: Date }): Promise<TruckFillRow | null> {
  const [fill] = await tx.select().from(truckFills).where(eq(truckFills.id, input.truckFillId)).limit(1);
  if (!fill || fill.reversalOfId || fill.reversedAt) return null;
  const mismatch = input.result === "mismatch";
  if (fill.geofenceMismatch === mismatch && (mismatch || fill.status === "geofence_verified" || !fill.tripId)) return fill;
  const [row] = await tx
    .update(truckFills)
    .set({ geofenceMismatch: mismatch, status: mismatch ? fill.status : fill.tripId ? "geofence_verified" : fill.status })
    .where(eq(truckFills.id, fill.id))
    .returning();
  await auditRecord(tx, {
    ctx: systemContext({ tenantId: fill.tenantId, now: input.now }),
    objectType: "truck_fill",
    objectId: fill.id,
    action: "geofence",
    before: { geofenceMismatch: fill.geofenceMismatch, status: fill.status },
    after: { geofenceMismatch: row!.geofenceMismatch, status: row!.status },
    reason: input.note ?? null,
    rule: "US-M8-02 KP-4, US-M12-06",
    businessDate: fill.businessDate,
  });
  return row!;
}

/** Handler `fleet_event.detected` (M12): "pengisian tanpa masuk geofence sumber" → tandai pengisian (tidak memblokir). */
export async function handleFleetEventForFills(tx: Tx, event: DomainEvent<"fleet_event.detected">): Promise<TruckFillRow | null> {
  if (event.payload.kind !== "fill_without_geofence") return null;
  const [fe] = await tx.select().from(fleetEvents).where(eq(fleetEvents.id, event.payload.fleetEventId)).limit(1);
  const details = (fe?.details ?? {}) as Record<string, unknown>;
  let fillId = typeof details.truckFillId === "string" ? details.truckFillId : null;
  const tripId = event.payload.tripId ?? fe?.tripId ?? null;
  if (!fillId && tripId) {
    const [f] = await tx
      .select({ id: truckFills.id })
      .from(truckFills)
      .where(and(eq(truckFills.tripId, tripId), isNull(truckFills.reversalOfId), isNull(truckFills.reversedAt)))
      .limit(1);
    fillId = f?.id ?? null;
  }
  if (!fillId) return null;
  return setFillGeofenceResult(tx, { truckFillId: fillId, result: "mismatch", note: "M12: pengisian tanpa kejadian masuk geofence sumber.", now: event.occurredAt ? new Date(event.occurredAt) : undefined });
}

// =====================================================================================================================
// Kueri
// =====================================================================================================================

export type FillListRow = TruckFillRow & {
  truckCode: string;
  sourceCode: string;
  sourceName: string;
  tripNumber: string | null;
  tripStatus: TripRow["status"] | null;
  tripIsInternal: boolean | null;
  deliveredVolumeL: number | null;
  customerName: string | null;
  destinationName: string | null;
  recordedByName: string | null;
  deviceSpare: boolean;
};

/** Pengisian rentang tanggal (terbaru dulu) + rit, volume terkirim (selisih rit untuk neraca, US-M8-02 KP-6). */
export async function listFills(tx: Tx, tenantId: string, input: { from: BusinessDate; to: BusinessDate; sourceId?: string | null; truckId?: string | null }): Promise<FillListRow[]> {
  const rows = await tx
    .select({
      fill: truckFills,
      truckCode: trucks.code,
      sourceCode: waterSources.code,
      sourceName: waterSources.name,
      tripNumber: trips.number,
      tripStatus: trips.status,
      tripIsInternal: trips.isInternal,
      deliveredVolumeL: trips.deliveredVolumeL,
      customerName: customers.name,
      destinationName: outlets.name,
      recordedByName: employees.fullName,
      deviceSpare: devices.isSpare,
    })
    .from(truckFills)
    .innerJoin(trucks, eq(trucks.id, truckFills.truckId))
    .innerJoin(waterSources, eq(waterSources.id, truckFills.waterSourceId))
    .leftJoin(trips, eq(trips.id, truckFills.tripId))
    .leftJoin(customers, eq(customers.id, trips.customerId))
    .leftJoin(outlets, eq(outlets.id, trips.destinationOutletId))
    .leftJoin(users, eq(users.id, truckFills.recordedBy))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .leftJoin(devices, eq(devices.id, truckFills.deviceId))
    .where(
      and(
        eq(truckFills.tenantId, tenantId),
        gte(truckFills.businessDate, input.from),
        lte(truckFills.businessDate, input.to),
        ...(input.sourceId ? [eq(truckFills.waterSourceId, input.sourceId)] : []),
        ...(input.truckId ? [eq(truckFills.truckId, input.truckId)] : []),
      ),
    )
    .orderBy(desc(truckFills.businessDate), desc(truckFills.filledAt));
  return rows.map((r) => ({
    ...r.fill,
    truckCode: r.truckCode,
    sourceCode: r.sourceCode,
    sourceName: r.sourceName,
    tripNumber: r.tripNumber,
    tripStatus: r.tripStatus,
    tripIsInternal: r.tripIsInternal,
    deliveredVolumeL: r.deliveredVolumeL,
    customerName: r.customerName,
    destinationName: r.destinationName,
    recordedByName: r.recordedByName,
    deviceSpare: !!r.deviceSpare,
  }));
}

/** Pengisian dari ponsel perangkat cadangan (BRD 10.5) — penanda di tampilan kantor. */
export function isSpareDeviceFill(row: Pick<FillListRow, "deviceSpare">): boolean {
  return row.deviceSpare;
}

export type ScheduleVsFillRow = {
  truckId: string;
  truckCode: string;
  plannedAtSource: boolean;
  plannedSourceName: string | null;
  trips: { id: string; number: string; customerName: string; status: TripRow["status"]; isInternal: boolean; routeOrder: number | null; fill: { id: string; volumeL: number; sourceName: string; filledAt: Date } | null }[];
  fillsWithoutTrip: FillListRow[];
};

/**
 * Dispatcher: pengisian vs jadwal rit per truk pada tanggal (US-M8-02 KP-2; 7.8.2 "melihat pengisian vs jadwal rit").
 */
export async function fillsVsSchedule(ctx: ActorContext, input: { date: BusinessDate; sourceId?: string | null }, opts: { tx?: Tx } = {}): Promise<ScheduleVsFillRow[]> {
  await authorize(ctx, "m8.truck_fill.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const sources = await tx.select().from(waterSources).where(eq(waterSources.tenantId, ctx.tenantId));
  const sourceName = new Map(sources.map((s) => [s.id, s.name]));
  const anchor = input.sourceId ?? sources[0]?.id ?? "";
  const plans = await truckPlansForDay(tx, ctx.tenantId, anchor, input.date);
  const fills = await listFills(tx, ctx.tenantId, { from: input.date, to: input.date, sourceId: input.sourceId ?? null });
  const live = fills.filter((f) => !f.reversalOfId && !f.reversedAt);
  const truckRows = await tx.select().from(trucks).where(eq(trucks.tenantId, ctx.tenantId)).orderBy(asc(trucks.code));
  const out: ScheduleVsFillRow[] = [];
  for (const t of truckRows) {
    const plan = plans.get(t.id);
    const own = live.filter((f) => f.truckId === t.id);
    if (!plan && own.length === 0) continue;
    const plannedSourceId = plan?.plannedSourceId ?? null;
    out.push({
      truckId: t.id,
      truckCode: t.code,
      plannedAtSource: !!plan && !!input.sourceId && plannedSourceId === input.sourceId,
      plannedSourceName: plannedSourceId ? (sourceName.get(plannedSourceId) ?? null) : null,
      trips: (plan?.trips ?? []).map((tr) => {
        const f = live.find((x) => x.tripId === tr.id);
        return {
          id: tr.id,
          number: tr.number,
          customerName: tr.customerName,
          status: tr.status,
          isInternal: tr.isInternal,
          routeOrder: tr.routeOrder,
          fill: f ? { id: f.id, volumeL: f.volumeL, sourceName: f.sourceName, filledAt: f.filledAt } : null,
        };
      }),
      fillsWithoutTrip: own.filter((f) => !f.tripId),
    });
  }
  return out;
}

/** Pengisian tanpa rit & konflik yang belum ditautkan/dibalik (daftar kerja Admin Keuangan). */
export async function openFillIssues(tx: Tx, tenantId: string): Promise<TruckFillRow[]> {
  return tx
    .select()
    .from(truckFills)
    .where(and(eq(truckFills.tenantId, tenantId), isNull(truckFills.tripId), isNull(truckFills.reversalOfId), isNull(truckFills.reversedAt)))
    .orderBy(desc(truckFills.businessDate), desc(truckFills.filledAt));
}
