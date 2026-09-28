import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { PwaProvider } from "@/components/field/pwa-provider";

export const metadata: Metadata = {
  title: { default: "EQUA Lapangan", template: "%s · EQUA Lapangan" },
  applicationName: "EQUA Lapangan",
  manifest: "/lapangan.webmanifest",
  appleWebApp: { capable: true, title: "EQUA Lapangan", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = { themeColor: "#1e40af" };

/**
 * Layout aplikasi lapangan (PWA offline-first): tema kontras tinggi (teks dasar 18px) untuk sopir, operator produksi,
 * dan kasir POS + pendaftaran service worker. Halaman di bawahnya client-side (token perangkat, Dexie), tanpa cookie.
 */
export default function FieldLayout({ children }: { children: ReactNode }) {
  return (
    <div data-theme="field" className="flex min-h-dvh flex-1 flex-col">
      <PwaProvider>{children}</PwaProvider>
    </div>
  );
}
