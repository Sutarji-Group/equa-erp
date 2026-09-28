import type { ComponentProps, ReactNode } from "react";

import { type EnumName, label } from "@/lib/labels";
import { cn } from "@/lib/utils";

/** Nada warna lencana status. */
export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "muted";

export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "border-border bg-secondary text-secondary-foreground",
  info: "border-transparent bg-blue-500/10 text-blue-700 dark:bg-blue-400/20 dark:text-blue-300",
  success: "border-transparent bg-success/15 text-success dark:bg-success/25",
  warning: "border-transparent bg-warning/25 text-warning-foreground dark:bg-warning/30 dark:text-warning",
  danger: "border-transparent bg-destructive/10 text-destructive dark:bg-destructive/25",
  muted: "border-transparent bg-muted text-muted-foreground",
};

/**
 * Peta nada per enum. Nilai yang tidak tercantum → `neutral`. Modul boleh MENAMBAH entri enum baru di sini
 * (append) saat menambah enum ke `src/lib/labels.ts`.
 */
export const STATUS_TONES: Partial<Record<EnumName, Record<string, StatusTone>>> = {
  order_status: {
    new: "info",
    awaiting_approval: "warning",
    scheduled: "info",
    in_delivery: "info",
    completed: "success",
    cancelled: "muted",
  },
  trip_status: {
    assigned: "neutral",
    departed: "info",
    arrived: "info",
    completed: "success",
    failed: "danger",
  },
  deposit_status: {
    running: "neutral",
    submitted: "warning",
    received: "info",
    closed: "success",
  },
  discrepancy_status: {
    formed: "danger",
    explained: "warning",
    approved: "success",
    rejected: "danger",
    followed_up: "info",
    done: "muted",
  },
  shift_status: { open: "success", closed: "muted" },
  shift_deposit_status: { not_deposited: "warning", deposited: "info", received: "success" },
  invoice_status: { open: "warning", partial: "info", paid: "success" },
  period_status: { open: "success", closed: "info", locked: "muted", reopened: "warning" },
  approval_status: {
    submitted: "warning",
    approved: "success",
    rejected: "danger",
    expired: "muted",
    cancelled: "muted",
  },
  device_status: {
    registered: "neutral",
    active: "success",
    blocked: "danger",
    wipe_pending: "warning",
    wiped: "muted",
  },
  incoming_transfer_status: { unmatched: "warning", matched: "success", not_found: "danger" },
  notification_status: { new: "info", read: "neutral", actioned: "success", done: "muted" },
  credit_status: { cash: "neutral", credit: "info", credit_migrated: "info", on_hold: "danger" },
};

/** Nada untuk nilai enum (bawaan `neutral`). */
export function statusTone(enumName: EnumName, value: string | null | undefined): StatusTone {
  if (!value) return "muted";
  return STATUS_TONES[enumName]?.[value] ?? "neutral";
}

export type StatusBadgeProps = {
  /** Nama enum di `src/lib/labels.ts`, mis. `"order_status"`. */
  enumName: EnumName;
  value: string | null | undefined;
  /** Timpa nada bawaan. */
  tone?: StatusTone;
  /** Timpa label bawaan (mis. menambah keterangan). */
  children?: ReactNode;
  /** Tampilkan titik warna di depan label. */
  dot?: boolean;
  className?: string;
};

/** Lencana status: label Indonesia dari `labels.ts` + warna sesuai makna. */
export function StatusBadge({ enumName, value, tone, children, dot = true, className }: StatusBadgeProps) {
  const t = tone ?? statusTone(enumName, value);
  return <ToneBadge tone={t} dot={dot} className={className} data-enum={enumName} data-value={value ?? ""}>{children ?? label(enumName, value)}</ToneBadge>;
}

export type ToneBadgeProps = {
  tone?: StatusTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<"span">, "children">;

/** Lencana bernada bebas (untuk status yang belum ada di `labels.ts`, mis. "Belum ditutup"). */
export function ToneBadge({ tone = "neutral", dot = false, children, className, ...props }: ToneBadgeProps) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        STATUS_TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current opacity-80" /> : null}
      {children}
    </span>
  );
}
