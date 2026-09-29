/**
 * P3 — pesanan air & spare part dari portal mitra (Tahap 3 US-P3-03; flag `phase3.partner_portal`).
 *
 * - KP-1: pesanan air (jumlah tangki, tanggal/jam) → pesanan M2 pelanggan mitra (`createOrder` lewat pelaku sistem,
 *   asal `partner_portal`), harga = tarif zona alamat outlet (M1) dikurangi diskon mitra bila Opsi A (parameter kontrak
 *   yang berlaku bulan itu); SLA PAR-76 dipantau handler `order.created` + job SLA (US-P3-08 KP-4).
 * - KP-2: cara bayar tunai/transfer/tempo; tempo dalam batas kredit kontrak (kontrol kredit M2 = satu batas lintas
 *   lini PTB-25); Ditahan memblokir seperti pelanggan lain dan dinaikkan ke pemicu sanksi (handler
 *   `credit_status.changed`); penghentian pasokan sementara (US-P3-07) menolak pesanan air dengan alasan & syarat.
 * - KP-3: spare part dari katalog toko M7 harga mitra (BR-18) → Diajukan → dikonfirmasi kasir toko saat mencatat
 *   penjualan harga mitra untuk pelanggan mitra di POS toko (`pos_sale.recorded`) → Dikonfirmasi; ambil di toko atau
 *   ikut truk air (ditandai pada rit berikutnya). Tempo mengikuti batas kredit yang sama.
 * - KP-4: status pesanan & pengiriman (M2/M3) + volume kirim & konfirmasi operator mitra (US-M6-05) di portal.
 * - KP-5: riwayat pembelian per bulan (`purchaseHistory`, supply.ts).
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { customerAddresses, orders, partnerPortalOrders, posSales, products, trips, waterSupplyReceipts } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, isBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";
import { resolveProductPrice } from "@/server/modules/m1-master";
import { computeCreditExposure, createOrder } from "@/server/modules/m2-orders";

import { activeContractFor, assertPartnerActor, authorizePortalAction, bpToPercent, denyCrossTenant, ownerTenantId, partnerCustomerForOutlet, type ContractRow } from "./common";
import { effectiveTerms } from "./contracts";
import { activeSupplySuspension } from "./sanctions";

export type PortalOrderRow = typeof partnerPortalOrders.$inferSelect;

/** Outlet mitra milik tenant pelaku + pelanggan mitra tertaut + kontrak berlaku. */
async function partnerOutletContext(tx: Tx, ctx: ActorContext, outletId: string) {
  const tenant = await assertPartnerActor(tx, ctx);
  const customer = await partnerCustomerForOutlet(tx, outletId);
  if (!customer) throw ValidationError.field("outletId", "Outlet ini belum tertaut ke pelanggan mitra EQUA. Hubungi Admin Keuangan EQUA.");
  if (customer.partnerTenantId !== tenant.id) await denyCrossTenant(ctx, "outlet", "outlet", outletId, tx);
  const today = ctxBusinessDate(ctx);
  const contract = await activeContractFor(tx, tenant.id, today);
  if (!contract) throw new DomainError("NO_ACTIVE_CONTRACT", "Kontrak kemitraan Anda tidak berlaku hari ini. Hubungi pembina wilayah EQUA.");
  return { tenant, customer, contract, today };
}

/** Harga air per tangki setelah diskon mitra Opsi A (US-P3-03 KP-1; K23, 9.6). */
export function discountedWaterPrice(price: number, contract: ContractRow, periodMonth: string): { price: number; discountBp: number } {
  const terms = effectiveTerms(contract, periodMonth);
  if (contract.option !== "option_a" || terms.waterDiscountBp <= 0) return { price, discountBp: 0 };
  return { price: Math.round((price * (10_000 - terms.waterDiscountBp)) / 10_000), discountBp: terms.waterDiscountBp };
}

// =====================================================================================================================
// KP-1/KP-2: pesanan air
// =====================================================================================================================

