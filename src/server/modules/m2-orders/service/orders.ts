/**
 * M2 — pesanan (US-M2-01, US-M2-02, US-M2-04, US-M2-05, US-M2-08, US-M2-09; BR-19, BR-20, BR-24, BR-38; PTB-01,
 * PTB-13, PTB-18).
 *
 * - Satu layar: `previewOrder` (harga otomatis, jam terima tetap, kontrol kredit, dobel) → `createOrder`. Harga hanya
 *   dari master (BR-19) — tidak ada masukan harga. n tangki → n rit bernomor `P-YY-NNNNNN/n`.
 * - H+0 setelah PAR-05 → wajib alasan (6.2c). Dobel (pelanggan + alamat + tanggal) → "Ini pesanan tambahan" (alasan)
 *   atau "Batalkan yang ini" (tercatat Dibatalkan alasan dobel, KPI-06).
 * - Tempo: status Tunai → tidak tersedia; Ditahan / eksposur > batas → ditolak dengan angka + "Ajukan persetujuan
 *   pemilik" (Menunggu persetujuan). Kurang bayar terbuka → "tagih kurang bayar"; kurang bayar kedua → jadwal perlu
 *   lunas/persetujuan.
 * - Tidak ada hapus: batal beralasan dari daftar; tidak dari kantor bila Dalam pengiriman. Setiap transisi berjejak.
 */
import "server-only";

import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  approvalRequests,
  customerAddresses,
  customers,
  dailySchedules,
  orderDateHistory,
  orders,
  outlets,
  products,
  scheduleChangeLogs,
  trips,
  trucks,
  waMessageLogs,
} from "@/db/schema";
import { label, type OrderStatus, type PaymentMethod } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, toWibParts, wibToUtc, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { query as auditQuery, record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { nextNumber, tripNumber } from "@/server/core/numbering";
import { authorize, runService, sod } from "@/server/core/rbac";
import { detectTruckPriceChange, resolveInternalTransferPrice, resolveTruckWaterPrice, zoneTableAt, type TruckWaterPrice } from "@/server/modules/m1-master";

import {
  cancelOrderSchema,
  changePaymentSchema,
  createOrderSchema,
  listOrdersSchema,
  reconfirmSchema,
  rescheduleOrderSchema,
  type CancelOrderInput,
  type ChangePaymentInput,
  type CreateOrderInput,
  type ListOrdersFilter,
  type ReconfirmInput,
  type RescheduleOrderInput,
} from "../schemas";
import {
  ACTIVE_ORDER_STATUSES,
  defaultRequestedDate,
  employeeNames,
  isTripOpen,
  isTripPublished,
  loadCustomerAddress,
  loadOrder,
  orderRules,
  orderTrips,
  userNames,
  type CustomerRow,
  type OrderRow,
  type TripRow,
} from "./common";
import { computeCreditExposure, evaluateCreditOrder, underpaymentStatus, type CreditCheck, type CreditExposure, type UnderpaymentStatus } from "./credit";
import { clearDuplicateFlags, findDuplicateOrders, reconfirmationNeededFor, recomputeOrderStatus, schedulingBlockers, type SchedulingBlocker } from "./lifecycle";
import { markScheduleChanged } from "./schedule-log";

const z_reason = z.string().trim().min(3, { error: "Alasan pengajuan wajib diisi (minimal 3 karakter)." }).max(500);

const LABELS = {
  customerId: "Pelanggan",
  addressId: "Alamat kirim",
  tankCount: "Jumlah tangki",
  requestedDate: "Tanggal diminta",
  requestedTime: "Jam diminta",
  paymentMethod: "Cara bayar",
  notes: "Catatan",
  reason: "Alasan",
  note: "Keterangan",
};

// =====================================================================================================================
// Harga & bawaan layar pesanan
// =====================================================================================================================

export type OrderPrice = {
  pricePerTrip: number;
  totalAmount: number;
  source: "zone" | "special" | "internal_transfer";
  provisional: boolean;
  zoneCode: string | null;
  tariffZoneId: string | null;
  zoneTariffId: string | null;
  fuelComponentId: string | null;
  specialPriceId: string | null;
  productId: string;
  /** Rincian untuk layar: tarif zona + BBM atau harga khusus. */
  breakdown: string;
};

async function internalTransferProductId(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.line, "truck_water"), eq(products.isInternalTransfer, true), eq(products.status, "active")))
    .orderBy(asc(products.sortOrder))
    .limit(1);
  if (!rows[0]) {
    throw new DomainError("NO_INTERNAL_PRODUCT", "Produk \"air truk — transfer internal\" belum ada atau nonaktif. Minta Admin Keuangan membuatnya di Data master > Produk.");
  }
  return rows[0].id;
}

/** Harga per rit dari master (BR-19): harga khusus / zona + BBM; pesanan internal = harga transfer internal (BR-33). */
export async function resolveOrderPrice(tx: Tx, customer: CustomerRow, addressId: string, date: BusinessDate, tankCount: number): Promise<OrderPrice> {
  if (customer.internalOutletId) {
    const p = await resolveInternalTransferPrice(tx, { depotOutletId: customer.internalOutletId, date });
    return {
      pricePerTrip: p.unitPrice,
      totalAmount: p.unitPrice * tankCount,
      source: "internal_transfer",
      provisional: false,
      zoneCode: p.zoneCode,
      tariffZoneId: p.zoneId,
      zoneTariffId: null,
      fuelComponentId: null,
      specialPriceId: null,
      productId: await internalTransferProductId(tx, customer.tenantId),
      breakdown: `Transfer internal: tarif zona ${p.zoneCode} ${formatRupiah(p.zoneTariff)} + BBM ${formatRupiah(p.fuelComponent)} (tanpa pembayaran)`,
    };
  }
  const p: TruckWaterPrice = await resolveTruckWaterPrice(tx, { customerId: customer.id, addressId, date });
  return priceFromTruckWater(p, tankCount);
}

function priceFromTruckWater(p: TruckWaterPrice, tankCount: number): OrderPrice {
  return {
    pricePerTrip: p.unitPrice,
    totalAmount: p.unitPrice * tankCount,
    source: p.source,
    provisional: p.tempPrice,
    zoneCode: p.zoneCode,
    tariffZoneId: p.zoneId,
    zoneTariffId: p.zoneTariffId,
    fuelComponentId: p.fuelComponentId,
    specialPriceId: p.specialPriceId ?? null,
    productId: p.productId,
    breakdown:
      p.source === "special"
        ? "Harga khusus pelanggan (disetujui pemilik)"
        : p.tempPrice
          ? `Harga sementara: alamat belum berzona — tarif zona tertinggi ${formatRupiah(p.zoneTariff)} + BBM ${formatRupiah(p.fuelComponent)}`
          : `Tarif zona ${p.zoneCode ?? ""} ${formatRupiah(p.zoneTariff)} + komponen BBM ${formatRupiah(p.fuelComponent)}`.replace("  ", " "),
  };
}

export type OrderFormDefaults = {
  today: BusinessDate;
  /** Jam WIB saat ini (HH:mm). */
  nowTime: string;
  sameDayCutoff: string;
  afterCutoff: boolean;
  defaultDate: BusinessDate;
};

/** Bawaan layar pesanan baru (US-M2-01 KP-1/KP-4, BR-20). */
export async function orderFormDefaults(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<OrderFormDefaults> {
  await authorize(ctx, "m2.order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const rules = await orderRules(tx, today);
  const d = defaultRequestedDate(ctx.now, rules.sameDayCutoff);
  return { today, nowTime: toWibParts(ctx.now).time, sameDayCutoff: rules.sameDayCutoff, afterCutoff: d.afterCutoff, defaultDate: d.date };
}

export type OrderFormOptions = {
  /** Tujuan pesanan internal pasokan depot (PTB-01): pelanggan internal tiap depot + alamatnya. */
  internalTargets: { outletId: string; outletCode: string; outletName: string; customerId: string; addressId: string }[];
  /** Zona tarif berlaku (untuk pelanggan baru tanpa koordinat). */
  zones: { id: string; code: string; name: string }[];
};

/** Pilihan layar pesanan baru. */
export async function orderFormOptions(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<OrderFormOptions> {
  await authorize(ctx, "m2.order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ outletId: outlets.id, outletCode: outlets.code, outletName: outlets.name, customerId: customers.id, addressId: customerAddresses.id })
    .from(customers)
    .innerJoin(outlets, eq(outlets.id, customers.internalOutletId))
    .innerJoin(customerAddresses, and(eq(customerAddresses.customerId, customers.id), eq(customerAddresses.isActive, true)))
    .where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.isActive, true), eq(outlets.isActive, true)))
    .orderBy(asc(outlets.code), asc(customerAddresses.createdAt));
  const seen = new Set<string>();
  const internalTargets = rows.filter((r) => (seen.has(r.customerId) ? false : (seen.add(r.customerId), true)));
  const zones = (await zoneTableAt(tx, ctx.tenantId, ctxBusinessDate(ctx))).map((z) => ({ id: z.zoneId, code: z.code, name: z.name }));
  return { internalTargets, zones };
}

export type DuplicateOrderView = {
  id: string;
  number: string;
  tankCount: number;
  status: OrderStatus;
  requestedDate: string;
  requestedTime: string | null;
  createdByName: string | null;
  createdAt: Date;
};

async function duplicateViews(tx: Tx, rows: OrderRow[]): Promise<DuplicateOrderView[]> {
  const names = await userNames(tx, rows.map((r) => r.createdBy));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    tankCount: r.tankCount,
    status: r.status,
    requestedDate: r.requestedDate,
    requestedTime: r.requestedTime,
    createdByName: r.createdBy ? (names.get(r.createdBy) ?? null) : "Sistem",
    createdAt: r.createdAt,
  }));
}

