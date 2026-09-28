"use client";

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Lock, RefreshCw, Send, Undo2, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type DragEvent, type ReactNode, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  assignTripAction,
  moveTripAction,
  publishAction,
  publishAllAction,
  resolveConflictAction,
  suggestOrderAction,
  unassignTripAction,
} from "@/app/(office)/jadwal/actions";
import { ConfirmWithReasonDialog } from "@/components/shared/confirm-with-reason-dialog";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MapView, type MapMarker } from "@/components/shared/map/map-view";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatJam, formatTanggal } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Board, BoardLane, BoardTrip } from "@/server/modules/m2-orders";

import type { ActionState } from "./action-state";
import { ActionButton, ReasonActionButton } from "./action-buttons";
import { SELECT_CLASS } from "./fields";

/** Interval pembaruan status real-time (≤ 30 detik, US-M2-03 KP-6). */
const REFRESH_MS = 20_000;

function notify(r: ActionState) {
  if (r.error) toast.error(r.error);
  else {
    if (r.message) toast.success(r.message);
    for (const w of r.warnings ?? []) toast.warning(w);
  }
}

/**
 * Papan jadwal rit harian (US-M2-03): jalur per truk (kru hari itu, kapasitas vs terjadwal, status terbit, kunci BR-10),
 * kolom "Belum terjadwal" (termasuk tanggal lewat), seret-lepas HTML5 + tombol alternatif untuk ponsel, terbitkan,
 * status rit real-time (pembaruan tiap 20 detik) dan peta posisi truk terakhir berdampingan.
 */
