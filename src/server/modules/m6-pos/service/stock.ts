/**
 * M6 — stok bahan habis pakai & opname (US-M6-04; BR-27, BR-28 analog, PAR-32, PAR-58, PTB-37).
 *
 * - Penerimaan bahan: dari toko EQUA lewat transfer internal (dibuat M7, `internal_transfers` status Dikirim →
 *   Diterima di POS depot) atau dari pemasok lain dengan nota + foto. Tanpa pencatatan, stok tidak bertambah.
 * - Keluar = pemakaian seharusnya dari resep (dibukukan saat tutup shift, lihat depot-policy.ts).
 * - Opname mingguan: saldo sistem pada waktu hitung → selisih → usulan penyesuaian beralasan → persetujuan pemilik
 *   (tenggat 3 hari; lewat tenggat saldo TIDAK berubah, tetap di daftar) → saldo + event `stock.adjusted` (jurnal M11).
 */
import "server-only";

import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import {
  consumableReceiptLines,
  consumableReceipts,
  internalTransferLines,
  internalTransfers,
  outlets,
  products,
  shifts,
  stockCountLines,
  stockCounts,
  suppliers,
} from "@/db/schema";
import { enumValues, label } from "@/lib/labels";
import { formatRupiah, zRupiahNonNegative } from "@/lib/money";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { authorize } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { isoWeekLabel, loadOutlet, openShiftOf, resolvePosOutlet, type FieldWriteMeta } from "./common";
import { computeShiftFigures } from "./figures";
import { consumablesOf, postStockMovement, stockBalancesOf } from "./inventory";
import { posKindPolicy } from "./policy";

export type StockCountRow = typeof stockCounts.$inferSelect;

// =====================================================================================================================
// Penerimaan bahan dari pemasok lain (nota + foto) — US-M6-04 KP-1/KP-5
// =====================================================================================================================

