/**
 * M11 — buku besar & laporan keuangan (US-M11-04): buku besar per akun & pusat laba; neraca saldo; laba rugi per lini
 * (L1–L5, SHARED; alokasi L1 & biaya bersama terpisah) dan konsolidasi (eliminasi transfer internal); neraca; arus kas
 * metode langsung dari akun kas/bank (PTB-45). Per periode & kumulatif tahun berjalan. "Sementara" pada periode belum
 * dikunci; "Final" setelah dikunci — versi Final disimpan (`report_snapshots`) dan disajikan ulang identik.
 *
 * Laporan per periode memakai PERIODE POSTING jurnal (bukan tanggal kejadian): peristiwa terlambat yang masuk periode
 * terbuka berikutnya tidak mengubah laporan periode yang sudah dikunci (FR-M11-10).
 */
import "server-only";

import { createHash } from "node:crypto";

import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";

import { accountingPeriods, accounts, journalLines, journals, reportSnapshots } from "@/db/schema";
import type { AccountType, ProfitCenter } from "@/lib/labels";

import { canonicalJson } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError } from "@/server/core/errors";
import { resolveMapping } from "@/server/core/ledger";
import { authorize } from "@/server/core/rbac";

import { INTERNAL_TRANSFER_SOURCES, PROFIT_CENTERS, SOURCE_OBJECT_LABELS } from "../constants";
import { isPeriodLabel, periodEnd, periodStart, shiftPeriod, type AccountRow } from "./common";

export type Basis = "period" | "ytd";

export const STATEMENTS_REPORT_KEY = "m11.statements";

type AggRow = { accountId: string; profitCenter: ProfitCenter; internalSource: boolean; debit: number; credit: number };

