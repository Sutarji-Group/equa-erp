import type { ReactNode } from "react";

/**
 * Pembantu tampilan kantor toko (/toko/*) — Server Component, tanpa JavaScript: pemilih toko (bila tenant punya lebih
 * dari satu toko), pemilih bulan, dan pembuat URL dengan kueri.
 */

/** URL dengan kueri (nilai kosong dibuang). */
export function hrefWith(path: string, query: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

const control = "h-9 rounded-md border bg-background px-2 text-sm";

/** Formulir GET: pilih toko (disembunyikan bila hanya satu toko) + isian tambahan (bulan, rentang, dll.). */
export function StoreFilter({
  action,
  stores,
  storeId,
  hidden,
  children,
  submitLabel = "Tampilkan",
}: {
  action: string;
  stores: readonly { id: string; code: string; name: string }[];
  storeId: string | null;
  hidden?: Record<string, string | null | undefined>;
  children?: ReactNode;
  submitLabel?: string;
}) {
  const showStores = stores.length > 1;
  if (!showStores && !children) return null;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-testid="filter-toko">
      {Object.entries(hidden ?? {}).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      {showStores ? (
        <label className="grid gap-1 text-xs font-medium">
          Toko
          <select name="toko" defaultValue={storeId ?? ""} className={control}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>
        </label>
      ) : storeId ? (
        <input type="hidden" name="toko" value={storeId} />
      ) : null}
      {children}
      <button type="submit" className="h-9 rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent">
        {submitLabel}
      </button>
    </form>
  );
}

export function MonthInput({ name = "bulan", value, label = "Bulan" }: { name?: string; value: string; label?: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {label}
      <input type="month" name={name} defaultValue={value} className={control} />
    </label>
  );
}

export function DateInput({ name, value, label }: { name: string; value: string | null | undefined; label: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {label}
      <input type="date" name={name} defaultValue={value ?? ""} className={control} />
    </label>
  );
}

export function SelectInput({ name, value, label, options, emptyLabel }: { name: string; value: string | null | undefined; label: string; options: readonly { value: string; label: string }[]; emptyLabel?: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {label}
      <select name={name} defaultValue={value ?? ""} className={control}>
        {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Isian berlabel untuk formulir aksi (angka/teks/tanggal/berkas). */
export function FormInput({
  label,
  name,
  type = "text",
  defaultValue,
  required,
  hint,
  inputMode,
  accept,
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
  accept?: string;
  min?: string;
  max?: string;
  className?: string;
}) {
  return (
    <label className={`grid gap-1 text-sm font-medium ${className ?? ""}`}>
      {label}
      <input
        name={name}
        type={type}
        defaultValue={type === "file" ? undefined : (defaultValue ?? "")}
        required={required}
        inputMode={inputMode}
        accept={accept}
        min={min}
        max={max}
        className="h-10 rounded-md border border-input bg-background px-3 text-base file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function FormSelect({ label, name, options, defaultValue, required, emptyLabel }: { label: string; name: string; options: readonly { value: string; label: string }[]; defaultValue?: string | null; required?: boolean; emptyLabel?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className="h-10 rounded-md border border-input bg-background px-3 text-base">
        {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FormTextarea({ label, name, required, defaultValue, hint }: { label: string; name: string; required?: boolean; defaultValue?: string | null; hint?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <textarea name={name} required={required} defaultValue={defaultValue ?? ""} rows={2} className="rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
