/**
 * M7 — kebijakan POS TOKO (`PosKindPolicy` kind `store`) di atas kerangka POS M6 (D-07, PRD 7.7.2):
 *
 * - Harga: pelanggan bertanda mitra toko → harga mitra, selain itu (termasuk "umum") harga umum; kasir tidak memilih
 *   harga (BR-15, BR-18; US-M7-01 KP-1).
 * - Cara bayar: tunai, QRIS statis, tempo mitra (US-M7-04). Diskon per transaksi ≤ PAR-14 dengan alasan; di atasnya
 *   transaksi "menunggu persetujuan pemilik" (`store_discount`) dan tidak dapat diselesaikan sampai disetujui (BR-17).
 * - Stok berkurang saat transaksi berlaku; stok 0 / kurang tidak dapat dijual (BR-28; US-M7-01 KP-4). Barang baru yang
 *   belum disetujui Admin Keuangan tidak dapat dijual (US-M7-02 KP-2).
 * - Void (M6) mengembalikan stok; transaksi menunggu persetujuan yang belum diputuskan saat tutup shift dianggap
 *   ditolak (6.2a "Dianggap ditolak di akhir shift").
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { approvalRequests, posSaleLines, posSales } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { wibToUtc } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize } from "@/server/core/rbac";
import {
  completePendingSale,
  postStockMovement,
  rejectPendingSale,
  type PosKindPolicy,
  type PosSaleDecision,
  type PosSaleValidateArgs,
} from "@/server/modules/m6-pos";

import { balancesNow, loadCustomer, loadProductsById, priceKindForCustomer, storeRules, sumByProduct } from "./common";
import { evaluateStoreCredit } from "./credit";
import { evaluateReorder } from "./reorder";

/** Jenis persetujuan transaksi toko (pos_sale). */
export const STORE_SALE_APPROVAL_TYPES = ["store_discount", "store_credit_sale"] as const;

/** Diskon melampaui PAR-14 (perbandingan bilangan bulat: diskon × 100 > subtotal × persen maks). */
export function discountExceedsLimit(discountAmount: number, subtotal: number, maxPercent: number): boolean {
  return discountAmount * 100 > subtotal * maxPercent;
}

async function assertSellable(args: PosSaleValidateArgs): Promise<void> {
  const { tx, outlet, lines } = args;
  const qty = sumByProduct(lines);
  const byId = await loadProductsById(tx, [...qty.keys()]);
  const bal = await balancesNow(tx, outlet.id, [...qty.keys()]);
  for (const [productId, q] of qty) {
    const p = byId.get(productId);
    if (!p) throw new NotFoundError("Barang tidak ditemukan.");
    if (p.status === "pending_approval") {
      throw new DomainError("PRODUCT_PENDING", `${p.name} masih menunggu persetujuan Admin Keuangan dan belum dapat dijual.`);
    }
    if (p.status !== "active") throw new DomainError("PRODUCT_INACTIVE", `${p.name} nonaktif dan tidak dapat dijual.`);
    const available = bal.get(productId)?.quantity ?? 0;
    // BR-28: barang tanpa nota tidak masuk stok — stok 0 tidak dapat dijual; penjualan tidak boleh melebihi stok.
    if (available <= 0) {
      throw new DomainError("STOCK_EMPTY", `Stok ${p.name} 0 — barang tanpa nota tidak dapat dijual. Catat penerimaan barang (nota pemasok) lebih dulu.`);
    }
    if (available < q) {
      throw new DomainError("STOCK_INSUFFICIENT", `Stok ${p.name} tinggal ${available} ${p.unit}; tidak dapat menjual ${q}. Catat penerimaan barang lebih dulu bila ada barang baru.`);
    }
  }
}

