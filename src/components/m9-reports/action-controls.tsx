"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmWithReasonDialog, type ReasonOption } from "@/components/shared/confirm-with-reason-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ReportActionState } from "./action-state";

type Variant = "default" | "outline" | "destructive" | "secondary" | "ghost";

function report(r: ReportActionState): void {
  if (r.error) throw new Error(r.error);
  if (r.message) toast.success(r.message);
}

/**
 * Tombol aksi satu ketuk (setujui selisih dari H+0 — US-M9-01 KP-4, "Tandai ditinjau", setujui dari kotak masuk).
 * Galat layanan tampil sebagai toast berbahasa Indonesia.
 */
export function ReportActionButton({
  label,
  action,
  variant = "default",
  size = "sm",
  disabled,
  icon,
  testId,
}: {
  label: string;
  action: () => Promise<ReportActionState>;
  variant?: Variant;
  size?: "sm" | "default";
  disabled?: boolean;
  icon?: ReactNode;
  testId?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled || pending}
      data-testid={testId}
      onClick={() =>
        start(async () => {
          try {
            report(await action());
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Tindakan gagal. Coba lagi.");
          }
        })
      }
    >
      {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : icon}
      {label}
    </Button>
  );
}

/** Tombol aksi yang meminta alasan/catatan (tolak — alasan wajib; minta keterangan). */
export function ReportReasonButton({
  label,
  title,
  description,
  confirmLabel,
  reasons,
  action,
  destructive,
  variant = "outline",
  size = "sm",
  disabled,
  minLength = 3,
  textLabel,
  testId,
}: {
  label: string;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  reasons?: readonly ReasonOption[];
  action: (reason: string) => Promise<ReportActionState>;
  destructive?: boolean;
  variant?: Variant;
  size?: "sm" | "default";
  disabled?: boolean;
  minLength?: number;
  textLabel?: string;
  testId?: string;
}) {
  return (
    <ConfirmWithReasonDialog
      title={title}
      description={description}
      confirmLabel={confirmLabel ?? label}
      destructive={destructive}
      reasons={reasons}
      minLength={minLength}
      textLabel={textLabel}
      trigger={
        <Button type="button" variant={variant} size={size} disabled={disabled} data-testid={testId}>
          {label}
        </Button>
      }
      onConfirm={async ({ reason }) => report(await action(reason))}
    />
  );
}

/** Formulir Server Action (KPI-10, lembar pencocokan, periode paralel): galat tampil apa adanya; toast saat berhasil. */
export function ReportActionForm({
  action,
  children,
  submitLabel = "Simpan",
  variant = "default",
  className,
  testId,
  inline = false,
  resetOnSuccess = true,
}: {
  action: (state: ReportActionState, formData: FormData) => Promise<ReportActionState>;
  children?: ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
  testId?: string;
  inline?: boolean;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {} as ReportActionState);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
      if (resetOnSuccess) ref.current?.reset();
    }
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={cn(inline ? "flex flex-wrap items-end gap-2" : "grid gap-3", className)} data-testid={testId}>
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
        <Button type="submit" variant={variant} disabled={pending} size={inline ? "sm" : "default"}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
