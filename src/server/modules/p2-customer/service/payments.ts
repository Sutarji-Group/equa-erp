/**
 * P2 — pembayaran digital (US-P2-04 KP-3/KP-4, S; PTB-50).
 *
 * - QRIS dinamis / virtual account per tagihan (satu faktur atau semua tagihan terbuka) atau per pesanan (bayar di
 *   muka) lewat `PaymentGateway`; wajib verifikasi ulang OTP (8.6).
 * - Status Berhasil diterima otomatis dari gerbang (webhook bertanda tangan) → pelunasan M5 kanal `digital`
 *   (`customer_payments` + alokasi tertua dulu; kelebihan / bayar di muka → uang muka) diumumkan lewat
 *   `collection.recorded` (M5 menerapkan alokasi & melepas Ditahan, US-M5-03 KP-3) dan `digital_payment.succeeded`
 *   (M4: transfer masuk "pembayaran digital" untuk dicocokkan dengan settlement bank; M11: jurnal + biaya gerbang
 *   sebagai beban). Transfer dicocokkan M4 → status Dicocokkan. Idempoten per pemberitahuan.
 * - Bayar di muka pesanan → cara bayar pesanan & rit yang belum berangkat menjadi "Pembayaran digital" (lunas di
 *   muka); pull `p2.prepaid_trips` untuk aplikasi sopir (perubahan kecil M3 — lihat hand-off).
 */
import "server-only";

import { randomBytes } from "node:crypto";

