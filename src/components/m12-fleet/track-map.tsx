"use client";

/**
 * Peta jejak statis (riwayat rit / truk per hari, rincian kejadian — US-M12-03, US-M12-04 KP-3 "peta kecil"): jalur
 * disederhanakan, titik berhenti ≥ PAR-49, titik status rit, lingkaran tujuan (alamat/depot, radius PAR-16), titik
 * kejadian & posisi perangkat GPS pembanding.
 */
import { MapView, type MapCircle, type MapMarker, type MapPolyline } from "@/components/shared/map/map-view";
import { formatJam } from "@/lib/time";

import { formatDuration } from "./ui";

export type TrackMapProps = {
  path?: readonly [number, number][];
  /** Jalur hanya dari titik status (jarak estimasi) — digambar putus-putus. */
  estimated?: boolean;
  stops?: readonly { lat: number; lng: number; startedAt: string; endedAt: string; durationS: number; place: string | null }[];
  statusPoints?: readonly { status: string; at: string | Date; lat: number; lng: number }[];
  target?: { lat: number; lng: number; label: string; radiusM?: number } | null;
  point?: { lat: number; lng: number; label: string } | null;
  devicePoint?: { lat: number; lng: number; label: string } | null;
  height?: number;
  ariaLabel?: string;
};

const STATUS_TEXT: Record<string, string> = { departed: "Berangkat", arrived: "Tiba", completed: "Selesai", failed: "Gagal" };

export function TrackMap({ path = [], estimated = false, stops = [], statusPoints = [], target, point, devicePoint, height = 360, ariaLabel = "Peta jejak" }: TrackMapProps) {
  const polylines: MapPolyline[] = path.length >= 2 ? [{ id: "jejak", positions: path.map(([lat, lng]) => ({ lat, lng })), tone: "primary", dashed: estimated, weight: 4 }] : [];
  const markers: MapMarker[] = [
    ...stops.map((s, i) => ({
      id: `stop-${i}`,
      position: { lat: s.lat, lng: s.lng },
      tone: "warning" as const,
      popup: `Berhenti ${formatDuration(s.durationS)} (${formatJam(s.startedAt)}–${formatJam(s.endedAt)})${s.place ? ` · ${s.place}` : ""}`,
    })),
    ...statusPoints.map((s, i) => ({
      id: `status-${i}`,
      position: { lat: s.lat, lng: s.lng },
      tone: (s.status === "failed" ? "danger" : "success") as MapMarker["tone"],
      label: STATUS_TEXT[s.status] ?? s.status,
      popup: `${STATUS_TEXT[s.status] ?? s.status} ${formatJam(s.at)}`,
    })),
    ...(point ? [{ id: "kejadian", position: { lat: point.lat, lng: point.lng }, tone: "danger" as const, label: point.label }] : []),
    ...(devicePoint ? [{ id: "perangkat", position: { lat: devicePoint.lat, lng: devicePoint.lng }, tone: "primary" as const, label: devicePoint.label }] : []),
    ...(target ? [{ id: "tujuan", position: { lat: target.lat, lng: target.lng }, tone: "muted" as const, label: target.label }] : []),
  ];
  const circles: MapCircle[] = target?.radiusM ? [{ id: "tujuan-radius", center: { lat: target.lat, lng: target.lng }, radiusM: target.radiusM, tone: "muted", label: target.label }] : [];
  if (polylines.length === 0 && markers.length === 0) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Tidak ada posisi untuk digambar.</p>;
  }
  return <MapView polylines={polylines} markers={markers} circles={circles} height={height} ariaLabel={ariaLabel} />;
}
