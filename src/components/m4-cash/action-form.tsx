"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useTransition } from "react";

import { useFlashActionState } from "@/components/shared/use-flash-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { CashActionState } from "./action-state";
import { prepareCashFormData } from "./prepare-form-data";

/**
 * Formulir Server Action layar kas (/kas/*): galat layanan berbahasa Indonesia tampil apa adanya; toast saat berhasil.
 * Foto dikompresi di perangkat sebelum dikirim (≤ 300 KB, PAR-38).
 */
export function CashActionForm({
  action,
  children,
  submitLabel = "Simpan",
  variant = "default",
  className,
  testId,
  inline = false,
  resetOnSuccess = true,
  disabled = false,
}: {
  action: (state: CashActionState, formData: FormData) => Promise<CashActionState>;
  children?: ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
  testId?: string;
  inline?: boolean;
  resetOnSuccess?: boolean;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useFlashActionState(action, {} as CashActionState);
  const [preparing, startPreparing] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      if (resetOnSuccess) ref.current?.reset();
    }
  }, [state, resetOnSuccess]);
  const busy = pending || preparing;
  const submit = (fd: FormData) => {
    startPreparing(async () => {
      const prepared = await prepareCashFormData(fd);
      startPreparing(() => formAction(prepared));
    });
  };
  return (
    <form ref={ref} action={submit} className={cn(inline ? "flex flex-wrap items-end gap-2" : "grid gap-3", className)} data-testid={testId}>
      {children}
      {state.error ? (
        <Alert variant="destructive" role="alert" className={inline ? "basis-full" : undefined}>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.ok && state.message ? (
        <p role="status" className={cn("text-sm text-success", inline && "basis-full")}>
          {state.message}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant={variant} disabled={busy || disabled} size={inline ? "sm" : "default"}>
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
