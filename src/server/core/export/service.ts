/**
 * Ekspor laporan (US-M9-03, BR-39, NFR-12):
 * `exportReport(ctx, "m5.aging", "xlsx", filters, purpose?)` →
 *   1. otorisasi izin laporan; 2. validasi filter; 3. kebijakan data pribadi — laporan ber-PII hanya utuh untuk
 *   pemilik/Admin Keuangan (`m9.report.export_pii`) DENGAN TUJUAN tercatat; peran lain menerima versi tanpa nomor WA &
 *   alamat lengkap; 4. render Excel/PDF/CSV; 5. catat `export_logs` + log akses `export`.
 */
import "server-only";

import { createHash } from "node:crypto";

import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { attachments, employees, exportLogs } from "@/db/schema";
import { label } from "@/lib/labels";
import { toWibParts } from "@/lib/time";

import { logAccess } from "../access-log";
import { ensureBootstrapped } from "../bootstrap";
import { ctxBusinessDate, systemContext, type ActorContext } from "../context";
import { getDb, withTx } from "../db";
import { DomainError, NotFoundError, parseInput } from "../errors";
import { get as getParam } from "../params-read";
import { authorize, can } from "../rbac/authorize";
import { put, storageDriver } from "../storage";
import { renderCsv, renderExcel } from "./excel";
import { renderPdf } from "./pdf";
import { getReport } from "./registry";
import type { AnyReportDef, ExportFormat, RenderColumn, RenderInput, ReportColumn } from "./types";

export const PII_EXPORT_PERMISSION = "m9.report.export_pii";

export type ExportResult = {
  filename: string;
  contentType: string;
  body: Buffer;
  rowCount: number;
  containsPersonalData: boolean;
  /** Kolom data pribadi disembunyikan/dipangkas karena peran tidak berhak (BR-39). */
  piiStripped: boolean;
  sha256: string;
  exportLogId: string;
};

const CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
};

const purposeSchema = z
  .string({ error: "Tujuan ekspor wajib diisi karena laporan memuat data pribadi (BR-39)." })
  .trim()
  .min(5, { error: "Tujuan ekspor wajib diisi (minimal 5 karakter) karena laporan memuat data pribadi (BR-39)." });

/** Alamat dipangkas menjadi wilayah saja (bagian setelah koma terakhir). */
export function redactAddress(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "—";
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1]! : "(alamat disembunyikan)";
}

type ResolvedColumn = { col: ReportColumn; render: RenderColumn; redact?: (v: unknown) => unknown };

function resolveColumns(def: AnyReportDef, stripPii: boolean): ResolvedColumn[] {
  const out: ResolvedColumn[] = [];
  for (const col of def.columns as ReportColumn[]) {
    if (stripPii && col.pii && col.pii !== "address") continue;
    out.push({
      col,
      render: {
        key: col.key,
        header: stripPii && col.pii === "address" ? `${col.header} (wilayah)` : col.header,
        type: stripPii && col.pii === "address" ? "text" : (col.type ?? "text"),
        enumName: col.enumName,
        width: col.width,
        total: col.total,
      },
      redact: stripPii && col.pii === "address" ? redactAddress : undefined,
    });
  }
  return out;
}

