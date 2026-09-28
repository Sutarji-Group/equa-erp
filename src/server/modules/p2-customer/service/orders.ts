/**
 * P2 — pesanan mandiri (US-P2-02) & pemantauan status (US-P2-03 KP-1/KP-3).
 *
 * Pesanan aplikasi = pesanan M2 (8.4): dibuat lewat `m2.createOrder` (atas nama Sistem, SETELAH kepemilikan alamat
 * diperiksa) sehingga seluruh aturan Tahap 1 berlaku tanpa pengecualian — harga hanya dari master (BR-19, K23), batas
 * H+0 (BR-20), pemeriksaan dobel (US-M2-04: pesanan tetap masuk bertanda "kemungkinan dobel" + notifikasi Dispatcher,
 * 8.7), kontrol kredit (US-M2-05; penolakan singkat TANPA angka batas), kurang bayar (PTB-18). P2 menandai pesanan
 * `source = customer_app` + slot + akun pembuat, dan mencatat tenggat konfirmasi Dispatcher (PAR-75, jam layanan).
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { customerAddresses, customerAppOrders, customers, employees, orders, paymentIntents, tripRatings, trips, trucks } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, formatTanggalJam, isBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import { getDb, runInTx, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService, sod } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";
import * as m2 from "@/server/modules/m2-orders";

import { addServiceHours, appRules, assertAppEnabled, customerBusinessDate, firstName, loadCustomer, loadOwnOrder, recordCustomerAudit, requireLinked, sysCtx, type CustomerContext, type OrderRow } from "./common";
import { digitalPaymentAvailable } from "./gateway";
import { notifyCustomer } from "./messaging";
import { assertSlotAvailable, slotAvailability, slotDefs, slotLabel } from "./slots";

export type PaymentChoice = "cash" | "transfer" | "digital" | "credit";

export type PaymentOption = { method: PaymentChoice; label: string; available: boolean; reason: string | null };

/** Alasan singkat penolakan tempo (US-P2-02 KP-3: tanpa angka batas). */
export function shortCreditReason(reason: "cash_customer" | "on_hold" | "over_limit"): string {
  if (reason === "cash_customer") return "Tempo hanya untuk pelanggan berstatus Tempo. Pilih bayar tunai, transfer, atau bayar sekarang.";
  if (reason === "on_hold") return "Tempo sedang tidak tersedia karena ada tagihan lewat jatuh tempo. Lunasi di menu Tagihan atau pilih cara bayar lain.";
  return "Tempo tidak tersedia untuk pesanan ini karena melebihi batas tempo Anda. Pilih cara bayar lain atau hubungi kantor.";
}

async function paymentOptions(tx: Tx, customer: { id: string; creditStatus: string }, total: number): Promise<PaymentOption[]> {
  const opts: PaymentOption[] = [
    { method: "cash", label: label("customer_payment_choice", "cash"), available: true, reason: null },
    { method: "transfer", label: label("customer_payment_choice", "transfer"), available: true, reason: null },
    {
      method: "digital",
      label: label("customer_payment_choice", "digital"),
      available: digitalPaymentAvailable(),
      reason: digitalPaymentAvailable() ? null : "Pembayaran digital belum tersedia.",
    },
  ];
  let credit: PaymentOption;
  if (customer.creditStatus !== "credit" && customer.creditStatus !== "credit_migrated" && customer.creditStatus !== "on_hold") {
    credit = { method: "credit", label: label("customer_payment_choice", "credit"), available: false, reason: shortCreditReason("cash_customer") };
  } else {
    const check = await m2.evaluateCreditOrder(tx, customer.id, total);
    credit = { method: "credit", label: label("customer_payment_choice", "credit"), available: check.ok, reason: check.ok ? null : shortCreditReason(check.reason) };
  }
  opts.push(credit);
  return opts;
}

// =====================================================================================================================
// Ringkasan harga (langkah 4) & kirim pesanan
// =====================================================================================================================

const quoteSchema = z.object({
  addressId: z.uuid({ error: "Pilih alamat kirim." }),
  tankCount: z.coerce.number({ error: "Isi jumlah tangki." }).int().min(1, { error: "Jumlah tangki minimal 1." }).max(20, { error: "Maksimal 20 tangki per pesanan dari aplikasi; hubungi kantor untuk pesanan lebih besar." }),
  date: z.string().refine(isBusinessDate, { error: "Pilih tanggal kirim." }).optional(),
});

export type OrderQuote = {
  address: { id: string; label: string; addressText: string; notes: string | null };
  tankCount: number;
  date: BusinessDate | null;
  pricePerTank: number;
  total: number;
  priceSource: "zone" | "special";
  priceText: string;
  paymentOptions: PaymentOption[];
};

