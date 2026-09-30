/**
 * M3 — GPS ponsel CADANGAN (US-M3-02 KP-5, K11, NFR-17): perangkat merekam posisi ±60 dtk (m3.driver_rules) HANYA
 * selama rit aktif dan HANYA bila server menandai pelacakan ponsel untuk truk itu (`phone_tracking_flags`: perangkat
 * GPS truk mati / dipaksa admin sistem). Posisi dikirim sebagai perintah batch `gps.phone_positions` →
 * `gps_positions` sumber `phone` (dedupe unik truk + sumber + waktu perangkat; kirim ulang tidak menggandakan).
 */
import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { gpsPositions, phoneTrackingFlags } from "@/db/schema";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { inTruckScope } from "@/server/core/rbac";

import { phonePositionsSchema } from "../schemas";
import type { M3WriteMeta } from "./common";

/** Pelacakan ponsel aktif untuk truk (flag M12 yang belum berakhir). */
export async function phoneTrackingActive(tx: Tx, truckId: string | null): Promise<boolean> {
  if (!truckId) return false;
  const rows = await tx.select({ id: phoneTrackingFlags.id }).from(phoneTrackingFlags).where(and(eq(phoneTrackingFlags.truckId, truckId), isNull(phoneTrackingFlags.endedAt))).limit(1);
  return rows.length > 0;
}

export async function recordPhonePositions(ctx: ActorContext, input: unknown, meta: M3WriteMeta): Promise<{ inserted: number; received: number }> {
  const data = parseInput(phonePositionsSchema, input, { positions: "Posisi" });
  const tx = meta.tx;
  if (!inTruckScope(ctx, data.truckId)) throw new DomainError("NOT_YOUR_TRUCK", "Posisi hanya untuk truk yang dikemudikan hari ini.");
  const tenantId = ctx.tenantId;
  // US-M3-02 KP-5 / US-M12-01 KP-5: ambang akurasi posisi sah dari parameter M12 (sama dengan GPS truk), bukan angka tetap.
  const maxAccuracyM = (await params.get(tx, "m12.fleet_rules", meta.businessDate, { tenantId })).max_accuracy_m;
  let inserted = 0;
  for (const p of data.positions) {
    const rows = await tx
      .insert(gpsPositions)
      .values({
        tenantId,
        truckId: data.truckId,
        deviceId: meta.deviceId,
        source: "phone",
        deviceTime: new Date(p.deviceTime),
        serverTime: meta.receivedAt,
        lat: p.lat,
        lng: p.lng,
        speedKmh: p.speedKmh ?? null,
        heading: p.heading ?? null,
        accuracyM: p.accuracyM ?? null,
        isValid: p.accuracyM === null || p.accuracyM === undefined || p.accuracyM <= maxAccuracyM,
        clockSkewFlagged: meta.clockSkewFlagged,
        tripId: p.tripId ?? null,
        userId: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({ id: gpsPositions.id });
    inserted += rows.length;
  }
  return { inserted, received: data.positions.length };
}
