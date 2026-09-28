import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  computeCoverage,
  extractTestTitles,
  parseCliArgs,
  parseKpNumbers,
  parseModuleNames,
  parsePrdStories,
  parsePriority,
  parseTitleRefs,
  renderConsoleSummary,
  renderMarkdown,
} from "../../tools/trace-check";

const PRD_SAMPLE = `
# Bab 7 — Kebutuhan Produk Tahap 1

## 7.1 M1 — Master Data

### 7.1.4 User story

**US-M1-01 Mengelola pelanggan dan alamat kirim** — M — FR-M1-01, BR-01
Sebagai Dispatcher, saya ingin mencatat pelanggan.

Kriteria penerimaan:
1. Bidang wajib: nama, segmen.
2. Alamat kirim memuat label.
   Baris lanjutan KP-2 (bukan KP baru).
3. Status kredit pelanggan baru = Tunai.

**US-M1-02 Produk & harga** — M (harga) / S (laporan) — FR-M1-02
Kriteria penerimaan:
1. Tiga kelompok produk.
2. Komponen BBM.

### 7.1.5 Aturan
1. Daftar bernomor di luar KP tidak dihitung.

## 7.9 M9 — Laporan & Dashboard Pemilik

**US-M9-06 Tren mingguan** — S, dijadwalkan RL-6 (kompensasi) — FR-M9-06
Kriteria penerimaan:
1. Grafik tren.

# Bab 8 — Tahap 2: Aplikasi Pelanggan

**US-P2-07 Memesan galon antar** — EP-2-07 — C [USULAN; BRD: "bisa ditunda"]
Kriteria penerimaan (garis besar):
1. Bergantung pada FR-M6-08.
2. Bila dibangun: depot terdekat.
`;

describe("trace-check — parser PRD", () => {
  it("membaca ID, judul, prioritas M/S/C, dan jumlah KP (baris lanjutan & daftar di luar KP tidak dihitung)", () => {
    const stories = parsePrdStories(PRD_SAMPLE);
    expect(stories.map((s) => [s.id, s.module, s.priority, s.kps.length])).toEqual([
      ["US-M1-01", "M1", "M", 3],
      ["US-M1-02", "M1", "M", 2],
      ["US-M9-06", "M9", "S", 1],
      ["US-P2-07", "P2", "C", 2],
    ]);
    expect(stories[0]!.title).toBe("Mengelola pelanggan dan alamat kirim");
    expect(stories[1]!.priorityText).toBe("M (harga) / S (laporan)");
  });

  it("prioritas diambil dari segmen pertama berawalan M/S/C (Tahap 2/3 setelah kode epik)", () => {
    expect(parsePriority("— EP-2-01 — M [USULAN]".replace(/^—\s*/, "")).priority).toBe("M");
    expect(parsePriority("FR-M1-01, BR-01").priority).toBeNull();
    expect(parsePriority("S [USULAN, PTB-30], dibangun di RL-6 — BRD 2.3").priority).toBe("S");
  });

  it("nama modul dari judul bab", () => {
    const names = parseModuleNames(PRD_SAMPLE);
    expect(names.get("M1")).toBe("Master Data");
    expect(names.get("M9")).toBe("Laporan & Dashboard Pemilik");
    expect(names.get("P2")).toBe("Tahap 2: Aplikasi Pelanggan");
  });

  it("PRD nyata: 114 user story, semuanya berprioritas dan ber-KP", () => {
    const stories = parsePrdStories(readFileSync("docs/prd/PRD_EQUA_v1_1.md", "utf8"));
    expect(stories).toHaveLength(114);
    expect(stories.every((s) => s.priority !== null && s.kps.length > 0)).toBe(true);
    expect(stories.find((s) => s.id === "US-M1-01")?.kps).toHaveLength(10);
    expect(new Set(stories.map((s) => s.id)).size).toBe(stories.length);
  });
});

