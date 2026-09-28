/**
 * M1 — impor data awal (US-M1-06; FR-M1-06, NFR-34, BRD 10.3, BR-01).
 *
 * Alur: unduh template/contoh → unggah .xlsx (mode UJI berulang / PRODUKSI sekali per jenis dengan penanda "data
 * awal") → laporan validasi per baris (wajib kosong, format WA, segmen tak dikenal, duplikat + usulan gabung) →
 * perbaiki/kecualikan beralasan, putuskan duplikat (gabung / buat baru beralasan) → "Masukkan data" (ditolak selama
 * masih ada baris Salah/duplikat belum diputuskan) → ringkasan (per segmen, per zona, Tempo migrasi & batas) →
 * tanda tangan pemilik (./signoff.ts) sebelum go-live.
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import {
  customerAddresses,
  customerLegacyPrices,
  customers,
  employees,
  importBatches,
  importBatchRows,
  outlets,
  poolLocations,
  tariffZones,
  trucks,
  waterMeters,
  waterSources,
} from "@/db/schema";
import { isProductionLike, serverEnv } from "@/lib/env";
import type { CustomerSegment, RoleCode } from "@/lib/labels";
import { label } from "@/lib/labels";
import { newId } from "@/lib/ids";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { assertTenantScope, authorize, authorizeAny, can, runService } from "@/server/core/rbac";
import { put as putAttachment } from "@/server/core/storage";
import { normalizeWaNumber } from "@/server/core/wa";

import { normalizeText } from "../common";
import { ensureInternalCustomer } from "../org";
import { defaultCreditTerms } from "../customers";
import { autoZoneColumns, mapAddressToZone } from "../zones";
import { IMPORT_DEFS, isImportKindM1, type ImportKindM1 } from "./definitions";
import { refreshSignoffDraft } from "./signoff";
import { importValueParsers, parseCreditStatus, parseRoles, parseSegment, validateImportRows } from "./validate";
import { parseImportWorkbook, type ParsedImportRow } from "./workbook";

const { str, num, coord, lookupLabel } = importValueParsers;

type BatchRow = typeof importBatches.$inferSelect;
type ImportRow = typeof importBatchRows.$inferSelect;

export type ImportMode = "test" | "production";

async function loadBatch(tx: Tx, ctx: ActorContext, id: string, forUpdate = false): Promise<BatchRow> {
  const q = tx.select().from(importBatches).where(eq(importBatches.id, id)).limit(1);
  const rows = forUpdate ? await q.for("update") : await q;
  if (!rows[0]) throw new NotFoundError("Batch impor tidak ditemukan.");
  assertTenantScope(ctx, rows[0].tenantId);
  return rows[0];
}

function assertKind(kind: string): ImportKindM1 {
  if (!isImportKindM1(kind)) throw ValidationError.field("kind", "Jenis impor tidak dikenal.");
  return kind;
}

/** Mode uji hanya di lingkungan non-produksi (NFR-27); produksi = sekali per jenis dengan penanda "data awal". */
export function allowedImportModes(): ImportMode[] {
  return isProductionLike(serverEnv()) ? ["production"] : ["test", "production"];
}

const uploadSchema = z.object({
  kind: z.string(),
  mode: z.enum(["test", "production"], { error: "Pilih mode impor (uji atau produksi)." }),
  filename: z.string().trim().max(200).optional(),
});

/**
 * Unggah & validasi berkas impor (US-M1-06 KP-1/KP-2). Berkas asli disimpan sebagai lampiran; setiap baris dinilai
 * dan disimpan dengan status Valid / Salah / Duplikat. Belum ada data master yang ditulis.
 */
export async function uploadImport(
  ctx: ActorContext,
  input: { kind: string; mode: ImportMode; filename?: string; file: Buffer | ArrayBuffer | Uint8Array },
  opts: { tx?: Tx } = {},
): Promise<{ batch: BatchRow; rows: ImportRow[] }> {
  await authorize(ctx, "m1.import.create", { tx: opts.tx });
  const data = parseInput(uploadSchema, { kind: input.kind, mode: input.mode, filename: input.filename });
  const kind = assertKind(data.kind);
  if (!allowedImportModes().includes(data.mode)) throw new DomainError("IMPORT_MODE", "Mode uji tidak tersedia di lingkungan produksi (NFR-27).");
  const body = Buffer.isBuffer(input.file) ? input.file : Buffer.from(input.file as ArrayBuffer);
  const parsed = await parseImportWorkbook(kind, body);
  return runService(ctx, opts, async (tx) => {
    if (data.mode === "production") await assertProductionAvailable(tx, ctx.tenantId, kind);
    const batchId = newId();
    const attachment = await putAttachment(tx, ctx, {
      blob: body,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      kind: "import_file",
      objectRef: { type: "import_batch", id: batchId },
      originalName: data.filename ?? `impor-${kind}.xlsx`,
    });
    const [batch] = await tx
      .insert(importBatches)
      .values({
        id: batchId,
        tenantId: ctx.tenantId,
        kind,
        fileAttachmentId: attachment.id,
        originalFilename: data.filename ?? null,
        status: "uploaded",
        isInitialData: data.mode === "production",
        rowCount: parsed.length,
        createdBy: ctx.userId,
      })
      .returning();
    await tx.insert(importBatchRows).values(parsed.map((r) => ({ batchId: batch!.id, rowNumber: r.rowNumber, data: r.data })));
    const updated = await revalidateBatch(tx, ctx, batch!);
    await auditRecord(tx, {
      ctx,
      objectType: "import_batch",
      objectId: batch!.id,
      action: "create",
      after: { kind, mode: data.mode, rows: parsed.length, errors: updated.errorCount, duplicates: updated.duplicateCount },
    });
    const rows = await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batch!.id)).orderBy(asc(importBatchRows.rowNumber));
    return { batch: updated, rows };
  });
}

