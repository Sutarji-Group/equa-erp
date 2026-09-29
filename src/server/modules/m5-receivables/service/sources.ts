/**
 * M5 — piutang terbentuk otomatis dari transaksi sumber (US-M5-01 KP-1/KP-2; B-16, B-22; US-M4-04 KP-4):
 *
 * - Rit Selesai tempo (`trip.completed` / `trip.payment_recorded`, M3) → faktur kirim per rit (PTB-24), jatuh tempo =
 *   tanggal kirim + tempo pelanggan (PAR-08); pelanggan tagihan bulanan (BR-05) → `unbilled_charges` "belum ditagih";
 *   tersinkron setelah faktur bulanan periodenya terbit → bertanda terlambat (masuk faktur bulan berikutnya).
 * - Kurang bayar lapangan (PTB-18) → faktur `underpayment` jatuh tempo H+`underpayment_due_days` (bawaan H+0) +
 *   notifikasi Admin Keuangan & Dispatcher (bila M3 belum mengirim `trip.underpayment` untuk rit itu).
 * - Penjualan tempo toko (`pos_sale.recorded` metode `credit`, M7) → faktur per transaksi + `pos_sales.invoice_id`.
 * - Void setelah shift ditutup / retur toko tempo (`pos_sale.voided`, `store_return.recorded`) → nota kredit.
 * - Transfer "Tidak ditemukan" (M4) → piutang sementara "transfer belum diterima"; transfer dicocokkan → penanda dihapus.
 *
 * Semua fungsi IDEMPOTEN (event dapat terulang/diputar ulang): cek faktur (jenis + rit / transaksi / transfer).
 */
import "server-only";

import { and, desc, eq, isNull, like, lt, sql } from "drizzle-orm";

import { creditNotes, customerAddresses, customers, invoices, notifications, posSaleLines, posSales, products, shifts, trips, unbilledCharges } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, firstDayOfMonth, formatTanggal, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";
import { notify } from "@/server/core/notifications";

import { invoiceLink, receivableRules } from "./common";
import { afterReceivablesChanged } from "./credit-hold";
import { createAdvance, invoiceForTrip, issueCreditNote, issueInvoice, recomputeInvoice, type InvoiceLineInput } from "./ledger";

// =====================================================================================================================
// Rit (M3)
// =====================================================================================================================

export type TripReceivableInput = {
  tripId: string;
  businessDate: BusinessDate;
  /** Nilai tempo (harga rit) bila cara bayar tempo; 0 bila bukan tempo. */
  creditAmount: number;
  /** Kurang bayar tunai/transfer (PTB-18). */
  underpaymentAmount: number;
  expectedAmount?: number;
  receivedAmount?: number;
  underpaymentReason?: string | null;
  lateSync?: boolean;
  /** B-65: nilai rit yang sudah dibayar di muka lewat aplikasi pelanggan (cara bayar `digital`). */
  prepaidAmount?: number;
};

export type TripReceivableResult = { deliveryInvoiceId: string | null; unbilledChargeId: string | null; underpaymentInvoiceId: string | null };

/**
 * Nilai prabayar digital rit Selesai (B-65, D-11 butir 4) — SATU definisi untuk M5 (faktur lunas uang muka) & M11
 * (pendapatan terhadap uang muka): `prepaidAmount` dari M3 bila ada; bila tidak, harga rit dikurangi uang yang
 * diterima/ditagih di lapangan. 0 untuk cara bayar selain `digital`.
 */
export function prepaidAmountOfTrip(p: {
  paymentMethod: string;
  price: number;
  prepaidAmount?: number | null;
  cashReceived?: number;
  transferAmount?: number;
  creditAmount?: number;
  underpaymentAmount?: number;
}): number {
  if (p.paymentMethod !== "digital") return 0;
  if (typeof p.prepaidAmount === "number") return Math.max(0, Math.round(p.prepaidAmount));
  return Math.max(0, p.price - (p.cashReceived ?? 0) - (p.transferAmount ?? 0) - (p.creditAmount ?? 0) - (p.underpaymentAmount ?? 0));
}

