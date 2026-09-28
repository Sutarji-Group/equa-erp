"use client";

import { Check, Copy, LoaderCircle } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

import { TotpCodeInput } from "./totp-form";

/** Rahasia base32 dikelompokkan per 4 karakter agar mudah diketik: `JBSW Y3DP EHPK 3PXP`. */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

export type TotpEnrollCardProps = {
  /** URI `otpauth://totp/...` dari server. */
  otpauthUrl: string;
  /** Rahasia base32 untuk entri manual. */
  secret: string;
  /** QR siap pakai (data URL) dari server; bila kosong dibuat di peramban dari `otpauthUrl`. */
  qrDataUrl?: string;
  /** Verifikasi kode pertama untuk menyelesaikan pendaftaran. Lempar `Error(pesan)` bila salah. */
  onVerify: (code: string) => void | Promise<void>;
  error?: ReactNode;
};

/** Pendaftaran 2FA TOTP: pindai QR di aplikasi autentikator, atau ketik rahasia, lalu verifikasi kode pertama. */
export function TotpEnrollCard({ otpauthUrl, secret, qrDataUrl, onVerify, error }: TotpEnrollCardProps) {
  const id = useId();
  const [generatedQr, setGeneratedQr] = useState<{ url: string; dataUrl: string } | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (qrDataUrl) return;
    let cancelled = false;
    import("qrcode")
      .then((QR) => QR.toDataURL(otpauthUrl, { margin: 1, width: 224, errorCorrectionLevel: "M" }))
      .then((dataUrl) => {
        if (!cancelled) setGeneratedQr({ url: otpauthUrl, dataUrl });
      })
      .catch(() => {
        if (!cancelled) setQrFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [otpauthUrl, qrDataUrl]);

  const qr = qrDataUrl ?? (generatedQr?.url === otpauthUrl ? generatedQr.dataUrl : null);
  const shownError = localError ?? error;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6) {
      setLocalError("Masukkan 6 angka yang tampil di aplikasi autentikator.");
      return;
    }
    setPending(true);
    setLocalError(null);
    try {
      await onVerify(code);
    } catch (err) {
      setLocalError(err instanceof Error && err.message ? err.message : "Kode tidak cocok. Periksa jam ponsel lalu coba lagi.");
      setCode("");
    } finally {
      setPending(false);
    }
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Salin tidak tersedia; pengguna dapat mengetik manual.
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-xl">Aktifkan verifikasi 2 langkah</CardTitle>
        <CardDescription>
          Wajib untuk Pemilik, Admin Keuangan, dan admin sistem. Pasang aplikasi autentikator (mis. Google Authenticator)
          di ponsel Anda.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <ol className="grid gap-4 text-sm">
          <li className="grid gap-3">
            <span>
              <strong>1.</strong> Pindai kode QR ini dengan aplikasi autentikator.
            </span>
            <div className="flex justify-center">
              {qr ? (
                // eslint-disable-next-line @next/next/no-img-element -- data URL QR buatan lokal
                <img src={qr} alt="Kode QR untuk aplikasi autentikator" width={224} height={224} className="rounded-lg border bg-white p-2" />
              ) : qrFailed ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-muted-foreground">
                  QR tidak dapat ditampilkan. Gunakan kode manual di bawah.
                </p>
              ) : (
                <Skeleton className="size-56 rounded-lg" aria-label="Menyiapkan kode QR" />
              )}
            </div>
          </li>
          <li className="grid gap-2">
            <span>
              <strong>2.</strong> Tidak bisa memindai? Ketik kode ini di aplikasi:
            </span>
            <div className="flex items-center gap-2">
              <code className="tabular flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">{groupSecret(secret)}</code>
              <Button type="button" variant="outline" size="icon" onClick={copySecret} aria-label="Salin kode manual">
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              </Button>
            </div>
          </li>
        </ol>
        <form onSubmit={submit} className="grid gap-3" noValidate>
          <Label htmlFor={`${id}-code`}>
            <strong>3.</strong>&nbsp;Masukkan kode 6 angka dari aplikasi
          </Label>
          <TotpCodeInput
            id={`${id}-code`}
            value={code}
            onValueChange={(v) => {
              setCode(v);
              setLocalError(null);
            }}
            disabled={pending}
            invalid={!!shownError}
            describedBy={shownError ? `${id}-error` : undefined}
          />
          {shownError ? (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
              {shownError}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            Aktifkan
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
