"use client";

import { ArrowLeft, KeyRound } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { BigButton } from "@/components/field/big-button";
import { PinPad } from "@/components/field/pin-pad";

import { formatActivationCode, normalizeActivationCode } from "./device-activation-form";

export type PinEnrollFormProps = {
  /** Kirim kode aktivasi akun + PIN baru. Lempar `Error(pesan)` untuk menampilkan pesan. */
  onSubmit: (code: string, pin: string) => void | Promise<void>;
  onCancel?: () => void;
};

/** PIN lemah (sama semua / berurutan) — dicek juga di server. */
export function isWeakPinClient(pin: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const d = pin.split("").map(Number);
  const asc = d.every((v, i) => i === 0 || v === (d[i - 1]! + 1) % 10);
  const desc = d.every((v, i) => i === 0 || v === (d[i - 1]! + 9) % 10);
  return asc || desc;
}

/**
 * Aktivasi akun lapangan di perangkat (US-M10-02 KP-3): (1) kode 8 karakter dari admin sistem — dilakukan di hadapan
 * admin sistem, (2) PIN 6 angka pilihan sendiri, (3) ulangi PIN. Wajib ada sinyal.
 */
export function PinEnrollForm({ onSubmit, onCancel }: PinEnrollFormProps) {
  const id = useId();
  const [step, setStep] = useState<"code" | "pin" | "confirm">("code");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function submitCode(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 8) {
      setError("Kode aktivasi akun berisi 8 huruf/angka. Periksa lagi kode dari admin sistem.");
      return;
    }
    setError(null);
    setStep("pin");
  }

  if (step === "code") {
    return (
      <form onSubmit={submitCode} noValidate className="mx-auto flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRound className="size-8" aria-hidden />
          </span>
          <h1 className="text-2xl font-bold">Aktifkan akun Anda</h1>
          <p className="text-base text-muted-foreground">Masukkan kode dari admin sistem, lalu buat PIN 6 angka Anda sendiri.</p>
        </div>
        <label htmlFor={`${id}-code`} className="text-lg font-semibold">
          Kode aktivasi akun
        </label>
        <input
          id={`${id}-code`}
          value={formatActivationCode(code)}
          onChange={(e) => {
            setCode(normalizeActivationCode(e.target.value));
            setError(null);
          }}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ABCD-1234"
          aria-invalid={error ? true : undefined}
          className="tabular min-h-16 w-full rounded-xl border-2 border-input bg-background px-4 text-center font-mono text-3xl tracking-widest uppercase focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
        />
        {error ? (
          <p role="alert" className="text-base font-semibold text-destructive">
            {error}
          </p>
        ) : null}
        <BigButton type="submit">Lanjut</BigButton>
        {onCancel ? (
          <BigButton type="button" variant="outline" onClick={onCancel}>
            Kembali
          </BigButton>
        ) : null}
      </form>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      <button
        type="button"
        onClick={() => {
          setStep(step === "confirm" ? "pin" : "code");
          setError(null);
        }}
        className="inline-flex min-h-12 items-center gap-2 self-start rounded-xl px-2 text-base font-semibold hover:bg-accent"
      >
        <ArrowLeft className="size-5" aria-hidden />
        Kembali
      </button>
      <PinPad
        key={step}
        title={step === "pin" ? "Buat PIN 6 angka" : "Ulangi PIN"}
        description={step === "pin" ? "Jangan pakai angka sama atau berurutan. PIN tidak boleh dibagi." : "Masukkan PIN yang sama sekali lagi."}
        error={error}
        disabled={pending}
        onComplete={async (value) => {
          if (step === "pin") {
            if (isWeakPinClient(value)) {
              setError("PIN terlalu mudah ditebak. Pilih 6 angka lain.");
              return;
            }
            setPin(value);
            setError(null);
            setStep("confirm");
            return;
          }
          if (value !== pin) {
            setError("PIN tidak sama. Buat ulang PIN Anda.");
            setStep("pin");
            return;
          }
          setPending(true);
          try {
            await onSubmit(code, value);
          } catch (err) {
            setError(err instanceof Error && err.message ? err.message : "Aktivasi akun gagal. Coba lagi.");
            setStep("code");
          } finally {
            setPending(false);
          }
        }}
      />
    </div>
  );
}
