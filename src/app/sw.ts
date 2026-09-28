/// <reference lib="webworker" />
/**
 * Service worker PWA "EQUA Lapangan" (Serwist; dibundel esbuild lewat route `src/app/serwist/[path]/route.ts`).
 *
 * - Precache: aset build Next + halaman lapangan (/sopir, /pos, /produksi, /aktivasi-perangkat) + /~offline.
 * - Halaman lapangan: NetworkFirst (timeout 3 dtk) → tetap tampil tanpa sinyal.
 * - API (`/api/**`) dan halaman web kantor TIDAK pernah di-cache (data kantor tidak tertinggal di perangkat).
 * - Dokumen yang tidak tersedia offline → /~offline.
 */
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist, StaleWhileRevalidate } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const FIELD_ROUTES = /^\/(sopir|pos|produksi|aktivasi-perangkat|~offline)(\/|$)/;
const OFFICE_M8_ROUTES = /^\/produksi\/(neraca-air|utilisasi|mutu)(\/|$)/;

function isFieldPath(pathname: string): boolean {
  return FIELD_ROUTES.test(pathname) && !OFFICE_M8_ROUTES.test(pathname);
}

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
