/**
 * M7 — penerimaan barang dari nota pemasok & kartu stok (US-M7-02; BR-28, BR-38, PTB-38; 7.7.6).
 *
 * - Kasir (POS, perintah sinkron) mencatat penerimaan WAJIB merujuk nota pemasok: pemasok (master aktif), nomor &
 *   tanggal nota, foto nota, baris (jumlah, harga beli satuan), total. Tanpa nota → ditolak; barang tanpa nota dicatat
 *   sebagai "nota pengganti" (foto barang + keterangan) yang TIDAK masuk stok sampai Admin Keuangan menerimanya.
 * - Nota diterima → kartu stok "Penerimaan" + harga pokok rata-rata bergerak (PTB-38), daftar pesan ulang barang itu
 *   selesai (US-M7-03 KP-2), utang pemasok terbentuk (US-M7-08, jatuh tempo nota/PAR-67), `purchase_receipt.recorded`.
 * - Tidak dapat dihapus: koreksi = nota retur pemasok / pembalik beralasan (> PAR-21 → persetujuan `correction`).
 * - Saldo awal utang pemasok saat cut-over dicatat Admin Keuangan dari nota (tanpa stok).
 */
import "server-only";

import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { attachments, outlets, products, purchaseReceiptLines, purchaseReceipts, supplierPaymentAllocations, supplierPayments, suppliers } from "@/db/schema";
import { formatRupiah, zRupiahNonNegative, zRupiahPositive } from "@/lib/money";
import { isBusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { assignOfficialNumber, nextNumber } from "@/server/core/numbering";
import * as params from "@/server/core/params";
import { authorize, runService, sod } from "@/server/core/rbac";
import { getUrl, linkAttachment } from "@/server/core/storage";
import { postStockMovement, type FieldWriteMeta } from "@/server/modules/m6-pos";

import { balancesNow, loadProductsById, loadStoreOutlet, resolveOfficeStore, resolveStorePosOutlet } from "./common";
import { payableDueDate, receiptBalances, refreshPaymentStatus } from "./payables";
import { closeReorderOnReceipt, evaluateReorder } from "./reorder";

export type PurchaseReceiptRow = typeof purchaseReceipts.$inferSelect;
type LineRow = typeof purchaseReceiptLines.$inferSelect;

const dateField = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." });

// =====================================================================================================================
// Penerimaan barang (POS kasir)
// =====================================================================================================================

export const purchaseReceiptSchema = z
  .object({
    receiptId: z.uuid(),
    localNumber: z.string().trim().min(5).max(60),
    deviceSeq: z.number().int().min(1),
    supplierId: z.uuid({ error: "Pilih pemasok." }),
    /** Barang datang tanpa nota (pemasok kecil) → nota pengganti: foto barang + keterangan (7.7.6). */
    isSubstitute: z.boolean().default(false),
    supplierNoteNumber: z.string().trim().max(60).nullable().optional(),
    supplierNoteDate: dateField.nullable().optional(),
    /** Jatuh tempo tertulis di nota (kosong → tempo pemasok / PAR-67). */
    dueDate: dateField.nullable().optional(),
    lines: z
      .array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(100_000), unitCost: zRupiahNonNegative }).strict())
      .min(1, { error: "Isi minimal satu barang yang diterima." })
      .max(100),
    /** Total tertulis di nota (harus sama dengan jumlah baris). */
    totalAmount: zRupiahNonNegative,
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type PurchaseReceiptInput = z.output<typeof purchaseReceiptSchema>;

/** Kartu stok "Penerimaan" per barang (satu mutasi per barang per nota; harga beli rata-rata tertimbang baris). */
async function postReceiptStock(tx: Tx, input: { receipt: PurchaseReceiptRow; lines: readonly LineRow[]; occurredAt: Date; businessDate: string; userId: string | null; now: Date }) {
  const agg = new Map<string, { qty: number; value: number }>();
  for (const l of input.lines) {
    const cur = agg.get(l.productId) ?? { qty: 0, value: 0 };
    cur.qty += l.quantity;
    cur.value += l.lineTotal;
    agg.set(l.productId, cur);
  }
  for (const [productId, v] of agg) {
    await postStockMovement(tx, {
      tenantId: input.receipt.tenantId,
      outletId: input.receipt.outletId,
      productId,
      kind: "receipt",
      quantity: v.qty,
      unitCost: Math.round(v.value / v.qty),
      businessDate: input.businessDate,
      occurredAt: input.occurredAt,
      source: { type: "purchase_receipt", id: input.receipt.id },
      createdBy: input.userId,
      note: `Nota ${input.receipt.supplierNoteNumber ?? input.receipt.number ?? ""}`.trim(),
    });
  }
  await closeReorderOnReceipt(tx, { tenantId: input.receipt.tenantId, outletId: input.receipt.outletId, productIds: [...agg.keys()], receiptId: input.receipt.id, now: input.now });
}

