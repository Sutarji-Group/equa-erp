/**
 * M11 — daftar tunggu jurnal (US-M11-02 KP-3): jurnal otomatis yang gagal terposting (pemetaan hilang, akun nonaktif,
 * jurnal asal belum ada) tersimpan dengan alasan; Admin Keuangan memproses ulang setelah memperbaiki pemetaan/akun.
 * Setelah pemetaan diperbarui, antrean peristiwa terkait diproses ulang otomatis. Tidak ada peristiwa yang hilang.
 */
import "server-only";

import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { journalQueue, journals } from "@/db/schema";
import { toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withSavepoint, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { authorize, runService } from "@/server/core/rbac";

import { processEvent } from "./engine";
import { loadDomainEvent, type AutoResult } from "./posting";

export type QueueRow = typeof journalQueue.$inferSelect;

export async function listJournalQueue(
  ctx: ActorContext,
  filter: { status?: "pending" | "resolved" | "all"; upTo?: BusinessDate | null } = {},
  opts: { tx?: Tx } = {},
): Promise<QueueRow[]> {
  await authorize(ctx, "m11.journal_queue.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds = [eq(journalQueue.tenantId, ctx.tenantId)];
  const status = filter.status ?? "pending";
  if (status !== "all") conds.push(eq(journalQueue.status, status));
  if (filter.upTo) conds.push(lte(journalQueue.journalDate, filter.upTo));
  return tx
    .select()
    .from(journalQueue)
    .where(and(...conds))
    .orderBy(status === "pending" ? asc(journalQueue.journalDate) : desc(journalQueue.updatedAt))
    .limit(500);
}

/** Jumlah antrean menunggu s.d. tanggal (prasyarat tutup periode). */
export async function pendingQueueCount(tx: Tx, tenantId: string, upTo: BusinessDate): Promise<number> {
  const rows = await tx
    .select({ id: journalQueue.id })
    .from(journalQueue)
    .where(and(eq(journalQueue.tenantId, tenantId), eq(journalQueue.status, "pending"), lte(journalQueue.journalDate, upTo)));
  return rows.length;
}

/** Proses ulang satu baris antrean (tanpa otorisasi — dipanggil layanan/job). */
export async function retryQueueRow(tx: Tx, row: QueueRow, today: BusinessDate): Promise<AutoResult> {
  if (row.status !== "pending") return { status: "duplicate", journalIds: row.resolvedJournalId ? [row.resolvedJournalId] : [] };
  if (!row.domainEventId) {
    throw new DomainError("QUEUE_NO_EVENT", "Baris antrean ini tidak berasal dari peristiwa tersimpan; catat sebagai jurnal manual beralasan.");
  }
  const event = await loadDomainEvent(tx, row.domainEventId);
  if (!event) throw new NotFoundError("Peristiwa sumber antrean tidak ditemukan.");
  return processEvent(tx, event, { queueItemId: row.id, today });
}

const retrySchema = z.object({ queueId: z.uuid({ error: "Pilih baris antrean." }) }).strict();

/** Proses ulang satu baris antrean (Admin Keuangan). */
export async function retryJournalQueueItem(ctx: ActorContext, input: z.input<typeof retrySchema>, opts: { tx?: Tx } = {}): Promise<AutoResult> {
  await authorize(ctx, "m11.journal_queue.retry", { tx: opts.tx });
  const data = parseInput(retrySchema, input);
  return runService(ctx, opts, async (tx) => {
    const [row] = await tx.select().from(journalQueue).where(and(eq(journalQueue.id, data.queueId), eq(journalQueue.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!row) throw new NotFoundError("Baris antrean tidak ditemukan.");
    if (row.status !== "pending") throw new DomainError("QUEUE_DONE", "Baris antrean ini sudah terposting.");
    const result = await retryQueueRow(tx, row, ctxBusinessDate(ctx));
    await auditRecord(tx, { ctx, objectType: "journal_queue", objectId: row.id, action: "retry", before: { status: row.status, reason: row.reason }, after: result, rule: "US-M11-02 KP-3" });
    return result;
  });
}

export type RetrySummary = { tried: number; posted: number; stillQueued: number; skipped: number; errors: { id: string; message: string }[] };

/** Proses ulang semua antrean menunggu (opsional per kunci peristiwa) — terisolasi per baris. */
export async function retryPendingQueue(tx: Tx, tenantId: string, opts: { eventKeys?: string[]; today?: BusinessDate } = {}): Promise<RetrySummary> {
  const conds = [eq(journalQueue.tenantId, tenantId), eq(journalQueue.status, "pending")];
  if (opts.eventKeys?.length) conds.push(inArray(journalQueue.eventKey, opts.eventKeys));
  const rows = await tx.select().from(journalQueue).where(and(...conds)).orderBy(asc(journalQueue.createdAt)).limit(1000);
  const out: RetrySummary = { tried: 0, posted: 0, stillQueued: 0, skipped: 0, errors: [] };
  const today = opts.today ?? toBusinessDate(new Date());
  for (const row of rows) {
    if (!row.domainEventId) continue;
    out.tried++;
    try {
      const res = await withSavepoint(tx, (sp) => retryQueueRow(sp, row, today));
      if (res.status === "posted" || res.status === "duplicate") out.posted++;
      else if (res.status === "queued") out.stillQueued++;
      else out.skipped++;
    } catch (error) {
      out.errors.push({ id: row.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

/** Proses ulang seluruh antrean menunggu (Admin Keuangan). */
export async function retryAllJournalQueue(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<RetrySummary> {
  await authorize(ctx, "m11.journal_queue.retry", { tx: opts.tx });
  return runService(ctx, opts, async (tx) => {
    const summary = await retryPendingQueue(tx, ctx.tenantId, { today: ctxBusinessDate(ctx) });
    await auditRecord(tx, { ctx, objectType: "journal_queue", objectId: ctx.tenantId, action: "retry_all", after: summary, rule: "US-M11-02 KP-3" });
    return summary;
  });
}

/** Jurnal yang dihasilkan satu baris antrean (setelah terposting). */
export async function queueResolution(tx: Tx, queueId: string) {
  const [row] = await tx.select().from(journalQueue).where(eq(journalQueue.id, queueId)).limit(1);
  if (!row?.resolvedJournalId) return null;
  const [j] = await tx.select({ id: journals.id, number: journals.number }).from(journals).where(eq(journals.id, row.resolvedJournalId)).limit(1);
  return j ?? null;
}
