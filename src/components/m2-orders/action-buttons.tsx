"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmWithReasonDialog, type ReasonOption } from "@/components/shared/confirm-with-reason-dialog";
import { Button } from "@/components/ui/button";

import type { ActionState } from "./action-state";

type Variant = "default" | "outline" | "destructive" | "secondary" | "ghost";

function report(r: ActionState) {
  if (r.error) throw new Error(r.error);
  if (r.message) toast.success(r.message);
  for (const w of r.warnings ?? []) toast.warning(w);
}

/** Tombol aksi yang meminta alasan (batal, tarik rit, ubah status) — Server Action `(reason, code) => state`. */
export function ReasonActionButton({
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
  icon,
}: {
  label: string;
  title: string;
  description?: string;
  confirmLabel?: string;
  reasons?: readonly ReasonOption[];
  action: (reason: string, reasonCode: string | null, reasonText: string) => Promise<ActionState>;
  destructive?: boolean;
  variant?: Variant;
  size?: "sm" | "default" | "icon";
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <ConfirmWithReasonDialog
      title={title}
      description={description}
      confirmLabel={confirmLabel ?? label}
      destructive={destructive}
      reasons={reasons}
      trigger={
        <Button variant={variant} size={size} disabled={disabled} aria-label={size === "icon" ? label : undefined}>
          {icon}
          {size === "icon" ? null : label}
        </Button>
      }
      onConfirm={async ({ reason, reasonCode, reasonText }) => report(await action(reason, reasonCode, reasonText))}
    />
  );
}

/** Tombol aksi tanpa alasan. */
export function ActionButton({
  label,
  action,
  variant = "default",
  size = "sm",
  disabled,
  icon,
  onDone,
}: {
  label: string;
  action: () => Promise<ActionState>;
  variant?: Variant;
  size?: "sm" | "default" | "icon";
  disabled?: boolean;
  icon?: ReactNode;
  onDone?: (state: ActionState) => void;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant={variant}
      size={size}
      disabled={pending || disabled}
      aria-label={size === "icon" ? label : undefined}
      title={size === "icon" ? label : undefined}
      onClick={() =>
        start(async () => {
          const r = await action();
          if (r.error) toast.error(r.error);
          else {
            if (r.message) toast.success(r.message);
            for (const w of r.warnings ?? []) toast.warning(w);
          }
          onDone?.(r);
        })
      }
    >
      {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : icon}
      {size === "icon" ? null : label}
    </Button>
  );
}
