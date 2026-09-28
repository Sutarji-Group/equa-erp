import { FileDown, FileSpreadsheet } from "lucide-react";
import type { ReactNode } from "react";

import { type StatusTone, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { label } from "@/lib/labels";

/**
 * Pembantu tampilan kantor Piutang (/piutang/*) — Server Component, tanpa JavaScript: formulir penyaring GET, isian
 * formulir aksi, ekspor ber-data pribadi dengan tujuan (BR-39), dan lencana status khas M5.
 */

/** URL dengan kueri (nilai kosong dibuang). */
export function hrefWith(path: string, query: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    sp.set(k, v === true ? "1" : String(v));
  }
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

const control = "h-9 rounded-md border border-input bg-background px-2 text-sm";

/** Formulir GET penyaring (tanpa JavaScript). */
export function FilterForm({ action, children, submitLabel = "Tampilkan", testId }: { action: string; children: ReactNode; submitLabel?: string; testId?: string }) {
  return (
    <form action={action} method="get" className="flex flex-wrap items-end gap-2" data-testid={testId}>
      {children}
      <button type="submit" className="h-9 rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent">
        {submitLabel}
      </button>
    </form>
  );
}

export function FilterSelect({
  name,
  value,
  label: text,
  options,
  emptyLabel,
}: {
  name: string;
  value: string | null | undefined;
  label: string;
  options: readonly { value: string; label: string }[];
  emptyLabel?: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {text}
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

export function FilterDate({ name, value, label: text }: { name: string; value: string | null | undefined; label: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {text}
      <input type="date" name={name} defaultValue={value ?? ""} className={control} />
    </label>
  );
}

export function FilterText({ name, value, label: text, placeholder }: { name: string; value: string | null | undefined; label: string; placeholder?: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {text}
      <input type="search" name={name} defaultValue={value ?? ""} placeholder={placeholder} className={`${control} w-56`} />
    </label>
  );
}

export function FilterCheckbox({ name, checked, label: text }: { name: string; checked: boolean; label: string }) {
  return (
    <label className="flex h-9 items-center gap-2 text-sm">
      <input type="checkbox" name={name} value="1" defaultChecked={checked} className="size-4" />
      {text}
    </label>
  );
}

/** Isian berlabel untuk formulir aksi (angka/teks/tanggal/berkas). */
export function FormInput({
  label: text,
  name,
  type = "text",
  defaultValue,
  required,
  hint,
  inputMode,
  accept,
  min,
  max,
  placeholder,
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
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`grid gap-1 text-sm font-medium ${className ?? ""}`}>
      {text}
      <input
        name={name}
        type={type}
        defaultValue={type === "file" ? undefined : (defaultValue ?? "")}
        required={required}
        inputMode={inputMode}
        accept={accept}
        min={min}
        max={max}
        placeholder={placeholder}
        className="h-10 rounded-md border border-input bg-background px-3 text-base file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function FormSelect({
  label: text,
  name,
  options,
  defaultValue,
  required,
  emptyLabel,
  hint,
}: {
  label: string;
  name: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string | null;
  required?: boolean;
  emptyLabel?: string;
  hint?: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {text}
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className="h-10 rounded-md border border-input bg-background px-3 text-base">
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

export function FormTextarea({ label: text, name, required, defaultValue, hint, rows = 2 }: { label: string; name: string; required?: boolean; defaultValue?: string | null; hint?: string; rows?: number }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {text}
      <textarea
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        rows={rows}
        className="rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/**
 * Ekspor ber-data pribadi pelanggan (BR-39, US-M5-04 KP-4): POST ke `/api/export/<kunci>` dengan tujuan wajib —
 * hanya pemilik/Admin Keuangan; server mencatat `export_logs` + log akses.
 */
export function PiiExportForm({
  reportKey,
  filters = {},
  formats = ["xlsx", "pdf"],
  testId,
}: {
  reportKey: string;
  filters?: Record<string, string | number | null | undefined>;
  formats?: readonly ("xlsx" | "pdf")[];
  testId?: string;
}) {
  return (
    <form method="post" action={`/api/export/${reportKey}`} className="flex flex-wrap items-center gap-2" data-testid={testId}>
      {Object.entries(filters).map(([k, v]) => (v === null || v === undefined || v === "" ? null : <input key={k} type="hidden" name={k} value={String(v)} />))}
      <input
        name="purpose"
        required
        minLength={5}
        placeholder="Tujuan ekspor (wajib, BR-39)"
        aria-label="Tujuan ekspor"
        className="h-8 w-56 rounded-md border border-input bg-transparent px-2 text-sm"
      />
      {formats.map((f) => (
        <Button key={f} type="submit" name="format" value={f} variant="outline" size="sm">
          {f === "xlsx" ? <FileSpreadsheet aria-hidden /> : <FileDown aria-hidden />}
          {f === "xlsx" ? "Excel" : "PDF"}
        </Button>
      ))}
    </form>
  );
}

// =====================================================================================================================
// Lencana status khas M5
// =====================================================================================================================

const BUCKET_TONE: Record<string, StatusTone> = { not_due: "success", d1_7: "warning", d8_30: "danger", over_30: "danger" };
const DISPUTE_TONE: Record<string, StatusTone> = { none: "muted", disputed: "warning", resolved: "info", rejected: "neutral" };
const ADVANCE_TONE: Record<string, StatusTone> = { open: "info", applied: "muted", refunded: "neutral" };
const REMINDER_TONE: Record<string, StatusTone> = { scheduled: "warning", opened: "success", skipped: "muted" };
const INVOICE_TONE: Record<string, StatusTone> = { open: "warning", partial: "info", paid: "success" };

export function BucketBadge({ bucket, text }: { bucket: string; text?: string }) {
  return (
    <ToneBadge tone={BUCKET_TONE[bucket] ?? "neutral"} dot data-bucket={bucket}>
      {text ?? label("aging_bucket", bucket)}
    </ToneBadge>
  );
}

export function InvoiceStatusBadge({ status }: { status: string }) {
  return (
    <ToneBadge tone={INVOICE_TONE[status] ?? "neutral"} dot data-status={status}>
      {label("invoice_status", status)}
    </ToneBadge>
  );
}

export function DisputeBadge({ status }: { status: string }) {
  if (status === "none") return null;
  return <ToneBadge tone={DISPUTE_TONE[status] ?? "neutral"}>{label("dispute_status", status)}</ToneBadge>;
}

export function AdvanceBadge({ status }: { status: string }) {
  return <ToneBadge tone={ADVANCE_TONE[status] ?? "neutral"}>{label("advance_status", status)}</ToneBadge>;
}

export function ReminderBadge({ status }: { status: string }) {
  return (
    <ToneBadge tone={REMINDER_TONE[status] ?? "neutral"} dot data-status={status}>
      {label("reminder_status", status)}
    </ToneBadge>
  );
}

/** Kalimat hari lewat jatuh tempo ("3 hari lewat" / "jatuh tempo 5 hari lagi" / "jatuh tempo hari ini"). */
export function dueText(daysPastDue: number): string {
  if (daysPastDue > 0) return `${daysPastDue} hari lewat`;
  if (daysPastDue === 0) return "jatuh tempo hari ini";
  return `jatuh tempo ${-daysPastDue} hari lagi`;
}
