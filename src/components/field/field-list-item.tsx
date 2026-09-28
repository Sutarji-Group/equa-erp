import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type FieldListItemProps = {
  /** Baris utama, mis. nama pelanggan. */
  title: ReactNode;
  /** Baris kedua, mis. alamat singkat. */
  subtitle?: ReactNode;
  /** Baris ketiga kecil, mis. "5.000 L · Tunai · jam 09.00". */
  meta?: ReactNode;
  /** Elemen kiri, mis. nomor urut rit. */
  leading?: ReactNode;
  /** Lencana status (baris bawah, sebelum penanda). */
  status?: ReactNode;
  /** Tonjolkan (rit berikutnya). */
  highlight?: boolean;
  /** Redupkan (rit selesai/gagal). */
  muted?: boolean;
  /** Penanda kecil (mis. "Catatan khusus", "Diperbarui"). */
  flags?: ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
};

/** Baris daftar lapangan bertarget sentuh besar (≥ 64 px) — daftar rit, pasokan, riwayat shift. */
export function FieldListItem({
  title,
  subtitle,
  meta,
  leading,
  status,
  highlight,
  muted,
  flags,
  href,
  onClick,
  className,
}: FieldListItemProps) {
  const interactive = !!href || !!onClick;
  const inner = (
    <>
      {leading !== undefined ? (
        <div
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-full text-lg font-bold",
            highlight ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          )}
        >
          {leading}
        </div>
      ) : null}
      <div className="min-w-0 flex-1 text-left">
        <p className="text-lg leading-snug font-semibold break-words">{title}</p>
        {subtitle ? <p className="text-base break-words text-muted-foreground">{subtitle}</p> : null}
        {meta ? <p className="text-base font-medium">{meta}</p> : null}
        {status || flags ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {status}
            {flags}
          </div>
        ) : null}
      </div>
      {interactive ? <ChevronRight className="size-6 shrink-0 self-center text-muted-foreground" aria-hidden /> : null}
    </>
  );
  const classes = cn(
    "flex min-h-16 w-full items-start gap-3 rounded-xl border-2 bg-card p-4 text-card-foreground",
    highlight && "border-primary ring-2 ring-primary/30",
    muted && "opacity-60",
    interactive && "transition-colors hover:bg-accent focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none active:bg-accent",
    className,
  );
  if (href) {
    return (
      <Link href={href} className={classes} data-slot="field-list-item" aria-current={highlight ? "step" : undefined}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes} data-slot="field-list-item">
        {inner}
      </button>
    );
  }
  return (
    <div className={classes} data-slot="field-list-item">
      {inner}
    </div>
  );
}
