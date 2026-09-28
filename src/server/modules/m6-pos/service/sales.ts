/**
 * M6 — transaksi POS & void (US-M6-01, US-M6-03, US-M6-06 KP-4; BR-13, BR-15, BR-38, PTB-04, PTB-43, PTB-48).
 *
 * - Transaksi dicatat di perangkat (ID + nomor lokal dari perangkat) → nomor resmi `{kodeOutlet}-YYMMDD-NNNN` saat
 *   sinkron (tanggal bisnis perangkat). Harga dari master berlaku hari itu; harga perangkat yang berbeda tetap dipakai
 *   dan DITANDAI (`price_mismatch`). Tidak dapat diubah — hanya void.
 * - Void: hanya shift terbuka; alasan dari daftar; > PAR-04 → "menunggu persetujuan" pemilik (tetap dihitung sampai
 *   disetujui, PTB-43); > PAR-03/hari/outlet → notifikasi Admin Keuangan; void QRIS ditandai. Persetujuan setelah shift
 *   ditutup → pembalik oleh Admin Keuangan (`reverseSaleAfterClose`).
 */
import "server-only";

import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { approvalRequests, posSaleLines, posSales, products, shifts } from "@/db/schema";
import { enumValues, label } from "@/lib/labels";
import { formatRupiah, zRupiahNonNegative } from "@/lib/money";
import { businessDateToUtcRange, wibToUtc, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { assignOfficialNumber, nextNumber } from "@/server/core/numbering";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { resolveProductPrice } from "@/server/modules/m1-master";

import {
  loadOutlet,
  loadSale,
  loadShift,
  outletPosSettings,
  reasonText,
  resolvePosOutlet,
  type FieldWriteMeta,
  type OutletRow,
  type PosSaleRow,
  type ShiftRow,
} from "./common";
import { posKindPolicy, type PosKindPolicy } from "./policy";
import { checkCashLimit } from "./shifts";

// =====================================================================================================================
// Transaksi
// =====================================================================================================================

export const saleLineSchema = z
  .object({
    productId: z.uuid(),
    quantity: z.number().int().min(1, { error: "Jumlah minimal 1." }).max(9_999),
    /** Harga di perangkat saat transaksi (dari katalog hasil pull). */
    unitPrice: zRupiahNonNegative,
  })
  .strict();

export const recordSaleSchema = z
  .object({
    saleId: z.uuid(),
    shiftId: z.uuid(),
    outletId: z.uuid().nullable().optional(),
    localNumber: z.string().trim().min(5).max(60),
    deviceSeq: z.number().int().min(1),
    lines: z.array(saleLineSchema).min(1, { error: "Transaksi tanpa barang tidak dapat disimpan." }).max(50),
    paymentMethod: z.enum(["cash", "qris"]),
    /** Tunai: uang diterima (bawaan = pas). */
    cashReceived: zRupiahNonNegative.nullable().optional(),
    qrisReference: z.string().trim().max(64).nullable().optional(),
    receiptPrinted: z.boolean().optional(),
    /** Transaksi pengganti dari void (US-M6-03 KP-1). */
    replacesSaleId: z.uuid().nullable().optional(),
    /** Disiapkan untuk Tahap 2 / toko (FR-M6-08 C): depot selalu kosong. */
    customerId: z.uuid().nullable().optional(),
  })
  .strict();

export type RecordSaleInput = z.output<typeof recordSaleSchema>;

export type RecordSaleResult = {
  sale: PosSaleRow;
  lines: (typeof posSaleLines.$inferSelect)[];
  conflict: string | null;
  priceMismatch: boolean;
  cashAlert: boolean;
};

/**
 * Catat transaksi POS (inti kerangka POS; M7 memakai fungsi yang sama dengan `PosKindPolicy` toko).
 * Dipanggil handler sinkron `m6.pos_sale.create` di transaksi perintah.
 */
export async function recordSale(ctx: ActorContext, input: RecordSaleInput, meta: FieldWriteMeta): Promise<RecordSaleResult> {
  const { tx } = meta;
  const outlet = await resolvePosOutlet(tx, ctx, meta.device, input.outletId);
  const policy = posKindPolicy(outlet.kind);
  await authorize(ctx, policy.permissions.saleCreate, { tx, objectType: "pos_sale", objectId: input.saleId });
  const settings = await outletPosSettings(tx, outlet, meta.businessDate);
  if (input.lines.length > settings.rules.max_sale_lines) {
    throw new DomainError("TOO_MANY_LINES", `Satu transaksi maksimal ${settings.rules.max_sale_lines} baris.`);
  }
  if (input.lines.some((l) => l.quantity > settings.rules.max_quantity_per_line)) {
    throw new DomainError("QUANTITY_TOO_LARGE", `Jumlah per baris maksimal ${settings.rules.max_quantity_per_line}. Periksa jumlahnya.`);
  }
  const shift = await loadShift(tx, input.shiftId);
  // Shift belum ada = perintah buka shift masih di antrean/dicoba ulang → coba lagi nanti (bukan ditolak).
  if (!shift) throw new Error("Shift transaksi ini belum tersinkron — kirim ulang nanti.");
  if (shift.outletId !== outlet.id || shift.tenantId !== outlet.tenantId) {
    throw new DomainError("SHIFT_OUTLET_MISMATCH", "Transaksi merujuk shift outlet lain. Hubungi admin sistem.");
  }
  const conflicts: string[] = [];
  const shiftClosed = shift.status !== "open";
  if (shiftClosed) conflicts.push("Shift sudah ditutup saat transaksi ini tersinkron (perangkat lain); transaksi tetap dicatat dan ditinjau Admin Keuangan.");

  // --- Barang & harga master (BR-15). Harga perangkat dipakai; beda → ditandai (US-M6-06 KP-4).
  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const prodRows = await tx.select().from(products).where(inArray(products.id, productIds));
  const byId = new Map(prodRows.map((p) => [p.id, p]));
  let priceMismatch = false;
  const priceKind = policy.priceKind({ customerId: input.customerId ?? null });
  const lineValues: { productId: string; quantity: number; unitPrice: number; lineTotal: number; productPriceId: string | null; gallonSizeL: number | null }[] = [];
  for (const l of input.lines) {
    const p = byId.get(l.productId);
    if (!p || p.tenantId !== outlet.tenantId) throw new NotFoundError("Produk tidak ditemukan untuk tenant ini."); // NFR-30
    if (p.line !== policy.productLine) throw new DomainError("PRODUCT_LINE_MISMATCH", `${p.name} bukan produk ${policy.label.toLowerCase()}.`);
    let productPriceId: string | null = null;
    try {
      const master = await resolveProductPrice(tx, { productId: p.id, kind: priceKind, date: meta.businessDate, tenantId: outlet.tenantId, outletId: outlet.id });
      productPriceId = master.priceId;
      if (master.unitPrice !== l.unitPrice) priceMismatch = true;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      priceMismatch = true; // produk dinonaktifkan/harga belum ada setelah perangkat mengunduh katalog
    }
    lineValues.push({ productId: p.id, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.quantity * l.unitPrice, productPriceId, gallonSizeL: p.gallonSizeL });
  }
  const total = lineValues.reduce((s, l) => s + l.lineTotal, 0);
  const customerId = policy.acceptsCustomer ? (input.customerId ?? null) : null;
  await policy.validateSale?.({ tx, ctx, outlet, shift, lines: lineValues, customerId });

  // --- Cara bayar (US-M6-01 KP-2): tunai (uang diterima → kembalian) atau QRIS statis (+ referensi).
  let cashReceived: number | null = null;
  let changeAmount: number | null = null;
  if (input.paymentMethod === "cash") {
    cashReceived = input.cashReceived ?? total;
    if (cashReceived < total) throw new DomainError("CASH_INSUFFICIENT", `Uang diterima ${formatRupiah(cashReceived)} kurang dari total ${formatRupiah(total)}.`);
    changeAmount = cashReceived - total;
  } else if (!outlet.qrisEnabled) {
    conflicts.push("QRIS tidak aktif di outlet ini menurut pengaturan terbaru; transaksi tetap dicatat.");
  }

  let replacesSaleId: string | null = null;
  if (input.replacesSaleId) {
    const orig = await loadSale(tx, input.replacesSaleId);
    if (orig && orig.outletId === outlet.id && (orig.status === "voided" || orig.status === "void_pending")) replacesSaleId = orig.id;
  }

  const number = await assignOfficialNumber(tx, "pos_sale", { tenantId: outlet.tenantId, businessDate: meta.businessDate, outletCode: outlet.code });
  const [sale] = await tx
    .insert(posSales)
    .values({
      id: input.saleId,
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      shiftId: shift.id,
      number,
      localNumber: input.localNumber,
      deviceSeq: input.deviceSeq,
      operatorUserId: ctx.userId!,
      customerId,
      priceKind,
      businessDate: meta.businessDate,
      soldAt: meta.deviceTime,
      subtotal: total,
      discountAmount: 0,
      total,
      paymentMethod: input.paymentMethod,
      cashReceived,
      changeAmount,
      qrisReference: input.paymentMethod === "qris" ? (input.qrisReference ?? null) : null,
      status: "valid",
      replacesSaleId,
      priceMismatch,
      receiptPrinted: input.receiptPrinted ?? false,
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning();
  const lines = await tx
    .insert(posSaleLines)
    .values(
      lineValues.map((l, i) => ({
        posSaleId: sale!.id,
        tenantId: outlet.tenantId,
        outletId: outlet.id,
        businessDate: meta.businessDate,
        lineNo: i + 1,
        productId: l.productId,
        productPriceId: l.productPriceId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        gallonSizeL: l.gallonSizeL,
      })),
    )
    .returning();

  await policy.afterSaleRecorded?.({ tx, ctx, outlet, shift, sale: sale!, lines: lineValues, shiftClosed });

  let cashAlert = false;
  if (input.paymentMethod === "cash" && !shiftClosed) {
    cashAlert = (await checkCashLimit(tx, ctx, outlet, shift.id, meta.businessDate)).alerted;
  }

  await auditRecord(tx, {
    ctx,
    objectType: "pos_sale",
    objectId: sale!.id,
    action: "create",
    after: {
      number,
      localNumber: input.localNumber,
      total,
      paymentMethod: input.paymentMethod,
      lines: lineValues.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice })),
      priceMismatch,
    },
    businessDate: meta.businessDate,
  });
  await emit(
    tx,
    "pos_sale.recorded",
    {
      posSaleId: sale!.id,
      outletId: outlet.id,
      outletKind: outlet.kind,
      shiftId: shift.id,
      method: input.paymentMethod,
      total,
      discount: 0,
      customerId,
      lines: lineValues.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
      number,
      businessDate: meta.businessDate,
      priceMismatch,
      afterShiftClosed: shiftClosed,
      qrisReference: sale!.qrisReference,
    },
    { ctx, objectType: "pos_sale", objectId: sale!.id, businessDate: meta.businessDate },
  );
  return { sale: sale!, lines, conflict: conflicts.length ? conflicts.join(" ") : null, priceMismatch, cashAlert };
}

