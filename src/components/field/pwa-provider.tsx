"use client";

import { SerwistProvider } from "@serwist/turbopack/react";
import type { ReactNode } from "react";

/**
 * Pendaftaran service worker PWA lapangan (`/serwist/sw.js`, scope `/`). Nonaktif di `next dev` agar cache tidak
 * membingungkan saat pengembangan. `reloadOnOnline` dimatikan: sinyal kembali TIDAK memuat ulang halaman (isian
 * pengguna tidak hilang) — worker sinkron yang mengirim antrean.
 */
export function PwaProvider({ children }: { children: ReactNode }) {
  return (
    <SerwistProvider swUrl="/serwist/sw.js" disable={process.env.NODE_ENV === "development"} reloadOnOnline={false} cacheOnNavigation>
      {children}
    </SerwistProvider>
  );
}
