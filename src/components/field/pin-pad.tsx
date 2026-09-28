"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { NumericKeypad } from "./numeric-keypad";

export type PinPadProps = {
  /** Panjang PIN. Bawaan 6 (US-M10-02 KP-3). */
  length?: number;
  /** Dipanggil saat digit ke-`length` diketuk. PIN lalu dikosongkan agar dapat diulang bila salah. */
  onComplete: (pin: string) => void | Promise<void>;
  /** Judul, mis. "Masukkan PIN Anda". */
  title?: ReactNode;
  /** Keterangan di bawah judul. */
  description?: ReactNode;
  /** Pesan kesalahan (mis. "PIN salah. Sisa 3 kali percobaan."). */
  error?: ReactNode;
  /** Nonaktif (mis. terkunci 15 menit / sedang memeriksa). */
  disabled?: boolean;
  /** Terima ketikan papan ketik fisik (bawaan `true`). */
  keyboard?: boolean;
  className?: string;
};

/**
 * Masukan PIN: 6 titik + papan angka besar. PIN tidak pernah ditampilkan. Setelah lengkap, `onComplete(pin)` dipanggil
 * dan titik dikosongkan. Verifikasi (termasuk offline via verifier PBKDF2) tanggung jawab pemanggil.
 */
export function PinPad({
  length = 6,
  onComplete,
  title = "Masukkan PIN",
  description,
  error,
  disabled,
  keyboard = true,
  className,
}: PinPadProps) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const pinRef = useRef("");
  const inactive = disabled || busy;

  function update(next: string) {
    pinRef.current = next;
    setPin(next);
  }

  async function addDigit(d: string) {
    if (inactive || !/^\d$/.test(d)) return;
    const current = pinRef.current;
    if (current.length >= length) return;
    const next = current + d;
    if (next.length < length) {
      update(next);
      return;
    }
    update(next);
    setBusy(true);
    try {
      await onComplete(next);
    } finally {
      update("");
      setBusy(false);
    }
  }

  function backspace() {
    if (inactive) return;
    update(pinRef.current.slice(0, -1));
  }

  const addDigitRef = useRef(addDigit);
  const backspaceRef = useRef(backspace);
  useEffect(() => {
    addDigitRef.current = addDigit;
    backspaceRef.current = backspace;
  });

  useEffect(() => {
    if (!keyboard) return;
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        void addDigitRef.current(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        backspaceRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard]);

  return (
    <div data-slot="pin-pad" className={cn("mx-auto flex w-full max-w-sm flex-col items-center gap-6", className)}>
      <div className="space-y-1 text-center">
        {title ? <p className="text-xl font-bold">{title}</p> : null}
        {description ? <p className="text-base text-muted-foreground">{description}</p> : null}
      </div>
      <div
        className="flex items-center justify-center gap-3"
        role="img"
        aria-label={`${pin.length} dari ${length} angka PIN terisi`}
        data-filled={pin.length}
      >
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            data-testid="pin-dot"
            data-filled={i < pin.length || undefined}
            className={cn(
              "size-5 rounded-full border-2 border-foreground transition-colors",
              i < pin.length ? "bg-foreground" : "bg-transparent",
              error && "border-destructive",
              error && i < pin.length && "bg-destructive",
            )}
          />
        ))}
      </div>
      <div className="min-h-7 text-center" aria-live="assertive">
        {error ? <p className="text-base font-semibold text-destructive">{error}</p> : null}
      </div>
      <NumericKeypad
        className="w-full"
        onDigit={(d) => void addDigit(d)}
        onBackspace={backspace}
        extraKey="clear"
        onClear={() => !inactive && update("")}
        disabled={inactive}
      />
    </div>
  );
}
