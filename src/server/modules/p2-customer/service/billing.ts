/**
 * P2 — riwayat, struk, tagihan (US-P2-04 KP-1/KP-2/KP-5). Data milik M3 (rit, bukti kirim) & M5 (faktur, kartu
 * piutang); P2 hanya membuka jendela baca untuk pelanggan pemiliknya ("data pribadi hanya milik sendiri", 8.6).
 * Unduhan faktur/riwayat/struk tercatat (`customer_download_logs`; BR-39 tidak berlaku untuk data milik sendiri).
 */
import "server-only";

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { attachments, bankAccounts, complaints, customerDownloadLogs, invoices, orders, paymentIntents, tripPayments, trips } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { addDays, daysBetween, formatTanggal, formatTanggalJam, type BusinessDate } from "@/lib/time";

import { getDb, withTx, type Tx } from "@/server/core/db";
import { NotFoundError } from "@/server/core/errors";
import { renderPdf } from "@/server/core/export";
import * as params from "@/server/core/params";
import { readAttachment } from "@/server/core/storage";
import * as m5 from "@/server/modules/m5-receivables";

import { appRules, customerBusinessDate, loadCustomer, loadOwnInvoices, loadOwnTrip, requireLinked, sysCtx, type CustomerContext } from "./common";
import { digitalPaymentAvailable } from "./gateway";
import { listMyOrders } from "./orders";

export type BillingInvoiceRow = {
  id: string;
  number: string;
  kind: EnumValue<"invoice_kind">;
  kindLabel: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  outstanding: number;
  overdueDays: number;
  disputed: boolean;
  periodMonth: string | null;
  pendingPayment: boolean;
};

export type MyBilling = {
  creditStatus: EnumValue<"credit_status">;
  creditStatusLabel: string;
  onHold: boolean;
  /** Keterangan & cara melunasi bagi pelanggan Ditahan (US-P2-04 KP-2). */
  holdMessage: string | null;
  bankAccounts: { bankName: string; accountNumber: string; accountName: string }[];
  digitalPaymentAvailable: boolean;
  openInvoices: BillingInvoiceRow[];
  totalOutstanding: number;
  monthlyInvoices: BillingInvoiceRow[];
  statement: { from: string; to: string; openingBalance: number; closingBalance: number; openAdvance: number; unbilled: number; entries: { date: string; kind: string; reference: string; description: string; debit: number; credit: number; balance: number }[] };
};

function toRow(i: typeof invoices.$inferSelect, today: BusinessDate, pending: Set<string>): BillingInvoiceRow {
  return {
    id: i.id,
    number: i.number,
    kind: i.kind,
    kindLabel: label("invoice_kind", i.kind),
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    amount: i.amount,
    outstanding: i.outstandingAmount,
    overdueDays: i.outstandingAmount > 0 && i.dueDate < today ? daysBetween(i.dueDate, today) : 0,
    disputed: i.disputeStatus === "disputed",
    periodMonth: i.periodMonth,
    pendingPayment: pending.has(i.id),
  };
}

