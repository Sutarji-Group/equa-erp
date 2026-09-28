"use client";

import { Bell, CheckCheck } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatTanggalJam } from "@/lib/time";
import { cn } from "@/lib/utils";

import { formatBadgeCount } from "./badge-count";

export type NotificationSeverity = "info" | "warning" | "critical";

export type NotificationPreview = {
  id: string;
  title: string;
  /** Ringkasan (objek, nilai, tenggat). */
  body?: string;
  at: Date | string;
  /** Tautan tindakan. */
  href?: string;
  severity?: NotificationSeverity;
  /** Belum dibaca. */
  unread?: boolean;
};

export type NotificationBellProps = {
  /** Jumlah notifikasi belum dibaca. */
  count: number;
  /** Pratinjau terbaru (maks ± 5). Kosong → hanya tautan ke pusat notifikasi. */
  items?: readonly NotificationPreview[];
  /** Pusat notifikasi. Bawaan `/notifikasi`. */
  href?: string;
  /** Dipanggil saat menu dibuka (mis. menandai "dibaca" atau memuat pratinjau). */
  onOpenChange?: (open: boolean) => void;
  /** Tandai semua dibaca. */
  onMarkAllRead?: () => void;
  className?: string;
};

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
};

/** Lonceng notifikasi di topbar dengan hitungan belum dibaca dan pratinjau terbaru. */
export function NotificationBell({
  count,
  items = [],
  href = "/notifikasi",
  onOpenChange,
  onMarkAllRead,
  className,
}: NotificationBellProps) {
  const badge = formatBadgeCount(count);
  const srLabel = badge ? `Notifikasi, ${count} belum dibaca` : "Notifikasi";
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("relative", className)} aria-label={srLabel}>
          <Bell aria-hidden />
          {badge ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-white"
            >
              {badge}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifikasi</span>
          {onMarkAllRead && badge ? (
            <button
              type="button"
              onClick={onMarkAllRead}
              className="inline-flex items-center gap-1 text-xs font-normal text-primary hover:underline"
            >
              <CheckCheck className="size-3.5" aria-hidden />
              Tandai semua dibaca
            </button>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {badge ? `${count} notifikasi belum dibaca.` : "Tidak ada notifikasi baru."}
          </p>
        ) : (
          items.map((n) => {
            const content = (
              <div className="flex w-full min-w-0 gap-2">
                <span
                  aria-hidden
                  className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.unread ? SEVERITY_DOT[n.severity ?? "info"] : "bg-transparent")}
                />
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-sm", n.unread && "font-medium")}>{n.title}</p>
                  {n.body ? <p className="line-clamp-2 text-xs text-muted-foreground">{n.body}</p> : null}
                  <p className="text-[11px] text-muted-foreground">{formatTanggalJam(n.at, { weekday: false })}</p>
                </div>
              </div>
            );
            return n.href ? (
              <DropdownMenuItem key={n.id} asChild>
                <Link href={n.href}>{content}</Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={n.id}>{content}</DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={href} className="justify-center font-medium">
            Lihat semua notifikasi
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
