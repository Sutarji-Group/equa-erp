import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const bigButtonVariants = cva(
  [
    "inline-flex min-h-14 w-full select-none items-center justify-center gap-3 rounded-xl px-5 py-3",
    "text-lg leading-tight font-semibold text-balance text-center",
    "transition-[transform,background-color,box-shadow] active:scale-[0.98]",
    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/60",
    "disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-6",
  ],
  {
    variants: {
      variant: {
        /** Tindakan utama (Berangkat, Simpan, Bayar). */
        primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        /** Tindakan berisiko / gagal / batal. */
        danger: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        /** Tindakan penyelesai (Selesai, Terima). */
        success: "bg-success text-success-foreground shadow-sm hover:bg-success/90",
        /** Tindakan sekunder. */
        secondary: "border-2 border-border bg-secondary text-secondary-foreground hover:bg-secondary/80",
        /** Garis tepi saja (pilihan dalam daftar). */
        outline: "border-2 border-input bg-background text-foreground hover:bg-accent",
      },
      size: {
        /** ≥ 56 px. */
        default: "",
        /** ≥ 80 px untuk tombol tunggal paling penting di layar. */
        xl: "min-h-20 text-xl",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export type BigButtonProps = ComponentProps<"button"> &
  VariantProps<typeof bigButtonVariants> & {
    asChild?: boolean;
    /** Ikon di kiri teks. */
    icon?: ReactNode;
    /** Teks kecil di bawah label (mis. "Rit 2 dari 5"). */
    hint?: ReactNode;
    /** Tampilkan pemutar & nonaktifkan. */
    loading?: boolean;
  };

/**
 * Tombol besar aplikasi lapangan & POS: tinggi ≥ 56 px, teks ≥ 18 px, kontras tinggi (PRD 2.1, NFR-18).
 * Varian: `primary` (utama), `danger` (bahaya), `secondary` (sekunder), `success`, `outline`.
 */
export function BigButton({
  className,
  variant,
  size,
  asChild,
  icon,
  hint,
  loading,
  disabled,
  children,
  type = "button",
  ...props
}: BigButtonProps) {
  const classes = cn(bigButtonVariants({ variant, size }), hint && "flex-col gap-0.5", className);
  if (asChild) {
    return (
      <Slot.Root data-slot="big-button" className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  const label = (
    <span className="inline-flex items-center justify-center gap-3">
      {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : icon}
      <span>{children}</span>
    </span>
  );
  return (
    <button
      data-slot="big-button"
      data-variant={variant ?? "primary"}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {hint ? (
        <>
          {label}
          <span className="text-sm font-normal opacity-90">{hint}</span>
        </>
      ) : (
        label
      )}
    </button>
  );
}
