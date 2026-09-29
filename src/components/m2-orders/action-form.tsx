"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { toast } from "sonner";

import { useFlashActionState } from "@/components/shared/use-flash-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { EMPTY_ACTION_STATE, type ActionState } from "./action-state";

export type ActionFormProps = {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel?: string;
  /** Kosongkan formulir setelah berhasil. Bawaan true. */
  resetOnSuccess?: boolean;
  className?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  size?: "sm" | "default";
  "aria-label"?: string;
};

/**
 * Formulir Server Action (tetap berfungsi tanpa JS): galat berbahasa Indonesia dari layanan, peringatan (tidak
 * memblokir), toast saat berhasil, dan pengosongan isian.
 */
export function ActionForm({ action, children, submitLabel = "Simpan", resetOnSuccess = true, className, variant = "default", size = "default", ...rest }: ActionFormProps) {
  const [state, formAction, pending] = useFlashActionState(action, EMPTY_ACTION_STATE);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      for (const w of state.warnings ?? []) toast.warning(w);
      if (resetOnSuccess) ref.current?.reset();
    }
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={cn("grid gap-3", className)} aria-label={rest["aria-label"]}>
      {children}
      {state.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="submit" variant={variant} size={size} disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
