"use client";

import { useState } from "react";

import { MapPicker } from "@/components/shared/map/map-view";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LatLng } from "@/lib/geo";

/**
 * Pemilih koordinat untuk formulir Server Action: klik peta (atau ketik lintang/bujur) → isian `lat`/`lng`.
 * Dikosongkan = alamat "Belum dikunci" (US-M1-01 KP-2).
 */
export function CoordinatePicker({ namePrefix = "", defaultValue = null, radiusM, height = 240, showMap = true }: { namePrefix?: string; defaultValue?: LatLng | null; radiusM?: number; height?: number; showMap?: boolean }) {
  const [value, setValue] = useState<LatLng | null>(defaultValue);
  const [open, setOpen] = useState(false);
  const latName = `${namePrefix}lat`;
  const lngName = `${namePrefix}lng`;
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`f-${latName}`}>Lintang</Label>
          <Input
            id={`f-${latName}`}
            name={latName}
            inputMode="decimal"
            placeholder="-6.8201"
            value={value ? String(value.lat) : ""}
            onChange={(e) => {
              const lat = Number(e.target.value.replace(",", "."));
              setValue(e.target.value === "" ? null : { lat: Number.isFinite(lat) ? lat : 0, lng: value?.lng ?? 107.14 });
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`f-${lngName}`}>Bujur</Label>
          <Input
            id={`f-${lngName}`}
            name={lngName}
            inputMode="decimal"
            placeholder="107.1402"
            value={value ? String(value.lng) : ""}
            onChange={(e) => {
              const lng = Number(e.target.value.replace(",", "."));
              setValue(e.target.value === "" ? null : { lat: value?.lat ?? -6.82, lng: Number.isFinite(lng) ? lng : 0 });
            }}
          />
        </div>
      </div>
      {showMap ? (
        open ? (
          <MapPicker value={value} onValueChange={setValue} radiusM={radiusM} height={height} />
        ) : (
          <button type="button" className="justify-self-start text-sm text-primary underline-offset-4 hover:underline" onClick={() => setOpen(true)}>
            Pilih titik di peta
          </button>
        )
      ) : null}
      {value ? (
        <button type="button" className="justify-self-start text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setValue(null)}>
          Kosongkan koordinat (Belum dikunci)
        </button>
      ) : null}
    </div>
  );
}
