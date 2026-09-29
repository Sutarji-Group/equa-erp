/**
 * M5 — faktur bulanan untuk pelanggan tagihan bulanan (US-M5-06; FR-M5-07, BR-05, PTB-26, CR-07, PAR-12).
 *
 * - Penanda "tagihan bulanan" hanya dengan perjanjian tertulis terlampir & disetujui pemilik (6.2a `monthly_billing`).
 * - Job harian: pada tanggal terbit PAR-12 (bawaan tanggal 1) faktur bulan layanan sebelumnya terbit otomatis dari
 *   `unbilled_charges` (rincian rit: nomor, tanggal, alamat, volume, harga), jatuh tempo tanggal PAR-12 (bawaan 15);
 *   uang muka dialokasikan otomatis; PDF memuat pelunasan & uang muka yang sudah diterima serta saldo terutang.
 * - Rit Selesai yang tersinkron setelah faktur terbit masuk faktur bulan berikutnya dengan penanda; faktur terbit tidak
 *   berubah (koreksi lewat nota kredit).
 * - Daftar "faktur bulanan siap kirim" + PDF + status kirim; eksposur menghitung rit belum ditagih (KP-5, `balance.ts`).
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { approvalRequests, attachments, customers, invoices, unbilledCharges } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, isBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withSavepoint, type Tx } from "@/server/core/db";
import { DomainError, ValidationError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";
import * as m10 from "@/server/modules/m10-access";

import { customerCardLink, loadCustomer } from "./common";
import { issueInvoice } from "./ledger";

// =====================================================================================================================
// Periode (PAR-12)
// =====================================================================================================================

function shiftMonth(ym: string, offset: number): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + offset;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export type MonthlyPeriod = { serviceMonth: BusinessDate; periodEnd: BusinessDate; issueDate: BusinessDate; dueDate: BusinessDate; isIssueDay: boolean };

/**
 * Periode yang diterbitkan pada `date`: bulan layanan = bulan `date` − `issue_month_offset`; terbit tanggal `issue_day`,
 * jatuh tempo tanggal `due_day` bulan layanan + `due_month_offset` (PTB-26: layanan bulan M terbit 1 M+1, jatuh tempo 15 M+1).
 */
export async function monthlyPeriod(tx: Tx, date: BusinessDate): Promise<MonthlyPeriod> {
  const p = await params.get(tx, "PAR-12", date);
  const ym = date.slice(0, 7);
  const service = shiftMonth(ym, -p.issue_month_offset);
  const next = shiftMonth(service, 1);
  const due = shiftMonth(service, p.due_month_offset);
  const issue = shiftMonth(service, p.issue_month_offset);
  return {
    serviceMonth: `${service}-01`,
    periodEnd: `${next}-01`,
    issueDate: `${issue}-${String(p.issue_day).padStart(2, "0")}`,
    dueDate: `${due}-${String(p.due_day).padStart(2, "0")}`,
    isIssueDay: Number(date.slice(8, 10)) === p.issue_day,
  };
}

export type MonthlyRunSummary = {
  serviceMonth: BusinessDate;
  issued: { customerId: string; invoiceId: string; number: string; amount: number; lateLines: number }[];
  skipped: number;
  /** Pelanggan yang gagal diterbitkan (terisolasi savepoint; dicatat insiden, dicoba lagi pada jalan berikutnya). */
  failed: { customerId: string; message: string }[];
};

/**
 * Terbitkan faktur bulanan periode (idempoten per pelanggan & bulan): semua `unbilled_charges` belum ditagih dengan
 * tanggal layanan < akhir bulan layanan (termasuk susulan bulan sebelumnya bertanda terlambat).
 */