async function validateStoreSale(args: PosSaleValidateArgs): Promise<PosSaleDecision> {
  const { tx, ctx, outlet, customerId, input, subtotal, discountAmount, total, meta } = args;
  const decision: PosSaleDecision = { status: "valid", approvals: [] };
  if (customerId) {
    const c = await loadCustomer(tx, customerId);
    if (!c || c.tenantId !== outlet.tenantId || !c.isActive) throw new DomainError("CUSTOMER_NOT_FOUND", "Pelanggan tidak ditemukan atau nonaktif. Pilih pelanggan lain atau \"Umum\".");
  }
  await assertSellable(args);

  // --- Diskon per transaksi (BR-17, PAR-14).
  if (discountAmount > 0) {
    const reason = input.discountReason?.trim() ?? "";
    if (reason.length < 3) throw new DomainError("DISCOUNT_REASON_REQUIRED", "Diskon wajib disertai alasan.");
    const { max_percent } = await params.get(tx, "PAR-14", meta.businessDate);
    if (discountExceedsLimit(discountAmount, subtotal, max_percent)) {
      await authorize(ctx, "m7.discount.request", { tx, objectType: "pos_sale", objectId: input.saleId });
      const pct = Math.round((discountAmount / subtotal) * 10_000) / 100;
      decision.status = "pending_approval";
      decision.approvals!.push({
        type: "store_discount",
        amount: discountAmount,
        reason: `Diskon ${pct}% (${formatRupiah(discountAmount)}) dari ${formatRupiah(subtotal)} melebihi ${max_percent}% (PAR-14). Alasan kasir: ${reason}`,
      });
    }
  }

  // --- Tempo mitra (US-M7-04).
  if (input.paymentMethod === "credit") {
    await authorize(ctx, "m7.credit_sale.create", { tx, objectType: "pos_sale", objectId: input.saleId });
    const rules = await storeRules(tx, meta.businessDate, outlet.tenantId);
    const delayMs = meta.fieldValues.syncedAt.getTime() - meta.deviceTime.getTime();
    // US-M7-04 KP-4 / PTB-42: "offline" ditentukan server dari jeda waktu perangkat → sinkron, BUKAN dari penanda klien
    // (`creditOffline` hanya informasi) — tempo daring selalu melewati kontrol kredit penuh.
    const offline = delayMs > rules.credit_offline_after_minutes * 60_000;
    const check = await evaluateStoreCredit(tx, { tenantId: outlet.tenantId, customerId, amount: total });
    if (!check.ok && (check.reason === "customer_required" || check.reason === "not_partner")) {
      throw new DomainError(check.reason === "customer_required" ? "CREDIT_CUSTOMER_REQUIRED" : "CREDIT_NOT_PARTNER", check.message);
    }
    if (offline) {
      // PTB-42: tempo offline memakai eksposur sinkron terakhir di perangkat — melampaui batas karena transaksi lain
      // diterima & ditandai tinjauan FA; pelanggan Ditahan/Tunai TIDAK pernah Sah otomatis → menunggu persetujuan pemilik.
      decision.creditOffline = true;
      if (!check.ok && check.reason === "over_limit") {
        decision.conflict = `Tempo dicatat saat offline; menurut server: ${check.message}`;
      } else if (!check.ok) {
        decision.status = "pending_approval";
        decision.conflict = `Tempo dicatat saat offline, tetapi ${check.message.replace(/ Pilih tunai.*$/, "")} — menunggu keputusan pemilik.`;
        decision.approvals!.push({ type: "store_credit_sale", amount: total, reason: `Tempo dicatat saat offline (PTB-42) untuk pelanggan yang menurut server: ${check.message.replace(/ Pilih tunai.*$/, "")}` });
      }
    } else if (!check.ok) {
      if (input.requestApproval && check.canRequestApproval) {
        decision.status = "pending_approval";
        decision.approvals!.push({ type: "store_credit_sale", amount: total, reason: `${check.message.replace(/ Pilih tunai.*$/, "")} Kasir mengajukan persetujuan pemilik.` });
      } else {
        throw new DomainError(`CREDIT_${check.reason.toUpperCase()}`, check.message);
      }
    }
  }
  return decision;
}

/** Tenggat persetujuan transaksi = jam `m6.pos_rules.void_approval_deadline_time` pada tanggal bisnis shift (6.2a). */
async function saleApprovalDeadline(tx: Tx, tenantId: string, outletId: string, businessDate: string): Promise<Date> {
  const rules = await params.get(tx, "m6.pos_rules", businessDate, { tenantId, outletId });
  return wibToUtc(businessDate, rules.void_approval_deadline_time);
}