/** Jumlah debit/kredit per akun × pusat laba untuk periode posting dalam rentang (inklusif). */
async function aggregate(tx: Tx, tenantId: string, range: { fromPeriod?: string | null; toPeriod: string; profitCenter?: ProfitCenter | null }): Promise<AggRow[]> {
  const conds = [eq(journals.tenantId, tenantId), eq(journals.status, "posted"), lte(accountingPeriods.period, range.toPeriod)];
  if (range.fromPeriod) conds.push(gte(accountingPeriods.period, range.fromPeriod));
  if (range.profitCenter) conds.push(eq(journalLines.profitCenter, range.profitCenter));
  const internalSources = [...INTERNAL_TRANSFER_SOURCES];
  const rows = await tx
    .select({
      accountId: journalLines.accountId,
      profitCenter: journalLines.profitCenter,
      internalSource: sql<boolean>`coalesce(${journals.sourceType} in (${sql.join(
        internalSources.map((s) => sql`${s}`),
        sql`, `,
      )}), false)`,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .where(and(...conds))
    .groupBy(journalLines.accountId, journalLines.profitCenter, sql`3`);
  return rows.map((r) => ({ accountId: r.accountId, profitCenter: r.profitCenter, internalSource: Boolean(r.internalSource), debit: Number(r.debit), credit: Number(r.credit) }));
}

async function tenantAccounts(tx: Tx, tenantId: string): Promise<Map<string, AccountRow>> {
  const rows = await tx.select().from(accounts).where(eq(accounts.tenantId, tenantId)).orderBy(asc(accounts.code));
  return new Map(rows.map((a) => [a.id, a]));
}

/** Tanda saldo normal per jenis akun (aset/beban: debit − kredit; lainnya: kredit − debit). */
export function signedAmount(type: AccountType, debit: number, credit: number): number {
  return type === "asset" || type === "expense" ? debit - credit : credit - debit;
}

function topHeader(a: AccountRow, byId: Map<string, AccountRow>): AccountRow | null {
  let cur: AccountRow | undefined = a;
  let top: AccountRow | null = null;
  for (let guard = 0; guard < 10 && cur?.parentId; guard++) {
    cur = byId.get(cur.parentId);
    if (cur) top = cur;
  }
  return top;
}

function yearStart(period: string): string {
  return `${period.slice(0, 4)}-01`;
}

function rangeOf(period: string, basis: Basis): { fromPeriod: string; toPeriod: string } {
  return { fromPeriod: basis === "ytd" ? yearStart(period) : period, toPeriod: period };
}

// =====================================================================================================================
// Neraca saldo
// =====================================================================================================================

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  openingDebit: number;
  openingCredit: number;
  debit: number;
  credit: number;
  closingDebit: number;
  closingCredit: number;
};

export async function computeTrialBalance(tx: Tx, tenantId: string, period: string, basis: Basis) {
  const { fromPeriod, toPeriod } = rangeOf(period, basis);
  const byId = await tenantAccounts(tx, tenantId);
  const before = await aggregate(tx, tenantId, { toPeriod: shiftPeriod(fromPeriod, -1) });
  const beforeYear = await aggregate(tx, tenantId, { fromPeriod: yearStart(period), toPeriod: shiftPeriod(fromPeriod, -1) });
  const movement = await aggregate(tx, tenantId, { fromPeriod, toPeriod });
  const acc = new Map<string, { od: number; oc: number; d: number; c: number }>();
  const add = (rows: AggRow[], key: "o" | "m", filter: (a: AccountRow) => boolean) => {
    for (const r of rows) {
      const a = byId.get(r.accountId);
      if (!a || !filter(a)) continue;
      const cur = acc.get(r.accountId) ?? { od: 0, oc: 0, d: 0, c: 0 };
      if (key === "o") {
        cur.od += r.debit;
        cur.oc += r.credit;
      } else {
        cur.d += r.debit;
        cur.c += r.credit;
      }
      acc.set(r.accountId, cur);
    }
  };
  const isPl = (a: AccountRow) => a.type === "revenue" || a.type === "expense";
  add(before, "o", (a) => !isPl(a));
  add(fromPeriod === yearStart(period) ? [] : beforeYear, "o", isPl);
  add(movement, "m", () => true);
  const rows: TrialBalanceRow[] = [];
  for (const [id, v] of acc) {
    const a = byId.get(id)!;
    const openingNet = v.od - v.oc;
    const closingNet = openingNet + v.d - v.c;
    rows.push({
      accountId: id,
      code: a.code,
      name: a.name,
      type: a.type,
      openingDebit: openingNet > 0 ? openingNet : 0,
      openingCredit: openingNet < 0 ? -openingNet : 0,
      debit: v.d,
      credit: v.c,
      closingDebit: closingNet > 0 ? closingNet : 0,
      closingCredit: closingNet < 0 ? -closingNet : 0,
    });
  }
  rows.sort((x, y) => x.code.localeCompare(y.code));
  const totals = rows.reduce(
    (s, r) => ({ debit: s.debit + r.debit, credit: s.credit + r.credit, closingDebit: s.closingDebit + r.closingDebit, closingCredit: s.closingCredit + r.closingCredit }),
    { debit: 0, credit: 0, closingDebit: 0, closingCredit: 0 },
  );
  return { period, basis, rows, totals, balanced: totals.debit === totals.credit && totals.closingDebit === totals.closingCredit };
}

// =====================================================================================================================
// Laba rugi per lini & konsolidasi
// =====================================================================================================================

export type PlRow = {
  accountId: string;
  code: string;
  name: string;
  section: string;
  kind: "revenue" | "expense";
  internal: boolean;
  allocation: "l1" | "shared" | null;
  byCenter: Record<ProfitCenter, number>;
  total: number;
  elimination: number;
  consolidated: number;
};

async function allocationAccountIds(tx: Tx, tenantId: string, date: string): Promise<{ l1: Set<string>; shared: Set<string> }> {
  const l1 = await resolveMapping(tx, "m11.allocation", "l1_allocation", date, tenantId);
  const shared = await resolveMapping(tx, "m11.allocation", "shared_costs", date, tenantId);
  return {
    l1: new Set(l1 ? [l1.debitAccountId, l1.creditAccountId] : []),
    shared: new Set(shared ? [shared.debitAccountId, shared.creditAccountId] : []),
  };
}

const zeroCenters = (): Record<ProfitCenter, number> => ({ L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, SHARED: 0 });

export async function computeProfitLoss(tx: Tx, tenantId: string, period: string, basis: Basis) {
  const { fromPeriod, toPeriod } = rangeOf(period, basis);
  const byId = await tenantAccounts(tx, tenantId);
  const alloc = await allocationAccountIds(tx, tenantId, periodEnd(period));
  const agg = await aggregate(tx, tenantId, { fromPeriod, toPeriod });
  const rows = new Map<string, PlRow>();
  for (const r of agg) {
    const a = byId.get(r.accountId);
    if (!a || (a.type !== "revenue" && a.type !== "expense")) continue;
    const amount = a.type === "revenue" ? r.credit - r.debit : r.debit - r.credit;
    const top = topHeader(a, byId);
    const allocation = alloc.l1.has(a.id) ? "l1" : alloc.shared.has(a.id) ? "shared" : null;
    const row =
      rows.get(a.id) ??
      ({
        accountId: a.id,
        code: a.code,
        name: a.name,
        section: allocation ? (allocation === "l1" ? "Alokasi biaya produksi air (L1)" : "Alokasi biaya bersama") : a.isInternalTransfer ? "Transfer internal (dieliminasi)" : (top?.name ?? (a.type === "revenue" ? "PENDAPATAN" : "BEBAN")),
        kind: a.type,
        internal: a.isInternalTransfer,
        allocation,
        byCenter: zeroCenters(),
        total: 0,
        elimination: 0,
        consolidated: 0,
      } satisfies PlRow);
    row.byCenter[r.profitCenter] += amount;
    row.total += amount;
    if (a.isInternalTransfer || r.internalSource) row.elimination += amount;
    row.consolidated = row.total - row.elimination;
    rows.set(a.id, row);
  }
  const list = [...rows.values()].sort((x, y) => x.code.localeCompare(y.code));
  const sum = (filter: (r: PlRow) => boolean, pick: (r: PlRow) => number, sign: (r: PlRow) => number = (r) => (r.kind === "revenue" ? 1 : -1)) =>
    list.filter(filter).reduce((s, r) => s + sign(r) * pick(r), 0);
  const centers = {} as Record<ProfitCenter, { beforeAllocation: number; allocationL1: number; allocationShared: number; net: number; revenue: number }>;
  for (const pc of PROFIT_CENTERS) {
    const revenue = sum((r) => r.kind === "revenue" && !r.allocation, (r) => r.byCenter[pc], () => 1);
    const beforeAllocation = sum((r) => !r.allocation, (r) => r.byCenter[pc]);
    const allocationL1 = -sum((r) => r.allocation === "l1", (r) => r.byCenter[pc], () => 1);
    const allocationShared = -sum((r) => r.allocation === "shared", (r) => r.byCenter[pc], () => 1);
    centers[pc] = { revenue, beforeAllocation, allocationL1, allocationShared, net: beforeAllocation + allocationL1 + allocationShared };
  }
  const consolidated = {
    revenue: sum((r) => r.kind === "revenue", (r) => r.consolidated, () => 1),
    net: sum(() => true, (r) => r.consolidated),
    eliminatedRevenue: sum((r) => r.kind === "revenue", (r) => r.elimination, () => 1),
    eliminatedExpense: sum((r) => r.kind === "expense", (r) => r.elimination, () => 1),
  };
  return { period, basis, rows: list, centers, consolidated, netTotal: sum(() => true, (r) => r.total) };
}

// =====================================================================================================================
// Neraca
// =====================================================================================================================

export type BalanceRow = { accountId: string | null; code: string; name: string; section: "asset" | "liability" | "equity"; amount: number };

export async function computeBalanceSheet(tx: Tx, tenantId: string, period: string) {
  const byId = await tenantAccounts(tx, tenantId);
  const all = await aggregate(tx, tenantId, { toPeriod: period });
  const ytd = await aggregate(tx, tenantId, { fromPeriod: yearStart(period), toPeriod: period });
  const bal = new Map<string, number>();
  let retained = 0;
  for (const r of all) {
    const a = byId.get(r.accountId);
    if (!a) continue;
    if (a.type === "revenue" || a.type === "expense") {
      retained += r.credit - r.debit;
      continue;
    }
    bal.set(a.id, (bal.get(a.id) ?? 0) + signedAmount(a.type, r.debit, r.credit));
  }
  let currentYear = 0;
  for (const r of ytd) {
    const a = byId.get(r.accountId);
    if (a && (a.type === "revenue" || a.type === "expense")) currentYear += r.credit - r.debit;
  }
  const rows: BalanceRow[] = [];
  for (const [id, amount] of bal) {
    const a = byId.get(id)!;
    if (amount === 0) continue;
    rows.push({ accountId: id, code: a.code, name: a.name, section: a.type as BalanceRow["section"], amount });
  }
  rows.push({ accountId: null, code: "", name: "Saldo laba (akumulasi tahun lalu)", section: "equity", amount: retained - currentYear });
  rows.push({ accountId: null, code: "", name: "Laba (rugi) tahun berjalan", section: "equity", amount: currentYear });
  rows.sort((x, y) => (x.code || "9").localeCompare(y.code || "9"));
  const total = (s: BalanceRow["section"]) => rows.filter((r) => r.section === s).reduce((t, r) => t + r.amount, 0);
  const assets = total("asset");
  const liabilities = total("liability");
  const equity = total("equity");
  return { period, rows, assets, liabilities, equity, balanced: assets === liabilities + equity };
}

// =====================================================================================================================
// Arus kas metode langsung (PTB-45)
// =====================================================================================================================

export type CashFlowCategory = "customers" | "suppliers" | "operating_expenses" | "investing" | "financing" | "other";

export const CASH_FLOW_LABELS: Record<CashFlowCategory, string> = {
  customers: "Penerimaan dari pelanggan",
  suppliers: "Pembayaran ke pemasok & persediaan",
  operating_expenses: "Pembayaran beban operasional",
  investing: "Arus kas investasi (aset tetap)",
  financing: "Arus kas pendanaan (modal & pinjaman)",
  other: "Lain-lain",
};

function classify(a: AccountRow, byId: Map<string, AccountRow>): CashFlowCategory {
  const top = topHeader(a, byId);
  const parent = a.parentId ? byId.get(a.parentId) : undefined;
  const parentName = (parent?.name ?? "").toLowerCase();
  if (a.type === "revenue") return "customers";
  if (a.type === "expense") return "operating_expenses";
  if (a.type === "equity") return "financing";
  const name = a.name.toLowerCase();
  if (a.type === "asset") {
    if (parentName.includes("tetap") || (top?.code === "1-0000" && parentName.includes("aset tetap"))) return "investing";
    if (name.includes("piutang karyawan")) return "other";
    if (name.includes("piutang") || name.includes("belum dicocokkan")) return "customers";
    if (name.includes("persediaan")) return "suppliers";
    return "other";
  }
  if (a.type === "liability") {
    if (name.includes("pemasok") || name.includes("utang usaha")) return "suppliers";
    if (name.includes("uang muka pelanggan")) return "customers";
    if (name.includes("gaji") || name.includes("akrual") || name.includes("masih harus")) return "operating_expenses";
    return "financing";
  }
  return "other";
}

export async function computeCashFlow(tx: Tx, tenantId: string, period: string, basis: Basis) {
  const { fromPeriod, toPeriod } = rangeOf(period, basis);
  const byId = await tenantAccounts(tx, tenantId);
  const cashIds = [...byId.values()].filter((a) => a.isCash).map((a) => a.id);
  const opening = cashIds.length ? await aggregate(tx, tenantId, { toPeriod: shiftPeriod(fromPeriod, -1) }) : [];
  const openingCash = opening.filter((r) => cashIds.includes(r.accountId)).reduce((s, r) => s + r.debit - r.credit, 0);
  const lines = cashIds.length
    ? await tx
        .select({ journalId: journalLines.journalId, accountId: journalLines.accountId, debit: journalLines.debit, credit: journalLines.credit })
        .from(journalLines)
        .innerJoin(journals, eq(journals.id, journalLines.journalId))
        .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
        .where(
          and(
            eq(journals.tenantId, tenantId),
            eq(journals.status, "posted"),
            gte(accountingPeriods.period, fromPeriod),
            lte(accountingPeriods.period, toPeriod),
            sql`${journals.id} in (select jl2.journal_id from journal_lines jl2 where jl2.account_id in (${sql.join(
              cashIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}))`,
          ),
        )
    : [];
  const byJournal = new Map<string, typeof lines>();
  for (const l of lines) byJournal.set(l.journalId, [...(byJournal.get(l.journalId) ?? []), l]);
  const cats: Record<CashFlowCategory, { inflow: number; outflow: number }> = {
    customers: { inflow: 0, outflow: 0 },
    suppliers: { inflow: 0, outflow: 0 },
    operating_expenses: { inflow: 0, outflow: 0 },
    investing: { inflow: 0, outflow: 0 },
    financing: { inflow: 0, outflow: 0 },
    other: { inflow: 0, outflow: 0 },
  };
  const cashSet = new Set(cashIds);
  for (const jl of byJournal.values()) {
    const net = jl.filter((l) => cashSet.has(l.accountId)).reduce((s, l) => s + l.debit - l.credit, 0);
    if (net === 0) continue;
    // Akun lawan terbesar menentukan kategori.
    const others = jl.filter((l) => !cashSet.has(l.accountId)).sort((a, b) => b.debit + b.credit - (a.debit + a.credit));
    const counter = others[0] ? byId.get(others[0].accountId) : undefined;
    const cat = counter ? classify(counter, byId) : "other";
    if (net > 0) cats[cat].inflow += net;
    else cats[cat].outflow += -net;
  }
  const netChange = Object.values(cats).reduce((s, c) => s + c.inflow - c.outflow, 0);
  const section = (keys: CashFlowCategory[]) => keys.reduce((s, k) => s + cats[k].inflow - cats[k].outflow, 0);
  return {
    period,
    basis,
    categories: (Object.keys(cats) as CashFlowCategory[]).map((k) => ({ key: k, label: CASH_FLOW_LABELS[k], ...cats[k], net: cats[k].inflow - cats[k].outflow })),
    operating: section(["customers", "suppliers", "operating_expenses", "other"]),
    investing: section(["investing"]),
    financing: section(["financing"]),
    openingCash,
    netChange,
    closingCash: openingCash + netChange,
  };
}

// =====================================================================================================================
// Buku besar
// =====================================================================================================================

export type LedgerLine = {
  journalId: string;
  number: string;
  date: string;
  period: string;
  description: string;
  kind: string;
  sourceType: string | null;
  sourceObjectType: string | null;
  sourceObjectId: string | null;
  sourceLabel: string | null;
  profitCenter: ProfitCenter;
  outletId: string | null;
  debit: number;
  credit: number;
  balance: number;
  memo: string | null;
};

export async function computeLedger(
  tx: Tx,
  tenantId: string,
  filter: { accountId: string; profitCenter?: ProfitCenter | null; outletId?: string | null; fromPeriod: string; toPeriod: string },
) {
  const [a] = await tx.select().from(accounts).where(and(eq(accounts.id, filter.accountId), eq(accounts.tenantId, tenantId))).limit(1);
  if (!a) throw new DomainError("ACCOUNT_MISSING", "Akun tidak ditemukan.");
  const pl = a.type === "revenue" || a.type === "expense";
  const openFrom = pl ? yearStart(filter.fromPeriod) : null;
  const baseConds = (extra: ReturnType<typeof eq>[]) => {
    const c = [eq(journals.tenantId, tenantId), eq(journals.status, "posted"), eq(journalLines.accountId, a.id), ...extra];
    if (filter.profitCenter) c.push(eq(journalLines.profitCenter, filter.profitCenter));
    if (filter.outletId) c.push(eq(journalLines.outletId, filter.outletId));
    return c;
  };
  const openingConds = baseConds([lt(accountingPeriods.period, filter.fromPeriod) as ReturnType<typeof eq>]);
  if (openFrom) openingConds.push(gte(accountingPeriods.period, openFrom) as ReturnType<typeof eq>);
  const [op] = await tx
    .select({ d: sql<string>`coalesce(sum(${journalLines.debit}),0)`, c: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .where(and(...openingConds));
  const opening = signedAmount(a.type, Number(op?.d ?? 0), Number(op?.c ?? 0));
  const rows = await tx
    .select({ l: journalLines, j: journals, period: accountingPeriods.period })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .where(and(...baseConds([gte(accountingPeriods.period, filter.fromPeriod) as ReturnType<typeof eq>, lte(accountingPeriods.period, filter.toPeriod) as ReturnType<typeof eq>])))
    .orderBy(asc(journals.journalDate), asc(journals.number), asc(journalLines.lineNo))
    .limit(5000);
  let running = opening;
  const lines: LedgerLine[] = rows.map(({ l, j, period }) => {
    running += signedAmount(a.type, l.debit, l.credit);
    return {
      journalId: j.id,
      number: j.number,
      date: j.journalDate,
      period,
      description: j.description,
      kind: j.kind,
      sourceType: j.sourceType,
      sourceObjectType: j.sourceObjectType,
      sourceObjectId: j.sourceObjectId,
      sourceLabel: j.sourceObjectType ? (SOURCE_OBJECT_LABELS[j.sourceObjectType] ?? j.sourceObjectType) : null,
      profitCenter: l.profitCenter,
      outletId: l.outletId,
      debit: l.debit,
      credit: l.credit,
      balance: running,
      memo: l.description,
    };
  });
  return { account: a, opening, lines, closing: running, debit: lines.reduce((s, l) => s + l.debit, 0), credit: lines.reduce((s, l) => s + l.credit, 0) };
}

// =====================================================================================================================
// Paket laporan periode + versi Final
// =====================================================================================================================

export type Statements = {
  period: string;
  basis: Basis;
  status: "provisional" | "final";
  revision: number;
  retroactive: boolean;
  generatedAt: string;
  trialBalance: Awaited<ReturnType<typeof computeTrialBalance>>;
  profitLoss: Awaited<ReturnType<typeof computeProfitLoss>>;
  balanceSheet: Awaited<ReturnType<typeof computeBalanceSheet>>;
  cashFlow: Awaited<ReturnType<typeof computeCashFlow>>;
  fileSha256?: string | null;
};

export async function computeStatements(tx: Tx, tenantId: string, period: string, basis: Basis, now: Date): Promise<Omit<Statements, "status" | "revision" | "retroactive">> {
  return {
    period,
    basis,
    generatedAt: now.toISOString(),
    trialBalance: await computeTrialBalance(tx, tenantId, period, basis),
    profitLoss: await computeProfitLoss(tx, tenantId, period, basis),
    balanceSheet: await computeBalanceSheet(tx, tenantId, period),
    cashFlow: await computeCashFlow(tx, tenantId, period, basis),
  };
}

/** Simpan versi Final (dipanggil saat periode dikunci). Revisi baru menggantikan revisi Final sebelumnya. */
export async function saveFinalSnapshots(tx: Tx, ctx: ActorContext, period: { id: string; tenantId: string; period: string; revision: number; isRetroactive: boolean }): Promise<string[]> {
  const ids: string[] = [];
  for (const basis of ["period", "ytd"] as Basis[]) {
    const data = await computeStatements(tx, period.tenantId, period.period, basis, ctx.now);
    const payload = { ...data, retroactive: period.isRetroactive, revision: period.revision };
    const sha = createHash("sha256").update(canonicalJson(payload)).digest("hex");
    const [old] = await tx
      .select()
      .from(reportSnapshots)
      .where(
        and(
          eq(reportSnapshots.tenantId, period.tenantId),
          eq(reportSnapshots.reportKey, STATEMENTS_REPORT_KEY),
          eq(reportSnapshots.period, period.period),
          eq(reportSnapshots.scopeKey, basis),
          eq(reportSnapshots.status, "final"),
          isNull(reportSnapshots.supersededById),
        ),
      )
      .limit(1);
    if (old && old.revision === period.revision) {
      ids.push(old.id);
      continue;
    }
    const [created] = await tx
      .insert(reportSnapshots)
      .values({
        tenantId: period.tenantId,
        reportKey: STATEMENTS_REPORT_KEY,
        period: period.period,
        revision: period.revision,
        status: "provisional",
        scopeKey: basis,
        filters: { basis },
        data: payload as unknown as Record<string, unknown>,
        fileSha256: sha,
        accountingPeriodId: period.id,
        generatedAt: ctx.now,
        generatedBy: ctx.userId,
      })
      .returning();
    if (old) await tx.update(reportSnapshots).set({ supersededById: created!.id, updatedAt: new Date() }).where(eq(reportSnapshots.id, old.id));
    await tx.update(reportSnapshots).set({ status: "final", updatedAt: new Date() }).where(eq(reportSnapshots.id, created!.id));
    ids.push(created!.id);
  }
  return ids;
}

/** Laporan periode: Final (tersimpan, identik) bila dikunci; selain itu Sementara (dihitung). */
export async function loadStatements(tx: Tx, tenantId: string, period: string, basis: Basis, now: Date): Promise<Statements> {
  if (!isPeriodLabel(period)) throw new DomainError("INVALID_PERIOD", "Periode harus berformat YYYY-MM.");
  const [p] = await tx.select().from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, tenantId), eq(accountingPeriods.period, period))).limit(1);
  if (p?.status === "locked") {
    const [snap] = await tx
      .select()
      .from(reportSnapshots)
      .where(
        and(
          eq(reportSnapshots.tenantId, tenantId),
          eq(reportSnapshots.reportKey, STATEMENTS_REPORT_KEY),
          eq(reportSnapshots.period, period),
          eq(reportSnapshots.scopeKey, basis),
          eq(reportSnapshots.status, "final"),
          isNull(reportSnapshots.supersededById),
        ),
      )
      .limit(1);
    if (snap) return { ...(snap.data as unknown as Omit<Statements, "status">), status: "final", revision: snap.revision, fileSha256: snap.fileSha256 } as Statements;
  }
  const data = await computeStatements(tx, tenantId, period, basis, now);
  return { ...data, status: "provisional", revision: p?.revision ?? 1, retroactive: p?.isRetroactive ?? false };
}

