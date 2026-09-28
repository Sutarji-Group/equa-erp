/**
 * M7 — barang toko, harga jual toko & pemasok (US-M7-02 KP-2, 7.7.3; BR-15, BRD 10.2).
 *
 * - Barang baru diusulkan KASIR di POS (nama, kode, satuan, kategori, harga umum & mitra, stok minimum) → berlaku
 *   setelah disetujui Admin Keuangan (`store_product`, objek `product`). Belum disetujui = tidak dapat dijual.
 * - Perubahan harga jual toko diusulkan kasir dengan tanggal berlaku & alasan → persetujuan Admin Keuangan
 *   (`store_product`, objek `product_price`); riwayat harga tidak dapat dihapus (M1 `priceHistory`).
 * - Pemasok diusulkan kasir → aktif setelah disetujui Admin Keuangan (`supplier`); dinonaktifkan, tidak dihapus.
 * Handler persetujuan menulis langsung dengan `tx` (ctx = penyetuju) + jejak audit (6.2a).
 */
import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { productPrices, products, suppliers } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah, zRupiahPositive } from "@/lib/money";
import { isBusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import type { ApprovalRow } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { authorize, runService } from "@/server/core/rbac";
import { resolveProductPrice } from "@/server/modules/m1-master";
import type { FieldWriteMeta } from "@/server/modules/m6-pos";

import { loadStoreProduct } from "./common";
import { payableSummaryBySupplier } from "./payables";

type SupplierRow = typeof suppliers.$inferSelect;

const codeSchema = z
  .string()
  .trim()
  .min(2, { error: "Kode barang wajib diisi." })
  .max(30)
  .regex(/^[A-Za-z0-9-]+$/, { error: "Kode barang hanya huruf, angka, dan tanda minus." })
  .transform((v) => v.toUpperCase());

// =====================================================================================================================
// Usulan barang toko baru (POS kasir)
// =====================================================================================================================

export const proposeProductSchema = z
  .object({
    productId: z.uuid(),
    code: codeSchema,
    name: z.string().trim().min(2, { error: "Nama barang wajib diisi." }).max(120),
    unit: z.string().trim().min(1, { error: "Satuan wajib diisi (mis. pcs, botol)." }).max(20),
    category: z.string().trim().max(40).nullable().optional(),
    generalPrice: zRupiahPositive,
    partnerPrice: zRupiahPositive,
    minStock: z.number().int().min(0).max(1_000_000).nullable().optional(),
    barcode: z.string().trim().max(40).nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export async function proposeStoreProduct(ctx: ActorContext, input: z.output<typeof proposeProductSchema>, meta: FieldWriteMeta) {
  const { tx } = meta;
  await authorize(ctx, "m7.store_product.propose", { tx, objectType: "product", objectId: input.productId });
  const tenantId = meta.device.tenantId;
  const dup = await tx.select({ id: products.id }).from(products).where(and(eq(products.tenantId, tenantId), eq(products.code, input.code))).limit(1);
  if (dup[0]) throw new DomainError("PRODUCT_DUPLICATE", `Kode barang ${input.code} sudah dipakai. Pakai kode lain atau cari barangnya di daftar.`);
  const [row] = await tx
    .insert(products)
    .values({
      id: input.productId,
      tenantId,
      code: input.code,
      name: input.name,
      line: "store",
      unit: input.unit,
      category: input.category ?? null,
      minStock: input.minStock ?? null,
      barcode: input.barcode ?? null,
      posVisible: true,
      status: "pending_approval",
      createdBy: ctx.userId,
    })
    .returning();
  const req = await approvals.submit(
    ctx,
    {
      type: "store_product",
      objectType: "product",
      objectId: row!.id,
      amount: input.generalPrice,
      reason: `Barang baru ${input.code} ${input.name} (${input.unit}): harga umum ${formatRupiah(input.generalPrice)}, mitra ${formatRupiah(input.partnerPrice)}, stok minimum ${input.minStock ?? "—"}.${input.notes ? ` ${input.notes}` : ""}`,
      payload: {
        kind: "new_product",
        code: input.code,
        name: input.name,
        unit: input.unit,
        category: input.category ?? null,
        generalPrice: input.generalPrice,
        partnerPrice: input.partnerPrice,
        minStock: input.minStock ?? null,
        link: `/toko/barang/${row!.id}`,
      },
    },
    { tx },
  );
  await tx.update(products).set({ approvalRequestId: req.id }).where(eq(products.id, row!.id));
  await tx.insert(productPrices).values(
    (
      [
        ["general", input.generalPrice],
        ["partner", input.partnerPrice],
      ] as const
    ).map(([kind, price]) => ({
      tenantId,
      productId: row!.id,
      kind,
      price,
      effectiveFrom: meta.businessDate,
      status: "pending" as const,
      approvalRequestId: req.id,
      reason: "Barang toko baru (usulan kasir)",
      createdBy: ctx.userId,
    })),
  );
  await auditRecord(tx, {
    ctx,
    objectType: "product",
    objectId: row!.id,
    action: "propose",
    after: { code: input.code, name: input.name, unit: input.unit, generalPrice: input.generalPrice, partnerPrice: input.partnerPrice, minStock: input.minStock ?? null, status: "pending_approval" },
    reason: input.notes ?? null,
    businessDate: meta.businessDate,
  });
  return { product: { ...row!, approvalRequestId: req.id }, approval: req };
}

// =====================================================================================================================
// Usulan perubahan harga jual toko (BR-15: persetujuan, tanggal berlaku, riwayat)
// =====================================================================================================================

export const proposePriceSchema = z
  .object({
    priceId: z.uuid(),
    productId: z.uuid(),
    kind: z.enum(["general", "partner"]),
    price: zRupiahPositive,
    effectiveFrom: z.string().refine(isBusinessDate, { error: "Tanggal berlaku wajib (YYYY-MM-DD)." }),
    reason: z.string().trim().min(3, { error: "Alasan perubahan harga wajib diisi." }).max(300),
  })
  .strict();

export async function proposeStorePrice(ctx: ActorContext, input: z.output<typeof proposePriceSchema>, meta: FieldWriteMeta) {
  const { tx } = meta;
  await authorize(ctx, "m7.store_product.propose", { tx, objectType: "product_price", objectId: input.priceId });
  const product = await loadStoreProduct(tx, meta.device.tenantId, input.productId);
  if (product.status !== "active") throw new DomainError("PRODUCT_NOT_ACTIVE", `${product.name} belum aktif/nonaktif — harga tidak dapat diubah.`);
  if (input.effectiveFrom < meta.businessDate) throw new DomainError("EFFECTIVE_FROM_PAST", "Tanggal berlaku tidak boleh sebelum hari ini.");
  let current: number | null = null;
  try {
    current = (await resolveProductPrice(tx, { productId: product.id, kind: input.kind, date: meta.businessDate, tenantId: product.tenantId })).unitPrice;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
  if (current === input.price) throw new DomainError("PRICE_UNCHANGED", `${label("price_kind", input.kind)} ${product.name} sudah ${formatRupiah(input.price)}.`);
  const req = await approvals.submit(
    ctx,
    {
      type: "store_product",
      objectType: "product_price",
      objectId: input.priceId,
      amount: input.price,
      reason: `${label("price_kind", input.kind)} ${product.name}: ${current === null ? "—" : formatRupiah(current)} → ${formatRupiah(input.price)} berlaku ${input.effectiveFrom}. Alasan: ${input.reason}`,
      payload: { kind: "price_change", productId: product.id, productCode: product.code, productName: product.name, priceKind: input.kind, oldPrice: current, price: input.price, effectiveFrom: input.effectiveFrom, link: `/toko/barang/${product.id}` },
    },
    { tx },
  );
  const [row] = await tx
    .insert(productPrices)
    .values({
      id: input.priceId,
      tenantId: product.tenantId,
      productId: product.id,
      kind: input.kind,
      price: input.price,
      effectiveFrom: input.effectiveFrom,
      status: "pending",
      approvalRequestId: req.id,
      reason: input.reason,
      createdBy: ctx.userId,
    })
    .returning();
  await auditRecord(tx, {
    ctx,
    objectType: "product_price",
    objectId: row!.id,
    action: "submit",
    after: { product: product.code, kind: input.kind, oldPrice: current, price: input.price, effectiveFrom: input.effectiveFrom, status: "pending" },
    reason: input.reason,
    rule: "BR-15",
    businessDate: meta.businessDate,
  });
  return { price: row!, approval: req };
}

/** Aktifkan harga usulan (tanggal berlaku tidak mundur sebelum tanggal keputusan) — menggantikan harga aktif bertanggal sama. */
async function activateStorePrice(tx: Tx, ctx: ActorContext, priceId: string): Promise<boolean> {
  const [row] = await tx.select().from(productPrices).where(eq(productPrices.id, priceId)).for("update").limit(1);
  if (!row || row.status !== "pending") return false;
  const today = ctxBusinessDate(ctx);
  const effectiveFrom = row.effectiveFrom < today ? today : row.effectiveFrom;
  const same = await tx
    .select()
    .from(productPrices)
    .where(and(eq(productPrices.productId, row.productId), eq(productPrices.kind, row.kind), eq(productPrices.effectiveFrom, effectiveFrom), eq(productPrices.status, "active")));
  for (const s of same.filter((r) => r.outletId === row.outletId)) {
    await tx.update(productPrices).set({ status: "cancelled" }).where(eq(productPrices.id, s.id));
    await auditRecord(tx, { ctx, objectType: "product_price", objectId: s.id, action: "cancel", before: { status: "active" }, after: { status: "cancelled" }, reason: "Digantikan harga baru pada tanggal berlaku yang sama." });
  }
  await tx.update(productPrices).set({ status: "active", effectiveFrom, approvedBy: ctx.userId, approvedAt: ctx.now }).where(eq(productPrices.id, row.id));
  await auditRecord(tx, {
    ctx,
    objectType: "product_price",
    objectId: row.id,
    action: "approve",
    before: { status: "pending", effectiveFrom: row.effectiveFrom },
    after: { status: "active", effectiveFrom, price: row.price },
    rule: "6.2a",
  });
  return true;
}

// --- Handler persetujuan `store_product` (ctx = Admin Keuangan) ------------------------------------------------------

export async function onStoreProductApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [product] = await tx.select().from(products).where(eq(products.id, request.objectId)).for("update").limit(1);
  if (!product || product.status !== "pending_approval") return { effect: "none" };
  await tx.update(products).set({ status: "active" }).where(eq(products.id, product.id));
  const prices = await tx.select().from(productPrices).where(and(eq(productPrices.productId, product.id), eq(productPrices.status, "pending"), eq(productPrices.approvalRequestId, request.id)));
  for (const p of prices) await activateStorePrice(tx, ctx, p.id);
  await auditRecord(tx, { ctx, objectType: "product", objectId: product.id, action: "activate", before: { status: "pending_approval" }, after: { status: "active" }, rule: "BRD 10.2" });
  return { effect: "activated", prices: prices.length };
}

export async function onStoreProductRejected(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [product] = await tx.select().from(products).where(eq(products.id, request.objectId)).for("update").limit(1);
  if (!product || product.status !== "pending_approval") return { effect: "none" };
  const reason = request.decisionReason ?? request.cancelReason ?? "Usulan barang tidak disetujui.";
  await tx.update(products).set({ status: "inactive", deactivatedAt: ctx.now, deactivatedBy: ctx.userId, deactivationReason: reason }).where(eq(products.id, product.id));
  await tx
    .update(productPrices)
    .set({ status: "rejected" })
    .where(and(eq(productPrices.productId, product.id), eq(productPrices.status, "pending"), eq(productPrices.approvalRequestId, request.id)));
  await auditRecord(tx, { ctx, objectType: "product", objectId: product.id, action: "reject", before: { status: "pending_approval" }, after: { status: "inactive" }, reason, rule: "BRD 10.2" });
  return { effect: "rejected" };
}

export async function onStorePriceApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  return { effect: (await activateStorePrice(tx, ctx, request.objectId)) ? "activated" : "none" };
}

export async function onStorePriceRejected(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const res = await tx
    .update(productPrices)
    .set({ status: "rejected" })
    .where(and(eq(productPrices.id, request.objectId), eq(productPrices.status, "pending")))
    .returning({ id: productPrices.id });
  if (!res.length) return { effect: "none" };
  await auditRecord(tx, {
    ctx,
    objectType: "product_price",
    objectId: request.objectId,
    action: "reject",
    before: { status: "pending" },
    after: { status: "rejected" },
    reason: request.decisionReason ?? request.cancelReason ?? null,
    rule: "6.2a",
  });
  return { effect: "rejected" };
}

// =====================================================================================================================
// Pemasok (7.7.3: dikelola kasir, disetujui Admin Keuangan)
// =====================================================================================================================

export const proposeSupplierSchema = z
  .object({
    supplierId: z.uuid(),
    name: z.string().trim().min(2, { error: "Nama pemasok wajib diisi." }).max(120),
    code: z.string().trim().max(20).nullable().optional(),
    contactName: z.string().trim().max(80).nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
    /** Jatuh tempo bawaan pemasok (hari); kosong = PAR-67. */
    paymentTermDays: z.number().int().min(0).max(365).nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

async function assertSupplierNameFree(tx: Tx, tenantId: string, name: string, exceptId?: string) {
  const rows = await tx
    .select({ id: suppliers.id, status: suppliers.status })
    .from(suppliers)
    .where(and(eq(suppliers.tenantId, tenantId), sql`lower(${suppliers.name}) = ${name.toLowerCase()}`, inArray(suppliers.status, ["active", "pending_approval"])));
  if (rows.some((r) => r.id !== exceptId)) throw new DomainError("SUPPLIER_DUPLICATE", `Pemasok "${name}" sudah ada. Pilih dari daftar pemasok.`);
}

export async function proposeSupplier(ctx: ActorContext, input: z.output<typeof proposeSupplierSchema>, meta: FieldWriteMeta) {
  const { tx } = meta;
  await authorize(ctx, "m7.supplier.create", { tx, objectType: "supplier", objectId: input.supplierId });
  const tenantId = meta.device.tenantId;
  await assertSupplierNameFree(tx, tenantId, input.name);
  const [row] = await tx
    .insert(suppliers)
    .values({
      id: input.supplierId,
      tenantId,
      code: input.code ?? null,
      name: input.name,
      contactName: input.contactName ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      paymentTermDays: input.paymentTermDays ?? null,
      status: "pending_approval",
      notes: input.notes ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  const req = await approvals.submit(
    ctx,
    {
      type: "supplier",
      objectType: "supplier",
      objectId: row!.id,
      reason: `Pemasok baru: ${input.name}${input.contactName ? ` (${input.contactName})` : ""}${input.paymentTermDays !== undefined && input.paymentTermDays !== null ? `, tempo ${input.paymentTermDays} hari` : ""}.${input.notes ? ` ${input.notes}` : ""}`,
      payload: { name: input.name, phone: input.phone ?? null, address: input.address ?? null, link: "/toko/pemasok" },
    },
    { tx },
  );
  await tx.update(suppliers).set({ approvalRequestId: req.id }).where(eq(suppliers.id, row!.id));
  await auditRecord(tx, { ctx, objectType: "supplier", objectId: row!.id, action: "propose", after: { name: input.name, status: "pending_approval" }, businessDate: meta.businessDate });
  return { supplier: { ...row!, approvalRequestId: req.id }, approval: req };
}

export async function onSupplierApproved(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, request.objectId)).for("update").limit(1);
  if (!sup || sup.status !== "pending_approval") return { effect: "none" };
  await tx.update(suppliers).set({ status: "active", approvedBy: ctx.userId, approvedAt: ctx.now, updatedAt: new Date() }).where(eq(suppliers.id, sup.id));
  await auditRecord(tx, { ctx, objectType: "supplier", objectId: sup.id, action: "approve", before: { status: "pending_approval" }, after: { status: "active" }, rule: "7.7.3" });
  return { effect: "activated" };
}

export async function onSupplierRejected(tx: Tx, request: ApprovalRow, ctx: ActorContext): Promise<Record<string, unknown>> {
  const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, request.objectId)).for("update").limit(1);
  if (!sup || sup.status !== "pending_approval") return { effect: "none" };
  const reason = request.decisionReason ?? request.cancelReason ?? "Usulan pemasok tidak disetujui.";
  await tx.update(suppliers).set({ status: "inactive", deactivatedAt: ctx.now, deactivationReason: reason, updatedAt: new Date() }).where(eq(suppliers.id, sup.id));
  await auditRecord(tx, { ctx, objectType: "supplier", objectId: sup.id, action: "reject", before: { status: "pending_approval" }, after: { status: "inactive" }, reason, rule: "7.7.3" });
  return { effect: "rejected" };
}

const updateSupplierSchema = z
  .object({
    contactName: z.string().trim().max(80).nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
    paymentTermDays: z.number().int().min(0).max(365).nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

async function loadSupplier(tx: Tx, ctx: ActorContext, id: string): Promise<SupplierRow> {
  const [row] = await tx.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (!row || row.tenantId !== ctx.tenantId) throw new NotFoundError("Pemasok tidak ditemukan.");
  return row;
}

/** Ubah data kontak/tempo pemasok (Admin Keuangan). Nama tetap (riwayat nota). */
export async function updateSupplier(ctx: ActorContext, supplierId: string, input: z.input<typeof updateSupplierSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.supplier.update", { tx: opts.tx, objectType: "supplier", objectId: supplierId });
  const data = parseInput(updateSupplierSchema, input, { paymentTermDays: "Tempo (hari)" });
  return runService(ctx, opts, async (tx) => {
    const before = await loadSupplier(tx, ctx, supplierId);
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Partial<SupplierRow>;
    const [after] = await tx.update(suppliers).set({ ...patch, updatedAt: new Date() }).where(eq(suppliers.id, supplierId)).returning();
    const keys = Object.keys(patch).filter((k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]);
    if (keys.length) {
      await auditRecord(tx, {
        ctx,
        objectType: "supplier",
        objectId: supplierId,
        action: "update",
        before: Object.fromEntries(keys.map((k) => [k, (before as Record<string, unknown>)[k]])),
        after: Object.fromEntries(keys.map((k) => [k, (after as Record<string, unknown>)[k]])),
      });
    }
    return after!;
  });
}

/** Nonaktifkan / aktifkan kembali pemasok beralasan (tidak dihapus; 6.1). */
export async function setSupplierActive(ctx: ActorContext, supplierId: string, input: { active: boolean; reason: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.supplier.deactivate", { tx: opts.tx, objectType: "supplier", objectId: supplierId });
  const data = parseInput(z.object({ active: z.boolean(), reason: z.string().trim().min(3, { error: "Alasan wajib diisi (minimal 3 karakter)." }).max(300) }), input);
  return runService(ctx, opts, async (tx) => {
    const before = await loadSupplier(tx, ctx, supplierId);
    if (before.status === "pending_approval") throw new DomainError("SUPPLIER_PENDING", "Pemasok masih menunggu persetujuan — putuskan dari kotak persetujuan.");
    const target = data.active ? "active" : "inactive";
    if (before.status === target) throw new DomainError("NO_CHANGE", `Pemasok sudah ${data.active ? "aktif" : "nonaktif"}.`);
    const [after] = await tx
      .update(suppliers)
      .set({ status: target, deactivatedAt: data.active ? null : ctx.now, deactivationReason: data.active ? null : data.reason, updatedAt: new Date() })
      .where(eq(suppliers.id, supplierId))
      .returning();
    await auditRecord(tx, { ctx, objectType: "supplier", objectId: supplierId, action: data.active ? "activate" : "deactivate", before: { status: before.status }, after: { status: target }, reason: data.reason });
    return after!;
  });
}

export type SupplierListRow = SupplierRow & { outstanding: number; openNotes: number; overdueAmount: number };

/** Daftar pemasok + ringkasan utang (izin `m7.supplier.read`). */
export async function listSuppliers(ctx: ActorContext, filter: { includeInactive?: boolean } = {}, opts: { tx?: Tx } = {}): Promise<SupplierListRow[]> {
  await authorize(ctx, "m7.supplier.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx.select().from(suppliers).where(eq(suppliers.tenantId, ctx.tenantId)).orderBy(suppliers.name);
  const sums = await payableSummaryBySupplier(tx, ctx.tenantId, ctxBusinessDate(ctx));
  return rows
    .filter((r) => filter.includeInactive || r.status !== "inactive")
    .map((r) => ({ ...r, outstanding: sums.get(r.id)?.outstanding ?? 0, openNotes: sums.get(r.id)?.openNotes ?? 0, overdueAmount: sums.get(r.id)?.overdue ?? 0 }));
}
