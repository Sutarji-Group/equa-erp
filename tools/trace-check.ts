/**
 * `pnpm trace` — ketertelusuran user story / kriteria penerimaan (KP) PRD → uji otomatis (docs/ARCHITECTURE.md §10,
 * DECISIONS D-06 butir 2).
 *
 * 1. Membaca `docs/prd/PRD_EQUA_v1_1.md`: setiap baris judul `**US-M1-01 Judul** — M — …` (atau `— EP-2-01 — M …`
 *    untuk Tahap 2/3) menjadi satu user story dengan prioritas M/S/C (huruf pertama segmen prioritas) dan jumlah KP =
 *    baris bernomor di bawah "Kriteria penerimaan:".
 * 2. Memindai `tests/**\/*.test.ts(x)` dan `e2e/**\/*.spec.ts` (AST TypeScript): judul `describe`/`it`/`test` (termasuk
 *    `test.describe` Playwright; judul describe induk ikut digabung) yang memuat `US-Mx-nn` / `US-Px-nn` dan opsional
 *    `KP-n` (juga `KP-1/KP-2`, `KP-2 & KP-5`, `KP-1–3`). KP menempel pada US terdekat di sebelah kirinya. Uji
 *    `.skip`/`.todo`/`.fixme` tidak dihitung.
 * 3. Menulis `docs/dev/traceability.md` (DIBANGKITKAN — jangan diedit manual) dan mencetak ringkasan ke konsol.
 *
 * Opsi: `--fail-under=<persen>` → keluar dengan kode 1 bila cakupan KP prioritas M < persen (bawaan: tidak pernah
 * gagal); `--out=<berkas>` (bawaan docs/dev/traceability.md); `--no-write` (hanya konsol); `--quiet`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as ts from "typescript";

// =====================================================================================================================
// Tipe
// =====================================================================================================================

export type Priority = "M" | "S" | "C";

export type Story = {
  id: string;
  /** Modul: "M1".."M12", "P2", "P3". */
  module: string;
  title: string;
  /** Prioritas utama (huruf pertama segmen prioritas). */
  priority: Priority | null;
  /** Teks prioritas lengkap, mis. "M (rit gagal; keterangan BR-25) / S (kendala)". */
  priorityText: string;
  /** Nomor KP yang ada (1..n). */
  kps: number[];
  /** Nomor baris (1-based) judul story di PRD. */
  line: number;
};

export type TestTitle = {
  file: string;
  line: number;
  /** Judul lengkap: judul describe induk + judul uji, dipisah " › ". */
  title: string;
};

/** Rujukan dari satu judul: US → himpunan KP (kosong = hanya menyebut story). */
export type TitleRefs = Map<string, Set<number>>;

export type StoryCoverage = {
  story: Story;
  coveredKps: number[];
  missingKps: number[];
  /** Jumlah uji yang merujuk story ini (dengan atau tanpa KP). */
  testCount: number;
  status: "lengkap" | "sebagian" | "belum";
};

export type CoverageTotals = {
  stories: number;
  lengkap: number;
  sebagian: number;
  belum: number;
  kpTotal: number;
  kpCovered: number;
  /** Persen KP tercakup (0–100, 1 desimal). */
  percent: number;
};

export type TraceReport = {
  stories: StoryCoverage[];
  modules: { module: string; name: string; totals: CoverageTotals }[];
  totalsM: CoverageTotals;
  totalsAll: CoverageTotals;
  testFiles: number;
  testTitles: number;
  referencingTitles: number;
  warnings: string[];
};

// =====================================================================================================================
// PRD
// =====================================================================================================================

const STORY_HEADING = /^\*\*(US-(M\d{1,2}|P\d)-\d{2})\s+(.+?)\*\*\s*(.*)$/;
const MODULE_HEADING = /^##\s+7\.\d+\s+(M\d{1,2})\s+—\s+(.+)$/;
const PHASE_HEADING = /^#\s+Bab\s+([89])\s+—\s+(.+)$/;