describe("trace-check — judul uji", () => {
  it("KP menempel pada US terdekat di kirinya; mendukung KP-1/KP-2, KP-2 & KP-5, daftar koma, dan rentang", () => {
    const refs = parseTitleRefs("US-M4-02 KP-4 menolak … US-M6-02 KP-2 & KP-5, US-M3-04 KP-1/KP-2 US-M8-01 KP-1–3 US-M10-01 lain");
    expect([...refs.get("US-M4-02")!]).toEqual([4]);
    expect([...refs.get("US-M6-02")!].sort()).toEqual([2, 5]);
    expect([...refs.get("US-M3-04")!].sort()).toEqual([1, 2]);
    expect([...refs.get("US-M8-01")!].sort()).toEqual([1, 2, 3]);
    expect(refs.get("US-M10-01")!.size).toBe(0);
    expect(parseKpNumbers(" KP-1, 3 dan KP-7")).toEqual([1, 3, 7]);
    expect(parseTitleRefs("tanpa rujukan KP-1").size).toBe(0);
  });

  it("mengambil judul describe/it/test bersarang (Vitest & Playwright) dan mengabaikan skip/todo/hook", () => {
    const source = `
      import { describe, it, test } from "vitest";
      describe("US-M4-02 penerimaan setoran", () => {
        it("KP-3 selisih dihitung sistem", () => {});
        it.skip("KP-4 dilewati", () => {});
        it.todo("KP-5 belum");
        describe.each([1, 2])("varian %s", () => {
          test(\`KP-6 template \${"x"}\`, () => {});
        });
      });
      test.describe("US-P3-02 POS mitra", () => {
        test.beforeEach(async () => {});
        test("KP-2 data terpisah", async () => {});
      });
      it("tanpa ID", () => {});
    `;
    const titles = extractTestTitles(source, "tests/x.test.ts");
    expect(titles.map((t) => t.title)).toEqual([
      "US-M4-02 penerimaan setoran › KP-3 selisih dihitung sistem",
      'US-M4-02 penerimaan setoran › varian %s › KP-6 template ${"x"}',
      "US-P3-02 POS mitra › KP-2 data terpisah",
      "tanpa ID",
    ]);
    expect(titles[0]!.line).toBe(4);
  });
});

describe("trace-check — cakupan & laporan", () => {
  const stories = parsePrdStories(PRD_SAMPLE);
  const titles = [
    { file: "tests/a.test.ts", line: 1, title: "US-M1-01 KP-1 KP-2 KP-3 lengkap" },
    { file: "tests/a.test.ts", line: 2, title: "US-M1-02 KP-2 sebagian" },
    { file: "tests/a.test.ts", line: 3, title: "US-M9-06 hanya menyebut story" },
    { file: "tests/a.test.ts", line: 4, title: "US-M1-02 KP-9 tidak ada; US-M5-99 tidak dikenal" },
  ];
  const report = computeCoverage(stories, titles, { moduleNames: parseModuleNames(PRD_SAMPLE) });

  it("status lengkap/sebagian/belum per story dan ringkasan prioritas M", () => {
    const status = Object.fromEntries(report.stories.map((c) => [c.story.id, [c.status, c.coveredKps.length, c.testCount]]));
    expect(status).toEqual({
      "US-M1-01": ["lengkap", 3, 1],
      "US-M1-02": ["sebagian", 1, 2],
      "US-M9-06": ["belum", 0, 1],
      "US-P2-07": ["belum", 0, 0],
    });
    expect(report.totalsM).toMatchObject({ stories: 2, lengkap: 1, sebagian: 1, kpTotal: 5, kpCovered: 4, percent: 80 });
    expect(report.totalsAll.kpTotal).toBe(8);
    expect(report.warnings).toHaveLength(2);
  });

  it("laporan markdown ditandai dibangkitkan, per modul, dan deterministik", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("DIBANGKITKAN OTOMATIS oleh `pnpm trace`");
    expect(md).toContain("## M1 — Master Data");
    expect(md).toContain("| US-M1-02 | Produk & harga | M | 1/2 | sebagian | 1 | 2 |");
    expect(md).toContain("## Peringatan");
    expect(renderMarkdown(report)).toBe(md);
    expect(renderConsoleSummary(report)).toContain("Prioritas M     : 4/5 KP (80.0%)");
  });

  it("opsi CLI --fail-under, --out, --no-write; opsi tak dikenal ditolak", () => {
    expect(parseCliArgs([])).toEqual({ failUnder: null, out: "docs/dev/traceability.md", write: true, quiet: false });
    expect(parseCliArgs(["--fail-under=60", "--out=x.md", "--no-write", "--quiet"])).toEqual({
      failUnder: 60,
      out: "x.md",
      write: false,
      quiet: true,
    });
    expect(() => parseCliArgs(["--gagal"])).toThrow(/tidak dikenal/);
  });
});