/** Bentuk piutang dari rit Selesai (idempoten per rit & jenis). */
export async function receivablesFromTrip(tx: Tx, ctx: ActorContext, input: TripReceivableInput): Promise<TripReceivableResult> {
  const out: TripReceivableResult = { deliveryInvoiceId: null, unbilledChargeId: null, underpaymentInvoiceId: null };
  const [trip] = await tx.select().from(trips).where(eq(trips.id, input.tripId)).limit(1);
  if (!trip || trip.isInternal) return out;
  const [customer] = await tx.select().from(customers).where(eq(customers.id, trip.customerId)).limit(1);
  if (!customer) return out;
  const [addr] = await tx.select({ text: customerAddresses.addressText, label: customerAddresses.label }).from(customerAddresses).where(eq(customerAddresses.id, trip.addressId)).limit(1);
  const volume = trip.deliveredVolumeL ?? trip.plannedVolumeL;
  const serviceDate = input.businessDate;
  const tripDesc = `Air truk ${volume.toLocaleString("id-ID")} L — rit ${trip.number}, ${formatTanggal(serviceDate, { weekday: false })}${addr ? `, ${addr.text}` : ""}`;

  if (input.creditAmount > 0) {
    if (customer.monthlyBilling) {
      const [existing] = await tx.select({ id: unbilledCharges.id }).from(unbilledCharges).where(eq(unbilledCharges.tripId, trip.id)).limit(1);
      if (existing) out.unbilledChargeId = existing.id;
      else {
        // US-M5-06 KP-3: faktur bulanan periode layanan sudah terbit → masuk bulan berikutnya dengan penanda.
        const [monthly] = await tx
          .select({ id: invoices.id, number: invoices.number })
          .from(invoices)
          .where(and(eq(invoices.customerId, customer.id), eq(invoices.kind, "monthly"), eq(invoices.periodMonth, firstDayOfMonth(serviceDate))))
          .limit(1);
        const [row] = await tx
          .insert(unbilledCharges)
          .values({
            tenantId: trip.tenantId,
            customerId: customer.id,
            tripId: trip.id,
            serviceDate,
            description: tripDesc,
            amount: input.creditAmount,
            volumeL: volume,
            status: "unbilled",
            lateSync: !!monthly,
          })
          .returning();
        out.unbilledChargeId = row!.id;
        await auditRecord(tx, {
          ctx,
          objectType: "unbilled_charge",
          objectId: row!.id,
          action: "create",
          after: { tripId: trip.id, tripNumber: trip.number, amount: input.creditAmount, serviceDate, lateSync: !!monthly, monthlyInvoice: monthly?.number ?? null },
          reason: monthly ? `Tersinkron setelah faktur bulanan ${monthly.number} terbit — masuk faktur bulan berikutnya (US-M5-06 KP-3).` : null,
          rule: "US-M5-01 KP-2, BR-05",
          businessDate: serviceDate,
        });
      }
    } else {
      const existing = await invoiceForTrip(tx, trip.id, "delivery");
      if (existing) out.deliveryInvoiceId = existing.id;
      else {
        const inv = await issueInvoice(tx, ctx, {
          tenantId: trip.tenantId,
          customerId: customer.id,
          kind: "delivery",
          addressId: trip.addressId,
          tripId: trip.id,
          issueDate: serviceDate,
          dueDate: addDays(serviceDate, customer.paymentTermDays),
          description: `Faktur kirim rit ${trip.number}`,
          lines: [{ component: "trip", description: tripDesc, tripId: trip.id, serviceDate, quantity: 1, unitPrice: input.creditAmount, amount: input.creditAmount, volumeL: volume }],
          rule: "US-M5-01 KP-1, PTB-24",
        });
        out.deliveryInvoiceId = inv.id;
      }
    }
  }

  // B-65: rit prabayar digital → faktur kirim yang langsung dilunasi uang muka pelanggan (bukan kurang bayar/tempo).
  // Pemakaian uang muka memancarkan `customer_advance.applied` → M11 Dr uang muka / Cr piutang; bersama jurnal rit
  // Selesai (Dr piutang / Cr pendapatan) hasil bersihnya pendapatan diakui terhadap uang muka 2-1201.
  if ((input.prepaidAmount ?? 0) > 0) {
    const existing = await invoiceForTrip(tx, trip.id, "delivery");
    if (existing) out.deliveryInvoiceId = existing.id;
    else {
      const amount = input.prepaidAmount!;
      const inv = await issueInvoice(tx, ctx, {
        tenantId: trip.tenantId,
        customerId: customer.id,
        kind: "delivery",
        addressId: trip.addressId,
        tripId: trip.id,
        issueDate: serviceDate,
        dueDate: serviceDate,
        description: `Faktur rit ${trip.number} — dibayar di muka lewat aplikasi pelanggan`,
        lines: [{ component: "trip", description: `${tripDesc} (prabayar digital)`, tripId: trip.id, serviceDate, quantity: 1, unitPrice: amount, amount, volumeL: volume }],
        rule: "US-P2-04 KP-4, D-11 butir 4",
      });
      out.deliveryInvoiceId = inv.id;
    }
  }

  if (input.underpaymentAmount > 0) {
    const existing = await invoiceForTrip(tx, trip.id, "underpayment");
    if (existing) out.underpaymentInvoiceId = existing.id;
    else {
      const rules = await receivableRules(tx, serviceDate, trip.tenantId);
      const received = input.receivedAmount ?? (input.expectedAmount ?? trip.price) - input.underpaymentAmount;
      const inv = await issueInvoice(tx, ctx, {
        tenantId: trip.tenantId,
        customerId: customer.id,
        kind: "underpayment",
        addressId: trip.addressId,
        tripId: trip.id,
        issueDate: serviceDate,
        dueDate: addDays(serviceDate, rules.underpayment_due_days),
        description: `Kurang bayar rit ${trip.number}`,
        lines: [
          {
            component: "underpayment",
            description: `Kurang bayar rit ${trip.number}: diterima ${formatRupiah(received)} dari ${formatRupiah(input.expectedAmount ?? trip.price)}${input.underpaymentReason ? ` (${input.underpaymentReason})` : ""}`,
            tripId: trip.id,
            serviceDate,
            quantity: 1,
            unitPrice: input.underpaymentAmount,
            amount: input.underpaymentAmount,
            volumeL: volume,
          },
        ],
        rule: "US-M5-01 KP-1, PTB-18",
        reason: input.underpaymentReason ?? null,
      });
      out.underpaymentInvoiceId = inv.id;
      // 6.3 "Kurang bayar di lapangan" → Admin Keuangan & Dispatcher (M3 biasanya sudah mengirim; jangan dobel).
      const [sent] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.event, "trip.underpayment"), eq(notifications.objectId, trip.id)))
        .limit(1);
      if (!sent) {
        await notify(tx, {
          event: "trip.underpayment",
          tenantId: trip.tenantId,
          title: `Kurang bayar ${formatRupiah(input.underpaymentAmount)}: ${customer.name}`,
          body: `Rit ${trip.number}. Faktur ${inv.number} jatuh tempo ${formatTanggal(inv.dueDate, { weekday: false })} (PTB-18); pesanan berikutnya bertanda "tagih kurang bayar".`,
          objectType: "trip",
          objectId: trip.id,
          valueAmount: input.underpaymentAmount,
          link: invoiceLink(inv.id),
          groupKey: `trip.underpayment:${trip.id}`,
          now: ctx.now,
        });
      }
    }
  }
  return out;
}