/** Ringkasan harga (US-P2-02 KP-1): harga per tangki dari zona alamat + BBM atau harga khusus; total sebelum kirim. */
export async function quoteOrder(cctx: CustomerContext, input: z.input<typeof quoteSchema>, opts: { tx?: Tx } = {}): Promise<OrderQuote> {
  const customerId = requireLinked(cctx);
  const data = parseInput(quoteSchema, input, { addressId: "Alamat", tankCount: "Jumlah tangki", date: "Tanggal" });
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    const [address] = await tx
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.id, data.addressId), eq(customerAddresses.customerId, customerId), eq(customerAddresses.isActive, true)))
      .limit(1);
    if (!address) throw new NotFoundError("Alamat tidak ditemukan.");
    const date = data.date ?? customerBusinessDate(cctx);
    const price = await m1.resolveTruckWaterPrice(tx, { customerId, addressId: address.id, date });
    if (price.tempPrice) {
      throw new DomainError("ADDRESS_OUT_OF_ZONE", "Alamat ini di luar jangkauan zona tarif sehingga harga belum dapat dihitung. Periksa titik peta atau hubungi kantor EQUA.");
    }
    const customer = await loadCustomer(tx, customerId);
    const total = price.unitPrice * data.tankCount;
    return {
      address: { id: address.id, label: address.label, addressText: address.addressText, notes: address.notes },
      tankCount: data.tankCount,
      date: data.date ?? null,
      pricePerTank: price.unitPrice,
      total,
      priceSource: price.source,
      priceText:
        price.source === "special"
          ? `Harga khusus Anda ${formatRupiah(price.unitPrice)} per tangki`
          : `Zona ${price.zoneCode ?? ""}: tarif ${formatRupiah(price.zoneTariff)} + komponen BBM ${formatRupiah(price.fuelComponent)} = ${formatRupiah(price.unitPrice)} per tangki`,
      paymentOptions: await paymentOptions(tx, customer, total),
    };
  });
}

const placeSchema = z.object({
  addressId: z.uuid({ error: "Pilih alamat kirim." }),
  tankCount: quoteSchema.shape.tankCount,
  date: z.string({ error: "Pilih tanggal kirim." }).refine(isBusinessDate, { error: "Pilih tanggal kirim." }),
  slot: z.string({ error: "Pilih slot pengiriman." }).min(1, { error: "Pilih slot pengiriman." }),
  paymentMethod: z.enum(["cash", "transfer", "digital", "credit"], { error: "Pilih cara bayar." }),
  notes: z.string().trim().max(300).nullable().optional(),
  /** Kunci idempoten formulir (ketukan ganda → pesanan yang sama). */
  clientRequestId: z.uuid().nullable().optional(),
});
export type PlaceOrderInput = z.input<typeof placeSchema>;

export type PlaceOrderResult = {
  orderId: string;
  number: string;
  total: number;
  pricePerTank: number;
  paymentMethod: PaymentChoice;
  confirmDueAt: Date | null;
  duplicate: boolean;
  /** true bila ketukan ganda (pesanan sudah dibuat sebelumnya). */
  replay: boolean;
};

/**
 * Kirim pesanan (US-P2-02 KP-1..KP-4, KP-6): pesanan M2 berstatus Baru bertanda "dari aplikasi", nomor PTB-14 tampil,
 * Dispatcher diberi tahu dengan tenggat PAR-75. Cara bayar digital = tunai sampai pembayaran berhasil (lalu "lunas di
 * muka", US-P2-04 KP-4).
 */