export const consumableReceiptSchema = z
  .object({
    receiptId: z.uuid(),
    source: z.enum(["supplier", "other"]),
    supplierId: z.uuid().nullable().optional(),
    supplierName: z.string().trim().max(120).nullable().optional(),
    supplierNoteNumber: z.string().trim().max(60).nullable().optional(),
    lines: z
      .array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(100_000), unitCost: zRupiahNonNegative.nullable().optional() }).strict())
      .min(1, { error: "Isi minimal satu bahan yang diterima." })
      .max(30),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export async function recordConsumableReceipt(ctx: ActorContext, input: z.output<typeof consumableReceiptSchema>, meta: FieldWriteMeta) {
  const { tx } = meta;
  const outlet = await resolvePosOutlet(tx, ctx, meta.device);
  const policy = posKindPolicy(outlet.kind);
  await authorize(ctx, policy.permissions.consumableReceipt, { tx, objectType: "consumable_receipt", objectId: input.receiptId });
  const attachmentId = meta.attachmentIds[0] ?? null;
  if (input.source === "supplier") {
    if (!attachmentId) throw new DomainError("NOTE_PHOTO_REQUIRED", "Foto nota pemasok wajib dilampirkan.");
    if (!input.supplierNoteNumber) throw new DomainError("NOTE_NUMBER_REQUIRED", "Nomor nota pemasok wajib diisi.");
    if (!input.supplierId && !input.supplierName) throw new DomainError("SUPPLIER_REQUIRED", "Pilih pemasok atau tulis nama pemasok.");
  }
  if (input.supplierId) {
    const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1);
    if (!sup || sup.tenantId !== outlet.tenantId) throw new NotFoundError("Pemasok tidak ditemukan.");
  }
  const materials = new Map((await consumablesOf(tx, outlet.tenantId, policy.productLine)).map((m) => [m.id, m]));
  for (const l of input.lines) {
    if (!materials.has(l.productId)) throw new DomainError("NOT_A_CONSUMABLE", "Barang yang diterima bukan bahan habis pakai outlet ini.");
  }
  const shift = await openShiftOf(tx, outlet.id);
  const notes = [input.supplierName ? `Pemasok: ${input.supplierName}` : null, input.notes].filter(Boolean).join(" · ") || null;
  const [receipt] = await tx
    .insert(consumableReceipts)
    .values({
      id: input.receiptId,
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      source: input.source,
      supplierId: input.supplierId ?? null,
      supplierNoteNumber: input.supplierNoteNumber ?? null,
      noteAttachmentId: attachmentId,
      shiftId: shift?.id ?? null,
      receivedAt: meta.deviceTime,
      receivedBy: ctx.userId,
      businessDate: meta.businessDate,
      notes,
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning();
  if (attachmentId) await linkAttachment(tx, attachmentId, { type: "consumable_receipt", id: receipt!.id });
  await tx.insert(consumableReceiptLines).values(
    input.lines.map((l) => ({ tenantId: outlet.tenantId, receiptId: receipt!.id, productId: l.productId, quantity: l.quantity, unitCost: l.unitCost ?? null })),
  );
  let totalValue = 0;
  for (const l of input.lines) {
    const res = await postStockMovement(tx, {
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      productId: l.productId,
      kind: "receipt",
      quantity: l.quantity,
      unitCost: l.unitCost ?? null,
      businessDate: meta.businessDate,
      occurredAt: meta.deviceTime,
      source: { type: "consumable_receipt", id: receipt!.id },
      createdBy: ctx.userId,
    });
    totalValue += res.totalCost;
  }
  await auditRecord(tx, {
    ctx,
    objectType: "consumable_receipt",
    objectId: receipt!.id,
    action: "create",
    after: { source: input.source, supplierNoteNumber: input.supplierNoteNumber ?? null, lines: input.lines, totalValue },
  });
  await emit(
    tx,
    "consumable.received",
    { receiptId: receipt!.id, outletId: outlet.id, source: input.source, supplierId: input.supplierId ?? null, totalValue },
    { ctx, objectType: "consumable_receipt", objectId: receipt!.id },
  );
  return { receipt: receipt!, totalValue };
}

// =====================================================================================================================
// Terima transfer internal dari toko (dibuat M7, US-M7-06 KP-1) — US-M6-04 KP-1/KP-5
// =====================================================================================================================

export const receiveTransferSchema = z
  .object({
    transferId: z.uuid(),
    receiptId: z.uuid(),
    lines: z
      .array(
        z
          .object({
            lineId: z.uuid(),
            quantityReceived: z.number().int().min(0).max(100_000),
            reason: z.string().trim().max(300).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export async function receiveInternalTransfer(ctx: ActorContext, input: z.output<typeof receiveTransferSchema>, meta: FieldWriteMeta) {
  const { tx } = meta;
  await authorize(ctx, "m6.internal_transfer.receive", { tx, objectType: "internal_transfer", objectId: input.transferId });
  const [transfer] = await tx.select().from(internalTransfers).where(eq(internalTransfers.id, input.transferId)).for("update").limit(1);
  if (!transfer || transfer.tenantId !== ctx.tenantId) throw new NotFoundError("Transfer internal tidak ditemukan.");
  const outlet = await resolvePosOutlet(tx, ctx, meta.device, transfer.toOutletId);
  if (transfer.toOutletId !== outlet.id) throw new NotFoundError("Transfer internal ini bukan untuk outlet Anda.");
  if (transfer.status !== "sent") throw new DomainError("TRANSFER_ALREADY_RECEIVED", "Transfer internal ini sudah diterima.");
  const tLines = await tx.select().from(internalTransferLines).where(eq(internalTransferLines.transferId, transfer.id));
  const byLine = new Map(input.lines.map((l) => [l.lineId, l]));
  for (const l of input.lines) {
    if (!tLines.some((t) => t.id === l.lineId)) throw new DomainError("TRANSFER_LINE_UNKNOWN", "Baris transfer tidak dikenal.");
  }
  // Bahan depot yang dipasok barang toko ini (products.store_product_id).
  const storeIds = tLines.map((l) => l.productId);
  const mapped = storeIds.length
    ? await tx
        .select({ id: products.id, storeProductId: products.storeProductId })
        .from(products)
        .where(and(eq(products.tenantId, outlet.tenantId), inArray(products.storeProductId, storeIds), eq(products.line, "depot")))
    : [];
  const depotFor = new Map(mapped.map((m) => [m.storeProductId!, m.id]));
  const shift = await openShiftOf(tx, outlet.id);
  const [receipt] = await tx
    .insert(consumableReceipts)
    .values({
      id: input.receiptId,
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      source: "internal_transfer",
      internalTransferId: transfer.id,
      shiftId: shift?.id ?? null,
      receivedAt: meta.deviceTime,
      receivedBy: ctx.userId,
      businessDate: meta.businessDate,
      notes: input.notes ?? null,
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning();
  let hasDifference = false;
  let totalValue = 0;
  for (const tl of tLines) {
    const entry = byLine.get(tl.id);
    const received = entry ? entry.quantityReceived : tl.quantitySent;
    const diff = received - tl.quantitySent;
    const reason = entry?.reason?.trim() || null;
    if (diff !== 0 && (!reason || reason.length < 3)) {
      throw new DomainError("TRANSFER_REASON_REQUIRED", "Jumlah diterima berbeda dari yang dikirim toko — isi alasannya per barang.");
    }
    if (diff !== 0) hasDifference = true;
    const target = tl.toProductId ?? depotFor.get(tl.productId) ?? null;
    if (!target) throw new DomainError("TRANSFER_PRODUCT_UNMAPPED", "Barang transfer belum dipetakan ke bahan depot (Data master > Produk).");
    await tx.update(internalTransferLines).set({ quantityReceived: received, differenceReason: reason, toProductId: target, updatedAt: new Date() }).where(eq(internalTransferLines.id, tl.id));
    await tx.insert(consumableReceiptLines).values({
      tenantId: outlet.tenantId,
      receiptId: receipt!.id,
      productId: target,
      quantity: received,
      unitCost: tl.unitValue,
      expectedQuantity: tl.quantitySent,
      differenceReason: reason,
    });
    if (received > 0) {
      await postStockMovement(tx, {
        tenantId: outlet.tenantId,
        outletId: outlet.id,
        productId: target,
        kind: "transfer_in",
        quantity: received,
        unitCost: tl.unitValue,
        businessDate: meta.businessDate,
        occurredAt: meta.deviceTime,
        source: { type: "consumable_receipt", id: receipt!.id },
        createdBy: ctx.userId,
      });
    }
    totalValue += received * tl.unitValue;
  }
  await tx
    .update(internalTransfers)
    .set({ status: "received", receivedAt: meta.deviceTime, receivedBy: ctx.userId, hasDifference, updatedAt: new Date() })
    .where(eq(internalTransfers.id, transfer.id));
  await auditRecord(tx, {
    ctx,
    objectType: "internal_transfer",
    objectId: transfer.id,
    action: "receive",
    before: { status: "sent" },
    after: { status: "received", hasDifference, totalValue, receiptId: receipt!.id },
  });
  await emit(
    tx,
    "internal_transfer.received",
    { internalTransferId: transfer.id, toOutletId: outlet.id, totalValue, hasDiscrepancy: hasDifference },
    { ctx, objectType: "internal_transfer", objectId: transfer.id },
  );
  return { receipt: receipt!, hasDifference, totalValue };
}

// =====================================================================================================================
// Opname mingguan (PAR-32) → usulan penyesuaian → persetujuan pemilik — US-M6-04 KP-4
// =====================================================================================================================

export const stockCountSchema = z
  .object({
    stockCountId: z.uuid(),
    lines: z
      .array(
        z
          .object({
            productId: z.uuid(),
            physicalQty: z.number().int().min(0).max(1_000_000),
            reason: z.enum(enumValues("stock_adjust_reason")).nullable().optional(),
            reasonNote: z.string().trim().max(300).nullable().optional(),
          })
          .strict(),
      )
      .min(1, { error: "Isi hitungan minimal satu bahan." })
      .max(100),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type SubmitStockCountResult = { stockCount: StockCountRow; approval: ApprovalRow | null; differences: number };

export async function submitStockCount(ctx: ActorContext, input: z.output<typeof stockCountSchema>, meta: FieldWriteMeta): Promise<SubmitStockCountResult> {
  const { tx } = meta;
  const outlet = await resolvePosOutlet(tx, ctx, meta.device);
  const policy = posKindPolicy(outlet.kind);
  await authorize(ctx, policy.permissions.stockCount, { tx, objectType: "stock_count", objectId: input.stockCountId });
  const materials = await consumablesOf(tx, outlet.tenantId, policy.productLine);
  const matById = new Map(materials.map((m) => [m.id, m]));
  for (const l of input.lines) {
    if (!matById.has(l.productId)) throw new DomainError("NOT_A_CONSUMABLE", "Barang opname bukan bahan habis pakai outlet ini.");
  }
  // US-M6-04 KP-4 / BR-27: opname menghitung SELURUH bahan — opname sebagian tidak dianggap opname minggu itu.
  const counted = new Set(input.lines.map((l) => l.productId));
  const missing = materials.filter((m) => !counted.has(m.id));
  if (missing.length) {
    throw new DomainError("COUNT_INCOMPLETE", `Opname harus menghitung seluruh bahan. Belum dihitung: ${missing.map((m) => m.name).join(", ")}.`);
  }
  // Saldo sistem PADA WAKTU HITUNG: saldo kartu stok − pemakaian shift terbuka sampai jam hitung (belum dibukukan).
  const bal = await stockBalancesOf(
    tx,
    outlet.id,
    input.lines.map((l) => l.productId),
  );
  const open = await tx.select().from(shifts).where(and(eq(shifts.outletId, outlet.id), eq(shifts.status, "open"), lte(shifts.openedAt, meta.deviceTime)));
  const pendingUsage = new Map<string, number>();
  for (const s of open) {
    const f = await computeShiftFigures(tx, s, { soldUpTo: meta.deviceTime });
    for (const [mat, qty] of f.usage) pendingUsage.set(mat, (pendingUsage.get(mat) ?? 0) + qty);
  }
  const rows = input.lines.map((l) => {
    const b = bal.get(l.productId)!;
    const systemQty = b.quantity - (pendingUsage.get(l.productId) ?? 0);
    const diff = l.physicalQty - systemQty;
    return { ...l, systemQty, diff, unitCost: b.avgCost, value: diff * b.avgCost };
  });
  for (const r of rows) {
    if (r.diff === 0) continue;
    if (!r.reason) throw new DomainError("ADJUST_REASON_REQUIRED", `${matById.get(r.productId)!.name}: selisih ${r.diff} — pilih alasan penyesuaian.`);
    if (r.reason === "other" && (r.reasonNote?.length ?? 0) < 3) throw new DomainError("ADJUST_REASON_REQUIRED", "Alasan \"Lainnya\" wajib diisi keterangannya.");
  }
  const differences = rows.filter((r) => r.diff !== 0).length;
  const periodLabel = isoWeekLabel(meta.businessDate);
  const [count] = await tx
    .insert(stockCounts)
    .values({
      id: input.stockCountId,
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      kind: policy.stockCountKind,
      periodLabel,
      status: differences ? "submitted" : "approved",
      startedAt: meta.deviceTime,
      countedBy: ctx.userId,
      submittedAt: meta.deviceTime,
      decidedAt: differences ? null : ctx.now,
      notes: input.notes ?? null,
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning();
  await tx.insert(stockCountLines).values(
    rows.map((r) => ({
      tenantId: outlet.tenantId,
      stockCountId: count!.id,
      productId: r.productId,
      physicalQty: r.physicalQty,
      systemQtyAtCount: r.systemQty,
      countedAt: meta.deviceTime,
      differenceQty: r.diff,
      unitCost: r.unitCost,
      differenceValue: r.value,
      reason: r.diff === 0 ? null : (r.reason ?? null),
      reasonNote: r.diff === 0 ? null : (r.reasonNote ?? null),
    })),
  );
  let approval: ApprovalRow | null = null;
  if (differences) {
    await authorize(ctx, policy.permissions.stockAdjustment, { tx, objectType: "stock_count", objectId: count!.id });
    const totalValue = rows.reduce((s, r) => s + r.value, 0);
    approval = await approvals.submit(
      ctx,
      {
        type: "stock_adjustment",
        objectType: "stock_count",
        objectId: count!.id,
        amount: Math.abs(totalValue),
        reason: `Opname ${outlet.name} ${periodLabel}: ${differences} bahan selisih (${formatRupiah(totalValue)}). ${rows
          .filter((r) => r.diff !== 0)
          .map((r) => `${matById.get(r.productId)!.name} ${r.diff > 0 ? "+" : ""}${r.diff} (${label("stock_adjust_reason", r.reason!)}${r.reasonNote ? `: ${r.reasonNote}` : ""})`)
          .join("; ")}`.slice(0, 1000),
        payload: { outletId: outlet.id, outletName: outlet.name, periodLabel, lines: rows.filter((r) => r.diff !== 0).map((r) => ({ productId: r.productId, diff: r.diff, value: r.value })) },
      },
      { tx },
    );
    await tx.update(stockCounts).set({ approvalRequestId: approval.id, dueAt: approval.deadlineAt }).where(eq(stockCounts.id, count!.id));
  }
  await auditRecord(tx, {
    ctx,
    objectType: "stock_count",
    objectId: count!.id,
    action: "submit",
    after: { periodLabel, status: count!.status, differences, lines: rows.map((r) => ({ productId: r.productId, physical: r.physicalQty, system: r.systemQty, diff: r.diff })) },
    reason: input.notes ?? null,
  });
  return { stockCount: { ...count!, approvalRequestId: approval?.id ?? null }, approval, differences };
}

/** Disetujui pemilik → saldo disesuaikan (kartu stok "penyesuaian opname") + `stock.adjusted` (jurnal M11). */
export async function onStockAdjustmentApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, request.objectId)).for("update").limit(1);
  if (!count || count.status !== "submitted") return { effect: "none" };
  const outlet = await loadOutlet(tx, count.outletId);
  const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.stockCountId, count.id));
  const out: { productId: string; quantityDelta: number; value: number }[] = [];
  for (const l of lines) {
    if (l.differenceQty === 0) continue;
    const res = await postStockMovement(tx, {
      tenantId: count.tenantId,
      outletId: count.outletId,
      productId: l.productId,
      kind: "adjustment",
      quantity: l.differenceQty,
      unitCost: l.differenceQty > 0 ? l.unitCost : null,
      businessDate: ctxBusinessDate(ctx),
      occurredAt: ctx.now,
      source: { type: "stock_count", id: count.id },
      createdBy: ctx.userId,
      note: `Opname ${count.periodLabel} disetujui`,
    });
    out.push({ productId: l.productId, quantityDelta: l.differenceQty, value: res.totalCost });
  }
  await tx.update(stockCounts).set({ status: "approved", decidedAt: ctx.now, adjustmentPostedAt: ctx.now, updatedAt: new Date() }).where(eq(stockCounts.id, count.id));
  const totalValue = out.reduce((s, l) => s + l.value, 0);
  await auditRecord(tx, { ctx, objectType: "stock_count", objectId: count.id, action: "adjust", after: { status: "approved", lines: out, totalValue }, rule: "BR-27" });
  await emit(
    tx,
    "stock.adjusted",
    { stockCountId: count.id, outletId: count.outletId, outletKind: outlet.kind, totalValue, lines: out },
    { ctx, tenantId: count.tenantId, objectType: "stock_count", objectId: count.id },
  );
  return { effect: "adjusted", totalValue };
}

/** Ditolak pemilik → saldo tidak berubah. */
export async function onStockAdjustmentRejected(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, request.objectId)).for("update").limit(1);
  if (!count || count.status !== "submitted") return { effect: "none" };
  await tx.update(stockCounts).set({ status: "rejected", decidedAt: ctx.now, updatedAt: new Date() }).where(eq(stockCounts.id, count.id));
  await auditRecord(tx, {
    ctx,
    objectType: "stock_count",
    objectId: count.id,
    action: "reject",
    before: { status: "submitted" },
    after: { status: "rejected" },
    reason: request.decisionReason ?? null,
    rule: "BR-27",
  });
  return { effect: "rejected" };
}

/** Outlet depot aktif tanpa opname pada minggu tertentu (job → notifikasi Admin Keuangan). */
export async function outletsWithoutStockCount(tx: Tx, tenantId: string, periodLabel: string) {
  const depots = await tx
    .select({ id: outlets.id, name: outlets.name, code: outlets.code })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.kind, "depot"), eq(outlets.isActive, true)));
  const done = await tx
    .selectDistinct({ outletId: stockCounts.outletId })
    .from(stockCounts)
    .where(and(eq(stockCounts.tenantId, tenantId), eq(stockCounts.periodLabel, periodLabel), eq(stockCounts.kind, "weekly_depot")));
  const doneSet = new Set(done.map((d) => d.outletId));
  return depots.filter((d) => !doneSet.has(d.id));
}

/** Opname terakhir outlet (untuk POS & kantor). */
export async function latestStockCounts(tx: Tx, outletId: string, limit = 10) {
  return tx.select().from(stockCounts).where(eq(stockCounts.outletId, outletId)).orderBy(desc(stockCounts.startedAt)).limit(limit);
}
