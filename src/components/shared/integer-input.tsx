"use client";

import { type ClipboardEvent, type ComponentProps, type ReactNode, useLayoutEffect, useRef } from "react";

import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { parseRupiah } from "@/lib/money";
import { cn } from "@/lib/utils";

/** `1250000` → `"1.250.000"`; `null` → `""`. */
export function formatIntegerDisplay(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return String(Math.trunc(Math.abs(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Ambil digit saja dari masukan mentah (`"Rp 1.250.000"` → `"1250000"`). */
export function digitsOnly(raw: string): string {
  return raw.replace(/\D+/g, "");
}

/**
 * Urai masukan ketikan menjadi bilangan bulat ≥ 0. `""` → `null`. Hasil di atas `max` → `undefined` (tolak ketikan).
 * Karakter bukan digit (titik, koma, huruf) diabaikan — tidak ada pecahan.
 */
export function parseIntegerInput(raw: string, max: number = Number.MAX_SAFE_INTEGER): number | null | undefined {
  const digits = digitsOnly(raw).replace(/^0+(?=\d)/, "");
  if (digits === "") return null;
  if (digits.length > 16) return undefined;
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value > max) return undefined;
  return value;
}

/** Posisi kursor setelah `digitCount` digit pertama pada teks berformat. */
function caretAfterDigits(display: string, digitCount: number): number {
  if (digitCount <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < display.length; i++) {
    if (/\d/.test(display[i]!)) {
      seen++;
      if (seen === digitCount) return i + 1;
    }
  }
  return display.length;
}

export type IntegerInputProps = Omit<
  ComponentProps<"input">,
  "value" | "defaultValue" | "onChange" | "type" | "prefix" | "max" | "min"
> & {
  /** Nilai bilangan bulat (rupiah/liter) atau `null` bila kosong. */
  value: number | null | undefined;
  /** Dipanggil dengan bilangan bulat baru atau `null` bila dikosongkan. */
  onValueChange: (value: number | null) => void;
  /** Awalan (mis. "Rp"). */
  prefix?: ReactNode;
  /** Akhiran (mis. "L"). */
  suffix?: ReactNode;
  /** Batas atas; ketikan yang melebihi diabaikan. */
  max?: number;
  /** Kelas pembungkus (InputGroup). */
  className?: string;
  /** Kelas elemen `<input>`. */
  inputClassName?: string;
};

/**
 * Input bilangan bulat berformat ribuan (`1.250.000`). Hanya digit yang diterima; titik/koma/huruf diabaikan.
 * Tempel (`paste`) teks rupiah seperti `"Rp 1.250.000"` diurai; teks berpecahan (`"1.000,50"`) ditolak.
 */
export function IntegerInput({
  value,
  onValueChange,
  prefix,
  suffix,
  max = Number.MAX_SAFE_INTEGER,
  className,
  inputClassName,
  onPaste,
  disabled,
  ref,
  ...rest
}: IntegerInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null) => {
    inputRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
  const pendingCaret = useRef<number | null>(null);
  const display = formatIntegerDisplay(value);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && pendingCaret.current !== null && document.activeElement === el) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    }
    pendingCaret.current = null;
  });

  function commit(raw: string, caret: number | null) {
    const parsed = parseIntegerInput(raw, max);
    if (parsed === undefined) {
      // Tolak ketikan (di atas batas): kembalikan tampilan lama.
      if (inputRef.current) inputRef.current.value = display;
      return;
    }
    const nextDisplay = formatIntegerDisplay(parsed);
    const digitsBefore = caret === null ? digitsOnly(raw).length : digitsOnly(raw.slice(0, caret)).replace(/^0+(?=\d)/, "").length;
    const caretPos = caretAfterDigits(nextDisplay, Math.min(digitsBefore, digitsOnly(nextDisplay).length));
    const el = inputRef.current;
    if (el) el.value = nextDisplay;
    if (parsed !== (value ?? null)) {
      pendingCaret.current = caretPos;
      onValueChange(parsed);
    } else if (el && document.activeElement === el) {
      // Nilai tidak berubah (mis. mengetik titik/koma): tidak ada render ulang, pasang kursor sekarang.
      el.setSelectionRange(caretPos, caretPos);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    onPaste?.(e);
    if (e.defaultPrevented) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    const parsed = parseRupiah(text);
    if (parsed === null || parsed < 0) return;
    const el = e.currentTarget;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const raw = el.value.slice(0, start) + String(parsed) + el.value.slice(end);
    commit(raw, start + String(parsed).length);
  }

  return (
    <InputGroup className={cn(className)} data-disabled={disabled ? true : undefined}>
      {prefix !== undefined ? (
        <InputGroupAddon>
          <InputGroupText>{prefix}</InputGroupText>
        </InputGroupAddon>
      ) : null}
      <InputGroupInput
        ref={setRefs}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        value={display}
        onChange={(e) => commit(e.target.value, e.target.selectionStart)}
        onPaste={handlePaste}
        className={cn("tabular text-right", inputClassName)}
        {...rest}
      />
      {suffix !== undefined ? (
        <InputGroupAddon align="inline-end">
          <InputGroupText>{suffix}</InputGroupText>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

export type MoneyInputProps = Omit<IntegerInputProps, "prefix" | "suffix">;

/** Input rupiah bulat: tampil `Rp 1.250.000`, nilai `1250000` (integer, tanpa desimal). */
export function MoneyInput(props: MoneyInputProps) {
  return <IntegerInput prefix="Rp" aria-roledescription="jumlah rupiah" {...props} />;
}

export type LiterInputProps = Omit<IntegerInputProps, "prefix" | "suffix">;

/** Input volume liter bulat: tampil `5.000 L`, nilai `5000`. */
export function LiterInput(props: LiterInputProps) {
  return <IntegerInput suffix="L" aria-roledescription="volume liter" {...props} />;
}
