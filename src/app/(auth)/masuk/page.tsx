import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOfficeSession, LOGIN_REASON_MESSAGES, safeNextPath } from "@/server/core/auth/office";

import { LoginClient } from "./login-client";

export const metadata: Metadata = { title: "Masuk" };

/** Halaman masuk web kantor (US-M10-02 KP-4). Pengguna yang sudah masuk diarahkan ke beranda / langkah 2FA. */
export default async function MasukPage({ searchParams }: PageProps<"/masuk">) {
  const sp = await searchParams;
  const session = await getOfficeSession();
  const next = typeof sp.lanjut === "string" ? sp.lanjut : null;
  if (session.state === "active") redirect(safeNextPath(next));
  if (session.state === "totp") redirect("/masuk/2fa");
  if (session.state === "totp_enroll") redirect("/masuk/atur-2fa");
  const reason = typeof sp.alasan === "string" ? sp.alasan : next ? "perlu-masuk" : null;
  const notice = reason ? (LOGIN_REASON_MESSAGES[reason] ?? null) : null;
  return (
    <main className="flex flex-1 items-center justify-center bg-muted/40 p-4">
      <LoginClient notice={notice} next={next} />
    </main>
  );
}