export async function onTripCompleted(tx: Tx, ctx: ActorContext, event: DomainEvent<"trip.completed">): Promise<TripReceivableResult | null> {
  const p = event.payload;
  if (p.isInternal) return null;
  return receivablesFromTrip(tx, ctx, {
    tripId: p.tripId,
    businessDate: p.businessDate ?? event.businessDate ?? p.completedAt.slice(0, 10),
    creditAmount: p.paymentMethod === "credit" ? (p.creditAmount || p.price) : 0,
    underpaymentAmount: p.underpaymentAmount ?? 0,
    expectedAmount: p.expectedAmount ?? p.price,
    receivedAmount: p.paymentMethod === "cash" ? p.cashReceived : p.paymentMethod === "transfer" ? p.transferAmount : 0,
    underpaymentReason: p.underpaymentReason ?? null,
    lateSync: p.lateSync,
    prepaidAmount: prepaidAmountOfTrip(p),
  });
}

export async function onTripPaymentRecorded(tx: Tx, ctx: ActorContext, event: DomainEvent<"trip.payment_recorded">): Promise<TripReceivableResult | null> {
  const p = event.payload;
  const businessDate = p.businessDate ?? event.businessDate;
  if (!businessDate) return null;
  return receivablesFromTrip(tx, ctx, {
    tripId: p.tripId,
    businessDate,
    creditAmount: p.method === "credit" ? (p.expectedAmount ?? p.amount) : 0,
    underpaymentAmount: p.underpaymentAmount ?? 0,
    expectedAmount: p.expectedAmount,
    receivedAmount: p.receivedAmount,
    underpaymentReason: p.underpaymentReason ?? null,
    lateSync: p.lateSync,
  });
}

