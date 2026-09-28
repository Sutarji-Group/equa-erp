"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmWithReasonDialog, type ReasonOption } from "@/components/shared/confirm-with-reason-dialog";
import { Button } from "@/components/ui/button";

import type { CashActionState } from "./action-state";

type Variant = "default" | "outline" | "destructive" | "secondary" | "ghost";

function report(r: CashActionState): void {
  if (r.error) throw new Error(r.error);
  if (r.message) toast.success(r.message);
}

/**
 * Tombol aksi satu ketuk (mis. "Setujui" selisih dari ringkasan — US-M4-06 KP-6, "Tutup setoran", "Mulai tutup kas").
 * Galat layanan tampil sebagai toast berbahasa Indonesia.
 */
export function CashActionButton({
  label,
  action,
  variant = "default",
  size = "sm",
  disabled,
  icon,
  testId,
}: {
  label: string;
  action: () => Promise<CashActionState>;
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

/** Tombol aksi yang meminta alasan (tolak selisih, buka kembali, pengecualian tutup kas, pembalik). */
export function CashReasonButton({
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
  minLength,
  textLabel,
  testId,
  children,
}: {
  label: string;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  reasons?: readonly ReasonOption[];
  action: (reason: string, reasonCode: string | null) => Promise<CashActionState>;
  destructive?: boolean;
  variant?: Variant;
  size?: "sm" | "default";
  disabled?: boolean;
  minLength?: number;
  textLabel?: string;
  testId?: string;
  children?: ReactNode;
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
      onConfirm={async ({ reason, reasonCode }) => report(await action(reason, reasonCode))}
    >
      {children}
    </ConfirmWithReasonDialog>
  );
}