async function emitReceiptRecorded(tx: Tx, ctx: ActorContext, receipt: PurchaseReceiptRow, lines: readonly LineRow[], opts: { fromSubstituteNote?: boolean } = {}) {
  await emit(
    tx,
    "purchase_receipt.recorded",
    {
      purchaseReceiptId: receipt.id,
      supplierId: receipt.supplierId,
      outletId: receipt.outletId,
      total: receipt.totalAmount,
      paymentMode: "credit",
      isOpeningPayable: receipt.isOpeningPayable,
      number: receipt.number,
      businessDate: receipt.businessDate,
      dueDate: receipt.dueDate,
      fromSubstituteNote: opts.fromSubstituteNote ?? false,
      lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost })),
    },
    { ctx, tenantId: receipt.tenantId, objectType: "purchase_receipt", objectId: receipt.id, businessDate: receipt.businessDate },
  );
}

async function findDuplicateNote(tx: Tx, tenantId: string, supplierId: string, noteNumber: string, exceptId?: string) {
  const rows = await tx
    .select({ id: purchaseReceipts.id, number: purchaseReceipts.number })
    .from(purchaseReceipts)
    .where(
      and(
        eq(purchaseReceipts.tenantId, tenantId),
        eq(purchaseReceipts.supplierId, supplierId),
        sql`lower(${purchaseReceipts.supplierNoteNumber}) = ${noteNumber.toLowerCase()}`,
        isNull(purchaseReceipts.reversalOfId),
        ne(purchaseReceipts.status, "reversed"),
      ),
    )
    .limit(2);
  return rows.find((r) => r.id !== exceptId) ?? null;
}

