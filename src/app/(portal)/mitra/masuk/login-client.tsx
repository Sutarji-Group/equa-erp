"use client";

import { LoginForm } from "@/components/auth/login-form";

import { portalLoginAction } from "../actions";

/** Formulir masuk portal mitra (galat server tampil sebagai pesan tindakan). */
export function PortalLoginClient({ notice }: { notice?: string | null }) {
  return (
    <LoginForm
      error={notice ?? undefined}
      footer={<span className="text-xs text-muted-foreground">Portal baca-saja untuk pemilik mitra depot.</span>}
      onSubmit={async (values) => {
        const result = await portalLoginAction(values);
        return result ? { error: result.error } : undefined;
      }}
    />
  );
}
