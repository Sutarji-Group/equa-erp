import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Tab berbasis tautan (`?tab=`) untuk halaman kantor M6 — Server Component, tetap berfungsi tanpa JavaScript dan
 * dapat dibagikan sebagai URL.
 */
export function LinkTabs({ tabs, active, hrefFor, label }: { tabs: readonly { key: string; label: string; count?: number }[]; active: string; hrefFor: (key: string) => string; label: string }) {
  return (
    <nav aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b px-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={hrefFor(t.key)}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "inline-flex min-h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap",
            t.key === active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
          {t.count ? <span className="rounded-full bg-warning px-1.5 text-xs text-warning-foreground">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** Formulir GET rentang tanggal (+ outlet opsional) untuk laporan kantor. */
export function RangeFilter({
  action,
  from,
  to,
  outlets,
  outletId,
  hidden,
  extra,
}: {
  action: string;
  from: string;
  to: string;
  outlets?: readonly { id: string; code: string; name: string }[];
  outletId?: string | null;
  hidden?: Record<string, string>;
  extra?: ReactNode;
}) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-testid="filter-laporan">
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label className="grid gap-1 text-xs font-medium">
        Dari
        <input type="date" name="dari" defaultValue={from} className="h-9 rounded-md border bg-background px-2 text-sm" />
      </label>
      <label className="grid gap-1 text-xs font-medium">
        Sampai
        <input type="date" name="sampai" defaultValue={to} className="h-9 rounded-md border bg-background px-2 text-sm" />
      </label>
      {outlets ? (
        <label className="grid gap-1 text-xs font-medium">
          Outlet
          <select name="outlet" defaultValue={outletId ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">Semua outlet</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} · {o.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {extra}
      <button type="submit" className="h-9 rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent">
        Tampilkan
      </button>
    </form>
  );
}

/** Angka selisih bertanda (+/−) dengan warna. */
export function SignedNumber({ value, suffix = "", money = false }: { value: number | null | undefined; suffix?: string; money?: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  const abs = Math.abs(value);
  const text = money ? `Rp${abs.toLocaleString("id-ID")}` : abs.toLocaleString("id-ID");
  return <span className={value < 0 ? "text-destructive" : value > 0 ? "text-warning-foreground" : undefined}>{`${value < 0 ? "−" : value > 0 ? "+" : ""}${text}${suffix}`}</span>;
}