const waterSchema = z.object({
  outletId: z.uuid({ error: "Pilih outlet." }),
  tankCount: z.coerce.number().int().min(1, { error: "Jumlah tangki minimal 1." }).max(20, { error: "Maksimal 20 tangki per pesanan." }),
  requestedDate: z.string().refine(isBusinessDate, { error: "Tanggal kirim harus YYYY-MM-DD." }),
  requestedTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, { error: "Jam kirim harus JJ:MM." })
    .nullable()
    .optional(),
  paymentMethod: z.enum(["cash", "transfer", "credit"], { error: "Pilih tunai, transfer, atau tempo." }),
  notes: z.string().trim().max(500).nullable().optional(),
  /** Pesanan pada tanggal yang sama sudah ada → mitra mengonfirmasi ini pesanan tambahan. */
  confirmAdditional: z.boolean().optional(),
});
export type PortalWaterOrderInput = z.input<typeof waterSchema>;

export type PortalWaterOrderResult =
  | { status: "created"; portalOrder: PortalOrderRow; orderId: string; orderNumber: string; pricePerTrip: number; discountBp: number }
  | { status: "duplicate"; message: string }
  | { status: "credit_blocked"; message: string };

export async function createPortalWaterOrder(ctx: ActorContext, input: PortalWaterOrderInput, opts: { tx?: Tx } = {}): Promise<PortalWaterOrderResult> {
  await authorizePortalAction(ctx, "p3.portal_order.create", { tx: opts.tx });
  const data = parseInput(waterSchema, input, { outletId: "Outlet", tankCount: "Jumlah tangki", requestedDate: "Tanggal kirim", paymentMethod: "Cara bayar" });
  return runService(ctx, opts, async (tx) => {
    const { tenant, customer, contract, today } = await partnerOutletContext(tx, ctx, data.outletId);
    if (data.requestedDate < today) throw ValidationError.field("requestedDate", "Tanggal kirim tidak boleh sebelum hari ini.");
    const suspension = await activeSupplySuspension(tx, tenant.id, today);
    if (suspension) {
      const d = (suspension.triggerDetail ?? {}) as { recoveryConditions?: string };
      throw new DomainError(
        "PARTNER_SUPPLY_SUSPENDED",
        `Pesanan air diblokir sementara (sanksi penghentian pasokan sejak ${formatTanggal(suspension.effectiveFrom ?? today, { weekday: false })}). Alasan: ${suspension.decisionReason ?? "-"}. Syarat pemulihan: ${d.recoveryConditions ?? "hubungi pembina wilayah"}.`,
      );
    }
    const [address] = await tx
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.customerId, customer.id), eq(customerAddresses.isActive, true)))
      .orderBy(asc(customerAddresses.createdAt))
      .limit(1);
    if (!address) throw new DomainError("NO_ADDRESS", "Alamat kirim outlet belum tercatat di EQUA. Hubungi Admin Keuangan EQUA.");
    const equa = await ownerTenantId(tx);
    const sys = systemContext({ tenantId: equa, now: ctx.now, businessDate: today });
    const res = await createOrder(
      sys,
      {
        customerId: customer.id,
        addressId: address.id,
        tankCount: data.tankCount,
        requestedDate: data.requestedDate,
        requestedTime: data.requestedTime ?? null,
        paymentMethod: data.paymentMethod,
        notes: [`Pesanan dari portal mitra ${tenant.name}`, data.notes].filter(Boolean).join(" — "),
        duplicateDecision: data.confirmAdditional ? "additional" : null,
        duplicateReason: data.confirmAdditional ? "Pesanan tambahan dikonfirmasi mitra lewat portal" : null,
      },
      { tx },
    );
    if (res.status === "duplicate") return { status: "duplicate", message: "Sudah ada pesanan air untuk outlet ini pada tanggal yang sama. Centang \"Ini pesanan tambahan\" bila memang perlu tambahan." };
    if (res.status === "credit_blocked") {
      return {
        status: "credit_blocked",
        message:
          res.check.reason === "on_hold"
            ? "Pesanan tempo diblokir karena status kredit Ditahan (ada tagihan lewat tempo). Lunasi tagihan atau pilih tunai/transfer."
            : res.check.reason === "cash_customer"
              ? "Kontrak Anda tidak memberi fasilitas tempo. Pilih tunai atau transfer."
              : `Pesanan tempo melebihi batas kredit kontrak (sisa ${formatRupiah(Math.max(0, res.check.exposure.remaining + res.check.exposure.extraAmount))}). Pilih tunai/transfer atau lunasi tagihan.`,
      };
    }
    if (res.status !== "created") throw new DomainError("ORDER_NOT_CREATED", "Pesanan tidak dapat dibuat. Coba lagi atau hubungi Dispatcher EQUA.");
    const order = res.order;
    const periodMonth = `${data.requestedDate.slice(0, 7)}-01`;
    const priced = discountedWaterPrice(order.pricePerTrip, contract, periodMonth);
    const set: Partial<typeof orders.$inferInsert> = { source: "partner_portal", updatedAt: ctx.now };
    if (priced.discountBp > 0) {
      Object.assign(set, {
        pricePerTrip: priced.price,
        totalAmount: priced.price * order.tankCount,
        priceUpdatedAt: ctx.now,
        priceUpdateNote: `Diskon mitra Opsi A ${bpToPercent(priced.discountBp)}% dari tarif zona ${formatRupiah(order.pricePerTrip)} (kontrak ${contract.number})`,
      });
      await tx.update(trips).set({ price: priced.price, updatedAt: ctx.now }).where(eq(trips.orderId, order.id));
    }
    await tx.update(orders).set(set).where(eq(orders.id, order.id));
    const [row] = await tx
      .insert(partnerPortalOrders)
      .values({
        tenantId: tenant.id,
        contractId: contract.id,
        customerId: customer.id,
        outletId: data.outletId,
        kind: "water",
        status: "confirmed",
        requestedDate: data.requestedDate,
        requestedTime: data.requestedTime ?? null,
        tankCount: data.tankCount,
        paymentMethod: data.paymentMethod,
        estimatedAmount: priced.price * order.tankCount,
        orderId: order.id,
        submittedBy: ctx.userId,
        submittedAt: ctx.now,
        confirmedAt: ctx.now,
        notes: data.notes ?? null,
      })
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "partner_portal_order",
      objectId: row!.id,
      action: "create",
      after: { kind: "water", orderNumber: order.number, tankCount: data.tankCount, pricePerTrip: priced.price, discountBp: priced.discountBp, paymentMethod: data.paymentMethod },
      rule: "US-P3-03 KP-1/KP-2",
    });
    return { status: "created", portalOrder: row!, orderId: order.id, orderNumber: order.number, pricePerTrip: priced.price, discountBp: priced.discountBp };
  });
}

