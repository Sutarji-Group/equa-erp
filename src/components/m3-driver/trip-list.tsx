"use client";

/**
 * Layar utama aplikasi sopir (US-M3-01 KP-1/KP-4/KP-5/KP-6, US-M3-07 KP-1): kas di tangan selalu tampil, kunci BR-10 /
 * PAR-83 + tombol hubungi Admin Keuangan, penanda baca-saja kernet, pembaruan jadwal, tugas keterangan perjalanan,
 * daftar rit (rit berikutnya ditonjolkan dengan tombol tindakan langsung; Selesai/Gagal turun ke bawah), status data.
 */
import { CircleAlert, MapPin, Phone, Send, Truck } from "lucide-react";
import { useState } from "react";

import { M3_COMMANDS, distanceToAddressM, isOutOfOrder, nextTrip, sortTripsForDriver, type M3TripRef } from "@/client/m3-driver/contract";
import { currentPosition, geoFailureText } from "@/client/m3-driver/geo";
import { enqueue, outboxStatusText } from "@/client/offline";
import { useOutbox } from "@/client/offline/hooks";
import { BigButton } from "@/components/field/big-button";
import { FieldListItem } from "@/components/field/field-list-item";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatJam } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useDriver } from "./driver-context";
import { Banner, ErrorText } from "./ui";
import { OutboxItemActions } from "@/components/field/outbox-item-actions";

const STATUS_TONE: Record<string, string> = {
  assigned: "bg-muted text-foreground",
  departed: "bg-primary text-primary-foreground",
  arrived: "bg-warning text-warning-foreground",
  completed: "bg-success text-success-foreground",
  failed: "bg-destructive text-destructive-foreground",
};

export function TripStatusBadge({ status }: { status: string }) {
  return <span className={cn("rounded-full px-2.5 py-0.5 text-sm font-semibold", STATUS_TONE[status] ?? "bg-muted")}>{label("trip_status", status)}</span>;
}

