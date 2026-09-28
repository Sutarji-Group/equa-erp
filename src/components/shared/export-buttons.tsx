import { FileDown, FileSpreadsheet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ExportButtonsProps = {
  /** URL ekspor Excel (mis. `/api/export/orders?format=xlsx&…`). Tidak diisi → tombol disembunyikan. */
  excelHref?: string;
  /** URL ekspor PDF. */
  pdfHref?: string;
  /** Nonaktifkan (mis. tidak ada data). */
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
};

/**
 * Tombol ekspor Excel/PDF sebagai tautan unduhan (NFR-23). Pencatatan log ekspor & pembatasan data pribadi (BR-39)
 * dilakukan endpoint ekspor di server.
 */
export function ExportButtons({ excelHref, pdfHref, disabled, size = "sm", className }: ExportButtonsProps) {
  if (!excelHref && !pdfHref) return null;
  return (
    <div data-slot="export-buttons" className={cn("flex flex-wrap items-center gap-2", className)}>
      {excelHref ? (
        disabled ? (
          <Button variant="outline" size={size} disabled>
            <FileSpreadsheet aria-hidden />
            Excel
          </Button>
        ) : (
          <Button asChild variant="outline" size={size}>
            <a href={excelHref} download aria-label="Unduh Excel">
              <FileSpreadsheet aria-hidden />
              Excel
            </a>
          </Button>
        )
      ) : null}
      {pdfHref ? (
        disabled ? (
          <Button variant="outline" size={size} disabled>
            <FileDown aria-hidden />
            PDF
          </Button>
        ) : (
          <Button asChild variant="outline" size={size}>
            <a href={pdfHref} download aria-label="Unduh PDF">
              <FileDown aria-hidden />
              PDF
            </a>
          </Button>
        )
      ) : null}
    </div>
  );
}
