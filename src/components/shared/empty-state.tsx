import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  title: ReactNode;
  /** Kalimat tindakan, mis. "Tambahkan pelanggan pertama untuk mulai membuat pesanan." */
  description?: ReactNode;
  icon?: LucideIcon;
  /** Tombol/tautan tindakan. */
  action?: ReactNode;
  className?: string;
  /** Versi ringkas untuk di dalam tabel/kartu. */
  compact?: boolean;
};

/** Keadaan kosong: ikon, judul, penjelasan, dan tindakan berikutnya. */
export function EmptyState({ title, description, icon: Icon = Inbox, action, className, compact }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        compact ? "px-4 py-8" : "rounded-lg border border-dashed px-6 py-12",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-6" aria-hidden />
      </div>
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
