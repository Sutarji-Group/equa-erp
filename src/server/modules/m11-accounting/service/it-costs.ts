/**
 * M11 — laporan biaya komunikasi, cloud, peta, GPS & WhatsApp bulanan (NFR-29, US-P2-08 KP-3; B-67).
 *
 * - Biaya langganan (cloud, peta, GPS, aplikasi) dicatat bulanan lewat jurnal manual ke akun beban yang ditetapkan
 *   parameter `m11.it_cost_report.account_codes` (bawaan 6-2001 "Beban komunikasi, cloud & aplikasi", termasuk anak
 *   akun) — dihitung per PERIODE POSTING seperti laporan keuangan.
 * - Biaya pesan WhatsApp Business API dibaca dari catatan per pesan tertagih (`wa_message_costs`, P2
 *   `waCostForMonth`) per kategori Meta — terpisah dari jurnal (informasi pemakaian; tagihan Meta tetap dijurnal manual).
 * - Dibandingkan dengan anggaran bulanan parameter (`monthly_budget`, 0 = tanpa anggaran).
 */
import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { accountingPeriods, accounts, journalLines, journals } from "@/db/schema";
import { lastDayOfMonth, monthOf } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { authorize } from "@/server/core/rbac";
import * as p2 from "@/server/modules/p2-customer";

import { isPeriodLabel } from "./common";

export type ItCostReport = {
  period: string;
  accountCodes: string[];
  /** Beban terjurnal per akun (debit − kredit, jurnal terposting pada periode). */
  journaled: { accountId: string; code: string; name: string; amount: number }[];
  journaledTotal: number;
  /** Pemakaian WhatsApp Business API (catatan per pesan tertagih). */
  whatsapp: { totalCost: number; billableMessages: number; byCategory: { category: string; count: number; amount: number }[] };
  budget: number;
  /** Beban terjurnal dibandingkan anggaran (null bila tanpa anggaran). */
  budgetUsedPct: number | null;
  overBudget: boolean;
};

/** Laporan biaya bulanan tanpa otorisasi (dipakai layar & ekspor). */
export async function computeItCostReport(tx: Tx, tenantId: string, period: string): Promise<ItCostReport> {
  const cfg = await params.get(tx, "m11.it_cost_report", lastDayOfMonth(`${period}-01`), { tenantId });
  const codes = cfg.account_codes;
  // Akun yang dipilih + seluruh anak akunnya (menurut induk).
  const all = await tx.select({ id: accounts.id, code: accounts.code, name: accounts.name, parentId: accounts.parentId }).from(accounts).where(eq(accounts.tenantId, tenantId));
  const selected = new Set(all.filter((a) => codes.includes(a.code)).map((a) => a.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of all) {
      if (a.parentId && selected.has(a.parentId) && !selected.has(a.id)) {
        selected.add(a.id);
        grew = true;
      }
    }
  }
  const ids = [...selected];
  const rows = ids.length
    ? await tx
        .select({ accountId: journalLines.accountId, d: sql<string>`coalesce(sum(${journalLines.debit}), 0)`, c: sql<string>`coalesce(sum(${journalLines.credit}), 0)` })
        .from(journalLines)
        .innerJoin(journals, eq(journals.id, journalLines.journalId))
        .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
        .where(and(eq(journals.tenantId, tenantId), eq(journals.status, "posted"), eq(accountingPeriods.period, period), inArray(journalLines.accountId, ids)))
        .groupBy(journalLines.accountId)
    : [];
  const byId = new Map(all.map((a) => [a.id, a]));
  const journaled = rows
    .map((r) => ({ accountId: r.accountId, code: byId.get(r.accountId)?.code ?? "", name: byId.get(r.accountId)?.name ?? "", amount: Number(r.d) - Number(r.c) }))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
  const journaledTotal = journaled.reduce((s, r) => s + r.amount, 0);
  const wa = await p2.waCostForMonth(tx, tenantId, period);
  const budget = cfg.monthly_budget;
  return {
    period,
    accountCodes: codes,
    journaled,
    journaledTotal,
    whatsapp: { totalCost: wa.totalCost, billableMessages: wa.billableMessages, byCategory: wa.byCategory },
    budget,
    budgetUsedPct: budget > 0 ? Math.round((journaledTotal / budget) * 10_000) / 100 : null,
    overBudget: budget > 0 && journaledTotal > budget,
  };
}

/** Layar/ekspor "Biaya komunikasi, cloud & WhatsApp" per periode (izin laporan keuangan). */
export async function itCostReport(ctx: ActorContext, filter: { period?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<ItCostReport> {
  await authorize(ctx, "m11.financial_report.read", { tx: opts.tx });
  const period = filter.period && isPeriodLabel(filter.period) ? filter.period : monthOf(ctxBusinessDate(ctx));
  return computeItCostReport(opts.tx ?? getDb(), ctx.tenantId, period);
}
