import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "UI kit", template: "%s · UI kit · EQUA" },
  robots: { index: false, follow: false },
};

/** Halaman demo komponen — HANYA di luar produksi (tinjauan visual tim). */
export default function UiKitLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return <>{children}</>;
}
