"use client";

/**
 * Aplikasi Operator Produksi (M8, PWA offline-first, PRD 7.8): gerbang perangkat + PIN (FieldGate), layar Hari ini
 * (meter pagi/malam, pengisian, tugas), catat meter (3 langkah + foto), isi truk (3 langkah), level tandon,
 * investigasi susut, hasil uji mutu, riwayat, dan Bantuan (laporan kendala aplikasi + antrean data, B-03). Semua aksi
 * dicatat ke outbox lalu tersinkron otomatis; data referensi `m8.today` diunduh saat login (US-M8-07).
 */
import { CircleAlert, Gauge, History, Home, LifeBuoy, LoaderCircle, RefreshCw, Truck } from "lucide-react";
import type { ReactNode } from "react";

import { outboxStatusText, useOutbox } from "@/client/offline";
import { BigButton } from "@/components/field/big-button";
import { FieldGate } from "@/components/field/field-gate";
import { FieldShell } from "@/components/field/field-shell";
import { FieldSupportPanel } from "@/components/m10-access/field-support-panel";
import { formatJam } from "@/lib/time";
import { cn } from "@/lib/utils";

import { FillFlow } from "./fill-flow";
import { InvestigationForm, QualityForm, TankForm } from "./forms";
import { HistoryView } from "./history-view";
import { MeterFlow } from "./meter-flow";
import { ProductionProvider, useProduction, type ProductionView } from "./production-context";
import { TodayView } from "./today-view";
import { Banner } from "./ui";

const NAV: { view: "today" | "meter" | "fill" | "history" | "help"; label: string; icon: typeof Home }[] = [
  { view: "today", label: "Hari ini", icon: Home },
  { view: "meter", label: "Meter", icon: Gauge },
  { view: "fill", label: "Isi truk", icon: Truck },
  { view: "history", label: "Riwayat", icon: History },
  { view: "help", label: "Bantuan", icon: LifeBuoy },
];

const TITLES: Record<ProductionView["name"], string> = {
  today: "Produksi Air",
  meter: "Catat meter",
  fill: "Isi truk",
  tank: "Level tandon",
  investigation: "Investigasi susut",
  quality: "Hasil uji mutu",
  history: "Riwayat",
  help: "Bantuan",
};

/** Data di antrean ponsel pengguna ini dengan status per item (NFR-08). */
function OutboxList() {
  const { session } = useProduction();
  const items = useOutbox(session.user.id, 15);
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
        </li>
      ))}
    </ul>
  );
}

function HelpView() {
  const { session } = useProduction();
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
  const { session, view, viewKey, go, today, ready } = useProduction();
  const sync = session.sync;
  let body: ReactNode;
  if (today === undefined) {
    body = (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <LoaderCircle className="size-10 animate-spin text-primary" aria-hidden />
        <p className="text-lg">Mengunduh data sumber air… Pastikan ada sinyal saat pertama kali masuk.</p>
      </div>
    );
  } else if (!ready && view.name !== "help") {
    body = (
      <Banner tone="danger" role="alert" testId="aplikasi-terkunci">
        {today.blockedReason ?? "Ponsel ini belum dapat dipakai untuk mencatat produksi."}
      </Banner>
    );
  } else {
    switch (view.name) {
      case "meter":
        body = <MeterFlow key={viewKey} meterId={view.meterId} phase={view.phase} />;
        break;
      case "fill":
        body = <FillFlow key={viewKey} truckId={view.truckId} />;
        break;
      case "tank":
        body = <TankForm key={viewKey} />;
        break;
      case "investigation":
        body = <InvestigationForm key={viewKey} waterBalanceId={view.waterBalanceId} />;
        break;
      case "quality":
        body = <QualityForm key={viewKey} scheduleId={view.scheduleId} />;
        break;
      case "history":
        body = <HistoryView />;
        break;
      case "help":
        body = <HelpView />;
        break;
      default:
        body = <TodayView />;
    }
  }
  const footer = (
    <nav aria-label="Menu produksi" className="grid grid-cols-5 gap-1">
      {NAV.map((n) => (
        <button
          key={n.view}
          type="button"
          onClick={() => go({ name: n.view })}
          aria-current={view.name === n.view ? "page" : undefined}
          className={cn(
            "relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-base font-semibold focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none",
            view.name === n.view ? "bg-primary text-primary-foreground" : "hover:bg-accent",
          )}
        >
          <n.icon className="size-6" aria-hidden />
          {n.label}
          {n.view === "today" && today?.investigations.some((i) => i.status === "over_threshold") ? (
            <span className="absolute top-1 right-2 rounded-full bg-destructive px-1.5 text-sm text-destructive-foreground" aria-label="Ada tugas">
              !
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
  return (
    <FieldShell
      title={TITLES[view.name]}
      userName={session.user.name}
      roleLabel={session.user.roleLabel}
      unitLabel={today?.source?.name ?? session.device.unitLabel ?? undefined}
      pendingCount={sync.pendingCount}
      syncing={sync.syncing}
      lastSyncedAt={sync.lastSyncAt ? new Date(sync.lastSyncAt) : null}
      onSyncNow={sync.syncNow}
      onLock={session.lock}
      onBack={view.name === "today" ? undefined : () => go({ name: "today" })}
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
          {sync.rejectedCount} data ditolak server. Lihat alasannya di Bantuan → Data di ponsel; hubungi Admin Keuangan bila perlu dikoreksi kantor.
        </Banner>
      ) : null}
      {body}
    </FieldShell>
  );
}

/** Aplikasi operator produksi: `/produksi`. */
export function ProduksiApp() {
  return (
    <FieldGate home="/produksi">
      <ProductionProvider>
        <Screen />
      </ProductionProvider>
    </FieldGate>
  );
}