// =====================================================================================================================
// KP-3: pesanan spare part (katalog toko harga mitra)
// =====================================================================================================================

export type SparePartCatalogRow = { productId: string; code: string; name: string; unit: string; partnerPrice: number };

/** Katalog barang toko EQUA dengan harga mitra (BR-18) yang berlaku hari ini. */
export async function sparePartCatalog(tx: Tx, date: string): Promise<SparePartCatalogRow[]> {
  const equa = await ownerTenantId(tx);
  const rows = await tx
    .select()
    .from(products)
    .where(and(eq(products.tenantId, equa), eq(products.line, "store"), eq(products.status, "active")))
    .orderBy(asc(products.name));
  const out: SparePartCatalogRow[] = [];
  for (const p of rows) {
    try {
      const price = await resolveProductPrice(tx, { productId: p.id, kind: "partner", date, tenantId: equa });
      out.push({ productId: p.id, code: p.code, name: p.name, unit: p.unit, partnerPrice: price.unitPrice });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return out;
}

const spareSchema = z.object({
  outletId: z.uuid({ error: "Pilih outlet." }),
  items: z
    .array(z.object({ productId: z.uuid(), quantity: z.coerce.number().int().min(1).max(999) }))
    .min(1, { error: "Pilih minimal satu barang." })
    .max(30),
  pickup: z.enum(["store_pickup", "with_truck"], { error: "Pilih ambil di toko atau ikut truk air." }),
  paymentMethod: z.enum(["cash", "transfer", "credit"], { error: "Pilih cara bayar." }),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type PortalSparePartOrderInput = z.input<typeof spareSchema>;

export async function createPortalSparePartOrder(ctx: ActorContext, input: PortalSparePartOrderInput, opts: { tx?: Tx } = {}): Promise<PortalOrderRow> {
  await authorizePortalAction(ctx, "p3.portal_order.create", { tx: opts.tx });
  const data = parseInput(spareSchema, input, { outletId: "Outlet", items: "Barang", pickup: "Cara ambil", paymentMethod: "Cara bayar" });
  return runService(ctx, opts, async (tx) => {
    const { tenant, customer, contract, today } = await partnerOutletContext(tx, ctx, data.outletId);
    const catalog = new Map((await sparePartCatalog(tx, today)).map((c) => [c.productId, c]));
    const items = data.items.map((i) => {
      const c = catalog.get(i.productId);
      if (!c) throw ValidationError.field("items", "Barang tidak ada di katalog harga mitra. Muat ulang katalog.");
      return { productId: c.productId, code: c.code, name: c.name, quantity: i.quantity, unitPrice: c.partnerPrice, amount: c.partnerPrice * i.quantity };
    });
    const estimated = items.reduce((s, i) => s + i.amount, 0);
    if (data.paymentMethod === "credit") {
      // Satu batas kredit lintas lini (PTB-25) — sama dengan pesanan air.
      const exp = await computeCreditExposure(tx, customer.id, { extraAmount: estimated });
      if (exp.creditStatus === "on_hold") throw new DomainError("CREDIT_ON_HOLD", "Tempo diblokir karena status kredit Ditahan. Lunasi tagihan lewat tempo atau pilih tunai/transfer.");
      if (exp.creditStatus === "cash") throw new DomainError("CASH_CUSTOMER", "Kontrak Anda tidak memberi fasilitas tempo. Pilih tunai atau transfer.");
      if (exp.exceedsLimit) throw new DomainError("CREDIT_LIMIT", `Tempo melebihi batas kredit kontrak (sisa ${formatRupiah(Math.max(0, exp.remaining + estimated))}). Kurangi pesanan atau pilih tunai/transfer.`);
    }
    const [row] = await tx
      .insert(partnerPortalOrders)
      .values({
        tenantId: tenant.id,
        contractId: contract.id,
        customerId: customer.id,
        outletId: data.outletId,
        kind: "spare_part",
        status: "submitted",
        paymentMethod: data.paymentMethod,
        items,
        pickup: data.pickup,
        estimatedAmount: estimated,
        submittedBy: ctx.userId,
        submittedAt: ctx.now,
        notes: data.notes ?? null,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "partner_portal_order", objectId: row!.id, action: "create", after: { kind: "spare_part", items: items.length, estimated, pickup: data.pickup, paymentMethod: data.paymentMethod }, rule: "US-P3-03 KP-3, BR-18" });
    await notify(tx, {
      event: "partner.spare_part_order",
      tenantId: await ownerTenantId(tx),
      title: `Pesanan spare part mitra ${tenant.name}: ${formatRupiah(estimated)}`,
      body: `${items.map((i) => `${i.name} × ${i.quantity}`).join(", ")} · ${label("spare_part_pickup", data.pickup)} · ${label("payment_method", data.paymentMethod)}. Catat penjualan harga mitra untuk ${customer.name} di POS toko.`,
      objectType: "partner_portal_order",
      objectId: row!.id,
      valueAmount: estimated,
      now: ctx.now,
    });
    return row!;
  });
}

const cancelSchema = z.object({ portalOrderId: z.uuid(), reason: z.string().trim().min(5, { error: "Alasan pembatalan minimal 5 karakter." }).max(300) });

/** Mitra membatalkan pesanan spare part yang belum dikonfirmasi kasir. Pesanan air dibatalkan lewat Dispatcher (M2). */
export async function cancelPortalSparePartOrder(ctx: ActorContext, input: z.input<typeof cancelSchema>, opts: { tx?: Tx } = {}): Promise<PortalOrderRow> {
  await authorizePortalAction(ctx, "p3.portal_order.create", { tx: opts.tx });
  const data = parseInput(cancelSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const tenant = await assertPartnerActor(tx, ctx);
    const [o] = await tx.select().from(partnerPortalOrders).where(eq(partnerPortalOrders.id, data.portalOrderId)).for("update").limit(1);
    if (!o) throw new NotFoundError("Pesanan tidak ditemukan.");
    if (o.tenantId !== tenant.id) await denyCrossTenant(ctx, "pesanan", "partner_portal_order", o.id, tx);
    if (o.kind !== "spare_part" || o.status !== "submitted") throw new DomainError("PORTAL_ORDER_NOT_CANCELLABLE", "Hanya pesanan spare part yang belum dikonfirmasi kasir yang dapat dibatalkan. Pesanan air: hubungi Dispatcher EQUA.");
    const [row] = await tx.update(partnerPortalOrders).set({ status: "cancelled", rejectedReason: data.reason, updatedAt: ctx.now }).where(eq(partnerPortalOrders.id, o.id)).returning();
    await auditRecord(tx, { ctx, objectType: "partner_portal_order", objectId: o.id, action: "cancel", before: { status: o.status }, after: { status: "cancelled" }, reason: data.reason, rule: "US-P3-03 KP-3" });
    return row!;
  });
}

/**
 * Handler `pos_sale.recorded` (M7 toko): penjualan harga mitra untuk pelanggan mitra mengonfirmasi pesanan spare part
 * portal tertua yang masih Diajukan (US-P3-03 KP-3). Ikut truk → ditandai pada rit berikutnya pelanggan mitra itu.
 */
export async function confirmSparePartOrderFromSale(tx: Tx, event: DomainEvent<"pos_sale.recorded">): Promise<PortalOrderRow | null> {
  const p = event.payload;
  if (p.outletKind !== "store" || !p.customerId) return null;
  if (p.priceKind && p.priceKind !== "partner") return null;
  const [pending] = await tx
    .select()
    .from(partnerPortalOrders)
    .where(and(eq(partnerPortalOrders.customerId, p.customerId), eq(partnerPortalOrders.kind, "spare_part"), eq(partnerPortalOrders.status, "submitted"), isNull(partnerPortalOrders.posSaleId)))
    .orderBy(asc(partnerPortalOrders.submittedAt))
    .limit(1);
  if (!pending) return null;
  return linkSaleToPortalOrder(tx, pending, p.posSaleId, event.occurredAt, p.number ?? null);
}

async function linkSaleToPortalOrder(tx: Tx, order: PortalOrderRow, posSaleId: string, now: Date, saleNumber: string | null): Promise<PortalOrderRow> {
  let notes = order.notes;
  if (order.pickup === "with_truck") {
    const [next] = await tx
      .select({ id: trips.id, number: trips.number, scheduledDate: trips.scheduledDate })
      .from(trips)
      .where(and(eq(trips.customerId, order.customerId), inArray(trips.status, ["assigned", "departed"])))
      .orderBy(asc(trips.scheduledDate))
      .limit(1);
    notes = [order.notes, next ? `Ikut truk air rit ${next.number} (${next.scheduledDate})` : "Ikut truk air — rit berikutnya belum terjadwal"].filter(Boolean).join(" · ");
  }
  const [row] = await tx
    .update(partnerPortalOrders)
    .set({ status: "confirmed", posSaleId, confirmedAt: now, notes, updatedAt: now })
    .where(eq(partnerPortalOrders.id, order.id))
    .returning();
  await auditRecord(tx, {
    ctx: systemContext({ tenantId: order.tenantId, now }),
    objectType: "partner_portal_order",
    objectId: order.id,
    action: "confirm",
    before: { status: order.status },
    after: { status: "confirmed", posSaleId, saleNumber },
    rule: "US-P3-03 KP-3",
  });
  return row!;
}

const linkSchema = z.object({ portalOrderId: z.uuid(), posSaleId: z.uuid({ error: "Pilih transaksi toko." }) });

/** Admin Keuangan/pemilik menautkan penjualan toko ke pesanan spare part portal (bila tidak tertaut otomatis). */
export async function linkPortalOrderSale(ctx: ActorContext, input: z.input<typeof linkSchema>, opts: { tx?: Tx } = {}): Promise<PortalOrderRow> {
  await authorize(ctx, "p3.partner_supply.read", { tx: opts.tx });
  const data = parseInput(linkSchema, input, { posSaleId: "Transaksi toko" });
  return runService(ctx, opts, async (tx) => {
    const [o] = await tx.select().from(partnerPortalOrders).where(eq(partnerPortalOrders.id, data.portalOrderId)).for("update").limit(1);
    if (!o || o.kind !== "spare_part") throw new NotFoundError("Pesanan spare part tidak ditemukan.");
    if (o.status !== "submitted") throw new DomainError("PORTAL_ORDER_DONE", `Pesanan sudah ${label("portal_order_status", o.status).toLowerCase()}.`);
    const [sale] = await tx.select().from(posSales).where(eq(posSales.id, data.posSaleId)).limit(1);
    if (!sale || sale.customerId !== o.customerId) throw ValidationError.field("posSaleId", "Transaksi toko bukan untuk pelanggan mitra ini.");
    if (sale.priceKind !== "partner") throw ValidationError.field("posSaleId", "Spare part mitra wajib memakai harga mitra (BR-18).");
    return linkSaleToPortalOrder(tx, o, sale.id, ctx.now, sale.number);
  });
}

// =====================================================================================================================
// KP-4: status pesanan & pengiriman di portal
// =====================================================================================================================

export type PortalOrderView = PortalOrderRow & {
  orderNumber: string | null;
  orderStatus: string | null;
  slaDueAt: Date | null;
  trips: { id: string; number: string; status: string; scheduledDate: string; completedAt: Date | null; deliveredVolumeL: number | null; hasSignature: boolean; signatureAttachmentId: string | null; receiptStatus: string | null; receivedVolumeL: number | null }[];
  saleNumber: string | null;
};

/** Pesanan portal tenant (tanpa otorisasi; pemanggil memastikan tenant). */
export async function portalOrdersOf(tx: Tx, tenantId: string, opts: { limit?: number } = {}): Promise<PortalOrderView[]> {
  const rows = await tx.select().from(partnerPortalOrders).where(eq(partnerPortalOrders.tenantId, tenantId)).orderBy(desc(partnerPortalOrders.submittedAt)).limit(opts.limit ?? 100);
  if (!rows.length) return [];
  const orderIds = rows.map((r) => r.orderId).filter((x): x is string => !!x);
  const orderRows = orderIds.length ? await tx.select({ id: orders.id, number: orders.number, status: orders.status, slaDueAt: orders.slaDueAt }).from(orders).where(inArray(orders.id, orderIds)) : [];
  const tripRows = orderIds.length ? await tx.select().from(trips).where(inArray(trips.orderId, orderIds)).orderBy(asc(trips.sequenceInOrder)) : [];
  const receipts = tripRows.length
    ? await tx
        .select({ tripId: waterSupplyReceipts.tripId, status: waterSupplyReceipts.status, receivedVolumeL: waterSupplyReceipts.receivedVolumeL })
        .from(waterSupplyReceipts)
        .where(and(inArray(waterSupplyReceipts.tripId, tripRows.map((t) => t.id)), eq(waterSupplyReceipts.tenantId, tenantId)))
    : [];
  const saleIds = rows.map((r) => r.posSaleId).filter((x): x is string => !!x);
  const sales = saleIds.length ? await tx.select({ id: posSales.id, number: posSales.number }).from(posSales).where(inArray(posSales.id, saleIds)) : [];
  return rows.map((r) => {
    const o = orderRows.find((x) => x.id === r.orderId);
    return {
      ...r,
      orderNumber: o?.number ?? null,
      orderStatus: o?.status ?? null,
      slaDueAt: o?.slaDueAt ?? null,
      trips: tripRows
        .filter((t) => t.orderId === r.orderId)
        .map((t) => {
          const rc = receipts.find((x) => x.tripId === t.id);
          return {
            id: t.id,
            number: t.number,
            status: t.status,
            scheduledDate: t.scheduledDate,
            completedAt: t.completedAt,
            deliveredVolumeL: t.deliveredVolumeL,
            hasSignature: !!t.signatureAttachmentId,
            signatureAttachmentId: t.signatureAttachmentId ?? null,
            receiptStatus: rc?.status ?? null,
            receivedVolumeL: rc?.receivedVolumeL ?? null,
          };
        }),
      saleNumber: sales.find((s) => s.id === r.posSaleId)?.number ?? null,
    };
  });
}

/** Pesanan spare part portal yang menunggu konfirmasi kasir (tenant EQUA; pull POS toko & layar kantor). */
export async function pendingSparePartOrders(tx: Tx) {
  return tx
    .select()
    .from(partnerPortalOrders)
    .where(and(eq(partnerPortalOrders.kind, "spare_part"), eq(partnerPortalOrders.status, "submitted")))
    .orderBy(asc(partnerPortalOrders.submittedAt));
}

export function portalOrderStatusText(o: Pick<PortalOrderView, "kind" | "status" | "orderStatus">): string {
  if (o.kind === "water" && o.orderStatus) return label("order_status", o.orderStatus);
  return label("portal_order_status", o.status);
}