function slug(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function actorName(ctx: ActorContext): Promise<string> {
  const roleText = ctx.roles.map((r) => label("role", r)).join("/") || "Sistem";
  if (!ctx.employeeId) return roleText;
  const rows = await getDb().select({ name: employees.fullName }).from(employees).where(eq(employees.id, ctx.employeeId)).limit(1);
  return rows[0]?.name ? `${rows[0].name} (${roleText})` : roleText;
}

/** Ekspor laporan terdaftar. Panggil di luar transaksi (menulis log sendiri). */
export async function exportReport(
  ctx: ActorContext,
  key: string,
  format: ExportFormat,
  filters: Record<string, unknown> = {},
  purpose?: string | null,
): Promise<ExportResult> {
  ensureBootstrapped();
  const def = getReport(key);
  if (!def) throw new NotFoundError("Laporan tidak ditemukan.");
  if (!["xlsx", "pdf", "csv"].includes(format)) throw new DomainError("EXPORT_FORMAT", "Format ekspor harus Excel, PDF, atau CSV.");
  await authorize(ctx, def.permission, { objectType: "report", objectId: key });
  if (!ctx.userId) throw new DomainError("USER_REQUIRED", "Ekspor harus dilakukan oleh pengguna yang masuk.");

  const parsedFilters = def.filtersSchema ? parseInput(def.filtersSchema, filters) : filters;
  const piiAllowed = def.containsPii && can(ctx, PII_EXPORT_PERMISSION);
  const stripPii = def.containsPii && !piiAllowed;
  const cleanPurpose = piiAllowed ? parseInput(purposeSchema, purpose ?? undefined) : (purpose?.trim() || null);

  const db = getDb();
  const result = await def.fetch(ctx, parsedFilters, { tx: db });
  const columns = resolveColumns(def, stripPii);
  const rows = result.rows.map((row: Record<string, unknown>) =>
    columns.map(({ col, redact }) => {
      const raw = col.value ? col.value(row) : row[col.key];
      return redact ? redact(raw) : raw;
    }),
  );

  const identity = await getParam(db, "company.identity", ctxBusinessDate(ctx));
  const now = ctx.now ?? new Date();
  const input: RenderInput = {
    title: def.title,
    company: { name: identity.name, legalName: identity.legal_name, address: identity.address, phone: identity.phone },
    generatedAt: now,
    generatedBy: await actorName(ctx),
    filters: def.describeFilters ? def.describeFilters(parsedFilters) : describeGeneric(parsedFilters),
    status: result.status,
    columns: columns.map((c) => c.render),
    rows,
    summary: result.summary ?? [],
    orientation: def.orientation ?? (columns.length > 7 ? "landscape" : "portrait"),
    notes: stripPii ? ["Versi tanpa nomor WA dan alamat lengkap (BR-39). Data pribadi hanya dapat diekspor pemilik/Admin Keuangan dengan tujuan tercatat."] : [],
  };
  // (Tambahan S5-B) Versi Final: berkas pertama per (laporan, versi Final, format, filter, varian data pribadi) disimpan
  // lalu dikirim ulang apa adanya — ekspor ulang identik (US-M9-03 KP-4, US-M11-04 KP-2). Metadata cetak = waktu Final.
  const finalRef = result.final ?? null;
  const finalKey = finalRef
    ? createHash("sha256").update(JSON.stringify([key, format, finalRef.key, stripPii, sortedEntries(parsedFilters as Record<string, unknown>)])).digest("hex").slice(0, 40)
    : null;
  const stored = finalKey ? await storedFinalExport(db, ctx.tenantId, finalKey, format) : null;
  let body: Buffer;
  if (stored) body = stored.body;
  else if (finalRef) {
    const fixed = { ...input, generatedAt: finalRef.at, generatedBy: "Laporan Final" };
    body = format === "xlsx" ? await renderExcel(fixed, { fixedTimestamp: finalRef.at }) : format === "pdf" ? await renderPdf(fixed) : renderCsv(fixed);
  } else body = format === "xlsx" ? await renderExcel(input) : format === "pdf" ? await renderPdf(input) : renderCsv(input);
  const sha256 = createHash("sha256").update(body).digest("hex");

  const w = toWibParts(finalRef ? finalRef.at : now);
  const stamp = `${w.businessDate.replace(/-/g, "")}-${w.time.replace(":", "")}`;
  const filename = stored?.name ?? `${slug(def.title) || slug(key)}-${finalRef ? "final-" : ""}${stamp}.${format}`;
  if (finalKey && !stored) {
    await withTx(async (tx) => {
      await put(tx, systemContext({ tenantId: ctx.tenantId, now }), {
        blob: body,
        contentType: CONTENT_TYPES[format].split(";")[0]!,
        kind: `report_final_${format}`,
        originalName: filename,
        objectRef: { type: FINAL_EXPORT_OBJECT, id: finalKey },
      });
    });
  }

  const exportLogId = await withTx(async (tx) => {
    const [log] = await tx
      .insert(exportLogs)
      .values({
        tenantId: ctx.tenantId,
        userId: ctx.userId!,
        reportKey: key,
        format,
        filters: parsedFilters as Record<string, unknown>,
        containsPersonalData: piiAllowed,
        purpose: cleanPurpose,
        rowCount: rows.length,
        fileSha256: sha256,
      })
      .returning({ id: exportLogs.id });
    await logAccess(tx, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      event: "export",
      success: true,
      objectType: "report",
      objectId: key,
      reason: cleanPurpose,
      details: { format, rowCount: rows.length, containsPersonalData: piiAllowed, piiStripped: stripPii, exportLogId: log!.id },
      occurredAt: now,
    });
    return log!.id;
  });

  return {
    filename,
    contentType: CONTENT_TYPES[format],
    body,
    rowCount: rows.length,
    containsPersonalData: piiAllowed,
    piiStripped: stripPii,
    sha256,
    exportLogId,
  };
}

/** (Tambahan S5-B) Objek lampiran berkas ekspor versi Final. */
const FINAL_EXPORT_OBJECT = "report_final_export";

function sortedEntries(filters: Record<string, unknown>): [string, unknown][] {
  return Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Berkas ekspor versi Final yang sudah tersimpan (dibaca langsung dari penyimpanan — otorisasi laporan sudah lolos). */
async function storedFinalExport(db: ReturnType<typeof getDb>, tenantId: string, finalKey: string, format: ExportFormat): Promise<{ body: Buffer; name: string | null } | null> {
  const [row] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.objectType, FINAL_EXPORT_OBJECT), eq(attachments.objectId, finalKey), eq(attachments.kind, `report_final_${format}`), eq(attachments.tenantId, tenantId), isNull(attachments.archivedAt)))
    .orderBy(asc(attachments.createdAt))
    .limit(1);
  if (!row) return null;
  const body = await storageDriver().get(row.storageKey, row.url);
  return body ? { body, name: row.originalName } : null;
}

function describeGeneric(filters: Record<string, unknown>): string[] {
  return Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
}