/** Prioritas dari sisa baris judul: segmen pertama (dipisah " — ") yang diawali M/S/C. */
export function parsePriority(rest: string): { priority: Priority | null; text: string } {
  const segments = rest
    .split(/\s+—\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const segment of segments) {
    const m = /^([MSC])(?=$|[\s,([])/.exec(segment);
    if (m) return { priority: m[1] as Priority, text: segment };
  }
  return { priority: null, text: "" };
}

/** Daftar user story + jumlah KP dari teks PRD. */
export function parsePrdStories(markdown: string): Story[] {
  const lines = markdown.split(/\r?\n/);
  const stories: Story[] = [];
  let current: Story | null = null;
  let inKp = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const heading = STORY_HEADING.exec(line);
    if (heading) {
      const { priority, text } = parsePriority(heading[4]!.replace(/^—\s*/, ""));
      current = {
        id: heading[1]!,
        module: heading[2]!,
        title: heading[3]!.trim(),
        priority,
        priorityText: text,
        kps: [],
        line: i + 1,
      };
      stories.push(current);
      inKp = false;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      current = null;
      inKp = false;
      continue;
    }
    if (!current) continue;
    // "Kriteria penerimaan:" atau "Kriteria penerimaan (garis besar):".
    if (/^Kriteria penerimaan\b[^:]*:\s*$/i.test(line)) {
      inKp = true;
      continue;
    }
    if (!inKp) continue;
    const kp = /^(\d+)\.\s+\S/.exec(line);
    if (kp) {
      const n = Number(kp[1]);
      if (!current.kps.includes(n)) current.kps.push(n);
    }
  }
  return stories;
}

/** Nama modul dari judul bab PRD (M1..M12 dari "## 7.x Mn — Nama", P2/P3 dari "# Bab 8/9 — …"). */
export function parseModuleNames(markdown: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const m = MODULE_HEADING.exec(line);
    if (m) names.set(m[1]!, m[2]!.trim());
    const p = PHASE_HEADING.exec(line);
    if (p) names.set(p[1] === "8" ? "P2" : "P3", p[2]!.trim());
  }
  return names;
}

// =====================================================================================================================
// Judul uji
// =====================================================================================================================

const US_REF = /\bUS-(M\d{1,2}|P\d)-(\d{2})\b/g;
const KP_REF = /\bKP-?\s?(\d+)((?:\s*(?:\/|,|&|–|\.\.)\s*(?:KP-?\s?)?\d+)*)/g;

/** Nomor KP dari satu potongan judul: `KP-1`, `KP-1/KP-2`, `KP-2 & KP-5`, `KP-1, 3`, `KP-1–3`, `KP-1..3`. */
export function parseKpNumbers(segment: string): number[] {
  const out = new Set<number>();
  for (const m of segment.matchAll(KP_REF)) {
    let prev = Number(m[1]);
    out.add(prev);
    const tail = m[2] ?? "";
    for (const part of tail.matchAll(/\s*(\/|,|&|–|\.\.)\s*(?:KP-?\s?)?(\d+)/g)) {
      const n = Number(part[2]);
      if ((part[1] === "–" || part[1] === "..") && n > prev && n - prev <= 50) {
        for (let k = prev + 1; k <= n; k++) out.add(k);
      } else {
        out.add(n);
      }
      prev = n;
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Rujukan US/KP dalam satu judul. KP menempel pada US terdekat di sebelah kirinya. */
export function parseTitleRefs(title: string): TitleRefs {
  const refs: TitleRefs = new Map();
  const matches = [...title.matchAll(US_REF)];
  matches.forEach((m, i) => {
    const id = m[0];
    const start = m.index! + id.length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : title.length;
    const kps = parseKpNumbers(title.slice(start, end));
    const set = refs.get(id) ?? new Set<number>();
    for (const kp of kps) set.add(kp);
    refs.set(id, set);
  });
  return refs;
}

const TEST_BASES = new Set(["describe", "suite", "it", "test"]);
const IGNORED_PROPS = new Set([
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "use",
  "extend",
  "step",
  "info",
  "setTimeout",
  "slow",
  "expect",
  "configure",
  "fail",
]);
const SKIPPED_PROPS = new Set(["skip", "todo", "fixme"]);

function calleeChain(expr: ts.Expression): { base: string | null; props: string[] } {
  const props: string[] = [];
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isIdentifier(cur)) return { base: cur.text, props };
    if (ts.isPropertyAccessExpression(cur)) {
      props.unshift(cur.name.text);
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return { base: null, props };
  }
}

function literalText(node: ts.Expression | undefined, sf: ts.SourceFile): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText(sf).slice(1, -1);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left, sf);
    const right = literalText(node.right, sf);
    return left !== null && right !== null ? left + right : null;
  }
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression, sf);
  return null;
}

