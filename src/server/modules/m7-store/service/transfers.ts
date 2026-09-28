/**
 * M7 — transfer internal bahan toko → depot sendiri (US-M7-06; PTB-37, BR-33 analog).
 *
 * - Kasir memilih depot tujuan (tenant sendiri) + baris barang (tutup, tisu, galon kosong — barang toko yang dipetakan
 *   ke bahan depot lewat `products.store_product_id`); stok toko berkurang saat DIKIRIM ("Transfer keluar").
 * - Stok depot bertambah saat operator mengonfirmasi di POS depot (M6 `m6.internal_transfer.receive`); selisih
 *   kirim–terima ditandai (M6) dan diberitahukan ke Admin Keuangan (handler event M7).
 * - Nilai = harga mitra (PTB-37) — tanpa kas/piutang; `internal_transfer.sent`/`.received` → M11 pendapatan internal L4
 *   & beban/persediaan L3 (dieliminasi saat konsolidasi). Tanpa persetujuan; dilaporkan bulanan per depot.
 * - Pengiriman ke outlet MITRA (tenant lain) bukan transfer internal — dicatat sebagai penjualan harga mitra.
 */
import "server-only";

import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { internalTransferLines, internalTransfers, outlets, products } from "@/db/schema";
import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { assignOfficialNumber } from "@/server/core/numbering";
import { authorize, authorizeAny } from "@/server/core/rbac";
import { resolveProductPrice } from "@/server/modules/m1-master";
import { postStockMovement, type FieldWriteMeta } from "@/server/modules/m6-pos";

import { balancesNow, loadOutlet, loadProductsById, monthRange, resolveStorePosOutlet, sumByProduct } from "./common";
import { evaluateReorder } from "./reorder";

type TransferRow = typeof internalTransfers.$inferSelect;

export const internalTransferSchema = z
  .object({
    transferId: z.uuid(),
    localNumber: z.string().trim().min(5).max(60),
    deviceSeq: z.number().int().min(1),
    toOutletId: z.uuid({ error: "Pilih depot tujuan." }),
    lines: z.array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(100_000) }).strict()).min(1, { error: "Isi minimal satu barang." }).max(50),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

/** Bahan depot yang dipasok barang toko (products.store_product_id). */
export async function depotMaterialFor(tx: Tx, tenantId: string, storeProductIds: readonly string[]): Promise<Map<string, string>> {
  if (!storeProductIds.length) return new Map();
  const rows = await tx
    .select({ id: products.id, storeProductId: products.storeProductId })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.line, "depot"), inArray(products.storeProductId, [...storeProductIds])));
  return new Map(rows.map((r) => [r.storeProductId!, r.id]));
}