export async function placeOrder(cctx: CustomerContext, input: PlaceOrderInput, opts: { tx?: Tx } = {}): Promise<PlaceOrderResult> {
  const customerId = requireLinked(cctx);
  const data = parseInput(placeSchema, input, { addressId: "Alamat", tankCount: "Jumlah tangki", date: "Tanggal", slot: "Slot", paymentMethod: "Cara bayar", notes: "Catatan" });
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    if (data.clientRequestId) {
      const [prev] = await tx
        .select({ a: customerAppOrders, o: orders })
        .from(customerAppOrders)
        .innerJoin(orders, eq(orders.id, customerAppOrders.orderId))
        .where(eq(customerAppOrders.clientRequestId, data.clientRequestId))
        .limit(1);
      if (prev) {
        if (prev.a.customerAccountId !== cctx.accountId) throw new ConflictError("REQUEST_REUSED", "Permintaan tidak sah. Muat ulang halaman lalu coba lagi.");
        return { orderId: prev.o.id, number: prev.o.number, total: prev.o.totalAmount, pricePerTank: prev.o.pricePerTrip, paymentMethod: prev.a.paymentPreference as PaymentChoice, confirmDueAt: prev.a.confirmDueAt, duplicate: prev.o.possibleDuplicate, replay: true };
      }
    }
    const quote = await quoteOrder(cctx, { addressId: data.addressId, tankCount: data.tankCount, date: data.date }, { tx });
    const slots = await slotDefs(tx, data.date);
    const slot = slots.find((s) => s.key === data.slot);
    if (!slot) throw ValidationError.field("slot", "Slot tidak dikenal. Pilih pagi, siang, atau sore.");
    await assertSlotAvailable(tx, { tenantId: cctx.tenantId, now: cctx.now, date: data.date, slot: data.slot, tankCount: data.tankCount });
    const option = quote.paymentOptions.find((o) => o.method === data.paymentMethod)!;
    if (!option.available) throw new DomainError(data.paymentMethod === "credit" ? "CREDIT_UNAVAILABLE" : "PAYMENT_UNAVAILABLE", option.reason ?? "Cara bayar ini tidak tersedia.");

    const m2Method = data.paymentMethod === "digital" ? "cash" : data.paymentMethod;
    const res = await m2.createOrder(
      sysCtx(cctx.tenantId, cctx.now),
      {
        customerId,
        addressId: data.addressId,
        tankCount: data.tankCount,
        requestedDate: data.date,
        requestedTime: slot.start,
        paymentMethod: m2Method,
        notes: data.notes ? `Dari aplikasi pelanggan: ${data.notes}` : "Dari aplikasi pelanggan",
        duplicateDecision: "additional",
        duplicateReason: "Pesanan dari aplikasi pelanggan — periksa dobel dengan pesanan telepon (8.7)",
      },
      { tx },
    );
    if (res.status === "credit_blocked") throw new DomainError("CREDIT_UNAVAILABLE", shortCreditReason(res.check.reason));
    if (res.status !== "created") throw new DomainError("ORDER_NOT_CREATED", "Pesanan tidak dapat dibuat. Coba lagi atau hubungi kantor EQUA.");
    const order = res.order;
    // Penanda "dari aplikasi" (kolom Tahap 2 di tabel M2) + slot & akun pembuat (US-P2-02 KP-4, US-M10-05 KP-1).
    await tx.update(orders).set({ source: "customer_app", slot: data.slot as EnumValue<"delivery_slot">, createdByCustomerAccountId: cctx.accountId, updatedAt: cctx.now }).where(eq(orders.id, order.id));

    const date = customerBusinessDate(cctx);
    const rules75 = await params.get(tx, "PAR-75", date);
    const window = await params.get(tx, "PAR-07", date);
    const confirmDueAt = addServiceHours(cctx.now, rules75.order_confirm_hours, window, rules75.service_hours_only);
    await tx.insert(customerAppOrders).values({
      tenantId: cctx.tenantId,
      orderId: order.id,
      customerAccountId: cctx.accountId,
      customerId,
      slot: data.slot,
      paymentPreference: data.paymentMethod,
      clientRequestId: data.clientRequestId ?? null,
      confirmDueAt,
      createdAt: cctx.now,
      updatedAt: cctx.now,
    });
    await recordCustomerAudit(tx, cctx, {
      objectType: "order",
      objectId: order.id,
      action: "create",
      after: { number: order.number, source: "customer_app", date: data.date, slot: data.slot, tankCount: data.tankCount, pricePerTrip: order.pricePerTrip, total: order.totalAmount, paymentPreference: data.paymentMethod, possibleDuplicate: order.possibleDuplicate },
      rule: "US-P2-02 KP-1/KP-4",
    });
    const customer = await loadCustomer(tx, customerId);
    await notify(tx, {
      event: "customer_app.order_submitted",
      tenantId: cctx.tenantId,
      title: `Pesanan aplikasi ${order.number}: ${customer.name}`,
      body: `${data.tankCount} tangki, ${formatTanggal(data.date)} ${slotLabel(slot)} — ${label("customer_payment_choice", data.paymentMethod)}. Konfirmasi atau tolak sebelum ${formatTanggalJam(confirmDueAt)}.${order.possibleDuplicate ? " Kemungkinan dobel dengan pesanan lain." : ""}`,
      objectType: "order",
      objectId: order.id,
      deadlineAt: confirmDueAt,
      link: "/keluhan/pesanan-aplikasi",
      now: cctx.now,
    });
    await notifyCustomer(tx, {
      tenantId: cctx.tenantId,
      customerId,
      accountId: cctx.accountId,
      kind: "order_submitted",
      title: `Pesanan ${order.number} diajukan`,
      body: `${data.tankCount} tangki untuk ${formatTanggal(data.date)} (${slotLabel(slot)}), total ${formatRupiah(order.totalAmount)}. Kantor EQUA akan mengonfirmasi.`,
      link: `/app/pesanan/${order.id}`,
      objectType: "order",
      objectId: order.id,
      dedupeKey: `order_submitted:${order.id}`,
      now: cctx.now,
    });
    return {
      orderId: order.id,
      number: order.number,
      total: order.totalAmount,
      pricePerTank: order.pricePerTrip,
      paymentMethod: data.paymentMethod,
      confirmDueAt,
      duplicate: order.possibleDuplicate,
      replay: false,
    };
  });
}