export async function recordPurchaseReceipt(ctx: ActorContext, input: PurchaseReceiptInput, meta: FieldWriteMeta) {
  const { tx } = meta;
  await authorize(ctx, "m7.purchase_receipt.create", { tx, objectType: "purchase_receipt", objectId: input.receiptId });
  const outlet = await resolveStorePosOutlet(tx, ctx, meta.device);
  const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1);
  if (!sup || sup.tenantId !== outlet.tenantId) throw new NotFoundError("Pemasok tidak ditemukan.");
  if (sup.status !== "active") throw new DomainError("SUPPLIER_NOT_ACTIVE", `Pemasok ${sup.name} belum disetujui Admin Keuangan / nonaktif. Pilih pemasok aktif.`);
  const photoId = meta.attachmentIds[0] ?? null;
  const noteNumber = input.supplierNoteNumber?.trim() || null;
  if (!input.isSubstitute) {
    // BR-28: tanpa nota barang tidak dapat diterima.
    if (!noteNumber || !input.supplierNoteDate || !photoId) {
      throw new DomainError(
        "NOTE_REQUIRED",
        "Penerimaan wajib merujuk nota pemasok: isi nomor & tanggal nota dan foto notanya (BR-28). Barang tanpa nota → pilih \"Nota pengganti\".",
      );
    }
  } else {
    if (!photoId) throw new DomainError("GOODS_PHOTO_REQUIRED", "Nota pengganti wajib foto barang yang diterima.");
    if ((input.notes?.trim().length ?? 0) < 5) throw new DomainError("SUBSTITUTE_NOTE_REQUIRED", "Nota pengganti wajib keterangan (mis. nama penjual, alasan tanpa nota).");
  }
  if (input.supplierNoteDate && input.supplierNoteDate > meta.businessDate) throw new DomainError("NOTE_DATE_FUTURE", "Tanggal nota tidak boleh setelah hari ini.");
  const byId = await loadProductsById(
    tx,
    input.lines.map((l) => l.productId),
  );
  for (const l of input.lines) {
    const p = byId.get(l.productId);
    if (!p || p.tenantId !== outlet.tenantId || p.line !== "store") throw new NotFoundError("Barang toko tidak ditemukan.");
    if (p.status === "inactive") throw new DomainError("PRODUCT_INACTIVE", `${p.name} nonaktif — aktifkan dulu atau pilih barang lain.`);
  }
  const computed = input.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
  if (computed !== input.totalAmount) {
    throw new DomainError("TOTAL_MISMATCH", `Total nota ${formatRupiah(input.totalAmount)} tidak sama dengan jumlah baris ${formatRupiah(computed)}. Periksa jumlah & harga beli satuan.`);
  }
  if (noteNumber) {
    const dup = await findDuplicateNote(tx, outlet.tenantId, sup.id, noteNumber);
    if (dup) throw new DomainError("DUPLICATE_NOTE", `Nota ${noteNumber} dari ${sup.name} sudah tercatat (${dup.number ?? "nota lain"}). Periksa kembali; nota tidak dapat diinput dua kali.`);
  }
  const number = await assignOfficialNumber(tx, "purchase_receipt", { tenantId: outlet.tenantId, businessDate: meta.businessDate });
  const dueDate = await payableDueDate(tx, { explicit: input.dueDate ?? null, noteDate: input.supplierNoteDate ?? null, businessDate: meta.businessDate, supplierTermDays: sup.paymentTermDays });
  const [receipt] = await tx
    .insert(purchaseReceipts)
    .values({
      id: input.receiptId,
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      number,
      localNumber: input.localNumber,
      deviceSeq: input.deviceSeq,
      supplierId: sup.id,
      supplierNoteNumber: noteNumber,
      supplierNoteDate: input.supplierNoteDate ?? null,
      noteAttachmentId: input.isSubstitute ? null : photoId,
      isSubstituteNote: input.isSubstitute,
      substituteGoodsPhotoId: input.isSubstitute ? photoId : null,
      status: input.isSubstitute ? "pending_acceptance" : "received",
      totalAmount: input.totalAmount,
      paymentStatus: "unpaid",
      paidAmount: 0,
      dueDate,
      receivedBy: ctx.userId,
      businessDate: meta.businessDate,
      notes: input.notes ?? null,
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning();
  await linkAttachment(tx, photoId!, { type: "purchase_receipt", id: receipt!.id });
  const lines = await tx
    .insert(purchaseReceiptLines)
    .values(input.lines.map((l) => ({ tenantId: outlet.tenantId, receiptId: receipt!.id, productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, lineTotal: l.quantity * l.unitCost })))
    .returning();
  if (!input.isSubstitute) {
    await postReceiptStock(tx, { receipt: receipt!, lines, occurredAt: meta.deviceTime, businessDate: meta.businessDate, userId: ctx.userId, now: ctx.now });
  } else {
    await notify(tx, {
      event: "store.substitute_note_pending",
      tenantId: outlet.tenantId,
      title: `Nota pengganti ${number} menunggu diterima (${sup.name})`,
      body: `${outlet.name} · ${formatRupiah(input.totalAmount)} · ${input.lines.length} barang. Keterangan: ${input.notes ?? "—"}. Barang belum masuk stok & belum dapat dijual sampai diterima.`,
      objectType: "purchase_receipt",
      objectId: receipt!.id,
      valueAmount: input.totalAmount,
      link: `/toko/pembelian/${receipt!.id}`,
      now: ctx.now,
    });
  }
  await auditRecord(tx, {
    ctx,
    objectType: "purchase_receipt",
    objectId: receipt!.id,
    action: "create",
    after: {
      number,
      supplier: sup.name,
      supplierNoteNumber: noteNumber,
      supplierNoteDate: input.supplierNoteDate ?? null,
      isSubstituteNote: input.isSubstitute,
      totalAmount: input.totalAmount,
      dueDate,
      lines: input.lines,
    },
    reason: input.notes ?? null,
    businessDate: meta.businessDate,
  });
  if (!input.isSubstitute) await emitReceiptRecorded(tx, ctx, receipt!, lines);
  return { receipt: receipt!, lines };
}

// =====================================================================================================================
// Nota pengganti → diterima Admin Keuangan sebagai nota (7.7.6) / dibalik
// =====================================================================================================================

const acceptSchema = z.object({
  receiptId: z.uuid(),
  /** Nomor nota susulan bila ada (opsional). */
  supplierNoteNumber: z.string().trim().max(60).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

async function loadReceipt(tx: Tx, ctx: ActorContext, id: string, opts: { forUpdate?: boolean } = {}): Promise<PurchaseReceiptRow> {
  const q = tx.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, id)).limit(1);
  const [row] = opts.forUpdate ? await q.for("update") : await q;
  if (!row || row.tenantId !== ctx.tenantId) throw new NotFoundError("Nota pembelian tidak ditemukan.");
  return row;
}

export async function acceptSubstituteNote(ctx: ActorContext, input: z.input<typeof acceptSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.purchase_receipt.accept_substitute", { tx: opts.tx, objectType: "purchase_receipt", objectId: input.receiptId });
  const data = parseInput(acceptSchema, input);
  return runService(ctx, opts, async (tx) => {
    const receipt = await loadReceipt(tx, ctx, data.receiptId, { forUpdate: true });
    if (!receipt.isSubstituteNote || receipt.status !== "pending_acceptance") throw new DomainError("NOT_PENDING_SUBSTITUTE", "Nota ini bukan nota pengganti yang menunggu diterima.");
    // Pemisahan tugas: penerima barang (kasir) ≠ yang menerima nota pengganti sebagai nota.
    sod.assertNotSelf(receipt.receivedBy, ctx.userId, "nota pengganti", { objectType: "purchase_receipt", objectId: receipt.id });
    const noteNumber = data.supplierNoteNumber?.trim() || receipt.supplierNoteNumber;
    if (noteNumber && noteNumber !== receipt.supplierNoteNumber) {
      const dup = await findDuplicateNote(tx, receipt.tenantId, receipt.supplierId, noteNumber, receipt.id);
      if (dup) throw new DomainError("DUPLICATE_NOTE", `Nota ${noteNumber} dari pemasok ini sudah tercatat.`);
    }
    const [updated] = await tx
      .update(purchaseReceipts)
      .set({ status: "received", supplierNoteNumber: noteNumber, substituteAcceptedBy: ctx.userId, substituteAcceptedAt: ctx.now, updatedAt: new Date() })
      .where(eq(purchaseReceipts.id, receipt.id))
      .returning();
    const lines = await tx.select().from(purchaseReceiptLines).where(eq(purchaseReceiptLines.receiptId, receipt.id));
    await postReceiptStock(tx, { receipt: updated!, lines, occurredAt: ctx.now, businessDate: ctxBusinessDate(ctx), userId: ctx.userId, now: ctx.now });
    await auditRecord(tx, {
      ctx,
      objectType: "purchase_receipt",
      objectId: receipt.id,
      action: "accept_substitute",
      before: { status: "pending_acceptance" },
      after: { status: "received", supplierNoteNumber: noteNumber },
      reason: data.note ?? null,
      rule: "BR-28",
    });
    await emitReceiptRecorded(tx, ctx, updated!, lines, { fromSubstituteNote: true });
    return updated!;
  });
}

// =====================================================================================================================
// Koreksi: nota retur pemasok / pembalik beralasan (US-M7-02 KP-6, BR-38)
// =====================================================================================================================

export const correctionSchema = z
  .object({
    receiptId: z.uuid(),
    /** `return` = retur sebagian barang ke pemasok; `reversal` = pembalik penuh (nota salah input / pengganti ditolak). */
    kind: z.enum(["return", "reversal"]),
    lines: z.array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(100_000) }).strict()).max(100).optional(),
    reason: z.string().trim().min(5, { error: "Alasan koreksi wajib diisi (minimal 5 karakter)." }).max(500),
  })
  .strict();

