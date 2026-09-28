import Link from "next/link";
import type { ReactNode } from "react";

import { ToneBadge, type StatusTone } from "@/components/shared/status-badge";
import type { KpiStatus } from "@/client/m9-reports/types";
import { cn } from "@/lib/utils";

/**
 * Isian & navigasi sederhana layar laporan (Server Component, tanpa JavaScript): tab tautan, formulir filter GET,
 * isian berlabel, pembuat URL, lencana status KPI, perubahan (%) terhadap periode sebelumnya.
 */

const control =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:text-sm";

export function hrefWith(path: string, query: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

/** Tab berupa tautan (tanpa JavaScript) — bergulir mendatar di dalam dirinya sendiri, bukan halaman (NFR-19). */
export function LinkTabs({ tabs, active, label }: { tabs: readonly { key: string; label: ReactNode; href: string }[]; active: string; label: string }) {
  return (
    <nav aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b px-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "-mb-px shrink-0 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
            t.key === active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Formulir GET untuk filter (tanggal/bulan). */
export function FilterForm({ action, children, submitLabel = "Tampilkan", testId }: { action: string; children: ReactNode; submitLabel?: string; testId?: string }) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-testid={testId}>
      {children}
      <button type="submit" className="h-9 rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent">
        {submitLabel}
      </button>
    </form>
  );
}

export function FilterInput({ name, value, label, type = "date", max }: { name: string; value: string | null | undefined; label: string; type?: "date" | "month"; max?: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {label}
      <input type={type} name={name} defaultValue={value ?? ""} max={max} className="h-9 rounded-md border bg-background px-2 text-sm" />
    </label>
  );
}

export function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required,
  hint,
  inputMode,
  placeholder,
  step,
  min,
  max,
  className,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  hint?: string;
  inputMode?: "numeric" | "decimal" | "text";
  placeholder?: string;
  step?: string;
  min?: string;
  max?: string;
  className?: string;
}) {
  return (
    <label className={cn("grid gap-1 text-sm font-medium", className)}>
      {label}
      <input name={name} type={type} defaultValue={defaultValue ?? ""} required={required} inputMode={inputMode} placeholder={placeholder} step={step} min={min} max={max} className={control} />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function SelectField({
  label,
  name,
  options,
  defaultValue,
  required,
  emptyLabel,
  hint,
  className,
}: {
  label: string;
  name: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string | null;
  required?: boolean;
  emptyLabel?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={cn("grid gap-1 text-sm font-medium", className)}>
      {label}
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className={control}>
        {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function TextareaField({ label, name, required, hint, defaultValue, className }: { label: string; name: string; required?: boolean; hint?: string; defaultValue?: string | null; className?: string }) {
  return (
    <label className={cn("grid gap-1 text-sm font-medium", className)}>
      {label}
      <textarea name={name} required={required} defaultValue={defaultValue ?? ""} rows={2} className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:text-sm" />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const KPI_TONE: Record<KpiStatus, StatusTone> = { met: "success", not_met: "danger", baseline: "info", pending: "warning", no_data: "muted" };
const KPI_LABEL: Record<KpiStatus, string> = { met: "Tercapai", not_met: "Belum tercapai", baseline: "Baseline", pending: "Menunggu", no_data: "Belum ada data" };

export function KpiStatusBadge({ status }: { status: KpiStatus }) {
  return (
    <ToneBadge tone={KPI_TONE[status]} dot>
      {KPI_LABEL[status]}
    </ToneBadge>
  );
}

/** Perubahan (%) terhadap periode sebelumnya; `invert` = naik itu buruk (mis. % lewat tempo). */
export function ChangeText({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
  const up = value > 0;
  const good = value === 0 ? null : invert ? !up : up;
  return (
    <span className={cn("text-xs font-medium", good === null ? "text-muted-foreground" : good ? "text-success" : "text-destructive")}>
      {up ? "▲" : value < 0 ? "▼" : "•"} {Math.abs(value).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%
    </span>
  );
}

/** Tabel dengan gulir mendatar DI DALAM kartu (halaman tidak bergulir mendatar di ponsel — US-M9-01 KP-5). */
export function ScrollTable({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="max-w-full overflow-x-auto" data-testid={testId}>
      {children}
    </div>
  );
}