async function assertProductionAvailable(tx: Tx, tenantId: string, kind: ImportKindM1): Promise<void> {
  const done = await tx
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(and(eq(importBatches.tenantId, tenantId), eq(importBatches.kind, kind), eq(importBatches.isInitialData, true), eq(importBatches.status, "committed")))
    .limit(1);
  if (done[0]) {
    throw new DomainError(
      "PRODUCTION_IMPORT_DONE",
      `Impor produksi ${IMPORT_DEFS[kind].title} sudah pernah dijalankan (sekali di produksi). Perubahan data awal hanya lewat koreksi berjejak di layar master.`,
    );
  }
}

type Decision = { decision?: "merge" | "create_new"; targetCustomerId?: string; targetCode?: string; reason?: string; decidedBy?: string | null };

/** Nilai ulang semua baris batch (menjaga pengecualian & keputusan duplikat yang masih relevan). */
async function revalidateBatch(tx: Tx, ctx: ActorContext, batch: BatchRow): Promise<BatchRow> {
  const kind = assertKind(batch.kind);
  const rows = await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batch.id)).orderBy(asc(importBatchRows.rowNumber));
  const parsed: ParsedImportRow[] = rows.map((r) => ({ rowNumber: r.rowNumber, data: r.data as Record<string, string | number | null> }));
  const results = await validateImportRows(tx, batch.tenantId, kind, parsed, ctxBusinessDate(ctx));
  let errorCount = 0;
  let duplicateCount = 0;
  let excludedCount = 0;
  for (const row of rows) {
    const v = results.find((x) => x.rowNumber === row.rowNumber)!;
    const prev = (row.mergeProposal ?? {}) as Decision;
    let status: ImportRow["status"] = v.status;
    let proposal: Record<string, unknown> | null = v.mergeProposal;
    if (row.status === "excluded") status = "excluded";
    else if (v.status === "duplicate" && prev.decision) {
      status = "valid";
      proposal = { ...(v.mergeProposal ?? {}), ...prev };
    }
    if (status === "error") errorCount++;
    if (status === "duplicate") duplicateCount++;
    if (status === "excluded") excludedCount++;
    await tx
      .update(importBatchRows)
      .set({ status, errors: v.errors.length ? v.errors : null, duplicateCandidates: v.duplicateCandidates.length ? v.duplicateCandidates : null, mergeProposal: proposal })
      .where(eq(importBatchRows.id, row.id));
  }
  const [updated] = await tx
    .update(importBatches)
    .set({ status: errorCount + duplicateCount > 0 ? "has_errors" : "validated", rowCount: rows.length, errorCount, duplicateCount, excludedCount })
    .where(eq(importBatches.id, batch.id))
    .returning();
  return updated!;
}

const resolveSchema = z.object({
  decision: z.enum(["exclude", "include", "merge", "create_new"], { error: "Keputusan tidak dikenal." }),
  reason: z.string().trim().max(300).optional(),
  targetCustomerId: z.uuid().optional(),
});

/**
 * Selesaikan baris (US-M1-06 KP-2): kecualikan beralasan / batalkan pengecualian; untuk duplikat pelanggan: gabungkan
 * ke pelanggan yang ada (usulan) atau buat baru beralasan. Keputusan duplikat berlaku untuk semua baris kode yang sama.
 */
