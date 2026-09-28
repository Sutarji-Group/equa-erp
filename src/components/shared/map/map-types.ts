import type { LatLng } from "@/lib/geo";

export type MapTone = "primary" | "success" | "warning" | "danger" | "muted";

export type MapMarker = {
  id: string;
  position: LatLng;
  /** Label yang selalu tampil di samping titik (mis. nomor polisi truk). Teks di-escape. */
  label?: string;
  /** Teks popup saat titik diklik. */
  popup?: string;
  tone?: MapTone;
  onClick?: () => void;
};

export type MapPolyline = {
  id: string;
  positions: readonly LatLng[];
  tone?: MapTone;
  dashed?: boolean;
  weight?: number;
};

export type MapCircle = {
  id: string;
  center: LatLng;
  /** Radius geofence dalam meter. */
  radiusM: number;
  tone?: MapTone;
  label?: string;
};

export type MapViewProps = {
  markers?: readonly MapMarker[];
  polylines?: readonly MapPolyline[];
  circles?: readonly MapCircle[];
  /** Pusat awal bila tidak ada fitur untuk di-fit. Bawaan: Cianjur. */
  center?: LatLng;
  /** Zoom awal. Bawaan 12. */
  zoom?: number;
  /** Sesuaikan tampilan agar semua fitur terlihat (bawaan `true`). */
  fitBounds?: boolean;
  /** Tinggi peta (px atau nilai CSS). Bawaan 360. */
  height?: number | string;
  className?: string;
  /** Klik pada peta (mis. memilih koordinat). */
  onMapClick?: (position: LatLng) => void;
  /** URL ubin. Bawaan OpenStreetMap. */
  tileUrl?: string;
  attribution?: string;
  /** Label aksesibilitas peta. */
  ariaLabel?: string;
};

/** Pusat bawaan: Kabupaten Cianjur. */
export const DEFAULT_MAP_CENTER: LatLng = { lat: -6.8168, lng: 107.1425 };
export const DEFAULT_MAP_ZOOM = 12;
export const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** Semua titik fitur (untuk fitBounds). */
export function collectMapPoints(props: Pick<MapViewProps, "markers" | "polylines" | "circles">): LatLng[] {
  return [
    ...(props.markers ?? []).map((m) => m.position),
    ...(props.polylines ?? []).flatMap((p) => p.positions),
    ...(props.circles ?? []).map((c) => c.center),
  ];
}
