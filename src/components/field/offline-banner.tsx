"use client";

import { WifiOff } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { useOnlineStatus } from "./use-online-status";

export type OfflineBannerProps = {
  /** Paksa tampil/sembunyi. Bawaan mengikuti `navigator.onLine`. */
  offline?: boolean;
  /** Pesan tindakan. */
  message?: ReactNode;
  className?: string;
};

/**
 * Pita "tanpa sinyal" untuk aplikasi lapangan/POS. Pesan menenangkan + tindakan (US-M3-10 KP-6):
 * data tetap tersimpan di ponsel dan terkirim otomatis saat sinyal kembali.
 */
export function OfflineBanner({ offline, message, className }: OfflineBannerProps) {
  const online = useOnlineStatus();
  const isOffline = offline ?? !online;
  if (!isOffline) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="offline-banner"
      className={cn("flex items-center gap-3 bg-warning px-4 py-2.5 text-base font-medium text-warning-foreground", className)}
    >
      <WifiOff className="size-5 shrink-0" aria-hidden />
      <span>{message ?? "Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja."}</span>
    </div>
  );
}
