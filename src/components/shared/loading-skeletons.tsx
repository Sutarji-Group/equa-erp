import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Kerangka tabel saat memuat. */
export function TableSkeleton({ rows = 6, columns = 5, className }: { rows?: number; columns?: number; className?: string }) {
  return (
    <div role="status" aria-label="Memuat data" className={cn("w-full space-y-2", className)}>
      <div className="flex gap-3">
        {Array.from({ length: columns }, (_, c) => (
          <Skeleton key={c} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3 border-t pt-2">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className="h-6 flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">Memuat…</span>
    </div>
  );
}

/** Kerangka kisi ubin KPI. */
export function KpiGridSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div role="status" aria-label="Memuat ringkasan" className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-3 rounded-xl border p-4">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
      <span className="sr-only">Memuat…</span>
    </div>
  );
}

/** Kerangka daftar (kartu/baris). */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Memuat daftar" className={cn("space-y-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
      <span className="sr-only">Memuat…</span>
    </div>
  );
}

/** Kerangka formulir. */
export function FormSkeleton({ fields = 4, className }: { fields?: number; className?: string }) {
  return (
    <div role="status" aria-label="Memuat formulir" className={cn("space-y-5", className)}>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <Skeleton className="h-9 w-28" />
      <span className="sr-only">Memuat…</span>
    </div>
  );
}

/** Kerangka halaman utuh (judul + tabel) — cocok untuk `loading.tsx`. */
export function PageSkeleton({ className }: { className?: string }) {
  return (
    <div role="status" aria-label="Memuat halaman" className={cn("space-y-6", className)}>
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <TableSkeleton />
    </div>
  );
}
