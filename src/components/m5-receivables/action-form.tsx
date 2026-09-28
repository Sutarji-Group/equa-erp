"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { M5ActionState } from "./action-state";

/**
 * Formulir Server Action layar Piutang: galat layanan berbahasa Indonesia tampil apa adanya, toast saat berhasil, dan
 * tautan hasil (WhatsApp/e-mail) dibuka di tab baru. Tetap berfungsi tanpa JavaScript (form action).
 */
export function M5ActionForm({
  action,
  children,
  submitLabel = "Simpan",
  variant = "default",
  className,
  testId,
  resetOnSuccess = true,
}: {
  action: (state: M5ActionState, formData: FormData) => Promise<M5ActionState>;
  children?: ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
  testId?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {} as M5ActionState);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.ok) return;
    if (state.message) toast.success(state.message);
    if (state.link) window.open(state.link, "_blank", "noopener");
    if (resetOnSuccess) ref.current?.reset();
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
