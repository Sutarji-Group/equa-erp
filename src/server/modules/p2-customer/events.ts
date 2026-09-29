/**
 * P2 — handler event domain milik modul ini (terisolasi savepoint; galat → insiden, transaksi sumber tetap commit).
 *
 * | Event | Handler | Efek |
 * |---|---|---|
 * | `order.status_changed` | `p2-customer:order_status` | Terjadwal → pesanan aplikasi Dikonfirmasi + notifikasi "Dikonfirmasi" (WA ke pelanggan tanpa aplikasi bila Cloud API aktif & belum dikirim dari M2); Dibatalkan/Ditolak kantor → pemberitahuan beralasan (US-P2-02 KP-4, US-P2-03 KP-4, US-P2-08 KP-1/KP-2). |
 * | `trip.departed` | `p2-customer:trip_departed` | Notifikasi "Berangkat" (US-P2-03 KP-4). |
 * | `trip.completed` | `p2-customer:trip_completed` | Notifikasi "Selesai" + struk digital WA otomatis (US-M3-03 KP-7 Tahap 2, US-P2-08 KP-1). |
 * | `trip.failed` | `p2-customer:trip_failed` | Notifikasi "Gagal" beralasan layak pelanggan (US-P2-03 KP-1). |
 * | `transfer.matched` | `p2-customer:digital_matched` | Transfer "pembayaran digital" dicocokkan M4 → pembayaran Dicocokkan (US-P2-04 KP-3). |
 */
import "server-only";

import { on } from "@/server/core/events";

import { onOrderStatusChanged, onTransferMatched, onTripCompleted, onTripDeparted, onTripFailed } from "./service/events-logic";

export function registerEvents(): void {
  on("order.status_changed", onOrderStatusChanged, { name: "p2-customer:order_status" });
  on("trip.departed", onTripDeparted, { name: "p2-customer:trip_departed" });
  on("trip.completed", onTripCompleted, { name: "p2-customer:trip_completed" });
  on("trip.failed", onTripFailed, { name: "p2-customer:trip_failed" });
  on("transfer.matched", onTransferMatched, { name: "p2-customer:digital_matched" });
}
