/**
 * M11 — alokasi biaya bulanan (US-M11-01 KP-3/KP-5):
 * - L1 (produksi air) = pusat biaya → dialokasikan ke L2 (air truk) & L3 (depot) menurut proporsi volume pengisian
 *   bulan itu (PAR-65 `fill_volume_monthly`, M8 `fillTotalsByDay`: pengisian pelanggan → L2, pasokan depot → L3).
 * - Biaya bersama (SHARED) → dialokasikan ke lini menurut kunci pemilik (`m11.shared_cost_allocation`: omzet atau
 *   persentase tetap) atau dibiarkan di pusat biaya bersama.
 * Jurnal alokasi memakai akun khusus dari pemetaan `m11.allocation` sehingga tampil TERPISAH pada laba rugi per lini.
 */
import "server-only";

import { and, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { accountingPeriods, accounts, costAllocationRuns, journalLines, journals, waterSources } from "@/db/schema";
import type { ProfitCenter } from "@/lib/labels";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { fillTotalsByDay } from "@/server/modules/m8-production";

import { LINE_PROFIT_CENTERS } from "../constants";
import { insertJournal, isOpenStatus, loadPeriod, mappingAccounts, type PeriodRow } from "./common";

type Kind = "l1_allocation" | "shared_costs";

/** Biaya bersih (debit − kredit) akun beban pada pusat laba dalam periode posting, tanpa akun alokasi. */
async function costOf(tx: Tx, tenantId: string, periodId: string, profitCenter: ProfitCenter, excludeAccountIds: readonly string[]): Promise<number> {
  const rows = await tx
    .select({ accountId: journalLines.accountId, d: sql<string>`coalesce(sum(${journalLines.debit}),0)`, c: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journals.tenantId, tenantId), eq(journals.status, "posted"), eq(journals.periodId, periodId), eq(journalLines.profitCenter, profitCenter), eq(accounts.type, "expense")))
    .groupBy(journalLines.accountId);
  return rows.filter((r) => !excludeAccountIds.includes(r.accountId)).reduce((s, r) => s + Number(r.d) - Number(r.c), 0);
}

/** Omzet luar (pendapatan non-internal) per lini dalam periode — dasar kunci "omzet". */
async function revenueByLine(tx: Tx, tenantId: string, periodId: string): Promise<Record<string, number>> {
  const rows = await tx
    .select({ pc: journalLines.profitCenter, d: sql<string>`coalesce(sum(${journalLines.debit}),0)`, c: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journals.tenantId, tenantId), eq(journals.status, "posted"), eq(journals.periodId, periodId), eq(accounts.type, "revenue"), eq(accounts.isInternalTransfer, false)))
    .groupBy(journalLines.profitCenter);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.pc] = Number(r.c) - Number(r.d);
  return out;
}

/** Bagi `total` menurut bobot (pembulatan ke rupiah; sisa ke bobot terbesar). */
export function splitByWeights(total: number, weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights).filter((k) => weights[k]! > 0);
  const sum = keys.reduce((s, k) => s + weights[k]!, 0);
  const out: Record<string, number> = {};
  if (sum <= 0 || total === 0) return out;
  let allocated = 0;
  for (const k of keys) {
    out[k] = Math.floor((total * weights[k]!) / sum);
    allocated += out[k]!;
  }
  const biggest = keys.reduce((a, b) => (weights[a]! >= weights[b]! ? a : b));
  out[biggest] = out[biggest]! + (total - allocated);
  return out;
}

export type AllocationPreview = {
  kind: Kind;
  period: string;
  basis: Record<string, unknown>;
  total: number;
  shares: Record<string, number>;
  required: boolean;
  posted: { id: string; journalId: string | null } | null;
  message: string | null;
};

async function postedRun(tx: Tx, periodId: string, kind: Kind) {
  const [r] = await tx.select().from(costAllocationRuns).where(and(eq(costAllocationRuns.periodId, periodId), eq(costAllocationRuns.kind, kind), eq(costAllocationRuns.status, "posted"))).limit(1);
  return r ?? null;
}

