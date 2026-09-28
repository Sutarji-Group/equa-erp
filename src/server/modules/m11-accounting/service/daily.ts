/**
 * M11 — rekonsiliasi jurnal per hari per modul dengan ringkasan H+0 (US-M11-02 KP-5): jumlah & nilai peristiwa
 * operasional hari itu (sumber H+0) dibandingkan dengan jurnal otomatis bertanggal sama; selisih ditandai beserta
 * peristiwa yang masih di daftar tunggu/dilewati — tidak ada peristiwa yang terlewat diam-diam.
 */
import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { accounts, dailySummaries, domainEvents, journalLines, journalQueue, journals } from "@/db/schema";
import type { BusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { authorize } from "@/server/core/rbac";

export type DailyReconRow = {
  key: string;
  module: string;
  label: string;
  events: number;
  eventValue: number;
  journals: number;
  journalValue: number;
  queued: number;
  match: boolean;
};

type GroupDef = {
  key: string;
  module: string;
  label: string;
  eventType: string;
  include: (p: Record<string, unknown>) => boolean;
  eventValue: (p: Record<string, unknown>) => number;
  /** Nilai jurnal: pendapatan bersih (kredit − debit akun pendapatan) atau debit akun kas/bank. */
  journalValue: "revenue" | "cash_debit";
};

const n = (v: unknown) => (typeof v === "number" ? v : 0);

const GROUPS: GroupDef[] = [
  { key: "trip", module: "M3", label: "Rit air truk Selesai", eventType: "trip.completed", include: (p) => !p.isInternal, eventValue: (p) => n(p.cashReceived) + n(p.transferAmount) + n(p.creditAmount) + n(p.underpaymentAmount), journalValue: "revenue" },
  { key: "pos_depot", module: "M6", label: "Penjualan POS depot", eventType: "pos_sale.recorded", include: (p) => p.outletKind !== "store", eventValue: (p) => n(p.total), journalValue: "revenue" },
  { key: "pos_store", module: "M7", label: "Penjualan toko", eventType: "pos_sale.recorded", include: (p) => p.outletKind === "store", eventValue: (p) => n(p.total), journalValue: "revenue" },
  { key: "deposit", module: "M4", label: "Setoran diterima", eventType: "deposit.received", include: () => true, eventValue: (p) => n(p.receivedAmount), journalValue: "cash_debit" },
];

export async function dailyReconciliationTx(tx: Tx, tenantId: string, date: BusinessDate): Promise<{ date: string; rows: DailyReconRow[]; h0Published: boolean }> {
  const out: DailyReconRow[] = [];
  for (const g of GROUPS) {
    const evs = await tx
      .select({ id: domainEvents.id, payload: domainEvents.payload })
      .from(domainEvents)
      .where(and(eq(domainEvents.tenantId, tenantId), eq(domainEvents.type, g.eventType), eq(domainEvents.businessDate, date)));
    const included = evs.filter((e) => g.include(e.payload));
    const ids = included.map((e) => e.id);
    let journalCount = 0;
    let journalValue = 0;
    let queued = 0;
    if (ids.length) {
      const js = await tx.select({ id: journals.id }).from(journals).where(and(inArray(journals.sourceEventId, ids), eq(journals.kind, "auto"), eq(journals.status, "posted")));
      journalCount = js.length;
      if (js.length) {
        const [v] = await tx
          .select({
            rev: sql<string>`coalesce(sum(case when ${accounts.type} = 'revenue' and not ${accounts.isInternalTransfer} then ${journalLines.credit} - ${journalLines.debit} else 0 end),0)`,
            cash: sql<string>`coalesce(sum(case when ${accounts.isCash} then ${journalLines.debit} else 0 end),0)`,
          })
          .from(journalLines)
          .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
          .where(
            inArray(
              journalLines.journalId,
              js.map((j) => j.id),
            ),
          );
        journalValue = Number(g.journalValue === "revenue" ? v?.rev : v?.cash);
      }
      queued = (await tx.select({ id: journalQueue.id }).from(journalQueue).where(and(inArray(journalQueue.domainEventId, ids), eq(journalQueue.status, "pending")))).length;
    }
    const eventValue = included.reduce((s, e) => s + g.eventValue(e.payload), 0);
    out.push({ key: g.key, module: g.module, label: g.label, events: included.length, eventValue, journals: journalCount, journalValue, queued, match: included.length === journalCount && eventValue === journalValue });
  }
  const [h0] = await tx.select({ status: dailySummaries.status }).from(dailySummaries).where(and(eq(dailySummaries.tenantId, tenantId), eq(dailySummaries.businessDate, date))).limit(1);
  return { date, rows: out, h0Published: !!h0 && h0.status !== "running" };
}

/** Rekonsiliasi jurnal per hari per modul vs peristiwa H+0 (akuntan & Admin Keuangan). */
export async function dailyReconciliation(ctx: ActorContext, input: { date: BusinessDate }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.journal.read", { tx: opts.tx });
  return dailyReconciliationTx(opts.tx ?? getDb(), ctx.tenantId, input.date);
}