export async function resolveImportRow(ctx: ActorContext, batchId: string, rowId: string, input: z.input<typeof resolveSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.import.create", { tx: opts.tx, objectType: "import_batch", objectId: batchId });
  const data = parseInput(resolveSchema, input, { reason: "Alasan" });
  if ((data.decision === "exclude" || data.decision === "create_new") && (!data.reason || data.reason.length < 3)) {
    throw ValidationError.field("reason", data.decision === "exclude" ? "Alasan pengecualian wajib diisi (minimal 3 karakter)." : "Alasan membuat pelanggan baru walau mirip wajib diisi.");
  }
  return runService(ctx, opts, async (tx) => {
    const batch = await loadBatch(tx, ctx, batchId, true);
    if (batch.status === "committed" || batch.status === "cancelled") throw new ConflictError("IMPORT_CLOSED", "Batch ini sudah selesai; tidak dapat diubah.");
    const [row] = await tx.select().from(importBatchRows).where(and(eq(importBatchRows.id, rowId), eq(importBatchRows.batchId, batchId)));
    if (!row) throw new NotFoundError("Baris impor tidak ditemukan.");
    if (data.decision === "exclude") {
      await tx.update(importBatchRows).set({ status: "excluded", exclusionReason: data.reason! }).where(eq(importBatchRows.id, rowId));
    } else if (data.decision === "include") {
      if (row.status !== "excluded") throw new DomainError("NOT_EXCLUDED", "Baris ini tidak sedang dikecualikan.");
      await tx.update(importBatchRows).set({ status: "valid", exclusionReason: null }).where(eq(importBatchRows.id, rowId));
    } else {
      if (batch.kind !== "customers") throw new DomainError("NOT_CUSTOMER_IMPORT", "Keputusan gabung/buat baru hanya untuk impor pelanggan.");
      if (row.status !== "duplicate" && !((row.mergeProposal ?? {}) as Decision).decision) throw new DomainError("NOT_DUPLICATE", "Baris ini bukan kandidat duplikat.");
      const proposal = (row.mergeProposal ?? {}) as Record<string, unknown> & Decision;
      const decision: Decision = { decision: data.decision, reason: data.reason, decidedBy: ctx.userId };
      if (data.decision === "merge") {
        const candidates = (row.duplicateCandidates ?? []) as { customerId?: string; code?: string; source?: string }[];
        const target = data.targetCustomerId ?? proposal.targetCustomerId;
        if (target) {
          if (!candidates.some((c) => c.customerId === target)) throw ValidationError.field("targetCustomerId", "Pilih salah satu kandidat duplikat sebagai tujuan penggabungan.");
          decision.targetCustomerId = target as string;
        } else if (proposal.targetCode) {
          decision.targetCode = proposal.targetCode;
        } else {
          throw ValidationError.field("targetCustomerId", "Pilih pelanggan tujuan penggabungan.");
        }
      }
      const code = str((row.data as Record<string, unknown>).kode_pelanggan);
      const all = await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batchId));
      for (const r of all.filter((x) => str((x.data as Record<string, unknown>).kode_pelanggan) === code && x.status !== "excluded" && x.status !== "error")) {
        await tx
          .update(importBatchRows)
          .set({ status: "valid", mergeProposal: { ...((r.mergeProposal ?? {}) as object), ...decision } })
          .where(eq(importBatchRows.id, r.id));
      }
    }
    const updated = await revalidateBatch(tx, ctx, batch);
    await auditRecord(tx, { ctx, objectType: "import_batch_row", objectId: rowId, action: data.decision, after: { rowNumber: row.rowNumber, decision: data.decision, targetCustomerId: data.targetCustomerId ?? null }, reason: data.reason ?? null, rule: "US-M1-06 KP-2" });
    return updated;
  });
}

/** Perbaiki isi baris (lalu seluruh batch dinilai ulang). */
export async function updateImportRow(ctx: ActorContext, batchId: string, rowId: string, patch: Record<string, string | number | null>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.import.create", { tx: opts.tx, objectType: "import_batch", objectId: batchId });
  return runService(ctx, opts, async (tx) => {
    const batch = await loadBatch(tx, ctx, batchId, true);
    if (batch.status === "committed" || batch.status === "cancelled") throw new ConflictError("IMPORT_CLOSED", "Batch ini sudah selesai; tidak dapat diubah.");
    const [row] = await tx.select().from(importBatchRows).where(and(eq(importBatchRows.id, rowId), eq(importBatchRows.batchId, batchId)));
    if (!row) throw new NotFoundError("Baris impor tidak ditemukan.");
    const def = IMPORT_DEFS[assertKind(batch.kind)];
    const allowed = new Set(def.columns.map((c) => c.key));
    const next = { ...(row.data as Record<string, string | number | null>) };
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k)) continue;
      next[k] = typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v;
    }
    await tx.update(importBatchRows).set({ data: next, status: row.status === "excluded" ? "excluded" : "valid" }).where(eq(importBatchRows.id, rowId));
    await auditRecord(tx, { ctx, objectType: "import_batch_row", objectId: rowId, action: "update", before: row.data, after: next, rule: "US-M1-06 KP-2" });
    return revalidateBatch(tx, ctx, batch);
  });
}

