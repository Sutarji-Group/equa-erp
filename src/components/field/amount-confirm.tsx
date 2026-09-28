"use client";

import { Check, PencilLine } from "lucide-react";
import { type ReactNode, useState } from "react";

import { buildReasonResult, type ReasonOption, validateReason } from "@/components/shared/confirm-with-reason-dialog";
import { formatLiter } from "@/components/shared/money-text";
import { formatRupiah } from "@/lib/money";
import { cn } from "@/lib/utils";

import { BigButton } from "./big-button";
import { NumericKeypad } from "./numeric-keypad";

export type AmountConfirmResult = {
  amount: number;
  /** `true` bila berbeda dari angka seharusnya. */
  changed: boolean;
  reasonCode: string | null;
  reasonText: string;
  /** Alasan siap simpan ("" bila tidak berubah). */
  reason: string;
};

export type AmountConfirmProps = {
  /** Label, mis. "Uang tunai diterima" atau "Volume terkirim". */
  label: ReactNode;
  /** Angka seharusnya (harga pesanan / 5.000 L). */
  expected: number;
  unit?: "rupiah" | "liter";
  /** Batas atas (mis. = harga: "jumlah lebih besar tidak dapat dicatat", US-M3-04 KP-2). */
  max?: number;
  maxMessage?: string;
  /** Batas bawah. Bawaan 0. */
  min?: number;
  /** Daftar kode alasan wajib bila jumlah ≠ seharusnya. Kosong → tanpa alasan. */
  reasons?: readonly ReasonOption[];
  /** Kode "Lainnya" (wajib teks). Bawaan `"other"`. */
  otherCode?: string;
  confirmLabel?: string;
  onConfirm: (result: AmountConfirmResult) => void;
  disabled?: boolean;
  className?: string;
};

const MAX_DIGITS = 13;

/**
 * Konfirmasi angka lapangan: tampilkan angka seharusnya besar-besar; satu ketuk "Sesuai", atau "Ubah" dengan papan
 * angka + alasan wajib dari daftar bila berbeda (US-M3-03 KP-2, US-M3-04 KP-2). Aturan bisnis (mis. kurang bayar →
 * faktur) tetap di layanan server.
 */
export function AmountConfirm({
  label,
  expected,
  unit = "rupiah",
  max,
  maxMessage,
  min = 0,
  reasons,
  otherCode = "other",
  confirmLabel = "Simpan jumlah",
  onConfirm,
  disabled,
  className,
}: AmountConfirmProps) {
  const [editing, setEditing] = useState(false);
  const [digits, setDigits] = useState("");
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const format = (n: number) => (unit === "rupiah" ? formatRupiah(n) : formatLiter(n));
  const amount = digits === "" ? null : Number(digits);
  const differs = amount !== null && amount !== expected;
  const needReason = !!reasons && reasons.length > 0 && differs;
  const options = reasons && !reasons.some((r) => r.code === otherCode) ? [...reasons, { code: otherCode, label: "Lainnya" }] : reasons;

  function pushDigit(d: string) {
    setError(null);
    setDigits((prev) => {
      const next = (prev + d).replace(/^0+(?=\d)/, "");
      return next.length > MAX_DIGITS ? prev : next;
    });
  }

  function startEdit() {
    setEditing(true);
    setDigits(String(expected));
    setError(null);
  }

  function cancelEdit() {
    setEditing(false);
    setDigits("");
    setReasonCode(null);
    setReasonText("");
    setError(null);
  }

  function submitEdited() {
    if (amount === null) return setError("Masukkan jumlahnya dulu.");
    if (max !== undefined && amount > max) return setError(maxMessage ?? `Jumlah tidak boleh lebih dari ${format(max)}.`);
    if (amount < min) return setError(`Jumlah tidak boleh kurang dari ${format(min)}.`);
    if (needReason) {
      const message = validateReason({ reasons: options, otherCode, reasonCode, reasonText });
      if (message) return setError(message);
      const r = buildReasonResult(options, otherCode, reasonCode, reasonText);
      return onConfirm({ amount, changed: true, ...r });
    }
    onConfirm({ amount, changed: differs, reasonCode: null, reasonText: "", reason: "" });
  }

  if (!editing) {
    return (
      <div data-slot="amount-confirm" className={cn("flex flex-col gap-4", className)}>
        <div className="rounded-xl border-2 bg-card p-4 text-center">
          <p className="text-base text-muted-foreground">{label}</p>
          <p className="tabular text-4xl font-bold tracking-tight">{format(expected)}</p>
        </div>
        <BigButton
          variant="success"
          size="xl"
          disabled={disabled}
          icon={<Check aria-hidden />}
          onClick={() => onConfirm({ amount: expected, changed: false, reasonCode: null, reasonText: "", reason: "" })}
        >
          Sesuai {format(expected)}
        </BigButton>
        <BigButton variant="secondary" disabled={disabled} icon={<PencilLine aria-hidden />} onClick={startEdit}>
          Ubah jumlah
        </BigButton>
      </div>
    );
  }

  return (
    <div data-slot="amount-confirm" className={cn("flex flex-col gap-4", className)}>
      <div className="rounded-xl border-2 border-primary bg-card p-4 text-center">
        <p className="text-base text-muted-foreground">{label}</p>
        <p className="tabular text-4xl font-bold tracking-tight" aria-live="polite">
          {amount === null ? <span className="text-muted-foreground">{format(0)}</span> : format(amount)}
        </p>
        <p className="text-sm text-muted-foreground">Seharusnya {format(expected)}</p>
      </div>
      <NumericKeypad
        onDigit={pushDigit}
        onBackspace={() => {
          setError(null);
          setDigits((p) => p.slice(0, -1));
        }}
        extraKey={unit === "rupiah" ? "000" : "clear"}
        onTripleZero={() => pushDigit("000")}
        onClear={() => setDigits("")}
        disabled={disabled}
      />
      {needReason && options ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-lg font-semibold">Alasan jumlah berbeda</legend>
          {options.map((o) => (
            <BigButton
              key={o.code}
              variant={reasonCode === o.code ? "primary" : "outline"}
              aria-pressed={reasonCode === o.code}
              onClick={() => {
                setReasonCode(o.code);
                setError(null);
              }}
            >
              {o.label}
            </BigButton>
          ))}
          {reasonCode === otherCode ? (
            <textarea
              value={reasonText}
              onChange={(e) => {
                setReasonText(e.target.value);
                setError(null);
              }}
              rows={2}
              placeholder="Tulis alasannya"
              aria-label="Alasan lainnya"
              className="min-h-16 w-full rounded-xl border-2 border-input bg-background px-4 py-3 text-lg focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
            />
          ) : null}
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-base font-semibold text-destructive">
          {error}
        </p>
      ) : null}
      <BigButton onClick={submitEdited} disabled={disabled}>
        {confirmLabel}
      </BigButton>
      <BigButton variant="secondary" onClick={cancelEdit} disabled={disabled}>
        Batal
      </BigButton>
    </div>
  );
}