export type PurchaseCorrectionInput = z.input<typeof correctionSchema>;

type CorrectionPlan = { kind: "return" | "reversal"; lines: { productId: string; quantity: number; unitCost: number }[]; amount: number; reason: string };

async function planCorrection(tx: Tx, receipt: PurchaseReceiptRow, data: z.output<typeof correctionSchema>): Promise<CorrectionPlan> {
  const lines = await tx.select().from(purchaseReceiptLines).where(eq(purchaseReceiptLines.receiptId, receipt.id));
  const prior = await tx
    .select({ productId: purchaseReceiptLines.productId, qty: sql<string>`coalesce(sum(${purchaseReceiptLines.quantity}), 0)` })
    .from(purchaseReceiptLines)
    .innerJoin(purchaseReceipts, eq(purchaseReceipts.id, purchaseReceiptLines.receiptId))
    .where(eq(purchaseReceipts.reversalOfId, receipt.id))
    .groupBy(purchaseReceiptLines.productId);
  const returned = new Map(prior.map((p) => [p.productId, -Number(p.qty)]));
  const remaining = new Map<string, { qty: number; unitCost: number }>();
  for (const l of lines) {
    const cur = remaining.get(l.productId) ?? { qty: 0, unitCost: l.unitCost };
    cur.qty += l.quantity;
    remaining.set(l.productId, cur);
  }
  for (const [id, q] of returned) {
    const cur = remaining.get(id);
    if (cur) cur.qty -= q;
  }
  let planLines: CorrectionPlan["lines"];
  if (data.kind === "reversal") {
    planLines = [...remaining].filter(([, v]) => v.qty > 0).map(([productId, v]) => ({ productId, quantity: v.qty, unitCost: v.unitCost }));
  } else {
    if (!data.lines?.length) throw new DomainError("RETURN_LINES_REQUIRED", "Pilih barang dan jumlah yang diretur ke pemasok.");
    planLines = data.lines.map((l) => {
      const r = remaining.get(l.productId);
      if (!r) throw new DomainError("RETURN_PRODUCT_UNKNOWN", "Barang yang diretur tidak ada di nota ini.");
      if (l.quantity > r.qty) throw new DomainError("RETURN_TOO_MANY", `Jumlah retur melebihi sisa di nota (${r.qty}).`);
      return { productId: l.productId, quantity: l.quantity, unitCost: r.unitCost };
    });
  }
  const amount = receipt.isOpeningPayable && data.kind === "reversal" ? receipt.totalAmount - (await receiptBalances(tx, [receipt.id])).get(receipt.id)!.returned : planLines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
  if (amount <= 0 && !planLines.length) throw new DomainError("NOTHING_TO_CORRECT", "Tidak ada sisa barang/nilai nota yang dapat dikoreksi.");
  return { kind: data.kind, lines: planLines, amount, reason: data.reason };
}

