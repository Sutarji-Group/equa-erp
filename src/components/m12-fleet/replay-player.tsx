"use client";

/**
 * Putar ulang jejak truk (US-M12-02 KP-5: 24 jam terakhir dari peta; US-M12-03 KP-3: jejak dapat diputar ulang).
 * Data dari `/api/gps/replay?truk=<id>&sampai=<ISO>` (izin `m12.position.read`); posisi disampel (tidak diekspor).
 */
import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { MapView, type MapMarker, type MapPolyline } from "@/components/shared/map/map-view";
import { Button } from "@/components/ui/button";
import { formatJam, formatTanggalJam } from "@/lib/time";

import { formatDuration } from "./ui";

export type ReplayJson = {
  truckId: string;
  truckCode: string;
  from: string;
  to: string;
  points: { t: string; lat: number; lng: number; speedKmh: number | null; source: string }[];
  statusPoints: { status: string; at: string; lat: number; lng: number; tripNumber: string }[];
  stops: { lat: number; lng: number; startedAt: string; endedAt: string; durationS: number; place: string | null }[];
};

const STATUS_TEXT: Record<string, string> = { departed: "Berangkat", arrived: "Tiba", completed: "Selesai", failed: "Gagal" };
const SPEEDS = [1, 5, 20] as const;

export function ReplayPlayer({ truckId, to, initial }: { truckId: string; to?: string; initial?: ReplayJson | null }) {
  const [data, setData] = useState<ReplayJson | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(5);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    const q = new URLSearchParams({ truk: truckId });
    if (to) q.set("sampai", to);
    fetch(`/api/gps/replay?${q.toString()}`, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { ok: boolean; replay?: ReplayJson; message?: string };
        if (!res.ok || !body.replay) throw new Error(body.message ?? "Putar ulang tidak dapat dimuat.");
        if (!cancelled) {
          setData(body.replay);
          setIndex(0);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error && e.message ? e.message : "Putar ulang tidak dapat dimuat.");
      });
    return () => {
      cancelled = true;
    };
  }, [truckId, to, initial]);

  const count = data?.points.length ?? 0;
  useEffect(() => {
    if (!playing || count === 0) return;
    const id = setInterval(() => {
      setIndex((i) => {
        const next = Math.min(count - 1, i + speed);
        if (next >= count - 1) setPlaying(false);
        return next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [playing, speed, count]);

  const polylines = useMemo<MapPolyline[]>(() => {
    if (!data || data.points.length < 2) return [];
    const all = data.points.map((p) => ({ lat: p.lat, lng: p.lng }));
    return [
      { id: "semua", positions: all, tone: "muted", dashed: true, weight: 3 },
      { id: "dilalui", positions: all.slice(0, index + 1), tone: "primary", weight: 4 },
    ];
  }, [data, index]);

  const markers = useMemo<MapMarker[]>(() => {
    if (!data) return [];
    const out: MapMarker[] = [];
    for (const [i, s] of data.stops.entries()) {
      out.push({ id: `stop-${i}`, position: { lat: s.lat, lng: s.lng }, tone: "warning", popup: `Berhenti ${formatDuration(s.durationS)} (${formatJam(s.startedAt)}–${formatJam(s.endedAt)})${s.place ? ` · ${s.place}` : ""}` });
    }
    for (const [i, s] of data.statusPoints.entries()) {
      out.push({ id: `status-${i}`, position: { lat: s.lat, lng: s.lng }, tone: s.status === "failed" ? "danger" : "success", popup: `${STATUS_TEXT[s.status] ?? s.status} ${s.tripNumber} · ${formatJam(s.at)}` });
    }
    const cur = data.points[index];
    if (cur) out.push({ id: "truk", position: { lat: cur.lat, lng: cur.lng }, tone: "primary", label: `${data.truckCode} ${formatJam(cur.t)}` });
    return out;
  }, [data, index]);

  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Memuat jejak…</p>;
  if (count === 0) return <p className="text-sm text-muted-foreground">Tidak ada posisi perangkat/ponsel pada {formatTanggalJam(data.from)} – {formatTanggalJam(data.to)}.</p>;
  const cur = data.points[index]!;

  return (
    <div className="grid gap-3" data-testid="putar-ulang">
      <MapView markers={markers} polylines={polylines} height={380} fitBounds={index === 0} ariaLabel={`Putar ulang truk ${data.truckCode}`} />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button type="button" size="sm" onClick={() => (index >= count - 1 ? (setIndex(0), setPlaying(true)) : setPlaying((p) => !p))}>
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
          {playing ? "Jeda" : "Putar"}
        </Button>
        <label className="flex items-center gap-2">
          Kecepatan
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])} className="h-8 rounded-md border border-input bg-background px-2">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <span className="tabular-nums">
          {formatTanggalJam(cur.t)} · {cur.speedKmh ?? 0} km/jam · {cur.source === "phone" ? "GPS ponsel" : "perangkat GPS"}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={count - 1}
        value={index}
        onChange={(e) => {
          setPlaying(false);
          setIndex(Number(e.target.value));
        }}
        aria-label="Waktu putar ulang"
        className="w-full"
      />
      <p className="text-xs text-muted-foreground">
        {formatTanggalJam(data.from)} – {formatTanggalJam(data.to)} · {count} posisi · {data.stops.length} titik berhenti · {data.statusPoints.length} titik status rit
      </p>
    </div>
  );
}
