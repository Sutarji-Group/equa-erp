/**
 * P3 — laporan bulanan mitra (RL-7 US-P3-10 KP-3; BRD 9.8 kewajiban EQUA): terbit otomatis tanggal
 * `p3.partner_rules.monthly_report_day` (bawaan 5) untuk bulan lalu, disimpan sebagai snapshot (`partner_monthly_reports`)
 * dan dapat diunduh PDF (`/api/export/p3.partner_monthly?format=pdf&period=YYYY-MM`, US-M9-03).
 *
 * Isi = data yang SAMA dengan yang dipakai EQUA (fungsi laporan M6 berlingkup tenant mitra, neraca air P3, faktur &
 * pelunasan M5): penjualan per hari per outlet, galon, void, selisih shift, pasokan diterima, neraca air versi mitra,
 * tagihan & pembayaran, kepatuhan SLA dukungan (US-P3-11 KP-2), dan (Tahap 3) skor mutu.
 */
import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { customerPayments, invoices, partnerMonthlyReports, partnerScores, paymentAllocations } from "@/db/schema";
import { addDays, firstDayOfMonth, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";
import { dailyOutletReport, waterSupplyReport, type DailyOutletRow } from "@/server/modules/m6-pos";

import { assertOwnerTenant, contractsLiveOn, isValidMonth, loadPartnerTenant, monthKey, monthRange, partnerCustomersOf, partnerRules, partnerTenants, partnerTerms } from "./common";
import { partnerWaterBalance, purchaseHistory, type PartnerWaterBalanceRow, type PurchaseHistoryRow } from "./supply";
import { supportSlaSummary, type SupportSlaSummary } from "./support";

export type MonthlyReportOutlet = {
  outletId: string;
  outletCode: string;
  outletName: string;
  salesTotal: number;
  transactions: number;
  gallons: number;
  voidCount: number;
  voidAmount: number;
  cashDifference: number;
  shiftsClosed: number;
  supplyCount: number;
  supplyReceivedL: number;
};

export type MonthlyReportInvoice = { id: string; number: string; kind: string; issueDate: string; dueDate: string; amount: number; paidAmount: number; outstandingAmount: number; status: string };
export type MonthlyReportPayment = { invoiceNumber: string; businessDate: string; method: string; amount: number };

export type PartnerMonthlyReportData = {
  tenantId: string;
  tenantName: string;
  programName: string;
  month: string;
  from: BusinessDate;
  to: BusinessDate;
  generatedAt: string;
  outlets: MonthlyReportOutlet[];
  daily: Pick<DailyOutletRow, "outletCode" | "businessDate" | "salesTotal" | "transactions" | "gallons" | "voidCount" | "voidAmount" | "cashDifference" | "shiftsClosed">[];
  waterBalance: PartnerWaterBalanceRow[];
  purchases: PurchaseHistoryRow | null;
  invoices: MonthlyReportInvoice[];
  payments: MonthlyReportPayment[];
  sla: SupportSlaSummary;
  quality: { outletId: string; totalScore: number; belowThreshold: boolean }[];
  totals: { salesTotal: number; gallons: number; voidCount: number; supplyReceivedL: number; invoiced: number; paid: number; outstanding: number };
};

/** Susun data laporan bulanan satu tenant mitra (tanpa menulis). */
export async function buildMonthlyReportData(tx: Tx, tenantId: string, month: string, now: Date): Promise<PartnerMonthlyReportData> {
  const tenant = await loadPartnerTenant(tx, tenantId);
  const { from, to } = monthRange(month);
  // Fungsi laporan M6 berlingkup tenant pelaku → pelaku sistem pada tenant mitra (data yang sama dengan portal/EQUA).
  const sys = systemContext({ tenantId, now, businessDate: to });
  const daily = await dailyOutletReport(sys, { from, to }, { tx });
  const supply = await waterSupplyReport(sys, { from, to }, { tx });
  const balance = await partnerWaterBalance(tx, tenantId, month);
  const outletIds = [...new Set([...daily.map((d) => d.outletId), ...balance.map((b) => b.outletId)])];
  const outlets: MonthlyReportOutlet[] = outletIds.map((id) => {
    const rows = daily.filter((d) => d.outletId === id);
    const sup = supply.filter((s) => s.outletId === id && s.source === "equa_truck");
    const bal = balance.find((b) => b.outletId === id);
    return {
      outletId: id,
      outletCode: rows[0]?.outletCode ?? bal?.outletCode ?? "",
      outletName: rows[0]?.outletName ?? bal?.outletName ?? "",
      salesTotal: rows.reduce((s, r) => s + r.salesTotal, 0),
      transactions: rows.reduce((s, r) => s + r.transactions, 0),
      gallons: rows.reduce((s, r) => s + r.gallons, 0),
      voidCount: rows.reduce((s, r) => s + r.voidCount, 0),
      voidAmount: rows.reduce((s, r) => s + r.voidAmount, 0),
      cashDifference: rows.reduce((s, r) => s + r.cashDifference, 0),
      shiftsClosed: rows.reduce((s, r) => s + r.shiftsClosed, 0),
      supplyCount: sup.length,
      supplyReceivedL: sup.reduce((s, r) => s + (r.receivedVolumeL ?? (r.status === "auto_accepted" ? (r.deliveredVolumeL ?? 0) : 0)), 0),
    };
  });
  const custIds = (await partnerCustomersOf(tx, tenantId)).map((c) => c.id);
  const inv = custIds.length
    ? await tx
        .select()
        .from(invoices)
        .where(and(inArray(invoices.customerId, custIds)))
        .orderBy(desc(invoices.issueDate))
    : [];
  const periodInvoices = inv.filter((i) => (i.issueDate >= from && i.issueDate <= addDays(to, 31)) || i.outstandingAmount > 0);
  const payRows = periodInvoices.length
    ? await tx
        .select({ invoiceId: paymentAllocations.invoiceId, amount: paymentAllocations.amount, businessDate: customerPayments.businessDate, method: customerPayments.method })
        .from(paymentAllocations)
        .innerJoin(customerPayments, eq(customerPayments.id, paymentAllocations.customerPaymentId))
        .where(inArray(paymentAllocations.invoiceId, periodInvoices.map((i) => i.id)))
        .orderBy(asc(customerPayments.businessDate))
    : [];
  const quality = await tx
    .select({ outletId: partnerScores.outletId, totalScore: partnerScores.totalScore, belowThreshold: partnerScores.belowThreshold })
    .from(partnerScores)
    .where(and(eq(partnerScores.tenantId, tenantId), eq(partnerScores.period, month)));
  const purchases = (await purchaseHistory(tx, tenantId, { from, to })).find((p) => p.month === month) ?? null;
  const terms = await partnerTerms(tx);
  const invOut = periodInvoices.map((i) => ({ id: i.id, number: i.number, kind: i.kind, issueDate: i.issueDate, dueDate: i.dueDate, amount: i.amount, paidAmount: i.paidAmount, outstandingAmount: i.outstandingAmount, status: i.status }));
  return {
    tenantId,
    tenantName: tenant.name,
    programName: terms.program,
    month,
    from,
    to,
    generatedAt: now.toISOString(),
    outlets,
    daily: daily
      .map((d) => ({ outletCode: d.outletCode, businessDate: d.businessDate, salesTotal: d.salesTotal, transactions: d.transactions, gallons: d.gallons, voidCount: d.voidCount, voidAmount: d.voidAmount, cashDifference: d.cashDifference, shiftsClosed: d.shiftsClosed }))
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.outletCode.localeCompare(b.outletCode)),
    waterBalance: balance,
    purchases,
    invoices: invOut,
    payments: payRows.map((p) => ({ invoiceNumber: periodInvoices.find((i) => i.id === p.invoiceId)?.number ?? "", businessDate: p.businessDate, method: p.method, amount: p.amount })),
    sla: await supportSlaSummary(tx, tenantId, month, now),
    quality: quality.map((q) => ({ outletId: q.outletId, totalScore: q.totalScore, belowThreshold: q.belowThreshold })),
    totals: {
      salesTotal: outlets.reduce((s, o) => s + o.salesTotal, 0),
      gallons: outlets.reduce((s, o) => s + o.gallons, 0),
      voidCount: outlets.reduce((s, o) => s + o.voidCount, 0),
      supplyReceivedL: outlets.reduce((s, o) => s + o.supplyReceivedL, 0),
      invoiced: invOut.reduce((s, i) => s + i.amount, 0),
      paid: invOut.reduce((s, i) => s + i.paidAmount, 0),
      outstanding: invOut.reduce((s, i) => s + i.outstandingAmount, 0),
    },
  };
}