/** Pesan ulang satu ketukan (US-P2-05 KP-2): alamat, jumlah tangki & cara bayar pesanan rujukan, slot tersedia terdekat. */
export async function reorder(cctx: CustomerContext, input: { orderId: string; clientRequestId?: string | null }, opts: { tx?: Tx } = {}): Promise<PlaceOrderResult> {
  return runInTx(opts.tx, async (tx) => {
    const ref = await loadOwnOrder(tx, cctx, input.orderId);
    const [app] = await tx.select().from(customerAppOrders).where(eq(customerAppOrders.orderId, ref.id)).limit(1);
    const days = await slotAvailability(tx, { tenantId: cctx.tenantId, now: cctx.now, tankCount: ref.tankCount });
    const preferred = app?.slot ?? ref.slot ?? null;
    let pick: { date: string; slot: string } | null = null;
    for (const d of days) {
      const s = d.slots.find((x) => x.available && (!preferred || x.key === preferred)) ?? d.slots.find((x) => x.available);
      if (s) {
        pick = { date: d.date, slot: s.key };
        break;
      }
    }
    if (!pick) throw new DomainError("NO_SLOT", "Belum ada slot pengiriman yang tersedia. Coba lagi nanti atau telepon kantor.");
    const method: PaymentChoice = app?.paymentPreference === "digital" ? "cash" : ref.paymentMethod === "credit" || ref.paymentMethod === "transfer" ? ref.paymentMethod : "cash";
    return placeOrder(cctx, { addressId: ref.addressId, tankCount: ref.tankCount, date: pick.date, slot: pick.slot, paymentMethod: method, clientRequestId: input.clientRequestId ?? null }, { tx });
  });
}

/**
 * Batal sendiri (US-P2-02 KP-5, PAR-72 "sampai rit Berangkat"): hanya sebelum ada tangki yang Berangkat; alasan wajib
 * dan tercatat (KPI-06). Setelah Berangkat → hubungi Dispatcher.
 */
export async function cancelMyOrder(cctx: CustomerContext, orderId: string, input: { reason: string }, opts: { tx?: Tx } = {}): Promise<OrderRow> {
  requireLinked(cctx);
  const data = parseInput(z.object({ reason: z.string().trim().min(3, { error: "Tulis alasan pembatalan (minimal 3 huruf)." }).max(300) }), input, { reason: "Alasan" });
  return runInTx(opts.tx, async (tx) => {
    const order = await loadOwnOrder(tx, cctx, orderId, { forUpdate: true });
    const rule = (await params.get(tx, "PAR-72", customerBusinessDate(cctx))).rule;
    const tripRows = await tx.select().from(trips).where(eq(trips.orderId, order.id));
    if (order.status === "cancelled") throw new ConflictError("ORDER_CANCELLED", `Pesanan ${order.number} sudah dibatalkan.`);
    if (order.status === "completed") throw new ConflictError("ORDER_COMPLETED", `Pesanan ${order.number} sudah selesai.`);
    const started = rule === "until_trip_departed" && (order.status === "in_delivery" || tripRows.some((t) => t.departedAt || ["departed", "arrived", "completed"].includes(t.status)));
    if (started) throw new DomainError("CANCEL_AFTER_DEPARTED", "Truk sudah berangkat, pesanan tidak dapat dibatalkan dari aplikasi. Hubungi kantor EQUA.");
    const after = await m2.cancelOrder(sysCtx(cctx.tenantId, cctx.now), order.id, { reason: "customer_cancelled", note: `Dibatalkan pelanggan lewat aplikasi: ${data.reason}` }, { tx });
    await tx.update(orders).set({ cancelledByCustomerAccountId: cctx.accountId }).where(eq(orders.id, order.id));
    await tx.update(customerAppOrders).set({ cancelledByCustomerAt: cctx.now, cancelReason: data.reason, updatedAt: cctx.now }).where(eq(customerAppOrders.orderId, order.id));
    await tx
      .update(paymentIntents)
      .set({ status: "failed", updatedAt: cctx.now, lastNotification: { cancelledWithOrder: true } })
      .where(and(eq(paymentIntents.orderId, order.id), eq(paymentIntents.status, "pending")));
    await recordCustomerAudit(tx, cctx, { objectType: "order", objectId: order.id, action: "cancel", before: { status: order.status }, after: { status: "cancelled", by: "customer" }, reason: data.reason, rule: "US-P2-02 KP-5, PAR-72" });
    return after;
  });
}

// =====================================================================================================================
// Riwayat & rincian (US-P2-04 KP-1, US-P2-03 KP-1/KP-3)
// =====================================================================================================================

export type MyOrderRow = {
  id: string;
  number: string;
  requestedDate: string;
  slot: string | null;
  tankCount: number;
  total: number;
  status: EnumValue<"order_status">;
  statusLabel: string;
  fromApp: boolean;
  paymentLabel: string;
  createdAt: Date;
};