// =====================================================================================================================
// Penjualan tempo toko (M7) — US-M7-04 KP-2/KP-3
// =====================================================================================================================

/**
 * Faktur per penjualan tempo toko (idempoten per transaksi; `pos_sales.invoice_id` diisi). Diterbitkan saat shift
 * DITUTUP (atau langsung bila transaksi tersinkron setelah shift ditutup) — selama shift berjalan transaksi masih
 * dapat di-void (PAR-60) dan eksposur menghitungnya sebagai "tempo toko belum difakturkan".
 */
export async function invoiceStoreSale(tx: Tx, ctx: ActorContext, saleId: string, opts: { paymentTermDays?: number | null } = {}): Promise<string | null> {
  const [sale] = await tx.select().from(posSales).where(eq(posSales.id, saleId)).limit(1);
  if (!sale || sale.paymentMethod !== "credit" || !sale.customerId) return null;
  const [existing] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.posSaleId, sale.id)).limit(1);
  if (existing) {
    if (!sale.invoiceId) await tx.update(posSales).set({ invoiceId: existing.id, updatedAt: ctx.now }).where(eq(posSales.id, sale.id));
    return existing.id;
  }
  if (sale.status !== "valid" || sale.isReversal) return null;
  const [customer] = await tx.select().from(customers).where(eq(customers.id, sale.customerId)).limit(1);
  if (!customer) return null;
  const lines = await tx
    .select({ l: posSaleLines, name: products.name })
    .from(posSaleLines)
    .leftJoin(products, eq(products.id, posSaleLines.productId))
    .where(eq(posSaleLines.posSaleId, sale.id))
    .orderBy(posSaleLines.lineNo);
  const businessDate = sale.businessDate;
  const term = opts.paymentTermDays ?? customer.paymentTermDays;
  const invLines: InvoiceLineInput[] = lines.map(({ l, name }) => ({
    component: "store_item",
    description: `${name ?? "Barang toko"} × ${l.quantity}`,
    posSaleLineId: l.id,
    productId: l.productId,
    serviceDate: businessDate,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: l.lineTotal,
  }));
  const linesTotal = invLines.reduce((acc, l) => acc + l.amount, 0);
  if (linesTotal !== sale.total) {
    invLines.push({
      component: "other",
      description: sale.discountAmount ? `Diskon kasir${sale.discountReason ? ` (${sale.discountReason})` : ""}` : "Penyesuaian transaksi",
      serviceDate: businessDate,
      quantity: 1,
      unitPrice: sale.total - linesTotal,
      amount: sale.total - linesTotal,
    });
  }
  const inv = await issueInvoice(tx, ctx, {
    tenantId: sale.tenantId,
    customerId: customer.id,
    kind: "store_sale",
    posSaleId: sale.id,
    outletId: sale.outletId,
    issueDate: businessDate,
    dueDate: addDays(businessDate, term),
    description: `Penjualan tempo toko ${sale.number ?? sale.localNumber}`,
    lines: invLines,
    rule: "US-M5-01 KP-1, US-M7-04 KP-3",
  });
  await tx.update(posSales).set({ invoiceId: inv.id, updatedAt: ctx.now }).where(eq(posSales.id, sale.id));
  return inv.id;
}

/** `pos_sale.recorded` tempo: faktur langsung hanya bila shift-nya sudah ditutup (sinkron terlambat / persetujuan). */
export async function invoiceFromPosSale(tx: Tx, ctx: ActorContext, event: DomainEvent<"pos_sale.recorded">): Promise<string | null> {
  const p = event.payload;
  if (p.method !== "credit" || !p.customerId) return null;
  const [shift] = await tx.select({ status: shifts.status }).from(shifts).where(eq(shifts.id, p.shiftId)).limit(1);
  if (shift?.status !== "closed") return null;
  return invoiceStoreSale(tx, ctx, p.posSaleId, { paymentTermDays: p.paymentTermDays ?? null });
}

