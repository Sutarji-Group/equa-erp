"use client";

import { ClipboardList, Droplets, History, LifeBuoy, Package, ShoppingCart } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { PosSaleRef } from "@/client/m6-pos/contract";
import { FieldGate } from "@/components/field/field-gate";
import { PosQualityChecklist } from "@/components/p3-partner/pos-quality-checklist";
import { PosShell } from "@/components/pos/pos-shell";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import { cn } from "@/lib/utils";

import { PosHelpView } from "./help-view";
import { HistoryView } from "./history-view";
import { PosProvider, usePos } from "./pos-context";
import { ReceiptView, SaleView, type SaleDraft } from "./sale-view";
import { CloseShiftForm, OpenShiftView, PartialDepositForm, ShiftSales } from "./shift-view";
import { StockView, SupplyView } from "./stock-view";
import { Banner } from "./ui";

type View = "jual" | "shift" | "pasokan" | "stok" | "riwayat" | "bantuan";

const NAV: { view: View; label: string; icon: typeof ShoppingCart }[] = [
  { view: "jual", label: "Jual", icon: ShoppingCart },
  { view: "shift", label: "Shift & void", icon: ClipboardList },
  { view: "pasokan", label: "Pasokan air", icon: Droplets },
  { view: "stok", label: "Stok bahan", icon: Package },
  { view: "riwayat", label: "Riwayat", icon: History },
  // B-03 (US-M10-07 KP-3): laporan kendala aplikasi & status sinkron.
  { view: "bantuan", label: "Bantuan", icon: LifeBuoy },
];

/** Layar POS depot (diekspor untuk pemilih mode outlet M7: toko memakai layarnya sendiri di dalam PosProvider yang sama). */
export function PosScreen() {
  const { session, ref, shift, figures, today, grid } = usePos();
  const [view, setView] = useState<View>("jual");
  const [draft, setDraft] = useState<SaleDraft>({ lines: [], replacesSaleId: null });
  const [lastSale, setLastSale] = useState<PosSaleRef | null>(null);
  const sync = session.sync;

  const header = (
    <nav aria-label="Menu POS" className="flex flex-wrap gap-2">
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
          {n.view === "pasokan" && ref?.water?.pending.length ? <span className="rounded-full bg-warning px-2 text-sm text-warning-foreground">{ref.water.pending.length}</span> : null}
        </button>
      ))}
    </nav>
  );

  let body: ReactNode;
  if (ref === undefined) {
    body = <Banner tone="info">Mengunduh data outlet… Pastikan ada sinyal saat pertama kali masuk.</Banner>;
  } else if (ref === null || !ref.outlet) {
    body = <Banner tone="danger">Perangkat ini belum tertaut ke outlet Anda. Hubungi admin sistem.</Banner>;
  } else if (view === "pasokan") {
    body = <SupplyView />;
  } else if (view === "stok") {
    body = <StockView />;
  } else if (view === "riwayat") {
    body = <HistoryView />;
  } else if (view === "bantuan") {
    body = <PosHelpView />;
  } else if (!shift) {
    // B-72 (US-P3-05 KP-1): daftar periksa mutu harian outlet mitra diisi saat buka shift (tersembunyi untuk outlet EQUA).
    body =
      view === "shift" ? (
        <div className="flex flex-col gap-4">
          <PosQualityChecklist shiftId={null} />
          <OpenShiftView />
        </div>
      ) : (
        <OpenShiftView />
      );
  } else if (view === "shift") {
    body = (
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <PosQualityChecklist shiftId={shift.id} className="lg:col-span-2" />
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border-2 bg-card p-4">
            <h2 className="text-lg font-bold">Transaksi shift ini</h2>
            <p className="text-base text-muted-foreground">
              Kas di laci {formatRupiah(figures?.expectedDrawer ?? 0)} · void hari ini {ref.voidsToday}
              {ref.voidsToday > ref.settings.voidDailyCount ? " (melebihi batas — Admin Keuangan diberi tahu)" : ""}
            </p>
            <div className="mt-3">
              <ShiftSales
                onReplace={(voided) => {
                  // Transaksi pengganti (US-M6-03 KP-1): keranjang diisi ulang dari transaksi yang di-void (harga master terkini).
                  const lines = voided.lines.flatMap((l) => {
                    const p = grid.find((g) => g.id === l.productId);
                    return p ? [{ productId: p.id, name: p.name, unitPrice: p.price, quantity: l.quantity }] : [];
                  });
                  setDraft({ lines, replacesSaleId: voided.id });
                  setView("jual");
                }}
              />
            </div>
          </section>
          <PartialDepositForm />
        </div>
        <CloseShiftForm onClosed={() => setView("riwayat")} />
      </div>
    );
  } else {
    const stale = shift.businessDate < today ? `Shift tanggal ${formatTanggal(shift.businessDate)} belum ditutup. Tutup dulu di menu "Shift & void" sebelum berjualan.` : null;
    body = (
      <div className="flex flex-col gap-4">
        {figures && figures.expectedDrawer > ref.settings.cashLimit ? (
          <Banner tone="danger" role="alert">
            Kas di laci {formatRupiah(figures.expectedDrawer)} melebihi batas {formatRupiah(ref.settings.cashLimit)}.{" "}
            <button type="button" className="font-semibold underline" onClick={() => setView("shift")}>
              Setor sebagian
            </button>
          </Banner>
        ) : null}
        {shift.syncConflict ? <Banner tone="warning">Shift ini tercatat sebagai konflik (shift lain masih terbuka di outlet). Admin Keuangan akan meninjau.</Banner> : null}
        {lastSale ? (
          <ReceiptView sale={lastSale} onDone={() => setLastSale(null)} />
        ) : (
          <SaleView
            draft={draft}
            setDraft={setDraft}
            blocked={stale}
            onSaved={(sale) => {
              setLastSale(sale);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <PosShell
      outletName={ref?.outlet?.name ?? session.device.unitLabel ?? "POS"}
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
        <button
          type="button"
          onClick={session.switchUser}
          className="min-h-12 self-start rounded-xl px-4 text-base font-semibold text-primary underline-offset-4 hover:underline print:hidden"
        >
          Ganti operator (data tetap tersimpan)
        </button>
      </div>
    </PosShell>
  );
}

/** Aplikasi POS depot (PWA offline-first): gerbang perangkat + PIN, lalu layar jual/shift/pasokan/stok/riwayat. */
export function PosApp() {
  return (
    <FieldGate home="/pos">
      <PosProvider>
        <PosScreen />
      </PosProvider>
    </FieldGate>
  );
}
