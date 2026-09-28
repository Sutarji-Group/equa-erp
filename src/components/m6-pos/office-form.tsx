"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { OutletActionState } from "./office-action-state";

/**
 * Formulir Server Action layar kantor M6 (/outlet): galat layanan berbahasa Indonesia ditampilkan apa adanya, toast
 * saat berhasil. Tetap berfungsi tanpa JavaScript (form action).
 */
export function OutletActionForm({
  action,
  children,
  submitLabel = "Simpan",
  variant = "default",
  className,
  testId,
}: {
  action: (state: OutletActionState, formData: FormData) => Promise<OutletActionState>;
  children?: ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
  testId?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as OutletActionState);
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

/** Isian teks sederhana berlabel. */
export function Field({ label, name, type = "text", defaultValue, required, hint, inputMode, placeholder }: { label: string; name: string; type?: string; defaultValue?: string | number | null; required?: boolean; hint?: string; inputMode?: "numeric" | "text"; placeholder?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? ""}
        required={required}
        inputMode={inputMode}
        placeholder={placeholder}
        className="h-10 rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
