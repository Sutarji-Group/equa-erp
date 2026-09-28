"use client";

/**
 * Formulir Server Action layar kantor M8 (/produksi/*): galat layanan berbahasa Indonesia ditampilkan apa adanya, toast
 * saat berhasil. Tetap berfungsi tanpa JavaScript (form action). Isian kecil: teks, angka, pilihan, area teks, berkas.
 */
import { LoaderCircle } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { M8ActionState } from "./office-action-state";

export function M8ActionForm({
  action,
  children,
  submitLabel = "Simpan",
  variant = "default",
  className,
  testId,
  resetOnSuccess = true,
}: {
  action: (state: M8ActionState, formData: FormData) => Promise<M8ActionState>;
  children?: ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
  testId?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {} as M8ActionState);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
      if (resetOnSuccess) ref.current?.reset();
    }
  }, [state, resetOnSuccess]);
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

const INPUT = "h-10 rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** Isian teks/angka/tanggal berlabel. */
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
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  hint?: string;
  inputMode?: "numeric" | "text" | "decimal";
  placeholder?: string;
  min?: string | number;
  max?: string | number;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input name={name} type={type} defaultValue={defaultValue ?? ""} required={required} inputMode={inputMode} placeholder={placeholder} min={min} max={max} className={INPUT} />
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
  placeholder,
  hint,
}: {
  label: string;
  name: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string | null;
  required?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <select name={name} defaultValue={defaultValue ?? ""} required={required} className={INPUT}>
        {placeholder ? <option value="">{placeholder}</option> : null}
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

export function TextareaField({ label, name, defaultValue, required, placeholder, hint, rows = 3 }: { label: string; name: string; defaultValue?: string | null; required?: boolean; placeholder?: string; hint?: string; rows?: number }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <textarea
        name={name}
        defaultValue={defaultValue ?? ""}
        required={required}
        placeholder={placeholder}
        rows={rows}
        className="rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** Berkas foto/PDF (dikirim sebagai bagian FormData Server Action). */
export function FileField({ label, name, accept = "image/*,application/pdf", required, hint }: { label: string; name: string; accept?: string; required?: boolean; hint?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input name={name} type="file" accept={accept} required={required} className="text-sm file:mr-3 file:rounded-md file:border file:bg-secondary file:px-3 file:py-1.5" />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
