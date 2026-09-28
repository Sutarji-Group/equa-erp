"use client";

import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { formatRupiah } from "@/lib/money";
import { cn } from "@/lib/utils";

import { type CartLine, cartTotal } from "./cart";

export type { CartLine } from "./cart";

export type CartPanelProps = {
  lines: readonly CartLine[];
  onIncrement: (productId: string) => void;
  /** Kurangi 1; bila jumlah 1 → pemanggil menghapus baris. */
  onDecrement: (productId: string) => void;
  onClear?: () => void;
  /** Aksi di bawah total (mis. tombol "Bayar"). */
  footer?: ReactNode;
  disabled?: boolean;
  className?: string;
};

const STEP_BTN =
  "flex size-12 items-center justify-center rounded-xl border-2 bg-background hover:bg-accent focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none active:scale-95 disabled:opacity-40";

/** Keranjang POS: baris produk dengan +/−, subtotal per baris, dan total. */
export function CartPanel({ lines, onIncrement, onDecrement, onClear, footer, disabled, className }: CartPanelProps) {
  const total = cartTotal(lines);
  return (
    <section data-slot="cart-panel" aria-label="Keranjang" className={cn("flex flex-col gap-3 rounded-2xl border-2 bg-card p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <ShoppingCart className="size-5" aria-hidden />
          Keranjang
        </h2>
        {onClear && lines.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-base text-destructive hover:bg-destructive/10 disabled:opacity-40"
          >
            <Trash2 className="size-4" aria-hidden />
            Kosongkan
          </button>
        ) : null}
      </div>
      {lines.length === 0 ? (
        <p className="py-6 text-center text-base text-muted-foreground">Ketuk produk untuk menambahkan.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {lines.map((l) => (
            <li key={l.productId} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold">{l.name}</p>
                <p className="tabular text-sm text-muted-foreground">
                  {formatRupiah(l.unitPrice)} × {l.quantity} = <span className="font-semibold text-foreground">{formatRupiah(l.unitPrice * l.quantity)}</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={STEP_BTN}
                  onClick={() => onDecrement(l.productId)}
                  disabled={disabled}
                  aria-label={`Kurangi ${l.name}`}
                >
                  <Minus className="size-5" aria-hidden />
                </button>
                <span className="tabular w-8 text-center text-xl font-bold" aria-label={`Jumlah ${l.name}`}>
                  {l.quantity}
                </span>
                <button
                  type="button"
                  className={STEP_BTN}
                  onClick={() => onIncrement(l.productId)}
                  disabled={disabled}
                  aria-label={`Tambah ${l.name}`}
                >
                  <Plus className="size-5" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-baseline justify-between border-t-2 pt-3">
        <span className="text-lg font-semibold">Total</span>
        <span className="tabular text-3xl font-bold" aria-live="polite">
          {formatRupiah(total)}
        </span>
      </div>
      {footer}
    </section>
  );
}
