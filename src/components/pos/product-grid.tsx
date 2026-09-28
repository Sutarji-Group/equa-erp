"use client";

import { formatRupiah } from "@/lib/money";
import { cn } from "@/lib/utils";

/** Batas tombol produk di layar utama POS depot (US-M6-01 KP-1). */
export const POS_GRID_MAX = 12;

export type PosProduct = {
  id: string;
  /** Nama singkat di tombol, mis. "Isi ulang 19 L". */
  name: string;
  /** Harga berlaku hari ini (integer rupiah) — dari master, tidak dapat diubah operator. */
  price: number;
  /** Satuan kecil di bawah harga, mis. "galon". */
  unitLabel?: string;
  disabled?: boolean;
};

export type ProductGridProps = {
  products: readonly PosProduct[];
  onSelect: (product: PosProduct) => void;
  /** Jumlah di keranjang per ID produk (lencana angka). */
  quantities?: Readonly<Record<string, number>>;
  disabled?: boolean;
  className?: string;
};

/**
 * Kisi produk POS: maksimal 12 tombol besar (sisanya diabaikan dengan peringatan di mode pengembangan).
 * Ketuk = tambah 1 ke keranjang.
 */
export function ProductGrid({ products, onSelect, quantities, disabled, className }: ProductGridProps) {
  if (process.env.NODE_ENV !== "production" && products.length > POS_GRID_MAX) {
    console.warn(`ProductGrid: ${products.length} produk; hanya ${POS_GRID_MAX} pertama yang tampil (US-M6-01 KP-1).`);
  }
  const shown = products.slice(0, POS_GRID_MAX);
  return (
    <div data-slot="product-grid" className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4", className)}>
      {shown.map((p) => {
        const qty = quantities?.[p.id] ?? 0;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p)}
            disabled={disabled || p.disabled}
            aria-label={`${p.name}, ${formatRupiah(p.price)}${qty > 0 ? `, ${qty} di keranjang` : ""}`}
            className={cn(
              "relative flex min-h-28 flex-col items-start justify-between gap-2 rounded-2xl border-2 bg-card p-4 text-left text-card-foreground shadow-xs transition-transform select-none",
              "hover:bg-accent focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none active:scale-[0.97] disabled:opacity-40",
              qty > 0 && "border-primary bg-primary/5",
            )}
          >
            <span className="text-lg leading-snug font-bold text-balance">{p.name}</span>
            <span className="tabular flex flex-col text-lg leading-tight font-semibold text-primary">
              {formatRupiah(p.price)}
              {p.unitLabel ? <span className="text-sm font-normal text-muted-foreground">per {p.unitLabel}</span> : null}
            </span>
            {qty > 0 ? (
              <span
                aria-hidden
                className="absolute -top-2 -right-2 flex size-9 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground shadow"
              >
                {qty}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
