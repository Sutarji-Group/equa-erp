/**
 * M7 — stok minimum & daftar pesan ulang (US-M7-03; FR-M7-02, Bab 6.3 "Stok minimum toko").
 *
 * - Saldo ≤ stok minimum (master barang) → barang masuk daftar (saldo saat terpicu, pemasok terakhir) + notifikasi kasir
 *   toko itu (`store.stock_minimum`, berlingkup outlet). Satu baris hidup (Perlu dipesan/Sudah dipesan) per barang.
 * - Kasir menandai "sudah dipesan" (tanggal, pemasok) dari POS; baris selesai otomatis saat nota penerimaan masuk.
 * - Rata-rata penjualan harian atas `m7.store_rules.average_sales_days` hari (bawaan 30).
 */
import "server-only";

import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { posSaleLines, posSales, products, purchaseReceiptLines, purchaseReceipts, reorderItems, stockBalances, suppliers } from "@/db/schema";
import { addDays, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize } from "@/server/core/rbac";
import { COUNTED_SALE, type FieldWriteMeta } from "@/server/modules/m6-pos";

import { resolveOfficeStore, resolveStorePosOutlet, storeRules } from "./common";

type ReorderRow = typeof reorderItems.$inferSelect;

/** Pemasok terakhir per barang (nota diterima terbaru, bukan pembalik). */
export async function lastSuppliers(tx: Tx, outletId: string, productIds: readonly string[]): Promise<Map<string, { supplierId: string; supplierName: string; unitCost: number; date: string }>> {
  const out = new Map<string, { supplierId: string; supplierName: string; unitCost: number; date: string }>();
  if (!productIds.length) return out;
  const rows = await tx
    .select({
      productId: purchaseReceiptLines.productId,
      supplierId: purchaseReceipts.supplierId,
      supplierName: suppliers.name,
      unitCost: purchaseReceiptLines.unitCost,
      date: purchaseReceipts.businessDate,
      createdAt: purchaseReceipts.createdAt,
    })
    .from(purchaseReceiptLines)
    .innerJoin(purchaseReceipts, eq(purchaseReceipts.id, purchaseReceiptLines.receiptId))
    .innerJoin(suppliers, eq(suppliers.id, purchaseReceipts.supplierId))
    .where(
      and(
        eq(purchaseReceipts.outletId, outletId),
        eq(purchaseReceipts.status, "received"),
        isNull(purchaseReceipts.reversalOfId),
        inArray(purchaseReceiptLines.productId, [...productIds]),
      ),
    )
    .orderBy(desc(purchaseReceipts.businessDate), desc(purchaseReceipts.createdAt));
  for (const r of rows) if (!out.has(r.productId) && r.unitCost > 0) out.set(r.productId, { supplierId: r.supplierId, supplierName: r.supplierName, unitCost: r.unitCost, date: r.date });
  return out;
}

/** Jumlah terjual per barang dalam rentang tanggal bisnis (transaksi dihitung). */
export async function soldQuantities(tx: Tx, outletId: string, from: BusinessDate, to: BusinessDate, productIds?: readonly string[]): Promise<Map<string, number>> {
  const rows = await tx
    .select({ productId: posSaleLines.productId, qty: sql<string>`coalesce(sum(${posSaleLines.quantity}), 0)` })
    .from(posSaleLines)
    .innerJoin(posSales, eq(posSales.id, posSaleLines.posSaleId))
    .where(
      and(
        eq(posSaleLines.outletId, outletId),
        gte(posSaleLines.businessDate, from),
        lte(posSaleLines.businessDate, to),
        COUNTED_SALE,
        ...(productIds?.length ? [inArray(posSaleLines.productId, [...productIds])] : []),
      ),
    )
    .groupBy(posSaleLines.productId);
  return new Map(rows.map((r) => [r.productId, Number(r.qty)]));
}

/**
 * Evaluasi daftar pesan ulang untuk barang tertentu setelah mutasi stok (KP-1): saldo ≤ minimum dan belum ada baris
 * hidup → baris baru + notifikasi kasir toko. Mengembalikan baris yang baru dibuat.
 */
