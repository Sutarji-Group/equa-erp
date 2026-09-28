import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createSerwistRoute } from "@serwist/turbopack";

/**
 * Service worker PWA lapangan lewat @serwist/turbopack (Next 16 + Turbopack; @serwist/next hanya untuk webpack):
 * `src/app/sw.ts` dibundel esbuild saat build lalu disajikan statis di `/serwist/sw.js` (scope `/`).
 * Halaman lapangan & /~offline ikut di-precache (revisi = commit build).
 */
const revision =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  (spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout?.trim() || randomUUID());

const route = createSerwistRoute({
  swSrc: "src/app/sw.ts",
  useNativeEsbuild: true,
  additionalPrecacheEntries: ["/~offline", "/aktivasi-perangkat", "/sopir", "/pos", "/produksi"].map((url) => ({ url, revision })),
});

export const dynamic = "force-static";
export const dynamicParams = false;
export const revalidate = false;
export const generateStaticParams = route.generateStaticParams;
export const GET = route.GET;