export function tripMeta(t: M3TripRef): string {
  return [
    `${t.plannedVolumeL.toLocaleString("id-ID")} L`,
    // B-65: rit prabayar digital tampil "Sudah dibayar" (sopir tidak menagih).
    t.isInternal ? "Internal" : t.paymentMethod === "digital" ? "Sudah dibayar" : label("payment_method", t.paymentMethod),
    t.requestedTime ? `jam ${t.requestedTime.replace(":", ".")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Tombol Berangkat/Tiba satu ketukan (dengan konfirmasi di luar urutan) — dipakai daftar & detail. */
export function useTripActions() {
  const { today, send, canAct, depositSubmitted } = useDriver();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const blockReason = (t: M3TripRef): string | null => {
    if (!canAct) return today?.readOnlyReason ?? "Anda hanya dapat melihat daftar rit.";
    if (t.status === "assigned") {
      if (today?.lock) return today.lock.message;
      if (depositSubmitted) return "Setoran hari ini sudah diajukan — tidak ada rit baru. Hubungi Admin Keuangan bila masih ada rit.";
      const active = today?.trips.find((x) => x.id !== t.id && (x.status === "departed" || x.status === "arrived"));
      if (active) return `Rit ${active.number} masih berjalan. Selesaikan atau tandai gagal dulu.`;
    }
    return null;
  };

  const depart = async (t: M3TripRef) => {
    setError(null);
    setNotice(null);
    const reason = blockReason(t);
    if (reason) return setError(reason);
    const outOfOrder = today ? isOutOfOrder(today.trips, t.id) : false;
    if (outOfOrder && !window.confirm(`Rit ${t.number} bukan rit berikutnya menurut urutan. Tetap berangkat? Urutan aktual tercatat untuk Dispatcher.`)) return;
    setBusy(t.id);
    try {
      const { location, failure } = await currentPosition();
      await send(M3_COMMANDS.depart, { tripId: t.id, location, outOfOrderConfirmed: outOfOrder }, `Berangkat ${t.number}`);
      setNotice(geoFailureText(failure));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mencatat. Coba lagi.");
    } finally {
      setBusy(null);
    }
  };

  const arrive = async (t: M3TripRef) => {
    setError(null);
    setNotice(null);
    setBusy(t.id);
    try {
      const { location, failure } = await currentPosition();
      await send(M3_COMMANDS.arrive, { tripId: t.id, location, clientDistanceM: distanceToAddressM(location, t) }, `Tiba ${t.number}`);
      setNotice(geoFailureText(failure));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mencatat. Coba lagi.");
    } finally {
      setBusy(null);
    }
  };

  return { busy, error, notice, depart, arrive, blockReason };
}

function PrimaryAction({ trip }: { trip: M3TripRef }) {
  const { go, canAct } = useDriver();
  const actions = useTripActions();
  if (!canAct) return null;
  return (
    <div className="flex flex-col gap-2">
      {trip.status === "assigned" ? (
        <BigButton icon={<Truck aria-hidden />} loading={actions.busy === trip.id} onClick={() => actions.depart(trip)} disabled={!!actions.blockReason(trip)}>
          Berangkat
        </BigButton>
      ) : trip.status === "departed" ? (
        <BigButton icon={<MapPin aria-hidden />} loading={actions.busy === trip.id} onClick={() => actions.arrive(trip)}>
          Tiba
        </BigButton>
      ) : trip.status === "arrived" ? (
        <BigButton variant="success" onClick={() => go({ name: "complete", tripId: trip.id })}>
          Selesai &amp; bayar
        </BigButton>
      ) : null}
      {actions.notice ? <Banner tone="warning">{actions.notice}</Banner> : null}
      <ErrorText>{actions.error}</ErrorText>
    </div>
  );
}

function OutboxList() {
  const { session } = useDriver();
  const items = useOutbox(session.user.id, 10);
  if (items.length === 0) {
    return <p className="rounded-xl border-2 border-dashed p-4 text-center text-base text-muted-foreground">Belum ada data yang dicatat.</p>;
  }
  return (
    <ul className="flex flex-col gap-2" aria-label="Data terakhir">
      {items.map((item) => (
        <li key={item.id} className="rounded-xl border-2 bg-card p-3" data-status={item.status}>
          <p className="text-base font-semibold">{item.label ?? item.type}</p>
          <p className={cn("text-base", item.status === "rejected" ? "text-destructive" : item.status === "sent" ? "text-success" : "text-warning-foreground")}>
            {outboxStatusText(item)} · {formatJam(new Date(item.createdAt))}
          </p>
            <OutboxItemActions item={item} />
        </li>
      ))}
    </ul>
  );
}

function TestSend() {
  const { session } = useDriver();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-3 rounded-xl border-2 p-4" aria-label="Uji kirim data">
      <p className="text-base">Uji apakah data dari ponsel ini sampai ke kantor. Data uji tetap tersimpan walau tanpa sinyal.</p>
      <BigButton
        variant="secondary"
        icon={<Send aria-hidden />}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await enqueue({ type: "core.ping", payload: {}, label: "Data uji" });
            setNote(session.sync.online ? "Data uji dicatat dan sedang dikirim." : "Data uji tersimpan di ponsel. Terkirim otomatis saat ada sinyal.");
          } catch (err) {
            setNote(err instanceof Error ? err.message : "Gagal mencatat data uji.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Kirim data uji
      </BigButton>
      {note ? (
        <p role="status" className="text-base">
          {note}
        </p>
      ) : null}
    </section>
  );
}

export function TripListView() {
  const { today, figures, go, canAct, depositSubmitted, session } = useDriver();
  if (today === undefined) return <Banner tone="info">Mengunduh rit hari ini… Pastikan ada sinyal saat pertama kali masuk.</Banner>;
  if (today === null) return <Banner tone="danger">Data rit belum tersedia untuk akun ini. Hubungi Dispatcher.</Banner>;
  const trips = sortTripsForDriver(today.trips);
  const next = nextTrip(today.trips);
  const updates = today.trips.filter((t) => t.update);
  const finance = today.financeContacts.find((f) => f.phone) ?? today.financeContacts[0];

  return (
    <div className="flex flex-col gap-4">
      {today.notices.map((n) => (
        <Banner key={n.id} tone={n.event === "deposit.driver_reminder" ? "warning" : "info"}>
          <strong>{n.title}.</strong> {n.body}
        </Banner>
      ))}
      {today.lock ? (
        <Banner tone="danger" role="alert" testId="kunci-setoran">
          <p className="flex items-start gap-2 font-semibold">
            <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
            {today.lock.kind === "br10" ? "Setoran kemarin belum ditutup Admin Keuangan" : "Menunggu keputusan pemilik atas selisih besar"}
          </p>
          <p className="mt-1">{today.lock.message}</p>
          {finance?.phone ? (
            <a href={`tel:${finance.phone}`} className="mt-2 inline-flex min-h-12 items-center gap-2 rounded-xl border-2 border-destructive/40 px-4 font-semibold">
              <Phone className="size-5" aria-hidden /> Hubungi Admin Keuangan ({finance.name})
            </a>
          ) : finance ? (
            <p className="mt-2 font-semibold">Hubungi Admin Keuangan: {finance.name}</p>
          ) : null}
        </Banner>
      ) : null}
      {!canAct ? <Banner tone="info">{today.readOnlyReason}</Banner> : null}
      {depositSubmitted ? (
        <Banner tone="success">
          Setoran {today.deposit?.number ?? "hari ini"} sudah diajukan{today.deposit?.local ? " (tersimpan di ponsel)" : ""}. Serahkan uang ke Admin Keuangan.
        </Banner>
      ) : null}

      {canAct && figures ? (
        <button type="button" onClick={() => go({ name: "setor" })} className="flex items-center justify-between gap-3 rounded-2xl border-2 border-primary bg-primary/5 p-4 text-left" data-testid="kas-di-tangan">
          <span>
            <span className="block text-base text-muted-foreground">Kas di tangan</span>
            <span className="block text-2xl font-bold tabular-nums">{formatRupiah(figures.cashOnHand)}</span>
          </span>
          <span className="text-base font-semibold text-primary">Setor ›</span>
        </button>
      ) : null}

      {today.explanationTasks.length > 0 && canAct ? (
        <Banner tone="warning">
          <button type="button" className="text-left font-semibold underline" onClick={() => go({ name: "tasks" })}>
            {today.explanationTasks.length} keterangan perjalanan diminta — isi hari ini.
          </button>
        </Banner>
      ) : null}

      {updates.length > 0 || today.withdrawn.length > 0 ? (
        <Banner tone="info" testId="jadwal-diperbarui">
          <p className="font-semibold">Jadwal diperbarui Dispatcher</p>
          <ul className="mt-1 list-disc pl-5">
            {updates.map((t) => (
              <li key={t.id}>
                Rit {t.number}: {t.update!.summary.join("; ")}
              </li>
            ))}
            {today.withdrawn.map((w) => (
              <li key={w.tripId}>
                Rit {w.number} ({w.customerName}) ditarik dari jadwal.
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <section aria-label="Rit hari ini" className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">
          Rit hari ini{today.truck ? ` · ${today.truck.code}` : ""} ({trips.filter((t) => t.status === "completed" || t.status === "failed").length}/{trips.length} selesai)
        </h2>
        {trips.length === 0 ? <p className="rounded-xl border-2 border-dashed p-4 text-center text-base text-muted-foreground">Belum ada rit terbit untuk hari ini.</p> : null}
        <ol className="flex flex-col gap-2">
          {trips.map((t) => (
            <li key={t.id} className="flex flex-col gap-2" data-testid={`rit-${t.number}`}>
              <FieldListItem
                leading={t.routeOrder ?? "–"}
                title={t.isInternal ? `Internal — ${t.destinationOutletName ?? "Depot"}` : t.customerName}
                subtitle={`${t.number} · ${t.addressShort}`}
                meta={tripMeta(t)}
                highlight={next?.id === t.id}
                muted={t.status === "completed" || t.status === "failed"}
                status={<TripStatusBadge status={t.status} />}
                flags={
                  <>
                    {t.hasSpecialNotes ? <span className="rounded-full bg-warning/30 px-2 py-0.5 text-sm font-semibold">Catatan khusus</span> : null}
                    {t.update ? <span className="rounded-full bg-primary/15 px-2 py-0.5 text-sm font-semibold">Diperbarui</span> : null}
                    {t.collectUnderpayment ? <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-sm font-semibold">Tagih kurang bayar</span> : null}
                    {t.local ? <span className="rounded-full bg-muted px-2 py-0.5 text-sm">Tersimpan di ponsel</span> : null}
                  </>
                }
                onClick={() => go({ name: "trip", tripId: t.id })}
              />
              {next?.id === t.id ? <PrimaryAction trip={t} /> : null}
            </li>
          ))}
        </ol>
      </section>

      <h2 className="text-lg font-bold">Data terakhir</h2>
      <OutboxList />
      <TestSend />
      <button type="button" onClick={session.switchUser} className="min-h-12 rounded-xl px-4 text-base font-semibold text-primary underline-offset-4 hover:underline">
        Ganti pengguna (data Anda tetap tersimpan)
      </button>
    </div>
  );
}

export { OutboxList };
