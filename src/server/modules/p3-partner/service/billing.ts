/**
 * P3 — tagihan mitra bulanan (RL-7 US-P3-09; Tahap 3 US-P3-04). Satu faktur M5 per kontrak per bulan layanan
 * (`invoices.kind = partner_subscription`, nomor `F-YY-NNNNNN`, periode = hari pertama bulan layanan, kontrak tertaut):
 *
 * - KP-1: langganan sistem = jumlah outlet AKTIF di bulan layanan (`outlets.activated_on`/`billing_start_date`,
 *   `deactivated_at`) × tarif kontrak (bawaan PAR-35); terbit tanggal PAR-12 bulan berikutnya (bawaan tgl 1), jatuh
 *   tempo PAR-12 (bawaan tgl 15). Job terlambat → tanggal faktur = tanggal jalan (sama dengan M5).
 * - KP-2: faktur mengikuti M5 (pelunasan, pengingat, umur piutang lini "Kemitraan", Ditahan) karena ditulis ke tabel
 *   faktur M5 dengan kolom yang sama. Mitra bertanda tagihan bulanan (kontrak + pelanggan, BR-05): rit air tempo yang
 *   belum ditagih (`unbilled_charges`) DIGABUNG ke faktur yang sama (baris komponen "Air").
 * - KP-3: `partner.subscription_invoiced` → M11 menjurnal pendapatan L5 (hanya langganan + royalti + fee awal; air
 *   gabungan sudah diakui saat rit Selesai, D-10). Opsi B TANPA royalti.
 * - KP-4: faktur tidak dapat dihapus (trigger DB); koreksi = nota kredit beralasan M5 (`requestCreditNote`).
 * - US-P3-04 (Tahap 3, flag): royalti = % kontrak × omzet POS Sah tanpa void (Opsi A saja), rincian omzet per outlet
 *   per hari; fee awal sekali; sengketa ≤ `dispute_window_days` hari lewat portal (`disputePartnerInvoice`).
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { customers, invoiceLines, invoices, royaltyCalculations, unbilledCharges } from "@/db/schema";
import type { EnumValue } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, daysBetween, formatTanggal, isBusinessDate, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { nextNumber } from "@/server/core/numbering";
import * as params from "@/server/core/params";
import { authorize, authorizeAny, runService } from "@/server/core/rbac";
import { applyAdvance, disputeInvoice, listAdvances } from "@/server/modules/m5-receivables";
import { salesAggregates } from "@/server/modules/m6-pos";

import {
  assertOwnerTenant,
  assertPartnerActor,
  authorizePortalAction,
  bpToPercent,
  contractOutlets,
  contractsLiveOn,
  isValidMonth,
  loadPartnerTenant,
  monthRange,
  ownerTenantId,
  partnerRules,
  portalEnabled,
  type ContractRow,
  type CustomerRow,
  type OutletRow,
  type TenantRow,
} from "./common";
import { effectiveTerms, type ContractTerms } from "./contracts";

// =====================================================================================================================
// Periode (PAR-12)
// =====================================================================================================================

function shiftMonth(ym: string, offset: number): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + offset;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export type BillingPeriod = { serviceMonth: string; scheduledIssueDate: BusinessDate; dueDate: BusinessDate };

/** Periode yang terbit pada bulan `date` (PAR-12: layanan bulan M terbit tanggal N bulan M+1, jatuh tempo tanggal D). */
export async function billingPeriodFor(tx: Tx, date: BusinessDate): Promise<BillingPeriod> {
  const p = await params.get(tx, "PAR-12", date);
  const serviceMonth = shiftMonth(date.slice(0, 7), -p.issue_month_offset);
  return {
    serviceMonth,
    scheduledIssueDate: `${shiftMonth(serviceMonth, p.issue_month_offset)}-${String(p.issue_day).padStart(2, "0")}`,
    dueDate: `${shiftMonth(serviceMonth, p.due_month_offset)}-${String(p.due_day).padStart(2, "0")}`,
  };
}

