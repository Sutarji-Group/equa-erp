"use client";

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import { useEffect, useMemo } from "react";
import { Circle, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";

import type { LatLng } from "@/lib/geo";

import {
  collectMapPoints,
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  type MapTone,
  type MapViewProps,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
} from "./map-types";

const TONE_COLOR: Record<MapTone, string> = {
  primary: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--destructive)",
  muted: "var(--muted-foreground)",
};

/** Warna nyata untuk jalur/lingkaran SVG (Leaflet tidak selalu menerima var CSS pada atribut). */
const TONE_HEX: Record<MapTone, string> = {
  primary: "#1d4ed8",
  success: "#15803d",
  warning: "#d97706",
  danger: "#dc2626",
  muted: "#6b7280",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function markerIcon(tone: MapTone, label?: string): L.DivIcon {
  const color = TONE_COLOR[tone];
  const labelHtml = label
    ? `<span style="margin-left:6px;padding:1px 6px;border-radius:6px;background:var(--background);color:var(--foreground);border:1px solid var(--border);font:600 12px/1.4 var(--font-sans);white-space:nowrap;box-shadow:0 1px 2px rgb(0 0 0 / .15)">${escapeHtml(label)}</span>`
    : "";
  return L.divIcon({
    className: "equa-map-marker",
    html: `<div style="display:flex;align-items:center;transform:translate(-8px,-8px)"><span style="display:block;width:16px;height:16px;border-radius:9999px;background:${color};border:3px solid var(--background);box-shadow:0 0 0 1px rgb(0 0 0 / .35)"></span>${labelHtml}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    popupAnchor: [0, -10],
  });
}

function FitBounds({ points, enabled }: { points: LatLng[]; enabled: boolean }) {
  const map = useMap();
  const key = points.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join("|");
  useEffect(() => {
    if (!enabled || points.length === 0) return;
    if (points.length === 1) {
      map.setView([points[0]!.lat, points[0]!.lng], Math.max(map.getZoom(), 15));
      return;
    }
    map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), { padding: [32, 32], maxZoom: 16 });
    // `key` merangkum isi `points`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key, enabled]);
  return null;
}

function ClickHandler({ onMapClick }: { onMapClick: (p: LatLng) => void }) {
  useMapEvents({
    click(e) {
      onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

/** Implementasi Leaflet. Jangan impor langsung — pakai `MapView`/`MapPicker` (dimuat dinamis tanpa SSR). */
export default function LeafletMap({
  markers = [],
  polylines = [],
  circles = [],
  center = DEFAULT_MAP_CENTER,
  zoom = DEFAULT_MAP_ZOOM,
  fitBounds = true,
  height = 360,
  className,
  onMapClick,
  tileUrl = OSM_TILE_URL,
  attribution = OSM_ATTRIBUTION,
  ariaLabel = "Peta",
}: MapViewProps) {
  const points = useMemo(() => collectMapPoints({ markers, polylines, circles }), [markers, polylines, circles]);
  return (
    <div className={className} style={{ height }} role="region" aria-label={ariaLabel}>
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={zoom}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%", borderRadius: "inherit", zIndex: 0 }}
      >
        <TileLayer url={tileUrl} attribution={attribution} />
        {circles.map((c) => (
          <Circle
            key={c.id}
            center={[c.center.lat, c.center.lng]}
            radius={c.radiusM}
            pathOptions={{ color: TONE_HEX[c.tone ?? "primary"], weight: 2, fillOpacity: 0.12 }}
          >
            {c.label ? <Tooltip>{c.label}</Tooltip> : null}
          </Circle>
        ))}
        {polylines.map((p) => (
          <Polyline
            key={p.id}
            positions={p.positions.map((pt) => [pt.lat, pt.lng] as [number, number])}
            pathOptions={{ color: TONE_HEX[p.tone ?? "primary"], weight: p.weight ?? 4, dashArray: p.dashed ? "6 8" : undefined }}
          />
        ))}
        {markers.map((m) => (
          <Marker
            key={m.id}
            position={[m.position.lat, m.position.lng]}
            icon={markerIcon(m.tone ?? "primary", m.label)}
            title={m.label}
            eventHandlers={m.onClick ? { click: () => m.onClick?.() } : undefined}
          >
            {m.popup ? <Popup>{m.popup}</Popup> : null}
          </Marker>
        ))}
        <FitBounds points={points} enabled={fitBounds} />
        {onMapClick ? <ClickHandler onMapClick={onMapClick} /> : null}
      </MapContainer>
    </div>
  );
}
