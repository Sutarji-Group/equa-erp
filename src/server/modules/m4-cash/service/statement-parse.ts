/**
 * M4 — pembaca berkas mutasi bank (US-M4-04 KP-3, S; NFR-22): CSV (papaparse) atau Excel (exceljs) hasil unduhan
 * internet banking. Kolom dikenali dari judulnya (Bahasa Indonesia/Inggris): tanggal, keterangan, jumlah (atau kolom
 * kredit/debit terpisah, atau akhiran CR/DB), saldo, referensi. Hasil: baris bertanda (kredit/masuk positif).
 *
 * Murni (tanpa DB) — diuji langsung di tests/m4-cash.
 */
import { createHash } from "node:crypto";

import * as ExcelJSNs from "exceljs";
import Papa from "papaparse";

import { isBusinessDate } from "@/lib/time";

const ExcelJS = ((ExcelJSNs as unknown as { default?: typeof ExcelJSNs }).default ?? ExcelJSNs) as typeof ExcelJSNs;

export type ParsedStatementLine = {
  lineDate: string;
  description: string | null;
  /** Kredit (masuk) positif, debit (keluar) negatif. */
  amount: number;
  balance: number | null;
  reference: string | null;
  /** Hash isi baris + urutan kemunculan (baris identik di hari yang sama tetap dibedakan). */
  rowHash: string;
};

export type ParsedStatement = { lines: ParsedStatementLine[]; skipped: number; periodStart: string | null; periodEnd: string | null };

const HEADERS = {
  date: ["tanggal", "tgl", "date", "tanggal transaksi", "tgl transaksi", "posting date", "transaction date", "tanggal mutasi"],
  description: ["keterangan", "deskripsi", "description", "uraian", "remark", "remarks", "berita", "keterangan transaksi"],
  amount: ["jumlah", "amount", "nominal", "mutasi", "nilai"],
  credit: ["kredit", "credit", "cr", "masuk", "uang masuk"],
  debit: ["debit", "debet", "db", "keluar", "uang keluar"],
  balance: ["saldo", "balance", "saldo akhir"],
  reference: ["referensi", "reference", "ref", "no. referensi", "no referensi", "no. ref", "cabang"],
} as const;

type ColumnMap = Partial<Record<keyof typeof HEADERS, number>>;

function norm(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function mapHeader(cells: readonly unknown[]): ColumnMap {
  const map: ColumnMap = {};
  cells.forEach((cell, i) => {
    const h = norm(cell);
    if (!h) return;
    for (const [key, names] of Object.entries(HEADERS) as [keyof typeof HEADERS, readonly string[]][]) {
      if (map[key] === undefined && names.includes(h)) map[key] = i;
    }
  });
  return map;
}

function usable(map: ColumnMap): boolean {
  return map.date !== undefined && (map.amount !== undefined || map.credit !== undefined || map.debit !== undefined);
}

/** Angka rupiah dari teks bank: "1.500.000", "1,500,000.00", "Rp 1.500.000,00", "250.000 CR", "(5.000)", "-5000". */
export function parseBankAmount(raw: unknown): { value: number; sign: 1 | -1 | 0 } | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: Math.round(Math.abs(raw)), sign: raw < 0 ? -1 : 0 } : null;
  let s = String(raw ?? "").trim();
  if (!s) return null;
  let sign: 1 | -1 | 0 = 0;
  if (/CR\s*$/i.test(s)) {
    sign = 1;
    s = s.replace(/\s*CR\s*$/i, "");
  } else if (/DB\s*$/i.test(s)) {
    sign = -1;
    s = s.replace(/\s*DB\s*$/i, "");
  }
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  s = s.replace(/rp\.?/i, "").replace(/\s/g, "");
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  if (!/^[0-9.,]+$/.test(s)) return null;
  const value = parseSeparatedNumber(s);
  if (value === null) return null;
  return { value: Math.round(value), sign };
}

/** "1.500.000" / "1,500,000.00" / "1500,00" / "1.500" → angka (pemisah desimal = pemisah terakhir diikuti 1–2 digit). */
function parseSeparatedNumber(s: string): number | null {
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  let intPart = s;
  let frac = "";
  if (hasDot && hasComma) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const idx = s.lastIndexOf(dec);
    intPart = s.slice(0, idx);
    frac = s.slice(idx + 1);
  } else if (hasDot || hasComma) {
    const sep = hasDot ? "." : ",";
    const parts = s.split(sep);
    const last = parts[parts.length - 1]!;
    if (parts.length === 2 && last.length !== 3) {
      intPart = parts[0]!;
      frac = last;
    }
  }
  const digits = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits) || !/^\d*$/.test(frac)) return null;
  const value = Number(digits) + (frac ? Number(`0.${frac}`) : 0);
  return Number.isFinite(value) ? value : null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };

/** Tanggal mutasi → YYYY-MM-DD. `year` bawaan untuk format tanpa tahun (mis. "28/09" BCA). */
export function parseBankDate(raw: unknown, year?: number): string | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return `${raw.getUTCFullYear()}-${String(raw.getUTCMonth() + 1).padStart(2, "0")}-${String(raw.getUTCDate()).padStart(2, "0")}`;
  }
  const s = String(raw ?? "").trim().replace(/^'/, "");
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return isBusinessDate(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(s);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year;
    if (!y) return null;
    const d = `${y}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
    return isBusinessDate(d) ? d : null;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2]!.toLowerCase()];
    if (!mo) return null;
    const d = `${m[3]}-${String(mo).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
    return isBusinessDate(d) ? d : null;
  }
  return null;
}

function toLines(rows: readonly (readonly unknown[])[], opts: { year?: number }): ParsedStatement {
  let headerIndex = -1;
  let map: ColumnMap = {};
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const m = mapHeader(rows[i]!);
    if (usable(m)) {
      headerIndex = i;
      map = m;
      break;
    }
  }
  if (headerIndex < 0) {
    throw new Error("Kolom mutasi tidak dikenali. Pastikan baris judul memuat Tanggal, Keterangan, dan Jumlah (atau Kredit/Debit).");
  }
  const lines: ParsedStatementLine[] = [];
  const seen = new Map<string, number>();
  let skipped = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    const date = parseBankDate(row[map.date!], opts.year);
    let amount: number | null = null;
    if (map.credit !== undefined || map.debit !== undefined) {
      const cr = map.credit !== undefined ? parseBankAmount(row[map.credit]) : null;
      const db = map.debit !== undefined ? parseBankAmount(row[map.debit]) : null;
      if (cr && cr.value) amount = cr.value;
      else if (db && db.value) amount = -db.value;
    }
    if (amount === null && map.amount !== undefined) {
      const a = parseBankAmount(row[map.amount]);
      if (a && a.value) amount = a.sign === -1 ? -a.value : a.value;
    }
    if (!date || amount === null) {
      skipped++;
      continue;
    }
    const description = map.description !== undefined ? String(row[map.description] ?? "").trim() || null : null;
    const bal = map.balance !== undefined ? parseBankAmount(row[map.balance]) : null;
    const reference = map.reference !== undefined ? String(row[map.reference] ?? "").trim() || null : null;
    const base = `${date}|${amount}|${description ?? ""}|${reference ?? ""}|${bal?.value ?? ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    lines.push({
      lineDate: date,
      description,
      amount,
      balance: bal ? (bal.sign === -1 ? -bal.value : bal.value) : null,
      reference,
      rowHash: createHash("sha256").update(`${base}#${n}`).digest("hex"),
    });
  }
  const dates = lines.map((l) => l.lineDate).sort();
  return { lines, skipped, periodStart: dates[0] ?? null, periodEnd: dates[dates.length - 1] ?? null };
}

export function parseStatementCsv(text: string, opts: { year?: number } = {}): ParsedStatement {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: true, delimiter: "" });
  return toLines(res.data, opts);
}

export async function parseStatementXlsx(bytes: Uint8Array, opts: { year?: number } = {}): Promise<ParsedStatement> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Berkas Excel tidak memiliki lembar kerja.");
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];
    rows.push(
      values.slice(1).map((v) => {
        if (v && typeof v === "object" && !(v instanceof Date)) {
          const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
          if (o.result !== undefined) return o.result;
          if (o.richText) return o.richText.map((t) => t.text).join("");
          if (o.text !== undefined) return o.text;
        }
        return v;
      }),
    );
  });
  return toLines(rows, opts);
}

/** Pilih pembaca dari nama berkas (.csv/.txt → CSV; .xlsx → Excel). */
export async function parseStatement(fileName: string, content: string | Uint8Array, opts: { year?: number } = {}): Promise<ParsedStatement> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    if (typeof content === "string") throw new Error("Berkas Excel harus diunggah sebagai berkas biner.");
    return parseStatementXlsx(content, opts);
  }
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const text = typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
    return parseStatementCsv(text, opts);
  }
  throw new Error("Format berkas tidak didukung. Unggah CSV atau Excel (.xlsx) dari internet banking.");
}