export type OrderPreview = {
  customer: { id: string; name: string; creditStatus: CustomerRow["creditStatus"]; isInternal: boolean; fixedReceiveTime: string | null; notes: string | null; isActive: boolean };
  requestedDate: BusinessDate;
  afterCutoff: boolean;
  sameDayCutoff: string;
  /** Jam terima tetap pelanggan (terisi otomatis bila jam diminta kosong). */
  defaultTime: string | null;
  price: OrderPrice | null;
  priceError: string | null;
  /** Kontrol kredit bila cara bayar tempo. */
  credit: CreditCheck | null;
  /** Tempo dapat dipilih (status Tempo/Tempo migrasi). */
  creditSelectable: boolean;
  creditNote: string;
  underpayment: UnderpaymentStatus;
  duplicates: DuplicateOrderView[];
  reconfirmationRequired: boolean;
};

/**
 * Pratinjau layar pesanan (US-M2-01 KP-1/KP-2, US-M2-04, US-M2-05): harga otomatis dari zona alamat + BBM atau harga
 * khusus, total = harga × tangki, jam terima tetap, ketersediaan tempo, pesanan dobel. Tidak menulis apa pun.
 */
export async function previewOrder(ctx: ActorContext, input: Partial<CreateOrderInput> & { customerId: string; addressId: string }, opts: { tx?: Tx } = {}): Promise<OrderPreview> {
  await authorize(ctx, "m2.order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const { customer, address } = await loadCustomerAddress(tx, ctx, input.customerId, input.addressId);
  const today = ctxBusinessDate(ctx);
  const rules = await orderRules(tx, today);
  const d = defaultRequestedDate(ctx.now, rules.sameDayCutoff);
  const requestedDate = input.requestedDate ?? d.date;
  const tankCount = Math.max(1, Number(input.tankCount ?? 1) || 1);
  let price: OrderPrice | null = null;
  let priceError: string | null = null;
  try {
    price = await resolveOrderPrice(tx, customer, address.id, requestedDate, tankCount);
  } catch (error) {
    priceError = error instanceof Error ? error.message : String(error);
  }
  const isInternal = !!customer.internalOutletId;
  const creditSelectable = !isInternal && (customer.creditStatus === "credit" || customer.creditStatus === "credit_migrated" || customer.creditStatus === "on_hold");
  const credit = input.paymentMethod === "credit" && price && !isInternal ? await evaluateCreditOrder(tx, customer.id, price.totalAmount) : null;
  const dups = await findDuplicateOrders(tx, { customerId: customer.id, addressId: address.id, requestedDate });
  return {
    customer: {
      id: customer.id,
      name: customer.name,
      creditStatus: customer.creditStatus,
      isInternal,
      fixedReceiveTime: customer.fixedReceiveTime?.slice(0, 5) ?? null,
      notes: customer.notes,
      isActive: customer.isActive,
    },
    requestedDate,
    afterCutoff: requestedDate === today && toWibParts(ctx.now).time >= rules.sameDayCutoff,
    sameDayCutoff: rules.sameDayCutoff,
    defaultTime: customer.fixedReceiveTime?.slice(0, 5) ?? null,
    price,
    priceError,
    credit,
    creditSelectable,
    creditNote: isInternal
      ? "Pesanan internal pasokan depot: cara bayar Internal, tanpa pencatatan uang (PTB-01)."
      : customer.creditStatus === "cash"
        ? "Tempo tidak tersedia: status kredit pelanggan Tunai."
        : customer.creditStatus === "on_hold"
          ? "Pelanggan Ditahan (piutang lewat tempo): tempo hanya dengan persetujuan pemilik."
          : `Status ${label("credit_status", customer.creditStatus)}, batas ${formatRupiah(customer.creditLimit)}.`,
    underpayment: await underpaymentStatus(tx, customer.id),
    duplicates: await duplicateViews(tx, dups),
    reconfirmationRequired: !isInternal && (await reconfirmationNeededFor(tx, customer.id, today)),
  };
}

// =====================================================================================================================
// Buat pesanan
// =====================================================================================================================

export type CreateOrderResult =
  | { status: "created"; order: OrderRow; trips: TripRow[]; warnings: string[]; approvalNumbers: string[] }
  | { status: "duplicate"; existing: DuplicateOrderView[] }
  | { status: "credit_blocked"; check: Extract<CreditCheck, { ok: false }> }
  | { status: "cancelled_duplicate"; order: OrderRow };

/** Tenggat persetujuan "sebelum jadwal terbit" (6.2a): awal jam layanan tanggal kirim; bila sudah lewat, akhir jam layanan; bila lewat juga, awal jam layanan esok. */
export function approvalDeadline(now: Date, requestedDate: BusinessDate, serviceStart: string, serviceEnd: string): Date {
  const start = wibToUtc(requestedDate, serviceStart);
  if (start > now) return start;
  const end = wibToUtc(requestedDate, serviceEnd);
  if (end > now) return end;
  return wibToUtc(addDays(toWibParts(now).businessDate, 1), serviceStart);
}

type InsertOrderData = {
  customer: CustomerRow;
  addressId: string;
  requestedDate: BusinessDate;
  requestedTime: string | null;
  tankCount: number;
  paymentMethod: PaymentMethod;
  price: OrderPrice;
  notes: string | null;
  source: OrderRow["source"];
  /** Slot pengiriman (aplikasi pelanggan, B-64). */
  slot?: OrderRow["slot"];
  recurringOrderId?: string | null;
  status?: OrderStatus;
  afterCutoffForced?: boolean;
  afterCutoffReason?: string | null;
  possibleDuplicate?: boolean;
  duplicateOfOrderId?: string | null;
  duplicateReason?: string | null;
  collectUnderpayment?: boolean;
  reconfirmationRequired?: boolean;
  cancel?: { reason: "duplicate"; note: string } | null;
  createTrips?: boolean;
};

/** Sisipkan pesanan + n rit (dipakai layar kantor & job langganan). Tanpa otorisasi — pemanggil sudah memeriksa. */
export async function insertOrder(tx: Tx, ctx: ActorContext, data: InsertOrderData): Promise<{ order: OrderRow; trips: TripRow[] }> {
  const rules = await orderRules(tx, data.requestedDate);
  const number = await nextNumber(tx, "order", ctxBusinessDate(ctx), { tenantId: data.customer.tenantId });
  const isInternal = !!data.customer.internalOutletId;
  const cancelled = !!data.cancel;
  const [order] = await tx
    .insert(orders)
    .values({
      tenantId: data.customer.tenantId,
      number,
      customerId: data.customer.id,
      addressId: data.addressId,
      productId: data.price.productId,
      status: cancelled ? "cancelled" : (data.status ?? "new"),
      source: data.source,
      slot: data.slot ?? null,
      tankCount: data.tankCount,
      requestedDate: data.requestedDate,
      requestedTime: data.requestedTime,
      paymentMethod: data.paymentMethod,
      pricePerTrip: data.price.pricePerTrip,
      totalAmount: data.price.pricePerTrip * data.tankCount,
      priceSource: data.price.source,
      tariffZoneId: data.price.tariffZoneId,
      zoneTariffId: data.price.zoneTariffId,
      fuelComponentId: data.price.fuelComponentId,
      specialPriceId: data.price.specialPriceId,
      priceIsProvisional: data.price.provisional,
      notes: data.notes,
      isInternal,
      internalOutletId: data.customer.internalOutletId,
      recurringOrderId: data.recurringOrderId ?? null,
      afterCutoffForced: data.afterCutoffForced ?? false,
      afterCutoffReason: data.afterCutoffReason ?? null,
      possibleDuplicate: cancelled ? false : (data.possibleDuplicate ?? false),
      duplicateOfOrderId: data.duplicateOfOrderId ?? null,
      duplicateReason: data.duplicateReason ?? null,
      collectUnderpayment: data.collectUnderpayment ?? false,
      reconfirmationRequired: data.reconfirmationRequired ?? false,
      cancelReason: cancelled ? data.cancel!.reason : null,
      cancelNote: cancelled ? data.cancel!.note : null,
      cancelledAt: cancelled ? ctx.now : null,
      cancelledBy: cancelled ? ctx.userId : null,
      createdBy: ctx.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  const tripRows: TripRow[] = [];
  if (!cancelled && data.createTrips !== false) {
    const values = Array.from({ length: data.tankCount }, (_, i) => ({
      tenantId: order!.tenantId,
      orderId: order!.id,
      number: tripNumber(number, i + 1),
      sequenceInOrder: i + 1,
      status: "assigned" as const,
      customerId: data.customer.id,
      addressId: data.addressId,
      isInternal,
      destinationOutletId: data.customer.internalOutletId,
      scheduledDate: data.requestedDate,
      price: data.price.pricePerTrip,
      paymentMethod: data.paymentMethod,
      plannedVolumeL: rules.standardVolumeL,
      createdBy: ctx.userId,
    }));
    tripRows.push(...(await tx.insert(trips).values(values).returning()));
  }
  await auditRecord(tx, {
    ctx,
    objectType: "order",
    objectId: order!.id,
    action: "create",
    after: { ...order, trips: tripRows.map((t) => t.number) },
    reason: cancelled ? data.cancel!.note : (data.afterCutoffReason ?? data.duplicateReason ?? null),
    rule: data.afterCutoffForced ? "BR-20 6.2c" : data.possibleDuplicate ? "FR-M2-04 6.2c" : cancelled ? "FR-M2-04" : null,
  });
  await emit(
    tx,
    "order.created",
    {
      orderId: order!.id,
      number,
      customerId: data.customer.id,
      addressId: data.addressId,
      requestedDate: data.requestedDate,
      tankCount: data.tankCount,
      pricePerTrip: order!.pricePerTrip,
      totalAmount: order!.totalAmount,
      paymentMethod: data.paymentMethod,
      source: data.source,
      isInternal,
      internalOutletId: data.customer.internalOutletId,
      recurringOrderId: data.recurringOrderId ?? null,
      status: order!.status,
      slot: order!.slot ?? null,
    },
    { ctx, objectType: "order", objectId: order!.id },
  );
  return { order: order!, trips: tripRows };
}

/**
 * Buat pesanan (US-M2-01). Mengembalikan `duplicate` / `credit_blocked` TANPA menyimpan agar layar menampilkan
 * pilihan; panggil ulang dengan `duplicateDecision` / `creditApprovalReason` / cara bayar lain.
 */
export async function createOrder(ctx: ActorContext, input: CreateOrderInput, opts: { tx?: Tx } = {}): Promise<CreateOrderResult> {
  await authorize(ctx, "m2.order.create", { tx: opts.tx });
  const data = parseInput(createOrderSchema, input, LABELS);
  // B-64: asal aplikasi pelanggan / portal mitra hanya dari pelaku sistem (layanan P2/P3), bukan dari layar kantor.
  if (data.source !== "office" && ctx.userId !== null) {
    throw ValidationError.field("source", "Pesanan dari kantor selalu berasal \"Kantor\". Pesanan aplikasi pelanggan/portal mitra dibuat oleh sistem.");
  }
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const { customer, address } = await loadCustomerAddress(tx, ctx, data.customerId, data.addressId);
    if (!customer.isActive || customer.anonymizedAt) {
      throw new DomainError("CUSTOMER_INACTIVE", `Pelanggan ${customer.name} nonaktif. Aktifkan dulu di Data master > Pelanggan.`);
    }
    if (!address.isActive) throw new DomainError("ADDRESS_INACTIVE", "Alamat kirim ini nonaktif. Pilih alamat lain atau aktifkan di Data master.");
    const isInternal = !!customer.internalOutletId;
    const paymentMethod: PaymentMethod = isInternal ? "internal" : data.paymentMethod;
    if (!isInternal && paymentMethod === "internal") {
      throw ValidationError.field("paymentMethod", "Cara bayar Internal hanya untuk pesanan pasokan depot sendiri (PTB-01).");
    }

    // Tanggal diminta (BR-20).
    const today = ctxBusinessDate(ctx);
    const rules = await orderRules(tx, today);
    const d = defaultRequestedDate(ctx.now, rules.sameDayCutoff);
    const requestedDate = data.requestedDate ?? d.date;
    if (requestedDate < today) throw ValidationError.field("requestedDate", "Tanggal diminta tidak boleh sebelum hari ini.");
    const afterCutoff = requestedDate === today && toWibParts(ctx.now).time >= rules.sameDayCutoff;
    if (afterCutoff && !data.forceSameDayReason) {
      throw new DomainError(
        "AFTER_CUTOFF",
        `Sudah lewat pukul ${rules.sameDayCutoff.replace(":", ".")} (BR-20): sistem mengusulkan kirim besok (${formatTanggal(addDays(today, 1))}). Untuk tetap kirim hari ini, isi alasan paksa H+0.`,
        { suggestedDate: addDays(today, 1) },
      );
    }
    if (afterCutoff && data.forceSameDayReason!.length < 3) {
      throw ValidationError.field("forceSameDayReason", "Alasan paksa kirim hari ini wajib diisi (minimal 3 karakter).");
    }

    // Harga dari master (BR-19) + jam terima tetap.
    const price = await resolveOrderPrice(tx, customer, address.id, requestedDate, data.tankCount);
    const requestedTime = data.requestedTime ?? customer.fixedReceiveTime?.slice(0, 5) ?? null;

    // Dobel (FR-M2-04).
    const dups = await findDuplicateOrders(tx, { customerId: customer.id, addressId: address.id, requestedDate });
    if (dups.length && !data.duplicateDecision) return { status: "duplicate", existing: await duplicateViews(tx, dups) };
    if (dups.length && data.duplicateDecision === "cancel") {
      const created = await insertOrder(tx, ctx, {
        customer,
        addressId: address.id,
        requestedDate,
        requestedTime,
        tankCount: data.tankCount,
        paymentMethod,
        price,
        notes: data.notes,
        source: data.source,
        slot: data.slot ?? null,
        duplicateOfOrderId: dups[0]!.id,
        cancel: { reason: "duplicate", note: `Dibatalkan saat input: dobel dengan ${dups.map((x) => x.number).join(", ")}` },
      });
      return { status: "cancelled_duplicate", order: created.order };
    }
    if (dups.length && (!data.duplicateReason || data.duplicateReason.length < 3)) {
      throw ValidationError.field("duplicateReason", "Alasan \"Ini pesanan tambahan\" wajib diisi (minimal 3 karakter).");
    }

    // Kontrol kredit (US-M2-05).
    let creditBlocked: Extract<CreditCheck, { ok: false }> | null = null;
    if (paymentMethod === "credit") {
      const check = await evaluateCreditOrder(tx, customer.id, price.totalAmount);
      if (!check.ok) {
        if (!check.canRequestApproval || !data.creditApprovalReason) return { status: "credit_blocked", check };
        creditBlocked = check;
      }
    }
    const up = isInternal ? null : await underpaymentStatus(tx, customer.id);
    if (data.underpaymentApprovalReason && !up?.secondUnpaid) {
      throw new DomainError("UNDERPAYMENT_APPROVAL_NOT_NEEDED", "Persetujuan kurang bayar kedua tidak diperlukan: pelanggan tidak punya dua faktur kurang bayar terbuka.");
    }
    const reconfirm = !isInternal && (await reconfirmationNeededFor(tx, customer.id, today));

    const { order, trips: tripRows } = await insertOrder(tx, ctx, {
      customer,
      addressId: address.id,
      requestedDate,
      requestedTime,
      tankCount: data.tankCount,
      paymentMethod,
      price,
      notes: data.notes,
      source: data.source,
      slot: data.slot ?? null,
      afterCutoffForced: afterCutoff,
      afterCutoffReason: afterCutoff ? data.forceSameDayReason : null,
      possibleDuplicate: dups.length > 0,
      duplicateOfOrderId: dups[0]?.id ?? null,
      duplicateReason: dups.length ? data.duplicateReason : null,
      collectUnderpayment: up?.collect ?? false,
      reconfirmationRequired: reconfirm,
    });

    const warnings: string[] = [];
    const approvalNumbers: string[] = [];
    if (price.provisional) warnings.push("Harga sementara: alamat belum berzona. Pesanan tidak dapat diterbitkan sampai zona ditetapkan dan harga diperbarui.");
    if (up?.collect) warnings.push(`Tagih kurang bayar: pelanggan punya ${up.openCount} faktur kurang bayar terbuka (${formatRupiah(up.openAmount)}); sopir menagih sisanya saat pengiriman.`);
    if (reconfirm) warnings.push("Pelanggan mengalami rit gagal berturut (BR-24): centang \"sudah dikonfirmasi ulang\" sebelum dijadwalkan.");
    if (dups.length) {
      await notify(tx, {
        event: "order.duplicate",
        tenantId: order.tenantId,
        excludeUserIds: ctx.userId ? [ctx.userId] : [],
        title: `Kemungkinan pesanan dobel: ${order.number}`,
        body: `${customer.name}, ${formatTanggal(requestedDate)} — sama dengan ${dups.map((x) => x.number).join(", ")}. Alasan tambahan: ${data.duplicateReason}`,
        objectType: "order",
        objectId: order.id,
        link: `/pesanan/${order.id}`,
        now: ctx.now,
      });
    }
    if (creditBlocked) {
      const approval = await submitCreditApproval(tx, ctx, order, creditBlocked, data.creditApprovalReason!, rules);
      approvalNumbers.push(approval.number);
    }
    if (up?.secondUnpaid && data.underpaymentApprovalReason) {
      const approval = await submitUnderpaymentApproval(tx, ctx, order, up, data.underpaymentApprovalReason, rules);
      approvalNumbers.push(approval.number);
    } else if (up?.secondUnpaid) {
      warnings.push("Kurang bayar kedua belum lunas (PTB-18): pesanan hanya dapat dijadwalkan setelah lunas atau disetujui pemilik.");
    }
    const final = await loadOrder(tx, null, order.id);
    return { status: "created", order: final, trips: tripRows, warnings, approvalNumbers };
  });
}

async function setAwaiting(tx: Tx, ctx: ActorContext, order: OrderRow, patch: Partial<typeof orders.$inferInsert>, reason: string, rule: string) {
  await tx
    .update(orders)
    .set({ ...patch, status: "awaiting_approval", updatedAt: ctx.now })
    .where(eq(orders.id, order.id));
  if (order.status !== "awaiting_approval") {
    await auditRecord(tx, { ctx, objectType: "order", objectId: order.id, action: "status", before: { status: order.status }, after: { status: "awaiting_approval" }, reason, rule });
    await emitStatusChanged(tx, ctx, order, "awaiting_approval", reason);
  }
}

async function submitCreditApproval(
  tx: Tx,
  ctx: ActorContext,
  order: OrderRow,
  check: Extract<CreditCheck, { ok: false }>,
  reason: string,
  rules: Awaited<ReturnType<typeof orderRules>>,
) {
  const exposure = check.exposure;
  const approval = await approvals.submit(
    ctx,
    {
      type: "credit_order",
      objectType: "order",
      objectId: order.id,
      amount: exposure.extraAmount,
      reason: `${reason} — ${order.number}: ${check.reason === "on_hold" ? "pelanggan Ditahan" : `eksposur ${formatRupiah(exposure.exposure)} > batas ${formatRupiah(exposure.creditLimit)}`}`,
      payload: {
        orderNumber: order.number,
        customerId: order.customerId,
        blockReason: check.reason,
        exposure: exposure.exposure,
        creditLimit: exposure.creditLimit,
        openInvoices: exposure.openInvoices,
        unbilledCharges: exposure.unbilledCharges,
        openCreditOrders: exposure.openCreditOrders,
        orderAmount: exposure.extraAmount,
        link: `/pesanan/${order.id}`,
      },
      deadlineAt: approvalDeadline(ctx.now, order.requestedDate, rules.serviceStart, rules.serviceEnd),
    },
    { tx },
  );
  await setAwaiting(tx, ctx, order, { creditApprovalRequestId: approval.id }, `Tempo di luar kontrol kredit diajukan ke pemilik (${approval.number})`, "US-M2-05 KP-3");
  return approval;
}

async function submitUnderpaymentApproval(tx: Tx, ctx: ActorContext, order: OrderRow, up: UnderpaymentStatus, reason: string, rules: Awaited<ReturnType<typeof orderRules>>) {
  const approval = await approvals.submit(
    ctx,
    {
      type: "second_underpayment_order",
      objectType: "order",
      objectId: order.id,
      amount: up.openAmount,
      reason: `${reason} — ${order.number}: ${up.openCount} faktur kurang bayar belum lunas (${formatRupiah(up.openAmount)})`,
      payload: { orderNumber: order.number, customerId: order.customerId, openUnderpayments: up.openCount, openAmount: up.openAmount, link: `/pesanan/${order.id}` },
      deadlineAt: approvalDeadline(ctx.now, order.requestedDate, rules.serviceStart, rules.serviceEnd),
    },
    { tx },
  );
  await setAwaiting(tx, ctx, order, { underpaymentApprovalRequestId: approval.id }, `Pesanan saat kurang bayar kedua diajukan ke pemilik (${approval.number})`, "PTB-18");
  return approval;
}

async function emitStatusChanged(tx: Tx, ctx: ActorContext, order: Pick<OrderRow, "id" | "number" | "customerId" | "status">, to: OrderStatus, reason: string | null, cancelReason: OrderRow["cancelReason"] = null) {
  await emit(
    tx,
    "order.status_changed",
    { orderId: order.id, number: order.number, customerId: order.customerId, from: order.status, to, reason, cancelReason },
    { ctx, objectType: "order", objectId: order.id },
  );
}

// =====================================================================================================================
// Persetujuan untuk pesanan yang sudah ada
// =====================================================================================================================

/** Ajukan persetujuan pemilik untuk pesanan tempo yang ditolak kontrol kredit (US-M2-05 KP-1..KP-3). */
export async function requestCreditApproval(ctx: ActorContext, orderId: string, input: { reason: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m2.order.request_approval", { tx: opts.tx, objectType: "order", objectId: orderId });
  const reason = parseInput(z_reason, input.reason ?? "");
  return runService(ctx, opts, async (tx) => {
    const order = await loadOrder(tx, ctx, orderId, { forUpdate: true });
    if (order.paymentMethod !== "credit") throw new DomainError("NOT_CREDIT", "Persetujuan tempo hanya untuk pesanan bercara bayar tempo.");
    if (order.status !== "new") throw new ConflictError("ORDER_NOT_NEW", `Pesanan ${order.number} berstatus ${label("order_status", order.status)}; persetujuan tidak dapat diajukan.`);
    const openTotal = (await orderTrips(tx, order.id)).filter(isTripOpen).reduce((s, t) => s + t.price, 0);
    const check = await evaluateCreditOrder(tx, order.customerId, openTotal, { excludeOrderId: order.id });
    if (check.ok) throw new DomainError("CREDIT_OK", "Eksposur dalam batas kredit — pesanan tempo ini tidak memerlukan persetujuan.");
    if (!check.canRequestApproval) throw new DomainError(check.reason.toUpperCase(), check.message);
    const rules = await orderRules(tx, ctxBusinessDate(ctx));
    return submitCreditApproval(tx, ctx, order, check, reason, rules);
  });
}

/** Ajukan persetujuan pemilik untuk pesanan saat kurang bayar kedua belum lunas (PTB-18, US-M2-05 KP-6). */
export async function requestUnderpaymentApproval(ctx: ActorContext, orderId: string, input: { reason: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m2.order.request_approval", { tx: opts.tx, objectType: "order", objectId: orderId });
  const reason = parseInput(z_reason, input.reason ?? "");
  return runService(ctx, opts, async (tx) => {
    const order = await loadOrder(tx, ctx, orderId, { forUpdate: true });
    if (order.status !== "new") throw new ConflictError("ORDER_NOT_NEW", `Pesanan ${order.number} berstatus ${label("order_status", order.status)}; persetujuan tidak dapat diajukan.`);
    const up = await underpaymentStatus(tx, order.customerId);
    if (!up.secondUnpaid) throw new DomainError("UNDERPAYMENT_APPROVAL_NOT_NEEDED", "Persetujuan tidak diperlukan: pelanggan tidak punya dua faktur kurang bayar terbuka.");
    const rules = await orderRules(tx, ctxBusinessDate(ctx));
    return submitUnderpaymentApproval(tx, ctx, order, up, reason, rules);
  });
}


// =====================================================================================================================
// Batal, jadwal ulang, cara bayar, catatan, konfirmasi ulang, harga
// =====================================================================================================================

/** Tarik rit terbuka dari papan (pembatalan/jadwal ulang). `permanent` = ditarik permanen (pesanan batal). */
export async function withdrawOpenTrips(tx: Tx, ctx: ActorContext, order: OrderRow, opts: { permanent: boolean; reason: string; newDate?: BusinessDate }): Promise<TripRow[]> {
  const list = (await orderTrips(tx, order.id)).filter(isTripOpen);
  const out: TripRow[] = [];
  for (const t of list) {
    const wasPublished = isTripPublished(t);
    const patch: Partial<typeof trips.$inferInsert> = { updatedAt: ctx.now };
    if (opts.permanent) patch.withdrawnAt = ctx.now;
    else {
      patch.truckId = null;
      patch.scheduleId = null;
      patch.routeOrder = null;
      patch.publishedAt = null;
      if (opts.newDate) patch.scheduledDate = opts.newDate;
    }
    const [after] = await tx.update(trips).set(patch).where(eq(trips.id, t.id)).returning();
    out.push(after!);
    if (t.truckId && t.scheduleId) {
      await tx.insert(scheduleChangeLogs).values({
        tenantId: t.tenantId,
        scheduleId: t.scheduleId,
        tripId: t.id,
        changeType: "withdrawn",
        before: { truckId: t.truckId, routeOrder: t.routeOrder, scheduledDate: t.scheduledDate },
        after: { truckId: opts.permanent ? t.truckId : null, withdrawn: true },
        reason: opts.reason,
        afterPublish: wasPublished,
        changedBy: ctx.userId,
        changedAt: ctx.now,
      });
      await markScheduleChanged(tx, ctx, t.scheduleId);
    }
    await auditRecord(tx, {
      ctx,
      objectType: "trip",
      objectId: t.id,
      action: opts.permanent ? "withdraw" : "unassign",
      before: { truckId: t.truckId, routeOrder: t.routeOrder, scheduledDate: t.scheduledDate, publishedAt: t.publishedAt },
      after: { truckId: after!.truckId, withdrawnAt: after!.withdrawnAt, scheduledDate: after!.scheduledDate },
      reason: opts.reason,
    });
  }
  return out;
}

async function cancelOpenApprovals(tx: Tx, ctx: ActorContext, order: OrderRow, reason: string, opts: { only?: "credit" } = {}) {
  const ids = (opts.only === "credit" ? [order.creditApprovalRequestId] : [order.creditApprovalRequestId, order.underpaymentApprovalRequestId]).filter((x): x is string => !!x);
  if (!ids.length) return;
  const open = await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(and(inArray(approvalRequests.id, ids), eq(approvalRequests.status, "submitted")));
  for (const a of open) {
    await approvals.cancel(systemContext({ tenantId: order.tenantId, now: ctx.now }), a.id, reason, { tx });
  }
}

/** Batalkan pesanan dengan alasan dari daftar (US-M2-02 KP-3). Tidak dari kantor bila Dalam pengiriman. */
export async function cancelOrder(ctx: ActorContext, orderId: string, input: CancelOrderInput, opts: { tx?: Tx } = {}): Promise<OrderRow> {
  await authorize(ctx, "m2.order.cancel", { tx: opts.tx, objectType: "order", objectId: orderId });
  const data = parseInput(cancelOrderSchema, input, LABELS);
  if (data.reason === "other" && (!data.note || data.note.length < 3)) throw ValidationError.field("note", "Alasan \"Lainnya\" wajib dijelaskan (minimal 3 karakter).");
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const order = await loadOrder(tx, ctx, orderId, { forUpdate: true });
    if (order.status === "completed" || order.status === "cancelled") {
      throw new ConflictError("ORDER_LOCKED", `Pesanan ${order.number} sudah ${label("order_status", order.status)} dan terkunci; koreksi hanya lewat transaksi pembalik.`);
    }
    const tripRows = await orderTrips(tx, order.id);
    if (tripRows.some((t) => t.status === "departed" || t.status === "arrived")) {
      throw new DomainError("ORDER_IN_DELIVERY", `Pesanan ${order.number} sedang Dalam pengiriman dan tidak dapat dibatalkan dari kantor. Bila pengiriman tidak jadi, sopir menandai rit Gagal.`);
    }
    const reasonText = `${label("order_cancel_reason", data.reason)}${data.note ? `: ${data.note}` : ""}`;
    // Bab 5.2: pesanan dengan pengiriman terealisasi (ada rit Selesai) tidak pernah menjadi Dibatalkan — hanya SISA rit
    // yang ditarik permanen, lalu pesanan Selesai (air sudah terkirim & ditagih).
    if (tripRows.some((t) => t.status === "completed")) {
      const withdrawn = await withdrawOpenTrips(tx, ctx, order, { permanent: true, reason: `Sisa rit dibatalkan — ${reasonText}` });
      if (withdrawn.length === 0) throw new DomainError("NO_OPEN_TRIP", `Pesanan ${order.number} tidak punya sisa rit yang dapat dibatalkan.`);
      await cancelOpenApprovals(tx, ctx, order, `Sisa rit dibatalkan — ${reasonText}`);
      await tx.update(orders).set({ needsReschedule: false, updatedAt: ctx.now }).where(eq(orders.id, order.id));
      await auditRecord(tx, {
        ctx,
        objectType: "order",
        objectId: order.id,
        action: "cancel_remaining",
        before: { status: order.status },
        after: { withdrawnTrips: withdrawn.map((t) => t.number) },
        reason: reasonText,
        rule: "5.2",
      });
      const { order: final } = await recomputeOrderStatus(tx, ctx, order.id, { reason: `Sisa rit dibatalkan — ${reasonText}`, rule: "5.2" });
      return final;
    }
    if (order.status === "in_delivery") {
      throw new DomainError("ORDER_IN_DELIVERY", `Pesanan ${order.number} sedang Dalam pengiriman dan tidak dapat dibatalkan dari kantor. Bila pengiriman tidak jadi, sopir menandai rit Gagal.`);
    }
    await withdrawOpenTrips(tx, ctx, order, { permanent: true, reason: `Pesanan dibatalkan — ${reasonText}` });
    const [after] = await tx
      .update(orders)
      .set({ status: "cancelled", cancelReason: data.reason, cancelNote: data.note, cancelledAt: ctx.now, cancelledBy: ctx.userId, needsReschedule: false, updatedAt: ctx.now })
      .where(eq(orders.id, order.id))
      .returning();
    await cancelOpenApprovals(tx, ctx, order, `Pesanan dibatalkan — ${reasonText}`);
    await auditRecord(tx, {
      ctx,
      objectType: "order",
      objectId: order.id,
      action: "cancel",
      before: { status: order.status },
      after: { status: "cancelled", cancelReason: data.reason, cancelNote: data.note },
      reason: reasonText,
      rule: data.reason === "duplicate" ? "KPI-06" : "US-M2-02 KP-3",
    });
    await emitStatusChanged(tx, ctx, order, "cancelled", reasonText, data.reason);
    await clearDuplicateFlags(tx, ctx, { ...after!, possibleDuplicate: order.possibleDuplicate });
    return after!;
  });
}

/** Jadwal ulang: ubah tanggal diminta beralasan, riwayat tanggal tersimpan (US-M2-09 KP-1). */
export async function rescheduleOrder(ctx: ActorContext, orderId: string, input: RescheduleOrderInput, opts: { tx?: Tx } = {}): Promise<{ order: OrderRow; warnings: string[] }> {
  await authorize(ctx, "m2.order.reschedule", { tx: opts.tx, objectType: "order", objectId: orderId });
  const data = parseInput(rescheduleOrderSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    const order = await loadOrder(tx, ctx, orderId, { forUpdate: true });
    if (order.status === "completed" || order.status === "cancelled") {
      throw new ConflictError("ORDER_LOCKED", `Pesanan ${order.number} sudah ${label("order_status", order.status)}; tidak dapat dijadwalkan ulang.`);
    }
    const tripRows = await orderTrips(tx, order.id);
    if (tripRows.some((t) => t.status === "departed" || t.status === "arrived")) {
      throw new DomainError("TRIP_ON_ROAD", "Ada rit yang sedang berjalan; jadwal ulang setelah rit itu Selesai atau Gagal.");
    }
    const today = ctxBusinessDate(ctx);
    if (data.requestedDate < today) throw ValidationError.field("requestedDate", "Tanggal baru tidak boleh sebelum hari ini.");
    const rules = await orderRules(tx, today);
    const afterCutoff = data.requestedDate === today && toWibParts(ctx.now).time >= rules.sameDayCutoff;
    const newTime = data.requestedTime === undefined ? order.requestedTime : data.requestedTime;
    if (data.requestedDate === order.requestedDate && (newTime ?? null) === (order.requestedTime?.slice(0, 5) ?? null) && !order.needsReschedule) {
      throw new DomainError("SAME_DATE", "Tanggal dan jam baru sama dengan yang lama.");
    }
    await tx.insert(orderDateHistory).values({
      orderId: order.id,
      fromDate: order.requestedDate,
      toDate: data.requestedDate,
      fromTime: order.requestedTime,
      toTime: newTime ?? null,
      reason: data.reason,
      changedBy: ctx.userId,
      changedAt: ctx.now,
    });
    await withdrawOpenTrips(tx, ctx, order, { permanent: false, reason: `Jadwal ulang ke ${data.requestedDate}: ${data.reason}`, newDate: data.requestedDate });
    await tx
      .update(orders)
      .set({
        requestedDate: data.requestedDate,
        requestedTime: newTime ?? null,
        needsReschedule: false,
        afterCutoffForced: afterCutoff ? true : order.afterCutoffForced,
        afterCutoffReason: afterCutoff ? data.reason : order.afterCutoffReason,
        updatedAt: ctx.now,
      })
      .where(eq(orders.id, order.id));
    await auditRecord(tx, {
      ctx,
      objectType: "order",
      objectId: order.id,
      action: "reschedule",
      before: { requestedDate: order.requestedDate, requestedTime: order.requestedTime },
      after: { requestedDate: data.requestedDate, requestedTime: newTime ?? null },
      reason: data.reason,
      rule: afterCutoff ? "US-M2-09 KP-1, BR-20 6.2c" : "US-M2-09 KP-1",
    });
    const { order: final } = await recomputeOrderStatus(tx, ctx, order.id, { reason: `Jadwal ulang: ${data.reason}` });
    const warnings: string[] = [];
    const dups = await findDuplicateOrders(tx, { customerId: order.customerId, addressId: order.addressId, requestedDate: data.requestedDate, excludeOrderId: order.id });
    if (dups.length) warnings.push(`Ada pesanan lain untuk pelanggan & alamat yang sama pada tanggal itu: ${dups.map((x) => x.number).join(", ")}.`);
    return { order: final, warnings };
  });
}

