"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Kartu bagian layar POS (teks besar, kontras tinggi). */
export function PosSection({ title, children, actions, className, testId }: { title: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={cn("flex flex-col gap-3 rounded-2xl border-2 bg-card p-4", className)} data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Pita peringatan/informasi. */
export function Banner({ tone = "warning", children, role = "status" }: { tone?: "warning" | "danger" | "info" | "success"; children: ReactNode; role?: "status" | "alert" }) {
  return (
    <div
      role={role}
      className={cn(
        "rounded-xl border-2 p-3 text-base",
        tone === "warning" && "border-warning bg-warning/15",
        tone === "danger" && "border-destructive/50 bg-destructive/5 text-destructive",
        tone === "info" && "border-primary/40 bg-primary/5",
        tone === "success" && "border-success bg-success/10",
      )}
    >
      {children}
    </div>
  );
}

/** Isian angka besar (uang/jumlah/liter) — hanya angka bulat ≥ 0. */
export function NumberField({
  label,
  value,
  onChange,
  suffix,
  prefix,
  hint,
  id,
  min = 0,
}: {
  label: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  suffix?: string;
  prefix?: string;
  hint?: ReactNode;
  id: string;
  min?: number;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-base font-medium">
      {label}
      <span className="flex items-center gap-2">
        {prefix ? <span className="text-lg text-muted-foreground">{prefix}</span> : null}
        <input
          id={id}
          inputMode="numeric"
          pattern="[0-9]*"
          value={value === null ? "" : String(value)}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^0-9]/g, "");
            if (digits === "") return onChange(null);
            const n = Math.max(min, Number(digits));
            onChange(Number.isSafeInteger(n) ? n : null);
          }}
          className="tabular min-h-14 w-full rounded-xl border-2 border-input bg-background px-4 text-xl font-semibold focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
        />
        {suffix ? <span className="text-lg text-muted-foreground">{suffix}</span> : null}
      </span>
      {hint ? <span className="text-sm font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** Isian teks alasan. */
export function ReasonField({ label, value, onChange, id, placeholder }: { label: ReactNode; value: string; onChange: (v: string) => void; id: string; placeholder?: string }) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-base font-medium">
      {label}
      <input
        id={id}
        value={value}
        maxLength={300}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-14 rounded-xl border-2 border-input bg-background px-4 text-lg focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
      />
    </label>
  );
}

/** Pilihan tombol besar (radio). */
export function ChoiceButtons<T extends string>({ value, onChange, options, label }: { value: T | null; onChange: (v: T) => void; options: readonly { value: T; label: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-14 rounded-xl border-2 px-3 text-base font-semibold focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none",
            value === o.value ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Pesan galat tindakan (dari enqueue/validasi). */
export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-3 text-base text-destructive">
      {children}
    </p>
  );
}
