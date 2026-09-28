/**
 * M11 — pembaca template impor (bagan akun K9, daftar aset K15/NFR-34): CSV (papaparse) atau Excel (exceljs). Baris
 * pertama = judul kolom; judul dikenali tanpa membedakan huruf besar/kecil dan spasi. Murni (tanpa DB).
 */
import * as ExcelJSNs from "exceljs";
import Papa from "papaparse";

import { isBusinessDate } from "@/lib/time";

import { DomainError } from "@/server/core/errors";

const ExcelJS = ((ExcelJSNs as unknown as { default?: typeof ExcelJSNs }).default ?? ExcelJSNs) as typeof ExcelJSNs;

export type ParsedTable = { headers: string[]; rows: Record<string, string>[] };

export function normHeader(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.result !== undefined) return cellText(o.result);
    if (o.text !== undefined) return String(o.text);
  }
  return String(v).trim();
}

/** Baca CSV/XLSX → baris objek (kunci = judul kolom yang dinormalkan). */
export async function parseTable(fileName: string, content: Buffer | string): Promise<ParsedTable> {
  const lower = fileName.toLowerCase();
  let matrix: string[][] = [];
  if (lower.endsWith(".xlsx")) {
    const wb = new ExcelJS.Workbook();
    const buf = typeof content === "string" ? Buffer.from(content) : content;
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new DomainError("IMPORT_EMPTY", "Berkas Excel tidak berisi lembar kerja.");
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      matrix.push(values.map(cellText));
    });
  } else if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const text = typeof content === "string" ? content : content.toString("utf8");
    const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: true, delimiter: "" });
    matrix = parsed.data.map((r) => r.map((c) => String(c ?? "").trim()));
  } else {
    throw new DomainError("IMPORT_FORMAT", "Format berkas harus CSV atau Excel (.xlsx) sesuai template.");
  }
  if (matrix.length < 2) throw new DomainError("IMPORT_EMPTY", "Berkas kosong atau hanya berisi judul kolom.");
  const headers = matrix[0]!.map(normHeader);
  const rows = matrix.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = cells[i] ?? "";
    });
    return obj;
  });
  return { headers, rows: rows.filter((r) => Object.values(r).some((v) => v !== "")) };
}

/** Ambil nilai kolom dari beberapa kemungkinan judul. */
export function pick(row: Record<string, string>, names: readonly string[]): string {
  for (const n of names) {
    const v = row[normHeader(n)];
    if (v !== undefined && v !== "") return v.trim();
  }
  return "";
}

/** Angka rupiah dari teks ("1.500.000", "Rp 1.500.000", "1500000"). */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/^rp\s*/i, "").replace(/\s/g, "");
  if (!s) return null;
  const cleaned = s.includes(",") && s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/\./g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Tanggal: YYYY-MM-DD atau DD/MM/YYYY. */
export function parseDateText(raw: string): string | null {
  const s = raw.trim();
  let out: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) out = s.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) out = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return out && isBusinessDate(out) ? out : null;
}

export function parseBool(raw: string): boolean {
  return ["ya", "y", "yes", "true", "1", "benar"].includes(raw.trim().toLowerCase());
}