/** Ubah cara bayar (US-M2-05 KP-3: Dispatcher dapat mengubah ke tunai kapan saja; ke tempo lewat kontrol kredit). */
export async function changePaymentMethod(
  ctx: ActorContext,
  orderId: string,
  input: ChangePaymentInput,
  opts: { tx?: Tx } = {},
): Promise<{ status: "updated"; order: OrderRow } | { status: "credit_blocked"; check: Extract<CreditCheck, { ok: false }> }> {
  await authorize(ctx, "m2.order.update", { tx: opts.tx, objectType: "order", objectId: orderId });
  const data = parseInput(changePaymentSchema, input, LABELS);
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const order = await loadOrder(tx, ctx, orderId, { forUpdate: true });
    if (order.isInternal) throw new DomainError("INTERNAL_ORDER", "Pesanan internal pasokan depot selalu bercara bayar Internal.");
    if (order.status === "completed" || order.status === "cancelled") throw new ConflictError("ORDER_LOCKED", `Pesanan ${order.number} sudah terkunci.`);
    if (order.paymentMethod === data.paymentMethod) throw new DomainError("SAME_PAYMENT", `Cara bayar sudah ${label("payment_method", data.paymentMethod)}.`);
    const open = (await orderTrips(tx, order.id)).filter(isTripOpen);
    if (open.length === 0) throw new DomainError("NO_OPEN_TRIP", "Semua rit sudah berjalan atau selesai; cara bayar tidak dapat diubah dari kantor.");
    if (data.paymentMethod === "credit") {
      const check = await evaluateCreditOrder(tx, order.customerId, open.reduce((s, t) => s + t.price, 0), { excludeOrderId: order.id });
      if (!check.ok) return { status: "credit_blocked" as const, check };
    }
    // US-M2-05 KP-3/KP-6: hanya persetujuan TEMPO yang gugur karena ubah cara bayar; persetujuan "kurang bayar kedua"
    // (PTB-18) tidak berkaitan dengan cara bayar dan tetap menunggu keputusan pemilik.
    await cancelOpenApprovals(tx, ctx, order, `Cara bayar diubah ke ${label("payment_method", data.paymentMethod)}`, { only: "credit" });
    const openIds = open.map((t) => t.id);
    await tx.update(trips).set({ paymentMethod: data.paymentMethod, updatedAt: ctx.now }).where(inArray(trips.id, openIds));
    if (order.paymentMethod === "credit") {
      await tx
        .update(trips)
        .set({ creditHoldResolution: "changed_to_cash" })
        .where(and(inArray(trips.id, openIds), isNotNull(trips.creditHoldFlaggedAt), sql`${trips.creditHoldResolution} is null`));
    }
    const patch: Partial<typeof orders.$inferInsert> = { paymentMethod: data.paymentMethod, updatedAt: ctx.now };
    if (order.status === "awaiting_approval" && order.paymentMethod === "credit" && !(await hasOpenApproval(tx, order.underpaymentApprovalRequestId))) patch.status = "new";
    const [after] = await tx.update(orders).set(patch).where(eq(orders.id, order.id)).returning();
    await auditRecord(tx, {
      ctx,
      objectType: "order",
      objectId: order.id,
      action: "update",
      before: { paymentMethod: order.paymentMethod, status: order.status },
      after: { paymentMethod: data.paymentMethod, status: after!.status },
      reason: data.reason ?? null,
      rule: "US-M2-05 KP-3",
    });
    if (patch.status) await emitStatusChanged(tx, ctx, order, patch.status, `Cara bayar diubah ke ${label("payment_method", data.paymentMethod)}`);
    const { order: final } = await recomputeOrderStatus(tx, ctx, order.id);
    return { status: "updated" as const, order: final };
  });
}

