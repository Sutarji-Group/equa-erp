/**
 * M11 — utang usaha (US-M11-07, S): gabungan utang dari nota pembelian M7 (termasuk saldo awal utang ber-tanda-tangan,
 * US-M7-08) dan jurnal manual bertanda utang; umur & jadwal pembayaran; pembayaran M4/M7 mengurangi utang nota,
 * jurnal pembayaran mengurangi utang manual; laporan per pemasok & jatuh tempo; pengingat (Bab 6.3).
 */
import "server-only";

import { and, asc, eq, inArray, lte, ne } from "drizzle-orm";

import { journalPayables, journals, notifications, suppliers } from "@/db/schema";
import { addDays, daysBetween, toBusinessDate, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize } from "@/server/core/rbac";
import { payableRows } from "@/server/modules/m7-store";

import { accountBalanceAt } from "./statements";
import { inJobTx, isAccountingTenant, mappingAccounts } from "./common";
import { monthOf } from "@/lib/time";

export type AgingBucket = "not_due" | "d1_7" | "d8_30" | "over_30";
export const PAYABLE_AGING_LABELS: Record<AgingBucket, string> = { not_due: "Belum jatuh tempo", d1_7: "1–7 hari", d8_30: "8–30 hari", over_30: "> 30 hari" };

function bucketOf(dueDate: string | null, asOf: BusinessDate): { bucket: AgingBucket; daysOverdue: number } {
  if (!dueDate) return { bucket: "not_due", daysOverdue: 0 };
  const d = daysBetween(dueDate, asOf);
  if (d <= 0) return { bucket: "not_due", daysOverdue: 0 };
  return { bucket: d <= 7 ? "d1_7" : d <= 30 ? "d8_30" : "over_30", daysOverdue: d };
}

export type PayableViewRow = {
  source: "purchase_receipt" | "journal";
  id: string;
  number: string | null;
  supplierId: string | null;
  supplierName: string;
  description: string;
  businessDate: string;
  dueDate: string | null;
  total: number;
  paid: number;
  outstanding: number;
  daysOverdue: number;
  bucket: AgingBucket;
  isOpening: boolean;
  href: string;
};

/** Utang terbuka per tanggal (tanpa otorisasi). */
export async function payableViewRows(tx: Tx, tenantId: string, asOf: BusinessDate): Promise<PayableViewRow[]> {
  const nota = await payableRows(tx, tenantId, asOf);
  const rows: PayableViewRow[] = nota.map((r) => ({
    source: "purchase_receipt",
    id: r.receiptId,
    number: r.supplierNoteNumber ?? r.number,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    description: `Nota ${r.supplierNoteNumber ?? r.number ?? ""} (${r.outletName})`.trim(),
    businessDate: r.businessDate,
    dueDate: r.dueDate,
    total: r.total,
    paid: r.paid + r.returned,
    outstanding: r.outstanding,
    daysOverdue: r.daysOverdue,
    bucket: r.bucket,
    isOpening: r.isOpeningPayable,
    href: `/toko/pembelian/${r.receiptId}`,
  }));
  const manual = await tx
    .select({ p: journalPayables, number: journals.number, date: journals.journalDate, supplierName: suppliers.name })
    .from(journalPayables)
    .innerJoin(journals, eq(journals.id, journalPayables.journalId))
    .leftJoin(suppliers, eq(suppliers.id, journalPayables.supplierId))
    .where(and(eq(journalPayables.tenantId, tenantId), ne(journalPayables.status, "paid"), lte(journals.journalDate, asOf)))
    .orderBy(asc(journalPayables.dueDate));
  for (const m of manual) {
    const ag = bucketOf(m.p.dueDate, asOf);
    rows.push({
      source: "journal",
      id: m.p.id,
      number: m.number,
      supplierId: m.p.supplierId,
      supplierName: m.supplierName ?? m.p.payeeName,
      description: m.p.description,
      businessDate: m.date,
      dueDate: m.p.dueDate,
      total: m.p.amount,
      paid: m.p.settledAmount,
      outstanding: m.p.amount - m.p.settledAmount,
      daysOverdue: ag.daysOverdue,
      bucket: ag.bucket,
      isOpening: false,
      href: `/akuntansi/jurnal/${m.p.journalId}`,
    });
  }
  return rows.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
}

/** Layar utang usaha: per dokumen, per pemasok & umur, jadwal bayar per minggu, cek saldo buku. */
export async function payablesView(ctx: ActorContext, filter: { asOf?: BusinessDate | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.payable.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const asOf = filter.asOf ?? ctxBusinessDate(ctx);
  const rows = await payableViewRows(tx, ctx.tenantId, asOf);
  const bySupplier = new Map<string, { supplierName: string; total: number } & Record<AgingBucket, number>>();
  for (const r of rows) {
    const key = r.supplierId ?? `payee:${r.supplierName}`;
    const cur = bySupplier.get(key) ?? { supplierName: r.supplierName, total: 0, not_due: 0, d1_7: 0, d8_30: 0, over_30: 0 };
    cur.total += r.outstanding;
    cur[r.bucket] += r.outstanding;
    bySupplier.set(key, cur);
  }
  const schedule = new Map<string, number>();
  for (const r of rows) {
    const week = r.dueDate && r.dueDate >= asOf ? r.dueDate.slice(0, 7) : "Lewat jatuh tempo";
    schedule.set(week, (schedule.get(week) ?? 0) + r.outstanding);
  }
  const payableAccount = await mappingAccounts(tx, ctx.tenantId, "purchase_receipt.recorded", "credit", asOf).catch(() => null);
  const bookBalance = payableAccount ? -(await accountBalanceAt(tx, ctx.tenantId, [payableAccount.creditAccountId], monthOf(asOf))) : null;
  return {
    asOf,
    rows,
    bySupplier: [...bySupplier.values()].sort((a, b) => b.total - a.total),
    schedule: [...schedule.entries()].map(([when, amount]) => ({ when, amount })),
    total: rows.reduce((s, r) => s + r.outstanding, 0),
    bookBalance,
  };
}

/** Job harian: pengingat utang jurnal manual jatuh tempo ≤ N hari (utang nota diingatkan M7). */
export async function runJournalPayableReminders(now: Date, opts: { db?: Tx } = {}): Promise<number> {
  const run = async (tx: Tx) => {
    const today = toBusinessDate(now);
    const rules = await params.get(tx, "m11.accounting_rules", today);
    const horizon = addDays(today, rules.payable_reminder_days_before);
    const due = await tx
      .select()
      .from(journalPayables)
      .where(and(inArray(journalPayables.status, ["open", "partial"]), lte(journalPayables.dueDate, horizon)));
    let sent = 0;
    for (const p of due) {
      if (!(await isAccountingTenant(tx, p.tenantId))) continue;
      const groupKey = `supplier_payable.due:journal:${p.id}:${p.dueDate <= today ? "due" : "soon"}`;
      const [dup] = await tx.select({ id: notifications.id }).from(notifications).where(eq(notifications.groupKey, groupKey)).limit(1);
      if (dup) continue;
      await notify(tx, {
        event: "supplier_payable.due",
        tenantId: p.tenantId,
        title: `Utang ${p.payeeName} jatuh tempo ${p.dueDate}`,
        body: `${p.description} — sisa Rp ${(p.amount - p.settledAmount).toLocaleString("id-ID")}.`,
        objectType: "journal_payable",
        objectId: p.id,
        valueAmount: p.amount - p.settledAmount,
        groupKey,
        link: "/akuntansi/utang",
        now,
      });
      sent++;
    }
    return sent;
  };
  return inJobTx(opts.db, run);
}
