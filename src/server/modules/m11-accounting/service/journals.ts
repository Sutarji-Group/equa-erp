/**
 * M11 — kueri jurnal & ketertelusuran dua arah (US-M11-02 KP-5, US-M11-04 KP-3): daftar jurnal, rincian (baris, akun,
 * sumber, pembalik, persetujuan, lampiran), jurnal per transaksi sumber, dan tautan ke layar sumber.
 */
import "server-only";

import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, type SQL } from "drizzle-orm";

import { accountingPeriods, accounts, journalLines, journalPayables, journalQueue, journals, manualJournalDetails, outlets, trips } from "@/db/schema";
import type { JournalKind, JournalStatus } from "@/lib/labels";
import type { BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { NotFoundError } from "@/server/core/errors";
import { authorize } from "@/server/core/rbac";

import { SOURCE_MODULE, SOURCE_OBJECT_LABELS } from "../constants";

export type JournalFilter = {
  from?: BusinessDate | null;
  to?: BusinessDate | null;
  period?: string | null;
  kind?: JournalKind | null;
  status?: JournalStatus | null;
  sourceType?: string | null;
  sourceObjectType?: string | null;
  sourceObjectId?: string | null;
  q?: string | null;
  /** Daftar tinjauan pemilik periode (PTB-12). */
  reviewPeriod?: string | null;
  limit?: number;
};

export async function listJournals(ctx: ActorContext, filter: JournalFilter = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.journal.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds: SQL[] = [eq(journals.tenantId, ctx.tenantId)];
  if (filter.from) conds.push(gte(journals.journalDate, filter.from));
  if (filter.to) conds.push(lte(journals.journalDate, filter.to));
  if (filter.period) conds.push(eq(accountingPeriods.period, filter.period));
  if (filter.kind) conds.push(eq(journals.kind, filter.kind));
  if (filter.status) conds.push(eq(journals.status, filter.status));
  if (filter.sourceType) conds.push(eq(journals.sourceType, filter.sourceType));
  if (filter.sourceObjectType) conds.push(eq(journals.sourceObjectType, filter.sourceObjectType));
  if (filter.sourceObjectId) conds.push(eq(journals.sourceObjectId, filter.sourceObjectId));
  if (filter.q) conds.push(or(ilike(journals.number, `%${filter.q}%`), ilike(journals.description, `%${filter.q}%`))!);
  if (filter.reviewPeriod) conds.push(eq(accountingPeriods.period, filter.reviewPeriod), eq(journals.requiresOwnerReview, true), eq(journals.status, "posted"));
  const rows = await tx
    .select({ j: journals, period: accountingPeriods.period })
    .from(journals)
    .leftJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .where(and(...conds))
    .orderBy(desc(journals.journalDate), desc(journals.createdAt))
    .limit(Math.min(filter.limit ?? 300, 2000));
  const ids = rows.map((r) => r.j.id);
  const reversed = ids.length ? new Set((await tx.select({ id: journals.reversalOfId }).from(journals).where(inArray(journals.reversalOfId, ids))).map((r) => r.id)) : new Set<string | null>();
  return rows.map(({ j, period }) => ({
    ...j,
    period,
    module: j.sourceType ? (SOURCE_MODULE[j.sourceType] ?? (j.sourceType === "manual" ? "M11" : null)) : null,
    reversed: reversed.has(j.id),
  }));
}

/** Tautan layar transaksi sumber (ketertelusuran jurnal → sumber). */
export async function sourceLink(tx: Tx, type: string | null, id: string | null): Promise<{ label: string; href: string | null } | null> {
  if (!type || !id) return null;
  const text = SOURCE_OBJECT_LABELS[type] ?? type;
  switch (type) {
    case "trip": {
      const [t] = await tx.select({ orderId: trips.orderId, number: trips.number }).from(trips).where(eq(trips.id, id)).limit(1);
      return { label: `${text} ${t?.number ?? ""}`.trim(), href: t ? `/pesanan/${t.orderId}` : null };
    }
    case "deposit":
      return { label: text, href: `/kas/setoran/${id}` };
    case "invoice":
      return { label: text, href: `/piutang/faktur/${id}` };
    case "customer_payment":
      return { label: text, href: `/piutang/pelunasan/${id}` };
    case "purchase_receipt":
      return { label: text, href: `/toko/pembelian/${id}` };
    case "stock_count":
      return { label: text, href: `/toko/opname/${id}` };
    case "fixed_asset":
      return { label: text, href: `/akuntansi/aset/${id}` };
    case "journal":
      return { label: text, href: `/akuntansi/jurnal/${id}` };
    case "accounting_period":
      return { label: text, href: `/akuntansi/periode/${id}` };
    case "opening_balance_batch":
      return { label: text, href: "/akuntansi/saldo-awal" };
    case "discrepancy":
      return { label: text, href: "/kas/selisih" };
    case "incoming_transfer":
      return { label: text, href: "/kas/transfer" };
    case "bank_deposit":
    case "office_cash_movement":
      return { label: text, href: "/kas/kantor" };
    case "petty_cash_transaction":
    case "petty_cash_count":
      return { label: text, href: "/kas/kas-kecil" };
    case "restitution_settlement":
      return { label: text, href: "/kas/ganti-rugi" };
    case "supplier_payment":
      return { label: text, href: "/toko/utang" };
    case "trip_expense":
      return { label: text, href: "/kas/setoran" };
    case "pos_sale":
    case "shift":
    case "consumable_receipt":
    case "water_supply_receipt":
      return { label: text, href: "/outlet" };
    case "store_return":
    case "internal_transfer":
      return { label: text, href: "/toko/laporan" };
    default:
      return { label: text, href: null };
  }
}

export async function getJournalDetail(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.journal.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const [row] = await tx
    .select({ j: journals, period: accountingPeriods.period, periodStatus: accountingPeriods.status })
    .from(journals)
    .leftJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .where(and(eq(journals.id, id), eq(journals.tenantId, ctx.tenantId)))
    .limit(1);
  if (!row) throw new NotFoundError("Jurnal tidak ditemukan.");
  const lines = await tx
    .select({ l: journalLines, code: accounts.code, name: accounts.name, type: accounts.type, outletName: outlets.name })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(outlets, eq(outlets.id, journalLines.outletId))
    .where(eq(journalLines.journalId, id))
    .orderBy(asc(journalLines.lineNo));
  const [reversedBy] = await tx.select({ id: journals.id, number: journals.number, kind: journals.kind }).from(journals).where(eq(journals.reversalOfId, id)).limit(1);
  const reversalOf = row.j.reversalOfId ? (await tx.select({ id: journals.id, number: journals.number }).from(journals).where(eq(journals.id, row.j.reversalOfId)).limit(1))[0] : null;
  const [details] = await tx.select().from(manualJournalDetails).where(eq(manualJournalDetails.journalId, id)).limit(1);
  const [payable] = await tx.select().from(journalPayables).where(eq(journalPayables.journalId, id)).limit(1);
  const approval = row.j.approvalRequestId ? await approvals.getApproval(tx, row.j.approvalRequestId) : null;
  const pendingApprovals = (await approvals.listForObject(tx, "journal", id)).filter((a) => a.status === "submitted");
  const queue = row.j.sourceEventId ? (await tx.select().from(journalQueue).where(eq(journalQueue.domainEventId, row.j.sourceEventId)).limit(5)) : [];
  return {
    journal: row.j,
    period: row.period,
    periodStatus: row.periodStatus,
    lines: lines.map((r) => ({ ...r.l, accountCode: r.code, accountName: r.name, accountType: r.type, outletName: r.outletName })),
    source: await sourceLink(tx, row.j.sourceObjectType, row.j.sourceObjectId),
    module: row.j.sourceType ? (SOURCE_MODULE[row.j.sourceType] ?? null) : null,
    reversedBy: reversedBy ?? null,
    reversalOf: reversalOf ?? null,
    details: details ?? null,
    payable: payable ?? null,
    approval,
    pendingApprovals,
    queue,
  };
}

/** Jurnal untuk satu transaksi sumber (ketertelusuran sumber → jurnal). */
export async function journalsForSource(ctx: ActorContext, input: { type: string; id: string }, opts: { tx?: Tx } = {}) {
  return listJournals(ctx, { sourceObjectType: input.type, sourceObjectId: input.id }, opts);
}

/** Jurnal manual yang belum terposting (draf/diajukan/ditolak). */
export async function openManualJournals(tx: Tx, tenantId: string) {
  return tx
    .select()
    .from(journals)
    .where(and(eq(journals.tenantId, tenantId), inArray(journals.status, ["draft", "submitted"]), isNull(journals.reversalOfId)))
    .orderBy(desc(journals.createdAt));
}