export type MonthlyReportRow = typeof partnerMonthlyReports.$inferSelect;

/** Terbitkan (sekali; snapshot tidak diubah) laporan bulanan satu tenant mitra + notifikasi pemilik mitra. */
export async function publishMonthlyReport(tx: Tx, tenantId: string, month: string, now: Date): Promise<{ report: MonthlyReportRow; created: boolean }> {
  const [existing] = await tx.select().from(partnerMonthlyReports).where(and(eq(partnerMonthlyReports.tenantId, tenantId), eq(partnerMonthlyReports.period, month))).limit(1);
  if (existing) return { report: existing, created: false };
  const data = await buildMonthlyReportData(tx, tenantId, month, now);
  const [row] = await tx
    .insert(partnerMonthlyReports)
    .values({ tenantId, period: month, data: data as unknown as Record<string, unknown>, slaSummary: data.sla as unknown as Record<string, unknown>, publishedAt: now })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [again] = await tx.select().from(partnerMonthlyReports).where(and(eq(partnerMonthlyReports.tenantId, tenantId), eq(partnerMonthlyReports.period, month))).limit(1);
    return { report: again!, created: false };
  }
  const sys = systemContext({ tenantId, now });
  await auditRecord(tx, { ctx: sys, objectType: "partner_monthly_report", objectId: row.id, action: "publish", after: { period: month, salesTotal: data.totals.salesTotal, outstanding: data.totals.outstanding }, rule: "US-P3-10 KP-3" });
  await notify(tx, {
    event: "partner.monthly_report_published",
    tenantId,
    recipients: { roles: ["partner_owner"] },
    title: `Laporan bulanan ${data.programName} ${month} terbit`,
    body: `Penjualan, galon, pasokan air, neraca air, tagihan & kepatuhan SLA bulan ${month}. Unduh PDF dari portal mitra.`,
    objectType: "partner_monthly_report",
    objectId: row.id,
    link: `/mitra/laporan-bulanan?periode=${month}`,
    now,
  });
  return { report: row, created: true };
}

