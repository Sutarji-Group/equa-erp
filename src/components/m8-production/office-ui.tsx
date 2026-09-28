/**
 * Komponen tampilan kantor M8 (Server Component — tanpa state): lencana status berwarna untuk enum M8, tab tautan,
 * filter tanggal/sumber (GET, tetap berfungsi tanpa JavaScript), dan penanda angka liter/persen.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { ToneBadge, type StatusTone } from "@/components/shared/status-badge";
import { label, type EnumName } from "@/lib/labels";
import { cn } from "@/lib/utils";

const TONES: Partial<Record<EnumName, Record<string, StatusTone>>> = {
  water_balance_status: { formed: "neutral", normal: "success", over_threshold: "danger", investigating: "warning", done: "muted", negative_anomaly: "danger" },
  production_status: { incomplete: "warning", complete: "success", combined: "info", estimated: "warning" },
  truck_fill_status: { recorded: "neutral", linked: "success", unlinked: "warning", geofence_verified: "success", geofence_mismatch: "danger" },
  meter_reading_status: { recorded: "neutral", flagged: "danger", verified: "success", superseded: "muted" },
  meter_status: { active: "success", replaced: "muted", inactive: "muted" },
  meter_adjustment_kind: { rollover: "info", replacement: "warning" },
  trip_status: { assigned: "neutral", departed: "info", arrived: "info", completed: "success", failed: "danger" },
};

/** Lencana status enum M8 (nada per nilai). */
export function M8Badge({ enumName, value }: { enumName: EnumName; value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <ToneBadge tone={TONES[enumName]?.[value] ?? "neutral"}>{label(enumName, value)}</ToneBadge>;
}

/** Tab berupa tautan (URL dapat dibagikan; Server Component). */
export function TabLinks({ tabs, active, testId }: { tabs: readonly { key: string; label: string; href: string }[]; active: string; testId?: string }) {
  return (
    <nav aria-label="Tampilan" className="flex flex-wrap gap-1 border-b" data-testid={testId}>
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", t.key === active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Filter GET: tanggal (tunggal/rentang/bulan) + sumber air opsional + isian tersembunyi tambahan. */
export function FilterForm({
  action,
  children,
  hidden = {},
}: {
  action: string;
  children: ReactNode;
  hidden?: Record<string, string | undefined>;
}) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" role="search">
      {Object.entries(hidden).map(([k, v]) => (v !== undefined ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      {children}
      <button type="submit" className="h-9 rounded-md border px-3 text-sm">
        Tampilkan
      </button>
    </form>
  );
}

export function FilterInput({ label: text, name, type = "date", defaultValue }: { label: string; name: string; type?: "date" | "month"; defaultValue?: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {text}
      <input type={type} name={name} defaultValue={defaultValue} className="h-9 rounded-md border px-2 text-sm text-foreground" />
    </label>
  );
}

export function FilterSelect({ label: text, name, options, defaultValue, allLabel = "Semua" }: { label: string; name: string; options: readonly { value: string; label: string }[]; defaultValue?: string | null; allLabel?: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {text}
      <select name={name} defaultValue={defaultValue ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Liter gaya Indonesia (mis. "5.000 L"). */
export function Liter({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return <span className={cn("tabular-nums", className)}>{Math.round(value).toLocaleString("id-ID")} L</span>;
}

/** Persen 1–2 desimal gaya Indonesia; `danger` bila melewati ambang. */
export function Pct({ value, danger, className }: { value: number | null | undefined; danger?: boolean; className?: string }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return <span className={cn("tabular-nums", danger && "font-semibold text-destructive", className)}>{value.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%</span>;
}