/** Tanggal terbit & jatuh tempo untuk bulan layanan tertentu. */
export async function datesForServiceMonth(tx: Tx, serviceMonth: string): Promise<{ scheduledIssueDate: BusinessDate; dueDate: BusinessDate }> {
  const p = await params.get(tx, "PAR-12", `${serviceMonth}-01`);
  return {
    scheduledIssueDate: `${shiftMonth(serviceMonth, p.issue_month_offset)}-${String(p.issue_day).padStart(2, "0")}`,
    dueDate: `${shiftMonth(serviceMonth, p.due_month_offset)}-${String(p.due_day).padStart(2, "0")}`,
  };
}

// =====================================================================================================================
// Hitung tagihan
// =====================================================================================================================

export type BillOutlet = { outletId: string; code: string; name: string; activatedOn: string | null; billingStart: string | null; billable: boolean; note: string | null };
export type RoyaltyDetailRow = { outletId: string; outletCode: string; businessDate: string; sales: number; transactions: number };
export type WaterChargeRow = { id: string; tripId: string | null; serviceDate: string; description: string; amount: number; volumeL: number | null };

export type PartnerBill = {
  contract: ContractRow;
  tenant: TenantRow;
  customer: CustomerRow;
  serviceMonth: string;
  periodMonth: BusinessDate;
  from: BusinessDate;
  to: BusinessDate;
  issueDate: BusinessDate;
  dueDate: BusinessDate;
  terms: ContractTerms;
  outlets: BillOutlet[];
  outletCount: number;
  subscriptionAmount: number;
  royalty: { applies: boolean; bp: number; grossSales: number; amount: number; detail: RoyaltyDetailRow[] };
  initialFee: number;
  water: { applies: boolean; charges: WaterChargeRow[]; amount: number };
  /** Pendapatan L5 (langganan + royalti + fee awal). */
  l5Amount: number;
  total: number;
  existing: { invoiceId: string; number: string } | null;
};

function outletBillable(o: OutletRow, contract: ContractRow, from: BusinessDate, to: BusinessDate): BillOutlet {
  const base = { outletId: o.id, code: o.code, name: o.name, activatedOn: o.activatedOn, billingStart: o.billingStartDate };
  if (!o.activatedOn) return { ...base, billable: false, note: "Belum Aktif (onboarding belum lengkap)" };
  const start = o.billingStartDate ?? (o.activatedOn > contract.startDate ? o.activatedOn : contract.startDate);
  if (start > to) return { ...base, billingStart: start, billable: false, note: `Mulai ditagih ${start}` };
  if (!o.isActive && o.deactivatedAt && toBusinessDate(o.deactivatedAt) < from) return { ...base, billingStart: start, billable: false, note: "Nonaktif sebelum bulan layanan" };
  return { ...base, billingStart: start, billable: true, note: null };
}