/** Kait "menunggu persetujuan": ajukan persetujuan pemilik per alasan (diskon / tempo). */
async function submitSaleApprovals(args: Parameters<NonNullable<PosKindPolicy["afterSalePending"]>>[0]): Promise<void> {
  const { tx, ctx, outlet, shift, sale, decision } = args;
  const deadlineAt = await saleApprovalDeadline(tx, outlet.tenantId, outlet.id, shift.businessDate);
  const customer = sale.customerId ? await loadCustomer(tx, sale.customerId) : null;
  for (const a of decision.approvals ?? []) {
    const req = await approvals.submit(
      ctx,
      {
        type: a.type as (typeof STORE_SALE_APPROVAL_TYPES)[number],
        objectType: "pos_sale",
        objectId: sale.id,
        amount: a.amount ?? sale.total,
        reason: `${outlet.name} · ${sale.localNumber} · ${formatRupiah(sale.total)}${customer ? ` · ${customer.name}` : ""}. ${a.reason}`.slice(0, 1000),
        payload: {
          outletId: outlet.id,
          outletName: outlet.name,
          shiftId: shift.id,
          saleNumber: sale.number,
          localNumber: sale.localNumber,
          subtotal: sale.subtotal,
          discountAmount: sale.discountAmount,
          discountPercent: sale.discountPercent,
          total: sale.total,
          method: sale.paymentMethod,
          customerName: customer?.name ?? null,
          link: `/outlet/shift/${shift.id}`,
        },
        deadlineAt,
        businessDate: shift.businessDate,
      },
      { tx },
    );
    if (a.type === "store_discount") await tx.update(posSales).set({ discountApprovalId: req.id }).where(eq(posSales.id, sale.id));
  }
}

/** Stok keluar per barang (satu mutasi per barang per transaksi) + HPP per baris (sekali, PTB-38). */
async function postSaleStock(args: Parameters<NonNullable<PosKindPolicy["afterSaleRecorded"]>>[0]) {
  const { tx, ctx, outlet, sale } = args;
  const lines = await tx.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, sale.id));
  const qty = sumByProduct(lines);
  const lineCosts: { productId: string; quantity: number; unitCost: number }[] = [];
  let cogs = 0;
  for (const [productId, q] of qty) {
    const res = await postStockMovement(tx, {
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      productId,
      kind: "sale",
      quantity: -q,
      businessDate: sale.businessDate,
      occurredAt: sale.soldAt,
      source: { type: "pos_sale", id: sale.id },
      createdBy: ctx.userId,
      note: `Penjualan ${sale.number ?? sale.localNumber}`,
    });
    cogs += Math.abs(res.totalCost);
    lineCosts.push({ productId, quantity: q, unitCost: res.unitCost });
    await tx
      .update(posSaleLines)
      .set({ unitCost: res.unitCost, updatedAt: new Date() })
      .where(and(eq(posSaleLines.posSaleId, sale.id), eq(posSaleLines.productId, productId)));
  }
  await evaluateReorder(tx, { tenantId: outlet.tenantId, outletId: outlet.id, productIds: [...qty.keys()], now: ctx.now });
  return { cogs, lineCosts };
}

