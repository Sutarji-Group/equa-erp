/**
 * M2 — handler event domain (siklus pesanan dari aplikasi sopir M3 & status kredit M5).
 *
 * - `trip.departed` (`m2-orders:order_in_delivery`) → pesanan Dalam pengiriman (Bab 5.2); rit yang sudah ditarik/dipindah
 *   kantor tetapi dikerjakan offline ditandai konflik (Bab 6.4 KP-3).
 * - `trip.completed` (`m2-orders:order_completed`) → pesanan Selesai bila semua rit Selesai; penanda dobel dilepas.
 * - `trip.failed` (`m2-orders:trip_failed`) → kejadian rit gagal, rit pengganti di "Belum terjadwal", pesanan Baru +
 *   "perlu jadwal ulang", gagal berturut ≥ PAR-17 → konfirmasi ulang wajib (BR-24), notifikasi Dispatcher (6.3).
 * - `credit_status.changed` (`m2-orders:credit_hold_trips`) → Ditahan: rit tempo belum Berangkat ditandai (PTB-27).
 *
 * Handler terisolasi savepoint (bawaan): galat M2 tidak menggagalkan perintah lapangan M3 (dicatat sebagai insiden).
 */
import "server-only";

import { on } from "@/server/core/events";

import { onCreditStatusChanged, onTripCompleted, onTripDeparted, onTripFailed } from "./service/lifecycle";

export function registerEvents(): void {
  on("trip.departed", (event, tx) => onTripDeparted(tx, event), { name: "m2-orders:order_in_delivery" });
  on("trip.completed", (event, tx) => onTripCompleted(tx, event), { name: "m2-orders:order_completed" });
  on("trip.failed", (event, tx) => onTripFailed(tx, event), { name: "m2-orders:trip_failed" });
  on("credit_status.changed", (event, tx) => onCreditStatusChanged(tx, event), { name: "m2-orders:credit_hold_trips" });
}
