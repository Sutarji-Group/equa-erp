/**
 * M7 — retur barang toko oleh pelanggan (US-M7-01 KP-5, PTB-46).
 *
 * - Retur pada shift yang SAMA dilakukan kasir lewat VOID di POS (kerangka M6; stok kembali lewat kait kebijakan toko).
 * - Setelah shift/hari itu: Admin Keuangan mencatat barang yang kembali (sebagian/semua) → stok kembali dengan HPP saat
 *   jual; event `store_return.recorded` agar M5 menerbitkan NOTA KREDIT (tempo) / pengembalian dana (tunai/QRIS) dan M11
 *   membalik pendapatan & HPP. Nilai > PAR-21 → persetujuan pemilik `correction` (BR-38).
 */
import "server-only";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { posSaleLines, posSales, shifts } from "@/db/schema";
import { newId } from "@/lib/ids";
import { formatRupiah } from "@/lib/money";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit, queryEvents } from "@/server/core/events";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { postStockMovement } from "@/server/modules/m6-pos";

import { loadOutlet, loadProductsById } from "./common";

export const storeReturnSchema = z
  .object({
    saleId: z.uuid(),
    lines: z.array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(100_000) }).strict()).min(1, { error: "Pilih barang yang diretur." }).max(50),
    reason: z.string().trim().min(5, { error: "Alasan retur wajib diisi (minimal 5 karakter)." }).max(300),
  })
  .strict();

type SaleRow = typeof posSales.$inferSelect;
type ReturnPlan = { returnId: string; lines: { productId: string; quantity: number; unitPrice: number; lineTotal: number; unitCost: number }[]; amount: number; cogs: number; reason: string };

/** Barang yang sudah diretur per transaksi (dari event `store_return.recorded`). */
export async function returnedQuantities(tx: Tx, saleId: string): Promise<Map<string, number>> {
  const evs = await queryEvents(tx, { type: "store_return.recorded", objectType: "pos_sale", objectId: saleId, limit: 500 });
  const out = new Map<string, number>();
  for (const e of evs) {
    const p = e.payload as { lines?: { productId: string; quantity: number }[] };
    for (const l of p.lines ?? []) out.set(l.productId, (out.get(l.productId) ?? 0) + l.quantity);
  }
  return out;
}

async function planReturn(tx: Tx, sale: SaleRow, data: z.output<typeof storeReturnSchema>): Promise<ReturnPlan> {
  const lines = await tx.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, sale.id));
  const already = await returnedQuantities(tx, sale.id);
  const byProduct = new Map<string, { qty: number; unitPrice: number; unitCost: number }>();
  for (const l of lines) {
    const cur = byProduct.get(l.productId) ?? { qty: 0, unitPrice: l.unitPrice, unitCost: l.unitCost ?? 0 };
    cur.qty += l.quantity;
    byProduct.set(l.productId, cur);
  }
  const names = await loadProductsById(
    tx,
    data.lines.map((l) => l.productId),
  );
  const planned = data.lines.map((l) => {
    const sold = byProduct.get(l.productId);
    if (!sold) throw new DomainError("RETURN_PRODUCT_UNKNOWN", "Barang yang diretur tidak ada di transaksi ini.");
    const rest = sold.qty - (already.get(l.productId) ?? 0);
    if (l.quantity > rest) throw new DomainError("RETURN_TOO_MANY", `${names.get(l.productId)?.name ?? "Barang"}: sisa yang dapat diretur ${rest}.`);
    // Diskon transaksi dibagi proporsional ke nilai baris.
    const gross = l.quantity * sold.unitPrice;
    const discount = sale.subtotal > 0 ? Math.round((sale.discountAmount * gross) / sale.subtotal) : 0;
    return { productId: l.productId, quantity: l.quantity, unitPrice: sold.unitPrice, lineTotal: gross - discount, unitCost: sold.unitCost };
  });
  return {
    returnId: newId(),
    lines: planned,
    amount: planned.reduce((s, l) => s + l.lineTotal, 0),
    cogs: planned.reduce((s, l) => s + l.quantity * l.unitCost, 0),
    reason: data.reason,
  };
}