export type MonthlyReportRunSummary = { month: string; published: string[]; notDue?: boolean };

/** Job harian: pada/sesudah tanggal terbit, terbitkan laporan bulan lalu untuk tiap mitra (idempoten per tenant-bulan). */
export async function runMonthlyReports(now: Date, opts: { db?: Db; date?: BusinessDate; force?: boolean } = {}): Promise<MonthlyReportRunSummary> {
  const date = opts.date ?? toBusinessDate(now);
  const month = monthKey(addDays(firstDayOfMonth(date), -1));
  return withTx(
    async (tx) => {
      const rules = await partnerRules(tx, date);
      if (!opts.force && Number(date.slice(8, 10)) < rules.monthly_report_day) return { month, published: [], notDue: true };
      const { from, to } = monthRange(month);
      const withContract = new Set((await contractsLiveOn(tx, from, to)).map((c) => c.tenantId));
      const published: string[] = [];
      for (const tenant of await partnerTenants(tx, { includeInactive: true })) {
        if (!withContract.has(tenant.id)) continue;
        const res = await publishMonthlyReport(tx, tenant.id, month, now);
        if (res.created) published.push(tenant.id);
      }
      return { month, published };
    },
    opts.db ? { db: opts.db } : {},
  );
}

/** Admin Keuangan: terbitkan laporan bulanan sekarang (bulan tertentu; tetap sekali per tenant-bulan). */
export async function publishMonthlyReportsNow(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<MonthlyReportRunSummary> {
  await authorize(ctx, "p3.partner_report.publish", { tx: opts.tx });
  const today = ctxBusinessDate(ctx);
  const month = isValidMonth(input.month) ? input.month! : monthKey(addDays(firstDayOfMonth(today), -1));
  if (`${month}-01` >= firstDayOfMonth(today)) throw new DomainError("MONTH_NOT_CLOSED", "Laporan bulanan hanya untuk bulan yang sudah berakhir.");
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const { from, to } = monthRange(month);
    const published: string[] = [];
    for (const c of await contractsLiveOn(tx, from, to)) {
      const res = await publishMonthlyReport(tx, c.tenantId, month, ctx.now);
      if (res.created) published.push(c.tenantId);
    }
    return { month, published };
  });
}

/** Daftar laporan bulanan (tanpa otorisasi; pemanggil memastikan tenant). */
export async function monthlyReportsOf(tx: Tx, tenantId: string): Promise<MonthlyReportRow[]> {
  return tx.select().from(partnerMonthlyReports).where(eq(partnerMonthlyReports.tenantId, tenantId)).orderBy(desc(partnerMonthlyReports.period));
}
