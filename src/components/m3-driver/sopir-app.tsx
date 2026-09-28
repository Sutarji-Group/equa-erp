"use client";

/**
 * Aplikasi Sopir/Kernet (M3, PWA offline-first): gerbang perangkat + PIN (FieldGate), daftar rit hari ini, detail &
 * tindakan rit, Selesai + pembayaran, pelunasan, gagal/kendala, keterangan perjalanan, pengeluaran, Setor & riwayat,
 * bantuan (antrean data + laporan kendala aplikasi). Semua aksi dicatat ke outbox lalu tersinkron otomatis.
 * GPS ponsel cadangan hanya berjalan bila server menandai pelacakan ponsel untuk truk & ada rit aktif (US-M3-02 KP-5).
 */
import { CircleAlert, History, LifeBuoy, ListChecks, NotebookPen, RefreshCw, Wallet } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { activeTrip } from "@/client/m3-driver/contract";
import { startBackupGps } from "@/client/m3-driver/geo";
import { BigButton } from "@/components/field/big-button";
import { FieldGate } from "@/components/field/field-gate";
import { FieldShell } from "@/components/field/field-shell";
import { FieldSupportPanel } from "@/components/m10-access/field-support-panel";
import { cn } from "@/lib/utils";

import { CompleteFlow } from "./complete-flow";
import { HistoryView, SetorView } from "./deposit-view";
import { DriverProvider, useDriver, type DriverView } from "./driver-context";
import { CollectForm, ExpenseForm, FailForm, IncidentForm, ReceiptView, TasksView } from "./forms";
import { TripDetailView } from "./trip-detail";
import { OutboxList, TripListView } from "./trip-list";
import { Banner } from "./ui";

const NAV: { view: DriverView["name"]; label: string; icon: typeof Wallet }[] = [
  { view: "list", label: "Rit", icon: ListChecks },
  { view: "setor", label: "Setor", icon: Wallet },
  { view: "tasks", label: "Keterangan", icon: NotebookPen },
  { view: "history", label: "Riwayat", icon: History },
  { view: "help", label: "Bantuan", icon: LifeBuoy },
];

function BackupGps() {
  const { today } = useDriver();
  const active = today ? activeTrip(today.trips) : null;
  const enabled = !!today?.gpsTracking.enabled && !!today.gpsTracking.truckId && !!active && today.actingRole !== "readonly";
  const truckId = today?.gpsTracking.truckId ?? null;
  const tripId = active?.id ?? null;
  const interval = today?.gpsTracking.intervalS ?? 60;
  useEffect(() => {
    if (!enabled || !truckId) return;
    return startBackupGps({ truckId, tripId, intervalS: interval });
  }, [enabled, truckId, tripId, interval]);
  return enabled ? <p className="text-sm text-muted-foreground">GPS ponsel cadangan aktif selama rit berjalan.</p> : null;
}

function HelpView() {
  const { session } = useDriver();
  return (
    <div className="flex flex-col gap-4">
      <FieldSupportPanel />
      <h2 className="text-lg font-bold">Data di ponsel</h2>
      <OutboxList />
      <BigButton variant="secondary" icon={<RefreshCw aria-hidden />} onClick={session.sync.syncNow} disabled={!session.sync.online}>
        Kirim sekarang
      </BigButton>
    </div>
  );
}

function Screen() {
  const { session, view, go, today } = useDriver();
  const sync = session.sync;
  let body: ReactNode;
  let title = "Aplikasi Sopir";
  switch (view.name) {
    case "trip":
      body = <TripDetailView tripId={view.tripId} />;
      break;
    case "complete":
      body = <CompleteFlow tripId={view.tripId} />;
      break;
    case "fail":
      body = <FailForm tripId={view.tripId} />;
      break;
    case "incident":
      body = <IncidentForm tripId={view.tripId} />;
      break;
    case "collect":
      body = <CollectForm tripId={view.tripId} />;
      break;
    case "receipt":
      body = <ReceiptView tripId={view.tripId} />;
      break;
    case "setor":
      body = <SetorView />;
      break;
    case "expense":
      body = <ExpenseForm tripId={view.tripId} />;
      break;
    case "tasks":
      body = <TasksView />;
      break;
    case "history":
      body = <HistoryView />;
      break;
    case "help":
      body = <HelpView />;
      break;
    default:
      body = <TripListView />;
  }
  if (view.name !== "list") title = NAV.find((n) => n.view === view.name)?.label ?? "Aplikasi Sopir";
  const back = view.name === "list" ? undefined : () => go(view.name === "complete" || view.name === "fail" || view.name === "collect" ? { name: "trip", tripId: view.tripId } : { name: "list" });
  const footer = (
    <nav aria-label="Menu sopir" className="grid grid-cols-5 gap-1">
      {NAV.map((n) => (
        <button
          key={n.view}
          type="button"
          onClick={() => go({ name: n.view } as DriverView)}
          aria-current={view.name === n.view ? "page" : undefined}
          className={cn(
            "relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-sm font-semibold focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none",
            view.name === n.view ? "bg-primary text-primary-foreground" : "hover:bg-accent",
          )}
        >
          <n.icon className="size-6" aria-hidden />
          {n.label}
          {n.view === "tasks" && today?.explanationTasks.length ? <span className="absolute top-1 right-2 rounded-full bg-warning px-1.5 text-xs text-warning-foreground">{today.explanationTasks.length}</span> : null}
        </button>
      ))}
    </nav>
  );
  return (
    <FieldShell
      title={view.name === "list" ? "Aplikasi Sopir" : title}
      userName={session.user.name}
      roleLabel={today?.actingRole === "substitute" ? "Kernet pengganti" : session.user.roleLabel}
      unitLabel={today?.truck?.code ?? session.device.unitLabel ?? undefined}
      pendingCount={sync.pendingCount}
      syncing={sync.syncing}
      lastSyncedAt={sync.lastSyncAt ? new Date(sync.lastSyncAt) : null}
      onSyncNow={sync.syncNow}
      onLock={session.lock}
      onBack={back}
      footer={footer}
    >
      {session.updateRequired ? (
        <Banner tone="warning" role="alert">
          <span className="flex items-center gap-2">
            <CircleAlert className="size-5" aria-hidden /> Versi aplikasi perlu diperbarui.{" "}
            <button type="button" className="font-semibold underline" onClick={() => window.location.reload()}>
              Perbarui sekarang
            </button>
          </span>
        </Banner>
      ) : null}
      {sync.lastError && sync.online ? <Banner tone="warning">{sync.lastError}</Banner> : null}
      {sync.rejectedCount > 0 ? (
        <Banner tone="danger" role="alert">
          {sync.rejectedCount} data ditolak server. Lihat alasannya di Bantuan → Data di ponsel; hubungi Admin Keuangan bila perlu dicatat kantor.
        </Banner>
      ) : null}
      <BackupGps />
      {body}
    </FieldShell>
  );
}

/** Aplikasi sopir: `/sopir`. */
export function SopirApp() {
  return (
    <FieldGate home="/sopir">
      <DriverProvider>
        <Screen />
      </DriverProvider>
    </FieldGate>
  );
}
