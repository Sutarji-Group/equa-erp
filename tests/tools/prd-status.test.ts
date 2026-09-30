import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildReport, parsePrdStories } from "../../tools/trace-check";

const ROOT = process.cwd();
const PRD = readFileSync(path.join(ROOT, "docs/prd/PRD_EQUA_v1_1.md"), "utf8");
const STATUS = readFileSync(path.join(ROOT, "docs/prd/status.md"), "utf8");

type StatusRow = { id: string; title: string; priority: string; kp: string; status: string; note: string };

/** Baris tabel status per user story: `| US-xx-nn | judul | prio | x/y | status | catatan |`. */
function statusRows(): StatusRow[] {
  return STATUS.split("\n")
    .filter((l) => /^\| US-(M\d{1,2}|P\d)-\d{2} \|/.test(l))
    .map((l) => {
      const cells = l.split("|").slice(1, -1).map((c) => c.trim());
      return { id: cells[0]!, title: cells[1]!, priority: cells[2]!, kp: cells[3]!, status: cells[4]!, note: cells[5] ?? "" };
    });
}

const STATUSES = ["Aktif", "Aktif — flag", "Di balik flag", "Tidak dibangun"];
const PHASE3_FLAGGED = ["US-P3-01", "US-P3-02", "US-P3-03", "US-P3-04", "US-P3-05", "US-P3-06", "US-P3-07"];

describe("status implementasi docs/prd/status.md (S5-C)", () => {
  const report = buildReport(ROOT);

  it("D-02 setiap user story PRD (M1–M12, P2, P3) tercantum tepat satu kali dengan judul, prioritas, dan KP teruji sesuai pnpm trace", () => {
    const rows = statusRows();
    const stories = parsePrdStories(PRD);
    expect(stories.length).toBeGreaterThan(100);
    expect(rows.map((r) => r.id).sort()).toEqual(stories.map((s) => s.id).sort());
    const byId = new Map(report.stories.map((c) => [c.story.id, c]));
    for (const row of rows) {
      const cov = byId.get(row.id)!;
      expect(row.title, row.id).toBe(cov.story.title);
      expect(row.priority, row.id).toBe(cov.story.priority);
      expect(row.kp, `${row.id}: jalankan pnpm trace lalu perbarui docs/prd/status.md`).toBe(
        `${cov.coveredKps.length}/${cov.story.kps.length}`,
      );
      expect(STATUSES, row.id).toContain(row.status);
    }
  });

  it("D-02 status rilis mengikuti cakupan: C tidak dibangun, P2 & Tahap 3 (US-P3-01..07) di balik flag, RL-7 aktif", () => {
    for (const row of statusRows()) {
      if (row.priority === "C") expect(row.status, row.id).toBe("Tidak dibangun");
      else if (row.id.startsWith("US-P2-") || PHASE3_FLAGGED.includes(row.id)) expect(row.status, row.id).toBe("Di balik flag");
      else expect(row.status, row.id).toMatch(/^Aktif/);
      if (row.status === "Aktif — flag") expect(row.note, `${row.id}: sebutkan flag/parameternya`).not.toBe("");
    }
  });

  it("D-06 ringkasan per modul dan jumlah KP sama dengan hasil pnpm trace", () => {
    for (const m of report.modules) {
      const line = STATUS.split("\n").find((l) => l.startsWith(`| ${m.module} — `));
      expect(line, `baris ringkasan ${m.module}`).toBeDefined();
      expect(line, m.module).toContain(`| ${m.totals.stories} |`);
      expect(line, m.module).toContain(`| ${m.totals.kpCovered}/${m.totals.kpTotal} |`);
    }
    expect(STATUS).toContain(`| **Jumlah** | **${report.totalsAll.stories}** | | **${report.totalsAll.kpCovered}/${report.totalsAll.kpTotal}** |`);
    expect(STATUS).toContain(`${report.totalsM.kpCovered}/${report.totalsM.kpTotal} KP teruji`);
  });

  it("PRD Bab 13 & Lampiran D status seluruh PTB-01..62 dan CR-01..18 tercatat tepat satu kali", () => {
    const ptb = [...STATUS.matchAll(/^\| (PTB-\d{2}) \|/gm)].map((m) => m[1]);
    const cr = [...STATUS.matchAll(/^\| (CR-\d{2}) \|/gm)].map((m) => m[1]);
    const expectedPtb = [...PRD.matchAll(/^\| (PTB-\d{2}) \|/gm)].map((m) => m[1]);
    const expectedCr = [...PRD.matchAll(/^\| (CR-\d{2}) \|/gm)].map((m) => m[1]);
    expect(expectedPtb).toHaveLength(62);
    expect(expectedCr).toHaveLength(18);
    expect(ptb).toEqual(expectedPtb);
    expect(cr).toEqual(expectedCr);
  });
});
