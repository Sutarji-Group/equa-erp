/**
 * M6 — handler event domain.
 *
 * - `trip.completed` (M3) → `m6-pos:water_supply_arrived`: rit internal Selesai (`isInternal`, `destinationOutletId`,
 *   `volumeL`) → penerimaan pasokan "Tiba" di POS outlet tujuan (idempoten per rit; US-M6-05 KP-1).
 * - `deposit.received` (M4) → `m6-pos:shift_deposit_received`: setoran akhir shift diterima → status setoran shift
 *   Diterima (tampil ke operator, US-M6-02 KP-5).
 * Handler berjalan di savepoint (bawaan): galat tidak menggagalkan transaksi sumber, dicatat sebagai insiden.
 */
import "server-only";

import { on } from "@/server/core/events";

import { markShiftDepositReceived } from "./service/shifts";
import { recordSupplyArrival } from "./service/water";

export function registerEvents(): void {
  on(
    "trip.completed",
    async (event, tx) => {
      await recordSupplyArrival(tx, event);
    },
    { name: "m6-pos:water_supply_arrived" },
  );
  on(
    "deposit.received",
    async (event, tx) => {
      if (event.payload.sourceType !== "depot_shift" && event.payload.sourceType !== "store_shift") return;
      await markShiftDepositReceived(tx, event.payload.depositId, event.occurredAt);
    },
    { name: "m6-pos:shift_deposit_received" },
  );
}
