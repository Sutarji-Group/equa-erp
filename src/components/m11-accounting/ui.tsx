import Link from "next/link";
import type { ReactNode } from "react";

import { type StatusTone, ToneBadge } from "@/components/shared/status-badge";
import { enumOptions, label, type ProfitCenter } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * Pembantu tampilan kantor Akuntansi (/akuntansi/*) — Server Component, tanpa JavaScript: penyaring GET, isian formulir
 * aksi, editor baris jurnal (baris tetap, berfungsi tanpa JS), lencana status jurnal/periode/antrean, tautan ekspor.
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

/** Tautan unduh ekspor laporan terdaftar (`/api/export/<kunci>`). */
export function exportHref(report: string, format: "xlsx" | "pdf" | "csv", filters: Record<string, string | null | undefined> = {}): string {
  return hrefWith(`/api/export/${report}`, { format, ...filters });
}

const control = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const fieldControl = "h-10 rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

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

export function FilterSelect({ name, value, label: text, options, emptyLabel }: { name: string; value: string | null | undefined; label: string; options: readonly { value: string; label: string }[]; emptyLabel?: string }) {
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

export function FilterInput({ name, value, label: text, type = "text", placeholder }: { name: string; value: string | null | undefined; label: string; type?: string; placeholder?: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium">
      {text}
      <input type={type} name={name} defaultValue={value ?? ""} placeholder={placeholder} className={cn(control, type === "search" ? "w-56" : undefined)} />
    </label>
  );
}

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
  step,
  placeholder,
  className,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  hint?: string;
  inputMode?: "numeric" | "text" | "decimal";
  accept?: string;
  min?: string;
  max?: string;
  step?: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cn("grid gap-1 text-sm font-medium", className)}>
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
        step={step}
        placeholder={placeholder}
        className={cn(fieldControl, "file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium")}
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
      {text}
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className={fieldControl}>
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
      <textarea name={name} required={required} defaultValue={defaultValue ?? ""} rows={rows} className="rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function FormCheckbox({ name, label: text, defaultChecked, hint }: { name: string; label: string; defaultChecked?: boolean; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name={name} value="1" defaultChecked={defaultChecked} className="mt-0.5 size-4" />
      <span>
        {text}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

export const PROFIT_CENTER_OPTIONS = enumOptions("profit_center");

export type AccountOption = { id: string; code: string; name: string };

/**
 * Editor baris jurnal berbaris tetap (tanpa JavaScript): `line_account_<i>`, `line_pc_<i>`, `line_outlet_<i>`,
 * `line_debit_<i>`, `line_credit_<i>`, `line_memo_<i>`. Baris tanpa akun diabaikan server.
 */
export function JournalLinesInput({
  accounts,
  outlets,
  rows = 6,
  defaults = [],
  showOutlet = true,
  testId,
}: {
  accounts: readonly AccountOption[];
  outlets?: readonly { id: string; name: string }[];
  rows?: number;
  defaults?: readonly { accountId?: string | null; profitCenter?: ProfitCenter | null; outletId?: string | null; debit?: number; credit?: number; memo?: string | null }[];
  showOutlet?: boolean;
  testId?: string;
}) {
  const accountOptions = accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }));
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 pr-2">Akun</th>
            <th className="py-1 pr-2">Pusat laba</th>
            {showOutlet ? <th className="py-1 pr-2">Outlet</th> : null}
            <th className="py-1 pr-2 text-right">Debit (Rp)</th>
            <th className="py-1 pr-2 text-right">Kredit (Rp)</th>
            <th className="py-1">Memo</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => {
            const d = defaults[i];
            return (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <select name={`line_account_${i}`} defaultValue={d?.accountId ?? ""} aria-label={`Akun baris ${i + 1}`} className={cn(control, "w-64")}>
                    <option value="">—</option>
                    {accountOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <select name={`line_pc_${i}`} defaultValue={d?.profitCenter ?? "SHARED"} aria-label={`Pusat laba baris ${i + 1}`} className={control}>
                    {PROFIT_CENTER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </td>
                {showOutlet ? (
                  <td className="py-1 pr-2">
                    <select name={`line_outlet_${i}`} defaultValue={d?.outletId ?? ""} aria-label={`Outlet baris ${i + 1}`} className={cn(control, "w-36")}>
                      <option value="">—</option>
                      {(outlets ?? []).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </td>
                ) : null}
                <td className="py-1 pr-2">
                  <input name={`line_debit_${i}`} inputMode="numeric" defaultValue={d?.debit ? String(d.debit) : ""} aria-label={`Debit baris ${i + 1}`} className={cn(control, "w-32 text-right")} />
                </td>
                <td className="py-1 pr-2">
                  <input name={`line_credit_${i}`} inputMode="numeric" defaultValue={d?.credit ? String(d.credit) : ""} aria-label={`Kredit baris ${i + 1}`} className={cn(control, "w-32 text-right")} />
                </td>
                <td className="py-1">
                  <input name={`line_memo_${i}`} defaultValue={d?.memo ?? ""} aria-label={`Memo baris ${i + 1}`} className={cn(control, "w-48")} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// =====================================================================================================================
// Lencana & teks khas M11
// =====================================================================================================================

const JOURNAL_TONE: Record<string, StatusTone> = { draft: "neutral", submitted: "warning", approved: "info", posted: "success", rejected: "danger" };
const QUEUE_TONE: Record<string, StatusTone> = { pending: "warning", resolved: "success", failed: "danger" };
const PERIOD_TONE: Record<string, StatusTone> = { open: "success", closed: "info", locked: "muted", reopened: "warning" };
const BATCH_TONE: Record<string, StatusTone> = { draft: "neutral", signed: "info", posted: "success" };
const REC_TONE: Record<string, StatusTone> = { in_progress: "warning", zero_difference: "success" };

export function JournalStatusBadge({ status }: { status: string }) {
  return (
    <ToneBadge tone={JOURNAL_TONE[status] ?? "neutral"} dot data-status={status}>
      {label("journal_status", status)}
    </ToneBadge>
  );
}

export function JournalKindBadge({ kind }: { kind: string }) {
  return <ToneBadge tone={kind === "auto" ? "info" : kind.includes("reversal") ? "warning" : "neutral"}>{label("journal_kind", kind)}</ToneBadge>;
}

export function QueueStatusBadge({ status }: { status: string }) {
  return (
    <ToneBadge tone={QUEUE_TONE[status] ?? "neutral"} dot>
      {label("journal_queue_status", status)}
    </ToneBadge>
  );
}

export function PeriodStatusBadge({ status, late }: { status: string; late?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <ToneBadge tone={PERIOD_TONE[status] ?? "neutral"} dot data-status={status}>
        {label("period_status", status)}
      </ToneBadge>
      {late ? <ToneBadge tone="danger">Terlambat</ToneBadge> : null}
    </span>
  );
}

export function BatchStatusBadge({ status }: { status: string }) {
  return (
    <ToneBadge tone={BATCH_TONE[status] ?? "neutral"} dot data-status={status}>
      {label("opening_batch_status", status)}
    </ToneBadge>
  );
}

export function RecStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <ToneBadge tone="neutral">Belum dikerjakan</ToneBadge>;
  return (
    <ToneBadge tone={REC_TONE[status] ?? "neutral"} dot data-status={status}>
      {label("reconciliation_status", status)}
    </ToneBadge>
  );
}

/** Label status laporan keuangan (Sementara/Final + revisi + retroaktif). */
export function StatementStatusBadge({ status, revision, retroactive }: { status: "provisional" | "final"; revision: number; retroactive: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="status-laporan">
      <ToneBadge tone={status === "final" ? "success" : "warning"} dot>
        {status === "final" ? "Final" : "Sementara"}
        {revision > 1 ? ` (revisi ${revision})` : ""}
      </ToneBadge>
      {retroactive ? <ToneBadge tone="info">Dibangkitkan retroaktif, diverifikasi akuntan</ToneBadge> : null}
    </span>
  );
}

/** Angka rupiah rata kanan; nol tampil "—". */
export function Amount({ value, className, strong }: { value: number; className?: string; strong?: boolean }) {
  return <span className={cn("tabular-nums", strong && "font-semibold", value < 0 && "text-destructive", className)}>{value === 0 ? "—" : formatRupiah(value)}</span>;
}

/** Tautan jurnal (nomor → rincian). */
export function JournalLink({ id, number }: { id: string; number: string }) {
  return (
    <Link href={`/akuntansi/jurnal/${id}`} className="font-mono text-primary hover:underline">
      {number}
    </Link>
  );
}

/** Pilihan periode 'YYYY-MM' (bulan berjalan & N bulan ke belakang). */
export function periodOptions(current: string, back = 12, forward = 0): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const [y, m] = current.split("-").map(Number) as [number, number];
  for (let i = -forward; i <= back; i++) {
    const idx = y * 12 + (m - 1) - i;
    const p = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
    out.push({ value: p, label: periodLabel(p) });
  }
  return out;
}

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

/** '2026-09' → 'September 2026'. */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? period} ${y}`;
}
