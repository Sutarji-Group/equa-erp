import { CheckCheck } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

import { formatBadgeCount } from "./badge-count";

export type ApprovalCountBadgeProps = {
  /** Jumlah permintaan persetujuan yang menunggu keputusan pengguna. */
  count: number;
  /** Jumlah yang lewat tenggat (ditandai merah). */
  overdueCount?: number;
  href?: string;
  /** Sembunyikan teks "Persetujuan" (hanya ikon + angka), mis. di ponsel. */
  compact?: boolean;
  className?: string;
};

/** Tautan kotak persetujuan dengan hitungan (topbar web kantor). */
export function ApprovalCountBadge({ count, overdueCount = 0, href = "/persetujuan", compact, className }: ApprovalCountBadgeProps) {
  const badge = formatBadgeCount(count);
  const label = badge ? `Persetujuan, ${count} menunggu${overdueCount > 0 ? `, ${overdueCount} lewat tenggat` : ""}` : "Persetujuan";
  return (
    <Link
      href={href}
      aria-label={label}
      data-slot="approval-count-badge"
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        className,
      )}
    >
      <CheckCheck className="size-4" aria-hidden />
      <span className={cn(compact ? "sr-only" : "hidden md:inline")}>Persetujuan</span>
      {badge ? (
        <span
          aria-hidden
          className={cn(
            "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs leading-none font-semibold",
            overdueCount > 0 ? "bg-destructive text-white" : "bg-primary text-primary-foreground",
          )}
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