/** `shift.closed`: terbitkan faktur semua penjualan tempo Sah shift itu yang belum difakturkan. */
export async function invoiceShiftCreditSales(tx: Tx, ctx: ActorContext, shiftId: string): Promise<string[]> {
  const sales = await tx
    .select({ id: posSales.id })
    .from(posSales)
    .where(and(eq(posSales.shiftId, shiftId), eq(posSales.paymentMethod, "credit"), eq(posSales.status, "valid"), eq(posSales.isReversal, false), isNull(posSales.invoiceId)));
  const out: string[] = [];
  for (const sale of sales) {
    const id = await invoiceStoreSale(tx, ctx, sale.id);
    if (id) out.push(id);
  }
  return out;
}

/** Penjaga malam: penjualan tempo Sah pada shift yang sudah ditutup tetapi belum difakturkan. */
export async function sweepUninvoicedStoreSales(tx: Tx, ctx: ActorContext, tenantId: string): Promise<number> {
  const rows = await tx
    .select({ id: posSales.id })
    .from(posSales)
    .innerJoin(shifts, eq(shifts.id, posSales.shiftId))
    .where(and(eq(posSales.tenantId, tenantId), eq(posSales.paymentMethod, "credit"), eq(posSales.status, "valid"), eq(posSales.isReversal, false), isNull(posSales.invoiceId), eq(shifts.status, "closed")));
  let n = 0;
  for (const r of rows) if (await invoiceStoreSale(tx, ctx, r.id)) n++;
  return n;
}

/** Void penjualan tempo toko yang sudah difakturkan → nota kredit (kelebihan atas faktur terbayar → uang muka). */
export async function creditFromPosVoid(tx: Tx, ctx: ActorContext, event: DomainEvent<"pos_sale.voided">): Promise<string | null> {
  const p = event.payload;
  if (p.method !== "credit") return null;
  const [inv] = await tx.select().from(invoices).where(eq(invoices.posSaleId, p.posSaleId)).limit(1);
  if (!inv) return null;
  const tag = `[void ${p.posSaleId}]`;
  const reason = `Void transaksi toko: ${p.reason} ${tag}`;
  const [prior] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(creditNotes)
    .where(and(eq(creditNotes.invoiceId, inv.id), like(creditNotes.reason, `%${tag}%`)));
  if (Number(prior?.n ?? 0) > 0) return null;
  const res = await issueCreditNote(tx, ctx, { invoiceId: inv.id, amount: p.total, reason, purpose: "pos_void", posSaleId: p.posSaleId, excessToAdvance: true, approvalId: p.approvalId ?? null });
  await afterReceivablesChanged(tx, ctx, [inv.customerId]);
  return res.creditNote?.id ?? null;
}

/** Retur toko tempo setelah shift (PTB-46) → nota kredit atas faktur transaksi asal. */
export async function creditFromStoreReturn(tx: Tx, ctx: ActorContext, event: DomainEvent<"store_return.recorded">): Promise<string | null> {
  const p = event.payload;
  if (p.method !== "credit") return null; // tunai/QRIS: pengembalian dana (M4/M11), bukan piutang.
  const [inv] = await tx.select().from(invoices).where(eq(invoices.posSaleId, p.posSaleId)).limit(1);
  if (!inv) return null;
  // Idempoten: satu nota kredit per retur (alasan memuat ID retur).
  const tag = `[retur ${p.storeReturnId}]`;
  const [prior] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(creditNotes)
    .where(and(eq(creditNotes.invoiceId, inv.id), like(creditNotes.reason, `%${tag}%`)));
  if (Number(prior?.n ?? 0) > 0) return null;
  const res = await issueCreditNote(tx, ctx, {
    invoiceId: inv.id,
    amount: p.amount,
    reason: `Retur barang toko ${p.posSaleNumber ?? ""}: ${p.reason} ${tag}`.replace(/\s+/g, " ").trim(),
    purpose: "store_return",
    posSaleId: p.posSaleId,
    storeReturnId: p.storeReturnId,
    approvalId: p.approvalId ?? null,
    excessToAdvance: true,
    issueDate: p.businessDate,
  });
  await afterReceivablesChanged(tx, ctx, [inv.customerId]);
  return res.creditNote?.id ?? null;
}

// =====================================================================================================================
// Transfer tidak ditemukan / dicocokkan (M4) — US-M4-04 KP-4
// =====================================================================================================================

