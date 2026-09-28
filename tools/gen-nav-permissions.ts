/**
 * Bangkitkan bagian otomatis `docs/nav-permissions.md` dari registri navigasi.
 * Pakai: `pnpm tsx tools/gen-nav-permissions.ts` (menulis ulang blok di antara penanda AUTO).
 * Uji `tests/ui/nav-registry.test.ts` memastikan dokumen selalu memuat semua izin registri.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { NAV_GROUPS, navPermissions } from "../src/components/shared/nav/registry";

const DOC = resolve(__dirname, "../docs/nav-permissions.md");
const BEGIN = "<!-- BEGIN:AUTO nav-permissions -->";
const END = "<!-- END:AUTO nav-permissions -->";

function buildBlock(): string {
  const lines: string[] = [BEGIN, "", "### Daftar izin unik", "", "```text", ...navPermissions(), "```", "", "### Rute → izin", ""];
  lines.push("| Grup | Rute | Label | Izin | Catatan |", "|---|---|---|---|---|");
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const perm =
        item.permission === null
          ? "_(semua pengguna web kantor)_"
          : (typeof item.permission === "string" ? [item.permission] : item.permission).map((p) => `\`${p}\``).join(" / ");
      const notes = [item.hidden ? "tidak tampil di sidebar" : "", item.badgeKey ? `lencana \`${item.badgeKey}\`` : "", item.flag ? `flag \`${item.flag}\`` : ""]
        .filter(Boolean)
        .join("; ");
      lines.push(`| ${group.label} | \`${item.href}\` | ${item.label} | ${perm} | ${notes} |`);
    }
  }
  lines.push("", END);
  return lines.join("\n");
}

function main() {
  const current = readFileSync(DOC, "utf8");
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < 0) throw new Error("Penanda AUTO tidak ditemukan di docs/nav-permissions.md");
  const next = current.slice(0, start) + buildBlock() + current.slice(end + END.length);
  writeFileSync(DOC, next);
  console.log(`docs/nav-permissions.md diperbarui (${navPermissions().length} izin).`);
}

main();
