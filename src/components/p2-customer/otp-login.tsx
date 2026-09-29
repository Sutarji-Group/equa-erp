"use client";

/**
 * Masuk/daftar pelanggan dengan nomor WhatsApp + kode OTP 6 digit (US-P2-01 KP-1), tanpa kata sandi. Langkah 1 kirim
 * kode; langkah 2 masukkan kode (pengalihan oleh Server Action). Mode uji (dev/E2E tanpa WhatsApp Business API)
 * menampilkan kode di layar.
 */
import { LoaderCircle, MessageCircle } from "lucide-react";
import { useActionState, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import type { P2ActionState } from "./action-state";

export function OtpLogin({
  requestAction,
  verifyAction,
  next,
}: {
  requestAction: (s: P2ActionState, fd: FormData) => Promise<P2ActionState>;
  verifyAction: (s: P2ActionState, fd: FormData) => Promise<P2ActionState>;
  next?: string;
}) {
  const [sent, requestFormAction, requesting] = useActionState(requestAction, {} as P2ActionState);
  const [verified, verifyFormAction, verifying] = useActionState(verifyAction, {} as P2ActionState);
  const [phoneInput, setPhoneInput] = useState("");
  const phone = typeof sent.data?.phone === "string" ? sent.data.phone : null;
  const devCode = typeof sent.data?.devCode === "string" ? sent.data.devCode : null;

  return (
    <div className="grid gap-5">
      <form action={requestFormAction} className="grid gap-3" data-testid="otp-request">
        <label className="grid gap-1 text-sm font-medium">
          Nomor WhatsApp
          <input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            placeholder="0812-3456-7890"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            className="h-12 rounded-md border border-input bg-background px-3 text-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </label>
        {sent.error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{sent.error}</AlertDescription>
          </Alert>
        ) : null}
        <Button type="submit" size="lg" variant={phone ? "outline" : "default"} disabled={requesting}>
          {requesting ? <LoaderCircle className="animate-spin" aria-hidden /> : <MessageCircle aria-hidden />}
          {phone ? "Kirim ulang kode" : "Kirim kode lewat WhatsApp"}
        </Button>
      </form>

      {phone ? (
        <form action={verifyFormAction} className="grid gap-3" data-testid="otp-verify">
          <p role="status" className="text-sm text-muted-foreground">
            {sent.message}
          </p>
          {devCode ? (
            <p className="rounded-md border border-dashed border-warning bg-warning/10 p-2 text-sm" data-testid="otp-dev-code">
              Mode uji (WhatsApp Business API belum aktif): kode Anda <strong className="tabular">{devCode}</strong>
            </p>
          ) : null}
          <input type="hidden" name="phone" value={phone} />
          {next ? <input type="hidden" name="lanjut" value={next} /> : null}
          <label className="grid gap-1 text-sm font-medium">
            Kode verifikasi (6 angka)
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={8}
              required
              className="h-12 rounded-md border border-input bg-background px-3 text-center text-2xl tracking-[0.4em] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          </label>
          {verified.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{verified.error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" size="lg" disabled={verifying}>
            {verifying ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            Masuk
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** Formulir kode OTP sekali pakai (verifikasi ulang pembayaran, ganti nomor). */
export function OtpStep({
  requestAction,
  submitAction,
  hidden,
  requestLabel = "Kirim kode verifikasi",
  submitLabel = "Lanjut",
  testId,
}: {
  requestAction: (s: P2ActionState) => Promise<P2ActionState>;
  submitAction: (s: P2ActionState, fd: FormData) => Promise<P2ActionState>;
  hidden?: Record<string, string>;
  requestLabel?: string;
  submitLabel?: string;
  testId?: string;
}) {
  const [sent, requestFormAction, requesting] = useActionState(requestAction, {} as P2ActionState);
  const [done, submitFormAction, submitting] = useActionState(submitAction, {} as P2ActionState);
  const devCode = typeof sent.data?.devCode === "string" ? sent.data.devCode : null;
  return (
    <div className="grid gap-4" data-testid={testId}>
      <form action={requestFormAction}>
        <Button type="submit" variant={sent.ok ? "outline" : "default"} disabled={requesting}>
          {requesting ? <LoaderCircle className="animate-spin" aria-hidden /> : <MessageCircle aria-hidden />}
          {sent.ok ? "Kirim ulang kode" : requestLabel}
        </Button>
        {sent.error ? <p className="mt-2 text-sm text-destructive">{sent.error}</p> : null}
      </form>
      {sent.ok ? (
        <form action={submitFormAction} className="grid gap-3">
          <p role="status" className="text-sm text-muted-foreground">
            {sent.message}
          </p>
          {devCode ? (
            <p className="rounded-md border border-dashed border-warning bg-warning/10 p-2 text-sm" data-testid="otp-dev-code">
              Mode uji: kode Anda <strong className="tabular">{devCode}</strong>
            </p>
          ) : null}
          {Object.entries(hidden ?? {}).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            required
            aria-label="Kode verifikasi"
            className="h-12 rounded-md border border-input bg-background px-3 text-center text-2xl tracking-[0.4em]"
          />
          {done.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{done.error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            {submitLabel}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
