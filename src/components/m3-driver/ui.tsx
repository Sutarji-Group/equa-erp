"use client";

/**
 * Komponen kecil aplikasi sopir (teks ≥ 16 pt, target sentuh ≥ 56 px, kontras tinggi — NFR-18).
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Section({ title, children, actions, className, testId }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={cn("flex flex-col gap-3 rounded-2xl border-2 bg-card p-4", className)} data-testid={testId}>
      {title || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="text-lg font-bold">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Banner({ tone = "warning", children, role = "status", testId }: { tone?: "warning" | "danger" | "info" | "success"; children: ReactNode; role?: "status" | "alert"; testId?: string }) {
  return (
    <div
      role={role}
      data-testid={testId}
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

export function NumberField({ label, value, onChange, suffix, prefix, hint, id, testId }: { label: ReactNode; value: number | null; onChange: (v: number | null) => void; suffix?: string; prefix?: string; hint?: ReactNode; id: string; testId?: string }) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-base font-medium">
      {label}
      <span className="flex items-center gap-2">
        {prefix ? <span className="text-lg text-muted-foreground">{prefix}</span> : null}
        <input
          id={id}
          data-testid={testId}
          inputMode="numeric"
          pattern="[0-9]*"
          value={value === null ? "" : String(value)}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^0-9]/g, "");
            if (digits === "") return onChange(null);
            const n = Number(digits);
            onChange(Number.isSafeInteger(n) ? n : null);
          }}
          className="min-h-14 w-full rounded-xl border-2 border-input bg-background px-4 text-xl font-semibold tabular-nums focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
        />
        {suffix ? <span className="text-lg text-muted-foreground">{suffix}</span> : null}
      </span>
      {hint ? <span className="text-sm font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function TextField({ label, value, onChange, id, placeholder, multiline, maxLength = 300 }: { label: ReactNode; value: string; onChange: (v: string) => void; id: string; placeholder?: string; multiline?: boolean; maxLength?: number }) {
  const cls = "rounded-xl border-2 border-input bg-background px-4 text-lg focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none";
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-base font-medium">
      {label}
      {multiline ? (
        <textarea id={id} value={value} maxLength={maxLength} placeholder={placeholder} rows={3} onChange={(e) => onChange(e.target.value)} className={cn(cls, "py-3")} />
      ) : (
        <input id={id} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cn(cls, "min-h-14")} />
      )}
    </label>
  );
}

/** Pilihan tombol besar (radio). */
export function Choices<T extends string>({ value, onChange, options, label, columns = 2 }: { value: T | null; onChange: (v: T) => void; options: readonly { value: T; label: string }[]; label: string; columns?: 1 | 2 }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-base font-medium">{label}</p>
      <div role="radiogroup" aria-label={label} className={cn("grid gap-2", columns === 2 ? "grid-cols-2" : "grid-cols-1")}>
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
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-3 text-base text-destructive">
      {children}
    </p>
  );
}

/** Baris angka ringkasan (label kiri, nilai kanan). */
export function FigureRow({ label, value, strong, testId }: { label: ReactNode; value: ReactNode; strong?: boolean; testId?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 text-base", strong && "text-lg font-bold")}>
      <span>{label}</span>
      <span className="tabular-nums" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
