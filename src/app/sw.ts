/// <reference lib="webworker" />
/**
 * Service worker PWA "EQUA Lapangan" (Serwist; dibundel esbuild lewat route `src/app/serwist/[path]/route.ts`).
 *
 * - Precache: aset build Next + halaman lapangan (/sopir, /pos, /produksi, /aktivasi-perangkat) + /~offline.
 * - Halaman lapangan: NetworkFirst (timeout 3 dtk) → tetap tampil tanpa sinyal.
 * - API (`/api/**`) dan halaman web kantor TIDAK pernah di-cache (data kantor tidak tertinggal di perangkat).
 * - Dokumen yang tidak tersedia offline → /~offline.
 * - Web Push (B-68, PTB-05): event `push` menampilkan notifikasi (pelanggan aplikasi P2 & pengguna lapangan/kantor)
 *   dari muatan `{ title, body, url, tag, severity }`; mengetuk notifikasi membuka/memfokuskan tautan asal yang sama.
 */
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist, StaleWhileRevalidate } from "serwist";

import { isFieldPath } from "../lib/field-routes";
import { buildPushNotification, safeNotificationPath } from "../lib/push-notification";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Rute lapangan vs subrute kantor M8: satu sumber di src/lib/field-routes.ts (diuji terhadap registri nav & proxy).

const runtimeCaching: RuntimeCaching[] = [
  { matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api/"), handler: new NetworkOnly() },
  {
    matcher: ({ request, url, sameOrigin }) => sameOrigin && request.headers.get("RSC") === "1" && isFieldPath(url.pathname),
    handler: new NetworkFirst({
      cacheName: "field-rsc",
      networkTimeoutSeconds: 3,
      plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 7 * 24 * 60 * 60 })],
    }),
  },
  {
    matcher: ({ request, url, sameOrigin }) => sameOrigin && request.mode === "navigate" && isFieldPath(url.pathname),
    handler: new NetworkFirst({
      cacheName: "field-pages",
      networkTimeoutSeconds: 3,
      plugins: [new ExpirationPlugin({ maxEntries: 16, maxAgeSeconds: 7 * 24 * 60 * 60 })],
    }),
  },
  {
    matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/_next/static/"),
    handler: new CacheFirst({
      cacheName: "next-static",
      plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 })],
    }),
  },
  {
    matcher: ({ request, sameOrigin }) => sameOrigin && (request.destination === "image" || request.destination === "font"),
    handler: new StaleWhileRevalidate({
      cacheName: "static-assets",
      plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 })],
    }),
  },
  // Selain itu (termasuk halaman web kantor): selalu jaringan, tidak disimpan.
  { matcher: () => true, handler: new NetworkOnly() },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching,
  fallbacks: {
    entries: [{ url: "/~offline", matcher: ({ request }) => request.destination === "document" }],
  },
});

serwist.addEventListeners();

// --- Web Push (B-68) -------------------------------------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let raw: string | null = null;
  try {
    raw = event.data ? event.data.text() : null;
  } catch {
    raw = null;
  }
  const n = buildPushNotification(raw, self.location.origin);
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  const path = safeNotificationPath(data?.url, self.location.origin);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target) return client.focus();
      }
      const any = windows[0];
      if (any) {
        await any.focus();
        return any.navigate(target);
      }
      return self.clients.openWindow(target);
    })(),
  );
});