/** Riwayat pesanan pelanggan (semua asal: aplikasi, telepon, langganan) `history_months` bulan (bawaan 24). */
export async function listMyOrders(cctx: CustomerContext, filter: { status?: "active" | "done" | null } = {}, opts: { tx?: Tx } = {}): Promise<MyOrderRow[]> {
  const customerId = requireLinked(cctx);
  const tx = opts.tx ?? getDb();
  const date = customerBusinessDate(cctx);
  const rules = await appRules(tx, date, cctx.tenantId);
  const since = addDays(date, -Math.round(rules.history_months * 30.44));
  const conds: SQL[] = [eq(orders.customerId, customerId), gte(orders.requestedDate, since)];
  if (filter.status === "active") conds.push(inArray(orders.status, ["new", "awaiting_approval", "scheduled", "in_delivery"]));
  if (filter.status === "done") conds.push(inArray(orders.status, ["completed", "cancelled"]));
  const rows = await tx
    .select({ o: orders, pref: customerAppOrders.paymentPreference, prepaidAt: customerAppOrders.prepaidAt })
    .from(orders)
    .leftJoin(customerAppOrders, eq(customerAppOrders.orderId, orders.id))
    .where(and(...conds))
    .orderBy(desc(orders.requestedDate), desc(orders.createdAt))
    .limit(1000);
  return rows.map(({ o, pref, prepaidAt }) => ({
    id: o.id,
    number: o.number,
    requestedDate: o.requestedDate,
    slot: o.slot,
    tankCount: o.tankCount,
    total: o.totalAmount,
    status: o.status,
    statusLabel: label("customer_order_status", o.status),
    fromApp: o.source === "customer_app",
    paymentLabel: prepaidAt ? "Sudah dibayar (digital)" : pref ? label("customer_payment_choice", pref) : label("payment_method", o.paymentMethod),
    createdAt: o.createdAt,
  }));
}

export type TimelineStep = { key: string; title: string; at: Date | null; description: string | null; state: "done" | "current" | "pending" | "failed" };

export type DeliveryView = {
  tripId: string;
  sequence: number;
  status: EnumValue<"trip_status">;
  statusLabel: string;
  scheduledDate: string;
  truckPlate: string | null;
  driverFirstName: string | null;
  departedAt: Date | null;
  arrivedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  deliveredVolumeL: number | null;
  recipientName: string | null;
  failReason: string | null;
  /** US-P2-03 KP-2: peta hanya saat Berangkat menuju pelanggan ini. */
  trackingActive: boolean;
  rating: number | null;
  canRate: boolean;
};

export type MyOrderDetail = MyOrderRow & {
  pricePerTank: number;
  address: { label: string; addressText: string; notes: string | null };
  slotLabel: string | null;
  confirmedAt: Date | null;
  confirmDueAt: Date | null;
  rejectReason: string | null;
  cancelNote: string | null;
  canCancel: boolean;
  cancelBlockedReason: string | null;
  paymentPreference: PaymentChoice | null;
  prepaid: boolean;
  canPay: boolean;
  deliveries: DeliveryView[];
  timeline: TimelineStep[];
  officePhone: string;
};

/** Rincian pesanan + garis waktu status (US-P2-03 KP-1) dalam istilah pelanggan. */
export async function getMyOrder(cctx: CustomerContext, orderId: string, opts: { tx?: Tx } = {}): Promise<MyOrderDetail> {
  const tx = opts.tx ?? getDb();
  const order = await loadOwnOrder(tx, cctx, orderId);
  const [app] = await tx.select().from(customerAppOrders).where(eq(customerAppOrders.orderId, order.id)).limit(1);
  const [address] = await tx.select().from(customerAddresses).where(eq(customerAddresses.id, order.addressId)).limit(1);
  const tripRows = await tx
    .select({ t: trips, plate: trucks.plateNumber, driverName: employees.fullName })
    .from(trips)
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .leftJoin(employees, eq(employees.id, trips.driverEmployeeId))
    .where(and(eq(trips.orderId, order.id), or(isNull(trips.withdrawnAt), sql`${trips.departedAt} is not null`)!))
    .orderBy(asc(trips.sequenceInOrder));
  const ratings = tripRows.length ? await tx.select().from(tripRatings).where(inArray(tripRatings.tripId, tripRows.map((r) => r.t.id))) : [];
  const date = customerBusinessDate(cctx);
  const rules = await appRules(tx, date, cctx.tenantId);
  const slots = await slotDefs(tx, order.requestedDate);
  const slot = slots.find((s) => s.key === order.slot) ?? null;
  const deliveries: DeliveryView[] = tripRows.map(({ t, plate, driverName }) => {
    const rating = ratings.find((r) => r.tripId === t.id)?.rating ?? null;
    return {
      tripId: t.id,
      sequence: t.sequenceInOrder,
      status: t.status,
      statusLabel: label("customer_delivery_status", t.status),
      scheduledDate: t.scheduledDate,
      truckPlate: t.truckId && t.publishedAt ? plate : null,
      driverFirstName: t.truckId && t.publishedAt ? firstName(driverName) : null,
      departedAt: t.departedAt,
      arrivedAt: t.arrivedAt,
      completedAt: t.completedAt,
      failedAt: t.failedAt,
      deliveredVolumeL: t.deliveredVolumeL,
      recipientName: t.recipientName,
      failReason: t.failReason ? label("customer_fail_reason", t.failReason) : null,
      trackingActive: t.status === "departed",
      rating,
      canRate: t.status === "completed" && rating === null,
    };
  });
  const started = order.status === "in_delivery" || deliveries.some((d) => d.departedAt || d.status !== "assigned");
  const canCancel = !started && !["completed", "cancelled"].includes(order.status);
  const intents = await tx.select().from(paymentIntents).where(and(eq(paymentIntents.orderId, order.id), eq(paymentIntents.status, "succeeded"))).limit(1);
  const prepaid = !!app?.prepaidAt || intents.length > 0;
  const confirmedAt = app?.confirmedAt ?? order.scheduledAt ?? null;
  const detail: MyOrderDetail = {
    id: order.id,
    number: order.number,
    requestedDate: order.requestedDate,
    slot: order.slot,
    tankCount: order.tankCount,
    total: order.totalAmount,
    status: order.status,
    statusLabel: label("customer_order_status", order.status),
    fromApp: order.source === "customer_app",
    paymentLabel: prepaid ? "Sudah dibayar (digital)" : app ? label("customer_payment_choice", app.paymentPreference) : label("payment_method", order.paymentMethod),
    createdAt: order.createdAt,
    pricePerTank: order.pricePerTrip,
    address: { label: address?.label ?? "—", addressText: address?.addressText ?? "—", notes: address?.notes ?? null },
    slotLabel: slot ? slotLabel(slot) : null,
    confirmedAt,
    confirmDueAt: app?.confirmDueAt ?? null,
    rejectReason: app?.rejectReason ?? (order.cancelReason === "rejected_by_dispatcher" ? order.cancelNote : null),
    cancelNote: order.status === "cancelled" ? `${label("order_cancel_reason", order.cancelReason)}${order.cancelNote ? ` — ${order.cancelNote.replace(/^Dibatalkan pelanggan lewat aplikasi: /, "")}` : ""}` : null,
    canCancel,
    cancelBlockedReason: canCancel ? null : started ? "Truk sudah berangkat — pembatalan hanya lewat kantor EQUA." : null,
    paymentPreference: (app?.paymentPreference as PaymentChoice | undefined) ?? null,
    prepaid,
    canPay: !prepaid && !started && !["completed", "cancelled"].includes(order.status) && app?.paymentPreference === "digital",
    deliveries,
    timeline: [],
    officePhone: rules.office_phone,
  };
  detail.timeline = buildTimeline(order, detail);
  return detail;
}

