import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Droplets } from "lucide-react";

import { appEnabled } from "@/server/modules/p2-customer/web";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "EQUA — Pesan Air", template: "%s · EQUA Pelanggan" },
  applicationName: "EQUA Pelanggan",
  manifest: "/app/manifest",
  appleWebApp: { capable: true, title: "EQUA Pelanggan", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = { themeColor: "#1e40af" };

/**
 * Aplikasi pelanggan (Tahap 2, PWA): di balik flag `phase2.customer_app` (bawaan mati, D-02). Bila mati, semua layar
 * menampilkan arahan memesan lewat telepon/WhatsApp kantor.
 */
export default async function CustomerLayout({ children }: { children: ReactNode }) {
  if (!(await appEnabled())) {
    return (
      <div className="mx-auto grid min-h-dvh max-w-md place-content-center gap-3 px-6 text-center">
        <Droplets className="mx-auto size-10 text-primary" aria-hidden />
        <h1 className="text-xl font-semibold">Aplikasi pelanggan EQUA belum aktif</h1>
        <p className="text-muted-foreground">Silakan pesan air lewat telepon atau WhatsApp kantor EQUA seperti biasa.</p>
      </div>
    );
  }
  return <div className="flex min-h-dvh flex-1 flex-col bg-muted/30">{children}</div>;
}
