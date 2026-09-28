"use client";

import { Lock, Store } from "lucide-react";
import type { ReactNode } from "react";

import { OfflineBanner } from "@/components/field/offline-banner";
import { SyncStatusPill } from "@/components/field/field-shell";
import { useOnlineStatus } from "@/components/field/use-online-status";
import { cn } from "@/lib/utils";

import { ShiftBadge, type ShiftBadgeProps } from "./shift-badge";

export type PosShellProps = {
  /** Nama outlet (depot/toko), mis. "Depot Cipanas". */
  outletName: string;
  /** Nama operator/kasir yang masuk. */
  operatorName: string;
  shift: Pick<ShiftBadgeProps, "status" | "openedAt">;
  /** Jumlah transaksi/aksi belum terkirim. */
  pendingCount: number;
  syncing?: boolean;
  onSyncNow?: () => void;
  onLock: () => void;
  /** Aksi header tambahan (mis. menu "Tutup shift", "Riwayat"). */
  headerActions?: ReactNode;
  online?: boolean;
  /** Area utama (ProductGrid). */
  children: ReactNode;
  /**
   * Panel samping (CartPanel + PaymentPanel). Tablet (≥ md): kolom kanan tetap. Ponsel: di bawah kisi produk.
   */
  aside?: ReactNode;
  /** Bilah bawah menempel khusus ponsel (mis. ringkasan total + "Bayar"). */
  mobileBar?: ReactNode;
  className?: string;
};

/**
 * Kerangka POS depot & toko (tablet/ponsel, offline-first): header outlet + shift + status sinkron + kunci;
 * kisi produk di kiri dan keranjang/pembayaran di kanan (tablet), bertumpuk di ponsel.
 */
export function PosShell({
  outletName,
  operatorName,
  shift,
  pendingCount,
  syncing,
  onSyncNow,
  onLock,
  headerActions,
  online,
  children,
  aside,
  mobileBar,
  className,
}: PosShellProps) {
  const detected = useOnlineStatus();
  const isOnline = online ?? detected;
  return (
    <div data-slot="pos-shell" className={cn("flex min-h-dvh flex-1 flex-col bg-muted/40", className)}>
      <header className="sticky top-0 z-30 border-b-2 bg-background shadow-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Store className="size-6 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0">
              <h1 className="truncate text-xl leading-tight font-bold">{outletName}</h1>
              <p className="truncate text-base text-muted-foreground">{operatorName}</p>
            </div>
          </div>
          {/* Ponsel: lencana turun ke baris kedua; tombol Kunci tetap di kanan atas. */}
          <div className="order-last flex w-full flex-wrap items-center gap-2 md:order-none md:w-auto">
            <ShiftBadge status={shift.status} openedAt={shift.openedAt} />
            <SyncStatusPill pendingCount={pendingCount} syncing={syncing} onSyncNow={onSyncNow} />
            {headerActions}
          </div>
          <button
            type="button"
            onClick={onLock}
            className="inline-flex min-h-12 shrink-0 items-center gap-2 rounded-xl border-2 px-3 text-base font-semibold hover:bg-accent focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <Lock className="size-5" aria-hidden />
            Kunci
          </button>
        </div>
        <OfflineBanner offline={!isOnline} />
      </header>
      <div className="flex flex-1 flex-col gap-4 p-4 md:grid md:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] md:items-start">
        <main className="min-w-0">{children}</main>
        {aside ? <aside className="flex min-w-0 flex-col gap-4 md:sticky md:top-28">{aside}</aside> : null}
      </div>
      {mobileBar ? (
        <div className="sticky bottom-0 z-20 border-t-2 bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
          {mobileBar}
        </div>
      ) : null}
    </div>
  );
}
