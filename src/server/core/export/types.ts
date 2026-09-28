/**
 * Tipe laporan yang dapat diekspor (US-M9-03). Modul mendaftarkan `ReportDef` lewat `registerReport` (dari
 * `registerReports()` modulnya); ekspor lewat `exportReport(ctx, key, format, filters, purpose?)`.
 */
import type { ZodType } from "zod";

import type { EnumName } from "@/lib/labels";

import type { ActorContext } from "../context";
import type { Tx } from "../db";

export type ReportColumnType = "text" | "rupiah" | "number" | "liter" | "date" | "datetime" | "percent" | "boolean" | "enum";

/**
 * Jenis data pribadi pada kolom (BR-39). Untuk peran yang tidak berhak (bukan pemilik/Admin Keuangan):
 * `phone`/`email`/`coordinates`/`identity` → kolom dihilangkan; `address` → hanya bagian wilayah (setelah koma terakhir).
 */
export type PiiKind = "phone" | "address" | "email" | "coordinates" | "identity";

export type ReportColumn<Row = Record<string, unknown>> = {
  key: string;
  header: string;
  type?: ReportColumnType;
  /** Untuk `type: "enum"` — label dari `src/lib/labels.ts`. */
  enumName?: EnumName;
  /** Lebar kolom Excel (karakter) / proporsi PDF. */
  width?: number;
  pii?: PiiKind;
  /** Nilai sel (bawaan `row[key]`). */
  value?: (row: Row) => unknown;
  /** Jumlahkan kolom di lembar Ringkasan. */
  total?: boolean;
};

export type ReportSummaryItem = { label: string; value: string | number; type?: ReportColumnType };

export type ReportResult<Row = Record<string, unknown>> = {
  rows: Row[];
  summary?: ReportSummaryItem[];
  /** Label status laporan (mis. "Sementara" / "Final"). */
  status?: string;
};

export type ReportDef<Row = Record<string, unknown>, Filters = Record<string, unknown>> = {
  /** Kunci unik `<modul>.<nama>`, mis. `m5.aging`. */
  key: string;
  title: string;
  module: string;
  /** Izin yang diperlukan untuk mengekspor laporan ini (mis. `m5.aging.read`). */
  permission: string;
  description?: string;
  columns: ReportColumn<Row>[];
  /** Laporan memuat data pribadi pelanggan/mitra (BR-39). */
  containsPii: boolean;
  filtersSchema?: ZodType<Filters>;
  /** Uraian filter untuk kop PDF & lembar Ringkasan. */
  describeFilters?: (filters: Filters) => string[];
  orientation?: "portrait" | "landscape";
  fetch: (ctx: ActorContext, filters: Filters, opts: { tx: Tx }) => Promise<ReportResult<Row>>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyReportDef = ReportDef<any, any>;

export type ExportFormat = "xlsx" | "pdf" | "csv";

/** Masukan renderer (sudah diselesaikan: kolom tersaring PII, nilai sel mentah). */
export type RenderColumn = { key: string; header: string; type: ReportColumnType; enumName?: EnumName; width?: number; total?: boolean };

export type RenderInput = {
  title: string;
  company: { name: string; legalName?: string | null; address?: string | null; phone?: string | null };
  generatedAt: Date;
  generatedBy: string;
  filters: string[];
  status?: string;
  columns: RenderColumn[];
  rows: unknown[][];
  summary: ReportSummaryItem[];
  orientation: "portrait" | "landscape";
  /** Catatan kaki (mis. "Versi tanpa data pribadi"). */
  notes: string[];
};
