"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ErrorStateProps = {
  title?: ReactNode;
  /** Pesan berisi tindakan (bukan kode teknis), mis. "Periksa sinyal lalu coba lagi." */
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  /** Aksi tambahan (mis. tautan hubungi admin). */
  action?: ReactNode;
  className?: string;
};

/** Keadaan galat ramah pengguna: judul, pesan tindakan, tombol coba lagi. */
export function ErrorState({
  title = "Data belum dapat dimuat",
  message = "Periksa koneksi internet Anda, lalu coba lagi. Bila masih gagal, hubungi admin sistem.",
  onRetry,
  retryLabel = "Coba lagi",
  action,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="size-6" aria-hidden />
      </div>
      <p className="font-medium">{title}</p>
      {message ? <p className="max-w-md text-sm text-muted-foreground">{message}</p> : null}
      {onRetry || action ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <Button variant="outline" onClick={onRetry}>
              <RotateCcw aria-hidden />
              {retryLabel}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
