/**
 * M1 — template Excel impor data awal (exceljs) dan pembaca berkas (US-M1-06 KP-1).
 * Lembar "Data" (baris 1 = judul kolom; wajib bertanda *) + lembar "Petunjuk".
 */
import "server-only";

import * as ExcelJSNs from "exceljs";

import { ValidationError } from "@/server/core/errors";

import { IMPORT_DEFS, type ImportKindM1 } from "./definitions";

const ExcelJS = ((ExcelJSNs as unknown as { default?: typeof ExcelJSNs }).default ?? ExcelJSNs) as typeof ExcelJSNs;

/** Template kosong (`withExample: false`) atau contoh terisi (`true`). */
export async function buildImportTemplate(kind: ImportKindM1, opts: { withExample?: boolean } = {}): Promise<Buffer> {
  const def = IMPORT_DEFS[kind];
  const wb = new ExcelJS.Workbook();
  wb.creator = "EQUA ERP";
  wb.created = new Date();
  const sheet = wb.addWorksheet("Data", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = def.columns.map((c) => ({ header: `${c.header}${c.required ? " *" : ""}`, key: c.key, width: c.width ?? 16 }));
  const head = sheet.getRow(1);
  head.font = { bold: true };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0FE" } };
  def.columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.note = c.note || c.header;
  });
  if (opts.withExample) {
    for (const row of def.example) sheet.addRow(Object.fromEntries(def.columns.map((c) => [c.key, row[c.key] ?? null])));
  }
  const help = wb.addWorksheet("Petunjuk");
  help.columns = [
    { header: "Kolom", key: "header", width: 28 },
    { header: "Wajib", key: "required", width: 8 },
    { header: "Keterangan", key: "note", width: 90 },
  ];
  help.getRow(1).font = { bold: true };
  help.addRow({ header: def.title, required: "", note: def.description });
  help.addRow({ header: "", required: "", note: "Isi lembar \"Data\" mulai baris 2. Jangan mengubah judul kolom. Kolom bertanda * wajib diisi." });
  help.addRow({ header: "", required: "", note: "Sistem memvalidasi setiap baris; tidak ada baris yang masuk sebelum semua kesalahan diperbaiki atau dikecualikan dengan alasan." });
  help.addRow({});
  for (const c of def.columns) help.addRow({ header: c.header, required: c.required ? "Ya" : "", note: c.note });
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

function cellToValue(value: ExcelJSNs.CellValue): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "boolean") return value ? "Ya" : "Tidak";
  if (value instanceof Date) {
    // Excel menyimpan tanggal tanpa zona waktu → exceljs membaca sebagai tengah malam UTC.
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("result" in v) return cellToValue(v.result as ExcelJSNs.CellValue);
    if ("text" in v && typeof v.text === "string") return v.text.trim() || null;
    if ("richText" in v && Array.isArray(v.richText)) return (v.richText as { text: string }[]).map((r) => r.text).join("").trim() || null;
    if ("hyperlink" in v && typeof v.text === "string") return v.text;
  }
  return String(value);
}

function normalizeHeader(s: string): string {
  return s
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type ParsedImportRow = { rowNumber: number; data: Record<string, string | number | null> };

/** Baca berkas .xlsx sesuai template jenis. Judul kolom tak dikenal diabaikan; kolom wajib yang hilang = galat. */
export async function parseImportWorkbook(kind: ImportKindM1, body: Buffer | ArrayBuffer | Uint8Array): Promise<ParsedImportRow[]> {
  const def = IMPORT_DEFS[kind];
  const wb = new ExcelJS.Workbook();
  try {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as ArrayBuffer);
    await wb.xlsx.load(buf as unknown as ExcelJSNs.Buffer);
  } catch {
    throw ValidationError.field("file", "Berkas tidak dapat dibaca. Pastikan berformat Excel (.xlsx) dari template.");
  }
  const sheet = wb.getWorksheet("Data") ?? wb.worksheets[0];
  if (!sheet) throw ValidationError.field("file", "Lembar \"Data\" tidak ditemukan di berkas.");
  const headerRow = sheet.getRow(1);
  const colIndex = new Map<string, number>();
  headerRow.eachCell((cell, col) => {
    const text = normalizeHeader(String(cellToValue(cell.value) ?? ""));
    const match = def.columns.find((c) => normalizeHeader(c.header) === text || normalizeHeader(c.key) === text);
    if (match && !colIndex.has(match.key)) colIndex.set(match.key, col);
  });
  const missing = def.columns.filter((c) => c.required && !colIndex.has(c.key));
  if (missing.length) {
    throw ValidationError.field("file", `Kolom wajib tidak ditemukan: ${missing.map((c) => c.header).join(", ")}. Pakai template terbaru.`);
  }
  const rows: ParsedImportRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const data: Record<string, string | number | null> = {};
    let any = false;
    for (const c of def.columns) {
      const idx = colIndex.get(c.key);
      const v = idx ? cellToValue(row.getCell(idx).value) : null;
      data[c.key] = v;
      if (v !== null) any = true;
    }
    if (any) rows.push({ rowNumber, data });
  });
  if (rows.length === 0) throw ValidationError.field("file", "Lembar \"Data\" kosong. Isi mulai baris 2.");
  if (rows.length > 5000) throw ValidationError.field("file", "Maksimal 5.000 baris per berkas. Pecah berkas menjadi beberapa bagian.");
  return rows;
}
