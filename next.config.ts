import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Paket server yang memuat berkas WASM/native atau require dinamis — jangan dibundel.
  serverExternalPackages: ["@electric-sql/pglite", "ws", "exceljs"],
};

export default nextConfig;
