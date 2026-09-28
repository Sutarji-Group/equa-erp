"use client";

import { LoaderCircle, ShieldCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Normalisasi kode TOTP: ambil 6 digit. */
export function normalizeTotpCode(raw: string): string {
  return raw.replace(/\D+/g, "").slice(0, 6);
}

export type TotpCodeInputProps = {
  value: string;
  onValueChange: (code: string) => void;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  describedBy?: string;
};

/** Kolom kode 6 digit dari aplikasi autentikator. */
export function TotpCodeInput({ value, onValueChange, id, disabled, invalid, autoFocus, describedBy }: TotpCodeInputProps) {
  return (
    <Input
      id={id}
      value={value}
      onChange={(e) => onValueChange(normalizeTotpCode(e.target.value))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="\d{6}"
      maxLength={6}
      placeholder="123456"
      disabled={disabled}
      autoFocus={autoFocus}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className="tabular h-12 text-center text-2xl tracking-[0.5em]"
    />
  );
}

export type TotpFormProps = {
  /** Verifikasi kode. Lempar `Error(pesan)` untuk menampilkan pesan. */
  onSubmit: (code: string) => void | Promise<void>;
  onCancel?: () => void;
  error?: ReactNode;
  /** Nama pengguna yang sedang masuk. */
  userName?: string;
};

/** Langkah kedua masuk (2FA TOTP) untuk pemilik, Admin Keuangan, admin sistem (US-M10-02 KP-4). */
export function TotpForm({ onSubmit, onCancel, error, userName }: TotpFormProps) {
  const id = useId();
  const [code, setCode] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const shownError = localError ?? error;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6) {
      setLocalError("Masukkan 6 angka dari aplikasi autentikator.");
      return;
    }
    setPending(true);
    setLocalError(null);
    try {
      await onSubmit(code);
    } catch (err) {
      setLocalError(err instanceof Error && err.message ? err.message : "Kode tidak cocok. Periksa jam ponsel lalu coba lagi.");
      setCode("");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-2xl">
          <ShieldCheck className="size-6 text-primary" aria-hidden />
          Verifikasi 2 langkah
        </CardTitle>
        <CardDescription>
          {userName
            ? `${userName}, buka aplikasi autentikator di ponsel Anda lalu masukkan kode 6 angka.`
            : "Buka aplikasi autentikator di ponsel Anda lalu masukkan kode 6 angka."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-code`}>Kode verifikasi</Label>
            <TotpCodeInput
              id={`${id}-code`}
              value={code}
              onValueChange={(v) => {
                setCode(v);
                setLocalError(null);
              }}
              disabled={pending}
              invalid={!!shownError}
              autoFocus
              describedBy={shownError ? `${id}-error` : undefined}
            />
            {shownError ? (
              <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
                {shownError}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            Verifikasi
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Batal & kembali
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