export const storePolicy: PosKindPolicy = {
  kind: "store",
  label: "Toko",
  depositSourceType: "store_shift",
  stockCountKind: "monthly_store",
  permissions: {
    saleCreate: "m7.pos_sale.create",
    saleVoid: "m7.pos_sale.void",
    saleCorrect: "m7.pos_sale.correct",
    shiftOpen: "m7.shift.open",
    shiftClose: "m7.shift.close",
    shiftRead: "m7.shift.read",
    shiftDeposit: "m7.shift_deposit.create",
    stockCount: "m7.stock_count.create",
    stockAdjustment: "m7.stock_adjustment.request",
    consumableReceipt: "m7.purchase_receipt.create",
  },
  priceKind: ({ customerId }) => (customerId ? "partner" : "general"),
  resolvePriceKind: ({ tx, outlet, customerId }) => priceKindForCustomer(tx, outlet.tenantId, customerId),
  acceptsCustomer: true,
  productLine: "store",
  paymentMethods: ["cash", "qris", "credit"],
  allowsDiscount: true,

  validateSale: validateStoreSale,
  afterSalePending: submitSaleApprovals,

  async afterSaleRecorded(args) {
    const { tx, outlet, sale } = args;
    const { cogs, lineCosts } = await postSaleStock(args);
    const customer = sale.customerId ? await loadCustomer(tx, sale.customerId) : null;
    if (sale.paymentMethod === "credit" && sale.creditOffline) {
      await notify(tx, {
        event: "store.credit_offline_review",
        tenantId: outlet.tenantId,
        title: `Tempo toko dicatat offline: ${customer?.name ?? "pelanggan"} ${formatRupiah(sale.total)}`,
        body: `${outlet.name} · ${sale.number ?? sale.localNumber}. Perangkat memakai data eksposur sinkron terakhir (PTB-42) — tinjau batas kredit pelanggan.`,
        objectType: "pos_sale",
        objectId: sale.id,
        valueAmount: sale.total,
        link: `/outlet/shift/${sale.shiftId}`,
        now: args.ctx.now,
      });
    }
    const approvalRows = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.objectType, "pos_sale"), eq(approvalRequests.objectId, sale.id), eq(approvalRequests.status, "approved")));
    return {
      payload: {
        cogs,
        lineCosts,
        priceKind: sale.priceKind,
        discountReason: sale.discountReason,
        creditOffline: sale.creditOffline,
        paymentTermDays: sale.paymentMethod === "credit" ? (customer?.paymentTermDays ?? null) : null,
        approvalIds: approvalRows.map((a) => a.id),
      },
    };
  },

  async afterSaleVoided({ tx, ctx, outlet, sale }) {
    // Barang kembali ke stok dengan HPP saat jual (void di shift terbuka atau pembalik setelah tutup, US-M7-01 KP-5).
    const lines = await tx.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, sale.id));
    const byProduct = new Map<string, { qty: number; cost: number }>();
    for (const l of lines) {
      const cur = byProduct.get(l.productId) ?? { qty: 0, cost: l.unitCost ?? 0 };
      cur.qty += l.quantity;
      byProduct.set(l.productId, cur);
    }
    for (const [productId, v] of byProduct) {
      if (v.qty <= 0) continue;
      await postStockMovement(tx, {
        tenantId: outlet.tenantId,
        outletId: outlet.id,
        productId,
        kind: "sale_void",
        quantity: v.qty,
        unitCost: v.cost || null,
        businessDate: ctx.businessDate ?? sale.businessDate,
        occurredAt: ctx.now,
        source: { type: "pos_sale", id: sale.id },
        createdBy: ctx.userId,
        note: `Void ${sale.number ?? sale.localNumber}`,
      });
    }
  },

  async onShiftClosing({ tx, ctx, outlet, shift }) {
    // 6.2a: diskon/tempo yang belum diputuskan saat tutup shift → dianggap ditolak.
    const pending = await tx.select().from(posSales).where(and(eq(posSales.shiftId, shift.id), eq(posSales.status, "pending_approval")));
    let rejected = 0;
    for (const sale of pending) {
      const open = await tx
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.objectType, "pos_sale"),
            eq(approvalRequests.objectId, sale.id),
            eq(approvalRequests.status, "submitted"),
            inArray(approvalRequests.type, [...STORE_SALE_APPROVAL_TYPES]),
          ),
        );
      for (const req of open) {
        // Handler pembatalan ikut membatalkan persetujuan saudara — periksa ulang statusnya.
        const [cur] = await tx.select({ status: approvalRequests.status }).from(approvalRequests).where(eq(approvalRequests.id, req.id)).limit(1);
        if (cur?.status !== "submitted") continue;
        await approvals.cancel(systemContext({ tenantId: outlet.tenantId, now: ctx.now }), req.id, "Shift ditutup sebelum diputuskan — dianggap ditolak di akhir shift (6.2a).", { tx });
      }
      const res = await rejectPendingSale(tx, systemContext({ tenantId: outlet.tenantId, now: ctx.now }), sale.id, {
        reason: "Shift ditutup sebelum persetujuan diputuskan — dianggap ditolak (6.2a).",
        action: "reject_at_shift_close",
      });
      if (res || open.length) rejected++;
    }
    const counted = await tx.select().from(posSales).where(and(eq(posSales.shiftId, shift.id), eq(posSales.status, "valid")));
    return {
      storeDiscountTotal: counted.reduce((s, x) => s + x.discountAmount, 0),
      storeCreditSales: counted.filter((x) => x.paymentMethod === "credit").reduce((s, x) => s + x.total, 0),
      storePendingRejected: rejected,
    };
  },
};

