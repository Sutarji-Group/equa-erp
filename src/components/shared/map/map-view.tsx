"use client";

import { Crosshair, LoaderCircle, MapPin } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isValidLatLng, type LatLng } from "@/lib/geo";
import { cn } from "@/lib/utils";

import type { MapViewProps } from "./map-types";

export type { MapCircle, MapMarker, MapPolyline, MapTone, MapViewProps } from "./map-types";
export { DEFAULT_MAP_CENTER } from "./map-types";

/** Leaflet hanya di peramban (akses `window`) → dimuat dinamis tanpa SSR. */
const LeafletMap = dynamic(() => import("./leaflet-map"), {
  ssr: false,
  loading: () => <Skeleton className="size-full min-h-40 rounded-lg" aria-label="Memuat peta" />,
});

/**
 * Peta Leaflet + OpenStreetMap: titik berlabel, jalur (polyline), lingkaran geofence, dan fitBounds otomatis.
 * Contoh: `<MapView markers={[{ id, position, label: "F 1234 AB", tone: "success" }]} circles={[…]} />`.
 */
export function MapView({ className, height = 360, ...props }: MapViewProps) {
  return (
    <div className={cn("isolate overflow-hidden rounded-lg border", className)} style={{ height }}>
      <LeafletMap height="100%" {...props} />
    </div>
  );
}

export type MapPickerProps = {
  /** Koordinat terpilih. */
  value: LatLng | null;
  onValueChange: (value: LatLng) => void;
  /** Radius geofence yang digambar di sekitar titik (meter), mis. untuk sumber air/depot. */
  radiusM?: number;
  center?: LatLng;
  height?: number | string;
  /** Tampilkan tombol "Pakai lokasi saya" (GPS perangkat). Bawaan `true`. */
  allowGeolocation?: boolean;
  disabled?: boolean;
  className?: string;
};

/** Format koordinat untuk tampilan: `-6.816800, 107.142500`. */
export function formatLatLng(p: LatLng): string {
  return `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
}

/** Pemilih koordinat: klik peta untuk menaruh titik; opsional pakai GPS perangkat. */
export function MapPicker({
  value,
  onValueChange,
  radiusM,
  center,
  height = 320,
  allowGeolocation = true,
  disabled,
  className,
}: MapPickerProps) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const valid = isValidLatLng(value) ? value : null;

  function locateMe() {
    if (!("geolocation" in navigator)) {
      setGeoError("Perangkat ini tidak mendukung lokasi. Klik titik di peta.");
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onValueChange({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setGeoError("Lokasi tidak didapat. Aktifkan GPS/izin lokasi, atau klik titik di peta.");
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  return (
    <div className={cn("grid gap-2", className)}>
      <MapView
        height={height}
        center={center}
        markers={valid ? [{ id: "picked", position: valid, tone: "danger" }] : []}
        circles={valid && radiusM ? [{ id: "picked-radius", center: valid, radiusM, tone: "primary" }] : []}
        onMapClick={disabled ? undefined : onValueChange}
        ariaLabel="Peta pemilih titik lokasi. Klik untuk menaruh titik."
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <MapPin className="size-4" aria-hidden />
          {valid ? <span className="tabular text-foreground">{formatLatLng(valid)}</span> : "Klik peta untuk menaruh titik."}
        </span>
        {allowGeolocation && !disabled ? (
          <Button type="button" variant="outline" size="sm" onClick={locateMe} disabled={locating}>
            {locating ? <LoaderCircle className="animate-spin" aria-hidden /> : <Crosshair aria-hidden />}
            Pakai lokasi saya
          </Button>
        ) : null}
      </div>
      {geoError ? (
        <p role="alert" className="text-sm text-destructive">
          {geoError}
        </p>
      ) : null}
    </div>
  );
}
