/**
 * Daftar aset build yang DIBUTUHKAN rute PWA lapangan (NFR-17: unduhan kecil). Dipakai `manifestTransforms` service
 * worker (`src/app/serwist/[path]/route.ts`) agar ponsel sopir/POS/produksi hanya mem-precache potongan (chunk) halaman
 * lapangan — bukan seluruh `/_next/static/**` web kantor (peta, grafik, ekspor, dll.).
 *
 * Cara menghitung (saat build, dari keluaran Next/Turbopack di `.next/`):
 * 1. Titik awal = berkas klien setiap halaman lapangan (`server/app/(field)/**` + `~offline`,
 *    `page_client-reference-manifest.js`) + berkas akar/polyfill dari `build-manifest.json` halaman itu.
 * 2. Tutup transitif: setiap chunk JS/CSS yang terpilih dipindai untuk rujukan `static/chunks/…` / `static/media/…`
 *    (impor dinamis Turbopack memuat chunk lewat string itu) → ikut dipilih. Dengan begitu komponen yang dimuat malas
 *    (kamera, tanda tangan, dsb.) tetap tersedia offline.
 * Bila manifest tidak ditemukan (struktur build berubah), fungsi mengembalikan `null` → pemanggil mem-precache SEMUA
 * aset (perilaku lama, aman untuk offline).
 *
 * Hanya dipakai saat build/route handler (Node). Tidak mengimpor modul aplikasi lain.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ASSET_RE = /static\/(?:chunks|media)\/[A-Za-z0-9_.~\-/]+?\.(?:js|css|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico|avif)/g;
/** CSS Next merujuk media secara relatif: `url(../media/<berkas>)` dari `static/chunks/*.css`. */
const CSS_MEDIA_RE = /\.\.\/media\/([A-Za-z0-9_.~-]+)/g;

/** Direktori halaman lapangan di `server/app` (grup rute `(field)` + halaman fallback offline). */
function fieldPageDirs(appDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page_client-reference-manifest.js") out.push(dir);
    }
  };
  walk(path.join(appDir, "(field)"));
  if (existsSync(path.join(appDir, "~offline", "page_client-reference-manifest.js"))) out.push(path.join(appDir, "~offline"));
  return out;
}

/**
 * Aset `static/…` (relatif ke `distDir`) yang dibutuhkan halaman lapangan, atau `null` bila tidak dapat ditentukan.
 * @param distDir direktori build Next (bawaan `.next`).
 */
export function fieldPrecacheAssets(distDir = ".next"): Set<string> | null {
  const appDir = path.join(distDir, "server", "app");
  const pages = fieldPageDirs(appDir);
  if (!pages.length) return null;
  const selected = new Set<string>();
  const addFrom = (text: string) => {
    for (const m of text.matchAll(ASSET_RE)) if (existsSync(path.join(distDir, m[0]))) selected.add(m[0]);
  };
  for (const dir of pages) {
    addFrom(readFileSync(path.join(dir, "page_client-reference-manifest.js"), "utf8"));
    const build = path.join(dir, "page", "build-manifest.json");
    if (existsSync(build)) {
      const manifest = JSON.parse(readFileSync(build, "utf8")) as { rootMainFiles?: string[]; polyfillFiles?: string[] };
      addFrom(JSON.stringify([...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])]));
    }
  }
  if (!selected.size) return null;
  // Tutup transitif atas rujukan chunk/media di dalam JS & CSS terpilih.
  const queue = [...selected];
  while (queue.length) {
    const asset = queue.pop()!;
    if (!/\.(js|css)$/.test(asset)) continue;
    const text = readFileSync(path.join(distDir, asset), "utf8");
    const refs = [...text.matchAll(ASSET_RE)].map((m) => m[0]);
    if (asset.endsWith(".css")) for (const m of text.matchAll(CSS_MEDIA_RE)) refs.push(`static/media/${m[1]}`);
    for (const ref of refs) {
      if (!selected.has(ref) && existsSync(path.join(distDir, ref))) {
        selected.add(ref);
        queue.push(ref);
      }
    }
  }
  return selected;
}

/**
 * Saring entri manifest precache Serwist (URL masih relatif `globDirectory`: `.next/static/…`, `public/…`) menjadi
 * aset lapangan saja. Berkas `public/` (ikon, manifest aplikasi) selalu disertakan. Tanpa daftar lapangan → semua.
 */
export function filterFieldPrecache<T extends { url: string }>(entries: T[], distDir = ".next"): { manifest: T[]; warnings: string[] } {
  const keep = fieldPrecacheAssets(distDir);
  if (!keep) return { manifest: entries, warnings: ["Daftar aset lapangan tidak ditemukan — semua aset build di-precache."] };
  const prefix = `${distDir.replace(/^\.\//, "").replace(/\/$/, "")}/`;
  return {
    manifest: entries.filter((e) => !e.url.startsWith(prefix) || keep.has(e.url.slice(prefix.length))),
    warnings: [],
  };
}
