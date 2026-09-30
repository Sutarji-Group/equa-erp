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

type AggRange = { fromPeriod?: string | null; toPeriod: string };

/**
 * Sumber agregat laporan: `range` = `aggregate` per rentang periode, `markupState` = `markupStateUpTo`. Bawaan: satu
 * kueri per permintaan. `computeStatements` memakai `StatementAggregates` (segmen + memo) — paket laporan satu periode
 * meminta 7 rentang agregat + 4 posisi markup yang tersusun dari <= 3 segmen & 2 posisi (uji beban NFR-05).
 */
export type AggSource = {
  range(r: AggRange): Promise<AggRow[]>;
  markupState(inventoryAccountId: string, toPeriod: string): Promise<Map<string, MarkupState>>;
};

function directAggregates(tx: Tx, tenantId: string): AggSource {
  return { range: (r) => aggregate(tx, tenantId, r), markupState: (inv, to) => markupStateUpTo(tx, tenantId, inv, to) };
}

/** Gabungkan baris agregat beberapa segmen rentang (jumlah per akun x pusat laba x sumber internal). */
function mergeAggRows(parts: AggRow[][]): AggRow[] {
  if (parts.length === 1) return parts[0]!;
  const out = new Map<string, AggRow>();
  for (const rows of parts) {
    for (const r of rows) {
      const key = `${r.accountId}|${r.profitCenter}|${r.internalSource ? 1 : 0}`;
      const cur = out.get(key);
      if (cur) {
        cur.debit += r.debit;
        cur.credit += r.credit;
      } else out.set(key, { ...r });
    }
  }
  return [...out.values()];
}

/**
 * Agregat bersegmen dengan memo untuk satu paket laporan. Titik potong = awal periode rentang yang diminta; rentang
 * yang ujungnya jatuh tepat pada titik potong disusun dari segmen (masing-masing SATU kueri, dihitung sekali) — hasil
 * identik dengan `aggregate` langsung karena jumlah per kunci bersifat aditif atas periode yang saling lepas. Rentang
 * lain jatuh ke kueri langsung.
 */
export class StatementAggregates implements AggSource {
  private readonly starts: string[];
  private readonly end: string;
  private readonly segments = new Map<string, Promise<AggRow[]>>();
  private readonly markups = new Map<string, Promise<Map<string, MarkupState>>>();

  constructor(
    private readonly tx: Tx,
    private readonly tenantId: string,
    cuts: readonly string[],
    upTo: string,
  ) {
    this.starts = [...new Set(cuts.filter((c) => c <= upTo))].sort();
    this.end = shiftPeriod(upTo, 1);
  }

  range(r: AggRange): Promise<AggRow[]> {
    const from = r.fromPeriod ?? null;
    if (from && from > r.toPeriod) return Promise.resolve([]);
    const next = shiftPeriod(r.toPeriod, 1);
    const bounds: (string | null)[] = [null, ...this.starts, this.end];
    const i0 = bounds.indexOf(from);
    const i1 = bounds.indexOf(next);
    if (i0 < 0 || i1 <= i0) return aggregate(this.tx, this.tenantId, r);
    const parts: Promise<AggRow[]>[] = [];
    for (let i = i0; i < i1; i++) parts.push(this.segment(bounds[i] ?? null, shiftPeriod(bounds[i + 1]!, -1)));
    return Promise.all(parts).then(mergeAggRows);
  }

  markupState(inventoryAccountId: string, toPeriod: string): Promise<Map<string, MarkupState>> {
    const key = `${inventoryAccountId}|${toPeriod}`;
    let p = this.markups.get(key);
    if (!p) {
      p = markupStateUpTo(this.tx, this.tenantId, inventoryAccountId, toPeriod);
      this.markups.set(key, p);
    }
    return p;
  }

