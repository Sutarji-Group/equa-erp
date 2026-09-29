import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { passwordPageState } from "@/server/core/auth";
import { currentSessionToken } from "@/server/core/auth/office";
import { ensureBootstrapped } from "@/server/core/bootstrap";

import { ChangePasswordClient } from "./change-password-client";

export const metadata: Metadata = { title: "Ubah kata sandi" };

/**
 * Ubah kata sandi mandiri untuk SEMUA pengguna web (kantor & portal mitra) — B-08, US-M10-02 KP-4. Kata sandi sementara
 * hasil reset admin sistem (`must_change_password`) diarahkan ke sini oleh `requireOfficeSession`/`requirePortalSession`
 * sebelum halaman lain dapat dibuka.
 */
export default async function UbahKataSandiPage() {
  ensureBootstrapped();
  const state = await passwordPageState(await currentSessionToken());
  if (!state) redirect("/masuk?alasan=perlu-masuk");
  return (
    <main className="flex flex-1 items-center justify-center bg-muted/40 p-4">
      <ChangePasswordClient forced={state.mustChange} username={state.username} home={state.home} />
    </main>
  );
}
