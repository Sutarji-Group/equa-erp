import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Dokumen rilis & operasional yang tautan relatifnya wajib valid. */
const DOCS = [
  "README.md",
  "CHANGELOG.md",
  "docs/RELEASE_NOTES_v1.0.md",
  "docs/prd/status.md",
  "docs/deploy/README.md",
  "docs/ops/runbook.md",
  ...readdirSync(path.join(ROOT, "docs/uat"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/uat/${f}`),
];

function relativeLinks(file: string): string[] {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!)
    .filter((t) => !/^(https?:|mailto:|#)/.test(t));
}

describe("dokumen rilis v1.0 (S5-C)", () => {
  it("NFR-33 semua tautan relatif di README, CHANGELOG, catatan rilis, status PRD, deploy, runbook, dan UAT menunjuk berkas yang ada", () => {
    const broken: string[] = [];
    for (const doc of DOCS) {
      for (const link of relativeLinks(doc)) {
        const target = path.resolve(path.dirname(path.join(ROOT, doc)), link.split("#")[0]!);
        if (!existsSync(target)) broken.push(`${doc} → ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("versi package.json = rilis teratas CHANGELOG = catatan rilis (versi tampil di aplikasi lapangan)", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
    const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
    const top = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog)?.[1];
    expect(top).toBe(pkg.version);
    const [major, minor] = pkg.version.split(".");
    const notes = path.join(ROOT, `docs/RELEASE_NOTES_v${major}.${minor}.md`);
    expect(existsSync(notes), notes).toBe(true);
    expect(readFileSync(path.join(ROOT, "README.md"), "utf8")).toContain(`**Versi ${pkg.version}**`);
  });
});
