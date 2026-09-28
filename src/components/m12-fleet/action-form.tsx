"use client";

/**
 * Formulir Server Action layar armada (tinjauan kejadian, GPS ponsel cadangan): galat layanan berbahasa Indonesia
 * tampil apa adanya, toast saat berhasil. Tetap berfungsi tanpa JavaScript (form action).
 */
import { LoaderCircle } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { M12ActionState } from "./action-state";

export function M12ActionForm({
  action,
  children,
  submitLabel = "Simpan",
  variant = "default",
  className,
  testId,
}: {
  action: (state: M12ActionState, formData: FormData) => Promise<M12ActionState>;
  children?: ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
  testId?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as M12ActionState);
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

export function NoteField({ label, name = "note", required, placeholder, hint }: { label: string; name?: string; required?: boolean; placeholder?: string; hint?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <textarea
        name={name}
        required={required}
        rows={2}
        placeholder={placeholder}
        className="rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
