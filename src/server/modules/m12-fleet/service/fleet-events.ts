/**
 * M12 — pencatatan kejadian armada (`fleet_events`) yang idempoten: setiap pemicu (rit, segmen gerak, titik berhenti,
 * perangkat, pengisian) punya `dedupe_key` sehingga job tiap 5 menit & handler event dapat berjalan ulang tanpa
 * menggandakan kejadian (BR-38: kejadian tidak dihapus; alur Terdeteksi → Keterangan sopir → Ditinjau pemilik →
 * Selesai). Setiap kejadian baru berjejak audit (pelaku Sistem + aturan) dan memancarkan `fleet_event.detected`.
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { fleetEvents, notifications } from "@/db/schema";
import type { EnumValue, FleetEventKind, FleetEventStatus } from "@/lib/labels";

import { record as auditRecord } from "@/server/core/audit";
import { systemContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { notify, type NotifyInput } from "@/server/core/notifications";

export type FleetEventRow = typeof fleetEvents.$inferSelect;

export type CreateFleetEventInput = {
  tenantId: string;
  kind: FleetEventKind;
  dedupeKey: string;
  truckId: string | null;
  businessDate: string;
  startedAt: Date;
  endedAt?: Date | null;
  durationS?: number | null;
  distanceM?: number | null;
  lat?: number | null;
  lng?: number | null;
  tripId?: string | null;
  deviceId?: string | null;
  userId?: string | null;
  locationType?: EnumValue<"geofence_location_type"> | null;
  locationId?: string | null;
  details?: Record<string, unknown>;
  requiresExplanation?: boolean;
  status?: FleetEventStatus;
  /** Aturan PRD pemicu (jejak audit). */
  rule: string;
  now: Date;
};

/** Kejadian untuk kunci pemicu (null bila belum ada). */
export async function findFleetEventByKey(tx: Tx, tenantId: string, dedupeKey: string): Promise<FleetEventRow | null> {
  const rows = await tx.select().from(fleetEvents).where(and(eq(fleetEvents.tenantId, tenantId), eq(fleetEvents.dedupeKey, dedupeKey))).limit(1);
  return rows[0] ?? null;
}

/** Catat kejadian armada (idempoten per `dedupeKey`). `created=false` bila kejadian itu sudah tercatat sebelumnya. */
export async function createFleetEvent(tx: Tx, input: CreateFleetEventInput): Promise<{ event: FleetEventRow; created: boolean }> {
  const existing = await findFleetEventByKey(tx, input.tenantId, input.dedupeKey);
  if (existing) return { event: existing, created: false };
  const inserted = await tx
    .insert(fleetEvents)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      status: input.status ?? "detected",
      truckId: input.truckId,
      tripId: input.tripId ?? null,
      deviceId: input.deviceId ?? null,
      userId: input.userId ?? null,
      businessDate: input.businessDate,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      durationS: input.durationS ?? null,
      distanceM: input.distanceM === null || input.distanceM === undefined ? null : Math.round(input.distanceM),
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      locationType: input.locationType ?? null,
      locationId: input.locationId ?? null,
      details: input.details ?? null,
      requiresExplanation: input.requiresExplanation ?? false,
      doneAt: input.status === "done" ? input.now : null,
      dedupeKey: input.dedupeKey,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (!row) {
    const again = await findFleetEventByKey(tx, input.tenantId, input.dedupeKey);
    if (again) return { event: again, created: false };
    throw new Error(`Kejadian armada ${input.dedupeKey} gagal dicatat.`);
  }
  const ctx = systemContext({ tenantId: input.tenantId, now: input.now });
  await auditRecord(tx, {
    ctx,
    objectType: "fleet_event",
    objectId: row.id,
    action: "detect",
    after: {
      kind: row.kind,
      status: row.status,
      truckId: row.truckId,
      tripId: row.tripId,
      startedAt: row.startedAt,
      distanceM: row.distanceM,
      durationS: row.durationS,
      requiresExplanation: row.requiresExplanation,
    },
    rule: input.rule,
    businessDate: row.businessDate,
  });
  await emit(
    tx,
    "fleet_event.detected",
    {
      fleetEventId: row.id,
      truckId: row.truckId ?? "",
      kind: row.kind,
      startedAt: row.startedAt.toISOString(),
      tripId: row.tripId,
      businessDate: row.businessDate,
      endedAt: row.endedAt?.toISOString() ?? null,
      durationS: row.durationS,
      distanceM: row.distanceM,
      lat: row.lat,
      lng: row.lng,
      deviceId: row.deviceId,
      userId: row.userId,
      requiresExplanation: row.requiresExplanation,
      locationType: row.locationType,
      locationId: row.locationId,
      truckFillId: typeof input.details?.truckFillId === "string" ? input.details.truckFillId : null,
      waterSourceId: typeof input.details?.waterSourceId === "string" ? input.details.waterSourceId : null,
    },
    { ctx, tenantId: input.tenantId, businessDate: row.businessDate, objectType: "fleet_event", objectId: row.id },
  );
  return { event: row, created: true };
}

