import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getOfficeSession } from "@/server/core/auth/office";

import { TotpClient } from "./totp-client";

export const metadata: Metadata = { title: "Verifikasi 2 langkah" };

/** Langkah kedua masuk untuk pemilik, Admin Keuangan, admin sistem (PTB-35). */
export default async function TwoFactorPage() {
  const session = await getOfficeSession();
  if (session.state === "active") redirect("/beranda");
  if (session.state === "totp_enroll") redirect("/masuk/atur-2fa");
  if (session.state === "none") redirect("/masuk?alasan=perlu-masuk");
  return (
    <main className="flex flex-1 items-center justify-center bg-muted/40 p-4">
      <TotpClient userName={session.user.name} />
    </main>
  );
}
