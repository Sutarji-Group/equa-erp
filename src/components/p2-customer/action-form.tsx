"use client";

/**
 * Formulir Server Action aplikasi pelanggan & layar kantor P2: galat layanan (Bahasa Indonesia) tampil apa adanya,
 * pesan berhasil tampil di bawah formulir + toast. Tetap berfungsi tanpa JavaScript (form action).
 */
import { LoaderCircle } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { P2ActionState } from "./action-state";

export function P2ActionForm({
  action,
  children,
  submitLabel = "Simpan",
  variant = "default",
  size = "default",
  className,
  testId,
  resetOnSuccess = true,
  fullWidth,
  after,
}: {
  action: (state: P2ActionState, formData: FormData) => Promise<P2ActionState>;
  children?: ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  size?: "default" | "sm" | "lg";
  className?: string;
  testId?: string;
  resetOnSuccess?: boolean;
  fullWidth?: boolean;
  /** Isi tambahan setelah berhasil (mis. kode mode uji). */
  after?: (state: P2ActionState) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {} as P2ActionState);
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
      {after ? after(state) : null}
      <div>
        <Button type="submit" variant={variant} size={size} disabled={pending} className={cn(fullWidth && "w-full")}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Tombol aksi tunggal (tanpa isian) yang memanggil Server Action terikat argumen. */
export function P2ActionButton({ action, label, variant = "outline", size = "sm", testId }: { action: () => Promise<P2ActionState>; label: string; variant?: "default" | "outline" | "destructive" | "secondary"; size?: "default" | "sm" | "lg"; testId?: string }) {
  const [state, formAction, pending] = useActionState(async () => action(), {} as P2ActionState);
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
    if (state.error) toast.error(state.error);
  }, [state]);
  return (
    <form action={formAction} data-testid={testId}>
      <Button type="submit" variant={variant} size={size} disabled={pending}>
        {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
        {label}
      </Button>
    </form>
  );
}

export function TextField({ label, name, required, placeholder, hint, type = "text", defaultValue, inputMode, autoComplete, maxLength, min, max }: {
  label: string;
  name: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  type?: string;
  defaultValue?: string | number;
  inputMode?: "text" | "numeric" | "tel";
  autoComplete?: string;
  maxLength?: number;
  min?: number | string;
  max?: number | string;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        inputMode={inputMode}
        autoComplete={autoComplete}
        maxLength={maxLength}
        min={min}
        max={max}
        className="h-11 rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function TextAreaField({ label, name, required, placeholder, hint, rows = 3, defaultValue }: { label: string; name: string; required?: boolean; placeholder?: string; hint?: string; rows?: number; defaultValue?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <textarea
        name={name}
        required={required}
        rows={rows}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function SelectField({ label, name, options, defaultValue, required }: { label: string; name: string; options: { value: string; label: string }[]; defaultValue?: string; required?: boolean }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <select name={name} defaultValue={defaultValue} required={required} className="h-11 rounded-md border border-input bg-background px-3 text-base">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
