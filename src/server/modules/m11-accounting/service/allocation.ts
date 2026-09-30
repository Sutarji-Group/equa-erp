/**
 * M11 — alokasi biaya bulanan (US-M11-01 KP-3/KP-5):
 * - L1 (produksi air) = pusat biaya → dialokasikan ke L2 (air truk) & L3 (depot) menurut proporsi volume pengisian
 *   bulan itu (PAR-65 `fill_volume_monthly`, M8 `fillTotalsByDay`: pengisian pelanggan → L2, pasokan depot → L3).
 *   Bagian L3 dipecah PER OUTLET DEPOT menurut volume pasokan (diisi di sumber) tiap depot bulan itu (M8
 *   `supplyRows`/`summarizeSupply`) — "L3 depot per outlet" US-M11-01 KP-1 (B-56).
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
import { fillTotalsByDay, summarizeSupply, supplyRows } from "@/server/modules/m8-production";

import { LINE_PROFIT_CENTERS } from "../constants";
import { insertJournal, isOpenStatus, loadPeriod, mappingAccounts, type PeriodRow } from "./common";

type Kind = "l1_allocation" | "shared_costs";

/** Pesan pengguna (tanpa kunci teknis pemetaan — CLAUDE.md aturan 1). */
const MAPPING_MISSING_MESSAGE = "Akun jurnal alokasi biaya belum dipetakan. Lengkapi di Akuntansi > Pemetaan jurnal otomatis (Alokasi biaya).";

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
  /** B-56: bagian L3 per outlet depot (volume pasokan). Kosong bila tidak ada pasokan per depot tercatat. */
  l3ByOutlet: { outletId: string; code: string; name: string; liters: number; amount: number }[];
  required: boolean;
  posted: { id: string; journalId: string | null } | null;
  /** Biaya yang sudah dialokasikan run terposting periode ini (kumulatif). */
  allocated: number;
  /** Sisa biaya belum dialokasikan = total biaya pusat biaya saat ini − `allocated` (biaya susulan, penyusutan). */
  remaining: number;
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
  const run = await postedRun(tx, period.id, "l1_allocation");
  const allocated = run?.totalAmount ?? 0;
  const remaining = total - allocated;
  const shares = splitByWeights(remaining, { L2: Math.max(0, customerL), L3: Math.max(0, depotL) });
  // B-56: bagian L3 dibagi per outlet depot menurut volume pasokan (diisi di sumber) bulan itu.
  const supply = summarizeSupply(await supplyRows(tx, period.tenantId, { from: period.startDate, to: period.endDate }), "month").filter((s) => s.filledL > 0);
  const l3Split = shares.L3 ? splitByWeights(shares.L3, Object.fromEntries(supply.map((s) => [s.outletId, s.filledL]))) : {};
  const l3ByOutlet = supply
    .filter((s) => (l3Split[s.outletId] ?? 0) !== 0)
    .map((s) => ({ outletId: s.outletId, code: s.outletCode, name: s.outletName, liters: s.filledL, amount: l3Split[s.outletId]! }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return {
    kind: "l1_allocation",
    period: period.period,
    basis: { rule: basis, customerL, depotL, depotOutlets: l3ByOutlet.map((o) => ({ outletId: o.outletId, code: o.code, liters: o.liters, amount: o.amount })) },
    total,
    shares,
    l3ByOutlet,
    required: remaining !== 0,
    posted: run ? { id: run.id, journalId: run.journalId } : null,
    allocated,
    remaining,
    message: !map ? MAPPING_MISSING_MESSAGE : remaining !== 0 && customerL + depotL <= 0 ? "Belum ada volume pengisian bulan ini — alokasi tidak dapat dihitung. Catat pengisian truk/pasokan depot di Produksi dulu." : null,
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
  const allocated = run?.totalAmount ?? 0;
  const remaining = key.basis === "none" ? 0 : total - allocated;
  return {
    kind: "shared_costs",
    period: period.period,
    basis: { rule: key.basis, weights },
    total,
    shares: splitByWeights(remaining, weights),
    l3ByOutlet: [],
    required: key.basis !== "none" && remaining !== 0,
    posted: run ? { id: run.id, journalId: run.journalId } : null,
    allocated,
    remaining,
    message: key.basis === "none" ? "Kunci pemilik: biaya bersama dibiarkan di pusat biaya bersama." : !map ? MAPPING_MISSING_MESSAGE : null,
  };
}

export async function allocationStatus(ctx: ActorContext, input: { periodId: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.financial_report.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const period = await loadPeriod(tx, ctx.tenantId, input.periodId);
  return { l1: await previewL1Allocation(tx, period), shared: await previewSharedAllocation(tx, period) };
}

const runSchema = z.object({ periodId: z.uuid(), kind: z.enum(["l1_allocation", "shared_costs"]) }).strict();

/**
 * Posting alokasi (inti). Run pertama membuat baris `cost_allocation_runs`; biaya yang terposting SESUDAH alokasi
 * (tagihan susulan, jurnal manual susulan, penyusutan saat tutup periode) dialokasikan lewat run TAMBAHAN sebesar
 * sisanya (US-M11-01 KP-3, US-M11-10 KP-1) — baris run diperbarui kumulatif, tiap tambahan berjurnal sendiri.
 */
export async function postCostAllocation(tx: Tx, ctx: ActorContext, period: PeriodRow, kind: Kind) {
  const preview = kind === "l1_allocation" ? await previewL1Allocation(tx, period) : await previewSharedAllocation(tx, period);
  if (!preview.required) throw new DomainError("ALLOCATION_NOT_REQUIRED", preview.posted ? "Alokasi periode ini sudah mencakup seluruh biaya — tidak ada sisa untuk dialokasikan." : (preview.message ?? "Tidak ada biaya untuk dialokasikan."));
  if (preview.message) throw new DomainError("ALLOCATION_BLOCKED", preview.message);
  const map = await mappingAccounts(tx, ctx.tenantId, "m11.allocation", kind, period.endDate);
  const from: ProfitCenter = kind === "l1_allocation" ? "L1" : "SHARED";
  const amount = preview.remaining;
  const l3Total = preview.l3ByOutlet.reduce((s, o) => s + o.amount, 0);
  const splitL3 = preview.l3ByOutlet.length > 0 && l3Total === (preview.shares.L3 ?? 0);
  // Sisa negatif (biaya berkurang setelah alokasi) → arah jurnal dibalik.
  const side = (v: number) => (v >= 0 ? { debit: v } : { credit: -v });
  const lines = [
    ...Object.entries(preview.shares)
      .filter(([pc, v]) => v !== 0 && !(pc === "L3" && splitL3))
      .map(([pc, v]) => ({ accountId: map.debitAccountId, profitCenter: pc as ProfitCenter, ...side(v), memo: `Alokasi ${from} → ${pc}` })),
    // B-56: L3 per outlet depot (dimensi outlet pada baris jurnal).
    ...(splitL3 ? preview.l3ByOutlet.map((o) => ({ accountId: map.debitAccountId, profitCenter: "L3" as ProfitCenter, outletId: o.outletId, ...side(o.amount), memo: `Alokasi ${from} → L3 ${o.code} (${o.liters.toLocaleString("id-ID")} L)` })) : []),
    { accountId: map.creditAccountId, profitCenter: from, ...(amount >= 0 ? { credit: amount } : { debit: -amount }), memo: `Alokasi keluar ${from}` },
  ];
  const supplement = !!preview.posted;
  const { journal } = await insertJournal(tx, {
    tenantId: ctx.tenantId,
    kind: "allocation",
    date: period.endDate,
    description: `${kind === "l1_allocation" ? `Alokasi biaya produksi air L1 ${period.period} (volume pengisian)` : `Alokasi biaya bersama ${period.period}`}${supplement ? " — tambahan atas biaya susulan" : ""}`,
    lines,
    ctx,
    sourceType: "m11.allocation",
    sourceObject: { type: "accounting_period", id: period.id },
    periodMode: "strict",
  });
  let run;
  if (preview.posted) {
    const [prev] = await tx.select().from(costAllocationRuns).where(eq(costAllocationRuns.id, preview.posted.id)).limit(1);
    const supplements = [...(((prev?.result as { supplements?: unknown[] } | null)?.supplements ?? []) as unknown[]), { journalId: journal.id, amount, shares: preview.shares, at: ctx.now.toISOString() }];
    [run] = await tx
      .update(costAllocationRuns)
      .set({ totalAmount: preview.allocated + amount, result: { ...((prev?.result as Record<string, unknown>) ?? {}), supplements }, updatedAt: new Date() })
      .where(eq(costAllocationRuns.id, preview.posted.id))
      .returning();
  } else {
    [run] = await tx
      .insert(costAllocationRuns)
      .values({
        tenantId: ctx.tenantId,
        periodId: period.id,
        kind,
        basis: preview.basis,
        totalAmount: amount,
        result: preview.shares,
        journalId: journal.id,
        status: "posted",
        postedBy: ctx.userId,
        postedAt: ctx.now,
        createdBy: ctx.userId,
      })
      .returning();
  }
  await auditRecord(tx, {
    ctx,
    objectType: "cost_allocation_run",
    objectId: run!.id,
    action: supplement ? "post_supplement" : "post",
    after: { kind, period: period.period, amount, allocatedTotal: preview.allocated + amount, shares: preview.shares, journal: journal.number },
    rule: kind === "l1_allocation" ? "PTB-39, PAR-65" : "US-M11-01 KP-5",
  });
  return { run: run!, journal };
}

/** Posting alokasi (Admin Keuangan): run pertama, atau run tambahan untuk sisa biaya susulan. */
export async function runCostAllocation(ctx: ActorContext, input: z.input<typeof runSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.cost_allocation.run", { tx: opts.tx });
  const data = parseInput(runSchema, input);
  return runService(ctx, opts, async (tx) => {
    const period = await loadPeriod(tx, ctx.tenantId, data.periodId, { forUpdate: true });
    if (!isOpenStatus(period.status)) throw new DomainError("PERIOD_NOT_OPEN", `Periode ${period.period} sudah ditutup/dikunci.`);
    return postCostAllocation(tx, ctx, period, data.kind);
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