/** Batalkan batch (tidak ada data yang masuk). */
export async function cancelImport(ctx: ActorContext, batchId: string, reason: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.import.create", { tx: opts.tx, objectType: "import_batch", objectId: batchId });
  const cleanReason = parseInput(z.string().trim().min(3, { error: "Alasan wajib diisi." }), reason);
  return runService(ctx, opts, async (tx) => {
    const batch = await loadBatch(tx, ctx, batchId, true);
    if (batch.status === "committed" || batch.status === "cancelled") throw new ConflictError("IMPORT_CLOSED", "Batch ini sudah selesai.");
    const [after] = await tx.update(importBatches).set({ status: "cancelled" }).where(eq(importBatches.id, batchId)).returning();
    await auditRecord(tx, { ctx, objectType: "import_batch", objectId: batchId, action: "cancel", before: { status: batch.status }, after: { status: "cancelled" }, reason: cleanReason });
    return after!;
  });
}

// =====================================================================================================================
// Masukkan data (commit)
// =====================================================================================================================

export type ImportSummary = Record<string, unknown> & { kind: ImportKindM1; mode: ImportMode; created: number; merged?: number; excluded: number };

/**
 * Masukkan baris valid ke master (US-M1-06 KP-2/KP-3): DITOLAK bila masih ada baris Salah atau duplikat yang belum
 * diputuskan. Data keuangan (pelanggan + status/batas, harga) butuh `m1.import.commit_pricing`. Mode produksi →
 * penanda "data awal" (hanya diubah lewat koreksi berjejak) + draf tanda tangan pemilik (NFR-34).
 */
export async function commitImport(ctx: ActorContext, batchId: string, opts: { tx?: Tx } = {}): Promise<{ batch: BatchRow; summary: ImportSummary }> {
  await authorizeAny(ctx, ["m1.import.commit", "m1.import.commit_pricing"], { tx: opts.tx, objectType: "import_batch", objectId: batchId });
  return runService(ctx, opts, async (tx) => {
    const batch = await loadBatch(tx, ctx, batchId, true);
    const kind = assertKind(batch.kind);
    const def = IMPORT_DEFS[kind];
    if (def.pricing && !can(ctx, "m1.import.commit_pricing")) {
      await authorize(ctx, "m1.import.commit_pricing", { tx, objectType: "import_batch", objectId: batchId });
    }
    if (batch.status === "committed") throw new ConflictError("IMPORT_COMMITTED", "Batch ini sudah dimasukkan.");
    if (batch.status === "cancelled") throw new ConflictError("IMPORT_CANCELLED", "Batch ini sudah dibatalkan.");
    if (batch.isInitialData) await assertProductionAvailable(tx, batch.tenantId, kind);
    const checked = await revalidateBatch(tx, ctx, batch);
    if (checked.errorCount > 0 || checked.duplicateCount > 0) {
      throw new DomainError(
        "IMPORT_HAS_ERRORS",
        `Belum dapat dimasukkan: ${checked.errorCount} baris salah dan ${checked.duplicateCount} duplikat belum diputuskan. Perbaiki atau kecualikan dengan alasan dulu — tidak ada baris yang masuk.`,
      );
    }
    const rows = await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batchId)).orderBy(asc(importBatchRows.rowNumber));
    const valid = rows.filter((r) => r.status === "valid");
    const excluded = rows.filter((r) => r.status === "excluded").length;
    let summary: ImportSummary;
    switch (kind) {
      case "customers":
        summary = await commitCustomers(tx, ctx, checked, valid);
        break;
      case "customer_prices":
        summary = await commitCustomerPrices(tx, ctx, checked, valid);
        break;
      case "trucks":
        summary = await commitTrucks(tx, ctx, checked, valid);
        break;
      case "crew":
        summary = await commitCrew(tx, ctx, checked, valid);
        break;
      case "employees":
        summary = await commitEmployees(tx, ctx, checked, valid);
        break;
      case "outlets":
        summary = await commitOutlets(tx, ctx, checked, valid);
        break;
      case "water_sources":
        summary = await commitWaterSources(tx, ctx, checked, valid);
        break;
    }
    summary.excluded = excluded;
    const [after] = await tx
      .update(importBatches)
      .set({ status: "committed", committedAt: ctx.now, committedBy: ctx.userId, summary })
      .where(eq(importBatches.id, batchId))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "import_batch",
      objectId: batchId,
      action: "commit",
      before: { status: checked.status },
      after: { status: "committed", initialData: batch.isInitialData, created: summary.created, excluded },
      rule: batch.isInitialData ? "US-M1-06 KP-3" : null,
    });
    if (batch.isInitialData) {
      const signoffId = await refreshSignoffDraft(tx, ctx, def.signoffGroup, after!, summary);
      await tx.update(importBatches).set({ signoffId }).where(eq(importBatches.id, batchId));
    }
    return { batch: after!, summary };
  });
}

