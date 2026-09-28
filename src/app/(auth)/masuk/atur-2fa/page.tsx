import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { startTotpEnrollment } from "@/server/core/auth";
import { currentSessionToken, getOfficeSession, getRequestMeta } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";

import { EnrollClient } from "./enroll-client";

export const metadata: Metadata = { title: "Aktifkan verifikasi 2 langkah" };

/** Pendaftaran TOTP wajib untuk peran berisiko yang belum memiliki 2FA (PTB-35): QR + kode pertama. */
export default async function EnrollTwoFactorPage() {
  const session = await getOfficeSession();
  if (session.state === "active") redirect("/beranda");
  if (session.state === "totp") redirect("/masuk/2fa");
  if (session.state === "none") redirect("/masuk?alasan=perlu-masuk");
  let enrollment: Awaited<ReturnType<typeof startTotpEnrollment>> | null = null;
  let error: string | null = null;
  try {
    enrollment = await startTotpEnrollment((await currentSessionToken()) ?? "", await getRequestMeta());
  } catch (e) {
    error = toUserMessage(e);
  }
  return (
    <main className="flex flex-1 items-center justify-center bg-muted/40 p-4">
      {enrollment ? (
        <EnrollClient otpauthUrl={enrollment.otpauthUrl} secret={enrollment.secret} qrDataUrl={enrollment.qrDataUrl} />
      ) : (
        <p role="alert" className="max-w-sm rounded-md border border-destructive/30 bg-destructive/5 p-4 text-destructive">
          {error ?? "Pendaftaran verifikasi 2 langkah tidak dapat dimulai. Silakan masuk lagi."}
        </p>
      )}
    </main>
  );
}
