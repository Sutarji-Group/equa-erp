/**
 * M12 — handler event domain (terisolasi savepoint; galat tidak menggagalkan transaksi sumber, dicatat sebagai insiden).
 *
 * - `trip.departed` / `trip.arrived` / `trip.failed` (M3) → `m12-fleet:trip_status_point`: titik status disimpan sebagai
 *   posisi sumber `status_point` (US-M12-01 KP-4), penanda "tanpa lokasi" (US-M3-02 KP-4), Berangkat tersinkron terlambat
 *   menyelesaikan kejadian "di luar jadwal" yang ternyata bagian rit, jejak rit Gagal dihitung (US-M12-03).
 * - `trip.completed` (M3) → `m12-fleet:trip_completed`: jarak titik Selesai dihitung server vs alamat Dikunci / depot
 *   (tingkat 1/2, US-M12-04 KP-1/KP-4/KP-5), sumber lokasi tidak konsisten (KP-2), jejak rit + estimasi BBM.
 * - `truck_fill.recorded` (M8) → `m12-fleet:fill_geofence`: pengisian tanpa truk di geofence sumber (US-M12-06 KP-2)
 *   — dinilai langsung bila jendela ± menit sudah lewat (sinkron terlambat); selebihnya oleh job tiap 5 menit.
 * - `cash_day.closed` (M4) → `m12-fleet:unexplained_at_cash_close`: kejadian tanpa keterangan saat tutup kas ditandai →
 *   kotak masuk pemilik & H+0 (US-M12-05 KP-4).
 *
 * Dipancarkan: `fleet_event.detected` (setiap kejadian baru; payload mandiri — lihat `events.types.ts`).
 */
import "server-only";

import { toBusinessDate } from "@/lib/time";

import { on } from "@/server/core/events";

import { handleTripCompleted, handleTripStatus } from "./service/completion";
import { checkFillGeofence } from "./service/geofence";
import { markUnexplainedAtCashClose } from "./service/review";

export function registerEvents(): void {
  on("trip.departed", (event, tx) => handleTripStatus(tx, event), { name: "m12-fleet:trip_status_point" });
  on("trip.arrived", (event, tx) => handleTripStatus(tx, event), { name: "m12-fleet:trip_status_point" });
  on("trip.failed", (event, tx) => handleTripStatus(tx, event), { name: "m12-fleet:trip_status_point" });
  on("trip.completed", (event, tx) => handleTripCompleted(tx, event), { name: "m12-fleet:trip_completed" });
  on(
    "truck_fill.recorded",
    async (event, tx) => {
      await checkFillGeofence(tx, event.payload.truckFillId, event.occurredAt);
    },
    { name: "m12-fleet:fill_geofence" },
  );
  on(
    "cash_day.closed",
    async (event, tx) => {
      const tenantId = event.tenantId;
      if (!tenantId) return;
      const date = event.payload.businessDate ?? event.businessDate ?? toBusinessDate(event.occurredAt);
      const closedAt = event.payload.closedAt ? new Date(event.payload.closedAt) : event.occurredAt;
      await markUnexplainedAtCashClose(tx, { tenantId, date, closedAt, now: event.occurredAt });
    },
    { name: "m12-fleet:unexplained_at_cash_close" },
  );
}
