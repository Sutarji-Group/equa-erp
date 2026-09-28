/**
 * M3 — kendala perjalanan (US-M3-06 KP-3, S) & keterangan perjalanan di luar jadwal/jam (BR-25, US-M3-06 KP-4).
 *
 * - Kendala tanpa mengakhiri rit: jenis, foto, catatan → `trip_incidents` + notifikasi Dispatcher. "Truk rusak" →
 *   status truk Perbaikan SETELAH dikonfirmasi Dispatcher (`confirmIncident`, aksi kantor `/sopir-kantor/kendala`).
 * - Keterangan perjalanan: permintaan M12 (`fleet_events.requires_explanation`) tampil sebagai tugas di aplikasi; sopir
 *   mengisi hari yang sama (waktu perangkat & penanda terlambat bila diisi setelah tanggal kejadian).
 */
import "server-only";

import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";

import { fleetEvents, tripIncidents, trips, trucks, users, employees } from "@/db/schema";
import { label } from "@/lib/labels";
import { addDays, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, runService, inTruckScope } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";
import { setTruckStatus } from "@/server/modules/m1-master";

import { confirmIncidentSchema, explanationSchema, incidentSchema } from "../schemas";
import { actingTruckId, assertActingOnTruck, attachmentsOfKind, fieldValues, loadTrip, type M3WriteMeta } from "./common";

export type TripIncidentRow = typeof tripIncidents.$inferSelect;

export async function reportIncident(ctx: ActorContext, input: unknown, meta: M3WriteMeta): Promise<{ incident: TripIncidentRow; duplicate: boolean }> {
  const data = parseInput(incidentSchema, input, { kind: "Jenis kendala", description: "Catatan" });
  const tx = meta.tx;
  const existing = await tx.select().from(tripIncidents).where(eq(tripIncidents.id, data.incidentId)).limit(1);
  if (existing[0]) return { incident: existing[0], duplicate: true };
  const trip = data.tripId ? await loadTrip(tx, data.tripId) : null;
  const truckId = trip?.truckId ?? (await actingTruckId(tx, ctx, meta.businessDate));
  await assertActingOnTruck(tx, ctx, "m3.trip_incident.create", truckId, meta.businessDate, meta);
  const loc = data.location;
  const [incident] = await tx
    .insert(tripIncidents)
    .values({
      id: data.incidentId,
      tenantId: trip?.tenantId ?? ctx.tenantId,
      tripId: trip?.id ?? null,
      truckId,
      kind: data.kind,
      description: data.description,
      occurredAt: meta.deviceTime,
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
      reportedByUserId: ctx.userId,
      businessDate: meta.businessDate,
      ...fieldValues(meta),
    })
    .returning();
  for (const photo of attachmentsOfKind(meta, "incident_photo")) await linkAttachment(tx, photo.id, { type: "trip_incident", id: incident!.id });
  await auditRecord(tx, {
    ctx,
    objectType: "trip_incident",
    objectId: incident!.id,
    action: "create",
    after: { kind: data.kind, tripId: trip?.id ?? null, truckId, description: data.description },
    rule: "US-M3-06 KP-3",
    businessDate: meta.businessDate,
  });
  const truckCode = truckId ? (await tx.select({ code: trucks.code }).from(trucks).where(eq(trucks.id, truckId)).limit(1))[0]?.code : null;
  await notify(tx, {
    event: "trip_incident.reported",
    tenantId: incident!.tenantId,
    severity: data.kind === "truck_broken" || data.kind === "accident" ? "high" : undefined,
    title: `Kendala ${label("trip_incident_kind", data.kind)}${truckCode ? ` — truk ${truckCode}` : ""}${trip ? ` (rit ${trip.number})` : ""}`,
    body: `${data.description}${data.kind === "truck_broken" ? " Konfirmasi di Sopir > Kendala agar status truk menjadi Perbaikan." : ""}`,
    objectType: "trip_incident",
    objectId: incident!.id,
    link: "/sopir-kantor/kendala",
    groupKey: `trip_incident:${incident!.id}`,
    now: ctx.now,
  });
  return { incident: incident!, duplicate: false };
}

/**
 * Dispatcher mengonfirmasi kendala (US-M3-06 KP-3): "truk rusak" + `setTruckMaintenance` → status truk Perbaikan (M1;
 * rit terjadwal truk itu ditandai perlu dipindah). Kendala lain hanya ditandai sudah ditindaklanjuti.
 */
export async function confirmIncident(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m3.trip_incident.confirm", { tx: opts.tx });
  const data = parseInput(confirmIncidentSchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(tripIncidents).where(eq(tripIncidents.id, data.incidentId)).for("update").limit(1);
    const incident = rows[0];
    if (!incident || incident.tenantId !== ctx.tenantId) throw new NotFoundError("Kendala tidak ditemukan.");
    if (incident.acknowledgedAt) throw new DomainError("ALREADY_CONFIRMED", "Kendala ini sudah dikonfirmasi.");
    if (data.setTruckMaintenance && incident.kind !== "truck_broken") {
      throw new DomainError("NOT_TRUCK_BROKEN", "Status Perbaikan hanya untuk kendala \"Truk rusak\".");
    }
    let truckStatusChanged = false;
    if (data.setTruckMaintenance && incident.truckId) {
      const truck = (await tx.select({ status: trucks.status }).from(trucks).where(eq(trucks.id, incident.truckId)).limit(1))[0];
      if (truck && truck.status === "active") {
        await setTruckStatus(ctx, incident.truckId, { status: "maintenance", reason: `Kendala sopir dikonfirmasi: ${incident.description ?? "truk rusak"}. ${data.note}` }, { tx });
        truckStatusChanged = true;
      }
    }
    const [updated] = await tx
      .update(tripIncidents)
      .set({ acknowledgedAt: ctx.now, acknowledgedBy: ctx.userId, truckStatusChanged, updatedAt: ctx.now })
      .where(eq(tripIncidents.id, incident.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "trip_incident",
      objectId: incident.id,
      action: "confirm",
      before: { acknowledgedAt: null },
      after: { acknowledgedAt: ctx.now, truckStatusChanged },
      reason: data.note,
      rule: "US-M3-06 KP-3",
    });
    return { incident: updated!, truckStatusChanged };
  });
}