async function hasOpenApproval(tx: Tx, id: string | null): Promise<boolean> {
  if (!id) return false;
  const rows = await tx.select({ status: approvalRequests.status }).from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
  return rows[0]?.status === "submitted";
}

/** Ubah catatan pesanan (ikut ke aplikasi sopir, US-M2-08 KP-2). */
export async function updateOrderNotes(ctx: ActorContext, orderId: string, input: { notes: string | null }, opts: { tx?: Tx } = {}): Promise<OrderRow> {
  await authorize(ctx, "m2.order.update", { tx: opts.tx, objectType: "order", objectId: orderId });
  const notes = (input.notes ?? "").trim().slice(0, 1000) || null;
  return runService(ctx, opts, async (tx) => {
    const order = await loadOrder(tx, ctx, orderId, { forUpdate: true });
    if (order.status === "completed" || order.status === "cancelled") throw new ConflictError("ORDER_LOCKED", `Pesanan ${order.number} sudah terkunci.`);
    const [after] = await tx.update(orders).set({ notes, updatedAt: ctx.now }).where(eq(orders.id, order.id)).returning();
    await auditRecord(tx, { ctx, objectType: "order", objectId: order.id, action: "update", before: { notes: order.notes }, after: { notes } });
    return after!;
  });
}

/** Catat "sudah dikonfirmasi ulang" (waktu & cara) sebelum dijadwalkan (US-M2-09 KP-3, BR-24). */
export async function reconfirmOrder(ctx: ActorContext, orderId: string, input: ReconfirmInput, opts: { tx?: Tx } = {}): Promise<OrderRow> {
  await authorize(ctx, "m2.order.reconfirm", { tx: opts.tx, objectType: "order", objectId: orderId });
  const data = parseInput(reconfirmSchema, input, { confirmedAt: "Waktu konfirmasi", method: "Cara konfirmasi" });
  if (data.confirmedAt.getTime() > ctx.now.getTime() + 60_000) throw ValidationError.field("confirmedAt", "Waktu konfirmasi ulang tidak boleh di masa depan.");
  return runService(ctx, opts, async (tx) => {
    const order = await loadOrder(tx, ctx, orderId, { forUpdate: true });
    if (!order.reconfirmationRequired) throw new DomainError("RECONFIRM_NOT_NEEDED", `Pesanan ${order.number} tidak memerlukan konfirmasi ulang.`);
    if (order.status === "completed" || order.status === "cancelled") throw new ConflictError("ORDER_LOCKED", `Pesanan ${order.number} sudah terkunci.`);
    const method = data.note ? `${data.method} — ${data.note}` : data.method;
    const [after] = await tx
      .update(orders)
      .set({ reconfirmedAt: data.confirmedAt, reconfirmedBy: ctx.userId, reconfirmationMethod: method, updatedAt: ctx.now })
      .where(eq(orders.id, order.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "order",
      objectId: order.id,
      action: "reconfirm",
      after: { reconfirmedAt: data.confirmedAt, reconfirmationMethod: method },
      reason: method,
      rule: "BR-24",
    });
    return after!;
  });
}

