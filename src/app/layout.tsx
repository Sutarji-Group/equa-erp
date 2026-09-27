import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/components/shared/providers";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "EQUA", template: "%s · EQUA" },
  description: "Program Digitalisasi Terpadu EQUA — air truk, depot isi ulang, toko, dan sumber air.",
  applicationName: "EQUA",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" className={`${GeistSans.variable} ${GeistMono.variable} h-full`} suppressHydrationWarning>
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
