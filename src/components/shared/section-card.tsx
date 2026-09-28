import type { ReactNode } from "react";

import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type SectionCardProps = {
  title?: ReactNode;
  description?: ReactNode;
  /** Aksi di pojok kanan atas (tombol, ekspor). */
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  /** Hilangkan padding isi (mis. untuk tabel penuh). */
  flush?: boolean;
};

/** Kartu bagian halaman: judul + aksi + isi. */
export function SectionCard({
  title,
  description,
  actions,
  footer,
  children,
  className,
  contentClassName,
  flush,
}: SectionCardProps) {
  const hasHeader = title !== undefined || description !== undefined || actions !== undefined;
  return (
    <Card data-slot="section-card" className={cn("gap-4", flush && "pb-0", className)}>
      {hasHeader ? (
        <CardHeader>
          {title !== undefined ? <CardTitle className="text-base">{title}</CardTitle> : null}
          {description !== undefined ? <CardDescription>{description}</CardDescription> : null}
          {actions !== undefined ? <CardAction className="flex flex-wrap items-center gap-2">{actions}</CardAction> : null}
        </CardHeader>
      ) : null}
      <CardContent className={cn(flush && "px-0", contentClassName)}>{children}</CardContent>
      {footer !== undefined ? <CardFooter>{footer}</CardFooter> : null}
    </Card>
  );
}
