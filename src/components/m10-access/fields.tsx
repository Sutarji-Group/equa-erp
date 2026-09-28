import type { ComponentProps, ReactNode } from "react";

import { StatusBadge, ToneBadge, type StatusTone } from "@/components/shared/status-badge";
import { label, type EnumName } from "@/lib/labels";
import { cn } from "@/lib/utils";

/** Baris isian berlabel (server-safe). */
export function FormRow({ label: text, htmlFor, hint, children, className }: { label: string; htmlFor: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {text}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const control =
  "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full min-w-0 rounded-md border px-3 py-1 text-base shadow-xs outline-none focus-visible:ring-[3px] md:text-sm";

/** Select bawaan peramban bergaya shadcn (tanpa JS; aman di Server Component & ponsel). */
export function NativeSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={cn(control, "pr-8", props.multiple && "h-auto py-2", className)} {...props}>
      {children}
    </select>
  );
}

/** Area teks sederhana bergaya shadcn. */
export function TextArea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(control, "h-auto min-h-20 py-2", className)} {...props} />;
}

/** Input bergaya shadcn (server-safe). */
export function TextInput({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, className)} {...props} />;
}

/** Nada lencana untuk enum M10 yang belum ada di peta nada bersama. */
const TONES: Partial<Record<EnumName, Record<string, StatusTone>>> = {
  user_status: { pending_approval: "warning", active: "success", inactive: "muted", locked: "danger" },
  grant_status: { pending: "warning", active: "success", revoked: "muted", rejected: "danger" },
  device_status: { registered: "info", active: "success", blocked: "danger", wipe_pending: "warning", wiped: "muted" },
  incident_status: { open: "danger", acknowledged: "warning", resolved: "success" },
  incident_severity: { critical: "danger", major: "warning", minor: "neutral" },
  ticket_status: { received: "warning", answered: "info", done: "success" },
  anonymization_status: { submitted: "warning", approved: "info", rejected: "danger", executed: "success", deferred: "warning" },
  backup_status: { success: "success", failed: "danger" },
  access_review_status: { draft: "warning", reviewed: "success" },
  signoff_status: { draft: "warning", signed: "success", superseded: "muted" },
};

/** Lencana status enum M10 (label Indonesia + nada). */
export function M10Badge({ enumName, value }: { enumName: EnumName; value: string | null | undefined }) {
  const tone = value ? TONES[enumName]?.[value] : undefined;
  if (!tone) return <StatusBadge enumName={enumName} value={value ?? ""} />;
  return (
    <ToneBadge tone={tone} dot>
      {label(enumName, value ?? null)}
    </ToneBadge>
  );
}

/** Pembungkus tabel yang dapat digulir mendatar di ponsel. */
export function TableScroll({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0", className)}>{children}</div>;
}

/** Bagian lipat tanpa JS (`<details>`) untuk formulir tindakan sekunder. */
export function Disclosure({ summary, children, className, open }: { summary: string; children: ReactNode; className?: string; open?: boolean }) {
  return (
    <details className={cn("rounded-md border p-3 [&_summary]:cursor-pointer", className)} open={open}>
      <summary className="text-sm font-medium">{summary}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