export async function issueMonthlyInvoices(tx: Tx, ctx: ActorContext, tenantId: string, date: BusinessDate): Promise<MonthlyRunSummary> {
  const period = await monthlyPeriod(tx, date);
  const summary: MonthlyRunSummary = { serviceMonth: period.serviceMonth, issued: [], skipped: 0, failed: [] };
  const pending = await tx
    .select({ customerId: unbilledCharges.customerId })
    .from(unbilledCharges)
    .where(and(eq(unbilledCharges.tenantId, tenantId), eq(unbilledCharges.status, "unbilled"), isNull(unbilledCharges.invoiceId), lt(unbilledCharges.serviceDate, period.periodEnd)))
    .groupBy(unbilledCharges.customerId);
  for (const { customerId } of pending) {
    // Satu pelanggan bermasalah tidak membatalkan faktur pelanggan lain (US-M5-06 KP-2): savepoint per pelanggan,
    // kegagalan dicatat sebagai insiden dan dicoba lagi pada jalan berikutnya (susulan otomatis).
    try {
      await withSavepoint(tx, async (tx) => {
        const [existing] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(eq(invoices.customerId, customerId), eq(invoices.kind, "monthly"), eq(invoices.periodMonth, period.serviceMonth)))
          .limit(1);
        if (existing) {
          summary.skipped++;
          return;
        }
        const customer = await loadCustomer(tx, customerId, { forUpdate: true });
        const charges = await tx
          .select()
          .from(unbilledCharges)
          .where(and(eq(unbilledCharges.customerId, customerId), eq(unbilledCharges.status, "unbilled"), isNull(unbilledCharges.invoiceId), lt(unbilledCharges.serviceDate, period.periodEnd)))
          .orderBy(asc(unbilledCharges.serviceDate), asc(unbilledCharges.createdAt))
          .for("update");
        if (!charges.length) return;
        const lateLines = charges.filter((c) => c.lateSync || c.serviceDate < period.serviceMonth).length;
        // Terbit pada tanggal PAR-12 (job). Bila diterbitkan susulan setelah tanggal jatuh tempo PAR-12 (job gagal),
        // jatuh tempo tidak boleh sebelum tanggal faktur.
        const issueDate = date < period.issueDate ? period.issueDate : date;
        const inv = await issueInvoice(tx, ctx, {
          tenantId,
          customerId,
          kind: "monthly",
          periodMonth: period.serviceMonth,
          issueDate,
          dueDate: period.dueDate < issueDate ? issueDate : period.dueDate,
          description: `Faktur bulanan layanan ${formatTanggal(period.serviceMonth, { weekday: false }).replace(/^\d+ /, "")}`,
          lines: charges.map((c) => ({
            component: "trip" as const,
            description: c.lateSync || c.serviceDate < period.serviceMonth ? `${c.description} (susulan: tersinkron setelah faktur bulan layanannya terbit)` : c.description,
            tripId: c.tripId,
            serviceDate: c.serviceDate,
            quantity: 1,
            unitPrice: c.amount,
            amount: c.amount,
            volumeL: c.volumeL,
            unbilledChargeId: c.id,
          })),
          rule: "US-M5-06 KP-2, PAR-12",
        });
        await tx
          .update(unbilledCharges)
          .set({ status: "billed", invoiceId: inv.id, updatedAt: ctx.now })
          .where(inArray(unbilledCharges.id, charges.map((c) => c.id)));
        summary.issued.push({ customerId, invoiceId: inv.id, number: inv.number, amount: inv.amount, lateLines });
        await notify(tx, {
          event: "receivable.monthly_ready",
          tenantId,
          title: `Faktur bulanan ${inv.number} siap kirim: ${customer.name}`,
          body: `${charges.length} rit, ${formatRupiah(inv.amount)}; jatuh tempo ${formatTanggal(inv.dueDate, { weekday: false })}.${lateLines ? ` ${lateLines} rit susulan bertanda.` : ""} Kirim PDF lewat WA/e-mail hari ini.`,
          objectType: "invoice",
          objectId: inv.id,
          valueAmount: inv.amount,
          link: "/piutang/faktur-bulanan",
          now: ctx.now,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failed.push({ customerId, message });
      await m10.raiseIncident(tx, {
        tenantId,
        kind: "other",
        severity: "major",
        title: "Faktur bulanan gagal terbit untuk satu pelanggan",
        description: `Periode ${formatTanggal(period.serviceMonth, { weekday: false })}: ${message}. Faktur pelanggan lain tetap terbit; job mencoba lagi besok, atau terbitkan dari Piutang > Faktur bulanan.`.slice(0, 2000),
        objectType: "customer",
        objectId: customerId,
        now: ctx.now,
      });
    }
  }
  return summary;
}

/** Terbitkan faktur bulanan periode lalu sekarang (Admin Keuangan; bila job belum berjalan) — idempoten. */
export async function runMonthlyInvoicingNow(ctx: ActorContext, input: { date?: BusinessDate | null } = {}, opts: { tx?: Tx } = {}): Promise<MonthlyRunSummary> {
  await authorize(ctx, "m5.monthly_invoice.issue", { tx: opts.tx });
  const date = input.date && isBusinessDate(input.date) ? input.date : ctxBusinessDate(ctx);
  if (date > ctxBusinessDate(ctx)) throw ValidationError.field("date", "Tanggal terbit tidak boleh setelah hari ini.");
  return runService(ctx, opts, async (tx) => {
    const period = await monthlyPeriod(tx, date);
    if (date < period.issueDate) throw new DomainError("NOT_YET", `Faktur bulanan periode ini terbit mulai ${formatTanggal(period.issueDate, { weekday: false })} (PAR-12).`);
    return issueMonthlyInvoices(tx, ctx, ctx.tenantId, date);
  });
}

// =====================================================================================================================
// Penanda tagihan bulanan (KP-1; BR-05; 6.2a `monthly_billing`)
// =====================================================================================================================

const requestSchema = z.object({
  customerId: z.string().uuid({ error: "Pelanggan wajib dipilih." }),
  agreementAttachmentId: z.string().uuid({ error: "Perjanjian tertulis wajib dilampirkan (BR-05)." }),
  reason: z.string().trim().min(5, { error: "Alasan pengajuan wajib diisi (minimal 5 karakter)." }),
});

export async function requestMonthlyBilling(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.monthly_billing.request", { tx: opts.tx });
  const data = parseInput(requestSchema, input, { customerId: "Pelanggan", agreementAttachmentId: "Perjanjian", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const customer = await loadCustomer(tx, data.customerId, { ctx });
    if (customer.segment === "household") throw new DomainError("HOUSEHOLD_CASH_ONLY", "Rumah tangga hanya tunai; tagihan bulanan tidak berlaku (BR-04).");
    if (customer.monthlyBilling) throw new DomainError("ALREADY_MONTHLY", "Pelanggan sudah bertanda tagihan bulanan.");
    if (!["credit", "credit_migrated"].includes(customer.creditStatus)) {
      throw new DomainError("NOT_CREDIT_CUSTOMER", `Tagihan bulanan hanya untuk pelanggan Tempo (status sekarang ${label("credit_status", customer.creditStatus)}).`);
    }
    const [att] = await tx.select().from(attachments).where(eq(attachments.id, data.agreementAttachmentId)).limit(1);
    if (!att || att.tenantId !== customer.tenantId) throw ValidationError.field("agreementAttachmentId", "Berkas perjanjian tidak ditemukan. Unggah ulang perjanjian tertulis.");
    await linkAttachment(tx, att.id, { type: "customer", id: customer.id });
    return approvals.submit(
      ctx,
      {
        type: "monthly_billing",
        objectType: "customer",
        objectId: customer.id,
        reason: data.reason,
        payload: { customerName: customer.name, agreementAttachmentId: att.id, link: customerCardLink(customer.id) },
      },
      { tx },
    );
  });
}

/** Penerapan penanda tagihan bulanan disetujui pemilik (ctx = pemilik; tulis langsung + audit). */
export async function applyMonthlyBilling(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow): Promise<Record<string, unknown>> {
  const customer = await loadCustomer(tx, request.objectId, { forUpdate: true });
  const payload = (request.payload ?? {}) as { agreementAttachmentId?: string };
  if (!payload.agreementAttachmentId) return { applied: false, note: "Perjanjian tidak terlampir." };
  if (customer.segment === "household") return { applied: false, note: "Rumah tangga hanya tunai (BR-04)." };
  await tx
    .update(customers)
    .set({ monthlyBilling: true, monthlyBillingAgreementAttachmentId: payload.agreementAttachmentId, monthlyBillingApprovalId: request.id, updatedAt: ctx.now })
    .where(eq(customers.id, customer.id));
  await auditRecord(tx, {
    ctx,
    objectType: "customer",
    objectId: customer.id,
    action: "monthly_billing",
    before: { monthlyBilling: customer.monthlyBilling },
    after: { monthlyBilling: true, agreementAttachmentId: payload.agreementAttachmentId, approvalId: request.id },
    reason: request.reason,
    rule: "BR-05, 6.2a",
  });
  return { applied: true };
}

// =====================================================================================================================
// Tampilan: siap kirim, belum ditagih, pelanggan bulanan (KP-4)
// =====================================================================================================================

export async function monthlyBoard(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m5.monthly_invoice.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const period = await monthlyPeriod(tx, today);
  const monthly = await tx
    .select({ inv: invoices, customerName: customers.name })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.tenantId, ctx.tenantId), eq(invoices.kind, "monthly")))
    .orderBy(desc(invoices.issueDate), asc(customers.name))
    .limit(200);
  const unbilled = await tx
    .select({
      customerId: unbilledCharges.customerId,
      customerName: customers.name,
      n: sql<number>`count(*)::int`,
      total: sql<string>`sum(${unbilledCharges.amount})`,
      late: sql<number>`count(*) filter (where ${unbilledCharges.lateSync})::int`,
      first: sql<string>`min(${unbilledCharges.serviceDate})`,
    })
    .from(unbilledCharges)
    .innerJoin(customers, eq(customers.id, unbilledCharges.customerId))
    .where(and(eq(unbilledCharges.tenantId, ctx.tenantId), eq(unbilledCharges.status, "unbilled")))
    .groupBy(unbilledCharges.customerId, customers.name)
    .orderBy(asc(customers.name));
  const customersMonthly = await tx
    .select({ id: customers.id, code: customers.code, name: customers.name, agreementAttachmentId: customers.monthlyBillingAgreementAttachmentId, approvalId: customers.monthlyBillingApprovalId })
    .from(customers)
    .where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.monthlyBilling, true)))
    .orderBy(asc(customers.name));
  const requests = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, ctx.tenantId), eq(approvalRequests.type, "monthly_billing")))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(20);
  const eligible = await tx
    .select({ id: customers.id, code: customers.code, name: customers.name })
    .from(customers)
    .where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.monthlyBilling, false), inArray(customers.creditStatus, ["credit", "credit_migrated"]), eq(customers.isActive, true)))
    .orderBy(asc(customers.name));
  return {
    today,
    period,
    ready: monthly.filter((m) => !m.inv.sentAt).map((m) => ({ ...m.inv, customerName: m.customerName })),
    sent: monthly.filter((m) => !!m.inv.sentAt).map((m) => ({ ...m.inv, customerName: m.customerName })),
    unbilled: unbilled.map((u) => ({ ...u, total: Number(u.total ?? 0) })),
    customers: customersMonthly,
    requests,
    eligible,
  };
}