/** Hitung tagihan satu kontrak untuk bulan layanan (tanpa menulis). */
export async function computePartnerBill(tx: Tx, contract: ContractRow, serviceMonth: string, opts: { issueOn?: BusinessDate } = {}): Promise<PartnerBill> {
  const { from, to, periodMonth } = monthRange(serviceMonth);
  const tenant = await loadPartnerTenant(tx, contract.tenantId);
  const [customer] = await tx.select().from(customers).where(eq(customers.id, contract.customerId)).limit(1);
  if (!customer) throw new NotFoundError("Pelanggan mitra tidak ditemukan.");
  const terms = effectiveTerms(contract, periodMonth);
  const dates = await datesForServiceMonth(tx, serviceMonth);
  const issueDate = opts.issueOn && opts.issueOn > dates.scheduledIssueDate ? opts.issueOn : dates.scheduledIssueDate;
  const dueDate = dates.dueDate >= issueDate ? dates.dueDate : issueDate;
  const inContract = contract.startDate <= to && contract.endDate >= from;

  // D-13 butir 1 (PRD 9.7): langganan PER OUTLET — hanya outlet yang dicakup kontrak ini (satu kontrak per outlet).
  const outletRows = await contractOutlets(tx, contract, { from, to });
  const billOutlets = outletRows.map((o) => (inContract ? outletBillable(o, contract, from, to) : { outletId: o.id, code: o.code, name: o.name, activatedOn: o.activatedOn, billingStart: o.billingStartDate, billable: false, note: "Di luar masa kontrak" }));
  const outletCount = billOutlets.filter((o) => o.billable).length;
  const subscriptionAmount = outletCount * terms.subscriptionFeePerOutlet;

  // Royalti (US-P3-04, Opsi A saja, Tahap 3): omzet POS Sah tanpa void dalam masa kontrak.
  const royaltyApplies = contract.option === "option_a" && terms.royaltyBp > 0 && (await portalEnabled(tx, tenant.id));
  let royalty: PartnerBill["royalty"] = { applies: false, bp: terms.royaltyBp, grossSales: 0, amount: 0, detail: [] };
  if (royaltyApplies && inContract) {
    const rFrom = contract.startDate > from ? contract.startDate : from;
    const rTo = contract.endDate < to ? contract.endDate : to;
    const agg = await salesAggregates(tx, tenant.id, { from: rFrom, to: rTo, outletIds: outletRows.map((o) => o.id) });
    const detail = agg
      .map((a) => ({ outletId: a.outletId, outletCode: outletRows.find((o) => o.id === a.outletId)?.code ?? "", businessDate: a.businessDate, sales: a.salesTotal, transactions: a.transactions }))
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.outletCode.localeCompare(b.outletCode));
    const gross = detail.reduce((s, d) => s + d.sales, 0);
    royalty = { applies: true, bp: terms.royaltyBp, grossSales: gross, amount: Math.round((gross * terms.royaltyBp) / 10_000), detail };
  }

  // Fee awal (sekali, saat kontrak — US-P3-04 KP-1): faktur pertama sejak tanggal mulai.
  let initialFee = 0;
  if (contract.initialFee > 0 && inContract) {
    const prior = await tx
      .select({ detail: royaltyCalculations.detail })
      .from(royaltyCalculations)
      .where(and(eq(royaltyCalculations.contractId, contract.id), sql`${royaltyCalculations.invoiceId} is not null`));
    if (!prior.some((p) => Number((p.detail as { initialFee?: number } | null)?.initialFee ?? 0) > 0)) initialFee = contract.initialFee;
  }

  // Gabung rit air tempo belum ditagih (BR-05) untuk mitra bertanda tagihan bulanan.
  const waterApplies = contract.monthlyBilling && customer.monthlyBilling;
  const charges = waterApplies
    ? await tx
        .select()
        .from(unbilledCharges)
        .where(and(eq(unbilledCharges.customerId, customer.id), eq(unbilledCharges.status, "unbilled"), isNull(unbilledCharges.invoiceId), lt(unbilledCharges.serviceDate, addDays(to, 1))))
        .orderBy(asc(unbilledCharges.serviceDate), asc(unbilledCharges.createdAt))
    : [];
  const water = {
    applies: waterApplies,
    charges: charges.map((c) => ({ id: c.id, tripId: c.tripId, serviceDate: c.serviceDate, description: c.description, amount: c.amount, volumeL: c.volumeL })),
    amount: charges.reduce((s, c) => s + c.amount, 0),
  };

  const [calc] = await tx.select().from(royaltyCalculations).where(and(eq(royaltyCalculations.contractId, contract.id), eq(royaltyCalculations.period, serviceMonth))).limit(1);
  let existing: PartnerBill["existing"] = null;
  if (calc?.invoiceId) {
    const [inv] = await tx.select({ id: invoices.id, number: invoices.number }).from(invoices).where(eq(invoices.id, calc.invoiceId)).limit(1);
    if (inv) existing = { invoiceId: inv.id, number: inv.number };
  }
  const l5Amount = subscriptionAmount + royalty.amount + initialFee;
  return {
    contract,
    tenant,
    customer,
    serviceMonth,
    periodMonth,
    from,
    to,
    issueDate,
    dueDate,
    terms,
    outlets: billOutlets,
    outletCount,
    subscriptionAmount,
    royalty,
    initialFee,
    water,
    l5Amount,
    total: l5Amount + water.amount,
    existing,
  };
}

