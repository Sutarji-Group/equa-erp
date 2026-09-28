"use client";

/**
 * Peta posisi truk real-time (US-M12-02). Snapshot awal dari server, lalu diperbarui berkala dari `/api/gps/live`
 * (interval = `refreshSeconds` ≤ 60 detik, PAR-26; berhenti saat tab tersembunyi). Posisi > PAR-48 menit ditandai "basi".
 * Klik truk → rit hari ini & statusnya, rit berikutnya, perkiraan jarak & waktu tiba (penyedia rute), kontak sopir, tautan
 * riwayat & putar ulang 24 jam. Lapisan: alamat rit hari ini, sumber air, depot, pool, zona tarif (opsional).
 * Hanya dirender untuk peran berizin `m12.position.read` (halaman & API memeriksa izin).
 */
import { Crosshair, History, MessageCircle, Phone, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { KpiTile } from "@/components/shared/kpi-tile";
import { MapView, type MapCircle, type MapMarker } from "@/components/shared/map/map-view";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { formatJam, formatTanggal } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { FleetSnapshot, LiveTruck } from "@/server/modules/m12-fleet";

import { ReplayPlayer } from "./replay-player";
import { formatAge, LiveStatusBadge, waLink } from "./ui";

type Layers = { trips: boolean; sources: boolean; depots: boolean; pools: boolean; zones: boolean };

const LAYER_LABELS: Record<keyof Layers, string> = {
  trips: "Alamat rit hari ini",
  sources: "Sumber air",
  depots: "Depot",
  pools: "Pool",
  zones: "Zona tarif",
};

export function FleetLiveMap({ initial, compact = false, selectedTruckId = null }: { initial: FleetSnapshot; compact?: boolean; selectedTruckId?: string | null }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [selected, setSelected] = useState<string | null>(selectedTruckId);
  const [layers, setLayers] = useState<Layers>({ trips: true, sources: true, depots: !compact, pools: true, zones: false });
  const [fit, setFit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [replayFor, setReplayFor] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    setLoading(true);
    try {
      const res = await fetch(`/api/gps/live?tanggal=${snapshot.date}`, { cache: "no-store" });
      const body = (await res.json()) as { ok: boolean; snapshot?: FleetSnapshot; message?: string };
      if (!res.ok || !body.snapshot) throw new Error(body.message ?? "Peta tidak dapat diperbarui.");
      setSnapshot(body.snapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Peta tidak dapat diperbarui. Periksa koneksi internet.");
    } finally {
      setLoading(false);
    }
  }, [snapshot.date]);

  useEffect(() => {
    timer.current = setInterval(refresh, Math.max(15, snapshot.refreshSeconds) * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer.current) clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, snapshot.refreshSeconds]);

  // Sesuaikan tampilan hanya sekali (dan saat diminta) agar pembaruan berkala tidak mengubah zoom pengguna.
  useEffect(() => {
    if (!fit) return;
    const id = setTimeout(() => setFit(false), 1200);
    return () => clearTimeout(id);
  }, [fit]);

  const truck = snapshot.trucks.find((t) => t.truckId === selected) ?? null;

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    for (const t of snapshot.trucks) {
      if (!t.position) continue;
      out.push({
        id: `truck-${t.truckId}`,
        position: { lat: t.position.lat, lng: t.position.lng },
        label: `${t.code}${t.stale ? " · basi" : ""}`,
        popup: `${t.code} ${t.plateNumber} — ${t.statusDetail}. Posisi ${formatJam(t.position.at)}${t.position.speedKmh != null ? `, ${t.position.speedKmh} km/jam` : ""}.`,
        tone: t.stale ? "muted" : t.tone,
        onClick: () => setSelected(t.truckId),
      });
    }
    if (layers.trips) {
      for (const t of snapshot.trucks) {
        for (const trip of t.trips) {
          if (trip.lat == null || trip.lng == null) continue;
          out.push({
            id: `trip-${trip.id}`,
            position: { lat: trip.lat, lng: trip.lng },
            popup: `${trip.number} · ${trip.isInternal ? `Pasokan ${trip.destinationName ?? "depot"}` : trip.customerName} · ${trip.statusLabel} (truk ${t.code})`,
            tone: trip.status === "completed" ? "success" : trip.status === "failed" ? "danger" : trip.status === "assigned" ? "muted" : "primary",
          });
        }
      }
    }
    return out;
  }, [snapshot, layers.trips]);

  const circles = useMemo<MapCircle[]>(() => {
    const out: MapCircle[] = [];
    if (layers.sources) for (const s of snapshot.layers.sources) out.push({ id: `src-${s.id}`, center: { lat: s.lat, lng: s.lng }, radiusM: s.radiusM, tone: "success", label: `Sumber air ${s.name}` });
    if (layers.depots) for (const d of snapshot.layers.depots) out.push({ id: `dep-${d.id}`, center: { lat: d.lat, lng: d.lng }, radiusM: d.radiusM, tone: "primary", label: `Depot ${d.name}` });
    if (layers.pools) for (const p of snapshot.layers.pools) out.push({ id: `pool-${p.id}`, center: { lat: p.lat, lng: p.lng }, radiusM: p.radiusM, tone: "muted", label: `Pool ${p.name}` });
    if (layers.zones) for (const z of snapshot.layers.zoneRings) out.push({ id: `zone-${z.id}`, center: z.center, radiusM: z.radiusM, tone: "warning", label: z.label });
    return out;
  }, [snapshot.layers, layers]);

  const c = snapshot.counts;
  const updated = formatJam(snapshot.generatedAt, { seconds: true });

  return (
    <div className="grid gap-4" data-testid="fleet-live-map">
      {!compact ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiTile label="Truk" value={String(c.total)} />
          <KpiTile label="Rit aktif" value={String(c.activeTrip)} />
          <KpiTile label="Bergerak" value={String(c.moving)} />
          <KpiTile label="Posisi basi" value={String(c.stale)} hint={`> ${snapshot.staleAfterMinutes} menit (PAR-48)`} tone={c.stale ? "warning" : undefined} />
          <KpiTile label="Tanpa posisi" value={String(c.noData)} tone={c.noData ? "warning" : undefined} />
          <KpiTile label="Di luar jadwal" value={String(c.offSchedule)} tone={c.offSchedule ? "danger" : undefined} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground" aria-live="polite">
          {formatTanggal(snapshot.date)} · diperbarui {updated} WIB · otomatis tiap {snapshot.refreshSeconds} detik
          {snapshot.inServiceHours ? "" : " · di luar jam layanan"}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn(loading && "animate-spin")} aria-hidden />
          Perbarui
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setFit(true)}>
          <Crosshair aria-hidden />
          Tampilkan semua truk
        </Button>
        {error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : null}
      </div>

      <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <legend className="sr-only">Lapisan peta</legend>
        {(Object.keys(LAYER_LABELS) as (keyof Layers)[]).map((k) => (
          <label key={k} className="flex items-center gap-2">
            <input type="checkbox" className="size-4" checked={layers[k]} onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} />
            {LAYER_LABELS[k]}
            {k === "zones" ? <span className="text-xs text-muted-foreground">(perkiraan)</span> : null}
          </label>
        ))}
      </fieldset>

      <div className={cn("grid gap-4", compact ? "lg:grid-cols-[1fr_320px]" : "lg:grid-cols-[1fr_380px]")}>
        <MapView markers={markers} circles={circles} fitBounds={fit} height={compact ? 380 : 540} ariaLabel="Peta posisi truk" />
        <div className="grid content-start gap-3">
          {truck ? (
            <TruckDetail truck={truck} date={snapshot.date} onClose={() => setSelected(null)} onReplay={() => setReplayFor(truck.truckId)} />
          ) : (
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Klik truk di peta atau di daftar untuk melihat rit hari ini, perkiraan tiba, dan kontak sopir.</p>
          )}
          <ul className="grid gap-2" aria-label="Daftar truk">
            {snapshot.trucks.map((t) => (
              <li key={t.truckId}>
                <button
                  type="button"
                  onClick={() => setSelected(t.truckId)}
                  className={cn("grid w-full gap-1 rounded-lg border p-2 text-left text-sm hover:bg-muted/50", selected === t.truckId && "border-primary ring-1 ring-primary")}
                  data-testid={`truk-${t.code}`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{t.code}</span>
                    <LiveStatusBadge status={t.status} tone={t.tone} />
                    {t.stale ? <ToneBadge tone="warning">Basi</ToneBadge> : null}
                    {t.phoneTracking ? <ToneBadge tone="info">GPS ponsel</ToneBadge> : null}
                    {t.openEvents ? <ToneBadge tone="danger">{t.openEvents} keterangan</ToneBadge> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t.statusDetail} · {t.driverName ?? "sopir belum ditetapkan"} · {t.position ? `${t.position.speedKmh ?? 0} km/jam · ${formatAge(t.ageMinutes)}` : "belum ada posisi"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {replayFor ? (
        <div className="grid gap-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold">Putar ulang 24 jam — {snapshot.trucks.find((t) => t.truckId === replayFor)?.code}</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => setReplayFor(null)}>
              Tutup
            </Button>
          </div>
          <ReplayPlayer truckId={replayFor} />
        </div>
      ) : null}
    </div>
  );
}

function TruckDetail({ truck, date, onClose, onReplay }: { truck: LiveTruck; date: string; onClose: () => void; onReplay: () => void }) {
  const wa = waLink(truck.driverPhone);
  return (
    <section className="grid gap-3 rounded-lg border p-3 text-sm" aria-label={`Rincian truk ${truck.code}`} data-testid="rincian-truk">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          {truck.code} <span className="font-normal text-muted-foreground">{truck.plateNumber}</span>
        </h3>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Tutup
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <LiveStatusBadge status={truck.status} tone={truck.tone} />
        <span>{truck.statusDetail}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Posisi</dt>
        <dd>{truck.position ? `${formatJam(truck.position.at)} (${formatAge(truck.ageMinutes)})${truck.stale ? " — basi" : ""}` : "—"}</dd>
        <dt className="text-muted-foreground">Kecepatan</dt>
        <dd>{truck.position?.speedKmh != null ? `${truck.position.speedKmh} km/jam` : "—"}</dd>
        <dt className="text-muted-foreground">Sumber posisi</dt>
        <dd>{truck.position ? (truck.position.source === "phone" ? "GPS ponsel (cadangan)" : truck.position.source === "gps_device" ? "Perangkat GPS" : "Titik status rit") : "—"}</dd>
        <dt className="text-muted-foreground">Sopir hari ini</dt>
        <dd>{truck.driverName ?? "—"}</dd>
      </dl>
      {truck.driverPhone ? (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={`tel:${truck.driverPhone}`}>
              <Phone aria-hidden />
              Telepon sopir
            </a>
          </Button>
          {wa ? (
            <Button asChild variant="outline" size="sm">
              <a href={wa} target="_blank" rel="noreferrer">
                <MessageCircle aria-hidden />
                WA sopir
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}
      {truck.eta ? (
        <p className="rounded-md bg-muted/60 p-2" data-testid="perkiraan-tiba">
          Ke <strong>{truck.eta.destination}</strong>: ± {truck.eta.km.toLocaleString("id-ID")} km, ± {truck.eta.minutes} menit
          {truck.eta.estimated ? <span className="block text-xs text-muted-foreground">Perkiraan garis lurus × 1,3 (layanan rute tidak aktif).</span> : null}
        </p>
      ) : null}
      <div className="grid gap-1">
        <h4 className="font-medium">Rit hari ini ({truck.trips.length})</h4>
        {truck.trips.length === 0 ? (
          <p className="text-muted-foreground">Tidak ada rit terbit.</p>
        ) : (
          <ol className="grid gap-1">
            {truck.trips.map((trip) => (
              <li key={trip.id} className={cn("flex flex-wrap items-center gap-2", truck.activeTrip?.id === trip.id && "font-medium")}>
                <span>{trip.routeOrder ?? "–"}.</span>
                <Link href={`/pesanan/${trip.orderId}`} className="text-primary hover:underline">
                  {trip.number}
                </Link>
                <span>{trip.isInternal ? `Pasokan ${trip.destinationName ?? "depot"}` : trip.customerName}</span>
                <ToneBadge tone={trip.status === "completed" ? "success" : trip.status === "failed" ? "danger" : trip.status === "assigned" ? "neutral" : "info"}>{trip.statusLabel}</ToneBadge>
                {truck.nextTrip?.id === trip.id ? <ToneBadge tone="neutral">Berikutnya</ToneBadge> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href={`/armada/riwayat/truk/${truck.truckId}?tanggal=${date}`}>
            <History aria-hidden />
            Riwayat hari ini
          </Link>
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onReplay}>
          <Play aria-hidden />
          Putar ulang 24 jam
        </Button>
      </div>
    </section>
  );
}
