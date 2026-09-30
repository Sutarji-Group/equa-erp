/**
 * M11 — pembangkitan jurnal retroaktif (US-M11-02 KP-4, US-M11-09 KP-4, PTB-47, R04): bila M11 menyusul modul
 * operasional, seluruh peristiwa sejak tanggal cut-over diputar ulang dari `domain_events` (payload mandiri) lewat
 * perlakuan yang SAMA dengan handler langsung. Idempoten per event (jurnal yang sudah ada = duplikat). Periode yang
 * tersentuh berlabel "dibangkitkan retroaktif" dan wajib diverifikasi akuntan sebelum periode pertama ditutup.
 */
import "server-only";

import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";

import { accountingPeriods, domainEvents, journals, periodReviewNotes, retroactiveRuns } from "@/db/schema";
import { monthOf, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withSavepoint, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import type { DomainEvent } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";

import { isJournaledEvent } from "./auto-journals";
import { currentCutover, m11Active } from "./common";
import { processEvent } from "./engine";

export type RetroactiveRunRow = typeof retroactiveRuns.$inferSelect;

const runSchema = z.object({ fromDate: z.string().nullable().optional() }).strict();

/** Bangkitkan jurnal retroaktif sejak cut-over (Admin Keuangan). Aman dijalankan ulang. */
export async function generateRetroactiveJournals(ctx: ActorContext, input: z.input<typeof runSchema> = {}, opts: { tx?: Tx } = {}): Promise<RetroactiveRunRow> {
  await authorize(ctx, "m11.retroactive.run", { tx: opts.tx });
  const data = parseInput(runSchema, input);
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    const cutover = await currentCutover(tx, today);
    if (!cutover) throw new DomainError("CUTOVER_REQUIRED", "Tetapkan tanggal cut-over akuntansi (tanggal 1) dulu di Akuntansi > Saldo awal.");
    if (!(await m11Active(tx, ctx.tenantId, today))) throw new DomainError("M11_INACTIVE", "Aktifkan jurnal otomatis M11 dulu (pemilik) setelah semua pemetaan lengkap.");
    const from: BusinessDate = data.fromDate && data.fromDate > cutover ? data.fromDate : cutover;
    const [run] = await tx.insert(retroactiveRuns).values({ tenantId: ctx.tenantId, fromDate: from, toDate: today, startedBy: ctx.userId, startedAt: ctx.now }).returning();
    let afterSeq = 0;
    const counts = { eventsScanned: 0, posted: 0, duplicates: 0, queued: 0, skipped: 0 };
    const periods = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const rows = await tx
        .select()
        .from(domainEvents)
        .where(and(eq(domainEvents.tenantId, ctx.tenantId), gt(domainEvents.seq, afterSeq)))
        .orderBy(asc(domainEvents.seq))
        .limit(500);
      if (!rows.length) break;
      for (const r of rows) {
        afterSeq = r.seq;
        if (!isJournaledEvent(r.type)) continue;
        const date = r.businessDate ?? toBusinessDate(r.occurredAt);
        if (date < from) continue;
        counts.eventsScanned++;
        const event: DomainEvent = {
          id: r.id,
          seq: r.seq,
          type: r.type as DomainEvent["type"],
          payload: r.payload as unknown as DomainEvent["payload"],
          occurredAt: r.occurredAt,
          businessDate: r.businessDate,
          tenantId: r.tenantId,
          actorUserId: r.actorUserId,
          source: r.source,
          objectType: r.objectType,
          objectId: r.objectId,
        };
        try {
          const res = await withSavepoint(tx, (sp) => processEvent(sp, event, { retroactive: true, today }));
          if (res.status === "posted") {
            counts.posted++;
            periods.add(monthOf(date));
          } else if (res.status === "duplicate") counts.duplicates++;
          else if (res.status === "queued") counts.queued++;
          else counts.skipped++;
        } catch {
          counts.queued++;
        }
      }
      if (rows.length < 500) break;
    }
    const periodList = [...periods].sort();
    if (periodList.length) {
      await tx
        .update(accountingPeriods)
        .set({ isRetroactive: true, updatedAt: new Date() })
        .where(and(eq(accountingPeriods.tenantId, ctx.tenantId), inArray(accountingPeriods.period, periodList)));
    }
    const [done] = await tx
      .update(retroactiveRuns)
      .set({ ...counts, periods: periodList, status: "done", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(retroactiveRuns.id, run!.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "retroactive_run", objectId: run!.id, action: "create", after: { from, to: today, ...counts, periods: periodList }, rule: "PTB-47" });
    await notify(tx, {
      event: "journal.retroactive_done",
      tenantId: ctx.tenantId,
      title: `Jurnal retroaktif dibangkitkan: ${counts.posted} jurnal baru`,
      body: `Peristiwa sejak ${from}: ${counts.eventsScanned} diperiksa, ${counts.duplicates} sudah ada, ${counts.queued} masuk daftar tunggu. Akuntan memverifikasi sebelum periode pertama ditutup.`,
      objectType: "retroactive_run",
      objectId: run!.id,
      link: "/akuntansi/periode",
      now: ctx.now,
    });
    return done!;
  });
}

