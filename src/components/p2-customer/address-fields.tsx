"use client";

/**
 * Isian alamat kirim pelanggan (US-P2-01 KP-3): titik di peta (koordinat → zona & harga otomatis) + alamat lengkap +
 * catatan akses. Nilai titik dikirim lewat input tersembunyi `lat`/`lng`.
 */
import { useState } from "react";

import { MapPicker } from "@/components/shared/map/map-view";
import type { LatLng } from "@/lib/geo";

const CIANJUR: LatLng = { lat: -6.8172, lng: 107.1428 };

export function AddressFields({ required = true, defaultLabel = "Rumah" }: { required?: boolean; defaultLabel?: string }) {
  const [point, setPoint] = useState<LatLng | null>(null);
  return (
    <div className="grid gap-3">
      <div className="grid gap-1 text-sm font-medium">
        Titik alamat di peta
        <MapPicker value={point} onValueChange={setPoint} center={CIANJUR} height={260} />
        <span className="text-xs font-normal text-muted-foreground">Ketuk peta tepat di lokasi tandon/pintu masuk truk. Titik dikunci kantor setelah pengiriman pertama.</span>
      </div>
      <input type="hidden" name="lat" value={point ? String(point.lat) : ""} required={required} />
      <input type="hidden" name="lng" value={point ? String(point.lng) : ""} required={required} />
      <label className="grid gap-1 text-sm font-medium">
        Nama alamat
        <input name="label" defaultValue={defaultLabel} maxLength={60} className="h-11 rounded-md border border-input bg-background px-3 text-base" />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Alamat lengkap
        <textarea name="addressText" rows={2} required={required} placeholder="Jl. …, RT/RW, desa, kecamatan" className="rounded-md border border-input bg-background px-3 py-2 text-base" />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Catatan akses (opsional)
        <textarea name="notes" rows={2} placeholder="Mis. pagar hijau, truk masuk dari gang kiri, tandon di atap" className="rounded-md border border-input bg-background px-3 py-2 text-base" />
      </label>
    </div>
  );
}