  private segment(from: string | null, to: string): Promise<AggRow[]> {
    const key = `${from ?? ""}..${to}`;
    let p = this.segments.get(key);
    if (!p) {
      p = from && from > to ? Promise.resolve([]) : aggregate(this.tx, this.tenantId, { fromPeriod: from, toPeriod: to });
      this.segments.set(key, p);
    }
    return p;
  }
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

export async function computeTrialBalance(tx: Tx, tenantId: string, period: string, basis: Basis, src: AggSource = directAggregates(tx, tenantId)) {
  const { fromPeriod, toPeriod } = rangeOf(period, basis);
  const byId = await tenantAccounts(tx, tenantId);
  const before = await src.range({ toPeriod: shiftPeriod(fromPeriod, -1) });
  const beforeYear = await src.range({ fromPeriod: yearStart(period), toPeriod: shiftPeriod(fromPeriod, -1) });
  const movement = await src.range({ fromPeriod, toPeriod });
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

// =====================================================================================================================
// Eliminasi markup transfer internal toko → depot (B-56, US-M11-01 KP-4, BR-33, PTB-37)
// =====================================================================================================================

export type InternalMarkup = {
  /** Akun persediaan bahan depot (debit pemetaan `internal_transfer.sent/revenue`). */
  inventoryAccountId: string | null;
  /** Markup (harga mitra − HPP toko) transfer internal dalam rentang. */
  transferred: number;
  /** Markup yang masih melekat di persediaan depot pada awal / akhir rentang (belum terpakai). */
  unrealizedStart: number;
  unrealizedEnd: number;
  /** Markup yang ikut terpakai sebagai beban bahan depot dalam rentang = dieliminasi dari beban konsolidasi. */
  realized: number;
};

type MarkupState = { markup: number; inflow: number; balance: number };

/** Posisi kumulatif per outlet depot s.d. periode `toPeriod` (inklusif). */
async function markupStateUpTo(tx: Tx, tenantId: string, inventoryAccountId: string, toPeriod: string): Promise<Map<string, MarkupState>> {
  const base = [eq(journals.tenantId, tenantId), eq(journals.status, "posted"), lte(accountingPeriods.period, toPeriod)];
  // Arus persediaan depot per outlet: debit = masuk (transfer internal, pembelian, saldo awal), kredit = terpakai.
  const inv = await tx
    .select({ outletId: journalLines.outletId, d: sql<string>`coalesce(sum(${journalLines.debit}),0)`, c: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .where(and(...base, eq(journalLines.accountId, inventoryAccountId)))
    .groupBy(journalLines.outletId);
  // Nilai transfer internal (debit persediaan depot) & HPP toko (debit beban) per jurnal `internal_transfer.sent`.
  const tr = await tx
    .select({ journalId: journals.id, outletId: journalLines.outletId, accountId: journalLines.accountId, type: accounts.type, d: journalLines.debit })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(...base, eq(journals.sourceType, "internal_transfer.sent")));
  const byJournal = new Map<string, { outletId: string | null; value: number; cost: number }>();
  for (const r of tr) {
    const j = byJournal.get(r.journalId) ?? { outletId: null, value: 0, cost: 0 };
    if (r.accountId === inventoryAccountId) {
      j.value += Number(r.d ?? 0);
      j.outletId = r.outletId ?? j.outletId;
    } else if (r.type === "expense") j.cost += Number(r.d ?? 0);
    byJournal.set(r.journalId, j);
  }
  const out = new Map<string, MarkupState>();
  const key = (o: string | null) => o ?? "-";
  for (const r of inv) out.set(key(r.outletId), { markup: 0, inflow: Number(r.d), balance: Number(r.d) - Number(r.c) });
  for (const j of byJournal.values()) {
    const s = out.get(key(j.outletId)) ?? { markup: 0, inflow: 0, balance: 0 };
    s.markup += j.value - j.cost;
    out.set(key(j.outletId), s);
  }
  return out;
}

/** Markup belum terpakai = saldo persediaan × (markup kumulatif ÷ nilai masuk kumulatif), per outlet (rata-rata tertimbang). */
function unrealizedOf(states: Map<string, MarkupState>): { markup: number; unrealized: number } {
  let markup = 0;
  let unrealized = 0;
  for (const s of states.values()) {
    markup += s.markup;
    if (s.markup <= 0 || s.inflow <= 0 || s.balance <= 0) continue;
    unrealized += Math.min(s.markup, Math.round((s.balance * s.markup) / s.inflow));
  }
  return { markup, unrealized };
}

/**
 * Markup harga mitra atas bahan yang ditransfer toko → depot (B-56). Laporan per lini tetap memakai harga mitra
 * (PTB-37); pada KONSOLIDASI pendapatan internal & HPP toko sudah dieliminasi, dan markup yang ikut terpakai sebagai beban
 * bahan depot dieliminasi dari beban; markup yang masih di persediaan depot dieliminasi dari persediaan (neraca).
 */
export async function computeInternalMarkup(tx: Tx, tenantId: string, fromPeriod: string, toPeriod: string, src: AggSource = directAggregates(tx, tenantId)): Promise<InternalMarkup> {
  const map = await resolveMapping(tx, "internal_transfer.sent", "revenue", periodEnd(toPeriod), tenantId);
  const inventoryAccountId = map?.debitAccountId ?? null;
  if (!inventoryAccountId) return { inventoryAccountId: null, transferred: 0, unrealizedStart: 0, unrealizedEnd: 0, realized: 0 };
  const end = unrealizedOf(await src.markupState(inventoryAccountId, toPeriod));
  const start = unrealizedOf(await src.markupState(inventoryAccountId, shiftPeriod(fromPeriod, -1)));
  const transferred = end.markup - start.markup;
  return { inventoryAccountId, transferred, unrealizedStart: start.unrealized, unrealizedEnd: end.unrealized, realized: transferred - (end.unrealized - start.unrealized) };
}

export async function computeProfitLoss(tx: Tx, tenantId: string, period: string, basis: Basis, src: AggSource = directAggregates(tx, tenantId)) {
  const { fromPeriod, toPeriod } = rangeOf(period, basis);
  const byId = await tenantAccounts(tx, tenantId);
  const alloc = await allocationAccountIds(tx, tenantId, periodEnd(period));
  const agg = await src.range({ fromPeriod, toPeriod });
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
  // B-56: markup harga mitra yang terpakai sebagai beban bahan depot dieliminasi dari beban konsolidasi.
  const markup = await computeInternalMarkup(tx, tenantId, fromPeriod, toPeriod, src);
  const consolidated = {
    revenue: sum((r) => r.kind === "revenue", (r) => r.consolidated, () => 1),
    net: sum(() => true, (r) => r.consolidated) + markup.realized,
    eliminatedRevenue: sum((r) => r.kind === "revenue", (r) => r.elimination, () => 1),
    eliminatedExpense: sum((r) => r.kind === "expense", (r) => r.elimination, () => 1),
    /** Markup transfer internal toko → depot yang terpakai (mengurangi beban konsolidasi) & yang masih di persediaan. */
    markupRealized: markup.realized,
    markupUnrealized: markup.unrealizedEnd,
  };
  return { period, basis, rows: list, centers, consolidated, netTotal: sum(() => true, (r) => r.total) };
}

// =====================================================================================================================
// Neraca
// =====================================================================================================================

export type BalanceRow = { accountId: string | null; code: string; name: string; section: "asset" | "liability" | "equity"; amount: number };

export async function computeBalanceSheet(tx: Tx, tenantId: string, period: string, src: AggSource = directAggregates(tx, tenantId)) {
  const byId = await tenantAccounts(tx, tenantId);
  const all = await src.range({ toPeriod: period });
  const ytd = await src.range({ fromPeriod: yearStart(period), toPeriod: period });
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
  // B-56: markup harga mitra yang masih melekat di persediaan depot dieliminasi (persediaan dinilai harga pokok PT).
  const markup = await computeInternalMarkup(tx, tenantId, period, period, src);
  if (markup.unrealizedEnd !== 0) {
    rows.push({ accountId: null, code: "", name: "Eliminasi markup transfer internal di persediaan depot", section: "asset", amount: -markup.unrealizedEnd });
    rows.push({ accountId: null, code: "", name: "Laba internal belum terealisasi (eliminasi transfer toko → depot)", section: "equity", amount: -markup.unrealizedEnd });
  }
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

export async function computeCashFlow(tx: Tx, tenantId: string, period: string, basis: Basis, src: AggSource = directAggregates(tx, tenantId)) {
  const { fromPeriod, toPeriod } = rangeOf(period, basis);
  const byId = await tenantAccounts(tx, tenantId);
  const cashIds = [...byId.values()].filter((a) => a.isCash).map((a) => a.id);
  const opening = cashIds.length ? await src.range({ toPeriod: shiftPeriod(fromPeriod, -1) }) : [];
  const openingCash = opening.filter((r) => cashIds.includes(r.accountId)).reduce((s, r) => s + r.debit - r.credit, 0);
  const cats: Record<CashFlowCategory, { inflow: number; outflow: number }> = {
    customers: { inflow: 0, outflow: 0 },
    suppliers: { inflow: 0, outflow: 0 },
    operating_expenses: { inflow: 0, outflow: 0 },
    investing: { inflow: 0, outflow: 0 },
    financing: { inflow: 0, outflow: 0 },
    other: { inflow: 0, outflow: 0 },
  };
  if (cashIds.length) {
    // Per jurnal yang menyentuh akun kas/bank: kas bersih (debit - kredit akun kas) dan akun lawan terbesar (debit+kredit
    // terbesar di antara baris non-kas; seri -> nomor baris terkecil) yang menentukan kategori. Dihitung di SQL lalu
    // dijumlahkan per akun lawan — sebelumnya seluruh baris jurnal kas dimuat ke memori (1,2 dtk pada uji beban NFR-05).
    const cashList = sql.join(
      cashIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const res = await tx.execute<{ counter_account_id: string | null; inflow: string; outflow: string }>(sql`
      with lines as (
        select l.journal_id, l.account_id, l.debit, l.credit, l.line_no, (l.account_id in (${cashList})) as is_cash
        from ${journalLines} l
        join ${journals} j on j.id = l.journal_id
        join ${accountingPeriods} p on p.id = j.period_id
        where j.tenant_id = ${tenantId} and j.status = 'posted' and p.period >= ${fromPeriod} and p.period <= ${toPeriod}
      ),
      per_journal as (
        select journal_id, sum(case when is_cash then debit - credit else 0 end) as net
        from lines group by journal_id having bool_or(is_cash)
      ),
      counter as (
        select distinct on (journal_id) journal_id, account_id
        from lines where not is_cash
        order by journal_id, (debit + credit) desc, line_no asc
      )
      select c.account_id as counter_account_id,
             coalesce(sum(case when pj.net > 0 then pj.net else 0 end), 0) as inflow,
             coalesce(sum(case when pj.net < 0 then -pj.net else 0 end), 0) as outflow
      from per_journal pj left join counter c on c.journal_id = pj.journal_id
      where pj.net <> 0
      group by c.account_id`);
    for (const r of res.rows) {
      const counter = r.counter_account_id ? byId.get(r.counter_account_id) : undefined;
      const cat = counter ? classify(counter, byId) : "other";
      cats[cat].inflow += Number(r.inflow);
      cats[cat].outflow += Number(r.outflow);
    }
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

/** Baris buku besar per halaman layar (US-M11-04 KP-1; uji beban NFR-05: satu akun kas depot ±50 ribu baris/bulan). */
export const LEDGER_PAGE_SIZE = 250;
/** Batas baris per pemanggilan (ekspor Excel/PDF) — saldo & mutasi tetap dihitung atas seluruh rentang. */
export const LEDGER_MAX_ROWS = 20_000;

export type LedgerPage = { offset: number; limit: number; total: number };

/**
 * Buku besar satu akun: saldo awal (sebelum `fromPeriod`; akun laba rugi sejak awal tahun), mutasi & saldo akhir atas
 * SELURUH rentang (agregat SQL), dan baris mutasi per halaman (`offset`/`limit`, urutan tanggal → nomor jurnal → baris)
 * dengan saldo berjalan yang diteruskan dari baris sebelum halaman (`pageOpening`). Sebelumnya baris dipotong diam-diam
 * pada 5.000 dan mutasi/saldo akhir dihitung dari baris yang terpotong itu (salah untuk akun bervolume tinggi).
 */
export async function computeLedger(
  tx: Tx,
  tenantId: string,
  filter: { accountId: string; profitCenter?: ProfitCenter | null; outletId?: string | null; fromPeriod: string; toPeriod: string },
  page: { offset?: number | null; limit?: number | null } = {},
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
  const rangeConds = baseConds([gte(accountingPeriods.period, filter.fromPeriod) as ReturnType<typeof eq>, lte(accountingPeriods.period, filter.toPeriod) as ReturnType<typeof eq>]);
  const [tot] = await tx
    .select({ n: sql<string>`count(*)`, d: sql<string>`coalesce(sum(${journalLines.debit}),0)`, c: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .where(and(...rangeConds));
  const total = Number(tot?.n ?? 0);
  const debit = Number(tot?.d ?? 0);
  const credit = Number(tot?.c ?? 0);
  const limit = Math.max(1, Math.min(Math.trunc(page.limit ?? LEDGER_MAX_ROWS), LEDGER_MAX_ROWS));
  const offset = Math.max(0, Math.min(Math.trunc(page.offset ?? 0), Math.max(0, total - 1)));
  const order = [asc(journals.journalDate), asc(journals.number), asc(journalLines.lineNo)];
  let pageOpening = opening;
  if (offset > 0) {
    const before = tx
      .select({ debit: journalLines.debit, credit: journalLines.credit })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
      .where(and(...rangeConds))
      .orderBy(...order)
      .limit(offset)
      .as("sebelum");
    const [b] = await tx.select({ d: sql<string>`coalesce(sum(${before.debit}),0)`, c: sql<string>`coalesce(sum(${before.credit}),0)` }).from(before);
    pageOpening += signedAmount(a.type, Number(b?.d ?? 0), Number(b?.c ?? 0));
  }
  const rows = total
    ? await tx
        .select({ l: journalLines, j: journals, period: accountingPeriods.period })
        .from(journalLines)
        .innerJoin(journals, eq(journals.id, journalLines.journalId))
        .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
        .where(and(...rangeConds))
        .orderBy(...order)
        .limit(limit)
        .offset(offset)
    : [];
  let running = pageOpening;
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
  const page_: LedgerPage = { offset, limit, total };
  return { account: a, opening, pageOpening, lines, closing: opening + signedAmount(a.type, debit, credit), debit, credit, page: page_ };
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
  // Segmen: s.d. akhir tahun lalu, awal tahun s.d. sebelum rentang, rentang laporan (dihitung sekali untuk ke-4 laporan).
  const src = new StatementAggregates(tx, tenantId, [yearStart(period), rangeOf(period, basis).fromPeriod], period);
  return {
    period,
    basis,
    generatedAt: now.toISOString(),
    trialBalance: await computeTrialBalance(tx, tenantId, period, basis, src),
    profitLoss: await computeProfitLoss(tx, tenantId, period, basis, src),
    balanceSheet: await computeBalanceSheet(tx, tenantId, period, src),
    cashFlow: await computeCashFlow(tx, tenantId, period, basis, src),
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
  filter: { accountId: string; profitCenter?: ProfitCenter | null; outletId?: string | null; fromPeriod: string; toPeriod?: string | null; offset?: number | null; limit?: number | null },
  opts: { tx?: Tx } = {},
) {
  await authorize(ctx, "m11.ledger.read", { tx: opts.tx });
  if (!isPeriodLabel(filter.fromPeriod)) throw new DomainError("INVALID_PERIOD", "Periode harus berformat YYYY-MM.");
  const toPeriod = filter.toPeriod && isPeriodLabel(filter.toPeriod) ? filter.toPeriod : filter.fromPeriod;
  const { offset, limit, ...rest } = filter;
  return computeLedger(opts.tx ?? getDb(), ctx.tenantId, { ...rest, toPeriod }, { offset, limit });
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
