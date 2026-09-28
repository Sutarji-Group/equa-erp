"use client";

import { Check, CheckCheck } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { advanceNotificationAction, markAllReadAction } from "./actions";

export function NotificationRowActions({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  const run = (to: "read" | "actioned") =>
    start(async () => {
      const r = await advanceNotificationAction(id, to);
      if (r?.error) toast.error(r.error);
    });
  return (
    <div className="flex flex-wrap gap-2">
      {status === "new" ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run("read")}>
          <Check aria-hidden />
          Tandai dibaca
        </Button>
      ) : null}
      {status === "new" || status === "read" ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run("actioned")}>
          <CheckCheck aria-hidden />
          Tandai ditindaklanjuti
        </Button>
      ) : null}
    </div>
  );
}

export function MarkAllReadButton({ disabled }: { disabled?: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={disabled || pending}
      onClick={() =>
        start(async () => {
          const r = await markAllReadAction();
          if (r?.error) toast.error(r.error);
          else toast.success("Semua notifikasi ditandai dibaca.");
        })
      }
    >
      <CheckCheck aria-hidden />
      Tandai semua dibaca
    </Button>
  );
}