/**
 * Perbarui harga pesanan ke harga berlaku saat kirim (PTB-13, US-M1-02 KP-4) — hanya setelah konfirmasi pelanggan
 * (catatan wajib). Juga menghapus "harga sementara" setelah alamat berzona (7.1.6).
 */
export async function refreshOrderPrice(ctx: ActorContext, orderId: string, input: { note: string }, opts: { tx?: Tx } = {}): Promise<OrderRow> {
  await authorize(ctx, "m2.order.update", { tx: opts.tx, objectType: "order", objectId: orderId });
  const note = parseInput(z.string().trim().min(3, { error: "Catatan konfirmasi pelanggan wajib diisi (minimal 3 karakter)." }).max(300), input.note ?? "");
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const order = await loadOrder(tx, ctx, orderId, { forUpdate: true });
    if (order.status === "completed" || order.status === "cancelled") throw new ConflictError("ORDER_LOCKED", `Pesanan ${order.number} sudah terkunci.`);
    const open = (await orderTrips(tx, order.id)).filter(isTripOpen);
    if (!open.length) throw new DomainError("NO_OPEN_TRIP", "Tidak ada rit yang belum berangkat; harga tidak dapat diperbarui.");
    const customer = (await tx.select().from(customers).where(eq(customers.id, order.customerId)).limit(1))[0]!;
    const deliveryDate = open.map((t) => t.scheduledDate).sort()[0]!;
    const price = await resolveOrderPrice(tx, customer, order.addressId, deliveryDate, order.tankCount);
    if (price.pricePerTrip === order.pricePerTrip && !(order.priceIsProvisional && !price.provisional)) {
      throw new DomainError("PRICE_UNCHANGED", "Harga berlaku sama dengan harga pesanan; tidak ada yang diperbarui.");
    }
    await tx.update(trips).set({ price: price.pricePerTrip, updatedAt: ctx.now }).where(inArray(trips.id, open.map((t) => t.id)));
    const all = await orderTrips(tx, order.id);
    const total = all.filter((t) => t.status !== "failed" && !t.withdrawnAt).reduce((s, t) => s + t.price, 0);
    const [after] = await tx
      .update(orders)
      .set({
        pricePerTrip: price.pricePerTrip,
        totalAmount: total,
        priceSource: price.source,
        tariffZoneId: price.tariffZoneId,
        zoneTariffId: price.zoneTariffId,
        fuelComponentId: price.fuelComponentId,
        specialPriceId: price.specialPriceId,
        priceIsProvisional: price.provisional,
        priceUpdatedAt: ctx.now,
        priceUpdatedBy: ctx.userId,
        priceUpdateNote: note,
        updatedAt: ctx.now,
      })
      .where(eq(orders.id, order.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "order",
      objectId: order.id,
      action: "update",
      before: { pricePerTrip: order.pricePerTrip, totalAmount: order.totalAmount, priceIsProvisional: order.priceIsProvisional },
      after: { pricePerTrip: price.pricePerTrip, totalAmount: total, priceIsProvisional: price.provisional },
      reason: note,
      rule: "PTB-13",
    });
    return after!;
  });
}

