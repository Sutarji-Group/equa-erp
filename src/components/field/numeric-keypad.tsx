"use client";

import { Delete } from "lucide-react";

import { cn } from "@/lib/utils";

export type NumericKeypadProps = {
  /** Ketuk angka 0–9. */
  onDigit: (digit: string) => void;
  /** Hapus satu digit terakhir. */
  onBackspace: () => void;
  /** Tombol kiri bawah: `"clear"` (Hapus semua), `"000"` (nominal uang), atau `null` (kosong). */
  extraKey?: "clear" | "000" | null;
  onClear?: () => void;
  /** Dipanggil untuk tombol "000" (bawaan: tiga kali `onDigit("0")`). */
  onTripleZero?: () => void;
  disabled?: boolean;
  className?: string;
};

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

const KEY_CLASS =
  "flex min-h-16 select-none items-center justify-center rounded-xl border-2 bg-card text-2xl font-bold text-card-foreground transition-transform active:scale-95 active:bg-accent hover:bg-accent focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none disabled:opacity-40";

/** Papan angka 3×4 bertombol besar (≥ 64 px) untuk PIN 6 digit dan nominal uang/liter. */
export function NumericKeypad({
  onDigit,
  onBackspace,
  extraKey = null,
  onClear,
  onTripleZero,
  disabled,
  className,
}: NumericKeypadProps) {
  return (
    <div data-slot="numeric-keypad" className={cn("grid grid-cols-3 gap-3", className)} role="group" aria-label="Papan angka">
      {DIGITS.map((d) => (
        <button key={d} type="button" className={KEY_CLASS} onClick={() => onDigit(d)} disabled={disabled}>
          {d}
        </button>
      ))}
      {extraKey === "clear" ? (
        <button type="button" className={cn(KEY_CLASS, "text-lg")} onClick={onClear} disabled={disabled}>
          Hapus semua
        </button>
      ) : extraKey === "000" ? (
        <button
          type="button"
          className={KEY_CLASS}
          onClick={() => (onTripleZero ? onTripleZero() : ["0", "0", "0"].forEach((z) => onDigit(z)))}
          disabled={disabled}
        >
          000
        </button>
      ) : (
        <span aria-hidden />
      )}
      <button type="button" className={KEY_CLASS} onClick={() => onDigit("0")} disabled={disabled}>
        0
      </button>
      <button type="button" className={KEY_CLASS} onClick={onBackspace} disabled={disabled} aria-label="Hapus satu angka">
        <Delete className="size-7" aria-hidden />
      </button>
    </div>
  );
}
