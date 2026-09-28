/**
 * M7 — laporan yang dapat diekspor (katalog PRD 7.9.4; US-M9-03).
 *
 * ```ts
 * import { registerReport } from "@/server/core/export";
 * export function registerReports(): void {
 *   registerReport({ key: "m7.contoh", title: "…", module: "m7", permission: "<izin baca>",
 *     containsPii: false, columns: [...], fetch: async (ctx, filters, { tx }) => ({ rows: [] }) });
 * }
 * ```
 */
import "server-only";

export function registerReports(): void {
  // Belum ada laporan — diisi agen modul M7.
}
