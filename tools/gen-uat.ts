/**
 * `pnpm uat:gen` — bangkitkan dokumen UAT per modul `docs/uat/<modul>.md` (PRD 11.3) dari PRD
 * (`docs/prd/PRD_EQUA_v1_1.md`: judul user story, prioritas, teks KP apa adanya) + konfigurasi `tools/uat-config.ts`
 * (pemilik modul, skenario BRD, data uji, langkah di layar nyata, item UAT manual). Setiap berkas memuat checklist
 * lulus/gagal per KP, daftar cacat, kelas cacat (PRD 11.2), dan templat berita acara (PRD 11.3).
 *
 * `pnpm uat:gen -- --check` → keluar 1 bila berkas di disk tidak sama dengan hasil bangkitan (dipakai uji).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MODULES, type ModuleUat } from "./uat-config";

export type PrdStory = { id: string; title: string; priorityText: string; kps: { n: number; text: string }[]; line: number };

const STORY_HEADING = /^\*\*(US-(M\d{1,2}|P\d)-\d{2})\s+(.+?)\*\*\s*(.*)$/;

/** Segmen prioritas setelah judul (sampai " — " pertama di luar tanda kurung), mis. "M (KP-1–2: …)". */
function prioritySegment(rest: string): string {
  const segments = rest.split(" — ");
  let out = segments[0] ?? "";
  let i = 1;
  const open = (s: string) => (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;
  while (open(out) > 0 && i < segments.length) out += ` — ${segments[i++]}`;
  return out.trim();
}

/** User story + teks KP (baris bernomor setelah "Kriteria penerimaan:"; baris lanjutan digabung). */
export function parseStoriesWithKp(markdown: string): PrdStory[] {
  const lines = markdown.split(/\r?\n/);
  const out: PrdStory[] = [];
  let current: PrdStory | null = null;
  let inKp = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const heading = STORY_HEADING.exec(line);
    if (heading) {
      const rest = heading[4]!.replace(/^—\s*/, "");
      current = { id: heading[1]!, title: heading[3]!.trim(), priorityText: prioritySegment(rest), kps: [], line: i + 1 };
      out.push(current);
      inKp = false;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      current = null;
      inKp = false;
      continue;
    }
    if (!current) continue;
    if (/^Kriteria penerimaan\b[^:]*:\s*$/i.test(line)) {
      inKp = true;
      continue;
    }
    if (!inKp) continue;
    const kp = /^(\d+)\.\s+(.*)$/.exec(line);
    if (kp) {
      current.kps.push({ n: Number(kp[1]), text: kp[2]!.trim() });
    } else if (line && current.kps.length > 0 && !/^\*\*/.test(line)) {
      current.kps[current.kps.length - 1]!.text += ` ${line}`;
    } else if (!line && current.kps.length > 0) {
      inKp = false;
    }
  }
  return out;
}

const DEFECT_CLASSES = `| Kelas | Definisi | Konsekuensi |
|---|---|---|
| **Kritis** | Transaksi tidak dapat dicatat, hilang, dobel, atau dapat diubah tanpa jejak; kebocoran data lintas peran/tenant; salah hitung uang | Menahan rilis; ditanggapi ≤ 30 menit setelah go-live (NFR-31) |
| **Mayor** | Fungsi M tidak bekerja sesuai KP tetapi ada jalan lain berjejak | Menahan rilis kecuali komite pengarah menerima dengan tenggat perbaikan |
| **Minor** | Ketidaknyamanan, teks, tampilan | Masuk backlog; tidak menahan rilis |

User story **lulus** bila seluruh KP dijawab "lulus" oleh pemilik modul pada UAT dengan data nyata dan cacat tersisa bukan
Kritis/Mayor. User story prioritas M yang tidak lulus menahan rilis (PRD 11.2).`;

function beritaAcara(m: ModuleUat, storyIds: string[]): string {
  return `**BERITA ACARA UJI TERIMA PENGGUNA (UAT) — ${m.module === "P3" ? "RL-7" : m.module} ${m.title}**

| | |
|---|---|
| Rilis / versi aplikasi | RL-____ / v______ |
| Tanggal & tempat UAT | ____ / ____ 20__ · __________ |
| Lingkungan | ☐ Uji (Preview + branch Neon) ☐ Pilot (produksi) |
| Pemilik modul | ${m.owner} — nama: ______________________ |
| Peserta | ______________________ (tim IT) · ______________________ (juara lapangan/akuntan) |
| Skenario BRD | ${m.scenario} |
| Data uji | ${m.data} |

| User story | Prioritas | KP lulus / total | Status (Lulus / Gagal / Lulus bersyarat) |
|---|:-:|:-:|---|
${storyIds.map((id) => `| ${id} |  | __ / __ |  |`).join("\n")}

Cacat terbuka: Kritis ___ · Mayor ___ · Minor ___ (rincian di tabel "Catatan cacat").

Keputusan: ☐ **Diterima** ☐ **Diterima bersyarat** (cacat Mayor dengan tenggat: ________) ☐ **Ditolak** (uji ulang tanggal ______)

| Pemilik modul | Manajer proyek IT | Saksi (juara lapangan / akuntan) |
|---|---|---|
| <br><br>(____________________) | <br><br>(____________________) | <br><br>(____________________) |`;
}

