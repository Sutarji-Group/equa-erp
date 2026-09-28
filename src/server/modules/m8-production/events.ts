/**
 * M8 — handler event domain milik modul ini (terisolasi savepoint; galat → insiden, sumber tetap commit).
 *
 * | Event                    | Handler                          | Efek |
 * |--------------------------|----------------------------------|------|
 * | `water_supply.confirmed` | `m8-production:supply_check`     | US-M8-03 KP-2: tiga angka pasokan (diisi/diserahkan/diterima); selisih > PAR-69 → Dispatcher & pemilik. |
 * | `trip.failed`            | `m8-production:failed_trip_water`| US-M3-06 KP-2: air "kembali ke sumber" dikurangkan dari pengisian → neraca hari pengisian dihitung ulang. |
 * | `trip.completed`         | `m8-production:trip_delivered`   | Volume terkirim < volume isi = selisih rit (US-M8-02 KP-6); pasokan rit internal dievaluasi ulang. |
 * | `fleet_event.detected`   | `m8-production:geofence`         | US-M8-02 KP-4: "pengisian tanpa masuk geofence sumber" (M12) → pengisian ditandai, tidak diblokir. |
 */
import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { truckFills } from "@/db/schema";

import { systemContext } from "@/server/core/context";
import { on } from "@/server/core/events";

import { refreshSourceDay } from "./service/balance";
import { handleFleetEventForFills } from "./service/fills";
import { evaluateSupply } from "./service/supply";

export function registerEvents(): void {
  on(
    "water_supply.confirmed",
    async (event, tx) => {
      const tripId = event.payload.tripId;
      if (!tripId) return;
      const ctx = systemContext({ tenantId: event.tenantId ?? undefined, now: event.occurredAt ? new Date(event.occurredAt) : new Date() });
      await evaluateSupply(tx, ctx, tripId);
    },
    { name: "m8-production:supply_check" },
  );

  on(
    "trip.failed",
    async (event, tx) => {
      if (event.payload.loadedWaterDisposition !== "returned_to_source") return;
      const [fill] = await tx
        .select()
        .from(truckFills)
        .where(and(eq(truckFills.tripId, event.payload.tripId), isNull(truckFills.reversalOfId), isNull(truckFills.reversedAt)))
        .limit(1);
      if (!fill) return;
      const ctx = systemContext({ tenantId: fill.tenantId, now: event.occurredAt ? new Date(event.occurredAt) : new Date() });
      await refreshSourceDay(tx, ctx, fill.waterSourceId, fill.businessDate, { skipProduction: true });
    },
    { name: "m8-production:failed_trip_water" },
  );

  on(
    "trip.completed",
    async (event, tx) => {
      if (!event.payload.isInternal) return;
      const ctx = systemContext({ tenantId: event.tenantId ?? undefined, now: event.occurredAt ? new Date(event.occurredAt) : new Date() });
      await evaluateSupply(tx, ctx, event.payload.tripId);
    },
    { name: "m8-production:trip_delivered" },
  );

  on(
    "fleet_event.detected",
    async (event, tx) => {
      await handleFleetEventForFills(tx, event);
    },
    { name: "m8-production:geofence" },
  );
}
