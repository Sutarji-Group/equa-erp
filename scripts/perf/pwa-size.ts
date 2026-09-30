/**
 * `pnpm perf:pwa` — ukuran unduhan PWA lapangan (NFR-17) dari hasil `pnpm build`:
 * - daftar precache service worker (`/serwist/sw.js`, manifest Serwist) → jumlah berkas, byte mentah & gzip;
 * - rincian per jenis (JS/CSS/font/gambar/halaman) dan 10 berkas terbesar;
 * - perkiraan unduhan saat PASANG pertama & saat setiap RILIS (berkas berhash berubah → diunduh ulang).
 *
 * Opsi: `--json <berkas>` simpan hasil. Jalankan setelah `pnpm build` (membaca `.next/`, tidak menjalankan server).
 * Halaman lapangan (/sopir, /pos, /produksi, …) diukur dari HTML prerender bila ada; bila dinamis, dicatat "dinamis".
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { fieldPrecacheAssets } from "@/server/pwa/field-precache";

type Entry = { url: string; revision?: string | null };

function manifestFromSw(sw: string): Entry[] {
  // Serwist menyuntikkan `self.__SW_MANIFEST` sebagai literal objek (diminifikasi esbuild): {url:"…",revision:null|"…"}.
  // Urutan kunci bergantung pada keluaran esbuild ({url,revision} atau {revision,url}).
  const urlFirst = /\{\s*"?url"?\s*:\s*"([^"]+)"\s*,\s*"?revision"?\s*:\s*(null|"[^"]*")\s*\}/g;
  const revisionFirst = /\{\s*"?revision"?\s*:\s*(null|"[^"]*")\s*,\s*"?url"?\s*:\s*"([^"]+)"\s*\}/g;
  const out: Entry[] = [];
  const rev = (raw: string) => (raw === "null" ? null : raw.slice(1, -1));
  for (const m of sw.matchAll(urlFirst)) out.push({ url: m[1]!, revision: rev(m[2]!) });
  for (const m of sw.matchAll(revisionFirst)) out.push({ url: m[2]!, revision: rev(m[1]!) });
  if (!out.length) throw new Error("Manifest precache tidak ditemukan di sw.js — jalankan `pnpm build` dulu.");
  return out;
}

function fileFor(url: string): string | null {
  const clean = url.split("?")[0]!;
  if (clean.startsWith("/_next/static/")) return path.join(".next/static", clean.slice("/_next/static/".length));
  const pub = path.join("public", clean);
  if (existsSync(pub) && statSync(pub).isFile()) return pub;
  const page = clean === "/" ? "index" : clean.replace(/^\//, "");
  for (const candidate of [`.next/server/app/${page}.html`, `.next/server/app/${page}/index.html`]) if (existsSync(candidate)) return candidate;
  return null;
}

function kindOf(url: string): string {
  if (/\.js(\?|$)/.test(url)) return "js";
  if (/\.css(\?|$)/.test(url)) return "css";
  if (/\.(woff2?|ttf|otf)(\?|$)/.test(url)) return "font";
  if (/\.(png|jpe?g|webp|svg|ico|gif)(\?|$)/.test(url)) return "gambar";
  if (!/\.[a-z0-9]+(\?|$)/i.test(url)) return "halaman";
  return "lain";
}

function main(): void {
  const swPath = ".next/server/app/serwist/sw.js.body";
  if (!existsSync(swPath)) throw new Error("sw.js belum dibangun — jalankan `pnpm build` dulu.");
  const sw = readFileSync(swPath, "utf8");
  const entries = manifestFromSw(sw);
  const rows = entries.map((e) => {
    const file = fileFor(e.url);
    const buf = file ? readFileSync(file) : null;
    return { url: e.url, hashed: !e.revision, kind: kindOf(e.url), bytes: buf?.length ?? 0, gzip: buf ? gzipSync(buf).length : 0, missing: !buf };
  });
  const sum = (list: typeof rows, k: "bytes" | "gzip") => list.reduce((s, r) => s + r[k], 0);
  const byKind: Record<string, { files: number; bytes: number; gzip: number }> = {};
  for (const r of rows) {
    const cur = byKind[r.kind] ?? { files: 0, bytes: 0, gzip: 0 };
    cur.files++;
    cur.bytes += r.bytes;
    cur.gzip += r.gzip;
    byKind[r.kind] = cur;
  }
  const swGzip = gzipSync(Buffer.from(sw)).length;
  // Aset yang benar-benar dibutuhkan halaman lapangan (chunk halaman + impor dinamis) — lihat src/server/pwa/field-precache.ts.
  const field = fieldPrecacheAssets(".next");
  const fieldRows = field ? rows.filter((r) => !r.url.startsWith("/_next/static/") || field.has(r.url.slice("/_next/".length))) : rows;
  let fieldAll = 0;
  let fieldAllGzip = 0;
  for (const a of field ?? []) {
    const buf = readFileSync(path.join(".next", a));
    fieldAll += buf.length;
    fieldAllGzip += gzipSync(buf).length;
  }
  const result = {
    measuredAt: new Date().toISOString(),
    swBytes: sw.length,
    swGzip,
    files: rows.length,
    bytes: sum(rows, "bytes"),
    gzip: sum(rows, "gzip"),
    byKind,
    fieldNeeded: field ? { files: field.size, bytes: fieldAll, gzip: fieldAllGzip } : null,
    precachedButNotNeededByField: { files: rows.length - fieldRows.length, bytes: sum(rows, "bytes") - sum(fieldRows, "bytes"), gzip: sum(rows, "gzip") - sum(fieldRows, "gzip") },
    missing: rows.filter((r) => r.missing).map((r) => r.url),
    largest: [...rows].sort((a, b) => b.gzip - a.gzip).slice(0, 10).map((r) => ({ url: r.url, kb: Math.round(r.bytes / 102.4) / 10, gzipKb: Math.round(r.gzip / 102.4) / 10 })),
  };
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`sw.js ${kb(result.swBytes)} (gzip ${kb(result.swGzip)}) · precache ${result.files} berkas · ${kb(result.bytes)} mentah · ${kb(result.gzip)} gzip`);
  console.table(Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { berkas: v.files, mentahKB: Math.round(v.bytes / 1024), gzipKB: Math.round(v.gzip / 1024) }])));
  if (result.fieldNeeded) console.log(`dibutuhkan halaman lapangan: ${result.fieldNeeded.files} berkas · ${kb(result.fieldNeeded.bytes)} mentah · ${kb(result.fieldNeeded.gzip)} gzip`);
  console.log(`di-precache tetapi tidak dibutuhkan halaman lapangan: ${result.precachedButNotNeededByField.files} berkas · ${kb(result.precachedButNotNeededByField.bytes)} mentah · ${kb(result.precachedButNotNeededByField.gzip)} gzip`);
  console.table(result.largest);
  if (result.missing.length) console.warn(`Tidak ditemukan di disk (halaman dinamis / dibangkitkan saat diminta): ${result.missing.join(", ")}`);
  const out = process.argv.indexOf("--json");
  if (out >= 0 && process.argv[out + 1]) writeFileSync(process.argv[out + 1]!, `${JSON.stringify(result, null, 2)}\n`);
}

main();
