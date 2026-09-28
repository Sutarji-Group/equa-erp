"use client";

/**
 * Formulir Server Action layar kantor M3 (/sopir-kantor): galat layanan berbahasa Indonesia tampil apa adanya, toast
 * saat berhasil. Tetap berfungsi tanpa JavaScript (form action; berkas bukti dikirim multipart otomatis oleh React).
 */
import { LoaderCircle } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { M3ActionState } from "./office-action-state";

export function M3ActionForm({
  action,
  children,
  submitLabel = "Simpan",
  variant = "default",
  className,
  testId,
}: {
  action: (state: M3ActionState, formData: FormData) => Promise<M3ActionState>;
  children?: ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
  testId?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as M3ActionState);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
      ref.current?.reset();
    }
  }, [state]);
  return (
    <form ref={ref} action={formAction} className={cn("grid gap-3", className)} data-testid={testId}>
      {children}
      {state.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.ok && state.message ? (
        <p role="status" className="text-sm text-success">
          {state.message}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

const inputCls = "h-10 rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export function Field({ label, name, type = "text", defaultValue, required, hint, inputMode, placeholder }: { label: string; name: string; type?: string; defaultValue?: string | number | null; required?: boolean; hint?: string; inputMode?: "numeric" | "text"; placeholder?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input name={name} type={type} defaultValue={defaultValue ?? ""} required={required} inputMode={inputMode} placeholder={placeholder} className={inputCls} />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function SelectField({ label, name, options, defaultValue, required }: { label: string; name: string; options: readonly { value: string; label: string }[]; defaultValue?: string; required?: boolean }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className={inputCls}>
        {!required ? <option value="">—</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextAreaField({ label, name, required, hint, placeholder }: { label: string; name: string; required?: boolean; hint?: string; placeholder?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <textarea name={name} required={required} rows={2} placeholder={placeholder} className="rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
