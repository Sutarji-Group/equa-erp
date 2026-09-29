import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDb } from "@/server/core/db";
import * as p3 from "@/server/modules/p3-partner";

import { getPortalSession } from "../_session";
import { PortalLoginClient } from "./login-client";

export const metadata: Metadata = { title: "Masuk portal mitra" };

const REASONS: Record<string, string> = {
  keluar: "Anda sudah keluar dari portal mitra.",
  "bukan-portal": "Akun ini bukan akun pemilik mitra. Pengguna EQUA masuk lewat web kantor.",
  "akun-nonaktif": "Akun Anda tidak aktif. Hubungi admin sistem EQUA.",
};

/** Masuk portal pemilik mitra (RL-7 US-P3-10 KP-1): nama pengguna + kata sandi, antarmuka `portal` (D-07). */
export default async function PortalLoginPage({ searchParams }: { searchParams: Promise<{ alasan?: string }> }) {
  const sp = await searchParams;
  const s = await getPortalSession();
  if (s.state === "active") redirect("/mitra");
  if (s.reason === "must_change_password") redirect("/akun/kata-sandi?wajib=1");
  const terms = await p3.partnerTerms(getDb());
  const phase3 = await p3.portalEnabled(getDb());
  const notice = sp.alasan ? (REASONS[sp.alasan] ?? null) : null;
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-muted/40 p-4">
      <div className="text-center">
        <p className="text-sm font-medium text-muted-foreground">Portal</p>
        <h1 className="text-2xl font-semibold">{terms.program}</h1>
      </div>
      <PortalLoginClient notice={notice} />
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        Akun pemilik mitra dibuat admin sistem EQUA setelah disetujui pemilik. Lupa kata sandi? Hubungi pembina wilayah EQUA.
        {phase3 ? (
          <>
            {" "}
            Calon mitra baru dapat{" "}
            <Link href="/mitra/daftar" className="text-primary underline">
              mendaftar di sini
            </Link>
            .
          </>
        ) : null}
      </p>
    </main>
  );
}