async function applyCorrection(tx: Tx, ctx: ActorContext, receipt: PurchaseReceiptRow, plan: CorrectionPlan, opts: { approvalId: string | null; createdBy: string | null }) {
  const stocked = receipt.status === "received" && !receipt.isOpeningPayable;
  if (stocked && plan.lines.length) {
    const bal = await balancesNow(
      tx,
      receipt.outletId,
      plan.lines.map((l) => l.productId),
    );
    const byId = await loadProductsById(
      tx,
      plan.lines.map((l) => l.productId),
    );
    for (const l of plan.lines) {
      if ((bal.get(l.productId)?.quantity ?? 0) < l.quantity) {
        throw new DomainError("STOCK_INSUFFICIENT_RETURN", `Stok ${byId.get(l.productId)?.name ?? "barang"} tinggal ${bal.get(l.productId)?.quantity ?? 0}; tidak dapat meretur ${l.quantity}.`);
      }
    }
  }
  const today = ctxBusinessDate(ctx);
  const number = await nextNumber(tx, "purchase_receipt", today, { tenantId: receipt.tenantId });
  const [rev] = await tx
    .insert(purchaseReceipts)
    .values({
      tenantId: receipt.tenantId,
      outletId: receipt.outletId,
      number,
      supplierId: receipt.supplierId,
      supplierNoteNumber: receipt.supplierNoteNumber,
      supplierNoteDate: receipt.supplierNoteDate,
      isSubstituteNote: receipt.isSubstituteNote,
      status: "received",
      totalAmount: -plan.amount,
      paymentStatus: "paid",
      isOpeningPayable: receipt.isOpeningPayable,
      receivedBy: opts.createdBy,
      businessDate: today,
      reversalOfId: receipt.id,
      reversalReason: plan.reason,
      notes: plan.kind === "return" ? "Nota retur pemasok" : "Pembalik nota",
      recordedByOffice: true,
      officeRecordReason: plan.reason,
      createdBy: opts.createdBy,
    })
    .returning();
  if (plan.lines.length) {
    await tx
      .insert(purchaseReceiptLines)
      .values(plan.lines.map((l) => ({ tenantId: receipt.tenantId, receiptId: rev!.id, productId: l.productId, quantity: -l.quantity, unitCost: l.unitCost, lineTotal: -l.quantity * l.unitCost })));
  }
  if (stocked) {
    for (const l of plan.lines) {
      await postStockMovement(tx, {
        tenantId: receipt.tenantId,
        outletId: receipt.outletId,
        productId: l.productId,
        kind: "supplier_return",
        quantity: -l.quantity,
        businessDate: today,
        occurredAt: ctx.now,
        source: { type: "purchase_receipt", id: rev!.id },
        createdBy: opts.createdBy,
        note: `${plan.kind === "return" ? "Retur ke pemasok" : "Pembalik nota"} ${receipt.supplierNoteNumber ?? receipt.number ?? ""}`.trim(),
      });
    }
    await evaluateReorder(tx, { tenantId: receipt.tenantId, outletId: receipt.outletId, productIds: plan.lines.map((l) => l.productId), now: ctx.now });
  }
  const fullReversal = plan.kind === "reversal";
  await tx
    .update(purchaseReceipts)
    .set({ ...(fullReversal ? { status: "reversed" as const, reversalReason: plan.reason } : {}), updatedAt: new Date() })
    .where(eq(purchaseReceipts.id, receipt.id));
  await refreshPaymentStatus(tx, receipt.id);
  await auditRecord(tx, {
    ctx,
    objectType: "purchase_receipt",
    objectId: receipt.id,
    action: fullReversal ? "reverse" : "supplier_return",
    before: { status: receipt.status },
    after: { status: fullReversal ? "reversed" : receipt.status, correctionId: rev!.id, correctionNumber: number, amount: -plan.amount, lines: plan.lines },
    reason: plan.reason,
    rule: opts.approvalId ? "6.2a" : "BR-38",
  });
  // Nota pengganti yang belum diterima tidak pernah dijurnal — pembaliknya juga tidak.
  if (receipt.status === "received") {
    await emit(
      tx,
      "purchase_receipt.corrected",
      { purchaseReceiptId: receipt.id, correctionId: rev!.id, supplierId: receipt.supplierId, outletId: receipt.outletId, kind: plan.kind, amountDelta: -plan.amount, reason: plan.reason },
      { ctx, tenantId: receipt.tenantId, objectType: "purchase_receipt", objectId: receipt.id },
    );
  }
  return rev!;
}