export async function evaluateReorder(tx: Tx, input: { tenantId: string; outletId: string; productIds: readonly string[]; now: Date }): Promise<ReorderRow[]> {
  if (!input.productIds.length) return [];
  const prods = await tx
    .select()
    .from(products)
    .where(and(inArray(products.id, [...new Set(input.productIds)]), eq(products.line, "store"), eq(products.status, "active")));
  const watched = prods.filter((p) => p.minStock !== null && p.tenantId === input.tenantId);
  if (!watched.length) return [];
  const bal = await tx
    .select({ productId: stockBalances.productId, quantity: stockBalances.quantity })
    .from(stockBalances)
    .where(and(eq(stockBalances.outletId, input.outletId), inArray(stockBalances.productId, watched.map((p) => p.id))));
  const qty = new Map(bal.map((b) => [b.productId, b.quantity]));
  const live = await tx
    .select({ productId: reorderItems.productId })
    .from(reorderItems)
    .where(and(eq(reorderItems.outletId, input.outletId), inArray(reorderItems.status, ["open", "ordered"]), inArray(reorderItems.productId, watched.map((p) => p.id))));
  const liveSet = new Set(live.map((l) => l.productId));
  const due = watched.filter((p) => !liveSet.has(p.id) && (qty.get(p.id) ?? 0) <= p.minStock!);
  if (!due.length) return [];
  const last = await lastSuppliers(
    tx,
    input.outletId,
    due.map((p) => p.id),
  );
  const created = await tx
    .insert(reorderItems)
    .values(
      due.map((p) => ({
        tenantId: input.tenantId,
        outletId: input.outletId,
        productId: p.id,
        status: "open" as const,
        triggeredAt: input.now,
        balanceAtTrigger: qty.get(p.id) ?? 0,
        lastSupplierId: last.get(p.id)?.supplierId ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning();
  if (created.length) {
    const names = created.map((c) => {
      const p = due.find((d) => d.id === c.productId)!;
      return `${p.name} (sisa ${c.balanceAtTrigger} ${p.unit}, minimum ${p.minStock})`;
    });
    await notify(tx, {
      event: "store.stock_minimum",
      tenantId: input.tenantId,
      recipients: { roles: ["store_cashier"], scope: { outletId: input.outletId } },
      title: created.length === 1 ? `Stok minimum: ${names[0]}` : `${created.length} barang mencapai stok minimum`,
      body: `${names.join("; ")}. Lihat daftar pesan ulang di POS.`,
      objectType: "outlet",
      objectId: input.outletId,
      link: "/pos",
      now: input.now,
    });
  }
  return created;
}

/** Nota masuk → baris hidup barang itu selesai otomatis (KP-2), lalu dievaluasi ulang. */
export async function closeReorderOnReceipt(tx: Tx, input: { tenantId: string; outletId: string; productIds: readonly string[]; receiptId: string; now: Date }): Promise<number> {
  if (!input.productIds.length) return 0;
  const closed = await tx
    .update(reorderItems)
    .set({ status: "closed", closedAt: input.now, closedByReceiptId: input.receiptId, updatedAt: new Date() })
    .where(and(eq(reorderItems.outletId, input.outletId), inArray(reorderItems.status, ["open", "ordered"]), inArray(reorderItems.productId, [...input.productIds])))
    .returning({ id: reorderItems.id });
  await evaluateReorder(tx, input);
  return closed.length;
}

// =====================================================================================================================
// Tandai "sudah dipesan" (POS kasir, perintah sinkron)
// =====================================================================================================================

export const markOrderedSchema = z
  .object({
    itemId: z.uuid(),
    supplierId: z.uuid({ error: "Pilih pemasok tempat memesan." }),
    /** Tanggal pesan (bawaan tanggal bisnis perangkat). */
    orderedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

export async function markReorderOrdered(ctx: ActorContext, input: z.output<typeof markOrderedSchema>, meta: FieldWriteMeta): Promise<ReorderRow> {
  const { tx } = meta;
  await authorize(ctx, "m7.reorder.update", { tx, objectType: "reorder_item", objectId: input.itemId });
  const [item] = await tx.select().from(reorderItems).where(eq(reorderItems.id, input.itemId)).for("update").limit(1);
  const outlet = await resolveStorePosOutlet(tx, ctx, meta.device);
  if (!item || item.tenantId !== ctx.tenantId || item.outletId !== outlet.id) throw new NotFoundError("Barang di daftar pesan ulang tidak ditemukan.");
  if (item.status === "closed") throw new DomainError("REORDER_CLOSED", "Barang ini sudah diterima (nota masuk); daftar pesan ulang sudah selesai.");
  const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1);
  if (!sup || sup.tenantId !== ctx.tenantId) throw new NotFoundError("Pemasok tidak ditemukan.");
  if (sup.status !== "active") throw new DomainError("SUPPLIER_NOT_ACTIVE", `Pemasok ${sup.name} belum aktif. Pilih pemasok yang sudah disetujui Admin Keuangan.`);
  const orderedAt = input.orderedOn ? new Date(`${input.orderedOn}T05:00:00.000Z`) : meta.deviceTime;
  const [updated] = await tx
    .update(reorderItems)
    .set({ status: "ordered", orderedAt, orderedSupplierId: sup.id, orderedBy: ctx.userId, updatedAt: new Date() })
    .where(eq(reorderItems.id, item.id))
    .returning();
  await auditRecord(tx, {
    ctx,
    objectType: "reorder_item",
    objectId: item.id,
    action: "mark_ordered",
    before: { status: item.status },
    after: { status: "ordered", supplier: sup.name, orderedAt: orderedAt.toISOString() },
    businessDate: meta.businessDate,
  });
  return updated!;
}

// =====================================================================================================================
// Daftar (POS, kantor, ekspor)
// =====================================================================================================================

export type ReorderListRow = {
  id: string;
  productId: string;
  code: string;
  name: string;
  unit: string;
  minStock: number | null;
  balance: number;
  balanceAtTrigger: number;
  avgDailySales: number;
  lastSupplierId: string | null;
  lastSupplierName: string | null;
  lastUnitCost: number | null;
  status: ReorderRow["status"];
  triggeredAt: Date;
  orderedAt: Date | null;
  orderedSupplierName: string | null;
  closedAt: Date | null;
};

/** Daftar pesan ulang toko (baris hidup; `includeClosed` = juga yang selesai N hari terakhir). */
export async function reorderList(tx: Tx, input: { tenantId: string; outletId: string; date: BusinessDate; includeClosedDays?: number }): Promise<ReorderListRow[]> {
  const rules = await storeRules(tx, input.date, input.tenantId);
  const conds = [eq(reorderItems.outletId, input.outletId)];
  const rows = await tx
    .select({ r: reorderItems, p: products })
    .from(reorderItems)
    .innerJoin(products, eq(products.id, reorderItems.productId))
    .where(and(...conds))
    .orderBy(desc(reorderItems.triggeredAt));
  const cutoff = input.includeClosedDays ? new Date(Date.parse(`${addDays(input.date, -input.includeClosedDays)}T00:00:00+07:00`)) : null;
  const filtered = rows.filter(({ r }) => r.status !== "closed" || (cutoff && r.closedAt && r.closedAt >= cutoff));
  const ids = [...new Set(filtered.map(({ r }) => r.productId))];
  const [bal, sold, last] = await Promise.all([
    ids.length
      ? tx.select({ productId: stockBalances.productId, quantity: stockBalances.quantity }).from(stockBalances).where(and(eq(stockBalances.outletId, input.outletId), inArray(stockBalances.productId, ids)))
      : Promise.resolve([] as { productId: string; quantity: number }[]),
    soldQuantities(tx, input.outletId, addDays(input.date, -(rules.average_sales_days - 1)), input.date, ids),
    lastSuppliers(tx, input.outletId, ids),
  ]);
  const qty = new Map(bal.map((b) => [b.productId, b.quantity]));
  const supplierIds = [...new Set(filtered.flatMap(({ r }) => [r.lastSupplierId, r.orderedSupplierId]).filter((x): x is string => !!x))];
  const sups = supplierIds.length ? await tx.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(inArray(suppliers.id, supplierIds)) : [];
  const supName = new Map(sups.map((s) => [s.id, s.name]));
  return filtered.map(({ r, p }) => {
    const l = last.get(p.id);
    return {
      id: r.id,
      productId: p.id,
      code: p.code,
      name: p.name,
      unit: p.unit,
      minStock: p.minStock,
      balance: qty.get(p.id) ?? 0,
      balanceAtTrigger: r.balanceAtTrigger,
      avgDailySales: Math.round(((sold.get(p.id) ?? 0) / rules.average_sales_days) * 10) / 10,
      lastSupplierId: l?.supplierId ?? r.lastSupplierId,
      lastSupplierName: l?.supplierName ?? (r.lastSupplierId ? (supName.get(r.lastSupplierId) ?? null) : null),
      lastUnitCost: l?.unitCost ?? null,
      status: r.status,
      triggeredAt: r.triggeredAt,
      orderedAt: r.orderedAt,
      orderedSupplierName: r.orderedSupplierId ? (supName.get(r.orderedSupplierId) ?? null) : null,
      closedAt: r.closedAt,
    };
  });
}

/** Daftar pesan ulang untuk layar kantor / ekspor (izin `m7.reorder.read`). */
export async function getReorderList(ctx: ActorContext, input: { outletId?: string | null; includeClosedDays?: number } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.reorder.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const outlet = await resolveOfficeStore(tx, ctx, input.outletId);
  if (!outlet) return { outlet: null, rows: [] as ReorderListRow[] };
  return { outlet, rows: await reorderList(tx, { tenantId: outlet.tenantId, outletId: outlet.id, date: ctxBusinessDate(ctx), includeClosedDays: input.includeClosedDays }) };
}