export type IncidentListRow = TripIncidentRow & { truckCode: string | null; tripNumber: string | null; reporterName: string | null };

/** Kendala & rit gagal (kantor Dispatcher/Pemilik) untuk rentang tanggal. */
export async function listIncidents(ctx: ActorContext, input: { from?: BusinessDate; to?: BusinessDate } = {}, opts: { tx?: Tx } = {}): Promise<IncidentListRow[]> {
  await authorize(ctx, "m3.trip_incident.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const to = input.to ?? ctxBusinessDate(ctx);
  const from = input.from ?? addDays(to, -6);
  const rows = await db
    .select({ i: tripIncidents, truckCode: trucks.code, tripNumber: trips.number, reporterName: employees.fullName })
    .from(tripIncidents)
    .leftJoin(trucks, eq(trucks.id, tripIncidents.truckId))
    .leftJoin(trips, eq(trips.id, tripIncidents.tripId))
    .leftJoin(users, eq(users.id, tripIncidents.reportedByUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(tripIncidents.tenantId, ctx.tenantId), gte(tripIncidents.businessDate, from), lte(tripIncidents.businessDate, to)))
    .orderBy(desc(tripIncidents.occurredAt));
  return rows.map((r) => ({ ...r.i, truckCode: r.truckCode, tripNumber: r.tripNumber, reporterName: r.reporterName }));
}

// =====================================================================================================================
// Keterangan perjalanan (BR-25)
// =====================================================================================================================

export async function explainFleetEvent(ctx: ActorContext, input: unknown, meta: M3WriteMeta) {
  const data = parseInput(explanationSchema, input, { explanation: "Keterangan" });
  const tx = meta.tx;
  const rows = await tx.select().from(fleetEvents).where(eq(fleetEvents.id, data.fleetEventId)).for("update").limit(1);
  const ev = rows[0];
  if (!ev || ev.tenantId !== ctx.tenantId) throw new NotFoundError("Permintaan keterangan tidak ditemukan.");
  if (!ev.requiresExplanation) throw new DomainError("NO_EXPLANATION_REQUIRED", "Kejadian ini tidak meminta keterangan sopir.");
  if (!ev.truckId || !inTruckScope(ctx, ev.truckId)) {
    throw new DomainError("NOT_YOUR_TRUCK", "Keterangan hanya untuk kejadian truk yang Anda kemudikan.");
  }
  await assertActingOnTruck(tx, ctx, "m3.travel_explanation.create", ev.truckId, meta.businessDate, meta);
  if (ev.explanation) {
    if (ev.explanationSyncCommandId && ev.explanationSyncCommandId === meta.commandId) return { event: ev, duplicate: true, conflict: null as string | null };
    return { event: ev, duplicate: false, conflict: "Keterangan untuk kejadian ini sudah diisi sebelumnya; keterangan baru tidak menimpa." };
  }
  const late = meta.businessDate > ev.businessDate;
  const [updated] = await tx
    .update(fleetEvents)
    .set({
      explanation: data.explanation,
      explainedBy: ctx.userId,
      explainedAt: meta.deviceTime,
      explanationDeviceTime: meta.deviceTime,
      explanationDeviceId: meta.deviceId,
      explanationSyncCommandId: meta.commandId,
      explanationBusinessDate: meta.businessDate,
      explanationLate: late,
      status: ev.status === "detected" ? "explained" : ev.status,
      updatedAt: ctx.now,
    })
    .where(eq(fleetEvents.id, ev.id))
    .returning();
  await auditRecord(tx, {
    ctx,
    objectType: "fleet_event",
    objectId: ev.id,
    action: "explain",
    before: { explanation: null, status: ev.status },
    after: { explanation: data.explanation, explanationLate: late, status: updated!.status },
    rule: "BR-25",
    businessDate: meta.businessDate,
  });
  return { event: updated!, duplicate: false, conflict: null as string | null };
}

/** Tugas keterangan perjalanan terbuka untuk truk-truk (hari ini & kemarin yang belum diisi). */
export async function openExplanationTasks(tx: Tx, truckIds: readonly string[], date: BusinessDate) {
  if (truckIds.length === 0) return [];
  const rows = await tx
    .select({ e: fleetEvents, truckCode: trucks.code })
    .from(fleetEvents)
    .leftJoin(trucks, eq(trucks.id, fleetEvents.truckId))
    .where(
      and(
        inArray(fleetEvents.truckId, [...truckIds]),
        eq(fleetEvents.requiresExplanation, true),
        isNull(fleetEvents.explanation),
        gte(fleetEvents.businessDate, addDays(date, -1)),
        lte(fleetEvents.businessDate, date),
      ),
    )
    .orderBy(desc(fleetEvents.startedAt));
  return rows.map((r) => ({
    fleetEventId: r.e.id,
    kind: r.e.kind,
    kindLabel: label("fleet_event_kind", r.e.kind),
    truckCode: r.truckCode,
    startedAt: r.e.startedAt.toISOString(),
    endedAt: r.e.endedAt?.toISOString() ?? null,
    businessDate: r.e.businessDate,
    distanceM: r.e.distanceM,
    durationS: r.e.durationS,
    lat: r.e.lat,
    lng: r.e.lng,
  }));
}