/** Pratinjau alokasi L1 → L2/L3 (PAR-65). */
export async function previewL1Allocation(tx: Tx, period: PeriodRow): Promise<AllocationPreview> {
  const map = await mappingAccounts(tx, period.tenantId, "m11.allocation", "l1_allocation", period.endDate).catch(() => null);
  const exclude = map ? [map.debitAccountId, map.creditAccountId] : [];
  const total = await costOf(tx, period.tenantId, period.id, "L1", exclude);
  const { basis } = await params.get(tx, "PAR-65", period.endDate);
  const sources = await tx.select({ id: waterSources.id }).from(waterSources).where(eq(waterSources.tenantId, period.tenantId));
  const fills = await fillTotalsByDay(
    tx,
    sources.map((s) => s.id),
    period.startDate,
    period.endDate,
  );
  let customerL = 0;
  let depotL = 0;
  for (const f of fills.values()) {
    customerL += f.customerL;
    depotL += f.depotL;
  }
  const shares = splitByWeights(total, { L2: Math.max(0, customerL), L3: Math.max(0, depotL) });
  const run = await postedRun(tx, period.id, "l1_allocation");
  return {
    kind: "l1_allocation",
    period: period.period,
    basis: { rule: basis, customerL, depotL },
    total,
    shares,
    required: total !== 0,
    posted: run ? { id: run.id, journalId: run.journalId } : null,
    message: !map ? "Pemetaan m11.allocation / l1_allocation belum ada." : total !== 0 && customerL + depotL <= 0 ? "Belum ada volume pengisian bulan ini — alokasi tidak dapat dihitung." : null,
  };
}

/** Pratinjau alokasi biaya bersama menurut kunci pemilik. */
export async function previewSharedAllocation(tx: Tx, period: PeriodRow): Promise<AllocationPreview> {
  const key = await params.get(tx, "m11.shared_cost_allocation", period.endDate, { tenantId: period.tenantId });
  const map = await mappingAccounts(tx, period.tenantId, "m11.allocation", "shared_costs", period.endDate).catch(() => null);
  const exclude = map ? [map.debitAccountId, map.creditAccountId] : [];
  const l1Map = await mappingAccounts(tx, period.tenantId, "m11.allocation", "l1_allocation", period.endDate).catch(() => null);
  if (l1Map) exclude.push(l1Map.debitAccountId, l1Map.creditAccountId);
  const total = key.basis === "none" ? 0 : await costOf(tx, period.tenantId, period.id, "SHARED", exclude);
  let weights: Record<string, number> = {};
  if (key.basis === "revenue") {
    const rev = await revenueByLine(tx, period.tenantId, period.id);
    for (const pc of LINE_PROFIT_CENTERS) weights[pc] = Math.max(0, rev[pc] ?? 0);
  } else if (key.basis === "fixed") {
    weights = { ...(key.fixed_percents ?? {}) } as Record<string, number>;
  }
  const run = await postedRun(tx, period.id, "shared_costs");
  return {
    kind: "shared_costs",
    period: period.period,
    basis: { rule: key.basis, weights },
    total,
    shares: splitByWeights(total, weights),
    required: key.basis !== "none" && total !== 0,
    posted: run ? { id: run.id, journalId: run.journalId } : null,
    message: key.basis === "none" ? "Kunci pemilik: biaya bersama dibiarkan di pusat biaya bersama." : !map ? "Pemetaan m11.allocation / shared_costs belum ada." : null,
  };
}