function buildTimeline(order: OrderRow, d: MyOrderDetail): TimelineStep[] {
  const firstDeparted = d.deliveries.map((x) => x.departedAt).filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const firstArrived = d.deliveries.map((x) => x.arrivedAt).filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const allDone = d.deliveries.length > 0 && d.deliveries.every((x) => x.status === "completed" || x.status === "failed");
  const failed = d.deliveries.filter((x) => x.status === "failed");
  const completed = d.deliveries.filter((x) => x.status === "completed");
  const lastDone = completed.map((x) => x.completedAt).filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const trucksText = [...new Set(d.deliveries.map((x) => (x.truckPlate ? `${x.truckPlate}${x.driverFirstName ? ` (sopir ${x.driverFirstName})` : ""}` : null)).filter(Boolean))].join(", ");
  const steps: TimelineStep[] = [
    { key: "submitted", title: "Diajukan", at: order.createdAt, description: `Nomor pesanan ${order.number}`, state: "done" },
  ];
  if (order.status === "cancelled") {
    steps.push({ key: "cancelled", title: d.rejectReason ? "Ditolak kantor" : "Dibatalkan", at: order.cancelledAt, description: d.rejectReason ?? d.cancelNote, state: "failed" });
    return steps;
  }
  steps.push({
    key: "confirmed",
    title: "Dikonfirmasi",
    at: d.confirmedAt,
    description: d.confirmedAt ? [formatTanggal(order.requestedDate), d.slotLabel, trucksText ? `truk ${trucksText}` : null].filter(Boolean).join(" · ") : d.confirmDueAt ? `Menunggu konfirmasi kantor (paling lambat ${formatTanggalJam(d.confirmDueAt)})` : "Menunggu konfirmasi kantor",
    state: d.confirmedAt ? "done" : "current",
  });
  steps.push({ key: "departed", title: "Berangkat", at: firstDeparted, description: firstDeparted ? "Truk menuju alamat Anda" : null, state: firstDeparted ? "done" : d.confirmedAt ? "current" : "pending" });
  steps.push({ key: "arrived", title: "Tiba", at: firstArrived, description: null, state: firstArrived ? "done" : firstDeparted ? "current" : "pending" });
  if (allDone && failed.length && !completed.length) {
    steps.push({ key: "failed", title: "Gagal", at: failed[0]!.failedAt, description: failed.map((f) => f.failReason).filter(Boolean).join("; ") || null, state: "failed" });
  } else {
    const volume = completed.reduce((s, x) => s + (x.deliveredVolumeL ?? 0), 0);
    steps.push({
      key: "completed",
      title: "Selesai",
      at: allDone ? lastDone : null,
      description: completed.length
        ? `${volume.toLocaleString("id-ID")} L terkirim${completed[0]!.recipientName ? `, diterima ${completed.map((c) => c.recipientName).filter(Boolean).join(", ")}` : ""}${failed.length ? `; ${failed.length} tangki gagal (${failed.map((f) => f.failReason).join("; ")})` : ""}`
        : null,
      state: allDone ? "done" : firstArrived ? "current" : "pending",
    });
  }
  return steps;
}

