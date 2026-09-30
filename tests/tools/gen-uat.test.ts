import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parsePrdStories } from "../../tools/trace-check";
import { parseStoriesWithKp, renderAllUat } from "../../tools/gen-uat";
import { MODULES } from "../../tools/uat-config";

const ROOT = process.cwd();
const PRD = readFileSync(path.join(ROOT, "docs/prd/PRD_EQUA_v1_1.md"), "utf8");

describe("dokumen UAT per modul (PRD 11.3, S5-C)", () => {
  it("NFR-33 dokumen docs/uat/<modul>.md mutakhir terhadap PRD & tools/uat-config.ts (jalankan pnpm uat:gen)", () => {
    const stale: string[] = [];
    for (const [rel, content] of renderAllUat(ROOT)) {
      const abs = path.join(ROOT, rel);
      if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) stale.push(rel);
    }
    expect(stale, "Dokumen UAT tidak mutakhir — jalankan `pnpm uat:gen`").toEqual([]);
  });

  it("PRD 11.3 setiap user story M1–M12 dan RL-7 (US-P3-08..11) punya checklist dengan SEMUA KP-nya", () => {
    const withKp = new Map(parseStoriesWithKp(PRD).map((s) => [s.id, s]));
    const expected = parsePrdStories(PRD).filter((s) => /^US-M\d/.test(s.id) || ["US-P3-08", "US-P3-09", "US-P3-10", "US-P3-11"].includes(s.id));
    expect(expected.length).toBeGreaterThan(90);
    const docs = MODULES.map((m) => readFileSync(path.join(ROOT, `docs/uat/${m.file}.md`), "utf8")).join("\n");
    for (const story of expected) {
      expect(docs, story.id).toContain(`### ${story.id} `);
      // Jumlah KP hasil pengurai UAT = jumlah KP versi `pnpm trace` (tidak ada KP yang hilang dari checklist).
      expect(withKp.get(story.id)?.kps.map((k) => k.n), story.id).toEqual(story.kps);
    }
  });

  it("PRD 11.2/11.3 setiap dokumen memuat kelas cacat, catatan cacat, dan templat berita acara bertanda tangan", () => {
    for (const m of MODULES) {
      const doc = readFileSync(path.join(ROOT, `docs/uat/${m.file}.md`), "utf8");
      expect(doc, m.file).toContain("## Kelas cacat (PRD 11.2)");
      expect(doc, m.file).toContain("## Catatan cacat");
      expect(doc, m.file).toContain("BERITA ACARA UJI TERIMA PENGGUNA");
      expect(doc, m.file).toContain("## Item UAT manual");
    }
  });
});