/** Transfer "Tidak ditemukan" → piutang sementara bertanda "transfer belum diterima" (jatuh tempo hari itu). */
export async function onTransferNotFound(tx: Tx, ctx: ActorContext, event: DomainEvent<"transfer.not_found">): Promise<string | null> {
  const p = event.payload;
  if (!p.customerId || p.amount <= 0) return null;
  if (!["trip_payment", "collection", "office_payment", "store_collection", "digital_payment"].includes(p.sourceKind)) return null;
  const [existing] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.pendingTransferId, p.incomingTransferId)).limit(1);
  if (existing) return existing.id;
  const [customer] = await tx.select().from(customers).where(eq(customers.id, p.customerId)).limit(1);
  if (!customer) return null;
  const date = event.businessDate ?? ctx.now.toISOString().slice(0, 10);
  const inv = await issueInvoice(tx, ctx, {
    tenantId: customer.tenantId,
    customerId: customer.id,
    kind: p.sourceKind === "store_collection" ? "store_sale" : "delivery",
    issueDate: date,
    dueDate: date,
    pendingTransferId: p.incomingTransferId,
    description: `Transfer belum diterima (${label("transfer_source_kind", p.sourceKind)})`,
    lines: [{ component: "other", description: `Piutang sementara: transfer ${formatRupiah(p.amount)} tidak ditemukan di mutasi bank`, serviceDate: date, quantity: 1, unitPrice: p.amount, amount: p.amount }],
    rule: "US-M4-04 KP-4",
    applyAdvances: false,
  });
  return inv.id;
}

/** Transfer dicocokkan → piutang sementara ditutup (nota kredit reklasifikasi) dan penanda dihapus. */
export async function onTransferMatched(tx: Tx, ctx: ActorContext, event: DomainEvent<"transfer.matched">): Promise<string | null> {
  const p = event.payload;
  const [inv] = await tx.select().from(invoices).where(eq(invoices.pendingTransferId, p.incomingTransferId)).limit(1);
  if (!inv) return null;
  await recomputeInvoice(tx, ctx, inv.id);
  const [fresh] = await tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
  const paidByCustomer = fresh!.paidAmount;
  if (fresh!.outstandingAmount > 0) {
    await issueCreditNote(tx, ctx, {
      invoiceId: inv.id,
      amount: fresh!.outstandingAmount,
      reason: "Transfer ternyata diterima & dicocokkan dengan mutasi bank — piutang sementara ditutup (US-M4-04 KP-4).",
      purpose: "pending_transfer_resolved",
    });
  }
  await tx.update(invoices).set({ pendingTransferId: null, updatedAt: ctx.now }).where(eq(invoices.id, inv.id));
  await auditRecord(tx, {
    ctx,
    objectType: "invoice",
    objectId: inv.id,
    action: "pending_transfer_cleared",
    before: { pendingTransferId: p.incomingTransferId },
    after: { pendingTransferId: null, paidMeanwhile: paidByCustomer },
    reason: "Transfer dicocokkan (M4).",
    rule: "US-M4-04 KP-4",
  });
  if (paidByCustomer > 0) {
    await createAdvance(tx, ctx, {
      tenantId: inv.tenantId,
      customerId: inv.customerId,
      amount: paidByCustomer,
      notes: `Piutang sementara ${inv.number} sudah dibayar pelanggan, lalu transfer aslinya ditemukan — pembayaran ganda menjadi uang muka.`,
    });
  }
  await afterReceivablesChanged(tx, ctx, [inv.customerId]);
  return inv.id;
}

/** Faktur piutang sementara yang masih aktif untuk transfer (M4 membaca untuk tampilan). */
export async function pendingTransferInvoice(tx: Tx, incomingTransferId: string) {
  const [row] = await tx.select().from(invoices).where(eq(invoices.pendingTransferId, incomingTransferId)).orderBy(desc(invoices.createdAt)).limit(1);
  return row ?? null;
}

/** Tagihan belum ditagih pelanggan (untuk faktur bulanan & tampilan). */
export async function unbilledFor(tx: Tx, customerId: string, opts: { before?: BusinessDate } = {}) {
  const conds = [eq(unbilledCharges.customerId, customerId), eq(unbilledCharges.status, "unbilled"), isNull(unbilledCharges.invoiceId)];
  if (opts.before) conds.push(lt(unbilledCharges.serviceDate, opts.before));
  return tx.select().from(unbilledCharges).where(and(...conds)).orderBy(unbilledCharges.serviceDate);
}

