/**
 * M11 — rekonsiliasi bank & kas (US-M11-06, P-07 langkah 4, US-M4-04/05, PTB-16):
 * - Bank per rekening per periode: saldo rekening (input dari rekening koran atau saldo impor mutasi M4) vs saldo buku;
 *   item penyesuai OTOMATIS dari pencocokan harian M4 (setoran dalam perjalanan, transfer belum dicocokkan, transfer
 *   tidak ditemukan tanpa piutang sementara) + item manual (biaya/bunga bank → dijurnal manual). Selisih harus NOL.
 * - Kas: kas kantor (hitung fisik tutup kas M4), kas awal tetap outlet (PAR-57), kas di tangan sopir (harus 0 setelah
 *   setoran diterima), kas kecil (hitung fisik M4) vs buku; selisih wajib beralasan & diselesaikan lewat alur selisih M4.
 * - Hasil (nol selisih, siapa, kapan, item) tersimpan per periode dan tampil bagi akuntan.
 */
import "server-only";

import { and, desc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  accountingPeriods,
  bankAccounts,
  bankReconciliations,
  bankStatementLines,
  cashDays,
  cashReconciliations,
  incomingTransfers,
  journalLines,
  journals,
  outlets,
  pettyCashCounts,
} from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { zRupiah } from "@/lib/money";
import { wibToUtc, addDays, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { resolveMapping } from "@/server/core/ledger";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";

import { isOpenStatus, loadPeriod, type PeriodRow } from "./common";
import { accountBalanceAt } from "./statements";

type CashKind = EnumValue<"cash_reconciliation_kind">;

export type AdjustingItem = {
  kind: "deposit_in_transit" | "unmatched_transfer" | "transfer_not_found" | "bank_fee" | "interest" | "other";
  description: string;
  /** Bertanda: rekening koran − buku (+ = rekening lebih besar). */
  amount: number;
  auto: boolean;
  blocking?: boolean;
  refType?: string | null;
  refId?: string | null;
  date?: string | null;
};

export const ADJUSTING_LABELS: Record<AdjustingItem["kind"], string> = {
  deposit_in_transit: "Setoran dalam perjalanan",
  unmatched_transfer: "Transfer belum dicocokkan",
  transfer_not_found: "Transfer tidak ditemukan",
  bank_fee: "Biaya bank",
  interest: "Bunga bank",
  other: "Lainnya",
};

async function mappedAccountId(tx: Tx, tenantId: string, event: string, entry: string, side: "debit" | "credit", date: BusinessDate): Promise<string | null> {
  const m = await resolveMapping(tx, event, entry, date, tenantId);
  return m ? (side === "debit" ? m.debitAccountId : m.creditAccountId) : null;
}

async function defaultBankGl(tx: Tx, tenantId: string, date: BusinessDate): Promise<string | null> {
  return mappedAccountId(tx, tenantId, "transfer.matched", "default", "debit", date);
}

/** Akhir hari periode (UTC) — status pencocokan dinilai per akhir periode. */
function periodEndInstant(period: PeriodRow): Date {
  return wibToUtc(addDays(period.endDate, 1), "00:00");
}

async function activityOn(tx: Tx, tenantId: string, periodId: string, accountId: string, outletId?: string | null): Promise<boolean> {
  const conds = [eq(journals.tenantId, tenantId), eq(journals.periodId, periodId), eq(journals.status, "posted"), eq(journalLines.accountId, accountId)];
  if (outletId) conds.push(eq(journalLines.outletId, outletId));
  const rows = await tx.select({ id: journalLines.id }).from(journalLines).innerJoin(journals, eq(journals.id, journalLines.journalId)).where(and(...conds)).limit(1);
  return rows.length > 0;
}

// =====================================================================================================================
// Bank
// =====================================================================================================================

export type BankRecView = {
  bankAccountId: string;
  bankName: string;
  accountNumber: string;
  glAccountId: string | null;
  sharedGl: boolean;
  bookBalance: number;
  autoItems: AdjustingItem[];
  suggestedStatementBalance: number | null;
  saved: typeof bankReconciliations.$inferSelect | null;
  required: boolean;
  zero: boolean;
};

async function bankAutoItems(tx: Tx, period: PeriodRow, bankAccountId: string, includeUnassigned: boolean): Promise<AdjustingItem[]> {
  const endAt = periodEndInstant(period);
  const accCond = includeUnassigned ? or(eq(incomingTransfers.bankAccountId, bankAccountId), isNull(incomingTransfers.bankAccountId)) : eq(incomingTransfers.bankAccountId, bankAccountId);
  const rows = await tx
    .select()
    .from(incomingTransfers)
    .where(
      and(
        eq(incomingTransfers.tenantId, period.tenantId),
        accCond,
        lte(incomingTransfers.transferDate, period.endDate),
        ne(incomingTransfers.status, "cancelled"),
        or(eq(incomingTransfers.status, "unmatched"), eq(incomingTransfers.status, "not_found"), and(eq(incomingTransfers.status, "matched"), gt(incomingTransfers.matchedAt, endAt))),
      ),
    );
  const items: AdjustingItem[] = [];
  for (const t of rows) {
    const slip = t.sourceKind === "bank_deposit_slip";
    if (t.status === "not_found") {
      items.push({
        kind: "transfer_not_found",
        description: `${label("transfer_source_kind", t.sourceKind)} ${t.reference ?? ""} — ${t.temporaryInvoiceId ? "piutang sementara terbentuk (M5)" : "belum diselesaikan"}`.trim(),
        amount: 0,
        auto: true,
        blocking: !t.temporaryInvoiceId,
        refType: "incoming_transfer",
        refId: t.id,
        date: t.transferDate,
      });
      continue;
    }
    items.push({
      kind: slip ? "deposit_in_transit" : "unmatched_transfer",
      description: `${label("transfer_source_kind", t.sourceKind)}${t.reference ? ` ${t.reference}` : ""}`,
      amount: slip ? -t.amount : t.amount,
      auto: true,
      refType: "incoming_transfer",
      refId: t.id,
      date: t.transferDate,
    });
  }
  return items;
}

export async function bankReconciliationViews(tx: Tx, period: PeriodRow): Promise<BankRecView[]> {
  const accs = await tx.select().from(bankAccounts).where(and(eq(bankAccounts.tenantId, period.tenantId), eq(bankAccounts.isActive, true)));
  const fallback = await defaultBankGl(tx, period.tenantId, period.endDate);
  const glCount = new Map<string, number>();
  for (const a of accs) {
    const gl = a.glAccountId ?? fallback;
    if (gl) glCount.set(gl, (glCount.get(gl) ?? 0) + 1);
  }
  const customerFacing = accs.find((a) => a.isCustomerFacing) ?? accs[0];
  const out: BankRecView[] = [];
  for (const a of accs) {
    const gl = a.glAccountId ?? fallback;
    const book = gl ? await accountBalanceAt(tx, period.tenantId, [gl], period.period) : 0;
    const autoItems = await bankAutoItems(tx, period, a.id, a.id === customerFacing?.id);
    const [stmt] = await tx
      .select({ balance: bankStatementLines.balance })
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.bankAccountId, a.id), lte(bankStatementLines.lineDate, period.endDate), sql`${bankStatementLines.balance} is not null`))
      .orderBy(desc(bankStatementLines.lineDate), desc(bankStatementLines.createdAt))
      .limit(1);
    const [saved] = await tx.select().from(bankReconciliations).where(and(eq(bankReconciliations.bankAccountId, a.id), eq(bankReconciliations.periodId, period.id))).limit(1);
    const activity = gl ? await activityOn(tx, period.tenantId, period.id, gl) : false;
    out.push({
      bankAccountId: a.id,
      bankName: a.bankName,
      accountNumber: a.accountNumber,
      glAccountId: gl,
      sharedGl: gl ? (glCount.get(gl) ?? 0) > 1 : false,
      bookBalance: book,
      autoItems,
      suggestedStatementBalance: stmt?.balance ?? null,
      saved: saved ?? null,
      required: activity || book !== 0 || autoItems.length > 0,
      zero: saved?.status === "zero_difference",
    });
  }
  return out;
}

