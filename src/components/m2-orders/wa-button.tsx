"use client";

import { LoaderCircle, MessageCircle } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import type { ActionState } from "./action-state";

/**
 * "Kirim konfirmasi WA" (US-M2-07): server mencatat "konfirmasi dibuka" lalu tautan wa.me dibuka di tab baru (tanpa
 * klaim terkirim). Bila Business API aktif, pesan terkirim otomatis.
 */
export function WaConfirmButton({ action, size = "sm", variant = "outline" }: { action: () => Promise<ActionState>; size?: "sm" | "default"; variant?: "outline" | "default" }) {
  const [busy, start] = useTransition();
  return (
    <Button
      size={size}
      variant={variant}
      disabled={busy}
      onClick={() =>
        start(async () => {
          const r = await action();
          if (r.error) {
            toast.error(r.error);
            return;
          }
          if (r.link) window.open(r.link, "_blank", "noopener");
          if (r.message) toast.success(r.message);
          for (const w of r.warnings ?? []) toast.warning(w);
        })
      }
    >
      {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <MessageCircle aria-hidden />}
      Kirim konfirmasi WA
    </Button>
  );
}