export async function allocationStatus(ctx: ActorContext, input: { periodId: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.financial_report.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const period = await loadPeriod(tx, ctx.tenantId, input.periodId);
  return { l1: await previewL1Allocation(tx, period), shared: await previewSharedAllocation(tx, period) };
}

const runSchema = z.object({ periodId: z.uuid(), kind: z.enum(["l1_allocation", "shared_costs"]) }).strict();

/** Posting alokasi (Admin Keuangan) — satu kali per periode & jenis. */
export async function runCostAllocation(ctx: ActorContext, input: z.input<typeof runSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.cost_allocation.run", { tx: opts.tx });
  const data = parseInput(runSchema, input);
  return runService(ctx, opts, async (tx) => {
    const period = await loadPeriod(tx, ctx.tenantId, data.periodId, { forUpdate: true });
    if (!isOpenStatus(period.status)) throw new DomainError("PERIOD_NOT_OPEN", `Periode ${period.period} sudah ditutup/dikunci.`);
    const preview = data.kind === "l1_allocation" ? await previewL1Allocation(tx, period) : await previewSharedAllocation(tx, period);
    if (preview.posted) throw new DomainError("ALLOCATION_POSTED", "Alokasi periode ini sudah terposting.");
    if (!preview.required) throw new DomainError("ALLOCATION_NOT_REQUIRED", preview.message ?? "Tidak ada biaya untuk dialokasikan.");
    if (preview.message) throw new DomainError("ALLOCATION_BLOCKED", preview.message);
    const map = await mappingAccounts(tx, ctx.tenantId, "m11.allocation", data.kind, period.endDate);
    const from: ProfitCenter = data.kind === "l1_allocation" ? "L1" : "SHARED";
    const lines = [
      ...Object.entries(preview.shares)
        .filter(([, v]) => v > 0)
        .map(([pc, v]) => ({ accountId: map.debitAccountId, profitCenter: pc as ProfitCenter, debit: v, memo: `Alokasi ${from} → ${pc}` })),
      { accountId: map.creditAccountId, profitCenter: from, credit: preview.total, memo: `Alokasi keluar ${from}` },
    ];
    const { journal } = await insertJournal(tx, {
      tenantId: ctx.tenantId,
      kind: "allocation",
      date: period.endDate,
      description: data.kind === "l1_allocation" ? `Alokasi biaya produksi air L1 ${period.period} (volume pengisian)` : `Alokasi biaya bersama ${period.period}`,
      lines,
      ctx,
      sourceType: "m11.allocation",
      sourceObject: { type: "accounting_period", id: period.id },
      periodMode: "strict",
    });
    const [run] = await tx
      .insert(costAllocationRuns)
      .values({
        tenantId: ctx.tenantId,
        periodId: period.id,
        kind: data.kind,
        basis: preview.basis,
        totalAmount: preview.total,
        result: preview.shares,
        journalId: journal.id,
        status: "posted",
        postedBy: ctx.userId,
        postedAt: ctx.now,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "cost_allocation_run", objectId: run!.id, action: "post", after: { kind: data.kind, period: period.period, total: preview.total, shares: preview.shares, journal: journal.number }, rule: data.kind === "l1_allocation" ? "PTB-39, PAR-65" : "US-M11-01 KP-5" });
    return { run: run!, journal };
  });
}

const keySchema = z
  .object({
    basis: z.enum(["none", "revenue", "fixed"]),
    fixedPercents: z.record(z.enum(["L2", "L3", "L4", "L5"]), z.number().min(0).max(100)).nullable().optional(),
    effectiveFrom: z.string().nullable().optional(),
    reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }),
  })
  .strict();

/** Pemilik menetapkan kunci alokasi biaya bersama (parameter berjejak, 6.2b). */
export async function setSharedCostKey(ctx: ActorContext, input: z.input<typeof keySchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.cost_allocation.set", { tx: opts.tx });
  const data = parseInput(keySchema, input, { reason: "Alasan" });
  const effectiveFrom = data.effectiveFrom ?? ctxBusinessDate(ctx);
  return params.set(ctx, "m11.shared_cost_allocation", { basis: data.basis, fixed_percents: data.basis === "fixed" ? (data.fixedPercents ?? { L2: 0, L3: 0, L4: 0, L5: 0 }) : null }, effectiveFrom, data.reason, { tenantId: ctx.tenantId, tx: opts.tx });
}

/** Periode yang masih terbuka dengan alokasi belum terposting (dipakai layar). */
export async function periodsNeedingAllocation(tx: Tx, tenantId: string, from: string, to: string) {
  return tx
    .select()
    .from(accountingPeriods)
    .where(and(eq(accountingPeriods.tenantId, tenantId), gte(accountingPeriods.period, from), lte(accountingPeriods.period, to)));
}