// =====================================================================================================================
// Handler persetujuan transaksi toko (`store_discount`, `store_credit_sale`) — ctx = pemilik / sistem
// =====================================================================================================================

/** Disetujui: bila tidak ada persetujuan lain yang masih menunggu → stok dicek ulang lalu transaksi berlaku. */
export async function onStoreSaleApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [sale] = await tx.select().from(posSales).where(eq(posSales.id, request.objectId)).limit(1);
  if (!sale || sale.status !== "pending_approval") return { effect: "none" };
  const others = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.objectType, "pos_sale"),
        eq(approvalRequests.objectId, sale.id),
        inArray(approvalRequests.type, [...STORE_SALE_APPROVAL_TYPES]),
      ),
    );
  if (others.some((o) => o.id !== request.id && o.status === "submitted")) return { effect: "waiting_other_approval" };
  if (others.some((o) => o.id !== request.id && (o.status === "rejected" || o.status === "expired" || o.status === "cancelled"))) {
    await rejectPendingSale(tx, ctx, sale.id, { reason: "Persetujuan lain untuk transaksi ini ditolak." });
    return { effect: "rejected_other" };
  }
  const lines = await tx.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, sale.id));
  const qty = sumByProduct(lines);
  const bal = await balancesNow(tx, sale.outletId, [...qty.keys()]);
  const short = [...qty].find(([id, q]) => (bal.get(id)?.quantity ?? 0) < q);
  if (short) {
    await rejectPendingSale(tx, ctx, sale.id, { reason: "Stok tidak lagi cukup saat persetujuan diputuskan (BR-28).", action: "reject_stock" });
    return { effect: "rejected_stock" };
  }
  await completePendingSale(tx, ctx, sale.id, { approvalId: request.id, reason: request.decisionReason });
  return { effect: "completed" };
}

/** Ditolak / lewat tenggat / dibatalkan → transaksi Ditolak (tidak dihitung, stok tidak berubah). */
export async function onStoreSaleRejected(tx: Tx, request: ApprovalRow, ctx: ActorContext, decision: "rejected" | "expired" | "cancelled"): Promise<Record<string, unknown>> {
  const res = await rejectPendingSale(tx, ctx, request.objectId, {
    reason:
      decision === "expired"
        ? "Persetujuan lewat tenggat — dianggap ditolak di akhir shift (6.2a)."
        : decision === "cancelled"
          ? (request.cancelReason ?? "Permintaan persetujuan dibatalkan.")
          : (request.decisionReason ?? "Ditolak pemilik."),
    action: decision === "expired" ? "reject_expired" : "reject_pending",
  });
  // Persetujuan saudara (diskon + tempo) yang masih menunggu ikut dibatalkan.
  if (res) {
    const siblings = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.objectType, "pos_sale"), eq(approvalRequests.objectId, request.objectId), eq(approvalRequests.status, "submitted")));
    for (const s of siblings) {
      if (s.id === request.id || !(STORE_SALE_APPROVAL_TYPES as readonly string[]).includes(s.type)) continue;
      await approvals.cancel(systemContext({ tenantId: request.tenantId, now: ctx.now }), s.id, "Persetujuan lain untuk transaksi ini ditolak.", { tx });
    }
  }
  return { effect: res ? "rejected" : "none" };
}