// =====================================================================================================================
// Daftar & rincian
// =====================================================================================================================

export type OrderListRow = {
  id: string;
  number: string;
  status: OrderStatus;
  source: OrderRow["source"];
  customerId: string;
  customerName: string;
  addressLabel: string;
  addressText: string;
  requestedDate: string;
  requestedTime: string | null;
  tankCount: number;
  paymentMethod: PaymentMethod;
  pricePerTrip: number;
  totalAmount: number;
  trucks: string[];
  isInternal: boolean;
  possibleDuplicate: boolean;
  needsReschedule: boolean;
  reconfirmationRequired: boolean;
  reconfirmed: boolean;
  collectUnderpayment: boolean;
  afterCutoffForced: boolean;
  priceIsProvisional: boolean;
  cancelReason: OrderRow["cancelReason"];
  createdByName: string | null;
  createdAt: Date;
};

/** Cari & saring pesanan (US-M2-02 KP-4): nomor, pelanggan, tanggal, status, truk, cara bayar. */
export async function listOrders(ctx: ActorContext, filter: ListOrdersFilter = {}, opts: { tx?: Tx } = {}): Promise<OrderListRow[]> {
  await authorize(ctx, "m2.order.read", { tx: opts.tx });
  const f = parseInput(listOrdersSchema, filter);
  const tx = opts.tx ?? getDb();
  const conds: SQL[] = [eq(orders.tenantId, ctx.tenantId)];
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conds.push(or(ilike(orders.number, like), ilike(customers.name, like), ilike(customers.code, like), ilike(customerAddresses.addressText, like))!);
  }
  if (f.status === "active") conds.push(inArray(orders.status, [...ACTIVE_ORDER_STATUSES]));
  else if (f.status) conds.push(eq(orders.status, f.status));
  if (f.from) conds.push(gte(orders.requestedDate, f.from));
  if (f.to) conds.push(lte(orders.requestedDate, f.to));
  if (f.customerId) conds.push(eq(orders.customerId, f.customerId));
  if (f.paymentMethod) conds.push(eq(orders.paymentMethod, f.paymentMethod));
  if (f.truckId) conds.push(sql`exists (select 1 from ${trips} t where t.order_id = ${orders.id} and t.truck_id = ${f.truckId})`);
  if (f.flag === "duplicate") conds.push(eq(orders.possibleDuplicate, true));
  if (f.flag === "reschedule") conds.push(eq(orders.needsReschedule, true));
  if (f.flag === "reconfirm") conds.push(and(eq(orders.reconfirmationRequired, true), sql`${orders.reconfirmedAt} is null`)!);
  if (f.flag === "after_cutoff") conds.push(eq(orders.afterCutoffForced, true));
  if (f.flag === "provisional") conds.push(eq(orders.priceIsProvisional, true));
  const rows = await tx
    .select({ o: orders, customerName: customers.name, addressLabel: customerAddresses.label, addressText: customerAddresses.addressText })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .innerJoin(customerAddresses, eq(customerAddresses.id, orders.addressId))
    .where(and(...conds))
    .orderBy(desc(orders.requestedDate), desc(orders.createdAt))
    .limit(f.limit ?? 500);
  const ids = rows.map((r) => r.o.id);
  const truckRows = ids.length
    ? await tx
        .selectDistinct({ orderId: trips.orderId, code: trucks.code })
        .from(trips)
        .innerJoin(trucks, eq(trucks.id, trips.truckId))
        .where(and(inArray(trips.orderId, ids), sql`${trips.withdrawnAt} is null`))
    : [];
  const names = await userNames(tx, rows.map((r) => r.o.createdBy));
  return rows.map(({ o, customerName, addressLabel, addressText }) => ({
    id: o.id,
    number: o.number,
    status: o.status,
    source: o.source,
    customerId: o.customerId,
    customerName,
    addressLabel,
    addressText,
    requestedDate: o.requestedDate,
    requestedTime: o.requestedTime?.slice(0, 5) ?? null,
    tankCount: o.tankCount,
    paymentMethod: o.paymentMethod,
    pricePerTrip: o.pricePerTrip,
    totalAmount: o.totalAmount,
    trucks: truckRows.filter((t) => t.orderId === o.id).map((t) => t.code),
    isInternal: o.isInternal,
    possibleDuplicate: o.possibleDuplicate,
    needsReschedule: o.needsReschedule,
    reconfirmationRequired: o.reconfirmationRequired,
    reconfirmed: !!o.reconfirmedAt,
    collectUnderpayment: o.collectUnderpayment,
    afterCutoffForced: o.afterCutoffForced,
    priceIsProvisional: o.priceIsProvisional,
    cancelReason: o.cancelReason,
    createdByName: o.createdBy ? (names.get(o.createdBy) ?? null) : "Sistem",
    createdAt: o.createdAt,
  }));
}

