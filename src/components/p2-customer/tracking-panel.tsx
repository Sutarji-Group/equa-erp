"use client";

/**
 * Peta posisi truk untuk pelanggan (US-P2-03 KP-2/KP-3/KP-5; PTB-54): hanya selama pengiriman Berangkat menuju alamat
 * pelanggan; disegarkan berkala dari `/api/customer/lacak/<pesanan>`; tanpa posisi segar → "Posisi sementara tidak
 * tersedia". Tombol hubungi mengarah ke kantor, bukan ke sopir.
 */
import { Phone, Truck } from "lucide-react";
import { useEffect, useState } from "react";

import { MapView } from "@/components/shared/map/map-view";
import { Button } from "@/components/ui/button";

export type TrackingJson =
  | { active: false; message: string; officePhone: string; refreshSeconds: number }
  | {
      active: true;
      tripId: string;
      truckPlate: string | null;
      driverFirstName: string | null;
      destination: { lat: number; lng: number } | null;
      position: { lat: number; lng: number; at: string } | null;
      message: string | null;
      eta: { minutes: number; km: number; estimated: boolean } | null;
      officePhone: string;
      refreshSeconds: number;
    };

export function TrackingPanel({ orderId, initial }: { orderId: string; initial: TrackingJson }) {
  const [data, setData] = useState<TrackingJson>(initial);
  useEffect(() => {
    if (!data.active) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/customer/lacak/${orderId}`, { cache: "no-store" });
        if (res.ok) setData((await res.json()) as TrackingJson);
      } catch {
        // jaringan putus: pertahankan tampilan terakhir tanpa posisi baru
      }
    }, Math.max(5, data.refreshSeconds) * 1000);
    return () => clearInterval(timer);
  }, [orderId, data.active, data.refreshSeconds]);

  const tel = `tel:${data.officePhone.replace(/[^0-9+]/g, "")}`;
  if (!data.active) {
    return (
      <div className="grid gap-2 text-sm" data-testid="tracking-inactive">
        <p className="text-muted-foreground">{data.message}</p>
        <Button asChild variant="outline" size="sm" className="w-fit">
          <a href={tel}>
            <Phone aria-hidden /> Hubungi kantor EQUA
          </a>
        </Button>
      </div>
    );
  }
  const markers = [
    ...(data.position ? [{ id: "truck", position: { lat: data.position.lat, lng: data.position.lng }, label: data.truckPlate ?? "Truk", tone: "primary" as const }] : []),
    ...(data.destination ? [{ id: "home", position: data.destination, label: "Alamat Anda", tone: "success" as const }] : []),
  ];
  return (
    <div className="grid gap-3" data-testid="tracking-active">
      <div className="flex items-center gap-2 text-sm">
        <Truck className="size-5 text-primary" aria-hidden />
        <span>
          <strong>{data.truckPlate ?? "Truk EQUA"}</strong>
          {data.driverFirstName ? ` · sopir ${data.driverFirstName}` : ""}
        </span>
      </div>
      {data.position ? (
        <MapView markers={markers} height={240} ariaLabel="Peta posisi truk menuju alamat Anda" />
      ) : (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" role="status">
          {data.message ?? "Posisi sementara tidak tersedia."}
        </p>
      )}
      {data.eta ? (
        <p className="text-sm">
          Perkiraan tiba sekitar <strong>{data.eta.minutes} menit</strong> ({data.eta.km.toLocaleString("id-ID")} km{data.eta.estimated ? ", perkiraan" : ""}).
        </p>
      ) : null}
      <Button asChild variant="outline" size="sm" className="w-fit">
        <a href={tel}>
          <Phone aria-hidden /> Hubungi kantor EQUA
        </a>
      </Button>
    </div>
  );
}