// =====================================================================================================================
// Void
// =====================================================================================================================

export const voidSaleSchema = z
  .object({
    saleId: z.uuid(),
    reason: z.enum(enumValues("void_reason")),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((v) => v.reason !== "other" || (v.note?.trim().length ?? 0) >= 3, {
    error: "Alasan \"Lainnya\" wajib diisi keterangannya.",
    path: ["note"],
  });

export type VoidSaleResult = { sale: PosSaleRow; status: "voided" | "void_pending"; approval: ApprovalRow | null; excessiveVoids: boolean };

/** Tenggat persetujuan void: jam `m6.pos_rules.void_approval_deadline_time` pada tanggal bisnis shift (6.2a). */
async function voidDeadline(tx: Tx, outlet: OutletRow, shift: ShiftRow): Promise<Date> {
  const rules = await params.get(tx, "m6.pos_rules", shift.businessDate, { tenantId: outlet.tenantId, outletId: outlet.id });
  return wibToUtc(shift.businessDate, rules.void_approval_deadline_time);
}

/** Jumlah void (efektif + menunggu persetujuan) outlet pada tanggal bisnis (PAR-03). */
export async function voidCountOn(tx: Tx, outletId: string, date: BusinessDate): Promise<{ count: number; amount: number }> {
  const { start, end } = businessDateToUtcRange(date);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${posSales.total}), 0)` })
    .from(posSales)
    .where(
      and(
        eq(posSales.outletId, outletId),
        eq(posSales.isReversal, false),
        gte(posSales.voidRequestedAt, start),
        lt(posSales.voidRequestedAt, end),
        or(eq(posSales.status, "voided"), eq(posSales.status, "void_pending")),
      ),
    );
  return { count: Number(row?.n ?? 0), amount: Number(row?.amount ?? 0) };
}

export async function voidSale(ctx: ActorContext, input: z.output<typeof voidSaleSchema>, meta: FieldWriteMeta): Promise<VoidSaleResult> {
  const { tx } = meta;
  const sale = await loadSale(tx, input.saleId, { forUpdate: true });
  if (!sale) throw new Error("Transaksi yang di-void belum tersinkron — kirim ulang nanti.");
  const outlet = await resolvePosOutlet(tx, ctx, meta.device, sale.outletId);
  if (sale.outletId !== outlet.id) throw new NotFoundError("Transaksi tidak ditemukan untuk outlet ini.");
  const policy = posKindPolicy(outlet.kind);
  await authorize(ctx, policy.permissions.saleVoid, { tx, objectType: "pos_sale", objectId: sale.id });
  if (sale.isReversal) throw new DomainError("VOID_REVERSAL", "Transaksi pembalik tidak dapat di-void.");
  if (sale.status !== "valid") {
    throw new DomainError("ALREADY_VOIDED", `Transaksi ${sale.number ?? sale.localNumber} sudah ${label("pos_sale_status", sale.status).toLowerCase()}.`);
  }
  const shift = (await loadShift(tx, sale.shiftId, { forUpdate: true }))!;
  // PAR-60: void hanya untuk transaksi pada shift yang masih terbuka.
  if (shift.status !== "open") {
    throw new DomainError("VOID_SHIFT_CLOSED", "Shift transaksi ini sudah ditutup. Void tidak dapat dilakukan; minta Admin Keuangan membuat transaksi pembalik.");
  }
  const settings = await outletPosSettings(tx, outlet, meta.businessDate);
  const reason = reasonText(input.reason, label("void_reason", input.reason), input.note);
  const needsApproval = sale.total > settings.voidApprovalAbove;
  const status = needsApproval ? ("void_pending" as const) : ("voided" as const);
  const [updated] = await tx
    .update(posSales)
    .set({
      status,
      voidReason: input.reason,
      voidNote: input.note ?? null,
      voidRequestedAt: meta.deviceTime,
      ...(needsApproval ? {} : { voidedAt: meta.deviceTime, voidedBy: ctx.userId }),
      updatedAt: new Date(),
    })
    .where(eq(posSales.id, sale.id))
    .returning();

  let approval: ApprovalRow | null = null;
  if (needsApproval) {
    approval = await approvals.submit(
      ctx,
      {
        type: "pos_void",
        objectType: "pos_sale",
        objectId: sale.id,
        amount: sale.total,
        reason: `Void ${sale.number ?? sale.localNumber} (${formatRupiah(sale.total)}): ${reason}`,
        payload: { outletId: outlet.id, outletName: outlet.name, shiftId: shift.id, saleNumber: sale.number, method: sale.paymentMethod },
        deadlineAt: await voidDeadline(tx, outlet, shift),
        businessDate: shift.businessDate,
      },
      { tx },
    );
    await tx.update(posSales).set({ voidApprovalId: approval.id }).where(eq(posSales.id, sale.id));
  }
  await auditRecord(tx, {
    ctx,
    objectType: "pos_sale",
    objectId: sale.id,
    action: needsApproval ? "request_void" : "void",
    before: { status: "valid" },
    after: { status, approvalId: approval?.id ?? null },
    reason,
    businessDate: meta.businessDate,
  });
  if (!needsApproval) await afterVoidEffective(tx, ctx, { outlet, policy, sale: updated!, shift, reason, afterClose: false, reversalId: null, approvalId: null });

  // BR-13: > PAR-03 void per hari per outlet → notifikasi Admin Keuangan (sekali saat ambang terlampaui).
  const counts = await voidCountOn(tx, outlet.id, meta.businessDate);
  const excessive = counts.count > settings.voidDailyCount;
  if (counts.count === settings.voidDailyCount + 1) {
    await notify(tx, {
      event: "pos.excessive_voids",
      tenantId: outlet.tenantId,
      title: `Void berlebih di ${outlet.name}`,
      body: `${counts.count} void hari ini (${formatRupiah(counts.amount)}), melebihi ${settings.voidDailyCount} (PAR-03). Tinjau di Pemantauan outlet.`,
      objectType: "outlet",
      objectId: outlet.id,
      valueAmount: counts.amount,
      link: `/outlet/${outlet.id}?tab=transaksi`,
      groupKey: `pos.excessive_voids:${outlet.id}:${meta.businessDate}`,
      now: ctx.now,
    });
  }
  return { sale: { ...updated!, voidApprovalId: approval?.id ?? null }, status, approval, excessiveVoids: excessive };
}

/** Efek void yang BERLAKU (shift terbuka ≤ PAR-04, disetujui pemilik, atau pembalik setelah tutup shift). */
async function afterVoidEffective(
  tx: Tx,
  ctx: ActorContext,
  input: {
    outlet: OutletRow;
    policy: PosKindPolicy;
    sale: PosSaleRow;
    shift: ShiftRow;
    reason: string;
    afterClose: boolean;
    reversalId: string | null;
    approvalId: string | null;
  },
): Promise<void> {
  const { outlet, policy, sale } = input;
  const lines = await tx.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, sale.id));
  const lineValues = lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, gallonSizeL: l.gallonSizeL }));
  await policy.afterSaleVoided?.({ tx, ctx, outlet, shift: input.shift, sale, lines: lineValues, afterClose: input.afterClose, reversalId: input.reversalId });
  await emit(
    tx,
    "pos_sale.voided",
    {
      posSaleId: sale.id,
      outletId: outlet.id,
      outletKind: outlet.kind,
      shiftId: sale.shiftId,
      method: sale.paymentMethod,
      total: sale.total,
      reason: input.reason,
      businessDate: ctxBusinessDate(ctx),
      afterClose: input.afterClose,
      reversalId: input.reversalId,
      approvalId: input.approvalId,
      qrisReference: sale.qrisReference,
      lines: lineValues.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    },
    { ctx, objectType: "pos_sale", objectId: sale.id },
  );
  // US-M6-03 KP-4: void QRIS ditandai — pengembalian dana di luar sistem dicatat Admin Keuangan.
  if (sale.paymentMethod === "qris") {
    await notify(tx, {
      event: "pos.qris_voided",
      tenantId: outlet.tenantId,
      title: `Transaksi QRIS ${sale.number ?? sale.localNumber} di-void (${outlet.name})`,
      body: `${formatRupiah(sale.total)}${sale.qrisReference ? ` · ref ${sale.qrisReference}` : ""}. Alasan: ${input.reason}. Catat pengembalian dana sebagai pengeluaran dengan rujukan transaksi ini.`,
      objectType: "pos_sale",
      objectId: sale.id,
      valueAmount: sale.total,
      link: `/outlet/shift/${sale.shiftId}`,
      now: ctx.now,
    });
  }
}

// =====================================================================================================================
// Persetujuan void (handler registri `pos_void`; ctx = pemilik/sistem)
// =====================================================================================================================

/** Disetujui pemilik: shift masih terbuka → void berlaku; sudah ditutup → Admin Keuangan membuat pembalik. */
export async function onVoidApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const sale = await loadSale(tx, request.objectId, { forUpdate: true });
  if (!sale || sale.status !== "void_pending") return { effect: "none" };
  const outlet = await loadOutlet(tx, sale.outletId);
  const shift = (await loadShift(tx, sale.shiftId))!;
  const policy = posKindPolicy(outlet.kind);
  const reason = reasonText(sale.voidReason ?? "other", label("void_reason", sale.voidReason ?? "other"), sale.voidNote);
  if (shift.status === "open") {
    const [updated] = await tx
      .update(posSales)
      .set({ status: "voided", voidedAt: ctx.now, voidedBy: request.requesterUserId, updatedAt: new Date() })
      .where(eq(posSales.id, sale.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "pos_sale", objectId: sale.id, action: "void", before: { status: "void_pending" }, after: { status: "voided" }, reason, rule: "6.2a" });
    await afterVoidEffective(tx, ctx, { outlet, policy, sale: updated!, shift, reason, afterClose: false, reversalId: null, approvalId: request.id });
    return { effect: "voided" };
  }
  // PTB-43: persetujuan setelah shift ditutup → diproses sebagai pembalik oleh Admin Keuangan.
  await notify(tx, {
    event: "pos.void_reversal_needed",
    tenantId: outlet.tenantId,
    title: `Buat pembalik: void ${sale.number ?? sale.localNumber} disetujui setelah shift ditutup`,
    body: `${outlet.name} · ${formatRupiah(sale.total)}. Alasan: ${reason}.`,
    objectType: "pos_sale",
    objectId: sale.id,
    valueAmount: sale.total,
    link: `/outlet/shift/${sale.shiftId}`,
    now: ctx.now,
  });
  await auditRecord(tx, {
    ctx,
    objectType: "pos_sale",
    objectId: sale.id,
    action: "void_approved_after_close",
    after: { status: "void_pending", reversalNeeded: true },
    reason,
    rule: "PTB-43",
  });
  return { effect: "reversal_needed" };
}

/** Ditolak pemilik / lewat tenggat ("dianggap ditolak di akhir shift"): transaksi kembali Sah & tetap dihitung. */
export async function onVoidRejected(tx: Tx, request: ApprovalRow, ctx: ActorContext, decision: "rejected" | "expired"): Promise<Record<string, unknown>> {
  const sale = await loadSale(tx, request.objectId, { forUpdate: true });
  if (!sale || sale.status !== "void_pending") return { effect: "none" };
  await tx.update(posSales).set({ status: "valid", updatedAt: new Date() }).where(eq(posSales.id, sale.id));
  await auditRecord(tx, {
    ctx,
    objectType: "pos_sale",
    objectId: sale.id,
    action: decision === "expired" ? "void_expired" : "void_rejected",
    before: { status: "void_pending" },
    after: { status: "valid" },
    reason: decision === "expired" ? "Persetujuan void lewat tenggat — dianggap ditolak (6.2a)." : (request.decisionReason ?? null),
    rule: "6.2a",
  });
  return { effect: "void_rejected" };
}

// =====================================================================================================================
// Pembalik setelah shift ditutup (Admin Keuangan) — US-M6-02 KP-4, US-M6-03 KP-2, BR-38
// =====================================================================================================================

const reverseSchema = z.object({
  saleId: z.uuid(),
  reason: z.string().trim().min(5, { error: "Alasan pembalik wajib diisi (minimal 5 karakter)." }).max(500),
});

/**
 * Buat transaksi pembalik (negatif) untuk transaksi pada shift yang SUDAH DITUTUP. Diizinkan untuk void yang disetujui
 * pemilik setelah shift ditutup (PTB-43), atau koreksi ≤ PAR-21 (BR-38); di atasnya perlu persetujuan pemilik lewat
 * permintaan void dari outlet sebelum tenggat.
 */
export async function reverseSaleAfterClose(ctx: ActorContext, input: z.input<typeof reverseSchema>, opts: { tx?: Tx } = {}) {
  const data = parseInput(reverseSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const sale = await loadSale(tx, data.saleId, { forUpdate: true });
    if (!sale || sale.tenantId !== ctx.tenantId) throw new NotFoundError("Transaksi tidak ditemukan.");
    const outlet = await loadOutlet(tx, sale.outletId);
    const policy = posKindPolicy(outlet.kind);
    await authorize(ctx, policy.permissions.saleCorrect, { tx, objectType: "pos_sale", objectId: sale.id });
    if (sale.isReversal) throw new DomainError("REVERSAL_OF_REVERSAL", "Transaksi pembalik tidak dapat dibalik lagi.");
    const shift = (await loadShift(tx, sale.shiftId))!;
    if (shift.status === "open") throw new DomainError("SHIFT_STILL_OPEN", "Shift masih terbuka — operator melakukan void dari POS.");
    if (sale.status === "voided" || sale.status === "rejected") throw new DomainError("ALREADY_VOIDED", "Transaksi ini sudah di-void/dibalik.");
    let approvalId: string | null = null;
    if (sale.status === "void_pending" && sale.voidApprovalId) {
      const [appr] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, sale.voidApprovalId)).limit(1);
      if (appr?.status === "approved") approvalId = appr.id;
    }
    if (!approvalId) {
      const limit = await params.get(tx, "PAR-21", ctxBusinessDate(ctx));
      if (sale.total > limit.amount_gt) {
        throw new DomainError(
          "CORRECTION_NEEDS_APPROVAL",
          `Pembalik ${formatRupiah(sale.total)} melebihi ${formatRupiah(limit.amount_gt)} (PAR-21) dan belum ada persetujuan void pemilik. Ajukan persetujuan pemilik lebih dulu.`,
        );
      }
    }
    const today = ctxBusinessDate(ctx);
    const number = await nextNumber(tx, "pos_sale", today, { tenantId: outlet.tenantId, outletCode: outlet.code });
    const [rev] = await tx
      .insert(posSales)
      .values({
        tenantId: outlet.tenantId,
        outletId: outlet.id,
        shiftId: sale.shiftId,
        number,
        localNumber: `${sale.localNumber}-BALIK`,
        deviceSeq: sale.deviceSeq,
        operatorUserId: ctx.userId!,
        customerId: sale.customerId,
        priceKind: sale.priceKind,
        businessDate: today,
        soldAt: ctx.now,
        subtotal: -sale.subtotal,
        discountAmount: -sale.discountAmount,
        total: -sale.total,
        paymentMethod: sale.paymentMethod,
        status: "valid",
        isReversal: true,
        reversalOfId: sale.id,
        reversalReason: data.reason,
        correctionApprovalId: approvalId,
        recordedByOffice: true,
        officeRecordReason: data.reason,
        createdBy: ctx.userId,
      })
      .returning();
    const lines = await tx.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, sale.id));
    if (lines.length) {
      await tx.insert(posSaleLines).values(
        lines.map((l) => ({
          posSaleId: rev!.id,
          tenantId: l.tenantId,
          outletId: l.outletId,
          businessDate: today,
          lineNo: l.lineNo,
          productId: l.productId,
          productPriceId: l.productPriceId,
          quantity: -l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: -l.lineTotal,
          unitCost: l.unitCost,
          gallonSizeL: l.gallonSizeL,
        })),
      );
    }
    const [orig] = await tx
      .update(posSales)
      .set({ status: "voided", voidedAt: ctx.now, voidedBy: ctx.userId, reversalReason: data.reason, correctionApprovalId: approvalId, updatedAt: new Date() })
      .where(eq(posSales.id, sale.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "pos_sale",
      objectId: sale.id,
      action: "reverse",
      before: { status: sale.status },
      after: { status: "voided", reversalId: rev!.id, reversalNumber: number },
      reason: data.reason,
      rule: approvalId ? "PTB-43" : "BR-38",
    });
    await afterVoidEffective(tx, ctx, { outlet, policy, sale: orig!, shift, reason: data.reason, afterClose: true, reversalId: rev!.id, approvalId });
    return { original: orig!, reversal: rev! };
  });
}

/** Void yang disetujui setelah shift ditutup dan belum dibalik (daftar kerja Admin Keuangan). */
export async function pendingVoidReversals(tx: Tx, tenantId: string, outletIds?: string[]) {
  const rows = await tx
    .select({ sale: posSales, approval: approvalRequests })
    .from(posSales)
    .innerJoin(approvalRequests, eq(approvalRequests.id, posSales.voidApprovalId))
    .innerJoin(shifts, eq(shifts.id, posSales.shiftId))
    .where(
      and(
        eq(posSales.tenantId, tenantId),
        eq(posSales.status, "void_pending"),
        eq(approvalRequests.status, "approved"),
        eq(shifts.status, "closed"),
        ...(outletIds?.length ? [inArray(posSales.outletId, outletIds)] : []),
      ),
    );
  return rows;
}
