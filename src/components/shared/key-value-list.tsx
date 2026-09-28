import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type KeyValueItem = {
  label: ReactNode;
  value: ReactNode;
  /** Keterangan kecil di bawah nilai. */
  hint?: ReactNode;
  /** Ambil lebar penuh pada tata letak 2 kolom. */
  full?: boolean;
};

export type KeyValueListProps = {
  items: readonly KeyValueItem[];
  /** Jumlah kolom pada layar ≥ sm. Ponsel selalu 1 kolom. */
  columns?: 1 | 2 | 3;
  className?: string;
};

const COLS = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3" } as const;

/** Daftar label–nilai (`<dl>`) untuk halaman rincian. Nilai kosong tampil "—". */
export function KeyValueList({ items, columns = 2, className }: KeyValueListProps) {
  return (
    <dl data-slot="key-value-list" className={cn("grid grid-cols-1 gap-x-6 gap-y-4", COLS[columns], className)}>
      {items.map((item, i) => (
        <div key={i} className={cn("min-w-0", item.full && "sm:col-span-full")}>
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 font-medium break-words">
            {item.value === null || item.value === undefined || item.value === "" ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              item.value
            )}
          </dd>
          {item.hint ? <dd className="text-xs text-muted-foreground">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