export function ScheduleBoard({ board }: { board: Board }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [withdraw, setWithdraw] = useState<BoardTrip | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [router]);

  const allTrips = [...board.unscheduled, ...board.lanes.flatMap((l) => l.trips)];
  const findTrip = (id: string) => allTrips.find((t) => t.id === id) ?? null;
  const receivingLanes = board.lanes.filter((l) => l.canReceive);

  function run(fn: () => Promise<ActionState>) {
    start(async () => notify(await fn()));
  }

  function onDropLane(e: DragEvent, lane: BoardLane, position?: number) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(null);
    const tripId = e.dataTransfer.getData("text/plain");
    if (!tripId || !board.canEdit) return;
    run(() => assignTripAction({ tripId, truckId: lane.truck.id, date: board.date, position: position ?? null }));
  }

  function onDropUnscheduled(e: DragEvent) {
    e.preventDefault();
    setDragging(null);
    const trip = findTrip(e.dataTransfer.getData("text/plain"));
    if (!trip || !board.canEdit || trip.status !== "assigned" || !board.lanes.some((l) => l.trips.some((t) => t.id === trip.id))) return;
    if (trip.published) setWithdraw(trip);
    else run(() => unassignTripAction(trip.id, null));
  }

  const markers: MapMarker[] = [
    ...board.lanes
      .filter((l) => l.lastPosition)
      .map((l) => ({
        id: `truck-${l.truck.id}`,
        position: { lat: l.lastPosition!.lat, lng: l.lastPosition!.lng },
        label: l.truck.code,
        popup: `${l.truck.code} ${l.truck.plateNumber} · posisi ${formatJam(l.lastPosition!.at)}`,
        tone: "primary" as const,
      })),
    ...board.lanes.flatMap((l) =>
      l.trips
        .filter((t) => t.lat != null && t.lng != null)
        .map((t) => ({
          id: `trip-${t.id}`,
          position: { lat: t.lat!, lng: t.lng! },
          popup: `${t.number} · ${t.customerName} · ${label("trip_status", t.status)}`,
          tone: (t.status === "completed" ? "success" : t.status === "failed" ? "danger" : "muted") as MapMarker["tone"],
        })),
    ),
  ];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2" aria-label="Pilih tanggal">
          <Button asChild variant="outline" size="icon" aria-label="Hari sebelumnya">
            <Link href={`/jadwal?tanggal=${addDays(board.date, -1)}`}>
              <ChevronLeft aria-hidden />
            </Link>
          </Button>
          <form method="get" className="flex items-center gap-2">
            <input type="date" name="tanggal" defaultValue={board.date} aria-label="Tanggal papan" className={cn(SELECT_CLASS, "w-40")} />
            <Button type="submit" variant="outline" size="sm">
              Buka
            </Button>
          </form>
          <Button asChild variant="outline" size="icon" aria-label="Hari berikutnya">
            <Link href={`/jadwal?tanggal=${addDays(board.date, 1)}`}>
              <ChevronRight aria-hidden />
            </Link>
          </Button>
          {board.date !== board.today ? (
            <Button asChild variant="ghost" size="sm">
              <Link href="/jadwal">Hari ini</Link>
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Diperbarui {formatJam(board.generatedAt, { seconds: true })} · otomatis tiap 20 detik
          </span>
          <Button variant="ghost" size="icon" aria-label="Muat ulang" onClick={() => router.refresh()}>
            <RefreshCw aria-hidden />
          </Button>
          {board.canPublish ? <ActionButton label="Terbitkan semua" icon={<Send aria-hidden />} action={() => publishAllAction(board.date)} /> : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile label="Kapasitas rit hari ini" value={String(board.totals.capacity)} hint="Σ truk beroperasi (PAR-33)" />
        <KpiTile label="Terjadwal" value={`${board.totals.scheduled}`} hint={`${board.totals.customer} pelanggan · ${board.totals.internal} internal`} tone={board.totals.overCapacity ? "warning" : undefined} />
        <KpiTile label="Belum terjadwal" value={String(board.totals.unscheduled)} tone={board.totals.unscheduled ? "warning" : "success"} />
        <KpiTile label="Lewat tanggal" value={String(board.totals.overdue)} tone={board.totals.overdue ? "danger" : undefined} />
        <KpiTile label="Konflik lapangan" value={String(board.conflicts.length)} tone={board.conflicts.length ? "danger" : undefined} />
      </div>
      {board.totals.overCapacity ? <p className="text-sm text-warning-foreground">Terjadwal melebihi kapasitas harian — diperingatkan, tidak diblokir.</p> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
          <section
            aria-label="Belum terjadwal"
            className={cn("grid content-start gap-2 rounded-lg border-2 border-dashed p-3", board.unscheduled.length ? "border-warning/60 bg-warning/5" : "border-border", dragging && "ring-2 ring-ring")}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDropUnscheduled}
          >
            <h2 className="flex items-center justify-between text-sm font-semibold">
              Belum terjadwal <ToneBadge tone={board.unscheduled.length ? "warning" : "success"}>{board.unscheduled.length}</ToneBadge>
            </h2>
            {board.unscheduled.length === 0 ? <p className="text-sm text-muted-foreground">Semua rit sudah punya truk.</p> : null}
            {board.unscheduled.map((t) => (
              <TripCard key={t.id} trip={t} date={board.date} draggable={board.canEdit} onDragStart={setDragging}>
                {board.canEdit ? (
                  <AssignControl trip={t} lanes={receivingLanes} disabled={busy} onAssign={(truckId) => run(() => assignTripAction({ tripId: t.id, truckId, date: board.date }))} />
                ) : null}
              </TripCard>
            ))}
          </section>

          <div className="grid content-start gap-4 lg:grid-cols-2">
            {board.lanes.map((lane) => (
              <section
                key={lane.truck.id}
                aria-label={`Truk ${lane.truck.code}`}
                className={cn("grid content-start gap-2 rounded-lg border bg-card p-3", !lane.canReceive && "bg-muted/40", dragging && lane.canReceive && "ring-2 ring-ring/50")}
                onDragOver={(e) => lane.canReceive && e.preventDefault()}
                onDrop={(e) => onDropLane(e, lane)}
              >
                <LaneHeader lane={lane} date={board.date} canEdit={board.canEdit} canPublish={board.canPublish} busy={busy} />
                {lane.trips.length === 0 ? <p className="text-sm text-muted-foreground">{lane.canReceive ? "Seret rit ke sini atau pilih truk di kartu rit." : lane.cannotReceiveReason}</p> : null}
                <ol className="grid gap-2">
                  {lane.trips.map((t, i) => (
                    <li key={t.id} onDragOver={(e) => lane.canReceive && e.preventDefault()} onDrop={(e) => onDropLane(e, lane, i + 1)}>
                      <TripCard trip={t} date={board.date} draggable={board.canEdit && t.status === "assigned"} onDragStart={setDragging} showOrder>
                        {board.canEdit && t.status === "assigned" ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <ActionButton label="Naikkan" size="icon" variant="ghost" icon={<ArrowUp aria-hidden />} disabled={busy || i === 0} action={() => moveTripAction(t.id, "up")} />
                            <ActionButton label="Turunkan" size="icon" variant="ghost" icon={<ArrowDown aria-hidden />} disabled={busy || i === lane.trips.length - 1} action={() => moveTripAction(t.id, "down")} />
                            {t.published ? (
                              <ReasonActionButton label="Tarik" title={`Tarik ${t.number} dari jadwal terbit?`} description="Perubahan setelah terbit tercatat dan dikirim saat diterbitkan ulang." icon={<Undo2 aria-hidden />} variant="ghost" action={(reason) => unassignTripAction(t.id, reason)} />
                            ) : (
                              <ActionButton label="Tarik" variant="ghost" icon={<Undo2 aria-hidden />} action={() => unassignTripAction(t.id, null)} />
                            )}
                            <AssignControl trip={t} lanes={receivingLanes.filter((l) => l.truck.id !== lane.truck.id)} disabled={busy} compact onAssign={(truckId) => run(() => assignTripAction({ tripId: t.id, truckId, date: board.date }))} />
                          </div>
                        ) : null}
                      </TripCard>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        </div>

        <aside className="grid content-start gap-3">
          <section aria-label="Peta truk" className="grid gap-2">
            <h2 className="text-sm font-semibold">Posisi truk terakhir & alamat rit</h2>
            <MapView markers={markers} height={360} ariaLabel="Peta posisi truk dan alamat rit" />
            <p className="text-xs text-muted-foreground">Posisi dari perangkat GPS/ponsel (M12). Titik abu = alamat rit, hijau = Selesai, merah = Gagal.</p>
          </section>
          {board.conflicts.length ? (
            <section aria-label="Konflik lapangan" className="grid gap-2 rounded-lg border border-destructive/40 p-3">
              <h2 className="text-sm font-semibold text-destructive">Konflik lapangan (Bab 6.4)</h2>
              {board.conflicts.map((t) => (
                <div key={t.id} className="grid gap-1 text-sm">
                  <p>
                    <Link href={`/pesanan/${t.orderId}`} className="font-medium underline">
                      {t.number}
                    </Link>{" "}
                    · {t.customerName} · {label("trip_status", t.status)}
                  </p>
                  <p className="text-xs text-muted-foreground">{t.syncConflictNote}</p>
                  {board.canEdit ? <ReasonActionButton label="Tandai ditindaklanjuti" title="Tindak lanjut konflik" description="Rit lapangan tetap sah; catat tindak lanjut." action={(reason) => resolveConflictAction(t.id, reason)} /> : null}
                </div>
              ))}
            </section>
          ) : null}
        </aside>
      </div>

      <ConfirmWithReasonDialog
        open={!!withdraw}
        onOpenChange={(o) => !o && setWithdraw(null)}
        title={withdraw ? `Tarik ${withdraw.number} dari jadwal terbit?` : "Tarik rit"}
        description="Perubahan setelah terbit tercatat; terbitkan ulang agar aplikasi sopir menerima pembaruan."
        confirmLabel="Tarik rit"
        onConfirm={async ({ reason }) => {
          const r = await unassignTripAction(withdraw!.id, reason);
          if (r.error) throw new Error(r.error);
          notify(r);
          setWithdraw(null);
        }}
      />
    </div>
  );
}

function LaneHeader({ lane, date, canEdit, canPublish, busy }: { lane: BoardLane; date: string; canEdit: boolean; canPublish: boolean; busy: boolean }) {
  const s = lane.schedule;
  const hasOpen = lane.trips.some((t) => t.status === "assigned" && !t.published);
  return (
    <header className="grid gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          {lane.truck.code} <span className="text-xs font-normal text-muted-foreground">{lane.truck.plateNumber}</span>
        </h2>
        <div className="flex flex-wrap gap-1">
          {!s ? <ToneBadge tone="muted">Kosong</ToneBadge> : s.status === "draft" ? <ToneBadge tone="warning">Draf</ToneBadge> : s.pendingChanges || hasOpen ? <ToneBadge tone="warning">Ada perubahan</ToneBadge> : <ToneBadge tone="success">Terbit{s.version ? ` rev. ${s.version}` : ""}</ToneBadge>}
          {lane.dayStatus === "maintenance" ? <ToneBadge tone="danger">Perbaikan</ToneBadge> : null}
        </div>
      </div>
      <p className="text-sm">
        {lane.crew.driverName ? (
          <>
            Sopir: <span className="font-medium">{lane.crew.driverName}</span>
            {lane.crew.substitute ? <ToneBadge tone="info" className="ml-1">Pengganti ({label("crew_assignment_source", lane.crew.assignmentSource)})</ToneBadge> : null}
            {lane.crew.helperName ? <span className="text-muted-foreground"> · Kernet {lane.crew.helperName}</span> : null}
          </>
        ) : (
          <span className="text-destructive">Tanpa sopir hari ini</span>
        )}
      </p>
      {lane.crew.substitute && lane.crew.reason ? <p className="text-xs text-muted-foreground">Alasan: {lane.crew.reason}{lane.crew.assignedByName ? ` · ${lane.crew.assignedByName}` : ""}</p> : null}
      {lane.crew.lock ? (
        <p className="flex items-start gap-1 rounded-md bg-destructive/10 p-1.5 text-xs text-destructive" role="status">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Rit terkunci di aplikasi sopir (BR-10): {lane.crew.lockMessage}
        </p>
      ) : null}
      <p className={cn("text-xs", lane.overCapacity ? "font-medium text-warning-foreground" : "text-muted-foreground")}>
        {lane.counts.total}/{lane.capacityTrips} rit ({lane.counts.customer} pelanggan, {lane.counts.internal} internal) · {lane.volumeL.toLocaleString("id-ID")}/{lane.capacityVolumeL.toLocaleString("id-ID")} L
        {lane.overCapacity ? " · melebihi kapasitas" : ""}
        {lane.lastPosition ? ` · posisi ${formatJam(lane.lastPosition.at)}` : ""}
      </p>
      {!lane.canReceive && lane.cannotReceiveReason ? <p className="text-xs text-destructive">{lane.cannotReceiveReason}</p> : null}
      {(canEdit || canPublish) && lane.trips.length ? (
        <div className="flex flex-wrap gap-1">
          {canPublish && lane.canReceive ? <ActionButton label="Terbitkan" size="sm" icon={<Send aria-hidden />} disabled={busy} action={() => publishAction(lane.truck.id, date)} /> : null}
          {canEdit ? <ActionButton label="Urutan BR-21" size="sm" variant="outline" icon={<Wand2 aria-hidden />} disabled={busy} action={() => suggestOrderAction(lane.truck.id, date)} /> : null}
        </div>
      ) : null}
    </header>
  );
}

function TripCard({
  trip,
  date,
  draggable,
  onDragStart,
  showOrder,
  children,
}: {
  trip: BoardTrip;
  date: string;
  draggable: boolean;
  onDragStart: (id: string | null) => void;
  showOrder?: boolean;
  children?: ReactNode;
}) {
  const blocked = trip.blockers.length > 0;
  return (
    <article
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", trip.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(trip.id);
      }}
      onDragEnd={() => onDragStart(null)}
      className={cn(
        "grid gap-1 rounded-md border bg-background p-2 text-sm shadow-xs",
        draggable && "cursor-grab active:cursor-grabbing",
        trip.overdue && "border-destructive/50 bg-destructive/5",
        trip.status === "completed" && "opacity-70",
      )}
      data-trip={trip.number}
      aria-label={`Rit ${trip.number}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-1">
        <div className="min-w-0">
          <p className="font-medium">
            {showOrder && trip.routeOrder ? <span className="mr-1 inline-flex size-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">{trip.routeOrder}</span> : null}
            <Link href={`/pesanan/${trip.orderId}`} className="underline-offset-4 hover:underline">
              {trip.number}
            </Link>
          </p>
          <p className="truncate">{trip.customerName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {trip.addressLabel} · {trip.addressText}
          </p>
        </div>
        <StatusBadge enumName="trip_status" value={trip.status} />
      </div>
      <p className="text-xs text-muted-foreground">
        {trip.requestedTime ? `Jam ${trip.requestedTime.replace(":", ".")}` : trip.fixedReceiveTime ? `Jam terima ${trip.fixedReceiveTime.replace(":", ".")}` : "Tanpa jam"} · {label("payment_method", trip.paymentMethod)} · {formatRupiah(trip.price)}
        {trip.scheduledDate !== date ? ` · ${formatTanggal(trip.scheduledDate, { weekday: false })}` : ""}
      </p>
      <div className="flex flex-wrap gap-1">
        {trip.overdue ? <ToneBadge tone="danger">Lewat tanggal</ToneBadge> : null}
        {trip.isInternal ? <ToneBadge tone="info">Internal</ToneBadge> : null}
        {trip.recurring ? <ToneBadge tone="info">Langganan</ToneBadge> : null}
        {trip.published ? <ToneBadge tone="success">Terbit</ToneBadge> : null}
        {trip.possibleDuplicate ? <ToneBadge tone="warning">Kemungkinan dobel</ToneBadge> : null}
        {trip.needsReschedule ? <ToneBadge tone="danger">Perlu jadwal ulang</ToneBadge> : null}
        {trip.needsReassignment ? <ToneBadge tone="danger">Pindahkan truk</ToneBadge> : null}
        {trip.reconfirmationPending ? <ToneBadge tone="danger">Konfirmasi ulang</ToneBadge> : null}
        {trip.collectUnderpayment ? <ToneBadge tone="warning">Tagih kurang bayar</ToneBadge> : null}
        {trip.provisionalPrice ? <ToneBadge tone="warning">Harga sementara</ToneBadge> : null}
        {trip.creditHold ? <ToneBadge tone="danger">Pelanggan Ditahan</ToneBadge> : null}
        {trip.orderStatus === "awaiting_approval" ? <ToneBadge tone="warning">Menunggu persetujuan</ToneBadge> : null}
        {trip.syncConflict ? <ToneBadge tone="danger">Konflik</ToneBadge> : null}
      </div>
      {trip.customerNotes || trip.notes ? <p className="text-xs">Catatan: {[trip.customerNotes, trip.notes].filter(Boolean).join(" · ")}</p> : null}
      {blocked ? <p className="text-xs text-destructive">{trip.blockers.map((b) => b.message).join(" ")}</p> : null}
      {children}
    </article>
  );
}

function AssignControl({ trip, lanes, disabled, compact, onAssign }: { trip: BoardTrip; lanes: BoardLane[]; disabled: boolean; compact?: boolean; onAssign: (truckId: string) => void }) {
  const [truckId, setTruckId] = useState("");
  const hardBlocked = trip.blockers.some((b) => b.code !== "provisional_price" && b.code !== "credit_hold");
  if (hardBlocked || lanes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select aria-label={`Truk untuk ${trip.number}`} className={cn(SELECT_CLASS, "h-8 w-auto text-xs")} value={truckId} onChange={(e) => setTruckId(e.target.value)}>
        <option value="">{compact ? "Pindah ke…" : "Pilih truk…"}</option>
        {lanes.map((l) => (
          <option key={l.truck.id} value={l.truck.id}>
            {l.truck.code} ({l.counts.total}/{l.capacityTrips})
          </option>
        ))}
      </select>
      <Button type="button" size="sm" variant="outline" className="h-8" disabled={disabled || !truckId} onClick={() => onAssign(truckId)}>
        {compact ? "Pindah" : "Tugaskan"}
      </Button>
    </div>
  );
}
