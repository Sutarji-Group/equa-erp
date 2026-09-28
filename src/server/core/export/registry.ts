/**
 * Registri laporan yang dapat diekspor (katalog 7.9.4). Modul memanggil `registerReport(def)` dari `registerReports()`.
 */
import "server-only";

import type { ActorContext } from "../context";
import { can } from "../rbac/authorize";
import type { AnyReportDef } from "./types";

const reports = new Map<string, AnyReportDef>();

/** Daftarkan (atau ganti) laporan. */
export function registerReport(def: AnyReportDef): void {
  if (!/^[a-z0-9]+\.[a-z0-9_]+$/.test(def.key)) throw new Error(`Kunci laporan tidak valid: "${def.key}" (format <modul>.<nama>).`);
  if (def.columns.length === 0) throw new Error(`Laporan ${def.key} wajib memiliki kolom.`);
  reports.set(def.key, def);
}

export function unregisterReport(key: string): void {
  reports.delete(key);
}

export function getReport(key: string): AnyReportDef | undefined {
  return reports.get(key);
}

/** Laporan yang boleh diekspor pelaku (menurut izin). */
export function listReports(ctx?: ActorContext): AnyReportDef[] {
  const all = Array.from(reports.values());
  return ctx ? all.filter((r) => can(ctx, r.permission)) : all;
}
