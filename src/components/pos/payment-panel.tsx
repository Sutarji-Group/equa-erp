"use client";

import { Banknote, QrCode } from "lucide-react";
import { useState } from "react";

import { BigButton } from "@/components/field/big-button";
import { NumericKeypad } from "@/components/field/numeric-keypad";
import { formatRupiah } from "@/lib/money";
import { cn } from "@/lib/utils";

import { cashSuggestions, computeChange } from "./cart";

export type PosPaymentMethod = "cash" | "qris";

export type PosPayment =
  | { method: "cash"; received: number; change: number }
  | { method: "qris"; reference: string | null };

export type PaymentPanelProps = {
  /** Total yang harus dibayar (integer rupiah). */
  total: number;
  /** Simpan transaksi. Boleh async (tombol berputar sampai selesai). */
  onPay: (payment: PosPayment) => void | Promise<void>;
  /** Cara bayar tersedia (Tahap 1: tunai & QRIS statis, US-M6-01 KP-2). */
  methods?: readonly PosPaymentMethod[];
  /** Gambar QRIS statis outlet untuk ditunjukkan ke pelanggan. */
  qrisImageUrl?: string;
  disabled?: boolean;
  className?: string;
};

const METHOD_LABEL: Record<PosPaymentMethod, string> = { cash: "Tunai", qris: "QRIS" };
const MAX_DIGITS = 12;

/**
 * Panel pembayaran POS. Tunai: uang diterima (bawaan = pas) → kembalian dihitung; tombol "Uang pas" & usulan nominal.
 * QRIS: operator menandai QRIS diterima + referensi opsional (tidak menambah kas fisik).
 */
export function PaymentPanel({ total, onPay, methods = ["cash", "qris"], qrisImageUrl, disabled, className }: PaymentPanelProps) {
  const [method, setMethod] = useState<PosPaymentMethod>(methods[0] ?? "cash");
  // `null` = mengikuti total (uang pas) sampai operator mengetik.
  const [receivedDigits, setReceivedDigits] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  const received = receivedDigits === null ? total : receivedDigits === "" ? 0 : Number(receivedDigits);
  const change = computeChange(total, received);
  const inactive = disabled || saving || total <= 0;

  function push(d: string) {
    setReceivedDigits((prev) => {
      const base = prev ?? "";
      const next = (base + d).replace(/^0+(?=\d)/, "");
      return next.length > MAX_DIGITS ? base : next;
    });
  }

  async function pay(payment: PosPayment) {
    setSaving(true);
    try {
      await onPay(payment);
      setReceivedDigits(null);
      setReference("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-slot="payment-panel" aria-label="Pembayaran" className={cn("flex flex-col gap-4 rounded-2xl border-2 bg-card p-4", className)}>
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-semibold">Total bayar</span>
        <span className="tabular text-3xl font-bold">{formatRupiah(total)}</span>
      </div>

      {methods.length > 1 ? (
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Cara bayar">
          {methods.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              disabled={saving}
              className={cn(
                "flex min-h-14 items-center justify-center gap-2 rounded-xl border-2 text-lg font-bold focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none",
                method === m ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
              )}
            >
              {m === "cash" ? <Banknote className="size-6" aria-hidden /> : <QrCode className="size-6" aria-hidden />}
              {METHOD_LABEL[m]}
            </button>
          ))}
        </div>
      ) : null}

      {method === "cash" ? (
        <>
          <div className="rounded-xl border-2 p-3">
            <p className="text-base text-muted-foreground">Uang diterima</p>
            <p className="tabular text-3xl font-bold" aria-live="polite">
              {formatRupiah(received)}
            </p>
            <p
              className={cn("tabular text-xl font-bold", change < 0 ? "text-destructive" : "text-success")}
              aria-live="polite"
              data-testid="pos-change"
            >
              {change < 0 ? `Kurang ${formatRupiah(-change)}` : `Kembalian ${formatRupiah(change)}`}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button
              type="button"
              onClick={() => setReceivedDigits(null)}
              disabled={inactive}
              className="min-h-12 rounded-xl border-2 bg-secondary px-2 text-base font-bold hover:bg-secondary/80 disabled:opacity-40"
            >
              Uang pas
            </button>
            {cashSuggestions(total).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setReceivedDigits(String(v))}
                disabled={inactive}
                className="tabular min-h-12 rounded-xl border-2 bg-background px-2 text-base font-semibold hover:bg-accent disabled:opacity-40"
              >
                {formatRupiah(v)}
              </button>
            ))}
          </div>
          <NumericKeypad
            onDigit={push}
            onBackspace={() => setReceivedDigits((p) => (p ?? String(total)).slice(0, -1))}
            extraKey="000"
            onTripleZero={() => push("000")}
            disabled={inactive}
          />
          <BigButton
            variant="success"
            size="xl"
            loading={saving}
            disabled={inactive || change < 0}
            onClick={() => void pay({ method: "cash", received, change })}
          >
            Simpan · Tunai
          </BigButton>
        </>
      ) : (
        <>
          {qrisImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- QRIS statis outlet, dapat berupa URL lokal/offline
            <img src={qrisImageUrl} alt="QRIS outlet" className="mx-auto aspect-square w-full max-w-64 rounded-xl border-2 bg-white object-contain p-2" />
          ) : (
            <p className="rounded-xl border-2 border-dashed p-4 text-center text-base text-muted-foreground">
              Tunjukkan QRIS outlet ke pelanggan, lalu periksa notifikasi dana masuk.
            </p>
          )}
          <label className="flex flex-col gap-1.5 text-base font-medium">
            Referensi QRIS (opsional)
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={64}
              placeholder="mis. 4 digit terakhir"
              className="min-h-14 rounded-xl border-2 border-input bg-background px-4 text-lg focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
            />
          </label>
          <BigButton
            variant="success"
            size="xl"
            loading={saving}
            disabled={inactive}
            onClick={() => void pay({ method: "qris", reference: reference.trim() || null })}
          >
            QRIS diterima · Simpan
          </BigButton>
        </>
      )}
    </section>
  );
}