export type OrderDetail = {
  order: OrderRow;
  customer: CustomerRow;
  address: typeof customerAddresses.$inferSelect;
  trips: (TripRow & { truckCode: string | null; driverName: string | null; scheduleStatus: string | null })[];
  dateHistory: (typeof orderDateHistory.$inferSelect & { changedByName: string | null })[];
  approvals: (typeof approvalRequests.$inferSelect)[];
  timeline: { id: string; at: Date; action: string; actorName: string | null; reason: string | null; before: unknown; after: unknown }[];
  waLogs: { id: string; openedAt: Date | null; openedByName: string | null; status: string }[];
  blockers: SchedulingBlocker[];
  priceChange: { changed: boolean; lockedUnitPrice: number; currentUnitPrice: number; difference: number } | null;
  exposure: CreditExposure | null;
  duplicates: DuplicateOrderView[];
  createdByName: string | null;
  cancelledByName: string | null;
  reconfirmedByName: string | null;
};

/** Rincian pesanan: rit, riwayat tanggal, persetujuan, jejak status (waktu & pelaku), WA, penghalang jadwal, PTB-13. */
export async function getOrderDetail(ctx: ActorContext, orderId: string, opts: { tx?: Tx } = {}): Promise<OrderDetail> {
  await authorize(ctx, "m2.order.read", { tx: opts.tx, objectType: "order", objectId: orderId });
  const tx = opts.tx ?? getDb();
  const order = await loadOrder(tx, ctx, orderId);
  const customer = (await tx.select().from(customers).where(eq(customers.id, order.customerId)).limit(1))[0]!;
  const address = (await tx.select().from(customerAddresses).where(eq(customerAddresses.id, order.addressId)).limit(1))[0]!;
  const tripRows = await tx
    .select({ t: trips, truckCode: trucks.code, scheduleStatus: dailySchedules.status })
    .from(trips)
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .leftJoin(dailySchedules, eq(dailySchedules.id, trips.scheduleId))
    .where(eq(trips.orderId, order.id))
    .orderBy(asc(trips.sequenceInOrder));
  const history = await tx.select().from(orderDateHistory).where(eq(orderDateHistory.orderId, order.id)).orderBy(asc(orderDateHistory.changedAt));
  const approvalRows = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.objectType, "order"), eq(approvalRequests.objectId, order.id)))
    .orderBy(desc(approvalRequests.createdAt));
  const audit = await auditQuery(tx, { tenantId: order.tenantId, objectType: "order", objectId: order.id, limit: 200 });
  const wa = await tx
    .select()
    .from(waMessageLogs)
    .where(and(eq(waMessageLogs.objectType, "order"), eq(waMessageLogs.objectId, order.id)))
    .orderBy(desc(waMessageLogs.createdAt));
  const empNames = await employeeNames(tx, tripRows.map((r) => r.t.driverEmployeeId));
  const names = await userNames(tx, [
    order.createdBy,
    order.cancelledBy,
    order.reconfirmedBy,
    ...history.map((h) => h.changedBy),
    ...audit.map((a) => a.actorUserId),
    ...wa.map((w) => w.openedBy),
    ...tripRows.map((r) => r.t.driverUserId),
  ]);
  let priceChange: OrderDetail["priceChange"] = null;
  const openTrips = tripRows.map((r) => r.t).filter(isTripOpen);
  if (!order.isInternal && openTrips.length && order.status !== "cancelled") {
    try {
      const deliveryDate = openTrips.map((t) => t.scheduledDate).sort()[0]!;
      const pc = await detectTruckPriceChange(tx, { customerId: order.customerId, addressId: order.addressId, lockedUnitPrice: order.pricePerTrip, deliveryDate });
      priceChange = { changed: pc.changed, lockedUnitPrice: pc.lockedUnitPrice, currentUnitPrice: pc.currentUnitPrice, difference: pc.difference };
    } catch {
      priceChange = null;
    }
  }
  const exposure = order.paymentMethod === "credit" ? await computeCreditExposure(tx, order.customerId) : null;
  const dups = order.status === "cancelled" || order.status === "completed" ? [] : await findDuplicateOrders(tx, { customerId: order.customerId, addressId: order.addressId, requestedDate: order.requestedDate, excludeOrderId: order.id });
  return {
    order,
    customer,
    address,
    trips: tripRows.map((r) => ({
      ...r.t,
      truckCode: r.truckCode,
      scheduleStatus: r.scheduleStatus,
      driverName: r.t.driverUserId ? (names.get(r.t.driverUserId) ?? null) : r.t.driverEmployeeId ? (empNames.get(r.t.driverEmployeeId) ?? null) : null,
    })),
    dateHistory: history.map((h) => ({ ...h, changedByName: h.changedBy ? (names.get(h.changedBy) ?? null) : null })),
    approvals: approvalRows,
    timeline: audit
      .map((a) => ({ id: a.id, at: a.serverTime, action: a.action, actorName: a.actorUserId ? (names.get(a.actorUserId) ?? null) : "Sistem", reason: a.reason, before: a.before, after: a.after }))
      .reverse(),
    waLogs: wa.map((w) => ({ id: w.id, openedAt: w.openedAt, openedByName: w.openedBy ? (names.get(w.openedBy) ?? null) : null, status: w.status })),
    blockers: await schedulingBlockers(tx, order, { forPublish: true, trip: openTrips.find((t) => t.creditHoldFlaggedAt && !t.creditHoldResolution) ?? null }),
    priceChange,
    exposure,
    duplicates: await duplicateViews(tx, dups),
    createdByName: order.createdBy ? (names.get(order.createdBy) ?? null) : "Sistem",
    cancelledByName: order.cancelledBy ? (names.get(order.cancelledBy) ?? null) : null,
    reconfirmedByName: order.reconfirmedBy ? (names.get(order.reconfirmedBy) ?? null) : null,
  };
}