/** Judul uji (describe induk digabung) dari satu berkas sumber. */
export function extractTestTitles(source: string, file: string): TestTitle[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: TestTitle[] = [];
  const visit = (node: ts.Node, stack: string[]): void => {
    if (ts.isCallExpression(node)) {
      const { base, props } = calleeChain(node.expression);
      if (base && TEST_BASES.has(base) && !props.some((p) => IGNORED_PROPS.has(p))) {
        const title = literalText(node.arguments[0], sf);
        if (title !== null) {
          const skipped = props.some((p) => SKIPPED_PROPS.has(p));
          const isDescribe = base === "describe" || base === "suite" || props.includes("describe");
          if (isDescribe) {
            if (!skipped) for (const arg of node.arguments.slice(1)) visit(arg, [...stack, title]);
            return;
          }
          if (!skipped) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            out.push({ file, line: line + 1, title: [...stack, title].join(" › ") });
          }
          return;
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, stack));
  };
  visit(sf, []);
  return out;
}

/** Berkas uji: `tests/**\/*.test.ts(x)` dan `e2e/**\/*.spec.ts` (relatif terhadap `root`, terurut). */
export function listTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, pattern: RegExp) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, pattern);
      else if (pattern.test(entry)) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(root, "tests"), /\.test\.tsx?$/);
  walk(path.join(root, "e2e"), /\.spec\.ts$/);
  return out;
}

// =====================================================================================================================
// Cakupan
// =====================================================================================================================

function totalsOf(items: StoryCoverage[]): CoverageTotals {
  const kpTotal = items.reduce((s, c) => s + c.story.kps.length, 0);
  const kpCovered = items.reduce((s, c) => s + c.coveredKps.length, 0);
  return {
    stories: items.length,
    lengkap: items.filter((c) => c.status === "lengkap").length,
    sebagian: items.filter((c) => c.status === "sebagian").length,
    belum: items.filter((c) => c.status === "belum").length,
    kpTotal,
    kpCovered,
    percent: kpTotal === 0 ? 0 : Math.round((kpCovered / kpTotal) * 1000) / 10,
  };
}