/** Koreksi nota (Admin Keuangan): ≤ PAR-21 langsung; di atasnya persetujuan pemilik `correction` (BR-38). */
export async function correctPurchaseReceipt(ctx: ActorContext, input: PurchaseCorrectionInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.purchase_receipt.correct", { tx: opts.tx, objectType: "purchase_receipt", objectId: input.receiptId });
  const data = parseInput(correctionSchema, input, { reason: "Alasan", lines: "Barang retur" });
  return runService(ctx, opts, async (tx) => {
    const receipt = await loadReceipt(tx, ctx, data.receiptId, { forUpdate: true });
    if (receipt.reversalOfId) throw new DomainError("CORRECTION_OF_CORRECTION", "Nota retur/pembalik tidak dapat dikoreksi lagi.");
    if (receipt.status === "reversed") throw new DomainError("ALREADY_REVERSED", "Nota ini sudah dibalik.");
    if (receipt.status === "pending_acceptance" && data.kind !== "reversal") throw new DomainError("SUBSTITUTE_PENDING", "Nota pengganti yang belum diterima hanya dapat dibalik (ditolak), bukan diretur.");
    const plan = await planCorrection(tx, receipt, data);
    const limit = await params.get(tx, "PAR-21", ctxBusinessDate(ctx));
    if (plan.amount > limit.amount_gt && receipt.status === "received") {
      const req = await approvals.submit(
        ctx,
        {
          type: "correction",
          objectType: "purchase_receipt",
          objectId: receipt.id,
          amount: plan.amount,
          reason: `${plan.kind === "return" ? "Retur ke pemasok" : "Pembalik nota"} ${receipt.supplierNoteNumber ?? receipt.number} ${formatRupiah(plan.amount)}: ${plan.reason}`,
          payload: { kind: plan.kind, lines: plan.lines, reason: plan.reason, amount: plan.amount, link: `/toko/pembelian/${receipt.id}` },
        },
        { tx },
      );
      await auditRecord(tx, { ctx, objectType: "purchase_receipt", objectId: receipt.id, action: "request_correction", after: { approvalId: req.id, amount: plan.amount }, reason: plan.reason, rule: "BR-38" });
      return { status: "pending_approval" as const, approval: req, correction: null };
    }
    const rev = await applyCorrection(tx, ctx, receipt, plan, { approvalId: null, createdBy: ctx.userId });
    return { status: "applied" as const, approval: null, correction: rev };
  });
}

export async function onPurchaseCorrectionApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [receipt] = await tx.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, request.objectId)).for("update").limit(1);
  if (!receipt || receipt.status === "reversed") return { effect: "none" };
  const payload = request.payload as { kind: "return" | "reversal"; lines: CorrectionPlan["lines"]; reason: string; amount: number };
  const rev = await applyCorrection(tx, ctx, receipt, { kind: payload.kind, lines: payload.lines, amount: payload.amount, reason: payload.reason }, { approvalId: request.id, createdBy: request.requesterUserId });
  return { effect: "applied", correctionId: rev.id };
}

