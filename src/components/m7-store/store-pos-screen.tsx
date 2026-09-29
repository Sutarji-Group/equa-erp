"use client";

import { ClipboardList, History, LifeBuoy, Lightbulb, Package, PackagePlus, ShoppingCart } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { StoreCartPrefill } from "@/client/m7-store/contract";
import { PosHelpView } from "@/components/m6-pos/help-view";
import { HistoryView } from "@/components/m6-pos/history-view";
import { usePos } from "@/components/m6-pos/pos-context";
import { CloseShiftForm, OpenShiftView, PartialDepositForm, ShiftSales } from "@/components/m6-pos/shift-view";
import { Banner } from "@/components/m6-pos/ui";
import { PosShell } from "@/components/pos/pos-shell";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import { cn } from "@/lib/utils";

import { PartnerOrdersPanel, usePendingPartnerOrders } from "./partner-orders-panel";
import { StoreProvider, useStore } from "./store-context";
import { StoreProposalsView } from "./store-proposals-view";
import { StoreReceiveView } from "./store-receive-view";
import { StoreReceiptView, StoreSaleView, type SavedStoreSale } from "./store-sale-view";
import { StoreStockView } from "./store-stock-view";

type View = "jual" | "shift" | "terima" | "stok" | "usulan" | "riwayat" | "bantuan";

const NAV: { view: View; label: string; icon: typeof ShoppingCart }[] = [
  { view: "jual", label: "Jual", icon: ShoppingCart },
  { view: "shift", label: "Shift & kas", icon: ClipboardList },
  { view: "terima", label: "Terima barang", icon: PackagePlus },
  { view: "stok", label: "Stok & opname", icon: Package },
  { view: "usulan", label: "Usulan", icon: Lightbulb },
  { view: "riwayat", label: "Riwayat", icon: History },
  // B-03 (US-M10-07 KP-3): laporan kendala aplikasi & status sinkron (sama dengan POS depot).
  { view: "bantuan", label: "Bantuan", icon: LifeBuoy },
];

function StoreScreen() {
  const { session, ref, shift, figures, today } = usePos();
  const { store } = useStore();
  const [view, setView] = useState<View>("jual");
  const [lastSale, setLastSale] = useState<SavedStoreSale | null>(null);
  // B-73: keranjang terisi dari pesanan spare part portal mitra (`p3.store_partner_orders`).
  const [prefill, setPrefill] = useState<StoreCartPrefill | null>(null);
  const partnerOrders = usePendingPartnerOrders();
  const sync = session.sync;
  const pendingApprovals = (store?.recentSales ?? []).filter((s) => s.status === "pending_approval").length;

  const header = (
    <nav aria-label="Menu POS toko" className="flex flex-wrap gap-2">
      {NAV.map((n) => (
        <button
          key={n.view}
          type="button"
          onClick={() => setView(n.view)}
          aria-current={view === n.view ? "page" : undefined}
          className={cn(
            "inline-flex min-h-12 items-center gap-2 rounded-xl border-2 px-3 text-base font-semibold focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none",
            view === n.view ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
          )}
        >
          <n.icon className="size-5" aria-hidden />
          {n.label}
          {n.view === "stok" && store?.reorder.length ? <span className="rounded-full bg-warning px-2 text-sm text-warning-foreground">{store.reorder.length}</span> : null}
          {n.view === "jual" && partnerOrders.length ? (
            <span className="rounded-full bg-warning px-2 text-sm text-warning-foreground" aria-label={`${partnerOrders.length} pesanan mitra menunggu`}>
              {partnerOrders.length}
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );

  let body: ReactNode;
  if (view === "terima") body = <StoreReceiveView />;
  else if (view === "stok") body = <StoreStockView />;
  else if (view === "usulan") body = <StoreProposalsView />;
  else if (view === "riwayat") body = <HistoryView />;
  else if (view === "bantuan") body = <PosHelpView />;
  else if (!shift) body = <OpenShiftView />;
  else if (view === "shift") {
    body = (
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border-2 bg-card p-4">
            <h2 className="text-lg font-bold">Transaksi shift ini</h2>
            <p className="text-base text-muted-foreground">
              Kas di laci {formatRupiah(figures?.expectedDrawer ?? 0)} · tempo & QRIS tidak masuk kas fisik · void hari ini {ref?.voidsToday ?? 0}
            </p>
            <div className="mt-3">
              <ShiftSales onReplace={() => setView("jual")} />
            </div>
          </section>
          <PartialDepositForm />
        </div>
        <CloseShiftForm onClosed={() => setView("riwayat")} />
      </div>
    );
  } else {
    const stale = shift.businessDate < today ? `Shift tanggal ${formatTanggal(shift.businessDate)} belum ditutup. Tutup dulu di menu "Shift & kas" sebelum berjualan.` : null;
    body = (
      <div className="flex flex-col gap-4">
        {figures && ref && figures.expectedDrawer > ref.settings.cashLimit ? (
          <Banner tone="danger" role="alert">
            Kas di laci {formatRupiah(figures.expectedDrawer)} melebihi batas {formatRupiah(ref.settings.cashLimit)}.{" "}
            <button type="button" className="font-semibold underline" onClick={() => setView("shift")}>
              Setor sebagian
            </button>
          </Banner>
        ) : null}
        {pendingApprovals ? <Banner tone="warning">{pendingApprovals} transaksi menunggu persetujuan pemilik (diskon/tempo). Barang diserahkan setelah disetujui.</Banner> : null}
        {lastSale ? null : (
          <PartnerOrdersPanel
            disabled={!!stale}
            onUse={(p) => {
              setPrefill(p);
              window.scrollTo({ top: 0 });
            }}
          />
        )}
        {lastSale ? (
          <StoreReceiptView sale={lastSale} onDone={() => setLastSale(null)} />
        ) : (
          <StoreSaleView
            key={prefill?.key ?? "baru"}
            prefill={prefill}
            blocked={stale}
            onSaved={(sale) => {
              setPrefill(null);
              setLastSale(sale);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <PosShell
      outletName={ref?.outlet?.name ?? session.device.unitLabel ?? "POS toko"}
      operatorName={session.user.name}
      shift={{ status: shift ? "open" : ref?.lastClosedShift ? "closed" : null, openedAt: shift?.openedAt }}
      pendingCount={sync.pendingCount}
      syncing={sync.syncing}
      onSyncNow={sync.syncNow}
      onLock={session.lock}
      headerActions={header}
      online={sync.online}
    >
      <div className="flex flex-col gap-4">
        {sync.rejectedCount > 0 ? (
          <Banner tone="danger" role="alert">
            {sync.rejectedCount} data ditolak server. Lihat alasannya di menu Riwayat → Antrean data.
          </Banner>
        ) : null}
        {body}
        <button type="button" onClick={session.switchUser} className="min-h-12 self-start rounded-xl px-4 text-base font-semibold text-primary underline-offset-4 hover:underline print:hidden">
          Ganti kasir (data tetap tersimpan)
        </button>
      </div>
    </PosShell>
  );
}

/** Aplikasi POS mode TOKO (M7) di dalam kerangka POS M6 (`PosProvider`). */
export function StorePosScreen() {
  return (
    <StoreProvider>
      <StoreScreen />
    </StoreProvider>
  );
}
