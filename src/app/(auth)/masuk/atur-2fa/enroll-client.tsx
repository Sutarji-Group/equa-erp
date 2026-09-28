"use client";

import { TotpEnrollCard } from "@/components/auth/totp-enroll-card";

import { confirmEnrollmentAction } from "../actions";

export function EnrollClient({ otpauthUrl, secret, qrDataUrl }: { otpauthUrl: string; secret: string; qrDataUrl: string }) {
  return (
    <TotpEnrollCard
      otpauthUrl={otpauthUrl}
      secret={secret}
      qrDataUrl={qrDataUrl}
      onVerify={async (code) => {
        const result = await confirmEnrollmentAction(code);
        if (result?.error) throw new Error(result.error);
      }}
    />
  );
}
