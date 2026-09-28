"use client";

import { KeyRound, LoaderCircle } from "lucide-react";
import { useActionState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ActionState, FormAction } from "./action-state";

export type ActionFormProps = {
  action: FormAction;
  submitLabel: string;
  children?: ReactNode;
  variant?: "default" | "destructive" | "outline" | "secondary";
  className?: string;
  /** Teks konfirmasi peramban sebelum mengirim (tindakan yang tidak dapat dibatalkan). */
  confirmText?: string;
  /** Tombol kirim memenuhi lebar (ponsel). */
  block?: boolean;
  testId?: string;
};

/**
 * Formulir Server Action dengan status pesan: galat (role=alert), berhasil (role=status), dan nilai rahasia SEKALI
 * TAMPIL (kode aktivasi / kata sandi sementara) yang tidak dapat dilihat lagi setelah halaman ditutup.
 */
export function ActionForm({ action, submitLabel, children, variant = "default", className, confirmText, block, testId }: ActionFormProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, undefined);
  return (
    <form
      action={formAction}
      data-testid={testId}
      className={cn("grid gap-3", className)}
      onSubmit={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
    >
      {children}
      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state?.message ? (
        <p role="status" className="text-sm text-success">
          {state.message}
        </p>
      ) : null}
      {state?.secret ? (
        <div role="status" className="rounded-md border border-warning bg-warning/10 p-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-4" aria-hidden />
            {state.secret.label}
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tracking-widest" data-testid="kode-sekali">
            {state.secret.value}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{state.secret.note ?? "Hanya ditampilkan sekali. Catat atau serahkan langsung sekarang."}</p>
        </div>
      ) : null}
      <div>
        <Button type="submit" variant={variant} disabled={pending} className={cn(block && "w-full sm:w-auto")}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {pending ? "Memproses…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