async function markRow(tx: Tx, rowId: string, entityType: string, entityId: string) {
  await tx.update(importBatchRows).set({ status: "committed", createdEntityType: entityType, createdEntityId: entityId }).where(eq(importBatchRows.id, rowId));
}

function rowData(r: ImportRow): Record<string, string | number | null> {
  return r.data as Record<string, string | number | null>;
}

async function commitCustomers(tx: Tx, ctx: ActorContext, batch: BatchRow, rows: ImportRow[]): Promise<ImportSummary> {
  const date = ctxBusinessDate(ctx);
  const zones = await tx.select().from(tariffZones).where(eq(tariffZones.tenantId, batch.tenantId));
  const groups = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const code = str(rowData(r).kode_pelanggan)!;
    groups.set(code, [...(groups.get(code) ?? []), r]);
  }
  const createdByCode = new Map<string, string>();
  const bySegment: Record<string, number> = {};
  const byZone: Record<string, number> = {};
  const tempoMigrasi: { customerId: string; code: string; name: string; creditLimit: number; paymentTermDays: number }[] = [];
  let created = 0;
  let merged = 0;
  let addressesLocked = 0;
  let addressesUnlocked = 0;

  async function addAddress(customerId: string, r: ImportRow) {
    const d = rowData(r);
    const la = coord(d.lat);
    const ln = coord(d.lng);
    const zm = str(d.zona_manual);
    const manualZone = zm ? zones.find((z) => z.code.toUpperCase() === zm.toUpperCase()) : undefined;
    let values: typeof customerAddresses.$inferInsert = { customerId, label: str(d.label_alamat) ?? "Utama", addressText: String(d.alamat), createdBy: ctx.userId };
    if (la !== null && ln !== null) {
      const mapping = await mapAddressToZone(tx, { lat: la, lng: ln, tenantId: batch.tenantId, date });
      values = { ...values, lat: la, lng: ln, coordinateStatus: "locked", coordinateSource: "import", coordinateLockedAt: ctx.now, coordinateLockedBy: ctx.userId, ...autoZoneColumns(mapping, ctx.now, false, null) };
      if (manualZone) values = { ...values, tariffZoneId: manualZone.id, zoneBoundaryId: null, zoneAssignment: "manual", zoneManualReason: str(d.alasan_zona) ?? "Zona manual dari impor data awal." };
      addressesLocked++;
    } else {
      values = {
        ...values,
        coordinateStatus: "unlocked",
        tariffZoneId: manualZone?.id ?? null,
        zoneAssignment: manualZone ? "manual" : "auto",
        zoneManualReason: manualZone ? (str(d.alasan_zona) ?? "Koordinat belum tersedia — dilengkapi dari GPS sopir (US-M1-06 KP-5).") : null,
        zoneAssignedAt: manualZone ? ctx.now : null,
      };
      addressesUnlocked++;
    }
    const [addr] = await tx.insert(customerAddresses).values(values).returning();
    const zoneCode = zones.find((z) => z.id === addr!.tariffZoneId)?.code ?? "Tanpa zona";
    byZone[zoneCode] = (byZone[zoneCode] ?? 0) + 1;
    await auditRecord(tx, { ctx, objectType: "customer_address", objectId: addr!.id, action: "create", after: addr, reason: `Impor data awal baris ${r.rowNumber}.`, rule: "US-M1-06" });
    await markRow(tx, r.id, "customer_address", addr!.id);
  }

  // 1) Kelompok baru atau digabung ke pelanggan yang sudah ada; 2) kelompok yang digabung ke kode lain di berkas.
  const ordered = [...groups.entries()].sort(([, a], [, b]) => Number(Boolean(((a[0]!.mergeProposal ?? {}) as Decision).targetCode)) - Number(Boolean(((b[0]!.mergeProposal ?? {}) as Decision).targetCode)));
  for (const [code, group] of ordered) {
    const first = rowData(group[0]!);
    const decision = (group[0]!.mergeProposal ?? {}) as Decision;
    let customerId: string;
    if (decision.decision === "merge") {
      const target = decision.targetCustomerId ?? (decision.targetCode ? createdByCode.get(decision.targetCode) : undefined);
      if (!target) throw new DomainError("MERGE_TARGET_MISSING", `Tujuan penggabungan untuk ${code} tidak ditemukan. Kecualikan baris itu atau pilih ulang.`);
      customerId = target;
      merged++;
      await auditRecord(tx, { ctx, objectType: "customer", objectId: customerId, action: "merge", after: { importCode: code, rows: group.map((g) => g.rowNumber) }, reason: decision.reason ?? "Gabung duplikat dari impor data awal.", rule: "US-M1-06 KP-2" });
    } else {
      const segment = parseSegment(str(first.segmen)) as CustomerSegment;
      const terms = await defaultCreditTerms(tx, segment, date);
      const credit = parseCreditStatus(str(first.status_kredit));
      const time = str(first.jam_terima)?.replace(".", ":") ?? null;
      const [c] = await tx
        .insert(customers)
        .values({
          tenantId: batch.tenantId,
          code,
          name: String(first.nama),
          segment,
          waPhone: normalizeWaNumber(String(first.nomor_wa))!,
          contactName: str(first.nama_kontak),
          notes: str(first.catatan),
          fixedReceiveTime: time ? time.padStart(5, "0") : null,
          creditStatus: "cash",
          creditLimit: terms.creditLimit,
          paymentTermDays: terms.paymentTermDays,
          isInitialData: batch.isInitialData,
          importBatchId: batch.id,
          createdBy: ctx.userId,
        })
        .returning();
      customerId = c!.id;
      created++;
      bySegment[label("customer_segment", segment)] = (bySegment[label("customer_segment", segment)] ?? 0) + 1;
      if (credit === "credit_migrated") {
        tempoMigrasi.push({ customerId, code, name: c!.name, creditLimit: Number(num(first.batas_kredit)), paymentTermDays: Number(num(first.tempo_hari)) });
      }
      await auditRecord(tx, {
        ctx,
        objectType: "customer",
        objectId: customerId,
        action: "create",
        after: c,
        reason: decision.decision === "create_new" ? `Impor data awal — dikonfirmasi bukan duplikat: ${decision.reason}` : "Impor data awal.",
        rule: "US-M1-06",
      });
    }
    createdByCode.set(code, customerId);
    for (const r of group) await addAddress(customerId, r);
  }
  return {
    kind: "customers",
    mode: batch.isInitialData ? "production" : "test",
    created,
    merged,
    excluded: 0,
    bySegment,
    byZone,
    addressesLocked,
    addressesUnlocked,
    tempoMigrasi,
    tempoMigrasiTotalLimit: tempoMigrasi.reduce((s, t) => s + t.creditLimit, 0),
  };
}

