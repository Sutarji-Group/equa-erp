import { ChevronRight, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { type StatusTone, ToneBadge } from "./status-badge";

export type KpiTileProps = {
  /** Label angka, mis. "Omzet L2 air truk". */
  label: ReactNode;
  /** Angka utama (sudah diformat, mis. `<MoneyText value={…} />` atau `"42 rit"`). */
  value: ReactNode;
  /** Keterangan kecil di bawah angka (mis. "kas seharusnya Rp 12.000.000"). */
  hint?: ReactNode;
  /** Tautan turun ke rincian (US-M9-01 KP-3). */
  href?: string;
  hrefLabel?: string;
  /**
   * Penanda angka berjalan sebelum tutup kas (US-M9-01 KP-2): "belum ditutup — angka dapat berubah".
   * `true` memakai teks bawaan; string menimpa teks.
   */
  unclosed?: boolean | string;
  /** Nada penekanan angka (mis. selisih ≠ 0 → `danger`). */
  tone?: Extract<StatusTone, "neutral" | "success" | "warning" | "danger">;
  icon?: LucideIcon;
  className?: string;
};

const VALUE_TONE: Record<NonNullable<KpiTileProps["tone"]>, string> = {
  neutral: "",
  success: "text-success",
  warning: "text-warning-foreground dark:text-warning",
  danger: "text-destructive",
};

/** Ubin KPI dashboard: angka + label + tautan rinci + penanda "belum ditutup". */
export function KpiTile({
  label,
  value,
  hint,
  href,
  hrefLabel = "Lihat rincian",
  unclosed,
  tone = "neutral",
  icon: Icon,
  className,
}: KpiTileProps) {
  const unclosedText = unclosed === true ? "Belum ditutup — angka dapat berubah" : unclosed || null;
  return (
    <div
      data-slot="kpi-tile"
      data-unclosed={unclosedText ? true : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground shadow-xs",
        unclosedText && "border-dashed",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
      </div>
      <div className={cn("tabular text-2xl font-semibold tracking-tight break-words", VALUE_TONE[tone])}>{value}</div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {unclosedText || href ? (
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          {unclosedText ? (
            <ToneBadge tone="warning" dot className="whitespace-normal">
              {unclosedText}
            </ToneBadge>
          ) : null}
          {href ? (
            <Link
              href={href}
              className="inline-flex items-center gap-0.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {hrefLabel}
              <ChevronRight className="size-4" aria-hidden />
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
