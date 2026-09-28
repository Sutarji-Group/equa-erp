/**
 * M1 — handler event domain milik modul ini.
 *
 * - `trip.completed` (`m1-master:propose_coordinate`): alamat kirim yang koordinatnya "Belum dikunci" mendapat usulan
 *   kunci koordinat dari lokasi Selesai rit (rit pertama); Dispatcher diberi tahu dan mengonfirmasi di
 *   /master/pelanggan (US-M1-01 KP-2, BRD 10.2, US-M3-03 KP-4). Terisolasi savepoint (galat → insiden; rit tetap sah).
 */
import "server-only";

import { EQUA_TENANT_ID } from "@/server/core/context";
import { on } from "@/server/core/events";

import { proposeCoordinateFromTrip } from "./service/customers";

export function registerEvents(): void {
  on(
    "trip.completed",
    async (event, tx) => {
      if (event.payload.isInternal) return;
      await proposeCoordinateFromTrip(tx, { tripId: event.payload.tripId, tenantId: event.tenantId ?? EQUA_TENANT_ID, now: event.occurredAt });
    },
    { name: "m1-master:propose_coordinate" },
  );
}