/** Tagihan pelanggan: faktur terbuka, kartu piutang, faktur bulanan, info Ditahan (US-P2-04 KP-2). */
export async function myBilling(cctx: CustomerContext, opts: { tx?: Tx } = {}): Promise<MyBilling> {
  const customerId = requireLinked(cctx);
  const tx = opts.tx ?? getDb();
  const today = customerBusinessDate(cctx);
  const customer = await loadCustomer(tx, customerId);
  const invRows = await tx.select().from(invoices).where(eq(invoices.customerId, customerId)).orderBy(asc(invoices.dueDate), asc(invoices.number));
  const pendingIntents = await tx
    .select({ invoiceId: paymentIntents.invoiceId })
    .from(paymentIntents)
    .where(and(eq(paymentIntents.customerId, customerId), eq(paymentIntents.status, "pending"), gt(paymentIntents.expiresAt, cctx.now)));
  const pending = new Set(pendingIntents.map((p) => p.invoiceId).filter((x): x is string => !!x));
  const open = invRows.filter((i) => i.outstandingAmount > 0).map((i) => toRow(i, today, pending));
  const monthly = invRows.filter((i) => i.kind === "monthly").sort((a, b) => b.issueDate.localeCompare(a.issueDate)).map((i) => toRow(i, today, pending));
  const banks = await tx
    .select({ bankName: bankAccounts.bankName, accountNumber: bankAccounts.accountNumber, accountName: bankAccounts.accountName })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.tenantId, customer.tenantId), eq(bankAccounts.isCustomerFacing, true), eq(bankAccounts.isActive, true)))
    .orderBy(asc(bankAccounts.bankName));
  const onHold = customer.creditStatus === "on_hold";
  const overdue = open.filter((i) => i.overdueDays > 0);
  const st = await m5.customerStatement(sysCtx(customer.tenantId, cctx.now), customerId, { from: addDays(today, -90), to: today }, { tx });
  return {
    creditStatus: customer.creditStatus,
    creditStatusLabel: label("credit_status", customer.creditStatus),
    onHold,
    holdMessage: onHold
      ? `Status kredit Anda Ditahan karena ada ${overdue.length || "beberapa"} tagihan lewat jatuh tempo. Pesanan tempo tidak dapat dibuat sampai tagihan lewat jatuh tempo dilunasi; pesanan tunai tetap dapat dibuat. Lunasi dengan transfer ke rekening di bawah${digitalPaymentAvailable() ? " atau tombol Bayar sekarang (QRIS/VA)" : ""}; status dibuka otomatis setelah lunas.`
      : null,
    bankAccounts: banks,
    digitalPaymentAvailable: digitalPaymentAvailable(),
    openInvoices: open,
    totalOutstanding: open.reduce((s, i) => s + i.outstanding, 0),
    monthlyInvoices: monthly,
    statement: {
      from: st.from,
      to: st.to,
      openingBalance: st.openingBalance,
      closingBalance: st.closingBalance,
      openAdvance: st.openAdvance,
      unbilled: st.unbilled,
      entries: st.entries.map((e) => ({ date: e.date, kind: e.kind, reference: e.reference, description: e.description, debit: e.debit, credit: e.credit, balance: e.balance })),
    },
  };
}

async function logDownload(cctx: CustomerContext, kind: string, objectType: string | null, objectId: string | null): Promise<void> {
  await withTx((tx) => tx.insert(customerDownloadLogs).values({ tenantId: cctx.tenantId, customerAccountId: cctx.accountId, kind, objectType, objectId, createdAt: cctx.now }).then(() => undefined));
}

/** PDF faktur milik pelanggan (termasuk faktur bulanan, US-M5-06) — unduhan tercatat (KP-5). */
export async function myInvoicePdf(cctx: CustomerContext, invoiceId: string): Promise<{ filename: string; body: Buffer }> {
  const [inv] = await loadOwnInvoices(getDb(), cctx, [invoiceId]);
  const pdf = await m5.renderInvoicePdf(sysCtx(cctx.tenantId, cctx.now), inv!.id);
  await logDownload(cctx, "invoice_pdf", "invoice", inv!.id);
  return pdf;
}

export type ReceiptView = {
  tripId: string;
  number: string;
  orderNumber: string;
  completedAt: Date | null;
  dateLabel: string;
  deliveredVolumeL: number | null;
  plannedVolumeL: number;
  price: number;
  paymentLabel: string;
  receivedAmount: number | null;
  recipientName: string | null;
  partialReason: string | null;
  photos: { id: string; kind: string; url: string }[];
};

/** Struk digital per pengiriman (US-P2-04 KP-1) + foto bukti kirim sebagai bukti. */
export async function myReceipt(cctx: CustomerContext, tripId: string, opts: { tx?: Tx; log?: boolean } = {}): Promise<ReceiptView> {
  const tx = opts.tx ?? getDb();
  const trip = await loadOwnTrip(tx, cctx, tripId);
  if (trip.status !== "completed") throw new NotFoundError("Struk tersedia setelah air diterima (pengiriman Selesai).");
  const [order] = await tx.select({ number: orders.number }).from(orders).where(eq(orders.id, trip.orderId)).limit(1);
  const [pay] = await tx.select().from(tripPayments).where(and(eq(tripPayments.tripId, trip.id), sql`${tripPayments.reversalOfId} is null`)).orderBy(desc(tripPayments.createdAt)).limit(1);
  const [prepaid] = await tx.select({ id: paymentIntents.id }).from(paymentIntents).where(and(eq(paymentIntents.orderId, trip.orderId), inArray(paymentIntents.status, ["succeeded", "matched"]))).limit(1);
  const photos = await tx
    .select({ id: attachments.id, kind: attachments.kind })
    .from(attachments)
    .where(and(eq(attachments.objectType, "trip"), eq(attachments.objectId, trip.id), inArray(attachments.kind, ["delivery_photo", "signature"])))
    .orderBy(asc(attachments.createdAt));
  if (opts.log !== false) await logDownload(cctx, "receipt", "trip", trip.id);
  return {
    tripId: trip.id,
    number: trip.number,
    orderNumber: order?.number ?? "—",
    completedAt: trip.completedAt,
    dateLabel: trip.completedAt ? formatTanggalJam(trip.completedAt) : formatTanggal(trip.scheduledDate),
    deliveredVolumeL: trip.deliveredVolumeL,
    plannedVolumeL: trip.plannedVolumeL,
    price: trip.price,
    paymentLabel: prepaid ? "Sudah dibayar (pembayaran digital)" : label("payment_method", pay?.method ?? trip.paymentMethod),
    receivedAmount: pay?.receivedAmount ?? null,
    recipientName: trip.recipientName,
    partialReason: trip.partialVolumeReason ? label("partial_volume_reason", trip.partialVolumeReason) : null,
    photos: photos.map((p) => ({ id: p.id, kind: p.kind, url: `/api/customer/lampiran/${p.id}` })),
  };
}