// =====================================================================================================================
// Terbitkan faktur mitra (satu per kontrak per bulan; idempoten)
// =====================================================================================================================

type LineInput = {
  component: EnumValue<"invoice_line_component">;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  tripId?: string | null;
  serviceDate?: string | null;
  volumeL?: number | null;
  unbilledChargeId?: string | null;
};

function monthLabel(serviceMonth: string): string {
  return formatTanggal(`${serviceMonth}-01`, { weekday: false }).replace(/^1 /, "");
}

export type IssuedPartnerInvoice = { invoiceId: string; number: string; amount: number; l5Amount: number; outletCount: number; contractId: string; tenantId: string };

/** Tulis faktur mitra (tabel M5) + baris + rit belum ditagih → sudah ditagih + event (dipanggil job/layanan terotorisasi). */
export async function issuePartnerBill(tx: Tx, ctx: ActorContext, bill: PartnerBill): Promise<IssuedPartnerInvoice | null> {
  if (bill.existing) return null;
  if (bill.total <= 0) return null;
  const lines: LineInput[] = [];
  const month = monthLabel(bill.serviceMonth);
  if (bill.subscriptionAmount > 0) {
    lines.push({
      component: "subscription",
      description: `Langganan sistem ${month}: ${bill.outletCount} outlet aktif × ${formatRupiah(bill.terms.subscriptionFeePerOutlet)} (${bill.outlets.filter((o) => o.billable).map((o) => o.code).join(", ")})`,
      quantity: bill.outletCount,
      unitPrice: bill.terms.subscriptionFeePerOutlet,
      amount: bill.subscriptionAmount,
    });
  }
  if (bill.royalty.amount > 0) {
    lines.push({
      component: "royalty",
      description: `Royalti ${bpToPercent(bill.royalty.bp)}% × omzet POS ${formatRupiah(bill.royalty.grossSales)} (${month}; transaksi Sah tanpa void)`,
      quantity: 1,
      unitPrice: bill.royalty.amount,
      amount: bill.royalty.amount,
    });
  }
  if (bill.initialFee > 0) {
    lines.push({ component: "other", description: `Fee awal kemitraan (sekali) — kontrak ${bill.contract.number}`, quantity: 1, unitPrice: bill.initialFee, amount: bill.initialFee });
  }
  for (const c of bill.water.charges) {
    lines.push({ component: "water", description: c.description, quantity: 1, unitPrice: c.amount, amount: c.amount, tripId: c.tripId, serviceDate: c.serviceDate, volumeL: c.volumeL, unbilledChargeId: c.id });
  }
  const amount = lines.reduce((s, l) => s + l.amount, 0);
  if (amount <= 0) return null;
  const number = await nextNumber(tx, "invoice", bill.issueDate, { tenantId: bill.customer.tenantId });
  const [inv] = await tx
    .insert(invoices)
    .values({
      tenantId: bill.customer.tenantId,
      number,
      kind: "partner_subscription",
      customerId: bill.customer.id,
      periodMonth: bill.periodMonth,
      partnerContractId: bill.contract.id,
      issueDate: bill.issueDate,
      dueDate: bill.dueDate,
      amount,
      outstandingAmount: amount,
      status: "open",
      description: `Tagihan bulanan mitra ${bill.tenant.name} — ${month} (kontrak ${bill.contract.number})`,
      createdBy: ctx.userId,
    })
    .returning();
  let lineNo = 0;
  for (const l of lines) {
    lineNo++;
    await tx.insert(invoiceLines).values({
      invoiceId: inv!.id,
      lineNo,
      component: l.component,
      description: l.description,
      tripId: l.tripId ?? null,
      serviceDate: l.serviceDate ?? null,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      amount: l.amount,
      volumeL: l.volumeL ?? null,
      unbilledChargeId: l.unbilledChargeId ?? null,
    });
  }
  if (bill.water.charges.length) {
    await tx
      .update(unbilledCharges)
      .set({ status: "billed", invoiceId: inv!.id, updatedAt: ctx.now })
      .where(inArray(unbilledCharges.id, bill.water.charges.map((c) => c.id)));
  }
  const detail = {
    outlets: bill.outlets,
    terms: bill.terms,
    royaltyDetail: bill.royalty.detail,
    initialFee: bill.initialFee,
    waterCharges: bill.water.charges.map((c) => c.id),
    waterAmount: bill.water.amount,
  };
  await tx
    .insert(royaltyCalculations)
    .values({
      tenantId: bill.tenant.id,
      contractId: bill.contract.id,
      period: bill.serviceMonth,
      outletCount: bill.outletCount,
      subscriptionAmount: bill.subscriptionAmount,
      grossSales: bill.royalty.grossSales,
      royaltyBp: bill.royalty.applies ? bill.royalty.bp : 0,
      royaltyAmount: bill.royalty.amount,
      detail,
      status: "invoiced",
      invoiceId: inv!.id,
      computedAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [royaltyCalculations.contractId, royaltyCalculations.period],
      set: { outletCount: bill.outletCount, subscriptionAmount: bill.subscriptionAmount, grossSales: bill.royalty.grossSales, royaltyAmount: bill.royalty.amount, detail, status: "invoiced", invoiceId: inv!.id, computedAt: ctx.now, updatedAt: ctx.now },
    });
  await auditRecord(tx, {
    ctx,
    objectType: "invoice",
    objectId: inv!.id,
    action: "create",
    after: {
      number,
      kind: "partner_subscription",
      customerId: bill.customer.id,
      amount,
      issueDate: bill.issueDate,
      dueDate: bill.dueDate,
      periodMonth: bill.periodMonth,
      partnerContractId: bill.contract.id,
      outletCount: bill.outletCount,
      subscriptionAmount: bill.subscriptionAmount,
      royaltyAmount: bill.royalty.amount,
      initialFee: bill.initialFee,
      mergedWaterAmount: bill.water.amount,
      lines: lines.length,
    },
    rule: "US-P3-09 KP-1, PAR-12",
    businessDate: bill.issueDate,
  });
  const meta = { ctx, tenantId: bill.customer.tenantId, businessDate: bill.issueDate, objectType: "invoice", objectId: inv!.id };
  await emit(
    tx,
    "invoice.issued",
    {
      invoiceId: inv!.id,
      customerId: bill.customer.id,
      kind: "partner_subscription",
      amount,
      dueDate: bill.dueDate,
      tripId: null,
      posSaleId: null,
      profitCenter: "L5",
      outletId: null,
      number,
      issueDate: bill.issueDate,
      isOpeningBalance: false,
      pendingTransferId: null,
      periodMonth: bill.periodMonth,
      reclassifiedFromTripPaymentId: null,
    },
    meta,
  );
  if (bill.l5Amount > 0) {
    await emit(
      tx,
      "partner.subscription_invoiced",
      {
        invoiceId: inv!.id,
        partnerContractId: bill.contract.id,
        partnerTenantId: bill.tenant.id,
        amount: bill.l5Amount,
        outletCount: bill.outletCount,
        subscriptionAmount: bill.subscriptionAmount,
        royaltyAmount: bill.royalty.amount,
        initialFeeAmount: bill.initialFee,
        mergedWaterAmount: bill.water.amount,
        periodMonth: bill.periodMonth,
        customerId: bill.customer.id,
        number,
        issueDate: bill.issueDate,
        dueDate: bill.dueDate,
        option: bill.contract.option,
      },
      meta,
    );
  }
  // Uang muka pelanggan mitra dipotong otomatis (US-M5-02 KP-3) lewat API M5.
  const sys = systemContext({ tenantId: bill.customer.tenantId, now: ctx.now, businessDate: bill.issueDate });
  for (const adv of await listAdvances(sys, { customerId: bill.customer.id, openOnly: true }, { tx })) {
    try {
      await applyAdvance(sys, { advanceId: adv.id, invoiceId: inv!.id }, { tx });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  await notify(tx, {
    event: "partner.subscription_invoiced",
    tenantId: bill.customer.tenantId,
    title: `Tagihan mitra ${bill.tenant.name} ${month} terbit: ${formatRupiah(amount)}`,
    body: `${number} — ${bill.outletCount} outlet × ${formatRupiah(bill.terms.subscriptionFeePerOutlet)}${bill.royalty.amount ? ` + royalti ${formatRupiah(bill.royalty.amount)}` : ""}${bill.water.amount ? ` + air tempo ${formatRupiah(bill.water.amount)}` : ""}. Jatuh tempo ${formatTanggal(bill.dueDate, { weekday: false })}.`,
    objectType: "invoice",
    objectId: inv!.id,
    valueAmount: amount,
    link: `/piutang/faktur/${inv!.id}`,
    now: ctx.now,
  });
  return { invoiceId: inv!.id, number, amount, l5Amount: bill.l5Amount, outletCount: bill.outletCount, contractId: bill.contract.id, tenantId: bill.tenant.id };
}

export type SubscriptionRunSummary = { serviceMonth: string; issueDate: BusinessDate; issued: IssuedPartnerInvoice[]; skipped: { contractId: string; reason: string }[]; notDue?: boolean };

/**
 * Terbitkan tagihan mitra periode yang jatuh pada `date` (PAR-12) untuk semua kontrak yang berlaku di bulan layanan.
 * Idempoten per kontrak & bulan (`royalty_calculations` unik + `invoices_monthly_uq`).
 */
export async function issueSubscriptionInvoices(tx: Tx, ctx: ActorContext, date: BusinessDate): Promise<SubscriptionRunSummary> {
  const period = await billingPeriodFor(tx, date);
  if (date < period.scheduledIssueDate) return { serviceMonth: period.serviceMonth, issueDate: period.scheduledIssueDate, issued: [], skipped: [], notDue: true };
  const { from, to } = monthRange(period.serviceMonth);
  const out: SubscriptionRunSummary = { serviceMonth: period.serviceMonth, issueDate: date, issued: [], skipped: [] };
  for (const contract of await contractsLiveOn(tx, from, to)) {
    const bill = await computePartnerBill(tx, contract, period.serviceMonth, { issueOn: date });
    if (bill.existing) {
      out.skipped.push({ contractId: contract.id, reason: `Sudah terbit ${bill.existing.number}` });
      continue;
    }
    const issued = await issuePartnerBill(tx, ctx, bill);
    if (issued) out.issued.push(issued);
    else out.skipped.push({ contractId: contract.id, reason: "Tidak ada outlet aktif / nilai nol" });
  }
  return out;
}

/** Job harian (00.40, sebelum job faktur bulanan M5 agar rit tempo tergabung, BR-05). */
export async function runSubscriptionBilling(now: Date, opts: { db?: Db; date?: BusinessDate } = {}): Promise<SubscriptionRunSummary> {
  const date = opts.date ?? toBusinessDate(now);
  return withTx(
    async (tx) => {
      const equa = await ownerTenantId(tx);
      return issueSubscriptionInvoices(tx, systemContext({ tenantId: equa, now, businessDate: date }), date);
    },
    opts.db ? { db: opts.db } : {},
  );
}

/** Admin Keuangan: terbitkan sekarang (bila job belum berjalan) — tetap mengikuti tanggal PAR-12. */
export async function runSubscriptionBillingNow(ctx: ActorContext, input: { date?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<SubscriptionRunSummary> {
  await authorize(ctx, "p3.subscription.issue", { tx: opts.tx });
  const date = input.date && isBusinessDate(input.date) ? input.date : ctxBusinessDate(ctx);
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const res = await issueSubscriptionInvoices(tx, ctx, date);
    if (res.notDue) throw new DomainError("NOT_ISSUE_DAY", `Tagihan bulan ${res.serviceMonth} terbit mulai ${formatTanggal(res.issueDate, { weekday: false })} (PAR-12).`);
    return res;
  });
}

// =====================================================================================================================
// Papan tagihan langganan (EQUA)
// =====================================================================================================================

export type SubscriptionBoardRow = {
  contract: Pick<ContractRow, "id" | "number" | "option" | "status" | "startDate" | "endDate" | "monthlyBilling">;
  tenantName: string;
  customerName: string;
  bill: Pick<PartnerBill, "outletCount" | "subscriptionAmount" | "royalty" | "initialFee" | "water" | "l5Amount" | "total" | "issueDate" | "dueDate" | "existing" | "outlets" | "terms">;
};

export type PartnerInvoiceRow = {
  id: string;
  number: string;
  tenantName: string;
  customerName: string;
  periodMonth: string | null;
  issueDate: string;
  dueDate: string;
  amount: number;
  paidAmount: number;
  creditedAmount: number;
  outstandingAmount: number;
  status: string;
  disputeStatus: string;
  overdueDays: number;
};

export async function listPartnerInvoices(tx: Tx, filter: { tenantId?: string | null; customerIds?: string[]; today: BusinessDate; limit?: number }): Promise<PartnerInvoiceRow[]> {
  const conds = [eq(customers.isEquaPartner, true)];
  if (filter.tenantId) conds.push(eq(customers.partnerTenantId, filter.tenantId));
  if (filter.customerIds) {
    if (!filter.customerIds.length) return [];
    conds.push(inArray(customers.id, filter.customerIds));
  }
  const rows = await tx
    .select({ inv: invoices, customerName: customers.name, partnerTenantId: customers.partnerTenantId })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(...conds))
    .orderBy(desc(invoices.issueDate), desc(invoices.number))
    .limit(filter.limit ?? 200);
  const tenantNames = new Map<string, string>();
  for (const r of rows) {
    if (r.partnerTenantId && !tenantNames.has(r.partnerTenantId)) tenantNames.set(r.partnerTenantId, (await loadPartnerTenant(tx, r.partnerTenantId).catch(() => null))?.name ?? "-");
  }
  return rows.map((r) => ({
    id: r.inv.id,
    number: r.inv.number,
    tenantName: r.partnerTenantId ? (tenantNames.get(r.partnerTenantId) ?? "-") : "-",
    customerName: r.customerName,
    periodMonth: r.inv.periodMonth,
    issueDate: r.inv.issueDate,
    dueDate: r.inv.dueDate,
    amount: r.inv.amount,
    paidAmount: r.inv.paidAmount,
    creditedAmount: r.inv.creditedAmount,
    outstandingAmount: r.inv.outstandingAmount,
    status: r.inv.status,
    disputeStatus: r.inv.disputeStatus,
    overdueDays: r.inv.outstandingAmount > 0 && r.inv.dueDate < filter.today ? daysBetween(r.inv.dueDate, filter.today) : 0,
  }));
}

/** Papan tagihan langganan: pratinjau bulan layanan + faktur mitra (status M5). */
export async function subscriptionBoard(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.subscription.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const today = ctxBusinessDate(ctx);
  const current = await billingPeriodFor(tx, today);
  const month = isValidMonth(input.month) ? input.month! : current.serviceMonth;
  const { from, to } = monthRange(month);
  const rows: SubscriptionBoardRow[] = [];
  for (const contract of await contractsLiveOn(tx, from, to)) {
    const bill = await computePartnerBill(tx, contract, month);
    rows.push({
      contract: { id: contract.id, number: contract.number, option: contract.option, status: contract.status, startDate: contract.startDate, endDate: contract.endDate, monthlyBilling: contract.monthlyBilling },
      tenantName: bill.tenant.name,
      customerName: bill.customer.name,
      bill: {
        outletCount: bill.outletCount,
        subscriptionAmount: bill.subscriptionAmount,
        royalty: bill.royalty,
        initialFee: bill.initialFee,
        water: bill.water,
        l5Amount: bill.l5Amount,
        total: bill.total,
        issueDate: bill.issueDate,
        dueDate: bill.dueDate,
        existing: bill.existing,
        outlets: bill.outlets,
        terms: bill.terms,
      },
    });
  }
  const dates = await datesForServiceMonth(tx, month);
  return { month, issueDate: dates.scheduledIssueDate, dueDate: dates.dueDate, rows, invoices: await listPartnerInvoices(tx, { today }) };
}

/** Rincian royalti per outlet per hari untuk satu faktur/periode (US-P3-04 KP-2) — EQUA. */
export async function royaltyDetail(ctx: ActorContext, input: { contractId: string; month: string }, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.subscription.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const [calc] = await tx.select().from(royaltyCalculations).where(and(eq(royaltyCalculations.contractId, input.contractId), eq(royaltyCalculations.period, input.month))).limit(1);
  return calc ?? null;
}

// =====================================================================================================================
// Portal: sengketa tagihan (US-P3-04 KP-2, Tahap 3)
// =====================================================================================================================

const disputeSchema = z.object({ invoiceId: z.uuid(), note: z.string().trim().min(10, { error: "Jelaskan keberatan Anda (minimal 10 karakter)." }).max(1000) });

/** Mitra mengajukan sengketa tagihan dalam `dispute_window_days` hari sejak faktur terbit (7.5.6 lewat M5). */
export async function disputePartnerInvoice(ctx: ActorContext, input: z.input<typeof disputeSchema>, opts: { tx?: Tx } = {}) {
  await authorizePortalAction(ctx, "p3.portal_dispute.create", { tx: opts.tx });
  const data = parseInput(disputeSchema, input, { note: "Keberatan" });
  return runService(ctx, opts, async (tx) => {
    const tenant = await assertPartnerActor(tx, ctx);
    const [row] = await tx
      .select({ inv: invoices, partnerTenantId: customers.partnerTenantId })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(eq(invoices.id, data.invoiceId))
      .limit(1);
    if (!row || row.partnerTenantId !== tenant.id) throw new NotFoundError("Tagihan tidak ditemukan.");
    const rules = await partnerRules(tx, ctxBusinessDate(ctx));
    const age = daysBetween(row.inv.issueDate, ctxBusinessDate(ctx));
    if (age > rules.dispute_window_days) {
      throw new DomainError("DISPUTE_WINDOW_PASSED", `Sengketa hanya dapat diajukan paling lambat ${rules.dispute_window_days} hari sejak faktur terbit (${formatTanggal(row.inv.issueDate, { weekday: false })}). Hubungi Admin Keuangan EQUA.`);
    }
    const sys = systemContext({ tenantId: row.inv.tenantId, now: ctx.now, businessDate: ctxBusinessDate(ctx) });
    const updated = await disputeInvoice(sys, { invoiceId: row.inv.id, note: `Sengketa dari portal mitra ${tenant.name}: ${data.note}` }, { tx });
    await auditRecord(tx, { ctx, objectType: "invoice", objectId: row.inv.id, action: "dispute_request", after: { note: data.note, tenantId: tenant.id }, rule: "US-P3-04 KP-2" });
    return updated;
  });
}
