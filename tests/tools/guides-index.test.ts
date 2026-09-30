import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GUIDES = path.join(ROOT, "docs/guides");

/** Slug judul gaya GitHub: huruf kecil, buang tanda baca (selain spasi & strip), spasi → strip. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}

function anchorsOf(file: string): Set<string> {
  const text = readFileSync(file, "utf8");
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]!)));
}

function words(file: string): number {
  return readFileSync(file, "utf8").split(/\s+/).filter(Boolean).length;
}

describe("panduan pengguna per peran (S5-C)", () => {
  it("NFR-16 panduan lapangan maksimal satu halaman cetak (≤ 350 kata) untuk sopir/kernet, operator depot, kasir, operator produksi", () => {
    const dir = path.join(GUIDES, "lapangan");
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.sort()).toEqual(["kasir-toko.md", "operator-depot.md", "operator-produksi.md", "sopir-kernet.md"]);
    for (const f of files) expect(words(path.join(dir, f)), f).toBeLessThanOrEqual(350);
  });

  it("NFR-33 indeks docs/guides/README.md menautkan semua panduan dan setiap tautan (berkas & jangkar) valid", () => {
    const readme = path.join(GUIDES, "README.md");
    const text = readFileSync(readme, "utf8");
    const all = [
      ...readdirSync(GUIDES).filter((f) => f.endsWith(".md") && f !== "README.md"),
      ...readdirSync(path.join(GUIDES, "lapangan")).map((f) => `lapangan/${f}`),
    ];
    for (const f of all) expect(text, `indeks belum menautkan ${f}`).toContain(`](${f}`);
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = m[1]!;
      if (/^https?:/.test(target)) continue;
      const [file, anchor] = target.split("#");
      const abs = path.resolve(GUIDES, file!);
      expect(existsSync(abs), `tautan rusak: ${target}`).toBe(true);
      if (anchor && abs.endsWith(".md")) expect(anchorsOf(abs).has(anchor), `jangkar tidak ada: ${target}`).toBe(true);
    }
  });
});