// =====================================================================================================================
// Saldo awal utang pemasok saat cut-over (US-M7-08 KP-3, BRD 10.3)
// =====================================================================================================================

export const openingPayableSchema = z
  .object({
    outletId: z.uuid().nullable().optional(),
    supplierId: z.uuid({ error: "Pilih pemasok." }),
    supplierNoteNumber: z.string().trim().min(1, { error: "Nomor nota wajib diisi." }).max(60),
    supplierNoteDate: dateField,
    dueDate: dateField.nullable().optional(),
    amount: zRupiahPositive,
    attachmentId: z.uuid().nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export async function recordOpeningPayable(ctx: ActorContext, input: z.input<typeof openingPayableSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.opening_payable.create", { tx: opts.tx, objectType: "purchase_receipt" });
  const data = parseInput(openingPayableSchema, input, { amount: "Sisa utang", supplierNoteNumber: "Nomor nota", supplierNoteDate: "Tanggal nota" });
  return runService(ctx, opts, async (tx) => {
    const outlet = await resolveOfficeStore(tx, ctx, data.outletId ?? null);
    if (!outlet) throw new DomainError("STORE_REQUIRED", "Belum ada toko aktif untuk dicatat saldo awal utangnya.");
    const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, data.supplierId)).limit(1);
    if (!sup || sup.tenantId !== ctx.tenantId) throw new NotFoundError("Pemasok tidak ditemukan.");
    if (sup.status === "inactive") throw new DomainError("SUPPLIER_INACTIVE", `Pemasok ${sup.name} nonaktif.`);
    const dup = await findDuplicateNote(tx, ctx.tenantId, sup.id, data.supplierNoteNumber);
    if (dup) throw new DomainError("DUPLICATE_NOTE", `Nota ${data.supplierNoteNumber} dari ${sup.name} sudah tercatat.`);
    if (data.attachmentId) {
      const [att] = await tx.select().from(attachments).where(eq(attachments.id, data.attachmentId)).limit(1);
      if (!att || att.tenantId !== ctx.tenantId) throw new NotFoundError("Foto nota tidak ditemukan. Unggah ulang.");
    }
    const today = ctxBusinessDate(ctx);
    const number = await nextNumber(tx, "purchase_receipt", today, { tenantId: ctx.tenantId });
    const dueDate = await payableDueDate(tx, { explicit: data.dueDate ?? null, noteDate: data.supplierNoteDate, businessDate: today, supplierTermDays: sup.paymentTermDays });
    const [row] = await tx
      .insert(purchaseReceipts)
      .values({
        tenantId: ctx.tenantId,
        outletId: outlet.id,
        number,
        supplierId: sup.id,
        supplierNoteNumber: data.supplierNoteNumber,
        supplierNoteDate: data.supplierNoteDate,
        noteAttachmentId: data.attachmentId ?? null,
        status: "received",
        totalAmount: data.amount,
        paymentStatus: "unpaid",
        dueDate,
        isOpeningPayable: true,
        receivedBy: ctx.userId,
        businessDate: today,
        notes: data.notes ?? "Saldo awal utang pemasok (cut-over)",
        recordedByOffice: true,
        officeRecordReason: "Saldo awal utang pemasok saat cut-over (BRD 10.3)",
        createdBy: ctx.userId,
      })
      .returning();
    if (data.attachmentId) await linkAttachment(tx, data.attachmentId, { type: "purchase_receipt", id: row!.id });
    await auditRecord(tx, {
      ctx,
      objectType: "purchase_receipt",
      objectId: row!.id,
      action: "opening_payable",
      after: { number, supplier: sup.name, supplierNoteNumber: data.supplierNoteNumber, amount: data.amount, dueDate },
      reason: data.notes ?? null,
      rule: "US-M7-08 KP-3",
    });
    await emitReceiptRecorded(tx, ctx, row!, []);
    return row!;
  });
}

// =====================================================================================================================
// Tampilan kantor
// =====================================================================================================================

export type PurchaseListRow = PurchaseReceiptRow & { supplierName: string; outletName: string; lineCount: number; outstanding: number; returned: number };

