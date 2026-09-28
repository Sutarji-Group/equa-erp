"use client";

import { LoaderCircle } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { ConfirmWithReasonDialog } from "@/components/shared/confirm-with-reason-dialog";
import { Button } from "@/components/ui/button";

import type { ActionState } from "./action-state";

/** Tombol aksi yang meminta alasan (nonaktifkan, tolak usulan, ubah status) — Server Action `(reason) => state`. */
export function ReasonActionButton({
  label,
  title,
  description,
  confirmLabel,
  action,
  destructive,
  variant = "outline",
  size = "sm",
  disabled,
}: {
  label: string;
  title: string;
  description?: string;
  confirmLabel?: string;
  action: (reason: string) => Promise<ActionState>;
  destructive?: boolean;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  size?: "sm" | "default";
  disabled?: boolean;
}) {
  return (
    <ConfirmWithReasonDialog
      title={title}
      description={description}
      confirmLabel={confirmLabel ?? label}
      destructive={destructive}
      trigger={
        <Button variant={variant} size={size} disabled={disabled}>
          {label}
        </Button>
      }
      onConfirm={async ({ reason }) => {
        const r = await action(reason);
        if (r.error) throw new Error(r.error);
        if (r.message) toast.success(r.message);
      }}
    />
  );
}

/** Tombol aksi tanpa alasan (konfirmasi usulan koordinat, jalankan simulasi, dsb.). */
export function ActionButton({
  label,
  action,
  variant = "default",
  size = "sm",
  disabled,
}: {
  label: string;
  action: () => Promise<ActionState>;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  size?: "sm" | "default";
  disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant={variant}
      size={size}
      disabled={pending || disabled}
      onClick={() =>
        start(async () => {
          const r = await action();
          if (r.error) toast.error(r.error);
          else if (r.message) toast.success(r.message);
        })
      }
    >
      {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
      {label}
    </Button>
  );
}