export async function sendInternalTransfer(ctx: ActorContext, input: z.output<typeof internalTransferSchema>, meta: FieldWriteMeta) {
  const { tx } = meta;
  await authorize(ctx, "m7.internal_transfer.create", { tx, objectType: "internal_transfer", objectId: input.transferId });
  const from = await resolveStorePosOutlet(tx, ctx, meta.device);
  const to = await loadOutlet(tx, input.toOutletId).catch(() => null);
  if (!to || to.tenantId !== from.tenantId || to.kind !== "depot") {
    throw new DomainError(
      "NOT_OWN_DEPOT",
      "Tujuan bukan depot sendiri. Transfer internal hanya ke depot EQUA; pengiriman ke outlet mitra dicatat sebagai penjualan (harga mitra).",
    );
  }
  if (!to.isActive) throw new DomainError("OUTLET_INACTIVE", `${to.name} nonaktif.`);
  const qty = sumByProduct(input.lines);
  const ids = [...qty.keys()];
  const byId = await loadProductsById(tx, ids);
  const mapping = await depotMaterialFor(tx, from.tenantId, ids);
  const bal = await balancesNow(tx, from.id, ids);
  const lineValues: { productId: string; toProductId: string; quantity: number; unitValue: number }[] = [];
  for (const [productId, q] of qty) {
    const p = byId.get(productId);
    if (!p || p.tenantId !== from.tenantId || p.line !== "store") throw new NotFoundError("Barang toko tidak ditemukan.");
    const target = mapping.get(productId);
    if (!target) throw new DomainError("TRANSFER_PRODUCT_UNMAPPED", `${p.name} belum dipetakan ke bahan depot. Minta Admin Keuangan memetakan di Data master > Produk.`);
    const available = bal.get(productId)?.quantity ?? 0;
    if (available < q) throw new DomainError("STOCK_INSUFFICIENT", `Stok ${p.name} tinggal ${available} ${p.unit}; tidak dapat mengirim ${q}.`);
    let unitValue: number;
    try {
      unitValue = (await resolveProductPrice(tx, { productId, kind: "partner", date: meta.businessDate, tenantId: from.tenantId, outletId: from.id })).unitPrice;
    } catch (error) {
      if (error instanceof DomainError) throw new DomainError("NO_PARTNER_PRICE", `Harga mitra ${p.name} belum ditetapkan — nilai transfer memakai harga mitra (PTB-37).`);
      throw error;
    }
    lineValues.push({ productId, toProductId: target, quantity: q, unitValue });
  }
  const totalValue = lineValues.reduce((s, l) => s + l.quantity * l.unitValue, 0);
  const number = await assignOfficialNumber(tx, "internal_transfer", { tenantId: from.tenantId, businessDate: meta.businessDate });
  const [transfer] = await tx
    .insert(internalTransfers)
    .values({
      id: input.transferId,
      tenantId: from.tenantId,
      number,
      localNumber: input.localNumber,
      deviceSeq: input.deviceSeq,
      fromOutletId: from.id,
      toOutletId: to.id,
      status: "sent",
      businessDate: meta.businessDate,
      sentAt: meta.deviceTime,
      sentBy: ctx.userId,
      totalValue,
      notes: input.notes ?? null,
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning();
  let totalCost = 0;
  for (const l of lineValues) {
    const res = await postStockMovement(tx, {
      tenantId: from.tenantId,
      outletId: from.id,
      productId: l.productId,
      kind: "transfer_out",
      quantity: -l.quantity,
      businessDate: meta.businessDate,
      occurredAt: meta.deviceTime,
      source: { type: "internal_transfer", id: transfer!.id },
      createdBy: ctx.userId,
      note: `Transfer internal ${number} ke ${to.name}`,
    });
    totalCost += Math.abs(res.totalCost);
    await tx.insert(internalTransferLines).values({
      tenantId: from.tenantId,
      transferId: transfer!.id,
      productId: l.productId,
      toProductId: l.toProductId,
      quantitySent: l.quantity,
      unitValue: l.unitValue,
      unitCost: res.unitCost,
      lineValue: l.quantity * l.unitValue,
    });
  }
  await evaluateReorder(tx, { tenantId: from.tenantId, outletId: from.id, productIds: ids, now: ctx.now });
  await auditRecord(tx, {
    ctx,
    objectType: "internal_transfer",
    objectId: transfer!.id,
    action: "send",
    after: { number, to: to.name, totalValue, totalCost, lines: lineValues.map((l) => ({ productId: l.productId, quantity: l.quantity, unitValue: l.unitValue })) },
    reason: input.notes ?? null,
    businessDate: meta.businessDate,
  });
  await emit(
    tx,
    "internal_transfer.sent",
    { internalTransferId: transfer!.id, fromOutletId: from.id, toOutletId: to.id, totalValue, totalCost },
    { ctx, objectType: "internal_transfer", objectId: transfer!.id, businessDate: meta.businessDate },
  );
  return { transfer: transfer!, totalValue, totalCost };
}

/** Handler `internal_transfer.received`: selisih kirim–terima → Admin Keuangan (US-M7-06 KP-1). */
export async function notifyTransferDifference(tx: Tx, payload: { internalTransferId: string; hasDiscrepancy: boolean }, now: Date): Promise<void> {
  if (!payload.hasDiscrepancy) return;
  const [t] = await tx.select().from(internalTransfers).where(eq(internalTransfers.id, payload.internalTransferId)).limit(1);
  if (!t) return;
  const lines = await tx
    .select({ l: internalTransferLines, name: products.name })
    .from(internalTransferLines)
    .innerJoin(products, eq(products.id, internalTransferLines.productId))
    .where(eq(internalTransferLines.transferId, t.id));
  const [from, to] = await Promise.all([loadOutlet(tx, t.fromOutletId), loadOutlet(tx, t.toOutletId)]);
  const diffs = lines.filter((l) => l.l.quantityReceived !== null && l.l.quantityReceived !== l.l.quantitySent);
  await notify(tx, {
    event: "store.transfer_difference",
    tenantId: t.tenantId,
    title: `Selisih transfer internal ${t.number ?? t.localNumber}: ${from.name} → ${to.name}`,
    body: diffs.map((d) => `${d.name} kirim ${d.l.quantitySent}, terima ${d.l.quantityReceived}${d.l.differenceReason ? ` (${d.l.differenceReason})` : ""}`).join("; "),
    objectType: "internal_transfer",
    objectId: t.id,
    link: "/toko/laporan?tab=transfer",
    now,
  });
}

export type TransferReportRow = TransferRow & {
  fromOutletName: string;
  toOutletName: string;
  toOutletCode: string;
  lines: { productId: string; name: string; unit: string; quantitySent: number; quantityReceived: number | null; unitValue: number; lineValue: number; differenceReason: string | null }[];
};

/** Transfer internal per bulan (dilaporkan per depot, US-M7-06 KP-3). */
export async function transferReport(ctx: ActorContext, filter: { month: string; toOutletId?: string | null }, opts: { tx?: Tx } = {}): Promise<{ rows: TransferReportRow[]; byDepot: { outletId: string; outletName: string; transfers: number; totalValue: number; differences: number }[] }> {
  await authorizeAny(ctx, ["m7.internal_transfer.read", "m7.report.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const { from, to } = monthRange(filter.month);
  const conds = [eq(internalTransfers.tenantId, ctx.tenantId), gte(internalTransfers.businessDate, from), lte(internalTransfers.businessDate, to)];
  if (filter.toOutletId) conds.push(eq(internalTransfers.toOutletId, filter.toOutletId));
  const rows = await tx.select().from(internalTransfers).where(and(...conds)).orderBy(desc(internalTransfers.sentAt));
  const outletRows = await tx.select({ id: outlets.id, name: outlets.name, code: outlets.code }).from(outlets).where(eq(outlets.tenantId, ctx.tenantId));
  const oName = new Map(outletRows.map((o) => [o.id, o]));
  const ids = rows.map((r) => r.id);
  const lines = ids.length
    ? await tx
        .select({ l: internalTransferLines, name: products.name, unit: products.unit })
        .from(internalTransferLines)
        .innerJoin(products, eq(products.id, internalTransferLines.productId))
        .where(inArray(internalTransferLines.transferId, ids))
    : [];
  const out = rows.map((r) => ({
    ...r,
    fromOutletName: oName.get(r.fromOutletId)?.name ?? "—",
    toOutletName: oName.get(r.toOutletId)?.name ?? "—",
    toOutletCode: oName.get(r.toOutletId)?.code ?? "",
    lines: lines
      .filter((l) => l.l.transferId === r.id)
      .map((l) => ({ productId: l.l.productId, name: l.name, unit: l.unit, quantitySent: l.l.quantitySent, quantityReceived: l.l.quantityReceived, unitValue: l.l.unitValue, lineValue: l.l.lineValue, differenceReason: l.l.differenceReason })),
  }));
  const byDepot = new Map<string, { outletId: string; outletName: string; transfers: number; totalValue: number; differences: number }>();
  for (const r of out) {
    const cur = byDepot.get(r.toOutletId) ?? { outletId: r.toOutletId, outletName: r.toOutletName, transfers: 0, totalValue: 0, differences: 0 };
    cur.transfers++;
    cur.totalValue += r.totalValue;
    if (r.hasDifference) cur.differences++;
    byDepot.set(r.toOutletId, cur);
  }
  return { rows: out, byDepot: [...byDepot.values()].sort((a, b) => b.totalValue - a.totalValue) };
}