async function commitCustomerPrices(tx: Tx, ctx: ActorContext, batch: BatchRow, rows: ImportRow[]): Promise<ImportSummary> {
  let created = 0;
  let total = 0;
  for (const r of rows) {
    const d = rowData(r);
    const [cust] = await tx.select().from(customers).where(and(eq(customers.tenantId, batch.tenantId), eq(customers.code, String(d.kode_pelanggan)))).limit(1);
    if (!cust) throw new DomainError("CUSTOMER_MISSING", `Pelanggan ${d.kode_pelanggan} tidak ditemukan.`);
    let addressId: string | null = null;
    const lbl = str(d.label_alamat);
    if (lbl) {
      const addrs = await tx.select().from(customerAddresses).where(eq(customerAddresses.customerId, cust.id));
      addressId = addrs.find((a) => normalizeText(a.label) === normalizeText(lbl))?.id ?? null;
    }
    const prev = await tx
      .select({ id: customerLegacyPrices.id, addressId: customerLegacyPrices.addressId })
      .from(customerLegacyPrices)
      .where(and(eq(customerLegacyPrices.customerId, cust.id), eq(customerLegacyPrices.isCurrent, true)));
    for (const p of prev.filter((x) => x.addressId === addressId)) {
      await tx.update(customerLegacyPrices).set({ isCurrent: false, supersededAt: ctx.now }).where(eq(customerLegacyPrices.id, p.id));
    }
    const price = Number(num(d.harga_per_rit));
    const [row] = await tx
      .insert(customerLegacyPrices)
      .values({ tenantId: batch.tenantId, customerId: cust.id, addressId, pricePerTrip: price, notes: str(d.catatan), importBatchId: batch.id, createdBy: ctx.userId })
      .returning();
    await auditRecord(tx, { ctx, objectType: "customer_legacy_price", objectId: row!.id, action: "create", after: { customer: cust.code, addressId, pricePerTrip: price }, rule: "US-M1-06 KP-1" });
    await markRow(tx, r.id, "customer_legacy_price", row!.id);
    created++;
    total += price;
  }
  return { kind: "customer_prices", mode: batch.isInitialData ? "production" : "test", created, excluded: 0, averagePrice: created ? Math.round(total / created) : 0 };
}

