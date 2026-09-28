"use client";

import { LoginForm } from "@/components/auth/login-form";

import { loginAction } from "./actions";

/** Formulir masuk yang memanggil Server Action (galat server ditampilkan sebagai pesan tindakan). */
export function LoginClient({ notice, next }: { notice?: string | null; next?: string | null }) {
  return (
    <LoginForm
      error={notice ?? undefined}
      onSubmit={async (values) => {
        const result = await loginAction(values, next);
        return result ? { error: result.error } : undefined;
      }}
    />
  );
}
