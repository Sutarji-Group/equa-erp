/** Manifest PWA aplikasi pelanggan (PTB-49: PWA yang dapat dipasang). */
export const dynamic = "force-static";

export function GET(): Response {
  const manifest = {
    id: "/app",
    name: "EQUA Pelanggan — Pesan Air",
    short_name: "EQUA",
    description: "Pesan air truk EQUA, pantau pengiriman, lihat tagihan, dan bayar dari ponsel.",
    lang: "id",
    dir: "ltr",
    start_url: "/app",
    scope: "/app",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#1e40af",
    categories: ["shopping", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/manifest+json; charset=utf-8" } });
}