async function commitTrucks(tx: Tx, ctx: ActorContext, batch: BatchRow, rows: ImportRow[]): Promise<ImportSummary> {
  const pools = await tx.select().from(poolLocations).where(eq(poolLocations.tenantId, batch.tenantId));
  let created = 0;
  for (const r of rows) {
    const d = rowData(r);
    const pool = str(d.kode_pool) ? pools.find((p) => p.code.toUpperCase() === str(d.kode_pool)!.toUpperCase()) : undefined;
    const [t] = await tx
      .insert(trucks)
      .values({
        tenantId: batch.tenantId,
        code: String(d.kode).toUpperCase(),
        plateNumber: String(d.nopol).toUpperCase().replace(/\s+/g, " "),
        capacityL: num(d.kapasitas_l) ?? 5000,
        dailyTripCapacity: num(d.kapasitas_rit),
        poolLocationId: pool?.id ?? null,
        fleetDetectionEnabled: false,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "truck", objectId: t!.id, action: "create", after: t, reason: `Impor data awal baris ${r.rowNumber}.`, rule: "US-M1-06" });
    await markRow(tx, r.id, "truck", t!.id);
    created++;
  }
  return { kind: "trucks", mode: batch.isInitialData ? "production" : "test", created, excluded: 0 };
}

async function commitCrew(tx: Tx, ctx: ActorContext, batch: BatchRow, rows: ImportRow[]): Promise<ImportSummary> {
  let created = 0;
  for (const r of rows) {
    const d = rowData(r);
    const [t] = await tx.select().from(trucks).where(and(eq(trucks.tenantId, batch.tenantId), eq(trucks.code, String(d.kode_truk).toUpperCase())));
    if (!t) throw new DomainError("TRUCK_MISSING", `Truk ${d.kode_truk} tidak ditemukan.`);
    const find = async (no: string | null) => (no ? (await tx.select().from(employees).where(and(eq(employees.tenantId, batch.tenantId), eq(employees.employeeNo, no))))[0] : undefined);
    const driver = await find(str(d.no_sopir));
    const helper = await find(str(d.no_kernet));
    for (const e of [driver, helper].filter(Boolean)) {
      const clash = await tx
        .select({ code: trucks.code })
        .from(trucks)
        .where(and(ne(trucks.id, t.id), or(eq(trucks.defaultDriverEmployeeId, e!.id), eq(trucks.defaultHelperEmployeeId, e!.id))))
        .limit(1);
      if (clash[0]) throw new DomainError("CREW_ALREADY_DEFAULT", `${e!.fullName} sudah kru default truk ${clash[0].code}.`);
    }
    const patch = { defaultDriverEmployeeId: driver?.id ?? t.defaultDriverEmployeeId, defaultHelperEmployeeId: helper?.id ?? t.defaultHelperEmployeeId };
    await tx.update(trucks).set(patch).where(eq(trucks.id, t.id));
    await auditRecord(tx, { ctx, objectType: "truck", objectId: t.id, action: "update", before: { defaultDriverEmployeeId: t.defaultDriverEmployeeId, defaultHelperEmployeeId: t.defaultHelperEmployeeId }, after: patch, reason: `Impor kru default baris ${r.rowNumber}.`, rule: "US-M1-03 KP-3" });
    await markRow(tx, r.id, "truck", t.id);
    created++;
  }
  return { kind: "crew", mode: batch.isInitialData ? "production" : "test", created, excluded: 0 };
}

async function commitEmployees(tx: Tx, ctx: ActorContext, batch: BatchRow, rows: ImportRow[]): Promise<ImportSummary> {
  const os = await tx.select().from(outlets).where(eq(outlets.tenantId, batch.tenantId));
  const byRole: Record<string, number> = {};
  let created = 0;
  for (const r of rows) {
    const d = rowData(r);
    const roles = parseRoles(str(d.peran)).roles as RoleCode[];
    const outlet = str(d.kode_outlet) ? os.find((o) => o.code === str(d.kode_outlet)!.toUpperCase()) : undefined;
    const [e] = await tx
      .insert(employees)
      .values({
        tenantId: batch.tenantId,
        employeeNo: String(d.no_karyawan),
        fullName: String(d.nama),
        nickname: str(d.panggilan),
        position: String(d.jabatan),
        phone: str(d.telepon) ? normalizeWaNumber(String(d.telepon)) : null,
        workLocation: str(d.lokasi_tugas),
        primaryOutletId: outlet?.id ?? null,
        intendedRoles: roles,
        hireDate: str(d.tanggal_masuk),
        exitDate: str(d.tanggal_keluar),
        isActive: !(str(d.tanggal_keluar) && String(d.tanggal_keluar) <= ctxBusinessDate(ctx)),
        createdBy: ctx.userId,
      })
      .returning();
    for (const role of roles) byRole[label("role", role)] = (byRole[label("role", role)] ?? 0) + 1;
    await auditRecord(tx, { ctx, objectType: "employee", objectId: e!.id, action: "create", after: e, reason: `Impor data awal baris ${r.rowNumber}.`, rule: "US-M1-06" });
    await markRow(tx, r.id, "employee", e!.id);
    created++;
  }
  return { kind: "employees", mode: batch.isInitialData ? "production" : "test", created, excluded: 0, byRole };
}

