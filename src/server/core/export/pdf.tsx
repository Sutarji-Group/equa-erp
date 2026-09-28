/**
 * Ekspor PDF siap cetak (US-M9-03 KP-1): identitas usaha (parameter `company.identity`, bawaan "EQUA"), judul, cap
 * waktu WIB, pembuat, filter, status laporan, tabel (header berulang tiap halaman), nomor halaman.
 */
import "server-only";

import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";

import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";

import type { RenderColumn, RenderInput } from "./types";

const styles = StyleSheet.create({
  page: { paddingTop: 28, paddingBottom: 36, paddingHorizontal: 28, fontSize: 8, fontFamily: "Helvetica", color: "#111827" },
  company: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  companySub: { fontSize: 8, color: "#4B5563", marginTop: 2 },
  title: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 10 },
  meta: { fontSize: 8, color: "#374151", marginTop: 2 },
  table: { marginTop: 10, borderTopWidth: 1, borderColor: "#9CA3AF" },
  headerRow: { flexDirection: "row", backgroundColor: "#E8EEF5", borderBottomWidth: 1, borderColor: "#9CA3AF" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: "#E5E7EB" },
  cell: { paddingVertical: 3, paddingHorizontal: 3 },
  headerCell: { fontFamily: "Helvetica-Bold" },
  right: { textAlign: "right" },
  summary: { marginTop: 10 },
  summaryRow: { flexDirection: "row", marginTop: 2 },
  summaryLabel: { width: 180, fontFamily: "Helvetica-Bold" },
  note: { marginTop: 6, fontSize: 7, color: "#6B7280" },
  footer: { position: "absolute", bottom: 16, left: 28, right: 28, fontSize: 7, color: "#6B7280", flexDirection: "row", justifyContent: "space-between" },
});

/** Format nilai sel untuk tampilan cetak (bahasa & satuan Indonesia). */
export function formatCell(col: RenderColumn, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (col.type) {
    case "rupiah":
      return typeof value === "number" ? formatRupiah(value) : String(value);
    case "liter":
      return typeof value === "number" ? `${value.toLocaleString("id-ID")} L` : String(value);
    case "number":
      return typeof value === "number" ? value.toLocaleString("id-ID") : String(value);
    case "percent":
      return typeof value === "number" ? `${value.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%` : String(value);
    case "date":
      return typeof value === "string" && isBusinessDate(value)
        ? formatTanggal(value, { weekday: false })
        : value instanceof Date
          ? formatTanggal(value, { weekday: false })
          : String(value);
    case "datetime":
      return value instanceof Date || typeof value === "string" ? formatTanggalJam(value, { weekday: false }) : String(value);
    case "boolean":
      return value ? "Ya" : "Tidak";
    case "enum":
      return col.enumName ? label(col.enumName, String(value)) : String(value);
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

const NUMERIC = new Set(["rupiah", "liter", "number", "percent"]);

function ReportDocument({ input }: { input: RenderInput }) {
  const weights = input.columns.map((c) => c.width ?? Math.min(Math.max(c.header.length, 8), 30));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const widthOf = (i: number) => `${((weights[i]! / totalWeight) * 100).toFixed(2)}%`;
  const companyName = input.company.legalName ?? input.company.name;
  const sub = [input.company.address, input.company.phone].filter(Boolean).join(" · ");

  return (
    <Document title={input.title} author={input.company.name} creator="EQUA ERP" producer="EQUA ERP">
      <Page size="A4" orientation={input.orientation} style={styles.page} wrap>
        <View fixed>
          <Text style={styles.company}>{companyName}</Text>
          {sub ? <Text style={styles.companySub}>{sub}</Text> : null}
        </View>
        <Text style={styles.title}>{input.title}</Text>
        {input.status ? <Text style={styles.meta}>Status: {input.status}</Text> : null}
        <Text style={styles.meta}>Dicetak: {formatTanggalJam(input.generatedAt)} WIB · Oleh: {input.generatedBy}</Text>
        <Text style={styles.meta}>Filter: {input.filters.length ? input.filters.join("; ") : "Tanpa filter"}</Text>

        <View style={styles.table}>
          <View style={styles.headerRow} fixed>
            {input.columns.map((c, i) => (
              <Text key={c.key} style={[styles.cell, styles.headerCell, { width: widthOf(i) }, NUMERIC.has(c.type) ? styles.right : {}]}>
                {c.header}
              </Text>
            ))}
          </View>
          {input.rows.map((row, r) => (
            <View key={r} style={styles.row} wrap={false}>
              {input.columns.map((c, i) => (
                <Text key={c.key} style={[styles.cell, { width: widthOf(i) }, NUMERIC.has(c.type) ? styles.right : {}]}>
                  {formatCell(c, row[i])}
                </Text>
              ))}
            </View>
          ))}
          {input.rows.length === 0 ? <Text style={[styles.cell, styles.meta]}>Tidak ada data untuk filter ini.</Text> : null}
        </View>

        {input.summary.length ? (
          <View style={styles.summary}>
            {input.summary.map((s) => (
              <View key={s.label} style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{s.label}</Text>
                <Text>{s.type === "rupiah" && typeof s.value === "number" ? formatRupiah(s.value) : String(s.value)}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {input.notes.map((n) => (
          <Text key={n} style={styles.note}>
            {n}
          </Text>
        ))}

        <View style={styles.footer} fixed>
          <Text>
            {input.company.name} · {input.title}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Halaman ${pageNumber} dari ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** Render PDF ke Buffer. */
export async function renderPdf(input: RenderInput): Promise<Buffer> {
  return renderToBuffer(<ReportDocument input={input} />);
}