/**
 * Berkas lampiran untuk pelanggan: hanya foto bukti kirim rit miliknya atau foto keluhannya sendiri (objek lain →
 * "tidak ditemukan").
 */
export async function readMyAttachment(cctx: CustomerContext, attachmentId: string): Promise<{ contentType: string; body: Buffer; name: string }> {
  const customerId = requireLinked(cctx);
  const db = getDb();
  const [row] = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1);
  if (!row || !row.objectId) throw new NotFoundError("Berkas tidak ditemukan.");
  let owned = false;
  if (row.objectType === "trip" && ["delivery_photo", "signature"].includes(row.kind)) {
    const [t] = await db.select({ id: trips.id }).from(trips).where(and(eq(trips.id, row.objectId), eq(trips.customerId, customerId))).limit(1);
    owned = !!t;
  } else if (row.objectType === "complaint") {
    const [c] = await db.select({ id: complaints.id }).from(complaints).where(and(eq(complaints.id, row.objectId), eq(complaints.customerId, customerId))).limit(1);
    owned = !!c;
  }
  if (!owned) throw new NotFoundError("Berkas tidak ditemukan.");
  const { body } = await readAttachment(sysCtx(cctx.tenantId, cctx.now), attachmentId);
  return { contentType: row.contentType, body, name: row.originalName ?? row.id };
}

/** Ekspor riwayat pesanan (PDF) milik pelanggan — tercatat (US-P2-04 KP-5). */
export async function myHistoryPdf(cctx: CustomerContext): Promise<{ filename: string; body: Buffer }> {
  requireLinked(cctx);
  const db = getDb();
  const rows = await listMyOrders(cctx, {}, { tx: db });
  const today = customerBusinessDate(cctx);
  const rules = await appRules(db, today, cctx.tenantId);
  const identity = await params.get(db, "company.identity", today);
  const customer = await loadCustomer(db, cctx.customerId!);
  const body = await renderPdf({
    title: `Riwayat pesanan air — ${customer.name}`,
    company: { name: identity.name, legalName: identity.legal_name, address: identity.address, phone: identity.phone },
    generatedAt: cctx.now,
    generatedBy: "Aplikasi pelanggan",
    filters: [`${rules.history_months} bulan terakhir sampai ${formatTanggal(today)}`],
    columns: [
      { key: "number", header: "No. pesanan", type: "text" },
      { key: "date", header: "Tanggal kirim", type: "date" },
      { key: "tanks", header: "Tangki", type: "number" },
      { key: "total", header: "Total", type: "rupiah", total: true },
      { key: "pay", header: "Cara bayar", type: "text" },
      { key: "status", header: "Status", type: "text" },
    ],
    rows: rows.map((r) => [r.number, r.requestedDate, r.tankCount, r.total, r.paymentLabel, r.statusLabel]),
    summary: [
      { label: "Jumlah pesanan", value: rows.length, type: "number" },
      { label: "Total nilai pesanan selesai", value: rows.filter((r) => r.status === "completed").reduce((s, r) => s + r.total, 0), type: "rupiah" },
    ],
    orientation: "portrait",
    notes: ["Dokumen ini diunduh pelanggan dari aplikasi EQUA."],
  });
  await logDownload(cctx, "history_pdf", "customer", cctx.customerId);
  return { filename: `riwayat-pesanan-${today}.pdf`, body };
}
