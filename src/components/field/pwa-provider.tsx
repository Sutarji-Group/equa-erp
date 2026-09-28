"use client";

import { type ReactNode, useEffect } from "react";

/**
 * Pendaftaran service worker PWA lapangan (`/serwist/sw.js`, dibangun @serwist/turbopack; scope `/`, tipe module).
 * Nonaktif di `next dev` agar cache tidak membingungkan saat pengembangan. Sengaja TIDAK memakai
 * `SerwistProvider` dari `@serwist/turbopack/react`: paket itu eksternal di server (esbuild) sehingga komponen
 * React-nya memakai salinan React lain saat SSR. Sinyal kembali TIDAK memuat ulang halaman (isian tidak hilang) —
 * worker sinkron yang mengirim antrean.
 */
export function PwaProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (process.env.NODE_ENV === "development" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/serwist/sw.js", { scope: "/", type: "module" }).catch((error: unknown) => {
      console.warn("[equa] service worker gagal didaftarkan:", error);
    });
  }, []);
  return <>{children}</>;
}