/** Gabungkan story PRD dengan judul uji menjadi laporan cakupan. */
export function computeCoverage(
  stories: Story[],
  titles: TestTitle[],
  opts: { moduleNames?: Map<string, string>; testFiles?: number } = {},
): TraceReport {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const covered = new Map<string, Set<number>>();
  const testCount = new Map<string, number>();
  const warnings = new Set<string>();
  let referencing = 0;
  for (const t of titles) {
    const refs = parseTitleRefs(t.title);
    if (refs.size === 0) continue;
    referencing++;
    for (const [id, kps] of refs) {
      const story = byId.get(id);
      if (!story) {
        warnings.add(`${t.file}:${t.line} merujuk ${id} yang tidak ada di PRD.`);
        continue;
      }
      testCount.set(id, (testCount.get(id) ?? 0) + 1);
      const set = covered.get(id) ?? new Set<number>();
      for (const kp of kps) {
        if (story.kps.includes(kp)) set.add(kp);
        else warnings.add(`${t.file}:${t.line} merujuk ${id} KP-${kp}, padahal ${id} hanya punya ${story.kps.length} KP.`);
      }
      covered.set(id, set);
    }
  }
  const coverage: StoryCoverage[] = stories.map((story) => {
    const coveredKps = [...(covered.get(story.id) ?? [])].sort((a, b) => a - b);
    const missingKps = story.kps.filter((k) => !coveredKps.includes(k));
    const status: StoryCoverage["status"] =
      story.kps.length > 0 && missingKps.length === 0 ? "lengkap" : coveredKps.length > 0 ? "sebagian" : "belum";
    return { story, coveredKps, missingKps, testCount: testCount.get(story.id) ?? 0, status };
  });
  const moduleOrder = [...new Set(stories.map((s) => s.module))].sort(compareModules);
  const modules = moduleOrder.map((module) => ({
    module,
    name: opts.moduleNames?.get(module) ?? module,
    totals: totalsOf(coverage.filter((c) => c.story.module === module)),
  }));
  return {
    stories: coverage,
    modules,
    totalsM: totalsOf(coverage.filter((c) => c.story.priority === "M")),
    totalsAll: totalsOf(coverage),
    testFiles: opts.testFiles ?? new Set(titles.map((t) => t.file)).size,
    testTitles: titles.length,
    referencingTitles: referencing,
    warnings: [...warnings].sort(),
  };
}

function compareModules(a: string, b: string): number {
  const key = (m: string) => (m.startsWith("M") ? 0 : 100) + Number(m.slice(1));
  return key(a) - key(b);
}

// =====================================================================================================================
// Keluaran
// =====================================================================================================================

const STATUS_LABEL: Record<StoryCoverage["status"], string> = {
  lengkap: "lengkap",
  sebagian: "sebagian",
  belum: "belum",
};

function fmtTotals(t: CoverageTotals): string {
  return `${t.kpCovered}/${t.kpTotal} KP (${t.percent.toFixed(1)}%) · story: ${t.lengkap} lengkap, ${t.sebagian} sebagian, ${t.belum} belum`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Markdown laporan (deterministik — tanpa cap waktu, agar diff hanya berubah bila cakupan berubah). */
export function renderMarkdown(report: TraceReport): string {
  const out: string[] = [];
  out.push("# Ketertelusuran user story → uji otomatis");
  out.push("");
  out.push("> **DIBANGKITKAN OTOMATIS oleh `pnpm trace` (tools/trace-check.ts) — jangan diedit manual.**");
  out.push("> Sumber: `docs/prd/PRD_EQUA_v1_1.md` (KP = baris bernomor di bawah \"Kriteria penerimaan:\") dan judul");
  out.push("> `describe`/`it`/`test` di `tests/**/*.test.ts(x)` + `e2e/**/*.spec.ts` yang memuat `US-Mx-nn` dan `KP-n`.");
  out.push("");
  out.push("## Ringkasan");
  out.push("");
  out.push(`- **Prioritas M:** ${fmtTotals(report.totalsM)}`);
  out.push(`- **Semua prioritas:** ${fmtTotals(report.totalsAll)}`);
  out.push(
    `- Uji dipindai: ${report.testTitles} judul di ${report.testFiles} berkas; ${report.referencingTitles} judul merujuk user story.`,
  );
  out.push("");
  out.push("| Modul | Story | Lengkap | Sebagian | Belum | KP tercakup | % |");
  out.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const m of report.modules) {
    const t = m.totals;
    out.push(
      `| ${m.module} — ${escapeCell(m.name)} | ${t.stories} | ${t.lengkap} | ${t.sebagian} | ${t.belum} | ${t.kpCovered}/${t.kpTotal} | ${t.percent.toFixed(1)} |`,
    );
  }
  out.push("");
  out.push("Status: **lengkap** = semua KP punya uji; **sebagian** = sebagian KP punya uji; **belum** = belum ada KP yang teruji");
  out.push("(kolom *Uji* tetap menghitung uji yang hanya menyebut ID story tanpa KP).");
  for (const m of report.modules) {
    out.push("");
    out.push(`## ${m.module} — ${m.name}`);
    out.push("");
    out.push(`${fmtTotals(m.totals)}`);
    out.push("");
    out.push("| US | Judul | Prio | KP tercakup | Status | KP belum teruji | Uji |");
    out.push("|---|---|:-:|---:|---|---|---:|");
    for (const c of report.stories.filter((s) => s.story.module === m.module)) {
      const s = c.story;
      out.push(
        `| ${s.id} | ${escapeCell(s.title)} | ${s.priority ?? "?"} | ${c.coveredKps.length}/${s.kps.length} | ${STATUS_LABEL[c.status]} | ${
          c.missingKps.length ? c.missingKps.join(", ") : "—"
        } | ${c.testCount} |`,
      );
    }
  }
  if (report.warnings.length) {
    out.push("");
    out.push("## Peringatan");
    out.push("");
    for (const w of report.warnings) out.push(`- ${w}`);
  }
  out.push("");
  return out.join("\n");
}

