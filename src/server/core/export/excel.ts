/**
 * Ekspor Excel (NFR-23, US-M9-03 KP-1): lembar **Data** (header tebal, beku, format rupiah/liter/tanggal) dan
 * **Ringkasan** (identitas usaha, judul, cap waktu WIB, pembuat, filter, jumlah baris, total kolom).
 */
import "server-only";

import * as ExcelJSNs from "exceljs";

import { label } from "@/lib/labels";
import { formatTanggalJam, isBusinessDate } from "@/lib/time";

import type { RenderColumn, RenderInput } from "./types";

// exceljs = CommonJS; ambil objek modul baik lewat namespace maupun default (Node ESM / bundler).
const ExcelJS = ((ExcelJSNs as unknown as { default?: typeof ExcelJSNs }).default ?? ExcelJSNs) as typeof ExcelJSNs;

const RUPIAH_FMT = '"Rp" #,##0;[Red]-"Rp" #,##0';
const LITER_FMT = '#,##0" L"';
const NUMBER_FMT = "#,##0";
const PERCENT_FMT = '0.00"%"';

function excelValue(col: RenderColumn, value: unknown): ExcelJSNs.CellValue {
  if (value === null || value === undefined) return null;
  switch (col.type) {
    case "rupiah":
    case "number":
    case "liter":
    case "percent":
      return typeof value === "number" ? value : Number(value);
    case "date":
      if (typeof value === "string" && isBusinessDate(value)) return new Date(`${value}T00:00:00Z`);
      return value instanceof Date ? value : String(value);
    case "datetime": {
      const d = value instanceof Date ? value : new Date(String(value));
      // Excel tidak berzona waktu: simpan jam dinding WIB.
      return Number.isNaN(d.getTime()) ? String(value) : new Date(d.getTime() + 7 * 3_600_000);
    }
    case "boolean":
      return value ? "Ya" : "Tidak";
    case "enum":
      return col.enumName ? label(col.enumName, String(value)) : String(value);
    default:
      return typeof value === "object" ? JSON.stringify(value) : (value as ExcelJSNs.CellValue);
  }
}

function numFmt(col: RenderColumn): string | undefined {
  switch (col.type) {
    case "rupiah":
      return RUPIAH_FMT;
    case "liter":
      return LITER_FMT;
    case "number":
      return NUMBER_FMT;
    case "percent":
      return PERCENT_FMT;
    case "date":
      return "dd/mm/yyyy";
    case "datetime":
      return "dd/mm/yyyy hh:mm";
    default:
      return undefined;
  }
}

/** Bangun berkas .xlsx. `fixedTimestamp` membuat metadata berkas deterministik (laporan Final). */
export async function renderExcel(input: RenderInput, options: { fixedTimestamp?: Date } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const stamp = options.fixedTimestamp ?? input.generatedAt;
  wb.creator = input.company.name;
  wb.lastModifiedBy = input.generatedBy;
  wb.created = stamp;
  wb.modified = stamp;
  wb.title = input.title;

  // --- Data ---
  const data = wb.addWorksheet("Data", { views: [{ state: "frozen", ySplit: 1 }] });
  data.columns = input.columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? Math.min(Math.max(c.header.length + 4, 12), 40),
    style: numFmt(c) ? { numFmt: numFmt(c) } : {},
  }));
  data.getRow(1).font = { bold: true };
  data.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF5" } };
  for (const row of input.rows) {
    data.addRow(input.columns.map((c, i) => excelValue(c, row[i])));
  }
  if (input.rows.length > 0) {
    data.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: input.columns.length } };
  }

  // --- Ringkasan ---
  const sum = wb.addWorksheet("Ringkasan");
  sum.columns = [
    { header: "", key: "k", width: 32 },
    { header: "", key: "v", width: 60 },
  ];
  const lines: [string, ExcelJSNs.CellValue][] = [
    [input.company.legalName ?? input.company.name, null],
    ...(input.company.address ? ([["Alamat", input.company.address]] as [string, ExcelJSNs.CellValue][]) : []),
    ["Laporan", input.title],
    ...(input.status ? ([["Status", input.status]] as [string, ExcelJSNs.CellValue][]) : []),
    ["Dicetak", `${formatTanggalJam(input.generatedAt)} WIB`],
    ["Dibuat oleh", input.generatedBy],
    ["Filter", input.filters.length ? input.filters.join("; ") : "Tanpa filter"],
    ["Jumlah baris", input.rows.length],
  ];
  for (const [k, v] of lines) sum.addRow([k, v]);
  sum.getRow(1).font = { bold: true, size: 14 };
  for (let r = 2; r <= lines.length; r++) sum.getCell(r, 1).font = { bold: true };

  const totals = input.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.total && (c.type === "rupiah" || c.type === "number" || c.type === "liter"));
  if (totals.length || input.summary.length) sum.addRow([]);
  for (const { c, i } of totals) {
    const total = input.rows.reduce<number>((acc, row) => acc + (typeof row[i] === "number" ? (row[i] as number) : 0), 0);
    const added = sum.addRow([`Total ${c.header}`, total]);
    added.getCell(1).font = { bold: true };
    const fmt = numFmt(c);
    if (fmt) added.getCell(2).numFmt = fmt;
  }
  for (const item of input.summary) {
    const added = sum.addRow([item.label, item.value]);
    added.getCell(1).font = { bold: true };
    if (item.type === "rupiah") added.getCell(2).numFmt = RUPIAH_FMT;
  }
  for (const note of input.notes) sum.addRow(["Catatan", note]);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** CSV sederhana (pemisah koma, UTF-8 BOM agar Excel membaca huruf Indonesia dengan benar). */
export function renderCsv(input: RenderInput): Buffer {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [input.columns.map((c) => esc(c.header)).join(",")];
  for (const row of input.rows) {
    lines.push(
      input.columns
        .map((c, i) => {
          const v = row[i];
          if (c.type === "enum" && c.enumName && v != null) return esc(label(c.enumName, String(v)));
          if (c.type === "date" && typeof v === "string") return esc(v);
          if (c.type === "datetime" && v) return esc(formatTanggalJam(v as Date));
          return esc(v);
        })
        .join(","),
    );
  }
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

