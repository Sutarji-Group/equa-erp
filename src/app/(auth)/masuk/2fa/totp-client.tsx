"use client";

import { TotpForm } from "@/components/auth/totp-form";

import { cancelLoginAction, verifyTotpAction } from "../actions";

export function TotpClient({ userName }: { userName: string }) {
  return (
    <TotpForm
      userName={userName}
      onSubmit={async (code) => {
        const result = await verifyTotpAction(code);
        if (result?.error) throw new Error(result.error);
      }}
      onCancel={() => void cancelLoginAction()}
    />
  );
}
