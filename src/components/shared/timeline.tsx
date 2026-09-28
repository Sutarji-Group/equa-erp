import type { ReactNode } from "react";

import type { EnumName } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { cn } from "@/lib/utils";

import { STATUS_TONE_CLASSES, StatusBadge, type StatusTone, statusTone } from "./status-badge";

export type TimelineItem = {
  id: string;
  /** Judul kejadian, mis. "Rit berangkat". */
  title: ReactNode;
  /** Waktu kejadian (instan; ditampilkan WIB). */
  at: Date | string | number;
  /** Pelaku, mis. "Budi (Sopir) · Aplikasi lapangan". */
  actor?: ReactNode;
  /** Keterangan/alasan. */
  description?: ReactNode;
  /** Status baru (lencana). */
  status?: { enumName: EnumName; value: string };
  /** Nada titik; bawaan mengikuti status. */
  tone?: StatusTone;
};

export type TimelineProps = {
  items: readonly TimelineItem[];
  /** Pesan bila kosong. */
  emptyText?: ReactNode;
  className?: string;
};

/** Riwayat status/kejadian vertikal (urutan sesuai `items`; kirim terbaru dulu bila perlu). */
export function Timeline({ items, emptyText = "Belum ada riwayat.", className }: TimelineProps) {
  if (items.length === 0) return <p className={cn("text-sm text-muted-foreground", className)}>{emptyText}</p>;
  return (
    <ol data-slot="timeline" className={cn("relative space-y-5", className)}>
      {items.map((item, i) => {
        const tone = item.tone ?? (item.status ? statusTone(item.status.enumName, item.status.value) : "neutral");
        const time = new Date(item.at);
        return (
          <li key={item.id} className="relative flex gap-3">
            <div className="flex flex-col items-center">
              <span
                aria-hidden
                className={cn("mt-1 size-3 shrink-0 rounded-full border-2 border-background ring-1 ring-border", STATUS_TONE_CLASSES[tone])}
              />
              {i < items.length - 1 ? <span aria-hidden className="mt-1 w-px flex-1 bg-border" /> : null}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{item.title}</span>
                {item.status ? <StatusBadge enumName={item.status.enumName} value={item.status.value} /> : null}
              </div>
              <p className="text-xs text-muted-foreground">
                <time dateTime={time.toISOString()}>{formatTanggalJam(time)}</time>
                {item.actor ? <> · {item.actor}</> : null}
              </p>
              {item.description ? <p className="mt-1 text-sm break-words">{item.description}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