import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { customerAppOrders, customerPayments, customers, incomingTransfers, invoices, orders, paymentAllocations, paymentIntents, trips } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { toBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { systemContext, type ActorContext } from "@/server/core/context";
import { getDb, runInTx, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { authorize } from "@/server/core/rbac";

import { isReverified } from "./auth";
import { assertAppEnabled, customerBusinessDate, loadCustomer, loadOwnInvoices, loadOwnOrder, paymentRules, recordCustomerAudit, requireLinked, type CustomerContext } from "./common";
import { activeGateway, GatewayError, signMockNotification, type GatewayNotification } from "./gateway";
import { notifyCustomer } from "./messaging";

export type PaymentIntentRow = typeof paymentIntents.$inferSelect;

const createSchema = z.object({
  target: z.enum(["invoice", "all_invoices", "order"], { error: "Pilih yang dibayar." }),
  invoiceId: z.uuid().nullable().optional(),
  orderId: z.uuid().nullable().optional(),
  method: z.enum(["qris_dynamic", "virtual_account"], { error: "Pilih QRIS atau virtual account." }),
});
export type CreatePaymentInput = z.input<typeof createSchema>;

function newGatewayOrderId(now: Date): string {
  return `EQ-${toBusinessDate(now).replaceAll("-", "").slice(2)}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

/**
 * Buat kode bayar QRIS/VA (US-P2-04 KP-3). Kode yang masih berlaku untuk tagihan & cara yang sama dipakai ulang.
 */
export async function createPaymentIntent(cctx: CustomerContext, input: CreatePaymentInput, opts: { tx?: Tx } = {}): Promise<PaymentIntentRow> {
  const customerId = requireLinked(cctx);
  const data = parseInput(createSchema, input, { target: "Tagihan", method: "Cara bayar" });
  const gateway = activeGateway();
  if (!gateway) throw new DomainError("DIGITAL_PAYMENT_UNAVAILABLE", "Pembayaran digital belum tersedia. Bayar dengan transfer ke rekening EQUA atau tunai.");
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    if (!(await isReverified(tx, cctx))) {
      throw new DomainError("REVERIFY_REQUIRED", "Demi keamanan, masukkan kode verifikasi WhatsApp sebelum membayar.");
    }
    let amount = 0;
    let invoiceId: string | null = null;
    let orderId: string | null = null;
    if (data.target === "invoice") {
      if (!data.invoiceId) throw new DomainError("INVOICE_REQUIRED", "Pilih tagihan yang dibayar.");
      const [inv] = await loadOwnInvoices(tx, cctx, [data.invoiceId]);
      if (inv!.outstandingAmount <= 0) throw new ConflictError("INVOICE_PAID", `Tagihan ${inv!.number} sudah lunas.`);
      amount = inv!.outstandingAmount;
      invoiceId = inv!.id;
    } else if (data.target === "all_invoices") {
      const rows = await tx.select({ amt: invoices.outstandingAmount, dispute: invoices.disputeStatus }).from(invoices).where(and(eq(invoices.customerId, customerId), gt(invoices.outstandingAmount, 0)));
      amount = rows.filter((r) => r.dispute !== "disputed").reduce((s, r) => s + r.amt, 0);
      if (amount <= 0) throw new ConflictError("NOTHING_DUE", "Tidak ada tagihan yang perlu dibayar.");
    } else {
      if (!data.orderId) throw new DomainError("ORDER_REQUIRED", "Pilih pesanan yang dibayar.");
      const order = await loadOwnOrder(tx, cctx, data.orderId);
      if (["completed", "cancelled", "in_delivery"].includes(order.status)) throw new ConflictError("ORDER_NOT_PAYABLE", `Pesanan ${order.number} tidak dapat dibayar di muka (status ${label("customer_order_status", order.status)}).`);
      const paid = await tx.select({ id: paymentIntents.id }).from(paymentIntents).where(and(eq(paymentIntents.orderId, order.id), inArray(paymentIntents.status, ["succeeded", "matched"]))).limit(1);
      if (paid.length) throw new ConflictError("ORDER_PAID", `Pesanan ${order.number} sudah dibayar.`);
      amount = order.totalAmount;
      orderId = order.id;
    }
    const existing = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.customerId, customerId),
          eq(paymentIntents.status, "pending"),
          eq(paymentIntents.method, data.method),
          eq(paymentIntents.amount, amount),
          gt(paymentIntents.expiresAt, cctx.now),
          invoiceId ? eq(paymentIntents.invoiceId, invoiceId) : isNull(paymentIntents.invoiceId),
          orderId ? eq(paymentIntents.orderId, orderId) : isNull(paymentIntents.orderId),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];
    const rules = await paymentRules(tx, customerBusinessDate(cctx), cctx.tenantId);
    const customer = await loadCustomer(tx, customerId);
    const gatewayOrderId = newGatewayOrderId(cctx.now);
    let charge;
    try {
      charge = await gateway.charge({ gatewayOrderId, amount, method: data.method, vaBank: rules.va_bank, expiryMinutes: rules.intent_valid_minutes, customer: { name: customer.name, phone: cctx.phone }, now: cctx.now });
    } catch (error) {
      throw new DomainError("GATEWAY_FAILED", `Kode bayar gagal dibuat${error instanceof GatewayError ? ` (${error.message})` : ""}. Coba lagi beberapa saat atau bayar dengan transfer.`);
    }
    const [row] = await tx
      .insert(paymentIntents)
      .values({
        tenantId: cctx.tenantId,
        customerId,
        customerAccountId: cctx.accountId,
        invoiceId,
        orderId,
        amount,
        gateway: gateway.key,
        method: data.method,
        status: "pending",
        gatewayOrderId,
        gatewayTransactionId: charge.transactionId,
        qrString: charge.qrString ?? charge.qrUrl,
        vaNumber: charge.vaNumber,
        vaBank: charge.vaBank,
        expiresAt: charge.expiresAt,
        createdAt: cctx.now,
        updatedAt: cctx.now,
      })
      .returning();
    await recordCustomerAudit(tx, cctx, { objectType: "payment_intent", objectId: row!.id, action: "create", after: { amount, method: data.method, target: data.target, invoiceId, orderId, gatewayOrderId, gateway: gateway.key }, rule: "US-P2-04 KP-3, PTB-50" });
    return row!;
  });
}

export type PaymentIntentView = {
  id: string;
  status: EnumValue<"payment_intent_status">;
  statusLabel: string;
  method: EnumValue<"payment_intent_method">;
  methodLabel: string;
  amount: number;
  gatewayOrderId: string;
  qrString: string | null;
  vaNumber: string | null;
  vaBank: string | null;
  expiresAt: Date | null;
  succeededAt: Date | null;
  invoiceNumber: string | null;
  orderNumber: string | null;
  orderId: string | null;
};

/** Kode bayar milik pelanggan (halaman bayar / penyegaran status). */
export async function getMyPaymentIntent(cctx: CustomerContext, intentId: string, opts: { tx?: Tx } = {}): Promise<PaymentIntentView> {
  const customerId = requireLinked(cctx);
  const tx = opts.tx ?? getDb();
  const [row] = await tx
    .select({ p: paymentIntents, inv: invoices.number, ord: orders.number })
    .from(paymentIntents)
    .leftJoin(invoices, eq(invoices.id, paymentIntents.invoiceId))
    .leftJoin(orders, eq(orders.id, paymentIntents.orderId))
    .where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.customerId, customerId)))
    .limit(1);
  if (!row) throw new NotFoundError("Pembayaran tidak ditemukan.");
  const p = row.p;
  const status = p.status === "pending" && p.expiresAt && p.expiresAt <= cctx.now ? "expired" : p.status;
  return {
    id: p.id,
    status,
    statusLabel: label("payment_intent_status", status),
    method: p.method,
    methodLabel: label("payment_gateway_method", p.method),
    amount: p.amount,
    gatewayOrderId: p.gatewayOrderId,
    qrString: p.qrString,
    vaNumber: p.vaNumber,
    vaBank: p.vaBank,
    expiresAt: p.expiresAt,
    succeededAt: p.succeededAt,
    invoiceNumber: row.inv,
    orderNumber: row.ord,
    orderId: p.orderId,
  };
}

export type NotificationOutcome = { result: "applied" | "duplicate" | "ignored" | "invalid" | "mismatch"; intentId?: string; status?: string };

/**
 * Pemberitahuan gerbang (webhook, tanpa sesi): tanda tangan diverifikasi adaptor; Berhasil → pelunasan & event
 * (sekali); Gagal/Kedaluwarsa → status. Pemberitahuan berulang tidak menggandakan pelunasan.
 */
export async function handleGatewayNotification(body: Record<string, unknown>, opts: { now?: Date; tx?: Tx } = {}): Promise<NotificationOutcome> {
  const gateway = activeGateway();
  if (!gateway) return { result: "ignored" };
  const n = gateway.parseNotification(body);
  if (!n) return { result: "invalid" };
  const now = opts.now ?? new Date();
  return runInTx(opts.tx, async (tx) => {
    const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.gatewayOrderId, n.gatewayOrderId)).limit(1).for("update");
    if (!intent) return { result: "ignored" };
    if (intent.status === "succeeded" || intent.status === "matched") return { result: "duplicate", intentId: intent.id, status: intent.status };
    if (n.status === "succeeded") {
      if (n.grossAmount !== intent.amount) {
        await tx.update(paymentIntents).set({ lastNotification: n.raw, updatedAt: now }).where(eq(paymentIntents.id, intent.id));
        await notify(tx, {
          event: "customer_app.payment_succeeded",
          tenantId: intent.tenantId,
          title: `Nominal pembayaran digital ${intent.gatewayOrderId} tidak cocok`,
          body: `Gerbang melaporkan ${formatRupiah(n.grossAmount)}, tagihan ${formatRupiah(intent.amount)}. Periksa di dasbor gerbang; pelunasan belum dicatat.`,
          objectType: "payment_intent",
          objectId: intent.id,
          link: "/keluhan/pembayaran",
          now,
        });
        return { result: "mismatch", intentId: intent.id };
      }
      await applySucceeded(tx, intent, n, now);
      return { result: "applied", intentId: intent.id, status: "succeeded" };
    }
    if (n.status === "failed" || n.status === "expired") {
      await tx.update(paymentIntents).set({ status: n.status, lastNotification: n.raw, updatedAt: now }).where(eq(paymentIntents.id, intent.id));
      return { result: "applied", intentId: intent.id, status: n.status };
    }
    await tx.update(paymentIntents).set({ lastNotification: n.raw, updatedAt: now }).where(eq(paymentIntents.id, intent.id));
    return { result: "applied", intentId: intent.id, status: intent.status };
  });
}

function gatewayFee(amount: number, method: string, rules: { qris_fee_percent: number; va_fee_amount: number }): number {
  return method === "qris_dynamic" ? Math.round((amount * rules.qris_fee_percent) / 100) : rules.va_fee_amount;
}

async function applySucceeded(tx: Tx, intent: PaymentIntentRow, n: GatewayNotification, now: Date): Promise<void> {
  const date = toBusinessDate(now);
  const ctx: ActorContext = systemContext({ tenantId: intent.tenantId, now });
  const rules = await paymentRules(tx, date, intent.tenantId);
  const fee = gatewayFee(intent.amount, intent.method, rules);

  // Alokasi tertua dulu (faktur bersengketa dilewati); sisa / bayar di muka → uang muka (US-M5-02 KP-3).
  const allocations: { invoiceId: string; amount: number }[] = [];
  let remaining = intent.amount;
  if (!intent.orderId) {
    const conds: SQL[] = [eq(invoices.customerId, intent.customerId), gt(invoices.outstandingAmount, 0), sql`${invoices.disputeStatus} <> 'disputed'`];
    if (intent.invoiceId) conds.push(eq(invoices.id, intent.invoiceId));
    const open = await tx.select().from(invoices).where(and(...conds)).orderBy(asc(invoices.dueDate), asc(invoices.issueDate), asc(invoices.number)).for("update");
    for (const inv of open) {
      if (remaining <= 0) break;
      const a = Math.min(remaining, inv.outstandingAmount);
      allocations.push({ invoiceId: inv.id, amount: a });
      remaining -= a;
    }
  }
  const advance = remaining;
  const [payment] = await tx
    .insert(customerPayments)
    .values({
      tenantId: intent.tenantId,
      customerId: intent.customerId,
      channel: "digital",
      method: "digital",
      amount: intent.amount,
      businessDate: date,
      paymentIntentId: intent.id,
      advanceAmount: advance,
      notes: `Pembayaran digital ${label("payment_gateway_method", intent.method)} ${intent.gatewayOrderId}${intent.orderId ? " (bayar di muka)" : ""}`,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  for (const a of allocations) {
    await tx.insert(paymentAllocations).values({ invoiceId: a.invoiceId, customerPaymentId: payment!.id, amount: a.amount, allocatedAt: now, createdAt: now, updatedAt: now });
  }
  await tx
    .update(paymentIntents)
    .set({ status: "succeeded", succeededAt: now, gatewayFee: fee, gatewayTransactionId: n.transactionId ?? intent.gatewayTransactionId, customerPaymentId: payment!.id, lastNotification: n.raw, updatedAt: now })
    .where(eq(paymentIntents.id, intent.id));
  await auditRecord(tx, {
    ctx,
    objectType: "payment_intent",
    objectId: intent.id,
    action: "succeeded",
    before: { status: intent.status },
    after: { status: "succeeded", customerPaymentId: payment!.id, allocations, advanceAmount: advance, gatewayFee: fee, gatewayTransactionId: n.transactionId },
    rule: "US-P2-04 KP-3, PTB-50",
  });
  await emit(
    tx,
    "collection.recorded",
    {
      customerPaymentId: payment!.id,
      customerId: intent.customerId,
      amount: intent.amount,
      channel: "digital",
      method: "digital",
      allocations,
      advanceAmount: advance,
      businessDate: date,
      notes: payment!.notes,
    },
    { ctx, tenantId: intent.tenantId, businessDate: date, objectType: "customer_payment", objectId: payment!.id },
  );
  await emit(
    tx,
    "digital_payment.succeeded",
    {
      paymentIntentId: intent.id,
      customerId: intent.customerId,
      amount: intent.amount,
      gatewayFee: fee,
      method: intent.method,
      invoiceIds: allocations.map((a) => a.invoiceId),
      customerPaymentId: payment!.id,
      orderId: intent.orderId,
      prepaid: !!intent.orderId,
      gatewayOrderId: intent.gatewayOrderId,
      gateway: intent.gateway,
      advanceAmount: advance,
      businessDate: date,
    },
    { ctx, tenantId: intent.tenantId, businessDate: date, objectType: "payment_intent", objectId: intent.id },
  );

  // Bayar di muka (US-P2-04 KP-4): cara bayar pesanan & rit yang belum berangkat → "Pembayaran digital".
  if (intent.orderId) {
    const [order] = await tx.select().from(orders).where(eq(orders.id, intent.orderId)).limit(1);
    if (order && order.status !== "cancelled") {
      await tx.update(orders).set({ paymentMethod: "digital", updatedAt: now }).where(eq(orders.id, order.id));
      await tx.update(trips).set({ paymentMethod: "digital", updatedAt: now }).where(and(eq(trips.orderId, order.id), eq(trips.status, "assigned"), isNull(trips.departedAt)));
      await tx.update(customerAppOrders).set({ prepaidAt: now, prepaidAmount: intent.amount, updatedAt: now }).where(eq(customerAppOrders.orderId, order.id));
      await auditRecord(tx, { ctx, objectType: "order", objectId: order.id, action: "prepaid", before: { paymentMethod: order.paymentMethod }, after: { paymentMethod: "digital", prepaidAmount: intent.amount, paymentIntentId: intent.id }, rule: "US-P2-04 KP-4" });
    }
  }
  const [customer] = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, intent.customerId)).limit(1);
  await notifyCustomer(tx, {
    tenantId: intent.tenantId,
    customerId: intent.customerId,
    kind: "payment_succeeded",
    title: `Pembayaran ${formatRupiah(intent.amount)} berhasil`,
    body: intent.orderId ? "Pesanan Anda sudah dibayar di muka; sopir tidak menagih tunai." : allocations.length ? `Tagihan terlunasi: ${allocations.length} faktur.${advance > 0 ? ` Sisa ${formatRupiah(advance)} menjadi saldo uang muka.` : ""}` : `Tercatat sebagai saldo uang muka ${formatRupiah(advance)}.`,
    link: intent.orderId ? `/app/pesanan/${intent.orderId}` : "/app/tagihan",
    objectType: "payment_intent",
    objectId: intent.id,
    dedupeKey: `payment_succeeded:${intent.id}`,
    now,
    wa: { kind: "payment_receipt", text: `Pembayaran EQUA ${formatRupiah(intent.amount)} (${intent.gatewayOrderId}) sudah kami terima. Terima kasih.`, variables: { jumlah: formatRupiah(intent.amount), nomor: intent.gatewayOrderId } },
  });
  await notify(tx, {
    event: "customer_app.payment_succeeded",
    tenantId: intent.tenantId,
    title: `Pembayaran digital ${formatRupiah(intent.amount)} — ${customer?.name ?? "pelanggan"}`,
    body: `${label("payment_gateway_method", intent.method)} ${intent.gatewayOrderId}; biaya gerbang ${formatRupiah(fee)}. Cocokkan dengan settlement di Kas > Transfer masuk.`,
    objectType: "payment_intent",
    objectId: intent.id,
    link: "/kas/transfer",
    now,
  });
}

/** Kode bayar kedaluwarsa (job): Menunggu → Kedaluwarsa. */
export async function expirePendingIntents(tx: Tx, now: Date): Promise<number> {
  const rows = await tx
    .update(paymentIntents)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(paymentIntents.status, "pending"), lt(paymentIntents.expiresAt, now)))
    .returning({ id: paymentIntents.id });
  return rows.length;
}

/** Transfer masuk "pembayaran digital" dicocokkan M4 → status Dicocokkan (settlement bank diterima). */
export async function markIntentMatched(tx: Tx, input: { incomingTransferId: string; now: Date }): Promise<boolean> {
  const [t] = await tx.select().from(incomingTransfers).where(eq(incomingTransfers.id, input.incomingTransferId)).limit(1);
  if (!t || t.sourceKind !== "digital_payment" || t.sourceObjectType !== "payment_intent" || !t.sourceObjectId) return false;
  const rows = await tx
    .update(paymentIntents)
    .set({ status: "matched", settledAt: input.now, incomingTransferId: t.id, updatedAt: input.now })
    .where(and(eq(paymentIntents.id, t.sourceObjectId), eq(paymentIntents.status, "succeeded")))
    .returning({ id: paymentIntents.id });
  return rows.length > 0;
}

/**
 * Simulasi pemberitahuan gerbang TIRUAN (dev/uji/E2E; tidak tersedia di produksi): menandatangani badan pemberitahuan
 * lalu memprosesnya seperti webhook.
 */
export async function simulateMockPayment(intentId: string, status: "settlement" | "expire" | "deny" = "settlement", opts: { now?: Date; tx?: Tx } = {}): Promise<NotificationOutcome> {
  const gateway = activeGateway();
  if (!gateway || gateway.key !== "mock") throw new DomainError("MOCK_ONLY", "Simulasi hanya tersedia untuk gerbang tiruan (dev/uji).");
  const db = opts.tx ?? getDb();
  const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1);
  if (!intent) throw new NotFoundError("Pembayaran tidak ditemukan.");
  const body = { order_id: intent.gatewayOrderId, transaction_status: status, gross_amount: String(intent.amount), payment_type: intent.method };
  return handleGatewayNotification({ ...body, signature: signMockNotification(body) }, opts);
}

// =====================================================================================================================
// Kantor: daftar pembayaran digital (/keluhan/pembayaran)
// =====================================================================================================================

export type OfficePaymentRow = {
  id: string;
  customerName: string;
  amount: number;
  method: string;
  status: EnumValue<"payment_intent_status">;
  gatewayOrderId: string;
  gatewayFee: number | null;
  createdAt: Date;
  succeededAt: Date | null;
  settledAt: Date | null;
  target: string;
};

export async function listPaymentIntents(ctx: ActorContext, filter: { status?: string | null; from?: Date | null; to?: Date | null } = {}, opts: { tx?: Tx } = {}): Promise<OfficePaymentRow[]> {
  await authorize(ctx, "p2.payment_intent.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds: SQL[] = [eq(paymentIntents.tenantId, ctx.tenantId)];
  if (filter.status) conds.push(sql`${paymentIntents.status} = ${filter.status}`);
  if (filter.from) conds.push(gte(paymentIntents.createdAt, filter.from));
  if (filter.to) conds.push(lte(paymentIntents.createdAt, filter.to));
  const rows = await tx
    .select({ p: paymentIntents, customerName: customers.name, inv: invoices.number, ord: orders.number })
    .from(paymentIntents)
    .innerJoin(customers, eq(customers.id, paymentIntents.customerId))
    .leftJoin(invoices, eq(invoices.id, paymentIntents.invoiceId))
    .leftJoin(orders, eq(orders.id, paymentIntents.orderId))
    .where(and(...conds))
    .orderBy(desc(paymentIntents.createdAt))
    .limit(500);
  return rows.map(({ p, customerName, inv, ord }) => ({
    id: p.id,
    customerName,
    amount: p.amount,
    method: label("payment_gateway_method", p.method),
    status: p.status,
    gatewayOrderId: p.gatewayOrderId,
    gatewayFee: p.gatewayFee,
    createdAt: p.createdAt,
    succeededAt: p.succeededAt,
    settledAt: p.settledAt,
    target: ord ? `Pesanan ${ord} (bayar di muka)` : inv ? `Faktur ${inv}` : "Semua tagihan terbuka",
  }));
}

/** Pembayaran di muka yang berhasil untuk rit tertentu (pull `p2.prepaid_trips`, laporan). */
export async function prepaidTrips(tx: Tx, tripIds: string[]): Promise<{ tripId: string; orderId: string; paidAmount: number; paidAt: Date | null; reference: string }[]> {
  if (!tripIds.length) return [];
  const rows = await tx
    .select({ tripId: trips.id, orderId: trips.orderId, amount: paymentIntents.amount, at: paymentIntents.succeededAt, ref: paymentIntents.gatewayOrderId })
    .from(trips)
    .innerJoin(paymentIntents, and(eq(paymentIntents.orderId, trips.orderId), inArray(paymentIntents.status, ["succeeded", "matched"])))
    .where(inArray(trips.id, tripIds));
  return rows.map((r) => ({ tripId: r.tripId, orderId: r.orderId, paidAmount: r.amount, paidAt: r.at, reference: r.ref }));
}
