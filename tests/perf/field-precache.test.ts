import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { fieldPrecacheAssets, filterFieldPrecache } from "@/server/pwa/field-precache";

/** Keluaran build tiruan: satu halaman lapangan, satu chunk kantor yang tidak dirujuk. */
function fakeBuild(): string {
  const dist = mkdtempSync(path.join(tmpdir(), "equa-precache-"));
  const put = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    writeFileSync(path.join(dist, rel), content);
  };
  put(
    "server/app/(field)/sopir/page_client-reference-manifest.js",
    'globalThis.__RSC_MANIFEST={"entryJSFiles":{"[project]/src/app/(field)/sopir/page":["static/chunks/sopir.js"]},"entryCSSFiles":{"x":[{"path":"static/chunks/app.css"}]}}',
  );
  put("server/app/(field)/sopir/page/build-manifest.json", JSON.stringify({ rootMainFiles: ["static/chunks/root.js"], polyfillFiles: ["static/chunks/polyfill.js"] }));
  put("server/app/~offline/page_client-reference-manifest.js", '{"entryJSFiles":{"offline":["static/chunks/offline.js"]}}');
  put("static/chunks/sopir.js", 'o.v(t=>Promise.all(["static/chunks/kamera.js"].map(t=>o.l(t))))');
  put("static/chunks/kamera.js", 'o.v(t=>Promise.all(["static/chunks/tandatangan.js"].map(t=>o.l(t))))');
  put("static/chunks/tandatangan.js", "void 0");
  put("static/chunks/root.js", "void 0");
  put("static/chunks/polyfill.js", "void 0");
  put("static/chunks/offline.js", "void 0");
  put("static/chunks/app.css", "@font-face{src:url(../media/inter.woff2)} .x{background:url(/_next/static/media/logo.png)}");
  put("static/media/logo.png", "png");
  put("static/media/inter.woff2", "font");
  put("static/chunks/kantor-peta.js", 'o.v(t=>Promise.all(["static/chunks/kantor-grafik.js"].map(t=>o.l(t))))');
  put("static/chunks/kantor-grafik.js", "void 0");
  return dist;
}

describe("NFR-17 precache PWA lapangan hanya aset halaman lapangan", () => {
  const dist = fakeBuild();
  const empty = mkdtempSync(path.join(tmpdir(), "equa-precache-kosong-"));
  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  });

  it("NFR-17 US-M3-10 KP-4 unduhan kecil: chunk halaman lapangan + impor dinamis (transitif) + CSS/media ikut; chunk web kantor tidak di-precache; berkas public selalu ikut", () => {
    const assets = fieldPrecacheAssets(dist)!;
    expect([...assets].sort()).toEqual(
      ["static/chunks/app.css", "static/chunks/kamera.js", "static/chunks/offline.js", "static/chunks/polyfill.js", "static/chunks/root.js", "static/chunks/sopir.js", "static/chunks/tandatangan.js", "static/media/inter.woff2", "static/media/logo.png"].sort(),
    );
    const entries = [
      ...["sopir.js", "kamera.js", "tandatangan.js", "root.js", "polyfill.js", "offline.js", "app.css", "kantor-peta.js", "kantor-grafik.js"].map((f) => ({ url: `${dist}/static/chunks/${f}`, revision: null, size: 1 })),
      { url: `${dist}/static/media/logo.png`, revision: null, size: 1 },
      { url: "public/icons/icon-192.png", revision: "r1", size: 1 },
    ];
    const { manifest, warnings } = filterFieldPrecache(entries, dist);
    expect(warnings).toEqual([]);
    const kept = manifest.map((e) => e.url.replace(`${dist}/`, ""));
    expect(kept).toContain("public/icons/icon-192.png");
    expect(kept).toContain("static/chunks/tandatangan.js");
    expect(kept).not.toContain("static/chunks/kantor-peta.js");
    expect(kept).not.toContain("static/chunks/kantor-grafik.js");
    expect(manifest).toHaveLength(entries.length - 2);
  });

  it("NFR-17 US-M3-10 KP-4 struktur build tidak dikenali → semua aset tetap di-precache (aman untuk offline) dengan peringatan", () => {
    expect(fieldPrecacheAssets(empty)).toBeNull();
    const entries = [{ url: `${empty}/static/chunks/a.js` }, { url: "public/x.png" }];
    const res = filterFieldPrecache(entries, empty);
    expect(res.manifest).toEqual(entries);
    expect(res.warnings).toHaveLength(1);
  });
});
