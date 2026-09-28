/**
 * Ekspor — API publik.
 *
 * ```ts
 * import { registerReport, exportReport } from "@/server/core/export";
 * registerReport({ key: "m5.aging", title: "Umur piutang", module: "m5", permission: "m5.aging.read", containsPii: true,
 *   columns: [{ key: "customerName", header: "Pelanggan" }, { key: "phone", header: "WA", pii: "phone" },
 *             { key: "balance", header: "Saldo", type: "rupiah", total: true }],
 *   fetch: async (ctx, filters, { tx }) => ({ rows: await … }) });
 * ```
 */
import "server-only";

export * from "./types";
export * from "./registry";
export { exportReport, redactAddress, PII_EXPORT_PERMISSION, type ExportResult } from "./service";
export { renderExcel, renderCsv } from "./excel";
export { renderPdf, formatCell } from "./pdf";
