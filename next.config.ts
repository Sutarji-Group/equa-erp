import type { NextConfig } from "next";

import pkg from "./package.json";
import { SERVER_ACTION_BODY_LIMIT } from "./src/lib/upload-limits";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Paket server yang memuat berkas WASM/native atau require dinamis — jangan dibundel.
  // @serwist/turbopack + esbuild: bundel service worker saat build (route /serwist/[path]); esbuild di-resolve dari
  // lokasi paket serwist (pnpm) sehingga paketnya harus eksternal.
  serverExternalPackages: ["@electric-sql/pglite", "ws", "exceljs", "@serwist/turbopack", "esbuild", "esbuild-wasm"],
  experimental: {
    serverActions: {
      // D-10 butir 3 (B-18): unggahan bukti/berkas kantor lewat Server Action sampai 4 MB (di bawah batas badan
      // permintaan Vercel 4,5 MB). Foto dikompres di peramban (`UploadGuard`); berkas lebih besar ditolak dengan pesan.
      bodySizeLimit: SERVER_ACTION_BODY_LIMIT,
    },
  },
  env: {
    // Versi aplikasi lapangan (NFR-32) — dibandingkan dengan parameter `app.min_supported_version`.
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  async headers() {
    return [
      {
        source: "/serwist/:path*",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
