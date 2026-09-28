/**
 * M12 — status truk di peta real-time (US-M12-02 KP-1). MURNI: diturunkan dari rit aktif (M3), lokasi sah yang memuat
 * posisi terakhir (geofence M1/PAR-54), gerak, rit tersisa hari itu, kejadian di luar jadwal yang masih terbuka, dan
 * status truk (Perbaikan).
 */
import type { EnumValue } from "../../../../lib/labels";

export type FleetLiveStatus = EnumValue<"fleet_live_status">;

export type LiveStatusInput = {
  maintenance: boolean;
  hasPosition: boolean;
  activeTrip: { status: "departed" | "arrived"; customerName: string; isInternal: boolean; destinationName: string | null } | null;
  /** Kejadian di luar jadwal/jam yang baru terdeteksi dan belum selesai (atau gerak di luar jam layanan). */
  offSchedule: boolean;
  location: { type: "water_source" | "outlet" | "pool"; name: string } | null;
  moving: boolean;
  /** Rit Ditugaskan yang belum dikerjakan hari ini. */
  remainingTrips: number;
};

export type LiveStatus = { status: FleetLiveStatus; detail: string };

/** Nada warna penanda truk per status (dipakai peta & lencana). */
export const LIVE_STATUS_TONE: Record<FleetLiveStatus, "primary" | "success" | "warning" | "danger" | "muted"> = {
  active_trip: "primary",
  arrived: "primary",
  heading_to_source: "success",
  at_source: "success",
  at_depot: "success",
  at_pool: "muted",
  returning_to_pool: "muted",
  stopped: "warning",
  off_schedule: "danger",
  maintenance: "muted",
  no_data: "muted",
};

export function deriveLiveStatus(i: LiveStatusInput): LiveStatus {
  if (i.activeTrip) {
    const dest = i.activeTrip.isInternal ? `pasokan ${i.activeTrip.destinationName ?? "depot"}` : i.activeTrip.customerName;
    return i.activeTrip.status === "arrived"
      ? { status: "arrived", detail: `Tiba di ${dest}` }
      : { status: "active_trip", detail: `Rit aktif ke ${dest}` };
  }
  if (i.maintenance) return { status: "maintenance", detail: "Truk berstatus Perbaikan" };
  if (!i.hasPosition) return { status: "no_data", detail: "Belum ada posisi" };
  if (i.offSchedule) return { status: "off_schedule", detail: "Bergerak di luar jadwal/jam — menunggu keterangan sopir" };
  if (i.location) {
    if (i.location.type === "water_source") return { status: "at_source", detail: `Di ${i.location.name}` };
    if (i.location.type === "outlet") return { status: "at_depot", detail: `Di ${i.location.name}` };
    return { status: "at_pool", detail: `Di ${i.location.name}` };
  }
  if (i.moving) {
    return i.remainingTrips > 0
      ? { status: "heading_to_source", detail: `Menuju sumber (${i.remainingTrips} rit tersisa)` }
      : { status: "returning_to_pool", detail: "Kembali ke pool (rit hari ini selesai)" };
  }
  return { status: "stopped", detail: "Berhenti di luar lokasi sah" };
}