async function commitOutlets(tx: Tx, ctx: ActorContext, batch: BatchRow, rows: ImportRow[]): Promise<ImportSummary> {
  const emps = await tx.select().from(employees).where(eq(employees.tenantId, batch.tenantId));
  let created = 0;
  let depots = 0;
  for (const r of rows) {
    const d = rowData(r);
    const kind = lookupLabel<"depot" | "store">("outlet_kind", str(d.jenis))!;
    const op = str(d.no_operator) ? emps.find((e) => e.employeeNo === str(d.no_operator)) : undefined;
    const [o] = await tx
      .insert(outlets)
      .values({
        tenantId: batch.tenantId,
        code: String(d.kode).toUpperCase(),
        name: String(d.nama),
        kind,
        address: str(d.alamat),
        lat: coord(d.lat),
        lng: coord(d.lng),
        geofenceRadiusM: num(d.radius_geofence_m),
        storageCapacityL: num(d.kapasitas_simpan_l),
        defaultOperatorEmployeeId: op?.id ?? null,
        activatedOn: ctxBusinessDate(ctx),
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "outlet", objectId: o!.id, action: "create", after: o, reason: `Impor data awal baris ${r.rowNumber}.`, rule: "US-M1-06" });
    if (kind === "depot") {
      depots++;
      await ensureInternalCustomer(tx, ctx, o!);
    }
    await markRow(tx, r.id, "outlet", o!.id);
    created++;
  }
  return { kind: "outlets", mode: batch.isInitialData ? "production" : "test", created, excluded: 0, depots, stores: created - depots };
}

async function commitWaterSources(tx: Tx, ctx: ActorContext, batch: BatchRow, rows: ImportRow[]): Promise<ImportSummary> {
  let created = 0;
  let meters = 0;
  for (const r of rows) {
    const d = rowData(r);
    const [s] = await tx
      .insert(waterSources)
      .values({
        tenantId: batch.tenantId,
        code: String(d.kode).toUpperCase(),
        name: String(d.nama),
        address: str(d.alamat),
        lat: coord(d.lat)!,
        lng: coord(d.lng)!,
        dailyCapacityL: num(d.kapasitas_harian_l) ?? 50_000,
        geofenceRadiusM: num(d.radius_geofence_m),
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "water_source", objectId: s!.id, action: "create", after: s, reason: `Impor data awal baris ${r.rowNumber}.`, rule: "US-M1-06" });
    if (str(d.kode_meter)) {
      const unit = lookupLabel<"liter" | "cubic_meter">("meter_unit", str(d.satuan_meter)) ?? "liter";
      const [m] = await tx
        .insert(waterMeters)
        .values({ waterSourceId: s!.id, code: String(d.kode_meter), unit, initialReadingL: Number(num(d.angka_awal_l)), installedAt: ctxBusinessDate(ctx), createdBy: ctx.userId })
        .returning();
      await auditRecord(tx, { ctx, objectType: "water_meter", objectId: m!.id, action: "create", after: m, rule: "US-M1-06" });
      meters++;
    }
    await markRow(tx, r.id, "water_source", s!.id);
    created++;
  }
  return { kind: "water_sources", mode: batch.isInitialData ? "production" : "test", created, excluded: 0, meters };
}

// =====================================================================================================================
// Kueri
// =====================================================================================================================

/** Daftar batch impor (terbaru dulu). */
export async function listImportBatches(ctx: ActorContext, opts: { tx?: Tx; limit?: number } = {}) {
  await authorizeAny(ctx, ["m1.import.read", "m1.import.create"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return tx
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.tenantId, ctx.tenantId), inArray(importBatches.kind, [...Object.keys(IMPORT_DEFS)] as BatchRow["kind"][])))
    .orderBy(desc(importBatches.createdAt))
    .limit(opts.limit ?? 50);
}

/** Batch + baris (laporan validasi per baris). */
export async function getImportBatch(ctx: ActorContext, batchId: string, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m1.import.read", "m1.import.create"], { tx: opts.tx, objectType: "import_batch", objectId: batchId });
  const tx = opts.tx ?? getDb();
  const batch = await loadBatch(tx, ctx, batchId);
  const rows = await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batchId)).orderBy(asc(importBatchRows.rowNumber));
  return { batch, rows, def: IMPORT_DEFS[assertKind(batch.kind)] };
}

/** Jenis yang sudah diimpor produksi (untuk status go-live). */
export async function productionImportsDone(tx: Tx, tenantId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ kind: importBatches.kind })
    .from(importBatches)
    .where(and(eq(importBatches.tenantId, tenantId), eq(importBatches.isInitialData, true), eq(importBatches.status, "committed"), isNotNull(importBatches.committedAt)));
  return new Set(rows.map((r) => r.kind));
}
