import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Isian & navigasi sederhana layar kas (Server Component, tanpa JavaScript): isian berlabel, pilihan, area teks,
 * berkas, tab tautan, formulir filter GET, pembuat URL.
 */

const control =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:text-sm";

export function hrefWith(path: string, query: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
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
  inputMode?: "numeric" | "text";
  placeholder?: string;
  min?: string;
  max?: string;
  className?: string;
}) {
  return (
    <label className={cn("grid gap-1 text-sm font-medium", className)}>
      {label}
      <input name={name} type={type} defaultValue={defaultValue ?? ""} required={required} inputMode={inputMode} placeholder={placeholder} min={min} max={max} className={control} />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** Isian rupiah (angka bulat; titik ribuan boleh diketik). */
export function MoneyField(props: { label: string; name: string; defaultValue?: number | null; required?: boolean; hint?: string; className?: string }) {
  return <Field {...props} inputMode="numeric" placeholder="0" />;
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

export function FileField({ label, name, accept = "image/jpeg,image/png,image/webp", required, hint }: { label: string; name: string; accept?: string; required?: boolean; hint?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input name={name} type="file" accept={accept} capture={accept.startsWith("image") ? "environment" : undefined} required={required} className="text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1.5" />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** Tab berupa tautan (tanpa JavaScript). */
export function LinkTabs({ tabs, active, label }: { tabs: readonly { key: string; label: ReactNode; href: string }[]; active: string; label: string }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium",
            t.key === active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Formulir GET untuk filter (tanggal/rentang/status). */
export function FilterForm({ action, children, submitLabel = "Tampilkan" }: { action: string; children: ReactNode; submitLabel?: string }) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-testid="filter-kas">
      {children}
      <button type="submit" className="h-9 rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent">
        {submitLabel}
      </button>
    </form>
  );
}

export function DateFilterInput({ name, value, label }: { name: string; value: string | null | undefined; label: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {label}
      <input type="date" name={name} defaultValue={value ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm" />
    </label>
  );
}

export function SelectFilterInput({ name, value, label, options }: { name: string; value: string | null | undefined; label: string; options: readonly { value: string; label: string }[] }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {label}
      <select name={name} defaultValue={value ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Tombol hubungi (telepon & WhatsApp) untuk sumber penghalang tutup kas (US-M4-06 KP-1). */
export function ContactLinks({ phone, waNumber }: { phone: string | null; waNumber: string | null }) {
  if (!phone && !waNumber) return <span className="text-xs text-muted-foreground">Nomor belum tercatat</span>;
  return (
    <span className="inline-flex flex-wrap gap-2">
      {phone ? (
        <a href={`tel:${phone}`} className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium hover:bg-accent">
          Telepon
        </a>
      ) : null}
      {waNumber ? (
        <a href={`https://wa.me/${waNumber}`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium hover:bg-accent">
          WhatsApp
        </a>
      ) : null}
    </span>
  );
}