/** Perbarui ujung kejadian yang masih berlangsung (titik berhenti/segmen yang memanjang) — tanpa mengubah jenisnya. */
export async function extendFleetEvent(
  tx: Tx,
  event: FleetEventRow,
  patch: { endedAt: Date; durationS: number; distanceM?: number | null; details?: Record<string, unknown> },
  now: Date,
): Promise<FleetEventRow> {
  if (event.endedAt && event.endedAt.getTime() >= patch.endedAt.getTime() && (event.durationS ?? 0) >= patch.durationS) return event;
  const [row] = await tx
    .update(fleetEvents)
    .set({
      endedAt: patch.endedAt,
      durationS: patch.durationS,
      ...(patch.distanceM !== undefined ? { distanceM: patch.distanceM === null ? null : Math.round(patch.distanceM) } : {}),
      ...(patch.details ? { details: { ...(event.details ?? {}), ...patch.details } } : {}),
      updatedAt: now,
    })
    .where(eq(fleetEvents.id, event.id))
    .returning();
  return row!;
}

/** Notifikasi sekali per `groupKey` + penerima (job dapat berjalan ulang tanpa menggandakan pemberitahuan). */
export async function notifyOnce(tx: Tx, input: NotifyInput & { groupKey: string }): Promise<void> {
  const exists = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.event, input.event), eq(notifications.groupKey, input.groupKey)))
    .limit(1);
  if (exists[0]) return;
  await notify(tx, input);
}

/** Tautan layar kejadian. */
export function eventLink(id: string): string {
  return `/armada/kejadian/${id}`;
}

/** Jenis kejadian per kelompok layar (`fleet_event_group`). */
export const EVENT_GROUPS: Record<EnumValue<"fleet_event_group">, readonly FleetEventKind[]> = {
  location: ["location_deviation_l1", "location_deviation_l2", "location_source_inconsistent", "no_location"],
  travel: ["off_schedule_trip", "off_hours_trip", "unknown_stop", "maintenance_trip"],
  geofence: ["geofence_enter", "geofence_exit", "fill_without_geofence", "geofence_without_fill", "supply_without_geofence"],
  device: ["device_offline", "device_unplugged", "clock_skew"],
};

/** Jenis yang masuk daftar tinjauan pemilik (US-M12-04 KP-3, US-M12-05 KP-4, US-M12-06 KP-4). */
export const REVIEW_KINDS: readonly FleetEventKind[] = [
  "location_deviation_l2",
  "location_source_inconsistent",
  "off_schedule_trip",
  "off_hours_trip",
  "unknown_stop",
  "fill_without_geofence",
  "geofence_without_fill",
  "supply_without_geofence",
];

/** Jenis informasional (tidak perlu tinjauan; tercatat berlabel). */
export const INFO_KINDS: readonly FleetEventKind[] = ["geofence_enter", "geofence_exit", "clock_skew", "maintenance_trip", "location_deviation_l1"];
