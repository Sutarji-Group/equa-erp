"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmWithReasonDialog } from "@/components/shared/confirm-with-reason-dialog";
import { Button } from "@/components/ui/button";

import type { M5ActionState } from "./action-state";

type Variant = "default" | "outline" | "destructive" | "secondary" | "ghost";

function afterAction(r: M5ActionState): void {
  if (r.error) {
    toast.error(r.error);
    return;
  }
  // Tautan WhatsApp/e-mail dibuka di tab baru; server sudah mencatat "dibuka"/"dikirim" (K21).
  if (r.link) window.open(r.link, "_blank", "noopener");
  if (r.message) toast.success(r.message);
}

/**
 * Tombol aksi tanpa isian (kirim WA, jalankan evaluasi, dsb.). `icon` berupa ELEMEN (mis. `<MessageCircle aria-hidden />`)
 * — komponen ikon (fungsi) tidak dapat dikirim dari Server Component ke Client Component.
 */
export function M5ActionButton({
  label,
  action,
  variant = "outline",
  size = "sm",
  icon,
  disabled,
  testId,
}: {
  label: string;
  action: () => Promise<M5ActionState>;
  variant?: Variant;
  size?: "sm" | "default";
  icon?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={pending || disabled}
      data-testid={testId}
      onClick={() => start(async () => afterAction(await action()))}
    >
      {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : (icon ?? null)}
      {label}
    </Button>
  );
}

/** Tombol aksi yang meminta alasan (pembalik, konversi, pembukaan Ditahan, pembatalan saldo awal) — BR-38. */
export function M5ReasonButton({
  label,
  title,
  description,
  confirmLabel,
  action,
  destructive,
  variant = "outline",
  size = "sm",
  disabled,
  testId,
}: {
  label: string;
  title: string;
  description?: string;
  confirmLabel?: string;
  action: (reason: string) => Promise<M5ActionState>;
  destructive?: boolean;
  variant?: Variant;
  size?: "sm" | "default";
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <ConfirmWithReasonDialog
      title={title}
      description={description}
      confirmLabel={confirmLabel ?? label}
      destructive={destructive}
      minLength={5}
      trigger={
        <Button type="button" variant={variant} size={size} disabled={disabled} data-testid={testId}>
          {label}
        </Button>
      }
      onConfirm={async ({ reason }) => {
        const r = await action(reason);
        if (r.error) throw new Error(r.error);
        if (r.link) window.open(r.link, "_blank", "noopener");
        if (r.message) toast.success(r.message);
      }}
    />
  );
}