/** Riwayat versi Final (termasuk revisi lama setelah periode dibuka kembali). */
export async function finalVersions(tx: Tx, tenantId: string, period: string) {
  return tx
    .select({ id: reportSnapshots.id, revision: reportSnapshots.revision, scopeKey: reportSnapshots.scopeKey, generatedAt: reportSnapshots.generatedAt, supersededById: reportSnapshots.supersededById, fileSha256: reportSnapshots.fileSha256 })
    .from(reportSnapshots)
    .where(and(eq(reportSnapshots.tenantId, tenantId), eq(reportSnapshots.reportKey, STATEMENTS_REPORT_KEY), eq(reportSnapshots.period, period), eq(reportSnapshots.status, "final")))
    .orderBy(desc(reportSnapshots.revision), asc(reportSnapshots.scopeKey));
}

// --- Layanan (izin) ---------------------------------------------------------------------------------------------------

export async function getStatements(ctx: ActorContext, filter: { period: string; basis?: Basis }, opts: { tx?: Tx } = {}): Promise<Statements> {
  await authorize(ctx, "m11.financial_report.read", { tx: opts.tx });
  return loadStatements(opts.tx ?? getDb(), ctx.tenantId, filter.period, filter.basis ?? "period", ctx.now);
}

export async function getLedger(
  ctx: ActorContext,
  filter: { accountId: string; profitCenter?: ProfitCenter | null; outletId?: string | null; fromPeriod: string; toPeriod?: string | null },
  opts: { tx?: Tx } = {},
) {
  await authorize(ctx, "m11.ledger.read", { tx: opts.tx });
  if (!isPeriodLabel(filter.fromPeriod)) throw new DomainError("INVALID_PERIOD", "Periode harus berformat YYYY-MM.");
  const toPeriod = filter.toPeriod && isPeriodLabel(filter.toPeriod) ? filter.toPeriod : filter.fromPeriod;
  return computeLedger(opts.tx ?? getDb(), ctx.tenantId, { ...filter, toPeriod });
}

/** Saldo akun per akhir periode (dipakai rekonsiliasi). */
export async function accountBalanceAt(tx: Tx, tenantId: string, accountIds: readonly string[], period: string, filter: { outletId?: string | null } = {}): Promise<number> {
  if (!accountIds.length) return 0;
  const conds = [eq(journals.tenantId, tenantId), eq(journals.status, "posted"), lte(accountingPeriods.period, period), inArray(journalLines.accountId, [...accountIds])];
  if (filter.outletId) conds.push(eq(journalLines.outletId, filter.outletId));
  const [r] = await tx
    .select({ d: sql<string>`coalesce(sum(${journalLines.debit}),0)`, c: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .where(and(...conds));
  return Number(r?.d ?? 0) - Number(r?.c ?? 0);
}

export { periodStart, periodEnd };
