"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

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
  /** Varian tombol kirim. */
  variant?: "default" | "outline" | "destructive" | "secondary";
  /** Konten tambahan yang bergantung pada hasil (mis. kandidat duplikat). */
  renderState?: (state: ActionState) => ReactNode;
  "aria-label"?: string;
};

/**
 * Formulir Server Action sederhana (tanpa JS pun tetap berfungsi): menampilkan galat berbahasa Indonesia dari layanan,
 * toast saat berhasil, dan mengosongkan isian.
 */
export function ActionForm({ action, children, submitLabel = "Simpan", resetOnSuccess = true, className, variant = "default", renderState, ...rest }: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, EMPTY_ACTION_STATE);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
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
      {renderState ? renderState(state) : null}
      <div>
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
