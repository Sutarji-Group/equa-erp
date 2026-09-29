"use client";

/**
 * Status pembayaran digital (US-P2-04 KP-3): disegarkan tiap 5 detik dari `/api/customer/pembayaran/<id>` sampai
 * Berhasil/Gagal/Kedaluwarsa (status diterima otomatis dari gerbang lewat webhook).
 */
import { CircleCheckBig, Clock, CircleX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Status = { status: string; statusLabel: string };

export function PaymentStatus({ intentId, initial }: { intentId: string; initial: Status }) {
  const [s, setS] = useState<Status>(initial);
  const router = useRouter();
  useEffect(() => {
    if (s.status !== "pending") return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/customer/pembayaran/${intentId}`, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as Status;
        setS(next);
        if (next.status !== "pending") router.refresh();
      } catch {
        // abaikan; coba lagi pada interval berikutnya
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [intentId, s.status, router]);
  const paid = s.status === "succeeded" || s.status === "matched";
  const Icon = paid ? CircleCheckBig : s.status === "pending" ? Clock : CircleX;
  return (
    <p role="status" data-testid="payment-status" className={paid ? "flex items-center gap-2 font-semibold text-success" : s.status === "pending" ? "flex items-center gap-2 text-muted-foreground" : "flex items-center gap-2 text-destructive"}>
      <Icon className="size-5" aria-hidden /> {paid ? "Pembayaran berhasil" : s.statusLabel}
    </p>
  );
}
