/**
 * Isian formulir sederhana Kemitraan (server-safe; dipakai di dalam `P3ActionForm`). Teks ≥ 16px agar nyaman di ponsel.
 */
import type { ReactNode } from "react";

const INPUT = "h-10 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

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
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  hint?: string;
  inputMode?: "numeric" | "text" | "decimal" | "tel";
  placeholder?: string;
  step?: string;
  min?: string;
  max?: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input name={name} type={type} defaultValue={defaultValue ?? ""} required={required} inputMode={inputMode} placeholder={placeholder} step={step} min={min} max={max} className={INPUT} />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function SelectField({ label, name, options, defaultValue, required, hint }: { label: string; name: string; options: { value: string; label: string }[]; defaultValue?: string | null; required?: boolean; hint?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className={INPUT}>
        {!required || !defaultValue ? <option value="">— pilih —</option> : null}
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

export function TextAreaField({ label, name, required, hint, defaultValue, rows = 3 }: { label: string; name: string; required?: boolean; hint?: string; defaultValue?: string | null; rows?: number }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <textarea name={name} required={required} defaultValue={defaultValue ?? ""} rows={rows} className="w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function FileField({ label, name, required, accept = "image/jpeg,image/png,image/webp,application/pdf", hint }: { label: string; name: string; required?: boolean; accept?: string; hint?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input type="file" name={name} required={required} accept={accept} className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-secondary file:px-3 file:py-2" />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint ?? "Foto atau PDF, maksimal 4 MB."}</span> : null}
    </label>
  );
}

export function CheckField({ label, name, defaultChecked }: { label: ReactNode; name: string; defaultChecked?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" name={name} value="on" defaultChecked={defaultChecked} className="size-4" /> {label}
    </label>
  );
}

/** Saringan bulan (GET) — `?bulan=YYYY-MM` + parameter tersembunyi lain. */
export function MonthFilter({ month, hidden = {}, label = "Bulan" }: { month: string; hidden?: Record<string, string | null | undefined>; label?: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      {Object.entries(hidden).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <label className="grid gap-1 text-sm font-medium">
        {label}
        <input type="month" name="bulan" defaultValue={month} className="h-10 rounded-md border border-input bg-background px-3 text-base" />
      </label>
      <button type="submit" className="h-10 rounded-md border border-input bg-secondary px-4 text-sm font-medium">
        Tampilkan
      </button>
    </form>
  );
}