export type CustomerHistoryRow = {
  number: string;
  requestedDate: string;
  requestedTime: string | null;
  tankCount: number;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  pricePerTrip: number;
  totalAmount: number;
  trucks: string;
  addressLabel: string;
  addressText: string;
  cancelReason: OrderRow["cancelReason"];
  failedTrips: number;
  notes: string | null;
};

/** Riwayat lengkap pesanan per pelanggan (US-M2-08 KP-3) — dasar ekspor. */
export async function customerOrderHistory(ctx: ActorContext, customerId: string, opts: { tx?: Tx } = {}): Promise<{ customer: CustomerRow; rows: CustomerHistoryRow[] }> {
  await authorize(ctx, "m2.order.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const customer = (await tx.select().from(customers).where(eq(customers.id, customerId)).limit(1))[0];
  if (!customer || customer.tenantId !== ctx.tenantId) throw new NotFoundError("Pelanggan tidak ditemukan.");
  const rows = await tx
    .select({ o: orders, addressLabel: customerAddresses.label, addressText: customerAddresses.addressText })
    .from(orders)
    .innerJoin(customerAddresses, eq(customerAddresses.id, orders.addressId))
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(orders.requestedDate), desc(orders.createdAt));
  const ids = rows.map((r) => r.o.id);
  const tripRows = ids.length
    ? await tx
        .select({ orderId: trips.orderId, status: trips.status, code: trucks.code })
        .from(trips)
        .leftJoin(trucks, eq(trucks.id, trips.truckId))
        .where(inArray(trips.orderId, ids))
    : [];
  return {
    customer,
    rows: rows.map(({ o, addressLabel, addressText }) => {
      const own = tripRows.filter((t) => t.orderId === o.id);
      return {
        number: o.number,
        requestedDate: o.requestedDate,
        requestedTime: o.requestedTime?.slice(0, 5) ?? null,
        tankCount: o.tankCount,
        status: o.status,
        paymentMethod: o.paymentMethod,
        pricePerTrip: o.pricePerTrip,
        totalAmount: o.totalAmount,
        trucks: [...new Set(own.map((t) => t.code).filter(Boolean))].join(", "),
        addressLabel,
        addressText,
        cancelReason: o.cancelReason,
        failedTrips: own.filter((t) => t.status === "failed").length,
        notes: o.notes,
      };
    }),
  };
}
