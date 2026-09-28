"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useTransition } from "react";
import { toast } from "sonner";

import { ConfirmWithReasonDialog } from "@/components/shared/confirm-with-reason-dialog";
import { Button } from "@/components/ui/button";

import type { M11ActionState } from "./action-state";

type Variant = "default" | "outline" | "destructive" | "secondary" | "ghost";

/**
 * Tombol aksi tanpa isian (posting, ajukan, jalankan penyusutan, dsb.). `icon` berupa ELEMEN — komponen ikon (fungsi)
 * tidak dapat dikirim dari Server Component ke Client Component.
 */
export function M11ActionButton({
  label,
  action,
  variant = "outline",
  size = "sm",
  icon,
  disabled,
  testId,
}: {
  label: string;
  action: () => Promise<M11ActionState>;
  variant?: Variant;
  size?: "sm" | "default";
  icon?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={pending || disabled}
      data-testid={testId}
      onClick={() =>
        start(async () => {
          const r = await action();
          if (r.error) {
            toast.error(r.error);
            return;
          }
          if (r.message) toast.success(r.message);
          if (r.redirectTo) router.push(r.redirectTo);
        })
      }
    >
      {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : (icon ?? null)}
      {label}
    </Button>
  );
}

/** Tombol aksi yang meminta alasan (pembalik, pembatalan, nonaktifkan akun, buka periode) — BR-38, BR-32. */
export function M11ReasonButton({
  label,
  title,
  description,
  confirmLabel,
  action,
  destructive,
  variant = "outline",
  size = "sm",
  disabled,
  minLength = 5,
  testId,
}: {
  label: string;
  title: string;
  description?: string;
  confirmLabel?: string;
  action: (reason: string) => Promise<M11ActionState>;
  destructive?: boolean;
  variant?: Variant;
  size?: "sm" | "default";
  disabled?: boolean;
  minLength?: number;
  testId?: string;
}) {
  const router = useRouter();
  return (
    <ConfirmWithReasonDialog
      title={title}
      description={description}
      confirmLabel={confirmLabel ?? label}
      destructive={destructive}
      minLength={minLength}
      trigger={
        <Button type="button" variant={variant} size={size} disabled={disabled} data-testid={testId}>
          {label}
        </Button>
      }
      onConfirm={async ({ reason }) => {
        const r = await action(reason);
        if (r.error) throw new Error(r.error);
        if (r.message) toast.success(r.message);
        if (r.redirectTo) router.push(r.redirectTo);
      }}
    />
  );
}