/** Ringkasan singkat untuk konsol. */
export function renderConsoleSummary(report: TraceReport): string {
  const lines = [
    "Ketertelusuran US/KP → uji",
    `  Prioritas M     : ${fmtTotals(report.totalsM)}`,
    `  Semua prioritas : ${fmtTotals(report.totalsAll)}`,
    `  Judul uji       : ${report.testTitles} (${report.referencingTitles} merujuk US) di ${report.testFiles} berkas`,
    "  Per modul (KP tercakup):",
    ...report.modules.map(
      (m) => `    ${m.module.padEnd(4)} ${`${m.totals.kpCovered}/${m.totals.kpTotal}`.padStart(9)}  ${m.totals.percent.toFixed(1).padStart(5)}%  ${m.name}`,
    ),
  ];
  if (report.warnings.length) lines.push(`  Peringatan      : ${report.warnings.length} (lihat laporan)`);
  return lines.join("\n");
}

// =====================================================================================================================
// CLI
// =====================================================================================================================

export type CliOptions = { failUnder: number | null; out: string; write: boolean; quiet: boolean };

export function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { failUnder: null, out: "docs/dev/traceability.md", write: true, quiet: false };
  for (const arg of argv) {
    const fail = /^--fail-under=(\d+(?:\.\d+)?)$/.exec(arg);
    if (fail) opts.failUnder = Number(fail[1]);
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg === "--no-write") opts.write = false;
    else if (arg === "--quiet") opts.quiet = true;
    else throw new Error(`Opsi tidak dikenal: ${arg}. Pakai --fail-under=<persen>, --out=<berkas>, --no-write, --quiet.`);
  }
  return opts;
}

/** Bangun laporan dari berkas proyek di `root`. */
export function buildReport(root: string, prdPath = "docs/prd/PRD_EQUA_v1_1.md"): TraceReport {
  const prd = readFileSync(path.join(root, prdPath), "utf8");
  const stories = parsePrdStories(prd);
  const files = listTestFiles(root);
  const titles = files.flatMap((f) => extractTestTitles(readFileSync(path.join(root, f), "utf8"), f));
  return computeCoverage(stories, titles, { moduleNames: parseModuleNames(prd), testFiles: files.length });
}

export function main(argv: string[], root = process.cwd()): number {
  const opts = parseCliArgs(argv);
  const report = buildReport(root);
  if (opts.write) writeFileSync(path.join(root, opts.out), renderMarkdown(report));
  if (!opts.quiet) {
    console.log(renderConsoleSummary(report));
    if (opts.write) console.log(`Laporan: ${opts.out}`);
  }
  if (opts.failUnder !== null && report.totalsM.percent < opts.failUnder) {
    console.error(
      `Cakupan KP prioritas M ${report.totalsM.percent.toFixed(1)}% di bawah ambang ${opts.failUnder}% (--fail-under).`,
    );
    return 1;
  }
  return 0;
}

const invokedDirectly = /trace-check\.[cm]?[jt]s$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
