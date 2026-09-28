"use client";

import { Smartphone } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import { BigButton } from "@/components/field/big-button";

/** Panjang kode aktivasi perangkat (docs/ARCHITECTURE.md §6). */
export const ACTIVATION_CODE_LENGTH = 8;

/** Karakter kode aktivasi: huruf/angka tanpa yang mirip (0/O, 1/I/L) — disaring longgar, validasi di server. */
export function normalizeActivationCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ACTIVATION_CODE_LENGTH);
}

/** `ABCD1234` → `ABCD-1234`. */
export function formatActivationCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export type DeviceActivationFormProps = {
  /** Kirim kode aktivasi. Lempar `Error(pesan)` untuk menampilkan pesan (mis. "Kode kedaluwarsa. Minta kode baru."). */
  onSubmit: (code: string) => void | Promise<void>;
  error?: ReactNode;
};

/**
 * Aktivasi perangkat lapangan/POS: ketik kode 8 karakter dari admin sistem (berlaku 24 jam). Tampilan besar untuk
 * ponsel; dirender di dalam tema lapangan.
 */
export function DeviceActivationForm({ onSubmit, error }: DeviceActivationFormProps) {
  const id = useId();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const shownError = localError ?? error;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (code.length !== ACTIVATION_CODE_LENGTH) {
      setLocalError(`Kode aktivasi berisi ${ACTIVATION_CODE_LENGTH} huruf/angka. Periksa lagi kode dari admin sistem.`);
      return;
    }
    setPending(true);
    setLocalError(null);
    try {
      await onSubmit(code);
    } catch (err) {
      setLocalError(err instanceof Error && err.message ? err.message : "Aktivasi gagal. Periksa sinyal lalu coba lagi.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto flex w-full max-w-sm flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Smartphone className="size-8" aria-hidden />
        </span>
        <h1 className="text-2xl font-bold">Aktifkan perangkat</h1>
        <p className="text-base text-muted-foreground">Masukkan kode aktivasi dari admin sistem. Pastikan ponsel ada sinyal.</p>
      </div>
      <label htmlFor={`${id}-code`} className="text-lg font-semibold">
        Kode aktivasi
      </label>
      <input
        id={`${id}-code`}
        value={formatActivationCode(code)}
        onChange={(e) => {
          setCode(normalizeActivationCode(e.target.value));
          setLocalError(null);
        }}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder="ABCD-1234"
        disabled={pending}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={shownError ? `${id}-error` : undefined}
        className="tabular min-h-16 w-full rounded-xl border-2 border-input bg-background px-4 text-center font-mono text-3xl tracking-widest uppercase focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
      />
      {shownError ? (
        <p id={`${id}-error`} role="alert" className="text-base font-semibold text-destructive">
          {shownError}
        </p>
      ) : null}
      <BigButton type="submit" loading={pending}>
        Aktifkan
      </BigButton>
    </form>
  );
}
