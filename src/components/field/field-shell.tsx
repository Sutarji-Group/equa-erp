"use client";

import { ArrowLeft, CloudCheck, CloudUpload, LoaderCircle, Lock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { formatJam } from "@/lib/time";
import { cn } from "@/lib/utils";

import { OfflineBanner } from "./offline-banner";
import { useOnlineStatus } from "./use-online-status";

export type SyncStatusPillProps = {
  /** Jumlah item outbox yang belum terkirim. */
  pendingCount: number;
  /** Sedang mengirim. */
  syncing?: boolean;
  /** Waktu sinkron terakhir (ditampilkan kecil). */
  lastSyncedAt?: Date | string | null;
  /** Ketuk untuk "Kirim sekarang". */
  onSyncNow?: () => void;
  className?: string;
};

/** Teks status sinkron (US-M3-09 KP-2): "Tersimpan di ponsel: n" / "Semua terkirim" / "Mengirim…". */
export function syncStatusText(pendingCount: number, syncing?: boolean): string {
  if (syncing) return pendingCount > 0 ? `Mengirim ${pendingCount} data…` : "Mengirim…";
  return pendingCount > 0 ? `Tersimpan di ponsel: ${pendingCount}` : "Semua terkirim";
}

/** Pil status sinkron. Ketuk untuk kirim sekarang (bila `onSyncNow`). */
export function SyncStatusPill({ pendingCount, syncing, lastSyncedAt, onSyncNow, className }: SyncStatusPillProps) {
  const pending = pendingCount > 0;
  const text = syncStatusText(pendingCount, syncing);
  const content = (
    <>
      {syncing ? (
        <LoaderCircle className="size-5 animate-spin" aria-hidden />
      ) : pending ? (
        <CloudUpload className="size-5" aria-hidden />
      ) : (
        <CloudCheck className="size-5" aria-hidden />
      )}
      <span>{text}</span>
      {lastSyncedAt && !pending && !syncing ? (
        <span className="text-sm font-normal opacity-80">· {formatJam(lastSyncedAt)}</span>
      ) : null}
    </>
  );
  const classes = cn(
    "inline-flex min-h-10 items-center gap-2 rounded-full px-3.5 py-1.5 text-base font-semibold",
    pending || syncing ? "bg-warning text-warning-foreground" : "bg-success text-success-foreground",
    className,
  );
  if (onSyncNow) {
    return (
      <button
        type="button"
        onClick={onSyncNow}
        disabled={syncing}
        className={cn(classes, "focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none")}
        aria-label={`${text}. Ketuk untuk kirim sekarang.`}
        data-slot="sync-status-pill"
      >
        {content}
      </button>
    );
  }
  return (
    <span className={classes} role="status" data-slot="sync-status-pill">
      {content}
    </span>
  );
}

export type FieldShellProps = {
  /** Judul layar, mis. "Rit hari ini". */
  title: ReactNode;
  /** Nama pengguna yang sedang masuk. */
  userName: string;
  /** Peran/keterangan, mis. "Sopir" atau "Kernet pengganti". */
  roleLabel?: string;
  /** Unit kerja, mis. nomor polisi truk atau nama depot. */
  unitLabel?: string;
  /** Jumlah item outbox belum terkirim. */
  pendingCount: number;
  syncing?: boolean;
  lastSyncedAt?: Date | string | null;
  /** Kirim antrean sekarang. */
  onSyncNow?: () => void;
  /** Kunci layar (kembali ke PIN) — tidak menghapus data. */
  onLock: () => void;
  /** Tautan kembali (layar rincian). */
  backHref?: string;
  onBack?: () => void;
  /** Paksa status jaringan (bawaan dari `navigator.onLine`). */
  online?: boolean;
  /** Bilah aksi bawah yang menempel (tombol besar utama). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * Kerangka aplikasi lapangan (sopir, kernet, operator produksi): header kontras tinggi dengan pil status sinkron,
 * nama pengguna, dan tombol kunci layar; pita tanpa sinyal; isi; bilah aksi bawah.
 * Harus dirender di dalam `data-theme="field"` (sudah dipasang oleh `src/app/(field)/layout.tsx`).
 */
export function FieldShell({
  title,
  userName,
  roleLabel,
  unitLabel,
  pendingCount,
  syncing,
  lastSyncedAt,
  onSyncNow,
  onLock,
  backHref,
  onBack,
  online,
  footer,
  children,
  className,
}: FieldShellProps) {
  const detectedOnline = useOnlineStatus();
  const isOnline = online ?? detectedOnline;
  const backClasses =
    "-ml-2 inline-flex size-12 shrink-0 items-center justify-center rounded-full hover:bg-white/15 focus-visible:ring-4 focus-visible:ring-white/60 focus-visible:outline-none";

  return (
    <div data-slot="field-shell" className={cn("flex min-h-dvh flex-1 flex-col bg-background", className)}>
      <header className="sticky top-0 z-30 bg-primary text-primary-foreground shadow-md">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          {backHref ? (
            <Link href={backHref} className={backClasses} aria-label="Kembali">
              <ArrowLeft className="size-7" aria-hidden />
            </Link>
          ) : onBack ? (
            <button type="button" onClick={onBack} className={backClasses} aria-label="Kembali">
              <ArrowLeft className="size-7" aria-hidden />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl leading-tight font-bold">{title}</h1>
            <p className="truncate text-base opacity-90">
              {userName}
              {roleLabel ? ` · ${roleLabel}` : ""}
              {unitLabel ? ` · ${unitLabel}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onLock}
            className="inline-flex min-h-12 shrink-0 items-center gap-2 rounded-xl border-2 border-white/40 px-3 text-base font-semibold hover:bg-white/15 focus-visible:ring-4 focus-visible:ring-white/60 focus-visible:outline-none"
          >
            <Lock className="size-5" aria-hidden />
            Kunci
          </button>
        </div>
        <div className="px-4 pb-3">
          <SyncStatusPill pendingCount={pendingCount} syncing={syncing} lastSyncedAt={lastSyncedAt} onSyncNow={onSyncNow} />
        </div>
        <OfflineBanner offline={!isOnline} />
      </header>
      <main className="flex flex-1 flex-col gap-4 p-4">{children}</main>
      {footer ? (
        <div className="sticky bottom-0 z-20 border-t-2 bg-background/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