const manualItemSchema = z
  .object({ kind: z.enum(["bank_fee", "interest", "other"]), description: z.string().trim().min(3).max(200), amount: zRupiah })
  .strict();

const bankSchema = z
  .object({
    periodId: z.uuid(),
    bankAccountId: z.uuid(),
    statementBalance: zRupiah,
    manualItems: z.array(manualItemSchema).max(50).default([]),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/** Simpan rekonsiliasi bank (Admin Keuangan). Status "Nol selisih" bila selisih 0 dan tidak ada item penghalang. */
export async function saveBankReconciliation(ctx: ActorContext, input: z.input<typeof bankSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.reconciliation.create", { tx: opts.tx });
  const data = parseInput(bankSchema, input, { statementBalance: "Saldo rekening koran" });
  return runService(ctx, opts, async (tx) => {
    const period = await loadPeriod(tx, ctx.tenantId, data.periodId, { forUpdate: true });
    if (!isOpenStatus(period.status)) throw new DomainError("PERIOD_NOT_OPEN", `Periode ${period.period} sudah ditutup/dikunci.`);
    const view = (await bankReconciliationViews(tx, period)).find((v) => v.bankAccountId === data.bankAccountId);
    if (!view) throw new NotFoundError("Rekening bank tidak ditemukan atau nonaktif.");
    const manual: AdjustingItem[] = data.manualItems.map((m) => ({ kind: m.kind, description: m.description, amount: m.amount, auto: false }));
    const items = [...view.autoItems, ...manual];
    const difference = data.statementBalance - view.bookBalance - items.reduce((s, i) => s + i.amount, 0);
    const blocking = items.some((i) => i.blocking);
    const zero = difference === 0 && !blocking;
    const values = {
      statementBalance: data.statementBalance,
      bookBalance: view.bookBalance,
      adjustingItems: items as unknown as Record<string, unknown>[],
      difference,
      status: (zero ? "zero_difference" : "in_progress") as "zero_difference" | "in_progress",
      completedBy: zero ? ctx.userId : null,
      completedAt: zero ? ctx.now : null,
      notes: data.notes ?? null,
    };
    const [row] = view.saved
      ? await tx.update(bankReconciliations).set({ ...values, updatedAt: new Date() }).where(eq(bankReconciliations.id, view.saved.id)).returning()
      : await tx.insert(bankReconciliations).values({ tenantId: ctx.tenantId, bankAccountId: data.bankAccountId, periodId: period.id, ...values }).returning();
    await auditRecord(tx, {
      ctx,
      objectType: "bank_reconciliation",
      objectId: row!.id,
      action: view.saved ? "update" : "create",
      before: view.saved ? { difference: view.saved.difference, status: view.saved.status } : null,
      after: { period: period.period, statementBalance: data.statementBalance, bookBalance: view.bookBalance, items: items.length, difference, status: values.status },
      rule: "US-M11-06 KP-1",
    });
    return { reconciliation: row!, difference, blocking, zero };
  });
}

// =====================================================================================================================
// Kas
// =====================================================================================================================

export type CashRecView = {
  kind: CashKind;
  outletId: string | null;
  label: string;
  accountId: string | null;
  systemBalance: number;
  suggestedPhysical: number | null;
  saved: typeof cashReconciliations.$inferSelect | null;
  required: boolean;
  zero: boolean;
};

export async function cashReconciliationViews(tx: Tx, period: PeriodRow): Promise<CashRecView[]> {
  const date = period.endDate;
  const office = await mappedAccountId(tx, period.tenantId, "deposit.received", "driver", "debit", date);
  const driver = await mappedAccountId(tx, period.tenantId, "trip.completed", "cash", "debit", date);
  const petty = await mappedAccountId(tx, period.tenantId, "petty_cash.recorded", "topup", "debit", date);
  const depotCash = await mappedAccountId(tx, period.tenantId, "pos_sale.recorded", "depot_cash", "debit", date);
  const storeCash = await mappedAccountId(tx, period.tenantId, "pos_sale.recorded", "store_cash", "debit", date);
  const saved = await tx.select().from(cashReconciliations).where(eq(cashReconciliations.periodId, period.id)).orderBy(desc(cashReconciliations.updatedAt));
  const savedFor = (kind: CashKind, outletId: string | null) => saved.find((s) => s.kind === kind && (s.outletId ?? null) === outletId) ?? null;
  const [lastDay] = await tx
    .select()
    .from(cashDays)
    .where(and(eq(cashDays.tenantId, period.tenantId), eq(cashDays.status, "closed"), lte(cashDays.businessDate, period.endDate), sql`${cashDays.businessDate} >= ${period.startDate}`))
    .orderBy(desc(cashDays.businessDate))
    .limit(1);
  const [lastPetty] = await tx
    .select()
    .from(pettyCashCounts)
    .where(and(eq(pettyCashCounts.tenantId, period.tenantId), lte(pettyCashCounts.countDate, period.endDate)))
    .orderBy(desc(pettyCashCounts.countDate), desc(pettyCashCounts.createdAt))
    .limit(1);
  const views: CashRecView[] = [];
  const add = async (kind: CashKind, text: string, accountId: string | null, outletId: string | null, suggested: number | null) => {
    const system = accountId ? await accountBalanceAt(tx, period.tenantId, [accountId], period.period, { outletId }) : 0;
    const activity = accountId ? await activityOn(tx, period.tenantId, period.id, accountId, outletId) : false;
    const s = savedFor(kind, outletId);
    views.push({ kind, outletId, label: text, accountId, systemBalance: system, suggestedPhysical: suggested, saved: s, required: activity || system !== 0, zero: s?.status === "zero_difference" });
  };
  await add("office_cash", "Kas kantor", office, null, lastDay?.officeCashPhysical ?? null);
  await add("driver_cash", "Kas di tangan sopir (harus 0 setelah setoran diterima)", driver, null, 0);
  await add("petty_cash", "Kas kecil", petty, null, lastPetty?.physicalAmount ?? null);
  const outletRows = await tx.select().from(outlets).where(and(eq(outlets.tenantId, period.tenantId), eq(outlets.isActive, true)));
  for (const o of outletRows) {
    const { amount } = await params.get(tx, "PAR-57", period.endDate, { tenantId: period.tenantId, outletId: o.id });
    await add("outlet_fixed_cash", `Kas awal tetap ${o.name}`, o.kind === "store" ? storeCash : depotCash, o.id, amount);
  }
  return views;
}

const cashSchema = z
  .object({
    periodId: z.uuid(),
    kind: z.enum(["office_cash", "outlet_fixed_cash", "driver_cash", "petty_cash"]),
    outletId: z.uuid().nullable().optional(),
    physicalBalance: zRupiah,
    reason: z.string().trim().max(500).nullable().optional(),
    discrepancyId: z.uuid().nullable().optional(),
  })
  .strict();

/** Simpan rekonsiliasi kas: selisih ≠ 0 wajib beralasan & diselesaikan lewat alur selisih M4 (status tetap Berjalan). */
export async function saveCashReconciliation(ctx: ActorContext, input: z.input<typeof cashSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.reconciliation.create", { tx: opts.tx });
  const data = parseInput(cashSchema, input, { physicalBalance: "Saldo fisik" });
  return runService(ctx, opts, async (tx) => {
    const period = await loadPeriod(tx, ctx.tenantId, data.periodId, { forUpdate: true });
    if (!isOpenStatus(period.status)) throw new DomainError("PERIOD_NOT_OPEN", `Periode ${period.period} sudah ditutup/dikunci.`);
    const view = (await cashReconciliationViews(tx, period)).find((v) => v.kind === data.kind && v.outletId === (data.outletId ?? null));
    if (!view) throw new NotFoundError("Jenis rekonsiliasi kas tidak ditemukan.");
    const difference = data.physicalBalance - view.systemBalance;
    if (difference !== 0 && (data.reason?.length ?? 0) < 5) {
      throw new DomainError("REASON_REQUIRED", "Selisih kas wajib beralasan (minimal 5 karakter) dan diselesaikan lewat alur Selisih di Kas & Setoran.");
    }
    const zero = difference === 0;
    const values = {
      systemBalance: view.systemBalance,
      physicalBalance: data.physicalBalance,
      difference,
      reason: data.reason ?? null,
      discrepancyId: data.discrepancyId ?? null,
      status: (zero ? "zero_difference" : "in_progress") as "zero_difference" | "in_progress",
      completedBy: zero ? ctx.userId : null,
      completedAt: zero ? ctx.now : null,
    };
    const [row] = view.saved
      ? await tx.update(cashReconciliations).set({ ...values, updatedAt: new Date() }).where(eq(cashReconciliations.id, view.saved.id)).returning()
      : await tx.insert(cashReconciliations).values({ tenantId: ctx.tenantId, periodId: period.id, kind: data.kind, outletId: data.outletId ?? null, ...values }).returning();
    await auditRecord(tx, {
      ctx,
      objectType: "cash_reconciliation",
      objectId: row!.id,
      action: view.saved ? "update" : "create",
      after: { period: period.period, kind: data.kind, outletId: data.outletId ?? null, system: view.systemBalance, physical: data.physicalBalance, difference },
      reason: data.reason ?? null,
      rule: "US-M11-06 KP-2",
    });
    return { reconciliation: row!, difference, zero };
  });
}

/** Ringkasan rekonsiliasi periode (Admin Keuangan mengerjakan; akuntan & pemilik melihat). */
export async function reconciliationOverview(ctx: ActorContext, input: { periodId: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.reconciliation.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const period = await loadPeriod(tx, ctx.tenantId, input.periodId);
  const bank = await bankReconciliationViews(tx, period);
  const cash = await cashReconciliationViews(tx, period);
  return {
    period,
    bank,
    cash,
    bankOk: bank.every((b) => !b.required || b.zero),
    cashOk: cash.every((c) => !c.required || c.zero),
  };
}

/** Periode-periode yang punya rekonsiliasi tersimpan (riwayat untuk akuntan). */
export async function reconciliationHistory(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.reconciliation.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const bank = await tx
    .select({ r: bankReconciliations, period: accountingPeriods.period, bankName: bankAccounts.bankName, accountNumber: bankAccounts.accountNumber })
    .from(bankReconciliations)
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, bankReconciliations.periodId))
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankReconciliations.bankAccountId))
    .where(eq(bankReconciliations.tenantId, ctx.tenantId))
    .orderBy(desc(accountingPeriods.period));
  const cash = await tx
    .select({ r: cashReconciliations, period: accountingPeriods.period })
    .from(cashReconciliations)
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, cashReconciliations.periodId))
    .where(eq(cashReconciliations.tenantId, ctx.tenantId))
    .orderBy(desc(accountingPeriods.period));
  return { bank, cash };
}

/** Ringkasan rekonsiliasi (tanpa otorisasi) — prasyarat tutup periode. */
export async function reconciliationOverviewTx(tx: Tx, period: PeriodRow) {
  return { bank: await bankReconciliationViews(tx, period), cash: await cashReconciliationViews(tx, period) };
}