const verifySchema = z.object({ runId: z.uuid(), note: z.string().trim().min(5, { error: "Catatan verifikasi wajib diisi (minimal 5 karakter)." }) }).strict();

/** Verifikasi akuntan atas jurnal retroaktif (catatan tersimpan pada setiap periode yang tersentuh). */
export async function verifyRetroactiveRun(ctx: ActorContext, input: z.input<typeof verifySchema>, opts: { tx?: Tx } = {}): Promise<RetroactiveRunRow> {
  await authorize(ctx, "m11.retroactive.attest", { tx: opts.tx });
  const data = parseInput(verifySchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const [run] = await tx.select().from(retroactiveRuns).where(and(eq(retroactiveRuns.id, data.runId), eq(retroactiveRuns.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!run) throw new NotFoundError("Pembangkitan retroaktif tidak ditemukan.");
    if (run.verifiedAt) throw new DomainError("ALREADY_VERIFIED", "Pembangkitan ini sudah diverifikasi.");
    const [row] = await tx
      .update(retroactiveRuns)
      .set({ verifiedBy: ctx.userId, verifiedAt: ctx.now, verificationNote: data.note, updatedAt: new Date() })
      .where(eq(retroactiveRuns.id, run.id))
      .returning();
    const periods = await tx
      .select()
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.tenantId, ctx.tenantId), inArray(accountingPeriods.period, run.periods.length ? run.periods : ["-"])));
    for (const p of periods) {
      await tx.insert(periodReviewNotes).values({ tenantId: ctx.tenantId, periodId: p.id, kind: "retroactive_verification", note: data.note, createdBy: ctx.userId });
    }
    await auditRecord(tx, { ctx, objectType: "retroactive_run", objectId: run.id, action: "attest", after: { verifiedAt: ctx.now, periods: run.periods }, reason: data.note, rule: "US-M11-02 KP-4" });
    return row!;
  });
}

export async function listRetroactiveRuns(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<RetroactiveRunRow[]> {
  await authorize(ctx, "m11.period.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return tx.select().from(retroactiveRuns).where(eq(retroactiveRuns.tenantId, ctx.tenantId)).orderBy(desc(retroactiveRuns.startedAt)).limit(50);
}

/** Periode retroaktif belum diverifikasi akuntan (prasyarat tutup periode). */
export async function unverifiedRetroactive(tx: Tx, tenantId: string, period: string): Promise<boolean> {
  const runs = await tx.select().from(retroactiveRuns).where(eq(retroactiveRuns.tenantId, tenantId));
  return runs.some((r) => r.periods.includes(period) && !r.verifiedAt);
}

/** Jurnal otomatis pada periode (untuk layar verifikasi). */
export async function autoJournalCount(tx: Tx, periodId: string): Promise<number> {
  const rows = await tx.select({ id: journals.id }).from(journals).where(and(eq(journals.periodId, periodId), eq(journals.kind, "auto")));
  return rows.length;
}
