import { Clock } from "lucide-react";

import { formatJam } from "@/lib/time";
import { cn } from "@/lib/utils";

export type ShiftBadgeProps = {
  /** Status shift outlet: `open`/`closed` (enum `shift_status`) atau `null` bila belum ada shift. */
  status: "open" | "closed" | null;
  /** Waktu buka shift (ditampilkan WIB). */
  openedAt?: Date | string | null;
  /** Nama operator shift. */
  operatorName?: string;
  className?: string;
};

/** Teks status shift: "Shift terbuka sejak 07.00" / "Shift ditutup" / "Belum buka shift". */
export function shiftBadgeText(status: ShiftBadgeProps["status"], openedAt?: Date | string | null): string {
  if (status === "open") return openedAt ? `Shift terbuka sejak ${formatJam(openedAt)}` : "Shift terbuka";
  if (status === "closed") return "Shift ditutup";
  return "Belum buka shift";
}

/** Lencana status shift POS depot/toko. */
export function ShiftBadge({ status, openedAt, operatorName, className }: ShiftBadgeProps) {
  return (
    <span
      data-slot="shift-badge"
      data-status={status ?? "none"}
      className={cn(
        "inline-flex min-h-9 items-center gap-2 rounded-full px-3 py-1 text-base font-semibold",
        status === "open" ? "bg-success text-success-foreground" : "bg-warning text-warning-foreground",
        className,
      )}
    >
      <Clock className="size-4" aria-hidden />
      <span>{shiftBadgeText(status, openedAt)}</span>
      {operatorName && status === "open" ? <span className="font-normal opacity-90">· {operatorName}</span> : null}
    </span>
  );
}