/** Konten Markdown satu dokumen UAT modul. */
export function renderModuleUat(m: ModuleUat, stories: PrdStory[]): string {
  const mine = stories.filter((s) => s.id.startsWith(m.prefix) && (!m.only || m.only.includes(s.id)));
  const missingSteps = mine.filter((s) => !m.steps[s.id]).map((s) => s.id);
  if (missingSteps.length) throw new Error(`uat-config ${m.file}: langkah belum ada untuk ${missingSteps.join(", ")}`);
  const kpTotal = mine.reduce((n, s) => n + s.kps.length, 0);
  const parts: string[] = [];
  parts.push(`# UAT ${m.module === "P3" ? "RL-7" : m.module} — ${m.title}

> **Dibangkitkan \`pnpm uat:gen\`** (\`tools/gen-uat.ts\` + \`tools/uat-config.ts\`) dari PRD v1.1 — teks KP dikutip apa adanya
> dari PRD. Jangan edit berkas ini; ubah konfigurasi lalu bangkitkan ulang. Indeks & cara kerja UAT:
> [\`docs/uat/README.md\`](README.md).

| | |
|---|---|
| Pemilik modul (BRD 12.1) | ${m.owner} |
| Skenario BRD | ${m.scenario} |
| User story diuji (PRD 11.3) | ${m.stories} |
| Data uji | ${m.data} |
| Akun uji | ${m.accounts} |
| Panduan pengguna | \`${m.guide}\` |
| Jumlah | ${mine.length} user story · ${kpTotal} KP |

## Persiapan

${m.setup.map((s) => `- [ ] ${s}`).join("\n")}
- [ ] Uji otomatis modul hijau (\`pnpm test\`; cakupan KP di \`docs/dev/traceability.md\`) — UAT memverifikasi perilaku di layar nyata dengan data nyata, bukan mengulang uji otomatis.

Cara mengisi: centang **Lulus** atau **Gagal** per KP; setiap Gagal dicatat di tabel **Catatan cacat** beserta kelasnya.`);

  parts.push("## Checklist user story & kriteria penerimaan");
  for (const s of mine) {
    const cfg = m.steps[s.id]!;
    const lines = [
      `### ${s.id} ${s.title} — ${s.priorityText}`,
      "",
      `**Layar:** ${cfg.screen}  `,
      `**Rujukan PRD:** baris ${s.line}`,
      "",
      "**Langkah uji:**",
      ...cfg.steps.map((st, i) => `${i + 1}. ${st}`),
      "",
      "| KP | Kriteria penerimaan (PRD) | Lulus | Gagal | Catatan / no. cacat |",
      "|:-:|---|:-:|:-:|---|",
      ...s.kps.map((kp) => `| ${kp.n} | ${kp.text.replace(/\|/g, "\\|")} | ☐ | ☐ |  |`),
    ];
    parts.push(lines.join("\n"));
  }

  parts.push(`## Item UAT manual (tidak dapat diotomasi — backlog & NFR)

| Rujukan | Uji | Lulus | Gagal | Catatan |
|---|---|:-:|:-:|---|
${m.manual.map((x) => `| ${x.ref} | ${x.text.replace(/\|/g, "\\|")} | ☐ | ☐ |  |`).join("\n")}`);

  parts.push(`## Catatan cacat

| No | US / KP | Uraian & langkah mereproduksi | Kelas | Penanggung jawab | Tenggat | Status |
|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |`);

  parts.push(`## Kelas cacat (PRD 11.2)

${DEFECT_CLASSES}`);

  parts.push(`## Berita acara (PRD 11.3)

${beritaAcara(m, mine.map((s) => s.id))}`);

  return `${parts.join("\n\n")}\n`;
}

/** Semua dokumen UAT modul: `{ jalur relatif → isi }`. */
export function renderAllUat(root: string = process.cwd()): Map<string, string> {
  const prd = readFileSync(path.join(root, "docs/prd/PRD_EQUA_v1_1.md"), "utf8");
  const stories = parseStoriesWithKp(prd);
  const out = new Map<string, string>();
  for (const m of MODULES) out.set(`docs/uat/${m.file}.md`, renderModuleUat(m, stories));
  return out;
}

function main(argv: string[]): number {
  const root = process.cwd();
  const check = argv.includes("--check");
  const files = renderAllUat(root);
  const stale: string[] = [];
  for (const [rel, content] of files) {
    const abs = path.join(root, rel);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (current === content) continue;
    if (check) stale.push(rel);
    else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      console.log(`ditulis ${rel}`);
    }
  }
  if (check && stale.length) {
    console.error(`Dokumen UAT tidak mutakhir — jalankan \`pnpm uat:gen\`:\n${stale.join("\n")}`);
    return 1;
  }
  if (!check) console.log(`${files.size} dokumen UAT modul mutakhir.`);
  return 0;
}

const invokedDirectly = /gen-uat\.[cm]?[jt]s$/.test(process.argv[1] ?? "");
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