export async function listPurchaseReceipts(
  ctx: ActorContext,
  filter: { outletId?: string | null; supplierId?: string | null; status?: string | null; from?: string | null; to?: string | null; limit?: number } = {},
  opts: { tx?: Tx } = {},
): Promise<PurchaseListRow[]> {
  await authorize(ctx, "m7.purchase_receipt.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds = [eq(purchaseReceipts.tenantId, ctx.tenantId)];
  if (filter.outletId) conds.push(eq(purchaseReceipts.outletId, filter.outletId));
  if (filter.supplierId) conds.push(eq(purchaseReceipts.supplierId, filter.supplierId));
  if (filter.status === "pending_acceptance" || filter.status === "received" || filter.status === "reversed") conds.push(eq(purchaseReceipts.status, filter.status));
  if (filter.from && isBusinessDate(filter.from)) conds.push(gte(purchaseReceipts.businessDate, filter.from));
  if (filter.to && isBusinessDate(filter.to)) conds.push(lte(purchaseReceipts.businessDate, filter.to));
  const rows = await tx
    .select({ r: purchaseReceipts, supplierName: suppliers.name, outletName: outlets.name })
    .from(purchaseReceipts)
    .innerJoin(suppliers, eq(suppliers.id, purchaseReceipts.supplierId))
    .innerJoin(outlets, eq(outlets.id, purchaseReceipts.outletId))
    .where(and(...conds))
    .orderBy(desc(purchaseReceipts.businessDate), desc(purchaseReceipts.createdAt))
    .limit(filter.limit ?? 200);
  const ids = rows.map((r) => r.r.id);
  const counts = ids.length
    ? await tx
        .select({ id: purchaseReceiptLines.receiptId, n: sql<number>`count(*)::int` })
        .from(purchaseReceiptLines)
        .where(inArray(purchaseReceiptLines.receiptId, ids))
        .groupBy(purchaseReceiptLines.receiptId)
    : [];
  const n = new Map(counts.map((c) => [c.id, Number(c.n)]));
  const bal = await receiptBalances(tx, ids);
  return rows.map(({ r, supplierName, outletName }) => ({
    ...r,
    supplierName,
    outletName,
    lineCount: n.get(r.id) ?? 0,
    outstanding: r.reversalOfId || r.status !== "received" ? 0 : (bal.get(r.id)?.outstanding ?? 0),
    returned: bal.get(r.id)?.returned ?? 0,
  }));
}

export async function getPurchaseReceipt(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.purchase_receipt.read", { tx: opts.tx, objectType: "purchase_receipt", objectId: id });
  const tx = opts.tx ?? getDb();
  const receipt = await loadReceipt(tx, ctx, id);
  const outlet = await loadStoreOutlet(tx, ctx, receipt.outletId);
  const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, receipt.supplierId)).limit(1);
  const lines = await tx
    .select({ l: purchaseReceiptLines, code: products.code, name: products.name, unit: products.unit })
    .from(purchaseReceiptLines)
    .innerJoin(products, eq(products.id, purchaseReceiptLines.productId))
    .where(eq(purchaseReceiptLines.receiptId, receipt.id));
  const corrections = await tx.select().from(purchaseReceipts).where(eq(purchaseReceipts.reversalOfId, receipt.id)).orderBy(purchaseReceipts.createdAt);
  const original = receipt.reversalOfId ? (await tx.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, receipt.reversalOfId)).limit(1))[0] ?? null : null;
  const allocations = await tx
    .select({ a: supplierPaymentAllocations, p: supplierPayments })
    .from(supplierPaymentAllocations)
    .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.supplierPaymentId))
    .where(eq(supplierPaymentAllocations.purchaseReceiptId, receipt.id))
    .orderBy(supplierPaymentAllocations.createdAt);
  const attIds = [receipt.noteAttachmentId, receipt.substituteGoodsPhotoId].filter((x): x is string => !!x);
  const atts = attIds.length ? await tx.select().from(attachments).where(inArray(attachments.id, attIds)) : [];
  const bal = (await receiptBalances(tx, [receipt.id])).get(receipt.id)!;
  const pendingApprovals = (await approvals.listForObject(tx, "purchase_receipt", receipt.id)).filter((a) => a.status === "submitted");
  return {
    receipt,
    outlet,
    supplier: sup ?? null,
    lines: lines.map((l) => ({ ...l.l, code: l.code, name: l.name, unit: l.unit })),
    corrections,
    original,
    allocations: allocations.map(({ a, p }) => ({ ...a, businessDate: p.businessDate, method: p.method })),
    attachments: atts.map((a) => ({ id: a.id, kind: a.kind, url: getUrl(a), contentType: a.contentType })),
    balance: bal,
    pendingApprovals,
  };
}
