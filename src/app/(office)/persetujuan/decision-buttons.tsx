"use client";

import { Check, X } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { ConfirmWithReasonDialog } from "@/components/shared/confirm-with-reason-dialog";
import { Button } from "@/components/ui/button";

import { decideApprovalAction } from "./actions";

/** Tombol Setujui / Tolak (alasan wajib saat tolak). Tidak dirender untuk permintaan milik pengguna sendiri. */
export function DecisionButtons({ id, number }: { id: string; number: string }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await decideApprovalAction(id, "approve");
            if (r?.error) toast.error(r.error);
            else toast.success(`Permintaan ${number} disetujui.`);
          })
        }
      >
        <Check aria-hidden />
        Setujui
      </Button>
      <ConfirmWithReasonDialog
        title={`Tolak permintaan ${number}?`}
        description="Alasan penolakan wajib diisi dan dikirim ke pemohon."
        confirmLabel="Tolak"
        destructive
        trigger={
          <Button variant="outline" disabled={pending}>
            <X aria-hidden />
            Tolak
          </Button>
        }
        onConfirm={async ({ reason }) => {
          const r = await decideApprovalAction(id, "reject", reason);
          if (r?.error) throw new Error(r.error);
          toast.success(`Permintaan ${number} ditolak.`);
        }}
      />
    </div>
  );
}
