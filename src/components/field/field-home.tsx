"use client";

import { CircleAlert, RefreshCw, Send } from "lucide-react";
import { type ReactNode, useState } from "react";

import { enqueue, outboxStatusText, type FieldHome as FieldHomeRoute } from "@/client/offline";
import { useOutbox } from "@/client/offline/hooks";
import { formatJam } from "@/lib/time";
import { cn } from "@/lib/utils";

import { BigButton } from "./big-button";
import { FieldGate, useFieldSession } from "./field-gate";
import { FieldShell } from "./field-shell";
import { OutboxItemActions } from "@/components/field/outbox-item-actions";

export type FieldHomeProps = {
  /** Rute beranda perangkat ini. */
  home: FieldHomeRoute;
  title: string;
  /** Isi fungsional modul (rit hari ini, POS, produksi). */
  children?: ReactNode;
};

function Greeting() {
  const { user, device } = useFieldSession();
  return (
    <section className="rounded-xl border-2 bg-card p-4">
      <p className="text-lg font-semibold">Halo, {user.name}</p>
      <p className="text-base text-muted-foreground">
        {user.roleLabel}
        {device.unitLabel ? ` · ${device.unitLabel}` : ""}
      </p>
    </section>
  );
}

function OutboxList() {
  const { user } = useFieldSession();
  const items = useOutbox(user.id, 10);
  if (items.length === 0) {
    return <p className="rounded-xl border-2 border-dashed p-4 text-center text-base text-muted-foreground">Belum ada data yang dicatat.</p>;
  }
  return (
    <ul className="flex flex-col gap-2" aria-label="Data terakhir">
      {items.map((item) => (
        <li key={item.id} className="rounded-xl border-2 bg-card p-3" data-status={item.status}>
          <p className="text-base font-semibold">{item.label ?? item.type}</p>
          <p
            className={cn(
              "text-base",
              item.status === "rejected" ? "text-destructive" : item.status === "sent" ? "text-success" : "text-warning-foreground",
            )}
          >
            {outboxStatusText(item)} · {formatJam(new Date(item.createdAt))}
          </p>
            <OutboxItemActions item={item} />
        </li>
      ))}
    </ul>
  );
}

function Diagnostics() {
  const { sync } = useFieldSession();
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
            setNote(sync.online ? "Data uji dicatat dan sedang dikirim." : "Data uji tersimpan di ponsel. Terkirim otomatis saat ada sinyal.");
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

function HomeShell({ title, children }: { title: string; children?: ReactNode }) {
  const session = useFieldSession();
  const { sync } = session;
  return (
    <FieldShell
      title={title}
      userName={session.user.name}
      roleLabel={session.user.roleLabel}
      unitLabel={session.device.unitLabel ?? undefined}
      pendingCount={sync.pendingCount}
      syncing={sync.syncing}
      lastSyncedAt={sync.lastSyncAt ? new Date(sync.lastSyncAt) : null}
      onSyncNow={sync.syncNow}
      onLock={session.lock}
    >
      {session.updateRequired ? (
        <div role="alert" className="flex items-start gap-3 rounded-xl border-2 border-warning bg-warning/15 p-4">
          <CircleAlert className="size-6 shrink-0" aria-hidden />
          <div className="flex flex-col gap-2">
            <p className="text-base font-semibold">Versi aplikasi perlu diperbarui sebelum melanjutkan.</p>
            <BigButton variant="outline" icon={<RefreshCw aria-hidden />} onClick={() => window.location.reload()}>
              Perbarui sekarang
            </BigButton>
          </div>
        </div>
      ) : null}
      {sync.lastError && sync.online ? (
        <p role="alert" className="rounded-xl border-2 border-warning bg-warning/15 p-3 text-base">
          {sync.lastError}
        </p>
      ) : null}
      {sync.rejectedCount > 0 ? (
        <p role="alert" className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-3 text-base text-destructive">
          {sync.rejectedCount} data ditolak server. Lihat alasannya di daftar di bawah; hubungi Admin Keuangan bila perlu dicatat kantor.
        </p>
      ) : null}
      <Greeting />
      {children}
      <h2 className="text-lg font-bold">Data terakhir</h2>
      <OutboxList />
      <Diagnostics />
      <button
        type="button"
        onClick={session.switchUser}
        className="min-h-12 rounded-xl px-4 text-base font-semibold text-primary underline-offset-4 hover:underline"
      >
        Ganti pengguna (data Anda tetap tersimpan)
      </button>
    </FieldShell>
  );
}

/**
 * Beranda minimal aplikasi lapangan (sopir/POS/produksi): gerbang perangkat + PIN + kunci layar, pil status sinkron,
 * daftar status data ("tersimpan di ponsel"/"terkirim"/"ditolak"), uji kirim data. Modul mengisi `children`.
 */
export function FieldHomePage({ home, title, children }: FieldHomeProps) {
  return (
    <FieldGate home={home}>
      <HomeShell title={title}>{children}</HomeShell>
    </FieldGate>
  );
}