async function applyReturn(tx: Tx, ctx: ActorContext, sale: SaleRow, plan: ReturnPlan, opts: { approvalId: string | null; createdBy: string | null }) {
  const outlet = await loadOutlet(tx, sale.outletId);
  const today = ctxBusinessDate(ctx);
  for (const l of plan.lines) {
    await postStockMovement(tx, {
      tenantId: sale.tenantId,
      outletId: sale.outletId,
      productId: l.productId,
      kind: "correction",
      quantity: l.quantity,
      unitCost: l.unitCost || null,
      businessDate: today,
      occurredAt: ctx.now,
      source: { type: "store_return", id: plan.returnId },
      createdBy: opts.createdBy,
      note: `Retur pelanggan ${sale.number ?? sale.localNumber}`,
    });
  }
  await auditRecord(tx, {
    ctx,
    objectType: "pos_sale",
    objectId: sale.id,
    action: "customer_return",
    after: { returnId: plan.returnId, amount: plan.amount, lines: plan.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) },
    reason: plan.reason,
    rule: opts.approvalId ? "6.2a" : "PTB-46",
  });
  await emit(
    tx,
    "store_return.recorded",
    {
      storeReturnId: plan.returnId,
      posSaleId: sale.id,
      posSaleNumber: sale.number,
      outletId: outlet.id,
      customerId: sale.customerId,
      method: sale.paymentMethod,
      amount: plan.amount,
      cogs: plan.cogs,
      lines: plan.lines,
      reason: plan.reason,
      approvalId: opts.approvalId,
      businessDate: today,
    },
    { ctx, tenantId: sale.tenantId, objectType: "pos_sale", objectId: sale.id, businessDate: today },
  );
  return plan;
}

/**
 * Catat retur barang setelah shift transaksi ditutup (Admin Keuangan). Shift masih terbuka → kasir memakai void.
 * > PAR-21 → persetujuan pemilik (`correction`, objek `store_return`).
 */
export async function recordStoreReturn(ctx: ActorContext, input: z.input<typeof storeReturnSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.pos_sale.correct", { tx: opts.tx, objectType: "pos_sale", objectId: input.saleId });
  const data = parseInput(storeReturnSchema, input, { reason: "Alasan", lines: "Barang retur" });
  return runService(ctx, opts, async (tx) => {
    const [sale] = await tx.select().from(posSales).where(eq(posSales.id, data.saleId)).for("update").limit(1);
    if (!sale || sale.tenantId !== ctx.tenantId) throw new NotFoundError("Transaksi tidak ditemukan.");
    const outlet = await loadOutlet(tx, sale.outletId);
    if (outlet.kind !== "store") throw new DomainError("NOT_STORE_SALE", "Retur barang hanya untuk transaksi toko.");
    if (sale.isReversal || sale.status !== "valid") throw new DomainError("SALE_NOT_VALID", "Hanya transaksi Sah yang dapat diretur.");
    const [shift] = await tx.select().from(shifts).where(and(eq(shifts.id, sale.shiftId))).limit(1);
    if (shift?.status === "open") {
      throw new DomainError("USE_VOID_SAME_SHIFT", "Shift transaksi ini masih terbuka — retur hari yang sama dilakukan kasir lewat void di POS.");
    }
    const plan = await planReturn(tx, sale, data);
    const limit = await params.get(tx, "PAR-21", ctxBusinessDate(ctx));
    if (plan.amount > limit.amount_gt) {
      const req = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "store_return",
          objectId: plan.returnId,
          amount: plan.amount,
          reason: `Retur barang toko ${sale.number ?? sale.localNumber} ${formatRupiah(plan.amount)}: ${plan.reason}`,
          payload: { saleId: sale.id, lines: plan.lines, amount: plan.amount, cogs: plan.cogs, reason: plan.reason, link: `/outlet/shift/${sale.shiftId}` },
        },
        { tx },
      );
      await auditRecord(tx, { ctx, objectType: "pos_sale", objectId: sale.id, action: "request_customer_return", after: { approvalId: req.id, amount: plan.amount }, reason: plan.reason, rule: "BR-38" });
      return { status: "pending_approval" as const, approval: req, plan };
    }
    await applyReturn(tx, ctx, sale, plan, { approvalId: null, createdBy: ctx.userId });
    return { status: "applied" as const, approval: null, plan };
  });
}

export async function onStoreReturnApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const payload = request.payload as { saleId: string; lines: ReturnPlan["lines"]; amount: number; cogs: number; reason: string };
  const [sale] = await tx.select().from(posSales).where(eq(posSales.id, payload.saleId)).for("update").limit(1);
  if (!sale || sale.status !== "valid") return { effect: "none" };
  const already = await returnedQuantities(tx, sale.id);
  const lines = await tx.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, sale.id));
  for (const l of payload.lines) {
    const sold = lines.filter((x) => x.productId === l.productId).reduce((s, x) => s + x.quantity, 0);
    if (l.quantity > sold - (already.get(l.productId) ?? 0)) return { effect: "none", reason: "Barang sudah diretur sebelumnya." };
  }
  await applyReturn(tx, ctx, sale, { returnId: request.objectId, lines: payload.lines, amount: payload.amount, cogs: payload.cogs, reason: payload.reason }, { approvalId: request.id, createdBy: request.requesterUserId });
  return { effect: "applied", returnId: request.objectId };
}
