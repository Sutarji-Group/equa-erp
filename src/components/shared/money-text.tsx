import { formatRupiah } from "@/lib/money";
import { cn } from "@/lib/utils";

export type MoneyTextProps = {
  /** Jumlah rupiah (integer). `null`/`undefined` → "—". */
  value: number | null | undefined;
  /** Tampilkan "+" untuk nilai positif (selisih lebih). */
  signed?: boolean;
  /** Warnai negatif merah & positif hijau (untuk selisih). */
  colorize?: boolean;
  /** Tanpa awalan "Rp". */
  noPrefix?: boolean;
  className?: string;
};

/** Teks rupiah `Rp 1.250.000` dengan angka lebar tetap (tabular). */
export function MoneyText({ value, signed, colorize, noPrefix, className }: MoneyTextProps) {
  if (value === null || value === undefined) {
    return <span className={cn("tabular text-muted-foreground", className)}>—</span>;
  }
  return (
    <span
      data-slot="money-text"
      className={cn(
        "tabular whitespace-nowrap",
        colorize && value < 0 && "text-destructive",
        colorize && value > 0 && "text-success",
        className,
      )}
    >
      {formatRupiah(value, { signed, prefix: !noPrefix })}
    </span>
  );
}

/** `12500` → `"12.500 L"`. */
export function formatLiter(value: number): string {
  if (!Number.isFinite(value)) return "- L";
  return `${formatRupiah(value, { prefix: false })} L`;
}

export type LiterTextProps = { value: number | null | undefined; className?: string };

/** Teks volume `5.000 L`. */
export function LiterText({ value, className }: LiterTextProps) {
  if (value === null || value === undefined) {
    return <span className={cn("tabular text-muted-foreground", className)}>—</span>;
  }
  return <span className={cn("tabular whitespace-nowrap", className)}>{formatLiter(value)}</span>;
}