// =====================================================================================================================
// Kantor: pesanan aplikasi (/keluhan/pesanan-aplikasi) — konfirmasi / tolak ≤ PAR-75
// =====================================================================================================================

export type AppOrderRow = {
  orderId: string;
  number: string;
  customerId: string;
  customerName: string;
  requestedDate: string;
  slot: string | null;
  tankCount: number;
  total: number;
  paymentPreference: string;
  prepaid: boolean;
  status: EnumValue<"order_status">;
  possibleDuplicate: boolean;
  createdAt: Date;
  confirmDueAt: Date | null;
  confirmedAt: Date | null;
  rejectedAt: Date | null;
  rejectReason: string | null;
  cancelledByCustomer: boolean;
  overdue: boolean;
};

/** Pesanan dari aplikasi (Dispatcher/Pemilik): `pending` = belum dikonfirmasi/ditolak & belum batal. */
export async function listAppOrders(ctx: ActorContext, filter: { view?: "pending" | "all"; from?: string | null; to?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<AppOrderRow[]> {
  await authorize(ctx, "p2.app_order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds: SQL[] = [eq(customerAppOrders.tenantId, ctx.tenantId)];
  if ((filter.view ?? "pending") === "pending") {
    conds.push(isNull(customerAppOrders.confirmedAt), isNull(customerAppOrders.rejectedAt), sql`${orders.status} <> 'cancelled'`);
  }
  if (filter.from && isBusinessDate(filter.from)) conds.push(gte(orders.requestedDate, filter.from));
  if (filter.to && isBusinessDate(filter.to)) conds.push(sql`${orders.requestedDate} <= ${filter.to}`);
  const rows = await tx
    .select({ a: customerAppOrders, o: orders, customerName: customers.name })
    .from(customerAppOrders)
    .innerJoin(orders, eq(orders.id, customerAppOrders.orderId))
    .innerJoin(customers, eq(customers.id, customerAppOrders.customerId))
    .where(and(...conds))
    .orderBy(asc(customerAppOrders.confirmDueAt), desc(customerAppOrders.createdAt))
    .limit(500);
  return rows.map(({ a, o, customerName }) => ({
    orderId: o.id,
    number: o.number,
    customerId: o.customerId,
    customerName,
    requestedDate: o.requestedDate,
    slot: o.slot,
    tankCount: o.tankCount,
    total: o.totalAmount,
    paymentPreference: a.paymentPreference,
    prepaid: !!a.prepaidAt,
    status: o.status,
    possibleDuplicate: o.possibleDuplicate,
    createdAt: a.createdAt,
    confirmDueAt: a.confirmDueAt,
    confirmedAt: a.confirmedAt,
    rejectedAt: a.rejectedAt,
    rejectReason: a.rejectReason,
    cancelledByCustomer: !!a.cancelledByCustomerAt,
    overdue: !a.confirmedAt && !a.rejectedAt && o.status !== "cancelled" && !!a.confirmDueAt && a.confirmDueAt < ctx.now,
  }));
}

async function loadAppOrder(tx: Tx, ctx: ActorContext, orderId: string) {
  const [row] = await tx
    .select({ a: customerAppOrders, o: orders })
    .from(customerAppOrders)
    .innerJoin(orders, eq(orders.id, customerAppOrders.orderId))
    .where(and(eq(customerAppOrders.orderId, orderId), eq(customerAppOrders.tenantId, ctx.tenantId)))
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundError("Pesanan aplikasi tidak ditemukan.");
  return row;
}

/** Kirim notifikasi "Dikonfirmasi" (in-app + push + WA; US-P2-02 KP-4, US-P2-03 KP-4). */
export async function notifyConfirmed(tx: Tx, input: { tenantId: string; order: OrderRow; now: Date }): Promise<void> {
  const { order } = input;
  const slots = await slotDefs(tx, order.requestedDate);
  const slot = slots.find((s) => s.key === order.slot);
  const when = `${formatTanggal(order.requestedDate)}${slot ? ` ${slotLabel(slot)}` : order.requestedTime ? ` sekitar pukul ${order.requestedTime.slice(0, 5).replace(":", ".")}` : ""}`;
  await notifyCustomer(tx, {
    tenantId: input.tenantId,
    customerId: order.customerId,
    kind: "order_confirmed",
    title: `Pesanan ${order.number} dikonfirmasi`,
    body: `${order.tankCount} tangki dijadwalkan ${when}. Total ${formatRupiah(order.totalAmount)}.`,
    link: `/app/pesanan/${order.id}`,
    objectType: "order",
    objectId: order.id,
    dedupeKey: `order_confirmed:${order.id}`,
    now: input.now,
    wa: {
      kind: "order_confirmation",
      text: `Pesanan EQUA ${order.number} dikonfirmasi: ${order.tankCount} tangki, ${when}, total ${formatRupiah(order.totalAmount)}.`,
      variables: { nomor_pesanan: order.number, jadwal: when, jumlah_tangki: order.tankCount, total: formatRupiah(order.totalAmount) },
    },
  });
}

/** Dispatcher mengonfirmasi pesanan aplikasi (US-P2-02 KP-4) → pelanggan diberi tahu. */
export async function confirmAppOrder(ctx: ActorContext, orderId: string, input: { note?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<AppOrderRow["orderId"]> {
  await authorize(ctx, "p2.app_order.confirm", { tx: opts.tx, objectType: "order", objectId: orderId });
  const note = (input.note ?? "").trim() || null;
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const { a, o } = await loadAppOrder(tx, ctx, orderId);
    if (o.status === "cancelled") throw new ConflictError("ORDER_CANCELLED", `Pesanan ${o.number} sudah dibatalkan.`);
    if (a.rejectedAt) throw new ConflictError("ORDER_REJECTED", `Pesanan ${o.number} sudah ditolak.`);
    if (a.confirmedAt) throw new ConflictError("ORDER_CONFIRMED", `Pesanan ${o.number} sudah dikonfirmasi.`);
    await tx.update(customerAppOrders).set({ confirmedAt: ctx.now, confirmedBy: ctx.userId, updatedAt: ctx.now }).where(eq(customerAppOrders.id, a.id));
    await auditRecord(tx, { ctx, objectType: "order", objectId: o.id, action: "confirm", after: { confirmedAt: ctx.now, late: !!a.confirmDueAt && a.confirmDueAt < ctx.now }, reason: note, rule: "US-P2-02 KP-4, PAR-75" });
    await notifyConfirmed(tx, { tenantId: ctx.tenantId, order: o, now: ctx.now });
    return o.id;
  });
}

/** Dispatcher menolak pesanan aplikasi beralasan (US-P2-02 KP-4) → pesanan M2 Dibatalkan "Ditolak Dispatcher". */
export async function rejectAppOrder(ctx: ActorContext, orderId: string, input: { reason: string }, opts: { tx?: Tx } = {}): Promise<string> {
  await authorize(ctx, "p2.app_order.confirm", { tx: opts.tx, objectType: "order", objectId: orderId });
  const reason = parseInput(z.string().trim().min(5, { error: "Alasan penolakan wajib diisi (minimal 5 karakter) — alasan tampil ke pelanggan." }).max(300), input.reason, {});
  return runService(ctx, opts, async (tx) => {
    const { a, o } = await loadAppOrder(tx, ctx, orderId);
    if (a.confirmedAt) throw new ConflictError("ORDER_CONFIRMED", `Pesanan ${o.number} sudah dikonfirmasi; batalkan lewat Pesanan bila perlu.`);
    await m2.cancelOrder(ctx, o.id, { reason: "rejected_by_dispatcher", note: reason }, { tx });
    await tx.update(customerAppOrders).set({ rejectedAt: ctx.now, rejectedBy: ctx.userId, rejectReason: reason, updatedAt: ctx.now }).where(eq(customerAppOrders.id, a.id));
    await auditRecord(tx, { ctx, objectType: "order", objectId: o.id, action: "reject", after: { rejectedAt: ctx.now }, reason, rule: "US-P2-02 KP-4" });
    return o.id;
  });
}

/** Pesanan aplikasi belum dikonfirmasi melewati tenggat PAR-75 → notifikasi sekali (job). */
export async function notifyOverdueConfirmations(tx: Tx, now: Date): Promise<number> {
  const rows = await tx
    .select({ a: customerAppOrders, o: orders, customerName: customers.name })
    .from(customerAppOrders)
    .innerJoin(orders, eq(orders.id, customerAppOrders.orderId))
    .innerJoin(customers, eq(customers.id, customerAppOrders.customerId))
    .where(and(isNull(customerAppOrders.confirmedAt), isNull(customerAppOrders.rejectedAt), isNull(customerAppOrders.overdueNotifiedAt), lt(customerAppOrders.confirmDueAt, now), sql`${orders.status} <> 'cancelled'`));
  for (const { a, o, customerName } of rows) {
    await tx.update(customerAppOrders).set({ overdueNotifiedAt: now, updatedAt: now }).where(eq(customerAppOrders.id, a.id));
    await notify(tx, {
      event: "customer_app.order_confirm_overdue",
      tenantId: a.tenantId,
      title: `Pesanan aplikasi ${o.number} belum dikonfirmasi`,
      body: `${customerName} menunggu konfirmasi sejak ${formatTanggalJam(a.createdAt)} (tenggat ${formatTanggalJam(a.confirmDueAt!)}).`,
      objectType: "order",
      objectId: o.id,
      link: "/keluhan/pesanan-aplikasi",
      now,
    });
  }
  return rows.length;
}
