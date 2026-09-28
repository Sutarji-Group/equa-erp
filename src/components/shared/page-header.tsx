import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PageHeaderProps = {
  /** Judul halaman (dirender sebagai `<h1>`). */
  title: ReactNode;
  /** Kalimat penjelas di bawah judul. */
  description?: ReactNode;
  /** Tombol aksi di kanan (di ponsel turun ke bawah judul). */
  actions?: ReactNode;
  /** Tautan kembali (mis. dari rincian ke daftar). */
  backHref?: string;
  backLabel?: string;
  /** Baris kecil di atas judul (mis. nomor dokumen, lencana status). */
  meta?: ReactNode;
  className?: string;
};

/** Kepala halaman web kantor: judul, deskripsi, aksi. Responsif (aksi turun ke bawah di ponsel). */
export function PageHeader({ title, description, actions, backHref, backLabel = "Kembali", meta, className }: PageHeaderProps) {
  return (
    <div data-slot="page-header" className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {backHref ? (
          <Button asChild variant="link" size="sm" className="-ml-3 h-auto px-3 text-muted-foreground">
            <Link href={backHref}>
              <ArrowLeft aria-hidden />
              {backLabel}
            </Link>
          </Button>
        ) : null}
        {meta ? <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{meta}</div> : null}
        <h1 className="text-2xl font-semibold tracking-tight break-words">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">{actions}</div> : null}
    </div>
  );
}
